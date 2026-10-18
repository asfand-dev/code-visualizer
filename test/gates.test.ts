/**
 * Quality gates as pure functions: finding fingerprints, new / existing / fixed against a base commit
 * (compareReports) or a committed baseline, and the configuration keys of new-only-gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze, createAnalyzeCache, type AnalyzeCache } from '../src/analyzer/index.js';
import { compareReports } from '../src/analyzer/compare.js';
import { allFindings, countsLabel, evaluateGates, GATE_PROVIDERS, type GateProvider, type Thresholds } from '../src/analyzer/gates.js';
import { BaselineError, BaselineMatcher, baselineFromFindings, parseBaseline, ratchetBaseline, serializeBaseline } from '../src/analyzer/baseline.js';
import { checkKeyWarnings, loadConfig, normalizeConfig } from '../src/analyzer/config.js';
import { hygieneGate } from '../src/analyzer/hygiene.js';
import { newInsightsOf } from '../src/shared/new-findings.js';
import { complexityFingerprint, cycleFingerprint, fingerprint, unusedExportFingerprint } from '../src/shared/fingerprint.js';
import { ruleDescriptor, RULES_CATALOG } from '../src/shared/rules-catalog.js';
import type { ArchitectureDelta, CheckResult, Finding, ReportData } from '../src/shared/types.js';
import { copyFixture, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

type Overlay = Record<string, string | null>;

/** A fixture copy analyzed without git; overlays stand for edits (base = no overlay). */
function analyzer(fixture: string): { root: string; run(overlay?: Overlay): Promise<ReportData>; read(file: string): string } {
  const root = copyFixture(fixture, 'cv-gates-');
  const cache: AnalyzeCache = createAnalyzeCache();
  return {
    root,
    run: (overlay) => analyze({ root, overlay, git: false, includeSource: false, history: false, cache }),
    read: (file) => fs.readFileSync(path.join(root, file), 'utf8'),
  };
}

const MATH = 'src/utils/math.ts';
const FORMAT = 'src/utils/format.ts';
/** A new import cycle between two new files. */
const NEW_CYCLE: Overlay = {
  'src/a.ts': "import { b } from './b';\nexport const a = (): number => b();\n",
  'src/b.ts': "import { a } from './a';\nexport const b = (): number => (a ? 1 : 0);\n",
};
/** A new function with cyclomatic complexity 5 (four `if`s). */
const BRANCHY = 'src/utils/branchy.ts';
const BRANCHY_TEXT = "export function branchy(n: number): string {\n  if (n > 3) return 'a';\n  if (n > 2) return 'b';\n  if (n > 1) return 'c';\n  if (n > 0) return 'd';\n  return 'e';\n}\n";

const gate = (result: CheckResult, id: string) => result.gates.find((g) => g.id === id)!;

