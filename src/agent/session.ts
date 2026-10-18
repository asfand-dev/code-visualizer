/**
 * Agent sessions: `.code-visualizer/sessions/<id>.json` records the project as an agent session found it
 * (HEAD, the files that already differed from it, the findings it already had, export signatures), so
 * the post-edit radar and the stop gate report only what the session changed. Also keeps the original
 * text of every file the session edits, the "before" side of the post-edit comparison.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../analyzer/git.js';
import { ensureStateDir } from '../analyzer/health.js';
import { stateDir, writeFileAtomic } from '../analyzer/state.js';
import type { AgentSession } from '../shared/types.js';

/** Sessions kept on disk (newest first); older ones and ones untouched for two weeks are removed. */
const KEEP_SESSIONS = 30;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
/** Files above this size are not kept as originals (the comparison then uses the recorded signatures). */
const MAX_ORIGINAL_BYTES = 1_000_000;

export function sessionsDir(root: string): string {
  return path.join(stateDir(root), 'sessions');
}

/** A file name for any session id the client sends (ids with other characters are hashed). */
export function sessionFile(root: string, id: string): string {
  const safe = /^[A-Za-z0-9._-]{1,100}$/.test(id) && !id.startsWith('.') ? id : crypto.createHash('sha1').update(id).digest('hex');
  return path.join(sessionsDir(root), `${safe}.json`);
}

/** A commit hash as the session records it (anything else — `--output=…` — is never passed to git). */
export const isCommitHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);

/**
 * The session, when its file is one this user wrote: a regular file (not a link), owned by them, mode 0600
 * — checked on the opened file itself. One that came with the repository or from someone else could steer
 * what the hooks run git with.
 */
export function readSession(root: string, id: string): AgentSession | undefined {
  let fd: number | undefined;
  try {
    // Not through a link, and never blocking on a FIFO someone placed there.
    fd = fs.openSync(sessionFile(root, id), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) return undefined;
    const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as AgentSession;
    if (!value || typeof value !== 'object' || !Array.isArray(value.fingerprints)) return undefined;
    // A head that is not a commit hash is dropped (the session then compares with HEAD).
    if (value.head !== undefined && !isCommitHash(value.head)) delete value.head;
    return value;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Write a session (private: it holds file texts). */
export function writeSession(root: string, session: AgentSession): void {
  ensureStateDir(stateDir(root));
  writeFileAtomic(sessionFile(root, session.id), `${JSON.stringify(session)}\n`, 0o600);
}

/** Remove sessions beyond the newest KEEP_SESSIONS and those untouched for two weeks. */
export function pruneSessions(root: string, now = Date.now()): void {
  const dir = sessionsDir(root);
  let entries: { file: string; mtime: number }[];
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return;
  }
  entries.forEach((e, i) => {
    if (i >= KEEP_SESSIONS || now - e.mtime > MAX_AGE_MS) fs.rmSync(e.file, { force: true });
  });
}

/* -------------------------------------------------------------------------- */
/*                                     Git                                    */
/* -------------------------------------------------------------------------- */

/** `mtimeMs:size` of a file ('-' when it does not exist): tells whether a file changed since. */
export function fileSignature(abs: string): string {
  try {
    const st = fs.statSync(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

const splitZ = (out: string | undefined): string[] => (out ?? '').split('\0').filter(Boolean);

/**
 * Files below `root` that differ from HEAD — tracked edits (staged or not), deletions and untracked
 * files — as project-relative paths. Empty outside a repository.
 */
export async function changedFiles(root: string, since = 'HEAD'): Promise<string[]> {
  if (since !== 'HEAD' && !isCommitHash(since)) return [];
  const [tracked, untracked] = await Promise.all([
    // --end-of-options: `since` is a revision, never an option (git ≥ 2.24).
    git(root, ['diff', '--name-only', '-z', '--relative', '--end-of-options', since, '--']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  return [...new Set([...splitZ(tracked), ...splitZ(untracked)])].sort();
}

export async function headCommit(root: string): Promise<string | undefined> {
  return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() || undefined;
}

export async function currentBranch(root: string): Promise<string | undefined> {
  const name = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  return name && name !== 'HEAD' ? name : undefined;
}

/** The text of a project file at a commit: null when the file is not in it, undefined when git cannot tell. */
export async function textAt(root: string, commit: string, file: string): Promise<string | null | undefined> {
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return undefined;
  const exists = await git(root, ['cat-file', '-e', `${commit}:./${file}`]);
  if (exists === undefined) {
    // Either the file is not in the commit, or the commit is gone (gc'd, another clone).
    return (await git(root, ['cat-file', '-e', `${commit}^{commit}`])) === undefined ? undefined : null;
  }
  return (await git(root, ['show', `${commit}:./${file}`])) ?? undefined;
}

/** The state an agent session starts from (without the analysis part, which the caller adds). */
export async function startState(root: string): Promise<Pick<AgentSession, 'head' | 'branch' | 'dirty'>> {
  const [head, branch, files] = await Promise.all([headCommit(root), currentBranch(root), changedFiles(root)]);
  const dirty: Record<string, string> = {};
  for (const f of files) dirty[f] = fileSignature(path.join(root, f));
  return { ...(head ? { head } : {}), ...(branch ? { branch } : {}), dirty };
}

/**
 * Files the session changed: those that differ from the HEAD it started at (committed since, edited or
 * new) and are not exactly as they already were when it started, plus files it edited through hooks
 * whose text is no longer what it found.
 */
export async function changedSinceStart(root: string, session: AgentSession | undefined): Promise<string[]> {
  if (!session) return changedFiles(root);
  const head = await headCommit(root);
  const now = new Set(await changedFiles(root));
  if (isCommitHash(session.head) && head && head !== session.head) for (const f of await changedFiles(root, session.head)) now.add(f);
  const dirty = session.dirty ?? {};
  const result = new Set<string>();
  for (const f of now) if (dirty[f] === undefined || dirty[f] !== fileSignature(path.join(root, f))) result.add(f);
  // Edits git does not show (an ignored folder, no repository): files whose text is not what the session found.
  for (const [f, text] of Object.entries(session.originals ?? {})) if (diskText(root, f) !== text) result.add(f);
  return [...result].sort();
}

/** The text of a project file now (null: it does not exist). */
export function diskText(root: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}

/** Remember a file's text before the session's first edit of it (no-op when it is known or too large). */
export function rememberOriginal(session: AgentSession, file: string, text: string | null): boolean {
  const originals = (session.originals ??= {});
  if (Object.hasOwn(originals, file)) return false;
  if (text !== null && text.length > MAX_ORIGINAL_BYTES) return false;
  originals[file] = text;
  return true;
}
