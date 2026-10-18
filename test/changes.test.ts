import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChangeSet, codeChange, codeLines, codeLinesFor } from '../src/analyzer/changes.js';
import { analyze } from '../src/analyzer/index.js';
import type { RawChanges } from '../src/analyzer/git.js';
import type { CodeOwners } from '../src/analyzer/owners.js';
import { buildTestMap, detectTestRunners } from '../src/analyzer/tests.js';
import type { ChangedFile, ChangeSet, FileGitInfo, ReportData } from '../src/shared/types.js';
import { commitAll, DAY, daysAgo, editFile, fixtureDir, git, hasGit, initRepo, isolateGit, removeTempDirs } from './companion-helpers.js';
import { analyzeFixture } from './helpers.js';

type Input = Parameters<typeof buildChangeSet>[0];

let react: ReportData;
let nest: ReportData;
beforeAll(async () => {
  [react, nest] = await Promise.all([analyzeFixture('react-vite-ts'), analyzeFixture('nest-api')]);
});

const vitest = detectTestRunners([{ devDependencies: { vitest: '^2' } }], undefined);

function changed(id: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { id, status: 'modified', additions: 1, deletions: 1, lines: [], analyzed: true, ...overrides };
}

function changeSet(data: ReportData, files: ChangedFile[], extra: Partial<Input> = {}, raw: Partial<RawChanges> = {}): ChangeSet {
  return buildChangeSet({
    raw: { mode: 'working', files, commits: [], ...raw },
    files: data.files,
    edges: data.edges,
    symbolEdges: data.symbolEdges,
    routes: data.routes,
    hotspots: [],
    testMap: buildTestMap(data.files, data.edges),
    runners: vitest,
    ...extra,
  });
}

describe('buildChangeSet: changed symbols', () => {
  it('maps changed lines to the function / component that contains them', () => {
    const c = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })]);
    expect(c.symbols).toEqual([{ id: 'src/components/Button.tsx#Button', file: 'src/components/Button.tsx', name: 'Button', kind: 'component', exported: true, usedBy: expect.any(Number) }]);
    expect(c.symbols[0].usedBy).toBeGreaterThan(0);
    expect(changeSet(react, [changed('src/components/Button.tsx', { lines: [4] })]).symbols.map((s) => s.id)).toEqual(['src/components/Button.tsx#ButtonProps']);
    // `Button.displayName = …` (line 21) is outside every declaration
    expect(changeSet(react, [changed('src/components/Button.tsx', { lines: [21] })]).symbols).toEqual([]);
  });

  it('maps lines inside classes to the methods that contain them', () => {
    const file = 'src/users/users.service.ts';
    const c = changeSet(nest, [changed(file, { lines: [17, 36, 39] })]);
    expect(c.symbols.map((s) => [s.id, s.name, s.kind]).sort()).toEqual([
      [`${file}#UsersService.findOne`, 'UsersService.findOne', 'method'],
      [`${file}#UsersService.remove`, 'UsersService.remove', 'method'],
    ]);
    expect(c.symbols.find((s) => s.name === 'UsersService.findOne')!.usedBy).toBeGreaterThan(0);
    // The class line itself (before the first member) is attributed to the class.
    expect(changeSet(nest, [changed(file, { lines: [9] })]).symbols.map((s) => [s.id, s.kind])).toEqual([[`${file}#UsersService`, 'class']]);
  });

  it('orders symbols by how widely they are used', () => {
    const c = changeSet(react, [changed('src/utils/format.ts', { lines: [4, 8, 12, 18] }), changed('src/utils/math.ts', { lines: [4, 8, 14] })]);
    expect(c.symbols.length).toBeGreaterThanOrEqual(6);
    const used = c.symbols.map((s) => s.usedBy);
    expect(used).toEqual([...used].sort((a, b) => b - a));
  });
});

