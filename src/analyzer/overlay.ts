/**
 * Overlays and the snapshot store behind `snapshotAt` (src/analyzer/snapshot.ts).
 *
 * An overlay holds only the files that differ between the working tree and another version (a git
 * ref or the staged index); everything else is read from disk, where it is identical by
 * construction. So a snapshot depends only on the commit and is cached per commit, in memory and in
 * `.code-visualizer/snapshots/`. The analysis itself is passed in (`run`), so `analyze()` can take a
 * snapshot of its base commit without a runtime import cycle.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ReportData, ReportSnapshot } from '../shared/types.js';
import { SCHEMA_VERSION } from '../shared/types.js';
import { VERSION } from '../version.js';
import { loadConfig, type LoadedConfig } from './config.js';
import { AnalyzeError } from './errors.js';
import { extOf } from './files.js';
import { catFileBatch, git, resolveCommit } from './git.js';
import { cacheStamp, snapshotDir } from './disk-cache.js';
import { ensureStateDir } from './health.js';
import type { AnalyzeCache, AnalyzeOptions } from './index.js';
import { SOURCE_EXTENSIONS } from './resolve.js';
import { stateDir, writeFileAtomic } from './state.js';

/** Project-relative path → text in the snapshot (`null` = the file does not exist there). */
export type Overlay = Record<string, string | null>;

export interface SnapshotOptions {
  /** Parse cache shared with other analyses: only files that differ from it are parsed again. */
  cache?: AnalyzeCache;
  /** Extra exclude globs (the snapshot's own config file is applied as well). */
  exclude?: string[];
  maxFiles?: number;
  toolVersion?: string;
  /** Read and write `.code-visualizer/snapshots/<commit>.json.gz` (default: true). */
  persist?: boolean;
}

const SOURCE_EXTS = new Set(SOURCE_EXTENSIONS);
/** Non-source files that change what the analysis sees. */
const MANIFEST_RE = /(^|\/)(package\.json|[tj]sconfig[^/]*\.json|code-visualizer\.config\.json|\.code-visualizerrc(\.json)?|CODEOWNERS|pnpm-workspace\.yaml|lerna\.json|index\.html)$/;
const CONFIG_NAMES = ['code-visualizer.config.json', '.code-visualizerrc.json', '.code-visualizerrc', 'package.json'];
const SNAPSHOT_FORMAT = 1;
const KEEP_ON_DISK = 20;
/** Stored snapshots larger than this (uncompressed) are not read. */
const MAX_STORED_BYTES = 200 * 1024 * 1024;
const MEMO_LIMIT = 6;

/** Whether a path matters for a snapshot: source files and the manifests / config the analyzer reads. */
export function isSnapshotPath(rel: string): boolean {
  return SOURCE_EXTS.has(extOf(rel)) || MANIFEST_RE.test(rel);
}

/* -------------------------------------------------------------------------- */
/*                                  Overlays                                  */
/* -------------------------------------------------------------------------- */

/** Which files differ from `against`: `null` for files that are not there, else the blob id to read. */
type OverlayPlan = Map<string, string | null>;

/**
 * The files whose content differs between the working tree and `against` (a commit; undefined = the
 * index): untracked files and files added since are `null`, the others name their `against` blob.
 */
async function planAgainst(root: string, against: string | undefined): Promise<OverlayPlan> {
  const [raw, untracked] = await Promise.all([
    // --raw: modes and full blob ids of the `against` side; -z: unquoted paths; --relative: paths below the root.
    git(root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--relative', ...(against ? [against] : []), '--', '.']),
    git(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']),
  ]);
  if (raw === undefined) throw new AnalyzeError(`${root} is not inside a git repository (or git is not installed).`);
  const plan: OverlayPlan = new Map();
  for (const rel of (untracked ?? '').split('\0')) if (rel && isSnapshotPath(rel)) plan.set(rel, null);
  // ":100644 100644 <old sha> <new sha> M\0path\0"
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++];
    if (!meta.startsWith(':')) continue;
    const rel = parts[i++];
    if (!rel || !isSnapshotPath(rel)) continue;
    const [mode, , blob, , status] = meta.slice(1).split(' ');
    if (status === 'U') continue; // unmerged: keep the working-tree view
    if (status === 'A' || /^0+$/.test(blob ?? '')) {
      plan.set(rel, null); // not in the snapshot
      continue;
    }
    // Submodules and symlinks keep the working-tree view.
    if (mode === '160000' || mode === '120000') continue;
    plan.set(rel, blob);
  }
  return plan;
}

const samePlan = (a: OverlayPlan, b: OverlayPlan): boolean => a.size === b.size && [...a].every(([rel, blob]) => b.has(rel) && b.get(rel) === blob);

/** Read the blobs of a plan with one `git cat-file --batch`. */
async function overlayFromPlan(root: string, plan: OverlayPlan): Promise<Overlay> {
  const overlay: Overlay = {};
  const blobs = await catFileBatch(root, [...plan.values()].filter((b): b is string => b !== null));
  for (const [rel, blob] of plan) {
    if (blob === null) overlay[rel] = null;
    else {
      const content = blobs.get(blob);
      if (content) overlay[rel] = content.toString('utf8');
    }
  }
  return overlay;
}

