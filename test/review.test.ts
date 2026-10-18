/**
 * Review mode: the pure reading order (src/shared/review.ts) and `code-visualizer review` on throw-away
 * git repositories (nothing is checked out, pull requests are only fetched with --fetch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPullRequest, pullRequestFetch, readReviewState, resolveReviewRef, updateReviewState } from '../src/analyzer/review.js';
import { runCli } from '../src/cli/run.js';
import { reviewPathMarkdown, reviewPlanMarkdown } from '../src/shared/markdown.js';
import { shortNames } from '../src/shared/delta.js';
import { applyViewed, effortLabel, effortTime, meaningfulLines, READING_ORDER_LIMIT, reviewEffort, reviewPlan, setReadingOrder, shortNamer, suggestsSplit } from '../src/shared/review.js';
import type { ArchitectureDelta, ChangedFile, ChangedSymbol, ChangeSet, DependencyEdge, ExportChange, FileInfo, FileKind, ReviewPlan, SymbolInfo } from '../src/shared/types.js';
import { commitAll, daysAgo, editFile, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

// Every process the code under test starts goes through child_process.execFile / spawn (the test's own
// git helper uses execFileSync, which is not recorded): the spy sees every git command `review` runs,
// in any module, and proves it never fetches unless asked to.
const gitCalls = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util');
  const mod = await importOriginal<typeof import('node:child_process')>();
  const record = (command: unknown, args: unknown): void => {
    if (command !== 'git' || !Array.isArray(args)) return;
    const list = [...(args as string[])];
    // Drop the `-c key=value` settings git.ts puts in front of every command.
    while (list[0] === '-c') list.splice(0, 2);
    gitCalls.push(list);
  };
  const run = mod.execFile as unknown as (...args: unknown[]) => unknown;
  const runAsync = promisify(mod.execFile) as unknown as (...args: unknown[]) => Promise<unknown>;
  const execFile = Object.assign(
    (...args: unknown[]) => {
      record(args[0], args[1]);
      return run(...args);
    },
    {
      // promisify(execFile) resolves { stdout, stderr }: keep that.
      [promisify.custom]: (...args: unknown[]) => {
        record(args[0], args[1]);
        return runAsync(...args);
      },
    },
  );
  const spawn = (...args: unknown[]) => {
    record(args[0], args[1]);
    return (mod.spawn as unknown as (...a: unknown[]) => unknown)(...args);
  };
  return { ...mod, default: { ...mod, execFile, spawn }, execFile, spawn };
});

afterAll(removeTempDirs);

/* -------------------------------------------------------------------------- */
/*                               Pure ordering                                */
/* -------------------------------------------------------------------------- */

function file(id: string, kind: FileKind, extra: Partial<FileInfo> = {}): FileInfo {
  const name = id.slice(id.lastIndexOf('/') + 1);
  return {
    id,
    name,
    dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
    ext: name.slice(name.lastIndexOf('.')),
    language: 'typescript',
    kind,
    loc: 20,
    sloc: 18,
    bytes: 400,
    complexity: 3,
    maxComplexity: 3,
    symbols: [],
    exports: [],
    assets: [],
    unresolved: [],
    isEntry: false,
    isTest: kind === 'test',
    todos: [],
    metrics: { fanIn: 1, fanOut: 1, importance: 0.1, instability: 0.5, externalImports: 0 },
    ...extra,
  };
}

function sym(fileId: string, name: string, kind: SymbolInfo['kind'], complexity = 2): SymbolInfo {
  return { id: `${fileId}#${name}`, name, kind, line: 1, endLine: 10, exported: true, complexity, loc: 10 };
}

const edge = (source: string, target: string, typeOnly = false): DependencyEdge => ({ source, target, kind: 'import', typeOnly, names: ['x'], line: 1, specifier: './x' });

/** A diff that adds `n` code lines. */
const diffOf = (id: string, n: number): string => `diff --git a/${id} b/${id}\n--- a/${id}\n+++ b/${id}\n@@ -1,0 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+const v${i} = ${i};`).join('\n')}\n`;

const changed = (id: string, lines = 10, extra: Partial<ChangedFile> = {}): ChangedFile => ({ id, status: 'modified', additions: lines, deletions: 0, lines: [1], diff: diffOf(id, lines), analyzed: true, ...extra });

const changedSymbol = (fileId: string, name: string, kind: ChangedSymbol['kind'], usedBy = 1): ChangedSymbol => ({ id: `${fileId}#${name}`, file: fileId, name, kind, exported: true, usedBy });

