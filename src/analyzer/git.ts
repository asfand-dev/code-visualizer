import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { closest } from '../shared/delta.js';
import type { ChangeCoupling, ChangedFile, ChangeStatus, CommitInfo, CommitRef, FileGitInfo, GitSummary } from '../shared/types.js';
import { AnalyzeError } from './errors.js';

const execFileAsync = promisify(execFile);

export interface GitAnalysis {
  summary: GitSummary;
  files: Map<string, FileGitInfo>;
  coupling: ChangeCoupling[];
  info: { branch?: string; commit?: string; remote?: string };
  /** Full HEAD hash; used to cache history between runs. */
  headHash?: string;
}

export interface RawChanges {
  mode: 'working' | 'branch';
  base?: string;
  baseCommit?: string;
  files: ChangedFile[];
  commits: CommitInfo[];
}

/** Run git with stable, script-friendly settings. Returns undefined when git fails. */
export async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], {
      cwd: root,
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Run git and keep its error output (for commands whose failure the user needs to see, e.g. a fetch). */
export async function gitRun(root: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: (e.stderr || e.message).trim() };
  }
}

/** Remove credentials from remote URLs (https://user:token@host/…). */
export function sanitizeRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  try {
    if (/^https?:\/\//.test(trimmed)) {
      const u = new URL(trimmed);
      u.username = '';
      u.password = '';
      return u.toString().replace(/\.git$/, '');
    }
  } catch {
    return undefined;
  }
  // git@github.com:owner/repo.git → https://github.com/owner/repo
  const ssh = trimmed.match(/^[\w.-]+@([\w.-]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return undefined;
}

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
// %aN / %aE apply .mailmap, so one person with several names or emails is counted once. The raw %ae
// links the email you commit with today to your mapped identity (a name-qualified .mailmap entry).
const LOG_FORMAT = '--format=%x1e%H%x1f%aN%x1f%aE%x1f%ae%x1f%at%x1f%s';

interface ParsedCommit extends CommitInfo {
  allPaths: string[];
  /** Author email after .mailmap. */
  email: string;
  /** Author email as committed. */
  rawEmail: string;
}

/** Emails shared by many people (CI images, defaults) never link two names. */
const GENERIC_EMAIL_RE = /^(root|admin|administrator|user|nobody|noreply|no-reply|git|ubuntu|runner|builder?)@|@(localhost|\(none\))$|^$/i;

export interface AuthorIdentities {
  /** Canonical (most recent) display name for a name or email seen in the history. */
  nameOf(nameOrEmail: string): string | undefined;
  /** Most recent email of a canonical name. */
  emailOf(name: string): string | undefined;
}

/**
 * Merge author names that share an email (and emails that share a name) into one person, named after their
 * most recent commit. Rewrites `author` of every commit; `commits` must be ordered newest first.
 */
export function canonicalizeAuthors(commits: { author: string; email: string; rawEmail?: string }[]): AuthorIdentities {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    for (let k = key; k !== root; ) {
      const next = parent.get(k)!;
      parent.set(k, root);
      k = next;
    }
    return root;
  };
  const add = (key: string): void => {
    if (!parent.has(key)) parent.set(key, key);
  };
  const emailKey = (email: string): string | undefined => (GENERIC_EMAIL_RE.test(email.trim()) ? undefined : `e:${email.trim().toLowerCase()}`);
  for (const c of commits) {
    const n = `n:${c.author}`;
    add(n);
    for (const address of c.rawEmail && c.rawEmail !== c.email ? [c.email, c.rawEmail] : [c.email]) {
      const e = emailKey(address);
      if (!e) continue;
      add(e);
      const [a, b] = [find(n), find(e)];
      if (a !== b) parent.set(b, a);
    }
  }
  const display = new Map<string, string>();
  const email = new Map<string, string>();
  for (const c of commits) {
    const root = find(`n:${c.author}`);
    if (!display.has(root)) display.set(root, c.author);
    if (!email.has(root) && emailKey(c.email)) email.set(root, c.email.trim());
  }
  const emailByName = new Map<string, string>();
  for (const [root, name] of display) {
    const e = email.get(root);
    if (e && !emailByName.has(name)) emailByName.set(name, e);
  }
  for (const c of commits) c.author = display.get(find(`n:${c.author}`)) ?? c.author;
  return {
    nameOf(nameOrEmail) {
      const key = nameOrEmail.includes('@') ? emailKey(nameOrEmail) : `n:${nameOrEmail}`;
      return key && parent.has(key) ? display.get(find(key)) : undefined;
    },
    emailOf: (name) => emailByName.get(name),
  };
}

