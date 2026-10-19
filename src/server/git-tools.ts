/**
 * Git tools of the live server, for the Git tools view:
 *   GET  /api/git/search           look through the history (text, regex, message, author or file)
 *   GET  /api/git/commit           one commit with what it changed
 *   GET  /api/git/standup          your commits of the last days, from every branch
 *   POST /api/git/delete-branches  delete merged local branches, the safe way
 *
 * Nothing here fetches, pushes or rewrites history. Searches are bounded (time, size, parallel runs) and what
 * the user types only ever reaches git as the value of an option or after `--`, never as an option itself. A branch
 * is deleted only when git's own state, read again now, says it is merged and unprotected, and only with
 * `git branch --delete` (never `-D`); the caller must be on this machine (checked by the server).
 */
import { execFile } from 'node:child_process';
import { git, resolveCommit } from '../analyzer/git.js';
import { listBranches } from '../analyzer/repo.js';
import { deletableBranches, FIELD_SEPARATOR, RECORD_SEPARATOR } from '../shared/git-insights.js';
import type { BranchDeleteResult, BranchInfo, GitCommitDetail, GitSearchCommit, GitSearchMode, GitSearchResult, GitStandupCommits } from '../shared/types.js';

const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SEARCH_TIMEOUT_MS = 20_000;
const QUICK_TIMEOUT_MS = 10_000;
const MAX_PARALLEL_SEARCHES = 2;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FILES_PER_RESULT = 8;
const MAX_DETAIL_FILES = 200;
const MAX_BODY_CHARS = 4000;
const MAX_CONTAINING_BRANCHES = 10;
const MAX_DELETIONS = 50;
const DEFAULT_STANDUP_DAYS = 7;
const MAX_STANDUP_DAYS = 30;
const MAX_STANDUP_COMMITS = 200;

const HASH = /^[0-9a-f]{7,64}$/i;
/** A branch name starts with a letter, digit or underscore, so it can never be taken for an option. */
const BRANCH_NAME = /^\w[\w./-]*$/;
const LINE_BREAK = /[\0\r\n]/;

/** Per mode: the options that carry the text. The text is always glued to its option (`-S<text>`). */
const SEARCH_OPTIONS: Record<Exclude<GitSearchMode, 'file'>, (text: string) => string[]> = {
  text: (text) => [`-S${text}`],
  regex: (text) => [`-G${text}`],
  message: (text) => ['--fixed-strings', '--regexp-ignore-case', `--grep=${text}`],
  author: (text) => ['--fixed-strings', '--regexp-ignore-case', `--author=${text}`],
};
const SEARCH_MODES = [...Object.keys(SEARCH_OPTIONS), 'file'];

/** Every branch and tag, but not the stash: its "index on" and "WIP on" commits are bookkeeping, not history. */
const ALL_REFS = ['--exclude=refs/stash', '--all'];

const COMMIT_LINE = [RECORD_SEPARATOR + '%H', '%ct', '%an', '%s'].join(FIELD_SEPARATOR);
const DETAIL_FORMAT = [RECORD_SEPARATOR + '%H', '%P', '%ct', '%an', '%s', '%b'].join(FIELD_SEPARATOR);

export interface GitToolsRequest {
  method: string;
  pathname: string;
  params: URLSearchParams;
  /** The request comes from this machine (the server decides: only then may branches be deleted). */
  loopback: boolean;
  readBody: () => Promise<string>;
}

export interface GitToolsResponse {
  status: number;
  body: unknown;
}

export interface GitToolsService {
  /** Answers the `/api/git/*` endpoints; undefined for any other path. */
  handle(request: GitToolsRequest): Promise<GitToolsResponse | undefined>;
}

export interface GitToolsOptions {
  root: string;
  /** Branches were deleted: the analysis is out of date. */
  onBranchesChanged?: () => void;
}

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const fail = (status: number, message: string): GitToolsResponse => ({ status, body: { error: message } });
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const whole = (text: string | null, fallback: number): number => (text && Number.isFinite(Number(text)) ? Math.trunc(Number(text)) : fallback);

/** Git with a time limit and without optional locks (reading must never get in the way of the user's own git). */
function run(root: string, args: string[], timeoutMs: number): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args],
      { cwd: root, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout ?? '', stderr: (stderr ?? '').trim(), timedOut: !!error && (error as { killed?: boolean }).killed === true }),
    );
  });
}

/** The first line of git's complaint without its `fatal:` / `error:` prefix. */
const complaint = (stderr: string): string => (stderr.split('\n')[0] ?? '').replace(/^(?:fatal|error): /, '').trim() || 'git failed';

/** Records of a log that starts each commit with the record separator: header fields, then the file names. */
function records(output: string): { fields: string[]; lines: string[] }[] {
  return output
    .split(RECORD_SEPARATOR)
    .slice(1)
    .map((record) => {
      const [header, ...lines] = record.split('\n');
      return { fields: header.split(FIELD_SEPARATOR), lines: lines.map((l) => l.trim()).filter(Boolean) };
    });
}

