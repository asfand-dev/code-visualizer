/**
 * test-intelligence: real coverage from local lcov / istanbul reports — parsing, path mapping, merging,
 * stale detection, patch coverage, the `patch-coverage` gate, health and the `coverage` command.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { normalizeConfig } from '../src/analyzer/config.js';
import { CoveragePathMapper, fileCoverage, findReports, loadCoverage, parseIstanbul, parseLcov, parseReport, patchCoverage, patchCoverageGate } from '../src/analyzer/coverage.js';
import { evaluateGates, GATE_PROVIDERS } from '../src/analyzer/gates.js';
import { computeHealth } from '../src/analyzer/health.js';
import { updateState } from '../src/analyzer/state.js';
import { runCli } from '../src/cli/run.js';
import { analysisFingerprint } from '../src/server/client.js';
import { createEngine } from '../src/server/engine.js';
import { formatRanges, patchCoverageLine } from '../src/shared/coverage.js';
import { prSummaryMarkdown } from '../src/shared/markdown.js';
import { renderChanges } from '../src/mcp/changes.js';
import type { ChangedFile, LastTestState, ReportData } from '../src/shared/types.js';
import { appendFile, commitAll, daysAgo, editFile, fixtureDir, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

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

const samples = fixtureDir('coverage-samples');
const IDS = ['src/utils/math.ts', 'src/utils/format.ts', 'src/api/client.ts'];

/** An istanbul report with one statement per line and the given hits (line → hits). */
function istanbulReport(file: string, hits: Record<number, number>): string {
  const statementMap: Record<string, unknown> = {};
  const s: Record<string, number> = {};
  Object.entries(hits).forEach(([line, count], i) => {
    statementMap[i] = { start: { line: Number(line), column: 0 }, end: { line: Number(line), column: 10 } };
    s[i] = count;
  });
  return JSON.stringify({ [file]: { path: file, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} } });
}

