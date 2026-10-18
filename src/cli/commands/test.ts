import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import { detectBaseBranch, git, workingTreeId } from '../../analyzer/git.js';
import { updateState } from '../../analyzer/state.js';
import { manifestAffectsTests, planFiles, planSummary, selectTests, type SelectionData } from '../../analyzer/test-select.js';
import { formatPct, formatRanges, patchCoverageLine } from '../../shared/coverage.js';
import { coverageFlag, fitCommandLines, isE2eTest, isTestEntry, runnerArgv, runnerDirFor, runnerFor, type RunnerArgvOptions, type TestRunners } from '../../shared/testcmd.js';
import type { LastTestState, PatchCoverage, ReportData, SelectedTest, TestCommand, TestSelection } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { createLinker, plural } from '../format.js';
import { explicitRoot, formatMs, isTTY, parseCommandArgs, persistFrom, Progress, resolveProjectRoot, splitList, STAGE_LABELS, UsageError, type Command } from '../shared.js';
import { analyzeStagedCoverage, unknownRef } from './coverage.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer test [root] [options] [-- <runner args>]

  Run exactly the tests your change affects: changed tests, tests that import the
  changed code (directly or through other files), e2e and API tests that visit or
  request an affected route, and — with --with-cochange — tests that usually change
  together with your files. Each workspace package runs with its own runner (vitest,
  jest, mocha, ava, bun, node --test, playwright, cypress) from its own folder.
  A change to package.json, a lockfile, a tsconfig, a runner config or a test setup
  file runs the whole suite of its package (the root: every package).

${pc.bold('What changed')}
      --changed            Uncommitted work, and your branch's commits since it left the
                           base branch (default)
      --staged             Only what is staged (pre-commit hooks)
      --since <ref>        Everything since <ref> (its merge-base with HEAD)
      --push               The commits you have not pushed yet (pre-push hooks)
  -b, --base <ref>         Base branch for --changed and --push (default: origin/HEAD, main…)

${pc.bold('Selection')}
      --with-cochange      Also run tests that usually change together with your files
                           (git history, "likely related")
      --no-e2e             Leave out end-to-end tests (playwright, cypress, e2e/ folders)
      --no-full            Never run whole suites, not even after a manifest or config change
      --coverage           Run with the runner's coverage flag (vitest, jest, bun, node --test)
                           and print the patch coverage afterwards; a run of only some tests
                           switches the project's global coverage thresholds off

${pc.bold('Output')}
      --list               Print the test files (one per line, relative to the project root,
                           for xargs) instead of running them
      --json               Print the plan as JSON instead of running it
      --dry-run            Print the plan and the commands without running them (also
                           with --json or --list, which never run anything)
      --verbose            Say why each test was selected
  -q, --quiet              Only the runners' output and failures

${pc.bold('Other options')}
      --root <dir>         Project root (default: the project around the current folder)
  -e, --exclude <glob>     Exclude files from the analysis (gitignore syntax)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -h, --help               Show this help

  Exit code: the worst exit code of the runners (0 when nothing needs to run).
  The outcome is recorded in .code-visualizer/state.json (lastTest) for status
  lines and agent hooks.

${pc.bold('Examples')}
  $ npx code-visualizer test
  $ npx code-visualizer test --staged                  ${pc.dim('(pre-commit hook)')}
  $ npx code-visualizer test --push                    ${pc.dim('(pre-push hook)')}
  $ npx code-visualizer test --dry-run --verbose
  $ npx code-visualizer test --list | xargs -r npx vitest run
  $ npx code-visualizer test --coverage -- --reporter=dot
