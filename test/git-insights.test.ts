import { describe, expect, it } from 'vitest';
import {
  analyzeTree,
  branchFormat,
  commitStyle,
  configAdvice,
  deletableBranches,
  FIELD_SEPARATOR as F,
  isPlaceholderSubject,
  parseBranches,
  parseCountObjects,
  parseLog,
  parseRescue,
  parseStashes,
  parseWorktrees,
  pickConfig,
  RECORD_SEPARATOR as R,
  repoAttention,
  shellWord,
  usesConventionalCommits,
} from '../src/shared/git-insights.js';
import type { BranchInfo, RepoInsights } from '../src/shared/types.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DAY = 86_400_000;
const seconds = (daysAgo: number): number => Math.round((NOW - daysAgo * DAY) / 1000);

/** One `git for-each-ref` line in the format of `branchFormat`. */
const row = (ref: string, o: { days?: number; upstream?: string; track?: string; head?: boolean; worktree?: string; counts?: string; author?: string; subject?: string } = {}): string =>
  [ref, 'abc1234', seconds(o.days ?? 1), o.author ?? 'Ada', o.upstream ?? '', o.track ?? '', o.head ? '*' : ' ', o.worktree ?? '', o.subject ?? `work on ${ref}`, o.counts ?? '0 0'].join(F);

const branchesOf = (lines: string[], base = 'origin/main'): ReturnType<typeof parseBranches> => parseBranches(lines.join('\n'), { base, aheadBehind: true });
const find = (branches: BranchInfo[], name: string): BranchInfo => branches.find((b) => b.name === name) as BranchInfo;

describe('branchFormat', () => {
  it('asks for ahead-behind against a plain base ref, and omits it otherwise', () => {
    expect(branchFormat('origin/main')).toContain('%(ahead-behind:origin/main)');
    expect(branchFormat('origin/main', false)).not.toContain('ahead-behind');
    expect(branchFormat('weird%name')).not.toContain('ahead-behind');
    expect(branchFormat(undefined)).not.toContain('ahead-behind');
  });
});