describe('parsing coverage reports', () => {
  it('reads lcov line hits and function / branch totals, ignoring unknown records', () => {
    const report = parseLcov(fs.readFileSync(path.join(samples, 'lcov.info'), 'utf8'));
    expect(report.source).toBe('lcov');
    const math = report.files.get('/work/app/src/utils/math.ts')!;
    expect([...math.lines]).toEqual([
      [1, 1],
      [3, 1],
      [4, 4],
      [7, 1],
      [8, 0],
      [9, 0],
    ]);
    expect(math.functions).toEqual({ total: 2, covered: 1 });
    expect(math.branches).toEqual({ total: 2, covered: 0 });
    expect(report.files.get('src/utils/format.ts')!.lines.get(8)).toBe(0);
    expect(report.files.size).toBe(4);
  });

  it('maps absolute, relative and Windows report paths onto analyzed files (never node_modules)', () => {
    const mapper = new CoveragePathMapper('/work/app', IDS);
    expect(mapper.toId('/work/app/src/utils/math.ts')).toBe('src/utils/math.ts');
    expect(mapper.toId('src/utils/format.ts')).toBe('src/utils/format.ts');
    expect(mapper.toId('utils/format.ts', 'src')).toBe('src/utils/format.ts'); // relative to the report's package
    expect(mapper.toId('C:\\work\\app\\src\\api\\client.ts')).toBe('src/api/client.ts'); // written on another machine
    expect(mapper.toId('/home/runner/work/app/app/src/utils/math.ts')).toBe('src/utils/math.ts'); // CI checkout
    expect(mapper.toId('/somewhere/else/node_modules/react/index.js')).toBeUndefined();
    expect(mapper.toId('/work/app/src/unknown.ts')).toBeUndefined();
    const windows = new CoveragePathMapper('C:\\Work\\App', IDS);
    expect(windows.toId('c:\\work\\app\\src\\utils\\math.ts')).toBe('src/utils/math.ts');
    expect(windows.toId('file:///C:/Work/App/src/api/client.ts')).toBe('src/api/client.ts');
  });

  it('never lends a file the coverage of a same-named file elsewhere (excluded examples, fixtures)', () => {
    // On disk under the root: examples/demo/src/utils/math.ts (excluded from the analysis) and src/legacy/.
    const onDisk = new Set(['examples', 'examples/demo/src/utils/math.ts', 'src', 'src/legacy/client.ts']);
    const mapper = new CoveragePathMapper('/work/app', IDS, (rel) => onDisk.has(rel));
    expect(mapper.toId('/work/app/examples/demo/src/utils/math.ts')).toBeUndefined(); // inside the root, not analyzed
    expect(mapper.toId('src/legacy/client.ts')).toBeUndefined(); // relative: never by suffix
    expect(mapper.toId('/home/runner/work/app/app/examples/demo/src/utils/math.ts')).toBeUndefined(); // CI path of the excluded file
    expect(mapper.toId('/home/runner/work/app/app/src/utils/math.ts')).toBe('src/utils/math.ts');
    // The analyzed root is a sub-folder of the repository the report's paths are relative to.
    const sub = new CoveragePathMapper('/repo/packages/web', ['src/a.ts'], () => false);
    expect(sub.toId('packages/web/src/a.ts')).toBe('src/a.ts');
    expect(sub.toId('packages/api/src/a.ts')).toBeUndefined();
  });

  it('takes the most hits of the statements starting on a line (istanbul getLineCoverage); zero-hit lines are uncovered', () => {
    const report = parseIstanbul(JSON.parse(fs.readFileSync(path.join(samples, 'coverage-final.json'), 'utf8')));
    const math = report.files.get('/work/app/src/utils/math.ts')!;
    // Line 4 has two statements, hit 0 and 3 times.
    expect(math.lines.get(4)).toBe(3);
    expect(math.lines.get(8)).toBe(0);
    expect(math.functions).toEqual({ total: 2, covered: 1 });
    expect(math.branches).toEqual({ total: 2, covered: 0 });
    // Older istanbul wraps the file coverage in `data`.
    expect([...report.files.get('/work/app/src/utils/format.ts')!.lines]).toEqual([
      [1, 1],
      [8, 2],
    ]);
    const summary = fileCoverage({ ...math, source: 'istanbul', reportMtime: 1000, report: 'coverage/coverage-final.json' }, 2000);
    expect(summary).toEqual({ lines: { total: 4, covered: 2 }, uncovered: [8, 9], source: 'istanbul', functions: { total: 2, covered: 1 }, branches: { total: 2, covered: 0 }, stale: true });
    expect(parseReport('  {}').source).toBe('istanbul');
    expect(parseReport('SF:a.ts\nDA:1,1\nend_of_record\n').files.get('a.ts')!.lines.get(1)).toBe(1);
  });

  it('merges several reports by the most hits per line', () => {
    const root = makeTempDir('cv-cov-merge-');
    writeFile(root, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    writeFile(root, 'reports/unit.info', 'SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\n');
    writeFile(root, 'reports/e2e.info', `SF:${path.join(root, 'src/a.ts')}\nDA:1,0\nDA:2,5\nend_of_record\n`);
    const loaded = loadCoverage(root, { paths: ['reports/unit.info', 'reports/e2e.info'], ids: ['src/a.ts'] })!;
    expect(loaded.reports.map((r) => r.file)).toEqual(['reports/unit.info', 'reports/e2e.info']);
    expect([...loaded.files.get('src/a.ts')!.lines]).toEqual([
      [1, 1],
      [2, 5],
      [3, 0],
    ]);
  });

  it('warns about named reports that do not exist', () => {
    const root = makeTempDir('cv-cov-missing-');
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    expect(loadCoverage(root, { paths: ['reports/nope.info'], ids: ['src/a.ts'] })).toEqual({ reports: [], files: new Map(), scopes: [], warnings: ['No coverage report at reports/nope.info.'] });
    expect(loadCoverage(root, { ids: ['src/a.ts'] })).toBeUndefined();
  });

  it('finds the newest report of the root and of each workspace package', () => {
    const root = makeTempDir('cv-cov-find-');
    writeFile(root, 'coverage/lcov.info', 'SF:src/a.ts\nDA:1,1\nend_of_record\n');
    writeFile(root, 'coverage/coverage-final.json', '{}');
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(root, 'coverage/coverage-final.json'), old, old);
    writeFile(root, 'packages/web/coverage/coverage-final.json', '{}');
    const found = findReports(root, { dirs: ['packages/web', 'packages/api'] });
    expect(found.map((r) => [r.file, r.source, r.base])).toEqual([
      ['coverage/lcov.info', 'lcov', ''],
      ['packages/web/coverage/coverage-final.json', 'istanbul', 'packages/web'],
    ]);
  });
});

