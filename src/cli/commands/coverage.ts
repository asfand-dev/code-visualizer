import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import { git, refHint, resolveCommit } from '../../analyzer/git.js';
import { formatPct, formatRanges, patchCoverageLine, reportAge } from '../../shared/coverage.js';
import type { CoverageSummary, PatchCoverage, ReportData } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { createLinker, plural } from '../format.js';
import { explicitRoot, isTTY, parseCommandArgs, persistFrom, Progress, resolveProjectRoot, splitList, STAGE_LABELS, UsageError, type Command } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer coverage [root] [options]

  Patch coverage: how many of the lines your change added a test actually ran, per
  file with the uncovered line ranges — from the coverage report your test runner
  already writes (coverage/coverage-final.json or coverage/lcov.info, at the root and
  in each workspace package). Run your tests with coverage first, e.g.
  ${pc.cyan('code-visualizer test --coverage')} or ${pc.cyan('npx vitest run --coverage')}.

${pc.bold('Options')}
      --changed            Uncommitted work and your branch's commits (default)
      --staged             What you are about to commit
  -b, --base <ref>         Compare with this ref (default: origin/HEAD, main or master)
      --min <pct>          Exit with code 1 when patch coverage is lower (0–100)
      --coverage <path>    The coverage report (file or folder) to read; repeatable
      --json               Machine-readable output (without a report: "reason": "no-report",
                           and the explanation on stderr)
      --root <dir>         Project root (default: the project around the current folder)
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -q, --quiet              Only print the summary line
  -h, --help               Show this help

  In CI: ${pc.cyan('code-visualizer check --changed --min-patch-coverage 80')} (or "check":
  { "minPatchCoverage": 80 } in code-visualizer.config.json).

${pc.bold('Examples')}
  $ npx code-visualizer coverage
  $ npx code-visualizer coverage --base origin/develop --min 80
  $ npx code-visualizer coverage --coverage packages/web/coverage/lcov.info --json
