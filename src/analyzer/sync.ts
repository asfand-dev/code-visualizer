/**
 * Sync forecast (`code-visualizer sync`): what the base branch brings and what a rebase would do to your
 * work — before you run it. Works from refs you already fetched (fetching is opt-in):
 *
 * - incoming commits and their authors (`git log mb..base`);
 * - real conflicts from a trial merge (`git merge-tree --write-tree`, git ≥ 2.38; the working tree, the
 *   index and the refs are never touched), else files changed on both sides;
 * - changes that merge cleanly but break your code: an export you use was removed or its signature
 *   changed, a route you call was removed (snapshots of the merge-base and the base, compareReports);
 * - teammates' branches that touch your files (`--branches`).
 *
 * The analyzer itself is loaded only for the semantic part, so status lines can use `upstreamStatus`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usesOf, transitive } from '../shared/query.js';
import { callMatchesRoute, routeLabel } from '../shared/route-match.js';
import { compactPair, paramRange } from '../shared/signature.js';
import type { CommitInfo, ExportChange, FileInfo, ReportData, ReportSnapshot, SyncBranch, SyncReport, SyncSemanticChange, SyncState } from '../shared/types.js';
import type { AnalyzeCache } from './index.js';
import { findRepo, lastFetch } from './repo-state.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd` (injected in tests to spy on what is spawned). */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

/** The default runner: no shell, script-friendly settings, exit code kept (merge-tree exits 1 on conflicts). */
export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });

