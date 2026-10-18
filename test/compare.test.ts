import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, createAnalyzeCache, type AnalyzeCache } from '../src/analyzer/index.js';
import { toSnapshot } from '../src/analyzer/snapshot.js';
import { compareReports, routeKey } from '../src/analyzer/compare.js';
import { AnalyzeError } from '../src/analyzer/errors.js';
import { breakingExports, closest, cycleLabel, deltaFailures, deltaHighlights, exportChangeLabel, isEmptyDelta, parseFailOn, shortNames } from '../src/shared/delta.js';
import { complexityFingerprint, cycleFingerprint, cycleKey, cycleSetKey, devDependencyInProductionFingerprint, fingerprint, violationKey } from '../src/shared/fingerprint.js';
import { architectureDeltaMarkdown, prSummaryMarkdown } from '../src/shared/markdown.js';
import { compactPair, compactSignature, paramRange, signature } from '../src/shared/signature.js';
import type { ArchitectureDelta, ReportData, ReportSnapshot } from '../src/shared/types.js';
import { copyFixture, removeTempDirs } from './companion-helpers.js';

afterAll(removeTempDirs);

type Overlay = Record<string, string | null>;

/** Analyze a fixture copy, optionally with an overlay (no git: overlays work on plain folders too). */
function analyzer(fixture: string): { root: string; run(overlay?: Overlay): Promise<ReportData>; read(file: string): string } {
  const root = copyFixture(fixture, 'cv-compare-');
  const cache: AnalyzeCache = createAnalyzeCache();
  return {
    root,
    run: (overlay) => analyze({ root, overlay, git: false, includeSource: false, history: false, cache }),
    read: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
  };
}

const lineOf = (text: string, needle: string): number => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('fingerprints', () => {
  it('rotated cycles are equal, reversed ones are not', () => {
    expect(cycleKey(['b.ts', 'c.ts', 'a.ts'])).toBe('a.ts → b.ts → c.ts');
    expect(cycleKey(['c.ts', 'a.ts', 'b.ts'])).toBe(cycleKey(['a.ts', 'b.ts', 'c.ts']));
    expect(cycleKey(['a.ts', 'c.ts', 'b.ts'])).not.toBe(cycleKey(['a.ts', 'b.ts', 'c.ts']));
    // A reported cycle is a strongly connected component: its identity is the member set.
    expect(cycleSetKey(['a.ts', 'c.ts', 'b.ts'])).toBe(cycleSetKey(['b.ts', 'a.ts', 'c.ts']));
    expect(cycleFingerprint(['b.ts', 'a.ts'])).toBe(cycleFingerprint(['a.ts', 'b.ts']));
  });

  it('is a stable 64-bit FNV-1a hex without line numbers', () => {
    const fp = fingerprint('cv/cycle', 'src/a.ts', 'a → b');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint('cv/cycle', 'src/a.ts', 'a → b')).toBe(fp);
    expect(fingerprint('cv/cycle', 'src/a.ts', 'a → c')).not.toBe(fp);
    expect(fingerprint('cv/cycle', 'src/b.ts', 'a → b')).not.toBe(fp);
    expect(violationKey({ rule: 'no-db', source: 'ui/a.ts', target: 'db/b.ts' })).toBe('no-db|ui/a.ts|db/b.ts');
  });
});

describe('signatures', () => {
  it('counts required and allowed arguments', () => {
    expect(paramRange([{ name: 'a' }, { name: 'b', optional: true }])).toEqual({ required: 1, max: 2 });
    expect(paramRange([{ name: 'a', optional: true, defaultValue: '1' }, { name: 'b' }])).toEqual({ required: 2, max: 2 });
    expect(paramRange([{ name: 'a' }, { name: 'rest', rest: true }])).toEqual({ required: 1, max: Infinity });
    expect(paramRange(undefined)).toEqual({ required: 0, max: 0 });
  });

  it('compacts declarations to parameter names', () => {
    expect(compactSignature('formatDate(iso: string, locale: string): string')).toBe('formatDate(iso, locale)');
    expect(compactSignature('async load(map: Map<string, number>, cb: (x: number) => void, opts?: { a: string }): Promise<void>')).toBe('load(map, cb, opts?)');
    expect(compactSignature('Button({ label, onClick }: ButtonProps)')).toBe('Button({ label, onClick })');
  });

  it('marks parameters with a default value as optional', () => {
    const sym = { id: 'a.ts#formatCurrency', name: 'formatCurrency', kind: 'function', line: 1, exported: true } as const;
    const params = [{ name: 'amount', type: 'number' }, { name: 'currency', optional: true, defaultValue: "'USD'" }, { name: 'digits', defaultValue: '2' }];
    expect(signature({ ...sym, params, returnType: 'string' } as never)).toBe('formatCurrency(amount: number, currency?, digits?): string');
  });

  it('shows the changed part when two compact forms would read the same', () => {
    const before = "type AnalyzeStage = 'project' | 'discover' | 'parse' | 'link' | 'git' | 'changes' | 'insights' | 'done'";
    const after = "type AnalyzeStage = 'project' | 'discover' | 'parse' | 'link' | 'git' | 'changes' | 'compare' | 'insights' | 'done'";
    expect(compactSignature(before)).toBe(compactSignature(after)); // both cut off at 60 characters
    const [a, b] = compactPair(before, after);
    expect(a).not.toBe(b);
    expect(a.startsWith('type AnalyzeStage = …')).toBe(true);
    expect(b).toContain("'compare' | 'insights'");
    expect(a).not.toContain("'compare'");
    expect(compactPair('load(a: string): void', 'load(a: number): void')).toEqual(['load(a: string): void', 'load(a: number): void']);
    expect(compactPair('f(a: string)', 'f(a, b)')).toEqual(['f(a)', 'f(a, b)']);
  });
});

