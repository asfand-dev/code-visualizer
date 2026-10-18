import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeHealth, historyPath, mergeHistory, readHistory, writeHistory } from '../src/analyzer/health.js';
import type { FileInfo, HealthReport, HistoryPoint, Insights, Stats, SymbolInfo } from '../src/shared/types.js';
import { makeTempDir, removeTempDirs } from './companion-helpers.js';

afterAll(removeTempDirs);

/* ------------------------------- factories -------------------------------- */

function fn(fileId: string, name: string, complexity: number): SymbolInfo {
  return { id: `${fileId}#${name}`, name, kind: 'function', line: 1, endLine: 5, exported: true, loc: 5, complexity };
}

function file(id: string, overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id,
    name: id.slice(id.lastIndexOf('/') + 1),
    dir: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
    ext: '.ts',
    language: 'typescript',
    kind: 'util',
    loc: 40,
    sloc: 30,
    bytes: 800,
    complexity: 2,
    maxComplexity: 2,
    symbols: [fn(id, 'a', 2), fn(id, 'b', 3)],
    exports: [],
    assets: [],
    unresolved: [],
    isEntry: false,
    isTest: false,
    todos: [],
    metrics: { fanIn: 1, fanOut: 1, importance: 0.5, instability: 0.5, externalImports: 0 },
    tests: ['src/all.test.ts'],
    ...overrides,
  };
}

function emptyInsights(overrides: Partial<Insights> = {}): Insights {
  return {
    cycles: [],
    orphans: [],
    unusedExports: [],
    unusedDependencies: [],
    missingDependencies: [],
    complexFunctions: [],
    hotspots: [],
    changeCoupling: [],
    duplicateSymbols: [],
    untested: [],
    deprecated: [],
    ruleViolations: [],
    knowledgeSilos: [],
    ...overrides,
  };
}

function stats(testReach: number): Stats {
  return {
    files: 0,
    loc: 0,
    sloc: 0,
    symbols: 0,
    components: 0,
    hooks: 0,
    functions: 0,
    classes: 0,
    interfaces: 0,
    types: 0,
    enums: 0,
    constants: 0,
    variables: 0,
    routes: 0,
    packages: 0,
    internalEdges: 0,
    testFiles: 0,
    todos: 0,
    avgComplexity: 0,
    testReach,
    durationMs: 0,
  };
}

const testFile = file('src/all.test.ts', { kind: 'test', isTest: true, symbols: [], tests: undefined });
const cleanFiles = (): FileInfo[] => ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map((id) => file(id));

function category(h: HealthReport, id: string) {
  const c = h.categories.find((x) => x.id === id);
  if (!c) throw new Error(`no category ${id}: ${h.categories.map((x) => x.id).join(', ')}`);
  return c;
}

function expectWellFormed(h: HealthReport): void {
  expect(Number.isInteger(h.score)).toBe(true);
  expect(h.score).toBeGreaterThanOrEqual(0);
  expect(h.score).toBeLessThanOrEqual(100);
  const expectedGrade = h.score >= 90 ? 'A' : h.score >= 80 ? 'B' : h.score >= 70 ? 'C' : h.score >= 60 ? 'D' : 'E';
  expect(h.grade).toBe(expectedGrade);
  for (const c of h.categories) {
    expect(Number.isInteger(c.score), c.id).toBe(true);
    expect(c.score, c.id).toBeGreaterThanOrEqual(0);
    expect(c.score, c.id).toBeLessThanOrEqual(100);
    expect(c.detail, c.id).not.toMatch(/undefined|NaN/);
  }
  const total = h.categories.reduce((n, c) => n + c.weight, 0);
  expect(h.score).toBe(Math.max(0, Math.min(100, Math.round(h.categories.reduce((n, c) => n + c.score * c.weight, 0) / total))));
  expect(h.improvements.length).toBeLessThanOrEqual(8);
  const gains = h.improvements.map((i) => i.gain);
  expect(gains).toEqual([...gains].sort((a, b) => b - a));
  for (const imp of h.improvements) {
    expect(imp.gain, imp.id).toBeGreaterThan(0);
    // One improvement can never win back more than the points that are missing.
    expect(imp.gain, imp.id).toBeLessThanOrEqual(100 - h.score + 1);
    expect(`${imp.title} ${imp.detail}`, imp.id).not.toMatch(/undefined|NaN/);
  }
  expect(new Set(h.improvements.map((i) => i.id)).size).toBe(h.improvements.length);
}

