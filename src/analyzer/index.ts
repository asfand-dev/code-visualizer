import fs from 'node:fs';
import path from 'node:path';
import type {
  ChangedFile,
  ChangeSet,
  CoverageSummary,
  DependencyEdge,
  EnvReport,
  HistoryPoint,
  EdgeKind,
  FileInfo,
  Language,
  PackageInfo,
  ReportData,
  RiskFinding,
  RouteInfo,
  RuleListEntry,
  Scope,
  ScopeRole,
  Stats,
  SymbolEdge,
  SymbolEdgeKind,
  SymbolInfo,
} from '../shared/types.js';
import { SCHEMA_VERSION } from '../shared/types.js';
import type { TestRunners } from '../shared/testcmd.js';
import { meaningfulLines, setReadingOrder } from '../shared/review.js';
import { buildEnvReport } from '../shared/env.js';
import { isTestContext, MAX_RISKS, sortFindings, toFindings } from '../shared/risks.js';
import crypto from 'node:crypto';
import { linkApiCalls } from './apimap.js';
import { buildChangeSet, codeLinesFor, type CodeChange } from './changes.js';
import { cloneSettings, cloneTokens, createCloneCache, MAX_FAMILIES, projectClones, rememberDeclarations, type CloneCache, type ProjectClones } from './clones.js';
import { isSignificant } from '../shared/clones.js';
import { coverageSummary, fileCoverage, isPartialRun, loadCoverage, patchCoverage, unmeasuredPackages, type LoadedCoverage } from './coverage.js';
import { classifyFile, isConfigFile, isTestFile } from './classify.js';
import { evaluateRules, loadConfig, type LoadedConfig, type RuleConfig } from './config.js';
import { readEnvFiles } from './env.js';
import { readInstalled } from './licenses.js';
import { AnalyzeError } from './errors.js';
import { discoverFiles, discoveryFilter, extOf, MAX_FILE_BYTES, type DiscoveredFile } from './files.js';
import { analyzeChanges, analyzeGit, git as runGit, type GitAnalysis } from './git.js';
import { computeHealth, mergeHistory, readHistory } from './health.js';
import { loadCodeOwners, type CodeOwners } from './owners.js';
import { buildTestMap, detectTestRunners, hasCoverageThresholds, isTestableSource, playwrightTestDir, runnerInfo } from './tests.js';
import { selectTests } from './test-select.js';
import { loadTours } from './tours.js';
import { buildAdjacency, pageRank, reachable, reverse, sampleCycle, stronglyConnectedComponents, type Adjacency } from './graph.js';
import { buildFolders, buildTour, findDuplicates, markPackageHealth, symbolEdgeKey, type ManifestDeclarations } from './insights.js';
import { loadDiskCache, loadGitCache, saveDiskCache, saveGitCache } from './disk-cache.js';
import { joinRoute, MAX_SITES, parseSource, toPascalCase, type CallSiteFact, type ParsedFile, type RawRoute } from './parse.js';
import { loadProject, nearestManifest, readJson, toPosix, type PackageJson, type ProjectContext } from './project.js';
import { projectFiles, readTextFromOverlay, type ReadText } from './readtext.js';
import type { RepoMemo } from './repo.js';
import { ModuleResolver, packageNameOf, SOURCE_EXTENSIONS } from './resolve.js';
import { detectFileRoutes, type FileRole } from './routes.js';

export interface AnalyzeOptions {
  /** Project root (defaults to `process.cwd()`). */
  root?: string;
  /** Focus the report on a single file (path relative to cwd or absolute). */
  file?: string;
  /** Focus the report on a directory (path relative to cwd or absolute). */
  directory?: string;
  /** For `file` scope: how many levels of dependents / dependencies to include. */
  depth?: number;
  /** Extra gitignore-style patterns to exclude. */
  exclude?: string[];
  /** Embed file sources so the report can show code (default: true). */
  includeSource?: boolean;
  /** Analyze git history for churn, ownership and change coupling (default: true). */
  git?: boolean;
  maxFiles?: number;
  /** Version of the tool, stored in the report. */
  toolVersion?: string;
  /** Compare the working tree / branch with this ref (default: auto-detected main branch). */
  base?: string;
  /** Detect uncommitted and branch changes (default: true when git is enabled). */
  changes?: boolean;
  /** Read previous runs from `.code-visualizer/history.json` (default: true). */
  history?: boolean;
  /** Pre-loaded config (otherwise read from code-visualizer.config.json / package.json). */
  config?: LoadedConfig;
  /** Reuse parse results and git history between runs (used by `serve`). */
  cache?: AnalyzeCache;
  /**
   * Analyze a snapshot instead of the working tree: project-relative path → text (`null` = the file
   * does not exist). Source files in the overlay replace (or add to) the files on disk; manifests in it
   * (package.json, tsconfig, code-visualizer.config.json, CODEOWNERS…) are read from it too.
   * Overlay runs never read or record history. See `overlayForRef` / `overlayForIndex` / `snapshotAt`.
   */
  overlay?: Record<string, string | null>;
  /**
   * Override for configuration and manifest reads (package.json, tsconfig / jsconfig,
   * code-visualizer.config.json, CODEOWNERS…): text, `null` when the file is missing, or `undefined`
   * to use the overlay / the disk.
   */
  readText?: ReadText;
  /**
   * Also analyze the base commit of `changes` (the merge-base for a branch, HEAD for uncommitted work)
   * and attach what changed architecturally as `changes.delta`. Only differing files are re-parsed.
   */
  compare?: boolean;
  /**
   * new-only-gates: detect the changes between HEAD and the staged index (`git diff --cached`; untracked
   * files are ignored) instead of the working tree. Use with `overlay: await overlayForIndex(root)`;
   * with `compare`, the delta is the staged changes compared to HEAD.
   */
  staged?: boolean;
  // --- daily-loop ---
  /**
   * Detect the changes between the base and HEAD only: committed work, without uncommitted or untracked
   * files (what a push sends). Use with `overlay: await overlayForRef(root, 'HEAD')`; with `compare`, the
   * delta is HEAD compared to the merge-base. For pre-push hooks (`check --changed --committed`).
   */
  committed?: boolean;
  /**
   * review-mode: detect the changes of this ref (a branch, tag or commit) since it left `base` (their
   * merge-base) instead of the working tree, without git history. Use with
   * `overlay: await overlayForRef(root, head)`; with `compare`, the delta is the ref compared to the merge-base.
   */
  head?: string;
  /**
   * Keep parse results and git history in `.code-visualizer/cache/` between processes. Without
   * `cache` the parse cache is loaded from disk and saved back when something changed; the git
   * analysis is read from / written to disk either way.
   */
  persist?: boolean;
  /**
   * test-intelligence: coverage reports to read (files or folders, absolute or relative to the root)
   * instead of the auto-detected `coverage/coverage-final.json` / `coverage/lcov.info` of the root and
   * each workspace; `false` reads none. Snapshots of other refs and what-ifs (overlay runs) never read
   * coverage; staged runs (`staged` with the index as overlay) and committed runs (`committed`) do.
   */
  coverage?: string[] | false;
  /**
   * `false` skips copy-paste clone detection (no `insights.clones`, no Duplication category): for what-ifs
   * and overlays whose comparison needs no `newClones` (the engine's `whatIf` without a clone gate).
   * Default: detect, unless the configuration turns it off (`"clones": false`).
   */
  clones?: boolean;
  /**
   * dev-tools: work out what the next release contains (commits since the last version tag, changes to
   * the published API, the version that fits) as `release`. It analyzes the tag like any other ref
   * (cached per commit), so only `serve`, `report` and `release` ask for it. `since` starts from that tag or
   * commit instead of the latest version tag.
   */
  release?: boolean | { since?: string };
  /**
   * dev-tools: read the repository's branches, stashes, worktrees, lost commits, commit style, tracked-file
   * hygiene and git settings as `repo`. A few git processes (the commit-bound part is kept between runs), so
   * only `serve` and `report` ask for it.
   */
  repo?: boolean;
  /** dev-tools: read the GitHub Actions workflows, local actions and Dependabot setup as `ci` (plain files, no network). */
  ci?: boolean;
  /**
   * dev-tools: list the Claude Code tools (CLAUDE.md, skills, commands, subagents, MCP servers, hooks) as `ai`.
   * `personal: false` reads nothing outside the project (no `~/.claude`, no plugins); `home` is for tests.
   */
  ai?: boolean | { personal?: boolean; home?: string };
  onProgress?: (stage: AnalyzeStage, detail?: { done?: number; total?: number }) => void;
}

export interface AnalyzeCacheEntry {
  mtimeMs: number;
  size: number;
  /** sha1 of the text: a touched but unchanged file (checkout, formatter) keeps its parse result. */
  hash: string;
  /** Only kept in memory, and only once read (entries loaded from disk have none). */
  text?: string;
  parsed: ParsedFile;
}

export interface AnalyzeCache {
  files: Map<string, AnalyzeCacheEntry>;
  /** Parse results of overlay texts (snapshots of other refs, what-ifs), keyed by file id and the sha1 of the text. */
  byHash?: Map<string, ParsedFile>;
  git?: { key: string; result: GitAnalysis | undefined };
  /** Entries changed since the cache was loaded or saved (see saveDiskCache). */
  dirty?: boolean;
  /** 'disk' right after loadDiskCache; 'memory' once an analysis used the cache. */
  origin?: 'disk' | 'memory';
  /** Clone pairs of the last analysis of the working tree: the next one matches only the changed files. */
  clones?: CloneCache;
  /** The same, judged with the base's boilerplate fingerprints (`compare`, when the two sides count differently). */
  baseJudgedClones?: CloneCache;
  /**
   * What each changed file's diff changed in code (`codeChange`), by file id, content hash and diff hash,
   * and the code lines of changed files (patch coverage): a re-analysis re-scans only files edited since.
   */
  codeChanges?: Map<string, CodeChange | null>;
  codeLines?: Map<string, Set<number>>;
  /** Meaningful lines of each changed file's diff (review-mode's reading order), by the same identity. */
  meaningfulLines?: Map<string, number>;
  /** Tracked-file hygiene and commit style of the last `repo` analysis: they only change with a commit. */
  repo?: RepoMemo;
}

export function createAnalyzeCache(): AnalyzeCache {
  return { files: new Map(), byHash: new Map() };
}

export type AnalyzeStage = 'project' | 'discover' | 'parse' | 'link' | 'git' | 'changes' | 'compare' | 'insights' | 'done';

export { AnalyzeError };

interface Binding {
  file?: string;
  pkg?: string;
  imported: string;
}

interface FileState {
  id: string;
  ext: string;
  bytes: number;
  /** sha1 of the text, when a cache computed it. */
  hash?: string;
  text: string;
  parsed: ParsedFile;
  bindings: Map<string, Binding>;
  assets: FileInfo['assets'];
  unresolved: FileInfo['unresolved'];
  packages: Set<string>;
  symbolsByName: Map<string, SymbolInfo[]>;
}

const TYPE_KINDS = new Set(['interface', 'type', 'class', 'enum']);
const SOURCE_EXTS = new Set(SOURCE_EXTENSIONS);
const BY_HASH_LIMIT = 20_000;
/** Code lines kept per file content (`AnalyzeCache.codeLines`). */
const CODE_LINES_LIMIT = 4_000;
const EDGE_PRIORITY: Record<EdgeKind, number> = { import: 5, reexport: 4, require: 3, dynamic: 2, 'side-effect': 1 };
const MAX_SOURCE_BYTES = 400_000;
const MAX_TOTAL_SOURCE = 60_000_000;

const sha1 = (text: string): string => crypto.createHash('sha1').update(text).digest('hex');

/** Read a file's text on first use: warm runs that need no source skip reading unchanged files. */
function lazyText(abs: string, known: string | undefined, entry: AnalyzeCacheEntry | undefined): () => string {
  let text = known;
  return () => {
    if (text === undefined) {
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        text = '';
      }
      if (entry) entry.text = text;
    }
    return text;
  };
}

/**
 * Key of a git analysis: HEAD, the branch name (a new branch at the same commit), its upstream
 * (ahead/behind), the day (activity charts are relative to today) and the analyzed files.
 */
