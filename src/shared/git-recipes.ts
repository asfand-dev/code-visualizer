/**
 * Git recipes: the commands for the situations developers keep searching for ("undo my last commit",
 * "I committed to main by mistake", "find the commit that broke it"), filled in with the real branch and base of
 * the repository, and the few that fit what is going on right now. Nothing runs: every recipe is text to copy. Pure.
 */
import { deletableBranches, shellWord } from './git-insights.js';
import type { ReportData } from './types.js';

/** How much a recipe can hurt: nothing, history that was already shared, or work that is not committed. */
export type RecipeRisk = 'safe' | 'rewrites-history' | 'discards-work';

export interface GitRecipe {
  id: string;
  title: string;
  /** What the commands do, in a sentence. */
  explain: string;
  /** One command per line; `<name>` marks what to fill in. */
  commands: string[];
  risk: RecipeRisk;
  /** Why it is suggested right now (only in `suggested`). */
  reason?: string;
}

export interface RecipeGroup {
  id: string;
  title: string;
  recipes: GitRecipe[];
}

/** The state of the repository that recipes are written for. */
export interface GitContext {
  branch?: string;
  /** The comparison branch as a ref: `origin/main`. */
  base?: string;
  upstream?: string;
  /** Commits ahead of / behind the upstream. */
  ahead?: number;
  behind?: number;
  /** Commits ahead of / behind the base. */
  baseAhead?: number;
  baseBehind?: number;
  /** Files with uncommitted changes. */
  dirty: number;
  detached?: boolean;
  hasRemote?: boolean;
  stashes?: number;
  /** Local branches that are merged and safe to delete. */
  mergedBranches?: string[];
}

const recipe = (id: string, title: string, explain: string, commands: string[], risk: RecipeRisk = 'safe'): GitRecipe => ({ id, title, explain, commands, risk });