/** types.ts ← service.ts ← controller.ts ← page.tsx, and service.test.ts testing service.ts. */
function chain() {
  const files = [
    file('src/types.ts', 'types', { symbols: [sym('src/types.ts', 'Order', 'interface')] }),
    file('src/service.ts', 'service', { symbols: [sym('src/service.ts', 'createOrder', 'function', 8)], tests: ['src/service.test.ts'], metrics: { fanIn: 2, fanOut: 1, importance: 0.3, instability: 0.3, externalImports: 0 } }),
    file('src/controller.ts', 'controller', { symbols: [sym('src/controller.ts', 'handle', 'function')] }),
    file('src/page.tsx', 'page', { symbols: [sym('src/page.tsx', 'Page', 'component')], metrics: { fanIn: 0, fanOut: 1, importance: 0, instability: 1, externalImports: 0 } }),
    file('src/service.test.ts', 'test'),
  ];
  const edges = [edge('src/service.ts', 'src/types.ts', true), edge('src/controller.ts', 'src/service.ts'), edge('src/page.tsx', 'src/controller.ts'), edge('src/service.test.ts', 'src/service.ts')];
  // Listed alphabetically, as git reports them.
  const changes = {
    files: ['src/controller.ts', 'src/page.tsx', 'src/service.test.ts', 'src/service.ts', 'src/types.ts'].map((id) => changed(id)),
    symbols: [changedSymbol('src/types.ts', 'Order', 'interface', 3), changedSymbol('src/service.ts', 'createOrder', 'function', 2), changedSymbol('src/controller.ts', 'handle', 'function', 1), changedSymbol('src/page.tsx', 'Page', 'component', 0)],
  };
  return { files, edges, changes };
}