async function gitCacheKey(root: string, ids: string[]): Promise<{ head: string; key: string }> {
  // One process for both: `rev-parse HEAD --abbrev-ref HEAD` prints the hash, then the branch.
  const [refs, upstream] = await Promise.all([runGit(root, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']), runGit(root, ['rev-parse', '--verify', '--quiet', '@{u}'])]);
  const [head, branch] = (refs ?? '').trim().split('\n');
  const h = head?.trim() || 'none';
  return { head: h, key: `${h}:${branch?.trim() ?? ''}:${upstream?.trim() ?? ''}:${new Date().toDateString()}:${sha1(ids.join('\n'))}` };
}

function relativeToRoot(root: string, input: string): string {
  const abs = path.resolve(process.cwd(), input);
  const rel = toPosix(path.relative(root, abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AnalyzeError(`"${input}" is outside of the project root (${root}).`);
  }
  return rel.replace(/\/$/, '');
}

export async function analyze(options: AnalyzeOptions = {}): Promise<ReportData> {
  const started = Date.now();
  const root = path.resolve(options.root ?? process.cwd());
  const progress = options.onProgress ?? (() => undefined);
  const warnings: string[] = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new AnalyzeError(`Project root "${root}" is not a directory.`);

  progress('project');
  const overlay = options.overlay && normalizeOverlay(root, options.overlay);
  const overlayText = readTextFromOverlay(overlay);
  const readText: ReadText | undefined =
    options.readText || overlayText
      ? (rel) => {
          const text = options.readText?.(rel);
          return text !== undefined ? text : overlayText?.(rel);
        }
      : undefined;
  // Manifests that exist only in the snapshot, so globbed lookups (tsconfigs, workspaces) find them.
  const snapshotOnly = overlay ? Object.keys(overlay).filter((rel) => overlay[rel] !== null && !SOURCE_EXTS.has(extOf(rel)) && !fs.existsSync(path.join(root, rel))) : [];
  const loadedConfig = options.config ?? loadConfig(root, readText);
  const config = loadedConfig.config;
  let scope: Scope = { type: 'project' };
  if (options.file) scope = { type: 'file', path: relativeToRoot(root, options.file) };
  else if (options.directory) scope = { type: 'directory', path: relativeToRoot(root, options.directory) };
  // A sub-project you point at with --file / --directory is analyzed even though it is excluded by default.
  const ctx = await loadProject(root, { includeSubprojects: config.includeSubprojects, keep: scope.path || undefined, readText, extraFiles: snapshotOnly });

  progress('discover');
  // `concat` keeps a single string from JavaScript callers intact (spreading it would exclude every file).
  const exclude = (config.exclude ?? []).concat(options.exclude ?? []);
  // Nested fixture / example projects are separate programs with their own package.json: leave them out.
  const discovered = await discoverFiles(root, { exclude, excludeDirs: ctx.excludedSubprojects, maxFiles: options.maxFiles });
  if (overlay) discovered.files = applyOverlay(root, discovered.files, overlay, discoveryFilter(exclude, ctx.excludedSubprojects), warnings);
  // A snapshot may have no sources (a base commit before the project existed): that is an empty project.
  if (!discovered.files.length && !overlay) {
    throw new AnalyzeError(`No JavaScript/TypeScript source files found in ${root}.`);
  }
  if (loadedConfig.error) warnings.push(`Ignored the configuration — ${loadedConfig.error}`);
  for (const glob of ctx.unmatchedSubprojectGlobs) warnings.push(`"includeSubprojects": "${glob}" matches no nested package.json folder.`);
  if (discovered.truncated) warnings.push(`Only the first ${discovered.files.length} files were analyzed (use --max-files to raise the limit).`);
  for (const s of discovered.skipped.slice(0, 20)) warnings.push(`Skipped ${s.id} (${s.reason}).`);

  /* ------------------------------- Parse files ------------------------------- */
  const states = new Map<string, FileState>();
  const total = discovered.files.length;
  let done = 0;
  progress('parse', { done, total });
  // With `persist` and no in-memory cache, this run owns a cache loaded from (and saved to) disk.
  // Overlay runs (snapshots, what-ifs) never write state.
  const ownsDiskCache = !!options.persist && !options.cache && !overlay;
  let cache = options.cache;
  if (ownsDiskCache) {
    cache = createAnalyzeCache();
    loadDiskCache(root, cache);
  }
  // A comparison analyzes the base commit right after this run: share the parse results with it.
  if (!cache && options.compare) cache = createAnalyzeCache();
  const cacheOrigin = cache?.origin ?? 'memory';
  let reused = 0;
  let parsedCount = 0;
  const seenIds = new Set<string>();
  for (const f of discovered.files) {
    seenIds.add(f.id);
    let text: string | undefined;
    let parsed: ParsedFile;
    let hash: string | undefined;
    const cached = cache?.files.get(f.id);
    const snapshotText = overlay && Object.hasOwn(overlay, f.id) ? overlay[f.id] : undefined;
    if (typeof snapshotText === 'string') {
      // Overlay texts are cached by content: the same version of a file is parsed once across refs,
      // and a text equal to the working tree's reuses that parse result (same content hash).
      text = snapshotText;
      hash = sha1(text);
      // Parse output depends on the file id too (anonymous default exports): key on both.
      const key = `${f.id}\0${hash}`;
      const hit = cached?.hash === hash ? cached.parsed : cache?.byHash?.get(key);
      if (hit) {
        parsed = hit;
        reused++;
      } else {
        parsed = withCloneTokens(parseSource(f.id, text, f.ext), text, f.ext);
        parsedCount++;
        if (cache) rememberParsed(cache, key, parsed);
      }
    } else if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.bytes) {
      text = cached.text;
      parsed = cached.parsed;
      hash = cached.hash || undefined;
      reused++;
    } else {
      try {
        text = fs.readFileSync(f.abs, 'utf8');
      } catch {
        continue;
      }
      hash = cache ? sha1(text) : undefined;
      if (cached && cached.hash === hash) {
        // Touched but unchanged (checkout, formatter, `touch`): keep the parse result.
        Object.assign(cached, { mtimeMs: f.mtimeMs, size: f.bytes, text });
        parsed = cached.parsed;
        reused++;
      } else {
        parsed = withCloneTokens(parseSource(f.id, text, f.ext), text, f.ext);
        parsedCount++;
        cache?.files.set(f.id, { mtimeMs: f.mtimeMs, size: f.bytes, hash: hash ?? '', text, parsed });
      }
      if (cache) cache.dirty = true;
    }
    if (parsed.parseError) warnings.push(`Could not fully parse ${f.id}: ${parsed.parseError}`);
    // Cached parse results are shared between runs: symbols get this run's ids on copies.
    if (cache) parsed = { ...parsed, symbols: parsed.symbols.map((s) => ({ ...s })) };
    const fileText = lazyText(f.abs, text, cache?.files.get(f.id));
    states.set(f.id, {
      id: f.id,
      ext: f.ext,
      bytes: f.bytes,
      hash,
      get text() {
        return fileText();
      },
      parsed,
      bindings: new Map(),
      assets: [],
      unresolved: [],
      packages: new Set(),
      symbolsByName: new Map(),
    });
    done++;
    if (done % 50 === 0) progress('parse', { done, total });
  }
  // Overlay runs leave out files of the working tree; their parse results stay valid for the next normal run.
  if (cache && !overlay) {
    // A run narrowed by --exclude / --max-files shares the cache with full runs: it keeps the
    // entries of files it did not look at, as long as they still exist.
    const narrowed = discovered.truncated || ([] as string[]).concat(options.exclude ?? []).length > 0;
    for (const [id, entry] of cache.files) {
      if (seenIds.has(id)) continue;
      if (narrowed && fs.existsSync(path.join(root, id))) {
        entry.text = undefined;
        continue;
      }
      cache.files.delete(id);
      cache.dirty = true;
    }
  }
  progress('parse', { done, total });

  if (scope.type === 'file' && !states.has(scope.path!)) {
    throw new AnalyzeError(`File "${scope.path}" is not a supported source file inside the project (or it is excluded).`);
  }
  if (scope.type === 'directory' && scope.path && ![...states.keys()].some((id) => id.startsWith(`${scope.path}/`))) {
    throw new AnalyzeError(`Directory "${scope.path}" contains no supported source files.`);
  }

  progress('link');
  const ids = [...states.keys()];
  const idSet = new Set(ids);
  const resolver = new ModuleResolver(ctx, idSet);

  /* ------------------------------- Symbol ids -------------------------------- */
  const symbolById = new Map<string, SymbolInfo>();
  for (const st of states.values()) {
    const used = new Map<string, number>();
    for (const s of st.parsed.symbols) {
      const n = (used.get(s.name) ?? 0) + 1;
      used.set(s.name, n);
      s.id = n === 1 ? `${st.id}#${s.name}` : `${st.id}#${s.name}~${n}`;
      symbolById.set(s.id, s);
      const list = st.symbolsByName.get(s.name) ?? [];
      list.push(s);
      st.symbolsByName.set(s.name, list);
    }
  }

  /* --------------------------- Imports → edges -------------------------------- */
  const edgeMap = new Map<string, DependencyEdge>();
  const pkgUsage = new Map<
    string,
    // `loadedBy`: files that load the package when they run (a value import / require, not `import type` or `import()`).
    { files: Set<string>; names: Map<string, number>; count: number; typeOnly: boolean; builtin: boolean; loadedBy: Set<string> }
  >();
  const specCache = new Map<string, string | undefined>();
  const resolveFile = (from: string, specifier: string): string | undefined => {
    const key = `${from}\0${specifier}`;
    if (specCache.has(key)) return specCache.get(key);
    const r = resolver.resolve(from, specifier);
    const value = r.type === 'file' ? r.id : undefined;
    specCache.set(key, value);
    return value;
  };

  const addEdge = (source: string, target: string, kind: EdgeKind, typeOnly: boolean, names: string[], line: number, specifier: string): void => {
    if (source === target) return;
    const key = `${source}\0${target}`;
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, { source, target, kind, typeOnly, names: [...new Set(names)], line, specifier });
      return;
    }
    if (EDGE_PRIORITY[kind] > EDGE_PRIORITY[existing.kind]) existing.kind = kind;
    existing.typeOnly = existing.typeOnly && typeOnly;
    for (const n of names) if (!existing.names.includes(n)) existing.names.push(n);
  };

  const usePackage = (st: FileState, name: string, builtin: boolean, names: string[], typeOnly: boolean, kind: EdgeKind): void => {
    let usage = pkgUsage.get(name);
    if (!usage) {
      usage = { files: new Set(), names: new Map(), count: 0, typeOnly: true, builtin, loadedBy: new Set() };
      pkgUsage.set(name, usage);
    }
    usage.files.add(st.id);
    usage.count++;
    usage.typeOnly = usage.typeOnly && typeOnly;
    // A dynamic `import()` is an optional or guarded load (`if (dev) await import('vite')`).
    if (!typeOnly && kind !== 'dynamic') usage.loadedBy.add(st.id);
    for (const n of names) usage.names.set(n, (usage.names.get(n) ?? 0) + 1);
    st.packages.add(name);
  };

  // Packages used without a package import (they still count as used for "unused dependencies"): workspace
  // packages imported by name resolve to their source files, and JSX compiles to `react/jsx-runtime`.
  const implicitUse = new Map<string, Set<string>>();
  const internalNames = new Set(ctx.manifests.map((m) => m.pkg.name).filter((n): n is string => !!n));
  const noteUse = (name: string, file: string): void => {
    const set = implicitUse.get(name) ?? new Set<string>();
    set.add(file);
    implicitUse.set(name, set);
  };
  for (const st of states.values()) {
    // Importing your own package by name (self-reference) is not a dependency.
    const ownName = nearestManifest(ctx.manifests, st.id)?.pkg.name;
    if (st.parsed.usesJsx) noteUse('react', st.id);
    for (const imp of st.parsed.imports) {
      const r = resolver.resolve(st.id, imp.specifier);
      if (r.type === 'file') {
        if (!/^[./]/.test(imp.specifier) && internalNames.has(packageNameOf(imp.specifier))) noteUse(packageNameOf(imp.specifier), st.id);
        addEdge(st.id, r.id, imp.kind, imp.typeOnly, imp.names, imp.line, imp.specifier);
        for (const b of imp.bindings) st.bindings.set(b.local, { file: r.id, imported: b.imported });
      } else if (r.type === 'package' || r.type === 'builtin') {
        if (r.name === ownName) continue;
        usePackage(st, r.name, r.type === 'builtin', imp.names, imp.typeOnly, imp.kind);
        for (const b of imp.bindings) st.bindings.set(b.local, { pkg: r.name, imported: b.imported });
      } else if (r.type === 'asset') {
        st.assets.push({ specifier: imp.specifier, line: imp.line, path: r.path });
      } else if (r.type === 'unresolved') {
        st.unresolved.push({ specifier: imp.specifier, line: imp.line });
      }
    }
    for (const re of st.parsed.reexports) {
      const r = resolver.resolve(st.id, re.specifier);
      const names = re.star ? ['*'] : re.names.map((n) => n.imported);
      if (r.type === 'file') addEdge(st.id, r.id, 'reexport', re.typeOnly, names, re.line, re.specifier);
      else if (r.type === 'package' || r.type === 'builtin') usePackage(st, r.name, r.type === 'builtin', names, re.typeOnly, 'reexport');
      else if (r.type === 'unresolved') st.unresolved.push({ specifier: re.specifier, line: re.line });
    }
  }

  /* --------------------------- Export resolution ----------------------------- */
  const valueSymbol = (st: FileState, name: string, space: 'value' | 'type' | 'any' = 'any'): SymbolInfo | undefined => {
    const list = st.symbolsByName.get(name);
    if (!list?.length) return undefined;
    if (space === 'value') return list.find((s) => s.kind !== 'interface' && s.kind !== 'type') ?? undefined;
    if (space === 'type') return list.find((s) => TYPE_KINDS.has(s.kind)) ?? list[0];
    return list.find((s) => s.kind !== 'namespace') ?? list[0];
  };

  const resolveExport = (file: string, name: string, space: 'value' | 'type' | 'any' = 'any', depth = 0): SymbolInfo | undefined => {
    if (depth > 15) return undefined;
    const st = states.get(file);
    if (!st) return undefined;
    const local = st.parsed.localExports.find((e) => e.name === name);
    if (local) {
      const s = valueSymbol(st, local.local, space);
      if (s) return s;
      const b = st.bindings.get(local.local);
      if (b?.file) return resolveExport(b.file, b.imported, space, depth + 1);
    }
    if (name === 'default') {
      const s = st.parsed.symbols.find((x) => x.isDefault);
      if (s) return s;
    }
    for (const re of st.parsed.reexports) {
      if (re.star) continue;
      const hit = re.names.find((n) => n.exported === name);
      if (!hit) continue;
      const target = resolveFile(file, re.specifier);
      if (target && hit.imported !== '*') return resolveExport(target, hit.imported, space, depth + 1);
      return undefined;
    }
    if (name !== 'default') {
      for (const re of st.parsed.reexports) {
        if (!re.star) continue;
        const target = resolveFile(file, re.specifier);
        const s = target ? resolveExport(target, name, space, depth + 1) : undefined;
        if (s) return s;
      }
    }
    const s = valueSymbol(st, name, space);
    return s?.exported ? s : undefined;
  };

  /** Resolve an identifier (or `ns.member`) as seen from inside `file`. */
  const resolveName = (file: string, name: string, space: 'value' | 'type' | 'any' = 'any'): SymbolInfo | undefined => {
    const st = states.get(file);
    if (!st || !name) return undefined;
    const dot = name.indexOf('.');
    if (dot > 0) {
      const head = name.slice(0, dot);
      const tail = name.slice(dot + 1);
      const b = st.bindings.get(head);
      if (b?.file) {
        if (b.imported === '*') return resolveExport(b.file, tail, space);
        const viaDefault = resolveExport(b.file, b.imported, 'any');
        if (viaDefault && viaDefault.kind !== 'class' && viaDefault.kind !== 'namespace') return resolveExport(b.file, tail, space);
      }
      return undefined;
    }
    const local = valueSymbol(st, name, space);
    const b = st.bindings.get(name);
    // `const Page = lazy(() => import('./Page'))` → the real component lives in the imported file.
    if (local?.tags?.includes('lazy') && b?.file) return resolveExport(b.file, 'default', space) ?? local;
    if (local) return local;
    if (b?.file) return resolveExport(b.file, b.imported === '*' ? 'default' : b.imported, space);
    return undefined;
  };

  /** `new UserService(...)` stored in a constant → the class it instantiates. */
  const instanceClass = (sym: SymbolInfo | undefined, file: string): SymbolInfo | undefined => {
    if (!sym || (sym.kind !== 'constant' && sym.kind !== 'variable')) return undefined;
    const m = sym.typeText?.match(/^new\s+([A-Za-z_$][\w$]*)/);
    if (!m) return undefined;
    const cls = resolveName(file, m[1], 'value');
    return cls?.kind === 'class' ? cls : undefined;
  };

  // Vue: globally registered / auto-imported components (Nuxt `components/` convention)
  const vueRegistry = new Map<string, string>();
  for (const st of states.values()) {
    if (st.ext !== '.vue') continue;
    const base = toPascalCase(path.posix.basename(st.id));
    if (!vueRegistry.has(base)) vueRegistry.set(base, st.id);
    const m = st.id.match(/(?:^|\/)components\/(.+)\.vue$/);
    if (m) {
      const prefixed = toPascalCase(m[1].replace(/\/index$/, '').replace(/\//g, '-'));
      if (!vueRegistry.has(prefixed)) vueRegistry.set(prefixed, st.id);
    }
  }

  /* ------------------------------ Symbol edges ------------------------------- */
  const symbolEdgeMap = new Map<string, SymbolEdge>();
  // Call sites per symbol edge key (query-core): copied into `SymbolEdge.lines` / `argc` below.
  const edgeSites = new Map<string, CallSiteFact[]>();
  const addSymbolEdge = (source: string, target: string, kind: SymbolEdgeKind, count = 1, sites?: readonly CallSiteFact[]): void => {
    if (!source || !target || source === target) return;
    const key = symbolEdgeKey({ source, target, kind });
    const existing = symbolEdgeMap.get(key);
    if (existing) existing.count += count;
    else symbolEdgeMap.set(key, { source, target, kind, count });
    if (sites?.length) {
      const list = edgeSites.get(key);
      if (list) list.push(...sites);
      else edgeSites.set(key, [...sites]);
    }
  };
  /** Sites where `symbol` renders `tag` (a class component's are in the facts of its methods). */
  const renderSites = (st: FileState, symbol: SymbolInfo, tag: string): CallSiteFact[] => {
    const key = `jsx:${tag}`;
    const own = st.parsed.facts.get(symbol.name)?.sites?.get(key) ?? [];
    if (symbol.kind !== 'class') return own;
    const prefix = `${symbol.name}.`;
    const all = [...own];
    for (const [k, facts] of st.parsed.facts) if (k.startsWith(prefix)) all.push(...(facts.sites?.get(key) ?? []));
    return all;
  };
  const hasMember = (cls: SymbolInfo, member: string): boolean => !!cls.members?.some((m) => m.name === member);

  const resolveCallee = (st: FileState, owner: string | undefined, fieldTypes: Map<string, string> | undefined, callee: string): { id: string; kind: SymbolEdgeKind } | undefined => {
    if (callee.startsWith('new:')) {
      const cls = resolveName(st.id, callee.slice(4), 'value');
      if (cls && (cls.kind === 'class' || cls.kind === 'component')) return { id: cls.id, kind: 'instantiates' };
      return undefined;
    }
    if (callee.startsWith('super.')) return undefined;
    if (callee.startsWith('this.')) {
      const parts = callee.split('.');
      if (!owner) return undefined;
      const cls = valueSymbol(st, owner, 'value');
      if (!cls) return undefined;
      if (parts.length === 2) return hasMember(cls, parts[1]) ? { id: `${cls.id}.${parts[1]}`, kind: 'calls' } : undefined;
      const typeName = fieldTypes?.get(parts[1]);
      if (!typeName) return undefined;
      const target = resolveName(st.id, typeName, 'type');
      if (target?.kind === 'class' && hasMember(target, parts[2])) return { id: `${target.id}.${parts[2]}`, kind: 'calls' };
      if (target && target.kind === 'interface') return { id: target.id, kind: 'uses' };
      return undefined;
    }
    const dot = callee.indexOf('.');
    if (dot > 0) {
      const head = callee.slice(0, dot);
      const tail = callee.slice(dot + 1);
      const localSym = valueSymbol(st, head, 'value');
      if (localSym?.kind === 'class') return hasMember(localSym, tail) ? { id: `${localSym.id}.${tail}`, kind: 'calls' } : undefined;
      const localInstance = instanceClass(localSym, st.id);
      if (localInstance) return hasMember(localInstance, tail) ? { id: `${localInstance.id}.${tail}`, kind: 'calls' } : undefined;
      const b = st.bindings.get(head);
      if (!b?.file) return undefined;
      if (b.imported !== '*') {
        const target = resolveExport(b.file, b.imported, 'value');
        if (target?.kind === 'class') return hasMember(target, tail) ? { id: `${target.id}.${tail}`, kind: 'calls' } : undefined;
        const inst = instanceClass(target, b.file);
        if (inst) return hasMember(inst, tail) ? { id: `${inst.id}.${tail}`, kind: 'calls' } : undefined;
      }
      const fn = resolveExport(b.file, tail, 'value');
      if (fn) return { id: fn.id, kind: 'calls' };
      // const svc = require('./userService') where the module exports `new UserService()`
      const inst = instanceClass(resolveExport(b.file, 'default', 'value'), b.file);
      if (inst && hasMember(inst, tail)) return { id: `${inst.id}.${tail}`, kind: 'calls' };
      return undefined;
    }
    const target = resolveName(st.id, callee, 'value');
    if (!target || target.kind === 'class' || target.kind === 'enum' || target.kind === 'namespace') return undefined;
    if (target.kind === 'constant' || target.kind === 'variable') {
      // Only link to callable constants (stores, factories); plain values are not calls.
      if (!target.tags?.length) return undefined;
    }
    return { id: target.id, kind: 'calls' };
  };

  for (const st of states.values()) {
    // Calls / instantiations
    for (const [key, facts] of st.parsed.facts) {
      let sourceId: string | undefined;
      const dot = key.indexOf('.');
      if (dot > 0) {
        const cls = valueSymbol(st, key.slice(0, dot), 'value');
        if (cls) sourceId = `${cls.id}.${key.slice(dot + 1)}`;
      } else {
        sourceId = valueSymbol(st, key, 'value')?.id ?? valueSymbol(st, key, 'type')?.id;
      }
      if (!sourceId) continue;
      const ownerFacts = facts.owner ? st.parsed.facts.get(facts.owner) : undefined;
      const fieldTypes = ownerFacts?.fieldTypes ?? facts.fieldTypes;
      for (const [callee, count] of facts.calls) {
        const hit = resolveCallee(st, facts.owner, fieldTypes, callee);
        if (hit) addSymbolEdge(sourceId, hit.id, hit.kind, count, facts.sites?.get(callee));
      }
    }
    for (const symbol of st.parsed.symbols) {
      // Renders
      if (symbol.component) {
        for (const r of symbol.component.renders) {
          let target = resolveName(st.id, r, 'value');
          if (!target && (st.ext === '.vue' || st.ext === '.astro')) {
            const regFile = vueRegistry.get(r);
            if (regFile && regFile !== st.id) {
              target = states.get(regFile)?.parsed.symbols.find((s) => s.isDefault && s.kind === 'component');
              if (target) addEdge(st.id, regFile, 'import', false, ['default'], symbol.line, `(auto-import) ${r}`);
            }
          }
          if (target && (target.kind === 'component' || target.kind === 'function' || target.kind === 'class')) addSymbolEdge(symbol.id, target.id, 'renders', 1, renderSites(st, symbol, r));
        }
        for (const c of symbol.component.contexts ?? []) {
          const target = resolveName(st.id, c, 'value');
          if (target) addSymbolEdge(symbol.id, target.id, 'uses');
        }
      }
      // Inheritance
      for (const e of symbol.extends ?? []) {
        const target = resolveName(st.id, e, 'type');
        if (target && target.id !== symbol.id) addSymbolEdge(symbol.id, target.id, 'extends');
      }
      for (const i of symbol.implements ?? []) {
        const target = resolveName(st.id, i, 'type');
        if (target) addSymbolEdge(symbol.id, target.id, 'implements');
      }
      // Type associations (UML "uses")
      if (TYPE_KINDS.has(symbol.kind) || symbol.kind === 'component') {
        const refs = st.parsed.facts.get(symbol.name)?.refs;
        if (!refs) continue;
        const inherited = new Set([...(symbol.extends ?? []), ...(symbol.implements ?? [])]);
        for (const ref of refs) {
          if (inherited.has(ref) || ref === symbol.name) continue;
          const target = resolveName(st.id, ref, 'type');
          if (target && TYPE_KINDS.has(target.kind) && target.id !== symbol.id) addSymbolEdge(symbol.id, target.id, 'uses');
        }
      }
    }
  }

  // In-file references without an edge (query-core): a constant an exported function reads, a handler
  // stored in an exported map, a type a function mentions; and the symbols module-level code uses.
  const linked = new Set<string>();
  for (const e of symbolEdgeMap.values()) linked.add(`${e.source}\0${e.target}`);
  for (const st of states.values()) {
    for (const [key, facts] of st.parsed.facts) {
      if (!facts.values?.size && !facts.refs.size) continue;
      const dot = key.indexOf('.');
      const owner = dot > 0 ? valueSymbol(st, key.slice(0, dot), 'value') : (valueSymbol(st, key, 'value') ?? valueSymbol(st, key, 'type'));
      if (!owner) continue;
      const sourceId = dot > 0 ? `${owner.id}.${key.slice(dot + 1)}` : owner.id;
      const refs = new Set(owner.localRefs);
      const add = (target: SymbolInfo | undefined): void => {
        if (target && target !== owner && !linked.has(`${sourceId}\0${target.id}`)) refs.add(target.name);
      };
      for (const name of facts.values ?? []) add(valueSymbol(st, name, 'value'));
      for (const name of facts.refs) {
        if (name.includes('.') || name.includes('<')) continue;
        const target = valueSymbol(st, name, 'type');
        if (target && TYPE_KINDS.has(target.kind)) add(target);
      }
      if (refs.size) owner.localRefs = [...refs].sort();
    }
    for (const name of st.parsed.moduleRefs ?? []) for (const s of st.symbolsByName.get(name) ?? []) s.moduleRef = true;
  }

  // Exact call sites (query-core): sorted, de-duplicated and capped; argc only for calls and `new`.
  for (const [key, sites] of edgeSites) {
    const edge = symbolEdgeMap.get(key)!;
    const seen = new Set<string>();
    const unique: CallSiteFact[] = [];
    for (const site of sites.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const k = `${site[0]}:${site[1]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(site);
      if (unique.length >= MAX_SITES) break;
    }
    edge.lines = unique.map((s) => s[0]);
    if (edge.kind === 'calls' || edge.kind === 'instantiates') edge.argc = unique.map((s) => s[1]);
  }

  /* --------------------------------- Routes ---------------------------------- */
  const exportNames = (id: string): string[] => states.get(id)?.parsed.localExports.map((e) => e.name) ?? [];
  const fileRoutes = detectFileRoutes(ids, ctx, exportNames);
  const roles = fileRoutes.roles;
  const routes: RouteInfo[] = [];
  const routeIds = new Set<string>();
  const pushRoute = (route: Omit<RouteInfo, 'id'>): void => {
    const id = `${route.file}:${route.line ?? 0}:${route.method}:${route.path}`;
    if (routeIds.has(id)) return;
    routeIds.add(id);
    routes.push({ id, ...route });
  };
  for (const fr of fileRoutes.routes) {
    const st = states.get(fr.file);
    const handler = !st
      ? undefined
      : fr.type === 'api' && fr.method !== 'ALL'
        ? valueSymbol(st, fr.method, 'value')
        : fr.type === 'middleware'
          ? (valueSymbol(st, 'middleware', 'value') ?? st.parsed.symbols.find((s) => s.isDefault))
          : (st.parsed.symbols.find((s) => s.isDefault) ?? valueSymbol(st, 'handler', 'value') ?? valueSymbol(st, 'loader', 'value'));
    pushRoute({
      method: fr.method,
      path: fr.path,
      file: fr.file,
      line: handler?.line,
      handler: handler?.name,
      handlerSymbol: handler?.id,
      framework: fr.framework,
      type: fr.type,
      params: fr.params.length ? fr.params : undefined,
    });
  }

  // Express-style mounts: app.use('/api', router) → prefix routes in the router's file.
  const mounts: { parent: string; prefix: string; child: string }[] = [];
  const localMounts = new Map<string, string>(); // `${file}\0${receiver}` → prefix
  const filesWithServerRoutes = new Set(ids.filter((id) => states.get(id)!.parsed.routes.some((r) => r.type === 'api' || r.mountTargets || r.mountSpecifiers)));
  const mountKind = new Map<RawRoute, { children: string[] }>();
  for (const st of states.values()) {
    for (const r of st.parsed.routes) {
      if (r.method !== 'USE') continue;
      const children: string[] = [];
      for (const t of r.mountTargets ?? []) {
        const head = t.split('.')[0];
        const b = st.bindings.get(head);
        if (b?.file && filesWithServerRoutes.has(b.file)) children.push(b.file);
        else if (!b && st.parsed.routes.some((x) => x.receiver === head && x !== r)) localMounts.set(`${st.id}\0${head}`, r.path);
      }
      for (const s of r.mountSpecifiers ?? []) {
        const file = resolveFile(st.id, s);
        if (file && filesWithServerRoutes.has(file)) children.push(file);
      }
      for (const child of children) mounts.push({ parent: st.id, prefix: r.path, child });
      mountKind.set(r, { children });
    }
  }
  const prefixMemo = new Map<string, string[]>();
  const prefixesOf = (file: string, stack = new Set<string>()): string[] => {
    const memo = prefixMemo.get(file);
    if (memo) return memo;
    if (stack.has(file)) return [''];
    stack.add(file);
    const parents = mounts.filter((m) => m.child === file);
    const result = parents.length
      ? [...new Set(parents.flatMap((m) => prefixesOf(m.parent, stack).map((p) => joinRoute(p, m.prefix))))]
      : [''];
    stack.delete(file);
    prefixMemo.set(file, result);
    return result;
  };

  for (const st of states.values()) {
    for (const r of st.parsed.routes) {
      const localPrefix = r.receiver ? localMounts.get(`${st.id}\0${r.receiver}`) ?? '' : '';
      const prefixes = r.framework === 'nestjs' || r.type === 'page' || r.type === 'layout' ? [''] : prefixesOf(st.id);
      let handlerSymbol: string | undefined;
      if (r.framework === 'nestjs' && r.handler) {
        const [cls, method] = r.handler.split('.');
        const c = valueSymbol(st, cls, 'value');
        if (c) handlerSymbol = `${c.id}.${method}`;
      } else if (r.componentSpecifier) {
        const file = resolveFile(st.id, r.componentSpecifier);
        const target = file ? states.get(file) : undefined;
        handlerSymbol = target
          ? (target.parsed.symbols.find((s) => s.isDefault) ??
              valueSymbol(target, 'Component', 'value') ??
              target.parsed.symbols.find((s) => s.exported && s.kind === 'component'))?.id
          : undefined;
      } else if (r.component) {
        handlerSymbol = resolveName(st.id, r.component, 'value')?.id;
      } else if (r.handler && r.handler !== '(inline)') {
        handlerSymbol = resolveName(st.id, r.handler, 'value')?.id ?? resolveCallee(st, undefined, undefined, r.handler)?.id;
      }
      const isMount = r.method === 'USE' && (mountKind.get(r)?.children.length ?? 0) > 0;
      if (r.method === 'USE' && !isMount && !r.path.startsWith('/') && r.path !== '/') continue;
      for (const prefix of prefixes) {
        const full = r.type === 'page' || r.type === 'layout' ? r.path : joinRoute(prefix, localPrefix, r.path);
        pushRoute({
          method: r.method,
          path: r.path === '*' && !prefix && !localPrefix ? '*' : full,
          file: st.id,
          line: r.line,
          handler: r.handler,
          handlerSymbol,
          middlewares: r.middlewares,
          framework: r.framework,
          type: isMount ? 'mount' : r.type,
          params: [...full.matchAll(/:(\w+)|\[(?:\.\.\.)?(\w+)\]/g)].map((m) => m[1] ?? m[2]),
        });
      }
    }
  }
  for (const r of routes) if (r.params && !r.params.length) delete r.params;
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  /* -------------------------------- Entries ---------------------------------- */
  const entries = new Map<string, string>();
  const markEntry = (id: string | undefined, reason: string): void => {
    if (id && idSet.has(id) && !entries.has(id)) entries.set(id, reason);
  };
  const candidatesFor = (dir: string, field: string): string[] => {
    const rel = path.posix.normalize(path.posix.join(dir, field.replace(/^\.\//, '')));
    const noExt = rel.replace(/\.(d\.ts|[cm]?[jt]sx?)$/, '');
    const src = noExt.replace(/(^|\/)(dist|build|lib|out|esm|cjs)\//, '$1src/');
    return [rel, noExt, src];
  };
  // Root, workspaces and nested packages that are analyzed (their main / bin / exports are entries too).
  const pkgs = [
    { dir: '', pkg: ctx.pkg },
    ...ctx.workspaces.map((w) => ({ dir: w.dir, pkg: w.pkg })),
    ...ctx.manifests.filter((m) => m.role === 'subproject').map((m) => ({ dir: m.dir, pkg: m.pkg })),
  ];
  const rootRel = toPosix(path.relative(root, ctx.pkgDir));
  for (const { dir: d, pkg } of pkgs) {
    const dir = d || (rootRel && !rootRel.startsWith('..') ? rootRel : '');
    const fields: [unknown, string][] = [
      [pkg.source, 'package.json "source"'],
      [pkg.main, 'package.json "main"'],
      [pkg.module, 'package.json "module"'],
      [typeof pkg.browser === 'string' ? pkg.browser : undefined, 'package.json "browser"'],
    ];
    if (typeof pkg.bin === 'string') fields.push([pkg.bin, 'package.json "bin"']);
    else if (pkg.bin) for (const v of Object.values(pkg.bin)) fields.push([v, 'package.json "bin"']);
    const collectExports = (value: unknown): void => {
      if (typeof value === 'string') fields.push([value, 'package.json "exports"']);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectExports);
    };
    collectExports(pkg.exports);
    for (const [field, reason] of fields) {
      if (typeof field !== 'string') continue;
      for (const c of candidatesFor(dir, field)) {
        const hit = resolver.lookup(c);
        if (hit) {
          markEntry(hit, reason);
          break;
        }
      }
    }
    const prefix = dir ? `${dir}/` : '';
    for (const id of ids) {
      if (!id.startsWith(prefix)) continue;
      const rel = id.slice(prefix.length);
      if (/^(src\/)?(main|index|server|app|cli|bootstrap)\.[cm]?[jt]sx?$/.test(rel)) markEntry(id, 'conventional entry file');
      if (/^(src\/)?(App|app)\.vue$/.test(rel)) markEntry(id, 'root component');
      if (/^app\/(root|entry\.client|entry\.server)\.[jt]sx?$/.test(rel)) markEntry(id, 'framework entry');
      if (/^(src\/)?app\/layout\.[jt]sx?$/.test(rel)) markEntry(id, 'root layout');
      if (/^(src\/)?pages\/_app\.[jt]sx?$/.test(rel)) markEntry(id, 'custom App');
      if (/^(src\/)?hooks\.(server|client)\.[jt]s$/.test(rel)) markEntry(id, 'SvelteKit hooks');
    }
  }
  for (const s of ctx.scriptEntries) markEntry(resolver.lookup(s), 'referenced by a script / index.html');
  // Build tool configs (tsup / vite / webpack / rollup…) point at entry files: `entry: 'src/cli.ts'`.
  // Only real tool configs count (`tsup.config.ts`, not an app's `config.ts`), and their own imports are not entries.
  // Files they name as test setup (`setupFiles`, `globalSetup`) are test support, not production code.
  const testSupport = new Set<string>();
  const lookupFrom = (dir: string, ref: string): string | undefined =>
    resolver.lookup(path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, ref.replace(/^<rootDir>\//, ''))));
  for (const st of states.values()) {
    const base = path.posix.basename(st.id);
    if (!isConfigFile(st.id) && !/^electron([.-]main)?\.[cm]?[jt]s$/.test(base)) continue;
    const dir = path.posix.dirname(st.id);
    const imported = new Set([...st.parsed.imports.map((i) => i.specifier), ...st.parsed.reexports.map((r) => r.specifier)]);
    for (const m of st.text.matchAll(/['"`]((?:\.{1,2}\/)?[\w@\-./]+\.(?:[cm]?[jt]sx?|vue|svelte))['"`]/g)) {
      if (imported.has(m[1])) continue;
      const candidate = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, m[1]));
      if (candidate === st.id) continue;
      markEntry(resolver.lookup(candidate), `referenced in ${base}`);
    }
    for (const ref of testSetupRefs(st.text)) {
      const hit = lookupFrom(dir, ref);
      if (hit) testSupport.add(hit);
    }
  }
  // Jest configured in package.json (`"jest": { "setupFilesAfterEnv": [...] }`).
  for (const m of ctx.manifests) {
    const jest = (m.pkg as PackageJson & { jest?: unknown }).jest;
    if (!jest || typeof jest !== 'object') continue;
    for (const ref of testSetupRefs(JSON.stringify(jest))) {
      const hit = lookupFrom(m.dir || '.', ref);
      if (hit) {
        testSupport.add(hit);
        markEntry(hit, 'referenced in package.json "jest"');
      }
    }
  }

  /* -------------------------------- Metrics ---------------------------------- */
  const edges = [...edgeMap.values()];
  const allAdj = buildAdjacency(ids, edges);
  const runtimeAdj = buildAdjacency(
    ids,
    edges.filter((e) => !e.typeOnly),
  );
  const revAdj = reverse(allAdj);
  const importance = pageRank(allAdj);

  const sccs = stronglyConnectedComponents(runtimeAdj);
  const sccOf = new Map<string, number>();
  sccs.forEach((c, i) => c.forEach((id) => sccOf.set(id, i)));
  for (const e of edges) {
    const a = sccOf.get(e.source);
    if (a !== undefined && a === sccOf.get(e.target) && !e.typeOnly) e.inCycle = true;
  }
  const cycles = sccs.map((c) => {
    const sample = sampleCycle(runtimeAdj, c);
    return [...sample, ...c.filter((id) => !sample.includes(id))];
  });

  /* ---------------------------------- Git ------------------------------------ */
  let git: Awaited<ReturnType<typeof analyzeGit>>;
  if (options.git !== false) {
    progress('git');
    const { head, key } = await gitCacheKey(root, ids);
    if (cache?.git?.key === key) git = cache.git.result;
    else {
      git = options.persist ? loadGitCache(root, head, key) : undefined;
      if (!git) {
        git = await analyzeGit(root, idSet).catch(() => undefined);
        if (git && options.persist) saveGitCache(root, head, key, git);
      }
      if (cache) cache.git = { key, result: git };
    }
  }

  progress('insights');

  /* ----------------------------- Unused exports ------------------------------ */
  const used = new Map<string, Set<string>>();
  const allUsed = new Set<string>();
  const markUsed = (file: string, name: string, depth = 0): void => {
    if (depth > 15) return;
    const st = states.get(file);
    if (!st) return;
    if (name === '*') {
      if (allUsed.has(file)) return;
      allUsed.add(file);
      for (const re of st.parsed.reexports) {
        const t = resolveFile(file, re.specifier);
        if (!t) continue;
        if (re.star) markUsed(t, '*', depth + 1);
        else re.names.forEach((n) => markUsed(t, n.imported, depth + 1));
      }
      return;
    }
    let set = used.get(file);
    if (!set) {
      set = new Set();
      used.set(file, set);
    }
    if (set.has(name)) return;
    set.add(name);
    for (const re of st.parsed.reexports) {
      if (re.star) continue;
      for (const n of re.names) {
        if (n.exported !== name) continue;
        const t = resolveFile(file, re.specifier);
        if (t) markUsed(t, n.imported, depth + 1);
      }
    }
    if (!st.parsed.localExports.some((e) => e.name === name)) {
      for (const re of st.parsed.reexports) {
        if (!re.star) continue;
        const t = resolveFile(file, re.specifier);
        if (t) markUsed(t, name, depth + 1);
      }
    }
  };
  for (const e of edges) {
    if (e.kind === 'side-effect') continue;
    if (e.kind === 'dynamic' || e.kind === 'require' && e.names.includes('*')) {
      markUsed(e.target, '*');
      continue;
    }
    if (e.kind === 'reexport') continue; // handled through the chain when the barrel is used
    for (const n of e.names) markUsed(e.target, n);
  }
  // Things consumed by frameworks / tools count as used.
  const frameworkConsumed = (id: string): boolean => {
    const st = states.get(id)!;
    return (
      entries.has(id) ||
      roles.has(id) ||
      isTestFile(id) ||
      /\.(stories|story)\./.test(id) ||
      /\.d\.ts$/.test(id) ||
      isConfigFile(id) ||
      st.ext === '.vue' ||
      st.ext === '.svelte' ||
      st.ext === '.astro'
    );
  };
  for (const id of ids) if (frameworkConsumed(id)) markUsed(id, '*');

  const unusedExports: ReportData['insights']['unusedExports'] = [];
  const unusedByFile = new Map<string, Set<string>>();
  for (const st of states.values()) {
    if (allUsed.has(st.id)) continue;
    const set = used.get(st.id);
    for (const e of st.parsed.localExports) {
      if (e.local === '__module_exports__') continue;
      if (set?.has(e.name)) continue;
      // CommonJS modules required without destructuring use everything.
      unusedExports.push({ file: st.id, name: e.name, line: e.line, typeOnly: e.typeOnly || undefined });
      const s = unusedByFile.get(st.id) ?? new Set();
      s.add(e.name);
      unusedByFile.set(st.id, s);
    }
  }

  /* --------------------------------- Files ----------------------------------- */
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of edges) {
    fanOut.set(e.source, (fanOut.get(e.source) ?? 0) + 1);
    fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
  }

  const includeSource = options.includeSource !== false;
  let sourceBudget = MAX_TOTAL_SOURCE;
  const files: FileInfo[] = [];
  for (const st of states.values()) {
    const p = st.parsed;
    const fi = fanIn.get(st.id) ?? 0;
    const fo = fanOut.get(st.id) ?? 0;
    const isEntry = entries.has(st.id);
    const role: FileRole | undefined = roles.get(st.id);
    const kind = classifyFile(st.id, p, role, isEntry);
    const dir = path.posix.dirname(st.id);
    const unusedNames = unusedByFile.get(st.id);
    const info: FileInfo = {
      id: st.id,
      name: path.posix.basename(st.id),
      dir: dir === '.' ? '' : dir,
      ext: st.ext,
      language: p.language,
      kind,
      loc: p.loc,
      sloc: p.sloc,
      bytes: st.bytes,
      complexity: p.complexity,
      maxComplexity: p.maxComplexity,
      symbols: p.symbols,
      exports: dedupeExports(p, unusedNames),
      assets: st.assets,
      unresolved: st.unresolved,
      isEntry,
      entryReason: entries.get(st.id),
      isTest: kind === 'test',
      isGenerated: p.isGenerated || undefined,
      inCycle: sccOf.has(st.id) || undefined,
      directives: p.directives.length ? p.directives : undefined,
      description: p.description,
      todos: p.todos,
      git: git?.files.get(st.id),
      metrics: {
        fanIn: fi,
        fanOut: fo,
        importance: importance.get(st.id) ?? 0,
        instability: fi + fo ? Math.round((fo / (fi + fo)) * 100) / 100 : 0,
        externalImports: st.packages.size,
      },
      parseError: p.parseError,
    };
    // dev-tools: `any` in a declaration file or generated code says nothing about the project's own habits.
    if (p.escapes && !st.id.endsWith('.d.ts') && !p.isGenerated) info.escapes = p.escapes;
    // test-intelligence: e2e specs reach routes by URL, not by import.
    if (kind === 'test' && p.urlVisits?.length) info.urlVisits = p.urlVisits;
    const orphanCandidate =
      fi === 0 &&
      !isEntry &&
      !role &&
      !['test', 'story', 'config', 'script'].includes(kind) &&
      !st.id.endsWith('.d.ts') &&
      !p.isGenerated &&
      !/(^|\/)(examples?|demo|docs?|playground|fixtures|__fixtures__|scripts)\//.test(st.id);
    if (orphanCandidate) info.orphan = true;
    if (includeSource && st.bytes <= MAX_SOURCE_BYTES && sourceBudget > 0) {
      info.source = st.text;
      sourceBudget -= st.bytes;
    }
    files.push(info);
  }

  /* ------------------------------ Packages ----------------------------------- */
  let packages: PackageInfo[] = [...pkgUsage.entries()].map(([name, u]) => {
    return {
      name,
      version: undefined as string | undefined,
      declaredAs: undefined as PackageInfo['declaredAs'],
      builtin: u.builtin,
      importedBy: [...u.files].sort(),
      names: [...u.names.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([n]) => n),
      importCount: u.count,
      typeOnly: u.typeOnly,
    };
  });
  const manifests = packageManifests(ctx, root, states);
  const production = productionFiles(files, runtimeAdj, testSupport);
  const bundled = browserBundled(ctx, resolver, runtimeAdj);
  const health = markPackageHealth(packages, manifests, {
    isProduction: (id) => production.has(id) && !bundled(id),
    loads: (name, id) => pkgUsage.get(name)?.loadedBy.has(id) ?? false,
    binsOf: binLookup(root),
    implicitUse,
  });
  const missingSet = new Set(health.missing.map((m) => m.name));
  for (const p of packages) {
    // Only a declaration that serves the importing files counts (a sibling workspace's does not).
    const declared = health.declaredAs.get(p.name);
    p.version = declared?.version;
    p.declaredAs = declared?.declaredAs;
    if (missingSet.has(p.name)) p.missing = true;
  }
  // Unused declared dependencies are listed as packages too so they show up in the Packages view. A package
  // that one package.json declares without using, while other code imports it, keeps a single entry.
  const unusedIn = new Map<string, string[]>();
  for (const u of health.unusedDeclarations) unusedIn.set(u.name, [...(unusedIn.get(u.name) ?? []), u.manifest]);
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const [name, dirs] of unusedIn) {
    const existing = byName.get(name);
    if (existing) {
      existing.unusedIn = dirs;
      continue;
    }
    const d = manifests.find((m) => m.dir === dirs[0])?.declared.get(name);
    packages.push({ name, version: d?.version, declaredAs: d?.declaredAs, builtin: false, importedBy: [], names: [], importCount: 0, typeOnly: false, unused: true, unusedIn: dirs });
  }
  // dev-tools: what is installed for the declared packages (version, license, install scripts); not for snapshots.
  if (!overlay) {
    const declaredNames = packages.filter((p) => p.declaredAs && !p.builtin).map((p) => p.name);
    const installed = readInstalled(root, ctx.workspaces.map((w) => w.dir), declaredNames);
    for (const p of packages) {
      const info = installed.get(p.name);
      if (!info) continue;
      p.installed = info.version;
      p.license = info.license;
      p.licenseRisk = info.licenseRisk;
      if (info.installScripts) p.installScripts = info.installScripts;
    }
  }

  /* --------------------------- Complex functions ----------------------------- */
  // Inline callbacks and inner helpers are measured on their own: the most complex one of each symbol is
  // listed as `outer › app.get callback` (it counts for `check --max-complexity` like any function).
  const complexFunctions = files
    .filter((f) => f.kind !== 'test')
    .flatMap((f) =>
      f.symbols.flatMap((s) => {
        const list: ReportData['insights']['complexFunctions'] = [];
        if ((s.kind === 'function' || s.kind === 'component' || s.kind === 'hook') && (s.complexity ?? 0) > 1) {
          list.push({ symbol: s.id, file: f.id, name: s.name, complexity: s.complexity ?? 0, line: s.line, loc: s.loc });
        }
        if (s.nested) list.push({ symbol: s.id, file: f.id, name: `${s.name} › ${s.nested.name}`, complexity: s.nested.complexity, line: s.nested.line, loc: s.nested.loc });
        return list;
      }),
    )
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 40);

  /* -------------------------------- Hotspots --------------------------------- */
  let hotspots: ReportData['insights']['hotspots'] = [];
  if (git) {
    const candidates = files.filter((f) => f.git && f.git.commits >= 2 && f.kind !== 'test' && f.kind !== 'config');
    const maxCommits = Math.max(1, ...candidates.map((f) => f.git!.commits));
    const maxComplexity = Math.max(1, ...candidates.map((f) => f.complexity));
    hotspots = candidates
      .map((f) => ({
        file: f.id,
        commits: f.git!.commits,
        complexity: f.complexity,
        loc: f.loc,
        score: Math.round((f.git!.commits / maxCommits) * (f.complexity / maxComplexity) * 1000) / 10,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }

  /* ----------------------------- Tests & owners ------------------------------ */
  const testMap = buildTestMap(files, edges);
  for (const f of files) {
    const covering = testMap.coveredBy.get(f.id);
    if (covering?.length && f.kind !== 'test') f.tests = covering.slice(0, 20);
  }
  // --- test-intelligence: line coverage from the reports the test runner wrote ---
  const mtimes = new Map(discovered.files.map((f) => [f.id, f.mtimeMs]));
  // Snapshots of other refs and what-ifs have no report of their own; a staged run measures the index's
  // changes, and a committed run (daily-loop's pre-push `check --changed --committed`) the commits to push.
  const coverageOff = options.coverage === false || (!!overlay && !options.staged && !options.committed) || config.coverage?.enabled === false;
  let coverage: LoadedCoverage | undefined;
  let coverageInfo: CoverageSummary | undefined;
  if (!coverageOff) {
    const paths = options.coverage || config.coverage?.paths;
    try {
      coverage = loadCoverage(root, { dirs: ctx.workspaces.map((w) => w.dir).filter(Boolean), paths: paths && paths.length ? paths : undefined, ids: idSet });
    } catch (error) {
      warnings.push(`Could not read the coverage reports: ${(error as Error).message}`);
    }
    if (coverage) {
      warnings.push(...coverage.warnings);
      for (const f of files) {
        const data = coverage.files.get(f.id);
        if (data) f.coverage = fileCoverage(data, mtimes.get(f.id) || undefined);
      }
    }
  }
  // --- /test-intelligence ---
  const ownerFiles = readText ? projectFiles(root, readText) : undefined;
  let owners: CodeOwners | undefined = loadCodeOwners([root], '', ownerFiles);
  if (!owners && git) {
    const top = (await runGit(root, ['rev-parse', '--show-toplevel']))?.trim();
    const prefix = (await runGit(root, ['rev-parse', '--show-prefix']))?.trim() ?? '';
    if (top && path.resolve(top) !== root) owners = loadCodeOwners([top], prefix, ownerFiles);
  }
  if (owners) {
    for (const f of files) {
      const o = owners.ownersOf(f.id);
      if (o) f.owners = o;
    }
  }

  /* ---------------------------- Knowledge silos ------------------------------ */
  const BOT_RE = /\[bot\]|dependabot|renovate|github-actions|semantic-release/i;
  const byImportance = files.filter(isTestableSource).sort((a, b) => b.metrics.importance - a.metrics.importance);
  const importantSet = new Set(byImportance.slice(0, Math.max(10, Math.round(byImportance.length * 0.3))).map((f) => f.id));
  const knowledgeSilos = byImportance
    .filter((f) => importantSet.has(f.id) && f.git && f.git.commits >= 4 && f.git.ownership >= 0.8 && !BOT_RE.test(f.git.authors[0]?.name ?? ''))
    .map((f) => ({ file: f.id, author: f.git!.authors[0].name, share: f.git!.ownership, lastActive: f.git!.authors[0].last }))
    .slice(0, 40);

  /* ------------------------------ Deprecations ------------------------------- */
  const symbolUsers = new Map<string, Set<string>>();
  for (const e of symbolEdgeMap.values()) {
    const set = symbolUsers.get(e.target) ?? new Set<string>();
    set.add(e.source);
    symbolUsers.set(e.target, set);
  }
  const edgesByTarget = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    const list = edgesByTarget.get(e.target) ?? [];
    list.push(e);
    edgesByTarget.set(e.target, list);
  }
  const deprecated: ReportData['insights']['deprecated'] = [];
  for (const f of files) {
    for (const s of f.symbols) {
      if (s.deprecated === undefined) continue;
      const users = new Set(symbolUsers.get(s.id) ?? []);
      for (const e of edgesByTarget.get(f.id) ?? []) if (e.names.includes(s.name) || (s.isDefault && e.names.includes('default'))) users.add(e.source);
      deprecated.push({ symbol: s.id, file: f.id, name: s.name, line: s.line, note: s.deprecated, usages: [...users].slice(0, 30) });
    }
  }
  deprecated.sort((a, b) => b.usages.length - a.usages.length);

  /* ------------------------ Rules, API map and changes ----------------------- */
  const ruleViolations = evaluateRules(config, edges);
  const apiCalls = linkApiCalls(
    [...states.values()].filter((st) => st.parsed.apiCalls.length).map((st) => ({ file: st.id, symbols: st.parsed.symbols, raw: st.parsed.apiCalls })),
    routes,
  );
  // Test runners per workspace ('' = the root, which also sees the workspaces' runners).
  const rootRunners = detectTestRunners([ctx.pkg, ...ctx.workspaces.map((w) => w.pkg)], ctx.packageManager);
  const testRunners: TestRunners = {};
  if (rootRunners.unit || rootRunners.e2e) testRunners[''] = runnerInfo(rootRunners, ctx.packageManager);
  for (const w of ctx.workspaces) {
    const own = detectTestRunners([w.pkg], ctx.packageManager);
    if (w.dir && (own.unit || own.e2e)) testRunners[w.dir] = runnerInfo(own, ctx.packageManager);
  }
  // test-intelligence: Playwright's testDir (`tests/` in a fresh `npm init playwright` project) holds e2e specs.
  // Coverage thresholds in a runner config are switched off when `test --coverage` runs only some tests.
  const runnerFiles = projectFiles(root, readText);
  const readRunnerFile = (rel: string): string | undefined => runnerFiles.read(path.join(root, rel));
  const pkgOf = new Map<string, PackageJson>([['', ctx.pkg], ...ctx.workspaces.map((w) => [w.dir, w.pkg] as [string, PackageJson])]);
  for (const [dir, info] of Object.entries(testRunners)) {
    if (info.e2e === 'playwright') {
      const e2eDir = playwrightTestDir(dir, readRunnerFile);
      if (e2eDir !== undefined) info.e2eDir = e2eDir;
    }
    if (hasCoverageThresholds(dir, info.unit, readRunnerFile, pkgOf.get(dir))) info.coverageThresholds = true;
  }
  // --- test-intelligence: the project's line coverage, and packages with tests no report describes ---
  if (coverage?.reports.length) {
    const perFile = new Map<string, NonNullable<FileInfo['coverage']>>();
    for (const f of files) if (f.coverage) perFile.set(f.id, f.coverage);
    const byId = new Map(files.map((f) => [f.id, f]));
    coverageInfo = coverageSummary(coverage, perFile, (id) => !!byId.get(id) && isTestableSource(byId.get(id)!), isPartialRun(root, coverage));
    const unmeasured = unmeasuredPackages(coverage, testMap.testFiles, testRunners, ctx.workspaces.map((w) => w.dir).filter(Boolean));
    if (unmeasured.length) coverageInfo.unmeasured = unmeasured;
  }
  // --- clone-radar: copy-paste clones from the token index (tokens are cached with the parse results) ---
  const settings = options.clones === false ? undefined : cloneSettings(config.clones);
  const cloneTokensOf = (f: FileInfo): ParsedFile['tokens'] => states.get(f.id)?.parsed.tokens ?? tokensFromText(states.get(f.id));
  let clones: ProjectClones | undefined;
  if (settings) {
    try {
      // Only files changed since the last analysis are matched again. Overlays (snapshots, what-ifs) read
      // the working tree's pairs but keep them: the next save is compared with the working tree again.
      const cloneCache = cache && (overlay ? { ...(cache.clones ?? createCloneCache()) } : (cache.clones ??= createCloneCache()));
      clones = projectClones(files, cloneTokensOf, settings, { edges, coupling: git?.coupling, cache: cloneCache });
    } catch (error) {
      warnings.push(`Could not look for copy-paste clones: ${(error as Error).message}`);
    }
  }
  let changes: ChangeSet | undefined;
  let dirty = false;
  // Code lines of a file's current text, kept per content in the cache (a save re-scans only that file).
  const codeLinesMemo = cache ? (cache.codeLines ??= new Map()) : undefined;
  const codeLinesOf = (id: string, text: string): Set<number> => {
    const hash = states.get(id)?.hash;
    if (!codeLinesMemo || !hash) return codeLinesFor(id, text);
    const key = `${id}\0${hash}`;
    let lines = codeLinesMemo.get(key);
    if (!lines) {
      codeLinesMemo.set(key, (lines = codeLinesFor(id, text)));
      if (codeLinesMemo.size > CODE_LINES_LIMIT) codeLinesMemo.delete(codeLinesMemo.keys().next().value!);
    }
    return lines;
  };
  /**
   * Identity of a changed file's diff in this run — its content (parse-cache hash) and its diff — so work
   * on diffs (comment-only classification, meaningful lines) is not repeated for files unchanged since.
   */
  const diffKeys = new Map<ChangedFile, string | undefined>();
  const diffKeyOf = (c: ChangedFile): string | undefined => {
    if (diffKeys.has(c)) return diffKeys.get(c);
    const hash = states.get(c.id)?.hash;
    let key: string | undefined;
    // A new file's diff is its content; any other diff depends on the base too.
    if (cache && hash && c.status !== 'deleted') key = c.status === 'added' || c.status === 'untracked' ? `${c.id}\0${hash}\0${c.status}\0${c.diff?.length ?? -1}` : `${c.id}\0${hash}\0${c.status}\0${c.diff ? sha1(c.diff) : '-'}`;
    diffKeys.set(c, key);
    return key;
  };
  // A ref under review (review-mode) needs no history: its changes come from git directly.
  const reviewing = options.head !== undefined && !!overlay;
  // Also without history (no commits yet): then every file is new.
  if ((git || reviewing || options.git !== false) && options.changes !== false) {
    progress('changes');
    const raw = await analyzeChanges(root, idSet, {
      base: options.base ?? config.base,
      baseFromConfig: options.base === undefined,
      fileText: (id) => states.get(id)?.text,
      index: options.staged,
      head: reviewing ? options.head : undefined,
      committed: options.committed,
    }).catch((error: unknown) => {
      // An explicit --base that names no commit must fail, not fall back silently to another comparison.
      if (error instanceof AnalyzeError) throw error;
      return undefined;
    });
    dirty = !reviewing && !!(await runGit(root, ['status', '--porcelain']))?.trim();
    if (raw && (raw.files.length || raw.mode === 'branch')) {
      changes = buildChangeSet({
        raw,
        files,
        edges,
        symbolEdges: [...symbolEdgeMap.values()],
        routes,
        apiCalls,
        hotspots,
        testMap,
        runners: rootRunners,
        testRunners,
        fileText: (id) => states.get(id)?.text,
        memo: cache ? (cache.codeChanges ??= new Map()) : undefined,
        memoKey: diffKeyOf,
        codeLinesOf,
        owners,
        user: git?.summary.user,
        userEmail: git?.summary.userEmail,
        clones: clones?.families,
        cloneMinSimilarity: settings?.minSimilarity,
      });
      // --- test-intelligence: "Tests to run" is what `code-visualizer test` runs: tests importing the
      // change (uncapped, test helpers resolved to the tests using them) and e2e specs visiting affected routes.
      // The command is the plan's own: one per package, run from its folder (as `test` runs them).
      const plan = selectTests({ files, edges, routes, apiCalls, project: { testRunners } }, changes.files.map((f) => f.id), { commentOnly: changes.commentOnly, full: false });
      const selectedTests = plan.selected.map((s) => s.file).sort();
      const command = plan.commands.length ? plan.commands.map((c) => c.display).join(' && ') : undefined;
      const runner = plan.commands.length ? [...new Set(plan.commands.map((c) => c.runner))].join(' + ') : undefined;
      changes.tests = { ...changes.tests, files: selectedTests, command, runner };
      // --- test-intelligence: how much of the added code a test ran ---
      if (coverage) {
        const kindOf = new Map(files.map((f) => [f.id, f]));
        const patch = patchCoverage(changes.files, coverage, {
          isSource: (id) => !!kindOf.get(id) && isTestableSource(kindOf.get(id)!),
          codeLines: (id) => {
            const text = states.get(id)?.text;
            return text === undefined ? undefined : codeLinesOf(id, text);
          },
          mtime: (id) => mtimes.get(id) || undefined,
        });
        if (patch) changes.coverage = patch;
      }
    }
  }

  /* ------------------------------ Apply scope -------------------------------- */
  let roleOf: Map<string, ScopeRole> | undefined;
  if (scope.type === 'file') {
    const target = scope.path!;
    const deps = reachable(allAdj, target, options.depth ?? Infinity);
    const dependents = reachable(revAdj, target, options.depth ?? 2);
    roleOf = new Map();
    for (const id of dependents.keys()) roleOf.set(id, 'dependent');
    for (const id of deps.keys()) roleOf.set(id, 'dependency');
    roleOf.set(target, 'focus');
  } else if (scope.type === 'directory') {
    const dir = scope.path!;
    roleOf = new Map();
    for (const id of ids) if (!dir || id.startsWith(`${dir}/`)) roleOf.set(id, 'member');
    for (const e of edges) {
      const s = roleOf.get(e.source);
      const t = roleOf.get(e.target);
      if (s === 'member' && !t) roleOf.set(e.target, 'context');
      if (t === 'member' && !s) roleOf.set(e.source, 'context');
    }
  }

  let scopedFiles = files;
  let scopedEdges = edges;
  let scopedRoutes = routes;
  let symbolEdges = [...symbolEdgeMap.values()];
  if (roleOf) {
    const r = roleOf;
    const core = (id: string): boolean => r.has(id) && r.get(id) !== 'context';
    scopedFiles = files.filter((f) => r.has(f.id));
    for (const f of scopedFiles) f.scope = r.get(f.id);
    for (const f of scopedFiles) if (f.scope === 'context') delete f.source;
    scopedEdges = edges.filter((e) => r.has(e.source) && r.has(e.target) && (core(e.source) || core(e.target)));
    scopedRoutes = routes.filter((x) => core(x.file));
    const fileOfSymbol = (id: string): string => id.slice(0, id.indexOf('#'));
    symbolEdges = symbolEdges.filter((e) => r.has(fileOfSymbol(e.source)) && r.has(fileOfSymbol(e.target)));
    packages = packages
      .map((p) => ({ ...p, importedBy: p.importedBy.filter(core) }))
      .filter((p) => p.importedBy.length || (scope.type === 'directory' && !scope.path && p.unused));
  }
  const coreFiles = scopedFiles.filter((f) => f.scope !== 'context');
  const coreSet = new Set(coreFiles.map((f) => f.id));

  const insights: ReportData['insights'] = {
    cycles: cycles.filter((c) => c.some((id) => coreSet.has(id))),
    orphans: coreFiles.filter((f) => f.orphan).map((f) => f.id),
    unusedExports: unusedExports.filter((u) => coreSet.has(u.file)),
    unusedDependencies: roleOf ? [] : health.unused,
    missingDependencies: health.missing
      .map((m) => ({ ...m, files: m.files.filter((f) => coreSet.has(f)) }))
      .filter((m) => m.files.length),
    complexFunctions: complexFunctions.filter((c) => coreSet.has(c.file)),
    hotspots: hotspots.filter((h) => coreSet.has(h.file)),
    changeCoupling: (git?.coupling ?? []).filter((c) => coreSet.has(c.a) || coreSet.has(c.b)).slice(0, 60),
    duplicateSymbols: findDuplicates(coreFiles),
    untested: coreFiles
      .filter((f) => isTestableSource(f) && !f.tests?.length && !f.isGenerated)
      .sort((a, b) => b.metrics.importance - a.metrics.importance || b.loc - a.loc)
      .slice(0, 50)
      .map((f) => f.id),
    deprecated: deprecated.filter((d) => coreSet.has(d.file)),
    ruleViolations: ruleViolations.filter((v) => coreSet.has(v.source)),
    knowledgeSilos: knowledgeSilos.filter((k) => coreSet.has(k.file)),
    devDependenciesInProduction: health.devDependenciesInProduction
      .map((d) => ({ ...d, files: d.files.filter((f) => coreSet.has(f)) }))
      .filter((d) => d.files.length),
  };
  // --- clone-radar ---
  if (clones) {
    insights.clones = clones.families.filter((fam) => fam.fragments.some((f) => coreSet.has(f.file))).slice(0, MAX_FAMILIES);
    insights.cloneBoilerplate = clones.boilerplate;
    rememberDeclarations(insights.clones, clones.declarations);
  }
  if (!roleOf && health.unusedDeclarations.length) insights.unusedDeclarations = health.unusedDeclarations;
  // --- dev-tools: risky patterns in the project's own code, most severe first ---
  // Tests, stories, fixtures and examples set things up for themselves: their credentials and env reads are not the project's.
  const inTestContext = (f: FileInfo): boolean => f.isTest || f.kind === 'story' || isTestContext(f.id);
  const findings: RiskFinding[] = [];
  for (const f of coreFiles) {
    const raw = states.get(f.id)?.parsed.risks;
    if (raw?.length && !f.isGenerated) findings.push(...toFindings(f.id, raw, inTestContext(f)));
  }
  if (findings.length) {
    insights.risks = sortFindings(findings).slice(0, MAX_RISKS);
    if (findings.length > MAX_RISKS) insights.risksOmitted = findings.length - MAX_RISKS;
  }
  // --- dev-tools: environment variables; a scoped report or a snapshot says nothing about the whole project ---
  let env: EnvReport | undefined;
  if (!roleOf && !overlay) {
    const reads = coreFiles.flatMap((f) => {
      const list = states.get(f.id)?.parsed.env;
      return list?.length && !inTestContext(f) ? [{ file: f.id, reads: list }] : [];
    });
    const envFiles = await readEnvFiles(root, ctx.workspaces.map((w) => w.dir), options.git !== false);
    if (reads.length || envFiles.length) env = buildEnvReport(reads, envFiles);
  }

  /* --------------------------------- Stats ----------------------------------- */
  const languages = new Map<Language, { files: number; loc: number }>();
  for (const f of coreFiles) {
    const l = languages.get(f.language) ?? { files: 0, loc: 0 };
    l.files++;
    l.loc += f.loc;
    languages.set(f.language, l);
  }
  const allSymbols = coreFiles.flatMap((f) => f.symbols);
  const countKind = (k: SymbolInfo['kind']): number => allSymbols.filter((s) => s.kind === k).length;
  const complexities = allSymbols.filter((s) => s.complexity && (s.kind === 'function' || s.kind === 'component' || s.kind === 'hook'));
  const testable = coreFiles.filter(isTestableSource);
  const stats: Stats = {
    files: coreFiles.length,
    loc: coreFiles.reduce((n, f) => n + f.loc, 0),
    sloc: coreFiles.reduce((n, f) => n + f.sloc, 0),
    symbols: allSymbols.length,
    components: countKind('component'),
    hooks: countKind('hook'),
    functions: countKind('function'),
    classes: countKind('class'),
    interfaces: countKind('interface'),
    types: countKind('type'),
    enums: countKind('enum'),
    constants: countKind('constant'),
    variables: countKind('variable'),
    routes: scopedRoutes.length,
    packages: packages.filter((p) => !p.builtin && p.importedBy.length).length,
    internalEdges: scopedEdges.length,
    testFiles: coreFiles.filter((f) => f.kind === 'test').length,
    todos: coreFiles.reduce((n, f) => n + f.todos.length, 0),
    avgComplexity: complexities.length
      ? Math.round((complexities.reduce((n, s) => n + (s.complexity ?? 0), 0) / complexities.length) * 10) / 10
      : 0,
    testReach: testable.length ? Math.round((testable.filter((f) => f.tests?.length).length / testable.length) * 1000) / 1000 : 0,
    durationMs: 0,
    cache: { reused, parsed: parsedCount, source: reused ? cacheOrigin : 'cold' },
  };
  // --- clone-radar: lines of source files (tests left out) that are copies, and their share ---
  let duplication: { ratio: number; lines: number; families: number; minSimilarity: number } | undefined;
  if (clones) {
    let measuredLines = 0;
    let duplicated = 0;
    for (const f of coreFiles) {
      if (!clones.measured.has(f.id)) continue;
      measuredLines += f.loc;
      duplicated += clones.duplicatedLines.get(f.id) ?? 0;
    }
    stats.duplicatedLines = duplicated;
    const counted = (insights.clones ?? []).filter((fam) => isSignificant(fam, settings!.minSimilarity)).length;
    duplication = { ratio: measuredLines ? duplicated / measuredLines : 0, lines: duplicated, families: counted, minSimilarity: settings!.minSimilarity };
  }
  // test-intelligence: a report of only the affected tests (`test --coverage`) says nothing about the project.
  // …nor does one that leaves out a package with tests.
  if (coverageInfo && coverageInfo.lines.total && !coverageInfo.partial && !coverageInfo.unmeasured && !roleOf) stats.lineCoverage = coverageInfo.pct;

  const project: ReportData['project'] = {
    name: ctx.pkg.name ?? path.basename(root),
    version: ctx.pkg.version,
    description: ctx.pkg.description,
    rootName: path.basename(root),
    rootPath: root,
    frameworks: ctx.frameworks,
    languages: [...languages.entries()].map(([language, v]) => ({ language, ...v })).sort((a, b) => b.loc - a.loc),
    packageManager: ctx.packageManager,
    typescript: ctx.hasTypeScript || coreFiles.some((f) => f.language === 'typescript'),
    workspaces: ctx.workspaces.length ? ctx.workspaces.map((w) => w.dir) : undefined,
    scripts: ctx.pkg.scripts,
    engines: ctx.pkg.engines,
    license: ctx.pkg.license,
    git: git?.info,
    subprojects: discovered.excludedDirs.length ? discovered.excludedDirs : undefined,
    testRunners: Object.keys(testRunners).length ? testRunners : undefined,
  };

  const folders = buildFolders(coreFiles);
  enrichFolders(folders, coreFiles);

  const healthReport = computeHealth({
    files: coreFiles,
    insights,
    stats,
    hasGit: !!git,
    testFiles: testMap.testFiles.length,
    exportsTotal: coreFiles.reduce((n, f) => n + f.exports.filter((e) => !e.typeOnly && e.name !== '*').length, 0),
    lineCoverage: stats.lineCoverage,
    duplication,
  });
  const point: HistoryPoint = {
    date: Date.now(),
    commit: git?.summary.head,
    branch: git?.summary.branch,
    dirty: dirty || undefined,
    score: healthReport.score,
    files: stats.files,
    loc: stats.loc,
    cycles: insights.cycles.length,
    unusedExports: insights.unusedExports.filter((u) => !u.typeOnly).length,
    avgComplexity: stats.avgComplexity,
    testReach: stats.testReach,
    todos: stats.todos,
  };
  if (stats.lineCoverage !== undefined) point.lineCoverage = stats.lineCoverage;
  if (duplication) point.duplication = Math.round(duplication.ratio * 10000) / 10000;
  const history = options.history === false || roleOf || overlay ? [point] : mergeHistory(readHistory(root), point);
  const coreApiCalls = apiCalls.filter((c) => coreSet.has(c.file));

  const partial: Omit<ReportData, 'tour'> = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'code-visualizer', version: options.toolVersion ?? '0.0.0' },
    generatedAt: new Date().toISOString(),
    scope,
    options: { includeSource, git: !!git },
    project,
    files: scopedFiles.sort((a, b) => a.id.localeCompare(b.id)),
    edges: scopedEdges,
    packages: packages.sort((a, b) => b.importedBy.length - a.importedBy.length || a.name.localeCompare(b.name)),
    symbolEdges,
    routes: scopedRoutes,
    insights,
    folders,
    stats,
    git: git?.summary,
    changes,
    health: healthReport,
    history,
    apiCalls: coreApiCalls,
    tours: loadTours(root),
    config: loadedConfig.file
      ? {
          file: loadedConfig.file,
          rules: config.rules?.length ?? 0,
          layers: config.layers?.map((l) => (Array.isArray(l) ? l.join(', ') : l)),
          error: loadedConfig.error,
          includeSubprojects: config.includeSubprojects,
          // --- agent-guardrails: the named rules, for session briefs and the AGENTS.md block ---
          ...(config.rules?.length ? { ruleList: ruleList(config.rules) } : {}),
        }
      : undefined,
    warnings,
  };
  if (coverageInfo) partial.coverage = coverageInfo;
  if (env) partial.env = env;
  /**
   * clone-radar: the head as the delta sees it — judged with the base's boilerplate fingerprints, so a copy
   * that tips a fingerprint over the limit does not hide itself (nor does one that drops below it turn old
   * copies into new ones). The same analysis when both sides count the same boilerplate.
   */
  const withBaseBoilerplate = (head: typeof partial, baseBoilerplate: number[] | undefined): typeof partial => {
    if (!clones || !settings || !baseBoilerplate || !insights.clones) return head;
    const own = clones.boilerplate;
    if (own.length === baseBoilerplate.length && own.every((h, i) => h === baseBoilerplate[i])) return head;
    try {
      const judgedCache = cache && (overlay ? { ...(cache.baseJudgedClones ?? createCloneCache()) } : (cache.baseJudgedClones ??= createCloneCache()));
      const again = projectClones(files, cloneTokensOf, settings, { edges, coupling: git?.coupling, boilerplate: baseBoilerplate, cache: judgedCache });
      const families = again.families.filter((fam) => fam.fragments.some((f) => coreSet.has(f.file))).slice(0, MAX_FAMILIES);
      rememberDeclarations(families, again.declarations);
      return { ...head, insights: { ...head.insights, clones: families } };
    } catch {
      return head;
    }
  };
  // A staged analysis is an overlay of the index: it is compared with HEAD like uncommitted work.
  // A ref under review is compared with its merge-base only (nothing to compare without one, or without changes).
  const reviewable = !reviewing || (!!changes?.baseCommit && changes.files.length > 0);
  if (options.compare && changes && scope.type === 'project' && (!overlay || options.staged || options.committed || reviewing) && reviewable) {
    progress('compare');
    // Branch: compare with the merge-base; uncommitted work on the base branch: compare with HEAD.
    const branch = changes.mode === 'branch' && changes.baseCommit && changes.base;
    const baseRef = branch ? changes.baseCommit! : 'HEAD';
    const baseName = branch ? changes.base! : 'HEAD';
    // The change set already knows which files git saw renamed since the base: their findings are not new.
    const renames = new Map(changes.files.filter((f) => f.status === 'renamed' && f.oldPath).map((f) => [f.oldPath!, f.id]));
    try {
      const [{ takeSnapshot }, { compareReports }, { resolveCommit }] = await Promise.all([import('./overlay.js'), import('./compare.js'), import('./git.js')]);
      const [base, baseTip] = await Promise.all([
        takeSnapshot(analyze, root, baseRef, { cache, exclude: options.exclude, maxFiles: options.maxFiles, toolVersion: options.toolVersion, persist: options.persist !== false }),
        branch ? resolveCommit(root, changes.base!) : undefined,
      ]);
      changes.delta = compareReports(base, withBaseBoilerplate(partial, base.insights.cloneBoilerplate), {
        config,
        base: baseName,
        head: reviewing ? options.head! : options.staged ? 'staged changes' : options.committed ? 'HEAD' : 'working tree',
        renames,
        mergeBase: branch ? base.commit !== baseTip : undefined,
        // Findings are judged with the configured limit (`check.maxComplexity`), like `check` does.
        complexityThreshold: config.check?.maxComplexity,
        // A copy counts as edited only when the change touched its lines (not code added next to it).
        changes,
      });
      // clone-radar: copies that stopped matching because the change edited only one of them are drift too.
      if (changes.delta.driftedClones?.length) {
        const known = new Set((changes.cloneDrift ?? []).map((d) => d.family));
        const drift = [...(changes.cloneDrift ?? []), ...changes.delta.driftedClones.filter((d) => !known.has(d.family))];
        if (drift.length) changes.cloneDrift = drift;
      }
    } catch (error) {
      warnings.push(`Could not compare with ${baseName}: ${(error as Error).message}`);
    }
  }

  // dev-tools: what the next release contains and which version number fits (commits and API since the last tag).
  if (options.release && git && scope.type === 'project' && !overlay) {
    try {
      const [{ takeSnapshot }, { buildReleasePlan }] = await Promise.all([import('./overlay.js'), import('./release.js')]);
      partial.release = await buildReleasePlan(root, {
        head: partial,
        snapshot: (ref) => takeSnapshot(analyze, root, ref, { cache, exclude: options.exclude, maxFiles: options.maxFiles, toolVersion: options.toolVersion, persist: options.persist !== false }),
        config,
        since: typeof options.release === 'object' ? options.release.since : undefined,
        packageVersion: ctx.pkg.version,
        remote: git.info.remote,
        behind: git.summary.upstream?.behind,
      });
    } catch (error) {
      warnings.push(`Could not plan the release: ${(error as Error).message}`);
    }
  }

  // dev-tools: git insights, GitHub Actions and Claude Code tools. Like the release plan, they describe the whole
  // project as it is now, so a scoped report or a snapshot of another ref has none.
  if (scope.type === 'project' && !overlay) {
    if (options.repo && git) {
      try {
        const { analyzeRepo } = await import('./repo.js');
        const repo = await analyzeRepo(root, { branch: git.info.branch, memo: cache ? (cache.repo ??= {}) : undefined });
        if (repo) partial.repo = repo;
      } catch (error) {
        warnings.push(`Could not read the git repository: ${(error as Error).message}`);
      }
    }
    if (options.ci) {
      try {
        const { analyzeCi } = await import('./workflows.js');
        const ci = analyzeCi(root, { pkg: ctx.pkg, workspaces: ctx.workspaces.map((w) => w.pkg) });
        if (ci) partial.ci = ci;
      } catch (error) {
        warnings.push(`Could not read the GitHub Actions setup: ${(error as Error).message}`);
      }
    }
    if (options.ai) {
      try {
        const { analyzeAi } = await import('./ai.js');
        partial.ai = await analyzeAi(root, typeof options.ai === 'object' ? options.ai : {});
      } catch (error) {
        warnings.push(`Could not list the AI tools: ${(error as Error).message}`);
      }
    }
  }

  // review-mode: the suggested reading order of the change (dependency order, tests after their code).
  if (changes && scope.type === 'project') {
    try {
      const memo = cache ? (cache.meaningfulLines ??= new Map()) : undefined;
      const used = new Set<string>();
      setReadingOrder(partial, changes, {
        lines: (c) => {
          const key = memo && diffKeyOf(c);
          if (!key) return meaningfulLines(c);
          used.add(key);
          let n = memo!.get(key);
          if (n === undefined) memo!.set(key, (n = meaningfulLines(c)));
          return n;
        },
      });
      if (memo && memo.size > used.size + CODE_LINES_LIMIT) for (const key of memo.keys()) if (!used.has(key)) memo.delete(key);
    } catch (error) {
      warnings.push(`Could not order the changes for review: ${(error as Error).message}`);
    }
  }

  const tour = buildTour(partial);
  if (cache) cache.origin = 'memory';
  if (ownsDiskCache && cache?.dirty) saveDiskCache(root, cache);
  stats.durationMs = Date.now() - started;
  progress('done');
  return { ...partial, tour };
}

