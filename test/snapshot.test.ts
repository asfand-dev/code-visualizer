import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as gitModule from '../src/analyzer/git.js';
import * as parseModule from '../src/analyzer/parse.js';
import { analyze, AnalyzeError, createAnalyzeCache } from '../src/analyzer/index.js';
import { takeSnapshot } from '../src/analyzer/overlay.js';
import { clearSnapshotCache, overlayForIndex, overlayForRef, renamesSince, snapshotAt } from '../src/analyzer/snapshot.js';
import { runCli } from '../src/cli/run.js';
import type { ArchitectureDelta, ReportData, ReportSnapshot } from '../src/shared/types.js';
import { commitAll, copyFixture, daysAgo, editFile, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

let restoreGit: () => void = () => undefined;
beforeAll(() => {
  restoreGit = isolateGit();
});
afterAll(() => {
  restoreGit();
  removeTempDirs();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearSnapshotCache();
});

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Run the CLI in-process and capture what it writes. */
async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sink: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
      cb?.();
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

const plain = { git: false, changes: false, history: false, includeSource: false } as const;
const UNICODE_FILE = 'src/lib/my file ü.ts';
const SPACED_FILE = 'src/lib/späce name.ts';
const CYCLE_IMPORT = "\nimport { useUsers } from '@/hooks/useUsers';\nexport const usersHook = useUsers;\n";

/** The parts of an analysis that a snapshot must reproduce exactly. */
function comparable(r: ReportSnapshot): unknown {
  return JSON.parse(JSON.stringify({ files: r.files.map(({ source: _s, ...f }) => f), edges: r.edges, routes: r.routes, insights: r.insights, symbolEdges: r.symbolEdges, apiCalls: r.apiCalls, packages: r.packages, health: r.health }));
}

/** `git worktree add --detach` of `ref` (outside the repository), for a reference analysis. */
function checkout(repo: string, ref: string): string {
  const dir = path.join(makeTempDir('cv-snap-wt-'), 'checkout');
  git(repo, ['worktree', 'add', '-q', '--detach', dir, ref]);
  return dir;
}

describe.skipIf(!hasGit)('snapshotAt', () => {
  let repo: string;
  let first: string;

  beforeAll(() => {
    // C1: the fixture plus files with spaces and non-ASCII characters in their names.
    repo = initRepo('react-vite-ts');
    writeFile(repo, UNICODE_FILE, "import { clamp } from '../utils/math';\nexport const unicode = clamp(1, 0, 2);\n");
    writeFile(repo, SPACED_FILE, "export function spaced(a: string): string {\n  return a.trim();\n}\n");
    editFile(repo, 'src/App.tsx', /^/, "import { unicode } from './lib/my file ü';\nimport { spaced } from './lib/späce name';\nexport const used = [unicode, spaced];\n");
    first = commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'one' });
    // C2: exactly two files differ — a new cycle in client.ts and the unicode file is deleted.
    fs.appendFileSync(path.join(repo, 'src/api/client.ts'), CYCLE_IMPORT);
    fs.rmSync(path.join(repo, UNICODE_FILE));
    commitAll(repo, { author: 'Ada', date: daysAgo(2), message: 'two' });
  });

  it('equals an analysis of a real checkout of that commit', async () => {
    const snap = await snapshotAt(repo, 'HEAD~1', { persist: false });
    expect(snap.commit).toBe(first);
    const reference = await analyze({ root: checkout(repo, 'HEAD~1'), ...plain });
    expect(comparable(snap)).toEqual(comparable(reference));
    // The deleted file with a unicode name is back, the cycle is not there yet.
    expect(snap.files.map((f) => f.id)).toContain(UNICODE_FILE);
    expect(snap.edges).toContainEqual(expect.objectContaining({ source: 'src/App.tsx', target: UNICODE_FILE }));
    expect(snap.insights.cycles).toEqual([['src/utils/format.ts', 'src/utils/math.ts']]);
    // The working tree is untouched.
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(repo, UNICODE_FILE))).toBe(false);
  });

  it('builds the overlay from git: changed files with their old text, added files as null', async () => {
    writeFile(repo, 'src/brand new.ts', 'export const fresh = 1;\n');
    try {
      const overlay = await overlayForRef(repo, 'HEAD~1');
      expect(Object.keys(overlay).sort()).toEqual(['src/api/client.ts', 'src/brand new.ts', UNICODE_FILE].sort());
      expect(overlay['src/brand new.ts']).toBeNull();
      expect(overlay[UNICODE_FILE]).toContain('export const unicode');
      expect(overlay['src/api/client.ts']).not.toContain('useUsers');
    } finally {
      fs.rmSync(path.join(repo, 'src/brand new.ts'));
    }
  });

  it('re-parses only the files that differ from the working tree', async () => {
    const cache = createAnalyzeCache();
    await analyze({ root: repo, ...plain, cache });
    const parse = vi.spyOn(parseModule, 'parseSource');
    const snap = await snapshotAt(repo, 'HEAD~1', { cache, persist: false });
    expect(parse.mock.calls.map((c) => c[0]).sort()).toEqual(['src/api/client.ts', UNICODE_FILE].sort());
    expect(snap.files.length).toBeGreaterThan(20);
    // Same version of a file again (another ref): served from the content cache.
    parse.mockClear();
    clearSnapshotCache();
    await snapshotAt(repo, first, { cache, persist: false });
    expect(parse).not.toHaveBeenCalled();
  });

  it('memoizes per commit in memory and on disk', async () => {
    const batch = vi.spyOn(gitModule, 'catFileBatch');
    const one = await snapshotAt(repo, 'HEAD~1');
    // Building reads the changed blobs (and checks which inputs git does not have).
    const builds = batch.mock.calls.length;
    expect(builds).toBeGreaterThanOrEqual(1);
    const stored = path.join(repo, '.code-visualizer', 'snapshots', `${first}.json.gz`);
    expect(fs.existsSync(stored)).toBe(true);
    // Second call: memory.
    expect(await snapshotAt(repo, first)).toBe(one);
    // After forgetting the memory: disk.
    clearSnapshotCache();
    const fromDisk = await snapshotAt(repo, 'HEAD~1');
    expect(fromDisk).not.toBe(one);
    expect(comparable(fromDisk)).toEqual(comparable(one));
    expect(batch).toHaveBeenCalledTimes(builds);
    // The state folder ignores itself, so the working tree stays clean.
    expect(git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('stores snapshots privately and trusts only those signed with this user\'s cache key', async () => {
    const run = vi.fn(analyze);
    const stored = path.join(repo, '.code-visualizer', 'snapshots', `${first}.json.gz`);
    fs.rmSync(stored, { force: true });
    await takeSnapshot(run, repo, 'HEAD~1');
    expect(run).toHaveBeenCalledTimes(1);
    if (process.platform !== 'win32') expect(fs.statSync(stored).mode & 0o777).toBe(0o600);
    clearSnapshotCache();
    await takeSnapshot(run, repo, 'HEAD~1');
    expect(run).toHaveBeenCalledTimes(1); // from disk this time
    // Another user's key (as for a snapshot that came with the repository): not trusted, rebuilt.
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = makeTempDir('cv-other-user-');
    try {
      clearSnapshotCache();
      await takeSnapshot(run, repo, 'HEAD~1');
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    // ... and what was written under that key is not trusted by this user either.
    clearSnapshotCache();
    await takeSnapshot(run, repo, 'HEAD~1');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('reads files whose name has spaces from git', async () => {
    editFile(repo, SPACED_FILE, 'return a.trim();', 'return a.trim().toLowerCase();');
    try {
      const overlay = await overlayForRef(repo, 'HEAD');
      expect(overlay[SPACED_FILE]).toBe("export function spaced(a: string): string {\n  return a.trim();\n}\n");
      const snap = await snapshotAt(repo, 'HEAD', { persist: false });
      const reference = await analyze({ root: checkout(repo, 'HEAD'), ...plain });
      expect(comparable(snap)).toEqual(comparable(reference));
    } finally {
      git(repo, ['checkout', '-q', '--', SPACED_FILE]);
    }
  });

  it('snapshots the staged index, ignoring unstaged edits', async () => {
    const client = path.join(repo, 'src/api/client.ts');
    const committed = fs.readFileSync(client, 'utf8');
    try {
      // Stage the fix of the cycle, then bring the cycle back without staging it.
      fs.writeFileSync(client, committed.replace(CYCLE_IMPORT, '\n'));
      git(repo, ['add', 'src/api/client.ts']);
      fs.writeFileSync(client, committed);
      const overlay = await overlayForIndex(repo);
      expect(Object.keys(overlay)).toEqual(['src/api/client.ts']);
      const staged = await analyze({ root: repo, overlay, ...plain });
      const worktree = await analyze({ root: repo, ...plain });
      expect(staged.insights.cycles).toHaveLength(1);
      expect(worktree.insights.cycles).toHaveLength(2);
    } finally {
      git(repo, ['reset', '-q', '--', 'src/api/client.ts']);
      fs.writeFileSync(client, committed);
    }
  });

  it('reads many blobs with one cat-file process, leaving out missing ones', async () => {
    const blobs = await gitModule.catFileBatch(repo, ['HEAD:package.json', 'HEAD:no/such/file.ts', `${first}:${UNICODE_FILE}`, `:${SPACED_FILE}`, 'HEAD:src']);
    expect([...blobs.keys()].sort()).toEqual(['HEAD:package.json', `${first}:${UNICODE_FILE}`, `:${SPACED_FILE}`].sort());
    expect(blobs.get(`${first}:${UNICODE_FILE}`)?.toString('utf8')).toContain('export const unicode');
    expect(JSON.parse(blobs.get('HEAD:package.json')!.toString('utf8')).name).toBe('react-vite-ts');
    expect(await gitModule.catFileBatch(repo, [])).toEqual(new Map());
  });

  it('rejects unknown refs and folders outside git', async () => {
    await expect(snapshotAt(repo, 'no-such-branch')).rejects.toThrow(AnalyzeError);
    await expect(snapshotAt(repo, 'no-such-branch')).rejects.toThrow('Unknown git ref "no-such-branch"');
    await expect(snapshotAt(repo, '--output=/tmp/x')).rejects.toThrow(AnalyzeError);
    const plainDir = copyFixture('react-vite-ts', 'cv-nogit-');
    await expect(snapshotAt(plainDir, 'HEAD')).rejects.toThrow(/not inside a git repository/);
  });

  it('`diff HEAD~1 --fail-on new-cycles` exits 1 when that commit added a cycle, 0 otherwise', async () => {
    const failed = await cli('diff', 'HEAD~1', repo, '--fail-on', 'new-cycles');
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('Architecture changes  HEAD~1');
    expect(failed.stdout).toContain('✖ new   src/api/client.ts → src/hooks/useUsers.ts → src/api/client.ts');
    expect(failed.stdout).toContain('✖ new-cycles 1 new circular dependency');

    const clean = await cli('diff', 'HEAD', repo, '--fail-on', 'new-cycles');
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('No architectural changes');
    expect(clean.stdout).toContain('✔ --fail-on new-cycles: nothing got worse');

    // The reverse direction (the tips: base..head) fixes the cycle; head can be any ref.
    const reverse = await cli('diff', 'HEAD..HEAD~1', repo, '--fail-on', 'new-cycles', '--json');
    expect(reverse.code).toBe(0);
    const json = JSON.parse(reverse.stdout) as { ok: boolean; failures: unknown[]; delta: ArchitectureDelta };
    expect(json.ok).toBe(true);
    expect(json.delta.fixedCycles).toEqual([['src/api/client.ts', 'src/hooks/useUsers.ts']]);
    expect(json.delta.head).toBe('HEAD~1');
  });

  it('`diff` writes markdown, and reports usage errors with exit code 2', async () => {
    const out = path.join(makeTempDir('cv-diff-out-'), 'arch.md');
    const md = await cli('diff', 'HEAD~1', '--root', repo, '--format', 'md', '-o', out);
    expect(md.code).toBe(0);
    expect(md.stderr).toContain(`Wrote ${out}`);
    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain('### Architecture changes');
    expect(text).toContain('**1 new circular dependency**');
    expect(text).toContain('```mermaid');

    expect((await cli('diff', 'HEAD~1', repo, '--fail-on', 'everything')).code).toBe(2);
    expect((await cli('diff', 'HEAD~1', repo, '--format', 'xml')).code).toBe(2);
    expect((await cli('diff', 'HEAD~1', 'HEAD', repo, '--staged')).code).toBe(2);
    const unknown = await cli('diff', 'nope', repo);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown git ref "nope"');
  });

  it('`diff --staged` compares HEAD with the index', async () => {
    const client = path.join(repo, 'src/api/client.ts');
    const committed = fs.readFileSync(client, 'utf8');
    try {
      fs.writeFileSync(client, committed.replace(CYCLE_IMPORT, '\n'));
      git(repo, ['add', 'src/api/client.ts']);
      fs.writeFileSync(client, committed); // unstaged: the cycle is back in the working tree
      const staged = await cli('diff', '--staged', repo, '--json');
      expect(staged.code).toBe(0);
      const delta = (JSON.parse(staged.stdout) as { delta: ArchitectureDelta }).delta;
      expect(delta.head).toBe('staged changes');
      expect(delta.fixedCycles).toEqual([['src/api/client.ts', 'src/hooks/useUsers.ts']]);
    } finally {
      git(repo, ['reset', '-q', '--', 'src/api/client.ts']);
      fs.writeFileSync(client, committed);
    }
  });
});

describe.skipIf(!hasGit)('snapshotAt in a sub-directory root', () => {
  it('equals a checkout of the same sub-directory', async () => {
    const repo = makeTempDir('cv-mono-');
    fs.cpSync(copyFixture('react-vite-ts'), path.join(repo, 'apps', 'web'), { recursive: true });
    writeFile(repo, 'README.md', '# monorepo\n');
    git(repo, ['init', '-q', '-b', 'main']);
    commitAll(repo, { author: 'Ada', date: daysAgo(2), message: 'one' });
    const web = path.join(repo, 'apps', 'web');
    fs.appendFileSync(path.join(web, 'src/api/client.ts'), CYCLE_IMPORT);
    const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    delete pkg.dependencies.zustand; // the snapshot must read package.json from git too
    fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify(pkg, null, 2));
    writeFile(repo, 'apps/other/x.ts', 'export const outside = 1;\n');
    commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'two' });

    const overlay = await overlayForRef(web, 'HEAD~1');
    expect(Object.keys(overlay).sort()).toEqual(['package.json', 'src/api/client.ts']);
    const snap = await snapshotAt(web, 'HEAD~1', { persist: false });
    const reference = await analyze({ root: path.join(checkout(repo, 'HEAD~1'), 'apps', 'web'), ...plain });
    expect(comparable(snap)).toEqual(comparable(reference));
    expect(snap.insights.missingDependencies).toEqual([]);
    const head = await analyze({ root: web, ...plain });
    expect(head.insights.missingDependencies.map((m) => m.name)).toEqual(['zustand']);
  });
});

describe.skipIf(!hasGit)('analyze({ compare })', () => {
  let repo: string;
  let data: ReportData;

  beforeAll(async () => {
    repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Ada', date: daysAgo(5), message: 'base' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    fs.appendFileSync(path.join(repo, 'src/api/client.ts'), CYCLE_IMPORT);
    commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'feature: cycle' });
    // Uncommitted work counts too: a comment-only edit next to the old format ↔ math cycle.
    editFile(repo, 'src/utils/math.ts', /^/, '// a comment\n');
    data = await analyze({ root: repo, includeSource: false, history: false, compare: true });
  });

  it('attaches the delta against the merge-base to the change set', () => {
    const delta = data.changes?.delta;
    expect(data.changes?.mode).toBe('branch');
    expect(delta).toBeDefined();
    expect(delta!.base).toBe('main');
    expect(delta!.baseCommit).toBe(git(repo, ['rev-parse', 'main']).trim());
    expect(delta!.head).toBe('working tree');
    // Only the new cycle is new; the old one next to the comment-only edit is not.
    expect(delta!.newCycles).toEqual([['src/api/client.ts', 'src/hooks/useUsers.ts']]);
    expect(delta!.fixedCycles).toEqual([]);
    expect(data.warnings.filter((w) => w.startsWith('Could not compare'))).toEqual([]);
  });

  it('compares uncommitted work on the main branch with HEAD', async () => {
    git(repo, ['stash', '-q']);
    git(repo, ['checkout', '-q', 'main']);
    try {
      fs.appendFileSync(path.join(repo, 'src/api/client.ts'), CYCLE_IMPORT);
      const onMain = await analyze({ root: repo, includeSource: false, history: false, compare: true });
      expect(onMain.changes?.mode).toBe('working');
      expect(onMain.changes?.delta?.base).toBe('HEAD');
      expect(onMain.changes?.delta?.newCycles).toHaveLength(1);
    } finally {
      git(repo, ['checkout', '-q', '--', '.']);
      git(repo, ['checkout', '-q', 'feature']);
      git(repo, ['stash', 'pop', '-q']);
    }
  });

  it('`pr` includes the architecture section', async () => {
    const { code, stdout } = await cli('pr', repo);
    expect(code).toBe(0);
    expect(stdout).toContain('### Architecture changes');
    expect(stdout).toContain('**1 new circular dependency**');
    expect(stdout).toContain('`client.ts` → `useUsers.ts` → `client.ts`');
    // -o creates missing folders.
    const out = path.join(makeTempDir('cv-pr-out-'), 'reports', 'pr.md');
    expect((await cli('pr', repo, '-o', out)).code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toContain('### Architecture changes');
  });

  it('the default `diff` base is the merge-base with the main branch', async () => {
    const { code, stdout } = await cli('diff', repo, '--json');
    expect(code).toBe(0);
    const delta = (JSON.parse(stdout) as { delta: ArchitectureDelta }).delta;
    expect(delta.base).toBe('main');
    expect(delta.baseCommit).toBe(git(repo, ['rev-parse', 'main']).trim());
    expect(delta.newCycles).toEqual([['src/api/client.ts', 'src/hooks/useUsers.ts']]);
  });

  it('a named base is compared from the merge-base, like a pull request; base..head compares the tips', async () => {
    // main moves on after the feature branch left it: an unrelated new cycle and a breaking change.
    git(repo, ['stash', '-q']);
    git(repo, ['checkout', '-q', 'main']);
    const mergeBase = git(repo, ['rev-parse', 'HEAD']).trim();
    fs.appendFileSync(path.join(repo, 'src/components/Card.tsx'), "\nimport { Avatar } from './Avatar';\nexport const cardAvatar = Avatar;\n");
    fs.appendFileSync(path.join(repo, 'src/components/Avatar.tsx'), "\nimport { Card } from './Card';\nexport const avatarCard = Card;\n");
    editFile(repo, 'src/utils/format.ts', 'formatDate(iso: string)', 'formatDate(iso: string, digits = 2)');
    commitAll(repo, { author: 'Bo', date: daysAgo(0), message: 'main: another cycle' });
    git(repo, ['checkout', '-q', 'feature']);
    git(repo, ['stash', 'pop', '-q']);

    const named = await cli('diff', 'main', repo, '--json', '--fail-on', 'new-cycles,breaking-exports');
    expect(named.code).toBe(1); // the feature's own cycle
    const prLike = (JSON.parse(named.stdout) as { delta: ArchitectureDelta }).delta;
    expect(prLike).toMatchObject({ base: 'main', baseCommit: mergeBase, mergeBase: true });
    expect(prLike.fixedCycles).toEqual([]);
    expect(prLike.newCycles).toEqual([['src/api/client.ts', 'src/hooks/useUsers.ts']]);
    // main's later change to formatDate is not blamed on the branch.
    expect(prLike.exports.find((e) => e.name === 'formatDate')).toBeUndefined();
    // The header says what was compared.
    const text = await cli('diff', 'main', repo);
    expect(text.stdout).toContain(`Architecture changes  merge-base with main (${mergeBase.slice(0, 10)}) → working tree`);
    // -b / --base is the same as the base argument; --merge-base is the default.
    for (const args of [['--base', 'main'], ['-b', 'main', '--merge-base'], ['main...HEAD']]) {
      const same = (JSON.parse((await cli('diff', ...args, '--root', repo, '--json')).stdout) as { delta: ArchitectureDelta }).delta;
      expect(same.baseCommit).toBe(mergeBase);
      expect(same.newCycles).toEqual(prLike.newCycles);
    }
    // The tips: main's new cycle looks "fixed" and its new parameter looks removed.
    const tips = (JSON.parse((await cli('diff', 'main..', repo, '--json')).stdout) as { delta: ArchitectureDelta }).delta;
    expect(tips.baseCommit).toBe(git(repo, ['rev-parse', 'main']).trim());
    expect(tips.mergeBase).toBeUndefined();
    expect(tips.head).toBe('HEAD');
    expect(tips.fixedCycles).toHaveLength(1);
    expect(tips.exports.find((e) => e.name === 'formatDate')).toMatchObject({ change: 'signature', before: 'formatDate(iso: string, digits?): string', after: 'formatDate(iso: string): string', breaking: true });
  });

  it('suggests the closest ref for typos and rejects conflicting arguments', async () => {
    const typo = await cli('diff', 'mian', repo);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('Unknown git ref "mian". Did you mean "main"?');
    expect((await cli('diff', 'main..feature', 'HEAD', repo)).code).toBe(2);
    expect((await cli('diff', '--base', 'main', 'feature', 'HEAD', repo)).code).toBe(2);
    const failOn = await cli('diff', repo, '--fail-on', 'new-cycle');
    expect(failOn.code).toBe(2);
    expect(failOn.stderr).toContain('did you mean "new-cycles"?');
  });
});