`;

/**
 * The analysis of what is staged (the index as an overlay, its configuration from the index too), with its
 * patch coverage in `changes.coverage` — the same analysis `check --staged` judges, so `coverage --staged`
 * and `check --staged --min-patch-coverage` agree (also on the `coverage` configuration key).
 */
export async function analyzeStagedCoverage(root: string, options: { exclude?: string[]; coverage?: string[]; persist: boolean }): Promise<ReportData | string> {
  const [{ analyze, createAnalyzeCache }, { overlayForIndex, configAt }, { loadDiskCache, saveDiskCache }] = await Promise.all([
    import('../../analyzer/index.js'),
    import('../../analyzer/snapshot.js'),
    import('../../analyzer/disk-cache.js'),
  ]);
  const config = await configAt(root, null);
  if (config.error) return `Invalid configuration (staged) — ${config.error}`;
  const cache = createAnalyzeCache();
  if (options.persist) loadDiskCache(root, cache);
  const data = await analyze({
    root,
    exclude: options.exclude,
    coverage: options.coverage,
    overlay: await overlayForIndex(root),
    config,
    staged: true,
    changes: true,
    compare: false,
    history: false,
    includeSource: false,
    toolVersion: VERSION,
    cache,
  });
  if (options.persist && cache.dirty) saveDiskCache(root, cache);
  return data;
}

/**
 * `Unknown git ref "develp". Did you mean "develop"?` when `ref` names no commit, like `check`, `diff` and
 * `review` say it (`--base` typos must not fall back to another base silently); undefined when it does.
 */
export async function unknownRef(root: string, ref: string): Promise<string | undefined> {
  if (ref.trim() && (await resolveCommit(root, ref.trim()))) return undefined;
  return `Unknown git ref "${ref}".${await refHint(root, ref.trim())}`;
}

/** `Project line coverage 80% (…)` — or, when the reports cover only some packages, which ones. */
export function lineCoverageLabel(report: CoverageSummary): string {
  const numbers = `${formatPct(report.pct * 100)} (${report.lines.covered.toLocaleString('en-US')}/${report.lines.total.toLocaleString('en-US')} lines in ${plural(report.files, 'file')})`;
  if (!report.unmeasured?.length) return `Project line coverage ${numbers}`;
  const missing = report.unmeasured.map((d) => d || 'the project root');
  return `Line coverage ${numbers} · no report for ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`;
}

function printPatch(patch: PatchCoverage, report: CoverageSummary | undefined, min: number | undefined, out: (line?: string) => void, link: (file: string, line?: number, label?: string) => string, quiet: boolean): void {
  const color = min !== undefined ? (patch.pct >= min ? pc.green : pc.red) : patch.pct >= 80 ? pc.green : patch.pct >= 50 ? pc.yellow : pc.red;
  const head = patch.coverable ? patchCoverageLine(patch).replace(formatPct(patch.pct), color(pc.bold(formatPct(patch.pct)))) : patchCoverageLine(patch);
  out(`  ${head} ${pc.dim(`· report from ${reportAge(patch.reportDate)}`)}`);
  if (quiet) return;
  const width = Math.min(56, Math.max(10, ...patch.files.map((f) => f.file.length)));
  for (const f of patch.files) {
    const pct = f.coverable ? Math.floor((f.covered / f.coverable) * 100) : 100;
    const numbers = `${String(pct).padStart(3)}%  ${`${f.covered}/${f.coverable}`.padEnd(7)}`;
    const missed = f.uncovered.length ? `uncovered ${formatRanges(f.uncovered, 6)}${f.missing ? pc.dim(' (no test loads this file)') : ''}` : '';
    out(`    ${link(f.file, f.uncovered[0]?.[0], f.file)}${' '.repeat(Math.max(1, width - f.file.length + 2))}${(pct === 100 ? pc.green : pct >= 50 ? pc.yellow : pc.red)(numbers)}${missed}`);
  }
  if (patch.unmeasured?.length) {
    const list = patch.unmeasured.slice(0, 4).join(', ') + (patch.unmeasured.length > 4 ? ', …' : '');
    out(`  ${pc.yellow('!')} ${pc.yellow(`Not measured (no coverage report for their package): ${list}`)}`);
  }
  if (patch.stale) {
    const files = patch.files.filter((f) => f.stale).map((f) => f.file);
    out(`  ${pc.yellow('!')} ${pc.yellow(`The report is older than your changes${files.length ? ` in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}` : ''} — rerun the tests with coverage.`)}`);
  }
  if (report && report.lines.total) {
    const project = report.partial ? pc.dim(' (affected tests only)') : '';
    out(`  ${pc.dim(lineCoverageLabel(report))}${project}`);
  }
}

export const coverageCommand: Command = {
  name: 'coverage',
  summary: 'Patch coverage of your changes from the local coverage report',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('coverage', argv, {
        changed: { type: 'boolean' },
        staged: { type: 'boolean' },
        base: { type: 'string', short: 'b' },
        min: { type: 'string' },
        coverage: { type: 'string', multiple: true },
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
    if (values.changed && values.staged) return usage('Use one of --changed, --staged.');
    if (values.staged && values.base) return usage('--staged compares the index with HEAD; it takes no --base.');
    const min = values.min === undefined ? undefined : Number(values.min);
    if (min !== undefined && (!values.min!.trim() || !Number.isFinite(min) || min < 0 || min > 100)) return usage('--min must be a number from 0 to 100.');
    if (positionals.length > 1) return usage(`coverage takes one project root (got ${positionals.join(' ')}).`);
    let root: string;
    try {
      root = resolveProjectRoot(process.cwd(), explicitRoot(values, positionals)).root;
    } catch (error) {
      if (error instanceof UsageError) return usage(error.message);
      throw error;
    }
    const paths = values.coverage?.length ? values.coverage.map((p) => path.resolve(p)) : undefined;
    for (const p of paths ?? []) if (!fs.existsSync(p)) return usage(`No coverage report at ${p}.`);
    if ((await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') {
      stderr.write(`${pc.red('✖')} ${root} is not a git repository: patch coverage needs to know what changed.\n`);
      return 1;
    }
    const base = values.base?.trim();
    const badBase = values.base !== undefined ? await unknownRef(root, values.base) : undefined;
    if (badBase) return usage(badBase);
    const progress = new Progress(stderr, isTTY(stderr) && !values.quiet && !values.json);
    const persist = persistFrom(values['no-cache']);
    let data: ReportData;
    try {
      if (values.staged) {
        progress.update(STAGE_LABELS.changes);
        const staged = await analyzeStagedCoverage(root, { exclude: splitList(values.exclude), coverage: paths, persist });
        if (typeof staged === 'string') {
          progress.stop();
          return usage(staged);
        }
        data = staged;
      } else {
        data = await getReport({
          root,
          base,
          exclude: splitList(values.exclude),
          coverage: paths,
          includeSource: false,
          history: false,
          changes: true,
          persist,
          toolVersion: VERSION,
          onProgress: (stage) => progress.update(STAGE_LABELS[stage]),
        });
      }
    } catch (error) {
      progress.stop();
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    progress.stop();
    const out = (line = ''): void => void stdout.write(`${line}\n`);
    const report = data.coverage;
    const patch = data.changes?.coverage;
    const changed = data.changes?.files.length ?? 0;
    const ok = !patch || min === undefined || !patch.coverable || patch.pct >= min;
    const noReport = (): void => {
      stderr.write(`${pc.yellow('!')} No coverage report found (coverage/coverage-final.json or coverage/lcov.info${data.project.workspaces?.length ? ' at the root or in a workspace package' : ''}).\n`);
      stderr.write(`  ${pc.dim('Run your tests with coverage first: code-visualizer test --coverage, or npx vitest run --coverage / npx jest --coverage.')}\n`);
    };
    if (values.json) {
      // Scripts get the reason; people reading the job log get the explanation.
      out(JSON.stringify({ ok: !!report && ok, ...(report ? {} : { reason: 'no-report' }), min, patch, report, base: data.changes?.base }, null, 2));
      if (!report) noReport();
      return !report ? 1 : ok ? 0 : 1;
    }
    for (const w of data.warnings.filter((w) => /coverage report/i.test(w))) stderr.write(`${pc.yellow('!')} ${w}\n`);
    if (!report) {
      noReport();
      return 1;
    }
    if (!patch || changed === 0) {
      out(`  ${pc.green('✔')} No changes${values.staged ? ' staged' : ''}${data.changes?.base ? pc.dim(` compared to ${data.changes.base}`) : ''} — nothing to cover.`);
      return 0;
    }
    const link = createLinker({ root, stream: stdout });
    if (!values.quiet) out();
    printPatch(patch, report, min, out, link, !!values.quiet);
    if (min !== undefined && patch.coverable) out(ok ? `  ${pc.green('✔')} at least ${min}%` : `  ${pc.red('✖')} below the minimum of ${min}%`);
    if (!values.quiet) out();
    return ok ? 0 : 1;
  },
};
