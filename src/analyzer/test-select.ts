/**
 * Affected-test selection for `code-visualizer test`: from the changed files to the exact test files to
 * run, why each one was picked, and the runner commands per workspace package. Pure (no Node APIs), so
 * the CLI, git hooks, the MCP server and agent hooks select the same tests.
 *
 * A test is selected when
 * - it changed itself (`changed-test`);
 * - it imports a changed file, directly or through other files and test helpers (`imports-changed`);
 * - it visits or requests a route whose handler is affected (`route-e2e`): e2e specs reach the app over
 *   HTTP (`page.goto('/users/1')`, `cy.visit`, `request(app).get('/api/users/1')`), not through imports;
 * - with `withCochange`, it is usually committed together with a changed file (`co-change`, git history).
 *
 * Changes to package manifests, lockfiles, tsconfigs, test runner configs or setup files run the whole
 * suite of the package they belong to (the root: every package).
 */
import { argvDisplay, isE2eTest, isTestEntry, runnerArgv, runnerDirFor, runnerFor, shellQuote, type TestRunners } from '../shared/testcmd.js';
import { routesAffectedBy } from '../shared/query.js';
import { routeLabel, visitMatchesRoute } from '../shared/route-match.js';
import type { DependencyEdge, FileInfo, ProjectInfo, ReportData, RouteInfo, SelectedTest, TestCommand, TestSelection, TestSelectionReason } from '../shared/types.js';

export { visitMatchesRoute };

/**
 * Changes that can affect any test of their package: manifests, lockfiles, tsconfigs, runner configs and
 * test setup files. A plain `setup.js` counts only inside a test folder — elsewhere it is application code
 * (`lib/setup.js`) that reaches its tests through imports like any other file.
 */
export const FULL_RUN_RE =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|tsconfig[^/]*\.json|(vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s|setupTests\.[jt]s)$|(^|\/)(test|tests|__tests__|spec|e2e)\/(.+\/)?setup\.[cm]?[jt]s$/;

/** More test setup the runners load for every test (`vitest.setup.ts`, `jest.config.json`, babel configs). */
const MORE_FULL_RUN_RE =
  /(^|\/)((vitest|jest)\.(setup|workspace)(\.[\w-]+)?\.[cm]?[jt]s|vitest\.workspace\.json|jest\.config\.json|(vitest|jest|playwright|cypress)\.config\.[\w-]+\.[cm]?[jt]s|setupTests\.[jt]sx|test-setup\.[cm]?[jt]sx?|babel\.config\.(json|[cm]?js)|\.babelrc(\.json)?)$/;

/** End-to-end runner configs: only these make an e2e suite run in full. */
const E2E_CONFIG_RE = /(^|\/)(playwright|cypress)\.config(\.[\w-]+)?\.[cm]?[jt]s$/;

export function isFullRunTrigger(file: string): boolean {
  return FULL_RUN_RE.test(file) || MORE_FULL_RUN_RE.test(file);
}

/** package.json fields that change what tests load or how they run (everything else — version, bin, description, other scripts — does not). */
const MANIFEST_TEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'resolutions', 'pnpm', 'workspaces', 'type', 'imports', 'exports', 'main', 'module', 'browser', 'jest', 'vitest', 'ava', 'mocha', 'babel', 'nyc', 'c8'];

/**
 * Whether a package.json change can affect tests: its dependencies, workspaces, module type, entry points,
 * runner configuration or test scripts differ. Unreadable or unparsable versions count as a change.
 */
export function manifestAffectsTests(before: string | undefined, after: string | undefined): boolean {
  const fields = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    try {
      const pkg = JSON.parse(text) as Record<string, unknown>;
      if (!pkg || typeof pkg !== 'object') return undefined;
      const scripts = Object.entries((pkg.scripts as Record<string, unknown> | undefined) ?? {}).filter(([name]) => /test/i.test(name));
      return JSON.stringify([...MANIFEST_TEST_FIELDS.map((k) => pkg[k] ?? null), scripts]);
    } catch {
      return undefined;
    }
  };
  const a = fields(before);
  const b = fields(after);
  return a === undefined || b === undefined || a !== b;
}