describe('patch coverage', () => {
  const coverage = {
    reports: [{ abs: '/r', file: 'coverage/lcov.info', source: 'lcov' as const, mtimeMs: 5000, size: 1, base: '', scope: '', files: 1 }],
    files: new Map([
      [
        'src/a.ts',
        {
          lines: new Map([
            [10, 1],
            [11, 0],
            [12, 0],
            [14, 0],
            [20, 3],
            [21, 0],
          ]),
          source: 'lcov' as const,
          reportMtime: 5000,
          report: 'coverage/lcov.info',
        },
      ],
    ]),
    scopes: [{ base: '', mtimeMs: 5000, report: 'coverage/lcov.info' }],
    warnings: [],
  };
  const changed = (id: string, added: number[], status: ChangedFile['status'] = 'modified'): ChangedFile => ({ id, status, additions: added.length, deletions: 0, lines: added, added, analyzed: true });

  it('counts the added executable lines, merges uncovered ones into ranges and marks files no test loads', () => {
    const patch = patchCoverage([changed('src/a.ts', [10, 11, 12, 13, 14, 20, 21, 30]), changed('src/new.ts', [1, 2, 3, 5]), changed('src/a.test.ts', [1, 2])], coverage, {
      isSource: (id) => !id.includes('.test.'),
      codeLines: (id) => (id === 'src/new.ts' ? new Set([1, 2, 5]) : undefined),
      mtime: (id) => (id === 'src/new.ts' ? 9000 : 4000),
    })!;
    expect(patch.files).toEqual([
      // 13 is an added line that is not executable, so 11–14 is one block; 20 (covered) splits it from 21.
      { file: 'src/a.ts', coverable: 6, covered: 2, uncovered: [[11, 14], [21, 21]] },
      // 4 was not changed: 1-2 and 5 stay apart.
      { file: 'src/new.ts', coverable: 3, covered: 0, uncovered: [[1, 2], [5, 5]], missing: true, stale: true },
    ]);
    expect(patch).toMatchObject({ coverable: 9, covered: 2, pct: 22.2, report: 'coverage/lcov.info', reportDate: 5000, stale: true });
    expect(formatRanges(patch.files[0].uncovered)).toBe('L11-14, L21');
    expect(patchCoverageLine(patch)).toBe('Patch coverage 22.2% (2/9 changed lines)');
  });

  it('is 100% when nothing executable changed, and lists files in packages no report describes as not measured', () => {
    const scoped = { ...coverage, scopes: [{ base: 'packages/web', mtimeMs: 5000, report: 'packages/web/coverage/lcov.info' }] };
    const patch = patchCoverage([changed('packages/api/src/x.ts', [1, 2])], scoped, { isSource: () => true })!;
    expect(patch).toMatchObject({ coverable: 0, covered: 0, pct: 100, files: [], stale: false, unmeasured: ['packages/api/src/x.ts'] });
    // …unless only comments changed there.
    expect(patchCoverage([changed('packages/api/src/x.ts', [1, 2])], scoped, { isSource: () => true, codeLines: () => new Set([5]) })!.unmeasured).toBeUndefined();
  });

  it('counts only added lines: deleting code is not an uncovered change', () => {
    // A deletion-only hunk marks the line after it in `lines`, but adds nothing.
    const deletion: ChangedFile = { id: 'src/a.ts', status: 'modified', additions: 0, deletions: 1, lines: [11], added: [], analyzed: true };
    expect(patchCoverage([deletion], coverage, { isSource: () => true })).toMatchObject({ coverable: 0, files: [], pct: 100 });
    // Without `added` (no diff hunk at all) nothing counts either.
    const { added: _added, ...noHunk } = deletion;
    expect(patchCoverage([noHunk], coverage, { isSource: () => true })!.coverable).toBe(0);
  });

  it('leaves out blank and comment lines a V8 report lists as run, and never spans unchanged lines', () => {
    // V8 (node --test, c8, vitest v8 on JS) writes a hit for every line, blank and comment lines included.
    const v8 = { ...coverage, files: new Map([['src/b.ts', { lines: new Map([[1, 1], [2, 1], [3, 1], [4, 0], [10, 0], [11, 1], [15, 0]]), source: 'lcov' as const, reportMtime: 5000, report: 'coverage/lcov.info' }]]) };
    const patch = patchCoverage([changed('src/b.ts', [2, 3, 4, 10, 15])], v8, { isSource: () => true, codeLines: () => new Set([1, 4, 10, 11, 12, 13, 14, 15]) })!;
    // 2 (blank) and 3 (comment) are not coverable; 10 and 15 are not one block: 11-14 were not changed.
    expect(patch.files).toEqual([{ file: 'src/b.ts', coverable: 3, covered: 0, uncovered: [[4, 4], [10, 10], [15, 15]] }]);
  });
});