describe('buildChangeSet: impact, tests and clusters', () => {
  it('follows importers transitively and finds the routes behind them', () => {
    const c = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })]);
    expect(c.impacted).toEqual(expect.arrayContaining(['src/components/UserCard.tsx', 'src/components/ThemeToggle.tsx', 'src/components/index.ts', 'src/pages/Settings.tsx', 'src/components/Button.test.tsx']));
    expect(c.impacted).not.toContain('src/components/Button.tsx');
    expect(new Set(c.impacted).size).toBe(c.impacted.length);
    const routeIds = new Set(react.routes.map((r) => r.id));
    expect(c.impactedRoutes.length).toBeGreaterThan(0);
    expect(c.impactedRoutes.every((id) => routeIds.has(id))).toBe(true);
    const settings = react.routes.find((r) => r.path === '/settings')!;
    expect(c.impactedRoutes).toContain(settings.id);
  });

  it('suggests the tests that reach the changed files and a command to run them', () => {
    const c = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })]);
    expect(c.tests).toEqual({ files: ['src/components/Button.test.tsx'], command: 'npx vitest run src/components/Button.test.tsx', runner: 'vitest', changedTests: [] });
    const editedTest = changeSet(react, [changed('src/components/Button.test.tsx', { lines: [5] })]);
    expect(editedTest.tests).toMatchObject({ files: ['src/components/Button.test.tsx'], changedTests: ['src/components/Button.test.tsx'] });
    const noRunner = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })], { runners: {} });
    expect(noRunner.tests).toEqual({ files: ['src/components/Button.test.tsx'], command: undefined, runner: undefined, changedTests: [] });
    expect(changeSet(react, [changed('src/utils/format.ts', { lines: [12] })]).tests.files).toEqual([]);
  });

  it('groups changed files that import each other into review clusters', () => {
    const c = changeSet(react, [changed('src/components/Button.tsx'), changed('src/utils/math.ts'), changed('src/utils/format.ts'), changed('src/pages/Home.tsx')]);
    expect(c.clusters).toEqual([['src/pages/Home.tsx', 'src/utils/format.ts', 'src/utils/math.ts'], ['src/components/Button.tsx']]);
  });

  it('ignores deleted and non-source files for impact but counts their lines', () => {
    const c = changeSet(
      react,
      [changed('src/utils/math.ts', { lines: [4], additions: 2, deletions: 1 }), changed('README.md', { analyzed: false, additions: 10, deletions: 0 }), changed('src/old.ts', { status: 'deleted', analyzed: false, additions: 0, deletions: 30 })],
      {},
      { mode: 'branch', base: 'origin/main', baseCommit: '0123456789', commits: [{ hash: 'aaaaaaaaaa', date: 1, author: 'X', subject: 'Y', files: 3, additions: 12, deletions: 31, paths: ['src/utils/math.ts'] }] },
    );
    expect(c).toMatchObject({ mode: 'branch', base: 'origin/main', baseCommit: '0123456789', additions: 12, deletions: 31 });
    expect(c.commits).toHaveLength(1);
    expect(c.files.map((f) => f.id)).toEqual(['src/utils/math.ts', 'README.md', 'src/old.ts']);
    expect(c.symbols.map((s) => s.file)).toEqual(['src/utils/math.ts']);
    expect(c.clusters).toEqual([['src/utils/math.ts']]);
  });
});

