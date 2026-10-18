import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyze, createAnalyzeCache, type AnalyzeCache } from '../src/analyzer/index.js';
import { compareReports } from '../src/analyzer/compare.js';
import { normalizeConfig, type CodeVisualizerConfig } from '../src/analyzer/config.js';
import { brokenImports, cyclePath, diffLive, liveImporters, LiveGuard, staleCallCount, touchedFiles } from '../src/analyzer/live-events.js';
import { extractNotifyMode, formatLiveDetail, formatLiveEvent, notifyModeFrom } from '../src/cli/commands/serve.js';
import { UsageError } from '../src/cli/shared.js';
import { createNotifier, notifyCommand } from '../src/cli/notify.js';
import { cycleFingerprint } from '../src/shared/fingerprint.js';
import { liveEventLine, liveMarker, openProblemCount, topEvent } from '../src/shared/live.js';
import * as query from '../src/shared/query.js';
import type { LiveEvent, ReportData } from '../src/shared/types.js';
import { copyFixture, removeTempDirs } from './companion-helpers.js';

afterAll(removeTempDirs);

type Overlay = Record<string, string | null>;

const CYCLE_IMPORT = "import { useUsers } from '@/hooks/useUsers';\nexport const usersHook = useUsers;\n";
const kinds = (events: LiveEvent[]): string[] => events.map((e) => e.kind);
const ofKind = (events: LiveEvent[], kind: LiveEvent['kind']): LiveEvent[] => events.filter((e) => e.kind === kind);

