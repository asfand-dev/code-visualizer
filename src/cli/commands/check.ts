import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import { checkKeyWarnings, loadConfig, type LoadedConfig } from '../../analyzer/config.js';
import { allFindings, evaluateGates, failingFindings, type Thresholds } from '../../analyzer/gates.js';
import { BaselineError, baselineFromFindings, baselineSize, DEFAULT_BASELINE_FILE, ratchetBaseline, readBaseline, writeBaseline } from '../../analyzer/baseline.js';
import { detectBaseBranch, git, refHint, resolveCommit } from '../../analyzer/git.js';
import { updateState } from '../../analyzer/state.js';
import { escapeData, githubAnnotations } from '../../report/formats/github.js';
import { gitlabReport } from '../../report/formats/gitlab.js';
import { sarifLog } from '../../report/formats/sarif.js';
import { checkSummaryMarkdown } from '../../report/formats/summary.js';
import { deltaBaseLabel } from '../../shared/markdown.js';
import { shellQuote } from '../../shared/testcmd.js';
import type { Baseline, CheckMode, CheckResult, LastCheckState, ReportData } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { ANALYSIS_OPTIONS, analysisOptions, banner, coveragePaths, explicitRoot, parseCommandArgs, rootNotice, subprojectNotice, UsageError, type Command } from '../shared.js';
import { ANALYSIS_HELP_BASE } from './report.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer check [root] [options]

  Quality gates for CI and git hooks. Exits with code 1 when a gate fails.
  Gates come from "check" in code-visualizer.config.json (or package.json
  "codeVisualizer") and can be overridden with flags.
${ANALYSIS_HELP_BASE}

${pc.bold("Don't make it worse")}
      --changed            Fail only on findings that are new on your branch / in your
                           uncommitted work (compared with the merge-base); old debt is counted
      --new-since <ref>    Fail only on findings that are new since <ref> (its merge-base with HEAD)
      --staged             Judge what you are about to commit (the index) against HEAD;
                           unstaged edits are ignored — for pre-commit hooks
      --committed          With --changed or --new-since: judge only what you committed (HEAD);
                           uncommitted and untracked edits are ignored — for pre-push hooks
      --baseline [file]    Fail only on findings that are not in the baseline file (default:
                           code-visualizer.baseline.json, used automatically when it exists)
      --no-baseline        Ignore the baseline file
      --update-baseline    Write the baseline: removes fixed findings; new ones only with --force
                           (analyzes the whole project: not with --file, --directory, --exclude)
      --force              With --update-baseline: also accept the new findings
      --max-health-drop <n>
                           Fail when health drops by more than n points compared with the base
      --no-worse           Fail when a function you changed got more complex
      --max-new-clones <n> Fail when the change adds more than n copy-paste clones (copies of at
                           least half a function, "clones.minSimilarity"; old copies never fail)
  ${pc.dim('In CI the base is the pull request target (GITHUB_BASE_REF, GitLab, Bitbucket, Azure, Jenkins).')}

${pc.bold('Thresholds')}
      --max-cycles <n>     Fail when there are more circular dependencies
      --max-complexity <n> Fail when a function is more complex than this
      --min-health <n>     Fail when the health score is lower than this (0–100); with --changed,
                           only when your change lowers a score below it
      --max-risk <n>       Fail when the risk of your changes is higher (0–100, with --changed)
      --min-patch-coverage <n>
                           Fail when less than n% of the lines you added are covered by tests
                           (reads coverage/coverage-final.json or lcov.info; fails without one
                           when you changed code — "check": { "patchCoverage":
                           { "allowMissingReport": true } } skips it instead)

${pc.bold('Output')}
      --format <f>         text (default), json, github (annotations), sarif, gitlab
                           (Code Quality report) or markdown (job summary)
      --json [file]        JSON on stdout (same as --format json), or also write it to a file
      --sarif <file>       Also write SARIF 2.1.0 (GitHub code scanning)
      --gitlab <file>      Also write a GitLab Code Quality report
      --no-summary         Don't append the summary to $GITHUB_STEP_SUMMARY in GitHub Actions
  -q, --quiet              Only print failing gates and their new findings (to stderr)
      --quiet-pass         Like --quiet, plus one line when everything passed (for git hooks)
  -h, --help               Show this help

${pc.bold('Hygiene')}
  Fails on focused tests (it.only, fdescribe), debugger statements and merge conflict
  markers in the lines you added: your staged, committed or uncommitted work (a plain
  check judges the lines your branch adds). Configure it with "check": { "hygiene": false },
  { "debugger": false } or { "exclude": ["test/fixtures/**"] }.

${pc.bold('Declared dependencies')}
  Always on: fails when code imports a package its package.json doesn't declare,
  or when production code imports a package listed only in devDependencies.
  Allow them in code-visualizer.config.json:
    { "check": { "allowMissingDependencies": true } }
    { "check": { "allowDevDependenciesInProduction": ["electron"] } }   (true allows all)