/** Parse `git log --numstat` output produced with LOG_FORMAT. */
function parseLog(log: string, fileIds: Set<string>): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const chunk of log.split('\x1e')) {
    if (!chunk.trim()) continue;
    const newline = chunk.indexOf('\n');
    const header = newline === -1 ? chunk : chunk.slice(0, newline);
    const [hash, author, email, rawEmail, ts, ...subjectParts] = header.split('\x1f');
    const date = Number(ts) * 1000;
    if (!hash || !author || !Number.isFinite(date)) continue;
    let additions = 0;
    let deletions = 0;
    const allPaths: string[] = [];
    const body = newline === -1 ? '' : chunk.slice(newline + 1);
    for (const line of body.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const add = Number(parts[0]);
      const del = Number(parts[1]);
      if (Number.isFinite(add)) additions += add;
      if (Number.isFinite(del)) deletions += del;
      allPaths.push(unquoteGitPath(parts.slice(2).join('\t')));
    }
    commits.push({
      hash: hash.slice(0, 10),
      date,
      author,
      subject: subjectParts.join('\x1f').slice(0, 200),
      files: allPaths.length,
      additions,
      deletions,
      paths: allPaths.filter((p) => fileIds.has(p)).slice(0, 60),
      allPaths,
      email: email ?? '',
      rawEmail: rawEmail ?? '',
    });
  }
  return commits;
}

function areaOf(id: string): string {
  const parts = id.split('/');
  parts.pop();
  if (!parts.length) return '.';
  if (parts[0] === 'src' || parts[0] === 'app' || parts[0] === 'packages' || parts[0] === 'apps' || parts[0] === 'lib') return parts.slice(0, 2).join('/');
  return parts[0];
}

/** `git check-mailmap` for the configured identity (undefined without user.email). */
async function mailmapIdentity(root: string, name: string | undefined, email: string | undefined): Promise<{ name?: string; email?: string } | undefined> {
  if (!email) return undefined;
  const out = (await git(root, ['check-mailmap', name ? `${name} <${email}>` : `<${email}>`]))?.trim();
  const m = out?.match(/^(.*?)\s*<([^>]*)>$/);
  return m ? { name: m[1] || undefined, email: m[2] || undefined } : undefined;
}

/**
 * Who is running the analysis: `git config user.email` (through .mailmap) identifies their name in the
 * history; `user.name` is the fallback when that email has no commits yet.
 */
function currentUser(
  config: { name?: string; email?: string },
  mapped: { name?: string; email?: string } | undefined,
  identities: AuthorIdentities,
): { name?: string; email?: string } {
  const name = mapped?.name ?? config.name;
  const email = mapped?.email ?? config.email;
  const known =
    (email && identities.nameOf(email)) ||
    (config.email && identities.nameOf(config.email)) ||
    (name && identities.nameOf(name)) ||
    (config.name && identities.nameOf(config.name));
  // The email your history knows you by, so it matches the per-file author emails.
  return { name: known || name || undefined, email: (known && identities.emailOf(known)) || email || undefined };
}