/** Version of the git on PATH as [major, minor, patch]. */
export async function gitVersion(run: GitRunner, cwd: string): Promise<[number, number, number] | undefined> {
  const out = await run(cwd, ['version']);
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(out.stdout);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

/** `git merge-tree --write-tree` (a trial merge without a working tree) arrived in git 2.38. */
export function supportsMergeTree(version: readonly number[] | undefined): boolean {
  if (!version) return false;
  const [major, minor] = version;
  return major > 2 || (major === 2 && minor >= 38);
}

/**
 * A trial merge of two commits: clean, or the files that would conflict, plus the merged tree (conflicted
 * files hold markers there). Undefined when git cannot tell. Run it from the repository top: git prints
 * the file names relative to the current directory.
 */
export async function trialMerge(run: GitRunner, top: string, ours: string, theirs: string): Promise<{ clean: boolean; files: string[]; tree: string } | undefined> {
  const out = await run(top, ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', ours, theirs]);
  if (out.code !== 0 && out.code !== 1) return undefined;
  // `<tree>\0<file>\0<file>\0` (file names only after a conflict).
  const [tree, ...files] = out.stdout.split('\0').filter(Boolean);
  return { clean: out.code === 0, files: [...new Set(files)].sort(), tree: tree?.trim() ?? '' };
}

/** A file's content at `spec` (`HEAD:src/a.ts`, `<tree>:src/a.ts`); undefined when it does not exist there. */
async function blob(run: GitRunner, top: string, spec: string): Promise<string | undefined> {
  const out = await run(top, ['cat-file', 'blob', spec]);
  return out.code === 0 ? out.stdout : undefined;
}

/** Larger (or binary) files are not merged on the side. */
const MAX_LOCAL_MERGE_BYTES = 2_000_000;

/**
 * Whether your uncommitted edits to `file` (a repository path) still apply once the file looks like it does
 * in `onto` (the result of the rebase or merge): a 3-way merge of HEAD's version, the working tree and
 * `onto`'s version with `git merge-file`, in a temporary folder — nothing in the repository is touched.
 * Undefined when that cannot be told (binary or very large files).
 */
export async function uncommittedEditsApply(run: GitRunner, top: string, onto: string, file: string): Promise<boolean | undefined> {
  const [incoming, base] = await Promise.all([blob(run, top, `${onto}:${file}`), blob(run, top, `HEAD:${file}`)]);
  let mine: string | undefined;
  try {
    mine = fs.readFileSync(path.join(top, file), 'utf8');
  } catch {
    mine = undefined;
  }
  // Deleted here or there, added on both sides: clean only when both sides agree.
  if (mine === undefined || incoming === undefined || base === undefined) return mine === incoming;
  const texts = [mine, base, incoming];
  if (texts.some((t) => t.length > MAX_LOCAL_MERGE_BYTES || t.includes('\0'))) return undefined;
  if (incoming === base || mine === base || mine === incoming) return true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-sync-'));
  try {
    const names = ['mine', 'base', 'incoming'];
    texts.forEach((text, i) => fs.writeFileSync(path.join(dir, names[i]), text));
    const out = await run(dir, ['merge-file', '-p', '--quiet', ...names]);
    // The exit code is the number of conflicts (negative on errors).
    return out.code === 0 ? true : out.code > 0 && out.code < 128 ? false : undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lines = (text: string, sep = '\n'): string[] => text.split(sep).map((l) => l.trim()).filter(Boolean);

async function verifyCommit(run: GitRunner, cwd: string, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith('-')) return undefined;
  const out = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out.code === 0 ? out.stdout.trim() || undefined : undefined;
}

/**
 * The branch your work goes into: origin/HEAD, else main / master / develop / trunk (remote first). On
 * that branch itself, its upstream (you are behind it after a fetch).
 */
export async function detectSyncBase(run: GitRunner, cwd: string): Promise<string | undefined> {
  const branch = (await run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const upstream = (await run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
  const originHead = (await run(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim();
  let base = originHead || undefined;
  if (!base) {
    for (const name of ['main', 'master', 'develop', 'trunk']) {
      if (await verifyCommit(run, cwd, `refs/remotes/origin/${name}`)) base = `origin/${name}`;
      else if (await verifyCommit(run, cwd, `refs/heads/${name}`)) base = name;
      if (base) break;
    }
  }
  // On the base branch itself (local `main`), what matters is its upstream.
  if ((!base || base === branch) && upstream) return upstream;
  return base;
}

/** `origin` for `origin/main` when that is a remote; undefined for local branches. */
async function remoteOf(run: GitRunner, cwd: string, base: string): Promise<string | undefined> {
  const remotes = lines((await run(cwd, ['remote'])).stdout);
  const named = remotes.find((r) => base.startsWith(`${r}/`) || base.startsWith(`refs/remotes/${r}/`));
  return named;
}

/* -------------------------------------------------------------------------- */
/*                               Quick status                                 */
/* -------------------------------------------------------------------------- */

export interface UpstreamStatus {
  name: string;
  ahead: number;
  behind: number;
  /** Files a rebase would conflict in (only computed when behind, with git ≥ 2.38). */
  conflicts?: number;
}

/**
 * How far HEAD and `base` are apart, plus the number of conflicting files when you are behind: two or three
 * git calls, for status lines (the full forecast is `analyzeSync`).
 */
export async function upstreamStatus(root: string, base: string, options: { run?: GitRunner; version?: readonly number[] } = {}): Promise<UpstreamStatus | undefined> {
  const run = options.run ?? runGit;
  const counts = await run(root, ['rev-list', '--left-right', '--count', `HEAD...${base}`]);
  if (counts.code !== 0) return undefined;
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  const status: UpstreamStatus = { name: base, ahead, behind };
  if (behind > 0 && supportsMergeTree(options.version ?? (await gitVersion(run, root)))) {
    const merged = await trialMerge(run, root, 'HEAD', base);
    if (merged) status.conflicts = merged.files.length;
  }
  return status;
}

/* -------------------------------------------------------------------------- */
/*                                  Forecast                                  */
/* -------------------------------------------------------------------------- */

export class SyncError extends Error {
  /** `ref`: the base that does not exist (callers suggest the branch it was probably meant to be). */
  constructor(
    message: string,
    readonly ref?: string,
  ) {
    super(message);
  }
}

export interface SyncOptions {
  /** The branch to forecast against (default: origin/HEAD, main, master…; on it, its upstream). */
  base?: string;
  /** Also check other branches updated within `since` that touch your files. */
  branches?: boolean;
  /** For `branches`: only refs with a commit in this period (ms, default 14 days). */
  since?: number;
  /** `git fetch --prune <remote>` first — the only network access, opt-in. */
  fetch?: boolean;
  run?: GitRunner;
  /** Injected for tests: the git version (decides between a trial merge and comparing files). */
  gitVersion?: readonly number[];
  now?: number;
  /**
   * Your working tree's analysis, for changes that merge cleanly but break your code (signatures,
   * removed exports and routes). Without it that part is skipped.
   */
  data?: ReportData | (() => Promise<ReportData>);
  /** Parse cache for the two snapshots (merge-base and base); `persist` stores them in .code-visualizer/. */
  cache?: AnalyzeCache;
  persist?: boolean;
  onProgress?: (message: string) => void;
}

const DAY = 24 * 3600 * 1000;
const MAX_INCOMING = 100;
const MAX_BRANCHES = 20;
const BRANCH_CONCURRENCY = 4;
/** Fetched longer ago than this: suggest a fetch. */
export const FETCH_STALE_MS = DAY;
const LOG_FORMAT = '--format=%x1e%H%x1f%aN%x1f%at%x1f%s';
/** Uncommitted files merged on the side per forecast (each takes three small git calls). */
const MAX_SIDE_MERGES = 20;

/** Parse `git log --numstat` output written with LOG_FORMAT (paths relative to the repository top). */
function parseCommits(log: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const chunk of log.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [header, ...rest] = chunk.split('\n');
    const [hash, author, at, ...subject] = header.split('\x1f');
    if (!hash) continue;
    let additions = 0;
    let deletions = 0;
    const paths: string[] = [];
    for (const line of rest) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      additions += Number(parts[0]) || 0;
      deletions += Number(parts[1]) || 0;
      paths.push(parts.slice(2).join('\t'));
    }
    commits.push({ hash, author, date: Number(at) * 1000, subject: subject.join('\x1f'), files: paths.length, additions, deletions, paths });
  }
  return commits;
}

/** Run `fn` over `items` with at most `limit` at a time, keeping the order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Paths in git output are relative to the repository top; the report uses the analyzed root's paths. */
function pathMapper(prefix: string): { toRoot: (p: string) => string; toTop: (p: string) => string } {
  const dir = prefix.replace(/\/+$/, '');
  return {
    toRoot: (p) => (!dir ? p : p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : path.posix.relative(dir, p)),
    toTop: (p) => (!dir ? p : path.posix.normalize(`${dir}/${p}`)),
  };
}

export async function analyzeSync(root: string, options: SyncOptions = {}): Promise<SyncReport> {
  const run = options.run ?? runGit;
  const now = options.now ?? Date.now();
  const notes: string[] = [];
  const cwd = path.resolve(root);
  const where = await run(cwd, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (where.code !== 0) throw new SyncError(`${cwd} is not inside a git repository (or git is not installed).`);
  // Pathspecs and merge-tree's file names are relative to the current directory: those run from the top.
  const top = where.stdout.split('\n')[0]?.trim() || cwd;
  const prefix = where.stdout.split('\n')[1]?.trim() ?? '';
  const { toRoot } = pathMapper(prefix);
  const head = await verifyCommit(run, cwd, 'HEAD');
  if (!head) throw new SyncError('This repository has no commits yet: there is nothing to sync.');

  let base = options.base ?? (await detectSyncBase(run, cwd));
  if (!base) throw new SyncError('No base branch found (origin/HEAD, main, master, develop or trunk) — pass --base <ref>.');
  if (options.fetch) {
    const remote = (await remoteOf(run, cwd, base)) ?? (lines((await run(cwd, ['remote'])).stdout).includes('origin') ? 'origin' : undefined);
    if (!remote) notes.push(`${base} is not a remote branch: nothing to fetch.`);
    else {
      options.onProgress?.(`Fetching ${remote}`);
      const fetched = await run(cwd, ['fetch', '--prune', '--quiet', remote]);
      if (fetched.code !== 0) notes.push(`git fetch ${remote} failed: ${lines(fetched.stderr)[0] ?? `exit code ${fetched.code}`} — showing what was fetched before.`);
    }
  }
  const baseCommit = await verifyCommit(run, cwd, base);
  if (!baseCommit) throw new SyncError(`Unknown base "${base}": no such branch or commit${options.base ? '' : ' — pass --base <ref>'} (fetched it? git fetch, or code-visualizer sync --fetch).`, base);
  // Short names for display: `origin/main`, not `refs/remotes/origin/main`.
  base = base.replace(/^refs\/(?:remotes|heads)\//, '');

  const version = options.gitVersion ?? (await gitVersion(run, cwd));
  const mergeTree = supportsMergeTree(version);
  const mbOut = await run(cwd, ['merge-base', 'HEAD', baseCommit]);
  const mergeBase = mbOut.code === 0 ? mbOut.stdout.trim() : '';
  const counts = lines((await run(cwd, ['rev-list', '--left-right', '--count', `HEAD...${baseCommit}`])).stdout)[0]?.split(/\s+/).map(Number) ?? [0, 0];
  const [ahead = 0, behind = 0] = counts;

  const repo = findRepo(cwd);
  const fetchedAt = repo && (await remoteOf(run, cwd, base)) ? lastFetch(repo, base) : undefined;
  const fetchedAgo = fetchedAt === undefined ? undefined : Math.max(0, Math.round(now - fetchedAt));
  if (fetchedAgo !== undefined && fetchedAgo > FETCH_STALE_MS && !options.fetch) notes.push(`Last fetched ${Math.round(fetchedAgo / DAY)} day${fetchedAgo < 2 * DAY ? '' : 's'} ago — run "code-visualizer sync --fetch" (or git fetch) to see the latest.`);

  // What you changed: committed on your branch, plus uncommitted and untracked files (repository paths).
  options.onProgress?.('Comparing your changes with incoming commits');
  const [committed, uncommitted, untracked] = await Promise.all([
    mergeBase ? run(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, 'HEAD']) : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    run(cwd, ['diff', '--name-only', '-z', '--no-renames', 'HEAD']),
    run(cwd, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name']),
  ]);
  const committedFiles = new Set(lines(committed.stdout, '\0'));
  const uncommittedFiles = new Set(lines(uncommitted.stdout, '\0'));
  const untrackedFiles = new Set(lines(untracked.stdout, '\0'));
  const mine = new Set([...committedFiles, ...uncommittedFiles, ...untrackedFiles]);

  // What is coming.
  let incoming: CommitInfo[] = [];
  let incomingFiles = new Set<string>();
  if (behind > 0) {
    const range = mergeBase ? `${mergeBase}..${baseCommit}` : baseCommit;
    const [log, diff] = await Promise.all([
      run(cwd, ['log', '--no-merges', '--no-renames', '--numstat', `-n${MAX_INCOMING * 5}`, LOG_FORMAT, range]),
      mergeBase ? run(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, baseCommit]) : Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    ]);
    incoming = parseCommits(log.stdout);
    incomingFiles = new Set(mergeBase ? lines(diff.stdout, '\0') : incoming.flatMap((c) => c.paths));
  }
  const authorCounts = new Map<string, number>();
  for (const c of incoming) authorCounts.set(c.author, (authorCounts.get(c.author) ?? 0) + 1);
  const authors = [...authorCounts].map(([name, commits]) => ({ name, commits })).sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
  const commitsTouching = (file: string): CommitInfo[] => incoming.filter((c) => c.paths.includes(file));

  // A trial merge of HEAD and the base (committed work only), else the files changed on both sides.
  let conflictFiles: string[] = [];
  let mergedTree: string | undefined;
  if (behind > 0 && mergeTree) {
    options.onProgress?.('Trial merge with git merge-tree');
    const merged = await trialMerge(run, top, 'HEAD', baseCommit);
    if (merged) {
      conflictFiles = merged.files;
      mergedTree = merged.tree || undefined;
    } else notes.push('git merge-tree failed: only files changed on both sides are compared.');
  }
  const conflictSet = new Set(conflictFiles);
  const conflicts: SyncReport['conflicts'] = conflictFiles.map((f) => ({ file: toRoot(f) }));
  // Files incoming commits change that you changed too. The trial merge covers commits only: uncommitted
  // edits are merged on the side with the rebased version (what `--autostash` re-applies them to).
  const overlap: SyncReport['overlap'] = [];
  let sideMerges = 0;
  for (const f of [...mine].filter((x) => incomingFiles.has(x) && !conflictSet.has(x)).sort()) {
    const commits = commitsTouching(f).map((c) => c.hash.slice(0, 7));
    if (untrackedFiles.has(f)) {
      // A rebase stops before it overwrites an untracked file (and --autostash does not stash it).
      conflicts.push({ file: toRoot(f), local: 'untracked' });
      continue;
    }
    if (uncommittedFiles.has(f)) {
      const onto = mergedTree ?? (committedFiles.has(f) ? undefined : baseCommit);
      const applies = onto && sideMerges++ < MAX_SIDE_MERGES ? await uncommittedEditsApply(run, top, onto, f) : undefined;
      if (applies === false) conflicts.push({ file: toRoot(f), local: 'uncommitted' });
      else overlap.push({ file: toRoot(f), commits, local: 'uncommitted', ...(applies ? { clean: true } : {}) });
      continue;
    }
    overlap.push({ file: toRoot(f), commits, ...(mergedTree ? { clean: true } : {}) });
  }

  const report: SyncReport = {
    base,
    mergeBase,
    behind,
    ahead,
    ...(fetchedAgo !== undefined ? { fetchedAgo } : {}),
    incoming: incoming.slice(0, MAX_INCOMING).map((c) => ({ ...c, paths: c.paths.slice(0, 50).map(toRoot) })),
    conflicts,
    overlap,
    semantic: [],
    baseCommit,
    head,
    authors,
    method: mergeTree ? 'merge-tree' : 'files',
    generatedAt: now,
  };

  // Changes that merge cleanly but break the code you wrote.
  if (behind > 0 && mergeBase && options.data && mine.size) {
    try {
      const data = typeof options.data === 'function' ? await options.data() : options.data;
      report.semantic = await semanticChanges(cwd, data, {
        mine: new Set([...mine].map(toRoot)),
        incomingFiles: new Set([...incomingFiles].map(toRoot)),
        mergeBase,
        baseCommit,
        commitFor: (rootFile, names) => commitChanging(run, top, `${mergeBase}..${baseCommit}`, pathMapper(prefix).toTop(rootFile), names, commitsTouching),
        cache: options.cache,
        persist: options.persist,
        onProgress: options.onProgress,
      });
    } catch (error) {
      notes.push(`Could not compare the APIs: ${(error as Error).message}`);
    }
  }

  if (options.branches) {
    options.onProgress?.('Looking at other branches');
    report.branches = await branchForecast(run, cwd, { top, head, base, baseCommit, mine, committed: committedFiles, uncommitted: uncommittedFiles, since: options.since ?? 14 * DAY, now, mergeTree, toRoot });
  }

  report.recommendation = await recommend(run, cwd, report, uncommitted.stdout.length > 0 || untracked.stdout.length > 0);
  if (notes.length) report.notes = notes;
  return report;
}

/** The next step: rebase (with autostash when you have local edits), or pull on the base branch itself. */
async function recommend(run: GitRunner, cwd: string, report: SyncReport, dirty: boolean): Promise<string | undefined> {
  if (report.behind === 0) return undefined;
  const upstream = (await run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
  if (upstream === report.base) return dirty ? 'git pull --rebase --autostash' : 'git pull --rebase';
  return `git rebase ${dirty ? '--autostash ' : ''}${report.base}`;
}

/* -------------------------------------------------------------------------- */
/*                                  Semantic                                  */
/* -------------------------------------------------------------------------- */

interface SemanticInput {
  /** Files you changed (analyzed-root paths). */
  mine: Set<string>;
  incomingFiles: Set<string>;
  mergeBase: string;
  baseCommit: string;
  /** The incoming commit that changed one of `names` in `file` (see `commitChanging`). */
  commitFor: (file: string, names: string[]) => Promise<Pick<CommitInfo, 'hash' | 'author'> | undefined>;
  cache?: AnalyzeCache;
  persist?: boolean;
  onProgress?: (message: string) => void;
}

/** The exported symbol of `file` named `name` (`default` for the default export). */
function exportedSymbol(file: FileInfo | undefined, name: string) {
  return file?.symbols.find((s) => s.exported && (name === 'default' ? s.isDefault : s.name === name));
}

/**
 * Exports and routes that incoming commits removed or changed and that your changed files use: compares
 * snapshots of the merge-base and the base, restricted to the incoming files your files can reach.
 */
async function semanticChanges(root: string, data: ReportData, input: SemanticInput): Promise<SyncSemanticChange[]> {
  const fileById = new Map(data.files.map((f) => [f.id, f]));
  const yours = [...input.mine].filter((f) => fileById.has(f));
  if (!yours.length) return [];
  // Incoming files your files import (through barrels, a few levels deep) or whose routes they call.
  const reachable = new Set<string>();
  for (const f of yours) for (const dep of transitive(data, f, 'deps', 4).keys()) reachable.add(dep);
  const yourCalls = (data.apiCalls ?? []).filter((c) => input.mine.has(c.file));
  const routeFiles = new Set(data.routes.filter((r) => yourCalls.some((c) => callMatchesRoute(r, c))).map((r) => r.file));
  const candidates = new Set([...input.incomingFiles].filter((f) => reachable.has(f) || routeFiles.has(f)));
  if (!candidates.size) return [];

  input.onProgress?.('Comparing the APIs your changes use');
  const [{ snapshotAt }, { compareReports }] = await Promise.all([import('./snapshot.js'), import('./compare.js')]);
  let cache = input.cache;
  if (!cache && input.persist) {
    // Warm: files the snapshots share with the working tree are not parsed again.
    const [{ createAnalyzeCache }, { loadDiskCache }] = await Promise.all([import('./index.js'), import('./disk-cache.js')]);
    cache = createAnalyzeCache();
    loadDiskCache(root, cache);
  }
  const opts = { cache, persist: input.persist };
  const [before, after] = await Promise.all([snapshotAt(root, input.mergeBase, opts), snapshotAt(root, input.baseCommit, opts)]);
  const delta = compareReports(before, after, { changedFiles: candidates, areas: false, limit: 200 });
  const afterFiles = new Map(after.files.map((f) => [f.id, f]));
  const out: SyncSemanticChange[] = [];
  const by = async (file: string, names: string[]): Promise<Pick<SyncSemanticChange, 'commit' | 'author'>> => {
    const c = await input.commitFor(file, names);
    return c ? { commit: c.hash.slice(0, 7), author: c.author } : {};
  };
  for (const e of delta.exports) {
    if (e.change === 'added' || !candidates.has(e.file)) continue;
    const change = exportChange(data, fileById, afterFiles, input.mine, e);
    if (change) out.push({ ...change, ...(await by(e.file, [e.name])) });
  }
  for (const removed of delta.routes.removed) {
    const route = before.routes.find((r) => r.id === removed.id);
    if (!route) continue;
    const sites = bySite(yourCalls.filter((c) => callMatchesRoute(route, c)).map((c) => ({ file: c.file, line: c.line, kind: 'http' as const })));
    if (!sites.length) continue;
    const names = [route.handler, route.method].filter((n): n is string => !!n && IDENTIFIER.test(n));
    out.push({ kind: 'route-removed', file: route.file, symbol: routeLabel(route), message: `${routeLabel(route)} was removed`, yourSites: sites, ...(await by(route.file, names)) });
  }
  return out;
}

/** A removed or changed export, as it affects your files (undefined when your files do not use it, or still fit). */
function exportChange(data: ReportData, fileById: Map<string, FileInfo>, afterFiles: Map<string, ReportSnapshot['files'][number]>, mine: Set<string>, e: ExportChange): Omit<SyncSemanticChange, 'commit' | 'author'> | undefined {
  const symbol = exportedSymbol(fileById.get(e.file), e.name);
  if (!symbol) return undefined;
  const uses = usesOf(data, { type: 'symbol', id: symbol.id });
  const yourCalls = uses.sites.filter((s) => mine.has(s.file));
  const yourImports = uses.imports.filter((s) => mine.has(s.file));
  const label = e.name === 'default' ? `default export of ${e.file}` : symbol.kind === 'function' || symbol.kind === 'hook' ? `${e.name}()` : e.name;
  const site = (s: { file: string; line: number; kind?: string }): SyncSite => ({ file: s.file, line: s.line, kind: s.kind === 'import' || s.kind === 'reexport' ? 'import' : 'call' });
  if (e.change === 'removed') {
    const sites = bySite([...yourCalls, ...yourImports].map(site));
    if (!sites.length) return undefined;
    return { kind: 'export-removed', file: e.file, symbol: e.name, message: `${label} was removed from ${e.file}`, yourSites: sites };
  }
  // A changed signature or kind: calls whose argument count no longer fits come first.
  const newSymbol = exportedSymbol(afterFiles.get(e.file), e.name);
  const range = newSymbol ? paramRange(newSymbol.params) : undefined;
  const stale = range ? yourCalls.filter((s) => s.argc !== undefined && s.argc >= 0 && (s.argc < range.required || s.argc > range.max)) : [];
  if (!stale.length && !(e.breaking && (yourCalls.length || yourImports.length))) return undefined;
  const sites = bySite((stale.length ? stale : yourCalls.length ? yourCalls : yourImports).map(site));
  const [was, now] = e.before && e.after ? compactPair(e.before, e.after) : [label, label];
  const message = e.change === 'kind' ? `${label} is a different kind of declaration now: ${now}` : `${was} → ${now}`;
  return { kind: 'signature-changed', file: e.file, symbol: e.name, message, yourSites: sites };
}

type SyncSite = SyncSemanticChange['yourSites'][number];

/** Sites once each, by file and line. */
function bySite(list: SyncSite[]): SyncSite[] {
  return [...new Map(list.map((s) => [`${s.file}:${s.line}`, s])).values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** POSIX ERE (what `git log -G` takes): the name, not part of a longer identifier. */
const ereName = (name: string): string => name.replace(/\$/g, '\\$');

/**
 * The incoming commit (in `range`) that changed one of `names` in `file` (a repository path): the newest
 * whose added or removed lines declare it (`function name`, `const name`…), else mention it, else the
 * newest commit that touched the file. One to three `git log -G` calls (run from the top: pathspecs are
 * relative to the current directory).
 */
async function commitChanging(run: GitRunner, top: string, range: string, file: string, names: string[], touching: (file: string) => CommitInfo[]): Promise<Pick<CommitInfo, 'hash' | 'author'> | undefined> {
  const ids = names.filter((n) => IDENTIFIER.test(n) && n !== 'default').map(ereName);
  const patterns: string[] = [];
  if (names.includes('default')) patterns.push('export[[:space:]]+default');
  if (ids.length) {
    const alt = `(${ids.join('|')})`;
    patterns.push(`(function|const|let|var|class|type|interface|enum)[[:space:]]+\\*?[[:space:]]*${alt}([^A-Za-z0-9_$]|$)`, `(^|[^A-Za-z0-9_$])${alt}([^A-Za-z0-9_$]|$)`);
  }
  for (const pattern of patterns) {
    const out = await run(top, ['log', '-n1', '--no-merges', `-G${pattern}`, '--format=%H%x1f%aN', range, '--', file]);
    const [hash, author] = out.stdout.trim().split('\x1f');
    if (out.code === 0 && hash) return { hash, author: author ?? '' };
  }
  return touching(file)[0];
}

/* -------------------------------------------------------------------------- */
/*                                  Branches                                  */
/* -------------------------------------------------------------------------- */

interface BranchInput {
  /** Repository top (merge-tree and side merges run there). */
  top: string;
  head: string;
  base: string;
  baseCommit: string;
  /** Your files (repository paths): all of them, and those changed in commits / uncommitted edits. */
  mine: Set<string>;
  committed: Set<string>;
  uncommitted: Set<string>;
  since: number;
  now: number;
  mergeTree: boolean;
  toRoot: (p: string) => string;
}

/**
 * Recently updated branches that change files you changed: would they merge cleanly with your work? A
 * branch's own changes are what it adds to the base (`merge-base(base, ref)..ref`), so a branch made from
 * a newer base is not blamed for what the base brings.
 */
async function branchForecast(run: GitRunner, cwd: string, input: BranchInput): Promise<SyncBranch[]> {
  if (!input.mine.size) return [];
  const own = (await run(cwd, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim();
  const upstream = (await run(cwd, ['rev-parse', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
  const out = await run(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(authorname)%09%(symref)', 'refs/remotes', 'refs/heads']);
  const seen = new Set<string>([input.head, input.baseCommit]);
  const refs: { ref: string; tip: string; updated: number; author: string }[] = [];
  for (const line of lines(out.stdout)) {
    const [full, short, tip, at, author, symref] = line.split('\t');
    if (!full || symref || full === own || full === upstream || short === input.base) continue;
    const updated = Number(at) * 1000;
    if (!(updated >= input.now - input.since) || seen.has(tip)) continue;
    seen.add(tip);
    refs.push({ ref: short, tip, updated, author: author ?? '' });
    if (refs.length >= MAX_BRANCHES) break;
  }
  let sideMerges = 0;
  const results = await mapLimit(refs, BRANCH_CONCURRENCY, async (r): Promise<SyncBranch | undefined> => {
    const mbHead = (await run(cwd, ['merge-base', 'HEAD', r.tip])).stdout.trim();
    if (!mbHead || mbHead === r.tip) return undefined; // nothing of theirs that you do not have
    // What the branch itself changes on top of the base it was made from.
    const mbBase = (await run(cwd, ['merge-base', input.baseCommit, r.tip])).stdout.trim() || mbHead;
    if (mbBase === r.tip) return undefined; // already part of the base
    const theirs = new Set(lines((await run(cwd, ['diff', '--name-only', '-z', '--no-renames', mbBase, r.tip])).stdout, '\0'));
    const files = [...input.mine].filter((f) => theirs.has(f));
    if (!files.length) return undefined;
    const merged = input.mergeTree ? await trialMerge(run, input.top, 'HEAD', r.tip) : undefined;
    const conflictFiles = new Set((merged?.files ?? []).filter((f) => theirs.has(f)).map(input.toRoot));
    let verified = !!merged;
    // Your uncommitted edits to the files it changes: would they still apply on top of that merge?
    for (const f of files) {
      if (!input.uncommitted.has(f) || conflictFiles.has(input.toRoot(f))) continue;
      const onto = merged?.tree || (input.committed.has(f) ? undefined : r.tip);
      const applies = onto && sideMerges++ < MAX_SIDE_MERGES ? await uncommittedEditsApply(run, input.top, onto, f) : undefined;
      if (applies === false) conflictFiles.add(input.toRoot(f));
      else if (applies === undefined) verified = false;
    }
    // Files that conflict with the base too stay: the branch conflicts with your work there as well
    // (the text says "also conflicts with <base>"), and calling it clean would be wrong. A trial merge that
    // conflicted only in files the base brings is not a verified "merges cleanly" either.
    if (merged && !merged.clean && !conflictFiles.size) verified = false;
    return {
      ref: r.ref,
      author: r.author,
      updated: r.updated,
      files: files.map(input.toRoot).sort(),
      result: conflictFiles.size ? 'conflict' : 'clean',
      conflictFiles: [...conflictFiles].sort(),
      verified,
    };
  });
  return results.filter((b): b is SyncBranch => !!b);
}

/** The short form kept in `.code-visualizer/state.json` → `sync` (status lines show it). */
export function syncState(report: SyncReport): SyncState {
  return {
    at: report.generatedAt ?? Date.now(),
    head: report.head,
    base: report.base,
    baseCommit: report.baseCommit,
    ahead: report.ahead,
    behind: report.behind,
    conflicts: report.conflicts.length,
    overlap: report.overlap.length,
    semantic: report.semantic.length,
  };
}
