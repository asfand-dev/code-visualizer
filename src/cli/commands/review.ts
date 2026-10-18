import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { effortLabel, independentChanges, suggestsSplit } from '../../shared/review.js';
import type { ReviewPlan, ReviewRole } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { emitOutput, safeData } from '../format.js';
import { parseCommandArgs, persistFrom, resolveProjectRoot, splitList, type Command } from '../shared.js';
// --- clone-radar ---
import { driftMessage, newCloneMessage } from '../../shared/clones.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer review [ref|#123|!45] [root] [options]

  How to review a branch or pull request: the files in dependency order (types and
  contracts, then the code others build on, then its users, each test right after
  the code it covers), where to start and why, what to skim, effort, public API
  changes with call sites that were not updated, untested functions — and whether
  it is really several independent changes. Nothing is checked out: your working
  tree and HEAD stay as they are.

  ref defaults to your current branch; a branch that only exists on a remote (origin/feature)
  can be named without the remote. #123 is a GitHub pull request and !45 a GitLab merge
  request; they are looked up in refs you already fetched (refs/pull/123/head, pr/123,
  origin/pr/123 — refs/merge-requests/45/head, mr/45, origin/mr/45). --fetch fetches them
  first, and fetches them again when the author pushed.

${pc.bold('Options')}
  -b, --base <ref>         Compare with this ref (default: the pull request's target branch in CI,
                           otherwise origin/HEAD, main or master)
      --root <dir>         Project root (default: the project around the current folder)
      --format <f>         text (default), md or json
      --json               Same as --format json
      --test-first         Read each test before the code it covers
      --fetch              Fetch #123 / !45 first, also to update one fetched before
                           (git fetch origin pull/123/head:pr/123; network)
      --remote <name>      Remote for --fetch (default: origin)
      --open               Review in the browser: live companion with viewed checkboxes (starts serve,
                           or opens the one already running for the project)
  -p, --port <n>           Port for --open (default: 4747, next free port if taken)
  -o, --output <file>      Write to a file instead of stdout
  -c, --copy               Copy to the clipboard (the Markdown checklist with --format text)
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --max-files <n>      Maximum number of files to analyze (default: 20000)
      --no-cache           Analyze from scratch: skip the warm cache and stored snapshots
  -h, --help               Show this help

${pc.bold('Exit codes')}
  0 the plan was printed, 1 unknown ref or analysis error, 2 usage error, a pull request
  that is not fetched yet, or no common history with the base

${pc.bold('Examples')}
  $ npx code-visualizer review feature/refunds
  $ npx code-visualizer review '#123' --fetch
  $ npx code-visualizer review origin/copilot/fix-login --format md -o review.md
  $ npx code-visualizer review --test-first --open