export async function analyzeGit(root: string, fileIds: Set<string>, maxCommits = 4000): Promise<GitAnalysis | undefined> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return undefined;
  const [branch, head, remote, configName, configEmail, upstreamName] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['config', '--get', 'remote.origin.url']),
    git(root, ['config', '--get', 'user.name']),
    git(root, ['config', '--get', 'user.email']),
    git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
  ]);
  let upstream: GitSummary['upstream'];
  if (upstreamName?.trim()) {
    const counts = await git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    const [behind, ahead] = (counts ?? '').trim().split(/\s+/).map(Number);
    if (Number.isFinite(ahead) && Number.isFinite(behind)) upstream = { name: upstreamName.trim(), ahead, behind };
  }
  const config = { name: configName?.trim() || undefined, email: configEmail?.trim() || undefined };
  const [log, mapped] = await Promise.all([
    git(root, ['log', '--no-merges', '--relative', '--no-renames', '--numstat', `-n${maxCommits}`, LOG_FORMAT, '--', '.']),
    mailmapIdentity(root, config.name, config.email),
  ]);
  if (log === undefined) return undefined;
  const commits = parseLog(log, fileIds);
  const identities = canonicalizeAuthors(commits);
  const me = currentUser(config, mapped, identities);

  const files = new Map<string, FileGitInfo & { authorMap: Map<string, { commits: number; last: number }> }>();
  const contributors = new Map<string, { commits: number; files: Set<string>; first: number; last: number; areas: Map<string, number> }>();
  const pairCounts = new Map<string, number>();
  const now = Date.now();
  const todayStart = new Date(new Date(now).toDateString()).getTime();
  const weekly = new Array<number>(52).fill(0);
  const daily = new Array<number>(371).fill(0);
  let firstCommit = Infinity;
  let lastCommit = 0;

  for (const c of commits) {
    firstCommit = Math.min(firstCommit, c.date);
    lastCommit = Math.max(lastCommit, c.date);
    const week = Math.floor((now - c.date) / WEEK);
    if (week >= 0 && week < 52) weekly[51 - week]++;
    const daysAgo = Math.floor((todayStart + DAY - 1 - c.date) / DAY);
    if (daysAgo >= 0 && daysAgo < 371) daily[370 - daysAgo]++;
    let contributor = contributors.get(c.author);
    if (!contributor) {
      contributor = { commits: 0, files: new Set(), first: c.date, last: c.date, areas: new Map() };
      contributors.set(c.author, contributor);
    }
    contributor.commits++;
    contributor.first = Math.min(contributor.first, c.date);
    contributor.last = Math.max(contributor.last, c.date);
    const touched = c.allPaths.filter((p) => fileIds.has(p));
    const areas = new Set<string>();
    for (const id of touched) {
      contributor.files.add(id);
      areas.add(areaOf(id));
      let info = files.get(id);
      if (!info) {
        info = { commits: 0, authors: [], lastModified: c.date, firstSeen: c.date, recent: [], ownership: 0, authorMap: new Map() };
        files.set(id, info);
      }
      info.commits++;
      info.lastModified = Math.max(info.lastModified, c.date);
      info.firstSeen = Math.min(info.firstSeen, c.date);
      if (info.recent.length < 8) info.recent.push({ hash: c.hash, date: c.date, author: c.author, subject: c.subject });
      const a = info.authorMap.get(c.author) ?? { commits: 0, last: 0 };
      a.commits++;
      a.last = Math.max(a.last, c.date);
      info.authorMap.set(c.author, a);
    }
    for (const area of areas) contributor.areas.set(area, (contributor.areas.get(area) ?? 0) + 1);
    // Change coupling: files that are committed together (ignore huge refactor commits).
    if (touched.length >= 2 && touched.length <= 25) {
      const sorted = [...touched].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}\0${sorted[j]}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const result = new Map<string, FileGitInfo>();
  for (const [id, info] of files) {
    const authors = [...info.authorMap.entries()]
      .sort((a, b) => b[1].commits - a[1].commits || b[1].last - a[1].last)
      .slice(0, 8)
      .map(([name, a]) => ({ name, commits: a.commits, last: a.last, email: identities.emailOf(name) }));
    result.set(id, {
      commits: info.commits,
      authors,
      lastModified: info.lastModified,
      firstSeen: info.firstSeen,
      recent: info.recent,
      ownership: authors.length ? Math.round((authors[0].commits / info.commits) * 100) / 100 : 0,
    });
  }

  const coupling: ChangeCoupling[] = [];
  for (const [key, count] of pairCounts) {
    if (count < 3) continue;
    const [a, b] = key.split('\0');
    const min = Math.min(result.get(a)?.commits ?? count, result.get(b)?.commits ?? count);
    coupling.push({ a, b, count, ratio: Math.round((count / Math.max(min, 1)) * 100) / 100 });
  }
  coupling.sort((x, y) => y.count * y.ratio - x.count * x.ratio || y.count - x.count);

  return {
    summary: {
      branch: branch?.trim(),
      head: head?.trim().slice(0, 10),
      user: me.name,
      userEmail: me.email,
      upstream,
      commitsAnalyzed: commits.length,
      firstCommit: Number.isFinite(firstCommit) ? firstCommit : undefined,
      lastCommit: lastCommit || undefined,
      contributors: [...contributors.entries()]
        .sort((a, b) => b[1].commits - a[1].commits)
        .slice(0, 40)
        .map(([name, c]) => ({
          name,
          commits: c.commits,
          files: c.files.size,
          first: c.first,
          last: c.last,
          areas: [...c.areas.entries()]
            .sort((x, y) => y[1] - x[1])
            .slice(0, 5)
            .map(([path, n]) => ({ path, commits: n })),
        })),
      weeklyActivity: weekly,
      dailyActivity: daily,
      commits: commits.slice(0, 300).map(({ allPaths: _all, email: _email, rawEmail: _raw, ...c }) => c),
    },
    files: result,
    coupling: coupling.slice(0, 100),
    info: { branch: branch?.trim(), commit: head?.trim().slice(0, 7), remote: sanitizeRemote(remote) },
    headHash: head?.trim(),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Changes                                  */
/* -------------------------------------------------------------------------- */

async function refExists(root: string, ref: string): Promise<boolean> {
  const out = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return !!out?.trim();
}

/**
 * The target branch of the pull / merge request a CI job runs for, from the CI's environment (GitHub
 * Actions, GitLab, Bitbucket, Azure Pipelines, Jenkins), as `origin/<branch>` or `<branch>` when that
 * ref exists. GitLab's merge-base commit is the fallback when the target branch was not fetched.
 */
export async function ciBaseBranch(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const names = [env.GITHUB_BASE_REF, env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME, env.BITBUCKET_PR_DESTINATION_BRANCH, env.SYSTEM_PULLREQUEST_TARGETBRANCH, env.CHANGE_TARGET]
    .map((n) => n?.trim().replace(/^refs\/heads\//, ''))
    .filter((n): n is string => !!n && !n.startsWith('-'));
  for (const name of names) {
    if (await refExists(root, `origin/${name}`)) return `origin/${name}`;
    if (await refExists(root, name)) return name;
  }
  const diffBase = env.CI_MERGE_REQUEST_DIFF_BASE_SHA?.trim();
  if (diffBase && /^[0-9a-f]{7,64}$/i.test(diffBase) && (await refExists(root, diffBase))) return diffBase;
  return undefined;
}

/**
 * The branch a feature branch is compared to: in CI the pull request's target branch, otherwise
 * origin/HEAD, then main / master / develop / trunk.
 */
export async function detectBaseBranch(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const ci = await ciBaseBranch(root, env);
  if (ci) return ci;
  const originHead = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead?.trim()) return originHead.trim();
  for (const name of ['main', 'master', 'develop', 'trunk']) {
    if (await refExists(root, `origin/${name}`)) return `origin/${name}`;
    if (await refExists(root, name)) return name;
  }
  return undefined;
}

const MAX_DIFF_PER_FILE = 120_000;
const MAX_DIFF_TOTAL = 4_000_000;

interface DiffChunk {
  path: string;
  oldPath?: string;
  text: string;
  lines: number[];
  /** `+` lines (new numbering): what patch coverage measures. */
  added: number[];
  binary: boolean;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Git C-quotes paths with special characters, e.g. `"src/say \"hi\".ts"` or octal-escaped bytes. */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\' && i + 1 < body.length) {
      const octal = body.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        i += 4;
        continue;
      }
      const code = C_ESCAPES[body[i + 1]];
      if (code !== undefined) {
        bytes.push(code);
        i += 2;
        continue;
      }
    }
    const ch = String.fromCodePoint(body.codePointAt(i)!);
    bytes.push(...Buffer.from(ch, 'utf8'));
    i += ch.length;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** A path from a `--- a/…` / `+++ b/…` header (undefined for /dev/null). */
function headerPath(raw: string, prefix: 'a/' | 'b/'): string | undefined {
  // Git ends these lines with a tab when the path contains spaces (older tools put a timestamp after it).
  const p = unquoteGitPath(raw.replace(/\t.*$/, ''));
  if (p === '/dev/null') return undefined;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Split a unified diff into files and collect the changed line numbers of the new version.
 * Expects git's default `a/` and `b/` prefixes (`analyzeChanges` requests them explicitly).
 */
export function parseUnifiedDiff(diff: string): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  const parts = diff.split(/^diff --git /m).filter(Boolean);
  for (const part of parts) {
    const text = `diff --git ${part}`;
    const lines = text.split('\n');
    let path = '';
    let oldPath: string | undefined;
    let binary = false;
    const changed = new Set<number>();
    const added: number[] = [];
    let newLine = 0;
    let inHunk = false;
    for (const line of lines) {
      if (!inHunk) {
        if (line.startsWith('+++ ')) {
          path = headerPath(line.slice(4), 'b/') ?? path;
        } else if (line.startsWith('--- ')) {
          oldPath = headerPath(line.slice(4), 'a/') ?? oldPath;
        } else if (line.startsWith('rename to ')) {
          path = unquoteGitPath(line.slice(10));
        } else if (line.startsWith('rename from ')) {
          oldPath = unquoteGitPath(line.slice(12));
        } else if (line.startsWith('Binary files')) {
          binary = true;
        }
      }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) {
        inHunk = true;
        newLine = Number(hunk[1]);
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) {
        changed.add(newLine);
        added.push(newLine);
        newLine++;
      } else if (line.startsWith('-')) {
        changed.add(Math.max(1, newLine));
      } else if (line.startsWith(' ')) {
        newLine++;
      } else if (line.startsWith('diff --git')) {
        inHunk = false;
      }
    }
    if (!path) path = oldPath ?? lines[0].replace(/^diff --git a\/(.+?) b\/.*$/, '$1');
    chunks.push({ path, oldPath: oldPath !== path ? oldPath : undefined, text, lines: [...changed].sort((a, b) => a - b), added, binary });
  }
  return chunks;
}

/**
 * Trunk-based work: the upstream of the current branch and where HEAD left it, when HEAD has commits
 * that are not pushed yet (undefined without an upstream or with nothing to push).
 */
async function unpushedWork(root: string): Promise<{ upstream: string; mergeBase: string } | undefined> {
  const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))?.trim();
  if (!upstream) return undefined;
  const ahead = Number((await git(root, ['rev-list', '--count', '@{u}..HEAD']))?.trim());
  if (!(ahead > 0)) return undefined;
  const mergeBase = (await git(root, ['merge-base', 'HEAD', '@{u}']))?.trim();
  return mergeBase ? { upstream, mergeBase } : undefined;
}