/**
 * Overlay keys as root-relative POSIX paths, whatever form the caller used (`./src/a.ts`, an absolute
 * path, Windows separators); keys outside the root are an AnalyzeError.
 */
function normalizeOverlay(root: string, overlay: Record<string, string | null>): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, text] of Object.entries(overlay)) {
    const posix = key.replace(/\\/g, '/');
    const abs = path.isAbsolute(key) || path.posix.isAbsolute(posix) || /^[A-Za-z]:\//.test(posix);
    const rel = abs ? toPosix(path.relative(root, path.resolve(key))) : path.posix.normalize(posix).replace(/^(\.\/)+/, '');
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel)) {
      throw new AnalyzeError(`Overlay path "${key}" is outside of the project root (${root}).`);
    }
    result[rel.replace(/\/$/, '')] = text;
  }
  return result;
}

/** Test support that is not named like a test: mocks, test utilities and setup files. */
const TEST_SUPPORT_RE =
  /(^|\/)(__mocks__|mocks?|testing|test-?utils?|testUtils|test-?helpers?|testHelpers)(\/|\.[cm]?[jt]sx?$)|(^|\/)(setupTests|setup-?tests?|test-?setup|testSetup)\.[cm]?[jt]sx?$|\.mocks?\.[cm]?[jt]sx?$/;