/** Branch names from full ref names: not the "(HEAD detached …)" line, not a remote's `HEAD` pointer. */
function branchNames(refs: string): string[] {
  return refs
    .split('\n')
    .map((ref) => /^refs\/(?:heads|remotes)\/(.+)$/.exec(ref.trim())?.[1])
    .filter((name): name is string => !!name && !name.endsWith('/HEAD'));
}

export function createGitToolsService(options: GitToolsOptions): GitToolsService {
  const { root } = options;
  let searches = 0;

  const search = async (params: URLSearchParams): Promise<GitToolsResponse> => {
    const mode = params.get('mode') ?? 'text';
    if (!SEARCH_MODES.includes(mode)) return fail(400, `Unknown search mode "${mode.slice(0, 40)}". Use ${SEARCH_MODES.join(', ')}.`);
    const query = params.get('q')?.trim() ?? '';
    if (!query) return fail(400, 'Pass the text to look for as ?q=');
    if (query.length > MAX_QUERY_LENGTH) return fail(400, `The search text is longer than ${MAX_QUERY_LENGTH} characters.`);
    if (LINE_BREAK.test(query)) return fail(400, 'The search text cannot contain line breaks.');
    const limit = clamp(whole(params.get('limit'), DEFAULT_LIMIT), 1, MAX_LIMIT);
    if (searches >= MAX_PARALLEL_SEARCHES) return fail(429, 'Two searches are already running. Wait a moment.');

    // One more than asked, to know whether there is more.
    const log = ['log', `--max-count=${limit + 1}`, `--format=${COMMIT_LINE}`, '--name-only', ...(params.get('all') === '1' ? ALL_REFS : [])];
    const args = mode === 'file' ? ['--literal-pathspecs', ...log, '--follow', '--', query] : [...log, ...SEARCH_OPTIONS[mode as Exclude<GitSearchMode, 'file'>](query)];
    searches++;
    const result = await run(root, args, SEARCH_TIMEOUT_MS).finally(() => searches--);
    if (result.timedOut) return fail(504, `The search took longer than ${SEARCH_TIMEOUT_MS / 1000} seconds. Look in one file or folder, or search fewer branches.`);
    if (!result.ok) return fail(400, complaint(result.stderr));

    const commits = records(result.stdout).map(({ fields, lines }): GitSearchCommit => ({ hash: fields[0], date: Number(fields[1]) * 1000, author: fields[2] ?? '', subject: fields.slice(3).join(FIELD_SEPARATOR), files: lines.slice(0, FILES_PER_RESULT), fileCount: lines.length }));
    const body: GitSearchResult = { mode: mode as GitSearchMode, query, commits: commits.slice(0, limit), truncated: commits.length > limit };
    return { status: 200, body };
  };

  const commit = async (params: URLSearchParams): Promise<GitToolsResponse> => {
    const given = params.get('hash')?.trim() ?? '';
    if (!HASH.test(given)) return fail(400, 'Pass a commit hash as ?hash=');
    const hash = await resolveCommit(root, given);
    if (!hash) return fail(404, `No commit ${given.slice(0, 12)} in this repository.`);
    // Git prefers a branch or tag of that name to an abbreviated hash: then this is not the commit asked for.
    if (!hash.startsWith(given.toLowerCase())) return fail(400, `"${given.slice(0, 12)}" is also the name of a branch or tag. Use the full hash.`);
    // `-m --first-parent`: a merge is shown against its first parent, a root commit against nothing.
    const [info, stat, containing] = await Promise.all([
      run(root, ['log', '-1', `--format=${DETAIL_FORMAT}`, hash, '--'], QUICK_TIMEOUT_MS),
      run(root, ['show', '--numstat', '--format=', '-m', '--first-parent', hash, '--'], QUICK_TIMEOUT_MS),
      run(root, ['branch', '--all', '--contains', hash, '--format=%(refname)'], QUICK_TIMEOUT_MS),
    ]);
    // The body spans lines, so this record is split by its field separator only.
    const fields = info.stdout.split(RECORD_SEPARATOR)[1]?.split(FIELD_SEPARATOR);
    if (!info.ok || !fields) return fail(404, `Cannot read commit ${hash.slice(0, 12)}.`);

    const files = stat.stdout
      .split('\n')
      .map((line) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line))
      .filter((m): m is RegExpExecArray => !!m)
      .map(([, added, removed, file]) => ({ path: file, additions: Number(added) || 0, deletions: Number(removed) || 0, ...(added === '-' ? { binary: true } : {}) }));
    const body = fields.slice(5).join(FIELD_SEPARATOR).trim();
    const detail: GitCommitDetail = {
      hash,
      parents: fields[1] ? fields[1].split(' ') : [],
      date: Number(fields[2]) * 1000,
      author: fields[3] ?? '',
      subject: fields[4] ?? '',
      body: body.slice(0, MAX_BODY_CHARS),
      files: files.slice(0, MAX_DETAIL_FILES),
      fileCount: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
      containedIn: branchNames(containing.stdout).slice(0, MAX_CONTAINING_BRANCHES),
    };
    return { status: 200, body: detail };
  };

  const standup = async (params: URLSearchParams): Promise<GitToolsResponse> => {
    const days = clamp(whole(params.get('days'), DEFAULT_STANDUP_DAYS), 1, MAX_STANDUP_DAYS);
    const user = (await git(root, ['config', 'user.name']))?.trim() || undefined;
    const result = await run(
      root,
      ['log', ...ALL_REFS, '--no-merges', `--since=${days} days ago`, `--max-count=${MAX_STANDUP_COMMITS}`, `--format=${COMMIT_LINE}`, ...(user ? ['--fixed-strings', `--author=${user}`] : [])],
      QUICK_TIMEOUT_MS,
    );
    // A repository without commits has nothing to say, which is not an error.
    const commits = result.ok ? records(result.stdout).map(({ fields }) => ({ hash: fields[0], date: Number(fields[1]) * 1000, author: fields[2] ?? '', subject: fields.slice(3).join(FIELD_SEPARATOR) })) : [];
    const body: GitStandupCommits = { ...(user ? { user } : {}), commits };
    return { status: 200, body };
  };

  /** Why a branch is not deleted, in a sentence. */
  const whyNot = (branch: BranchInfo | undefined, base: string): string => {
    if (!branch) return 'There is no such local branch.';
    if (branch.current) return 'It is checked out.';
    if (branch.worktree) return 'It is checked out in another worktree.';
    if (branch.protected) return 'It is a protected branch.';
    return `It is not merged into ${base}.`;
  };

  const deleteBranches = async (request: GitToolsRequest): Promise<GitToolsResponse> => {
    if (request.method !== 'POST') return fail(405, 'Use POST.');
    if (!request.loopback) return fail(403, 'Branches can only be deleted on the machine that runs code-visualizer.');
    let names: string[];
    try {
      const body = JSON.parse(await request.readBody()) as { branches?: unknown };
      if (!Array.isArray(body.branches) || !body.branches.length || body.branches.some((b) => typeof b !== 'string')) throw new Error('shape');
      names = [...new Set(body.branches as string[])];
    } catch {
      return fail(400, 'Expected JSON: { "branches": ["feature/done"] }');
    }
    if (names.length > MAX_DELETIONS) return fail(400, `Delete at most ${MAX_DELETIONS} branches at a time.`);
    const invalid = names.find((name) => !BRANCH_NAME.test(name) || name.includes('..') || name.length > MAX_QUERY_LENGTH);
    if (invalid !== undefined) return fail(400, `Not a branch name: ${JSON.stringify(invalid.slice(0, 60))}`);

    // The state of the repository now, not what the page last showed.
    const fresh = await listBranches(root);
    if (!fresh) return fail(409, 'The branches of this repository cannot be read.');
    const allowed = new Set(deletableBranches(fresh.branches).map((b) => b.name));
    const local = new Map(fresh.branches.filter((b) => !b.remote).map((b) => [b.name, b]));

    const result: BranchDeleteResult = { deleted: [], refused: [] };
    for (const name of names) {
      if (!allowed.has(name)) {
        result.refused.push({ name, reason: whyNot(local.get(name), fresh.base) });
        continue;
      }
      // The full hash of the tip, to bring the branch back: `git branch <name> <hash>`.
      const tip = await resolveCommit(root, `refs/heads/${name}`);
      if (!tip) {
        result.refused.push({ name, reason: 'There is no such local branch.' });
        continue;
      }
      // `--delete`, never `--force`: git still refuses a branch that is not merged into its upstream or HEAD.
      const outcome = await run(root, ['branch', '--delete', '--', name], QUICK_TIMEOUT_MS);
      if (outcome.ok) result.deleted.push({ name, hash: tip });
      else result.refused.push({ name, reason: complaint(outcome.stderr) });
    }
    if (result.deleted.length) options.onBranchesChanged?.();
    return { status: 200, body: result };
  };

  return {
    async handle(request) {
      const { method, pathname, params } = request;
      if (pathname === '/api/git/delete-branches') return deleteBranches(request);
      const readers: Record<string, (p: URLSearchParams) => Promise<GitToolsResponse>> = { '/api/git/search': search, '/api/git/commit': commit, '/api/git/standup': standup };
      const reader = Object.hasOwn(readers, pathname) ? readers[pathname] : undefined;
      if (!reader) return undefined;
      return method === 'GET' ? reader(params) : fail(405, 'Use GET.');
    },
  };
}