/**
 * Changed files between two trees (`against`: git diff arguments such as `[commit]`, `['--cached', commit]`
 * or `[base, head]`), with line counts, changed lines and the diff text. `blobs`: also record the blob id
 * of each file on the new side (only meaningful when that side is a commit or the index).
 */
async function diffFiles(root: string, fileIds: Set<string>, against: string[], files: Map<string, ChangedFile>, blobs = false): Promise<void> {
  const [raw, numstat, diff] = await Promise.all([
    // -z: NUL-separated, unquoted paths (robust against spaces, quotes and " => " in names).
    git(root, ['diff', '--raw', '-z', '--no-abbrev', '-M', '--relative', '--no-ext-diff', ...against, '--', '.']),
    git(root, ['diff', '--numstat', '-z', '-M', '--relative', ...against, '--', '.']),
    // Explicit prefixes: settings like diff.mnemonicPrefix or diff.noprefix would change them otherwise.
    git(root, ['diff', '-U3', '-M', '--relative', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', ...against, '--', '.']),
  ]);
  // ":100644 100644 <old> <new> M\0path\0", renames and copies: ":… R100\0old\0new\0".
  const status = (raw ?? '').split('\0');
  for (let i = 0; i < status.length; ) {
    const meta = status[i++];
    if (!meta?.startsWith(':')) continue;
    const [, , , newBlob, code = ''] = meta.slice(1).split(' ');
    const twoPaths = code[0] === 'R' || code[0] === 'C';
    const from = twoPaths ? status[i++] : undefined;
    const id = status[i++];
    if (!id) continue;
    const kind: ChangeStatus = code[0] === 'A' || code[0] === 'C' ? 'added' : code[0] === 'D' ? 'deleted' : code[0] === 'R' ? 'renamed' : 'modified';
    const file: ChangedFile = { id, status: kind, oldPath: kind === 'renamed' ? from : undefined, additions: 0, deletions: 0, lines: [], analyzed: fileIds.has(id) };
    if (blobs && newBlob && !/^0+$/.test(newBlob)) file.blob = newBlob;
    files.set(id, file);
  }
  // "12\t3\tpath\0", renames: "12\t3\t\0old\0new\0"; binary files report "-".
  const stats = (numstat ?? '').split('\0');
  for (let i = 0; i < stats.length; ) {
    const parts = stats[i++].split('\t');
    if (parts.length < 3) continue;
    let id = parts.slice(2).join('\t');
    if (!id) {
      i++; // old path
      id = stats[i++] ?? '';
    }
    const f = files.get(id);
    if (!f) continue;
    f.additions = Number(parts[0]) || 0;
    f.deletions = Number(parts[1]) || 0;
  }
  let budget = MAX_DIFF_TOTAL;
  for (const chunk of parseUnifiedDiff(diff ?? '')) {
    const f = files.get(chunk.path);
    if (!f) continue;
    f.lines = chunk.lines.slice(0, 5000);
    // Always set (also empty): `lines` marks deletions too, which patch coverage must not count.
    f.added = chunk.added.slice(0, 5000);
    if (!chunk.binary && budget > 0) {
      const text = chunk.text.length > MAX_DIFF_PER_FILE ? `${chunk.text.slice(0, MAX_DIFF_PER_FILE)}\n… diff truncated …\n` : chunk.text;
      f.diff = text;
      budget -= text.length;
    }
  }
}

/**
 * review-mode: what `head` changed since it left `base` (their merge-base), like a pull request. Without
 * a base (none given or detected, or no common history) the change set is empty.
 */
async function refChanges(root: string, fileIds: Set<string>, head: string, base: string | undefined): Promise<RawChanges | undefined> {
  const headCommit = await resolveCommit(root, head);
  if (!headCommit) return undefined;
  const requested = base ?? (await detectBaseBranch(root));
  const baseCommit = requested ? await resolveCommit(root, requested) : undefined;
  const mergeBase = baseCommit ? (await git(root, ['merge-base', headCommit, baseCommit]))?.trim() : undefined;
  if (!requested || !mergeBase) return { mode: 'branch', base: requested, files: [], commits: [] };
  const files = new Map<string, ChangedFile>();
  if (mergeBase !== headCommit) await diffFiles(root, fileIds, [mergeBase, headCommit], files, true);
  const log = mergeBase !== headCommit ? await git(root, ['log', '--no-merges', '--relative', '--no-renames', '--numstat', LOG_FORMAT, `${mergeBase}..${headCommit}`, '--', '.']) : '';
  const parsed = parseLog(log ?? '', fileIds);
  canonicalizeAuthors(parsed);
  const commits = parsed.slice(0, 200).map(({ allPaths: _all, email: _email, rawEmail: _raw, ...c }) => c);
  const list = [...files.values()].sort((a, b) => Number(b.analyzed) - Number(a.analyzed) || a.id.localeCompare(b.id)).slice(0, 2000);
  return { mode: 'branch', base: requested, baseCommit: mergeBase.slice(0, 10), files: list, commits };
}

/**
 * ` Did you mean "main"?` for a ref that looks like a typo of a branch or tag ('' when none is close); for a
 * branch that exists only on origin (a teammate's branch you never checked out), its remote name.
 */
export async function refHint(root: string, ref: string): Promise<string> {
  if (ref && !ref.startsWith('-') && !ref.startsWith('origin/') && !ref.startsWith('refs/')) {
    const remote = await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`]);
    if (remote?.trim()) {
      const local = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`]);
      return ` Did you mean "origin/${ref}"?${local?.trim() ? '' : ` (there is no local branch "${ref}"; git fetch updates origin/${ref})`}`;
    }
  }
  const out = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  const hint = closest(ref, (out ?? '').split('\n').filter((r) => r && !r.endsWith('/HEAD')));
  return hint ? ` Did you mean "${hint}"?` : '';
}

