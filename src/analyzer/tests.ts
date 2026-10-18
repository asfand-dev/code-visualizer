import path from 'node:path';
import { buildTestCommand, isE2eTest, isTestableSource, runnerArgv, runnerCommand, type RunnerArgvOptions, type TestRunnerInfo } from '../shared/testcmd.js';
import type { DependencyEdge, FileInfo } from '../shared/types.js';
import type { PackageJson } from './project.js';

export { isE2eTest, isTestableSource };

export interface TestMap {
  /** Source file → test files that reach it through imports. */
  coveredBy: Map<string, string[]>;
  testFiles: string[];
  /** Share of source files reached by at least one test (0..1). */
  reach: number;
}

/** Which test files exercise which source files (static import reachability). */
export function buildTestMap(files: Pick<FileInfo, 'id' | 'kind'>[], edges: DependencyEdge[]): TestMap {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.typeOnly) continue;
    const list = out.get(e.source);
    if (list) list.push(e.target);
    else out.set(e.source, [e.target]);
  }
  const testFiles = files.filter((f) => f.kind === 'test').map((f) => f.id);
  const coveredBy = new Map<string, string[]>();
  for (const test of testFiles) {
    const seen = new Set<string>([test]);
    const queue = [test];
    while (queue.length) {
      const node = queue.pop()!;
      for (const next of out.get(node) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
        const list = coveredBy.get(next);
        if (!list) coveredBy.set(next, [test]);
        else if (list.length < 40) list.push(test);
      }
    }
  }
  const sources = files.filter(isTestableSource);
  const reached = sources.filter((f) => coveredBy.has(f.id)).length;
  return { coveredBy, testFiles, reach: sources.length ? reached / sources.length : 0 };
}

export interface TestRunner {
  id: string;
  /** Package manager used to run the binary (`pnpm exec vitest`, `yarn jest`…). */
  pm?: string;
  command: (files: string[]) => string;
  /** test-intelligence: program and arguments that run `files` (none: the whole suite), for spawning without a shell. */
  argv: (files: string[], options?: RunnerArgvOptions) => string[];
}

function runner(id: string, pm: string | undefined): TestRunner {
  return { id, pm, command: (files) => runnerCommand(id, pm, files) ?? '', argv: (files, options) => runnerArgv(id, pm, files, options) ?? [] };
}

/** Detect unit and end-to-end runners from package.json (dependencies and the `test` script). */
export function detectTestRunners(pkgs: PackageJson[], pm: string | undefined): { unit?: TestRunner; e2e?: TestRunner } {
  const deps = new Set<string>();
  let scripts = '';
  for (const p of pkgs) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) Object.keys(p[field] ?? {}).forEach((d) => deps.add(d));
    scripts += ` ${p.scripts?.test ?? ''}`;
  }
  const has = (name: string): boolean => deps.has(name) || new RegExp(`\\b${name}\\b`).test(scripts);
  let unit: TestRunner | undefined;
  if (has('vitest')) unit = runner('vitest', pm);
  else if (has('jest') || deps.has('ts-jest') || deps.has('@jest/core')) unit = runner('jest', pm);
  else if (has('mocha')) unit = runner('mocha', pm);
  else if (has('ava')) unit = runner('ava', pm);
  else if (pm === 'bun' || /\bbun test\b/.test(scripts)) unit = runner('bun', pm);
  else if (/node --test/.test(scripts)) unit = runner('node', pm);
  let e2e: TestRunner | undefined;
  if (deps.has('@playwright/test')) e2e = runner('playwright', pm);
  else if (deps.has('cypress')) e2e = runner('cypress', pm);
  return { unit, e2e };
}

// --- test-intelligence ---
const PLAYWRIGHT_CONFIGS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map((ext) => `playwright.config.${ext}`);

/**
 * The project-relative folder Playwright takes its specs from: `testDir` of the package's playwright.config
 * (`'./tests'`, `path.join(__dirname, 'e2e')`). Undefined without a config or a literal testDir — the
 * default (the config's own folder) cannot tell e2e specs from unit tests.
 */
export function playwrightTestDir(dir: string, read: (rel: string) => string | null | undefined): string | undefined {
  for (const name of PLAYWRIGHT_CONFIGS) {
    const text = read(dir ? `${dir}/${name}` : name);
    if (!text) continue;
    const m = /\btestDir\s*:\s*(?:path\.(?:join|resolve)\(\s*__dirname\s*,\s*)?(['"`])([^'"`$]+)\1/.exec(text);
    if (!m) return undefined;
    const rel = path.posix.normalize(`${dir || '.'}/${m[2].replace(/\\/g, '/')}`).replace(/\/+$/, '');
    return rel === '.' ? '' : rel.startsWith('../') || path.posix.isAbsolute(rel) ? undefined : rel;
  }
  return undefined;
}
const CONFIG_EXTS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'];

/**
 * Whether the package's unit runner config sets coverage thresholds (vitest `coverage.thresholds`, jest
 * `coverageThreshold`, also in package.json): a run of only the affected tests then switches them off.
 */
export function hasCoverageThresholds(dir: string, runner: string | undefined, read: (rel: string) => string | null | undefined, pkg?: PackageJson): boolean {
  const at = (name: string): string => (dir ? `${dir}/${name}` : name);
  if (runner === 'vitest') {
    const names = ['vitest', 'vite'].flatMap((n) => CONFIG_EXTS.map((ext) => `${n}.config.${ext}`));
    return names.some((n) => /\bthresholds\s*:/.test(read(at(n)) ?? ''));
  }
  if (runner === 'jest') {
    if ((pkg as { jest?: { coverageThreshold?: unknown } } | undefined)?.jest?.coverageThreshold) return true;
    return [...CONFIG_EXTS, 'json'].some((ext) => /\bcoverageThreshold\b/.test(read(at(`jest.config.${ext}`)) ?? ''));
  }
  return false;
}
// --- /test-intelligence ---

/** The serializable form of detected runners (`ProjectInfo.testRunners` entries). */
export function runnerInfo(runners: { unit?: TestRunner; e2e?: TestRunner }, pm?: string): TestRunnerInfo {
  const info: TestRunnerInfo = {};
  if (runners.unit) info.unit = runners.unit.id;
  if (runners.e2e) info.e2e = runners.e2e.id;
  const usedPm = runners.unit?.pm ?? runners.e2e?.pm ?? pm;
  if (usedPm) info.pm = usedPm;
  return info;
}

/** A ready-to-paste command that runs exactly these test files. */
export function testCommand(files: string[], runners: { unit?: TestRunner; e2e?: TestRunner }): { command?: string; runner?: string } {
  return buildTestCommand(files, runnerInfo(runners));
}