describe('diffLive (two analyses of a copied fixture)', () => {
  let root: string;
  let cache: AnalyzeCache;
  let base: ReportData;
  const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
  const run = (overlay?: Overlay): Promise<ReportData> => analyze({ root, overlay, git: false, includeSource: false, history: false, cache });

  beforeAll(async () => {
    root = copyFixture('react-vite-ts', 'cv-live-');
    cache = createAnalyzeCache();
    base = await run();
  });

  it('a new cycle is an error; removing it again is a fix', async () => {
    const withCycle = await run({ 'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT });
    const added = diffLive(base, withCycle, ['src/api/client.ts']);
    const [cycle] = ofKind(added, 'cycle-added');
    expect(cycle).toMatchObject({ severity: 'error', fingerprint: cycleFingerprint(['src/api/client.ts', 'src/hooks/useUsers.ts']) });
    expect(cycle.files.sort()).toEqual(['src/api/client.ts', 'src/hooks/useUsers.ts']);
    expect(cycle.message).toMatch(/^new cycle: src\/(api\/client|hooks\/useUsers)\.ts → .* → src\//);
    expect(cycle.id).toEqual(expect.any(String));
    expect(cycle.at).toEqual(expect.any(Number));
    // The old math ↔ format cycle is not news.
    expect(ofKind(added, 'cycle-added')).toHaveLength(1);
    expect(added[0]).toBe(cycle); // errors first

    const fixed = diffLive(withCycle, base, ['src/api/client.ts']);
    expect(ofKind(fixed, 'cycle-fixed')).toEqual([expect.objectContaining({ severity: 'success', fingerprint: cycle.fingerprint, message: expect.stringMatching(/^cycle fixed: /) })]);
    expect(ofKind(fixed, 'cycle-added')).toEqual([]);
  });

  it('fixing an old cycle is announced too', async () => {
    const math = read('src/utils/math.ts').replace("import { formatNumber } from './format';\n", '').replace('formatNumber(clamp((value / total) * 100, 0, 100))', 'String(clamp((value / total) * 100, 0, 100))');
    const next = await run({ 'src/utils/math.ts': math });
    const events = diffLive(base, next, ['src/utils/math.ts']);
    expect(ofKind(events, 'cycle-fixed')).toHaveLength(1);
    expect(ofKind(events, 'cycle-fixed')[0].files.sort()).toEqual(['src/utils/format.ts', 'src/utils/math.ts']);
  });

  it('a function that gets more branches gives complexity-up with before and after', async () => {
    const branches = Array.from({ length: 12 }, (_, i) => `  if (value === ${i}) return '${i}';\n`).join('');
    const format = read('src/utils/format.ts').replace('export function formatNumber(value: number): string {\n', `export function formatNumber(value: number): string {\n${branches}`);
    const next = await run({ 'src/utils/format.ts': format });
    const events = diffLive(base, next, ['src/utils/format.ts']);
    const [up] = ofKind(events, 'complexity-up');
    expect(up).toMatchObject({ severity: 'warning', before: 1, after: 13, symbol: 'src/utils/format.ts#formatNumber', files: ['src/utils/format.ts'], message: 'formatNumber() complexity 1 → 13' });
    expect(up.line).toBeGreaterThan(0);
    expect(liveEventLine(up)).toBe(`▲ formatNumber() complexity 1 → 13 · src/utils/format.ts:${up.line}`);

    // And back below the threshold: a fix.
    const down = diffLive(next, base, ['src/utils/format.ts']);
    expect(ofKind(down, 'complexity-down')).toEqual([expect.objectContaining({ severity: 'success', before: 13, after: 1, fingerprint: up.fingerprint })]);
  });

  it('judges complexity with check.maxComplexity, like the complexity gate', async () => {
    const branches = Array.from({ length: 12 }, (_, i) => `  if (value === ${i}) return '${i}';\n`).join('');
    const format = read('src/utils/format.ts').replace('export function formatNumber(value: number): string {\n', `export function formatNumber(value: number): string {\n${branches}`);
    const next = await run({ 'src/utils/format.ts': format });
    // 13 is within a limit of 15: worth knowing (a big step), not a warning, and nothing stays open.
    const lenient = normalizeConfig({ check: { maxComplexity: 15 } }).config;
    const guard = new LiveGuard();
    expect(ofKind(guard.update(base, next, ['src/utils/format.ts'], { config: lenient }), 'complexity-up')).toEqual([expect.objectContaining({ severity: 'info', after: 13 })]);
    expect(guard.openProblems().filter((e) => e.kind === 'complexity-up')).toEqual([]);
    // A stricter limit than 10 flags it, and dropping below that limit is the fix.
    const strict = normalizeConfig({ check: { maxComplexity: 12 } }).config;
    const [up] = ofKind(diffLive(base, next, ['src/utils/format.ts'], { config: strict }), 'complexity-up');
    expect(up).toMatchObject({ severity: 'warning', after: 13 });
    expect(ofKind(diffLive(next, base, ['src/utils/format.ts'], { config: strict }), 'complexity-down')).toEqual([expect.objectContaining({ severity: 'success', fingerprint: up.fingerprint })]);
  });

  it('a new required parameter on an imported function gives signature-changed with the importer count and stale call sites', async () => {
    const format = read('src/utils/format.ts').replace('export function formatDate(iso: string): string {', 'export function formatDate(iso: string, locale: string): string {');
    const next = await run({ 'src/utils/format.ts': format });
    const events = diffLive(base, next, ['src/utils/format.ts']);
    const [changed] = ofKind(events, 'signature-changed');
    // Real call-site data (query-core: SymbolEdge.argc): the one-argument call in UserCard is not updated yet.
    expect(changed).toMatchObject({ severity: 'error', message: 'formatDate() signature changed (1 importer, 1 call site not updated)', symbol: 'src/utils/format.ts#formatDate', detail: 'formatDate(iso) → formatDate(iso, locale)' });
    expect(changed.files).toEqual(['src/utils/format.ts', 'src/components/UserCard.tsx']);
    expect(staleCallCount(next, 'src/utils/format.ts#formatDate')).toBe(1);

    // It stays open while the call is stale and closes when the caller passes the new argument.
    const guard = new LiveGuard();
    expect(ofKind(guard.update(base, next, ['src/utils/format.ts']), 'signature-changed')).toHaveLength(1);
    expect(openProblemCount(guard.openProblems())).toBe(1);
    const card = read('src/components/UserCard.tsx').replace('formatDate(joinedAt)', "formatDate(joinedAt, 'en')");
    const fixed = await run({ 'src/utils/format.ts': format, 'src/components/UserCard.tsx': card });
    expect(staleCallCount(fixed, 'src/utils/format.ts#formatDate')).toBe(0);
    expect(ofKind(guard.update(next, fixed, ['src/components/UserCard.tsx']), 'signature-changed')).toEqual([
      expect.objectContaining({ severity: 'success', message: 'all calls of formatDate() updated', fingerprint: changed.fingerprint }),
    ]);
    expect(openProblemCount(guard.openProblems())).toBe(0);
    // Only for changed files: an edit of the same size and length that the watcher did not report is not one.
    const original = read('src/utils/format.ts');
    const grown = original.replace('formatDate(iso: string)', 'formatDate(iso: string, l: x)');
    const comment = '// Nobody imports this one';
    const sameSize = grown.replace(comment, comment.slice(0, comment.length - (grown.length - original.length)));
    expect(sameSize.length).toBe(original.length);
    const quiet = await run({ 'src/utils/format.ts': sameSize });
    expect(ofKind(diffLive(base, quiet, []), 'signature-changed')).toEqual([]);
    expect(ofKind(diffLive(base, quiet, ['src/utils/format.ts']), 'signature-changed')).toHaveLength(1);
  });

  it('a removed export that is still imported is an error', async () => {
    const format = read('src/utils/format.ts').replace(/export function formatDate[\s\S]*?\n}\n/, '');
    const next = await run({ 'src/utils/format.ts': format });
    const [removed] = ofKind(diffLive(base, next, ['src/utils/format.ts']), 'signature-changed');
    expect(removed).toMatchObject({ severity: 'error', message: 'formatDate removed but still imported by 1 file', files: ['src/utils/format.ts', 'src/components/UserCard.tsx'] });
  });

  it('a deleted file that is still imported is one error naming its importers', async () => {
    const next = await run({ 'src/utils/format.ts': null });
    const [deleted] = ofKind(diffLive(base, next, ['src/utils/format.ts']), 'signature-changed');
    expect(deleted).toMatchObject({ severity: 'error', message: 'src/utils/format.ts deleted but still imported by 3 files', detail: 'uses formatCurrency, formatDate, formatNumber' });
    expect([...deleted.files].sort()).toEqual(['src/components/UserCard.tsx', 'src/pages/Settings.tsx', 'src/utils/math.ts']);
    expect(ofKind(diffLive(base, next, ['src/utils/format.ts']), 'signature-changed')).toHaveLength(1);
  });

  it('editing a file no test reaches gives untested-change; tested files do not', async () => {
    const legacy = `${read('src/utils/legacyStorage.ts')}\nexport const LEGACY_VERSION = 2;\n`;
    const button = read('src/components/Button.tsx').replace('forwardRef', 'forwardRef ');
    const next = await run({ 'src/utils/legacyStorage.ts': legacy, 'src/components/Button.tsx': button });
    const events = diffLive(base, next, ['src/utils/legacyStorage.ts', 'src/components/Button.tsx']);
    expect(ofKind(events, 'untested-change')).toEqual([expect.objectContaining({ severity: 'warning', message: 'src/utils/legacyStorage.ts changed and no test reaches it', files: ['src/utils/legacyStorage.ts'] })]);
    // The new export nobody imports is worth knowing.
    expect(ofKind(events, 'unused-export')).toEqual([expect.objectContaining({ severity: 'info', message: 'LEGACY_VERSION is exported but nothing imports it', files: ['src/utils/legacyStorage.ts'] })]);
  });

  it('suppresses a repeated fingerprint until the problem is fixed, then announces the fix', async () => {
    const withCycle = await run({ 'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT });
    const guard = new LiveGuard();
    const first = guard.update(base, withCycle, ['src/api/client.ts']);
    expect(kinds(first)).toContain('cycle-added');
    expect(guard.openProblems().map((e) => e.kind)).toContain('cycle-added');
    // The same problem reported again (e.g. compared with an older analysis): quiet.
    expect(kinds(guard.update(base, withCycle, ['src/api/client.ts']))).not.toContain('cycle-added');
    // An unrelated save keeps it quiet as well.
    expect(kinds(guard.update(withCycle, withCycle, []))).toEqual([]);
    const fixed = guard.update(withCycle, base, ['src/api/client.ts']);
    expect(kinds(fixed)).toContain('cycle-fixed');
    expect(guard.openProblems().map((e) => e.kind)).not.toContain('cycle-added');
    // Once fixed, a new occurrence is news again.
    expect(kinds(guard.update(base, withCycle, ['src/api/client.ts']))).toContain('cycle-added');
    const feed = guard.feed(7);
    expect(feed.version).toBe(7);
    expect(feed.events.filter((e) => e.kind === 'cycle-added')).toHaveLength(2);
    // Still open: the cycle, and the edited file no test reaches.
    expect(feed.open.map((e) => e.kind).sort()).toEqual(['cycle-added', 'untested-change']);
  });

  it('with git, an untested file that is not part of your work (a revert) is not announced', async () => {
    const edited = await run({ 'src/utils/legacyStorage.ts': `${read('src/utils/legacyStorage.ts')}\n// edited\n` });
    const changes = (files: string[]) => ({ mode: 'working', files: files.map((id) => ({ id, status: 'modified', additions: 1, deletions: 0, lines: [], analyzed: true })) }) as unknown as ReportData['changes'];
    expect(kinds(diffLive(base, { ...edited, changes: changes(['src/utils/legacyStorage.ts']) }, ['src/utils/legacyStorage.ts']))).toContain('untested-change');
    expect(kinds(diffLive(edited, { ...base, changes: changes([]) }, ['src/utils/legacyStorage.ts']))).not.toContain('untested-change');
    // A clean working tree has no change set at all.
    const git = { commitsAnalyzed: 1 } as ReportData['git'];
    expect(kinds(diffLive(edited, { ...base, git, changes: undefined }, ['src/utils/legacyStorage.ts']))).not.toContain('untested-change');
  });

  it('repeats a complex function only once it grew clearly more than announced', async () => {
    const withBranches = (n: number) => {
      const branches = Array.from({ length: n }, (_, i) => `  if (value === ${i}) return '${i}';\n`).join('');
      return run({ 'src/utils/format.ts': read('src/utils/format.ts').replace('export function formatNumber(value: number): string {\n', `export function formatNumber(value: number): string {\n${branches}`) });
    };
    const [v13, v15, v19] = [await withBranches(12), await withBranches(14), await withBranches(18)];
    const guard = new LiveGuard();
    const up = (events: LiveEvent[]) => ofKind(events, 'complexity-up').map((e) => `${e.before} → ${e.after}`);
    expect(up(guard.update(base, v13, ['src/utils/format.ts']))).toEqual(['1 → 13']);
    expect(up(guard.update(v13, v15, ['src/utils/format.ts']))).toEqual([]);
    expect(up(guard.update(v15, v19, ['src/utils/format.ts']))).toEqual(['15 → 19']);
    expect(guard.openProblems().find((e) => e.kind === 'complexity-up')).toMatchObject({ after: 19 });
  });

  it('an untested file is announced once per session and closed when a test reaches it', async () => {
    const guard = new LiveGuard();
    const legacy = `${read('src/utils/legacyStorage.ts')}\n// edited\n`;
    const edited = await run({ 'src/utils/legacyStorage.ts': legacy });
    expect(kinds(guard.update(base, edited, ['src/utils/legacyStorage.ts']))).toContain('untested-change');
    const again = await run({ 'src/utils/legacyStorage.ts': `${legacy}// edited again\n` });
    expect(kinds(guard.update(edited, again, ['src/utils/legacyStorage.ts']))).not.toContain('untested-change');
    const test = "import { describe, it } from 'vitest';\nimport { loadLegacySettings } from './legacyStorage';\ndescribe('legacy', () => { it('loads', () => { loadLegacySettings(); }); });\n";
    const tested = await run({ 'src/utils/legacyStorage.ts': `${legacy}// edited again\n`, 'src/utils/legacyStorage.test.ts': test });
    const closing = guard.update(again, tested, ['src/utils/legacyStorage.test.ts']);
    expect(closing).toContainEqual(expect.objectContaining({ kind: 'untested-change', severity: 'success', message: 'src/utils/legacyStorage.ts is now reached by a test' }));
    expect(guard.openProblems()).toEqual([]);
  });

  it('filters out excluded kinds (options and serve.events.exclude)', async () => {
    const withCycle = await run({ 'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT });
    expect(kinds(diffLive(base, withCycle, ['src/api/client.ts'], { exclude: ['cycle-added'] }))).not.toContain('cycle-added');
    const config: CodeVisualizerConfig = { serve: { events: { exclude: ['cycle-added', 'health'] } } };
    const events = diffLive(base, withCycle, ['src/api/client.ts'], { config });
    expect(kinds(events)).not.toContain('cycle-added');
    expect(kinds(events)).not.toContain('health');
  });

  it('reports broken and fixed architecture rules with the head configuration', async () => {
    const config = JSON.stringify({ rules: [{ name: 'no-api-in-utils', from: 'src/utils/**', to: 'src/api/**' }] });
    const before = await run({ 'code-visualizer.config.json': config });
    const format = `import { fetchUsers } from '@/api/client';\nexport const users = fetchUsers;\n${read('src/utils/format.ts')}`;
    const after = await run({ 'code-visualizer.config.json': config, 'src/utils/format.ts': format });
    const parsed = normalizeConfig(JSON.parse(config)).config;
    const [broken] = ofKind(diffLive(before, after, ['src/utils/format.ts'], { config: parsed }), 'rule-violation');
    expect(broken).toMatchObject({ severity: 'error', message: 'rule no-api-in-utils broken in src/utils/format.ts:1', detail: 'imports src/api/client.ts', files: ['src/utils/format.ts', 'src/api/client.ts'], line: 1 });
    expect(liveEventLine(broken)).toBe('✖ rule no-api-in-utils broken in src/utils/format.ts:1');
    const [fixed] = ofKind(diffLive(after, before, ['src/utils/format.ts'], { config: parsed }), 'rule-fixed');
    expect(fixed).toMatchObject({ severity: 'success', fingerprint: broken.fingerprint });
    // A rule added to the configuration does not turn old imports into news.
    const ruleOnOld = JSON.stringify({ rules: [{ name: 'no-math-in-format', from: 'src/utils/format.ts', to: 'src/utils/math.ts' }] });
    const withRule = await run({ 'code-visualizer.config.json': ruleOnOld });
    expect(withRule.insights.ruleViolations).toHaveLength(1);
    expect(ofKind(diffLive(base, withRule, [], { config: normalizeConfig(JSON.parse(ruleOnOld)).config }), 'rule-violation')).toEqual([]);
  });

  it('a configuration typo is announced, keeps known rule breaks open, and breaks made meanwhile show up once it is fixed', async () => {
    const good = JSON.stringify({ rules: [{ name: 'no-api-in-utils', from: 'src/utils/**', to: 'src/api/**' }] });
    const typo = JSON.stringify({ rules: [{ name: 'no-api-in-utils', from: 'src/utils/**', to: 'src/api/**' }], serve: { events: { exclude: ['unused-exports'] } } });
    const parsed = (text: string) => normalizeConfig(JSON.parse(text)).config;
    const format = `import { fetchUsers } from '@/api/client';\nexport const users = fetchUsers;\n${read('src/utils/format.ts')}`;
    const legacy = `import { fetchUser } from '@/api/client';\nexport const user = fetchUser;\n${read('src/utils/legacyStorage.ts')}`;
    const guard = new LiveGuard();
    const step = (prev: ReportData, next: ReportData, changed: string[], config: string) => guard.update(prev, next, changed, { config: parsed(config) });
    const open = (kind: LiveEvent['kind']) => guard.openProblems().filter((e) => e.kind === kind);

    const s0 = await run({ 'code-visualizer.config.json': good });
    const s1 = await run({ 'code-visualizer.config.json': good, 'src/utils/format.ts': format });
    const [broken] = ofKind(step(s0, s1, ['src/utils/format.ts'], good), 'rule-violation');
    expect(broken).toMatchObject({ message: 'rule no-api-in-utils broken in src/utils/format.ts:1' });

    // The typo turns every rule off: said so, and the known violation is not "fixed" by it.
    const s2 = await run({ 'code-visualizer.config.json': typo, 'src/utils/format.ts': format });
    expect(s2.config?.error).toMatch(/did you mean "unused-export"/);
    const typoEvents = step(s1, s2, ['code-visualizer.config.json'], typo);
    expect(typoEvents).toEqual([expect.objectContaining({ kind: 'config', severity: 'warning', message: expect.stringMatching(/^configuration ignored — code-visualizer\.config\.json: .*did you mean "unused-export"/), files: ['code-visualizer.config.json'] })]);
    expect(open('rule-violation').map((e) => e.fingerprint)).toEqual([broken.fingerprint]);
    expect(open('config')).toHaveLength(1);
    expect(openProblemCount(guard.openProblems())).toBe(2);

    // A rule break made while the rules are off…
    const s3 = await run({ 'code-visualizer.config.json': typo, 'src/utils/format.ts': format, 'src/utils/legacyStorage.ts': legacy });
    expect(ofKind(step(s2, s3, ['src/utils/legacyStorage.ts'], typo), 'rule-violation')).toEqual([]);
    // …is announced once the configuration is repaired; the known one stays open without a repeat.
    const s4 = await run({ 'code-visualizer.config.json': good, 'src/utils/format.ts': format, 'src/utils/legacyStorage.ts': legacy });
    const repaired = step(s3, s4, ['code-visualizer.config.json'], good);
    expect(ofKind(repaired, 'config')).toEqual([expect.objectContaining({ severity: 'success', message: 'configuration is valid again' })]);
    expect(ofKind(repaired, 'rule-violation').map((e) => e.message)).toEqual(['rule no-api-in-utils broken in src/utils/legacyStorage.ts:1']);
    expect(kinds(repaired)).not.toContain('health');
    expect(open('rule-violation')).toHaveLength(2);
    expect(open('config')).toEqual([]);

    // The rule taken out closes them quietly; put back, they are announced again.
    const none = JSON.stringify({});
    const s5 = await run({ 'code-visualizer.config.json': none, 'src/utils/format.ts': format, 'src/utils/legacyStorage.ts': legacy });
    expect(ofKind(step(s4, s5, ['code-visualizer.config.json'], none), 'rule-fixed')).toEqual([]);
    expect(open('rule-violation')).toEqual([]);
    const back = step(s5, s4, ['code-visualizer.config.json'], good);
    expect(ofKind(back, 'rule-violation')).toHaveLength(2);
    expect(open('rule-violation')).toHaveLength(2);
  });

  it('closes with a health event when the score moves by a point or more', async () => {
    const withCycle = await run({ 'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT });
    // The new cycle costs modularity on this fixture.
    expect(withCycle.health.score).toBeLessThan(base.health.score);
    const events = diffLive(base, withCycle, ['src/api/client.ts']);
    expect(ofKind(events, 'health')).toEqual([
      expect.objectContaining({ severity: 'warning', before: base.health.score, after: withCycle.health.score, message: `health ${base.health.score} → ${withCycle.health.score}`, detail: expect.stringContaining('Modularity') }),
    ]);
    expect(events[events.length - 1].kind).toBe('health');
    expect(diffLive(base, base, [])).toEqual([]);
  });

  it('compares health on shared categories: a what-if analysis without git is no drop', async () => {
    // As with engine.whatIf: the current analysis has a git-only category the what-if one lacks.
    const knowledge = { id: 'knowledge', label: 'Knowledge spread', score: 100, weight: 10, detail: '' } as ReportData['health']['categories'][number];
    const categories = [...base.health.categories, knowledge];
    const weight = categories.reduce((n, c) => n + c.weight, 0);
    const score = Math.round(categories.reduce((n, c) => n + c.score * c.weight, 0) / weight);
    expect(score).not.toBe(base.health.score);
    const current = { ...base, health: { ...base.health, score, categories } } as ReportData;
    expect(ofKind(diffLive(current, base, ['src/App.tsx']), 'health')).toEqual([]);
  });

  /* ------------------------- Multi-step: open → resolve ------------------------ */

  it('a removed export imported through a barrel stays open until every importer is fixed', async () => {
    const card = read('src/components/Card.tsx');
    const renamed = card.replace('export function Card(', 'export function Card2(');
    const step1 = await run({ 'src/components/Card.tsx': renamed });
    const guard = new LiveGuard();
    const [removed] = ofKind(guard.update(base, step1, ['src/components/Card.tsx']), 'signature-changed');
    // UserCard directly, Settings and Reports through `export * from './Card'` in components/index.ts.
    expect(removed).toMatchObject({ severity: 'error', message: 'Card removed but still imported by 3 files' });
    expect(liveImporters(step1, 'src/components/Card.tsx', 'Card')).toEqual(['src/components/UserCard.tsx', 'src/pages/Settings.tsx', 'src/pages/admin/Reports.tsx']);
    // Only the direct importer is updated: the barrel importers still break.
    const userCard = read('src/components/UserCard.tsx').replace("import { Card } from './Card';", "import { Card2 as Card } from './Card';");
    const step2 = await run({ 'src/components/Card.tsx': renamed, 'src/components/UserCard.tsx': userCard });
    const partial = guard.update(step1, step2, ['src/components/UserCard.tsx']);
    expect(ofKind(partial, 'signature-changed')).toEqual([]);
    expect(guard.openProblems().map((e) => e.fingerprint)).toContain(removed.fingerprint);
    // Exported again: said so, not "nothing imports it".
    const step3 = await run({ 'src/components/UserCard.tsx': userCard.replace('Card2 as Card', 'Card') });
    expect(ofKind(guard.update(step2, step3, ['src/components/Card.tsx', 'src/components/UserCard.tsx']), 'signature-changed')).toEqual([
      expect.objectContaining({ severity: 'success', message: 'Card is exported again', fingerprint: removed.fingerprint }),
    ]);
    expect(guard.openProblems().map((e) => e.fingerprint)).not.toContain(removed.fingerprint);
  });

  it('a namespace importer keeps a removed export open; dropping the import closes it', async () => {
    const ns = "import * as fmt from './format';\nexport const day = (iso: string) => fmt.formatDate(iso);\n";
    const withNs = await run({ 'src/utils/dates.ts': ns });
    const format = read('src/utils/format.ts').replace('export function formatDate(', 'function formatDate(');
    const removed = await run({ 'src/utils/dates.ts': ns, 'src/utils/format.ts': format });
    const guard = new LiveGuard();
    expect(ofKind(guard.update(withNs, removed, ['src/utils/format.ts']), 'signature-changed')).toEqual([expect.objectContaining({ severity: 'error', message: 'formatDate removed but still imported by 2 files' })]);
    const userCard = read('src/components/UserCard.tsx').replace("import { formatDate } from '@/utils/format';\n", '').replace('{formatDate(joinedAt)}', '{joinedAt}');
    const direct = await run({ 'src/utils/dates.ts': ns, 'src/utils/format.ts': format, 'src/components/UserCard.tsx': userCard });
    expect(ofKind(guard.update(removed, direct, ['src/components/UserCard.tsx']), 'signature-changed')).toEqual([]);
    const none = await run({ 'src/utils/dates.ts': 'export const day = (iso: string) => iso;\n', 'src/utils/format.ts': format, 'src/components/UserCard.tsx': userCard });
    expect(ofKind(guard.update(direct, none, ['src/utils/dates.ts']), 'signature-changed')).toEqual([expect.objectContaining({ severity: 'success', message: 'nothing imports the removed formatDate any more' })]);
    expect(openProblemCount(guard.openProblems())).toBe(0); // edited untested files stay listed as nudges
  });

  it('removing a named export of a lazily loaded page is no error (import() loads the default)', async () => {
    const settings = `${read('src/pages/Settings.tsx')}\nexport const extra = 1;\n`;
    const withExtra = await run({ 'src/pages/Settings.tsx': settings });
    const without = await run({ 'src/pages/Settings.tsx': settings.replace('\nexport const extra = 1;\n', '\n') });
    expect(ofKind(diffLive(withExtra, without, ['src/pages/Settings.tsx']), 'signature-changed')).toEqual([]);
    expect(liveImporters(without, 'src/pages/Settings.tsx', 'extra')).toEqual([]);
    expect(liveImporters(without, 'src/pages/Settings.tsx', 'default')).toEqual(['src/App.tsx']);
  });

  it('undoing a signature change is announced as restored, not as another change', async () => {
    const changed = await run({ 'src/utils/format.ts': read('src/utils/format.ts').replace('formatDate(iso: string)', 'formatDate(iso: string, locale: string)') });
    const guard = new LiveGuard();
    const [first] = ofKind(guard.update(base, changed, ['src/utils/format.ts']), 'signature-changed');
    expect(first).toMatchObject({ severity: 'error', message: 'formatDate() signature changed (1 importer, 1 call site not updated)' });
    const [undo] = ofKind(guard.update(changed, base, ['src/utils/format.ts']), 'signature-changed');
    expect(undo).toMatchObject({ severity: 'success', message: 'formatDate() signature restored', fingerprint: first.fingerprint });
    // A fresh change after the undo is news again.
    expect(ofKind(guard.update(base, changed, ['src/utils/format.ts']), 'signature-changed')).toEqual([expect.objectContaining({ severity: 'error' })]);
  });

  it('a deleted file is an error until its importers are fixed; its cycle is not "fixed" by the broken import', async () => {
    const guard = new LiveGuard();
    const deleted = await run({ 'src/utils/format.ts': null });
    const step1 = guard.update(base, deleted, ['src/utils/format.ts']);
    expect(ofKind(step1, 'signature-changed')).toEqual([expect.objectContaining({ severity: 'error', message: 'src/utils/format.ts deleted but still imported by 3 files', line: 2 })]);
    // math.ts ↔ format.ts went away only because math.ts's import broke.
    expect(ofKind(step1, 'cycle-fixed')).toEqual([]);
    expect(brokenImports(base, deleted).map((b) => b.importer).sort()).toEqual(['src/components/UserCard.tsx', 'src/pages/Settings.tsx', 'src/utils/math.ts']);
    // The importers stop using it: now the cycle is really gone, and the file is no longer imported.
    const math = read('src/utils/math.ts').replace("import { formatNumber } from './format';\n", '').replace('formatNumber(clamp((value / total) * 100, 0, 100))', 'String(clamp((value / total) * 100, 0, 100))');
    const userCard = read('src/components/UserCard.tsx').replace("import { formatDate } from '@/utils/format';\n", '').replace('{formatDate(joinedAt)}', '{joinedAt}');
    const settings = read('src/pages/Settings.tsx').replace("import { formatCurrency } from '@/utils/format';\n", '').replace(/formatCurrency\(/g, 'String(');
    const fixed = await run({ 'src/utils/format.ts': null, 'src/utils/math.ts': math, 'src/components/UserCard.tsx': userCard, 'src/pages/Settings.tsx': settings });
    const step2 = guard.update(deleted, fixed, ['src/utils/math.ts', 'src/components/UserCard.tsx', 'src/pages/Settings.tsx']);
    expect(step2).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'signature-changed', severity: 'success', message: 'nothing imports the deleted src/utils/format.ts any more' }),
        expect.objectContaining({ kind: 'cycle-fixed', severity: 'success', files: expect.arrayContaining(['src/utils/format.ts', 'src/utils/math.ts']) }),
      ]),
    );
    expect(guard.openProblems().filter((e) => e.kind === 'signature-changed')).toEqual([]);
  });

  it('a file moved without updating its importers is an error, and the old cycle coming back is not news', async () => {
    const guard = new LiveGuard();
    // The same content under another name: compareReports pairs it as a rename.
    const moved = await run({ 'src/utils/format.ts': null, 'src/utils/formatting.ts': read('src/utils/format.ts') });
    const step1 = guard.update(base, moved, ['src/utils/format.ts', 'src/utils/formatting.ts']);
    expect(ofKind(step1, 'signature-changed')).toEqual([expect.objectContaining({ severity: 'error', message: 'src/utils/format.ts moved to src/utils/formatting.ts but 3 files still import the old path' })]);
    // Artifacts of the broken imports are no news: the cycle is not fixed, the exports not unused, health not better.
    expect(kinds(step1)).not.toContain('cycle-fixed');
    expect(kinds(step1)).not.toContain('unused-export');
    expect(kinds(step1)).not.toContain('health');
    // (With git the broken import lifts modularity; the same lift without a broken import is announced.)
    const lift = (r: ReportData): ReportData => ({ ...r, health: { ...r.health, categories: r.health.categories.map((c) => (c.id === 'modularity' ? { ...c, score: c.score - 20 } : c)) } });
    expect(ofKind(diffLive(lift(base), moved, ['src/utils/format.ts', 'src/utils/formatting.ts']), 'health')).toEqual([]);
    expect(ofKind(diffLive(lift(base), base, ['src/App.tsx']), 'health')).toHaveLength(1);
    // The importers follow: the format ↔ math cycle is back under the new name — old debt, not a new cycle.
    const math = read('src/utils/math.ts').replace("from './format'", "from './formatting'");
    const userCard = read('src/components/UserCard.tsx').replace("'@/utils/format'", "'@/utils/formatting'");
    const settings = read('src/pages/Settings.tsx').replace("'@/utils/format'", "'@/utils/formatting'");
    const updated = await run({ 'src/utils/format.ts': null, 'src/utils/formatting.ts': read('src/utils/format.ts'), 'src/utils/math.ts': math, 'src/components/UserCard.tsx': userCard, 'src/pages/Settings.tsx': settings });
    expect(updated.insights.cycles.some((c) => c.includes('src/utils/formatting.ts'))).toBe(true);
    const step2 = guard.update(moved, updated, ['src/utils/math.ts', 'src/components/UserCard.tsx', 'src/pages/Settings.tsx']);
    expect(kinds(step2)).not.toContain('cycle-added');
    expect(kinds(step2)).not.toContain('cycle-fixed');
    expect(kinds(step2)).not.toContain('health');
    expect(ofKind(step2, 'signature-changed')).toEqual([expect.objectContaining({ severity: 'success', message: 'imports of the moved src/utils/format.ts updated' })]);
    expect(openProblemCount(guard.openProblems())).toBe(0);
  });

  it('a session cycle that grows and shrinks back stays open until it is fixed', async () => {
    const guard = new LiveGuard();
    const client = read('src/api/client.ts');
    const step1 = await run({ 'src/api/client.ts': client + CYCLE_IMPORT });
    expect(kinds(guard.update(base, step1, ['src/api/client.ts']))).toContain('cycle-added');
    const cyclesOpen = () => guard.openProblems().filter((e) => e.kind === 'cycle-added');
    expect(cyclesOpen()).toHaveLength(1);
    // legacyStorage joins the cycle: a new (bigger) cycle, still one problem.
    const legacy = `import { fetchUsers } from '@/api/client';\nexport const legacyUsers = fetchUsers;\n${read('src/utils/legacyStorage.ts')}`;
    const clientAndLegacy = `${client}${CYCLE_IMPORT}import { loadLegacySettings } from '@/utils/legacyStorage';\nexport const legacy = loadLegacySettings;\n`;
    const step2 = await run({ 'src/api/client.ts': clientAndLegacy, 'src/utils/legacyStorage.ts': legacy });
    expect(step2.insights.cycles.some((c) => c.length === 3)).toBe(true);
    const grown = guard.update(step1, step2, ['src/api/client.ts', 'src/utils/legacyStorage.ts']);
    expect(ofKind(grown, 'cycle-added')).toHaveLength(1);
    expect(cyclesOpen()).toHaveLength(1);
    // legacyStorage leaves again: the client ↔ useUsers cycle of this session is still there.
    const step3 = await run({ 'src/api/client.ts': clientAndLegacy, 'src/utils/legacyStorage.ts': read('src/utils/legacyStorage.ts') });
    expect(kinds(guard.update(step2, step3, ['src/utils/legacyStorage.ts']))).not.toContain('cycle-fixed');
    expect(cyclesOpen()).toHaveLength(1);
    expect(openProblemCount(guard.openProblems())).toBeGreaterThanOrEqual(1);
    // Fixed for real.
    const step4 = await run({});
    expect(kinds(guard.update(step3, step4, ['src/api/client.ts']))).toContain('cycle-fixed');
    expect(cyclesOpen()).toEqual([]);
  });

  it('a new cycle starts at the file whose new import closed it, at that line', async () => {
    const chain = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`src/chain/c${i + 1}.ts`, i < 6 ? `import { v${i + 2} } from './c${i + 2}';\nexport const v${i + 1} = () => v${i + 2}();\n` : 'export const v7 = () => 7;\n']),
    );
    const before = await run(chain);
    const closing = { ...chain, 'src/chain/c7.ts': "// closes the loop\nimport { v1 } from './c1';\nexport const v7 = () => v1();\n" };
    const after = await run(closing);
    const [cycle] = ofKind(diffLive(before, after, ['src/chain/c7.ts']), 'cycle-added');
    expect(cycle.message).toBe('new cycle: src/chain/c7.ts → src/chain/c1.ts → src/chain/c2.ts → src/chain/c3.ts → src/chain/c4.ts → … (+2 more) → src/chain/c7.ts');
    expect(cycle.files[0]).toBe('src/chain/c7.ts');
    expect(cycle.files).toHaveLength(7);
    expect(cycle.line).toBe(2);
    expect(liveEventLine(cycle)).toBe(`✖ ${cycle.message}`);
  });

  it('a missing dependency stays open until it is declared', async () => {
    const guard = new LiveGuard();
    const math = `import chunk from 'lodash/chunk';\nexport const pairs = (xs: number[]) => chunk(xs, 2);\n${read('src/utils/math.ts')}`;
    const step1 = await run({ 'src/utils/math.ts': math });
    const [missing] = ofKind(guard.update(base, step1, ['src/utils/math.ts']), 'missing-dependency');
    expect(missing).toMatchObject({ severity: 'error', message: '"lodash" is imported but not declared in package.json', files: ['src/utils/math.ts'] });
    expect(ofKind(guard.update(step1, step1, ['src/utils/math.ts']), 'missing-dependency')).toEqual([]);
    const pkg = JSON.parse(read('package.json'));
    pkg.dependencies.lodash = '^4.17.21';
    const step2 = await run({ 'src/utils/math.ts': math, 'package.json': JSON.stringify(pkg, null, 2) });
    expect(ofKind(guard.update(step1, step2, ['package.json']), 'missing-dependency')).toEqual([expect.objectContaining({ severity: 'success', message: '"lodash" is declared now', fingerprint: missing.fingerprint })]);
    expect(guard.openProblems().filter((e) => e.kind === 'missing-dependency')).toEqual([]);
  });

  it('new unused exports in many files at once are one event', async () => {
    const files = ['src/utils/math.ts', 'src/utils/legacyStorage.ts', 'src/api/client.ts', 'src/hooks/useUsers.ts', 'src/types.ts'];
    const next = await run(Object.fromEntries(files.map((f, i) => [f, `${read(f)}\nexport const extra${i} = ${i};\n`])));
    const unused = ofKind(diffLive(base, next, files), 'unused-export');
    expect(unused).toEqual([expect.objectContaining({ severity: 'info', message: '5 new exports in 5 files that nothing imports', files: [...files].sort() })]);
    expect(unused[0].detail).toContain('extra0');
  });

  it('open problems do not keep the analyses they were found in alive', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const guard = new LiveGuard();
    let ref: WeakRef<ReportData> | undefined;
    await (async () => {
      const overlay = {
        'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT,
        'src/utils/legacyStorage.ts': `${read('src/utils/legacyStorage.ts')}\n// edited\n`,
        'src/utils/format.ts': read('src/utils/format.ts').replace('export function formatDate(', 'function formatDate('),
      };
      // No shared cache: nothing but the guard could hold on to this analysis.
      const next = await analyze({ root, overlay, git: false, includeSource: false, history: false });
      const events = guard.update(base, next, Object.keys(overlay));
      expect(kinds(events)).toEqual(expect.arrayContaining(['cycle-added', 'untested-change', 'signature-changed']));
      ref = new WeakRef(next);
    })();
    expect(guard.openProblems().length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3 && ref!.deref(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      gc();
    }
    expect(ref!.deref()).toBeUndefined();
  });

  it('compareReports scoped to the changed files agrees with the full comparison on what the guard reads', async () => {
    const branches = Array.from({ length: 12 }, (_, i) => `  if (value === ${i}) return '${i}';\n`).join('');
    const overlays: Overlay[] = [
      {
        'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT,
        'src/utils/format.ts': read('src/utils/format.ts').replace('export function formatDate(', 'function formatDate(').replace('export function formatNumber(value: number): string {\n', `export function formatNumber(value: number): string {\n${branches}`),
        'src/components/Card.tsx': read('src/components/Card.tsx').replace('export function Card(', 'export function Card2('),
      },
      { 'src/utils/format.ts': null, 'src/utils/formatting.ts': read('src/utils/format.ts') },
      { 'src/utils/math.ts': read('src/utils/math.ts').replace("import { formatNumber } from './format';\n", '').replace('formatNumber(clamp((value / total) * 100, 0, 100))', 'String(clamp((value / total) * 100, 0, 100))') },
    ];
    for (const overlay of overlays) {
      const next = await run(overlay);
      const touched = touchedFiles(base, next, Object.keys(overlay));
      const full = compareReports(base, next);
      const scoped = compareReports(base, next, { changedFiles: touched, areas: false });
      expect(scoped.areaEdges).toEqual([]);
      for (const key of ['newEdges', 'removedEdges', 'newCycles', 'fixedCycles', 'newViolations', 'fixedViolations', 'complexity', 'newUnusedExports', 'health', 'renamed', 'fingerprints', 'routes', 'newMissingDependencies'] as const) {
        expect(scoped[key]).toEqual(full[key]);
      }
      expect(scoped.exports).toEqual(full.exports.filter((e) => touched.has(e.file)));
      if (overlay === overlays[0]) expect(scoped.exports.length).toBeGreaterThan(0);
    }
  });

  it('limits the events of one update and sums up the rest', async () => {
    const withCycle = await run({ 'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT, 'src/utils/legacyStorage.ts': `${read('src/utils/legacyStorage.ts')}\nexport const A = 1;\n` });
    const all = diffLive(base, withCycle, ['src/api/client.ts', 'src/utils/legacyStorage.ts']);
    expect(all.length).toBeGreaterThan(2);
    const limited = diffLive(base, withCycle, ['src/api/client.ts', 'src/utils/legacyStorage.ts'], { maxEvents: 2 });
    const rest = limited.filter((e) => e.kind !== 'health');
    expect(rest).toHaveLength(2);
    expect(rest[1].message).toMatch(/^… and \d+ more changes? \(see the report\)$/);
  });

  it('touchedFiles: reported, added, deleted and resized files', async () => {
    const next = await run({ 'src/utils/legacyStorage.ts': null, 'src/utils/extra.ts': 'export const x = 1;\n', 'src/types.ts': `${read('src/types.ts')}\n` });
    const touched = touchedFiles(base, next, ['src/App.tsx', 'not/analyzed.md']);
    expect([...touched].sort()).toEqual(['src/App.tsx', 'src/types.ts', 'src/utils/extra.ts', 'src/utils/legacyStorage.ts']);
  });

  it('staleCallCount counts calls whose argument count no longer fits (with call-site data)', () => {
    const report = {
      files: [{ id: 'a.ts', symbols: [{ id: 'a.ts#f', name: 'f', kind: 'function', params: [{ name: 'x' }, { name: 'y' }] }] }],
      symbolEdges: [{ source: 'b.ts#g', target: 'a.ts#f', kind: 'calls', count: 3, lines: [1, 2, 3], argc: [1, 2, -1] }],
    } as unknown as ReportData;
    expect(staleCallCount(report, 'a.ts#f')).toBe(1);
    expect(staleCallCount(report, 'a.ts#missing')).toBe(0);
  });
});

describe('removed routes (fullstack-next)', () => {
  it('a removed route that is still called is an error until it is back', async () => {
    const root = copyFixture('fullstack-next', 'cv-live-');
    const cache = createAnalyzeCache();
    const run = (overlay?: Overlay): Promise<ReportData> => analyze({ root, overlay, git: false, includeSource: false, history: false, cache });
    const base = await run();
    const gone = await run({ 'app/api/users/[id]/route.ts': null });
    const guard = new LiveGuard();
    const removed = ofKind(guard.update(base, gone, ['app/api/users/[id]/route.ts']), 'route-removed');
    expect(removed.map((e) => `${e.severity} ${e.message}`).sort()).toEqual(['error DELETE /api/users/[id] removed but still called from 2 places', 'error GET /api/users/[id] removed but still called from 1 place']);
    const get = removed.find((e) => e.message.startsWith('GET'))!;
    expect(get.files).toEqual(['lib/users-client.ts']);
    expect(get.line).toBeGreaterThan(0);
    expect(guard.openProblems().filter((e) => e.kind === 'route-removed')).toHaveLength(2);
    // Still gone after an unrelated save: quiet.
    expect(ofKind(guard.update(gone, gone, ['lib/format.ts']), 'route-removed')).toEqual([]);
    const back = ofKind(guard.update(gone, base, ['app/api/users/[id]/route.ts']), 'route-removed');
    expect(back.map((e) => `${e.severity} ${e.message}`).sort()).toEqual(['success DELETE /api/users/[id] is back', 'success GET /api/users/[id] is back']);
    expect(guard.openProblems().filter((e) => e.kind === 'route-removed')).toEqual([]);
  });

  it('a handler that a test requests over HTTP counts as tested, like tests-for says', async () => {
    const root = copyFixture('fullstack-next', 'cv-live-');
    const cache = createAnalyzeCache();
    const run = (overlay?: Overlay): Promise<ReportData> => analyze({ root, overlay, git: false, includeSource: false, history: false, cache });
    const base = await run();
    const handler = 'app/api/users/[id]/route.ts';
    // No test imports it, but test/users.test.ts sends DELETE /api/users/1.
    expect(base.files.find((f) => f.id === handler)?.tests ?? []).toEqual([]);
    expect(query.testsFor(base, [handler]).untested).toEqual([]);
    const edited = await run({ [handler]: `${fs.readFileSync(path.join(root, handler), 'utf8')}\n// edited\n` });
    expect(ofKind(diffLive(base, edited, [handler]), 'untested-change')).toEqual([]);
    // release fixes: so is what that handler imports (`code-visualizer test` selects the test for it: route-e2e).
    const billing = await run({ 'lib/billing.ts': `${fs.readFileSync(path.join(root, 'lib/billing.ts'), 'utf8')}\n// edited\n` });
    expect(ofKind(diffLive(base, billing, ['lib/billing.ts']), 'untested-change')).toEqual([]);
    // A file no test reaches in any way is still a nudge…
    const client = 'lib/users-client.ts';
    const edit = { [client]: `${fs.readFileSync(path.join(root, client), 'utf8')}\nexport const RETRIES = 2;\n` };
    const nudged = await run(edit);
    expect(ofKind(diffLive(base, nudged, [client]), 'untested-change')).toEqual([expect.objectContaining({ message: `${client} changed and no test reaches it` })]);
    // …unless the coverage report saw its lines run (query.testEvidence, as the change risk and My changes say).
    const covered = { ...nudged, files: nudged.files.map((f) => (f.id === client ? { ...f, coverage: { lines: { total: 9, covered: 9 }, uncovered: [], source: 'lcov' as const } } : f)) };
    expect(ofKind(diffLive(base, covered, [client]), 'untested-change')).toEqual([]);
  });
});

// --- release fixes: the feed agrees with the Architecture changes card from the first analysis on ---
describe('LiveGuard.seed and open messages', () => {
  let root: string;
  let cache: AnalyzeCache;
  let base: ReportData;
  const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
  const run = (overlay?: Overlay): Promise<ReportData> => analyze({ root, overlay, git: false, includeSource: false, history: false, cache });

  beforeAll(async () => {
    root = copyFixture('react-vite-ts', 'cv-seed-');
    // A second caller of formatDate, so a signature change leaves two call sites to update.
    fs.writeFileSync(path.join(root, 'src/utils/stamp.ts'), "import { formatDate } from './format';\n\nexport const stamp = (iso: string): string => formatDate(iso);\n");
    cache = createAnalyzeCache();
    base = await run();
  });

  it('a guard started on work that already has a new cycle reports it open, without an event', async () => {
    const withCycle = await run({ 'src/api/client.ts': read('src/api/client.ts') + CYCLE_IMPORT });
    // The first analysis of `serve` on a branch: its delta against the base lists the cycle.
    const first: ReportData = { ...withCycle, changes: { ...(withCycle.changes ?? ({ mode: 'working', files: [] } as never)), delta: compareReports(base, withCycle) } };
    expect(first.changes!.delta!.newCycles).toHaveLength(1);
    const guard = new LiveGuard();
    guard.seed(first, { version: 1 });
    expect(guard.feed(1)).toMatchObject({ events: [], open: [expect.objectContaining({ kind: 'cycle-added', severity: 'error' })] });
    expect(openProblemCount(guard.feed(1).open)).toBe(1);
    // A save that leaves it in place says nothing about it; fixing it is announced and closes it.
    const again = await run({ 'src/api/client.ts': `${read('src/api/client.ts') + CYCLE_IMPORT}// still\n` });
    expect(ofKind(guard.update(first, again, ['src/api/client.ts']), 'cycle-added')).toEqual([]);
    expect(ofKind(guard.openProblems(), 'cycle-added')).toHaveLength(1);
    expect(ofKind(guard.update(again, base, ['src/api/client.ts']), 'cycle-fixed')).toHaveLength(1);
    expect(ofKind(guard.openProblems(), 'cycle-added')).toEqual([]);
    // Nothing to seed without a delta.
    const empty = new LiveGuard();
    empty.seed(base);
    expect(empty.openProblems()).toEqual([]);
  });

  it('seeds breaking exports with calls not updated, and an open message follows the calls that are left', async () => {
    const format = read('src/utils/format.ts').replace('export function formatDate(iso: string): string {', 'export function formatDate(iso: string, locale: string): string {');
    const next = await run({ 'src/utils/format.ts': format });
    expect(staleCallCount(next, 'src/utils/format.ts#formatDate')).toBe(2);
    const guard = new LiveGuard();
    const [changed] = ofKind(guard.update(base, next, ['src/utils/format.ts']), 'signature-changed');
    expect(changed.message).toBe('formatDate() signature changed (2 importers, 2 call sites not updated)');
    // One of the two callers is fixed: still open, and it says so.
    const stamp = "import { formatDate } from './format';\n\nexport const stamp = (iso: string): string => formatDate(iso, 'en');\n";
    const oneLeft = await run({ 'src/utils/format.ts': format, 'src/utils/stamp.ts': stamp });
    expect(staleCallCount(oneLeft, 'src/utils/format.ts#formatDate')).toBe(1);
    expect(ofKind(guard.update(next, oneLeft, ['src/utils/stamp.ts']), 'signature-changed')).toEqual([]);
    expect(ofKind(guard.openProblems(), 'signature-changed').map((e) => e.message)).toEqual(['formatDate() signature changed (2 importers, 1 call site not updated)']);
    // The feed keeps what was said at the time.
    expect(guard.feed().events.map((e) => e.message)).toContain('formatDate() signature changed (2 importers, 2 call sites not updated)');
    // A guard that starts on this work seeds the same problem, quietly.
    const seeded = new LiveGuard();
    seeded.seed({ ...next, changes: { mode: 'working', files: [], delta: compareReports(base, next) } as never });
    expect(seeded.feed().events).toEqual([]);
    expect(seeded.openProblems()).toEqual([expect.objectContaining({ kind: 'signature-changed', message: 'formatDate() signature changed (2 importers, 2 call sites not updated)' })]);
    expect(ofKind(seeded.update(next, oneLeft, ['src/utils/stamp.ts']), 'signature-changed')).toEqual([]);
    expect(ofKind(seeded.openProblems(), 'signature-changed')[0].message).toBe('formatDate() signature changed (2 importers, 1 call site not updated)');
  });
});

describe('live event helpers', () => {
  const event = (over: Partial<LiveEvent>): LiveEvent => ({ id: '1', at: 0, kind: 'cycle-added', severity: 'error', message: 'new cycle: a.ts → b.ts → a.ts', files: ['a.ts', 'b.ts'], fingerprint: 'f', ...over });

  it('shortens long cycles', () => {
    expect(cyclePath(['a', 'b'])).toBe('a → b → a');
    expect(cyclePath(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])).toBe('a → b → c → d → e → … (+3 more) → a');
  });

  it('marks, orders and counts events', () => {
    expect(liveMarker(event({}))).toBe('✖');
    expect(liveMarker(event({ kind: 'complexity-up', severity: 'warning' }))).toBe('▲');
    expect(liveMarker(event({ kind: 'complexity-down', severity: 'info' }))).toBe('▼');
    expect(liveMarker(event({ kind: 'cycle-fixed', severity: 'success' }))).toBe('✔');
    expect(liveMarker(event({ kind: 'untested-change', severity: 'warning' }))).toBe('!');
    expect(liveMarker(event({ kind: 'health', severity: 'warning' }))).toBe('');
    const list = [event({ id: 'a', severity: 'info' }), event({ id: 'b', severity: 'warning' }), event({ id: 'c', severity: 'error' }), event({ id: 'd', severity: 'error' })];
    expect(topEvent(list)?.id).toBe('c');
    expect(topEvent([])).toBeUndefined();
    expect(openProblemCount(list)).toBe(3);
    // Untested edits stay listed but are not counted as problems.
    expect(openProblemCount([...list, event({ kind: 'untested-change', severity: 'warning' })])).toBe(3);
    expect(liveEventLine(event({ kind: 'health', severity: 'success', message: 'health 80 → 82', files: [] }))).toBe('health 80 → 82');
  });

  it('formats coloured terminal lines without losing the text', () => {
    const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');
    expect(strip(formatLiveEvent(event({})))).toBe('✖ new cycle: a.ts → b.ts → a.ts');
    expect(strip(formatLiveEvent(event({ kind: 'complexity-up', severity: 'warning', message: 'f() complexity 12 → 19', files: ['src/f.ts'], line: 4 })))).toBe('▲ f() complexity 12 → 19 · src/f.ts:4');
    expect(strip(formatLiveEvent(event({ kind: 'health', severity: 'warning', message: 'health 82 → 80', detail: 'Modularity 90 → 80', files: [] })))).toBe('health 82 → 80 (Modularity 90 → 80)');
  });

  it('prints what changed on a second line for signatures and rule breaks', () => {
    const strip = (s?: string): string | undefined => s?.replace(/\x1b\[[0-9;]*m/g, '');
    expect(strip(formatLiveDetail(event({ kind: 'signature-changed', severity: 'warning', message: 'formatDate() signature changed (1 importer)', detail: 'formatDate(iso) → formatDate(iso, locale)' })))).toBe('formatDate(iso) → formatDate(iso, locale)');
    expect(strip(formatLiveDetail(event({ kind: 'rule-violation', detail: 'imports lib/db.ts — Components may only import the public lib modules' })))).toBe('imports lib/db.ts — Components may only import the public lib modules');
    expect(formatLiveDetail(event({}))).toBeUndefined();
    expect(formatLiveDetail(event({ kind: 'health', severity: 'warning', detail: 'Modularity 90 → 80' }))).toBeUndefined();
    expect(formatLiveDetail(event({ kind: 'rule-fixed', severity: 'success', detail: 'no longer imports x' }))).toBeUndefined();
  });

  it('reads --notify=<mode> and --notify <mode> (unless that is a directory)', () => {
    const none = () => false;
    expect(extractNotifyMode(['--notify=all'], none)).toEqual({ argv: ['--notify'], mode: 'all' });
    expect(extractNotifyMode(['.', '--notify', 'Errors', '--port', '5000'], none)).toEqual({ argv: ['.', '--notify', '--port', '5000'], mode: 'errors' });
    expect(extractNotifyMode(['--notify', 'all'], () => true)).toEqual({ argv: ['--notify', 'all'], mode: undefined });
    expect(extractNotifyMode(['--notify', 'app'], none)).toEqual({ argv: ['--notify', 'app'], mode: undefined });
    expect(extractNotifyMode(['--', '--notify=all'], none)).toEqual({ argv: ['--', '--notify=all'], mode: undefined });
    expect(() => extractNotifyMode(['--notify=loud'], none)).toThrow(UsageError);
    expect(notifyModeFrom({ notify: true, mode: 'all' }, 'off')).toBe('all');
    expect(notifyModeFrom({ notify: true, mode: 'errors' }, 'all')).toBe('errors');
    expect(notifyModeFrom({ 'no-notify': true, mode: 'all' }, undefined)).toBe('off');
  });

  it('decides the notification mode from flags and configuration', () => {
    expect(notifyModeFrom({}, undefined)).toBe('off');
    expect(notifyModeFrom({}, 'all')).toBe('all');
    expect(notifyModeFrom({ notify: true }, undefined)).toBe('errors');
    expect(notifyModeFrom({ notify: true }, 'off')).toBe('errors');
    expect(notifyModeFrom({ notify: true }, 'all')).toBe('all');
    expect(notifyModeFrom({ 'no-notify': true, notify: true }, 'all')).toBe('off');
  });
});

describe('serve configuration block', () => {
  it('accepts strings, lists and objects', () => {
    expect(normalizeConfig({ serve: { notify: 'errors', events: { exclude: ['health', 'unused-export'] } } })).toEqual({ config: { serve: { notify: 'errors', events: { exclude: ['health', 'unused-export'] } } } });
    expect(normalizeConfig({ serve: { notify: true, events: { exclude: 'health, unused-export' } } }).config.serve).toEqual({ notify: 'errors', events: { exclude: ['health', 'unused-export'] } });
    expect(normalizeConfig({ serve: { notify: 'ALL', events: { exclude: { health: true, 'cycle-fixed': false } } } }).config.serve).toEqual({ notify: 'all', events: { exclude: ['health'] } });
    expect(normalizeConfig({ serve: { notify: false, events: ['health'] } }).config.serve).toEqual({ notify: 'off', events: { exclude: ['health'] } });
  });

  it('names the bad key and suggests the closest kind', () => {
    expect(normalizeConfig({ serve: 3 }).error).toBe('"serve" must be an object, e.g. { "notify": "errors" }.');
    expect(normalizeConfig({ serve: 'loud' }).error).toMatch(/^"serve" must be an object .* or a notify mode/);
    expect(normalizeConfig({ serve: { notify: 'loud' } }).error).toBe('serve.notify must be "errors", "all" or "off".');
    expect(normalizeConfig({ serve: { events: { exclude: ['helth'] } } }).error).toMatch(/^serve\.events\.exclude has an unknown event kind "helth" — did you mean "health"\?/);
    expect(normalizeConfig({ serve: { events: { exclude: ['unused-exports'] } } }).error).toMatch(/unknown event kind "unused-exports" — did you mean "unused-export"\?/);
    expect(normalizeConfig({ serve: { events: { exclude: 3 } } }).error).toMatch(/^serve\.events\.exclude must be a list of event kinds/);
    // Unknown keys are named as written, with the closest known one.
    expect(normalizeConfig({ serve: { events: { include: ['health'] } } }).error).toMatch(/^serve\.events has an unknown key "include" — did you mean "exclude"\?/);
    expect(normalizeConfig({ serve: { events: { exclude: ['health'], only: ['cycle-added'] } } }).error).toMatch(/^serve\.events has an unknown key "only"/);
    expect(normalizeConfig({ serve: { notfy: 'all' } }).error).toMatch(/^"serve" has an unknown key "notfy" — did you mean "notify"\?/);
  });

  it('accepts a notify mode as the whole block, and kinds in any case', () => {
    expect(normalizeConfig({ serve: 'errors' }).config.serve).toEqual({ notify: 'errors' });
    expect(normalizeConfig({ serve: 'ALL' }).config.serve).toEqual({ notify: 'all' });
    expect(normalizeConfig({ serve: false }).config.serve).toEqual({ notify: 'off' });
    expect(normalizeConfig({ serve: { events: { exclude: [' Health ', 'UNUSED-EXPORT'] } } }).config.serve).toEqual({ events: { exclude: ['health', 'unused-export'] } });
    expect(normalizeConfig({ serve: { events: { health: true, config: true } } }).config.serve).toEqual({ events: { exclude: ['health', 'config'] } });
  });
});

describe('desktop notifications', () => {
  const errorEvent: LiveEvent = { id: '1', at: 0, kind: 'cycle-added', severity: 'error', message: 'new cycle: a.ts → b.ts → a.ts', files: ['a.ts', 'b.ts'], fingerprint: 'f' };
  const warning: LiveEvent = { ...errorEvent, id: '2', kind: 'untested-change', severity: 'warning', message: 'a.ts changed and no test reaches it', files: ['a.ts'] };

  it('picks the platform command and passes texts as arguments, never as code', () => {
    const mac = notifyCommand('darwin', 'code-visualizer', 'say "hi" & `rm -rf`')!;
    expect(mac.command).toBe('osascript');
    expect(mac.args.slice(-2)).toEqual(['code-visualizer', 'say "hi" & `rm -rf`']);
    expect(mac.args.slice(0, -2).join(' ')).not.toContain('say');
    const linux = notifyCommand('linux', '-t', 'a <b> & c')!;
    expect(linux).toEqual({ command: 'notify-send', args: ['--app-name=code-visualizer', '--', '-t', 'a &lt;b&gt; &amp; c'] });
    const win = notifyCommand('win32', 'title', "it's $(evil)")!;
    expect(win.command).toBe('powershell.exe');
    expect(win.env).toEqual({ CV_NOTIFY_TITLE: 'title', CV_NOTIFY_BODY: "it's $(evil)" });
    expect(win.args.join(' ')).not.toContain('evil');
    // A static script as one -Command argument: no -EncodedCommand / -ExecutionPolicy Bypass (EDR heuristics).
    expect(win.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(win.args).toHaveLength(4);
    expect(win.args.join(' ')).not.toMatch(/EncodedCommand|Bypass|ExecutionPolicy/);
    expect(win.args[3]).toContain('$env:CV_NOTIFY_BODY');
    expect(win.args[3]).not.toContain('"');
    expect(notifyCommand('aix', 't', 'b')).toBeUndefined();
    expect(notifyCommand('darwin', 't', 'x'.repeat(1000))!.args.at(-1)!.length).toBe(400);
  });

  it('notifies about errors only (by default), at most once per interval, and sums up what came in between', () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const calls: { command: string; args: string[] }[] = [];
      const notifier = createNotifier({ mode: 'errors', platform: 'linux', spawn: (command, args) => void calls.push({ command, args }), now: () => Date.now(), title: 'code-visualizer · app' });
      expect(notifier.notify([warning])).toBe(false);
      expect(notifier.notify([warning, errorEvent, { ...errorEvent, id: '3' }])).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].args.slice(-2)).toEqual(['code-visualizer · app', '✖ new cycle: a.ts → b.ts → a.ts (+1 more)']);
      // Inside the interval: kept, not lost.
      vi.advanceTimersByTime(3_000);
      const rule: LiveEvent = { ...errorEvent, id: '4', kind: 'rule-violation', message: 'rule no-db-in-ui broken in src/ui/Cart.tsx:3', files: ['src/ui/Cart.tsx'] };
      expect(notifier.notify([rule])).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(notifier.notify([warning, { ...errorEvent, id: '5', message: '"lodash" is imported but not declared in package.json', files: ['src/a.ts'] }])).toBe(false);
      expect(calls).toHaveLength(1);
      // When the interval ends: one notification for both.
      vi.advanceTimersByTime(5_000);
      expect(calls).toHaveLength(2);
      expect(calls[1].args.at(-1)).toBe('✖ rule no-db-in-ui broken in src/ui/Cart.tsx:3 (+1 more)');
      // The next one waits for the next interval again; close() drops what waits.
      expect(notifier.notify([errorEvent])).toBe(false);
      notifier.close();
      vi.advanceTimersByTime(30_000);
      expect(calls).toHaveLength(2);
      expect(notifier.notify([errorEvent])).toBe(true);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('"all" includes warnings and fixes, "off" nothing, and a failing spawner is swallowed', () => {
    const all = createNotifier({ mode: 'all', platform: 'darwin', spawn: () => { throw new Error('no osascript'); } });
    expect(all.notify([warning])).toBe(true);
    expect(all.notify([{ ...warning, severity: 'info' }])).toBe(false);
    const off = createNotifier({ mode: 'off', platform: 'darwin', spawn: () => { throw new Error('never'); } });
    expect(off.notify([errorEvent])).toBe(false);
    const nowhere = createNotifier({ mode: 'errors', platform: 'aix', spawn: () => { throw new Error('never'); } });
    expect(nowhere.notify([errorEvent])).toBe(false);
  });
});