/**
 * The message for a base ref that names no commit: `Unknown git ref "mian". Did you mean "main"?`, plus how
 * to fetch it when it is a remote branch or the run is in CI (where a shallow checkout lacks it).
 */
export async function unknownBaseMessage(root: string, ref: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const hint = await refHint(root, ref);
  const remote = /^origin\//.test(ref);
  const fetch = remote || env.CI ? ` Fetch it first (actions/checkout fetch-depth: 0, or git fetch origin ${ref.replace(/^origin\//, '')}).` : '';
  return `Unknown git ref "${ref}".${hint}${fetch}`;
}

/** Stale `"base"` settings already reported in this process (once per root and ref, not per re-analysis). */
const warnedBases = new Set<string>();

export async function analyzeChanges(
  root: string,
  fileIds: Set<string>,
  options: {
    /**
     * The ref to compare with (else the detected base branch). One that names no commit is an
     * AnalyzeError ('unknown-ref') — never silently another comparison — unless it comes from the
     * configuration (`baseFromConfig`): then it is reported once on stderr and the base is detected.
     */
    base?: string;
    baseFromConfig?: boolean;
    fileText?: (id: string) => string | undefined;
    /** Staged changes only: `git diff --cached` against HEAD; untracked files are not part of them. */
    index?: boolean;
    /**
     * review-mode: the changes of this ref (a branch, tag or commit) since it left `base` (their
     * merge-base), instead of your working tree. Nothing is checked out; untracked files are ignored.
     */
    head?: string;
    /** daily-loop: compare the base with HEAD (committed work only), not the working tree; untracked files are left out. */
    committed?: boolean;
  } = {},
): Promise<RawChanges | undefined> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return undefined;
  if (options.head !== undefined) return refChanges(root, fileIds, options.head, options.base);
  const hasHead = await refExists(root, 'HEAD');
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  let mode: RawChanges['mode'] = 'working';
  let target = hasHead ? 'HEAD' : undefined;
  let base: string | undefined;
  let baseCommit: string | undefined;
  let given = options.index ? undefined : options.base;
  if (given !== undefined && (given.startsWith('-') || !(await refExists(root, given)))) {
    const message = await unknownBaseMessage(root, given);
    if (!options.baseFromConfig) throw new AnalyzeError(message, 'unknown-ref');
    // A stale configuration must not break every report: say so once, then compare as if it were not set.
    const key = `${path.resolve(root)}\0${given}`;
    if (!warnedBases.has(key)) {
      warnedBases.add(key);
      process.stderr.write(`! Ignoring "base": "${given}" in the configuration — ${message}\n`);
    }
    given = undefined;
  }
  const requested = options.index ? undefined : (given ?? (hasHead ? await detectBaseBranch(root) : undefined));
  if (requested && hasHead && (await refExists(root, requested))) {
    const baseName = requested.replace(/^origin\//, '');
    const sameAsBase = branch === baseName || branch === requested;
    const mergeBase = (await git(root, ['merge-base', 'HEAD', requested]))?.trim();
    const headHash = (await git(root, ['rev-parse', 'HEAD']))?.trim();
    if (mergeBase && !(sameAsBase && !given) && mergeBase !== headHash) {
      mode = 'branch';
      target = mergeBase;
      base = requested;
      baseCommit = mergeBase.slice(0, 10);
    } else if (given && mergeBase) {
      mode = 'branch';
      target = mergeBase;
      base = requested;
      baseCommit = mergeBase.slice(0, 10);
    } else if (sameAsBase && !given) {
      // Trunk-based: on the base branch itself, the commits you have not pushed yet are your work too.
      const unpushed = await unpushedWork(root);
      if (unpushed) {
        mode = 'branch';
        target = unpushed.mergeBase;
        base = unpushed.upstream;
        baseCommit = unpushed.mergeBase.slice(0, 10);
      }
    }
  }

  const files = new Map<string, ChangedFile>();
  // Staged changes in a repository without commits yet: everything in the index is new.
  const against = options.index ? ['--cached', ...(target ? [target] : [])] : target ? [target, ...(options.committed ? ['HEAD'] : [])] : undefined;
  if (against) await diffFiles(root, fileIds, against, files);

  // Untracked files are brand new (but not part of what is staged or committed). Before the first commit
  // the tracked files are new too: `test`, `pr` and `status` then see what `check` sees — every file.
  const newFiles: [string, ChangeStatus][] = [];
  if (!options.index && !options.committed) {
    const [untracked, tracked] = await Promise.all([
      git(root, ['ls-files', '-z', '--others', '--exclude-standard']),
      hasHead ? undefined : git(root, ['ls-files', '-z']),
    ]);
    for (const id of (tracked ?? '').split('\0').filter(Boolean)) newFiles.push([id, 'added']);
    for (const id of (untracked ?? '').split('\0').filter(Boolean)) newFiles.push([id, 'untracked']);
  }
  for (const [id, status] of newFiles) {
    if (files.has(id)) continue;
    let text = options.fileText?.(id);
    if (text === undefined) {
      try {
        const abs = path.join(root, id);
        if (fs.statSync(abs).size < 1_000_000) text = fs.readFileSync(abs, 'utf8');
      } catch {
        /* unreadable — leave the count at 0 */
      }
    }
    const count = text ? text.replace(/\n$/, '').split('\n').length : 0;
    const lines = count ? Array.from({ length: Math.min(count, 5000) }, (_, i) => i + 1) : [];
    files.set(id, {
      id,
      status,
      additions: count,
      deletions: 0,
      lines,
      added: lines,
      analyzed: fileIds.has(id),
    });
  }

  let commits: CommitInfo[] = [];
  if (mode === 'branch' && target) {
    const log = await git(root, ['log', '--no-merges', '--relative', '--no-renames', '--numstat', LOG_FORMAT, `${target}..HEAD`, '--', '.']);
    const parsed = parseLog(log ?? '', fileIds);
    canonicalizeAuthors(parsed);
    commits = parsed.slice(0, 200).map(({ allPaths: _all, email: _email, rawEmail: _raw, ...c }) => c);
  }
  const list = [...files.values()].sort((a, b) => Number(b.analyzed) - Number(a.analyzed) || a.id.localeCompare(b.id)).slice(0, 2000);
  return { mode, base, baseCommit, files: list, commits };
}

