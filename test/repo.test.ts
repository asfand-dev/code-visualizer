import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { analyzeRepo, type RepoMemo } from '../src/analyzer/repo.js';
import { deletableBranches } from '../src/shared/git-insights.js';
import type { RepoInsights } from '../src/shared/types.js';
import { commitAll, daysAgo, git, hasGit, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const identity = ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false'];
const gitAs = (repo: string, args: string[]): string => git(repo, [...identity, ...args]);
const byName = (repo: RepoInsights, name: string) => repo.branches.find((b) => b.name === name);

/**
 * A repository with every situation the Git view reports: a merged branch, a branch with unpushed work that is
 * checked out in another worktree, a branch whose remote is gone, a stash, a commit only the reflog has, a
 * rewritten commit (which is not lost), tracked secrets and dependencies, and a large file.
 */
function buildRepository(): string {
  const repo = makeTempDir('cv-repo-');
  const remote = makeTempDir('cv-remote-');
  git(repo, ['init', '-q', '-b', 'main']);
  writeFile(repo, 'README.md', '# shop\n');
  writeFile(repo, 'src/index.ts', 'export const a = 1;\n');
  writeFile(repo, '.env', 'API_TOKEN=abc\n');
  writeFile(repo, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
  writeFile(repo, 'node_modules/left-pad/package.json', '{}\n');
  writeFile(repo, 'data/dump.bin', 'a'.repeat(1_200_000));
  commitAll(repo, { author: 'Ada', date: daysAgo(40), message: 'chore: initial commit' });

  git(repo, ['checkout', '-q', '-b', 'feature/done']);
  writeFile(repo, 'src/done.ts', 'export const done = true;\n');
  commitAll(repo, { author: 'Ada', date: daysAgo(30), message: 'feat(cart): add done' });
  git(repo, ['checkout', '-q', 'main']);
  gitAs(repo, ['merge', '--no-ff', '-q', '-m', 'Merge pull request #1 from acme/done', 'feature/done']);

  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);

  // A branch whose remote was deleted after a merge on the server.
  git(repo, ['checkout', '-q', '-b', 'feature/gone']);
  writeFile(repo, 'src/gone.ts', 'export const gone = 1;\n');
  commitAll(repo, { author: 'Ada', date: daysAgo(20), message: 'feat: gone soon' });
  git(repo, ['push', '-q', '-u', 'origin', 'feature/gone']);
  git(remote, ['branch', '-q', '-D', 'feature/gone']);
  git(repo, ['fetch', '-q', '--prune', 'origin']);

  // Work in progress, checked out in a second worktree.
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['checkout', '-q', '-b', 'feature/wip']);
  writeFile(repo, 'src/wip.ts', 'export const wip = 1;\n');
  commitAll(repo, { author: 'Ada', date: daysAgo(2), message: 'wip' });
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['worktree', 'add', '-q', path.join(makeTempDir('cv-worktree-'), 'wip'), 'feature/wip']);

  // A commit that was not pushed, a stash, a dropped experiment and a commit that was only amended.
  writeFile(repo, 'src/local.ts', 'export const local = 1;\n');
  commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'fix: local only' });
  writeFile(repo, 'README.md', '# shop\n\nedited\n');
  gitAs(repo, ['stash', 'push', '-q', '-m', 'login experiment']);
  git(repo, ['checkout', '-q', '-b', 'scratch']);
  writeFile(repo, 'src/lost.ts', 'export const lost = 1;\n');
  commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'experiment that was dropped' });
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['branch', '-q', '-D', 'scratch']);
  writeFile(repo, 'src/tidy.ts', 'export const tidy = 1;\n');
  commitAll(repo, { author: 'Ada', date: daysAgo(1), message: 'chore: tidy' });
  writeFile(repo, 'src/tidy2.ts', 'export const tidy2 = 1;\n');
  git(repo, ['add', '-A']);
  gitAs(repo, ['commit', '-q', '--amend', '--no-edit']);
  return repo;
}

