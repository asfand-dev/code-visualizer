import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { analyze, AnalyzeError, createAnalyzeCache } from '../../analyzer/index.js';
import { compareReports } from '../../analyzer/compare.js';
import { loadConfig, type CodeVisualizerConfig } from '../../analyzer/config.js';
import { detectBaseBranch, git, refHint, resolveCommit } from '../../analyzer/git.js';
import { loadDiskCache, saveDiskCache } from '../../analyzer/disk-cache.js';
import { configAt, overlayForIndex, renamesSince, snapshotAt, toSnapshot } from '../../analyzer/snapshot.js';
import { breakingExports, deltaFailures, deltaHighlights, exportChangeLabel, exportImpactLabel, functionLabel, healthDrop, isEmptyDelta, parseFailOn, type FailOn } from '../../shared/delta.js';
import { driftMessage, fragmentLocation, newCloneMessage } from '../../shared/clones.js';
import { architectureDeltaMarkdown, deltaBaseLabel } from '../../shared/markdown.js';
import type { ArchitectureDelta, ReportSnapshot } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { emitOutput, safeData, safeText } from '../format.js';
import { parseCommandArgs, persistFrom, resolveProjectRoot, splitList, type Command } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer diff [base] [head] [root] [options]
  $ code-visualizer diff base..head | base...head [root] [options]

  What changed architecturally between two versions of the project: new imports and
  dependencies between areas, cycles, rule violations, API and route changes,
  complexity and health. Nothing is checked out — your working tree stays as it is.

  Like a pull request, the comparison starts where head left base (their merge-base),
  so changes made on base since then are not counted. base defaults to the main branch
  (HEAD when you are on it); head defaults to your working tree and can be any ref.
  base..head compares the two tips instead.

${pc.bold('Options')}
  -b, --base <ref>         Same as the base argument
      --staged             Compare with the staged changes (what you are about to commit; base: HEAD)
      --merge-base         Start from the merge-base of base and head (the default; turns base..head into base...head)
      --root <dir>         Project root (default: the project around the current folder)
      --format <f>         text (default), md or json
      --json               Same as --format json
  -o, --output <file>      Write to a file instead of stdout
  -c, --copy               Copy to the clipboard
      --fail-on <list>     Exit with code 1 on: new-cycles, new-violations, breaking-exports,
                           removed-routes, new-missing-deps, health-drop:<n> (comma-separated)
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --max-files <n>      Maximum number of files to analyze (default: 20000)
      --no-cache           Analyze from scratch: skip the warm cache and stored snapshots
  -q, --quiet              Print only --fail-on failures (-o and --copy still get the report)
  -h, --help               Show this help

${pc.bold('Exit codes')}
  0 nothing failed, 1 a --fail-on gate failed (or an unknown ref), 2 usage error or no
  common history between base and head (shallow clone: fetch more history)

${pc.bold('Examples')}
  $ npx code-visualizer diff
  $ npx code-visualizer diff origin/main --fail-on new-cycles,breaking-exports,health-drop:2
  $ npx code-visualizer diff --staged
  $ npx code-visualizer diff v1.2.0..v1.3.0 --format md -o architecture.md