/** Folders of code that does not ship (it may still be used by code that does). */
const NON_PRODUCTION_DIR_RE = /(^|\/)(examples?|demos?|docs?|playground|sandbox|fixtures|__fixtures__|scripts|benchmarks?|bench)\//;

/** Files named as test setup in a test-runner config: `setupFiles: ['./src/setupTests.ts']`, `globalSetup`. */
function testSetupRefs(text: string): string[] {
  const refs: string[] = [];
  const re = /\b(?:setupFiles|setupFilesAfterEnv|setupFilesAfterEach|globalSetup|globalTeardown|setupFile|testSetup)['"]?\s*:\s*(?:require\.resolve\(\s*)?(\[[^\]]*\]|['"`][^'"`]+['"`])/g;
  for (const m of text.matchAll(re)) for (const s of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) refs.push(s[1]);
  return refs;
}

/**
 * Code that ships. It starts at what runs in production — package.json main / bin / exports, entry files
 * and modules nothing imports — and follows runtime imports. Tests, stories, tool configs, type
 * declarations and test support (mocks, test utilities, setup files) never ship, and neither does what
 * only they import (`src/test-utils.tsx`, `src/mocks/handlers.ts`). Scripts, examples and docs are not
 * starting points, but count once production code imports them.
 */
function productionFiles(files: FileInfo[], runtimeAdj: Adjacency, testSupport: Set<string>): Set<string> {
  const byId = new Map(files.map((f) => [f.id, f]));
  const never = (f: FileInfo): boolean =>
    f.kind === 'test' ||
    f.kind === 'story' ||
    f.kind === 'config' ||
    isTestFile(f.id) ||
    f.id.endsWith('.d.ts') ||
    TEST_SUPPORT_RE.test(f.id) ||
    testSupport.has(f.id);
  const notStart = (f: FileInfo): boolean => f.kind === 'script' || NON_PRODUCTION_DIR_RE.test(f.id);
  const imported = new Set<string>();
  for (const targets of runtimeAdj.values()) for (const t of targets) imported.add(t);
  const production = new Set<string>();
  const queue: string[] = [];
  for (const f of files) {
    if (never(f)) continue;
    const published = f.entryReason?.startsWith('package.json') ?? false;
    if (published || (!notStart(f) && (f.isEntry || !imported.has(f.id)))) {
      production.add(f.id);
      queue.push(f.id);
    }
  }
  while (queue.length) {
    for (const next of runtimeAdj.get(queue.pop()!) ?? []) {
      const f = byId.get(next);
      if (!f || production.has(next) || never(f)) continue;
      production.add(next);
      queue.push(next);
    }
  }
  return production;
}