describe('parseBranches', () => {
  const output = [
    row('refs/heads/main', { days: 1, upstream: 'origin/main', head: false, counts: '0 0' }),
    row('refs/heads/feature/done', { days: 10, counts: '0 4' }),
    row('refs/heads/feature/wip', { days: 2, head: true, counts: '3 1', upstream: 'origin/feature/wip', track: '[ahead 2]' }),
    row('refs/heads/old-idea', { days: 200, counts: '5 90' }),
    row('refs/heads/pr-merged', { days: 5, upstream: 'origin/pr-merged', track: '[gone]', counts: '2 0' }),
    row('refs/heads/elsewhere', { days: 3, worktree: '/work/elsewhere', counts: '0 0' }),
    row('refs/remotes/origin/HEAD', { days: 1 }),
    row('refs/remotes/origin/main', { days: 1 }),
    row('refs/remotes/origin/hotfix', { days: 4, counts: '1 0' }),
    row('refs/tags/v1', { days: 1 }),
    '',
  ];
  const { branches, totals } = branchesOf(output);

  it('lists local branches first, most recent first, and remote ones after', () => {
    expect(branches.map((b) => b.name)).toEqual(['main', 'feature/wip', 'elsewhere', 'pr-merged', 'feature/done', 'old-idea', 'origin/hotfix']);
  });

  it('leaves out the remote HEAD, the base itself on the remote, and tags', () => {
    const names = branches.map((b) => b.name);
    expect(names).not.toContain('origin/HEAD');
    expect(names).not.toContain('origin/main');
    expect(names.some((n) => n.includes('v1'))).toBe(false);
  });

  it('reads how far a branch is from the base', () => {
    expect(find(branches, 'feature/wip')).toMatchObject({ ahead: 3, behind: 1, merged: false, current: true, upstream: 'origin/feature/wip', unpushed: 2 });
    expect(find(branches, 'feature/done')).toMatchObject({ ahead: 0, behind: 4, merged: true });
  });

  it('marks branches that must not be deleted', () => {
    expect(find(branches, 'main').protected).toBe(true);
    expect(find(branches, 'feature/wip').protected).toBe(true); // checked out
    expect(find(branches, 'elsewhere')).toMatchObject({ protected: true, worktree: '/work/elsewhere' });
    expect(find(branches, 'feature/done').protected).toBeUndefined();
    expect(find(branches, 'origin/hotfix').protected).toBeUndefined();
  });

  it('reads a deleted upstream and the commits not pushed yet', () => {
    expect(find(branches, 'pr-merged')).toMatchObject({ gone: true });
    expect(find(branches, 'feature/wip').gone).toBeUndefined();
    expect(find(branches, 'main').unpushed).toBeUndefined();
  });

  it('counts the branches', () => {
    expect(totals).toEqual({ local: 6, remote: 1, merged: 1, gone: 1 });
  });

  it('only offers local, merged, unprotected branches for deletion', () => {
    expect(deletableBranches(branches).map((b) => b.name)).toEqual(['feature/done']);
  });

  it('treats common integration branch names as protected', () => {
    const { branches: found } = branchesOf([row('refs/heads/develop', { counts: '0 0' }), row('refs/heads/release/1.2', { counts: '0 0' }), row('refs/heads/releases', { counts: '0 0' })]);
    expect(found.filter((b) => b.protected).map((b) => b.name).sort()).toEqual(['develop', 'release/1.2']);
  });

  it('does not call a branch merged when git gave no counts', () => {
    const { branches: found } = branchesOf([row('refs/heads/odd', { counts: '' })]);
    expect(found[0]).toMatchObject({ merged: false, ahead: 0, behind: 0 });
  });

  it('falls back to the merged list when ahead-behind is not available', () => {
    const line = row('refs/heads/a').split(F).slice(0, 9).join(F);
    const { branches: found } = parseBranches(`${line}\n${row('refs/heads/b').split(F).slice(0, 9).join(F)}`, { base: 'main', aheadBehind: false, mergedNames: new Set(['a']) });
    expect(found.map((b) => [b.name, b.merged])).toEqual([['a', true], ['b', false]]);
  });

  it('caps the lists but reports the real totals', () => {
    const many = Array.from({ length: 250 }, (_, i) => row(`refs/heads/b${i}`, { days: i }));
    const result = branchesOf(many);
    expect(result.branches).toHaveLength(200);
    expect(result.totals.local).toBe(250);
  });
});