`;

type Colors = ReturnType<typeof pc.createColors>;

const LIST_LIMIT = 10;
const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;
const short = (commit: string): string => commit.slice(0, 10);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const sites = (list: { file: string; line: number }[], max = 3): string => `${list.slice(0, max).map((s) => `${s.file}:${s.line}`).join(', ')}${list.length > max ? ' …' : ''}`;
const cyclePath = (cycle: string[], c: Colors): string => [...cycle, cycle[0]].join(c.dim(' → '));
const files = (list: string[], max = 3): string => `${list.slice(0, max).join(', ')}${list.length > max ? ` (+${list.length - max} more)` : ''}`;
/** Second line of a row: where it happens. */
const detail = (text: string): string => `\n        ${text}`;

/** Sections of the text report: a title and its rows (an empty list hides the section). */
const SECTIONS: { title: string; rows(delta: ArchitectureDelta, c: Colors): string[] }[] = [
  {
    title: 'Circular dependencies',
    rows: (d, c) => [...d.newCycles.map((cy) => `${c.red('✖ new  ')} ${cyclePath(cy, c)}`), ...d.fixedCycles.map((cy) => `${c.green('✔ fixed')} ${cyclePath(cy, c)}`)],
  },
  {
    title: 'Architecture rules',
    rows: (d, c) => [
      ...d.newViolations.map((v) => `${v.severity === 'error' ? c.red('✖ new  ') : c.yellow('! new  ')} ${c.dim(`${v.source}:${v.line}`)} → ${v.target}  ${c.dim(v.message ?? v.rule)}`),
      ...d.fixedViolations.map((v) => `${c.green('✔ fixed')} ${c.dim(`${v.source}:${v.line}`)} → ${v.target}  ${c.dim(v.rule)}`),
    ],
  },
  {
    title: 'Dependencies between areas',
    rows: (d, c) =>
      d.areaEdges.map((a) => {
        const via = (a.via ?? []).slice(0, 2).map((v) => detail(c.dim(`${v.source}${v.line ? `:${v.line}` : ''} → ${v.target}`))).join('');
        if (a.isNew) return `${c.yellow('+')} ${a.from} → ${a.to}  ${plural(a.after, 'import')} ${c.yellow('(new)')}${via}`;
        return `${a.after > a.before ? c.yellow('▲') : c.green('▼')} ${a.from} → ${a.to}  ${a.before} → ${a.after}${a.after === 0 ? c.green(' (gone)') : ''}${via}`;
      }),
  },
  {
    title: 'API changes',
    rows: (d, c) => {
      const breaking = new Set(breakingExports(d));
      const rows = d.exports
        .filter((e) => e.change !== 'added')
        .map((e) => {
          const mark = breaking.has(e) ? c.red('✖') : e.breaking ? c.yellow('!') : c.dim('•');
          const where = e.staleCallSites.length
            ? detail(`${c.red(`${plural(e.staleCallSites.length, 'call')} not updated:`)} ${sites(e.staleCallSites, 5)}`)
            : e.breaking && e.importers.length
              ? detail(c.dim(`${e.change === 'removed' ? 'still imported by' : 'imported by'} ${files(e.importers)}`))
              : '';
          return `${mark} ${exportChangeLabel(e, !e.breaking)}  ${c.dim(`${e.file}${e.line ? `:${e.line}` : ''}`)}  ${c.dim(`${e.breaking ? 'breaking · ' : ''}${exportImpactLabel(e, 0)}`)}${where}`;
        });
      const added = d.exports.filter((e) => e.change === 'added');
      if (added.length) rows.push(`${c.green('+')} ${added.slice(0, 8).map((e) => `${e.name} ${c.dim(`(${path.posix.basename(e.file)})`)}`).join(', ')}${added.length > 8 ? c.dim(` … ${added.length - 8} more`) : ''}`);
      return rows;
    },
  },
  {
    title: 'Routes',
    rows: (d, c) => [
      ...d.routes.added.map((r) => `${c.green('+')} ${r}`),
      ...d.routes.removed.map((r) => `${c.red('−')} ${r.label}${r.stillCalledFrom.length ? `  ${c.red('still called from')} ${sites(r.stillCalledFrom)}` : ''}`),
    ],
  },
  {
    title: 'Packages',
    rows: (d, c) => [
      ...d.addedPackages.map((p) => `${c.green('+')} ${p}`),
      ...d.removedPackages.map((p) => `${c.dim('−')} ${p} ${c.dim('(no longer imported)')}`),
      ...d.newMissingDependencies.map((p) => `${c.red('!')} ${p} ${c.red('is imported but not in package.json')}`),
      ...(d.newDevDependenciesInProduction ?? []).map(
        (p) => `${c.red('!')} ${p.name} ${c.red(`is a devDependency${p.manifest ? ` of ${p.manifest}/package.json` : ''} used in production code`)}${detail(c.dim(files(p.files)))}`,
      ),
    ],
  },
  {
    title: 'Complexity',
    rows: (d, c) => d.complexity.map((x) => `${x.after > 10 ? c.yellow('▲') : c.dim('▲')} ${functionLabel(x.name)}  ${x.before ? `${x.before} → ${x.after}` : `new, ${x.after}`}  ${c.dim(`${x.file}:${x.line}`)}`),
  },
  {
    title: 'New unused exports',
    rows: (d, c) => d.newUnusedExports.map((u) => `${u.name}  ${c.dim(`${u.file}:${u.line}`)}`),
  },
  // --- clone-radar ---
  {
    title: 'Copy-paste clones',
    rows: (d, c) => [
      ...(d.newClones ?? []).map((fam) => `${c.yellow('! new  ')} ${newCloneMessage(fam)}${detail(c.dim(fam.fragments.slice(0, 4).map(fragmentLocation).join(' ≈ ')))}`),
      ...(d.driftedClones ?? []).map((x) => `${c.yellow('! drift')} ${driftMessage(x)} ${c.dim('(they no longer match)')}`),
      ...(d.fixedClones ?? []).map((fam) => `${c.green('✔ fixed')} ${fam.fragments.slice(0, 3).map(fragmentLocation).join(' ≈ ')}`),
    ],
  },
];

function healthLine(delta: ArchitectureDelta, c: Colors): string {
  const drop = healthDrop(delta);
  const change = drop > 0 ? c.red(`(−${drop})`) : drop < 0 ? c.green(`(+${-drop})`) : c.dim('(±0)');
  const cats = delta.health.categories.map((x) => `${x.id} ${x.before} → ${x.after}`).join(', ');
  return `  ${c.bold('Health')}  ${delta.health.before} → ${delta.health.after} ${change}${cats ? c.dim(`  ${cats}`) : ''}`;
}

/** Plain-text report of a delta (colors only when `c` has them enabled). */
function renderDeltaText(delta: ArchitectureDelta, c: Colors): string {
  const base = deltaBaseLabel(delta, (s) => (s === delta.base ? s : c.dim(s))).replace(/^the /, '');
  const out = ['', `  ${c.bold('Architecture changes')}  ${base} ${c.dim('→')} ${delta.head}`];
  if (isEmptyDelta(delta)) {
    out.push(`  ${c.green('✔')} No architectural changes: no new dependencies between areas, cycles, rule violations or API changes.`, '');
    return out.join('\n');
  }
  const highlights = deltaHighlights(delta);
  if (highlights.length) out.push(`  ${highlights.join(c.dim(' · '))}`);
  out.push('');
  for (const section of SECTIONS) {
    const rows = section.rows(delta, c);
    if (!rows.length) continue;
    out.push(`  ${c.bold(section.title)}`, ...rows.slice(0, LIST_LIMIT).map((r) => `    ${r}`));
    if (rows.length > LIST_LIMIT) out.push(`    ${c.dim(`… ${rows.length - LIST_LIMIT} more`)}`);
  }
  const added = delta.newEdges.length + (delta.truncated?.newEdges ?? 0);
  const removed = delta.removedEdges.length + (delta.truncated?.removedEdges ?? 0);
  if (added || removed) out.push(`  ${c.bold('Imports')}  ${c.yellow(`+${added}`)} ${c.green(`−${removed}`)} ${c.dim('between files')}`);
  out.push(healthLine(delta, c), '');
  return out.join('\n');
}

/** `base..head` (the tips) or `base...head` (from their merge-base); an empty side is HEAD, like git. */
function parseRange(arg: string): { base: string; head: string; tips: boolean } | undefined {
  const m = arg.match(/^(.*?)(\.{2,3})(?!\.)(.*)$/);
  if (!m || (!m[1] && !m[3])) return undefined;
  return { base: m[1] || 'HEAD', head: m[3] || 'HEAD', tips: m[2] === '..' };
}

// ` Did you mean "main"?` for a mistyped ref: lives with the git helpers (the analyzer needs it too).
export { refHint };

export const diffCommand: Command = {
  name: 'diff',
  summary: 'Architecture changes between two refs, your branch or staged work',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('diff', argv, {
        base: { type: 'string', short: 'b' },
        staged: { type: 'boolean' },
        'merge-base': { type: 'boolean' },
        root: { type: 'string' },
        format: { type: 'string' },
        json: { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        copy: { type: 'boolean', short: 'c' },
        'fail-on': { type: 'string', multiple: true },
        exclude: { type: 'string', short: 'e', multiple: true },
        'max-files': { type: 'string' },
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
    const format = values.json ? 'json' : (values.format ?? 'text');
    if (!['text', 'md', 'markdown', 'json'].includes(format)) return usage('--format must be text, md or json.');
    let failOn: FailOn[];
    try {
      failOn = parseFailOn(values['fail-on'] ?? []);
    } catch (error) {
      return usage((error as Error).message);
    }
    const maxFiles = values['max-files'] !== undefined ? Number(values['max-files']) : undefined;
    if (maxFiles !== undefined && (!Number.isFinite(maxFiles) || maxFiles < 1)) return usage('--max-files must be a positive number.');

    // Positionals: [base] [head] [root] or [base..head] [root]; a trailing directory that is not a ref is the root.
    let refs = [...positionals];
    let rootArg = values.root;
    if (!rootArg && refs.length) {
      const last = refs[refs.length - 1];
      if (isDirectory(last) && (refs.length === 3 || !(await resolveCommit(process.cwd(), last)))) rootArg = refs.pop();
    }
    let tips = false;
    const range = refs.length === 1 ? parseRange(refs[0]) : undefined;
    if (range) {
      refs = [range.base, range.head];
      tips = range.tips && !values['merge-base'];
    } else if (refs.some((r) => parseRange(r))) return usage('A range (base..head) replaces the base and head arguments.');
    if (values.base !== undefined) {
      if (range || refs.length > 1) return usage('--base names the base: pass at most a head ref next to it.');
      refs.unshift(values.base);
    }
    if (refs.length > 2) return usage(`Too many arguments: expected [base] [head] [root], got ${positionals.join(' ')}.`);
    if (values.staged && refs.length > 1) return usage('--staged compares with the index; it cannot be combined with a head ref.');
    for (const ref of refs) if (!ref || ref.startsWith('-')) return usage(`Invalid ref "${ref}".`);
    // Run from a sub-folder: the project around it, as every command finds it.
    const root = rootArg !== undefined ? path.resolve(rootArg) : resolveProjectRoot(process.cwd()).root;
    if (!isDirectory(root)) return usage(`Project root "${root}" is not a directory.`);

    const fail = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 1;
    };
    const head = await resolveCommit(root, 'HEAD');
    if (!head) return fail(`${root} is not a git repository with commits — diff compares git versions.`);
    const [baseArg, headArg] = refs;
    const headCommit = headArg ? await resolveCommit(root, headArg) : undefined;
    if (headArg && !headCommit) return fail(`Unknown git ref "${headArg}".${await refHint(root, headArg)}`);
    const baseRef = baseArg ?? (values.staged ? 'HEAD' : (loadConfig(root).config.base ?? (await detectBaseBranch(root)) ?? 'HEAD'));
    const baseTip = await resolveCommit(root, baseRef);
    if (!baseTip) return fail(`Unknown git ref "${baseRef}".${await refHint(root, baseRef)}`);
    // Like a pull request: compare with where the work left the base (the tips only for base..head).
    let baseCommit = baseTip;
    if (!tips) {
      const mergeBase = (await git(root, ['merge-base', headCommit ?? head, baseTip]))?.trim();
      if (!mergeBase) {
        const shallow = (await git(root, ['rev-parse', '--is-shallow-repository']))?.trim() === 'true';
        const pair = `${baseRef} and ${headArg ?? 'HEAD'}`;
        stderr.write(
          shallow
            ? `${pc.red('✖')} No common history between ${pair}: this is a shallow clone.\n  Fetch more history (git fetch --unshallow, or fetch-depth: 0 in actions/checkout), or compare the tips with ${baseRef}..${headArg ?? 'HEAD'}.\n`
            : `${pc.red('✖')} No common history between ${pair}. Compare the tips with ${baseRef}..${headArg ?? 'HEAD'}.\n`,
        );
        return 2;
      }
      baseCommit = mergeBase;
    }

    let delta: ArchitectureDelta;
    try {
      // Warm: parse results of the working tree from .code-visualizer/cache/, base commits from
      // .code-visualizer/snapshots/ (both skipped with --no-cache or CODE_VISUALIZER_NO_CACHE).
      const persist = persistFrom(values['no-cache']);
      const cache = createAnalyzeCache();
      if (persist) loadDiskCache(root, cache);
      const common = { cache, exclude: splitList(values.exclude), maxFiles, toolVersion: VERSION, persist };
      const plain = { git: false, changes: false, history: false, includeSource: false } as const;
      let headData: ReportSnapshot;
      let headConfig: CodeVisualizerConfig;
      let renames: Map<string, string>;
      if (headCommit) {
        headData = await snapshotAt(root, headCommit, common);
        headConfig = (await configAt(root, headCommit)).config;
        renames = await renamesSince(root, baseCommit, headCommit);
      } else if (values.staged) {
        headData = toSnapshot(await analyze({ root, overlay: await overlayForIndex(root), ...plain, ...common }));
        headConfig = (await configAt(root, null)).config;
        renames = await renamesSince(root, baseCommit, 'index');
      } else {
        // With git, so the health matches check, report and pr for the same working tree.
        headData = await analyze({ root, ...plain, git: true, ...common });
        headConfig = loadConfig(root).config;
        renames = await renamesSince(root, baseCommit);
      }
      const baseData = await snapshotAt(root, baseCommit, common);
      delta = compareReports(baseData, headData, {
        config: headConfig,
        base: baseRef === baseCommit || baseRef === short(baseCommit) ? short(baseCommit) : baseRef,
        baseCommit,
        head: headArg ?? (values.staged ? 'staged changes' : 'working tree'),
        renames,
        mergeBase: baseCommit !== baseTip,
      });
      if (persist && cache.dirty) saveDiskCache(root, cache);
    } catch (error) {
      if (error instanceof AnalyzeError) return fail(error.message);
      throw error;
    }

    const failures = deltaFailures(delta, failOn);
    const quiet = !!values.quiet;
    const toStdout = !values.output && !values.copy;
    const colors = pc.createColors(format === 'text' && toStdout && pc.isColorSupported && !!stdout.isTTY);
    // Text for the terminal: file names, symbols and messages come from the repository (control characters shown).
    const failureLines = failures.map((f) => `  ${colors.red('✖')} ${colors.bold(f.rule)} ${safeText(f.message)}`);
    let text: string;
    if (format === 'json') text = JSON.stringify({ ok: failures.length === 0, failures, delta }, null, 2);
    else if (format === 'md' || format === 'markdown') text = architectureDeltaMarkdown(delta);
    else {
      text = renderDeltaText(safeData(delta), colors);
      const lines = [...failureLines];
      if (failOn.length && !failures.length) lines.push(`  ${colors.green('✔')} --fail-on ${failOn.map((f) => (f.threshold !== undefined ? `${f.rule}:${f.threshold}` : f.rule)).join(',')}: nothing got worse`);
      if (lines.length) text += `${lines.join('\n')}\n`;
    }
    // Text on stdout lists the failures itself; everywhere else they go to stderr, so CI logs say why.
    if (failures.length && (format !== 'text' || !toStdout)) stderr.write(`${failures.map((f) => `${pc.red('✖')} ${f.rule}: ${safeText(f.message)}`).join('\n')}\n`);
    if (quiet && toStdout) {
      if (format === 'text' && failureLines.length) stdout.write(`${failureLines.join('\n')}\n`);
    } else if (!(await emitOutput(text, values, { stdout, stderr }, { quiet }))) return 2;
    return failures.length ? 1 : 0;
  },
};