/* -------------------------------------------------------------------------- */
/*                         Tree identity (test-intelligence)                  */
/* -------------------------------------------------------------------------- */

/**
 * A hash of the whole working tree as it is now — tracked edits, staged changes and untracked
 * (non-ignored) files: the tree `git add -A && git write-tree` would produce, computed in a temporary
 * copy of the index so the real index is never touched. The same content always gives the same id
 * (unlike `git stash create`, whose commit hash includes the time), so a test run can be matched with
 * the tree it tested. Undefined outside a git repository.
 */
export async function workingTreeId(root: string): Promise<string | undefined> {
  const [top, indexPath] = await Promise.all([git(root, ['rev-parse', '--show-toplevel']), git(root, ['rev-parse', '--git-path', 'index'])]);
  const topLevel = top?.trim();
  if (!topLevel) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-tree-'));
  const tmpIndex = path.join(dir, 'index');
  try {
    // Starting from a copy of the real index keeps its stat data: only changed files are hashed again.
    const real = indexPath?.trim() && path.resolve(root, indexPath.trim());
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const run = (args: string[]): Promise<string> =>
      execFileAsync('git', ['-c', 'core.quotePath=false', ...args], { cwd: topLevel, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true }).then((r) => r.stdout);
    await run(['add', '-A', '--', '.']);
    return (await run(['write-tree'])).trim() || undefined;
  } catch {
    return (await git(root, ['rev-parse', 'HEAD^{tree}']))?.trim() || undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Snapshots                                 */
/* -------------------------------------------------------------------------- */

/** Full hash of the commit a ref points to (undefined when it does not exist or looks like an option). */
export async function resolveCommit(root: string, ref: string): Promise<string | undefined> {
  if (!ref || ref.startsWith('-')) return undefined;
  const out = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out?.trim() || undefined;
}

/**
 * Read many blobs with a single `git cat-file --batch` process. Specs are object names:
 * `<commit>:<path>`, `:<path>` (the index) or blob hashes. Specs that are missing (or are not blobs,
 * e.g. submodules) are absent from the result.
 */
export function catFileBatch(root: string, specs: string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(specs)].filter((s) => s && !/[\r\n]/.test(s));
  if (!unique.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`git cat-file failed: ${stderr.trim() || `exit code ${code}`}`));
      resolve(parseCatFileBatch(Buffer.concat(chunks), unique));
    });
    child.stdin.on('error', () => undefined); // EPIPE when git exits early; reported through 'close'
    child.stdin.end(`${unique.join('\n')}\n`);
  });
}