describe('compareReports on overlays (react-vite-ts)', () => {
  const project = analyzer('react-vite-ts');
  let base: ReportData;
  let withCycle: ReportData;
  let cycleText: string;

  beforeAll(async () => {
    base = await project.run();
    cycleText = `${project.read('src/api/client.ts')}\nimport { useUsers } from '@/hooks/useUsers';\nexport const usersHook = useUsers;\n`;
    withCycle = await project.run({ 'src/api/client.ts': cycleText });
  });

  it('an import that closes a cycle gives exactly one new cycle; removing it fixes it', () => {
    const delta = compareReports(base, withCycle);
    expect(delta.newCycles).toEqual([['src/api/client.ts', 'src/hooks/useUsers.ts']]);
    expect(delta.fixedCycles).toEqual([]);
    // The old format.ts ↔ math.ts cycle is not new.
    expect(withCycle.insights.cycles).toHaveLength(2);
    expect(delta.fingerprints.new).toContain(cycleFingerprint(['src/api/client.ts', 'src/hooks/useUsers.ts']));
    expect(delta.newEdges).toEqual([{ source: 'src/api/client.ts', target: 'src/hooks/useUsers.ts', names: ['useUsers'], line: lineOf(cycleText, "from '@/hooks/useUsers'") }]);

    const back = compareReports(withCycle, base);
    expect(back.newCycles).toEqual([]);
    expect(back.fixedCycles).toEqual([['src/api/client.ts', 'src/hooks/useUsers.ts']]);
    expect(back.fingerprints.fixed).toContain(cycleFingerprint(['src/hooks/useUsers.ts', 'src/api/client.ts']));
    expect(back.removedEdges).toEqual([{ source: 'src/api/client.ts', target: 'src/hooks/useUsers.ts' }]);
  });

  it('flags a new dependency between areas', () => {
    const delta = compareReports(base, withCycle);
    // `via` names the file-level import behind the new area dependency.
    expect(delta.areaEdges).toContainEqual({ from: 'src/api', to: 'src/hooks', before: 0, after: 1, isNew: true, via: [{ source: 'src/api/client.ts', target: 'src/hooks/useUsers.ts', line: lineOf(cycleText, "from '@/hooks/useUsers'") }] });
    expect(delta.areaEdges.filter((a) => a.isNew)).toHaveLength(1);
    expect(deltaHighlights(delta)).toEqual(expect.arrayContaining(['1 new cycle', '+1 import src/api→src/hooks']));
  });

  it('compares cycles by member set, so a rotated sample path is not new', () => {
    const rotated: ReportSnapshot = { ...toSnapshot(withCycle), insights: { ...withCycle.insights, cycles: withCycle.insights.cycles.map((c) => [...c.slice(1), c[0]]) } };
    const delta = compareReports(rotated, withCycle);
    expect(delta.newCycles).toEqual([]);
    expect(delta.fixedCycles).toEqual([]);
  });

  it('an identical analysis is an empty delta', () => {
    const delta = compareReports(base, base);
    expect(isEmptyDelta(delta)).toBe(true);
    expect(delta.fingerprints).toEqual({ new: [], fixed: [], worsened: [] });
    expect(delta.health.before).toBe(delta.health.after);
    expect(architectureDeltaMarkdown(delta)).toContain('No architectural changes');
  });

  it('an added required parameter is a breaking signature change with its importers', async () => {
    const format = project.read('src/utils/format.ts');
    const head = await project.run({ 'src/utils/format.ts': format.replace('export function formatDate(iso: string)', 'export function formatDate(iso: string, locale: string)') });
    const delta = compareReports(base, head);
    const change = delta.exports.find((e) => e.name === 'formatDate')!;
    expect(change).toMatchObject({
      file: 'src/utils/format.ts',
      change: 'signature',
      before: 'formatDate(iso: string): string',
      after: 'formatDate(iso: string, locale: string): string',
      breaking: true,
      importers: ['src/components/UserCard.tsx'],
      line: lineOf(format, 'export function formatDate'),
    });
    // Call-site data (query-core): the stale call is reported at its exact line, from a real analysis.
    const line = lineOf(project.read('src/components/UserCard.tsx'), 'formatDate(joinedAt)');
    const callEdge = head.symbolEdges.find((e) => e.target === 'src/utils/format.ts#formatDate' && e.kind === 'calls')!;
    expect(callEdge).toMatchObject({ source: 'src/components/UserCard.tsx#UserCard', lines: [line], argc: [1] });
    expect(change.staleCallSites).toEqual([{ file: 'src/components/UserCard.tsx', line, argc: 1, kind: 'call', symbol: 'src/components/UserCard.tsx#UserCard' }]);
    expect(breakingExports(delta).map((e) => e.name)).toEqual(['formatDate']);
    expect(deltaHighlights(delta)).toContain(`formatDate(iso) → formatDate(iso, locale): 1 call not updated (UserCard.tsx:${line})`);
    // The PR section names the exact calls to update.
    expect(architectureDeltaMarkdown(delta)).toContain(`in \`src/utils/format.ts\` — 1 call not updated: \`src/components/UserCard.tsx:${line}\``);
  });

  it('reports stale call sites from call-site data', async () => {
    const format = project.read('src/utils/format.ts');
    const head = await project.run({ 'src/utils/format.ts': format.replace('export function formatDate(iso: string)', 'export function formatDate(iso: string, locale: string)') });
    // Inject query-core style call sites: two calls with 1 argument, one already updated, one spread.
    const withSites: ReportSnapshot = {
      ...toSnapshot(head),
      symbolEdges: head.symbolEdges.map((e) => (e.target === 'src/utils/format.ts#formatDate' ? { ...e, lines: [16, 30, 31, 32], argc: [1, 2, -1, 3] } : e)),
    };
    const change = compareReports(base, withSites).exports.find((e) => e.name === 'formatDate')!;
    expect(change.staleCallSites).toEqual([
      { file: 'src/components/UserCard.tsx', line: 16, argc: 1, kind: 'call', symbol: 'src/components/UserCard.tsx#UserCard' },
      { file: 'src/components/UserCard.tsx', line: 32, argc: 3, kind: 'call', symbol: 'src/components/UserCard.tsx#UserCard' },
    ]);
  });

  it('optional parameters are compatible; removed and re-kinded exports are breaking', async () => {
    const format = project.read('src/utils/format.ts');
    const head = await project.run({
      'src/utils/format.ts': format
        .replace('export function formatDate(iso: string)', 'export function formatDate(iso: string, locale?: string)')
        .replace('export function formatNumber(', 'function formatNumber(')
        .concat('\nexport { formatNumber as formatNumberLegacy };\n'),
      'src/types.ts': `${project.read('src/types.ts')}\nexport const NEW_FLAG = true;\n`,
    });
    const delta = compareReports(base, head);
    expect(delta.exports.find((e) => e.name === 'formatDate')).toMatchObject({ change: 'signature', breaking: false });
    // formatNumber is still imported by math.ts: removing it breaks that file.
    expect(delta.exports.find((e) => e.name === 'formatNumber')).toMatchObject({ change: 'removed', breaking: true, importers: ['src/utils/math.ts'] });
    expect(delta.exports.find((e) => e.name === 'NEW_FLAG')).toMatchObject({ file: 'src/types.ts', change: 'added', breaking: false });
    expect(breakingExports(delta).map((e) => e.name)).toEqual(['formatNumber']);
  });

  it('reports missing packages, complexity and new unused exports with fingerprints', async () => {
    const branches = Array.from({ length: 12 }, (_, i) => `  if (value === ${i}) return '${i}';`).join('\n');
    const head = await project.run({
      'src/utils/math.ts': `${project.read('src/utils/math.ts')}\nimport chunk from 'lodash/chunk';\nexport function classify(value: number): string {\n${branches}\n  return String(chunk([value], 1));\n}\n`,
    });
    const delta = compareReports(base, head);
    expect(delta.newMissingDependencies).toEqual(['lodash']);
    expect(delta.addedPackages).toEqual(['lodash']);
    expect(delta.complexity).toEqual([{ symbol: 'src/utils/math.ts#classify', file: 'src/utils/math.ts', name: 'classify', line: expect.any(Number), before: 0, after: 13 }]);
    expect(delta.newUnusedExports).toEqual([{ file: 'src/utils/math.ts', name: 'classify', line: expect.any(Number) }]);
    expect(delta.fingerprints.new).toHaveLength(3); // missing dependency, complexity, unused export
    expect(deltaFailures(delta, parseFailOn(['new-missing-deps']))).toEqual([{ rule: 'new-missing-deps', message: '1 package imported but not declared: lodash' }]);
    // Declaring the dependency in the overlaid package.json fixes it.
    const pkg = JSON.parse(project.read('package.json')) as { dependencies: Record<string, string> };
    pkg.dependencies.lodash = '^4.17.21';
    const declared = await project.run({ 'src/utils/math.ts': `${project.read('src/utils/math.ts')}\nimport chunk from 'lodash/chunk';\nexport const c = chunk;\n`, 'package.json': JSON.stringify(pkg) });
    expect(declared.insights.missingDependencies).toEqual([]);
    expect(compareReports(base, declared).newMissingDependencies).toEqual([]);
  });

  it('overlays can delete files and add files that exist only in the overlay', async () => {
    const head = await project.run({ 'src/utils/legacyStorage.ts': null, 'src/utils/strings.ts': "import { round } from './math';\nexport const two = round(2.01);\n" });
    expect(head.files.some((f) => f.id === 'src/utils/legacyStorage.ts')).toBe(false);
    expect(head.files.find((f) => f.id === 'src/utils/strings.ts')).toMatchObject({ bytes: Buffer.byteLength("import { round } from './math';\nexport const two = round(2.01);\n") });
    expect(head.edges).toContainEqual(expect.objectContaining({ source: 'src/utils/strings.ts', target: 'src/utils/math.ts' }));
    // The working tree is untouched and the next normal run is unchanged.
    expect(fs.existsSync(path.join(project.root, 'src/utils/strings.ts'))).toBe(false);
    expect((await project.run()).files.map((f) => f.id)).toEqual(base.files.map((f) => f.id));
  });
});