`;

type Colors = ReturnType<typeof pc.createColors>;

const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const ROLE_COLOR: Record<ReviewRole, (c: Colors) => (s: string) => string> = {
  contract: (c) => c.magenta,
  core: (c) => c.cyan,
  consumer: (c) => c.blue,
  test: (c) => c.green,
  config: (c) => c.yellow,
  mechanical: (c) => c.dim,
  other: (c) => c.dim,
};

/**
 * The plan as terminal text (colors only when `c` has them enabled). Every string of the plan — paths,
 * symbols, commit subjects, reasons — comes from the reviewed branch: control characters are shown, never
 * sent to the terminal.
 */
export function renderReviewText(reviewed: ReviewPlan, c: Colors): string {
  const plan = safeData(reviewed);
  const out: string[] = [''];
  const since = plan.mergeBase ? c.dim(` (since ${plan.mergeBase.slice(0, 10)}${plan.commits?.length ? `, ${plural(plan.commits.length, 'commit')}` : ''})`) : '';
  out.push(`  ${c.bold('Review')}  ${plan.ref} ${c.dim('→')} ${plan.base}${since}`);
  if (!plan.steps.length && !plan.skim.length) {
    out.push(`  ${c.green('✔')} Nothing to review: ${plan.ref} has no changes compared to ${plan.base}.`, '');
    return out.join('\n');
  }
  const viewed = plan.steps.filter((s) => s.viewed).length;
  const facts = [
    c.bold(effortLabel(plan.effort)),
    `${plural(plan.steps.length, 'file')} to read${plan.additions !== undefined ? c.dim(` (+${plan.additions} −${plan.deletions ?? 0})`) : ''}`,
    plan.skim.length ? `${plan.skim.length} to skim` : '',
    viewed ? c.green(`${viewed} viewed`) : '',
  ].filter(Boolean);
  out.push(`  ${facts.join(c.dim(' · '))}`, '');
  if (plan.startHere) out.push(`  ${c.green('▶')} ${c.bold('Start here')}  ${plan.startHere.file}`, `    ${c.dim(plan.startHere.reason)}`, '');
  const parts = independentChanges(plan);
  // Only substantial parts are worth a split; small unrelated touch-ups are just listed as parts below.
  if (suggestsSplit(plan)) {
    out.push(`  ${c.yellow('!')} ${c.bold(`This is ${plural(parts.length, 'independent change')}`)} ${c.dim('— review them one at a time, or split the pull request:')}`);
    for (const g of parts.slice(0, 8)) out.push(`    ${g.index}. ${g.title}  ${c.dim(`${plural(g.files.length, 'file')} · ${plural(g.lines, 'line')}`)}`);
    if (parts.length > 8) out.push(`    ${c.dim(`… ${parts.length - 8} more`)}`);
    out.push('');
  }
  const width = Math.min(56, Math.max(...plan.steps.map((s) => s.file.length), 10));
  const number = String(plan.steps.length).length;
  let group = 0;
  for (const step of plan.steps) {
    if (step.group !== group) {
      group = step.group;
      const g = plan.groups.find((x) => x.index === group);
      if (plan.groups.length > 1 || group !== 1) out.push(`  ${c.bold(g?.kind === 'other' ? (g?.title ?? '') : `Part ${group} · ${g?.title ?? ''}`)}`);
      else out.push(`  ${c.bold('Review path')}`);
    }
    const mark = step.viewed ? c.green('✔') : ' ';
    const role = ROLE_COLOR[step.role](c)(step.role.padEnd(8));
    const file = step.file.length > width ? step.file : step.file.padEnd(width);
    out.push(`  ${mark}${String(step.order).padStart(number + 1)}. ${role} ${file}  ${c.dim(step.reasons.join('; '))}`);
  }
  if (plan.skim.length) {
    out.push('', `  ${c.bold('Skim')}`);
    for (const s of plan.skim.slice(0, 12)) out.push(`    ${s.viewed ? c.green('✔ ') : ''}${s.file}  ${c.dim(s.reason)}`);
    if (plan.skim.length > 12) out.push(`    ${c.dim(`… ${plan.skim.length - 12} more`)}`);
  }
  const api = plan.apiChanges.filter((e) => e.breaking || e.importers.length);
  if (api.length) {
    out.push('', `  ${c.bold('API changes')}`);
    for (const e of api.slice(0, 10)) {
      const stale = e.staleCallSites.length ? c.red(`${plural(e.staleCallSites.length, 'call')} not updated: ${e.staleCallSites.slice(0, 4).map((s) => `${s.file}:${s.line}`).join(', ')}${e.staleCallSites.length > 4 ? ' …' : ''}`) : '';
      const importers = !stale && e.importers.length ? c.dim(`${e.change === 'removed' ? 'still imported by' : 'imported by'} ${e.importers.slice(0, 3).join(', ')}${e.importers.length > 3 ? ` (+${e.importers.length - 3})` : ''}`) : '';
      const label = e.change === 'removed' ? `${e.name} removed` : e.before && e.after ? `${e.before} → ${e.after}` : e.name;
      out.push(`    ${e.breaking ? c.red('✖') : c.dim('•')} ${label}  ${c.dim(`${e.file}${e.line ? `:${e.line}` : ''}`)}${stale || importers ? `\n        ${stale || importers}` : ''}`);
    }
    if (api.length > 10) out.push(`    ${c.dim(`… ${api.length - 10} more`)}`);
  }
  const d = plan.delta;
  // clone-radar: copies the branch edited on one side only (ChangeSet.cloneDrift includes the delta's driftedClones).
  const drifted = plan.cloneDrift ?? d?.driftedClones ?? [];
  if (d && (d.newCycles.length || d.newViolations.length || d.routes.removed.some((r) => r.stillCalledFrom.length) || d.newMissingDependencies.length || d.newClones?.length || drifted.length)) {
    out.push('', `  ${c.bold('Architecture')}`);
    for (const cy of d.newCycles.slice(0, 5)) out.push(`    ${c.red('✖ new cycle')} ${[...cy, cy[0]].join(c.dim(' → '))}`);
    for (const v of d.newViolations.slice(0, 5)) out.push(`    ${v.severity === 'error' ? c.red('✖') : c.yellow('!')} ${c.dim(`${v.source}:${v.line}`)} → ${v.target}  ${c.dim(v.message ?? v.rule)}`);
    for (const r of d.routes.removed.filter((x) => x.stillCalledFrom.length).slice(0, 5)) out.push(`    ${c.red('✖')} ${r.label} removed, still called from ${r.stillCalledFrom.slice(0, 3).map((s) => `${s.file}:${s.line}`).join(', ')}`);
    for (const p of d.newMissingDependencies.slice(0, 5)) out.push(`    ${c.red('!')} ${p} ${c.red('is imported but not in package.json')}`);
    // --- clone-radar: copies the branch adds, and copies it edited on one side only ---
    for (const fam of (d.newClones ?? []).slice(0, 5)) out.push(`    ${c.yellow('! new copy')} ${newCloneMessage(fam)}`);
    for (const drift of drifted.slice(0, 5)) out.push(`    ${c.yellow('! clone drift')} ${driftMessage(drift)}`);
  }
  // Measured from the code alone (no git history on either side), so it can differ from `report`.
  if (d && d.health.before !== d.health.after) {
    // Which categories moved (clone-radar: "duplication 100 → 86" explains a drop from a copy).
    const moved = d.health.categories.filter((x) => x.before !== x.after).map((x) => `${x.id} ${x.before} → ${x.after}`);
    out.push('', `  ${c.bold('Code health')}  ${d.health.before} → ${d.health.after} ${d.health.after < d.health.before ? c.red(`(−${d.health.before - d.health.after})`) : c.green(`(+${d.health.after - d.health.before})`)} ${c.dim(`${moved.length ? `${moved.join(', ')} · ` : ''}without git history`)}`);
  }
  if (plan.untestedChanges.length) {
    out.push('', `  ${c.bold('Changed functions without test changes')}`);
    const shown = plan.untestedChanges.slice(0, 8).map((id) => `${id.slice(id.indexOf('#') + 1)}() ${c.dim(id.slice(0, id.indexOf('#')))}`);
    out.push(`    ${shown.join(c.dim(', '))}${plan.untestedChanges.length > 8 ? c.dim(` … ${plan.untestedChanges.length - 8} more`) : ''}`);
  }
  for (const w of plan.warnings ?? []) out.push('', `  ${c.yellow('!')} ${w}`);
  out.push('');
  return out.join('\n');
}

export const reviewCommand: Command = {
  name: 'review',
  summary: 'Review any branch or PR in dependency order: start here, effort, split, viewed',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('review', argv, {
        base: { type: 'string', short: 'b' },
        root: { type: 'string' },
        format: { type: 'string' },
        json: { type: 'boolean' },
        'test-first': { type: 'boolean' },
        fetch: { type: 'boolean' },
        remote: { type: 'string' },
        open: { type: 'boolean' },
        port: { type: 'string', short: 'p' },
        output: { type: 'string', short: 'o' },
        copy: { type: 'boolean', short: 'c' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'max-files': { type: 'string' },
        'no-cache': { type: 'boolean' },
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
    const fail = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 1;
    };
    const format = values.json ? 'json' : (values.format ?? 'text');
    if (!['text', 'md', 'markdown', 'json'].includes(format)) return usage('--format must be text, md or json.');
    const maxFiles = values['max-files'] !== undefined ? Number(values['max-files']) : undefined;
    if (maxFiles !== undefined && (!Number.isFinite(maxFiles) || maxFiles < 1)) return usage('--max-files must be a positive number.');
    const remote = values.remote ?? 'origin';
    if (!/^[\w.-]+$/.test(remote) || remote.startsWith('-')) return usage(`Invalid remote name "${remote}".`);
    if (values.base !== undefined && (!values.base || values.base.startsWith('-'))) return usage(`Invalid ref "${values.base}".`);
    if (values.port !== undefined && !values.open) return usage('--port only applies to --open.');

    const [{ git, resolveCommit }, review] = await Promise.all([import('../../analyzer/git.js'), import('../../analyzer/review.js')]);
    // Positionals: [ref] [root]; a lone directory that is not a ref is the root.
    const refs = [...positionals];
    let rootArg = values.root;
    if (!rootArg && refs.length === 2) rootArg = refs.pop();
    else if (!rootArg && refs.length === 1 && isDirectory(refs[0]) && !review.parsePullRequestRef(refs[0]) && !(await resolveCommit(process.cwd(), refs[0]))) rootArg = refs.pop();
    if (refs.length > 1) return usage(`Too many arguments: expected [ref] [root], got ${positionals.join(' ')}.`);
    // Run from a sub-folder: the project around it, as every command finds it.
    const root = rootArg !== undefined ? path.resolve(rootArg) : resolveProjectRoot(process.cwd()).root;
    if (!isDirectory(root)) return usage(`Project root "${root}" is not a directory.`);
    if (!(await resolveCommit(root, 'HEAD'))) return fail(`${root} is not a git repository with commits — review compares git versions.`);
    let input = refs[0];
    if (input === undefined) {
      const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
      input = branch && branch !== 'HEAD' ? branch : 'HEAD';
    }
    if (!input || input.startsWith('-')) return usage(`Invalid ref "${input}".`);

    let resolved: Awaited<ReturnType<typeof review.resolveReviewRef>>;
    const pr = review.parsePullRequestRef(input);
    if (pr && values.fetch) {
      // --fetch always fetches: a pull request fetched before may have new commits (or a force push).
      const fetch = review.pullRequestFetch(pr, remote);
      stderr.write(`${pc.dim(`$ ${fetch.command}`)}\n`);
      const fetched = await review.fetchPullRequest(root, pr, remote);
      if (!fetched.ok || !fetched.after) return fail(`Could not fetch ${input}: ${fetched.error ?? 'the pull request has no head'}`);
      const short = (sha: string): string => sha.slice(0, 7);
      stderr.write(
        `${pc.dim(
          !fetched.before ? `${fetched.ref}: fetched at ${short(fetched.after)}` : fetched.before === fetched.after ? `${fetched.ref}: up to date (${short(fetched.after)})` : `${fetched.ref}: ${short(fetched.before)} → ${short(fetched.after)}`,
        )}\n`,
      );
      // Review exactly what was fetched (an older refs/pull/N/head from a mirror refspec must not win).
      resolved = { ok: true, ref: `refs/heads/${fetched.ref}`, commit: fetched.after, label: input.trim() };
    } else {
      resolved = await review.resolveReviewRef(root, input);
      if (!resolved.ok && resolved.pr) {
        const fetch = review.pullRequestFetch(resolved.pr, remote);
        stderr.write(`${pc.red('✖')} ${input} is not fetched yet. Fetch it with:\n    ${pc.cyan(fetch.command)}\n  or run again with --fetch.\n`);
        return 2;
      }
      // A pull request is reviewed as it was fetched: say which version, and how to update it.
      if (resolved.ok && pr) stderr.write(`${pc.dim(`${input} is ${resolved.ref.replace(/^refs\/(heads\/)?/, '')} at ${resolved.commit.slice(0, 7)} (fetched earlier; --fetch updates it)`)}\n`);
    }
    if (!resolved.ok) {
      const { refHint } = await import('./diff.js');
      return fail(`Unknown git ref "${input}".${await refHint(root, input)}`);
    }
    if (values.base !== undefined && !(await resolveCommit(root, values.base))) {
      const { refHint } = await import('./diff.js');
      return fail(`Unknown git ref "${values.base}".${await refHint(root, values.base)}`);
    }

    if (values.open) {
      // The live companion with this review open (My changes → Reviewer); serve prints its own banner.
      const { serveCommand } = await import('./serve.js');
      const args = [root, '--review', resolved.label, ...(values.base ? ['--review-base', values.base] : []), ...(values['test-first'] ? ['--review-test-first'] : []), ...splitList(values.exclude).flatMap((e) => ['--exclude', e])];
      if (values['max-files']) args.push('--max-files', values['max-files']);
      if (values.port) args.push('--port', values.port);
      if (values['no-cache']) args.push('--no-cache');
      return serveCommand.run({ argv: args, stdout, stderr });
    }

    let plan: ReviewPlan;
    try {
      const [{ createAnalyzeCache }, { loadDiskCache }] = await Promise.all([import('../../analyzer/index.js'), import('../../analyzer/disk-cache.js')]);
      const persist = persistFrom(values['no-cache']);
      // Files that are the same on the reviewed ref as in your working tree reuse the warm parse cache.
      const cache = createAnalyzeCache();
      if (persist) loadDiskCache(root, cache);
      plan = await review.buildReviewPlan(root, resolved.ref, { base: values.base, testFirst: values['test-first'], label: resolved.label, cache, exclude: splitList(values.exclude), maxFiles, toolVersion: VERSION, persist });
    } catch (error) {
      const { AnalyzeError } = await import('../../analyzer/errors.js');
      if (error instanceof AnalyzeError) {
        // No common history (a shallow clone) is a setup problem, like diff.
        return /^No common history|^No base branch/.test(error.message) ? usage(error.message) : fail(error.message);
      }
      throw error;
    }

    const { reviewPlanMarkdown } = await import('../../shared/markdown.js');
    const toStdout = !values.output && !values.copy;
    let text: string;
    if (format === 'json') text = JSON.stringify(plan, null, 2);
    else if (format === 'md' || format === 'markdown') text = reviewPlanMarkdown(plan);
    else text = renderReviewText(plan, pc.createColors(toStdout && pc.isColorSupported && !!stdout.isTTY));
    // --copy with text output copies the Markdown checklist: plain text is not what a PR comment needs.
    const clipboard = format === 'text' ? reviewPlanMarkdown(plan) : text;
    return (await emitOutput(text, values, { stdout, stderr }, { clipboard })) ? 0 : 1;
  },
};
