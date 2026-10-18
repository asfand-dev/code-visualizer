/**
 * Ready-to-paste test commands. Pure (no Node APIs), so the analyzer, the CLI, the MCP server and the
 * report UI build exactly the same command for the same test files.
 */
import type { FileInfo, TestCommand, TestRunnerInfo } from './types.js';

export type { TestRunnerInfo };

/** Runners per workspace directory (`''` is the project root), as in `ProjectInfo.testRunners`. */
export type TestRunners = Record<string, TestRunnerInfo>;

const NOT_TESTABLE = new Set(['test', 'story', 'config', 'script', 'types']);

/** Source files that tests are expected to reach (not tests, stories, configs, scripts or declarations). */
export function isTestableSource(f: Pick<FileInfo, 'id' | 'kind'>): boolean {
  return !NOT_TESTABLE.has(f.kind) && !f.id.endsWith('.d.ts');
}

/**
 * End-to-end specs: `e2e/`, `playwright/` and `cypress/` folders, `*.e2e.*` and `*.cy.*` names, and — with
 * the project's runners — files below an e2e runner's own test folder (`testDir` of playwright.config).
 */
export function isE2eTest(id: string, runners?: TestRunners | TestRunnerInfo): boolean {
  if (/(^|\/)(e2e|playwright|cypress)\//.test(id) || /\.(e2e|cy)\.[cm]?[jt]sx?$/.test(id)) return true;
  if (!runners) return false;
  const infos = isRunnerInfo(runners) ? [runners] : Object.values(runners);
  return infos.some((i) => !!i.e2e && i.e2eDir !== undefined && (i.e2eDir === '' || id.startsWith(`${i.e2eDir}/`)));
}

/** POSIX shell quoting: plain paths stay as they are, anything else goes in single quotes (no expansion of `$(…)` or backticks). */
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

const quote = shellQuote;

/** File names unit runners pick up by default: `*.test.*`, `*.spec.*`, `__tests__/`. */
const NAMED_TEST = /(^|\/)__tests__\/|[._-](test|spec)\.[cm]?[jt]sx?$/;

/** Playwright's default testMatch (`*.spec.*`, `*.test.*`) and Cypress specs (`*.cy.*`, or spec-named). */
const PLAYWRIGHT_SPEC = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CYPRESS_SPEC = /\.(cy|test|spec)\.[cm]?[jt]sx?$/;

/**
 * Whether `runner` runs `file` when it is passed on its command line. Vitest, Jest and Bun only run
 * test-named files, so a helper under `test/` would make the run fail ("No test files found"); Playwright
 * and Cypress only run their spec files (page objects, fixtures and support files are not specs); the
 * other runners run what they are given.
 */
export function runnerRuns(runner: string | undefined, file: string): boolean {
  if (runner === 'vitest' || runner === 'jest' || runner === 'bun') return NAMED_TEST.test(file);
  if (runner === 'playwright') return PLAYWRIGHT_SPEC.test(file);
  if (runner === 'cypress') return CYPRESS_SPEC.test(file);
  return true;
}

/** The runner of `info` for a test file: its e2e runner for e2e specs (and when it has no unit runner), else its unit runner. */
function runnerOf(file: string, info: TestRunnerInfo): string | undefined {
  return info.e2e && (!info.unit || isE2eTest(file, info)) ? info.e2e : info.unit;
}

/** The runners of the workspace a file belongs to (the deepest workspace with runners, else the root). */
function runnersFor(file: string, runners: TestRunners): TestRunnerInfo | undefined {
  const dir = Object.keys(runners)
    .filter((d) => d && (runners[d].unit || runners[d].e2e) && file.startsWith(`${d}/`))
    .sort((a, b) => b.length - a.length)[0];
  return runners[dir ?? ''];
}

/**
 * Whether a test-kind file is a test its runner runs, rather than a support file (`test/helpers.ts`,
 * fixtures). True when the runner is not known.
 */
export function isTestEntry(file: string, runners: TestRunners | TestRunnerInfo | undefined): boolean {
  if (!runners) return true;
  const info = isRunnerInfo(runners) ? runners : runnersFor(file, runners);
  if (!info) return true;
  return runnerRuns(runnerOf(file, info), file);
}

function exec(pm: string | undefined, bin: string): string {
  if (pm === 'pnpm') return `pnpm exec ${bin}`;
  if (pm === 'yarn') return `yarn ${bin}`;
  if (pm === 'bun') return `bunx ${bin}`;
  return `npx ${bin}`;
}

/** The command that runs `files` with `runner` (undefined for an unknown runner id). */
export function runnerCommand(runner: string, pm: string | undefined, files: string[]): string | undefined {
  const list = files.map(quote).join(' ');
  switch (runner) {
    case 'vitest':
      return `${exec(pm, 'vitest')} run ${list}`;
    case 'jest':
      return `${exec(pm, 'jest')} --runTestsByPath ${list}`;
    case 'mocha':
      return `${exec(pm, 'mocha')} ${list}`;
    case 'ava':
      return `${exec(pm, 'ava')} ${list}`;
    case 'bun':
      return `bun test ${list}`;
    case 'node':
      return `node --test ${list}`;
    case 'playwright':
      return `${exec(pm, 'playwright')} test ${list}`;
    case 'cypress':
      return `${exec(pm, 'cypress')} run --spec ${quote(files.join(','))}`;
    default:
      return undefined;
  }
}

/**
 * Unit and e2e commands for files that all use the same runners (`files`: paths as they should be passed;
 * `projectIds`: the same files project-relative, to tell e2e specs).
 */
function commandsFor(files: string[], info: TestRunnerInfo, projectIds: string[] = files): { parts: string[]; ids: string[] } {
  const runnerOfFile = new Map(files.map((f, i) => [f, runnerOf(projectIds[i], info)]));
  const e2eFiles = info.e2e ? files.filter((f) => runnerOfFile.get(f) === info.e2e && runnerRuns(info.e2e, f)) : [];
  const unitFiles = files.filter((f) => runnerOfFile.get(f) !== info.e2e && runnerRuns(info.unit, f));
  const parts: string[] = [];
  const ids: string[] = [];
  const unit = unitFiles.length && info.unit ? runnerCommand(info.unit, info.pm, unitFiles) : undefined;
  if (unit) {
    parts.push(unit);
    ids.push(info.unit!);
  }
  const e2e = e2eFiles.length && info.e2e ? runnerCommand(info.e2e, info.pm, e2eFiles) : undefined;
  if (e2e) {
    parts.push(e2e);
    ids.push(info.e2e!);
  }
  return { parts, ids };
}

/**
 * A command that runs exactly these test files. Each file runs with the runner of the workspace package
 * that declares it (`runnerDirFor`), from that package's folder: `(cd packages/api && npx jest …)` — the
 * same commands `code-visualizer test` runs, so tests-for, impact and test print the same line.
 */
export function buildTestCommand(files: string[], runners: TestRunners | TestRunnerInfo | undefined): { command?: string; runner?: string } {
  if (!files.length || !runners) return {};
  const byDir: TestRunners = isRunnerInfo(runners) ? { '': runners } : runners;
  const groups = new Map<string, string[]>();
  for (const f of [...new Set(files)].sort()) {
    const dir = runnerDirFor(f, byDir);
    const list = groups.get(dir);
    if (list) list.push(f);
    else groups.set(dir, [f]);
  }
  const parts: string[] = [];
  const ids: string[] = [];
  for (const dir of [...groups.keys()].sort()) {
    const info = byDir[dir];
    if (!info) continue;
    const list = groups.get(dir)!;
    const c = commandsFor(dir ? list.map((f) => f.slice(dir.length + 1)) : list, info, list);
    for (const part of c.parts) parts.push(dir ? `(cd ${quote(dir)} && ${part})` : part);
    ids.push(...c.ids);
  }
  if (!parts.length) return {};
  return { command: parts.join(' && '), runner: [...new Set(ids)].join(' + ') };
}

function isRunnerInfo(value: TestRunners | TestRunnerInfo): value is TestRunnerInfo {
  const keys = Object.keys(value);
  return keys.every((k) => k === 'unit' || k === 'e2e' || k === 'pm' || k === 'e2eDir' || k === 'coverageThresholds') && keys.every((k) => typeof (value as Record<string, unknown>)[k] !== 'object');
}

// --- test-intelligence ---

/** How the package manager runs a locally installed binary, as arguments (`['pnpm', 'exec', 'vitest']`). */
export function execArgv(pm: string | undefined, bin: string): string[] {
  if (pm === 'pnpm') return ['pnpm', 'exec', bin];
  if (pm === 'yarn') return ['yarn', bin];
  if (pm === 'bun') return ['bunx', bin];
  return ['npx', bin];
}

/**
 * The runner's own flags that write a coverage report (undefined when it has none we know).
 * `noThresholds`: only some test files run in a package whose config sets coverage thresholds, so they are
 * switched off for this run — a partial run is far below them by nature and must not fail (or, with
 * Vitest's `autoUpdate`, rewrite them). `node --test` writes lcov itself (Node ≥ 20.11) into
 * `coverage/lcov.info`, next to its usual output.
 */
export function coverageFlag(runner: string, noThresholds = false): string[] | undefined {
  if (runner === 'vitest') {
    if (!noThresholds) return ['--coverage'];
    return ['--coverage', ...['lines', 'functions', 'branches', 'statements'].map((m) => `--coverage.thresholds.${m}=0`), '--coverage.thresholds.autoUpdate=false'];
  }
  if (runner === 'jest') return noThresholds ? ['--coverage', '--coverageThreshold={}'] : ['--coverage'];
  if (runner === 'bun') return ['--coverage'];
  if (runner === 'node') return ['--experimental-test-coverage', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=lcov', `--test-reporter-destination=${NODE_LCOV}`];
  return undefined;
}

/** Where `node --test --coverage` runs write their lcov report (relative to the package; the folder must exist). */
export const NODE_LCOV = 'coverage/lcov.info';

export interface RunnerArgvOptions {
  /** Append the runner's coverage flag (see `coverageFlag`). */
  coverage?: boolean;
  /** The package's config sets coverage thresholds: a run of some files (with `coverage`) switches them off. */
  thresholds?: boolean;
  /** More arguments for the runner (`code-visualizer test -- --reporter=dot`). */
  extra?: string[];
}

/**
 * The program and arguments that run `files` with `runner` (no files: the whole suite), for spawning
 * without a shell. Undefined for an unknown runner id. Vitest always gets `run` (never watch mode).
 */
export function runnerArgv(runner: string, pm: string | undefined, files: string[], options: RunnerArgvOptions = {}): string[] | undefined {
  const tail = [...(options.coverage ? (coverageFlag(runner, !!options.thresholds && files.length > 0) ?? []) : []), ...(options.extra ?? [])];
  switch (runner) {
    case 'vitest':
      return [...execArgv(pm, 'vitest'), 'run', ...tail, ...files];
    case 'jest':
      return [...execArgv(pm, 'jest'), ...tail, ...(files.length ? ['--runTestsByPath', ...files] : [])];
    case 'mocha':
      return [...execArgv(pm, 'mocha'), ...tail, ...files];
    case 'ava':
      return [...execArgv(pm, 'ava'), ...tail, ...files];
    case 'bun':
      return ['bun', 'test', ...tail, ...files];
    case 'node':
      return ['node', '--test', ...tail, ...files];
    case 'playwright':
      return [...execArgv(pm, 'playwright'), 'test', ...tail, ...files];
    case 'cypress':
      return [...execArgv(pm, 'cypress'), 'run', ...tail, ...(files.length ? ['--spec', files.join(',')] : [])];
    default:
      return undefined;
  }
}

/** A command line for display (`npx vitest run 'my test.ts'`), quoted for POSIX shells. */
export function argvDisplay(argv: string[]): string {
  return argv.map(shellQuote).join(' ');
}

/**
 * The workspace package whose runner runs `file`: the deepest folder in `runners` that contains it and
 * has a runner for its kind (e2e or unit); '' (the root) otherwise.
 */
export function runnerDirFor(file: string, runners: TestRunners): string {
  const deepest = (has: (info: TestRunnerInfo) => boolean): string | undefined =>
    Object.keys(runners)
      .filter((d) => (!d || file.startsWith(`${d}/`)) && has(runners[d]))
      .sort((a, b) => b.length - a.length)[0];
  // An e2e spec goes to the nearest package with an e2e runner (a unit runner would pick it up wrongly).
  const dir = (isE2eTest(file, runners) ? deepest((i) => !!i.e2e) : undefined) ?? deepest((i) => !!i.unit) ?? deepest((i) => !!i.e2e);
  return dir ?? '';
}

/**
 * The runner id (`vitest`, `playwright`…) that runs `file` with the runners of its package, if any: the e2e
 * runner for e2e specs and in packages that only have an e2e runner, else the unit runner.
 */
export function runnerFor(file: string, info: TestRunnerInfo | undefined): string | undefined {
  if (!info) return undefined;
  return runnerOf(file, info);
}

/* -------------------------------------------------------------------------- */
/*                         Windows command-line length                        */
/* -------------------------------------------------------------------------- */

/**
 * cmd.exe refuses command lines over 8,191 characters, and on Windows the runners start through it. The
 * budget leaves room for the resolved runner path (`C:\…\node_modules\.bin\vitest.cmd`) and the
 * `cmd.exe /d /s /c "…"` wrapper.
 */
export const WINDOWS_LINE_BUDGET = 7_500;

/** A selection of at least this share of a package's tests runs its whole suite instead (no long line at all). */
export const WHOLE_SUITE_SHARE = 0.8;

/** The length of the cmd.exe line for `argv` with every argument quoted (`"a" "b"`), as the runners are spawned. */
export function windowsLineLength(argv: string[]): number {
  return argv.reduce((n, a) => n + a.length + 3, 0);
}

export interface FitCommandOptions {
  /** The program and arguments of `command` for these package-relative files (none: the whole suite). */
  argvFor(command: TestCommand, files: string[]): string[] | undefined;
  /**
   * How many test files the command's runner knows in its package; undefined when the package must not
   * run its whole suite (the root runner of a monorepo whose packages have runners of their own).
   */
  suiteSize?(command: TestCommand): number | undefined;
  budget?: number;
}

/** The command for `files` (project-relative) with its display line, run from the command's package. */
function withFiles(command: TestCommand, files: string[], options: FitCommandOptions): TestCommand | undefined {
  const local = files.map((f) => (command.cwd ? f.slice(command.cwd.length + 1) : f));
  const argv = options.argvFor(command, local);
  if (!argv) return undefined;
  const line = argvDisplay(argv);
  const next: TestCommand = { cwd: command.cwd, runner: command.runner, argv, display: command.cwd ? `(cd ${quote(command.cwd)} && ${line})` : line, files };
  if (!files.length) next.full = true;
  return next;
}

/**
 * Commands whose command lines fit cmd.exe (Windows). A command that selects at least 80% of its package's
 * tests runs that package's whole suite instead; any other one that is too long is split into several
 * runs of the same runner, each under the budget, together covering every file once (`test` runs them one
 * after another and keeps the worst exit code). Commands that fit are returned as they are.
 */
export function fitCommandLines(commands: TestCommand[], options: FitCommandOptions): TestCommand[] {
  const budget = options.budget ?? WINDOWS_LINE_BUDGET;
  const out: TestCommand[] = [];
  for (const c of commands) {
    if (c.full || !c.files.length || windowsLineLength(c.argv) <= budget) {
      out.push(c);
      continue;
    }
    const suite = options.suiteSize?.(c);
    const whole = suite !== undefined && c.files.length >= WHOLE_SUITE_SHARE * suite ? withFiles(c, [], options) : undefined;
    if (whole) {
      out.push(whole);
      continue;
    }
    // The fixed part of the line (program, flags), measured with one file and without it.
    const first = c.files[0];
    const one = withFiles(c, [first], options);
    if (!one) {
      out.push(c);
      continue;
    }
    const localLength = (f: string): number => (c.cwd ? f.length - c.cwd.length - 1 : f.length) + 3;
    const fixed = windowsLineLength(one.argv) - localLength(first);
    let chunk: string[] = [];
    let length = fixed;
    const flush = (): void => {
      const part = chunk.length ? withFiles(c, chunk, options) : undefined;
      if (part) out.push(part);
      chunk = [];
      length = fixed;
    };
    for (const f of c.files) {
      if (chunk.length && length + localLength(f) > budget) flush();
      chunk.push(f);
      length += localLength(f);
    }
    flush();
  }
  return out;
}