describe('cycles that split, shrink or merge', () => {
  const project = analyzer('react-vite-ts');
  const file = (imports: string[], name: string): string => `${imports.map((m) => `import { ${m} } from './${m}';`).join('\n')}\nexport const ${name} = [${imports.join(', ')}];\n`;
  /** Files a–d under src/cyc where each imports the ones listed. */
  const cyc = (graph: Record<string, string[]>): Overlay => Object.fromEntries(Object.entries(graph).map(([name, imports]) => [`src/cyc/${name}.ts`, file(imports, name)]));
  const ids = (...names: string[]): string[] => names.map((n) => `src/cyc/${n}.ts`);
  const setsOf = (cycles: string[][]): string[][] => cycles.map((c) => [...c].sort()).sort();

  it('splitting one cycle into two by removing an import is neither new nor fixed', async () => {
    // a ↔ b, c ↔ d, b → c, d → a: one cycle of four files.
    const base = await project.run(cyc({ a: ['b'], b: ['a', 'c'], c: ['d'], d: ['c', 'a'] }));
    expect(setsOf(base.insights.cycles)).toContainEqual(ids('a', 'b', 'c', 'd'));
    const head = await project.run(cyc({ a: ['b'], b: ['a', 'c'], c: ['d'], d: ['c'] }));
    expect(setsOf(head.insights.cycles)).toEqual(expect.arrayContaining([ids('a', 'b'), ids('c', 'd')]));
    const delta = compareReports(base, head);
    expect(delta.newCycles).toEqual([]);
    expect(delta.fixedCycles).toEqual([]);
    expect(delta.newEdges).toEqual([]);
    expect(delta.fingerprints.new).toEqual([]);
    expect(deltaFailures(delta, parseFailOn(['new-cycles']))).toEqual([]);
    expect(deltaHighlights(delta).join(' · ')).not.toMatch(/cycle/);
  });

  it('a cycle that shrank is old debt; one that grew or merged two old ones is new, and neither old one is fixed', async () => {
    const three = await project.run(cyc({ a: ['b'], b: ['c', 'a'], c: ['a'] }));
    const two = await project.run(cyc({ a: ['b'], b: ['a'], c: [] }));
    expect(compareReports(three, two)).toMatchObject({ newCycles: [], fixedCycles: [] });
    // The reverse: c joins the cycle of a and b.
    expect(setsOf(compareReports(two, three).newCycles)).toEqual([ids('a', 'b', 'c')]);
    expect(compareReports(two, three).fixedCycles).toEqual([]);

    const apart = await project.run(cyc({ a: ['b'], b: ['a'], c: ['d'], d: ['c'] }));
    const merged = await project.run(cyc({ a: ['b'], b: ['a', 'c'], c: ['d'], d: ['c', 'a'] }));
    const delta = compareReports(apart, merged);
    expect(setsOf(delta.newCycles)).toEqual([ids('a', 'b', 'c', 'd')]);
    expect(delta.fixedCycles).toEqual([]);
    expect(deltaHighlights(delta)).not.toContain('2 cycles fixed');
    // Removing every import of a cycle fixes it.
    const none = await project.run(cyc({ a: [], b: [], c: [], d: [] }));
    expect(setsOf(compareReports(apart, none).fixedCycles)).toEqual([ids('a', 'b'), ids('c', 'd')]);
  });
});