describe('finding fingerprints', () => {
  it('stay the same after inserting 10 lines above a function (lines move, identities do not)', async () => {
    const a = analyzer('react-vite-ts');
    const thresholds: Thresholds = { maxComplexity: 1, maxCycles: 0, maxUnusedExports: 0 };
    const before = evaluateGates(await a.run(), thresholds, { mode: 'all' });
    const after = evaluateGates(await a.run({ [MATH]: `${'// moved down\n'.repeat(10)}${a.read(MATH)}` }), thresholds, { mode: 'all' });
    const ids = (r: CheckResult): string[] => allFindings(r).map((f) => `${f.ruleId} ${f.fingerprint}`).sort();
    expect(ids(before).length).toBeGreaterThan(3);
    expect(ids(after)).toEqual(ids(before));
    const percent = (r: CheckResult): Finding => allFindings(r).find((f) => f.ruleId === 'cv/complexity' && f.subject === `${MATH}#percent`)!;
    expect(percent(after).line).toBe(percent(before).line! + 10);
    expect(percent(after).fingerprint).toBe(complexityFingerprint(MATH, `${MATH}#percent`));
  });

  it('gives rotated cycles one key', async () => {
    expect(cycleFingerprint(['src/a.ts', 'src/b.ts', 'src/c.ts'])).toBe(cycleFingerprint(['src/b.ts', 'src/c.ts', 'src/a.ts']));
    expect(cycleFingerprint(['src/c.ts', 'src/a.ts', 'src/b.ts'])).toBe(cycleFingerprint(['src/a.ts', 'src/b.ts', 'src/c.ts']));
    const data = await analyzer('react-vite-ts').run();
    const one = evaluateGates({ ...data, insights: { ...data.insights, cycles: [[MATH, FORMAT]] } }, { maxCycles: 0 }, { mode: 'all' });
    const other = evaluateGates({ ...data, insights: { ...data.insights, cycles: [[FORMAT, MATH]] } }, { maxCycles: 0 }, { mode: 'all' });
    expect(gate(one, 'cycles').findings[0].fingerprint).toBe(gate(other, 'cycles').findings[0].fingerprint);
  });

  it('reports every finding with a catalogued rule, a subject and a file', async () => {
    const data = await analyzer('react-vite-ts').run();
    const result = evaluateGates(data, { maxComplexity: 1, maxCycles: 0, maxUnusedExports: 0 }, { mode: 'all' });
    const known = new Set(RULES_CATALOG.map((r) => r.id));
    for (const f of allFindings(result)) {
      expect(known.has(f.ruleId), f.ruleId).toBe(true);
      expect(f.subject && f.file && f.message).toBeTruthy();
      expect(f.status).toBeUndefined();
    }
    // Rules without a catalog entry (plugins) get a generic descriptor; test-intelligence catalogued patch coverage.
    expect(ruleDescriptor('cv/plugin-rule')).toMatchObject({ id: 'cv/plugin-rule', name: 'PluginRule', shortDescription: 'Plugin rule' });
    expect(ruleDescriptor('cv/patch-coverage')).toMatchObject({ id: 'cv/patch-coverage', name: 'UncoveredChangedLines', level: 'warning' });
  });
});

