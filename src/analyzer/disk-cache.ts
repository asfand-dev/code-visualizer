import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { SCHEMA_VERSION } from '../shared/types.js';
import { VERSION } from '../version.js';
import type { GitAnalysis } from './git.js';
import { ensureStateDir } from './health.js';
import type { AnalyzeCache } from './index.js';
import type { ParsedFile } from './parse.js';
import { stateDir, writeFileAtomic } from './state.js';

/**
 * Persistent parse / git index in `.code-visualizer/cache/` so that every CLI run, hook and
 * status line starts warm. Entries are reused when a file's mtime and size are unchanged, or
 * (after a checkout or a formatter touched it) when its content hash still matches.
 *
 * Cache files are signed with a per-user secret kept outside the project (see `cacheStamp`), so a
 * cache that arrives with the repository (committed, archived, copied from another machine) is
 * never trusted: it could otherwise describe "clean" code and hide what `check` should report.
 */

const FORMAT = 1;
/** Caches larger than this are neither written nor read (uncompressed JSON). */
const MAX_BYTES = 200 * 1024 * 1024;
/** Git analyses kept on disk (one per HEAD; switching branches back and forth stays warm). */
const KEEP_GIT = 3;
/** Parse caches kept: the current one plus the newest of another tool version (e.g. global vs local install). */
const KEEP_PARSE = 2;

export function cacheDir(root: string): string {
  return path.join(stateDir(root), 'cache');
}

/** Analyses of other commits kept by `snapshotAt` (compare-engine, src/analyzer/overlay.ts). */
export function snapshotDir(root: string): string {
  return path.join(stateDir(root), 'snapshots');
}

let tsVersion: string | undefined;
/** Read from package.json, so callers that only inspect the cache never load the compiler. */
function typescriptVersion(): string {
  if (tsVersion === undefined) {
    try {
      tsVersion = (createRequire(import.meta.url)('typescript/package.json') as { version: string }).version;
    } catch {
      tsVersion = 'unknown';
    }
  }
  return tsVersion;
}

/** File name of the parse cache for this schema, tool and TypeScript version. */
export function parseCacheName(): string {
  return `parse-s${SCHEMA_VERSION}-${VERSION}-ts${typescriptVersion()}.json.gz`;
}

export function parseCachePath(root: string): string {
  return path.join(cacheDir(root), parseCacheName());
}

let stamp: string | undefined;
/**
 * Identifies the analyzer code that produced a cache: the bundle's build time in dist/, or the
 * newest analyzer source file when running from src/ (tests, tsx). Rebuilding or editing the
 * parser therefore invalidates caches even when the version number did not change.
 */
export function codeStamp(): string {
  if (stamp !== undefined) return stamp;
  try {
    const self = fileURLToPath(import.meta.url);
    if (/\.[cm]?ts$/.test(self)) {
      const dir = path.dirname(self);
      let newest = 0;
      for (const name of fs.readdirSync(dir)) if (/\.[cm]?ts$/.test(name)) newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
      stamp = `src-${Math.floor(newest)}`;
    } else {
      stamp = `dist-${Math.floor(fs.statSync(self).mtimeMs)}`;
    }
  } catch {
    stamp = 'unknown';
  }
  return stamp;
}

const SECRET_BYTES = 32;
let secret: { dir: string; value: string | undefined } | undefined;

/** True when `stat` belongs to the current user and nobody else can read or write it (POSIX only). */
function privateToUser(stat: fs.Stats): boolean {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
  return stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
}

/**
 * Directory of the per-user cache secret: a private folder in the OS temp dir, so it is never part
 * of a project and never in the user's config folders. When the OS clears it (reboot, cleanup), the
 * next run of each project is simply cold.
 */
export function secretDir(): string {
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(os.tmpdir(), `code-visualizer-${user}`);
}

