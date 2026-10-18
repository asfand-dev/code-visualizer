import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import { releaseNotesMarkdown } from '../../shared/release.js';
import type { CommitType, ReleaseBump, ReleasePlan } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { ago, createLinker, emitOutput, plural, safeText } from '../format.js';
import { explicitRoot, isTTY, parseCommandArgs, persistFrom, Progress, resolveProjectRoot, splitList, STAGE_LABELS, UsageError, type Command } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer release [root] [options]

  What would ship if you released now: the commits since the last version tag, the
  changes to the API your package.json publishes (removed or changed exports are
  breaking, new ones are features), the version number that fits, release notes
  ready to paste, and whether the project is ready (clean tree, up to date, no new
  cycles or rule violations).

${pc.bold('Options')}
      --since <ref>        Start from this tag or commit (default: the latest
                           version tag reachable from HEAD)
      --notes              Print the release notes (Markdown) instead of the summary
  -o, --output <path>      Write the release notes to a file
      --copy               Copy the release notes to the clipboard
      --check              Exit with code 1 when a readiness check fails (for CI)
      --json               Machine-readable output
      --root <dir>         Project root (default: the project around the current folder)
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -q, --quiet              Only print the suggested version
  -h, --help               Show this help

  Commits are read as Conventional Commits (feat:, fix:, feat!:, BREAKING CHANGE:);
  other messages are sorted by their first verb. The API check compares your code
  with the tag, so a "fix" that removes an export still asks for a major version.

${pc.bold('Examples')}
  $ npx code-visualizer release
  $ npx code-visualizer release --notes --copy
  $ npx code-visualizer release --since v1.4.0 --json
  $ npx code-visualizer release --check
`;

const MAX_API_CHANGES = 8;
const BUMP_LABEL: Record<ReleaseBump, string> = { none: 'NONE', patch: 'PATCH', minor: 'MINOR', major: 'MAJOR' };
const BUMP_COLOR: Record<ReleaseBump, (text: string) => string> = { none: pc.dim, patch: pc.green, minor: pc.cyan, major: pc.red };
/** Kinds of commit in the summary: the types they cover, and the label in singular and plural. */
const COMMIT_KINDS: { types: CommitType[]; one: string; many: string }[] = [
  { types: ['feat'], one: 'feature', many: 'features' },
  { types: ['fix'], one: 'fix', many: 'fixes' },
  { types: ['perf', 'refactor', 'revert', 'other'], one: 'other change', many: 'other changes' },
  { types: ['docs', 'test', 'build', 'ci', 'chore', 'style'], one: 'maintenance commit', many: 'maintenance commits' },
];

/** `14 commits: 3 features, 2 fixes, 9 maintenance commits` */
function commitSummary(plan: ReleasePlan): string {
  const parts = COMMIT_KINDS.map((kind) => plural(plan.commits.filter((c) => kind.types.includes(c.type)).length, kind.one, kind.many)).filter((part) => !part.startsWith('0 '));
  return `${plural(plan.commitCount, 'commit')}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