describe.runIf(hasGit)('analyzeRepo on a repository with history', () => {
  let restoreGit: () => void;
  let repo: string;
  let insights: RepoInsights;
  const memo: RepoMemo = {};

  beforeAll(async () => {
    restoreGit = isolateGit();
    repo = buildRepository();
    const result = await analyzeRepo(repo, { memo });
    if (!result) throw new Error('the repository has no insights');
    insights = result;
  });
  afterAll(() => restoreGit());

  it('compares the branches with the remote default branch', () => {
    expect(insights.base).toBe('origin/main');
    expect(insights.aheadBehind).toBe(true);
  });

  it('lists local branches first, then remote ones, without the base', () => {
    const local = insights.branches.filter((b) => !b.remote).map((b) => b.name);
    expect(local.sort()).toEqual(['feature/done', 'feature/gone', 'feature/wip', 'main']);
    expect(insights.branches.map((b) => b.name)).not.toContain('origin/main');
    expect(insights.branchTotals).toMatchObject({ local: 4, gone: 1 });
  });

  it('knows which branch is checked out, and which has unpushed commits', () => {
    expect(byName(insights, 'main')).toMatchObject({ current: true, protected: true, ahead: 2, unpushed: 2, upstream: 'origin/main' });
  });

  it('finds the merged branch and offers it for deletion, but not a branch with its own work', () => {
    expect(byName(insights, 'feature/done')).toMatchObject({ merged: true, ahead: 0 });
    expect(byName(insights, 'feature/done')!.behind).toBeGreaterThan(0);
    expect(byName(insights, 'feature/wip')).toMatchObject({ merged: false, ahead: 1 });
    expect(deletableBranches(insights.branches).map((b) => b.name)).toEqual(['feature/done']);
    expect(insights.branchTotals.merged).toBe(1);
  });

  it('notices a branch whose remote is gone, and one checked out in another worktree', () => {
    expect(byName(insights, 'feature/gone')).toMatchObject({ gone: true, upstream: 'origin/feature/gone', merged: false });
    expect(byName(insights, 'feature/wip')!.worktree).toContain('wip');
    expect(byName(insights, 'feature/wip')!.protected).toBe(true);
  });

  it('lists the worktrees, the first being the main one', () => {
    expect(insights.worktrees).toHaveLength(2);
    expect(insights.worktrees[0]).toMatchObject({ main: true, branch: 'main' });
    expect(insights.worktrees[1]).toMatchObject({ branch: 'feature/wip' });
  });

  it('lists the stash with its message and files', () => {
    expect(insights.stashes).toHaveLength(1);
    expect(insights.stashes[0]).toMatchObject({ ref: 'stash@{0}', message: 'login experiment', files: ['README.md'], fileCount: 1 });
  });

  it('finds the commit only the reflog has, not the amended one', () => {
    const subjects = insights.rescue.map((r) => r.subject);
    expect(subjects).toContain('experiment that was dropped');
    expect(subjects).not.toContain('chore: tidy');
  });

  it('summarises how commit messages are written', () => {
    expect(insights.style.analyzed).toBe(5);
    expect(insights.style.merges).toBe(1);
    expect(insights.style.conventional).toBeGreaterThanOrEqual(3);
    expect(insights.style.wip).toBe(0);
  });

  it('finds tracked files that do not belong in git', () => {
    const unwanted = Object.fromEntries(insights.hygiene.unwanted.map((u) => [u.path, u]));
    expect(unwanted['.env']).toMatchObject({ kind: 'secret' });
    expect(unwanted['node_modules/']).toMatchObject({ kind: 'dependency', count: 2 });
    expect(insights.hygiene.large).toEqual([{ path: 'data/dump.bin', size: 1_200_000 }]);
    expect(insights.hygiene.trackedFiles).toBe(10);
    expect(insights.hygiene.gitignore).toBe(false);
    expect(insights.hygiene.objects.loose + insights.hygiene.objects.packs).toBeGreaterThan(0);
  });

  it('checks the git settings without keeping the e-mail address', () => {
    expect(insights.config.find((c) => c.key === 'user.name')).toMatchObject({ status: 'missing', essential: true });
    expect(JSON.stringify(insights)).not.toContain('ada@example.com');
  });

  it('keeps what only a commit changes, until there is one', async () => {
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    expect(memo.head).toBe(head);
    const again = await analyzeRepo(repo, { memo });
    expect(again?.style).toBe(memo.style);
    expect(again?.hygiene.unwanted).toBe(memo.tree!.unwanted);

    writeFile(repo, 'src/next.ts', 'export const next = 1;\n');
    commitAll(repo, { author: 'Ada', date: daysAgo(0), message: 'wip' });
    const after = await analyzeRepo(repo, { memo });
    expect(memo.head).not.toBe(head);
    expect(after!.style.analyzed).toBe(insights.style.analyzed + 1);
    expect(after!.style.wip).toBe(1);
    git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
  });

  it('still tells merged from unmerged without ahead / behind counts (git before 2.41)', async () => {
    const old = await analyzeRepo(repo, { aheadBehind: false });
    expect(old?.aheadBehind).toBe(false);
    expect(byName(old!, 'feature/done')).toMatchObject({ merged: true, ahead: 0, behind: 0 });
    expect(byName(old!, 'feature/wip')).toMatchObject({ merged: false, ahead: 0, behind: 0 });
    expect(deletableBranches(old!.branches).map((b) => b.name)).toEqual(['feature/done']);
  });

  it('is part of the analysis only when asked for', async () => {
    writeFile(repo, 'package.json', '{"name":"shop"}\n');
    expect((await analyze({ root: repo, persist: false, history: false })).repo).toBeUndefined();
    const report = await analyze({ root: repo, persist: false, history: false, repo: true });
    expect(report.repo?.base).toBe('origin/main');
    fs.rmSync(path.join(repo, 'package.json'));
  });
});

