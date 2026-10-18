import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { findRepo, indexMtime, readHead, readRef } from '../src/analyzer/repo-state.js';
import { readState, updateState } from '../src/analyzer/state.js';
import { acquireRefreshLock, createStatusCommand, gitTracks, lockPath, parseDuration, payloadDir, refreshRunning, refreshStatus, releaseRefreshLock, staleReason, statusRoot, untrustedState } from '../src/cli/commands/status.js';
import { createDailyLoopService } from '../src/server/daily-loop.js';
import type { Engine } from '../src/server/engine.js';
import { asStoredStatus, buildStatus, formatStatus, isLoopbackUrl, osc8, statusContextFromState, STATUS_FORMATS, testsCovered, trustedLive, withState } from '../src/shared/status.js';
import type { ReportData, StatusSnapshot } from '../src/shared/types.js';
import { commitAll, daysAgo, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const ESC = '\x1b';

/** A writable stand-in for stdout / stderr. */
function sink(tty = false): { stream: NodeJS.WriteStream; text: () => string } {
  let out = '';
  const stream = { isTTY: tty, write: (chunk: string | Uint8Array) => ((out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')), true) } as unknown as NodeJS.WriteStream;
  return { stream, text: () => out };
}

async function runStatus(argv: string[], deps: Parameters<typeof createStatusCommand>[0] = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = sink();
  const err = sink();
  const code = await createStatusCommand(deps).run({ argv, stdout: out.stream, stderr: err.stream });
  return { code, stdout: out.text(), stderr: err.text() };
}

const SNAPSHOT: StatusSnapshot = {
  version: 1,
  generatedAt: 1_700_000_000_000,
  head: 'a'.repeat(40),
  branch: 'feature/cart',
  health: { score: 82, delta: -3 },
  changes: { files: 5, impacted: 23, tests: 3, risk: 41, level: 'medium' },
  problems: { newCycles: 1, newViolations: 0 },
  upstream: { name: 'origin/main', ahead: 2, behind: 7, conflicts: 1 },
  coverage: 72,
  live: { url: 'http://127.0.0.1:4747/' },
};

describe('status: formats', () => {
  it('short: the compact line (no colour unless asked)', () => {
    expect(formatStatus(SNAPSHOT, 'short')).toBe('◆ 82▼3 · 5Δ→23 · 3 tests · ✖1 new cycle · ↓7 main (1 conflict) · cov 72%');
    const coloured = formatStatus(SNAPSHOT, 'short', { color: true });
    expect(coloured).toContain(`${ESC}[31m▼3${ESC}[39m`);
    expect(coloured.replace(/\x1b\[[0-9;]*m/g, '')).toBe(formatStatus(SNAPSHOT, 'short'));
    expect(formatStatus(SNAPSHOT, 'short', { stale: true })).toBe(`${formatStatus(SNAPSHOT, 'short')} ↻`);
    // A refresh that failed: the older numbers, marked.
    expect(formatStatus(SNAPSHOT, 'short', { error: 'No JavaScript/TypeScript source files found' })).toBe(`${formatStatus(SNAPSHOT, 'short')} !`);
  });

  it('plain: words, never ANSI', () => {
    const plain = formatStatus(SNAPSHOT, 'plain', { color: true, stale: true, updating: true });
    expect(plain).not.toContain(ESC);
    expect(plain).toBe('health 82 (−3) · 5 changed → 23 affected · 3 tests to run · risk medium · 1 new cycle · 7 behind main (1 conflict) · coverage 72% (updating)');
    expect(formatStatus(SNAPSHOT, 'plain', { stale: true })).toMatch(/ \(outdated\)$/);
    expect(formatStatus(SNAPSHOT, 'plain', { error: 'boom' })).toMatch(/ \(refresh failed: boom\)$/);
  });

  it('claude: says whether it is updating, outdated or failed', () => {
    const first = (o: Parameters<typeof formatStatus>[2]): string => formatStatus(SNAPSHOT, 'claude', o).split('\n')[0];
    expect(first({ stale: true, updating: true })).toMatch(/ · updating…$/);
    expect(first({ stale: true })).toMatch(/ · outdated$/);
    expect(first({ error: 'No JavaScript files' })).toMatch(/ · ! refresh failed: No JavaScript files$/);
  });

  it('tmux: #[fg=…] colour codes, no ANSI, # escaped', () => {
    const tmux = formatStatus({ ...SNAPSHOT, upstream: { name: 'origin/release#2', ahead: 0, behind: 1 } }, 'tmux');
    expect(tmux).toContain('#[fg=red]▼3#[fg=default]');
    expect(tmux).toContain('#[fg=magenta]◆#[fg=default]');
    expect(tmux).toContain('↓1 release##2');
    expect(tmux).not.toContain(ESC);
  });

  it('starship: plain glyphs without escape codes', () => {
    const starship = formatStatus(SNAPSHOT, 'starship', { color: true });
    expect(starship).toBe('◆ 82▼3 · 5Δ→23 · 3 tests · ✖1 new cycle · ↓7 main (1 conflict) · cov 72%');
    expect(starship).not.toContain(ESC);
  });

  it('claude: two lines with an OSC 8 link to the live My changes page', () => {
    const claude = formatStatus(SNAPSHOT, 'claude', { color: true });
    const lines = claude.split('\n');
    expect(lines).toHaveLength(2);
    expect(claude).toContain(osc8('http://127.0.0.1:4747/#/changes', `${ESC}[35mMy changes ↗${ESC}[39m`));
    expect(claude).toContain(`${ESC}]8;;http://127.0.0.1:4747/#/changes${ESC}\\`);
    const text = claude.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;]*m/g, '');
    expect(text.split('\n')[0]).toBe('◆ health 82 ▼3 · 5 changed → 23 affected · 3 tests to run · risk medium');
    expect(text.split('\n')[1]).toBe('⎇ feature/cart · ↓7 main (1 conflict) · ✖ 1 new cycle · cov 72% · My changes ↗');
    // Without a live server there is no link, but still two lines.
    const offline = formatStatus({ ...SNAPSHOT, live: undefined }, 'claude');
    expect(offline).not.toContain(`${ESC}]8`);
    expect(offline.split('\n')).toHaveLength(2);
  });

  it('json: the snapshot itself (stale flagged)', () => {
    expect(JSON.parse(formatStatus(SNAPSHOT, 'json'))).toEqual(SNAPSHOT);
    expect(JSON.parse(formatStatus(SNAPSHOT, 'json', { stale: true }))).toEqual({ ...SNAPSHOT, stale: true });
  });

  it('a quiet day is a short line: health only', () => {
    const calm: StatusSnapshot = { version: 1, generatedAt: 1, health: { score: 91, delta: 0 }, problems: { newCycles: 0, newViolations: 0 } };
    expect(formatStatus(calm, 'short')).toBe('◆ 91');
    expect(formatStatus(calm, 'plain')).toBe('health 91');
  });

  it('shows the last test run and a failed check', () => {
    // (release fix) ✔ needs a run that covered the tests: here the whole suite ran.
    const s = withState(SNAPSHOT, { lastTest: { at: SNAPSHOT.generatedAt + 10, passed: true, full: true }, lastCheck: { at: 1, ok: false } });
    expect(formatStatus(s, 'short')).toContain('3 tests ✔ · ✖1 new cycle · ✖ check');
    const failed = withState(SNAPSHOT, { lastTest: { at: SNAPSHOT.generatedAt - 10, passed: false } });
    expect(formatStatus(failed, 'short')).toContain('3 tests ✖');
    // A pass from before the latest analysis (your later edits) is not shown as current.
    const old = withState(SNAPSHOT, { lastTest: { at: SNAPSHOT.generatedAt - 10, passed: true } });
    expect(formatStatus(old, 'short')).toContain('3 tests · ');
    // --- integration (wave 3): test-intelligence records the tree it tested; the same tree is still current ---
    const sameTree = withState({ ...SNAPSHOT, treeId: 't1' }, { lastTest: { at: SNAPSHOT.generatedAt - 10, passed: true, treeId: 't1', full: true } });
    expect(formatStatus(sameTree, 'short')).toContain('3 tests ✔');
    expect(formatStatus(sameTree, 'plain')).toContain('3 tests to run (passed)');
    const otherTree = withState({ ...SNAPSHOT, treeId: 't2' }, { lastTest: { at: SNAPSHOT.generatedAt - 10, passed: true, treeId: 't1' } });
    expect(formatStatus(otherTree, 'short')).toContain('3 tests · ');
    expect(statusContextFromState({ lastTest: { at: 2, passed: true, treeId: 't1', exitCode: 0 } })).toEqual({ lastTest: { at: 2, passed: true, treeId: 't1' } });
  });

  it('builds a snapshot from an analysis with its delta, and takes conflicts from a matching sync', () => {
    const data = {
      health: { score: 70, grade: 'C', categories: [], improvements: [] },
      stats: { lineCoverage: 0.645 },
      git: { branch: 'feat', commitsAnalyzed: 1, contributors: [], weeklyActivity: [], dailyActivity: [], commits: [] },
      changes: {
        mode: 'branch',
        base: 'origin/main',
        files: [{ id: 'a.ts', status: 'modified', additions: 1, deletions: 0, lines: [1], analyzed: true }],
        additions: 1,
        deletions: 0,
        commits: [],
        symbols: [],
        impacted: ['b.ts', 'c.ts'],
        impactedRoutes: [],
        clusters: [],
        tests: { files: ['a.test.ts'], changedTests: [] },
        reviewers: [],
        owners: [],
        risk: { score: 12, level: 'low', factors: [] },
        delta: { health: { before: 72, after: 70, categories: [] }, newCycles: [['a.ts', 'b.ts']], newViolations: [] },
      },
    } as unknown as ReportData;
    const s = buildStatus(data, {
      head: 'h1',
      generatedAt: 5,
      upstream: { name: 'origin/main', ahead: 1, behind: 4 },
      sync: { at: 1, head: 'h1', base: 'origin/main', ahead: 1, behind: 4, conflicts: 2, overlap: 1, semantic: 0 },
    });
    expect(s).toMatchObject({ head: 'h1', branch: 'feat', health: { score: 70, delta: -2 }, changes: { files: 1, impacted: 2, tests: 1, level: 'low' }, problems: { newCycles: 1, newViolations: 0 }, coverage: 65 });
    expect(s.upstream).toEqual({ name: 'origin/main', ahead: 1, behind: 4, conflicts: 2, overlap: 1 });
    // Incoming changes that merge cleanly but break your code (sync's semantic findings) show up too.
    const breaks = buildStatus(data, { head: 'h1', upstream: { name: 'origin/main', ahead: 1, behind: 4 }, sync: { at: 1, head: 'h1', base: 'origin/main', ahead: 1, behind: 4, conflicts: 1, overlap: 0, semantic: 2 } });
    expect(breaks.upstream).toMatchObject({ conflicts: 1, semantic: 2 });
    expect(formatStatus(breaks, 'short')).toContain('↓4 main (1 conflict, 2 breaks)');
    expect(formatStatus(breaks, 'plain')).toContain('4 behind main (1 conflict, 2 incoming changes that break your code)');
    expect(formatStatus(breaks, 'claude')).toContain('(1 conflict, 2 breaks)');
    // A sync made for another HEAD says nothing about now.
    const other = buildStatus(data, { head: 'h2', upstream: { name: 'origin/main', ahead: 1, behind: 4 }, sync: { at: 1, head: 'h1', base: 'origin/main', ahead: 1, behind: 4, conflicts: 2, overlap: 1, semantic: 0 } });
    expect(other.upstream?.conflicts).toBeUndefined();
  });

  // --- integration (wave 3): test-intelligence's patch coverage in the status line ---
  it('shows the patch coverage of changes that added executable lines, else the project line coverage', () => {
    const base = { health: { score: 80, grade: 'B', categories: [], improvements: [] }, stats: { lineCoverage: 0.8 } };
    const changes = (coverage: unknown): ReportData =>
      ({
        ...base,
        changes: { mode: 'working', files: [{ id: 'a.ts', status: 'modified', additions: 1, deletions: 0, lines: [1], analyzed: true }], impacted: [], tests: { files: [], changedTests: [] }, risk: { score: 1, level: 'low', factors: [] }, coverage },
      }) as unknown as ReportData;
    const patch = { coverable: 4, covered: 1, pct: 25, files: [], report: 'coverage/lcov.info', reportDate: 1, stale: false };
    expect(buildStatus(changes(patch)).coverage).toBe(25);
    // Only comments or deletions changed: 100% says nothing, the project figure does.
    expect(buildStatus(changes({ ...patch, coverable: 0, covered: 0, pct: 100 })).coverage).toBe(80);
    expect(buildStatus(changes(undefined)).coverage).toBe(80);
    expect(buildStatus({ ...base, stats: {} } as unknown as ReportData).coverage).toBeUndefined();
  });

  // --- integration (wave 4): clone-radar's new clones and clone drift in the status line ---
  it('counts the copies your work adds and the copies it changed without their clone', () => {
    const data = (delta: unknown, cloneDrift: unknown): ReportData =>
      ({
        health: { score: 80, grade: 'B', categories: [], improvements: [] },
        stats: {},
        changes: { mode: 'working', files: [{ id: 'a.ts', status: 'modified', additions: 1, deletions: 0, lines: [1], analyzed: true }], impacted: [], tests: { files: [], changedTests: [] }, risk: { score: 1, level: 'low', factors: [] }, delta, cloneDrift },
      }) as unknown as ReportData;
    const delta = { health: { before: 80, after: 80, categories: [] }, newCycles: [], newViolations: [], newClones: [{ id: 'f1' }] };
    const s = buildStatus(data(delta, [{ changed: {}, untouched: [] }, { changed: {}, untouched: [] }]));
    expect(s.clones).toEqual({ new: 1, drift: 2 });
    expect(formatStatus(s, 'short')).toBe('◆ 80 · 1Δ · ⧉1 new copy · ⧉2 drifted copies');
    expect(formatStatus(s, 'plain')).toBe('health 80 · 1 changed · risk low · 1 new copy-paste clone · 2 copies changed without their clones');
    expect(formatStatus(s, 'claude', { hyperlinks: false }).split('\n')[1]).toBe('⧉ 1 new copy · ⧉ 2 drifted copies');
    expect(formatStatus(s, 'short', { color: true })).toContain(`${ESC}[33m⧉1 new copy${ESC}[39m`);
    // Nothing copied: no segment, and no field.
    expect(buildStatus(data({ ...delta, newClones: [] }, undefined)).clones).toBeUndefined();
  });

  it('reads only well-formed state sections', () => {
    expect(statusContextFromState({ lastCheck: { at: 1, ok: true, mode: 'staged' }, lastTest: { at: 2, passed: 'yes' }, sync: { at: 3 } })).toEqual({ lastCheck: { at: 1, ok: true } });
  });

  it('parses durations and agent payloads', () => {
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('30')).toBe(30_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('2w')).toBe(14 * 86_400_000);
    expect(parseDuration('soon')).toBeUndefined();
    expect(payloadDir(JSON.stringify({ hook_event_name: 'Status', cwd: '/a', workspace: { current_dir: '/b', project_dir: '/c' } }))).toBe('/b');
    expect(payloadDir('{"cwd":"/a"}')).toBe('/a');
    expect(payloadDir('not json')).toBeUndefined();
  });
});

describe.skipIf(!hasGit)('status: the command', () => {
  let restore: () => void;
  let repo: string;
  beforeAll(() => {
    restore = isolateGit();
    repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(3), message: 'initial' });
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  /** A stored snapshot that is current for the repository as it is now. */
  function storeFresh(root = repo, extra: Partial<StatusSnapshot> = {}): StatusSnapshot {
    const r = findRepo(root)!;
    const s: StatusSnapshot = { version: 1, generatedAt: Date.now(), head: readHead(r), indexMtime: indexMtime(r), health: { score: 77, delta: 0 }, problems: { newCycles: 0, newViolations: 0 }, ...extra };
    updateState(root, 'status', s);
    return s;
  }

  it('prints nothing outside a repository (and exits 0)', async () => {
    const outside = makeTempDir('cv-no-repo-');
    const spawned = vi.fn(() => true);
    const result = await runStatus([outside], { spawnRefresh: spawned });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(spawned).not.toHaveBeenCalled();
  });

  it('stays silent in a repository that never used code-visualizer', async () => {
    const other = initRepo('express-api');
    fs.rmSync(path.join(other, 'code-visualizer.config.json'), { force: true });
    commitAll(other, { author: 'Alice', date: daysAgo(1), message: 'init' });
    const spawned = vi.fn(() => true);
    const result = await runStatus([other], { spawnRefresh: spawned });
    expect(result.stdout).toBe('');
    expect(spawned).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(other, '.code-visualizer'))).toBe(false);
  });

  it('prints a current snapshot without refreshing it', async () => {
    storeFresh();
    const spawned = vi.fn(() => true);
    const result = await runStatus([repo], { spawnRefresh: spawned });
    expect(result).toEqual({ code: 0, stdout: '◆ 77\n', stderr: '' });
    expect(spawned).not.toHaveBeenCalled();
  });

  it('a moved HEAD marks the snapshot stale, takes the lock and starts one refresh', async () => {
    storeFresh();
    releaseRefreshLock(repo);
    writeFile(repo, 'src/new.js', 'export const x = 1;\n');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'more' });
    const spawned = vi.fn(() => true);
    const result = await runStatus([repo], { spawnRefresh: spawned });
    expect(result.stdout).toBe('◆ 77 ↻\n');
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveBeenCalledWith(repo, fs.readFileSync(lockPath(repo), 'utf8').trim());
    expect(fs.existsSync(lockPath(repo))).toBe(true);
    // While the lock is held, a second prompt does not start another refresh.
    const again = await runStatus([repo, '--format', 'claude'], { spawnRefresh: spawned });
    expect(again.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]).toBe('◆ health 77 · no changes · updating…');
    expect(spawned).toHaveBeenCalledTimes(1);
    releaseRefreshLock(repo);
  });

  it('reads HEAD from packed refs (no git process)', async () => {
    git(repo, ['pack-refs', '--all']);
    expect(fs.existsSync(path.join(repo, '.git', 'refs', 'heads', 'main'))).toBe(false);
    const r = findRepo(path.join(repo, 'src'))!;
    expect(r.top).toBe(repo);
    expect(readHead(r)).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
    expect(readRef(r, 'refs/heads/main')).toBe(git(repo, ['rev-parse', 'main']).trim());
    const s = storeFresh();
    expect(staleReason(s, r, 60_000)).toBeUndefined();
    writeFile(repo, 'src/other.js', 'export const y = 2;\n');
    commitAll(repo, { author: 'Alice', date: daysAgo(1), message: 'after pack' });
    expect(staleReason(s, findRepo(repo)!, 60_000)).toBe('HEAD moved');
  });

  it('staging something or age makes it stale too', async () => {
    const r = findRepo(repo)!;
    const s = storeFresh();
    expect(staleReason(s, r, 60_000)).toBeUndefined();
    expect(staleReason({ ...s, generatedAt: Date.now() - 120_000, indexMtime: indexMtime(r) }, r, 60_000)).toBe('too old');
    writeFile(repo, 'src/staged.js', 'export const z = 3;\n');
    // The index mtime has a coarse resolution on some file systems: wait a moment.
    await new Promise((resolve) => setTimeout(resolve, 20));
    git(repo, ['add', 'src/staged.js']);
    expect(staleReason({ ...s, indexMtime: s.indexMtime! - 1000 }, findRepo(repo)!, 60_000)).toBe('the index changed');
    git(repo, ['reset', '-q', 'src/staged.js']);
    fs.rmSync(path.join(repo, 'src/staged.js'));
  });

  it('two status calls at the same moment start one refresh', async () => {
    releaseRefreshLock(repo);
    updateState(repo, 'status', { ...storeFresh(), head: 'f'.repeat(40) });
    const spawned = vi.fn(() => true);
    const [a, b] = await Promise.all([runStatus([repo], { spawnRefresh: spawned }), runStatus([repo], { spawnRefresh: spawned })]);
    expect(a.stdout).toBe('◆ 77 ↻\n');
    expect(b.stdout).toBe('◆ 77 ↻\n');
    expect(spawned).toHaveBeenCalledTimes(1);
    // The O_EXCL lock itself: one winner, a stale lock is taken over.
    expect(acquireRefreshLock(repo)).toBeUndefined();
    const token = acquireRefreshLock(repo, Date.now() + 60_000);
    expect(token).toEqual(expect.any(String));
    expect(fs.readFileSync(lockPath(repo), 'utf8').trim()).toBe(token);
    // Only its owner releases it.
    releaseRefreshLock(repo, 'someone-else');
    expect(fs.existsSync(lockPath(repo))).toBe(true);
    expect(refreshRunning(repo)).toBe(true);
    releaseRefreshLock(repo, token);
    expect(fs.existsSync(lockPath(repo))).toBe(false);
    expect(fs.readdirSync(path.dirname(lockPath(repo))).filter((f) => f.startsWith('status.lock'))).toEqual([]);
  });

  it('--no-refresh never starts a refresh', async () => {
    releaseRefreshLock(repo);
    updateState(repo, 'status', { ...storeFresh(), head: 'f'.repeat(40) });
    const spawned = vi.fn(() => true);
    const result = await runStatus([repo, '--no-refresh'], { spawnRefresh: spawned });
    expect(result.stdout).toBe('◆ 77 ↻\n');
    expect(spawned).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath(repo))).toBe(false);
    // Nothing is updating it: claude says so instead of "updating…".
    const claude = await runStatus([repo, '--no-refresh', '--format', 'claude'], { spawnRefresh: spawned });
    expect(claude.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]).toBe('◆ health 77 · no changes · outdated');
  });

  it('after a failed refresh: no "analyzing…" forever, the error instead (and JSON always prints a value)', async () => {
    const r = findRepo(repo)!;
    releaseRefreshLock(repo);
    const error = 'No JavaScript/TypeScript source files found in this project.';
    updateState(repo, 'status', { version: 1, generatedAt: Date.now(), head: readHead(r), indexMtime: indexMtime(r), error });
    const spawned = vi.fn(() => true);
    expect((await runStatus([repo], { spawnRefresh: spawned })).stdout).toBe('');
    const claude = await runStatus([repo, '--format', 'claude'], { spawnRefresh: spawned });
    expect(claude.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toBe(`◆ code-visualizer · ! ${error}\n`);
    expect(JSON.parse((await runStatus([repo, '--json'], { spawnRefresh: spawned })).stdout)).toEqual({ state: 'error', error });
    expect(spawned).not.toHaveBeenCalled();
    // Numbers from an earlier analysis are kept, marked with !.
    updateState(repo, 'status', { ...storeFresh(), error });
    expect((await runStatus([repo], { spawnRefresh: spawned })).stdout).toBe('◆ 77 !\n');
    // No snapshot and nothing running.
    updateState(repo, 'status', undefined);
    const none = await runStatus([repo, '--no-refresh', '--format', 'claude'], { spawnRefresh: spawned });
    expect(none.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toBe('◆ code-visualizer · no status yet (code-visualizer status --refresh)\n');
    expect(JSON.parse((await runStatus([repo, '--no-refresh', '--json'], { spawnRefresh: spawned })).stdout)).toEqual({ state: 'none' });
    // Just started: analyzing.
    expect(JSON.parse((await runStatus([repo, '--json'], { spawnRefresh: spawned })).stdout)).toEqual({ state: 'analyzing' });
    expect(spawned).toHaveBeenCalledTimes(1);
    releaseRefreshLock(repo);
    // Outside a repository: null.
    expect((await runStatus([makeTempDir('cv-json-'), '--json'])).stdout).toBe('null\n');
    expect((await runStatus(['--json', '--format', 'plain'])).code).toBe(2);
    storeFresh();
  });

  it('a stray .code-visualizer folder in a sub-folder is not a project', () => {
    const r = findRepo(repo)!;
    fs.mkdirSync(path.join(repo, 'src', '.code-visualizer'), { recursive: true });
    expect(statusRoot(path.join(repo, 'src'), r)).toBe(repo);
    // With a package.json it is one (a package of a monorepo).
    writeFile(repo, 'src/package.json', '{"name":"pkg"}\n');
    expect(statusRoot(path.join(repo, 'src'), r)).toBe(path.join(repo, 'src'));
    fs.rmSync(path.join(repo, 'src', '.code-visualizer'), { recursive: true });
    fs.rmSync(path.join(repo, 'src', 'package.json'));
  });

  it('--stdin-json takes the folder from a Claude Code payload', async () => {
    storeFresh(repo, { branch: 'main' });
    const payload = JSON.stringify({ hook_event_name: 'Status', session_id: 'x', model: { id: 'm' }, workspace: { current_dir: path.join(repo, 'src'), project_dir: repo } });
    const spawned = vi.fn(() => true);
    const result = await runStatus(['--stdin-json', '--format', 'claude'], { spawnRefresh: spawned, readStdin: async () => payload });
    const lines = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n');
    expect(lines).toEqual(['◆ health 77 · no changes', '⎇ main']);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('includes what check and test recorded since the snapshot', async () => {
    storeFresh();
    updateState(repo, 'lastCheck', { at: Date.now(), ok: false, mode: 'staged', failures: 1, failed: ['hygiene'], newFindings: 1 });
    const result = await runStatus([repo, '--format', 'plain'], { spawnRefresh: () => true });
    expect(result.stdout).toBe('health 77 · last check failed\n');
    updateState(repo, 'lastCheck', undefined);
  });

  it('rejects unknown formats and options (exit 2)', async () => {
    expect((await runStatus(['--format', 'fancy'])).code).toBe(2);
    expect((await runStatus(['--bogus'])).code).toBe(2);
    expect((await runStatus(['--max-age', 'later'])).code).toBe(2);
    const setup = await runStatus(['--setup', 'starship']);
    expect(setup.code).toBe(0);
    expect(setup.stdout).toContain('[custom.code_visualizer]');
    expect(setup.stdout).toContain('code-visualizer status --format starship');
    expect((await runStatus(['--setup', 'claude'])).stdout).toContain('"statusLine"');
    expect((await runStatus(['--setup', 'tmux'])).stdout).toContain('--format tmux');
    // tmux: appended to the user's status-right, not replacing it.
    expect((await runStatus(['--setup', 'tmux'])).stdout).toContain('set -ag status-right');
    expect((await runStatus(['--setup', 'zsh'])).stdout).toContain("RPROMPT='${CODE_VISUALIZER_STATUS}'");
    expect((await runStatus(['--setup', 'bash'])).stdout).toContain('PROMPT_COMMAND="_code_visualizer_status');
  });

  it('--refresh analyzes and stores a snapshot (a manual one leaves a background refresh\'s lock alone)', async () => {
    updateState(repo, 'status', undefined);
    const other = acquireRefreshLock(repo)!;
    await runStatus(['--refresh', '--quiet', repo]);
    expect(fs.readFileSync(lockPath(repo), 'utf8').trim()).toBe(other);
    // The background refresh it was started for releases it.
    process.env.CODE_VISUALIZER_STATUS_LOCK = other;
    let result;
    try {
      result = await runStatus(['--refresh', '--quiet', repo]);
    } finally {
      delete process.env.CODE_VISUALIZER_STATUS_LOCK;
    }
    expect(result.code).toBe(0);
    const stored = readState<StatusSnapshot>(repo, 'status')!;
    expect(stored.version).toBe(1);
    expect(stored.head).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
    expect(stored.health.score).toBeGreaterThan(0);
    expect(stored.branch).toBe('main');
    expect(fs.existsSync(lockPath(repo))).toBe(false);
    const printed = await runStatus([repo], { spawnRefresh: () => true });
    expect(printed.stdout).toBe(`◆ ${stored.health.score}\n`);
  }, 30_000);
});

describe('status: the command module is light', () => {
  it('loads and answers without the analyzer or TypeScript', async () => {
    vi.resetModules();
    vi.doMock('../src/analyzer/index.js', () => {
      throw new Error('the analyzer was loaded');
    });
    vi.doMock('typescript', () => {
      throw new Error('typescript was loaded');
    });
    try {
      await expect(import('../src/analyzer/index.js')).rejects.toThrow();
      const mod = await import('../src/cli/commands/status.js');
      const out = sink();
      const code = await mod.statusCommand.run({ argv: [makeTempDir('cv-light-')], stdout: out.stream, stderr: sink().stream });
      expect(code).toBe(0);
      expect(out.text()).toBe('');
      // A repository with a current snapshot: answered from .git and state.json alone.
      const dir = makeTempDir('cv-light-repo-');
      const head = 'a'.repeat(40);
      writeFile(dir, '.git/HEAD', 'ref: refs/heads/main\n');
      writeFile(dir, '.git/refs/heads/main', `${head}\n`);
      writeFile(dir, '.code-visualizer/state.json', JSON.stringify({ status: { version: 1, generatedAt: Date.now(), head, health: { score: 64, delta: -1 }, problems: { newCycles: 0, newViolations: 2 } } }));
      const printed = sink();
      await mod.createStatusCommand({ spawnRefresh: () => true }).run({ argv: [dir], stdout: printed.stream, stderr: sink().stream });
      expect(printed.text()).toBe('◆ 64▼1 · ✖2 rule breaks\n');
    } finally {
      vi.doUnmock('../src/analyzer/index.js');
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                               Release fixes                                */
/* -------------------------------------------------------------------------- */

describe('status: release fixes (pure)', () => {
  const HOSTILE = '\u001b]0;X\u0007\u001b[2J';
  /** A state file someone committed: escape sequences in every name, and a link to somewhere else. */
  const hostile = {
    ...SNAPSHOT,
    branch: `feat${HOSTILE}`,
    upstream: { name: `origin/main${HOSTILE}`, ahead: 0, behind: 2, conflicts: 1 },
    live: { url: 'https://evil.example/', open: 3 },
    error: `boom${HOSTILE}`,
  };

  it('never prints control characters from a stored status, nor its link', () => {
    const stored = asStoredStatus(hostile);
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty('live');
    const s = withState(stored as StatusSnapshot, {});
    for (const format of STATUS_FORMATS) {
      for (const stale of [false, true]) {
        const plainText = formatStatus(s, format, { stale, error: `bad${HOSTILE}` });
        expect(plainText, format).not.toContain(ESC);
        expect(plainText, format).not.toContain('\u0007');
        expect(plainText, format).not.toContain('evil.example');
      }
    }
    // With colours: only the tool's own SGR codes.
    for (const format of ['short', 'claude'] as const) {
      const coloured = formatStatus(s, format, { color: true, error: HOSTILE });
      expect(coloured.replace(/\u001b\[(?:2|22|3[1-9])m/g, ''), format).not.toContain(ESC);
    }
    expect(formatStatus(s, 'plain')).toContain('2 behind main\\e]0;X\\x07\\e[2J');
    expect(formatStatus(s, 'claude')).toContain('⎇ feat\\e]0;X\\x07\\e[2J');
    // Even a link handed to the formatter directly is dropped unless it is a page on this machine.
    expect(formatStatus({ ...SNAPSHOT, live: { url: 'https://evil.example/' } }, 'claude')).not.toContain('evil.example');
    expect(formatStatus({ ...SNAPSHOT, live: { url: 'http://[::1]:4747/' } }, 'claude')).toContain(`${ESC}]8;;http://[::1]:4747/#/changes`);
  });

  it('drops a malformed list of required tests from a stored status', () => {
    const base = { version: 1, generatedAt: 1, health: { score: 80, delta: 0 }, problems: { newCycles: 0, newViolations: 0 } };
    expect(asStoredStatus({ ...base, requiredTests: { count: 1, hash: 'x', files: 'test/a.test.ts' } })).not.toHaveProperty('requiredTests');
    expect(asStoredStatus({ ...base, requiredTests: { count: 1, hash: 'x', files: ['test/a.test.ts'] } })).toHaveProperty('requiredTests');
  });

  it('links only to loopback pages a live server named', () => {
    expect(isLoopbackUrl('http://127.0.0.1:4747/')).toBe(true);
    expect(isLoopbackUrl('https://localhost:5000/x')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:4747/')).toBe(true);
    expect(isLoopbackUrl('https://evil.example/')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.evil.example/')).toBe(false);
    expect(isLoopbackUrl('http://user:pw@127.0.0.1/')).toBe(false);
    expect(isLoopbackUrl('javascript:alert(1)')).toBe(false);
    expect(trustedLive({ live: { url: 'http://127.0.0.1:4747/', open: 2 } })).toEqual({ url: 'http://127.0.0.1:4747/', open: 2 });
    expect(trustedLive({ live: { url: 'https://evil.example/' } })).toBeUndefined();
    expect(trustedLive({ live: { url: 'http://127.0.0.1:4747/', open: 'x' } })).toEqual({ url: 'http://127.0.0.1:4747/' });
  });

  it('takes the whole upstream from a sync made after the snapshot for the same HEAD', () => {
    const snap: StatusSnapshot = { version: 1, generatedAt: 1_000, head: 'h1', health: { score: 80, delta: 0 }, problems: { newCycles: 0, newViolations: 0 }, upstream: { name: 'origin/main', ahead: 1, behind: 0 } };
    const sync = { at: 2_000, head: 'h1', base: 'origin/main', ahead: 1, behind: 2, conflicts: 1, overlap: 3, semantic: 0 };
    expect(withState(snap, { sync }).upstream).toEqual({ name: 'origin/main', ahead: 1, behind: 2, conflicts: 1, overlap: 3 });
    expect(formatStatus(withState(snap, { sync }), 'short')).toContain('↓2 main (1 conflict)');
    // An older sync that disagrees is ignored; one for another HEAD too.
    expect(withState(snap, { sync: { ...sync, at: 500 } }).upstream).toEqual(snap.upstream);
    expect(withState(snap, { sync: { ...sync, head: 'h2' } }).upstream).toEqual(snap.upstream);
  });

  it('✔ only when the last run covered every required test; a partial run shows how many', () => {
    const data = {
      health: { score: 80, grade: 'B', categories: [], improvements: [] },
      stats: {},
      changes: { mode: 'working', files: [{ id: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, lines: [1], analyzed: true }], impacted: [], tests: { files: ['test/b.test.ts', 'test/a.test.ts'], changedTests: [] }, risk: { score: 1, level: 'low', factors: [] } },
    } as unknown as ReportData;
    const snap = buildStatus(data, { generatedAt: 1_000, treeId: 't1' });
    expect(snap.requiredTests).toEqual({ count: 2, hash: expect.any(String), files: ['test/a.test.ts', 'test/b.test.ts'] });
    const one = withState(snap, { lastTest: { at: 2_000, passed: true, files: ['test/a.test.ts'], full: false } });
    expect(formatStatus(one, 'short')).toContain('2 tests 1/2');
    expect(formatStatus(one, 'short')).not.toContain('✔');
    expect(formatStatus(one, 'plain')).toContain('2 tests to run (1 of 2 passed)');
    expect(formatStatus(one, 'claude')).not.toContain('✔');
    const both = withState(snap, { lastTest: { at: 2_000, passed: true, files: ['test/a.test.ts', 'test/b.test.ts'], full: false } });
    expect(formatStatus(both, 'short')).toContain('2 tests ✔');
    expect(formatStatus(both, 'plain')).toContain('2 tests to run (passed)');
    // A run of other tests marks nothing; a whole-suite run (its package in full) covers them all.
    expect(formatStatus(withState(snap, { lastTest: { at: 2_000, passed: true, files: ['test/c.test.ts'] } }), 'short')).toMatch(/2 tests( ·|$)/);
    expect(formatStatus(withState(snap, { lastTest: { at: 2_000, passed: true, files: [], full: true, fullPackages: ['test'] } }), 'short')).toContain('2 tests ✔');
    expect(formatStatus(withState(snap, { lastTest: { at: 2_000, passed: true, files: [], full: true, fullPackages: ['packages/other'] } }), 'short')).not.toContain('✔');
    // The same tree counts even when the run came before the snapshot; a failed run is ✖ either way.
    expect(formatStatus(withState(snap, { lastTest: { at: 500, passed: true, treeId: 't1', files: ['test/a.test.ts', 'test/b.test.ts'] } }), 'short')).toContain('2 tests ✔');
    expect(formatStatus(withState(snap, { lastTest: { at: 2_000, passed: false, files: ['test/a.test.ts'] } }), 'short')).toContain('2 tests ✖');
    // The state section is read with the files it ran.
    expect(statusContextFromState({ lastTest: { at: 2, passed: true, files: ['a'], full: false, fullPackages: [''], exitCode: 0 } }).lastTest).toEqual({ at: 2, passed: true, files: ['a'], full: false, fullPackages: [''] });
    expect(testsCovered({ files: ['a', 'c'] }, ['a', 'b'])).toBe(1);
  });

  it('a long selection keeps only its size and hash: an exact rerun of it still counts', () => {
    const files = Array.from({ length: 600 }, (_, i) => `test/t${i}.test.ts`);
    const data = {
      health: { score: 80, grade: 'B', categories: [], improvements: [] },
      stats: {},
      changes: { mode: 'working', files: [{ id: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, lines: [1], analyzed: true }], impacted: [], tests: { files, changedTests: [] }, risk: { score: 1, level: 'low', factors: [] } },
    } as unknown as ReportData;
    const snap = buildStatus(data, { generatedAt: 1_000 });
    expect(snap.requiredTests?.files).toBeUndefined();
    expect(formatStatus(withState(snap, { lastTest: { at: 2_000, passed: true, files: [...files].reverse() } }), 'short')).toContain('600 tests ✔');
    expect(formatStatus(withState(snap, { lastTest: { at: 2_000, passed: true, files: files.slice(1) } }), 'short')).not.toContain('✔');
  });

  it('labels patch and project coverage differently, and marks a report older than the code', () => {
    const base = { health: { score: 80, grade: 'B', categories: [], improvements: [] }, stats: { lineCoverage: 0.8 } };
    const changes = (coverage: unknown, extra: object = {}): ReportData =>
      ({
        ...base,
        ...extra,
        changes: { mode: 'working', files: [{ id: 'a.ts', status: 'modified', additions: 1, deletions: 0, lines: [1], analyzed: true }], impacted: [], tests: { files: [], changedTests: [] }, risk: { score: 1, level: 'low', factors: [] }, coverage },
      }) as unknown as ReportData;
    const patch = { coverable: 4, covered: 1, pct: 25, files: [], report: 'coverage/lcov.info', reportDate: 1, stale: false };
    const p = buildStatus(changes(patch));
    expect(p).toMatchObject({ coverage: 25, coverageKind: 'patch' });
    expect(formatStatus(p, 'short')).toContain('patch 25%');
    expect(formatStatus(p, 'plain')).toContain('patch coverage 25%');
    const project = buildStatus(changes(undefined));
    expect(formatStatus(project, 'short')).toContain('cov 80%');
    expect(formatStatus(project, 'short')).not.toContain('?');
    expect(formatStatus(project, 'plain')).toContain('coverage 80%');
    // Stale reports: the patch's own flag, or the project report's.
    expect(formatStatus(buildStatus(changes({ ...patch, stale: true })), 'short')).toContain('patch 25%?');
    const staleProject = buildStatus(changes(undefined, { coverage: { reports: [], lines: { total: 1, covered: 1 }, pct: 0.8, files: 1, stale: true } }));
    expect(formatStatus(staleProject, 'short')).toContain('cov 80%?');
    expect(formatStatus(staleProject, 'plain')).toContain('coverage 80% (report older than the code)');
    expect(formatStatus(staleProject, 'claude')).toContain('cov 80%?');
    expect(formatStatus(staleProject, 'tmux')).toContain('#[fg=colour244]?#[fg=default]');
  });
});

describe.skipIf(!hasGit)('status: release fixes (the command)', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  function freshRepo(): string {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(3), message: 'initial' });
    return repo;
  }

  function store(repo: string, extra: Record<string, unknown> = {}): void {
    const r = findRepo(repo)!;
    updateState(repo, 'status', { version: 1, generatedAt: Date.now(), head: readHead(r), indexMtime: indexMtime(r), health: { score: 77, delta: 0 }, problems: { newCycles: 0, newViolations: 0 }, ...extra });
  }

  it('prints no escape sequence and no link from a state file (status --format claude | od -c shows no 033 ])', async () => {
    const repo = freshRepo();
    store(repo, { branch: 'x\u001b]0;X\u0007\u001b[2J', upstream: { name: 'origin/m\u001b]0;Y\u0007', ahead: 0, behind: 1 }, live: { url: 'https://evil.example/' } });
    for (const format of ['claude', 'short', 'plain', 'tmux', 'starship', 'json']) {
      const { stdout } = await runStatus([repo, '--format', format, '--no-refresh']);
      expect(stdout, format).not.toContain(`${ESC}]`);
      expect(stdout, format).not.toContain('\u0007');
      expect(stdout, format).not.toContain('evil.example');
    }
  });

  it('ignores a state file git tracks (it came with the repository) and does not refresh into it', async () => {
    const repo = freshRepo();
    store(repo, { branch: 'committed' });
    const r = findRepo(repo)!;
    expect(untrustedState(repo, r)).toBeUndefined();
    expect((await runStatus([repo, '--format', 'plain', '--no-refresh'])).stdout).toBe('health 77\n');
    git(repo, ['add', '-f', '.code-visualizer/state.json']);
    expect(gitTracks(r, '.code-visualizer/state.json')).toBe(true);
    expect(gitTracks(r, 'package.json')).toBe(true);
    expect(gitTracks(r, 'nope.json')).toBe(false);
    expect(untrustedState(repo, r)).toBe('.code-visualizer/state.json is tracked by git');
    const spawned = vi.fn(() => true);
    expect((await runStatus([repo], { spawnRefresh: spawned })).stdout).toBe('');
    expect(JSON.parse((await runStatus([repo, '--json'], { spawnRefresh: spawned })).stdout)).toEqual({ state: 'ignored', reason: '.code-visualizer/state.json is tracked by git' });
    expect((await runStatus([repo, '--format', 'claude'], { spawnRefresh: spawned })).stdout).toContain('tracked by git: ignored');
    expect(spawned).not.toHaveBeenCalled();
    // The same answer as git's own, for an index git wrote in another version (v4 is asked through git).
    git(repo, ['update-index', '--index-version', '4']);
    expect(gitTracks(findRepo(repo)!, '.code-visualizer/state.json')).toBe(true);
    git(repo, ['update-index', '--index-version', '3']);
    expect(gitTracks(findRepo(repo)!, '.code-visualizer/state.json')).toBe(true);
    git(repo, ['rm', '-q', '--cached', '.code-visualizer/state.json']);
    expect(untrustedState(repo, findRepo(repo)!)).toBeUndefined();
    // A linked .code-visualizer folder is not believed either.
    const other = freshRepo();
    const elsewhere = makeTempDir('cv-elsewhere-');
    writeFile(elsewhere, 'state.json', '{}');
    fs.symlinkSync(elsewhere, path.join(other, '.code-visualizer'));
    expect(untrustedState(other, findRepo(other)!)).toBe('.code-visualizer is a link');
  });

  // integration (release fixes): serve's status snapshot follows the same rule as the status command.
  it('serve neither reads nor rewrites a state file git tracks', async () => {
    const repo = freshRepo();
    store(repo);
    updateState(repo, 'lastCheck', { at: Date.now(), ok: false, mode: 'all', failed: ['made-up'] });
    const data = await analyze({ root: repo, includeSource: false, history: false, compare: false });
    const engine = { latest: () => data, feed: () => ({ open: [] }) } as unknown as Engine;
    const trusted = createDailyLoopService({ root: repo, engine, url: () => 'http://127.0.0.1:1/', persist: true });
    expect((await trusted.status())?.lastCheck).toMatchObject({ ok: false });
    trusted.close();

    git(repo, ['add', '-f', '.code-visualizer/state.json']);
    const before = fs.readFileSync(path.join(repo, '.code-visualizer/state.json'), 'utf8');
    vi.useFakeTimers();
    const service = createDailyLoopService({ root: repo, engine, url: () => 'http://127.0.0.1:1/', persist: true });
    try {
      expect((await service.status())?.lastCheck).toBeUndefined();
      service.scheduleWrite();
      await vi.advanceTimersByTimeAsync(1500);
    } finally {
      service.close();
      vi.useRealTimers();
    }
    expect(fs.readFileSync(path.join(repo, '.code-visualizer/state.json'), 'utf8')).toBe(before);
  }, 30_000);

  it('a fetch that moves the base makes the snapshot stale, and the refresh shows the new commits', async () => {
    const seed = freshRepo();
    const remote = path.join(makeTempDir('cv-origin-'), 'origin.git');
    git(path.dirname(remote), ['clone', '-q', '--bare', seed, remote]);
    const mine = path.join(makeTempDir('cv-mine-'), 'app');
    const theirs = path.join(makeTempDir('cv-theirs-'), 'app');
    git(path.dirname(mine), ['clone', '-q', remote, mine]);
    git(path.dirname(theirs), ['clone', '-q', remote, theirs]);
    await runStatus(['--refresh', '--quiet', mine]);
    const before = readState<StatusSnapshot>(mine, 'status')!;
    expect(before.upstream).toMatchObject({ name: 'origin/main', behind: 0 });
    const spawned = vi.fn(() => true);
    expect(JSON.parse((await runStatus([mine, '--json'], { spawnRefresh: spawned })).stdout)).not.toHaveProperty('stale');
    // A teammate pushes; you fetch (HEAD and the index stay as they were).
    writeFile(theirs, 'src/teammate.js', 'export const t = 1;\n');
    commitAll(theirs, { author: 'Bob', date: daysAgo(1), message: 'teammate' });
    git(theirs, ['push', '-q', 'origin', 'HEAD:main']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    git(mine, ['fetch', '-q', 'origin']);
    expect(staleReason(readState(mine, 'status')!, findRepo(mine)!, 600_000)).toBe('base ref changed');
    // The prompt starts the background refresh (run in-process here), then shows what it found.
    let pending: Promise<unknown> = Promise.resolve();
    const refresh = (root: string, token: string): boolean => {
      pending = refreshStatus(root, findRepo(root)!).finally(() => releaseRefreshLock(root, token));
      return true;
    };
    expect(JSON.parse((await runStatus([mine, '--json'], { spawnRefresh: refresh })).stdout)).toMatchObject({ stale: true, upstream: { behind: 0 } });
    await pending;
    const after = JSON.parse((await runStatus([mine, '--json'], { spawnRefresh: spawned })).stdout) as StatusSnapshot;
    expect(after.upstream?.behind).toBeGreaterThanOrEqual(1);
    expect(spawned).not.toHaveBeenCalled();
  }, 60_000);
});
