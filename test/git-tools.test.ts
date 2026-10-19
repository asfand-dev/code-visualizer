import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGitToolsService, type GitToolsResponse, type GitToolsService } from '../src/server/git-tools.js';
import { serve, type LiveServer } from '../src/server/index.js';
import type { BranchDeleteResult, GitCommitDetail, GitSearchResult, GitStandupCommits, ReportData } from '../src/shared/types.js';
import { commitAll, daysAgo, git, hasGit, httpRequest, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const hasTemplate = fs.existsSync(fileURLToPath(new URL('../dist/report/index.html', import.meta.url)));
const identity = ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false'];
const gitAs = (repo: string, args: string[]): string => git(repo, [...identity, ...args]);
const branchNames = (repo: string): string[] => git(repo, ['branch', '--format=%(refname:short)']).trim().split('\n');

interface Repository {
  root: string;
  /** Full hashes by name: root, cart, drop, merge. */
  hash: Record<string, string>;
}

/**
 * main: root (Ada, 45 days ago) → cart (Ada, 20 days ago; a multi-line message, a binary file) → drop (Grace, 2 days ago),
 * then feature/merged (merged with a merge commit), feature/open (unmerged), feature/wt (checked out in a worktree)
 * and develop (a protected name at the tip of main).
 */
function buildRepository(): Repository {
  const root = makeTempDir('cv-gitools-');
  git(root, ['init', '-q', '-b', 'main']);
  writeFile(root, 'README.md', '# demo\n');
  const rootHash = commitAll(root, { author: 'Ada', date: daysAgo(45), message: 'chore: initial commit' });
  writeFile(root, 'src/cart.ts', 'export const MAGIC_TOTAL = 1;\nexport const keep = 2;\n');
  fs.writeFileSync(path.join(root, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const cartHash = commitAll(root, { author: 'Ada', date: daysAgo(20), message: 'feat(cart): add total\n\nFirst line of the body.\n\nSecond paragraph.' });
  writeFile(root, 'src/cart.ts', 'export const keep = 2;\n');
  const dropHash = commitAll(root, { author: 'Grace', date: daysAgo(2), message: 'fix: drop the magic number' });

  git(root, ['checkout', '-q', '-b', 'feature/merged']);
  writeFile(root, 'src/merged.ts', 'export const merged = 1;\n');
  commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'feat: merged work' });
  git(root, ['checkout', '-q', 'main']);
  gitAs(root, ['merge', '--no-ff', '-q', '-m', 'Merge feature/merged', 'feature/merged']);
  const mergeHash = git(root, ['rev-parse', 'HEAD']).trim();

  git(root, ['checkout', '-q', '-b', 'feature/open']);
  writeFile(root, 'src/open.ts', 'export const open = 1;\n');
  commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'feat: open work' });
  git(root, ['checkout', '-q', 'main']);
  git(root, ['branch', 'develop']);
  git(root, ['branch', 'feature/wt']);
  git(root, ['worktree', 'add', '-q', path.join(makeTempDir('cv-gitools-wt-'), 'wt'), 'feature/wt']);
  return { root, hash: { root: rootHash, cart: cartHash, drop: dropHash, merge: mergeHash } };
}

function makeService(root: string): { service: GitToolsService; changed: ReturnType<typeof vi.fn> } {
  const changed = vi.fn();
  return { service: createGitToolsService({ root, onBranchesChanged: changed }), changed };
}

const get = (service: GitToolsService, pathname: string, query: Record<string, string> = {}): Promise<GitToolsResponse | undefined> =>
  service.handle({ method: 'GET', pathname, params: new URLSearchParams(query), loopback: true, readBody: async () => '' });

const post = (service: GitToolsService, body: string, loopback = true): Promise<GitToolsResponse | undefined> =>
  service.handle({ method: 'POST', pathname: '/api/git/delete-branches', params: new URLSearchParams(), loopback, readBody: async () => body });

const del = (service: GitToolsService, branches: unknown, loopback = true): Promise<GitToolsResponse | undefined> => post(service, JSON.stringify({ branches }), loopback);

const search = async (service: GitToolsService, mode: string, q: string, extra: Record<string, string> = {}): Promise<GitToolsResponse> => (await get(service, '/api/git/search', { mode, q, ...extra }))!;
const subjects = (response: GitToolsResponse): string[] => (response.body as GitSearchResult).commits.map((c) => c.subject);