describe.skipIf(!hasGit)('snapshots stay true to their commit', () => {
  it('retries when a file changes on disk while the snapshot is taken, and does not cache the mix', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Ada', date: daysAgo(2), message: 'one' });
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    const reference = await analyze({ root: repo, ...plain });
    const math = path.join(repo, 'src/utils/math.ts');
    const committed = fs.readFileSync(math, 'utf8');
    let runs = 0;
    try {
      const snap = await takeSnapshot(
        async (options) => {
          // A save lands in the middle of the first attempt.
          if (runs++ === 0) fs.writeFileSync(math, `${committed}\nimport { formatDate } from './format';\nexport const late = formatDate;\n`);
          return analyze(options);
        },
        repo,
        'HEAD',
      );
      expect(runs).toBe(2);
      expect(comparable(snap)).toEqual(comparable(reference));
      expect(fs.existsSync(path.join(repo, '.code-visualizer', 'snapshots', `${head}.json.gz`))).toBe(true);
    } finally {
      fs.writeFileSync(math, committed);
    }
  });

  it('a stored snapshot is rebuilt when a generated config outside git changes', async () => {
    const repo = initRepo('react-vite-ts');
    writeFile(repo, '.gitignore', '.nuxt/\n');
    commitAll(repo, { author: 'Ada', date: daysAgo(2), message: 'one' });
    writeFile(repo, '.nuxt/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }));
    const run = vi.fn(analyze);
    await takeSnapshot(run, repo, 'HEAD');
    clearSnapshotCache();
    await takeSnapshot(run, repo, 'HEAD');
    expect(run).toHaveBeenCalledTimes(1); // from disk
    writeFile(repo, '.nuxt/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '#/*': ['./src/*'] } } }));
    clearSnapshotCache();
    await takeSnapshot(run, repo, 'HEAD');
    expect(run).toHaveBeenCalledTimes(2); // the stored one no longer matches the disk
  });
});

describe.skipIf(!hasGit)('snapshots see the nested sub-projects of their commit (accuracy-pass)', () => {
  it('a package.json added or removed since the ref decides what the snapshot leaves out', async () => {
    const repo = initRepo('react-vite-ts');
    writeFile(repo, 'examples/demo/main.ts', "import { formatDate } from '../../src/utils/format';\nexport const demo = formatDate;\n");
    commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'demo without a package.json' });
    writeFile(repo, 'examples/demo/package.json', JSON.stringify({ name: 'demo', dependencies: { react: '^18.0.0' } }));
    commitAll(repo, { author: 'Ada', date: daysAgo(2), message: 'demo becomes a separate package' });
    const ids = (r: ReportSnapshot): string[] => r.files.map((f) => f.id);

    // Working tree (HEAD): the demo is a nested example project, left out.
    const now = await analyze({ root: repo, ...plain });
    expect(now.project.subprojects).toEqual(['examples/demo']);
    expect(ids(now)).not.toContain('examples/demo/main.ts');
    // HEAD~1 had no package.json there (deleted in the overlay): the demo was part of the project.
    const before = await snapshotAt(repo, 'HEAD~1', { persist: false });
    expect(ids(before)).toContain('examples/demo/main.ts');

    // The other way round: the package.json exists only in the snapshot (removed on disk).
    git(repo, ['rm', '-q', 'examples/demo/package.json']);
    commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'demo joins the app again' });
    expect(ids(await analyze({ root: repo, ...plain }))).toContain('examples/demo/main.ts');
    expect(ids(await snapshotAt(repo, 'HEAD~1', { persist: false }))).not.toContain('examples/demo/main.ts');
  });
});