describe('parseStashes', () => {
  it('reads the stash records, the files that follow and the message', () => {
    const output = `${R}stash@{0}${F}${seconds(2)}${F}On main: my stash\n\na.txt\nnew.txt\n${R}stash@{1}${F}${seconds(40)}${F}WIP on feature: 1a2b3c4 add login\n\nsrc/login.ts\n`;
    expect(parseStashes(output)).toEqual([
      { ref: 'stash@{0}', message: 'my stash', date: seconds(2) * 1000, files: ['a.txt', 'new.txt'], fileCount: 2 },
      { ref: 'stash@{1}', message: '1a2b3c4 add login', date: seconds(40) * 1000, files: ['src/login.ts'], fileCount: 1 },
    ]);
  });

  it('caps the files of a big stash but keeps their number', () => {
    const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`).join('\n');
    const [stash] = parseStashes(`${R}stash@{0}${F}${seconds(1)}${F}On main: big\n\n${files}\n`);
    expect(stash.files).toHaveLength(20);
    expect(stash.fileCount).toBe(50);
  });

  it('returns nothing for no stashes', () => {
    expect(parseStashes('')).toEqual([]);
  });
});

describe('parseWorktrees', () => {
  it('reads the main working tree and linked ones', () => {
    const output = `worktree /work/app\nHEAD f7547d6637adb38606638176d1a34883ebffe7b1\nbranch refs/heads/main\n\nworktree /work/app-fix\nHEAD 1111111222222233333334444444555555566666\nbranch refs/heads/feature/fix\nlocked reason\n\nworktree /work/old\nHEAD aaaaaaa000000000000000000000000000000000\ndetached\nprunable gitdir file points to non-existent location\n`;
    expect(parseWorktrees(output)).toEqual([
      { path: '/work/app', head: 'f7547d6', branch: 'main', main: true },
      { path: '/work/app-fix', head: '1111111', branch: 'feature/fix', locked: true },
      { path: '/work/old', head: 'aaaaaaa', detached: true, prunable: true },
    ]);
  });

  it('keeps a path with spaces', () => {
    expect(parseWorktrees('worktree /my work/app\nHEAD abcdef0\nbranch refs/heads/main\n')[0].path).toBe('/my work/app');
  });
});

describe('parseRescue', () => {
  const line = (hash: string, days: number, subject: string): string => [hash, seconds(days), 'Ada', subject].join(F);
  const reflog = [line('a'.repeat(40), 1, 'lost work'), line('b'.repeat(40), 3, 'amended commit'), line('a'.repeat(40), 1, 'lost work'), line('c'.repeat(40), 2, 'still on a branch'), line('d'.repeat(40), 5, 'older loss')].join('\n');

  it('lists commits that only the reflog has, newest first, once each', () => {
    const orphaned = new Set(['a'.repeat(40), 'b'.repeat(40), 'd'.repeat(40)]);
    const found = parseRescue(reflog, orphaned, new Set(['amended commit']));
    expect(found.map((c) => c.subject)).toEqual(['lost work', 'older loss']);
    expect(found[0]).toMatchObject({ hash: 'a'.repeat(40), author: 'Ada' });
  });

  it('keeps nothing when every orphan was only rewritten', () => {
    expect(parseRescue(reflog, new Set(['b'.repeat(40)]), new Set(['amended commit']))).toEqual([]);
  });
});

describe('commitStyle', () => {
  const log = (...commits: [string, string?, number?][]): string => commits.map(([subject, body = '', parents = 1]) => `${R}${'p '.repeat(parents).trim()}${F}${subject}${F}${body}`).join('\n');

  it('reads a log into commits with their number of parents', () => {
    expect(parseLog(log(['feat: a', 'Body text'], ['Merge branch x', '', 2], ['root', '', 0]))).toEqual([
      { parents: 1, subject: 'feat: a', body: 'Body text' },
      { parents: 2, subject: 'Merge branch x', body: '' },
      { parents: 0, subject: 'root', body: '' },
    ]);
  });

  it('counts conventional commits, types and habits, leaving merges out', () => {
    const style = commitStyle(
      parseLog(
        log(
          ['feat(ui): add dark mode (#12)', 'Co-authored-by: Bob <b@x.dev>'],
          ['fix: handle empty list'],
          ['Update readme'],
          ['wip'],
          ['fixup! add dark mode'],
          ['Revert "feat: add dark mode"'],
          ['Merge pull request #3 from x/y', '', 2],
          ['x'.repeat(80)],
        ),
      ),
    );
    expect(style).toMatchObject({ analyzed: 8, merges: 1, conventional: 2, types: { feat: 1, fix: 1 }, withBody: 1, longSubjects: 1, wip: 2, reverts: 1, prRefs: 1, coAuthored: 1 });
    expect(style.avgSubject).toBe(Math.round((28 + 21 + 13 + 3 + 20 + 29 + 80) / 7));
  });

  it('handles an empty log', () => {
    expect(commitStyle([])).toMatchObject({ analyzed: 0, conventional: 0, avgSubject: 0 });
  });

  it('decides whether the project uses Conventional Commits', () => {
    const subjects = (...s: string[]) => commitStyle(parseLog(log(...s.map((x): [string] => [x]))));
    expect(usesConventionalCommits(subjects('feat: a', 'fix: b', 'chore: c', 'docs: d', 'Update e'))).toBe(true);
    expect(usesConventionalCommits(subjects('feat: a', 'Update b', 'Update c', 'Update d', 'Update e'))).toBe(false);
    expect(usesConventionalCommits(subjects('feat: a', 'fix: b'))).toBe(false); // too few commits to tell
  });

  it('recognises messages that say nothing', () => {
    expect(['wip', 'WIP: login', 'fixup! x', 'fix', 'update.', '.'].every(isPlaceholderSubject)).toBe(true);
    expect(['fix: login redirect', 'Update docs for the API', 'tmpfile cleanup'].some(isPlaceholderSubject)).toBe(false);
  });
});

describe('analyzeTree', () => {
  const entry = (path: string, size = 100, type = 'blob'): string => `100644 ${type} ${'a'.repeat(40)} ${String(size).padStart(7)}\t${path}\0`;

  it('finds files that should not be tracked and collapses folders', () => {
    const tree = [
      entry('.env'),
      entry('.env.example'),
      entry('config/.env.production'),
      entry('test/fixtures/.env'),
      entry('keys/server.key'),
      entry('certs/ca.pem'),
      entry('certs/private-signing.pem'),
      entry('node_modules/a/index.js'),
      entry('node_modules/a/b.js'),
      entry('web/node_modules/c.js'),
      entry('dist/index.js'),
      entry('src/dist/keep.ts'),
      entry('.DS_Store'),
      entry('src/app.log'),
      entry('src/app.ts'),
    ].join('');
    const { unwanted, trackedFiles } = analyzeTree(tree);
    expect(trackedFiles).toBe(15);
    expect(unwanted).toEqual([
      { path: '.env', kind: 'secret' },
      { path: 'certs/private-signing.pem', kind: 'secret' },
      { path: 'config/.env.production', kind: 'secret' },
      { path: 'keys/server.key', kind: 'secret' },
      { path: 'node_modules/', kind: 'dependency', count: 2 },
      { path: 'web/node_modules/', kind: 'dependency', count: 1 },
      { path: 'dist/', kind: 'build', count: 1 },
      { path: '.DS_Store', kind: 'junk' },
      { path: 'src/app.log', kind: 'junk' },
    ]);
  });

  it('lists the biggest files over 1 MB, ignoring submodules and malformed records', () => {
    const tree = [entry('small.bin', 1000), entry('big.bin', 5 * 1024 * 1024), entry('medium.bin', 2 * 1024 * 1024), `160000 commit ${'b'.repeat(40)}       -\tvendor/sub\0`, 'garbage\0'].join('');
    const { large, trackedFiles } = analyzeTree(tree);
    expect(large).toEqual([{ path: 'big.bin', size: 5 * 1024 * 1024 }, { path: 'medium.bin', size: 2 * 1024 * 1024 }]);
    expect(trackedFiles).toBe(3);
  });

  it('keeps a path with a newline or spaces whole', () => {
    expect(analyzeTree(entry('my dir/a b.log')).unwanted).toEqual([{ path: 'my dir/a b.log', kind: 'junk' }]);
  });

  it('handles an empty repository', () => {
    expect(analyzeTree('')).toEqual({ trackedFiles: 0, unwanted: [], large: [] });
  });
});

describe('parseCountObjects', () => {
  it('reads the sizes and counts', () => {
    expect(parseCountObjects('count: 19\nsize: 76\nin-pack: 1200\npacks: 2\nsize-pack: 5400\nprune-packable: 0\ngarbage: 0\nsize-garbage: 0\n')).toEqual({ packKiB: 5400, looseKiB: 76, loose: 19, packs: 2 });
    expect(parseCountObjects('')).toEqual({ packKiB: 0, looseKiB: 0, loose: 0, packs: 0 });
  });
});

describe('git settings', () => {
  it('keeps only the settings it knows from the whole configuration', () => {
    const listing = 'user.name=Ada Lovelace\nuser.email=ada@example.com\ncredential.helper=osxkeychain\nurl.https://tok:secret@github.com/.insteadof=gh:\npull.rebase=true\nPUSH.autoSetupRemote=true\nalias.st=status\n';
    expect(pickConfig(listing)).toEqual({ 'user.name': 'Ada Lovelace', 'user.email': 'ada@example.com', 'pull.rebase': 'true', 'push.autosetupremote': 'true' });
    expect(JSON.stringify(pickConfig(listing))).not.toContain('secret');
  });

  it('reports what is set, missing or set differently, without keeping the e-mail address', () => {
    const advice = configAdvice({ 'user.name': 'Ada', 'user.email': 'ada@example.com', 'pull.rebase': 'false', 'fetch.prune': 'false', 'merge.conflictstyle': 'diff3' });
    const by = (key: string) => advice.find((a) => a.key === key);
    expect(by('user.name')).toMatchObject({ status: 'ok', value: 'Ada', essential: true });
    expect(by('user.email')).toMatchObject({ status: 'ok', essential: true });
    expect(by('user.email')?.value).toBeUndefined();
    expect(by('pull.rebase')).toMatchObject({ status: 'ok', value: 'false' }); // any explicit choice avoids the divergent-branches error
    expect(by('fetch.prune')).toMatchObject({ status: 'differs', value: 'false', recommended: 'true' });
    expect(by('merge.conflictstyle')?.status).toBe('ok');
    expect(by('rerere.enabled')).toMatchObject({ status: 'missing', command: 'git config --global rerere.enabled true' });
    expect(JSON.stringify(advice)).not.toContain('ada@example.com');
  });

  it('quotes values with spaces in the command', () => {
    const advice = configAdvice({});
    expect(advice.find((a) => a.key === 'user.name')?.command).toBe('git config --global user.name "Your Name"');
    expect(advice.find((a) => a.key === 'user.email')?.command).toBe('git config --global user.email "you@example.com"');
  });
});

describe('shellWord', () => {
  it('quotes only when a shell would need it', () => {
    expect(shellWord('feature/login-2')).toBe('feature/login-2');
    expect(shellWord('my branch')).toBe("'my branch'");
    expect(shellWord("it's;rm -rf")).toBe(`'it'\\''s;rm -rf'`);
  });
});