function groups(ctx: GitContext): RecipeGroup[] {
  const branch = ctx.branch ? shellWord(ctx.branch) : '<branch>';
  const base = ctx.base ? shellWord(ctx.base) : 'origin/main';
  const localBase = shellWord(localNameOf(ctx.base) ?? 'main');
  return [
    {
      id: 'undo',
      title: 'Undo and fix',
      recipes: [
        recipe('undo-commit', 'Undo the last commit, keep the changes', 'Moves the branch back one commit. The changes stay staged, ready to commit again.', ['git reset --soft HEAD~1'], 'rewrites-history'),
        recipe('amend-message', 'Change the last commit message', 'Opens your editor with the last message. Do it before you push, or force-push afterwards.', ['git commit --amend'], 'rewrites-history'),
        recipe('amend-files', 'Add a forgotten file to the last commit', 'Stages the file and folds it into the previous commit without touching its message.', ['git add <file>', 'git commit --amend --no-edit'], 'rewrites-history'),
        recipe('unstage', 'Unstage a file', 'Takes the file out of the next commit; your edits stay in the working tree.', ['git restore --staged <file>']),
        recipe('discard-file', 'Throw away my changes to a file', 'Restores the file to the last commit. The edits are gone for good.', ['git restore <file>'], 'discards-work'),
        recipe('discard-all', 'Throw away all uncommitted changes', 'Resets every tracked file, then removes untracked files. The first `clean` only lists what it would delete.', ['git restore .', 'git clean -fdn', 'git clean -fd'], 'discards-work'),
        recipe('revert', 'Undo a commit that is already pushed', 'Adds a new commit that cancels the old one, so nobody has to rewrite history.', ['git revert <commit>']),
        recipe('file-from-commit', 'Get a file back as it was in another commit', 'Copies the old version of one file into your working tree.', ['git restore --source=<commit> <file>']),
        recipe('recover', 'Recover a deleted branch or a lost commit', 'The reflog lists where HEAD has been for the last weeks. Find the commit and put a branch on it.', ['git reflog', 'git switch -c recovered <hash>']),
      ],
    },
    {
      id: 'branches',
      title: 'Branches',
      recipes: [
        recipe('new-branch', 'Start a branch from where I am', 'Creates the branch and switches to it. Uncommitted changes come along.', ['git switch -c <new-branch>']),
        recipe('wrong-branch', `I committed to ${localBase} by mistake`, `Keeps the commits on a new branch, then puts ${localBase} back where the remote has it.`, ['git switch -c <new-branch>', `git branch -f ${localBase} ${base}`], 'rewrites-history'),
        recipe('move-changes', 'Move my uncommitted changes to a new branch', 'Nothing is committed yet: just switch, the changes travel with you.', ['git switch -c <new-branch>', 'git add -A', 'git commit']),
        recipe('previous-branch', 'Go back to the previous branch', 'Like `cd -` for branches.', ['git switch -']),
        recipe('rename-branch', 'Rename the current branch', 'Renames locally; the second and third line move the name on the remote too.', ['git branch -m <new-name>', 'git push origin -u <new-name>', `git push origin --delete ${branch}`]),
        recipe('delete-remote', 'Delete a branch on the remote', 'Removes it from the server only. Everyone else can drop their copy with `git fetch --prune`.', ['git push origin --delete <branch>']),
        recipe('prune', 'Forget remote branches that were deleted', 'Cleans the list of remote-tracking branches.', ['git fetch --prune']),
        recipe('delete-merged', 'Delete branches that are merged', 'Lists the branches merged into the base, then deletes them (git refuses to delete unmerged ones).', [`git branch --merged ${base}`, 'git branch -d <branch>']),
      ],
    },
    {
      id: 'sync',
      title: 'Sync and share',
      recipes: [
        recipe('peek', `See what ${localBase} has that I do not`, 'Downloads new commits without changing your files, then lists what you are missing.', ['git fetch', `git log HEAD..${base} --oneline`]),
        recipe('rebase-base', `Update my branch with ${localBase} (rebase)`, 'Replays your commits on top of the latest base: a straight history. Resolve conflicts, then `git rebase --continue`.', ['git fetch origin', `git rebase ${base}`], 'rewrites-history'),
        recipe('merge-base', `Update my branch with ${localBase} (merge)`, 'Adds a merge commit. Nothing is rewritten, so it is safe on a shared branch.', ['git fetch origin', `git merge ${base}`]),
        recipe('force-push', 'Push after a rebase or an amend', '`--force-with-lease` refuses to overwrite commits you have not seen, unlike `--force`.', ['git push --force-with-lease'], 'rewrites-history'),
        recipe('pull-rebase', 'Pull without a merge commit', 'Replays your local commits on top of what is on the remote.', ['git pull --rebase']),
        recipe('push-new', 'Push a new branch', 'Pushes and remembers the remote branch, so later `git push` and `git pull` need no arguments.', [`git push -u origin ${branch}`]),
        recipe('fork', 'Keep a fork up to date', 'Adds the original repository as `upstream` once, then brings its changes into your branch.', ['git remote add upstream <url>', 'git fetch upstream', `git rebase upstream/${localBase}`], 'rewrites-history'),
      ],
    },
    {
      id: 'history',
      title: 'Tidy the history',
      recipes: [
        recipe('squash', 'Squash the last commits into one', 'Replace `3` with how many. Everything is staged afterwards; write the new message.', ['git reset --soft HEAD~3', 'git commit'], 'rewrites-history'),
        recipe('fixup', 'Fix up an older commit', 'Marks the new commit as a fix for the old one; `--autosquash` folds it in during the rebase.', ['git add <file>', 'git commit --fixup <commit>', 'git rebase -i --autosquash <commit>~1'], 'rewrites-history'),
        recipe('reword', 'Reword or reorder older commits', 'Opens the last commits in your editor: change `pick` to `reword`, `squash` or `drop`.', ['git rebase -i HEAD~5'], 'rewrites-history'),
        recipe('stash', 'Put work aside and come back to it', 'Stashes tracked and untracked files with a name; `pop` brings them back.', ['git stash push -u -m "<what it is>"', 'git stash list', 'git stash pop']),
        recipe('stash-branch', 'Turn a stash into a branch', 'Creates a branch from the commit the stash was made on and applies it there.', ['git stash branch <new-branch> stash@{0}']),
      ],
    },
    {
      id: 'find',
      title: 'Find things',
      recipes: [
        recipe('blame', 'Who changed these lines, and why', 'Shows the commit behind every line in the range.', ['git blame -L 10,30 <file>']),
        recipe('pickaxe', 'When was this text added or removed', 'Lists the commits that changed how often the text appears.', ['git log -S"<text>" --oneline']),
        recipe('file-history', 'The history of one file, through renames', 'Every commit that touched the file, with its changes.', ['git log --follow -p -- <file>']),
        recipe('bisect', 'Find the commit that broke it', 'Git halves the history until it finds the first bad commit. With a test command it does it by itself.', ['git bisect start', 'git bisect bad', 'git bisect good <commit>', 'git bisect run <test command>', 'git bisect reset']),
        recipe('contains', 'Which branches and release contain a commit', 'The first lists branches; the second the first tag that includes it.', ['git branch -a --contains <commit>', 'git describe --contains <commit>']),
        recipe('diff-base', `What my branch changes compared with ${localBase}`, 'Three dots compare with the point where your branch started, so changes made on the base meanwhile do not show.', [`git diff ${base}...HEAD --stat`]),
        recipe('my-commits', 'What I committed today', 'For a standup: your commits since midnight.', ['git log --author="$(git config user.name)" --since=midnight --oneline']),
      ],
    },
    {
      id: 'housekeeping',
      title: 'Housekeeping',
      recipes: [
        recipe('worktree', 'Work on two branches at the same time', 'Checks the branch out in a second folder, with no stashing or switching.', ['git worktree add ../<folder> <branch>', 'git worktree list']),
        recipe('untrack', 'Stop tracking a file that is in .gitignore', 'Removes it from git but keeps it on your disk.', ['git rm --cached <file>', 'git commit -m "chore: stop tracking <file>"']),
        recipe('tidy', 'Tidy up the repository', 'Packs loose objects and drops records of deleted worktrees and remote branches.', ['git gc', 'git worktree prune', 'git remote prune origin']),
        recipe('secret', 'I committed a secret', 'Rotate the secret first: it is already in the history. Then remove the file from every commit (needs git-filter-repo) and force-push.', ['git filter-repo --invert-paths --path <file>', 'git push --force-with-lease --all'], 'rewrites-history'),
      ],
    },
  ];
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** `origin/main` → `main`: the branch the base is as a local branch. */
const localNameOf = (ref: string | undefined): string | undefined => ref?.replace(/^origin\//, '');

/** The recipes that fit what is going on right now, most urgent first. */
export function suggestedRecipes(ctx: GitContext): GitRecipe[] {
  const byId = new Map(groups(ctx).flatMap((g) => g.recipes).map((r) => [r.id, r]));
  const picks: { id: string; reason: string }[] = [];
  const baseName = localNameOf(ctx.base);
  const behind = ctx.behind ?? 0;
  const baseBehind = ctx.baseBehind ?? 0;
  const merged = ctx.mergedBranches?.length ?? 0;
  const onBase = !!ctx.branch && ctx.branch === baseName;
  if (ctx.detached) picks.push({ id: 'new-branch', reason: 'You are on a detached HEAD: put a branch on your commits before you switch away.' });
  if (onBase && ctx.dirty > 0) picks.push({ id: 'move-changes', reason: `You have uncommitted changes on ${baseName}: move them to a branch of their own.` });
  if (behind > 0) picks.push({ id: 'pull-rebase', reason: `${ctx.upstream ?? 'The upstream'} has ${behind} new ${plural(behind, 'commit', 'commits')} you do not have.` });
  if (ctx.hasRemote && !ctx.upstream && ctx.branch && !ctx.detached && !onBase && (ctx.baseAhead ?? 0) > 0) picks.push({ id: 'push-new', reason: 'This branch has never been pushed.' });
  if (baseBehind > 0 && (ctx.baseAhead ?? 0) > 0) picks.push({ id: 'rebase-base', reason: `${ctx.base} has ${baseBehind} new ${plural(baseBehind, 'commit', 'commits')} this branch is missing.` });
  if (merged > 0) picks.push({ id: 'delete-merged', reason: `${merged} local ${plural(merged, 'branch is', 'branches are')} already merged.` });
  if (ctx.dirty > 0) picks.push({ id: 'stash', reason: `You have ${ctx.dirty} uncommitted ${plural(ctx.dirty, 'file', 'files')}: stash them to switch branches cleanly.` });
  return picks.flatMap(({ id, reason }) => {
    const found = byId.get(id);
    return found ? [{ ...found, reason }] : [];
  });
}

export function gitRecipes(ctx: GitContext): { suggested: GitRecipe[]; groups: RecipeGroup[] } {
  return { suggested: suggestedRecipes(ctx), groups: groups(ctx) };
}

/** What the recipes need to know about the repository right now, from an analysis (undefined without `repo` insights). */
export function contextOf(data: Pick<ReportData, 'repo' | 'git' | 'changes'>): GitContext | undefined {
  const { repo, git, changes } = data;
  if (!repo) return undefined;
  const current = repo.branches.find((b) => b.current && !b.remote);
  return {
    branch: git?.branch ?? current?.name,
    base: repo.base,
    upstream: git?.upstream?.name,
    ahead: git?.upstream?.ahead,
    behind: git?.upstream?.behind,
    baseAhead: current?.ahead,
    baseBehind: current?.behind,
    // Only uncommitted work counts: in `branch` mode the files are already committed.
    dirty: changes?.mode === 'working' ? changes.files.length : 0,
    detached: !!git && !git.branch,
    hasRemote: repo.branches.some((b) => b.remote),
    stashes: repo.stashes.length,
    mergedBranches: deletableBranches(repo.branches).map((b) => b.name),
  };
}

/** A recipe's commands as one text to copy. */
export function recipeText(item: Pick<GitRecipe, 'commands'>): string {
  return item.commands.join('\n');
}
