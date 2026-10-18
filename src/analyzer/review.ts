/**
 * Review mode (`code-visualizer review <ref|#123|!45>`): analyze any branch or pull request as it is on
 * that ref — without a checkout and without touching the working tree or HEAD — and plan how to read
 * it (src/shared/review.ts). Also: resolving `#123` / `!45` to already-fetched refs (a fetch only on
 * request), the branches worth reviewing, and which files a reviewer marked as viewed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyViewed, reviewPlan } from '../shared/review.js';
import type { ReviewPlan, ReviewRef, ReviewState } from '../shared/types.js';
import { loadConfig } from './config.js';
import { AnalyzeError } from './errors.js';
import { detectBaseBranch, git, gitRun, resolveCommit } from './git.js';
import { ensureStateDir } from './health.js';
import { analyze, type AnalyzeCache } from './index.js';
import { overlayForRef } from './snapshot.js';
import { stateDir, writeFileAtomic } from './state.js';

export interface ReviewOptions {
  /** Compare with this ref (default: `base` of the configuration, the CI target branch, origin/HEAD, main…). */
  base?: string;
  /** Parse cache shared with other analyses (files equal to the working tree are not parsed again). */
  cache?: AnalyzeCache;
  /** Place each test before the code it covers. */
  testFirst?: boolean;
  exclude?: string[];
  maxFiles?: number;
  toolVersion?: string;
  /** Read and write stored snapshots of the base commit (default: true). */
  persist?: boolean;
  /** Keep the changed files with their diffs on `plan.files` (the live server shows them). */
  files?: boolean;
  /** How the ref is shown (`#123` for refs/pull/123/head); default: the ref. */
  label?: string;
}

/* -------------------------------------------------------------------------- */
/*                         Pull and merge request refs                        */
/* -------------------------------------------------------------------------- */

/** `#123` (GitHub pull request) or `!45` (GitLab merge request). */
export interface PullRequestRef {
  host: 'github' | 'gitlab';
  number: number;
}