describe('renamed and moved files keep their findings', () => {
  const project = analyzer('react-vite-ts');
  let base: ReportData;
  beforeAll(async () => {
    base = await project.run();
  });
  const moveMath = (mathText: string): Overlay => ({
    'src/utils/math.ts': null,
    'src/utils/mathx.ts': mathText,
    'src/utils/format.ts': project.read('src/utils/format.ts').replace("from './math'", "from './mathx'"),
    'src/pages/Home.tsx': project.read('src/pages/Home.tsx').replace("from '@/utils/math'", "from '@/utils/mathx'"),
  });

  it('a pure rename is detected without git: no new cycle, unused export, complexity or edges', async () => {
    const head = await project.run(moveMath(project.read('src/utils/math.ts')));
    const delta = compareReports(base, head);
    expect(delta.renamed).toEqual([{ from: 'src/utils/math.ts', to: 'src/utils/mathx.ts' }]);
    expect(delta.newCycles).toEqual([]);
    expect(delta.fixedCycles).toEqual([]);
    expect(delta.newUnusedExports).toEqual([]);
    expect(delta.newEdges).toEqual([]);
    expect(delta.removedEdges).toEqual([]);
    expect(delta.exports).toEqual([]);
    expect(delta.fingerprints).toEqual({ new: [], fixed: [], worsened: [] });
    expect(deltaFailures(delta, parseFailOn(['new-cycles', 'breaking-exports']))).toEqual([]);
  });

  it('a rename with edits needs the rename list from git (the renames option)', async () => {
    const edited = `${project.read('src/utils/math.ts')}\n// moved\n`;
    const head = await project.run(moveMath(edited));
    // Without rename information the cycle looks new — what git -M tells us fixes it.
    expect(compareReports(base, head).newCycles).toHaveLength(1);
    const delta = compareReports(base, head, { renames: { 'src/utils/math.ts': 'src/utils/mathx.ts' } });
    expect(delta.newCycles).toEqual([]);
    expect(delta.fixedCycles).toEqual([]);
    expect(delta.newUnusedExports).toEqual([]);
    expect(delta.fingerprints.new).toEqual([]);
    // Renames that do not fit both sides are ignored.
    expect(compareReports(base, head, { renames: new Map([['src/nope.ts', 'src/utils/mathx.ts']]) }).newCycles).toHaveLength(1);
  });

  it('a function moved to another module keeps its complexity finding', async () => {
    const branches = Array.from({ length: 12 }, (_, i) => `  if (value === ${i}) return '${i}';`).join('\n');
    const fn = `export function classify(value: number): string {\n${branches}\n  return '';\n}\n`;
    const before = await project.run({ 'src/utils/math.ts': `${project.read('src/utils/math.ts')}\n${fn}` });
    const after = await project.run({ 'src/utils/classify.ts': fn });
    const delta = compareReports(before, after);
    expect(delta.complexity).toEqual([]);
    expect(delta.newUnusedExports).toEqual([]);
    expect(delta.fingerprints.new).toEqual([]);
    // Growing on the way is reported as an increase, not as a new function.
    const grown = await project.run({ 'src/utils/classify.ts': fn.replace("  return '';", "  if (value < 0) return '-';\n  return '';") });
    expect(compareReports(before, grown).complexity).toEqual([expect.objectContaining({ symbol: 'src/utils/classify.ts#classify', before: 13, after: 14 })]);
  });

  it('an area that was renamed as a whole does not add new dependencies between areas; one moved file does', async () => {
    const renamed = await project.run({
      'src/hooks/useUsers.ts': null,
      'src/hooks/useDebounce.ts': null,
      'src/queries/useUsers.ts': project.read('src/hooks/useUsers.ts'),
      'src/queries/useDebounce.ts': project.read('src/hooks/useDebounce.ts'),
      'src/pages/Home.tsx': project.read('src/pages/Home.tsx').replace('@/hooks/useUsers', '@/queries/useUsers'),
      'src/pages/admin/Reports.tsx': project.read('src/pages/admin/Reports.tsx').replace('@/hooks/useUsers', '@/queries/useUsers'),
      'src/pages/Settings.tsx': project.read('src/pages/Settings.tsx').replace('@/hooks/useDebounce', '@/queries/useDebounce'),
    });
    const delta = compareReports(base, renamed);
    expect(delta.renamed).toHaveLength(2);
    expect(delta.areaEdges).toEqual([]);

    // useUsers stays in src/hooks: moving useDebounce out is a real new dependency of src/pages.
    const moved = await project.run({
      'src/hooks/useDebounce.ts': null,
      'src/lib/useDebounce.ts': project.read('src/hooks/useDebounce.ts'),
      'src/pages/Settings.tsx': project.read('src/pages/Settings.tsx').replace('@/hooks/useDebounce', '@/lib/useDebounce'),
    });
    const fromMove = compareReports(base, moved);
    expect(fromMove.renamed).toEqual([{ from: 'src/hooks/useDebounce.ts', to: 'src/lib/useDebounce.ts' }]);
    expect(fromMove.newEdges).toEqual([]);
    expect(fromMove.areaEdges).toContainEqual(expect.objectContaining({ from: 'src/pages', to: 'src/lib', before: 0, after: 1, isNew: true, via: [expect.objectContaining({ source: 'src/pages/Settings.tsx', target: 'src/lib/useDebounce.ts' })] }));
  });
});

