import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { readState } from '../src/analyzer/state.js';
import { analyzeSync, runGit, supportsMergeTree, upstreamStatus, type GitRunner } from '../src/analyzer/sync.js';
import { syncText } from '../src/cli/commands/sync.js';
import { runCli } from '../src/cli/run.js';
import { serve } from '../src/server/index.js';
import type { SyncState, StatusSnapshot, SyncReport } from '../src/shared/types.js';
import { commitAll, daysAgo, editFile, git, hasGit, httpRequest, initRepo, isolateGit, makeTempDir, removeTempDirs } from './companion-helpers.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sinkFn: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sinkFn(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
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

/** A runner that records every git command (to prove what was, and was not, spawned). */
function spyRunner(): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (cwd, args) => {
      calls.push(args);
      return runGit(cwd, args);
    },
  };
}

const TABLE = 'components/UserTable.tsx';
const CALL_LINE = 32; // `<td>{formatUserName(u)}</td>`

interface World {
  remote: string;
  /** Your clone, on branch `feature`. */
  mine: string;
  /** A teammate's clone, on `main`. */
  theirs: string;
}

/** A bare remote with the fixture on main, your clone (on `feature`) and a teammate's clone. */
function world(): World {
  const seed = initRepo('fullstack-next');
  commitAll(seed, { author: 'Alice', date: daysAgo(5), message: 'initial' });
  const remote = path.join(makeTempDir('cv-remote-'), 'remote.git');
  git(path.dirname(remote), ['clone', '-q', '--bare', seed, remote]);
  const mine = path.join(makeTempDir('cv-mine-'), 'app');
  const theirs = path.join(makeTempDir('cv-theirs-'), 'app');
  git(path.dirname(mine), ['clone', '-q', remote, mine]);
  git(path.dirname(theirs), ['clone', '-q', remote, theirs]);
  git(mine, ['checkout', '-q', '-b', 'feature']);
  return { remote, mine, theirs };
}

/** Your change: the users table cell (the line that calls formatUserName). */
function changeMine(w: World): void {
  editFile(w.mine, TABLE, '<td>{formatUserName(u)}</td>', '<td className="name">{formatUserName(u)}</td>');
  commitAll(w.mine, { author: 'Me', date: daysAgo(2), message: 'style the name cell' });
}

/** The teammate commits on main and pushes. */
function pushTheirs(w: World, edit: () => void, message: string, author = 'Bob'): void {
  edit();
  commitAll(w.theirs, { author, date: daysAgo(1), message });
  git(w.theirs, ['push', '-q', 'origin', 'HEAD:main']);
}

const fetchMine = (w: World): string => git(w.mine, ['fetch', '-q', 'origin']);