describe('buildChangeSet: reviewers and owners', () => {
  const now = Date.now();
  function withGit(data: ReportData, git: Record<string, FileGitInfo>): ReportData['files'] {
    return data.files.map((f) => (git[f.id] ? { ...f, git: git[f.id] } : f));
  }
  const info = (commits: number, authors: FileGitInfo['authors']): FileGitInfo => ({ commits, authors, lastModified: now, firstSeen: now - 500 * DAY, recent: [], ownership: authors[0].commits / commits });

  it('suggests people who know the changed files, weighted by recency, never the current user or bots', () => {
    const files = withGit(react, {
      'src/components/Button.tsx': info(10, [
        { name: 'Me Myself', commits: 5, last: now - DAY },
        { name: 'Old Timer', commits: 4, last: now - 400 * DAY },
        { name: 'Recent Rita', commits: 3, last: now - 2 * DAY },
        { name: 'dependabot[bot]', commits: 6, last: now },
        { name: 'renovate-bot', commits: 6, last: now },
        { name: 'Newbie', commits: 1, last: now - DAY },
      ]),
      'src/utils/format.ts': info(4, [{ name: 'Recent Rita', commits: 1, last: now - 10 * DAY }, { name: 'github-actions', commits: 3, last: now }]),
    });
    const c = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] }), changed('src/utils/format.ts', { lines: [12] })], { files, user: 'Me Myself' });
    expect(c.reviewers.map((r) => r.name)).toEqual(['Recent Rita', 'Old Timer', 'Newbie']);
    expect(c.reviewers[0]).toMatchObject({ files: 2, last: now - 2 * DAY });
    const scores = c.reviewers.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores.every((s) => s > 0 && s <= 2)).toBe(true);
  });

  it('caps reviewers at five and suggests nobody without git history', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `Dev ${i}`, commits: 8 - i, last: now - i * DAY }));
    const files = withGit(react, { 'src/components/Button.tsx': info(36, many) });
    const c = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })], { files });
    expect(c.reviewers.map((r) => r.name)).toEqual(['Dev 0', 'Dev 1', 'Dev 2', 'Dev 3', 'Dev 4']);
    expect(changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })]).reviewers).toEqual([]);
  });

  it('collects CODEOWNERS for every changed path, including files outside the analysis', () => {
    const owners: CodeOwners = { file: 'CODEOWNERS', ownersOf: (id) => (id.startsWith('src/components/') ? ['@ui'] : id.endsWith('.md') ? ['@docs', '@ui'] : undefined) };
    const c = changeSet(react, [changed('src/components/Button.tsx'), changed('README.md', { analyzed: false }), changed('src/utils/math.ts')], { owners });
    expect(c.owners).toEqual([
      { owner: '@ui', files: ['src/components/Button.tsx', 'README.md'] },
      { owner: '@docs', files: ['README.md'] },
    ]);
    expect(changeSet(react, [changed('src/components/Button.tsx')]).owners).toEqual([]);
  });
});