describe('API changes that do not break users', () => {
  it('a component that gains or loses props is not a breaking change', async () => {
    const project = analyzer('react-vite-ts');
    const base = await project.run();
    const app = project.read('src/App.tsx');
    const head = await project.run({ 'src/App.tsx': app.replace('export default function App()', 'export default function App({ compact = false }: { compact?: boolean })') });
    const change = compareReports(base, head).exports.find((e) => e.file === 'src/App.tsx' && e.name === 'default');
    expect(change).toMatchObject({ change: 'signature', breaking: false, importers: ['src/router.tsx'] });
    expect(deltaFailures(compareReports(base, head), parseFailOn(['breaking-exports']))).toEqual([]);
    expect(deltaFailures(compareReports(head, base), parseFailOn(['breaking-exports']))).toEqual([]);
    // Removing a used default export is breaking and named after the file.
    const gone = await project.run({ 'src/App.tsx': app.replace('export default function App()', 'export function App()') });
    expect(deltaFailures(compareReports(base, gone), parseFailOn(['breaking-exports']))[0]?.message).toBe('1 breaking export change: default export of App.tsx');
  });

  it('exports of framework entry files are not public API; package.json entries are', async () => {
    const project = analyzer('next-app');
    const base = await project.run();
    const layout = project.read('app/layout.tsx');
    expect(base.files.find((f) => f.id === 'app/layout.tsx')?.isEntry).toBe(true);
    const head = await project.run({ 'app/layout.tsx': layout.replace('export const metadata: Metadata =', 'const metadata: Metadata =') });
    const delta = compareReports(base, head);
    expect(delta.exports.find((e) => e.name === 'metadata')).toMatchObject({ change: 'removed', breaking: true, importers: [] });
    expect(delta.exports.find((e) => e.name === 'metadata')?.entry).toBeUndefined();
    expect(breakingExports(delta)).toEqual([]);

    const lib = analyzer('react-vite-ts');
    const pkg = JSON.parse(lib.read('package.json')) as Record<string, unknown>;
    const published = { 'package.json': JSON.stringify({ ...pkg, main: 'src/utils/format.ts' }) };
    const libBase = await lib.run(published);
    expect(libBase.files.find((f) => f.id === 'src/utils/format.ts')?.entryReason).toBe('package.json "main"');
    const libHead = await lib.run({ ...published, 'src/utils/format.ts': lib.read('src/utils/format.ts').replace('export function slugify', 'function slugify') });
    expect(breakingExports(compareReports(libBase, libHead)).map((e) => [e.name, e.entry])).toEqual([['slugify', true]]);
  });
});

describe('complexity fingerprints', () => {
  const project = analyzer('react-vite-ts');
  const classify = (branches: number): Overlay => ({
    'src/utils/math.ts': `${project.read('src/utils/math.ts')}\nexport function classify(value: number): string {\n${Array.from({ length: branches }, (_, i) => `  if (value === ${i}) return '${i}';`).join('\n')}\n  return '';\n}\n`,
  });
  const fp = complexityFingerprint('src/utils/math.ts', 'src/utils/math.ts#classify');

  it('only findings that cross the threshold are new; old ones that grew are "worsened"', async () => {
    const [eight, eleven, fifteen, sixteen] = await Promise.all([classify(7), classify(10), classify(14), classify(15)].map((o) => project.run(o)));
    const cx = (r: ReportData): number | undefined => r.files.find((f) => f.id === 'src/utils/math.ts')?.symbols.find((s) => s.name === 'classify')?.complexity;
    expect([cx(eight), cx(eleven), cx(fifteen), cx(sixteen)]).toEqual([8, 11, 15, 16]);

    const crossed = compareReports(eight, eleven);
    expect(crossed.fingerprints.new).toEqual([fp]);
    const grew = compareReports(fifteen, sixteen);
    expect(grew.complexity).toEqual([expect.objectContaining({ name: 'classify', before: 15, after: 16 })]);
    expect(grew.fingerprints.new).toEqual([]);
    expect(grew.fingerprints.worsened).toEqual([fp]);
    const shrank = compareReports(sixteen, fifteen);
    expect(shrank.fingerprints).toEqual({ new: [], fixed: [], worsened: [] });
    expect(compareReports(eleven, eight).fingerprints.fixed).toEqual([fp]);
  });
});

