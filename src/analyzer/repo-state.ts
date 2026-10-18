/**
 * Reading a repository's state straight from `.git` — no git process — for status lines that run on
 * every prompt: where the repository is, what HEAD and a ref point to, and when the index changed.
 * Handles linked worktrees (`.git` files and `commondir`) and packed refs.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RepoLocation {
  /** Top-level folder of the working tree. */
  top: string;
  /** The git directory of this working tree (`.git`, or `.git/worktrees/<name>` for linked worktrees). */
  gitDir: string;
  /** Where refs, objects and packed-refs live (the main `.git` for linked worktrees). */
  commonDir: string;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The repository `dir` belongs to (walking up), or undefined outside one. */
export function findRepo(dir: string): RepoLocation | undefined {
  for (let current = path.resolve(dir); ; ) {
    const dotGit = path.join(current, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return { top: current, gitDir: dotGit, commonDir: commonDirOf(dotGit) };
    if (stat?.isFile()) {
      // Linked worktree or submodule: "gitdir: <path>".
      const target = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '')?.[1];
      if (target) {
        const gitDir = path.resolve(current, target);
        return { top: current, gitDir, commonDir: commonDirOf(gitDir) };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function commonDirOf(gitDir: string): string {
  const common = readText(path.join(gitDir, 'commondir'))?.trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

/** The commit a full ref name (`refs/heads/main`) points to: a loose ref file, else packed-refs. */
export function readRef(repo: RepoLocation, ref: string): string | undefined {
  for (const dir of ref.startsWith('refs/heads/') || ref.startsWith('refs/remotes/') || ref.startsWith('refs/tags/') ? [repo.commonDir, repo.gitDir] : [repo.gitDir, repo.commonDir]) {
    const loose = readText(path.join(dir, ref))?.trim();
    if (loose && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
    if (loose?.startsWith('ref: ')) return readRef(repo, loose.slice(5).trim());
  }
  const packed = readText(path.join(repo.commonDir, 'packed-refs'));
  if (!packed) return undefined;
  for (const line of packed.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0 && line.slice(space + 1).trim() === ref && /^[0-9a-f]{40,64}$/.test(line.slice(0, space))) return line.slice(0, space);
  }
  return undefined;
}

/**
 * What HEAD points to: the commit hash, or `ref:<name>` for a branch without commits yet. Undefined when
 * HEAD cannot be read.
 */
export function readHead(repo: RepoLocation): string | undefined {
  const head = readText(path.join(repo.gitDir, 'HEAD'))?.trim();
  if (!head) return undefined;
  if (!head.startsWith('ref: ')) return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
  const ref = head.slice(5).trim();
  return readRef(repo, ref) ?? `ref:${ref}`;
}

/** The commit a short name points to, the way git resolves it (`main`, `origin/main`, `refs/…`). */
export function resolveShortRef(repo: RepoLocation, name: string): string | undefined {
  const candidates = name.startsWith('refs/') ? [name] : [`refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`];
  for (const ref of candidates) {
    const hit = readRef(repo, ref);
    if (hit) return hit;
  }
  return undefined;
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** When the index (staging area) last changed; undefined without one. */
export function indexMtime(repo: RepoLocation): number | undefined {
  return mtime(path.join(repo.gitDir, 'index'));
}

/**
 * When the remote of `base` was last fetched: FETCH_HEAD, or the remote-tracking ref itself (a fresh clone
 * has no FETCH_HEAD). Undefined for local bases and when nothing was ever fetched.
 */
export function lastFetch(repo: RepoLocation, base: string): number | undefined {
  const remoteRef = base.startsWith('refs/remotes/') ? base : `refs/remotes/${base}`;
  const times = [mtime(path.join(repo.gitDir, 'FETCH_HEAD')), mtime(path.join(repo.commonDir, 'FETCH_HEAD')), mtime(path.join(repo.commonDir, remoteRef))].filter((t): t is number => t !== undefined);
  if (!times.length && readRef(repo, remoteRef)) {
    const packed = mtime(path.join(repo.commonDir, 'packed-refs'));
    if (packed !== undefined) times.push(packed);
  }
  return times.length ? Math.max(...times) : undefined;
}

/**
 * Whether git tracks `rel` (relative to the repository top, '/'-separated). Index versions 2 and 3 are read
 * directly (a status line has no time for a git process); index v4 and split indexes ask git.
 */
export function gitTracks(repo: RepoLocation, rel: string): boolean {
  const askGit = (): boolean => spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: repo.top, stdio: 'ignore', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).status === 0;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(path.join(repo.gitDir, 'index'));
  } catch {
    return false;
  }
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') return false;
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return askGit();
  const target = Buffer.from(rel, 'utf8');
  // Names are stored whole in these versions: a path that appears nowhere is not tracked (the common case),
  // unless a split index keeps it in its shared part.
  if (buf.indexOf(target) === -1) {
    let split = false;
    try {
      split = fs.readdirSync(repo.gitDir).some((f) => f.startsWith('sharedindex.'));
    } catch {
      /* unreadable: no split index */
    }
    return split ? askGit() : false;
  }
  const count = buf.readUInt32BE(8);
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off + 62 > buf.length) return askGit();
    // 62 bytes of stat data, hash and flags; v3 entries may add 2 bytes of extended flags; then the NUL-padded name.
    const flags = buf.readUInt16BE(off + 60);
    const nameStart = off + 62 + (version === 3 && flags & 0x4000 ? 2 : 0);
    const nameLen = flags & 0x0fff;
    const nameEnd = nameLen < 0x0fff ? nameStart + nameLen : buf.indexOf(0, nameStart);
    if (nameEnd < nameStart || nameEnd > buf.length) return askGit();
    if (nameEnd - nameStart === target.length && buf.compare(target, 0, target.length, nameStart, nameEnd) === 0) return true;
    off += Math.floor((nameEnd - off + 8) / 8) * 8;
  }
  // A split index keeps most entries in a shared file ("link" extension).
  for (let ext = off; ext + 8 <= buf.length - 20; ext += 8 + buf.readUInt32BE(ext + 4)) {
    if (buf.toString('latin1', ext, ext + 4) === 'link') return askGit();
  }
  return false;
}