`;

const REASON_TEXT: Record<SelectedTest['reason'], (via?: string) => string> = {
  'changed-test': (via) => (via ? `snapshot ${via} changed` : 'changed'),
  'imports-changed': (via) => `imports ${via ?? 'changed code'}`,
  'route-e2e': (via) => `visits ${via ?? 'an affected route'}`,
  'co-change': (via) => `usually changes with ${via ?? 'a changed file'} (likely related)`,
};

type Mode = TestSelection['mode'];

interface ChangeSource {
  mode: Mode;
  base?: string;
  files: string[];
  commentOnly?: string[];
  /** Where the old and new versions of a changed file are read from: a revision, `:` (the index) or the disk (undefined). */
  before: string;
  after?: string;
}

/** Paths from `git diff --name-only -z --relative` (relative to the analyzed root). */
async function diffNames(root: string, args: string[]): Promise<string[] | undefined> {
  const out = await git(root, ['diff', '--name-only', '-z', '--relative', ...args, '--', '.']);
  return out === undefined ? undefined : out.split('\0').filter(Boolean);
}

/** The ref `--push` compares with: where pushing goes (`@{push}`), the upstream, then the base branch. */
async function pushBase(root: string, base: string | undefined): Promise<string | undefined> {
  for (const ref of ['@{push}', '@{u}']) {
    const name = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', ref]))?.trim();
    if (name) return name;
  }
  return base ?? (await detectBaseBranch(root));
}

/** What changed, per mode. `--changed` and `--since` come from the analysis' own change set. */
async function changeSource(root: string, data: ReportData, mode: Mode, base: string | undefined): Promise<ChangeSource | string> {
  if (mode === 'staged') {
    const files = await diffNames(root, ['--cached']);
    return files ? { mode, files, before: 'HEAD', after: '' } : 'Could not read the staged changes (git diff --cached failed).';
  }
  if (mode === 'push') {
    const ref = await pushBase(root, base);
    if (!ref) return 'Nothing to compare with: this branch has no upstream and no base branch was found — pass --base <ref> or --since <ref>.';
    const files = await diffNames(root, [`${ref}...HEAD`]);
    if (!files) return `Could not compare with ${ref}.`;
    const mergeBase = (await git(root, ['merge-base', ref, 'HEAD']))?.trim();
    return { mode, base: ref, files, before: mergeBase || ref, after: 'HEAD' };
  }
  const c = data.changes;
  const branch = c?.mode === 'branch';
  return { mode, base: branch ? c.base : undefined, files: (c?.files ?? []).map((f) => f.id), commentOnly: c?.commentOnly, before: (branch && c.baseCommit) || 'HEAD' };
}

/**
 * Changed package.json files whose change cannot affect tests (a version bump, a `bin` entry, another
 * script): they must not run whole suites — on a branch that bumped its version, every `test` would.
 */
async function inertManifests(root: string, source: ChangeSource): Promise<string[]> {
  const show = async (rev: string, file: string): Promise<string | undefined> => (await git(root, ['show', `${rev}:./${file}`])) ?? undefined;
  const inert: string[] = [];
  for (const file of source.files.filter((f) => /(^|\/)package\.json$/.test(f))) {
    let after: string | undefined;
    if (source.after !== undefined) after = await show(source.after, file);
    else {
      try {
        after = fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        after = undefined;
      }
    }
    if (!manifestAffectsTests(await show(source.before, file), after)) inert.push(file);
  }
  return inert;
}

/* -------------------------------------------------------------------------- */
/*                                   Running                                  */
/* -------------------------------------------------------------------------- */

/** `node_modules/.bin/<bin>` in `dir` or a folder above it, up to `stop` (the repository), like npm scripts find them. */
export function localBin(dir: string, bin: string, stop: string): string | undefined {
  for (let d = path.resolve(dir); ; ) {
    const candidate = path.join(d, 'node_modules', '.bin', bin);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(d);
    if (d === path.resolve(stop) || parent === d) return undefined;
    d = parent;
  }
}

/** The binary a package-manager command runs: `npx vitest …`, `bunx …`, `pnpm exec …`, `yarn …`. */
function execTarget(argv: string[]): { bin: string; rest: string[]; fetches: boolean } | undefined {
  if ((argv[0] === 'npx' || argv[0] === 'bunx') && argv[1]) return { bin: argv[1], rest: argv.slice(2), fetches: true };
  if (argv[0] === 'pnpm' && argv[1] === 'exec' && argv[2]) return { bin: argv[2], rest: argv.slice(3), fetches: false };
  if (argv[0] === 'yarn' && argv[1]) return { bin: argv[1], rest: argv.slice(2), fetches: false };
  return undefined;
}

/**
 * The program and arguments to spawn for a command, and whether the runner is installed: the locally
 * installed binary instead of the package manager (no start-up cost). npx and bunx are never used for a
 * runner that is not installed — they would ask the registry for it (network) — the binary is run from
 * PATH instead (a global install), or fails with "not installed".
 */
export function resolveRunner(argv: string[], cwd: string, stop: string, platform: NodeJS.Platform = process.platform): { argv: string[]; installed?: boolean } {
  const target = execTarget(argv);
  if (!target) return { argv };
  const local = localBin(cwd, platform === 'win32' ? `${target.bin}.cmd` : target.bin, stop);
  if (local) return { argv: [local, ...target.rest], installed: true };
  // pnpm exec and yarn only run installed binaries (Yarn PnP has no node_modules/.bin): leave them be.
  return target.fetches ? { argv: [target.bin, ...target.rest], installed: false } : { argv };
}

export function spawnArgv(argv: string[], cwd: string, stop: string, platform: NodeJS.Platform = process.platform): string[] {
  return resolveRunner(argv, cwd, stop, platform).argv;
}

/**
 * Whether Ctrl+C must be passed on to the runner. Not when it shares our terminal: the terminal sends
 * SIGINT to the whole foreground process group, runner included, and a second one makes Vitest, Jest and
 * Playwright force-quit (skipping teardown). Without a terminal (`kill -INT <pid>` from a tool) nobody
 * else tells the runner.
 */
export function forwardsSigint(stdio: 'inherit' | 'ignore', tty: boolean): boolean {
  return stdio !== 'inherit' || !tty;
}

export interface RunnerFailure {
  runner: string;
  cwd: string;
  exitCode: number;
  /** The runner is not installed in that package (no node_modules/.bin entry). */
  notInstalled?: boolean;
}

export interface RunResult {
  exitCode: number;
  durationMs: number;
  /** Ctrl+C stopped the run. */
  interrupted: boolean;
  /** The commands that failed, in order. */
  failed: RunnerFailure[];
}

/**
 * Run the commands one after another from their package folders, without a shell (except on Windows,
 * where npx and friends are .cmd files), with the terminal attached. SIGINT is passed on to the running
 * runner and stops the remaining ones. The result is the worst exit code.
 */
export async function runTestCommands(
  commands: TestCommand[],
  options: {
    root: string;
    /** Where to stop looking for `node_modules/.bin` (default: the root). */
    binRoot?: string;
    stdio?: 'inherit' | 'ignore';
    onStart?: (command: TestCommand) => void;
    platform?: NodeJS.Platform;
    /** Pass Ctrl+C on to the running runner (default: see `forwardsSigint`). */
    forwardSigint?: boolean;
  },
): Promise<RunResult> {
  const started = Date.now();
  const platform = options.platform ?? process.platform;
  const stdio = options.stdio ?? 'inherit';
  const forward = options.forwardSigint ?? forwardsSigint(stdio, !!(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY));
  let worst = 0;
  let interrupted = false;
  const failed: RunnerFailure[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  const onSigint = (): void => {
    // Handling SIGINT keeps this process alive until the runner has shut down; the remaining commands are skipped.
    if (forward && !interrupted) child?.kill('SIGINT');
    interrupted = true;
  };
  process.on('SIGINT', onSigint);
  try {
    for (const command of commands) {
      if (interrupted) break;
      options.onStart?.(command);
      const cwd = path.resolve(options.root, command.cwd);
      const resolved = resolveRunner(command.argv, cwd, options.binRoot ?? options.root, platform);
      const [program, ...args] = resolved.argv;
      const win = platform === 'win32';
      // cmd.exe runs npx.cmd & co.: arguments are quoted, and those it could misread are refused.
      const unsafe = win ? [program, ...args].find((a) => /["%^&|<>]/.test(a)) : undefined;
      if (unsafe) {
        process.stderr.write(`${pc.red('✖')} Cannot pass ${unsafe} to ${program} safely on Windows; run it yourself: ${command.display}\n`);
        worst = Math.max(worst, 1);
        failed.push({ runner: command.runner, cwd: command.cwd, exitCode: 1 });
        continue;
      }
      const code = await new Promise<number>((resolve) => {
        const quoted = (a: string): string => (/\s/.test(a) ? `"${a}"` : a);
        child = spawn(win ? quoted(program) : program, win ? args.map((a) => `"${a}"`) : args, { cwd, stdio, shell: win, windowsHide: true });
        child.once('error', (error) => {
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          if (!missing || resolved.installed !== false) process.stderr.write(`${pc.red('✖')} Could not start ${program}: ${error.message}\n`);
          resolve(127);
        });
        child.once('close', (exit, signal) => resolve(exit ?? (signal === 'SIGINT' ? 130 : 1)));
      });
      child = undefined;
      worst = Math.max(worst, code);
      if (code !== 0) {
        const failure: RunnerFailure = { runner: command.runner, cwd: command.cwd, exitCode: code };
        if (resolved.installed === false && code === 127) failure.notInstalled = true;
        failed.push(failure);
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
  return { exitCode: interrupted ? Math.max(worst, 130) : worst, durationMs: Date.now() - started, interrupted, failed };
}

/**
 * The plan as it runs on `platform`. On Windows the runners start through cmd.exe, whose command lines
 * hold at most 8,191 characters: a command that selects at least 80% of its package's tests runs the
 * whole suite instead, and other long ones are split into several runs (see `fitCommandLines`).
 */
export function planForPlatform(
  plan: TestSelection,
  data: SelectionData,
  options: { platform?: NodeJS.Platform; coverage?: boolean; extra?: string[]; e2e?: boolean; budget?: number } = {},
): TestSelection {
  if ((options.platform ?? process.platform) !== 'win32') return plan;
  const runners: TestRunners = data.project.testRunners ?? {};
  // The root's runner never runs "everything" when packages have runners of their own (wrong config).
  const ownRunners = Object.keys(runners).some((d) => d && (runners[d].unit || runners[d].e2e));
  const suites = new Map<string, number>();
  for (const f of data.files) {
    if (f.kind !== 'test' || !isTestEntry(f.id, runners) || (options.e2e === false && isE2eTest(f.id, runners))) continue;
    const dir = runnerDirFor(f.id, runners);
    const key = `${dir}\0${runnerFor(f.id, runners[dir]) ?? ''}`;
    suites.set(key, (suites.get(key) ?? 0) + 1);
  }
  const argvOptions = (dir: string): RunnerArgvOptions => ({ coverage: options.coverage, thresholds: runners[dir]?.coverageThresholds, extra: options.extra });
  const commands = fitCommandLines(plan.commands, {
    argvFor: (c, files) => runnerArgv(c.runner, runners[c.cwd]?.pm, files, argvOptions(c.cwd)),
    suiteSize: (c) => (c.cwd === '' && ownRunners ? undefined : suites.get(`${c.cwd}\0${c.runner}`)),
    budget: options.budget,
  });
  return commands === plan.commands ? plan : { ...plan, commands };
}

/** Packages whose whole suite a plan runs ('' = the root): the plan's own, plus suites run instead of a long selection. */
function suitePackages(plan: TestSelection): string[] {
  return [...new Set([...(plan.fullPackages ?? []), ...plan.commands.filter((c) => c.full).map((c) => c.cwd)])].sort();
}

/** `jest (packages/api)` */
const runnerLabel = (f: { runner: string; cwd: string }): string => `${f.runner}${f.cwd ? ` (${f.cwd})` : ''}`;

/* -------------------------------------------------------------------------- */
/*                                   Command                                  */
/* -------------------------------------------------------------------------- */

function recordLastTest(root: string, state: LastTestState): void {
  try {
    updateState(root, 'lastTest', state);
  } catch {
    /* best effort: a read-only checkout still gets its exit code */
  }
}

/**
 * Patch coverage after a `--coverage` run: from a fresh analysis that reads the new report, compared with
 * what the selection compared with (`base`: `--since` or `--base`).
 */
async function patchAfterRun(root: string, mode: Mode, base: string | undefined, exclude: string[], persist: boolean): Promise<PatchCoverage | undefined> {
  if (mode === 'push') return undefined;
  if (mode === 'staged') {
    const staged = await analyzeStagedCoverage(root, { exclude, persist });
    return typeof staged === 'string' ? undefined : staged.changes?.coverage;
  }
  // Not from a running server: it may not have seen the new report yet.
  const data = await getReport({ root, base, exclude, includeSource: false, history: false, changes: true, server: false, persist, toolVersion: VERSION });
  return data.changes?.coverage;
}

/** A coverage report file, or a folder holding one (`coverage/`). */
function looksLikeCoverageReport(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return /(\.info|\.json)$/i.test(p);
    return path.basename(p) === 'coverage' && ['lcov.info', 'coverage-final.json'].some((name) => fs.existsSync(path.join(p, name)));
  } catch {
    return /(^|[\\/])(coverage|lcov\.info|coverage-final\.json)$/.test(p);
  }
}

export const testCommand: Command = {
  name: 'test',
  summary: 'Run exactly the tests your changes affect (unit, co-change, e2e via routes)',
  async run({ argv, stdout, stderr }) {
    const dash = argv.indexOf('--');
    const extra = dash === -1 ? [] : argv.slice(dash + 1);
    let parsed;
    try {
      parsed = parseCommandArgs('test', dash === -1 ? argv : argv.slice(0, dash), {
        changed: { type: 'boolean' },
        staged: { type: 'boolean' },
        since: { type: 'string' },
        push: { type: 'boolean' },
        base: { type: 'string', short: 'b' },
        'with-cochange': { type: 'boolean' },
        'no-e2e': { type: 'boolean' },
        'no-full': { type: 'boolean' },
        coverage: { type: 'boolean' },
        list: { type: 'boolean' },
        json: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        verbose: { type: 'boolean' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'no-cache': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        root: { type: 'string' },
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
    const modes = [values.changed && '--changed', values.staged && '--staged', values.since !== undefined && '--since', values.push && '--push'].filter(Boolean);
    if (modes.length > 1) return usage(`Use one of ${modes.join(', ')}.`);
    if (values.since !== undefined && !values.since.trim()) return usage('--since needs a git ref, e.g. --since origin/main.');
    if (values.staged && values.base) return usage('--staged compares the index with HEAD; it takes no --base.');
    // --json and --list never run anything: --dry-run next to them changes nothing.
    const outputs = [values.list && '--list', values.json && '--json'].filter(Boolean);
    if (outputs.length > 1) return usage(`Use one of ${outputs.join(', ')}.`);
    if (positionals.length > 1) return usage(`test takes one project root (got ${positionals.join(' ')}); pass runner arguments after --.`);
    const mode: Mode = values.staged ? 'staged' : values.push ? 'push' : values.since !== undefined ? 'branch' : 'working';

    let resolved;
    try {
      resolved = resolveProjectRoot(process.cwd(), explicitRoot(values, positionals));
    } catch (error) {
      if (error instanceof UsageError) return usage(error.message);
      throw error;
    }
    const root = resolved.root;
    const given = values.root ?? positionals[0];
    if (resolved.explicit) {
      // `test --coverage coverage/lcov.info`: report, check and pr take a report path there; test does not.
      if (values.coverage && looksLikeCoverageReport(root)) {
        return usage(`test --coverage takes no path: it runs the tests with the runner's coverage flag. To read a report, use code-visualizer coverage --coverage ${given}.`);
      }
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return usage(`"${given}" is not a directory.`);
    } else if (resolved.fallback) return usage('Not inside a project (no package.json or git repository here or above).');
    if ((await git(root, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') {
      stderr.write(`${pc.red('✖')} ${root} is not a git repository: test selects tests by what changed (run your test runner directly).\n`);
      return 1;
    }
    const since = values.since?.trim();
    const badRef = (since ? await unknownRef(root, since) : undefined) ?? (values.base !== undefined ? await unknownRef(root, values.base) : undefined);
    if (badRef) return usage(badRef);
    const base = values.base?.trim();

    const quiet = !!values.quiet;
    const machine = !!values.json || !!values.list;
    const log = (line = ''): void => {
      if (!quiet && !machine) stdout.write(`${line}\n`);
    };
    const exclude = splitList(values.exclude);
    const persist = persistFrom(values['no-cache']);
    const progress = new Progress(stderr, isTTY(stderr) && !quiet && !machine);
    let data: ReportData;
    try {
      data = await getReport({
        root,
        base: since ?? base,
        exclude,
        includeSource: false,
        history: false,
        // --staged and --push read their changes from git directly.
        changes: mode === 'working' || mode === 'branch',
        persist,
        toolVersion: VERSION,
        onProgress: (stage) => progress.update(STAGE_LABELS[stage]),
      });
    } catch (error) {
      progress.stop();
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    progress.stop();

    const source = await changeSource(root, data, mode, base);
    if (typeof source === 'string') {
      stderr.write(`${pc.red('✖')} ${source}\n`);
      return 1;
    }
    const e2e = !values['no-e2e'];
    const selection = selectTests(data, source.files, {
      mode,
      base: source.base,
      commentOnly: source.commentOnly,
      withCochange: values['with-cochange'],
      e2e,
      full: !values['no-full'],
      notTriggers: values['no-full'] ? undefined : await inertManifests(root, source),
      coverage: values.coverage,
      extra,
    });
    const plan = planForPlatform(selection, data, { coverage: values.coverage, extra, e2e });
    const files = planFiles(data, plan, { e2e });

    if (values.json) {
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }
    if (values.list) {
      for (const f of files) stdout.write(`${f}\n`);
      return 0;
    }

    const link = createLinker({ root, stream: stdout });
    const where = plan.base ? pc.dim(` (vs ${plan.base})`) : mode === 'staged' ? pc.dim(' (staged)') : '';
    if (!source.files.length) {
      log(`  ${pc.green('✔')} No changes${where} — no tests to run.`);
      return 0;
    }
    if (!plan.commands.length) {
      if (plan.selected.length) {
        // Tests were selected but no runner is known for them: say so even with --quiet (exit code 1).
        stderr.write(`${pc.yellow('!')} ${plural(plan.selected.length, 'test file')} affected, but no test runner (vitest, jest, mocha, ava, bun, node --test, playwright, cypress) was detected in package.json:\n`);
        for (const s of plan.selected.slice(0, 20)) stderr.write(`    ${s.file}\n`);
        return 1;
      }
      const skipped = plan.skipped?.length ? pc.dim(` (${plural(plan.skipped.length, 'comment-only edit')})`) : '';
      log(`  ${pc.green('✔')} No tests affected by your ${plural(source.files.length, 'changed file')}${where}${skipped}.`);
      return 0;
    }

    log();
    log(`  ${pc.bold('Tests to run')}${where}: ${planSummary(plan)}`);
    if (plan.full) log(`  ${pc.yellow('!')} Full run${plan.fullPackages?.[0] ? ` of ${plan.fullPackages.join(', ')}` : ''}: ${plan.fullReason}${pc.dim(' (--no-full runs only the affected tests)')}`);
    if (values.verbose) {
      const width = Math.min(60, Math.max(...plan.selected.map((s) => s.file.length)));
      for (const s of plan.selected) log(`    ${link(s.file)}${' '.repeat(Math.max(1, width - s.file.length + 2))}${pc.dim(REASON_TEXT[s.reason](s.via))}`);
    } else {
      const likely = plan.selected.filter((s) => s.reason === 'co-change').length;
      if (likely) log(`  ${pc.dim(`${plural(likely, 'test')} likely related through git history (--verbose shows why each test runs)`)}`);
    }
    for (const c of plan.commands) log(`  ${pc.dim('$')} ${c.display}`);
    if (values.coverage) {
      const without = [...new Set(plan.commands.map((c) => c.runner).filter((r) => !coverageFlag(r)))];
      const unit = without.filter((r) => r !== 'playwright' && r !== 'cypress');
      const e2eRunners = without.filter((r) => r === 'playwright' || r === 'cypress');
      if (unit.length) log(`  ${pc.dim(`${unit.join(', ')}: no coverage flag known — wrap the runner with c8 or nyc to write coverage/lcov.info.`)}`);
      if (e2eRunners.length) log(`  ${pc.dim(`${e2eRunners.join(', ')}: runs without coverage (browser coverage needs its own setup).`)}`);
    }
    if (values['dry-run']) {
      log();
      return 0;
    }
    log();

    const treeId = await workingTreeId(root);
    const binRoot = (await git(root, ['rev-parse', '--show-toplevel']))?.trim() || root;
    // node --test writes its lcov report into coverage/, which must exist.
    if (values.coverage) for (const c of plan.commands) if (c.runner === 'node') fs.mkdirSync(path.join(root, c.cwd, 'coverage'), { recursive: true });
    const result = await runTestCommands(plan.commands, { root, binRoot, onStart: (c) => plan.commands.length > 1 && log(`  ${pc.cyan('▶')} ${c.runner}${c.cwd ? pc.dim(` (${c.cwd})`) : ''}`) });
    // Recorded right away (before the coverage analysis below), so analyses that read the new report — this
    // command's and a running server's — know it came from this run. Not tied to --no-cache: it is an outcome.
    recordLastTest(root, {
      at: Date.now(),
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      mode,
      files: plan.commands.flatMap((c) => c.files).sort(),
      full: plan.full || plan.commands.some((c) => c.full),
      ...(suitePackages(plan).length ? { fullPackages: suitePackages(plan) } : {}),
      durationMs: result.durationMs,
      treeId,
      command: plan.commands.map((c) => c.display).join(' && '),
      ...(values.coverage ? { coverage: true } : {}),
    });
    const ran = plan.full ? `${files.length} of ${plan.totalTests} test files (full run)` : `${files.length} of ${plan.totalTests} test file${plan.totalTests === 1 ? '' : 's'}`;
    const failedIn = result.failed.length && plan.commands.length > 1 ? ` in ${result.failed.map(runnerLabel).join(', ')}` : '';
    const footer = result.interrupted
      ? `${pc.yellow('!')} Interrupted after ${formatMs(result.durationMs)}`
      : result.exitCode === 0
        ? `${pc.green('✔')} ran ${ran} in ${formatMs(result.durationMs)}`
        : `${pc.red('✖')} tests failed${failedIn} (exit code ${result.exitCode}) · ran ${ran} in ${formatMs(result.durationMs)}`;
    const hints = result.failed.filter((f) => f.notInstalled).map((f) => `${f.runner} is not installed${f.cwd ? ` in ${f.cwd}` : ''} — install the dependencies (npm install) and run again.`);
    // The runners wrote their own output: the footer goes to stderr when quiet, so failures stay visible.
    if (quiet) {
      if (result.exitCode !== 0) stderr.write(`${[footer, ...hints.map((h) => `${pc.yellow('!')} ${h}`)].join('\n')}\n`);
    } else {
      stdout.write(`\n  ${footer}\n`);
      for (const h of hints) stdout.write(`  ${pc.yellow('!')} ${h}\n`);
    }

    if (values.coverage && !result.interrupted) {
      try {
        const patch = await patchAfterRun(root, mode, since ?? base, exclude, persist);
        if (patch?.coverable) {
          const missed = patch.files.filter((f) => f.uncovered.length);
          log(`  ${patch.pct >= 80 ? pc.green('●') : pc.yellow('●')} ${patchCoverageLine(patch)}${missed.length ? pc.dim(` — uncovered ${missed.slice(0, 2).map((f) => `${f.file} ${formatRanges(f.uncovered, 2)}`).join(', ')}`) : ''}`);
        } else if (patch) log(`  ${pc.dim(`Patch coverage: no executable lines changed (${formatPct(patch.pct)})`)}`);
        else log(`  ${pc.dim('No coverage report found after the run (does the runner write coverage/coverage-final.json or lcov.info?).')}`);
        if (patch?.unmeasured?.length) log(`  ${pc.dim(`Not measured (no coverage report for their package): ${patch.unmeasured.slice(0, 3).join(', ')}${patch.unmeasured.length > 3 ? ', …' : ''}`)}`);
      } catch {
        /* the run's result stands */
      }
    }
    log();
    return result.exitCode;
  },
};