describe('accuracy-pass findings in the delta', () => {
  it('measures a function by its worst part: an inline callback that crosses the threshold is a new finding', async () => {
    const project = analyzer('react-vite-ts');
    const register = (branches: number): Overlay => ({
      'src/utils/routes.ts': `export function registerRoutes(app: { post(path: string, cb: (value: number) => string): void }): void {\n  app.post('/x', (value) => {\n${Array.from({ length: branches }, (_, i) => `    if (value === ${i}) return '${i}';`).join('\n')}\n    return '';\n  });\n}\n`,
    });
    const [small, big] = await Promise.all([project.run(register(3)), project.run(register(12))]);
    const delta = compareReports(small, big);
    expect(delta.complexity).toEqual([expect.objectContaining({ symbol: 'src/utils/routes.ts#registerRoutes', name: 'registerRoutes › app.post callback', before: 4, after: 13, line: 2 })]);
    expect(delta.fingerprints.new).toEqual([complexityFingerprint('src/utils/routes.ts', 'src/utils/routes.ts#registerRoutes')]);
    expect(compareReports(big, small).fingerprints.fixed).toEqual(delta.fingerprints.new);
    expect(deltaHighlights(delta)).toContain('registerRoutes › app.post callback complexity 4 → 13');
  });

  it('reports devDependencies that production code starts to import, with fingerprints', async () => {
    const project = analyzer('express-api');
    const base = await project.run();
    expect(base.insights.devDependenciesInProduction ?? []).toEqual([]);
    const head = await project.run({ 'services/UserService.js': `const request = require('supertest');\n${project.read('services/UserService.js')}` });
    const delta = compareReports(base, head);
    expect(delta.newDevDependenciesInProduction).toEqual([{ name: 'supertest', files: ['services/UserService.js'] }]);
    expect(delta.fingerprints.new).toContain(devDependencyInProductionFingerprint('supertest'));
    expect(isEmptyDelta(delta)).toBe(false);
    expect(deltaHighlights(delta)).toContain('devDependency "supertest" used in production');
    expect(architectureDeltaMarkdown(delta)).toContain('devDependencies used in production code: `supertest`');
    expect(compareReports(head, base).fingerprints.fixed).toContain(devDependencyInProductionFingerprint('supertest'));
  });
});

describe('a base without source files', () => {
  it('is an empty project: everything is new and health is neutral', async () => {
    const project = analyzer('react-vite-ts');
    const head = await project.run();
    const deleteAll: Overlay = Object.fromEntries(head.files.map((f) => [f.id, null]));
    const empty = await project.run({ ...deleteAll, 'package.json': null });
    expect(empty.files).toEqual([]);
    const delta = compareReports(empty, head);
    expect(delta.newCycles).toEqual(head.insights.cycles);
    expect(delta.newEdges).toHaveLength(head.edges.length);
    expect(delta.health).toEqual({ before: head.health.score, after: head.health.score, categories: [] });
    expect(deltaFailures(delta, parseFailOn(['health-drop:0']))).toEqual([]);
  });
});

describe('overlay keys', () => {
  it('accepts ./, absolute and Windows-style paths and rejects paths outside the root', async () => {
    const project = analyzer('react-vite-ts');
    const text = "export const added = 1;\n";
    for (const key of ['./src/added.ts', path.join(project.root, 'src/added.ts'), 'src\\added.ts', 'src/./x/../added.ts']) {
      const data = await project.run({ [key]: text });
      expect(data.files.filter((f) => f.id.endsWith('added.ts')).map((f) => f.id)).toEqual(['src/added.ts']);
    }
    // A Windows-style key replaces the file instead of adding a second one.
    const replaced = await project.run({ 'src\\utils\\math.ts': 'export const only = 1;\n' });
    expect(replaced.files.filter((f) => f.id.includes('math')).map((f) => [f.id, f.symbols.map((s) => s.name)])).toEqual([['src/utils/math.ts', ['only']]]);
    for (const key of ['../outside.ts', path.join(path.dirname(project.root), 'outside.ts'), '/elsewhere/x.ts']) {
      await expect(project.run({ [key]: text })).rejects.toThrow(AnalyzeError);
    }
  });
});