describe('buildChangeSet: risk', () => {
  function expectConsistentRisk(c: ChangeSet): void {
    const { score, level, factors } = c.risk;
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(level).toBe(score < 30 ? 'low' : score < 60 ? 'medium' : 'high');
    expect(factors.every((f) => f.points > 0 && Number.isInteger(f.points))).toBe(true);
    expect(factors.map((f) => f.points)).toEqual([...factors.map((f) => f.points)].sort((a, b) => b - a));
    expect(score).toBe(Math.min(100, factors.reduce((n, f) => n + f.points, 0)));
    for (const f of factors) expect(f.label).not.toMatch(/undefined|NaN/);
  }

  it('rates a one-line change to a file nothing depends on as low risk', () => {
    const c = changeSet(react, [changed('src/utils/legacyStorage.ts', { lines: [6] })]);
    expectConsistentRisk(c);
    expect(c.impacted).toEqual([]);
    expect(c.risk.level).toBe('low');
  });

  it('explains what makes a change risky', () => {
    const c = changeSet(react, [changed('src/utils/format.ts', { lines: [12], additions: 3, deletions: 2 })], { hotspots: [{ file: 'src/utils/format.ts', score: 90, commits: 30, complexity: 5, loc: 22 }] });
    expectConsistentRisk(c);
    const labels = c.risk.factors.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['5 lines changed', '1 hotspot file', '1 changed file has no tests', 'changes files inside a dependency cycle']));
    expect(labels.some((l) => /^1 source files? in 1 area$/.test(l)), labels.join(' | ')).toBe(true);
    // Line 12 is inside formatDate, so only its importers (and theirs) count.
    expect(labels.some((l) => /^\d+ other files? depends? on the changed symbols$/.test(l)), labels.join(' | ')).toBe(true);
  });

  it('flags complex functions and widely used exports', () => {
    const files = react.files.map((f) =>
      f.id === 'src/components/Button.tsx' ? { ...f, symbols: f.symbols.map((s) => (s.name === 'Button' ? { ...s, complexity: 30 } : s)) } : f,
    );
    const c = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })], { files });
    expectConsistentRisk(c);
    expect(c.risk.factors).toContainEqual({ label: 'touches a function with complexity 30', points: 15 });
    if (c.symbols[0].usedBy >= 5) expect(c.risk.factors.map((f) => f.label)).toContain('1 widely used export modified');
  });

  // --- integration (wave 3): the risk factors follow the rules My changes, `pr` and MCP review_changes use ---
  it('does not count the exports of a new file as widely used exports that were modified', () => {
    const modified = changeSet(react, [changed('src/components/Button.tsx', { lines: [12] })]);
    expect(modified.symbols.find((s) => s.name === 'Button')!.usedBy).toBeGreaterThanOrEqual(5);
    expect(modified.risk.factors.map((f) => f.label)).toContain('1 widely used export modified');
    const added = changeSet(react, [changed('src/components/Button.tsx', { lines: [12], status: 'added' })]);
    expect(added.risk.factors.map((f) => f.label).join(' | ')).not.toMatch(/widely used export/);
  });

  it('counts a handler that a test requests over HTTP as tested', async () => {
    const next = await analyze({ root: fixtureDir('fullstack-next'), git: false, includeSource: false, history: false });
    const handler = 'app/api/users/[id]/route.ts';
    expect(next.files.find((f) => f.id === handler)!.tests ?? []).toEqual([]);
    // The test reaches it by `request(app).delete('/api/users/1')`: a URL visit and an API call.
    const blind = next.files.map((f) => ({ ...f, urlVisits: undefined }));
    expect(changeSet(next, [changed(handler, { lines: [3] })], { files: blind }).risk.factors.map((f) => f.label)).toContain('1 changed file has no tests');
    expect(changeSet(next, [changed(handler, { lines: [3] })], { files: blind, apiCalls: next.apiCalls }).risk.factors.map((f) => f.label).join(' | ')).not.toMatch(/no tests/);
    expect(changeSet(next, [changed(handler, { lines: [3] })]).risk.factors.map((f) => f.label).join(' | ')).not.toMatch(/no tests/);
  });

  // --- release fixes: the risk follows query.testEvidence (coverage counts) and counts areas by folder ---
  it('does not flag a file the coverage report saw run as untested', () => {
    const file = 'src/utils/legacyStorage.ts';
    const plain = changeSet(react, [changed(file, { lines: [6] })]);
    expect(plain.risk.factors.map((f) => f.label)).toContain('1 changed file has no tests');
    const covered = react.files.map((f) => (f.id === file ? { ...f, coverage: { lines: { total: 12, covered: 12 }, uncovered: [], source: 'lcov' as const } } : f));
    expect(changeSet(react, [changed(file, { lines: [6] })], { files: covered }).risk.factors.map((f) => f.label).join(' | ')).not.toMatch(/no tests/);
  });

  it('counts four changed files in one folder as one area', async () => {
    const next = await analyze({ root: fixtureDir('fullstack-next'), git: false, includeSource: false, history: false });
    const lib = ['lib/api.ts', 'lib/billing.ts', 'lib/db.ts', 'lib/format.ts'].map((id) => changed(id, { lines: [1] }));
    expect(changeSet(next, lib).risk.factors.map((f) => f.label)).toContain('4 source files in 1 area');
    const spread = changeSet(next, [...lib, changed('app/api/users/route.ts', { lines: [1] }), changed('app/page.tsx', { lines: [1] })]);
    // lib, app/api and app: the folder, at most two levels deep.
    expect(spread.risk.factors.map((f) => f.label)).toContain('6 source files in 3 areas');
  });

  it('mentions a project without tests', () => {
    const noTests = react.files.filter((f) => f.kind !== 'test');
    const c = changeSet(react, [changed('src/utils/math.ts', { lines: [4] })], { files: noTests, testMap: buildTestMap(noTests, react.edges) });
    expect(c.risk.factors).toContainEqual({ label: 'the project has no tests', points: 6 });
  });

  it('caps the score at 100 for huge changes', () => {
    const all = react.files.map((f) => changed(f.id, { lines: [1, 2, 3, 4, 5], additions: 5000, deletions: 3000 }));
    const c = changeSet(react, all, { hotspots: react.files.slice(0, 10).map((f) => ({ file: f.id, score: 1, commits: 1, complexity: 1, loc: 1 })) });
    expectConsistentRisk(c);
    expect(c.risk.level).not.toBe('low');
  });
});