async function overlayAgainst(root: string, against: string | undefined): Promise<Overlay> {
  return overlayFromPlan(root, await planAgainst(root, against));
}

/**
 * Files git sees renamed between `base` (a commit) and `head` (a commit, `index` for the staged
 * changes, undefined for the working tree), old → new path relative to the root. Feeds
 * `compareReports({ renames })`, so moved files keep their findings.
 */
export async function renamesSince(root: string, base: string, head?: string): Promise<Map<string, string>> {
  const target = head === 'index' ? ['--cached', base] : head ? [base, head] : [base];
  const out = await git(path.resolve(root), ['diff', '--name-status', '-z', '-M', '--diff-filter=R', '--no-ext-diff', '--relative', ...target, '--', '.']);
  const renames = new Map<string, string>();
  const parts = (out ?? '').split('\0');
  // "R087\0old\0new\0"
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i].startsWith('R') && parts[i + 1] && parts[i + 2]) renames.set(parts[i + 1], parts[i + 2]);
  return renames;
}

/** Overlay that turns the working tree into `ref` (a branch, tag, commit…): see `snapshotAt`. */
export async function overlayForRef(root: string, ref: string): Promise<Overlay> {
  const commit = await resolveCommit(path.resolve(root), ref);
  if (!commit) throw new AnalyzeError(`Unknown git ref "${ref}".`);
  return overlayAgainst(path.resolve(root), commit);
}

/** Overlay that turns the working tree into the staged index (what the next commit will contain). */
export function overlayForIndex(root: string): Promise<Overlay> {
  return overlayAgainst(path.resolve(root), undefined);
}

/** Read the configuration as it is at `ref` (`null` = the staged index). */
export async function configAt(root: string, ref: string | null): Promise<LoadedConfig> {
  const abs = path.resolve(root);
  let commit = '';
  if (ref !== null) {
    const resolved = await resolveCommit(abs, ref);
    if (!resolved) throw new AnalyzeError(`Unknown git ref "${ref}".`);
    commit = resolved;
  }
  const prefix = (await git(abs, ['rev-parse', '--show-prefix']))?.trim() ?? '';
  const spec = (rel: string): string => `${commit}:${prefix}${rel}`;
  const blobs = await catFileBatch(abs, CONFIG_NAMES.map(spec));
  return loadConfig(abs, (rel) => blobs.get(spec(rel))?.toString('utf8') ?? null);
}

/* -------------------------------------------------------------------------- */
/*                                  Snapshots                                 */
/* -------------------------------------------------------------------------- */

const memo = new Map<string, Promise<ReportSnapshot>>();

/** Forget the in-memory snapshots (the files in `.code-visualizer/snapshots/` stay). */
export function clearSnapshotCache(): void {
  memo.clear();
}

/**
 * Identifies the analysis a stored snapshot came from. `stamp` is warm-engine's cache stamp: the
 * analyzer code (build or source mtime) signed with a per-user secret, so a snapshot that arrives
 * with the repository is never trusted (it could make old debt look new or new debt look old).
 */
function snapshotKey(options: SnapshotOptions, stamp: string | undefined): string {
  const exclude = [...(options.exclude ?? [])].sort();
  return JSON.stringify({ format: SNAPSHOT_FORMAT, schema: SCHEMA_VERSION, version: VERSION, stamp: stamp ?? null, exclude, maxFiles: options.maxFiles ?? null });
}

/** The parts of a report that comparisons need (no source code, no git history). */
export function toSnapshot(data: Pick<ReportData, keyof ReportSnapshot & keyof ReportData>, commit?: string): ReportSnapshot {
  return {
    commit,
    files: data.files.map(({ source: _source, ...f }) => f),
    edges: data.edges,
    symbolEdges: data.symbolEdges,
    routes: data.routes,
    apiCalls: data.apiCalls,
    packages: data.packages,
    insights: data.insights,
    health: data.health,
    config: data.config,
  };
}

/**
 * Files outside git that a snapshot read from disk (generated tsconfigs such as .nuxt/tsconfig.json,
 * ignored config files): root-relative path → sha1 of the content, `null` when missing. A stored
 * snapshot is only valid while they are unchanged.
 */
type DiskInputs = Record<string, string | null>;

/** Generated configs the analyzer reads straight from disk (see loadProject). */
const GENERATED_INPUTS = ['.nuxt/tsconfig.json', '.svelte-kit/tsconfig.json'];

function hashInput(root: string, rel: string): string | null {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  } catch {
    return null;
  }
}