${pc.bold('Examples')}
  $ npx code-visualizer check
  $ npx code-visualizer check --changed --format github --sarif cv.sarif
  $ npx code-visualizer check --staged                 ${pc.dim('(pre-commit hook)')}
  $ npx code-visualizer hooks install                  ${pc.dim('(run it before every commit and push)')}
  $ npx code-visualizer check --update-baseline         ${pc.dim('(adopt on an existing codebase)')}
  $ npx code-visualizer check --max-cycles 0 --min-health 70
  $ npx code-visualizer check --changed --min-patch-coverage 80   ${pc.dim('(after npm test -- --coverage)')}
  $ npx code-visualizer check --changed --max-new-clones 0        ${pc.dim('(no new copy-paste code)')}
`;

const FORMATS = ['text', 'json', 'github', 'sarif', 'gitlab', 'markdown', 'md'];
const DELTA_MODES: CheckMode[] = ['changed', 'new-since', 'staged'];

function numberFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n)) throw new UsageError(`${name} must be a number.`);
  return n;
}

/** A number flag within [min, max] (`--min-health 0–100`). */
function rangeFlag(value: string | undefined, name: string, min: number, max: number): number | undefined {
  const n = numberFlag(value, name);
  if (n !== undefined && (n < min || n > max)) throw new UsageError(`${name} must be a number from ${min} to ${max}.`);
  return n;
}

// --- clone-radar ---
/** A number flag that counts something (0 or more). */
function countFlag(value: string | undefined, name: string): number | undefined {
  const n = numberFlag(value, name);
  if (n !== undefined && n < 0) throw new UsageError(`${name} must be 0 or more.`);
  return n;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(path.resolve(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Flags with an optional value: `--json` alone means JSON on stdout, `--baseline` alone the default file.
 * A following argument is their value unless it is an existing directory (then it is the root).
 */
function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (arg === '--json' || arg === '--baseline') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && !isDirectory(next)) {
        out.push(`${arg}=${next}`);
        i++;
      } else out.push(`${arg}=`);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Where the analyzed root sits in its repository (`packages/app/`), for paths in CI reports. */
async function repoPrefix(root: string, gitOn: boolean): Promise<string> {
  if (!gitOn) return '';
  return ((await git(root, ['rev-parse', '--show-prefix'])) ?? '').trim();
}

function writeOutput(file: string, text: string): void {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function jsonReport(result: CheckResult): string {
  const { ok, mode, base, health, healthDelta, gates, fixed, notes, newOnly } = result;
  // `changedOnly` is kept for scripts written against earlier versions.
  return `${JSON.stringify({ ok, mode, changedOnly: DELTA_MODES.includes(mode), newOnly, base, health, healthDelta, gates, fixed, notes }, null, 2)}\n`;
}

/** The thresholds of a configuration with the command-line flags applied. */
function thresholdsFrom(config: LoadedConfig, flags: Partial<Thresholds>): Thresholds {
  const c = config.config.check ?? {};
  return {
    ...c,
    maxCycles: flags.maxCycles ?? c.maxCycles,
    maxComplexity: flags.maxComplexity ?? c.maxComplexity,
    minHealth: flags.minHealth ?? c.minHealth,
    maxRisk: flags.maxRisk ?? c.maxRisk,
    maxHealthDrop: flags.maxHealthDrop ?? c.maxHealthDrop,
    noWorse: flags.noWorse || c.noWorse,
    minPatchCoverage: flags.minPatchCoverage ?? c.minPatchCoverage,
    // --- clone-radar ---
    maxNewClones: flags.maxNewClones ?? c.maxNewClones,
    allowMissingDependencies: c.allowMissingDependencies ?? false,
    allowDevDependenciesInProduction: c.allowDevDependenciesInProduction ?? false,
    allowRuleViolations: c.allowRuleViolations ?? false,
  };
}

/** Whether the analysis must compare with the base commit (new-only modes, health drop, --no-worse). */
function needsDelta(mode: CheckMode, thresholds: Thresholds): boolean {
  return (DELTA_MODES.includes(mode) && (thresholds.changedMode ?? 'new') === 'new') || thresholds.maxHealthDrop !== undefined || !!thresholds.noWorse || /* clone-radar */ thresholds.maxNewClones !== undefined;
}

/** The configuration the analysis uses: with `--max-complexity`, the base comparison judges complexity by it too. */
function withComplexity(config: LoadedConfig, thresholds: Thresholds): LoadedConfig {
  const check = config.config.check ?? {};
  if (thresholds.maxComplexity === check.maxComplexity) return config;
  return { ...config, config: { ...config.config, check: { ...check, maxComplexity: thresholds.maxComplexity } } };
}

/** One line on what the check compared with. */
function scopeLine(result: CheckResult, data: ReportData, baseline: Baseline | undefined): string | undefined {
  const files = data.changes?.files.length ?? 0;
  const changed = files ? pc.dim(` · ${files} changed file${files === 1 ? '' : 's'}`) : '';
  // `changedMode: "files"` (or a failed comparison) judges every finding in the touched files.
  const compared = !!result.newOnly;
  if (result.mode === 'baseline' && baseline) return `Only findings that are not in ${pc.bold(result.base ?? DEFAULT_BASELINE_FILE)} fail ${pc.dim(`(${baselineSize(baseline)} known)`)}`;
  if (result.mode === 'staged' && compared) return `Only new findings in your staged changes fail ${pc.dim('(compared with HEAD)')}${changed}`;
  if (DELTA_MODES.includes(result.mode)) {
    const delta = data.changes?.delta;
    if (!compared || !delta) return `Judging the files you changed${data.changes?.base ? pc.dim(` (since ${data.changes.base})`) : ''}${changed}`;
    return `Only new findings fail ${pc.dim(`(compared with ${deltaBaseLabel(delta, (s) => s)})`)}${changed}`;
  }
  return undefined;
}

function printText(result: CheckResult, data: ReportData, baseline: Baseline | undefined, log: (line?: string) => void, printed: Set<string>): void {
  const scope = scopeLine(result, data, baseline);
  if (scope) log(`  ${scope}`);
  const notes = (result.notes ?? []).filter((n) => !printed.has(n));
  for (const note of notes) log(`  ${pc.yellow('!')} ${note}`);
  if (scope || notes.length) log();
  for (const g of result.gates) {
    log(`  ${g.ok ? pc.green('✔') : pc.red('✖')} ${pc.bold(g.label)} ${pc.dim(g.detail)}`);
    const compared = !!g.counts;
    let shown;
    if (compared) shown = g.findings.filter((f) => f.status === 'new').slice(0, g.ok ? 5 : 20);
    // Allowed dependency findings stay visible (as warnings) so you still see which package and file.
    else shown = g.findings.filter((f) => !g.ok || f.severity === 'error' || g.id === 'dependencies').slice(0, g.ok ? 5 : 20);
    const failing = new Set(failingFindings(g));
    for (const f of shown) log(`      ${failing.has(f) ? pc.red('•') : pc.yellow('•')} ${pc.dim(`${f.file}${f.line ? `:${f.line}` : ''}`)} ${f.message}${compared ? pc.dim(f.worsened ? ' (worse)' : ' (new)') : ''}`);
    const total = compared ? (g.counts?.new ?? 0) : g.findings.length;
    if (total > shown.length && (!g.ok || compared)) log(`      ${pc.dim(`… ${total - shown.length} more`)}`);
    if (compared) {
      const named = result.fixed.filter((f) => f.gate === g.id && f.file).slice(0, 3);
      for (const f of named) log(`      ${pc.green('✔')} ${pc.dim(`${f.file}${f.line ? `:${f.line}` : ''}`)} ${pc.dim(`fixed: ${f.message}`)}`);
    }
    // --- daily-loop ---
    if (g.id === 'hygiene' && !g.ok) log(`      ${pc.dim(HYGIENE_HINT)}`);
    if (g.id === 'dependencies' && !g.ok && g.findings.some((f) => f.ruleId === 'cv/dev-dependency-in-production' && f.severity === 'error')) {
      log(`      ${pc.dim('Intentional (a runtime-provided or bundled package)? Set "check": { "allowDevDependenciesInProduction": ["<name>"] } in code-visualizer.config.json.')}`);
    }
  }
  log();
  const failed = result.gates.filter((g) => !g.ok);
  const d = result.healthDelta;
  const delta = d === undefined ? '' : d > 0 ? pc.green(` ▲ ${d} vs base`) : d < 0 ? pc.red(` ▼ ${-d} vs base`) : pc.dim(' ±0 vs base');
  const risk = data.changes && DELTA_MODES.includes(result.mode) ? pc.dim(` · change risk ${data.changes.risk.score}/100`) : '';
  log(`  Health ${pc.bold(`${data.health.score}/100`)} ${pc.dim(`(${data.health.grade})`)}${delta}${risk}`);
  log(failed.length ? `  ${pc.red(pc.bold(`${failed.length} gate${failed.length === 1 ? '' : 's'} failed`))}` : `  ${pc.green(pc.bold('All gates passed'))}`);
  // A first full run on an existing codebase fails on old debt: point at the two ways to adopt the gates.
  // Findings that are new by nature (patch coverage, --no-worse) are not old debt, and hygiene judges
  // added lines: neither a baseline nor --changed absorbs it.
  if (result.mode === 'all' && failed.some((g) => g.id !== 'hygiene' && g.findings.some((f) => !f.status))) {
    log(`  ${pc.dim('Old debt? Run `code-visualizer check --update-baseline` once and commit the file, or use `check --changed` in CI: then only new findings fail.')}`);
  }
  if (!data.config) log(`  ${pc.dim('Tip: add architecture rules and thresholds in code-visualizer.config.json — see the README.')}`);
  log();
}

/** `--quiet`: only what failed — the failing gates and the findings that fail them — for hooks. */
function printFailures(result: CheckResult, write: (line: string) => void): void {
  for (const g of result.gates.filter((x) => !x.ok)) {
    write(`${pc.red('✖')} ${pc.bold(g.label)} ${pc.dim(g.detail)}`);
    const failing = failingFindings(g);
    for (const f of failing.slice(0, 20)) write(`    ${pc.red('•')} ${pc.dim(`${f.file}${f.line ? `:${f.line}` : ''}`)} ${f.message}`);
    if (failing.length > 20) write(`    ${pc.dim(`… ${failing.length - 20} more`)}`);
    if (g.id === 'hygiene') write(`    ${pc.dim(HYGIENE_HINT)}`);
  }
}

// --- daily-loop ---
const HYGIENE_HINT = 'Remove them before you commit — or, for files that need them, set "check": { "hygiene": { "exclude": ["<path>/**"] } }.';

/**
 * `--quiet-pass`: one line when every gate passed (`✔ code-visualizer: 7 gates passed · staged vs HEAD ·
 * health 76`); after a failure, how to skip the hook once.
 */
function quietPassLine(result: CheckResult, data: ReportData, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream, committedOnly = false): void {
  const hook = process.env.CODE_VISUALIZER_HOOK;
  if (!result.ok) {
    if (hook) stderr.write(`${pc.dim(`Skip once: CODE_VISUALIZER_SKIP=1 git ${hook === 'pre-push' ? 'push' : 'commit'} …`)}\n`);
    return;
  }
  const committed = committedOnly && result.mode !== 'staged' ? 'committed, ' : '';
  const what = result.mode === 'staged' ? 'staged vs HEAD' : DELTA_MODES.includes(result.mode) && result.base ? `${committed}new vs ${result.base}` : result.mode === 'baseline' ? `new vs ${result.base ?? DEFAULT_BASELINE_FILE}` : undefined;
  const gates = result.gates.length;
  const parts = [`${gates} gate${gates === 1 ? '' : 's'} passed`, what, `health ${data.health.score}`].filter(Boolean);
  stdout.write(`${pc.green('✔')} code-visualizer: ${parts.join(pc.dim(' · '))}\n`);
}

/**
 * The baseline of a whole-project check: `--baseline <file>`, "check.baseline", or the default file when it
 * exists (none with `--no-baseline` / `"baseline": false`). A string is a usage problem.
 */
function pickBaseline(
  root: string,
  configured: Thresholds['baseline'],
  values: { baseline?: string; 'no-baseline'?: boolean; 'update-baseline'?: boolean },
): { file?: string; baseline?: Baseline } | string {
  if (values['no-baseline'] || configured === false) return {};
  const explicit = !!values.baseline || typeof configured === 'string' || configured === true;
  const file = values.baseline ? path.resolve(values.baseline) : path.resolve(root, typeof configured === 'string' ? configured : DEFAULT_BASELINE_FILE);
  if (values['update-baseline']) return { file };
  let baseline: Baseline | undefined;
  try {
    baseline = readBaseline(file);
  } catch (error) {
    if (error instanceof BaselineError) return error.message;
    throw error;
  }
  if (!baseline && (explicit || values.baseline !== undefined)) return `Baseline ${path.relative(process.cwd(), file) || file} not found — create it with "code-visualizer check --update-baseline".`;
  return { file, baseline };
}

/** Whether the analysis covers only part of the project (a baseline needs all of it). */
function isScoped(options: { file?: string; directory?: string; exclude?: string[]; maxFiles?: number }): string | undefined {
  if (options.file) return '--file';
  if (options.directory) return '--directory';
  if (options.exclude?.length) return '--exclude';
  if (options.maxFiles !== undefined) return '--max-files';
  return undefined;
}

export const checkCommand: Command = {
  name: 'check',
  summary: 'Quality gates for CI: rules, cycles, complexity, health, risk',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('check', normalizeArgv(argv), {
        ...ANALYSIS_OPTIONS,
        changed: { type: 'boolean' },
        'new-since': { type: 'string' },
        staged: { type: 'boolean' },
        // --- daily-loop ---
        committed: { type: 'boolean' },
        baseline: { type: 'string' },
        'no-baseline': { type: 'boolean' },
        'update-baseline': { type: 'boolean' },
        force: { type: 'boolean' },
        'max-cycles': { type: 'string' },
        'max-complexity': { type: 'string' },
        'min-health': { type: 'string' },
        'max-risk': { type: 'string' },
        'max-health-drop': { type: 'string' },
        'no-worse': { type: 'boolean' },
        'min-patch-coverage': { type: 'string' },
        // --- clone-radar ---
        'max-new-clones': { type: 'string' },
        coverage: { type: 'string', multiple: true },
        format: { type: 'string' },
        json: { type: 'string' },
        sarif: { type: 'string' },
        gitlab: { type: 'string' },
        'no-summary': { type: 'boolean' },
        // --- daily-loop ---
        'quiet-pass': { type: 'boolean' },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    // --- daily-loop: hooks are quiet unless something fails (and then say how to skip) ---
    if (values['quiet-pass']) values.quiet = true;
    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    const usage = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 2;
    };
    const format = values.format ?? (values.json === '' ? 'json' : 'text');
    if (!FORMATS.includes(format)) return usage('--format must be text, json, github, sarif, gitlab or markdown.');
    const modes = [values.changed && '--changed', values['new-since'] !== undefined && '--new-since', values.staged && '--staged'].filter(Boolean);
    if (modes.length > 1) return usage(`Use one of ${modes.join(', ')}.`);
    if (modes.length && (values.baseline !== undefined || values['update-baseline'])) return usage(`${modes[0]} compares with git; it cannot be combined with --baseline or --update-baseline.`);
    if (values.force && !values['update-baseline']) return usage('--force only applies to --update-baseline.');
    if (values['new-since'] !== undefined && !values['new-since'].trim()) return usage('--new-since needs a git ref, e.g. --new-since origin/main.');
    if (values.staged && values.base) return usage('--staged compares the index with HEAD; it takes no --base.');
    // --- daily-loop ---
    if (values.committed && !values.changed && values['new-since'] === undefined) return usage('--committed applies to --changed or --new-since (it judges what you committed).');

    let options: ReturnType<typeof analysisOptions>;
    let config: LoadedConfig;
    /** Remarks for every output (text, JSON, summary). */
    const notes: string[] = [];
    /** Notes already written to stderr. */
    const printed = new Set<string>();
    let flags: Partial<Thresholds>;
    let explicit: boolean;
    try {
      options = { ...analysisOptions(values, positionals), coverage: coveragePaths(values.coverage) };
      explicit = explicitRoot(values, positionals) !== undefined;
      config = loadConfig(options.root);
      if (config.error) {
        stderr.write(`${pc.red('✖')} Invalid configuration — ${config.error}\n`);
        return 2;
      }
      // A misspelled gate key is a gate that is silently off: say so.
      for (const warning of checkKeyWarnings(config.config.check)) {
        notes.push(warning);
        printed.add(warning);
        stderr.write(`${pc.yellow('!')} ${warning}\n`);
      }
      flags = {
        maxCycles: numberFlag(values['max-cycles'], '--max-cycles'),
        maxComplexity: numberFlag(values['max-complexity'], '--max-complexity'),
        minHealth: rangeFlag(values['min-health'], '--min-health', 0, 100),
        maxRisk: numberFlag(values['max-risk'], '--max-risk'),
        maxHealthDrop: numberFlag(values['max-health-drop'], '--max-health-drop'),
        noWorse: values['no-worse'] || undefined,
        minPatchCoverage: numberFlag(values['min-patch-coverage'], '--min-patch-coverage'),
        // --- clone-radar ---
        maxNewClones: countFlag(values['max-new-clones'], '--max-new-clones'),
      };
    } catch (error) {
      if (error instanceof UsageError) return usage(error.message);
      throw error;
    }
    const root = options.root;
    const gitOn = options.git !== false;
    let thresholds = thresholdsFrom(config, flags);
    let mode: CheckMode = values.staged ? 'staged' : values['new-since'] !== undefined ? 'new-since' : values.changed ? 'changed' : 'all';
    if (DELTA_MODES.includes(mode) && !gitOn) return usage(`${modes[0]} compares with git: remove --no-git.`);
    const fail = (message: string): number => {
      stderr.write(`  ${pc.red('✖')} ${message}\n`);
      return 1;
    };
    const baseRef = values['new-since'] ?? options.base;
    if (baseRef !== undefined && gitOn && !(await resolveCommit(root, baseRef))) {
      return usage(`Unknown git ref "${baseRef}".${await refHint(root, baseRef)}`);
    }
    // A baseline describes the whole project: a partial analysis would drop (or "fix") everything outside it.
    const scoped = isScoped(options);
    if (values['update-baseline'] && scoped) return usage(`--update-baseline needs the whole project: remove ${scoped}.`);

    // The committed baseline: explicit (--baseline, "check.baseline") or the default file when it exists.
    let baselineFile: string | undefined;
    let baseline: Baseline | undefined;
    if (mode === 'all') {
      const picked = pickBaseline(root, thresholds.baseline, values);
      if (typeof picked === 'string') return usage(picked);
      ({ file: baselineFile, baseline } = picked);
      if (baseline) mode = 'baseline';
    }

    const text = format === 'text';
    const log = (line = ''): void => {
      if (text && !values.quiet) stdout.write(`${line}\n`);
    };
    banner(log);
    const where = rootNotice(root, explicit);
    if (where) log(`  ${pc.dim(`ℹ ${where}`)}`);
    let data: ReportData;
    try {
      if (values.committed || mode === 'staged') {
        // --- daily-loop: pre-commit judges the index, pre-push what is pushed (HEAD) — not uncommitted edits ---
        const snapshot = await analyzeSnapshot(root, options, flags, mode === 'staged' ? { of: 'index' } : { of: 'HEAD', mode, base: baseRef });
        if (typeof snapshot === 'string') return usage(snapshot);
        ({ data, thresholds } = snapshot);
        if (mode === 'staged' && !snapshot.hasHead) {
          mode = 'all';
          notes.push('No commits yet — checking everything that is staged.');
        }
      } else {
        const analysisConfig = withComplexity(config, thresholds);
        data = await getReport({
          ...options,
          base: baseRef,
          config: analysisConfig,
          includeSource: false,
          history: false,
          changes: gitOn,
          // --update-baseline judges the whole project: no comparison with the base needed.
          compare: needsDelta(mode, thresholds) && gitOn && !values['update-baseline'],
          // A running server judged complexity with the configured limit, not this flag's.
          ...(analysisConfig !== config ? { server: false } : {}),
        });
      }
    } catch (error) {
      if (error instanceof AnalyzeError) return fail(error.message);
      throw error;
    }

    const notice = subprojectNotice(data);
    if (notice) log(`  ${pc.dim(`ℹ ${notice}`)}`);
    /** Hints that something was not compared as asked (CI: a `::warning::`, a SARIF notification). */
    const warnings: string[] = [];
    const comparing = DELTA_MODES.includes(mode);
    if (comparing && !data.git) {
      // Not a git repository (an exported tarball) or no commits yet: there is no base to compare with.
      notes.push('No git history to compare with — checking everything.');
      mode = 'all';
    } else if (comparing && mode !== 'staged' && !data.changes?.files.length && !data.changes?.base) {
      // "Nothing changed" is only true when there was something to compare with: a CI checkout without the
      // base branch, or too shallow to reach the merge-base, must not pass silently.
      const hint = await unresolvedBase(root, baseRef, config.config.base);
      if (hint) {
        warnings.push(hint);
        notes.push(hint);
        printed.add(hint);
        stderr.write(`${pc.yellow('!')} ${hint}\n`);
        mode = 'all';
      }
    }
    // Checking everything after all: the committed baseline (when there is one) still holds the old debt.
    if (comparing && mode === 'all') {
      const picked = pickBaseline(root, thresholds.baseline, values);
      if (typeof picked === 'string') return usage(picked);
      ({ file: baselineFile, baseline } = picked);
      if (baseline) mode = 'baseline';
    }

    if (values['update-baseline']) return updateBaseline(data, thresholds, baselineFile ?? path.resolve(root, DEFAULT_BASELINE_FILE), { force: !!values.force, format, log, stdout, stderr, root });

    // Nothing changed: nothing can be new (the CI outputs are still written, empty).
    const nothing = DELTA_MODES.includes(mode) && !data.changes?.files.length;
    let result: CheckResult;
    if (nothing) {
      result = { ok: true, mode, base: data.changes?.base, health: data.health.score, gates: [], fixed: [], notes: ['No changes — nothing to check'] };
    } else {
      const baselineLabel = baselineFile && (path.relative(root, baselineFile).split(path.sep).join('/') || DEFAULT_BASELINE_FILE);
      result = evaluateGates(data, thresholds, {
        mode,
        delta: data.changes?.delta,
        baseline,
        base: mode === 'baseline' ? baselineLabel : undefined,
        changedMode: thresholds.changedMode,
        partial: !!scoped,
      });
    }
    if (notes.length) result.notes = [...notes, ...(result.notes ?? [])];

    const needsPrefix = ['github', 'sarif', 'gitlab', 'markdown', 'md'].includes(format) || !!values.sarif || !!values.gitlab || !!process.env.GITHUB_STEP_SUMMARY;
    const prefix = needsPrefix ? await repoPrefix(root, gitOn) : '';
    const command = reproduceCommand(mode, { prefix, base: values['new-since'] === undefined ? options.base : undefined, newSince: values['new-since'], committed: !!values.committed });
    const summary = (): string => checkSummaryMarkdown(result, data, { prefix, env: process.env, version: VERSION, command });
    const sarif = (): string => sarifText(result, prefix, warnings);
    if (format === 'json') stdout.write(jsonReport(result));
    else if (format === 'github') stdout.write(`${warnings.map((w) => `::warning title=code-visualizer::${escapeData(w)}\n`).join('')}${githubAnnotations(result, { prefix })}`);
    else if (format === 'sarif') stdout.write(sarif());
    else if (format === 'gitlab') stdout.write(gitlabReport(result, { prefix }));
    else if (format === 'markdown' || format === 'md') stdout.write(summary());
    else if (nothing) {
      log(`  ${pc.green('✔')} No changes — nothing to check${mode === 'staged' ? ' (nothing is staged)' : data.changes?.base ? pc.dim(` (compared with ${data.changes.base})`) : ''}\n`);
      if (values['quiet-pass']) stdout.write(`${pc.green('✔')} code-visualizer: ${mode === 'staged' ? 'nothing staged' : 'no changes'} to check\n`);
    } else if (text && values.quiet) {
      printFailures(result, (line) => stderr.write(`${line}\n`));
      if (values['quiet-pass']) quietPassLine(result, data, stdout, stderr, !!values.committed);
    } else printText(result, data, baseline, log, printed);

    // Several outputs from one analysis (CI: annotations on stdout, SARIF and Code Quality files).
    try {
      if (values.sarif) writeOutput(values.sarif, sarif());
      if (values.gitlab) writeOutput(values.gitlab, gitlabReport(result, { prefix }));
      if (values.json) writeOutput(values.json, jsonReport(result));
    } catch (error) {
      stderr.write(`${pc.red('✖')} Cannot write the report: ${(error as Error).message}\n`);
      return 2;
    }
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary && !values['no-summary']) {
      try {
        fs.appendFileSync(stepSummary, `${summary()}\n`);
      } catch {
        stderr.write(`${pc.yellow('!')} Could not append to $GITHUB_STEP_SUMMARY\n`);
      }
    }
    recordLastCheck(root, options.persist, result);
    return result.ok ? 0 : 1;
  },
};

/** The command that reproduces this check from the repository root (for the job summary). */
function reproduceCommand(mode: CheckMode, o: { prefix: string; base?: string; newSince?: string; committed?: boolean }): string {
  const args = ['code-visualizer', 'check'];
  // The analyzed root inside the repository (`app/`), so the command checks the same project.
  const root = o.prefix.replace(/\/+$/, '');
  if (root) args.push(shellQuote(root));
  if (mode === 'changed') args.push('--changed');
  else if (mode === 'staged') args.push('--staged');
  else if (mode === 'new-since' && o.newSince) args.push('--new-since', shellQuote(o.newSince));
  if (o.base && mode !== 'staged') args.push('--base', shellQuote(o.base));
  if (o.committed && mode !== 'staged') args.push('--committed');
  return args.join(' ');
}

/** `.code-visualizer/state.json` → lastCheck, for status lines and hooks (not with --no-cache). */
function recordLastCheck(root: string, persist: boolean | undefined, result: CheckResult): void {
  if (!persist) return;
  const failed = result.gates.filter((g) => !g.ok).map((g) => g.id);
  const compared = result.gates.some((g) => g.counts);
  const state: LastCheckState = {
    at: Date.now(),
    ok: result.ok,
    mode: result.mode,
    failures: failed.length,
    failed,
    newFindings: allFindings(result).filter((f) => !compared || f.status === 'new').length,
  };
  try {
    updateState(root, 'lastCheck', state);
  } catch {
    /* best effort: a read-only checkout still gets its exit code */
  }
}

/** What `--staged` and `--committed` judge instead of the working tree. */
type SnapshotSide = { of: 'index' } | { of: 'HEAD'; mode: CheckMode; base?: string };

/**
 * A snapshot of the project instead of the working tree, with its configuration from the snapshot too:
 * - `--staged` (`of: 'index'`): the index — unstaged edits and untracked files left out — compared with HEAD;
 * - `--committed` (`of: 'HEAD'`, with `--changed` / `--new-since`): HEAD — uncommitted and untracked edits
 *   left out — compared with the merge-base: what a push sends.
 * Parse results of the working tree are reused for every file whose content is the same.
 */
async function analyzeSnapshot(
  root: string,
  options: ReturnType<typeof analysisOptions>,
  flags: Partial<Thresholds>,
  side: SnapshotSide,
): Promise<{ data: ReportData; thresholds: Thresholds; hasHead: boolean } | string> {
  const index = side.of === 'index';
  if (index && (await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return '--staged needs a git repository (it checks what you are about to commit).';
  const hasHead = !!(await resolveCommit(root, 'HEAD'));
  if (!index && !hasHead) return '--committed needs a commit (this repository has none yet).';
  const [{ analyze, createAnalyzeCache }, snapshot, { loadDiskCache, saveDiskCache }] = await Promise.all([
    import('../../analyzer/index.js'),
    import('../../analyzer/snapshot.js'),
    import('../../analyzer/disk-cache.js'),
  ]);
  const config = await snapshot.configAt(root, index ? null : 'HEAD');
  if (config.error) return `Invalid configuration (${index ? 'staged' : 'HEAD'}) — ${config.error}`;
  const thresholds = thresholdsFrom(config, flags);
  const cache = createAnalyzeCache();
  if (options.persist) loadDiskCache(root, cache);
  const data = await analyze({
    ...options,
    root,
    base: side.of === 'HEAD' ? side.base : undefined,
    overlay: index ? await snapshot.overlayForIndex(root) : await snapshot.overlayForRef(root, 'HEAD'),
    config: withComplexity(config, thresholds),
    ...(index ? { staged: true } : { committed: true }),
    changes: true,
    // A repository without commits has nothing to compare the index with.
    compare: side.of === 'HEAD' ? needsDelta(side.mode, thresholds) : needsDelta('staged', thresholds) && hasHead,
    history: false,
    includeSource: false,
    cache,
  });
  if (options.persist && cache.dirty) saveDiskCache(root, cache);
  return { data, thresholds, hasHead };
}

/**
 * Why a `--changed` / `--new-since` run that found no changes had nothing to compare with — undefined when
 * it did (the base and its merge-base with HEAD exist: nothing changed since then). The ref given, else a
 * configured base that exists, else the detected base branch.
 */
async function unresolvedBase(root: string, given: string | undefined, configured: string | undefined): Promise<string | undefined> {
  const base = given ?? (configured && (await resolveCommit(root, configured)) ? configured : await detectBaseBranch(root));
  const shallow = (await git(root, ['rev-parse', '--is-shallow-repository']))?.trim() === 'true';
  const everything = 'checked everything instead';
  if (base && (await resolveCommit(root, base))) {
    if ((await git(root, ['merge-base', 'HEAD', base]))?.trim()) return undefined;
    return `${base} exists but has no common history with HEAD${shallow ? ' (shallow clone)' : ''}: fetch the full history (actions/checkout with fetch-depth: 0, or git fetch --unshallow) — ${everything}.`;
  }
  const fetch = `fetch it (actions/checkout with fetch-depth: 0, or git fetch origin <base branch>) or pass --base`;
  if (shallow) return `This is a shallow clone without the base branch: ${fetch} — ${everything}.`;
  return `No base branch found (origin/HEAD, main, master, develop or trunk): ${fetch} — ${everything}.`;
}

/** SARIF 2.1.0, with the run's warnings (e.g. no base to compare with) as tool notifications. */
function sarifText(result: CheckResult, prefix: string, warnings: string[]): string {
  const log = sarifLog(result, { version: VERSION, prefix });
  if (warnings.length) {
    Object.assign(log.runs[0], {
      invocations: [{ executionSuccessful: true, toolExecutionNotifications: warnings.map((text) => ({ level: 'warning', message: { text } })) }],
    });
  }
  return `${JSON.stringify(log, null, 2)}\n`;
}

/** `--update-baseline`: the ratchet. Fixed findings leave the file; new ones only enter it with --force. */
function updateBaseline(
  data: ReportData,
  thresholds: Thresholds,
  file: string,
  ctx: { force: boolean; format: string; log: (line?: string) => void; stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream; root: string },
): number {
  let previous: Baseline | undefined;
  try {
    previous = readBaseline(file);
  } catch (error) {
    if (!(error instanceof BaselineError) || !ctx.force) {
      ctx.stderr.write(`${pc.red('✖')} ${(error as Error).message}${ctx.force ? '' : ' (rerun with --force to replace it)'}\n`);
      return 2;
    }
  }
  const all = evaluateGates(data, thresholds, { mode: 'all' });
  // Findings judged against git (`--no-worse`: preset `new`) are not debt a baseline can hold.
  const known = baselineFromFindings(allFindings(all).filter((f) => !f.status));
  // Entries of rules whose gate did not run (a threshold not set this time) stay as they are.
  const { baseline, added, removed, rejected } = ratchetBaseline(previous, known, { force: ctx.force, rules: all.ruleIds });
  try {
    writeBaseline(file, baseline);
  } catch (error) {
    ctx.stderr.write(`${pc.red('✖')} Cannot write ${file}: ${(error as Error).message}\n`);
    return 2;
  }
  const name = path.relative(ctx.root, file).split(path.sep).join('/') || file;
  const total = baselineSize(baseline);
  if (ctx.format === 'json') {
    ctx.stdout.write(`${JSON.stringify({ file: name, created: !previous, added, removed, rejected, findings: total }, null, 2)}\n`);
    return 0;
  }
  ctx.log(previous ? `  ${pc.green('✔')} Updated ${pc.bold(name)}: ${pc.yellow(`+${added}`)} ${pc.green(`−${removed}`)} ${pc.dim(`(${total} known finding${total === 1 ? '' : 's'})`)}` : `  ${pc.green('✔')} Created ${pc.bold(name)} with ${total} known finding${total === 1 ? '' : 's'}`);
  if (rejected) ctx.log(`  ${pc.yellow('!')} ${rejected} new finding${rejected === 1 ? ' was' : 's were'} not added — fix ${rejected === 1 ? 'it' : 'them'}, or accept with --update-baseline --force`);
  ctx.log(`  ${pc.dim('Commit it: from now on `code-visualizer check` fails only on findings that are not in it.')}`);
  ctx.log();
  return 0;
}