/** The per-user secret, created on first use; undefined when it cannot be kept private. */
function userSecret(): string | undefined {
  const dir = secretDir();
  if (secret?.dir === dir) return secret.value;
  let value: string | undefined;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isDirectory() && privateToUser(dirStat)) {
      const file = path.join(dir, 'cache-key');
      value = readSecret(file);
      if (value === undefined) {
        // Write the whole key under a temporary name, then link it into place: concurrent first
        // runs agree on one key (the loser of the race reads the winner's).
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, crypto.randomBytes(SECRET_BYTES).toString('hex'), { mode: 0o600, flag: 'wx' });
        try {
          fs.linkSync(tmp, file);
        } catch {
          /* another process won */
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        value = readSecret(file);
      }
    }
  } catch {
    value = undefined;
  }
  secret = { dir, value };
  return value;
}

function readSecret(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || !privateToUser(stat)) return undefined;
    const value = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a cache file must carry to be used: the analyzer code stamp, signed with the per-user
 * secret. Undefined when there is no usable secret; caches are then neither read nor written.
 */
export function cacheStamp(): string | undefined {
  const key = userSecret();
  return key === undefined ? undefined : crypto.createHmac('sha256', key).update(codeStamp()).digest('hex').slice(0, 40);
}

/* -------------------------------------------------------------------------- */
/*                         JSON with Map and Set values                        */
/* -------------------------------------------------------------------------- */

/**
 * JSON.stringify that keeps Map (`{"$m":[[k,v]…]}`) and Set (`{"$s":[…]}`) values, and the token arrays of
 * clone detection as base64: Uint8Array as bytes (`{"$u8":"…"}`), Uint32Array as varint deltas
 * (`{"$u32d":"…"}`: the token lines mostly repeat or grow by one, so one byte per token instead of four).
 */
export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Map) return { $m: [...v] };
    if (v instanceof Set) return { $s: [...v] };
    if (v instanceof Uint8Array) return { $u8: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
    if (v instanceof Uint32Array) return { $u32d: packDeltas(v) };
    return v;
  });
}

/** The length, then each value's difference from the previous one (zigzag), as base64 varints. */
function packDeltas(values: Uint32Array): string {
  const out = new Uint8Array(values.length * 6 + 6);
  let at = 0;
  const put = (n: number): void => {
    while (n >= 0x80) {
      out[at++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    out[at++] = n;
  };
  put(values.length);
  let prev = 0;
  for (const v of values) {
    const d = v - prev;
    prev = v;
    put(d >= 0 ? d * 2 : -d * 2 - 1);
  }
  return Buffer.from(out.buffer, 0, at).toString('base64');
}

/** The inverse of `packDeltas`. */
function unpackDeltas(base64: string): Uint32Array {
  const bytes = Buffer.from(base64, 'base64');
  let at = 0;
  const get = (): number => {
    let n = 0;
    let scale = 1;
    let byte: number;
    do {
      byte = bytes[at++] ?? 0;
      n += (byte & 0x7f) * scale;
      scale *= 0x80;
    } while (byte & 0x80);
    return n;
  };
  const values = new Uint32Array(Math.min(get(), bytes.length));
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const z = get();
    prev += z % 2 ? -(z + 1) / 2 : z / 2;
    values[i] = prev;
  }
  return values;
}

/** A typed array from base64 (copied into its own, aligned buffer). */
function typedArray<T extends Uint8Array | Uint32Array>(base64: string, Type: { new (buffer: ArrayBuffer): T; BYTES_PER_ELEMENT: number }): T {
  const bytes = Buffer.from(base64, 'base64');
  const buffer = new ArrayBuffer(bytes.length - (bytes.length % Type.BYTES_PER_ELEMENT));
  new Uint8Array(buffer).set(bytes.subarray(0, buffer.byteLength));
  return new Type(buffer);
}

/** The inverse of `serialize`. */
export function deserialize<T = unknown>(text: string): T {
  // A walk after a plain JSON.parse is ~5x faster than a JSON.parse reviver on large caches.
  return revive(JSON.parse(text)) as T;
}

function revive(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i] as unknown;
      if (v !== null && typeof v === 'object') value[i] = revive(v);
    }
    return value;
  }
  const o = value as Record<string, unknown>;
  if (Array.isArray(o.$m) && Object.keys(o).length === 1) return new Map((o.$m as [unknown, unknown][]).map(([k, v]) => [revive(k), revive(v)]));
  if (Array.isArray(o.$s) && Object.keys(o).length === 1) return new Set((o.$s as unknown[]).map(revive));
  if (typeof o.$u8 === 'string' && Object.keys(o).length === 1) return typedArray(o.$u8, Uint8Array);
  if (typeof o.$u32d === 'string' && Object.keys(o).length === 1) return unpackDeltas(o.$u32d);
  if (typeof o.$u32 === 'string' && Object.keys(o).length === 1) return typedArray(o.$u32, Uint32Array);
  for (const key in o) {
    const v = o[key];
    if (v === null || typeof v !== 'object') continue;
    const r = revive(v);
    if (r !== v) Object.defineProperty(o, key, { value: r, writable: true, enumerable: true, configurable: true });
  }
  return o;
}