describe('baseline', () => {
  const f = (ruleId: string, fp: string): Pick<Finding, 'ruleId' | 'fingerprint'> => ({ ruleId, fingerprint: fp });

  it('is a multiset: duplicate fingerprints count once per occurrence', () => {
    const baseline = baselineFromFindings([f('cv/x', 'b2'), f('cv/x', 'a1'), f('cv/x', 'a1'), f('cv/a', 'z9')]);
    expect(baseline.findings).toEqual({ 'cv/a': ['z9'], 'cv/x': ['a1', 'a1', 'b2'] });
    const matcher = new BaselineMatcher(baseline);
    expect([matcher.claim(f('cv/x', 'a1')), matcher.claim(f('cv/x', 'a1')), matcher.claim(f('cv/x', 'a1'))]).toEqual([true, true, false]);
    expect(matcher.claim(f('cv/y', 'a1'))).toBe(false); // the rule is part of the identity
    expect(matcher.takeLeftovers(['cv/x'])).toEqual([{ ruleId: 'cv/x', fingerprint: 'b2' }]);
    expect(matcher.ruleIds()).toEqual(['cv/a']);
  });

  it('serializes deterministically: sorted keys, 2-space indent, trailing newline', () => {
    const text = serializeBaseline({ version: 1, tool: 'code-visualizer', findings: { 'cv/z': ['b', 'a'], 'cv/a': ['c'] } });
    expect(text).toBe('{\n  "version": 1,\n  "tool": "code-visualizer",\n  "findings": {\n    "cv/a": [\n      "c"\n    ],\n    "cv/z": [\n      "a",\n      "b"\n    ]\n  }\n}\n');
    expect(parseBaseline(text).findings).toEqual({ 'cv/a': ['c'], 'cv/z': ['a', 'b'] });
    expect(() => parseBaseline('{"version": 2}')).toThrow(BaselineError);
    expect(() => parseBaseline('{"version": 1, "findings": {"cv/x": [1]}}')).toThrow(/findings\["cv\/x"\]/);
  });

  it('ratchets: fixed findings leave, new ones only enter with force', () => {
    const previous = baselineFromFindings([f('cv/x', 'a'), f('cv/x', 'a'), f('cv/x', 'b')]);
    const current = baselineFromFindings([f('cv/x', 'a'), f('cv/x', 'c')]);
    expect(ratchetBaseline(previous, current)).toEqual({ baseline: { version: 1, tool: 'code-visualizer', findings: { 'cv/x': ['a'] } }, added: 0, removed: 2, rejected: 1 });
    expect(ratchetBaseline(previous, current, { force: true })).toMatchObject({ baseline: { findings: { 'cv/x': ['a', 'c'] } }, added: 1, removed: 2, rejected: 0 });
    // No baseline yet: adopting the gates accepts everything.
    expect(ratchetBaseline(undefined, current)).toMatchObject({ baseline: { findings: { 'cv/x': ['a', 'c'] } }, added: 2, removed: 0 });
  });

  it('keeps a known cycle known when it loses files or splits; a merged cycle is new and its parts are not fixed', async () => {
    const data = await analyzer('react-vite-ts').run();
    const withCycles = (cycles: string[][]): ReportData => ({ ...data, insights: { ...data.insights, cycles } });
    const big = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const other = ['src/x.ts', 'src/y.ts'];
    const known = baselineFromFindings(allFindings(evaluateGates(withCycles([big, other]), { maxCycles: 0 }, { mode: 'all' })));
    expect(known.cycles).toEqual({ [cycleFingerprint(big)]: big, [cycleFingerprint(other)]: other });
    const judge = (cycles: string[][]): CheckResult => evaluateGates(withCycles(cycles), { maxCycles: 0 }, { mode: 'baseline', baseline: known });

    // c.ts stops importing a.ts: a ↔ b is left (a new fingerprint, the same debt, smaller).
    const shrunk = judge([['src/a.ts', 'src/b.ts'], other]);
    expect(shrunk.ok).toBe(true);
    expect(gate(shrunk, 'cycles').counts).toEqual({ new: 0, existing: 2, fixed: 0 });
    // Split in two: both halves are old debt.
    expect(gate(judge([['src/a.ts', 'src/b.ts'], ['src/c.ts', 'src/d.ts'], other]), 'cycles')).toMatchObject({ ok: true, counts: { new: 0, existing: 3, fixed: 0 } });
    // Grown by a file, or two known cycles joined: new — and the known ones are not "fixed".
    expect(gate(judge([[...big, 'src/e.ts'], other]), 'cycles')).toMatchObject({ ok: false, counts: { new: 1, existing: 1, fixed: 0 } });
    expect(gate(judge([[...big, ...other]]), 'cycles')).toMatchObject({ ok: false, counts: { new: 1, existing: 0, fixed: 0 } });
    // Gone: fixed.
    expect(gate(judge([other]), 'cycles').counts).toEqual({ new: 0, existing: 1, fixed: 1 });
    // A baseline written before cycles kept their files still matches exactly.
    const { cycles: _files, ...old } = known;
    expect(gate(evaluateGates(withCycles([big, other]), { maxCycles: 0 }, { mode: 'baseline', baseline: old }), 'cycles').counts).toEqual({ new: 0, existing: 2, fixed: 0 });
  });

  it('ratchets cycles by their files and keeps entries of rules that were not judged', () => {
    const big = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const cycle = (members: string[]) => ({ ruleId: 'cv/cycle', fingerprint: cycleFingerprint(members), subject: members.join(' → ') });
    const previous = baselineFromFindings([cycle(big), { ruleId: 'cv/complexity', fingerprint: 'c1' }, { ruleId: 'cv/unused-export', fingerprint: 'u1' }]);
    // The cycle shrank; complexity was not judged this time (no --max-complexity); the unused export is gone.
    const current = baselineFromFindings([cycle(['src/a.ts', 'src/b.ts'])]);
    const next = ratchetBaseline(previous, current, { rules: ['cv/cycle', 'cv/unused-export'] });
    expect(next).toMatchObject({ added: 0, removed: 1, rejected: 0 });
    expect(next.baseline.findings).toEqual({ 'cv/complexity': ['c1'], 'cv/cycle': [cycleFingerprint(['src/a.ts', 'src/b.ts'])] });
    expect(next.baseline.cycles).toEqual({ [cycleFingerprint(['src/a.ts', 'src/b.ts'])]: ['src/a.ts', 'src/b.ts'] });
    // Merged with another cycle: the merge is rejected, the known cycle stays known (undoing the merge passes).
    const merged = ratchetBaseline(previous, baselineFromFindings([cycle([...big, 'src/z.ts'])]), { rules: ['cv/cycle'] });
    expect(merged).toMatchObject({ added: 0, removed: 0, rejected: 1 });
    expect(merged.baseline.findings['cv/cycle']).toEqual([cycleFingerprint(big)]);
    expect(serializeBaseline(next.baseline)).toContain('"cycles": {');
    expect(parseBaseline(serializeBaseline(next.baseline))).toEqual(next.baseline);
    expect(() => parseBaseline('{"version": 1, "findings": {}, "cycles": {"x": "a"}}')).toThrow(/"cycles" must map/);
  });

  it('counts nothing as fixed for gates that did not run or outside a partial analysis', async () => {
    const data = await analyzer('react-vite-ts').run();
    const known = baselineFromFindings(allFindings(evaluateGates(data, { maxCycles: 0, maxComplexity: 1 }, { mode: 'all' })));
    // Without --max-complexity the complexity gate does not run: its entries are neither new nor fixed.
    const noComplexity = evaluateGates(data, { maxCycles: 0 }, { mode: 'baseline', baseline: known });
    expect(noComplexity.fixed).toEqual([]);
    expect(noComplexity.ruleIds).toContain('cv/cycle');
    expect(noComplexity.ruleIds).not.toContain('cv/complexity');
    // --directory src/components: the cycle in src/utils is outside, not fixed.
    const scoped = { ...data, insights: { ...data.insights, cycles: [] } };
    const partial = evaluateGates(scoped, { maxCycles: 0, maxComplexity: 1 }, { mode: 'baseline', baseline: known, partial: true });
    expect(gate(partial, 'cycles').counts).toEqual({ new: 0, existing: 0, fixed: 0 });
    expect(partial.fixed).toEqual([]);
    expect(partial.notes).toEqual([expect.stringContaining('Only part of the project was analyzed')]);
    expect(gate(evaluateGates(scoped, { maxCycles: 0 }, { mode: 'baseline', baseline: known }), 'cycles').counts).toEqual({ new: 0, existing: 0, fixed: 1 });
  });

  it('judges findings against the baseline: known ones are existing, leftovers are fixed', async () => {
    const data = await analyzer('react-vite-ts').run();
    const all = evaluateGates(data, { maxCycles: 0, maxComplexity: 1 }, { mode: 'all' });
    const known = baselineFromFindings(allFindings(all));
    // A finding that is gone since the baseline was written.
    known.findings['cv/cycle'].push('00000000deadbeef');
    const result = evaluateGates(data, { maxCycles: 0, maxComplexity: 1 }, { mode: 'baseline', baseline: known, base: 'code-visualizer.baseline.json' });
    expect(result).toMatchObject({ ok: true, mode: 'baseline', base: 'code-visualizer.baseline.json' });
    expect(gate(result, 'cycles').counts).toEqual({ new: 0, existing: 1, fixed: 1 });
    expect(result.fixed).toEqual([expect.objectContaining({ ruleId: 'cv/cycle', fingerprint: '00000000deadbeef', status: 'fixed', gate: 'cycles' })]);
    // Remove one complexity entry: that function is new debt now.
    const complexity = known.findings['cv/complexity'];
    const dropped = complexity.shift()!;
    const stricter = evaluateGates(data, { maxCycles: 0, maxComplexity: 1 }, { mode: 'baseline', baseline: known });
    expect(gate(stricter, 'complexity')).toMatchObject({ ok: false, counts: { new: 1, existing: complexity.length, fixed: 0 } });
    expect(gate(stricter, 'complexity').findings.filter((x) => x.status === 'new').map((x) => x.fingerprint)).toEqual([dropped]);
  });
});