/** Parse `<sha> <type> <size>\n<content>\n` records (or `<spec> missing\n`) in the order of `specs`. */
function parseCatFileBatch(out: Buffer, specs: string[]): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let pos = 0;
  for (const spec of specs) {
    const newline = out.indexOf(0x0a, pos);
    if (newline === -1) break;
    const header = out.toString('utf8', pos, newline);
    pos = newline + 1;
    const m = header.match(/^[0-9a-f]{40,64} ([a-z]+) (\d+)$/);
    if (!m) continue; // "<spec> missing" / "<spec> ambiguous": no content follows
    const size = Number(m[2]);
    if (m[1] === 'blob') result.set(spec, out.subarray(pos, pos + size));
    pos += size + 1;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/*                                    Blame                                   */
/* -------------------------------------------------------------------------- */

export interface BlameRange {
  start: number;
  end: number;
  author: string;
  date: number;
  hash: string;
  subject: string;
}

/** Line authorship of one file, merged into ranges (used by the live server on demand). */
export async function blameFile(root: string, fileId: string): Promise<BlameRange[] | undefined> {
  const out = await git(root, ['blame', '--line-porcelain', '-w', '--', fileId]);
  if (!out) return undefined;
  const ranges: BlameRange[] = [];
  const meta = new Map<string, { author: string; date: number; subject: string }>();
  let current: { hash: string; line: number } | undefined;
  let author = '';
  let date = 0;
  let subject = '';
  for (const line of out.split('\n')) {
    const head = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (head) {
      current = { hash: head[1], line: Number(head[2]) };
      const known = meta.get(head[1]);
      if (known) ({ author, date, subject } = known);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('author-time ')) date = Number(line.slice(12)) * 1000;
    else if (line.startsWith('summary ')) subject = line.slice(8);
    else if (line.startsWith('\t')) {
      meta.set(current.hash, { author, date, subject });
      const last = ranges[ranges.length - 1];
      const hash = current.hash.startsWith('0000000') ? 'uncommitted' : current.hash.slice(0, 10);
      if (last && last.hash === hash && last.end === current.line - 1) last.end = current.line;
      else ranges.push({ start: current.line, end: current.line, author: hash === 'uncommitted' ? 'You (uncommitted)' : author, date, hash, subject });
      current = undefined;
    }
  }
  return ranges;
}

export type { CommitRef };