function readGz<T>(file: string): T | undefined {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return undefined;
    return deserialize<T>(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_BYTES }).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Serialize and write atomically; false when the payload is too large or the folder is not writable. */
function writeGz(file: string, payload: unknown): boolean {
  try {
    const json = serialize(payload);
    if (json.length > MAX_BYTES) return false;
    ensureStateDir(path.dirname(path.dirname(file)));
    writeFileAtomic(file, zlib.gzipSync(json, { level: 1 }), 0o600);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                Parse cache                                 */
/* -------------------------------------------------------------------------- */

type ParseEntry = [id: string, mtimeMs: number, size: number, hash: string, parsed: ParsedFile];

interface ParsePayload {
  format: number;
  stamp: string;
  savedAt: number;
  files: ParseEntry[];
}

const isEntry = (e: unknown): e is ParseEntry =>
  Array.isArray(e) &&
  typeof e[0] === 'string' &&
  typeof e[1] === 'number' &&
  typeof e[2] === 'number' &&
  typeof e[3] === 'string' &&
  !!e[4] &&
  Array.isArray((e[4] as ParsedFile).symbols) &&
  (e[4] as ParsedFile).facts instanceof Map;

/**
 * Fill `cache` from `.code-visualizer/cache/parse-….json.gz`. Returns false (and leaves the cache
 * untouched) when there is no usable cache: missing, corrupt, too large or written by other code.
 */
export function loadDiskCache(root: string, cache: AnalyzeCache): boolean {
  const stamp = cacheStamp();
  if (stamp === undefined) return false;
  const payload = readGz<ParsePayload>(parseCachePath(root));
  if (!payload || payload.format !== FORMAT || payload.stamp !== stamp || !Array.isArray(payload.files)) return false;
  if (!payload.files.every(isEntry)) return false;
  for (const [id, mtimeMs, size, hash, parsed] of payload.files) cache.files.set(id, { mtimeMs, size, hash, parsed });
  cache.origin = 'disk';
  return true;
}

/** Write the parse results (never the file texts) and drop older caches of other tool versions. */
export function saveDiskCache(root: string, cache: AnalyzeCache): boolean {
  const stamp = cacheStamp();
  if (stamp === undefined) return false;
  const payload: ParsePayload = {
    format: FORMAT,
    stamp,
    savedAt: Date.now(),
    files: [...cache.files].map(([id, e]) => [id, e.mtimeMs, e.size, e.hash, e.parsed]),
  };
  const name = parseCacheName();
  if (!writeGz(path.join(cacheDir(root), name), payload)) return false;
  cache.dirty = false;
  const others = listCacheFiles(root)
    .filter((f) => f.kind === 'parse' && f.name !== name)
    .sort((a, b) => b.modified - a.modified);
  for (const f of others.slice(KEEP_PARSE - 1)) removeQuietly(path.join(cacheDir(root), f.name));
  return true;
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* another process may hold it open (Windows) */
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Git cache                                  */
/* -------------------------------------------------------------------------- */

interface GitPayload {
  format: number;
  stamp: string;
  key: string;
  result: GitAnalysis;
}

const gitFile = (root: string, head: string): string | undefined => (/^([0-9a-f]{7,64}|none)$/.test(head) ? path.join(cacheDir(root), `git-${head}.json.gz`) : undefined);

/** The persisted git analysis for `head`, when it was computed for the same key (HEAD, upstream, day, files). */
export function loadGitCache(root: string, head: string, key: string): GitAnalysis | undefined {
  const file = gitFile(root, head);
  const stamp = cacheStamp();
  const payload = file && stamp !== undefined ? readGz<GitPayload>(file) : undefined;
  if (!payload || payload.format !== FORMAT || payload.stamp !== stamp || payload.key !== key) return undefined;
  return payload.result?.files instanceof Map ? payload.result : undefined;
}

export function saveGitCache(root: string, head: string, key: string, result: GitAnalysis): boolean {
  const file = gitFile(root, head);
  const stamp = cacheStamp();
  if (!file || stamp === undefined || !writeGz(file, { format: FORMAT, stamp, key, result } satisfies GitPayload)) return false;
  const old = listCacheFiles(root)
    .filter((f) => f.kind === 'git')
    .sort((a, b) => b.modified - a.modified)
    .slice(KEEP_GIT);
  for (const f of old) removeQuietly(path.join(cacheDir(root), f.name));
  return true;
}

/* -------------------------------------------------------------------------- */
/*                              Status and clear                              */
/* -------------------------------------------------------------------------- */

export interface CacheFileInfo {
  /** File name in `.code-visualizer/cache/`, or `snapshots/<commit>.json.gz`. */
  name: string;
  kind: 'parse' | 'git' | 'snapshot' | 'other';
  bytes: number;
  modified: number;
}

function filesIn(dir: string): { name: string; stat: fs.Stats }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; stat: fs.Stats }[] = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) out.push({ name, stat });
    } catch {
      /* removed meanwhile */
    }
  }
  return out;
}