describe('evaluateGates against a base commit', () => {
  it('fails only on new findings; old debt is counted and fixed debt reported', async () => {
    const a = analyzer('react-vite-ts');
    const base = await a.run();
    const thresholds: Thresholds = { maxCycles: 0 };
    // A comment next to the existing format.ts ↔ math.ts cycle.
    const comment = await a.run({ [MATH]: `${a.read(MATH)}// just a comment\n` });
    const quiet = evaluateGates(comment, thresholds, { mode: 'changed', delta: compareReports(base, comment) });
    expect(quiet.ok).toBe(true);
    expect(gate(quiet, 'cycles')).toMatchObject({ ok: true, detail: '0 new · 1 existing · 0 fixed', counts: { new: 0, existing: 1, fixed: 0 } });
    expect(evaluateGates(comment, thresholds, { mode: 'all' }).ok).toBe(false); // the same debt fails a full check

    const cyclic = await a.run(NEW_CYCLE);
    const failing = evaluateGates(cyclic, thresholds, { mode: 'changed', delta: compareReports(base, cyclic) });
    expect(failing.ok).toBe(false);
    const cycles = gate(failing, 'cycles');
    expect(cycles.counts).toEqual({ new: 1, existing: 1, fixed: 0 });
    expect(cycles.findings.filter((f) => f.status === 'new').map((f) => f.subject)).toEqual(['src/a.ts → src/b.ts']);
    // A limit that the new total stays within is not exceeded.
    expect(evaluateGates(cyclic, { maxCycles: 5 }, { mode: 'changed', delta: compareReports(base, cyclic) }).ok).toBe(true);

    const fixedData = await a.run({ [MATH]: a.read(MATH).replace("import { formatNumber } from './format';\n", '').replace('formatNumber(', 'String(') });
    const fixed = evaluateGates(fixedData, thresholds, { mode: 'changed', delta: compareReports(base, fixedData) });
    expect(gate(fixed, 'cycles').counts).toEqual({ new: 0, existing: 0, fixed: 1 });
    expect(fixed.fixed).toEqual([expect.objectContaining({ ruleId: 'cv/cycle', status: 'fixed', message: expect.stringContaining('format.ts') })]);
  });

  it('judges complexity by the configured limit: new above it, or more complex than before', async () => {
    const a = analyzer('react-vite-ts');
    const base = await a.run();
    const head = await a.run({ [BRANCHY]: BRANCHY_TEXT, [MATH]: a.read(MATH).replace("if (total === 0) return '0%';", "if (total === 0) return '0%';\n  if (total < 0) return '-';") });
    const thresholds: Thresholds = { maxComplexity: 1 };
    // compareReports lists new functions from the lower of 10 and the limit, like analyze() does with the config.
    const delta = compareReports(base, head, { complexityThreshold: 1 });
    expect(delta.complexityThreshold).toBe(1);
    expect(delta.complexity.map((c) => [c.symbol, c.before, c.after])).toEqual(
      expect.arrayContaining([
        [`${BRANCHY}#branchy`, 0, 5],
        [`${MATH}#percent`, 2, 3],
      ]),
    );
    const result = evaluateGates(head, thresholds, { mode: 'changed', delta });
    const complexity = gate(result, 'complexity');
    expect(complexity.ok).toBe(false);
    expect(complexity.findings.filter((f) => f.status === 'new').map((f) => f.subject).sort()).toEqual([`${BRANCHY}#branchy`, `${MATH}#percent`]);
    expect(complexity.counts!.existing).toBeGreaterThan(0);
    // percent() is old code that got worse (it was above the limit already): the message says from what.
    const percent = complexity.findings.find((f) => f.subject === `${MATH}#percent`)!;
    expect(percent).toMatchObject({ message: 'percent has cyclomatic complexity 3 (max 1, was 2)', worsened: true, weight: 3 });
    expect(complexity.findings.find((f) => f.subject === `${BRANCHY}#branchy`)).toMatchObject({ message: 'branchy has cyclomatic complexity 5 (max 1)' });
    expect(complexity.findings.find((f) => f.subject === `${BRANCHY}#branchy`)!.worsened).toBeUndefined();
    expect(result.newOnly).toBe(true);
    // With the default threshold (10) a new function of complexity 5 is no delta entry: that is why analyze()
    // and `check` pass the configured limit on to the comparison.
    expect(compareReports(base, head).complexity.some((c) => c.symbol === `${BRANCHY}#branchy`)).toBe(false);
  });

  it('--no-worse fails on any increase, --max-health-drop on a drop above the limit, --min-health only when lowered', async () => {
    const a = analyzer('react-vite-ts');
    const base = await a.run();
    const head = await a.run({ [MATH]: a.read(MATH).replace("if (total === 0) return '0%';", "if (total === 0) return '0%';\n  if (total < 0) return '-';") });
    const delta = compareReports(base, head);
    const noWorse = evaluateGates(head, { noWorse: true }, { mode: 'all', delta });
    expect(gate(noWorse, 'no-worse')).toMatchObject({ ok: false, findings: [expect.objectContaining({ ruleId: 'cv/complexity-increase', message: 'percent() got more complex: 2 → 3', status: 'new' })] });
    // Above --max-complexity the complexity gate reports the growth already: not twice.
    const both = evaluateGates(head, { noWorse: true, maxComplexity: 2 }, { mode: 'changed', delta: compareReports(base, head, { complexityThreshold: 2 }) });
    expect(gate(both, 'complexity').findings.filter((f) => f.status === 'new').map((f) => f.subject)).toEqual([`${MATH}#percent`]);
    expect(gate(both, 'no-worse')).toMatchObject({ ok: true, findings: [], detail: 'no other function got more complex (1 more under Function complexity)' });
    expect(gate(evaluateGates(head, { noWorse: true, maxComplexity: 5 }, { mode: 'changed', delta }), 'no-worse').findings).toHaveLength(1);

    const dropped: ArchitectureDelta = { ...delta, health: { before: 80, after: 77, categories: [] } };
    const drop = (n: number): CheckResult => evaluateGates(head, { maxHealthDrop: n }, { mode: 'changed', delta: dropped });
    expect(gate(drop(2), 'health-drop')).toMatchObject({ ok: false, detail: '80 → 77 (−3, max drop 2)' });
    expect(gate(drop(3), 'health-drop').ok).toBe(true);
    expect(gate(evaluateGates(head, { maxHealthDrop: 0 }, { mode: 'all' }), 'health-drop')).toMatchObject({ ok: true, detail: 'no base to compare with' });

    const score = head.health.score;
    const min = score + 1;
    expect(gate(evaluateGates(head, { minHealth: min }, { mode: 'all', delta }), 'health').ok).toBe(false);
    const unchanged: ArchitectureDelta = { ...delta, health: { before: score, after: score, categories: [] } };
    expect(gate(evaluateGates(head, { minHealth: min }, { mode: 'changed', delta: unchanged }), 'health')).toMatchObject({ ok: true, detail: expect.stringContaining('not lowered by this change') });
    expect(gate(evaluateGates(head, { minHealth: min }, { mode: 'changed', delta: { ...unchanged, health: { before: score + 1, after: score, categories: [] } } }), 'health').ok).toBe(false);
  });

  it('runs gates that other features append: their findings are new on changed lines unless the provider decides', async () => {
    const a = analyzer('react-vite-ts');
    const base = await a.run();
    const data = await a.run({ 'src/App.tsx': `${a.read('src/App.tsx')}// edited\n` });
    // What analyze() reports for an edit at line 3 of App.tsx.
    const changes = { files: [{ id: 'src/App.tsx', status: 'modified', lines: [3] }], symbols: [], base: 'HEAD' } as unknown as NonNullable<ReportData['changes']>;
    const head: ReportData = { ...data, changes };
    const hygieneFinding = (line: number): Finding => ({ ruleId: 'cv/hygiene', gate: 'hygiene', file: 'src/App.tsx', line, message: `debugger statement (line ${line})`, severity: 'error', subject: `debugger@${line}`, fingerprint: fingerprint('cv/hygiene', 'src/App.tsx', `debugger@${line}`) });
    const hygiene: GateProvider = () => ({ id: 'hygiene', label: 'Hygiene', ok: false, detail: '2 debugger statements', findings: [hygieneFinding(3), hygieneFinding(9)] });
    const delta = compareReports(base, data);
    // (daily-loop registers the real hygiene gate: this stand-in replaces it here.)
    const providers = [...GATE_PROVIDERS.filter((p) => p !== hygieneGate), hygiene];
    // compareReports knows nothing about cv/hygiene: the finding on the changed line is new, the other old.
    const judged = gate(evaluateGates(head, {}, { mode: 'changed', delta, providers }), 'hygiene');
    expect(judged).toMatchObject({ ok: false, counts: { new: 1, existing: 1, fixed: 0 } });
    expect(judged.findings.map((f) => [f.line, f.status])).toEqual([
      [3, 'new'],
      [9, 'existing'],
    ]);
    // A provider that knows better decides itself.
    const decided: GateProvider = (d, ctx) => ({ ...hygiene(d, ctx)!, isNew: () => false });
    expect(gate(evaluateGates(head, {}, { mode: 'changed', delta, providers: [decided] }), 'hygiene')).toMatchObject({ ok: true, counts: { new: 0, existing: 2, fixed: 0 } });
    // Built-in rules stay judged by fingerprint, even on a changed line.
    const onLine: GateProvider = () => ({ id: 'unused', label: 'Unused', ok: false, detail: '', findings: [{ ...hygieneFinding(3), ruleId: 'cv/unused-export', fingerprint: unusedExportFingerprint('src/App.tsx', 'x') }] });
    expect(gate(evaluateGates(head, {}, { mode: 'changed', delta, providers: [onLine] }), 'unused').counts).toEqual({ new: 0, existing: 1, fixed: 0 });
    expect(gate(evaluateGates(head, {}, { mode: 'all', providers }), 'hygiene').counts).toBeUndefined();
  });

  it('falls back to the changed files when the comparison is missing', async () => {
    const data = await analyzer('react-vite-ts').run();
    const result = evaluateGates(data, { maxCycles: 0 }, { mode: 'changed' });
    expect(result.notes).toEqual([expect.stringContaining('Could not compare with the base commit')]);
    expect(gate(result, 'cycles').counts).toBeUndefined();
    expect(countsLabel({ new: 1, existing: 14, fixed: 2 })).toBe('1 new · 14 existing · 2 fixed');
  });
});

