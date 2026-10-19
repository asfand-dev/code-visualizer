import { describe, expect, it } from 'vitest';
import { commitCommand, formatCommit, lintCommitMessage, scopeOf, setCommitType, standupGroups, standupMarkdown, suggestCommit } from '../src/shared/git-commit.js';
import { contextOf, gitRecipes, recipeText, suggestedRecipes, type GitContext } from '../src/shared/git-recipes.js';
import type { BranchInfo, ChangedFile, ChangedSymbol, ReportData } from '../src/shared/types.js';

const texts = (message: string, conventional = false): string[] => lintCommitMessage(message, { conventional }).map((p) => p.text);

describe('lintCommitMessage', () => {
  it('accepts a good message', () => {
    expect(lintCommitMessage('feat(auth): add password reset\n\nSends a link by e-mail.', { conventional: true })).toEqual([]);
    expect(lintCommitMessage('Add password reset')).toEqual([]);
  });

  it('needs a subject', () => {
    expect(lintCommitMessage('')).toEqual([expect.objectContaining({ level: 'error' })]);
    expect(lintCommitMessage('\n\nbody only')).toEqual([expect.objectContaining({ level: 'error' })]);
  });

  it('warns about a subject that is too long, and mentions one that is long', () => {
    expect(lintCommitMessage(`feat: ${'x'.repeat(70)}`)[0]).toMatchObject({ level: 'warning', text: expect.stringContaining('76 characters') });
    expect(lintCommitMessage(`feat: ${'x'.repeat(50)}`)[0]).toMatchObject({ level: 'info' });
    expect(lintCommitMessage(`feat: ${'x'.repeat(40)}`)).toEqual([]);
  });

  it('asks for a blank line before the body', () => {
    expect(texts('fix: x\nbody right away')).toEqual([expect.stringContaining('blank line')]);
    expect(texts('fix: x\n\nbody')).toEqual([]);
  });

  it('flags a subject that says nothing, with or without the type', () => {
    expect(texts('wip')).toEqual([expect.stringContaining('says nothing')]);
    expect(texts('fixup! add login')).toEqual([expect.stringContaining('says nothing')]);
    expect(texts('fix')).toEqual([expect.stringContaining('says nothing')]);
  });

  it('wants a type only when the project uses them', () => {
    expect(texts('Add login', true)).toEqual([expect.stringContaining('type(scope)')]);
    expect(texts('Add login', false)).toEqual([]);
    expect(texts('feat: add login', true)).toEqual([]);
  });

  it('notes a full stop and a subject that is not a command', () => {
    expect(texts('Add login.')).toEqual([expect.stringContaining('full stop')]);
    expect(texts('Added login')).toEqual([expect.stringContaining('“added”')]);
    expect(texts('fix(api): handling empty bodies')).toEqual([expect.stringContaining('“handling”')]);
    expect(texts('Need more tests')).toEqual([]);
    expect(texts('Add string helper')).toEqual([]);
  });

  it('notes long body lines but not links or code', () => {
    expect(texts(`fix: x\n\n${'w'.repeat(120)}`)).toEqual([expect.stringContaining('1 body line is longer')]);
    expect(texts(`fix: x\n\nsee https://example.com/${'w'.repeat(120)}`)).toEqual([]);
    expect(texts(`fix: x\n\n    ${'w'.repeat(120)}`)).toEqual([]);
  });

  it('handles Windows line endings', () => {
    expect(texts('fix: x\r\n\r\nbody')).toEqual([]);
  });
});

describe('formatCommit', () => {
  it('writes type, scope, breaking mark and body', () => {
    expect(formatCommit({ type: 'feat', scope: 'auth', description: 'add reset' })).toBe('feat(auth): add reset');
    expect(formatCommit({ type: 'fix', description: 'crash', breaking: true })).toBe('fix!: crash');
    expect(formatCommit({ type: 'docs', description: 'x', body: ['- a', '- b'] })).toBe('docs: x\n\n- a\n- b');
  });
});

describe('scopeOf', () => {
  it('names the folder when all files share one', () => {
    expect(scopeOf(['src/auth/login.ts', 'src/auth/session.ts'])).toBe('auth');
    expect(scopeOf(['packages/api/src/x.ts', 'packages/api/test/y.ts'])).toBe('api');
    expect(scopeOf(['lib/util/a.ts'])).toBe('lib');
  });

  it('has no scope for mixed folders or files at the top', () => {
    expect(scopeOf(['src/auth/a.ts', 'src/ui/b.ts'])).toBeUndefined();
    expect(scopeOf(['src/index.ts'])).toBeUndefined();
    expect(scopeOf(['README.md'])).toBeUndefined();
    expect(scopeOf([])).toBeUndefined();
  });
});