export function listCacheFiles(root: string): CacheFileInfo[] {
  const out: CacheFileInfo[] = [];
  for (const { name, stat } of filesIn(cacheDir(root))) {
    const kind = /^parse-.*\.json\.gz$/.test(name) ? 'parse' : /^git-.*\.json\.gz$/.test(name) ? 'git' : 'other';
    out.push({ name, kind, bytes: stat.size, modified: stat.mtimeMs });
  }
  for (const { name, stat } of filesIn(snapshotDir(root))) {
    if (name.endsWith('.json.gz')) out.push({ name: `snapshots/${name}`, kind: 'snapshot', bytes: stat.size, modified: stat.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DiskCacheStatus {
  dir: string;
  totalBytes: number;
  files: (CacheFileInfo & { current?: boolean; entries?: number; savedAt?: number; head?: string })[];
}

/** What is in `.code-visualizer/cache/` (reads the current parse cache to count its entries). */
export function diskCacheStatus(root: string): DiskCacheStatus {
  const current = parseCacheName();
  const order = { parse: 0, git: 1, snapshot: 2, other: 3 };
  const listed = listCacheFiles(root).sort((a, b) => order[a.kind] - order[b.kind] || b.modified - a.modified);
  const files: DiskCacheStatus['files'] = listed.map((f) => {
    if (f.kind === 'git') return { ...f, head: f.name.slice(4, -8) };
    if (f.kind !== 'parse') return f;
    if (f.name !== current) return { ...f, current: false };
    const payload = readGz<ParsePayload>(path.join(cacheDir(root), f.name));
    const stamp = cacheStamp();
    const usable = !!payload && stamp !== undefined && payload.format === FORMAT && payload.stamp === stamp;
    return { ...f, current: usable, entries: Array.isArray(payload?.files) ? payload.files.length : undefined, savedAt: payload?.savedAt };
  });
  return { dir: cacheDir(root), totalBytes: files.reduce((n, f) => n + f.bytes, 0), files };
}

/** Delete `.code-visualizer/cache/` and the stored snapshots (history, notes and state are kept). */
export function clearDiskCache(root: string): { files: number; bytes: number } {
  const files = listCacheFiles(root);
  fs.rmSync(cacheDir(root), { recursive: true, force: true });
  fs.rmSync(snapshotDir(root), { recursive: true, force: true });
  return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}