/** The commands (package.json "bin") an installed package provides, looked up in node_modules above `dir`. */
function binLookup(root: string): (dir: string, name: string) => string[] {
  const cache = new Map<string, string[]>();
  return (dir, name) => {
    const key = `${dir}\0${name}`;
    let bins = cache.get(key);
    if (bins) return bins;
    bins = [];
    let at = path.join(root, dir);
    for (let i = 0; i < 12; i++) {
      const pkg = readJson<PackageJson>(path.join(at, 'node_modules', name, 'package.json'));
      if (pkg) {
        bins = typeof pkg.bin === 'string' ? [name.slice(name.lastIndexOf('/') + 1)] : Object.keys(pkg.bin ?? {});
        break;
      }
      const parent = path.dirname(at);
      if (parent === at) break;
      at = parent;
    }
    cache.set(key, bins);
    return bins;
  };
}

/** Frameworks that bundle all application code (server code included), devDependencies and all. */
const BUNDLING_FRAMEWORKS = [
  'next',
  'nuxt',
  '@sveltejs/kit',
  'astro',
  'gatsby',
  '@remix-run/dev',
  '@react-router/dev',
  '@angular/core',
  'expo',
  'react-native',
  '@builder.io/qwik',
  '@redwoodjs/core',
  '@docusaurus/core',
  'vitepress',
  // Electron apps whose main process is bundled.
  'electron-vite',
  '@electron-forge/plugin-vite',
  '@electron-forge/plugin-webpack',
];