export function parsePullRequestRef(input: string): PullRequestRef | undefined {
  const m = /^([#!])(\d{1,9})$/.exec(input.trim());
  return m ? { host: m[1] === '#' ? 'github' : 'gitlab', number: Number(m[2]) } : undefined;
}

/** Local refs that may already hold a pull / merge request, in the order they are tried. */
export function pullRequestCandidates(pr: PullRequestRef): string[] {
  const n = pr.number;
  return pr.host === 'github'
    ? [`refs/pull/${n}/head`, `pr/${n}`, `origin/pr/${n}`, `refs/remotes/origin/pull/${n}/head`]
    : [`refs/merge-requests/${n}/head`, `mr/${n}`, `origin/mr/${n}`, `refs/remotes/origin/merge-requests/${n}/head`];
}

/** A remote name that cannot be mistaken for a git option (`--upload-pack=…`) or a path. */
export function isValidRemoteName(remote: string): boolean {
  return /^[\w.-]+$/.test(remote) && !remote.startsWith('-') && remote.length <= 200;
}

/**
 * The fetch that makes a pull / merge request reviewable: `git fetch origin pull/123/head:pr/123`.
 * Throws an AnalyzeError for a remote name that looks like an option.
 */
export function pullRequestFetch(pr: PullRequestRef, remote = 'origin'): { args: string[]; command: string; local: string } {
  if (!isValidRemoteName(remote)) throw new AnalyzeError(`Invalid remote name "${remote}".`);
  const [source, local] = pr.host === 'github' ? [`pull/${pr.number}/head`, `pr/${pr.number}`] : [`merge-requests/${pr.number}/head`, `mr/${pr.number}`];
  const refspec = `${source}:${local}`;
  // `--` ends the options: the remote and the refspec are never read as one.
  return { args: ['fetch', '--no-tags', '--', remote, refspec], command: `git fetch ${remote} ${refspec}`, local };
}

export type ResolvedReviewRef = { ok: true; ref: string; commit: string; label: string } | { ok: false; reason: 'unknown' | 'not-fetched'; pr?: PullRequestRef };

/**
 * A branch that only exists on a remote (`copilot/fix` → `refs/remotes/origin/copilot/fix`), like `git
 * checkout` guesses it: origin first, otherwise the only remote that has it.
 */
async function remoteBranch(root: string, input: string): Promise<{ ref: string; commit: string } | undefined> {
  if (input.startsWith('refs/') || /^[0-9a-f]{7,64}$/i.test(input)) return undefined;
  const remotes = ((await git(root, ['remote'])) ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const found: { remote: string; ref: string; commit: string }[] = [];
  for (const remote of remotes.sort((a, b) => Number(b === 'origin') - Number(a === 'origin'))) {
    const ref = `refs/remotes/${remote}/${input}`;
    const commit = await resolveCommit(root, ref);
    if (commit) found.push({ remote, ref, commit });
  }
  const match = found.find((f) => f.remote === 'origin') ?? (found.length === 1 ? found[0] : undefined);
  return match && { ref: match.ref, commit: match.commit };
}

/**
 * The commit to review: a ref, a branch that only exists on a remote (`feature` for origin/feature), or
 * `#123` / `!45` when that pull / merge request was already fetched (never fetches by itself). Refs that
 * look like options are rejected.
 */
export async function resolveReviewRef(root: string, input: string): Promise<ResolvedReviewRef> {
  const pr = parsePullRequestRef(input);
  if (pr) {
    const found: { ref: string; commit: string }[] = [];
    for (const candidate of pullRequestCandidates(pr)) {
      const commit = await resolveCommit(root, candidate);
      if (commit) found.push({ ref: candidate, commit });
    }
    if (!found.length) return { ok: false, reason: 'not-fetched', pr };
    // Several local copies (a mirror refspec and `--fetch`): the most recently committed one is the
    // latest version of the pull request (rebases and amends update the committer date too).
    let best = found[0];
    if (new Set(found.map((f) => f.commit)).size > 1) {
      const out = await git(root, ['log', '--no-walk=unsorted', '--format=%H %ct', ...new Set(found.map((f) => f.commit))]);
      const time = new Map((out ?? '').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf(' ')), Number(line.slice(line.indexOf(' ') + 1))]));
      for (const f of found) if ((time.get(f.commit) ?? 0) > (time.get(best.commit) ?? 0)) best = f;
    }
    return { ok: true, ref: best.ref, commit: best.commit, label: input.trim() };
  }
  const commit = await resolveCommit(root, input);
  if (commit) return { ok: true, ref: input, commit, label: input };
  // Someone else's branch in a fresh clone: only origin/<name> exists. The label stays as typed.
  const remote = input.startsWith('-') ? undefined : await remoteBranch(root, input);
  return remote ? { ok: true, ref: remote.ref, commit: remote.commit, label: input } : { ok: false, reason: 'unknown' };
}

/** The most useful line of git's error output: the first `fatal:` / `error:` line, otherwise the last lines. */
function gitError(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => /^(fatal|error):/.test(l));
  return first ? first.replace(/^(fatal|error):\s*/, '') : lines.slice(-2).join(' ') || 'git fetch failed';
}

/**
 * Fetch a pull / merge request into its local ref (opt-in: `review --fetch`), also when it was fetched
 * before: the local ref is force-updated, because pull request heads are rewritten (rebases, force
 * pushes). `before` / `after` are the commits of the local ref.
 */
export async function fetchPullRequest(root: string, pr: PullRequestRef, remote = 'origin'): Promise<{ ok: boolean; ref: string; before?: string; after?: string; error?: string }> {
  const fetch = pullRequestFetch(pr, remote);
  const local = `refs/heads/${fetch.local}`;
  const before = await resolveCommit(root, local);
  const result = await gitRun(root, [...fetch.args.slice(0, -1), `+${fetch.args[fetch.args.length - 1]}`]);
  if (!result.ok) return { ok: false, ref: fetch.local, before, error: gitError(result.stderr) };
  return { ok: true, ref: fetch.local, before, after: await resolveCommit(root, local) };
}

/* -------------------------------------------------------------------------- */
/*                                  The plan                                  */
/* -------------------------------------------------------------------------- */