describe.skipIf(!hasGit)('diff in everyday situations', () => {
  it('a base without source files (first scaffold) reports everything as new instead of failing', async () => {
    const repo = makeTempDir('cv-empty-base-');
    writeFile(repo, 'README.md', '# new project\n');
    git(repo, ['init', '-q', '-b', 'main']);
    commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'Initial commit' });
    git(repo, ['checkout', '-q', '-b', 'scaffold']);
    fs.cpSync(copyFixture('react-vite-ts'), repo, { recursive: true });
    commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'scaffold' });

    const result = await cli('diff', repo, '--json', '--fail-on', 'new-cycles,health-drop:0');
    expect(result.code).toBe(1);
    const json = JSON.parse(result.stdout) as { failures: { rule: string }[]; delta: ArchitectureDelta };
    expect(json.failures.map((f) => f.rule)).toEqual(['new-cycles']); // health is neutral
    expect(json.delta.newCycles).toEqual([['src/utils/format.ts', 'src/utils/math.ts']]);
    expect(json.delta.health.before).toBe(json.delta.health.after);

    // A new package in a monorepo: the sub-directory does not exist at the base.
    const pkg = path.join(repo, 'packages', 'newpkg');
    writeFile(repo, 'packages/newpkg/package.json', '{ "name": "newpkg" }\n');
    writeFile(repo, 'packages/newpkg/src/a.ts', "import { b } from './b';\nexport const a = () => b;\n");
    writeFile(repo, 'packages/newpkg/src/b.ts', "import { a } from './a';\nexport const b = () => a;\n");
    commitAll(repo, { author: 'Ada', date: daysAgo(0), message: 'new package' });
    const sub = await cli('diff', 'HEAD~1', pkg, '--fail-on', 'new-cycles');
    expect(sub.code).toBe(1);
    expect(sub.stdout).toContain('✖ new   src/a.ts → src/b.ts → src/a.ts');
    expect(sub.stderr).toBe('');
    // analyze({ compare }) in the package attaches a delta instead of a warning.
    const data = await analyze({ root: pkg, includeSource: false, history: false, compare: true });
    expect(data.warnings.filter((w) => w.startsWith('Could not compare'))).toEqual([]);
  });

  it('a renamed file keeps its old cycle, unused exports and complexity (git mv with edits)', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'base' });
    git(repo, ['checkout', '-q', '-b', 'rename']);
    git(repo, ['mv', 'src/utils/math.ts', 'src/utils/mathx.ts']);
    fs.appendFileSync(path.join(repo, 'src/utils/mathx.ts'), '\n// moved\n');
    editFile(repo, 'src/utils/format.ts', "from './math'", "from './mathx'");
    editFile(repo, 'src/pages/Home.tsx', "from '@/utils/math'", "from '@/utils/mathx'");
    commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'rename math' });

    expect([...(await renamesSince(repo, 'main', 'HEAD'))]).toEqual([['src/utils/math.ts', 'src/utils/mathx.ts']]);
    const result = await cli('diff', repo, '--json', '--fail-on', 'new-cycles,breaking-exports');
    expect(result.code).toBe(0);
    const delta = (JSON.parse(result.stdout) as { delta: ArchitectureDelta }).delta;
    expect(delta.renamed).toEqual([{ from: 'src/utils/math.ts', to: 'src/utils/mathx.ts' }]);
    expect(delta).toMatchObject({ newCycles: [], fixedCycles: [], newUnusedExports: [], fingerprints: { new: [], fixed: [] } });
    // The same through analyze({ compare }) (pr, check --changed, serve).
    const data = await analyze({ root: repo, includeSource: false, history: false, compare: true });
    expect(data.changes?.delta).toMatchObject({ newCycles: [], fixedCycles: [], newUnusedExports: [] });
  });

  it('fails with exit code 2 and a hint when a shallow clone has no merge-base', async () => {
    const origin = initRepo('react-vite-ts');
    commitAll(origin, { author: 'Ada', date: daysAgo(3), message: 'base' });
    git(origin, ['checkout', '-q', '-b', 'feature']);
    editFile(origin, 'src/App.tsx', /$/, '\n// harmless\n');
    commitAll(origin, { author: 'Ada', date: daysAgo(2), message: 'feature' });
    git(origin, ['checkout', '-q', 'main']);
    editFile(origin, 'src/utils/format.ts', 'formatDate(iso: string)', 'formatDate(iso: string, digits = 2)');
    commitAll(origin, { author: 'Bo', date: daysAgo(1), message: 'main moves on' });

    const clone = path.join(makeTempDir('cv-shallow-'), 'clone');
    git(path.dirname(clone), ['clone', '-q', '--depth', '1', '--no-single-branch', '--branch', 'feature', `file://${origin}`, clone]);
    const result = await cli('diff', 'origin/main', clone, '--fail-on', 'breaking-exports');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No common history between origin/main and HEAD: this is a shallow clone.');
    expect(result.stderr).toContain('fetch-depth: 0');
    expect(result.stdout).toBe('');
    // The tips can still be compared explicitly.
    expect((await cli('diff', 'origin/main..HEAD', clone, '--json')).code).toBe(0);
  });

  it('the health after the change matches check and report for the working tree', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'base' });
    fs.appendFileSync(path.join(repo, 'src/api/client.ts'), CYCLE_IMPORT);
    const full = await analyze({ root: repo, includeSource: false, history: false, changes: false });
    expect(full.health.categories.some((c) => c.id === 'knowledge')).toBe(true);
    const delta = (JSON.parse((await cli('diff', repo, '--json')).stdout) as { delta: ArchitectureDelta }).delta;
    expect(delta.health.after).toBe(full.health.score);
  });

  it('writes into new folders, reports write errors with exit 2 and explains gate failures outside text output', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'base' });
    fs.appendFileSync(path.join(repo, 'src/api/client.ts'), CYCLE_IMPORT);
    const dir = makeTempDir('cv-diff-o-');

    const md = await cli('diff', repo, '--format', 'md', '-o', path.join(dir, 'reports', 'arch.md'), '--fail-on', 'new-cycles');
    expect(md.code).toBe(1);
    expect(fs.readFileSync(path.join(dir, 'reports', 'arch.md'), 'utf8')).toContain('**1 new circular dependency**');
    expect(md.stderr).toContain('✖ new-cycles: 1 new circular dependency: client.ts → useUsers.ts → client.ts');

    const json = await cli('diff', repo, '--json', '--fail-on', 'new-cycles');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false });
    expect(json.stderr).toContain('✖ new-cycles:');

    // -q: only the failures on stdout; the report still goes to -o.
    const quiet = await cli('diff', repo, '-q', '--fail-on', 'new-cycles');
    expect(quiet.stdout.trim()).toBe('✖ new-cycles 1 new circular dependency: client.ts → useUsers.ts → client.ts');
    const quietMd = await cli('diff', repo, '-q', '--format', 'md', '-o', path.join(dir, 'q.md'));
    expect(quietMd).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(fs.readFileSync(path.join(dir, 'q.md'), 'utf8')).toContain('### Architecture changes');

    writeFile(dir, 'file.txt', 'not a folder\n');
    const blocked = await cli('diff', repo, '-o', path.join(dir, 'file.txt', 'arch.md'));
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('Cannot write');

    // Text output says where: the import behind a new area dependency.
    const text = await cli('diff', repo);
    expect(text.stdout).toMatch(/\+ src\/api → src\/hooks {2}1 import \(new\)\n {8}src\/api\/client\.ts:\d+ → src\/hooks\/useUsers\.ts/);
  });
});