describe('compareReports on overlays (fullstack-next)', () => {
  const project = analyzer('fullstack-next');
  let base: ReportData;
  beforeAll(async () => {
    base = await project.run();
  });

  it('a removed route that is still called lists its callers', async () => {
    const head = await project.run({ 'app/api/users/[id]/route.ts': null });
    const delta = compareReports(base, head);
    expect(delta.routes.added).toEqual([]);
    expect(delta.routes.removed).toEqual([
      { id: expect.stringContaining('DELETE'), label: 'DELETE /api/users/[id]', stillCalledFrom: [{ file: 'components/UserTable.tsx', line: 18 }, { file: 'test/users.test.ts', line: 20 }] },
      { id: expect.stringContaining('GET'), label: 'GET /api/users/[id]', stillCalledFrom: [{ file: 'lib/users-client.ts', line: 10 }] },
    ]);
    expect(deltaHighlights(delta)).toContain('DELETE /api/users/[id] removed but still called from 2 places');
    expect(deltaFailures(delta, parseFailOn(['removed-routes']))[0]?.message).toBe('2 routes removed: DELETE /api/users/[id], GET /api/users/[id]');
    const md = architectureDeltaMarkdown(delta);
    expect(md).toContain('- Removed routes:');
    expect(md).toContain('`GET /api/users/[id]` — ⚠️ still called from `lib/users-client.ts:10`');
  });

  it('renaming a dynamic segment keeps the routes ([id] → [userId])', async () => {
    const text = project.read('app/api/users/[id]/route.ts');
    const head = await project.run({ 'app/api/users/[id]/route.ts': null, 'app/api/users/[userId]/route.ts': text.replace(/params\.id\b/g, 'params.userId').replace(/\{ id: string \}/g, '{ userId: string }') });
    expect(head.routes.some((r) => r.path === '/api/users/[userId]')).toBe(true);
    const delta = compareReports(base, head);
    expect(delta.routes).toEqual({ added: [], removed: [] });
    expect(deltaFailures(delta, parseFailOn(['removed-routes']))).toEqual([]);
    expect(delta.areaEdges.filter((a) => a.isNew)).toEqual([]);
    expect(routeKey({ method: 'GET', path: '/users/:id' })).toBe(routeKey({ method: 'GET', path: '/users/[userId]' }));
    expect(routeKey({ method: 'GET', path: '/users/{id}' })).toBe(routeKey({ method: 'GET', path: '/users/$userId' }));
    expect(routeKey({ method: 'GET', path: '/docs/[...slug]' })).not.toBe(routeKey({ method: 'GET', path: '/docs/[slug]' }));
    expect(routeKey({ method: 'GET', path: '/users/:id' })).not.toBe(routeKey({ method: 'POST', path: '/users/:id' }));
  });

  it('new and fixed rule violations, judged with the head configuration', async () => {
    const profile = project.read('components/UserProfile.tsx');
    const head = await project.run({ 'components/UserProfile.tsx': `import { findUser } from '@/lib/db';\n${profile}\nexport const lookup = findUser;\n` });
    const delta = compareReports(base, head);
    expect(delta.newViolations).toEqual([expect.objectContaining({ rule: 'components-use-public-lib', source: 'components/UserProfile.tsx', target: 'lib/db.ts' })]);
    expect(delta.fixedViolations).toEqual([]);
    expect(deltaFailures(delta, parseFailOn(['new-violations']))).toHaveLength(1);

    // A rule added in the head config flags old imports too — they are not "new" when both sides use it.
    const config = JSON.parse(project.read('code-visualizer.config.json')) as { rules: { name: string; from: string; to: string }[] };
    config.rules.push({ name: 'no-format-in-components', from: 'components/**', to: 'lib/format.ts' });
    const withRule = await project.run({ 'code-visualizer.config.json': JSON.stringify(config) });
    expect(withRule.insights.ruleViolations.some((v) => v.rule === 'no-format-in-components')).toBe(true);
    expect(compareReports(base, withRule).newViolations.map((v) => v.rule)).toContain('no-format-in-components');
    const { loadConfig } = await import('../src/analyzer/config.js');
    const headConfig = loadConfig(project.root, (rel) => (rel === 'code-visualizer.config.json' ? JSON.stringify(config) : undefined)).config;
    expect(compareReports(base, withRule, { config: headConfig }).newViolations).toEqual([]);
  });
});