export const releaseCommand: Command = {
  name: 'release',
  summary: 'What the next release contains: commits, API changes, the version that fits, notes',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('release', argv, {
        since: { type: 'string' },
        notes: { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        copy: { type: 'boolean' },
        check: { type: 'boolean' },
        json: { type: 'boolean' },
        root: { type: 'string' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'no-cache': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    const usage = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 2;
    };
    if ((values.output || values.copy) && !values.notes) return usage('--output and --copy write the release notes: add --notes.');
    if (values.notes && values.json) return usage('Use either --notes or --json.');
    if (values.since !== undefined && !values.since.trim()) return usage('--since needs a tag or a commit.');
    if (positionals.length > 1) return usage(`release takes one project root (got ${positionals.join(' ')}).`);
    let root: string;
    try {
      root = resolveProjectRoot(process.cwd(), explicitRoot(values, positionals)).root;
    } catch (error) {
      if (error instanceof UsageError) return usage(error.message);
      throw error;
    }

    const since = values.since?.trim();
    const progress = new Progress(stderr, isTTY(stderr) && !values.quiet && !values.json && !values.notes);
    let plan: ReleasePlan | undefined;
    try {
      const data = await getReport({
        root,
        exclude: splitList(values.exclude),
        includeSource: false,
        history: false,
        changes: true,
        release: since ? { since } : true,
        // A running server plans from the latest tag.
        server: since ? false : undefined,
        persist: persistFrom(values['no-cache']),
        toolVersion: VERSION,
        onProgress: (stage) => progress.update(STAGE_LABELS[stage]),
      });
      plan = data.release;
    } catch (error) {
      progress.stop();
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    progress.stop();

    if (!plan) {
      stderr.write(`${pc.red('✖')} ${root} is not a git repository: a release is made of its commits.\n`);
      return 1;
    }
    for (const warning of plan.warnings ?? []) stderr.write(`${pc.yellow('!')} ${safeText(warning)}\n`);
    if (since && !plan.tag) return 2;

    const failing = plan.checks.filter((c) => !c.ok);
    const failed = values.check && failing.length > 0 ? 1 : 0;
    const out = (line = ''): void => void stdout.write(`${line}\n`);

    if (values.json) {
      out(JSON.stringify({ ok: failing.length === 0, ...plan }, null, 2));
      return failed;
    }
    if (values.notes) {
      if (!plan.commits.length && !plan.apiChanges.length) {
        stderr.write(`${pc.yellow('!')} Nothing to release${plan.tag ? ` since ${safeText(plan.tag)}` : ''}.\n`);
        return failed;
      }
      return (await emitOutput(releaseNotesMarkdown(plan, { date: new Date() }), values, { stdout, stderr }, { quiet: values.quiet })) ? failed : 1;
    }
    if (values.quiet) {
      out(plan.bump.next ?? plan.bump.level);
      return failed;
    }

    out();
    if (!plan.tag) {
      out(`  ${pc.bold('Release')} ${pc.dim('· no version tag yet')}`);
      out();
      for (const reason of plan.bump.reasons) out(`  ${pc.yellow('!')} ${reason}`);
      out(`  ${pc.dim('Or look at everything so far:')} ${pc.cyan('code-visualizer release --since <first commit>')}`);
      out();
      return 0;
    }

    const when = plan.tagDate ? ` ${pc.dim(`(${ago(plan.tagDate)})`)}` : '';
    out(`  ${pc.bold(`Release since ${safeText(plan.tag)}`)}${when} ${pc.dim(`· ${commitSummary(plan)}`)}`);
    out();
    const { bump } = plan;
    const version = bump.next ? `${plan.lastVersion} ${pc.dim('→')} ${pc.bold(bump.next)}` : '';
    out(`  Suggested bump  ${BUMP_COLOR[bump.level](pc.bold(BUMP_LABEL[bump.level]))}  ${version}`);
    for (const reason of bump.reasons) out(`    ${pc.dim('·')} ${safeText(reason)}`);
    if (plan.packageVersion && plan.lastVersion && plan.packageVersion !== plan.lastVersion) {
      out(`    ${pc.yellow('!')} ${pc.dim(`package.json says ${plan.packageVersion}, the last tag is ${safeText(plan.tag)}`)}`);
    }

    const published = plan.apiChanges.filter((c) => c.entry);
    if (published.length) {
      const link = createLinker({ root, stream: stdout });
      out();
      out(`  ${pc.bold('Published API')} ${pc.dim(`· ${plural(published.length, 'change')}`)}`);
      for (const change of published.slice(0, MAX_API_CHANGES)) {
        const mark = change.breaking ? pc.red('✖') : pc.green('+');
        const users = change.importers.length ? pc.dim(` · ${plural(change.importers.length, 'importer')}`) : '';
        out(`    ${mark} ${change.change.padEnd(9)} ${pc.bold(safeText(change.name))}  ${link(change.file, change.line, safeText(change.file))}${users}`);
      }
      if (published.length > MAX_API_CHANGES) out(`    ${pc.dim(`+${published.length - MAX_API_CHANGES} more (use --json for all)`)}`);
    }

    if (plan.checks.length) {
      out();
      out(`  ${pc.bold('Ready?')}`);
      for (const check of plan.checks) {
        out(`    ${check.ok ? pc.green('✔') : pc.red('✖')} ${safeText(check.label)}${check.detail && !check.ok ? pc.dim(` · ${check.detail}`) : ''}`);
      }
    }
    out();
    out(`  ${pc.dim('Release notes:')} ${pc.cyan('code-visualizer release --notes')}${plan.compareUrl ? `   ${pc.dim(`Compare: ${plan.compareUrl}`)}` : ''}`);
    out();
    return failed;
  },
};