describe.skipIf(!hasGit)('sync forecast', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  it('a teammate edits the same lines → a content conflict, after a fetch', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(w, () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'), 'trim names');
    // Not fetched yet: nothing is known about the teammate's push.
    const before = await analyzeSync(w.mine);
    expect(before).toMatchObject({ base: 'origin/main', behind: 0, ahead: 1, conflicts: [], recommendation: undefined });
    fetchMine(w);
    const report = await analyzeSync(w.mine);
    expect(report).toMatchObject({ base: 'origin/main', behind: 1, ahead: 1, method: 'merge-tree', conflicts: [{ file: TABLE }], overlap: [], recommendation: 'git rebase origin/main' });
    expect(report.incoming).toHaveLength(1);
    expect(report.incoming[0]).toMatchObject({ author: 'Bob', subject: 'trim names', paths: [TABLE] });
    expect(report.authors).toEqual([{ name: 'Bob', commits: 1 }]);
    expect(report.mergeBase).toBe(git(w.mine, ['merge-base', 'HEAD', 'origin/main']).trim());
    // The trial merge touched neither the working tree nor the index.
    expect(git(w.mine, ['status', '--porcelain'])).toBe('');
    // The status line's quick version agrees.
    expect(await upstreamStatus(w.mine, 'origin/main')).toEqual({ name: 'origin/main', ahead: 1, behind: 1, conflicts: 1 });
  });

  it('a teammate adds a parameter to an exported function you call → signature-changed with your call line', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(
      w,
      () => editFile(w.theirs, 'lib/format.ts', "export function formatUserName(user: Pick<User, 'name'>): string {\n  return user.name.toUpperCase();", "export function formatUserName(user: Pick<User, 'name'>, locale: string): string {\n  return user.name.toLocaleUpperCase(locale);"),
      'format names per locale',
    );
    fetchMine(w);
    const hash = git(w.mine, ['rev-parse', '--short=7', 'origin/main']).trim();
    const report = await analyzeSync(w.mine, { data: () => analyze({ root: w.mine, includeSource: false, history: false, changes: false }) });
    expect(report.conflicts).toEqual([]);
    expect(report.semantic).toEqual([
      {
        kind: 'signature-changed',
        file: 'lib/format.ts',
        symbol: 'formatUserName',
        message: 'formatUserName(user) → formatUserName(user, locale)',
        yourSites: [{ file: TABLE, line: CALL_LINE, kind: 'call' }],
        commit: hash,
        author: 'Bob',
      },
    ]);
    // In words, as `sync` prints it.
    const text = await cli('sync', w.mine, '--no-cache');
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`! formatUserName(user) → formatUserName(user, locale) in ${hash} (Bob); you call it at ${TABLE}:${CALL_LINE}`);
    expect(text.stdout).toContain('✔ your commits merge cleanly');
    expect(text.stdout).toContain('→ git rebase origin/main, then update 1 call site');
  });

  it('a removed route you request is reported with your call', async () => {
    const w = world();
    // Your change touches the code that sends DELETE /api/users/:id.
    editFile(w.mine, TABLE, "{ method: 'DELETE' }", "{ method: 'DELETE', keepalive: true }");
    commitAll(w.mine, { author: 'Me', date: daysAgo(2), message: 'keepalive' });
    pushTheirs(w, () => editFile(w.theirs, 'app/api/users/[id]/route.ts', /export async function DELETE[\s\S]*?\n}\n/, ''), 'users cannot be deleted any more');
    fetchMine(w);
    const report = await analyzeSync(w.mine, { data: () => analyze({ root: w.mine, includeSource: false, history: false, changes: false }) });
    expect(report.semantic).toEqual([expect.objectContaining({ kind: 'route-removed', file: 'app/api/users/[id]/route.ts', symbol: 'DELETE /api/users/[id]', message: 'DELETE /api/users/[id] was removed', yourSites: [{ file: TABLE, line: 18, kind: 'http' }], author: 'Bob' })]);
  });

  it('a break is blamed on the commit that changed the symbol, not on the latest one touching the file', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(
      w,
      () => editFile(w.theirs, 'lib/format.ts', "export function formatUserName(user: Pick<User, 'name'>): string {", "export function formatUserName(user: Pick<User, 'name'>, locale: string): string {"),
      'format names per locale',
      'Alice',
    );
    const alice = git(w.theirs, ['rev-parse', '--short=7', 'HEAD']).trim();
    pushTheirs(w, () => editFile(w.theirs, 'lib/format.ts', 'return user.name.trim() || user.email;', "return user.name.trim() || user.email || 'anonymous';"), 'anonymous users', 'Bob');
    fetchMine(w);
    const report = await analyzeSync(w.mine, { data: () => analyze({ root: w.mine, includeSource: false, history: false, changes: false }) });
    expect(report.semantic).toEqual([expect.objectContaining({ kind: 'signature-changed', symbol: 'formatUserName', commit: alice, author: 'Alice' })]);
  });

  it('from a sub-folder: conflict paths are the analyzed root\'s, and a conflicting file is not also "merging cleanly"', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(w, () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'), 'trim names');
    fetchMine(w);
    const report = await analyzeSync(path.join(w.mine, 'components'));
    expect(report.conflicts).toEqual([{ file: 'UserTable.tsx' }]);
    expect(report.overlap).toEqual([]);
    const branches = await analyzeSync(path.join(w.mine, 'components'), { branches: true });
    expect(branches.conflicts).toEqual([{ file: 'UserTable.tsx' }]);
  });

  it('uncommitted edits are merged on the side: a conflict when they would not re-apply, never "merges cleanly" unchecked', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(
      w,
      () => {
        editFile(w.theirs, 'lib/format.ts', 'return user.name.toUpperCase();', 'return user.name.toLocaleUpperCase();');
        editFile(w.theirs, 'lib/db.ts', 'export const MAX_USERS = 100;', 'export const MAX_USERS = 200;');
        fs.writeFileSync(path.join(w.theirs, 'lib/added.ts'), 'export const added = 1;\n');
      },
      'upstream edits',
    );
    fetchMine(w);
    // The same line, not committed: `git rebase --autostash` would stop with a conflict re-applying it.
    editFile(w.mine, 'lib/format.ts', 'return user.name.toUpperCase();', 'return user.name.toUpperCase().trim();');
    // Another part of a file the base changes: re-applies cleanly.
    editFile(w.mine, 'lib/db.ts', 'return users.delete(id);', 'return users.delete(id) && true;');
    // Untracked here, added upstream: the rebase would stop before overwriting it.
    fs.writeFileSync(path.join(w.mine, 'lib/added.ts'), 'export const mine = 1;\n');
    const report = await analyzeSync(w.mine);
    expect(report.conflicts).toEqual([{ file: 'lib/added.ts', local: 'untracked' }, { file: 'lib/format.ts', local: 'uncommitted' }]);
    expect(report.overlap).toEqual([{ file: 'lib/db.ts', commits: [expect.any(String)], local: 'uncommitted', clean: true }]);
    const text = syncText(report).map(strip).join('\n');
    expect(text).toContain('✔ your commits merge cleanly');
    expect(text).toContain('✖ your uncommitted edits to lib/format.ts conflict with incoming changes');
    expect(text).toContain('✖ lib/added.ts is untracked here but added by incoming commits');
    expect(text).toContain('~ lib/db.ts (uncommitted) also changes in 1 incoming commit (your edits still apply cleanly)');
    expect(text).not.toContain('lib/format.ts also changes');
    // Nothing was touched.
    expect(git(w.mine, ['status', '--porcelain', '--', 'lib/format.ts'])).toBe(' M lib/format.ts\n');
  });

  it('an unrelated edit → no conflicts, no overlap, nothing semantic', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(w, () => editFile(w.theirs, 'lib/billing.ts', /$/, '\nexport const CURRENCY = "EUR";\n'), 'currency');
    fetchMine(w);
    const report = await analyzeSync(w.mine, { data: () => analyze({ root: w.mine, includeSource: false, history: false, changes: false }) });
    expect(report).toMatchObject({ behind: 1, conflicts: [], overlap: [], semantic: [], recommendation: 'git rebase origin/main' });
    // Uncommitted work: rebase with --autostash.
    editFile(w.mine, 'lib/db.ts', /$/, '\n// wip\n');
    expect((await analyzeSync(w.mine)).recommendation).toBe('git rebase --autostash origin/main');
  });

  it('--branches reports a teammate branch that conflicts and one that merges cleanly', async () => {
    const w = world();
    changeMine(w);
    const branch = (name: string, edit: () => void): void => {
      git(w.theirs, ['checkout', '-q', '-b', name, 'origin/main']);
      edit();
      commitAll(w.theirs, { author: name.startsWith('alice') ? 'Alice' : 'Bob', date: daysAgo(1), message: name });
      git(w.theirs, ['push', '-q', 'origin', name]);
    };
    branch('alice/checkout', () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'));
    branch('bob/table', () => editFile(w.theirs, TABLE, "fetch('/api/users')", "fetch('/api/users?all=1')"));
    branch('bob/billing', () => editFile(w.theirs, 'lib/billing.ts', /$/, '\n// later\n'));
    fetchMine(w);
    const report = await analyzeSync(w.mine, { branches: true });
    const branches = [...(report.branches ?? [])].sort((a, b) => a.ref.localeCompare(b.ref));
    expect(branches.map((b) => ({ ref: b.ref, author: b.author, result: b.result, files: b.files, conflictFiles: b.conflictFiles }))).toEqual([
      { ref: 'origin/alice/checkout', author: 'Alice', result: 'conflict', files: [TABLE], conflictFiles: [TABLE] },
      { ref: 'origin/bob/table', author: 'Bob', result: 'clean', files: [TABLE], conflictFiles: [] },
    ]);
    // Branches older than --since are not looked at.
    const none = await analyzeSync(w.mine, { branches: true, since: 1000, now: Date.now() + 30 * 24 * 3600 * 1000 });
    expect(none.branches).toEqual([]);
  });

  it('--branches: a branch made from a newer base is judged by its own changes (and your uncommitted edits)', async () => {
    const w = world();
    changeMine(w);
    // main conflicts with your committed change…
    pushTheirs(w, () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'), 'trim names');
    // …and Bob branches from that main, changing only lib/db.ts.
    git(w.theirs, ['checkout', '-q', '-b', 'bob/limits']);
    editFile(w.theirs, 'lib/db.ts', 'export const MAX_USERS = 100;', 'export const MAX_USERS = 500;');
    commitAll(w.theirs, { author: 'Bob', date: daysAgo(1), message: 'more users' });
    git(w.theirs, ['push', '-q', 'origin', 'bob/limits']);
    fetchMine(w);
    // You edit the same line of lib/db.ts, not committed yet.
    editFile(w.mine, 'lib/db.ts', 'export const MAX_USERS = 100;', 'export const MAX_USERS = 50;');
    const report = await analyzeSync(w.mine, { branches: true });
    expect(report.conflicts).toEqual([{ file: TABLE }]);
    expect(report.branches).toEqual([{ ref: 'origin/bob/limits', author: 'Bob', updated: expect.any(Number), files: ['lib/db.ts'], result: 'conflict', conflictFiles: ['lib/db.ts'], verified: true }]);
  });

  it('git older than 2.38 compares files instead of merging', async () => {
    expect(supportsMergeTree([2, 38, 0])).toBe(true);
    expect(supportsMergeTree([2, 37, 9])).toBe(false);
    expect(supportsMergeTree([3, 0, 0])).toBe(true);
    const w = world();
    changeMine(w);
    pushTheirs(w, () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'), 'trim names');
    fetchMine(w);
    const spy = spyRunner();
    const report = await analyzeSync(w.mine, { run: spy.run, gitVersion: [2, 30, 0] });
    expect(report.method).toBe('files');
    expect(report.conflicts).toEqual([]);
    expect(report.overlap).toEqual([{ file: TABLE, commits: [git(w.mine, ['rev-parse', '--short=7', 'origin/main']).trim()] }]);
    expect(spy.calls.some((args) => args[0] === 'merge-tree')).toBe(false);
    expect(syncText(report).map(strip).join('\n')).toContain('git is older than 2.38: no trial merge, only files changed on both sides are compared');
  });

  it('never fetches unless asked (--fetch is the only network access)', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(w, () => editFile(w.theirs, 'lib/billing.ts', /$/, '\n// later\n'), 'later');
    const quiet = spyRunner();
    const report = await analyzeSync(w.mine, { run: quiet.run, branches: true });
    expect(report.behind).toBe(0);
    expect(quiet.calls.some((args) => args.includes('fetch'))).toBe(false);
    const fetching = spyRunner();
    const fetched = await analyzeSync(w.mine, { run: fetching.run, fetch: true });
    expect(fetching.calls.filter((args) => args[0] === 'fetch')).toEqual([['fetch', '--prune', '--quiet', 'origin']]);
    expect(fetched.behind).toBe(1);
    expect(fetched.fetchedAgo).toBeLessThan(60_000);
  });

  it('sync --json, the state for status lines, and errors', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(w, () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'), 'trim names');
    fetchMine(w);
    // State is kept with the warm cache on (the test environment turns it off).
    process.env.CODE_VISUALIZER_NO_CACHE = '';
    let result;
    try {
      result = await cli('sync', w.mine, '--json');
    } finally {
      process.env.CODE_VISUALIZER_NO_CACHE = '1';
    }
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as SyncReport;
    expect(report).toMatchObject({ base: 'origin/main', behind: 1, conflicts: [{ file: TABLE }] });
    expect(readState<SyncState>(w.mine, 'sync')).toMatchObject({ base: 'origin/main', behind: 1, ahead: 1, conflicts: 1, head: git(w.mine, ['rev-parse', 'HEAD']).trim() });
    const text = await cli('sync', w.mine);
    expect(text.stdout).toContain('origin/main is 1 commit ahead (Bob 1)');
    expect(text.stdout).toContain(`✖ conflict if you rebase now: ${TABLE}`);
    const unknown = await cli('sync', w.mine, '--base', 'origin/nope');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown base "origin/nope": no such branch or commit (fetched it?');
    expect(unknown.stderr).not.toContain('pass --base');
    // --json: errors are JSON too.
    const json = await cli('sync', w.mine, '--base', 'origin/nope', '--json');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout).error).toContain('Unknown base "origin/nope"');
    expect((await cli('sync', w.mine, '--since', '3d')).code).toBe(2);
    expect((await cli('sync', w.mine, '--branches', '--since', '2w', '--json')).code).toBe(0);
    expect((await cli('sync', makeTempDir('cv-not-a-repo-'))).code).toBe(1);
  });

  it('serve answers GET /api/sync and GET /api/status (token protected)', async () => {
    const w = world();
    changeMine(w);
    pushTheirs(w, () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'), 'trim names');
    fetchMine(w);
    const server = await serve({ root: w.mine, port: 0, includeSource: false, writeHistory: false, register: false });
    try {
      const base = server.url.replace(/\/$/, '');
      const headers = { 'X-CV-Token': server.info.token };
      expect((await httpRequest(`${base}/api/sync`)).status).toBe(401);
      expect((await httpRequest(`${base}/api/status`)).status).toBe(401);
      const sync = await httpRequest(`${base}/api/sync`, { headers });
      expect(sync.status).toBe(200);
      expect(JSON.parse(sync.text)).toMatchObject({ base: 'origin/main', behind: 1, conflicts: [{ file: TABLE }] });
      const status = JSON.parse((await httpRequest(`${base}/api/status`, { headers })).text) as StatusSnapshot;
      expect(status).toMatchObject({ version: 1, branch: 'feature', live: { url: server.url }, upstream: { name: 'origin/main', ahead: 1, behind: 1, conflicts: 1 } });
      expect(status.changes?.files).toBe(1);
      expect((await httpRequest(`${base}/api/sync?base=origin/nope`, { headers })).status).toBe(400);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('the server, the CLI and the status line agree on a configured base', async () => {
    const w = world();
    changeMine(w);
    // A gitflow-style base: origin/dev is ahead of origin/main.
    git(w.theirs, ['checkout', '-q', '-b', 'dev']);
    editFile(w.theirs, 'lib/billing.ts', /$/, '\n// dev\n');
    commitAll(w.theirs, { author: 'Bob', date: daysAgo(1), message: 'dev work' });
    editFile(w.theirs, 'lib/billing.ts', /$/, '\n// more dev\n');
    commitAll(w.theirs, { author: 'Bob', date: daysAgo(1), message: 'more dev work' });
    git(w.theirs, ['push', '-q', 'origin', 'dev']);
    fetchMine(w);
    const config = path.join(w.mine, 'code-visualizer.config.json');
    fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), base: 'origin/dev' }));
    const cliReport = JSON.parse((await cli('sync', w.mine, '--json', '--no-cache')).stdout) as SyncReport;
    expect(cliReport).toMatchObject({ base: 'origin/dev', behind: 2 });
    const server = await serve({ root: w.mine, port: 0, includeSource: false, writeHistory: false, register: false });
    try {
      const headers = { 'X-CV-Token': server.info.token };
      const url = server.url.replace(/\/$/, '');
      expect(JSON.parse((await httpRequest(`${url}/api/sync`, { headers })).text)).toMatchObject({ base: 'origin/dev', behind: 2 });
      expect(JSON.parse((await httpRequest(`${url}/api/status`, { headers })).text)).toMatchObject({ upstream: { name: 'origin/dev', behind: 2 } });
    } finally {
      await server.close();
    }
    // A server for part of the project does not answer for the status line.
    const scoped = await serve({ root: w.mine, port: 0, includeSource: false, writeHistory: false, register: false, directory: path.join(w.mine, 'lib') });
    try {
      expect((await httpRequest(`${scoped.url.replace(/\/$/, '')}/api/status`, { headers: { 'X-CV-Token': scoped.info.token } })).status).toBe(404);
    } finally {
      await scoped.close();
    }
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/*                               Release fixes                                */
/* -------------------------------------------------------------------------- */

describe.skipIf(!hasGit)('sync: release fixes', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  it('a branch that conflicts with your edit is a conflict even when the base conflicts on the same line', async () => {
    const w = world();
    changeMine(w);
    // Alice branches from the old main and edits the line you edited…
    git(w.theirs, ['checkout', '-q', '-b', 'alice/names', 'origin/main']);
    editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).toUpperCase()}</td>');
    commitAll(w.theirs, { author: 'Alice', date: daysAgo(1), message: 'upper' });
    git(w.theirs, ['push', '-q', 'origin', 'alice/names']);
    // …and main changes it too.
    git(w.theirs, ['checkout', '-q', 'main']);
    pushTheirs(w, () => editFile(w.theirs, TABLE, '<td>{formatUserName(u)}</td>', '<td>{formatUserName(u).trim()}</td>'), 'trim names');
    fetchMine(w);
    const report = await analyzeSync(w.mine, { branches: true });
    expect(report.conflicts).toEqual([{ file: TABLE }]);
    expect(report.branches).toEqual([expect.objectContaining({ ref: 'origin/alice/names', result: 'conflict', conflictFiles: [TABLE], verified: true })]);
    const text = syncText(report).map(strip).join('\n');
    expect(text).toContain(`✖ origin/alice/names (Alice) conflicts with your work in ${TABLE} (also conflicts with origin/main)`);
    expect(text).not.toContain('merges cleanly');
  });

  it('sync --base with a typo names the branch it was probably meant to be', async () => {
    const w = world();
    changeMine(w);
    const typo = await cli('sync', w.mine, '--base', 'mian');
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('Unknown base "mian"');
    expect(typo.stderr).toContain('Did you mean "main"?');
    expect(JSON.parse((await cli('sync', w.mine, '--base', 'mian', '--json')).stdout).error).toContain('Did you mean "main"?');
  });

  it('prints names from the repository with their control characters shown', () => {
    const hostile = '\u001b]0;OWNED\u0007';
    const report = {
      base: `origin/main${hostile}`,
      mergeBase: 'a'.repeat(40),
      behind: 1,
      ahead: 1,
      incoming: [],
      conflicts: [{ file: `src/x${hostile}.ts` }],
      overlap: [{ file: `src/y${hostile}.ts`, commits: ['abc1234'] }],
      semantic: [{ kind: 'export-removed', file: 'src/a.ts', symbol: 'a', message: `a() was removed${hostile}`, commit: 'abc1234', author: `Eve${hostile}`, yourSites: [{ file: `src/z${hostile}.ts`, line: 3, kind: 'call' }] }],
      authors: [{ name: `Eve${hostile}`, commits: 1 }],
      branches: [{ ref: `origin/eve${hostile}`, author: `Eve${hostile}`, updated: 1, files: [`src/x${hostile}.ts`], result: 'conflict', conflictFiles: [`src/x${hostile}.ts`], verified: true }],
      notes: [`note${hostile}`],
      recommendation: `git rebase origin/main${hostile}`,
      method: 'merge-tree',
    } as unknown as SyncReport;
    const text = syncText(report).join('\n');
    expect(text.replace(/\u001b\[[0-9;]*m/g, '')).not.toContain('\u001b');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('src/x\\e]0;OWNED\\x07.ts');
  });
});