/**
 * Files a bundler inlines into a browser / framework build, where a devDependency is fine: everything an
 * index.html loads (directly or through imports) and the code of packages built by a bundling framework.
 */
function browserBundled(ctx: ProjectContext, resolver: ModuleResolver, adj: Adjacency): (id: string) => boolean {
  const html = new Set<string>();
  const queue: string[] = [];
  for (const entry of ctx.htmlEntries) {
    const id = resolver.lookup(entry);
    if (id && !html.has(id)) {
      html.add(id);
      queue.push(id);
    }
  }
  while (queue.length) {
    for (const next of adj.get(queue.pop()!) ?? []) {
      if (html.has(next)) continue;
      html.add(next);
      queue.push(next);
    }
  }
  const frameworkDirs = ctx.manifests.filter((m) => BUNDLING_FRAMEWORKS.some((f) => m.declared.has(f))).map((m) => m.dir);
  return (id) => html.has(id) || frameworkDirs.some((d) => !d || id.startsWith(`${d}/`));
}

/** The package.json files imports are checked against, deepest first. */
function packageManifests(ctx: ProjectContext, root: string, states: Map<string, FileState>): ManifestDeclarations[] {
  const rootScripts = Object.values(ctx.pkg.scripts ?? {}).join(' ');
  const ids = [...states.keys()];
  // Tool configs name packages as strings (`presets: ['@babel/preset-env']`): they belong to their nearest package.json.
  const configText = new Map<string, string>();
  for (const st of states.values()) {
    if (!isConfigFile(st.id)) continue;
    const dir = nearestManifest(ctx.manifests, st.id)?.dir ?? '';
    configText.set(dir, `${configText.get(dir) ?? ''}\n${st.text}`);
  }
  const result: ManifestDeclarations[] = [];
  for (const m of ctx.manifests) {
    const isRoot = m.role === 'root';
    // No package.json at all (or an empty one): nothing to judge against.
    if (isRoot && Object.keys(m.pkg).length === 0) continue;
    // Only judge a package.json whose code was analyzed: one in an excluded or git-ignored folder can't be.
    const analyzed = !m.dir || ids.some((id) => id.startsWith(`${m.dir}/`));
    result.push({
      dir: m.dir,
      name: m.pkg.name,
      declared: m.declared,
      scripts: isRoot || m.role === 'ancestor' ? rootScripts : `${Object.values(m.pkg.scripts ?? {}).join(' ')} ${rootScripts}`,
      configText: m.role === 'ancestor' ? undefined : configText.get(m.dir),
      // A package.json above the analyzed folder also serves code that was not analyzed.
      checkUnused: analyzed && m.role !== 'ancestor' && (!isRoot || path.resolve(ctx.pkgDir) === path.resolve(root)),
    });
  }
  return result;
}