describe('configuration', () => {
  it('accepts the new check keys, also as strings, and passes other features’ keys through', () => {
    expect(
      normalizeConfig({ check: { maxHealthDrop: '2', noWorse: 'yes', baseline: 'ci/baseline.json', changedMode: 'Files', minPatchCoverage: 80, clones: { minLines: 6 }, hygiene: ['debugger'] } }).config.check,
    ).toEqual({ maxHealthDrop: 2, noWorse: true, baseline: 'ci/baseline.json', changedMode: 'files', minPatchCoverage: 80, clones: { minLines: 6 }, hygiene: ['debugger'] });
    expect(normalizeConfig({ check: { baseline: false } }).config.check).toEqual({ baseline: false });
    expect(normalizeConfig({ check: { changedMode: 'touched' } }).error).toMatch(/check\.changedMode must be "new"/);
    expect(normalizeConfig({ check: { baseline: 3 } }).error).toMatch(/check\.baseline must be/);
    expect(normalizeConfig({ check: { maxHealthDrop: 'lots' } }).error).toBe('check.maxHealthDrop must be a number.');
  });

  it('warns about check keys no gate reads, with the key that was probably meant', () => {
    expect(checkKeyWarnings({ maxCycles: 0, noWorse: true, baseline: false })).toEqual([]);
    expect(checkKeyWarnings({ maxCylces: 0, noworse: true, 'max-health-drop': 2, max_unused_exports: 3, frobnicate: 1 })).toEqual([
      'Unknown key check.maxCylces in the configuration is ignored — did you mean "maxCycles"?',
      'Unknown key check.noworse in the configuration is ignored — did you mean "noWorse"?',
      'Unknown key check.max-health-drop in the configuration is ignored — did you mean "maxHealthDrop"?',
      'Unknown key check.max_unused_exports in the configuration is ignored — did you mean "maxUnusedExports"?',
      'Unknown key check.frobnicate in the configuration is ignored.',
    ]);
    expect(checkKeyWarnings(undefined)).toEqual([]);
  });

  it('reads JSON with comments and trailing commas (without the TypeScript compiler) and still explains bad files', () => {
    const root = makeTempDir('cv-gates-config-');
    writeFile(root, 'code-visualizer.config.json', '// gates\n{\n  "check": { "maxCycles": 0, /* none */ "note": "a // b, }", },\n}\n');
    expect(loadConfig(root)).toEqual({ file: 'code-visualizer.config.json', config: { check: { maxCycles: 0, note: 'a // b, }' } } });
    writeFile(root, 'code-visualizer.config.json', '{ "check": { "maxCycles": 0 ');
    expect(loadConfig(root).error).toMatch(/^code-visualizer\.config\.json:1:\d+: /);
    writeFile(root, 'code-visualizer.config.json', '[1]');
    expect(loadConfig(root).error).toBe('code-visualizer.config.json must contain a JSON object.');
  });
});