describe('patch-coverage gate', () => {
  const data = (coverage?: ReportData['changes'] extends infer C ? (C extends { coverage?: infer P } ? P : never) : never): ReportData =>
    ({ health: { score: 80 }, insights: { ruleViolations: [] }, changes: { files: [{ id: 'src/a.ts' }], coverage } }) as unknown as ReportData;
  const patch = { coverable: 4, covered: 2, pct: 50, files: [{ file: 'src/a.ts', coverable: 4, covered: 2, uncovered: [[12, 13]] as [number, number][] }], report: 'coverage/lcov.info', reportDate: 1, stale: false };

  it('is registered and only runs with a minimum', () => {
    expect(GATE_PROVIDERS).toContain(patchCoverageGate);
    expect(patchCoverageGate(data(patch), { mode: 'all', newOnly: false, thresholds: {}, inScope: () => true })).toBeUndefined();
  });

  it('fails below the minimum with one finding per file, in every mode', () => {
    for (const mode of ['all', 'changed'] as const) {
      const result = evaluateGates(data(patch), { minPatchCoverage: 80 }, { mode, delta: mode === 'changed' ? ({ fingerprints: { new: [], fixed: [] }, health: { before: 80, after: 80 } } as never) : undefined, providers: [patchCoverageGate] });
      const gate = result.gates[0];
      expect(gate).toMatchObject({ id: 'patch-coverage', ok: false, detail: '50% (2/4 changed lines, min 80%)' });
      expect(gate.findings).toEqual([expect.objectContaining({ ruleId: 'cv/patch-coverage', file: 'src/a.ts', line: 12, severity: 'error', status: 'new', message: '2 changed lines not covered by tests: L12-13' })]);
      expect(result.ok).toBe(false);
    }
    expect(evaluateGates(data(patch), { minPatchCoverage: 50 }, { mode: 'all', providers: [patchCoverageGate] }).ok).toBe(true);
  });

  it('names changed files it could not measure', () => {
    const result = evaluateGates(data({ ...patch, unmeasured: ['packages/web/src/a.ts'] }), { minPatchCoverage: 10 }, { mode: 'all', providers: [patchCoverageGate] });
    expect(result.gates[0].detail).toBe('50% (2/4 changed lines, min 10%) · not measured (no coverage report): packages/web/src/a.ts');
  });

  it('fails without a report when the change adds code, unless check.patchCoverage.allowMissingReport', () => {
    // A forgotten coverage step in CI must not pass the gate silently.
    const withCode = {
      ...data(undefined),
      files: [{ id: 'src/a.ts', kind: 'module' }, { id: 'README.md', kind: 'other' }],
      changes: { files: [{ id: 'src/a.ts', status: 'modified', analyzed: true, lines: [3], added: [3] }], commentOnly: [] },
    } as unknown as ReportData;
    const failed = evaluateGates(withCode, { minPatchCoverage: 80 }, { mode: 'all', providers: [patchCoverageGate] });
    expect(failed.ok).toBe(false);
    expect(failed.gates[0]).toMatchObject({ ok: false, findings: [] });
    expect(failed.gates[0].detail).toMatch(/^no coverage report found for 1 changed file \(src\/a\.ts\)/);
    expect(failed.gates[0].detail).toContain('"allowMissingReport": true');
    // Opt out: skipped (passing), and it says so.
    for (const allowMissingReport of [true, 'true']) {
      const allowed = evaluateGates(withCode, { minPatchCoverage: 80, patchCoverage: { allowMissingReport } } as never, { mode: 'all', providers: [patchCoverageGate] });
      expect(allowed.ok).toBe(true);
      expect(allowed.gates[0].detail).toMatch(/skipped: no coverage report/);
    }
    // Nothing a report would measure (only a comment-only edit, a deleted file, docs): nothing to fail on.
    const noCode = {
      ...withCode,
      changes: {
        files: [
          { id: 'src/a.ts', status: 'modified', analyzed: true, lines: [3], added: [3] },
          { id: 'src/gone.ts', status: 'deleted', analyzed: false, lines: [], added: [] },
          { id: 'README.md', status: 'modified', analyzed: false, lines: [1], added: [1] },
        ],
        commentOnly: ['src/a.ts'],
      },
    } as unknown as ReportData;
    const quiet = evaluateGates(noCode, { minPatchCoverage: 80 }, { mode: 'all', providers: [patchCoverageGate] });
    expect(quiet.ok).toBe(true);
    expect(quiet.gates[0].detail).toBe('no coverage report, and no code changed (min 80%)');
  });
});

describe('coverage configuration', () => {
  it('accepts a path, a list, a switch or an object for "coverage", and a string number for check.minPatchCoverage', () => {
    expect(normalizeConfig({ coverage: 'coverage/lcov.info' }).config.coverage).toEqual({ paths: ['coverage/lcov.info'] });
    expect(normalizeConfig({ coverage: ['a/lcov.info', 'b'] }).config.coverage).toEqual({ paths: ['a/lcov.info', 'b'] });
    expect(normalizeConfig({ coverage: false }).config.coverage).toEqual({ enabled: false });
    expect(normalizeConfig({ coverage: { paths: 'x', enabled: 'yes' } }).config.coverage).toEqual({ paths: ['x'], enabled: true });
    expect(normalizeConfig({ coverage: { path: 'x' } }).error).toMatch(/unknown key "path" — did you mean "paths"/);
    expect(normalizeConfig({ coverage: 3 }).error).toMatch(/"coverage" must be/);
    expect(normalizeConfig({ check: { minPatchCoverage: '80' } }).config.check).toEqual({ minPatchCoverage: 80 });
    expect(normalizeConfig({ check: { minPatchCoverage: 'lots' } }).error).toMatch(/minPatchCoverage must be a number/);
  });
});