describe('reviewPlan (reading order)', () => {
  it('reads contracts, then the code others build on, then its users — each test right after its code', () => {
    const { files, edges, changes } = chain();
    const plan = reviewPlan({ files, edges }, changes);
    expect(plan.steps.map((s) => s.file)).toEqual(['src/types.ts', 'src/service.ts', 'src/service.test.ts', 'src/controller.ts', 'src/page.tsx']);
    expect(plan.steps.map((s) => s.role)).toEqual(['contract', 'core', 'test', 'core', 'consumer']);
    expect(plan.steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.steps.find((s) => s.file === 'src/service.ts')!.tests).toEqual(['src/service.test.ts']);
    // Start here: the main logic change (not its types, which come first as context).
    expect(plan.startHere).toEqual({ file: 'src/service.ts', reason: 'changes createOrder(); builds on types.ts (step 1)' });
    expect(plan.groups).toHaveLength(1);
    expect(plan.checklist[1]).toBe('2. `src/service.ts` (core) — 1 changed file builds on it; changes createOrder()');
  });

  it('--test-first moves the test before the code it covers', () => {
    const { files, edges, changes } = chain();
    const plan = reviewPlan({ files, edges }, changes, undefined, { testFirst: true });
    expect(plan.steps.map((s) => s.file)).toEqual(['src/types.ts', 'src/service.test.ts', 'src/service.ts', 'src/controller.ts', 'src/page.tsx']);
    expect(plan.testFirst).toBe(true);
    // A test that also reaches the types through the service goes before them.
    const covering = files.map((f) => (f.id === 'src/types.ts' ? { ...f, tests: ['src/service.test.ts'] } : f));
    const first = reviewPlan({ files: covering, edges: [...edges, edge('src/service.test.ts', 'src/types.ts', true)] }, changes, undefined, { testFirst: true });
    expect(first.steps[0].file).toBe('src/service.test.ts');
  });

  it('puts lockfiles, snapshots, generated files, pure renames and comment-only edits in skim', () => {
    const { files, edges, changes } = chain();
    const plan = reviewPlan({ files: [...files, file('src/old-name.ts', 'util')], edges }, {
      ...changes,
      files: [
        ...changes.files,
        changed('package-lock.json', 900, { analyzed: false }),
        changed('src/__snapshots__/page.test.tsx.snap', 40, { analyzed: false }),
        changed('src/old-name.ts', 0, { status: 'renamed', oldPath: 'src/oldName.ts', additions: 1, deletions: 1 }),
        changed('src/api.generated.ts', 300),
        changed('src/notes.ts', 3),
      ],
      commentOnly: ['src/notes.ts'],
    });
    expect(Object.fromEntries(plan.skim.map((s) => [s.file, s.reason]))).toEqual({
      'package-lock.json': 'lockfile',
      'src/__snapshots__/page.test.tsx.snap': 'test snapshot',
      'src/old-name.ts': 'renamed from src/oldName.ts (2 lines changed)',
      'src/api.generated.ts': 'generated file',
      'src/notes.ts': 'only comments or blank lines changed',
    });
    expect(plan.steps.map((s) => s.file)).not.toContain('package-lock.json');
    // Skimmed lines do not count towards the effort.
    expect(plan.effort.meaningfulLines).toBe(50);
  });

  it('splits disconnected changes into groups, riskiest first; configuration and docs come last', () => {
    const files = [
      file('src/a/x.ts', 'util', { symbols: [sym('src/a/x.ts', 'x', 'function', 2)] }),
      file('src/a/y.ts', 'util', { symbols: [sym('src/a/y.ts', 'y', 'function', 2)] }),
      file('src/b/big.ts', 'service', { symbols: [sym('src/b/big.ts', 'big', 'function', 15)], metrics: { fanIn: 6, fanOut: 0, importance: 0.5, instability: 0, externalImports: 0 } }),
    ];
    const plan = reviewPlan(
      { files, edges: [edge('src/a/y.ts', 'src/a/x.ts')] },
      { files: [changed('src/a/x.ts', 20), changed('src/a/y.ts', 20), changed('src/b/big.ts', 30), changed('README.md', 5, { analyzed: false }), changed('package.json', 2, { analyzed: false })], symbols: [changedSymbol('src/b/big.ts', 'big', 'function', 6)] },
    );
    expect(plan.groups.filter((g) => g.kind === 'change')).toHaveLength(2);
    expect(plan.groups.map((g) => g.files)).toEqual([['src/b/big.ts'], ['src/a/x.ts', 'src/a/y.ts'], ['package.json', 'README.md']]);
    expect(plan.groups[2]).toMatchObject({ kind: 'other', title: 'Configuration and other files' });
    expect(plan.steps.find((s) => s.file === 'package.json')!.role).toBe('config');
    expect(plan.steps.find((s) => s.file === 'README.md')).toMatchObject({ role: 'other', reasons: ['documentation'] });
    expect(plan.startHere?.file).toBe('src/b/big.ts');
    expect(reviewPlanMarkdown(plan)).toContain('> **This is 2 independent changes**');
  });

  it('orders the files of an import cycle deterministically, whatever order git lists them in', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map((id) => file(id, 'util'));
    const edges = [edge('src/a.ts', 'src/b.ts'), edge('src/b.ts', 'src/c.ts'), edge('src/c.ts', 'src/a.ts'), edge('src/d.ts', 'src/a.ts')];
    const ids = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const orders = new Set<string>();
    for (const permutation of [ids, [...ids].reverse(), ['src/c.ts', 'src/a.ts', 'src/d.ts', 'src/b.ts']]) {
      const plan = reviewPlan({ files: [...files].reverse(), edges: [...edges].reverse() }, { files: permutation.map((id) => changed(id, 10)) });
      orders.add(plan.steps.map((s) => s.file).join(','));
    }
    expect([...orders]).toEqual(['src/a.ts,src/b.ts,src/c.ts,src/d.ts']);
  });

  it('effort: 400 meaningful lines an hour, levels at 50 / 200 / 400 / 800 lines', () => {
    expect([0, 1, 50, 51, 200, 201, 400, 401, 800, 801, 5000].map((n) => reviewEffort(n).level)).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(reviewEffort(147)).toEqual({ minutes: 22, level: 2, meaningfulLines: 147 });
    expect(reviewEffort(0).minutes).toBe(0);
    expect(reviewEffort(2).minutes).toBe(1);
    expect(effortLabel(reviewEffort(147))).toBe('~22 min · level 2/5');
    expect(effortLabel(reviewEffort(1000))).toBe('~2 h 30 min · level 5/5');
  });

  it('counts meaningful lines: comments and blank lines are left out', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,9 @@', '+// a comment', '+', '+/**', '+ * docs', '+ */', '+const a = 1;', '-const b = 2; // trailing comment counts', ' unchanged', '+/* inline */ call();', ''].join('\n');
    expect(meaningfulLines({ id: 'a.ts', diff, additions: 7, deletions: 1 })).toBe(3);
    // `#` is a comment in YAML but a private field in TypeScript.
    expect(meaningfulLines({ id: 'ci.yml', diff: '@@ -1 +1,2 @@\n+# note\n+run: x\n', additions: 2, deletions: 0 })).toBe(1);
    expect(meaningfulLines({ id: 'a.ts', diff: '@@ -1 +1,2 @@\n+#secret = 1;\n', additions: 1, deletions: 0 })).toBe(1);
    expect(meaningfulLines({ id: 'img.png', additions: 0, deletions: 0 })).toBe(0);
  });

  it('explains each step from the architecture delta: signature changes, new routes, complexity, untested', () => {
    const { files, edges, changes } = chain();
    const delta = {
      base: 'main',
      baseCommit: 'abc',
      head: 'feature',
      exports: [{ file: 'src/service.ts', name: 'createOrder', change: 'signature', before: 'createOrder(a)', after: 'createOrder(a, b)', breaking: true, importers: ['src/controller.ts'], staleCallSites: [{ file: 'src/controller.ts', line: 4, argc: 1, kind: 'call' }] }],
      complexity: [{ symbol: 'src/controller.ts#handle', file: 'src/controller.ts', name: 'handle', line: 1, before: 4, after: 11 }],
      routes: { added: ['POST /api/refunds'], removed: [] },
      newCycles: [],
      newViolations: [],
    } as unknown as ArchitectureDelta;
    const routes = [{ id: 'r1', method: 'POST', path: '/api/refunds', file: 'src/controller.ts', framework: 'express' as const, type: 'api' as const }];
    const withUntested = files.map((f) => (f.id === 'src/controller.ts' ? { ...f, tests: [] } : f));
    const plan = reviewPlan({ files: withUntested, edges, routes }, changes, delta);
    const reasons = (id: string): string[] => plan.steps.find((s) => s.file === id)!.reasons;
    expect(reasons('src/service.ts')[0]).toBe('changes signature of createOrder() used in 2 places, 1 call not updated');
    expect(reasons('src/controller.ts')).toEqual(expect.arrayContaining(['new route POST /api/refunds', 'handle() complexity 4→11', 'untested']));
    expect(plan.apiChanges.map((e) => e.name)).toEqual(['createOrder']);
    // controller.ts and page.tsx changed functions that no changed test covers.
    expect(plan.untestedChanges).toEqual(['src/controller.ts#handle', 'src/page.tsx#Page']);
    // --- integration (wave 3): lines a local coverage report saw run are test evidence too (as in My changes) ---
    const covered = withUntested.map((f) => (f.id === 'src/controller.ts' ? { ...f, coverage: { lines: { total: 5, covered: 3 }, uncovered: [4, 5], source: 'lcov' as const } } : f));
    expect(reviewPlan({ files: covered, edges, routes }, changes, delta).steps.find((st) => st.file === 'src/controller.ts')!.reasons).not.toContain('untested');
  });

  it('start here: the change that breaks something comes first, then the largest logic change', () => {
    const { files, edges, changes } = chain();
    const delta = { base: 'main', baseCommit: 'abc', head: 'feature', exports: [], complexity: [], routes: { added: [], removed: [] }, newCycles: [], newViolations: [{ source: 'src/controller.ts', target: 'src/db.ts', rule: 'no-db-in-controllers', line: 3, severity: 'error' }] } as unknown as ArchitectureDelta;
    const plan = reviewPlan({ files, edges }, changes, delta);
    expect(plan.startHere).toEqual({ file: 'src/controller.ts', reason: 'breaks rule no-db-in-controllers: imports src/db.ts; untested; builds on service.ts (step 2)' });
    // The dependency order is unchanged; the urgent step carries the highest risk.
    expect(plan.steps.map((s) => s.file)).toEqual(['src/types.ts', 'src/service.ts', 'src/service.test.ts', 'src/controller.ts', 'src/page.tsx']);
    expect(plan.steps.find((s) => s.file === 'src/controller.ts')!.risk).toBe(100);
  });

  it('orders a build-breaking change before a bigger harmless one', () => {
    const files = [
      file('src/utils/format.ts', 'util', { symbols: [sym('src/utils/format.ts', 'formatDate', 'function', 2)], metrics: { fanIn: 3, fanOut: 0, importance: 0.2, instability: 0, externalImports: 0 } }),
      file('src/feature/summary.ts', 'util', { symbols: [sym('src/feature/summary.ts', 'summarize', 'function', 6)], metrics: { fanIn: 0, fanOut: 0, importance: 0, instability: 1, externalImports: 0 } }),
    ];
    const delta = {
      base: 'main', baseCommit: 'abc', head: 'feature', complexity: [], routes: { added: [], removed: [] }, newCycles: [], newViolations: [],
      exports: [{ file: 'src/utils/format.ts', name: 'formatDate', change: 'signature', before: 'formatDate(iso: string)', after: 'formatDate(iso: string, locale: string)', breaking: true, importers: ['src/components/UserCard.tsx'], staleCallSites: [{ file: 'src/components/UserCard.tsx', line: 16, argc: 1, kind: 'call' }] }],
    } as unknown as ArchitectureDelta;
    const plan = reviewPlan({ files, edges: [] }, { files: [changed('src/utils/format.ts', 2), changed('src/feature/summary.ts', 34, { status: 'added' })], symbols: [changedSymbol('src/utils/format.ts', 'formatDate', 'function', 3), changedSymbol('src/feature/summary.ts', 'summarize', 'function', 0)] }, delta);
    expect(plan.groups.map((g) => g.files)).toEqual([['src/utils/format.ts'], ['src/feature/summary.ts']]);
    expect(plan.startHere?.file).toBe('src/utils/format.ts');
    expect(plan.steps.map((s) => s.risk)).toEqual([100, expect.any(Number)]);
    expect(plan.steps[1].risk).toBeLessThanOrEqual(50);
  });

  it('a deleted file that is still imported is part of a change, read before its importers, and can be start here', () => {
    const files = [file('src/x.ts', 'util', { symbols: [sym('src/x.ts', 'x', 'function')] }), file('src/y.ts', 'util', { symbols: [sym('src/y.ts', 'y', 'function')] })];
    const removed = (importers: string[]): ArchitectureDelta =>
      ({ base: 'main', baseCommit: 'abc', head: 'feature', complexity: [], routes: { added: [], removed: [] }, newCycles: [], newViolations: [], exports: [{ file: 'src/old.ts', name: 'helper', change: 'removed', breaking: true, importers, staleCallSites: [] }] }) as unknown as ArchitectureDelta;
    const changes = { files: [changed('src/x.ts', 6), changed('src/y.ts', 6), changed('src/old.ts', 0, { status: 'deleted', additions: 0, deletions: 12, diff: undefined })] };
    // y.ts still imports the deleted file: one change, old.ts before y.ts.
    const joined = reviewPlan({ files, edges: [edge('src/y.ts', 'src/x.ts')] }, changes, removed(['src/y.ts', 'src/z.ts']));
    expect(joined.groups).toEqual([expect.objectContaining({ kind: 'change', files: expect.arrayContaining(['src/old.ts', 'src/x.ts', 'src/y.ts']) })]);
    const order = joined.steps.map((s) => s.file);
    expect(order.indexOf('src/old.ts')).toBeLessThan(order.indexOf('src/y.ts'));
    expect(joined.startHere).toEqual({ file: 'src/old.ts', reason: 'removes helper, still imported by 2 files; deleted; 1 changed file builds on it' });
    // Only unchanged files import it: its own part, first.
    const alone = reviewPlan({ files, edges: [edge('src/y.ts', 'src/x.ts')] }, changes, removed(['src/z.ts']));
    expect(alone.groups.map((g) => [g.kind, g.files])).toEqual([
      ['change', ['src/old.ts']],
      ['change', ['src/x.ts', 'src/y.ts']],
    ]);
    expect(alone.startHere?.file).toBe('src/old.ts');
  });

  it('a part with only tests ranks after code, and start here is still found', () => {
    const files = [file('src/lone.test.ts', 'test'), file('src/q.ts', 'util', { symbols: [sym('src/q.ts', 'q', 'function')] })];
    const plan = reviewPlan({ files, edges: [] }, { files: [changed('src/lone.test.ts', 300), changed('src/q.ts', 2)] });
    expect(plan.groups.map((g) => g.files)).toEqual([['src/q.ts'], ['src/lone.test.ts']]);
    expect(plan.startHere?.file).toBe('src/q.ts');
    // A lone test of 300 lines and a 2-line fix are not worth splitting.
    expect(suggestsSplit(plan)).toBe(false);
  });

  it('suggests a split only when two parts are substantial', () => {
    const files = [file('src/a.ts', 'util'), file('src/b.ts', 'util')];
    const small = reviewPlan({ files, edges: [] }, { files: [changed('src/a.ts', 5), changed('src/b.ts', 2)] });
    expect(small.groups).toHaveLength(2);
    expect(suggestsSplit(small)).toBe(false);
    const md = reviewPlanMarkdown(small);
    expect(md).not.toContain('This is 2 independent changes');
    expect(md).toContain('2 independent parts, small enough to review together.');
    expect(suggestsSplit(reviewPlan({ files, edges: [] }, { files: [changed('src/a.ts', 25), changed('src/b.ts', 20)] }))).toBe(true);
  });

  it('says what changed: appended parameters extend, renamed ones change compatibly, new exports are added', () => {
    const files = [file('src/hooks.ts', 'hook', { symbols: [sym('src/hooks.ts', 'useDebounce', 'hook'), sym('src/hooks.ts', 'useThrottle', 'hook'), sym('src/hooks.ts', 'CART_LIMIT', 'constant')] })];
    const signature = (name: string, before: string, after: string): ExportChange => ({ file: 'src/hooks.ts', name, change: 'signature', before, after, breaking: false, importers: ['src/a.ts', 'src/b.ts'], staleCallSites: [] });
    const delta = {
      base: 'main', baseCommit: 'abc', head: 'feature', complexity: [], routes: { added: [], removed: [] }, newCycles: [], newViolations: [],
      exports: [signature('useDebounce', 'useDebounce(value: T, delay: number)', 'useDebounce(value: T, delayMs: number)'), signature('useThrottle', 'useThrottle(fn: F)', 'useThrottle(fn: F, wait?: number)'), { file: 'src/hooks.ts', name: 'CART_LIMIT', change: 'added', breaking: false, importers: [], staleCallSites: [] }],
    } as unknown as ArchitectureDelta;
    const plan = reviewPlan({ files, edges: [] }, { files: [changed('src/hooks.ts', 8)], symbols: [changedSymbol('src/hooks.ts', 'useDebounce', 'hook', 2), changedSymbol('src/hooks.ts', 'useThrottle', 'hook', 2), changedSymbol('src/hooks.ts', 'CART_LIMIT', 'constant', 0)] }, delta);
    expect(plan.steps[0].reasons).toEqual(expect.arrayContaining(['changes signature of useDebounce() compatibly (used in 2 places)', 'extends useThrottle() compatibly (used in 2 places)']));
    const added = reviewPlan({ files, edges: [] }, { files: [changed('src/hooks.ts', 1)], symbols: [changedSymbol('src/hooks.ts', 'CART_LIMIT', 'constant', 0)] }, { ...delta, exports: delta.exports.slice(2) });
    expect(added.steps[0].reasons).toContain('adds CART_LIMIT');
  });

  it('short names: linear, and the same as the pairwise version', () => {
    const ids = ['src/a/index.ts', 'src/b/index.ts', 'lib/b/index.ts', 'src/service.ts', 'index.ts', 'src/a/service.test.ts'];
    const short = shortNamer(ids);
    expect(Object.fromEntries(ids.map((id) => [id, short(id)]))).toEqual(Object.fromEntries(shortNames(ids)));
    // 3,000 changed files (a codemod): planned in well under a second (it was quadratic).
    const many = Array.from({ length: 3000 }, (_, i) => `src/m${i % 40}/f${i}.ts`);
    const start = performance.now();
    const big = reviewPlan(
      { files: many.map((id) => file(id, 'util')), edges: many.slice(1).map((id, i) => edge(id, many[i])) },
      { files: many.map((id) => changed(id, 3)) },
    );
    expect(big.steps).toHaveLength(3000);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it('markdown: no empty Review path when only skimmed files changed; parts leave configuration out', () => {
    const lockOnly = reviewPlan({ files: [], edges: [] }, { files: [changed('package-lock.json', 40, { analyzed: false })] });
    const md = reviewPlanMarkdown(lockOnly);
    expect(md).not.toContain('### Review path');
    expect(md).toContain('### Skim');
    const files = [file('src/a.ts', 'util'), file('src/b.ts', 'util')];
    const plan = reviewPlan({ files, edges: [] }, { files: [changed('src/a.ts', 25), changed('src/b.ts', 20), changed('README.md', 3, { analyzed: false })] });
    for (const path of [reviewPathMarkdown(plan.steps, { groups: plan.groups }), reviewPathMarkdown(plan.steps)]) {
      expect(path).toContain(', 2 independent parts)');
      expect(path).toContain('**Configuration and other files**');
    }
  });

  it('effort time reads as hours past 60 minutes', () => {
    expect(effortTime({ minutes: 45 })).toBe('~45 min');
    expect(effortTime({ minutes: 120 })).toBe('~2 h');
    expect(effortTime({ minutes: 3018 })).toBe('~50 h 18 min');
  });

  it('your own change: reading order capped, skim and parts kept separately', () => {
    const many = Array.from({ length: READING_ORDER_LIMIT + 20 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`);
    const changes = { files: [...many.map((id) => changed(id, 2)), changed('yarn.lock', 30, { analyzed: false })], symbols: [] } as unknown as ChangeSet;
    setReadingOrder({ files: many.map((id) => file(id, 'util')), edges: [] }, changes);
    expect(changes.readingOrder).toHaveLength(READING_ORDER_LIMIT);
    // Files past the limit are not "skim": only what the plan skimmed is.
    expect(changes.readingSkim).toEqual([{ file: 'yarn.lock', reason: 'lockfile' }]);
    expect(changes.readingGroups?.[0]).not.toHaveProperty('files');
    expect(changes.readingGroups).toHaveLength(many.length);
  });

  it('viewed flags only hold for the blob they were viewed at', () => {
    const plan = reviewPlan({ files: [file('src/a.ts', 'util')], edges: [] }, { files: [changed('src/a.ts', 5, { blob: 'b1' }), changed('yarn.lock', 50, { analyzed: false, blob: 'l1' })] });
    expect(applyViewed(plan, { 'src/a.ts': 'b1', 'yarn.lock': 'old' })).toBe(1);
    expect(plan.steps[0].viewed).toBe(true);
    expect(plan.skim[0].viewed).toBeUndefined();
    expect(reviewPathMarkdown(plan.steps)).toContain('- [x] 1. `src/a.ts`');
  });
});

/* -------------------------------------------------------------------------- */
/*                         `code-visualizer review`                           */
/* -------------------------------------------------------------------------- */

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sink: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
      return true;
    }) as typeof process.stdout.write;
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture((s) => (stdout += s)));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture((s) => (stderr += s)));
  try {
    const code = await runCli(argv);
    return { code, stdout: strip(stdout), stderr: strip(stderr) };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const REFUNDS = `import { formatCurrency } from './format';

export interface Refund {
  id: string;
  amount: number;
}

export function describeRefund(refund: Refund): string {
  if (refund.amount <= 0) return 'nothing to refund';
  return \`refund \${refund.id}: \${formatCurrency(refund.amount)}\`;
}
`;

describe.skipIf(!hasGit)('code-visualizer review', () => {
  let restoreEnv: () => void;
  let repo: string;
  let mainHead: string;
  beforeAll(async () => {
    // Resolve the mocked module once up front: concurrent first imports from inside the CLI could
    // otherwise race the async mock factory and bind the original.
    await import('node:child_process');
    restoreEnv = isolateGit();
    repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(10), message: 'initial' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    // A breaking signature change (UserCard still calls formatDate(joinedAt)), a file that only
    // exists on the branch, and a lockfile.
    editFile(repo, 'src/utils/format.ts', 'export function formatDate(iso: string)', 'export function formatDate(iso: string, locale: string)');
    editFile(repo, 'src/utils/format.ts', "toLocaleDateString('en-US'", 'toLocaleDateString(locale');
    writeFile(repo, 'src/utils/refunds.ts', REFUNDS);
    writeFile(repo, 'package-lock.json', `${JSON.stringify({ name: 'react-vite-ts', lockfileVersion: 3, packages: {} }, null, 2)}\n`);
    commitAll(repo, { author: 'Bob Builder', date: daysAgo(2), message: 'refunds' });
    git(repo, ['checkout', '-q', 'main']);
    mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  });
  afterAll(() => restoreEnv?.());
  beforeEach(() => {
    gitCalls.length = 0;
  });

  it('plans a branch without checking it out: files that exist only there, API changes with stale calls, skim', async () => {
    const { code, stdout, stderr } = await cli('review', 'feature', repo, '--format', 'json');
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as ReviewPlan;
    expect(plan).toMatchObject({ ref: 'feature', base: 'main', mergeBase: mainHead });
    expect(plan.steps.map((s) => s.file).sort()).toEqual(['src/utils/format.ts', 'src/utils/refunds.ts']);
    // refunds.ts imports format.ts: the code it builds on comes first.
    expect(plan.steps.map((s) => s.file)).toEqual(['src/utils/format.ts', 'src/utils/refunds.ts']);
    expect(plan.steps[1]).toMatchObject({ role: 'consumer', status: 'added' });
    expect(plan.steps[1].blob).toMatch(/^[0-9a-f]{40}$/);
    expect(plan.skim).toEqual([expect.objectContaining({ file: 'package-lock.json', reason: 'lockfile' })]);
    const formatDate = plan.apiChanges.find((e) => e.name === 'formatDate')!;
    expect(formatDate).toMatchObject({ change: 'signature', breaking: true });
    expect(formatDate.staleCallSites.map((s) => s.file)).toEqual(['src/components/UserCard.tsx']);
    expect(plan.steps[0].reasons[0]).toMatch(/^changes signature of formatDate\(\) used in \d+ places?, 1 call not updated$/);
    expect(plan.startHere?.file).toBe('src/utils/format.ts');
    expect(plan.untestedChanges).toContain('src/utils/refunds.ts#describeRefund');
    expect(plan.commits?.map((c) => c.subject)).toEqual(['refunds']);
    // The working tree and HEAD are untouched.
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(mainHead);
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(repo, 'src/utils/refunds.ts'))).toBe(false);
    expect(gitCalls.length).toBeGreaterThan(0);
    // The spy sees git.ts' own calls (rev-parse, diff) and the overlay's `cat-file --batch` process too.
    expect(gitCalls.some((args) => args[0] === 'cat-file')).toBe(true);
    expect(gitCalls.some((args) => args[0] === 'diff')).toBe(true);
    expect(gitCalls.some((args) => args.includes('checkout') || args.includes('fetch'))).toBe(false);
  });

  it('prints a reading order in the terminal and a checklist as Markdown', async () => {
    const text = await cli('review', 'feature', repo);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Review  feature → main');
    expect(text.stdout).toMatch(/~\d+ min · level 1\/5/);
    // Two files in one part: no split advice.
    expect(text.stdout).not.toContain('independent change');
    expect(text.stdout).toMatch(/Start here {2}src\/utils\/format\.ts/);
    expect(text.stdout).toMatch(/1\. core +src\/utils\/format\.ts/);
    expect(text.stdout).toContain('package-lock.json  lockfile');
    expect(text.stdout).toContain('API changes');
    const md = await cli('review', 'feature', repo, '--format', 'md');
    expect(md.stdout).toContain('## Review: `feature` → `main`');
    expect(md.stdout).toContain('- [ ] 1. `src/utils/format.ts` (core) — changes signature of formatDate()');
    expect(md.stdout).toContain('- [ ] 2. `src/utils/refunds.ts` (consumer)');
    expect(md.stdout).toContain('### Skim');
    expect(md.stdout).toContain('1 call not updated');
  });

  it('#123 is only looked up in fetched refs: without one it prints the fetch command and exits 2', async () => {
    const missing = await cli('review', '#12', repo);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('#12 is not fetched yet');
    expect(missing.stderr).toContain('git fetch origin pull/12/head:pr/12');
    expect(gitCalls.some((args) => args.includes('fetch'))).toBe(false);
    const gitlab = await cli('review', '!7', repo);
    expect(gitlab.code).toBe(2);
    expect(gitlab.stderr).toContain('git fetch origin merge-requests/7/head:mr/7');

    git(repo, ['update-ref', 'refs/pull/12/head', 'feature']);
    const found = await cli('review', '#12', repo, '--json');
    expect(found.code).toBe(0);
    // Which local copy is reviewed, and how to update it.
    expect(found.stderr).toContain(`#12 is pull/12/head at ${git(repo, ['rev-parse', '--short=7', 'feature']).trim()} (fetched earlier; --fetch updates it)`);
    const plan = JSON.parse(found.stdout) as ReviewPlan;
    expect(plan.ref).toBe('#12');
    expect(plan.steps.map((s) => s.file)).toEqual(['src/utils/format.ts', 'src/utils/refunds.ts']);
    expect(gitCalls.some((args) => args.includes('fetch'))).toBe(false);
  });

  it('--fetch fetches the pull request from the remote first (opt-in), and again after the author pushed', async () => {
    const remote = path.join(makeTempDir('cv-remote-'), 'origin.git');
    git(repo, ['init', '-q', '--bare', remote]);
    git(repo, ['push', '-q', remote, 'feature:refs/pull/31/head']);
    git(repo, ['remote', 'add', 'origin', remote]);
    const first = git(repo, ['rev-parse', 'feature']).trim();
    try {
      const { code, stdout, stderr } = await cli('review', '#31', repo, '--fetch', '--json');
      expect(stderr).toContain('git fetch origin pull/31/head:pr/31');
      expect(stderr).toContain(`pr/31: fetched at ${first.slice(0, 7)}`);
      expect(code).toBe(0);
      expect((JSON.parse(stdout) as ReviewPlan).steps).toHaveLength(2);
      expect(gitCalls.filter((args) => args.includes('fetch'))).toEqual([['fetch', '--no-tags', '--', 'origin', '+pull/31/head:pr/31']]);
      expect(git(repo, ['rev-parse', 'pr/31']).trim()).toBe(first);

      // The author pushes a fix; a stale mirror of the old head (refs/pull/31/head) must not win either.
      git(repo, ['checkout', '-q', '-b', 'feature-v2', 'feature']);
      writeFile(repo, 'src/utils/limits.ts', 'export const REFUND_LIMIT = 100;\n');
      const second = commitAll(repo, { author: 'Bob Builder', date: daysAgo(1), message: 'limit' });
      git(repo, ['checkout', '-q', 'main']);
      git(repo, ['push', '-q', '--force', remote, 'feature-v2:refs/pull/31/head']);
      git(repo, ['update-ref', 'refs/pull/31/head', first]);
      const again = await cli('review', '#31', repo, '--fetch', '--json');
      expect(again.code).toBe(0);
      expect(again.stderr).toContain(`pr/31: ${first.slice(0, 7)} → ${second.slice(0, 7)}`);
      expect(git(repo, ['rev-parse', 'pr/31']).trim()).toBe(second);
      expect((JSON.parse(again.stdout) as ReviewPlan).steps.map((s) => s.file)).toContain('src/utils/limits.ts');

      // Without --fetch, the most recent local copy is reviewed (pr/31, not the stale refs/pull/31/head).
      const local = await resolveReviewRef(repo, '#31');
      expect(local).toMatchObject({ ok: true, ref: 'pr/31', commit: second, label: '#31' });
    } finally {
      git(repo, ['remote', 'remove', 'origin']);
      git(repo, ['update-ref', '-d', 'refs/pull/31/head']);
      git(repo, ['branch', '-q', '-D', 'feature-v2', 'pr/31']);
    }
  });

  it('--fetch reports git\'s own reason when it fails; remotes that look like options are refused', async () => {
    const failed = await cli('review', '#5', repo, '--fetch');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Could not fetch #5: 'origin' does not appear to be a git repository");
    expect((await cli('review', '#5', repo, '--fetch', '--remote', '--upload-pack=touch x')).code).toBe(2);
    gitCalls.length = 0;
    expect(() => pullRequestFetch({ host: 'github', number: 5 }, '--upload-pack=touch x')).toThrow('Invalid remote name');
    await expect(fetchPullRequest(repo, { host: 'github', number: 5 }, '--upload-pack=touch x')).rejects.toThrow('Invalid remote name');
    expect(gitCalls.some((args) => args.includes('fetch'))).toBe(false);
  });

  it('finds a branch that only exists on a remote (a fresh clone), keeping the name as typed', async () => {
    const remote = path.join(makeTempDir('cv-remote-'), 'origin.git');
    git(repo, ['init', '-q', '--bare', remote]);
    git(repo, ['push', '-q', remote, 'feature:refs/heads/copilot/refunds']);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['fetch', '-q', 'origin']);
    try {
      expect(await resolveReviewRef(repo, 'copilot/refunds')).toMatchObject({ ok: true, ref: 'refs/remotes/origin/copilot/refunds', label: 'copilot/refunds' });
      const { code, stdout } = await cli('review', 'copilot/refunds', repo, '--json');
      expect(code).toBe(0);
      const plan = JSON.parse(stdout) as ReviewPlan;
      expect(plan.ref).toBe('copilot/refunds');
      expect(plan.steps.map((s) => s.file)).toEqual(['src/utils/format.ts', 'src/utils/refunds.ts']);
    } finally {
      git(repo, ['remote', 'remove', 'origin']);
    }
  });

  it('viewed state: concurrent updates are all kept; files outside the change are not stored', async () => {
    const head = git(repo, ['rev-parse', 'feature']).trim();
    const files = ['package-lock.json', 'src/utils/format.ts', 'src/utils/refunds.ts'];
    await Promise.all(files.map((f) => updateReviewState(repo, 'concurrent', head, { [f]: true }, { mergeBase: mainHead })));
    expect(Object.keys(readReviewState(repo, 'concurrent').viewed).sort()).toEqual(files);
    // An unchanged file and a path that does not exist are not part of the review.
    await updateReviewState(repo, 'concurrent', head, { 'src/App.tsx': true, 'not/in/plan.ts': true }, { mergeBase: mainHead });
    expect(Object.keys(readReviewState(repo, 'concurrent').viewed).sort()).toEqual(files);
  });

  it('says which changed files a review from a sub-folder leaves out', async () => {
    const { code, stdout } = await cli('review', 'feature', '--root', path.join(repo, 'src'), '--json');
    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as ReviewPlan;
    expect(plan.steps.map((s) => s.file)).toEqual(['utils/format.ts', 'utils/refunds.ts']);
    expect(plan.warnings).toEqual([expect.stringMatching(/^1 changed file outside src\/ is not part of this review: review from the repository root \(.+\) to include it\.$/)]);
  });

  it('reports unknown refs and usage errors', async () => {
    const unknown = await cli('review', 'featur', repo);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown git ref "featur". Did you mean "feature"?');
    expect((await cli('review', 'feature', repo, '--format', 'xml')).code).toBe(2);
    expect((await cli('review', 'feature', repo, '--bogus')).code).toBe(2);
    expect((await cli('review', 'feature', repo, '--base', 'nope')).code).toBe(1);
    // A file that cannot be written is a failure (1), not a usage error.
    const unwritable = await cli('review', 'feature', repo, '-o', path.join(repo, 'package.json', 'review.md'));
    expect(unwritable.code).toBe(1);
    expect(unwritable.stderr).toContain('Cannot write');
  });

  it('pr shows the review path of your own change', async () => {
    git(repo, ['checkout', '-q', 'feature']);
    try {
      const { code, stdout } = await cli('pr', repo, '--no-cache');
      expect(code).toBe(0);
      expect(stdout).toContain('### Review path');
      expect(stdout).toContain('- [ ] 1. `src/utils/format.ts` (core)');
      expect(stdout).toContain('- [ ] 2. `src/utils/refunds.ts` (consumer)');
    } finally {
      git(repo, ['checkout', '-q', 'main']);
    }
  });
});