/* --------------------------------- tests ---------------------------------- */

describe('computeHealth', () => {
  it('gives a clean, fully tested project 100/A and no improvements', () => {
    const h = computeHealth({ files: [...cleanFiles(), testFile], insights: emptyInsights(), stats: stats(1), hasGit: false, testFiles: 1, exportsTotal: 8 });
    expectWellFormed(h);
    expect(h).toMatchObject({ score: 100, grade: 'A', improvements: [] });
    expect(h.categories.map((c) => c.id)).toEqual(['modularity', 'complexity', 'size', 'dead-code', 'dependencies', 'tests']);
    expect(h.categories.every((c) => c.score === 100)).toBe(true);
  });

  it('scores the test category 0 when there are no tests at all', () => {
    const files = cleanFiles().map((f) => ({ ...f, tests: undefined }));
    const h = computeHealth({ files, insights: emptyInsights({ untested: files.map((f) => f.id) }), stats: stats(0), hasGit: false, testFiles: 0, exportsTotal: 8 });
    expectWellFormed(h);
    expect(category(h, 'tests')).toMatchObject({ score: 0, detail: 'No test files found' });
    expect(h.score).toBe(83); // 75 of 90 weighted points
    expect(h.grade).toBe('B');
    expect(h.improvements.map((i) => i.id)).toEqual(['tests']);
  });

  it('adds the knowledge category only when git history is available', () => {
    const silo = { file: 'src/a.ts', author: 'Alice', share: 1, lastActive: Date.now() };
    const input = { files: [...cleanFiles(), testFile], stats: stats(1), testFiles: 1, exportsTotal: 8 };
    const withoutGit = computeHealth({ ...input, insights: emptyInsights({ knowledgeSilos: [silo] }), hasGit: false });
    expect(withoutGit.categories.some((c) => c.id === 'knowledge')).toBe(false);
    const withGit = computeHealth({ ...input, insights: emptyInsights({ knowledgeSilos: [silo] }), hasGit: true });
    expectWellFormed(withGit);
    expect(category(withGit, 'knowledge')).toMatchObject({ weight: 10, detail: '1 important files are known by only one person' });
    expect(category(withGit, 'knowledge').score).toBeLessThan(100);
    expect(withGit.improvements.find((i) => i.id === 'knowledge')).toMatchObject({ files: ['src/a.ts'], view: 'team' });
  });

  it('stays within bounds for a terrible project', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((id) =>
      file(id, {
        loc: 2000,
        inCycle: true,
        tests: undefined,
        symbols: [fn(id, 'huge', 80), fn(id, 'big', 60)],
        metrics: { fanIn: 30, fanOut: 30, importance: 1, instability: 0.5, externalImports: 9 },
      }),
    );
    const ids = files.map((f) => f.id);
    const h = computeHealth({
      files,
      insights: emptyInsights({
        cycles: Array.from({ length: 12 }, () => ids),
        orphans: ids,
        unusedExports: ids.map((f) => ({ file: f, name: 'x', line: 1 })),
        unusedDependencies: Array.from({ length: 20 }, (_, i) => `dep-${i}`),
        missingDependencies: Array.from({ length: 20 }, (_, i) => ({ name: `missing-${i}`, files: ids })),
        untested: ids,
        knowledgeSilos: ids.map((f) => ({ file: f, author: 'Solo', share: 1, lastActive: 0 })),
      }),
      stats: stats(0),
      hasGit: true,
      testFiles: 0,
      exportsTotal: 3,
    });
    expectWellFormed(h);
    expect(h.grade).toBe('E');
    expect(h.categories.every((c) => c.score === 0)).toBe(true);
    expect(h.improvements.length).toBeGreaterThan(3);
  });

  it('suggests improvements for every kind of problem, best gain first', () => {
    const files = [
      ...['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts', 'src/h.ts'].map((id) => file(id)),
      file('src/big.ts', { loc: 900, tests: undefined }),
      file('src/x.ts', { inCycle: true, tests: undefined, symbols: [fn('src/x.ts', 'tangled', 22)] }),
      file('src/y.ts', { inCycle: true, tests: undefined }),
      testFile,
    ];
    const h = computeHealth({
      files,
      insights: emptyInsights({
        cycles: [['src/x.ts', 'src/y.ts']],
        orphans: ['src/h.ts'],
        unusedExports: [
          { file: 'src/a.ts', name: 'a', line: 1 },
          { file: 'src/a.ts', name: 'b', line: 2 },
          { file: 'src/b.ts', name: 'T', line: 1, typeOnly: true },
        ],
        unusedDependencies: ['left-pad'],
        missingDependencies: [{ name: 'lodash', files: ['src/c.ts'] }],
        untested: ['src/big.ts', 'src/x.ts', 'src/y.ts'],
        knowledgeSilos: [{ file: 'src/a.ts', author: 'Alice', share: 0.9, lastActive: 0 }],
      }),
      stats: stats(8 / 11),
      hasGit: true,
      testFiles: 1,
      exportsTotal: 20,
    });
    expectWellFormed(h);
    expect(h.improvements.map((i) => i.id).sort()).toEqual(['complexity', 'cycles', 'dependencies', 'knowledge', 'orphans', 'size', 'tests', 'unused-exports']);
    expect(h.improvements.find((i) => i.id === 'cycles')).toMatchObject({ title: 'Break the circular dependency', files: ['src/x.ts', 'src/y.ts'] });
    expect(h.improvements.find((i) => i.id === 'unused-exports')).toMatchObject({ title: 'Remove 2 unused exports', files: ['src/a.ts'] });
    expect(h.improvements.find((i) => i.id === 'dependencies')!.detail).toBe('remove left-pad; declare lodash');
    expect(h.improvements.find((i) => i.id === 'size')!.detail).toBe('big.ts (900 lines)');
  });

  it('estimates gains that match the real score change (unclamped categories)', () => {
    const base = { stats: stats(1), hasGit: false, testFiles: 1, exportsTotal: 8 };
    // 2 of 20 functions are complex: simplifying them should lift the score by about the promised gain.
    const complexFile = file('src/a.ts', { symbols: [fn('src/a.ts', 'x', 20), fn('src/a.ts', 'y', 20), ...Array.from({ length: 18 }, (_, i) => fn('src/a.ts', `s${i}`, 1))] });
    const before = computeHealth({ ...base, files: [complexFile, testFile], insights: emptyInsights() });
    const promised = before.improvements.find((i) => i.id === 'complexity')!.gain;
    const simplified = { ...complexFile, symbols: complexFile.symbols.map((s) => ({ ...s, complexity: 1 })) };
    const after = computeHealth({ ...base, files: [simplified, testFile], insights: emptyInsights() });
    expect(Math.abs(after.score - before.score - promised)).toBeLessThanOrEqual(1);

    // Adding tests for the untested files.
    const files = cleanFiles().map((f, i) => (i < 2 ? { ...f, tests: undefined } : f));
    const untested = emptyInsights({ untested: ['src/a.ts', 'src/b.ts'] });
    const b2 = computeHealth({ ...base, stats: stats(0.5), files: [...files, testFile], insights: untested });
    const promised2 = b2.improvements.find((i) => i.id === 'tests')!.gain;
    const a2 = computeHealth({ ...base, stats: stats(1), files: [...cleanFiles(), testFile], insights: emptyInsights() });
    expect(Math.abs(a2.score - b2.score - promised2)).toBeLessThanOrEqual(1);
  });

  it('does not over-promise the gain of simplifying functions when the complexity score is already 0', () => {
    // 8 of 10 functions are complex → the category is clamped at 0. Simplifying the top 5 leaves 3 of 10.
    const symbols = [...Array.from({ length: 8 }, (_, i) => fn('src/a.ts', `c${i}`, 20)), fn('src/a.ts', 's1', 1), fn('src/a.ts', 's2', 1)];
    const base = { stats: stats(1), hasGit: false, testFiles: 1, exportsTotal: 8, insights: emptyInsights() };
    const before = computeHealth({ ...base, files: [file('src/a.ts', { symbols }), testFile] });
    expect(category(before, 'complexity').score).toBe(0);
    const improvement = before.improvements.find((i) => i.id === 'complexity')!;
    expect(improvement.title).toBe('Simplify the 5 most complex functions');
    const simplified = symbols.map((s, i) => (i < 5 ? { ...s, complexity: 1 } : s));
    const after = computeHealth({ ...base, files: [file('src/a.ts', { symbols: simplified }), testFile] });
    const actual = after.score - before.score;
    expect(improvement.gain, `promised +${improvement.gain}, applying it yields +${actual}`).toBeLessThanOrEqual(actual + 1);
  });
});