export interface SelectTestsOptions {
  mode?: TestSelection['mode'];
  /** What the changes were compared with (for the plan's `base`). */
  base?: string;
  /** Changed files whose edits are only comments or blank lines: they need no tests. */
  commentOnly?: string[];
  /** Also select tests that usually change together with a changed file (change coupling ratio ≥ `cochangeRatio`). */
  withCochange?: boolean;
  /** Minimum change coupling ratio for `withCochange` (default 0.5). */
  cochangeRatio?: number;
  /** Include end-to-end tests (default: true). */
  e2e?: boolean;
  /** Run whole suites when a manifest, lockfile, tsconfig or test setup changed (default: true). */
  full?: boolean;
  /**
   * Changed files that look like full-run triggers but whose change cannot affect tests (a package.json
   * whose dependencies, workspaces, module type and test config are unchanged — a version bump, a script).
   */
  notTriggers?: string[];
  /** Append the runners' coverage flag. */
  coverage?: boolean;
  /** More arguments for every runner (`code-visualizer test -- --reporter=dot`). */
  extra?: string[];
}

/** The parts of an analysis the selection reads (a full ReportData works). */
export type SelectionData = Pick<ReportData, 'files' | 'edges' | 'routes'> & { project: Pick<ProjectInfo, 'testRunners' | 'subprojects' | 'workspaces'> } & Partial<Pick<ReportData, 'apiCalls' | 'insights'>>;

const REASON_ORDER: Record<TestSelectionReason, number> = { 'changed-test': 0, 'imports-changed': 1, 'route-e2e': 2, 'co-change': 3 };

const basename = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/** Where a package's tests run and with what (runner info of its folder). */
function packageOf(file: string, runners: TestRunners): { dir: string; runner?: string } {
  const dir = runnerDirFor(file, runners);
  return { dir, runner: runnerFor(file, runners[dir]) };
}