/**
 * Plan the review of `ref` (a branch, tag, commit, or an already resolved pull request ref) compared to
 * its merge-base with the base branch. The ref is analyzed through an overlay of its files: nothing is
 * checked out and nothing in the working tree changes. Throws an AnalyzeError for unknown refs, when
 * no base branch is found, or when the two have no common history.
 */
export async function buildReviewPlan(root: string, ref: string, options: ReviewOptions = {}): Promise<ReviewPlan> {
  const abs = path.resolve(root);
  const head = await resolveCommit(abs, ref);
  if (!head) throw new AnalyzeError(`Unknown git ref "${ref}".`);
  const label = options.label ?? ref;
  const data = await analyze({
    root: abs,
    overlay: await overlayForRef(abs, head),
    head,
    base: options.base,
    compare: true,
    git: false,
    history: false,
    includeSource: false,
    cache: options.cache,
    exclude: options.exclude,
    maxFiles: options.maxFiles,
    toolVersion: options.toolVersion,
    persist: options.persist !== false,
  });
  const changes = data.changes;
  if (!changes?.base) throw new AnalyzeError('No base branch found to compare with: pass --base <ref> (e.g. --base origin/main).');
  if (!changes.baseCommit) {
    const shallow = (await git(abs, ['rev-parse', '--is-shallow-repository']))?.trim() === 'true';
    throw new AnalyzeError(`No common history between ${changes.base} and ${label}${shallow ? ': this is a shallow clone — fetch more history (git fetch --unshallow)' : ''}.`);
  }
  const mergeBase = (await resolveCommit(abs, changes.baseCommit)) ?? changes.baseCommit;
  if (changes.delta) changes.delta.head = label;
  const plan = reviewPlan(data, changes, changes.delta, { testFirst: options.testFirst, ref: label, base: changes.base, mergeBase, head });
  if (options.files) plan.files = changes.files;
  // clone-radar: copies edited on one side only (also those still matching, which the delta cannot see).
  if (changes.cloneDrift?.length) plan.cloneDrift = changes.cloneDrift;
  const warnings = data.warnings.filter((w) => /^Could not (compare|order)/.test(w));
  const outside = await changedOutsideRoot(abs, mergeBase, head);
  if (outside) warnings.push(outside);
  if (warnings.length) plan.warnings = warnings;
  // Files the reviewer already marked as viewed (for this version of them).
  applyViewed(plan, readReviewState(abs, label).viewed);
  return plan;
}

/**
 * Run from a sub-folder of the repository (a package of a monorepo), only that folder is reviewed: say
 * how many changed files are left out, instead of silently showing part of the pull request.
 */
async function changedOutsideRoot(root: string, mergeBase: string, head: string): Promise<string | undefined> {
  const prefix = (await git(root, ['rev-parse', '--show-prefix']))?.trim();
  if (!prefix) return undefined;
  // Without --relative and a pathspec, git lists the changes of the whole repository (from its top).
  const all = ((await git(root, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head])) ?? '').split('\0').filter(Boolean);
  const outside = all.filter((f) => !f.startsWith(prefix)).length;
  if (!outside) return undefined;
  const top = (await git(root, ['rev-parse', '--show-toplevel']))?.trim();
  return `${outside.toLocaleString('en-US')} changed ${outside === 1 ? 'file' : 'files'} outside ${prefix.replace(/\/$/, '')}/ ${outside === 1 ? 'is' : 'are'} not part of this review: review from the repository root${top ? ` (${top})` : ''} to include ${outside === 1 ? 'it' : 'them'}.`;
}

/* -------------------------------------------------------------------------- */
/*                               Refs to review                               */
/* -------------------------------------------------------------------------- */

/** Branches pushed by coding agents (GitHub Copilot, Codex, Claude, Cursor, Devin, Jules…). */
const AGENT_BRANCH_RE = /(^|\/)(copilot|codex|claude|cursor|devin|jules|sweep|aider|openhands|codegen|agent)[/-]/i;

/**
 * Local and remote branches (and fetched pull / merge requests) updated in the last `days` days, agent
 * branches first, then the most recent. The base branch and remote HEADs are left out.
 */