describe('suggestCommit', () => {
  const file = (id: string, status: ChangedFile['status'] = 'modified'): Pick<ChangedFile, 'id' | 'status' | 'additions' | 'deletions'> => ({ id, status, additions: 3, deletions: 1 });
  const symbol = (name: string, exported = true, usedBy = 1): Pick<ChangedSymbol, 'name' | 'exported' | 'usedBy' | 'file'> => ({ name, exported, usedBy, file: 'src/a.ts' });

  it('has nothing to suggest without changes', () => {
    expect(suggestCommit([], [])).toBeUndefined();
  });

  it('calls a new source file a feature and names the changed symbols', () => {
    const s = suggestCommit([file('src/auth/reset.ts', 'added'), file('src/auth/index.ts')], [symbol('resetPassword'), symbol('helper', false)]);
    expect(s).toMatchObject({ type: 'feat', scope: 'auth', description: 'update resetPassword and helper' });
    expect(s?.body).toEqual(['- add src/auth/reset.ts', '- update src/auth/index.ts']);
  });

  it('calls edits to existing code a fix and ranks exported, widely used symbols first', () => {
    const s = suggestCommit([file('src/ui/Button.tsx')], [symbol('a', false, 9), symbol('b', true, 1), symbol('c', true, 5), symbol('d', true, 2)]);
    expect(s).toMatchObject({ type: 'fix', scope: 'ui', description: 'update c, d and 2 more' });
  });

  it('describes a single file by its name when no symbol is known', () => {
    expect(suggestCommit([file('src/ui/Button.tsx')], [])?.description).toBe('update Button');
    expect(suggestCommit([file('src/a.ts'), file('src/b.ts'), file('src/c.ts')], [])?.description).toBe('update 3 files');
  });

  it('recognises changes that only touch tests, docs, CI or build files', () => {
    expect(suggestCommit([file('src/a.test.ts')], [])).toMatchObject({ type: 'test' });
    expect(suggestCommit([file('README.md'), file('docs/guide.md')], [])).toMatchObject({ type: 'docs' });
    expect(suggestCommit([file('.github/workflows/ci.yml')], [])).toMatchObject({ type: 'ci' });
    expect(suggestCommit([file('tsconfig.json')], [])).toMatchObject({ type: 'build' });
    expect(suggestCommit([file('package.json'), file('package-lock.json')], [])).toMatchObject({ type: 'build', scope: 'deps', description: 'update dependencies' });
  });

  it('calls deleting files a refactor', () => {
    expect(suggestCommit([file('src/old.ts', 'deleted')], [])).toMatchObject({ type: 'refactor', description: 'remove old' });
  });

  it('mixes tests with source as a change to the source', () => {
    expect(suggestCommit([file('src/auth/a.ts'), file('src/auth/a.test.ts')], [])).toMatchObject({ type: 'fix', scope: 'auth' });
  });

  it('keeps the body short for large changes', () => {
    const many = Array.from({ length: 12 }, (_, i) => file(`src/m${i}.ts`));
    const body = suggestCommit(many, [])?.body ?? [];
    expect(body).toHaveLength(9);
    expect(body[8]).toBe('- … and 4 more files');
  });
});

describe('standup', () => {
  // Wednesday 2026-10-21 10:00 local time.
  const now = new Date(2026, 9, 21, 10).getTime();
  const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime();
  const c = (date: number, subject: string, author = 'Ada') => ({ hash: subject, date, subject, author });

  it('shows today and the last earlier day with commits, oldest first in the text', () => {
    const groups = standupGroups([c(at(21, 9), 'feat: today'), c(at(19, 15), 'fix: monday'), c(at(17, 12), 'older friday'), c(at(20, 9), 'chore: bob', 'Bob')], { user: 'Ada', now });
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Monday']);
    expect(standupMarkdown(groups)).toBe('**Monday**\n- fix: monday\n\n**Today**\n- feat: today');
  });

  it('calls the day before "Yesterday"', () => {
    expect(standupGroups([c(at(20, 9), 'x')], { user: 'Ada', now }).map((g) => g.label)).toEqual(['Yesterday']);
  });

  it('lists a subject once and in the order it was made', () => {
    const groups = standupGroups([c(at(21, 9), 'b'), c(at(21, 8), 'a'), c(at(21, 7), 'b')], { user: 'Ada', now });
    expect(groups[0].commits.map((x) => x.subject)).toEqual(['b', 'a']);
  });

  it('includes everyone when the user is not known, and skips the future and the distant past', () => {
    const groups = standupGroups([c(at(21, 9), 'a', 'Bob'), c(at(22, 9), 'future'), c(at(1, 9), 'ancient')], { now });
    expect(groups.flatMap((g) => g.commits.map((x) => x.subject))).toEqual(['a']);
  });

  it('has no groups when there are no commits', () => {
    expect(standupGroups([], { user: 'Ada', now })).toEqual([]);
    expect(standupMarkdown([])).toBe('');
  });
});