/* --------------------------------- history -------------------------------- */

function point(overrides: Partial<HistoryPoint> = {}): HistoryPoint {
  return { date: 1_700_000_000_000, commit: 'abc1234567', branch: 'main', score: 80, files: 10, loc: 500, cycles: 0, unusedExports: 1, avgComplexity: 2, testReach: 0.5, todos: 0, ...overrides };
}

describe('mergeHistory', () => {
  const HOUR = 3600 * 1000;

  it('starts a history with the first point', () => {
    expect(mergeHistory([], point())).toEqual([point()]);
  });

  it('replaces the last point when nothing meaningful changed within 6 hours', () => {
    const first = point({ loc: 400 });
    const next = point({ date: first.date + 2 * HOUR, loc: 410, todos: 3 });
    const merged = mergeHistory([point({ date: first.date - 10 * HOUR, score: 70 }), first], next);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toBe(next);
  });

  it('treats a missing dirty flag like false', () => {
    const merged = mergeHistory([point({ dirty: false })], point({ date: point().date + HOUR, dirty: undefined }));
    expect(merged).toHaveLength(1);
  });

  it('appends when the commit, dirty flag, score, file count or cycles differ, or 6 hours passed', () => {
    const last = point();
    const later = (o: Partial<HistoryPoint>) => mergeHistory([last], point({ date: last.date + HOUR, ...o }));
    expect(later({ commit: 'def4567890' })).toHaveLength(2);
    expect(later({ dirty: true })).toHaveLength(2);
    expect(later({ score: 81 })).toHaveLength(2);
    expect(later({ files: 11 })).toHaveLength(2);
    expect(later({ cycles: 1 })).toHaveLength(2);
    expect(mergeHistory([last], point({ date: last.date + 6 * HOUR }))).toHaveLength(2);
  });

  it('does not mutate its input and keeps the latest 500 points', () => {
    const points = Array.from({ length: 600 }, (_, i) => point({ date: i * 7 * HOUR, score: i % 100 }));
    const copy = [...points];
    const merged = mergeHistory(points, point({ date: 600 * 7 * HOUR, score: 1 }));
    expect(points).toEqual(copy);
    expect(merged).toHaveLength(500);
    expect(merged[499].date).toBe(600 * 7 * HOUR);
    expect(merged[0]).toBe(points[101]);
  });
});