describe('coverage options', () => {
  it('only changes the server fingerprint when reports are given explicitly', () => {
    const root = '/work/app';
    expect(analysisFingerprint(root, {})).toBe(analysisFingerprint(root, { coverage: undefined }));
    expect(analysisFingerprint(root, { coverage: ['/work/app/coverage/lcov.info'] })).not.toBe(analysisFingerprint(root, {}));
    expect(analysisFingerprint(root, { coverage: ['coverage/lcov.info'] })).toBe(analysisFingerprint(root, { coverage: ['/work/app/coverage/lcov.info'] }));
  });

  it('reads an explicit report (--coverage <path>) and ignores reports when switched off', async () => {
    const root = makeTempDir('cv-cov-explicit-');
    writeFile(root, 'package.json', '{ "name": "x" }');
    writeFile(root, 'src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    writeFile(root, 'reports/unit.info', 'SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n');
    writeFile(root, 'coverage/lcov.info', 'SF:src/a.ts\nDA:1,1\nDA:2,1\nend_of_record\n');
    const auto = await analyze({ root, git: false, includeSource: false });
    expect(auto.coverage).toMatchObject({ reports: [{ file: 'coverage/lcov.info' }], pct: 1 });
    const explicit = await analyze({ root, git: false, includeSource: false, coverage: [path.join(root, 'reports/unit.info')] });
    expect(explicit.coverage).toMatchObject({ reports: [{ file: 'reports/unit.info', source: 'lcov' }], pct: 0.5 });
    expect(explicit.files.find((f) => f.id === 'src/a.ts')!.coverage).toMatchObject({ lines: { total: 2, covered: 1 }, uncovered: [2] });
    expect((await analyze({ root, git: false, includeSource: false, coverage: false })).coverage).toBeUndefined();
    writeFile(root, 'code-visualizer.config.json', JSON.stringify({ coverage: 'reports/unit.info' }));
    expect((await analyze({ root, git: false, includeSource: false })).coverage!.reports[0].file).toBe('reports/unit.info');
    writeFile(root, 'code-visualizer.config.json', JSON.stringify({ coverage: false }));
    expect((await analyze({ root, git: false, includeSource: false })).coverage).toBeUndefined();
    // Snapshots of other refs never read the working tree's report.
    expect((await analyze({ root, git: false, includeSource: false, overlay: { 'src/a.ts': 'export const a = 2;\n' }, config: { config: {} } })).coverage).toBeUndefined();
  });
});

describe('health with coverage', () => {
  const files = ['src/a.ts', 'src/b.ts'].map((id) => ({
    id,
    name: id,
    dir: 'src',
    ext: '.ts',
    language: 'typescript' as const,
    kind: 'util' as const,
    loc: 10,
    sloc: 10,
    bytes: 100,
    complexity: 1,
    maxComplexity: 1,
    symbols: [],
    exports: [],
    assets: [],
    unresolved: [],
    isEntry: false,
    isTest: false,
    todos: [],
    metrics: { fanIn: 1, fanOut: 1, importance: 0.5, instability: 0.5, externalImports: 0 },
  }));
  const insights = { cycles: [], orphans: [], unusedExports: [], unusedDependencies: [], missingDependencies: [], complexFunctions: [], hotspots: [], changeCoupling: [], duplicateSymbols: [], untested: [], deprecated: [], ruleViolations: [], knowledgeSilos: [] };
  const stats = { testReach: 1 } as ReportData['stats'];
  const tests = (lineCoverage?: number) => computeHealth({ files, insights, stats, hasGit: false, testFiles: 1, exportsTotal: 0, lineCoverage }).categories.at(-1)!;

  it('uses real line coverage when present and falls back to import reach otherwise', () => {
    expect(tests()).toMatchObject({ id: 'tests', label: 'Test reach', score: 100, detail: '100% of source files are reached by a test' });
    // 10 + 90 × (0.7 × 0.5 + 0.3 × 1) = 68.5; its own id, so comparisons with an analysis without a report stay neutral.
    expect(tests(0.5)).toMatchObject({ id: 'coverage', label: 'Tests & coverage', score: 69, detail: '50% line coverage, 100% of source files are reached by a test' });
  });
});

describe.skipIf(!hasGit)('coverage end to end (git repository)', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  const MATH = 'src/utils/math.ts';
  /** A repository with 4 new statement lines in math.ts and a report that covers `hits` of them. */
  function setup(): { repo: string; lines: number[]; write: (hits: number[]) => void } {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'initial' });
    const before = fs.readFileSync(path.join(repo, MATH), 'utf8').replace(/\n$/, '').split('\n').length;
    appendFile(repo, MATH, 'export const PATCH_A = 1;\nexport const PATCH_B = 2;\nexport const PATCH_C = 3;\nexport const PATCH_D = 4;\n');
    const lines = [before + 1, before + 2, before + 3, before + 4];
    const abs = fs.realpathSync(path.join(repo, MATH));
    const write = (hits: number[]): void => {
      const report: Record<number, number> = { 3: 1 };
      lines.forEach((l, i) => (report[l] = hits[i]));
      writeFile(repo, 'coverage/coverage-final.json', istanbulReport(abs, report));
    };
    return { repo, lines, write };
  }

  it('check --min-patch-coverage fails at 50% (2/4) with the uncovered range and passes at 100%', async () => {
    const { repo, lines, write } = setup();
    write([1, 1, 0, 0]);
    const failed = await cli('check', repo, '--min-patch-coverage', '80', '--no-cache');
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/✖ Patch coverage 50% \(2\/4 changed lines, min 80%\)/);
    expect(failed.stdout).toContain(`${MATH}:${lines[2]} 2 changed lines not covered by tests: L${lines[2]}-${lines[3]}`);
    const json = JSON.parse((await cli('check', repo, '--min-patch-coverage', '80', '--format', 'json')).stdout) as { gates: { id: string; ok: boolean }[] };
    expect(json.gates.find((g) => g.id === 'patch-coverage')).toMatchObject({ ok: false });
    // Only this gate decides the outcome here.
    expect(json.gates.filter((g) => !g.ok).map((g) => g.id)).toEqual(['patch-coverage']);

    write([1, 1, 1, 1]);
    const passed = await cli('check', repo, '--min-patch-coverage', '80');
    expect(passed.stdout).toMatch(/✔ Patch coverage 100% \(4\/4 changed lines, min 80%\)/);
    expect(passed.code).toBe(0);
    // check.minPatchCoverage in the configuration works the same way, also with --changed.
    write([1, 0, 0, 0]);
    writeFile(repo, 'code-visualizer.config.json', JSON.stringify({ check: { minPatchCoverage: '60' } }));
    const configured = await cli('check', repo, '--changed');
    expect(configured.code).toBe(1);
    expect(configured.stdout).toMatch(/Patch coverage 25% \(1\/4 changed lines, min 60%\)/);
  });

  it('without a coverage report: check --min-patch-coverage fails, coverage --json says why', async () => {
    const { repo } = setup(); // coverage/ was never written
    const check = await cli('check', repo, '--changed', '--min-patch-coverage', '80', '--no-cache', '--no-summary');
    expect(check.code).toBe(1);
    expect(check.stdout).toMatch(/✖ Patch coverage no coverage report found for 1 changed file \(src\/utils\/math\.ts\)/);
    // The opt-out for projects that cannot produce a report in every job.
    writeFile(repo, 'code-visualizer.config.json', JSON.stringify({ check: { patchCoverage: { allowMissingReport: true } } }));
    const allowed = await cli('check', repo, '--changed', '--min-patch-coverage', '80', '--no-cache', '--no-summary');
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toMatch(/✔ Patch coverage skipped: no coverage report/);
    expect(allowed.stderr).not.toContain('Unknown key check.patchCoverage');

    const json = await cli('coverage', repo, '--json', '--no-cache');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, reason: 'no-report' });
    // The explanation for people reading the job log goes to stderr, not into the JSON.
    expect(json.stderr).toContain('No coverage report found');
  });

  it('analysis: file coverage, project line coverage, patch coverage, health, stale reports and the PR line', async () => {
    const { repo, lines, write } = setup();
    write([1, 1, 0, 0]);
    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.coverage).toMatchObject({ reports: [{ file: 'coverage/coverage-final.json', source: 'istanbul', files: 1 }], files: 1, lines: { total: 5, covered: 3 }, pct: 0.6 });
    expect(data.files.find((f) => f.id === MATH)!.coverage).toMatchObject({ lines: { total: 5, covered: 3 }, uncovered: [lines[2], lines[3]], source: 'istanbul' });
    expect(data.stats.lineCoverage).toBe(0.6);
    expect(data.history.at(-1)!.lineCoverage).toBe(0.6);
    expect(data.health.categories.find((c) => c.id === 'coverage')).toMatchObject({ label: 'Tests & coverage' });
    expect(data.changes!.files.find((f) => f.id === MATH)!.added).toEqual(lines);
    expect(data.changes!.coverage).toMatchObject({ coverable: 4, covered: 2, pct: 50, stale: false, files: [{ file: MATH, uncovered: [[lines[2], lines[3]]] }] });
    expect(prSummaryMarkdown(data)).toContain(`- Patch coverage **50%** (2/4 changed lines) — uncovered \`${MATH}\` L${lines[2]}-${lines[3]}`);
    // The base commit has no report: the comparison must not read the report as a health change.
    const compared = await analyze({ root: repo, includeSource: false, history: false, compare: true });
    expect(compared.changes!.delta!.health.categories.map((c) => c.id)).not.toContain('coverage');
    expect(compared.changes!.delta!.health.categories.map((c) => c.id)).not.toContain('tests');

    // A report older than the edit: flagged on the file, the patch and the gate.
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(repo, 'coverage/coverage-final.json'), old, old);
    const stale = await analyze({ root: repo, includeSource: false, history: false });
    expect(stale.files.find((f) => f.id === MATH)!.coverage!.stale).toBe(true);
    expect(stale.coverage!.stale).toBe(true);
    expect(stale.changes!.coverage).toMatchObject({ stale: true, files: [{ file: MATH, stale: true }] });
    const gate = evaluateGates(stale, { minPatchCoverage: 10 }, { mode: 'all', providers: [patchCoverageGate] }).gates[0];
    expect(gate.detail).toContain('the report is older than your changes');

    // Without a report: no coverage anywhere, health falls back to import reach.
    fs.rmSync(path.join(repo, 'coverage'), { recursive: true });
    const none = await analyze({ root: repo, includeSource: false, history: false });
    expect(none.coverage).toBeUndefined();
    expect(none.stats.lineCoverage).toBeUndefined();
    expect(none.changes!.coverage).toBeUndefined();
    expect(none.health.categories.find((c) => c.id === 'tests')).toMatchObject({ label: 'Test reach' });
  });

  it('a report from `test --coverage` of only the affected tests counts for the patch, not for the project', async () => {
    const { repo, write } = setup();
    write([1, 1, 0, 0]);
    const at = Date.now() + 500;
    updateState<LastTestState>(repo, 'lastTest', { at, passed: true, exitCode: 0, mode: 'working', files: ['src/utils/math.test.ts'], full: false, durationMs: 5000, command: 'npx vitest run', coverage: true });
    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.coverage!.partial).toBe(true);
    expect(data.stats.lineCoverage).toBeUndefined();
    expect(data.changes!.coverage!.pct).toBe(50);
  });

  it('coverage command: patch coverage per file, --min, --json, and a hint without a report', async () => {
    const { repo, lines, write } = setup();
    const missing = await cli('coverage', repo);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No coverage report found');
    write([1, 1, 0, 0]);
    const text = await cli('coverage', repo);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/Patch coverage 50% \(2\/4 changed lines\) · report from just now/);
    expect(text.stdout).toMatch(new RegExp(`${MATH.replace(/\./g, '\\.')}\\s+50%\\s+2/4\\s+uncovered L${lines[2]}-${lines[3]}`));
    expect(text.stdout).toMatch(/Project line coverage 60% \(3\/5 lines in 1 file\)/);
    const below = await cli('coverage', repo, '--min', '80');
    expect(below.code).toBe(1);
    expect(below.stdout).toContain('below the minimum of 80%');
    const json = JSON.parse((await cli('coverage', repo, '--json', '--min', '50')).stdout) as { ok: boolean; patch: { pct: number } };
    expect(json).toMatchObject({ ok: true, patch: { pct: 50 } });
    expect((await cli('coverage', repo, '--min', 'x')).code).toBe(2);
    expect((await cli('coverage', repo, '--coverage', path.join(repo, 'nope.info'))).code).toBe(2);
  });

  it('deleting a line is not an uncovered change (the gate passes)', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'initial' });
    // Remove `const factor = …` (line 8): line 8 is now the unchanged `return …`, which no test ran.
    editFile(repo, MATH, '  const factor = 10 ** digits;\n', '');
    writeFile(repo, 'coverage/lcov.info', `SF:${fs.realpathSync(path.join(repo, MATH))}\nDA:4,1\nDA:8,0\nend_of_record\n`);
    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.changes!.files.find((f) => f.id === MATH)).toMatchObject({ added: [], deletions: 1 });
    expect(data.changes!.coverage).toMatchObject({ coverable: 0, files: [] });
    const check = await cli('check', repo, '--changed', '--min-patch-coverage', '80', '--no-cache');
    expect(check.stdout).toContain('Patch coverage no executable lines changed (min 80%)');
    expect(check.stdout).not.toContain('not covered by tests');
  });

  it('explicit --coverage paths must exist (a typo must not skip the gate); configured ones are warned about', async () => {
    const { repo, write } = setup();
    write([0, 0, 0, 0]);
    for (const command of ['check', 'report', 'pr', 'coverage']) {
      const result = await cli(command, repo, '--coverage', 'does/not/exist/lcov.info', '--no-cache', ...(command === 'check' ? ['--min-patch-coverage', '80'] : command === 'report' ? ['--no-open', '-q'] : []));
      expect(result.code, command).toBe(2);
      expect(result.stderr, command).toContain('No coverage report at');
    }
    writeFile(repo, 'code-visualizer.config.json', JSON.stringify({ coverage: 'reports/lcov.info' }));
    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.warnings).toContain('No coverage report at reports/lcov.info.');
    expect(data.coverage).toBeUndefined();
  });

  it('coverage --base must name a commit', async () => {
    const { repo, write } = setup();
    write([1, 1, 1, 1]);
    const typo = await cli('coverage', repo, '--base', 'origin/develp');
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('Unknown git ref "origin/develp"');
    // Like check, diff and review: a near miss gets a suggestion.
    expect((await cli('coverage', repo, '--base', 'mian')).stderr).toContain('Unknown git ref "mian". Did you mean "main"?');
    expect((await cli('test', repo, '--base', 'mian', '--dry-run')).stderr).toContain('Unknown git ref "mian". Did you mean "main"?');
  });

  // --- integration (wave 3) ---
  it('pre-push (`check --changed --committed`) judges the patch coverage of the commits to push', async () => {
    const { repo, write } = setup();
    const { git } = await import('./companion-helpers.js');
    git(repo, ['checkout', '-q', '-b', 'feature']);
    commitAll(repo, { author: 'Bob Builder', date: daysAgo(1), message: 'patch' });
    write([1, 1, 0, 0]);
    // Not committed, so not pushed: an untested new file only counts for the working tree.
    writeFile(repo, 'src/utils/local.ts', 'export const LOCAL_ONLY = 5;\n');
    const working = await cli('check', repo, '--changed', '--min-patch-coverage', '80', '--no-cache');
    expect(working.stdout).toMatch(/Patch coverage 40% \(2\/5 changed lines, min 80%\)/);
    const pushed = await cli('check', repo, '--changed', '--committed', '--min-patch-coverage', '80', '--no-cache');
    expect(pushed.code).toBe(1);
    expect(pushed.stdout).toMatch(/Patch coverage 50% \(2\/4 changed lines, min 80%\)/);
    write([1, 1, 1, 1]);
    const covered = await cli('check', repo, '--changed', '--committed', '--min-patch-coverage', '80', '--no-cache');
    expect(covered.stdout).toMatch(/Patch coverage 100% \(4\/4 changed lines, min 80%\)/);
    expect(covered.code).toBe(0);
  });

  it('MCP review_changes lists the patch coverage and the review path', async () => {
    const { repo, lines, write } = setup();
    write([1, 1, 0, 0]);
    const data = await analyze({ root: repo, includeSource: false, history: false });
    const { text, structured } = renderChanges(data, { limit: 30, format: 'concise', root: repo });
    expect(text).toContain('### Patch coverage 50% (2/4 changed lines)');
    expect(text).toContain(`- ${MATH} L${lines[2]}-${lines[3]}`);
    expect(text).toContain('### Review path');
    expect(text.indexOf('### Tests to run')).toBeLessThan(text.indexOf('### Patch coverage'));
    expect(structured).toMatchObject({ coverage: { pct: 50, covered: 2, coverable: 4, uncovered: [{ file: MATH, lines: [[lines[2], lines[3]]] }] }, readingOrder: [{ file: MATH, order: 1 }] });
  });

  it('coverage --staged reads the reports named in the configuration, like check --staged', async () => {
    const { repo, lines } = setup();
    const abs = fs.realpathSync(path.join(repo, MATH));
    writeFile(repo, 'reports/lcov.info', `SF:${abs}\n${lines.map((l) => `DA:${l},0`).join('\n')}\nend_of_record\n`);
    writeFile(repo, 'code-visualizer.config.json', JSON.stringify({ coverage: { paths: ['reports/lcov.info'] } }));
    const { git } = await import('./companion-helpers.js');
    git(repo, ['add', MATH, 'code-visualizer.config.json']);
    const staged = await cli('coverage', repo, '--staged', '--min', '80');
    expect(staged.code).toBe(1);
    expect(staged.stdout).toMatch(/Patch coverage 0% \(0\/4 changed lines\)/);
    const check = await cli('check', repo, '--staged', '--min-patch-coverage', '80');
    expect(check.code).toBe(1);
    expect(check.stdout).toMatch(/Patch coverage 0% \(0\/4 changed lines, min 80%\)/);
  });

  it('a monorepo report of one package is not the project figure; changes in the other package are not measured', async () => {
    const repo = initRepo('monorepo-ws');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'initial' });
    editFile(repo, 'packages/api/src/users.js', 'return users;', 'return users.slice();');
    editFile(repo, 'packages/web/src/format.ts', '.trim()', '.trim().normalize()');
    writeFile(repo, 'packages/api/coverage/lcov.info', 'SF:src/users.js\nDA:1,1\nDA:3,1\nDA:4,0\nDA:7,1\nend_of_record\n');
    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.coverage).toMatchObject({ reports: [{ file: 'packages/api/coverage/lcov.info' }], unmeasured: ['packages/web'] });
    expect(data.stats.lineCoverage).toBeUndefined();
    expect(data.health.categories.find((c) => c.id === 'tests')).toBeDefined();
    expect(data.changes!.coverage).toMatchObject({ coverable: 1, covered: 0, unmeasured: ['packages/web/src/format.ts'] });
    const text = await cli('coverage', repo);
    expect(text.stdout).toContain('Not measured (no coverage report for their package): packages/web/src/format.ts');
    expect(text.stdout).toMatch(/Line coverage 75% \(3\/4 lines in 1 file\) · no report for packages\/web/);
    expect(prSummaryMarkdown(data)).toContain('- Patch coverage not measured (no coverage report for their package): `packages/web/src/format.ts`');
  });

  it('coverage --staged measures what is staged (index line numbers)', async () => {
    const { repo, lines, write } = setup();
    write([1, 1, 1, 0]);
    expect((await cli('coverage', repo, '--staged')).stdout).toContain('No changes');
    const { git } = await import('./companion-helpers.js');
    git(repo, ['add', MATH]);
    const staged = await cli('coverage', repo, '--staged');
    expect(staged.stdout).toMatch(/Patch coverage 75% \(3\/4 changed lines\)/);
    expect(staged.stdout).toContain(`uncovered L${lines[3]}`);
  });

  it('a running server never answers with the previous report right after a test run', async () => {
    const { repo, write } = setup();
    write([0, 0, 0, 0]);
    // No watching or polling at all: only the check on each request (`current({ verify })`, what CLI clients ask for) can notice.
    const engine = createEngine({ root: repo, options: { includeSource: false, history: false }, watch: false, coveragePollMs: 0 });
    try {
      expect((await engine.current()).changes!.coverage!.pct).toBe(0);
      write([1, 1, 1, 1]);
      expect((await engine.current({ verify: true })).changes!.coverage!.pct).toBe(100);
      // Nothing new: no re-analysis.
      const version = engine.version();
      await engine.current({ verify: true });
      expect(engine.version()).toBe(version);
    } finally {
      engine.close();
    }
  });

  it('serve re-analyzes when a test run writes a new coverage report', async () => {
    const { repo, write } = setup();
    const engine = createEngine({ root: repo, options: { includeSource: false, history: false }, coveragePollMs: 50, debounceMs: 20 });
    try {
      const first = await engine.current();
      expect(first.coverage).toBeUndefined();
      const updated = new Promise<ReportData>((resolve) => engine.onUpdate((u) => u.data.coverage && resolve(u.data)));
      write([1, 1, 1, 1]);
      const next = await updated;
      expect(next.changes!.coverage).toMatchObject({ pct: 100, coverable: 4 });
    } finally {
      engine.close();
    }
  });
});