describe('gitRecipes', () => {
  const ctx = (extra: Partial<GitContext> = {}): GitContext => ({ branch: 'feature/login', base: 'origin/main', upstream: 'origin/feature/login', dirty: 0, hasRemote: true, ...extra });

  it('fills in the branch and the base of the repository', () => {
    const { groups } = gitRecipes(ctx());
    const all = groups.flatMap((g) => g.recipes);
    const wrong = all.find((r) => r.id === 'wrong-branch');
    expect(wrong?.title).toBe('I committed to main by mistake');
    expect(wrong?.commands).toEqual(['git switch -c <new-branch>', 'git branch -f main origin/main']);
    expect(all.find((r) => r.id === 'rebase-base')?.commands).toEqual(['git fetch origin', 'git rebase origin/main']);
    expect(all.find((r) => r.id === 'rename-branch')?.commands[2]).toBe('git push origin --delete feature/login');
  });

  it('falls back to placeholders and main when the state is unknown', () => {
    const all = gitRecipes({ dirty: 0 }).groups.flatMap((g) => g.recipes);
    expect(all.find((r) => r.id === 'push-new')?.commands).toEqual(['git push -u origin <branch>']);
    expect(all.find((r) => r.id === 'diff-base')?.commands).toEqual(['git diff origin/main...HEAD --stat']);
  });

  it('quotes branch names that a shell would split', () => {
    const all = gitRecipes(ctx({ branch: 'my branch' })).groups.flatMap((g) => g.recipes);
    expect(all.find((r) => r.id === 'push-new')?.commands[0]).toBe("git push -u origin 'my branch'");
  });

  it('gives every recipe an id, a title, commands and a risk, with unique ids', () => {
    const all = gitRecipes(ctx()).groups.flatMap((g) => g.recipes);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    for (const r of all) {
      expect(r.title && r.explain && r.commands.length > 0).toBeTruthy();
      expect(['safe', 'rewrites-history', 'discards-work']).toContain(r.risk);
      expect(r.commands.every((line) => line.startsWith('git '))).toBe(true);
    }
  });

  it('marks what can lose work', () => {
    const byId = Object.fromEntries(gitRecipes(ctx()).groups.flatMap((g) => g.recipes).map((r) => [r.id, r]));
    expect(byId['discard-all'].risk).toBe('discards-work');
    expect(byId['force-push'].risk).toBe('rewrites-history');
    expect(byId['unstage'].risk).toBe('safe');
  });

  it('copies all commands as lines', () => {
    expect(recipeText({ commands: ['git a', 'git b'] })).toBe('git a\ngit b');
  });
});

describe('suggestedRecipes', () => {
  const base: GitContext = { branch: 'feature/login', base: 'origin/main', upstream: 'origin/feature/login', dirty: 0, hasRemote: true, ahead: 0, behind: 0, baseAhead: 2, baseBehind: 0 };
  const ids = (extra: Partial<GitContext>): string[] => suggestedRecipes({ ...base, ...extra }).map((r) => r.id);

  it('suggests nothing when everything is in order', () => {
    expect(ids({})).toEqual([]);
  });

  it('suggests a branch for changes made on the base branch', () => {
    expect(ids({ branch: 'main', upstream: 'origin/main', dirty: 3, baseAhead: 0 })).toEqual(['move-changes', 'stash']);
    expect(suggestedRecipes({ ...base, branch: 'main', dirty: 1 })[0].reason).toContain('uncommitted changes on main');
  });

  it('suggests pulling when behind, and updating from the base', () => {
    expect(ids({ behind: 2 })).toEqual(['pull-rebase']);
    expect(suggestedRecipes({ ...base, behind: 1 })[0].reason).toContain('1 new commit ');
    expect(ids({ baseBehind: 4 })).toEqual(['rebase-base']);
    expect(ids({ baseBehind: 4, baseAhead: 0 })).toEqual([]);
  });

  it('suggests pushing a branch that was never pushed, only when there is a remote', () => {
    expect(ids({ upstream: undefined })).toEqual(['push-new']);
    expect(ids({ upstream: undefined, hasRemote: false })).toEqual([]);
    expect(ids({ upstream: undefined, baseAhead: 0 })).toEqual([]);
  });

  it('suggests cleaning up merged branches and stashing a dirty tree', () => {
    expect(ids({ mergedBranches: ['a', 'b'] })).toEqual(['delete-merged']);
    expect(suggestedRecipes({ ...base, mergedBranches: ['a'] })[0].reason).toBe('1 local branch is already merged.');
    expect(ids({ dirty: 2 })).toEqual(['stash']);
  });

  it('puts a detached HEAD first', () => {
    expect(ids({ detached: true, dirty: 1, behind: 1 })[0]).toBe('new-branch');
  });
});