describe('repoAttention', () => {
  const branch = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo => ({ name, remote: false, hash: 'abc1234', date: NOW - DAY, author: 'Ada', subject: 's', ahead: 1, behind: 0, merged: false, ...extra });
  const repo = (extra: Partial<RepoInsights> = {}): RepoInsights => ({
    base: 'origin/main',
    branches: [],
    aheadBehind: true,
    branchTotals: { local: 0, remote: 0, merged: 0, gone: 0 },
    stashes: [],
    worktrees: [],
    rescue: [],
    style: commitStyle([]),
    hygiene: { trackedFiles: 10, unwanted: [], large: [], objects: { packKiB: 1, looseKiB: 1, loose: 5, packs: 1 }, gitignore: true },
    config: configAdvice({ 'user.name': 'Ada', 'user.email': 'a@b.c', 'pull.rebase': 'true', 'fetch.prune': 'true', 'push.autosetupremote': 'true', 'rerere.enabled': 'true', 'merge.conflictstyle': 'zdiff3', 'diff.algorithm': 'histogram', 'init.defaultbranch': 'main', 'branch.sort': '-committerdate' }),
    ...extra,
  });
  const ids = (r: RepoInsights, hasRemote = true): string[] => repoAttention(r, { now: NOW, hasRemote }).map((a) => a.id);

  it('has nothing to say about a tidy repository', () => {
    expect(repoAttention(repo(), { now: NOW })).toEqual([]);
  });

  it('suggests deleting merged branches with a command for the first ten', () => {
    const merged = Array.from({ length: 12 }, (_, i) => branch(`done-${i}`, { merged: true, ahead: 0 }));
    const [item] = repoAttention(repo({ branches: merged }), { now: NOW });
    expect(item).toMatchObject({ id: 'merged-branches', severity: 'medium' });
    expect(item.command?.split(' ')).toHaveLength(3 + 10);
    expect(item.command).toMatch(/^git branch -d done-0 /);
  });

  it('never suggests deleting protected branches', () => {
    expect(ids(repo({ branches: [branch('main', { merged: true, ahead: 0, protected: true })] }))).not.toContain('merged-branches');
  });

  it('flags commits that exist on this computer only, and branches never pushed', () => {
    const found = repoAttention(repo({ branches: [branch('a', { unpushed: 2, upstream: 'origin/a' }), branch('b')] }), { now: NOW, hasRemote: true });
    expect(found.map((a) => a.id)).toEqual(['unpushed', 'never-pushed']);
    expect(found[0].command).toBe('git push origin a');
    expect(found[1].command).toBe('git push -u origin b');
    expect(ids(repo({ branches: [branch('b')] }), false)).not.toContain('never-pushed');
  });

  it('flags stale and gone branches', () => {
    const found = repo({ branches: [branch('old', { date: NOW - 100 * DAY }), branch('fresh'), branch('pr', { gone: true, upstream: 'origin/pr' })] });
    expect(ids(found)).toEqual(expect.arrayContaining(['stale-branches', 'gone-branches']));
    expect(repoAttention(found, { now: NOW }).find((a) => a.id === 'stale-branches')?.detail).toBe('old');
  });

  it('uses the right verb for one or several gone branches', () => {
    const gone = (name: string) => branch(name, { gone: true, upstream: `origin/${name}` });
    const title = (branches: BranchInfo[]) => repoAttention(repo({ branches }), { now: NOW }).find((a) => a.id === 'gone-branches')?.title;
    expect(title([gone('a')])).toBe('1 branch tracks a remote branch that was deleted');
    expect(title([gone('a'), gone('b')])).toBe('2 branches track a remote branch that was deleted');
  });

  it('puts tracked secrets first and tells to rotate them', () => {
    const risky = repo({ hygiene: { ...repo().hygiene, unwanted: [{ path: '.env', kind: 'secret' }, { path: 'node_modules/', kind: 'dependency', count: 3 }] }, rescue: [{ hash: 'a'.repeat(40), date: NOW, author: 'Ada', subject: 'lost' }] });
    const found = repoAttention(risky, { now: NOW });
    expect(found[0]).toMatchObject({ id: 'tracked-secrets', severity: 'high', command: 'git rm --cached .env' });
    expect(found[0].detail).toContain('Rotate');
    expect(found.map((a) => a.id)).toEqual(expect.arrayContaining(['tracked-dependencies', 'rescue']));
    expect(found.find((a) => a.id === 'rescue')?.command).toBe(`git branch rescue/aaaaaaa aaaaaaa`);
  });

  it('flags old stashes, prunable worktrees, a missing identity and many missing settings', () => {
    const messy = repo({ stashes: [{ ref: 'stash@{0}', message: 'x', date: NOW - 45 * DAY, files: [], fileCount: 0 }], worktrees: [{ path: '/gone', prunable: true }], config: configAdvice({}), hygiene: { ...repo().hygiene, gitignore: false } });
    const found = repoAttention(messy, { now: NOW });
    expect(found.map((a) => a.id)).toEqual(expect.arrayContaining(['old-stashes', 'prunable-worktrees', 'identity', 'config', 'gitignore']));
    expect(found[0].id).toBe('identity');
    expect(found.find((a) => a.id === 'identity')?.command).toContain('user.email');
  });

  it('flags a repository that needs packing', () => {
    expect(ids(repo({ hygiene: { ...repo().hygiene, objects: { packKiB: 1, looseKiB: 1, loose: 7000, packs: 1 } } }))).toContain('gc');
  });

  it('orders by severity', () => {
    const order = { high: 0, medium: 1, low: 2 };
    const found = repoAttention(repo({ config: configAdvice({}), rescue: [{ hash: 'a'.repeat(40), date: NOW, author: 'x', subject: 'y' }], stashes: [{ ref: 's', message: '', date: 0, files: [], fileCount: 0 }] }), { now: NOW });
    expect(found.map((a) => order[a.severity])).toEqual([...found.map((a) => order[a.severity])].sort());
  });
});