describe.runIf(hasGit)('git tools: search', () => {
  let restoreGit: () => void;
  let repository: Repository;
  let service: GitToolsService;
  beforeAll(() => {
    restoreGit = isolateGit();
    repository = buildRepository();
    service = makeService(repository.root).service;
  });
  afterAll(() => restoreGit());

  it('finds the commits that added or removed a text, newest first, with the files they changed', async () => {
    const response = await search(service, 'text', 'MAGIC_TOTAL');
    expect(response.status).toBe(200);
    expect(subjects(response)).toEqual(['fix: drop the magic number', 'feat(cart): add total']);
    const [drop] = (response.body as GitSearchResult).commits;
    expect(drop).toMatchObject({ hash: repository.hash.drop, author: 'Grace', files: ['src/cart.ts'], fileCount: 1 });
    expect(drop.date).toBe(daysAgo(2));
  });

  it('searches with a regular expression', async () => {
    expect(subjects(await search(service, 'regex', 'MAGIC_[A-Z]+'))).toEqual(['fix: drop the magic number', 'feat(cart): add total']);
  });

  it('searches the messages as text: no case, no regex (parentheses are parentheses)', async () => {
    expect(subjects(await search(service, 'message', 'FEAT(CART)'))).toEqual(['feat(cart): add total']);
    expect(subjects(await search(service, 'message', '.*'))).toEqual([]);
  });

  it('searches an author as text', async () => {
    expect(subjects(await search(service, 'author', 'grace'))).toEqual(['fix: drop the magic number']);
    expect(subjects(await search(service, 'author', '.*'))).toEqual([]);
  });

  it('lists the history of a file, literally (a glob matches nothing)', async () => {
    expect(subjects(await search(service, 'file', 'src/cart.ts'))).toEqual(['fix: drop the magic number', 'feat(cart): add total']);
    expect(subjects(await search(service, 'file', 'src/*.ts'))).toEqual([]);
  });

  it('searches the branches that are not checked out only when asked', async () => {
    expect(subjects(await search(service, 'message', 'open work'))).toEqual([]);
    expect(subjects(await search(service, 'message', 'open work', { all: '1' }))).toEqual(['feat: open work']);
  });

  it('limits the results and says there are more', async () => {
    const response = await search(service, 'author', 'Ada', { all: '1', limit: '2' });
    expect((response.body as GitSearchResult).commits).toHaveLength(2);
    expect((response.body as GitSearchResult).truncated).toBe(true);
    const all = await search(service, 'author', 'Ada', { all: '1', limit: '200' });
    expect((all.body as GitSearchResult).truncated).toBe(false);
  });

  it('lists a limited number of files per commit and counts all of them', async () => {
    const wide = makeTempDir('cv-gitools-wide-');
    git(wide, ['init', '-q', '-b', 'main']);
    for (let i = 0; i < 12; i++) writeFile(wide, `f${i}.txt`, 'x\n');
    commitAll(wide, { author: 'Ada', date: daysAgo(1), message: 'many files' });
    const [commit] = ((await search(makeService(wide).service, 'message', 'many')).body as GitSearchResult).commits;
    expect(commit.files).toHaveLength(8);
    expect(commit.fileCount).toBe(12);
  });

  it('never lets what was typed act as an option of git', async () => {
    const outside = path.join(makeTempDir('cv-gitools-out-'), 'pwned.txt');
    for (const mode of ['text', 'regex', 'message', 'author', 'file']) {
      for (const q of [`--output=${outside}`, '--all', '-p']) {
        const response = await search(service, mode, q);
        expect([200, 400], `${mode} ${q}`).toContain(response.status);
        if (response.status === 200) expect(subjects(response), `${mode} ${q}`).toEqual([]);
      }
    }
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('refuses what cannot be searched, with a reason', async () => {
    const bad = async (query: Record<string, string>, status: number, message: RegExp): Promise<void> => {
      const response = (await get(service, '/api/git/search', query))!;
      expect(response.status, JSON.stringify(query)).toBe(status);
      expect((response.body as { error: string }).error).toMatch(message);
    };
    await bad({ mode: 'text' }, 400, /\?q=/);
    await bad({ mode: 'text', q: '   ' }, 400, /\?q=/);
    await bad({ mode: 'text', q: 'a'.repeat(201) }, 400, /longer than 200/);
    await bad({ mode: 'text', q: 'a\nb' }, 400, /line breaks/);
    await bad({ mode: 'text', q: 'a\0b' }, 400, /line breaks/);
    await bad({ mode: 'nope', q: 'x' }, 400, /Unknown search mode "nope"/);
    await bad({ mode: 'regex', q: '(' }, 400, /./);
    await bad({ mode: 'file', q: '../outside' }, 400, /outside repository/);
  });

  it('answers only the endpoints it owns, and only with GET', async () => {
    expect(await get(service, '/api/git/nothing')).toBeUndefined();
    expect(await get(service, '/api/other')).toBeUndefined();
    const response = await service.handle({ method: 'POST', pathname: '/api/git/search', params: new URLSearchParams({ q: 'x' }), loopback: true, readBody: async () => '' });
    expect(response?.status).toBe(405);
  });

  it('runs at most two searches at once', async () => {
    const statuses = (await Promise.all([search(service, 'text', 'MAGIC_TOTAL'), search(service, 'text', 'keep'), search(service, 'text', 'merged'), search(service, 'text', 'open')])).map((r) => r.status);
    expect(statuses.slice(0, 2)).toEqual([200, 200]);
    expect(statuses.slice(2)).toEqual([429, 429]);
    // The slots are free again afterwards.
    expect((await search(service, 'text', 'keep')).status).toBe(200);
  });

  it('says so when the repository has no commits', async () => {
    const empty = makeTempDir('cv-gitools-empty-');
    git(empty, ['init', '-q', '-b', 'main']);
    const response = await search(makeService(empty).service, 'text', 'x');
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toMatch(/no commits|does not have any commits/i);
  });
});

describe.runIf(hasGit)('git tools: one commit', () => {
  let restoreGit: () => void;
  let repository: Repository;
  let service: GitToolsService;
  const detail = async (hash: string): Promise<GitToolsResponse> => (await get(service, '/api/git/commit', { hash }))!;
  beforeAll(() => {
    restoreGit = isolateGit();
    repository = buildRepository();
    service = makeService(repository.root).service;
  });
  afterAll(() => restoreGit());

  it('describes a commit by a short hash: message, body, parents, files with their lines and the branches that have it', async () => {
    const response = await detail(repository.hash.cart.slice(0, 7));
    expect(response.status).toBe(200);
    const commit = response.body as GitCommitDetail;
    expect(commit).toMatchObject({ hash: repository.hash.cart, parents: [repository.hash.root], author: 'Ada', subject: 'feat(cart): add total', fileCount: 2, additions: 2, deletions: 0 });
    expect(commit.body).toBe('First line of the body.\n\nSecond paragraph.');
    expect(commit.date).toBe(daysAgo(20));
    expect(commit.files).toEqual(
      expect.arrayContaining([
        { path: 'src/cart.ts', additions: 2, deletions: 0 },
        { path: 'logo.bin', additions: 0, deletions: 0, binary: true },
      ]),
    );
    expect(commit.containedIn).toEqual(expect.arrayContaining(['main', 'feature/merged', 'feature/open']));
  });

  it('shows what a commit removed', async () => {
    const commit = (await detail(repository.hash.drop)).body as GitCommitDetail;
    expect(commit.files).toEqual([{ path: 'src/cart.ts', additions: 0, deletions: 1 }]);
    expect(commit.deletions).toBe(1);
  });

  it('shows a merge against its first parent and a root commit as added files', async () => {
    const merge = (await detail(repository.hash.merge)).body as GitCommitDetail;
    expect(merge.parents).toHaveLength(2);
    expect(merge.files).toEqual([{ path: 'src/merged.ts', additions: 1, deletions: 0 }]);
    const first = (await detail(repository.hash.root)).body as GitCommitDetail;
    expect(first.parents).toEqual([]);
    expect(first.files).toEqual([{ path: 'README.md', additions: 1, deletions: 0 }]);
  });

  it('does not list a remote HEAD pointer or a detached HEAD as a branch', async () => {
    git(repository.root, ['update-ref', 'refs/remotes/origin/main', 'main']);
    git(repository.root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(repository.root, ['checkout', '-q', '--detach']);
    try {
      const { containedIn } = (await detail(repository.hash.drop)).body as GitCommitDetail;
      expect(containedIn).toContain('main');
      expect(containedIn).toContain('origin/main');
      expect(containedIn.filter((name) => name.endsWith('HEAD') || name.startsWith('('))).toEqual([]);
    } finally {
      git(repository.root, ['checkout', '-q', 'main']);
    }
  });

  it('refuses what is not a commit hash, and says when a commit does not exist', async () => {
    for (const hash of ['', 'main', '--help', '-p', 'zzzzzzz', 'abc', `${repository.hash.cart};ls`]) {
      expect((await detail(hash)).status, JSON.stringify(hash)).toBe(400);
    }
    const missing = await detail('deadbeefdeadbeef');
    expect(missing.status).toBe(404);
    expect((missing.body as { error: string }).error).toContain('deadbeefdead');
  });

  it('does not show another commit when a branch is named like the short hash: it asks for the full hash', async () => {
    const short = repository.hash.cart.slice(0, 7);
    git(repository.root, ['branch', short, repository.hash.root]);
    try {
      const ambiguous = await detail(short);
      expect(ambiguous.status).toBe(400);
      expect((ambiguous.body as { error: string }).error).toMatch(/full hash/);
      expect(((await detail(repository.hash.cart)).body as GitCommitDetail).hash).toBe(repository.hash.cart);
    } finally {
      git(repository.root, ['branch', '-D', short]);
    }
  });
});

describe.runIf(hasGit)('git tools: standup', () => {
  let restoreGit: () => void;
  let repository: Repository;
  let service: GitToolsService;
  const standup = async (query: Record<string, string> = {}): Promise<GitStandupCommits> => (await get(service, '/api/git/standup', query))!.body as GitStandupCommits;
  beforeAll(() => {
    restoreGit = isolateGit();
    repository = buildRepository();
    service = makeService(repository.root).service;
  });
  afterAll(() => restoreGit());

  it('lists everybody’s commits of the last days when git does not know the user', async () => {
    const { user, commits } = await standup({ days: '3' });
    expect(user).toBeUndefined();
    expect(commits.map((c) => c.subject).sort()).toEqual(['feat: merged work', 'feat: open work', 'fix: drop the magic number']);
  });

  it('lists the commits of the configured user from every branch, without merge commits', async () => {
    git(repository.root, ['config', 'user.name', 'Ada']);
    try {
      const { user, commits } = await standup({ days: '3' });
      expect(user).toBe('Ada');
      expect(commits.map((c) => c.subject).sort()).toEqual(['feat: merged work', 'feat: open work']);
      expect(commits.every((c) => c.author === 'Ada' && c.hash.length === 40 && c.date > 0)).toBe(true);
    } finally {
      git(repository.root, ['config', '--unset', 'user.name']);
    }
  });

  it('looks back a week by default and at most 30 days', async () => {
    expect((await standup()).commits.map((c) => c.subject)).not.toContain('feat(cart): add total');
    const month = (await standup({ days: '999' })).commits.map((c) => c.subject);
    expect(month).toContain('feat(cart): add total');
    expect(month).not.toContain('chore: initial commit');
    expect((await standup({ days: 'abc' })).commits.length).toBe((await standup()).commits.length);
  });

  it('has nothing to say, without an error, in a repository without commits', async () => {
    const empty = makeTempDir('cv-gitools-empty-');
    git(empty, ['init', '-q', '-b', 'main']);
    const response = await get(makeService(empty).service, '/api/git/standup');
    expect(response).toEqual({ status: 200, body: { commits: [] } });
  });

  it('does not list the commits that git makes for a stash', async () => {
    const stashed = makeTempDir('cv-gitools-stash-');
    git(stashed, ['init', '-q', '-b', 'main']);
    writeFile(stashed, 'a.txt', 'one\n');
    commitAll(stashed, { author: 'Ada', date: daysAgo(1), message: 'feat: real work' });
    writeFile(stashed, 'a.txt', 'two\n');
    gitAs(stashed, ['stash']);
    expect(git(stashed, ['log', '--all', '--format=%s']).split('\n')).toContain('WIP on main: ' + git(stashed, ['log', '-1', '--format=%h %s', 'main']).trim());

    const { service: stashService } = makeService(stashed);
    const recent = (await get(stashService, '/api/git/standup'))!.body as GitStandupCommits;
    expect(recent.commits.map((c) => c.subject)).toEqual(['feat: real work']);
    expect(subjects(await search(stashService, 'message', 'WIP', { all: '1' }))).toEqual([]);
  });
});

describe.runIf(hasGit)('git tools: delete merged branches', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  const result = (response: GitToolsResponse | undefined): BranchDeleteResult => response!.body as BranchDeleteResult;

  it('deletes a merged branch, tells where it pointed (to bring it back) and that the analysis is out of date', async () => {
    const { root } = buildRepository();
    const tip = git(root, ['rev-parse', 'feature/merged']).trim();
    const { service, changed } = makeService(root);
    const response = await del(service, ['feature/merged']);
    expect(response?.status).toBe(200);
    expect(result(response)).toEqual({ deleted: [{ name: 'feature/merged', hash: tip }], refused: [] });
    expect(branchNames(root)).not.toContain('feature/merged');
    expect(changed).toHaveBeenCalledTimes(1);
    // The reported hash is enough to undo it.
    git(root, ['branch', 'feature/merged', tip]);
    expect(git(root, ['rev-parse', 'feature/merged']).trim()).toBe(tip);
  });

  it('refuses a branch with work that is not merged, a protected one, one in a worktree and one that does not exist', async () => {
    const { root } = buildRepository();
    const { service, changed } = makeService(root);
    const outcome = result(await del(service, ['feature/open', 'develop', 'main', 'feature/wt', 'feature/nothing', 'origin/feature/x']));
    expect(outcome.deleted).toEqual([]);
    expect(Object.fromEntries(outcome.refused.map((r) => [r.name, r.reason]))).toEqual({
      'feature/open': 'It is not merged into main.',
      develop: 'It is a protected branch.',
      main: 'It is checked out.',
      'feature/wt': 'It is checked out in another worktree.',
      'feature/nothing': 'There is no such local branch.',
      'origin/feature/x': 'There is no such local branch.',
    });
    expect(branchNames(root)).toEqual(expect.arrayContaining(['feature/open', 'develop', 'main', 'feature/wt']));
    expect(changed).not.toHaveBeenCalled();
  });

  it('deletes what it may and refuses the rest in the same request, once per name', async () => {
    const { root } = buildRepository();
    const { service } = makeService(root);
    const outcome = result(await del(service, ['feature/merged', 'feature/open', 'feature/merged']));
    expect(outcome.deleted.map((d) => d.name)).toEqual(['feature/merged']);
    expect(outcome.refused.map((r) => r.name)).toEqual(['feature/open']);
  });

  it('leaves it to git to refuse a branch that is merged into main but not into where you are, and never forces', async () => {
    const { root, hash } = buildRepository();
    git(root, ['checkout', '-q', '-b', 'elsewhere', hash.root]);
    const { service, changed } = makeService(root);
    const outcome = result(await del(service, ['feature/merged']));
    expect(outcome.deleted).toEqual([]);
    expect(outcome.refused).toEqual([{ name: 'feature/merged', reason: expect.stringMatching(/not fully merged/) }]);
    expect(branchNames(root)).toContain('feature/merged');
    expect(changed).not.toHaveBeenCalled();
  });

  it('works from the state of the repository now: a branch that got new work after the page was drawn is not deleted', async () => {
    const { root } = buildRepository();
    const { service } = makeService(root);
    git(root, ['checkout', '-q', 'feature/merged']);
    writeFile(root, 'src/more.ts', 'export const more = 1;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(0), message: 'one more thing' });
    git(root, ['checkout', '-q', 'main']);
    const outcome = result(await del(service, ['feature/merged']));
    expect(outcome.deleted).toEqual([]);
    expect(outcome.refused[0].reason).toBe('It is not merged into main.');
    expect(branchNames(root)).toContain('feature/merged');
  });

  it('answers only a POST from this machine', async () => {
    const { root } = buildRepository();
    const { service, changed } = makeService(root);
    const remote = await del(service, ['feature/merged'], false);
    expect(remote?.status).toBe(403);
    const wrongMethod = await service.handle({ method: 'GET', pathname: '/api/git/delete-branches', params: new URLSearchParams(), loopback: true, readBody: async () => '' });
    expect(wrongMethod?.status).toBe(405);
    expect(branchNames(root)).toContain('feature/merged');
    expect(changed).not.toHaveBeenCalled();
  });

  it('refuses a malformed request and names that are not branch names, before anything is run', async () => {
    const { root } = buildRepository();
    const { service, changed } = makeService(root);
    for (const body of ['', 'not json', '{}', '{"branches":[]}', '{"branches":"feature/merged"}', '{"branches":[1]}', '[]', JSON.stringify({ branches: Array.from({ length: 51 }, (_, i) => `b${i}`) })]) {
      expect((await post(service, body))?.status, body.slice(0, 30)).toBe(400);
    }
    const hostile = ['--force', '-D', '--all', '-', '.hidden', '/abs', 'a..b', 'a b', 'a;b', 'a\nb', 'a\0b', '$(touch x)', 'a'.repeat(201), ''];
    for (const name of hostile) {
      const response = await del(service, ['feature/merged', name]);
      expect(response?.status, JSON.stringify(name)).toBe(400);
    }
    expect(branchNames(root)).toContain('feature/merged');
    expect(changed).not.toHaveBeenCalled();
  });

  it('refuses everything in a repository without branches', async () => {
    const empty = makeTempDir('cv-gitools-empty-');
    git(empty, ['init', '-q', '-b', 'main']);
    const { service, changed } = makeService(empty);
    expect(result(await del(service, ['feature/merged']))).toEqual({ deleted: [], refused: [{ name: 'feature/merged', reason: 'There is no such local branch.' }] });
    expect(changed).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasGit || !hasTemplate)('git tools over HTTP (requires dist/report/index.html)', () => {
  let restoreGit: () => void;
  let repository: Repository;
  let server: LiveServer;
  let token: string;
  const call = (route: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => httpRequest(new URL(route, server.url).toString(), { ...init, headers: { 'X-CV-Token': token, ...init.headers } });
  const data = async (): Promise<ReportData> => JSON.parse((await call('/api/data')).text) as ReportData;

  beforeAll(async () => {
    restoreGit = isolateGit();
    repository = buildRepository();
    server = await serve({ root: repository.root, port: 0, includeSource: false, writeHistory: false });
    const page = await httpRequest(server.url);
    token = (JSON.parse(/window\.__CV_LIVE__=(\{[^<]*?\});/.exec(page.text)![1]) as { token: string }).token;
  });
  afterAll(async () => {
    await server?.close();
    restoreGit();
  });

  it('wants the token', async () => {
    const bare = (route: string, method = 'GET') => httpRequest(new URL(route, server.url).toString(), { method, body: method === 'POST' ? '{"branches":["feature/merged"]}' : undefined });
    expect((await bare('/api/git/search?q=x')).status).toBe(401);
    expect((await bare('/api/git/commit?hash=abcdef1')).status).toBe(401);
    expect((await bare('/api/git/standup')).status).toBe(401);
    expect((await bare('/api/git/delete-branches', 'POST')).status).toBe(401);
    expect((await bare('/api/refresh', 'POST')).status).toBe(401);
    expect(branchNames(repository.root)).toContain('feature/merged');
  });

  it('searches, describes a commit and 404s on what it does not know', async () => {
    const found = JSON.parse((await call(`/api/git/search?mode=text&q=${encodeURIComponent('MAGIC_TOTAL')}`)).text) as GitSearchResult;
    expect(found.commits.map((c) => c.subject)).toEqual(['fix: drop the magic number', 'feat(cart): add total']);
    const commit = await call(`/api/git/commit?hash=${repository.hash.drop}`);
    expect(commit.status).toBe(200);
    expect((await call('/api/git/nothing')).status).toBe(404);
  });

  it('carries the repository in the analysis, and keeps it current after a deletion and a refresh', async () => {
    const before = await data();
    expect(before.repo?.branches.map((b) => b.name)).toEqual(expect.arrayContaining(['feature/merged', 'feature/open']));
    expect(before.repo?.branches.find((b) => b.name === 'feature/merged')).toMatchObject({ merged: true });

    const deleted = await call('/api/git/delete-branches', { method: 'POST', body: JSON.stringify({ branches: ['feature/merged'] }) });
    expect(deleted.status).toBe(200);
    expect((JSON.parse(deleted.text) as BranchDeleteResult).deleted.map((d) => d.name)).toEqual(['feature/merged']);

    // A branch made in a terminal is invisible to the watchers; the refresh looks again.
    git(repository.root, ['branch', 'made-in-terminal']);
    const refreshed = await call('/api/refresh', { method: 'POST' });
    expect(refreshed.status).toBe(200);
    expect((JSON.parse(refreshed.text) as { version: number }).version).toBeGreaterThan(0);
    const after = (await data()).repo?.branches.map((b) => b.name) ?? [];
    expect(after).toContain('made-in-terminal');
    expect(after).not.toContain('feature/merged');
  });
});