describe('readHistory / writeHistory', () => {
  it('round-trips points through .code-visualizer/history.json and git-ignores the folder', () => {
    const root = makeTempDir('cv-history-');
    expect(readHistory(root)).toEqual([]);
    const points = [point(), point({ date: point().date + 1, score: 90 })];
    writeHistory(root, points);
    expect(historyPath(root)).toBe(path.join(root, '.code-visualizer', 'history.json'));
    expect(readHistory(root)).toEqual(points);
    expect(JSON.parse(fs.readFileSync(historyPath(root), 'utf8'))).toMatchObject({ version: 1, points });
    expect(fs.readFileSync(path.join(root, '.code-visualizer', '.gitignore'), 'utf8')).toContain('*');
  });

  it('keeps an existing .gitignore in the folder', () => {
    const root = makeTempDir('cv-history-');
    fs.mkdirSync(path.join(root, '.code-visualizer'));
    fs.writeFileSync(path.join(root, '.code-visualizer', '.gitignore'), 'report.html\n');
    writeHistory(root, [point()]);
    expect(fs.readFileSync(path.join(root, '.code-visualizer', '.gitignore'), 'utf8')).toBe('report.html\n');
  });

  it('accepts a bare array, drops malformed points and survives corrupt files', () => {
    const root = makeTempDir('cv-history-');
    fs.mkdirSync(path.join(root, '.code-visualizer'));
    fs.writeFileSync(historyPath(root), JSON.stringify([point(), { date: 'yesterday', score: 1 }, { date: 1 }, null]));
    expect(readHistory(root)).toEqual([point()]);
    fs.writeFileSync(historyPath(root), '{ not json');
    expect(readHistory(root)).toEqual([]);
    fs.writeFileSync(historyPath(root), 'null');
    expect(readHistory(root)).toEqual([]);
  });
});