/** Drop files the overlay deletes, add files that exist only in it, keep discovery's order and limits. */
function applyOverlay(root: string, files: DiscoveredFile[], overlay: Record<string, string | null>, accept: (id: string) => boolean, warnings: string[]): DiscoveredFile[] {
  const known = new Set(files.map((f) => f.id));
  const result = files.filter((f) => !Object.hasOwn(overlay, f.id) || overlay[f.id] !== null);
  for (const [id, text] of Object.entries(overlay)) {
    if (text === null || known.has(id) || !accept(id)) continue;
    result.push({ id, abs: path.join(root, id), ext: extOf(id), bytes: 0, mtimeMs: 0 });
  }
  return result
    .map((f) => {
      const text = Object.hasOwn(overlay, f.id) ? overlay[f.id] : undefined;
      return typeof text === 'string' ? { ...f, bytes: Buffer.byteLength(text) } : f;
    })
    .filter((f) => {
      if (f.bytes <= MAX_FILE_BYTES) return true;
      warnings.push(`Skipped ${f.id} (larger than ${(MAX_FILE_BYTES / 1e6).toFixed(1)} MB).`);
      return false;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

// --- clone-radar ---
/** A fresh parse result with its clone tokens (cached together, so warm runs never re-scan unchanged files). */
function withCloneTokens(parsed: ParsedFile, text: string, ext: string): ParsedFile {
  try {
    parsed.tokens = cloneTokens(text, ext);
  } catch {
    /* clone detection skips the file */
  }
  return parsed;
}

/** Clone tokens of a file whose cached parse result has none (written by an older analyzer). */
function tokensFromText(st: FileState | undefined): ParsedFile['tokens'] {
  if (!st) return undefined;
  try {
    return (st.parsed.tokens = cloneTokens(st.text, st.ext));
  } catch {
    return undefined;
  }
}

function rememberParsed(cache: AnalyzeCache, key: string, parsed: ParsedFile): void {
  const map = (cache.byHash ??= new Map());
  map.set(key, parsed);
  if (map.size <= BY_HASH_LIMIT) return;
  let excess = map.size - Math.floor(BY_HASH_LIMIT * 0.9);
  for (const k of map.keys()) {
    if (excess-- <= 0) break;
    map.delete(k);
  }
}

/** Who knows each folder best (recency-weighted commits), its bus factor and CODEOWNERS. */
function enrichFolders(folders: ReportData['folders'], files: FileInfo[]): void {
  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  const BOT_RE = /\[bot\]|dependabot|renovate|github-actions|semantic-release/i;
  const acc = new Map<string, { authors: Map<string, number>; total: number; owners: Map<string, number> }>();
  for (const f of files) {
    const parts = f.dir ? f.dir.split('/') : [];
    const paths = [''];
    for (let i = 1; i <= parts.length; i++) paths.push(parts.slice(0, i).join('/'));
    for (const p of paths) {
      let entry = acc.get(p);
      if (!entry) acc.set(p, (entry = { authors: new Map(), total: 0, owners: new Map() }));
      for (const a of f.git?.authors ?? []) {
        if (BOT_RE.test(a.name)) continue;
        const w = a.commits * (0.4 + 0.6 * Math.exp(-(now - a.last) / (180 * DAY)));
        entry.authors.set(a.name, (entry.authors.get(a.name) ?? 0) + w);
        entry.total += w;
      }
      for (const o of f.owners ?? []) entry.owners.set(o, (entry.owners.get(o) ?? 0) + 1);
    }
  }
  for (const folder of folders) {
    const entry = acc.get(folder.path);
    if (!entry) continue;
    if (entry.total > 0) {
      const sorted = [...entry.authors.entries()].sort((a, b) => b[1] - a[1]);
      folder.experts = sorted.slice(0, 3).map(([name, v]) => ({ name, share: Math.round((v / entry.total) * 100) / 100 }));
      let sum = 0;
      let count = 0;
      for (const [, v] of sorted) {
        sum += v;
        count++;
        if (sum / entry.total > 0.5) break;
      }
      folder.busFactor = count;
    }
    if (entry.owners.size) {
      folder.owners = [...entry.owners.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([o]) => o);
    }
  }
}

function dedupeExports(p: ParsedFile, unused: Set<string> | undefined): FileInfo['exports'] {
  const out: FileInfo['exports'] = [];
  const seen = new Set<string>();
  for (const e of p.localExports) {
    if (e.local === '__module_exports__' || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, line: e.line, isDefault: e.name === 'default' || undefined, typeOnly: e.typeOnly || undefined, unused: unused?.has(e.name) || undefined });
  }
  for (const re of p.reexports) {
    if (re.star) {
      out.push({ name: '*', line: re.line, from: re.specifier, typeOnly: re.typeOnly || undefined });
      continue;
    }
    for (const n of re.names) {
      if (seen.has(n.exported)) continue;
      seen.add(n.exported);
      out.push({ name: n.exported, line: re.line, from: re.specifier, typeOnly: re.typeOnly || undefined });
    }
  }
  return out;
}

// --- agent-guardrails ---
/** The configured rules with their names (`rule-N` when unnamed, as `evaluateRules` reports them) and globs as lists. */
function ruleList(rules: RuleConfig[]): RuleListEntry[] {
  const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);
  return rules.map((r, i) => ({
    name: r.name ?? `rule-${i + 1}`,
    from: list(r.from),
    to: list(r.to),
    ...(r.allow !== undefined ? { allow: list(r.allow) } : {}),
    severity: r.severity ?? 'error',
    ...(r.message ? { message: r.message } : {}),
    ...(r.includeTypes === false ? { includeTypes: false } : {}),
  }));
}

export type { ProjectContext };