/** Disk inputs of a snapshot: files it asked for that are neither in the overlay nor in git at `commit`. */
async function diskInputs(root: string, commit: string, asked: Iterable<string>, overlay: Overlay): Promise<DiskInputs> {
  const candidates = [...new Set([...asked, ...GENERATED_INPUTS])].filter((rel) => !Object.hasOwn(overlay, rel) && !rel.startsWith('../'));
  if (!candidates.length) return {};
  const prefix = (await git(root, ['rev-parse', '--show-prefix']))?.trim() ?? '';
  const inGit = await catFileBatch(root, candidates.map((rel) => `${commit}:${prefix}${rel}`));
  const inputs: DiskInputs = {};
  for (const rel of candidates) {
    if (inGit.has(`${commit}:${prefix}${rel}`)) continue; // identical on disk by construction
    const hash = hashInput(root, rel);
    // Missing files only matter for the generated configs; other misses are files that never existed.
    if (hash !== null || GENERATED_INPUTS.includes(rel)) inputs[rel] = hash;
  }
  return inputs;
}

function readStored(root: string, file: string, key: string): ReportSnapshot | undefined {
  try {
    // Bounded like the parse cache: a stored file is untrusted until its signed key matches.
    const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_STORED_BYTES }).toString('utf8')) as { key?: string; inputs?: DiskInputs; snapshot?: ReportSnapshot };
    if (stored.key !== key || !stored.snapshot?.files) return undefined;
    for (const [rel, hash] of Object.entries(stored.inputs ?? {})) if (hashInput(root, rel) !== hash) return undefined;
    return stored.snapshot;
  } catch {
    return undefined;
  }
}

function writeStored(root: string, file: string, key: string, snapshot: ReportSnapshot, inputs: DiskInputs): void {
  try {
    ensureStateDir(stateDir(root));
    writeFileAtomic(file, zlib.gzipSync(JSON.stringify({ key, inputs, snapshot }), { level: 1 }), 0o600);
    // Keep the most recently used snapshots.
    const dir = path.dirname(file);
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json.gz'))
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of entries.slice(KEEP_ON_DISK)) fs.rmSync(path.join(dir, old.n), { force: true });
  } catch {
    /* the disk cache is best effort */
  }
}

/** The analysis a snapshot runs: `analyze()` (passed in by the caller). */
export type AnalyzeRun = (options: AnalyzeOptions) => Promise<ReportData>;

/** A snapshot, and whether it can be cached (files did not change on disk while it was taken). */
interface Taken {
  snapshot: ReportSnapshot;
  stable: boolean;
}

async function buildSnapshot(run: AnalyzeRun, root: string, commit: string, key: string, options: SnapshotOptions, signed: boolean): Promise<Taken> {
  // Without a private per-user key (see cacheStamp) snapshots are neither read nor written.
  const persist = options.persist !== false && signed;
  const file = path.join(snapshotDir(root), `${commit}.json.gz`);
  if (persist) {
    const stored = readStored(root, file, key);
    if (stored) {
      try {
        const now = new Date();
        fs.utimesSync(file, now, now); // most recently used
      } catch {
        /* ignore */
      }
      return { snapshot: stored, stable: true };
    }
  }
  // Files outside the overlay are read from disk: if one is saved while the snapshot is taken, the
  // snapshot mixes versions. Check the plan again afterwards and retry once.
  for (let attempt = 0; ; attempt++) {
    const plan = await planAgainst(root, commit);
    const overlay = await overlayFromPlan(root, plan);
    const asked = new Set<string>();
    const data = await run({
      root,
      overlay,
      // Records the manifests and configs the analysis looks for (and lets the overlay answer).
      readText: (rel) => void asked.add(rel),
      git: false,
      changes: false,
      history: false,
      includeSource: false,
      cache: options.cache,
      exclude: options.exclude,
      maxFiles: options.maxFiles,
      toolVersion: options.toolVersion,
    });
    const snapshot = toSnapshot(data, commit);
    const stable = samePlan(plan, await planAgainst(root, commit));
    if (!stable && attempt === 0) continue;
    if (stable && persist) writeStored(root, file, key, snapshot, await diskInputs(root, commit, asked, overlay));
    return { snapshot, stable };
  }
}

/** `snapshotAt` with the analysis passed in; see src/analyzer/snapshot.ts. */
export async function takeSnapshot(run: AnalyzeRun, root: string, ref: string, options: SnapshotOptions = {}): Promise<ReportSnapshot> {
  const abs = path.resolve(root);
  const commit = await resolveCommit(abs, ref);
  if (!commit) {
    const inside = (await git(abs, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
    throw new AnalyzeError(inside ? `Unknown git ref "${ref}".` : `${abs} is not inside a git repository (or git is not installed).`);
  }
  const stamp = cacheStamp();
  const key = snapshotKey(options, stamp);
  const memoKey = `${abs}\0${commit}\0${key}`;
  let pending = memo.get(memoKey);
  if (pending) {
    // Most recently used last.
    memo.delete(memoKey);
    memo.set(memoKey, pending);
    return pending;
  }
  const taken = buildSnapshot(run, abs, commit, key, options, stamp !== undefined);
  pending = taken.then((t) => t.snapshot);
  memo.set(memoKey, pending);
  // Failed and unstable snapshots are not remembered.
  taken.then(
    (t) => {
      if (!t.stable) memo.delete(memoKey);
    },
    () => memo.delete(memoKey),
  );
  while (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  return pending;
}