describe('"New only" in the report (newInsightsOf)', () => {
  it('lists what check --changed fails on, once per function, and counts what it lists', async () => {
    const a = analyzer('react-vite-ts');
    const base = await a.run();
    const head = await a.run({ ...NEW_CYCLE, [MATH]: a.read(MATH).replace("if (total === 0) return '0%';", "if (total === 0) return '0%';\n  if (total < 0) return '-';") });
    const delta = compareReports(base, head);
    const fresh = newInsightsOf(head.insights, delta);
    expect(fresh.cycles).toEqual([['src/a.ts', 'src/b.ts']]);
    // percent() grew 2 → 3: far below the limit, so not a complexity finding (check would not fail on it).
    expect(delta.complexity.some((c) => c.symbol === `${MATH}#percent`)).toBe(true);
    expect(fresh.complexFunctions).toEqual([]);
    expect(fresh.count).toBe(fresh.cycles.length + fresh.complexFunctions.length + fresh.unusedExports.length + fresh.ruleViolations.length);
    // Missing-dependency fingerprints are not part of the lists, so not of the count either.
    const withMissing = { ...delta, fingerprints: { ...delta.fingerprints, new: [...delta.fingerprints.new, fingerprint('cv/missing-dependency', '', 'left-pad')] } };
    expect(newInsightsOf(head.insights, withMissing).count).toBe(fresh.count);
    // A function and its inline callback are one finding.
    const fn = { symbol: 'src/x.ts#run', file: 'src/x.ts', name: 'run', line: 1, complexity: 14, loc: 30 };
    const twice = newInsightsOf(
      { ...head.insights, complexFunctions: [fn, { ...fn, name: 'run › callback', line: 9, complexity: 16 }] } as ReportData['insights'],
      { fingerprints: { new: [complexityFingerprint('src/x.ts', 'src/x.ts#run')], fixed: [] } },
    );
    expect(twice.complexFunctions.map((c) => c.complexity)).toEqual([16]);
  });
});