describe('delta helpers', () => {
  const empty = (): ArchitectureDelta => ({
    base: 'main',
    baseCommit: 'abcdef1234567890',
    head: 'working tree',
    newEdges: [],
    removedEdges: [],
    areaEdges: [],
    newCycles: [],
    fixedCycles: [],
    newViolations: [],
    fixedViolations: [],
    newMissingDependencies: [],
    addedPackages: [],
    removedPackages: [],
    complexity: [],
    exports: [],
    routes: { added: [], removed: [] },
    newUnusedExports: [],
    health: { before: 80, after: 80, categories: [] },
    fingerprints: { new: [], fixed: [] },
  });

  it('parses --fail-on values and rejects unknown ones', () => {
    expect(parseFailOn(['new-cycles,health-drop:2', 'breaking-exports'])).toEqual([{ rule: 'new-cycles' }, { rule: 'health-drop', threshold: 2 }, { rule: 'breaking-exports' }]);
    expect(() => parseFailOn(['new-cycle'])).toThrow(/Unknown --fail-on value "new-cycle"/);
    expect(() => parseFailOn(['health-drop:x'])).toThrow(/health-drop:<n>/);
    expect(() => parseFailOn(['new-cycles:1'])).toThrow(/takes no value/);
  });

  it('health-drop fails only above the allowed drop', () => {
    const delta = { ...empty(), health: { before: 80, after: 77, categories: [] } };
    expect(deltaFailures(delta, parseFailOn(['health-drop:3']))).toEqual([]);
    expect(deltaFailures(delta, parseFailOn(['health-drop:2']))).toEqual([{ rule: 'health-drop', message: 'health dropped by 3 (80 → 77, allowed 2)' }]);
    expect(deltaFailures(empty(), parseFailOn(['new-cycles', 'new-violations', 'breaking-exports', 'removed-routes', 'new-missing-deps', 'health-drop']))).toEqual([]);
  });

  it('names the first offender in gate failures and suggests --fail-on values', () => {
    const delta: ArchitectureDelta = {
      ...empty(),
      newCycles: [['src/components/index.ts', 'src/hooks/index.ts'], ['a.ts', 'b.ts']],
      newViolations: [{ rule: 'no-db', severity: 'error', source: 'src/ui/a.ts', target: 'src/db/b.ts', line: 3 }],
    };
    expect(deltaFailures(delta, parseFailOn(['new-cycles', 'new-violations']))).toEqual([
      { rule: 'new-cycles', message: '2 new circular dependencies: components/index.ts → hooks/index.ts → components/index.ts (+1 more)' },
      { rule: 'new-violations', message: '1 new architecture rule violation: src/ui/a.ts:3 → src/db/b.ts (no-db)' },
    ]);
    expect(() => parseFailOn(['breaking-export'])).toThrow('did you mean "breaking-exports"?');
    expect(closest('mian', ['main', 'master'])).toBe('main');
    expect(closest('feature-x', ['main', 'master'])).toBeUndefined();
  });

  it('tells barrel files apart in cycles', () => {
    expect(cycleLabel(['src/components/index.ts', 'src/hooks/index.ts'])).toBe('components/index.ts → hooks/index.ts → components/index.ts');
    expect(cycleLabel(['src/a.ts', 'src/b.ts'])).toBe('a.ts → b.ts → a.ts');
    expect([...shortNames(['a/x/index.ts', 'b/x/index.ts', 'c.ts']).values()]).toEqual(['a/x/index.ts', 'b/x/index.ts', 'c.ts']);
    const md = architectureDeltaMarkdown({ ...empty(), newCycles: [['src/components/index.ts', 'src/hooks/index.ts']] });
    expect(md).toContain('  - `components/index.ts` → `hooks/index.ts` → `components/index.ts`');
  });

  it('says when the base is a merge-base and does not repeat a commit label', () => {
    const changed = { ...empty(), health: { before: 80, after: 79, categories: [] } };
    expect(architectureDeltaMarkdown({ ...changed, mergeBase: true })).toContain('Compared to the merge-base with `main` (`abcdef1234`): health 80 → 79 (−1).');
    expect(architectureDeltaMarkdown({ ...changed, base: 'abcdef1234' })).toContain('Compared to `abcdef1234`: health 80 → 79 (−1).');
    expect(architectureDeltaMarkdown({ ...empty(), mergeBase: true })).toContain('No architectural changes compared to the merge-base with `main` (`abcdef1234`)');
  });

  it('labels default exports with their file', () => {
    const e = { file: 'src/components/Spinner.tsx', name: 'default', change: 'kind' as const, before: 'class Spinner', after: 'Spinner()', breaking: true, importers: ['a.ts'], staleCallSites: [] };
    expect(exportChangeLabel({ ...e, change: 'removed' })).toBe('default export of Spinner.tsx removed');
    expect(deltaFailures({ ...empty(), exports: [e] }, parseFailOn(['breaking-exports']))[0]?.message).toBe('1 breaking export change: default export of Spinner.tsx');
  });

  it('only breaking changes that break something fail breaking-exports', () => {
    const unusedRemoval = { file: 'a.ts', name: 'old', change: 'removed' as const, breaking: true, importers: [], staleCallSites: [] };
    const entryRemoval = { ...unusedRemoval, name: 'api', entry: true };
    expect(deltaFailures({ ...empty(), exports: [unusedRemoval] }, parseFailOn(['breaking-exports']))).toEqual([]);
    expect(deltaFailures({ ...empty(), exports: [unusedRemoval, entryRemoval] }, parseFailOn(['breaking-exports']))).toEqual([{ rule: 'breaking-exports', message: '1 breaking export change: api' }]);
  });

  it('renders the PR section with a diagram of new area dependencies', () => {
    const delta: ArchitectureDelta = {
      ...empty(),
      newEdges: [{ source: 'src/ui/Cart.tsx', target: 'src/db/client.ts', names: ['db'], line: 3 }],
      areaEdges: [{ from: 'src/ui', to: 'src/db', before: 0, after: 1, isNew: true }],
      newCycles: [['src/ui/a.ts', 'src/ui/b.ts']],
      health: { before: 80, after: 78, categories: [{ id: 'modularity', before: 90, after: 80 }] },
    };
    const md = architectureDeltaMarkdown(delta);
    expect(md).toContain('### Architecture changes');
    // Zero counts are left out.
    expect(md).toContain('Compared to `main` (`abcdef1234`): +1 import, health 80 → 78 (−2).');
    expect(md).toContain('- ⚠️ **1 new circular dependency**:');
    expect(md).toContain('  - `a.ts` → `b.ts` → `a.ts`');
    expect(md).toContain('```mermaid\nflowchart LR\n  f0["src/ui"]\n  f1["src/db"]\n  f0 -->|1| f1\n```');
    expect(md).toContain('- Health by category: modularity 90 → 80');
    expect(deltaHighlights(delta)).toEqual(['1 new cycle', '+1 import src/ui→src/db', 'health 80 → 78']);
  });

  it('prSummaryMarkdown includes the section when the change set has a delta', () => {
    const data = {
      files: [],
      routes: [],
      edges: [],
      changes: {
        mode: 'branch',
        files: [{ id: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, lines: [1], analyzed: true }],
        additions: 1,
        deletions: 0,
        commits: [],
        symbols: [],
        impacted: [],
        impactedRoutes: [],
        clusters: [],
        tests: { files: [], changedTests: [] },
        reviewers: [],
        owners: [],
        risk: { score: 5, level: 'low', factors: [] },
        delta: empty(),
      },
    } as unknown as ReportData;
    expect(prSummaryMarkdown(data)).toContain('### Architecture changes\n\nNo architectural changes compared to `main`');
  });
});