describe('code vs. comment changes (query-core)', () => {
  it('codeLines finds lines with real tokens, also around templates and regular expressions', () => {
    const text = [
      '// a comment', // 1
      'const a = 1; /* trailing */', // 2
      '/**', // 3
      ' * doc', // 4
      ' */', // 5
      '', // 6
      'const t = `x ${a} // not a comment', // 7
      '  still the template`;', // 8
      'const r = /\/\* not a comment/;', // 9
      'const b = 2;', // 10
    ].join('\n');
    expect([...codeLines(text)].sort((x, y) => x - y)).toEqual([2, 7, 8, 9, 10]);
  });

  const diffOf = (lines: string[]): string => ['diff --git a/f.ts b/f.ts', '--- a/f.ts', '+++ b/f.ts', ...lines].join('\n');

  it('classifies comment-only hunks as trivia, rebuilding the old text from the diff', () => {
    const now = ['/**', ' * Formats a date.', ' * Second line.', ' */', 'export function f(x: number) {', '  // explain', '  return x + 1;', '}', ''].join('\n');
    const commentOnly = diffOf(['@@ -1,6 +1,6 @@', ' /**', '- * Formats the date.', '+ * Formats a date.', '  * Second line.', '  */', ' export function f(x: number) {', '-  // old explanation', '+  // explain']);
    expect(codeChange({ id: 'f.ts', diff: commentOnly }, now)).toEqual({ lines: [], removals: [], triviaOnly: true });
    // Removing a line of a JSDoc block is trivia too (the old text is scanned, not the line alone).
    const removedDoc = diffOf(['@@ -1,5 +1,4 @@', ' /**', '  * Formats a date.', '- * Removed line.', '  * Second line.', '  */']);
    expect(codeChange({ id: 'f.ts', diff: removedDoc }, now)?.triviaOnly).toBe(true);
    const code = diffOf(['@@ -5,3 +5,3 @@', ' export function f(x: number) {', '   // explain', '-  return x;', '+  return x + 1;', ' }']);
    expect(codeChange({ id: 'f.ts', diff: code }, now)).toEqual({ lines: [7], removals: [], triviaOnly: false });
    // A plain removal is anchored between the lines around it.
    const removal = diffOf(['@@ -6,4 +6,3 @@', '   // explain', '-  console.log(x);', '   return x + 1;', ' }']);
    expect(codeChange({ id: 'f.ts', diff: removal }, now)).toEqual({ lines: [6], removals: [[6, 7]], triviaOnly: false });
    // A diff that does not match the text, or none at all: unknown.
    expect(codeChange({ id: 'f.ts', diff: diffOf(['@@ -1,1 +1,1 @@', '-a', '+b']) }, now)).toBeUndefined();
    expect(codeChange({ id: 'f.ts' }, now)).toBeUndefined();
    // No hunks at all (a pure rename, a mode change): nothing to classify, so not "comment-only".
    expect(codeChange({ id: 'f.ts', diff: ['diff --git a/f.ts b/f.ts', 'old mode 100644', 'new mode 100755'].join('\n') }, now)).toBeUndefined();
  });

  it('JSX text is code even when it looks like a comment; a comment in braces is not', () => {
    const tsx = [
      'export function Help() {', // 1
      '  return (', // 2
      '    <p>', // 3
      '      // read the manual', // 4
      '      {/* just a note */}', // 5
      '      /* shown */ text', // 6
      '    </p>', // 7
      '  );', // 8
      '}', // 9
      '// trailing comment', // 10
    ].join('\n');
    expect([...codeLinesFor('src/Help.tsx', tsx)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
    const help = diffOf(['@@ -4,1 +4,1 @@', '-      // see the docs', '+      // read the manual']);
    expect(codeChange({ id: 'src/Help.tsx', diff: help }, tsx)?.triviaOnly).toBe(false);
    const note = diffOf(['@@ -5,1 +5,1 @@', '-      {/* a note */}', '+      {/* just a note */}']);
    expect(codeChange({ id: 'src/Help.tsx', diff: note }, tsx)?.triviaOnly).toBe(true);
  });

  it('single-file components: markup text is code, HTML and script comments are not', () => {
    const vue = [
      '<template>', // 1
      '  <!-- a note -->', // 2
      '  <p>// shown to users</p>', // 3
      '</template>', // 4
      '<script setup lang="ts">', // 5
      '// script comment', // 6
      'const a = 1;', // 7
      '</script>', // 8
      '<style>', // 9
      '/* style comment */', // 10
      'p { color: red; }', // 11
      '</style>', // 12
    ].join('\n');
    expect([...codeLinesFor('src/A.vue', vue)].sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 7, 8, 9, 11, 12]);
  });
});

describe.skipIf(!hasGit)('buildChangeSet: symbol-precise impact in a real repository', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => {
    restoreEnv?.();
    removeTempDirs();
  });

  const run = (root: string) => analyze({ root, includeSource: false, history: false, persist: false });

  it('a comment-only edit affects nothing and is low risk', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice', date: daysAgo(10), message: 'Initial import' });
    editFile(repo, 'src/utils/format.ts', '// Nobody imports this one — it should show up as an unused export.', '// Nobody imports this one (yet): an unused export.');
    editFile(repo, 'src/utils/format.ts', "  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });", "  // Short month names read best in tables.\n  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });");
    const c = (await run(repo)).changes!;
    expect(c.files.map((f) => f.id)).toEqual(['src/utils/format.ts']);
    expect(c.commentOnly).toEqual(['src/utils/format.ts']);
    expect(c.symbols).toEqual([]);
    expect(c.impacted).toEqual([]);
    expect(c.impactedRoutes).toEqual([]);
    expect(c.tests.files).toEqual([]);
    expect(c.risk.level).toBe('low');
    expect(c.risk.factors.map((f) => f.label).join(' | ')).not.toMatch(/depend|no tests|cycle/);
  });

  it('an edit inside one exported function reaches only its importers', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice', date: daysAgo(10), message: 'Initial import' });
    editFile(repo, 'src/utils/format.ts', "month: 'short'", "month: 'long'");
    const precise = (await run(repo)).changes!;
    expect(precise.impactPrecision).toBe('symbol');
    expect(precise.symbols.map((s) => s.id)).toEqual(['src/utils/format.ts#formatDate']);
    expect(precise.impacted).toContain('src/components/UserCard.tsx'); // imports formatDate
    expect(precise.impacted).not.toContain('src/utils/math.ts'); // imports only formatNumber
    expect(precise.risk.factors.map((f) => f.label)).toContainEqual(expect.stringMatching(/^\d+ other files? depends? on the changed symbols$/));

    // A change outside any declaration (an import) reaches every importer of the file.
    editFile(repo, 'src/utils/format.ts', "import { round } from './math';", "import { round } from './math.ts';");
    const fileLevel = (await run(repo)).changes!;
    expect(fileLevel.impactPrecision).toBe('file');
    expect(fileLevel.impacted).toEqual(expect.arrayContaining(['src/components/UserCard.tsx', 'src/pages/Settings.tsx', 'src/utils/math.ts']));
    expect(fileLevel.risk.factors.map((f) => f.label)).toContainEqual(expect.stringMatching(/on the changed files$/));
  });

  it('an edit to a constant reaches the importers of the exported functions that read it', async () => {
    const repo = initRepo('fullstack-next');
    commitAll(repo, { author: 'Alice', date: daysAgo(10), message: 'Initial import' });
    editFile(repo, 'lib/db.ts', 'export const MAX_USERS = 100;', 'export const MAX_USERS = 50;');
    const c = (await run(repo)).changes!;
    expect(c.impactPrecision).toBe('symbol');
    expect(c.symbols.map((s) => s.id)).toEqual(['lib/db.ts#MAX_USERS']);
    // Nobody imports MAX_USERS, but listUsers reads it: its importers are affected.
    expect(c.impacted).toEqual(expect.arrayContaining(['app/api/users/route.ts']));
    expect(c.impacted).not.toContain('app/api/users/[id]/route.ts'); // uses findUser / deleteUser only
  });

  it('a renamed file is never comment-only and affects every importer', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice', date: daysAgo(10), message: 'Initial import' });
    git(repo, ['mv', 'src/utils/math.ts', 'src/utils/numbers.ts']);
    editFile(repo, 'src/utils/format.ts', "from './math'", "from './numbers'");
    const c = (await run(repo)).changes!;
    expect(c.files.find((f) => f.id === 'src/utils/numbers.ts')?.status).toBe('renamed');
    expect(c.commentOnly).toBeUndefined();
    expect(c.impactPrecision).toBe('file');
  });

  it('renaming an export falls back to every importer (the old name is still imported)', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice', date: daysAgo(10), message: 'Initial import' });
    editFile(repo, 'src/utils/format.ts', 'export function formatDate(iso: string)', 'export function formatDay(iso: string)');
    const c = (await run(repo)).changes!;
    expect(c.impactPrecision).toBe('file');
    expect(c.impacted).toEqual(expect.arrayContaining(['src/components/UserCard.tsx', 'src/utils/math.ts']));
  });
});