describe.runIf(hasGit)('analyzeRepo in odd places', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  it('has nothing for a folder that is not a repository', async () => {
    expect(await analyzeRepo(makeTempDir('cv-plain-'))).toBeUndefined();
  });

  it('has nothing for a repository without commits', async () => {
    const repo = makeTempDir('cv-empty-');
    git(repo, ['init', '-q', '-b', 'main']);
    expect(await analyzeRepo(repo)).toBeUndefined();
  });

  it('compares with the current branch when the repository has no main branch', async () => {
    const repo = makeTempDir('cv-trunkless-');
    git(repo, ['init', '-q', '-b', 'work']);
    writeFile(repo, 'a.txt', 'a\n');
    commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'first' });
    git(repo, ['branch', 'other']);
    const insights = await analyzeRepo(repo, { branch: 'work' });
    expect(insights?.base).toBe('work');
    expect(byName(insights!, 'other')).toMatchObject({ merged: true });
    expect(byName(insights!, 'work')).toMatchObject({ current: true, protected: true });
  });

  it('works in a folder inside the repository, and with a detached HEAD', async () => {
    const repo = makeTempDir('cv-nested-');
    git(repo, ['init', '-q', '-b', 'main']);
    writeFile(repo, 'packages/app/index.ts', 'export {};\n');
    const first = commitAll(repo, { author: 'Ada', date: daysAgo(3), message: 'feat: app' });
    writeFile(repo, 'packages/app/two.ts', 'export {};\n');
    commitAll(repo, { author: 'Ada', date: daysAgo(2), message: 'feat: two' });
    git(repo, ['checkout', '-q', '--detach', first]);
    const insights = await analyzeRepo(path.join(repo, 'packages', 'app'));
    expect(insights?.hygiene.trackedFiles).toBe(1);
    expect(insights?.branches.find((b) => b.current)).toBeUndefined();
    expect(insights?.worktrees[0]).toMatchObject({ detached: true });
    // The commit HEAD was on before the checkout is still reachable from main: nothing is lost.
    expect(insights?.rescue).toEqual([]);
  });
});