export async function listReviewRefs(root: string, options: { days?: number; limit?: number; now?: number } = {}): Promise<ReviewRef[]> {
  const abs = path.resolve(root);
  const since = (options.now ?? Date.now()) - (options.days ?? 14) * 24 * 3600 * 1000;
  const [out, current, base] = await Promise.all([
    git(abs, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(authorname)%1f%(subject)', 'refs/heads', 'refs/remotes', 'refs/pull', 'refs/merge-requests']),
    git(abs, ['symbolic-ref', '--quiet', 'HEAD']),
    detectBaseBranch(abs),
  ]);
  const baseNames = new Set(base ? [base, base.replace(/^origin\//, ''), `origin/${base.replace(/^origin\//, '')}`] : []);
  const refs: ReviewRef[] = [];
  const localCommits = new Map<string, string>();
  for (const line of (out ?? '').split('\n')) {
    const [name, short, commit, time, author = '', subject = ''] = line.split('\x1f');
    if (!name || !commit || name.endsWith('/HEAD')) continue;
    const date = Number(time) * 1000;
    if (!(date >= since) || baseNames.has(short)) continue;
    const pull = /^refs\/pull\/(\d+)\/head$/.exec(name) ?? /^refs\/merge-requests\/(\d+)\/head$/.exec(name);
    const ref = pull ? `${name.startsWith('refs/pull/') ? '#' : '!'}${pull[1]}` : short;
    const remote = name.startsWith('refs/remotes/');
    if (name.startsWith('refs/heads/')) localCommits.set(short, commit);
    refs.push({ ref, name, commit, date, author, subject: subject.slice(0, 200), agent: AGENT_BRANCH_RE.test(short), remote, current: name === current?.trim() || undefined });
  }
  // origin/feature at the same commit as your local feature is the same branch.
  const unique = refs.filter((r) => !(r.remote && localCommits.get(r.ref.slice(r.ref.indexOf('/') + 1)) === r.commit));
  return unique.sort((a, b) => Number(b.agent) - Number(a.agent) || b.date - a.date).slice(0, options.limit ?? 50);
}

/* -------------------------------------------------------------------------- */
/*                                Viewed state                                */
/* -------------------------------------------------------------------------- */

/** `.code-visualizer/reviews/<sha1(ref)>.json` */
export function reviewStatePath(root: string, ref: string): string {
  return path.join(stateDir(path.resolve(root)), 'reviews', `${crypto.createHash('sha1').update(ref).digest('hex')}.json`);
}

/** What the reviewer marked as viewed for `ref` (file → blob at the time). */
export function readReviewState(root: string, ref: string): ReviewState {
  try {
    const value = JSON.parse(fs.readFileSync(reviewStatePath(root, ref), 'utf8')) as Partial<ReviewState>;
    const viewed: Record<string, string> = {};
    if (value && typeof value.viewed === 'object' && value.viewed) for (const [file, blob] of Object.entries(value.viewed)) if (typeof blob === 'string') viewed[file] = blob;
    return { ref, viewed, updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined };
  } catch {
    return { ref, viewed: {} };
  }
}

/** A project-relative POSIX path that cannot leave the root (no `..`, no absolute paths, no NUL). */
export function isSafeRelativePath(file: string): boolean {
  if (!file || file.length > 4096 || file.includes('\0') || file.includes('\\') || file.startsWith('/') || /^[A-Za-z]:/.test(file)) return false;
  return file.split('/').every((part) => part && part !== '.' && part !== '..');
}

/** Blob ids of files in `commit` ('' for files that do not exist there). */
export async function blobsAt(root: string, commit: string, files: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>(files.map((f) => [f, '']));
  for (let i = 0; i < files.length; i += 400) {
    const chunk = files.slice(i, i + 400);
    // Paths are relative to the root (git resolves pathspecs against the working directory).
    const out = await git(root, ['ls-tree', '-r', '-z', commit, '--', ...chunk.map((f) => `:(literal)${f}`)]);
    for (const entry of (out ?? '').split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab === -1) continue;
      const [, type, blob] = entry.slice(0, tab).split(' ');
      if (type === 'blob' && result.has(entry.slice(tab + 1))) result.set(entry.slice(tab + 1), blob);
    }
  }
  return result;
}

/** The files of `state` that are still viewed: their blob in `commit` is the one they were viewed at. */
export async function currentlyViewed(root: string, commit: string, state: ReviewState): Promise<string[]> {
  const files = Object.keys(state.viewed);
  if (!files.length) return [];
  const blobs = await blobsAt(path.resolve(root), commit, files);
  return files.filter((f) => blobs.get(f) === state.viewed[f]).sort();
}

/**
 * The merge-base of a reviewed commit with its base branch (`base`, else `base` of the configuration,
 * the CI target branch, origin/HEAD, main…); undefined without one.
 */
export async function reviewMergeBase(root: string, commit: string, base?: string): Promise<string | undefined> {
  const abs = path.resolve(root);
  let requested = base;
  if (!requested) {
    try {
      requested = loadConfig(abs).config.base;
    } catch {
      /* unreadable configuration: detect the base branch */
    }
  }
  requested ??= await detectBaseBranch(abs);
  const baseCommit = requested ? await resolveCommit(abs, requested) : undefined;
  return baseCommit ? (await git(abs, ['merge-base', commit, baseCommit]))?.trim() || undefined : undefined;
}

/** Which of `files` changed between two commits (paths relative to the root). */
async function changedBetween(root: string, from: string, to: string, files: string[]): Promise<Set<string>> {
  const changed = new Set<string>();
  for (let i = 0; i < files.length; i += 400) {
    const chunk = files.slice(i, i + 400);
    const out = await git(root, ['diff', '--name-only', '-z', '--no-renames', '--relative', from, to, '--', ...chunk.map((f) => `:(literal)${f}`)]);
    for (const f of (out ?? '').split('\0')) if (f) changed.add(f);
  }
  return changed;
}

/** Updates of one review state file run one after the other (read, git, write): none is lost. */
const stateLocks = new Map<string, Promise<unknown>>();

function withStateLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const run = (stateLocks.get(file) ?? Promise.resolve()).then(task);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  stateLocks.set(file, settled);
  void settled.then(() => {
    if (stateLocks.get(file) === settled) stateLocks.delete(file);
  });
  return run;
}

export interface ReviewStateUpdate {
  /**
   * The commit the reviewer was shown (the plan's head): files are stored with their blob there, so
   * a version pushed after the page loaded is not marked as viewed. Default: `commit`.
   */
  shown?: string;
  /** The merge-base of the review: only files changed between it and `shown` can be marked as viewed. */
  mergeBase?: string;
}

/**
 * Mark files as viewed (true) or not (false) for `ref` at `commit` (the ref's current tip). A file is
 * stored with its blob in the version the reviewer saw, so it shows as unviewed again once the author
 * changes it. Throws for unsafe paths. Concurrent updates of the same ref are applied one by one.
 */
export async function updateReviewState(root: string, ref: string, commit: string, changes: Record<string, boolean>, options: ReviewStateUpdate = {}): Promise<ReviewState> {
  const abs = path.resolve(root);
  const files = Object.keys(changes);
  for (const f of files) if (!isSafeRelativePath(f)) throw new AnalyzeError(`Invalid file path "${f}".`);
  const file = reviewStatePath(abs, ref);
  return withStateLock(file, async () => {
    // Read inside the lock: an update that ran meanwhile is kept.
    const state = readReviewState(abs, ref);
    const shown = options.shown ?? commit;
    const marked = files.filter((f) => changes[f]);
    // Paths that are not part of the change (typos, files of another branch) are not stored.
    const inChange = options.mergeBase && marked.length ? await changedBetween(abs, options.mergeBase, shown, marked) : undefined;
    const blobs = await blobsAt(abs, shown, marked);
    for (const f of files) {
      if (!changes[f]) delete state.viewed[f];
      else if (!inChange || inChange.has(f)) state.viewed[f] = blobs.get(f) ?? '';
    }
    // Entries that no longer match the head are dropped, so the file does not grow with every push.
    const keep = await currentlyViewed(abs, commit, state);
    state.viewed = Object.fromEntries(keep.map((f) => [f, state.viewed[f]]));
    state.updatedAt = Date.now();
    ensureStateDir(stateDir(abs));
    writeFileAtomic(file, `${JSON.stringify({ ref, viewed: state.viewed, updatedAt: state.updatedAt }, null, 2)}\n`, 0o600);
    return state;
  });
}