/** The tests a change needs (see the module comment), with the commands that run them. */
export function selectTests(data: SelectionData, changedFiles: string[], options: SelectTestsOptions = {}): TestSelection {
  const runners: TestRunners = data.project.testRunners ?? {};
  const e2e = options.e2e !== false;
  const byId = new Map<string, FileInfo>(data.files.map((f) => [f.id, f]));
  const isRunnable = (id: string): boolean => {
    const f = byId.get(id);
    return !!f && f.kind === 'test' && isTestEntry(id, runners) && (e2e || !isE2eTest(id, runners));
  };
  const allTests = data.files.filter((f) => isRunnable(f.id)).map((f) => f.id);
  const changed = [...new Set(changedFiles)].sort();
  const commentOnly = new Set(options.commentOnly ?? []);
  const selected = new Map<string, SelectedTest>();
  const add = (file: string, reason: TestSelectionReason, via?: string): void => {
    if (!isRunnable(file)) return;
    const prev = selected.get(file);
    if (prev && REASON_ORDER[prev.reason] <= REASON_ORDER[reason]) return;
    const { dir, runner } = packageOf(file, runners);
    const entry: SelectedTest = { file, reason, package: dir };
    if (via) entry.via = via;
    if (runner) entry.runner = runner;
    selected.set(file, entry);
  };

  // What changed in code: analyzed files (not comment-only edits) and files they import as assets or snapshots.
  const sources = changed.filter((id) => byId.has(id) && !commentOnly.has(id));
  const assetUsers = new Map<string, string[]>();
  for (const f of data.files) for (const a of f.assets) if (a.path) assetUsers.set(a.path, [...(assetUsers.get(a.path) ?? []), f.id]);
  const seeds = new Map<string, string>(); // file → the changed file it stands for
  for (const id of sources) seeds.set(id, id);
  for (const id of changed) {
    if (byId.has(id)) continue;
    for (const user of assetUsers.get(id) ?? []) if (!seeds.has(user)) seeds.set(user, id);
    // `__snapshots__/Button.test.tsx.snap` belongs to `Button.test.tsx`.
    const snap = /^(.*?)__snapshots__\/(.+)\.snap$/.exec(id);
    if (snap) add(`${snap[1]}${snap[2]}`, 'changed-test', id);
  }

  for (const id of sources) if (byId.get(id)?.kind === 'test') add(id, 'changed-test');

  // Everything that (transitively) imports the changed code at runtime, and through which changed file.
  const importers = new Map<string, DependencyEdge[]>();
  for (const e of data.edges) {
    if (e.typeOnly) continue;
    const list = importers.get(e.target);
    if (list) list.push(e);
    else importers.set(e.target, [e]);
  }
  const reachedBy = new Map<string, string>(seeds);
  const queue = [...seeds.keys()];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const e of importers.get(node) ?? []) {
      if (reachedBy.has(e.source)) continue;
      reachedBy.set(e.source, reachedBy.get(node)!);
      queue.push(e.source);
    }
  }
  for (const [file, via] of reachedBy) if (file !== via) add(file, 'imports-changed', via);

  // e2e and API tests that visit or request an affected route (the rule `tests-for`, impact and the live guard
  // follow in reverse: query.routeTestReach).
  const routes = routesAffectedBy(data.routes, new Set(reachedBy.keys()), new Set(sources));
  if (routes.length) {
    // Test file → the first affected route it requests (`fetch`, supertest) or visits (`page.goto`).
    const reaching = new Map<string, RouteInfo>();
    const routeIds = new Map(routes.map((r) => [r.id, r]));
    for (const c of data.apiCalls ?? []) {
      const r = c.route ? routeIds.get(c.route) : undefined;
      if (r && byId.get(c.file)?.kind === 'test' && !reaching.has(c.file)) reaching.set(c.file, r);
    }
    for (const f of data.files) {
      if (!f.urlVisits?.length || f.kind !== 'test' || reaching.has(f.id)) continue;
      const r = routes.find((route) => f.urlVisits!.some((visit) => visitMatchesRoute(route, visit)));
      if (r) reaching.set(f.id, r);
    }
    // A request in a page object, fixture or support file selects the specs that use it (they import it).
    const testImporters = (helper: string): string[] => {
      const found: string[] = [];
      const seen = new Set([helper]);
      const queue = [helper];
      for (let i = 0; i < queue.length; i++) {
        for (const e of importers.get(queue[i]) ?? []) {
          if (seen.has(e.source) || byId.get(e.source)?.kind !== 'test') continue;
          seen.add(e.source);
          queue.push(e.source);
          found.push(e.source);
        }
      }
      return found;
    };
    for (const [file, r] of reaching) {
      if (isRunnable(file)) add(file, 'route-e2e', routeLabel(r));
      else for (const spec of testImporters(file)) add(spec, 'route-e2e', `${routeLabel(r)} (${basename(file)})`);
    }
  }

  // Tests that are usually committed together with a changed file.
  if (options.withCochange) {
    const min = options.cochangeRatio ?? 0.5;
    const changedSet = new Set(sources);
    for (const pair of data.insights?.changeCoupling ?? []) {
      if (pair.ratio < min) continue;
      if (changedSet.has(pair.a)) add(pair.b, 'co-change', pair.a);
      if (changedSet.has(pair.b)) add(pair.a, 'co-change', pair.b);
    }
  }

  // Whole suites: the tests of the package a trigger file belongs to ('' = the root, i.e. every package).
  let fullPackages: string[] = [];
  let fullReason: string | undefined;
  let e2eFull = false;
  let unitFull = false;
  if (options.full !== false) {
    const excluded = data.project.subprojects ?? [];
    const ignored = new Set(options.notTriggers ?? []);
    const triggers = changed.filter((f) => isFullRunTrigger(f) && !ignored.has(f) && !excluded.some((d) => f.startsWith(`${d}/`)));
    const packages = [...new Set([...Object.keys(runners), ...(data.project.workspaces ?? [])])].filter(Boolean);
    const ownerOf = (file: string): string => packages.filter((d) => file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
    const owners = new Set(triggers.map(ownerOf));
    // A package without tests (docs, a config package) has nothing to run in full.
    const scope = owners.has('') ? [''] : [...owners].filter((d) => allTests.some((t) => t.startsWith(`${d}/`))).sort();
    if (scope.length) {
      const inScope = triggers.filter((t) => scope.includes('') || scope.includes(ownerOf(t)));
      fullPackages = scope;
      fullReason = `${inScope[0]} changed${inScope.length > 1 ? ` (and ${inScope.length - 1} more)` : ''}`;
      e2eFull = e2e && inScope.some((t) => E2E_CONFIG_RE.test(t));
      // An e2e config change runs the e2e suite, not the unit tests.
      unitFull = inScope.some((t) => !E2E_CONFIG_RE.test(t));
    }
  }

  const commands = buildCommands([...selected.values()], allTests, runners, fullPackages, { unit: unitFull, e2e: e2eFull }, options);
  const plan: TestSelection = {
    mode: options.mode ?? 'working',
    full: fullPackages.length > 0,
    selected: [...selected.values()].sort((a, b) => REASON_ORDER[a.reason] - REASON_ORDER[b.reason] || a.file.localeCompare(b.file)),
    commands,
    totalTests: allTests.length,
    changed,
  };
  if (options.base) plan.base = options.base;
  if (fullReason) {
    plan.fullReason = fullReason;
    plan.fullPackages = fullPackages;
  }
  const skipped = changed.filter((id) => commentOnly.has(id));
  if (skipped.length) plan.skipped = skipped;
  return plan;
}

