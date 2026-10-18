import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerInfo } from '../shared/types.js';
import { ensureStateDir } from './health.js';
import { gitTracks, type RepoLocation } from './repo-state.js';

/**
 * Per-repository state in `.code-visualizer/` (git-ignored by its own .gitignore).
 *
 * `state.json` holds small sections owned by individual features (`lastCheck`, `lastTest`,
 * `status`, `sync`, `lastVisit`…). Features only touch their own section through
 * `readState` / `updateState`; this module never needs to know about them.
 */

export function stateDir(root: string): string {
  return path.join(path.resolve(root), '.code-visualizer');
}

export function statePath(root: string): string {
  return path.join(stateDir(root), 'state.json');
}

/** Write a file via a temporary file + rename, so readers never see a half-written file. */
export function writeFileAtomic(file: string, data: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** All sections of `.code-visualizer/state.json` (empty when missing or unreadable). */
export function readAllState(root: string): Record<string, unknown> {
  return readJsonObject(statePath(root)) ?? {};
}

export function readState<T = unknown>(root: string, section: string): T | undefined {
  return readAllState(root)[section] as T | undefined;
}

/** A lock older than this belongs to a crashed process (updates take milliseconds). */
const STALE_LOCK_MS = 1_000;
/** How long an update waits for the lock before writing anyway (state is best effort). */
const LOCK_WAIT_MS = 1_500;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding `<file>.lock` (O_EXCL), so that git hooks, status lines and commands that
 * update different sections at the same moment do not overwrite each other.
 */
function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break; // cannot lock here: write unlocked
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (Date.now() > deadline) break;
      sleepSync(2 + Math.random() * 8);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }
}

/**
 * Replace one section of `.code-visualizer/state.json` (atomically, under a lock file so concurrent
 * writers of other sections are not lost). Pass a function to update the previous value, or
 * `undefined` to remove the section.
 */
export function updateState<T = unknown>(root: string, section: string, value: T | undefined | ((prev: T | undefined) => T | undefined)): void {
  ensureStateDir(stateDir(root));
  withFileLock(statePath(root), () => {
    const all = readAllState(root);
    const next = typeof value === 'function' ? (value as (prev: T | undefined) => T | undefined)(all[section] as T | undefined) : value;
    if (next === undefined) delete all[section];
    else all[section] = next;
    writeFileAtomic(statePath(root), `${JSON.stringify(all, null, 2)}\n`);
  });
}

/* -------------------------------------------------------------------------- */
/*                        Running server (server.json)                        */
/* -------------------------------------------------------------------------- */

export function serverInfoPath(root: string): string {
  return path.join(stateDir(root), 'server.json');
}

/**
 * Only a registration written by `serve` for this user is trusted: private (0600) and owned by the
 * current user. A server.json that came with the repository (committed, archived) is ignored, so it
 * can neither point commands at another host nor feed them made-up data.
 */
function privateFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
    return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** The registered server for this root, if the file exists, is private and looks valid (it may be stale). */
export function readServerInfo(root: string): ServerInfo | undefined {
  const file = serverInfoPath(root);
  if (!privateFile(file)) return undefined;
  const info = readJsonObject(file) as Partial<ServerInfo> | undefined;
  if (!info) return undefined;
  const valid =
    Number.isInteger(info.pid) &&
    Number.isInteger(info.port) &&
    typeof info.host === 'string' &&
    typeof info.token === 'string' &&
    typeof info.root === 'string' &&
    typeof info.version === 'string';
  return valid ? (info as ServerInfo) : undefined;
}

/** Register a server (mode 0600: the file contains the API token). */
export function writeServerInfo(root: string, info: ServerInfo): void {
  ensureStateDir(stateDir(root));
  writeFileAtomic(serverInfoPath(root), `${JSON.stringify(info, null, 2)}\n`, 0o600);
}

/** Remove the registration; with `token`, only when it still belongs to that server. */
export function removeServerInfo(root: string, token?: string): void {
  try {
    if (token !== undefined && readServerInfo(root)?.token !== token) return;
    fs.rmSync(serverInfoPath(root), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Why `.code-visualizer/state.json` cannot be believed, if it cannot: it came with the repository (git
 * tracks it, or the folder is a link) or someone else wrote it. Like `server.json`, it would otherwise feed
 * the status line made-up text.
 */
export function untrustedState(root: string, repo: RepoLocation): string | undefined {
  const file = statePath(root);
  let stat: fs.Stats;
  try {
    if (fs.lstatSync(stateDir(root)).isSymbolicLink()) return '.code-visualizer is a link';
    stat = fs.lstatSync(file);
  } catch {
    return undefined; // no state yet
  }
  if (!stat.isFile()) return '.code-visualizer/state.json is not a regular file';
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) return '.code-visualizer/state.json belongs to another user';
  const rel = path.relative(repo.top, file).split(path.sep).join('/');
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && gitTracks(repo, rel)) return '.code-visualizer/state.json is tracked by git';
  return undefined;
}
