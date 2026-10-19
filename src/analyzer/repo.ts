/**
 * The facts behind the Git view: branches (merged, stale, gone, unpushed), stashes, worktrees, commits only the
 * reflog still has, the style of recent commit messages, tracked files that do not belong in git, and git settings.
 * Everything is read with git's own formats (parsed in src/shared/git-insights.ts), a handful of processes in
 * parallel. What only a new commit changes (the tree and the commit style) is kept between analyses.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeTree,
  branchFormat,
  configAdvice,
  FIELD_SEPARATOR,
  LOG_FORMAT,
  commitStyle,
  parseBranches,
  parseCountObjects,
  parseLog,
  parseRescue,
  parseStashes,
  parseWorktrees,
  pickConfig,
  REFLOG_FORMAT,
  STASH_FORMAT,
} from '../shared/git-insights.js';
import type { RepoInsights, RescueCommit } from '../shared/types.js';
import { detectBaseBranch, git } from './git.js';
import { findRepo, readHead } from './repo-state.js';

/** Commit messages the style summary looks at. */
const STYLE_COMMITS = 300;
/** Reflog entries searched for lost commits. */
const REFLOG_ENTRIES = 300;
/** Subjects of the history that tell a rewritten commit from a lost one. */
const KNOWN_SUBJECTS = 3000;
const MAX_STASHES = 30;
const FULL_HASH = /^[0-9a-f]{40,64}$/;

/** What only a new commit changes; the analysis cache keeps it (`AnalyzeCache.repo`). */
export interface RepoMemo {
  head?: string;
  tree?: Pick<RepoInsights['hygiene'], 'trackedFiles' | 'unwanted' | 'large'>;
  style?: RepoInsights['style'];
}

export interface RepoOptions {
  /** The checked-out branch, for repositories without a main branch to compare with. */
  branch?: string;
  memo?: RepoMemo;
  /** `false` reads the branches without ahead / behind counts, as for git older than 2.41 (default: try). */
  aheadBehind?: boolean;
}

async function readBranches(root: string, base: string, tryAheadBehind: boolean): Promise<Pick<RepoInsights, 'branches' | 'branchTotals' | 'aheadBehind'> | undefined> {
  const refs = ['refs/heads', 'refs/remotes'];
  const format = branchFormat(base, tryAheadBehind);
  if (format.includes('ahead-behind')) {
    const withCounts = await git(root, ['for-each-ref', `--format=${format}`, ...refs]);
    if (withCounts !== undefined) {
      const { branches, totals } = parseBranches(withCounts, { base, aheadBehind: true });
      return { branches, branchTotals: totals, aheadBehind: true };
    }
  }
  // Git older than 2.41 has no ahead-behind: merged or not is still known, the counts are not.
  const [plain, merged] = await Promise.all([git(root, ['for-each-ref', `--format=${branchFormat(base, false)}`, ...refs]), git(root, ['for-each-ref', `--merged=${base}`, '--format=%(refname)', ...refs])]);
  if (plain === undefined) return undefined;
  const mergedNames = new Set((merged ?? '').split('\n').map((ref) => ref.replace(/^refs\/(?:heads|remotes)\//, '')));
  const { branches, totals } = parseBranches(plain, { base, aheadBehind: false, mergedNames });
  return { branches, branchTotals: totals, aheadBehind: false };
}

/**
 * The branches as the Git view shows them, read from git now (never from the memo): the view is built from this,
 * and so is the check a branch deletion must pass.
 */
export async function listBranches(root: string, options: Pick<RepoOptions, 'branch' | 'aheadBehind'> = {}): Promise<Pick<RepoInsights, 'base' | 'branches' | 'branchTotals' | 'aheadBehind'> | undefined> {
  const base = (await detectBaseBranch(root)) ?? options.branch ?? 'HEAD';
  const read = await readBranches(root, base, options.aheadBehind !== false);
  return read && { base, ...read };
}

/** Commits the HEAD reflog remembers that no branch, tag or remote reaches, unless only their wording survives in the history. */
async function readRescue(root: string): Promise<RescueCommit[]> {
  const reflog = await git(root, ['reflog', `--max-count=${REFLOG_ENTRIES}`, `--format=${REFLOG_FORMAT}`]);
  const candidates = [...new Set((reflog ?? '').split('\n').map((line) => line.split(FIELD_SEPARATOR)[0]).filter((hash) => FULL_HASH.test(hash)))];
  if (!candidates.length) return [];
  const unreachable = await git(root, ['rev-list', '--ignore-missing', ...candidates, '--not', '--branches', '--remotes', '--tags', '--']);
  const orphaned = new Set((unreachable ?? '').split('\n').filter(Boolean));
  if (!orphaned.size) return [];
  const subjects = await git(root, ['log', `--max-count=${KNOWN_SUBJECTS}`, '--format=%s', '--branches', '--remotes', '--tags']);
  return parseRescue(reflog ?? '', orphaned, new Set((subjects ?? '').split('\n')));
}

async function readTree(root: string, memo: RepoMemo | undefined, head: string): Promise<{ tree: NonNullable<RepoMemo['tree']>; style: NonNullable<RepoMemo['style']> }> {
  if (memo?.head === head && memo.tree && memo.style) return { tree: memo.tree, style: memo.style };
  const [lsTree, log] = await Promise.all([
    git(root, ['ls-tree', '-r', '-l', '-z', '--full-tree', 'HEAD']),
    git(root, ['log', `--max-count=${STYLE_COMMITS}`, `--format=${LOG_FORMAT}`, 'HEAD']),
  ]);
  const tree = analyzeTree(lsTree ?? '');
  const style = commitStyle(parseLog(log ?? ''));
  if (memo) Object.assign(memo, { head, tree, style });
  return { tree, style };
}

/** Undefined outside a repository and in one without commits. */
export async function analyzeRepo(root: string, options: RepoOptions = {}): Promise<RepoInsights | undefined> {
  const repo = findRepo(root);
  const head = repo && readHead(repo);
  if (!repo || !head || head.startsWith('ref:')) return undefined;

  const [branches, stashes, worktrees, rescue, objects, config, { tree, style }] = await Promise.all([
    listBranches(root, options),
    git(root, ['stash', 'list', `--max-count=${MAX_STASHES}`, '--name-only', `--format=${STASH_FORMAT}`]),
    git(root, ['worktree', 'list', '--porcelain']),
    readRescue(root),
    git(root, ['count-objects', '-v']),
    git(root, ['config', '--list']),
    readTree(root, options.memo, head),
  ]);
  if (!branches) return undefined;

  return {
    ...branches,
    stashes: parseStashes(stashes ?? ''),
    worktrees: parseWorktrees(worktrees ?? ''),
    rescue,
    style,
    hygiene: { ...tree, objects: parseCountObjects(objects ?? ''), gitignore: fs.existsSync(path.join(repo.top, '.gitignore')) },
    config: configAdvice(pickConfig(config ?? '')),
  };
}