/**
 * One command per package and runner, run from the package folder with package-relative paths. In a
 * package that runs in full, its runner runs without paths; tests of a full package that another
 * folder's runner runs (a root runner in a monorepo) are added by path, and the root's runner never runs
 * "everything" when packages have runners of their own (it would run their tests with the wrong config).
 * e2e suites run in full only when an e2e config changed — selected e2e specs still run by path.
 */
function buildCommands(selected: SelectedTest[], allTests: string[], runners: TestRunners, fullPackages: string[], fullKinds: { unit: boolean; e2e: boolean }, options: SelectTestsOptions): TestCommand[] {
  const everything = fullPackages.includes('');
  const inScope = (file: string): boolean => everything || fullPackages.some((d) => file.startsWith(`${d}/`));
  const ownRunners = Object.keys(runners).some((d) => d && (runners[d].unit || runners[d].e2e));
  const suiteRuns = (dir: string): boolean => (everything || fullPackages.includes(dir)) && (dir !== '' || !ownRunners);
  const groups = new Map<string, { dir: string; runner: string; files: string[]; full: boolean }>();
  const group = (dir: string, runner: string, full: boolean): { files: string[]; full: boolean } => {
    const key = `${dir}\0${runner}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { dir, runner, files: [], full }));
    g.full ||= full;
    return g;
  };
  if (fullPackages.length) {
    for (const file of allTests) {
      const { dir, runner } = packageOf(file, runners);
      if (!runner || !inScope(file)) continue;
      const isE2e = runners[dir]?.e2e === runner && runners[dir]?.unit !== runner;
      if (isE2e ? !fullKinds.e2e : !fullKinds.unit) continue;
      if (suiteRuns(dir)) group(dir, runner, true);
      else group(dir, runner, false).files.push(file);
    }
  }
  for (const s of selected) {
    if (!s.runner) continue;
    const g = group(s.package, s.runner, false);
    if (!g.full) g.files.push(s.file);
  }
  const commands: TestCommand[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.dir.localeCompare(b.dir) || (runners[a.dir]?.e2e === a.runner ? 1 : 0) - (runners[b.dir]?.e2e === b.runner ? 1 : 0))) {
    const files = g.full ? [] : [...new Set(g.files)].sort();
    if (!g.full && !files.length) continue;
    const local = files.map((f) => (g.dir ? f.slice(g.dir.length + 1) : f));
    const argv = runnerArgv(g.runner, runners[g.dir]?.pm, local, { coverage: options.coverage, thresholds: runners[g.dir]?.coverageThresholds, extra: options.extra });
    if (!argv) continue;
    const line = argvDisplay(argv);
    const command: TestCommand = { cwd: g.dir, runner: g.runner, argv, display: g.dir ? `(cd ${shellQuote(g.dir)} && ${line})` : line, files };
    if (g.full) command.full = true;
    commands.push(command);
  }
  return commands;
}

/** `7 of 312 test files · vitest (packages/web) 5 · jest (packages/api) 2` */
export function planSummary(plan: TestSelection): string {
  const count = (c: TestCommand): string => (c.full ? 'all' : String(c.files.length));
  const parts = plan.commands.map((c) => `${c.runner}${c.cwd ? ` (${c.cwd})` : ''} ${count(c)}`);
  const files = plan.full ? `${plan.selected.length} affected of ${plan.totalTests} test files, full run` : `${plan.selected.length} of ${plan.totalTests} test file${plan.totalTests === 1 ? '' : 's'}`;
  return [files, ...parts].join(' · ');
}

/**
 * The test files a plan runs: the files of its by-path commands, plus every test of the packages that
 * run in full (for `--list` and `lastTest`).
 */
export function planFiles(data: SelectionData, plan: TestSelection, options: Pick<SelectTestsOptions, 'e2e'> = {}): string[] {
  const runners: TestRunners = data.project.testRunners ?? {};
  const files = new Set(plan.commands.flatMap((c) => c.files));
  // Selected tests no detected runner runs (tap, uvu, a custom script): still listed, for `--list | xargs …`.
  for (const s of plan.selected) if (!s.runner) files.add(s.file);
  const full = plan.commands.filter((c) => c.full);
  if (full.length) {
    for (const f of data.files) {
      if (f.kind !== 'test' || !isTestEntry(f.id, runners) || (options.e2e === false && isE2eTest(f.id, runners))) continue;
      const { dir, runner } = packageOf(f.id, runners);
      if (full.some((c) => c.cwd === dir && c.runner === runner)) files.add(f.id);
    }
  }
  return [...files].sort();
}