describe('setCommitType', () => {
  it('replaces the type and keeps the scope, the breaking mark and the body', () => {
    expect(setCommitType('fix(auth): reset the token', 'feat')).toBe('feat(auth): reset the token');
    expect(setCommitType('fix!: drop v1\n\nBody text', 'refactor')).toBe('refactor!: drop v1\n\nBody text');
    expect(setCommitType('fix(a)!: x', 'chore')).toBe('chore(a)!: x');
  });

  it('adds a type to a message without one, and does not mistake a plain sentence for a type', () => {
    expect(setCommitType('Add the login page', 'feat')).toBe('feat: Add the login page');
    expect(setCommitType('Update README: fix the link', 'docs')).toBe('docs: Update README: fix the link');
    expect(setCommitType('', 'chore')).toBe('chore: ');
  });
});

describe('commitCommand', () => {
  it('makes a paragraph of the message each a -m option', () => {
    expect(commitCommand('feat: add x\n\nBecause y.\n\nSecond paragraph.')).toBe("git commit -m 'feat: add x' -m 'Because y.' -m 'Second paragraph.'");
  });

  it('leaves a message without spaces unquoted and escapes single quotes', () => {
    expect(commitCommand('wip')).toBe('git commit -m wip');
    expect(commitCommand("fix: don't crash")).toBe("git commit -m 'fix: don'\\''t crash'");
  });

  it('keeps line breaks inside a paragraph, and ignores blank messages and extra blank lines', () => {
    expect(commitCommand('feat: x\n\nline one\nline two\n\n\n\nend')).toBe("git commit -m 'feat: x' -m 'line one\nline two' -m end");
    expect(commitCommand('  \n ')).toBe('git commit');
  });

  it('does not let a message end the quote: $(...) and backticks stay text', () => {
    expect(commitCommand('fix: $(rm -rf x) `id`')).toBe("git commit -m 'fix: $(rm -rf x) `id`'");
  });
});

describe('contextOf', () => {
  const branch = (extra: Partial<BranchInfo> & { name: string }): BranchInfo => ({ remote: false, hash: 'abc1234', date: 0, author: 'Ada', subject: 's', ahead: 0, behind: 0, merged: false, ...extra });
  const repo = (branches: BranchInfo[], stashes = 0): NonNullable<ReportData['repo']> =>
    ({ base: 'origin/main', branches, aheadBehind: true, branchTotals: { local: 0, remote: 0, merged: 0, gone: 0 }, stashes: Array.from({ length: stashes }, (_, i) => ({ ref: `stash@{${i}}`, message: '', date: 0, files: [], fileCount: 0 })), worktrees: [], rescue: [] }) as unknown as NonNullable<ReportData['repo']>;
  const files = (n: number): ChangedFile[] => Array.from({ length: n }, (_, i) => ({ id: `f${i}.ts`, status: 'modified', additions: 1, deletions: 0, lines: [], analyzed: true }));

  it('reads the branch, the distances, the stashes and the merged branches from the analysis', () => {
    const data: Pick<ReportData, 'repo' | 'git' | 'changes'> = {
      repo: repo([branch({ name: 'feature/x', current: true, protected: true, ahead: 2, behind: 3 }), branch({ name: 'old', merged: true }), branch({ name: 'origin/main', remote: true })], 2),
      git: { branch: 'feature/x', upstream: { name: 'origin/feature/x', ahead: 1, behind: 4 } } as ReportData['git'],
      changes: { mode: 'working', files: files(3) } as ReportData['changes'],
    };
    expect(contextOf(data)).toEqual({
      branch: 'feature/x',
      base: 'origin/main',
      upstream: 'origin/feature/x',
      ahead: 1,
      behind: 4,
      baseAhead: 2,
      baseBehind: 3,
      dirty: 3,
      detached: false,
      hasRemote: true,
      stashes: 2,
      mergedBranches: ['old'],
    });
  });

  it('counts only uncommitted work as dirty, and knows a detached HEAD', () => {
    const base = { repo: repo([branch({ name: 'main', current: true })]) };
    expect(contextOf({ ...base, changes: { mode: 'branch', files: files(5) } as ReportData['changes'] })?.dirty).toBe(0);
    expect(contextOf({ ...base, git: { commitsAnalyzed: 1 } as ReportData['git'] })).toMatchObject({ detached: true, hasRemote: false });
    expect(contextOf(base)).toMatchObject({ detached: false, dirty: 0, branch: 'main' });
  });

  it('has nothing to say without repository insights', () => {
    expect(contextOf({})).toBeUndefined();
  });
});
