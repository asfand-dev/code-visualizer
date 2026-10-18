import fs from 'node:fs';
import path from 'node:path';
import { analyze, createAnalyzeCache, type AnalyzeOptions } from '../analyzer/index.js';
import { loadConfig } from '../analyzer/config.js';
import { coverageCandidates } from '../analyzer/coverage.js';
import { loadDiskCache, saveDiskCache } from '../analyzer/disk-cache.js';
import { git } from '../analyzer/git.js';
import { writeHistory } from '../analyzer/health.js';
import { LiveGuard, type LiveGuardOptions } from '../analyzer/live-events.js';
import type { LiveEvent, LiveFeed, ReportData } from '../shared/types.js';
import { watchGitDir, watchProject, watchRemoteRefs, type ProjectWatcher, type WatchFn } from './watch.js';

/**
 * The warm analysis engine behind `serve` (and later `mcp`): one in-memory cache, a coalescing
 * re-analysis queue, file and git watchers, and listeners for every new analysis.
 */

export interface EngineUpdate {
  data: ReportData;
  /** The previous successful analysis (undefined for the first one). */
  prev?: ReportData;
  /** Project-relative paths reported since the previous analysis (empty for git events and manual refreshes). */
  changed: string[];
  durationMs: number;
  /** Counts successful analyses: 1 for the first one. */
  version: number;
  /** What got worse or better since `prev` (live-guard; only with `EngineOptions.events`). */
  events?: LiveEvent[];
}

export interface EngineOptions {
  root: string;
  /** Analysis options; `persist` keeps the parse cache in `.code-visualizer/cache/` across restarts. */
  options?: Omit<AnalyzeOptions, 'root' | 'cache' | 'onProgress'>;
  /** Watch files and git (default: true). */
  watch?: boolean;
  /**
   * `eager` (default) re-analyzes shortly after changes and notifies listeners (serve);
   * `lazy` only marks the analysis dirty and re-analyzes on the next `current()` (mcp).
   */
  mode?: 'eager' | 'lazy';
  /** Quiet period before an eager re-analysis (default: 350 ms). */
  debounceMs?: number;
  /** Record `.code-visualizer/history.json` after each project-wide analysis. */
  writeHistory?: boolean;
  log?: (message: string) => void;
  /** Minimum time between disk-cache saves with `persist` (default: 30 s; always saved on close). */
  saveIntervalMs?: number;
  /** Injected for tests: the platform decides between recursive and per-directory watching. */
  platform?: NodeJS.Platform;
  watchFn?: WatchFn;
  /**
   * Announce what got worse or better with every re-analysis (live-guard): `EngineUpdate.events` and
   * `feed()`. Kinds in `serve.events.exclude` of the configuration are left out.
   */
  events?: boolean | LiveGuardOptions;
  // --- mcp-server ---
  /** Progress of every analysis the engine runs (the MCP server forwards it as `notifications/progress`). */
  onProgress?: AnalyzeOptions['onProgress'];
  /**
   * test-intelligence: how often to look at the coverage reports (`coverage/coverage-final.json`,
   * `coverage/lcov.info`) for a new test run (default: 1000 ms; 0 turns it off). They live in an ignored
   * folder that test runners delete and recreate, so they are polled rather than watched.
   */
  coveragePollMs?: number;
}

export interface Engine {
  readonly root: string;
  /**
   * The up-to-date analysis: waits for the first run, flushes pending changes and re-analyzes when
   * something is dirty. `verify` also compares mtimes and sizes of analyzed files (catches edits
   * the watcher has not reported yet) and re-analyzes on a new day. Rejects when the latest
   * attempt failed.
   */
  current(opts?: { verify?: boolean }): Promise<ReportData>;
  /** The last successful analysis, without waiting (undefined before the first one). */
  latest(): ReportData | undefined;
  /** Number of successful analyses so far. */
  version(): number;
  /** Re-analyze now (coalesced with a run in progress). */
  reanalyze(paths?: string[]): Promise<ReportData>;
  /** Mark files (or everything) as changed: eager engines re-analyze after the debounce, lazy ones on the next current(). */
  markDirty(paths?: string[]): void;
  onUpdate(cb: (update: EngineUpdate) => void): () => void;
  onError(cb: (error: Error) => void): () => void;
  /**
   * Analysis of the project as if `file` (project-relative or absolute) contained `text`, or did not
   * exist (`null`) — without writing it. Shares the warm parse cache, never writes state, skips git.
   * Compare it with `current()` through `compareReports` (src/analyzer/compare.ts).
   * agent-guardrails: an overlay (path → text, `null` = deleted) changes several files at once.
   * Copy-paste clones are detected only when the comparison needs them: `options.clones`, or a clone
   * gate in the configuration (`check.maxNewClones`).
   */
  whatIf(file: string | Record<string, string | null>, text?: string | null, options?: WhatIfOptions): Promise<ReportData>;
  /** This session's live events and the problems still open (empty without `EngineOptions.events`). */
  feed(): LiveFeed;
  /** How the project is watched ('pending' until the first analysis finished). */
  watchMode(): ProjectWatcher['mode'] | 'pending';
  /** Stop watching and save the cache (with persist; an analysis still running is saved when it ends). The last analysis stays readable. */
  close(): void;
}

export interface WhatIfOptions {
  /** Detect copy-paste clones (for `newClones` in the comparison; default: only with a clone gate configured). */
  clones?: boolean;
}

const MAX_CATCH_UP = 3;

export function createEngine(engineOptions: EngineOptions): Engine {
  const root = path.resolve(engineOptions.root);
  const options = engineOptions.options ?? {};
  const log = engineOptions.log ?? (() => undefined);
  const eager = (engineOptions.mode ?? 'eager') === 'eager';
  const debounceMs = engineOptions.debounceMs ?? 350;
  const saveIntervalMs = engineOptions.saveIntervalMs ?? 30_000;
  const cache = createAnalyzeCache();
  if (options.persist) loadDiskCache(root, cache);
  const guard = engineOptions.events ? new LiveGuard(engineOptions.events === true ? {} : engineOptions.events) : undefined;
  /** The configuration as the analyses read it: rules are re-judged with it, serve.events.exclude applies. */
  const currentConfig = () => (options.config ?? loadConfig(root)).config;
  /** Live events of one step; never fails the analysis. */
  const liveEvents = (prev: ReportData, next: ReportData, changed: string[], version: number): LiveEvent[] | undefined => {
    if (!guard) return undefined;
    try {
      return guard.update(prev, next, changed, { config: currentConfig(), version });
    } catch (error) {
      log(`! Could not compare with the previous analysis: ${(error as Error).message}`);
      return [];
    }
  };
  /** The first analysis: what the work already breaks (its delta) is open from the start, without events. */
  const seedLive = (first: ReportData, version: number): undefined => {
    try {
      guard?.seed(first, { config: currentConfig(), version });
    } catch (error) {
      log(`! Could not read the open problems of the first analysis: ${(error as Error).message}`);
    }
    return undefined;
  };

  let data: ReportData | undefined;
  let version = 0;
  let lastError: Error | undefined;
  let closed = false;
  /** A change not tied to known files (first run, git events, refresh, a new day): always re-analyze. */
  let dirtyAll = true; // nothing analyzed yet
  /** Project-relative files reported changed since the last analysis started. */
  let changedPaths = new Set<string>();
  /** Local day of the last successful analysis (activity charts and history points are per day). */
  let analyzedDay: string | undefined;
  // --- new-only-gates: HEAD and its upstream when the last analysis started ---
  // Trunk mode compares with the upstream, which `git push` moves without touching HEAD or the index.
  const wantsGit = options.git !== false && options.changes !== false;
  let gitStamp: string | undefined;
  const readGitStamp = async (): Promise<string | undefined> => {
    if (!wantsGit) return undefined;
    return (await git(root, ['rev-parse', 'HEAD', '@{upstream}'])) ?? (await git(root, ['rev-parse', 'HEAD']));
  };
  // --- test-intelligence: the coverage reports when the last analysis started ---
  // A test run writes a new report; CLI commands asking right after it (`check --min-patch-coverage`)
  // must not get the analysis of the previous report while the poller has not noticed yet.
  let coverageStamp = new Map<string, string>();
  const coverageSignature = (file: string): string => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '-';
    }
  };
  const readCoverageStamp = (): Map<string, string> => new Map(coverageFiles(false).map((file) => [file, coverageSignature(file)]));
  const sameStamp = (a: Map<string, string>, b: Map<string, string>): boolean => a.size === b.size && [...a].every(([file, sig]) => b.get(file) === sig);
  let running: Promise<void> | undefined;
  let rerun = false;
  let timer: NodeJS.Timeout | undefined;
  const isDirty = (): boolean => dirtyAll || changedPaths.size > 0;
  const updateListeners = new Set<(u: EngineUpdate) => void>();
  const errorListeners = new Set<(e: Error) => void>();
  /** A failing listener must neither break the others nor count as a failed analysis. */
  const notify = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const cb of listeners) {
      try {
        cb(value);
      } catch (error) {
        log(`✖ ${(error as Error).message}`);
      }
    }
  };

  /* -------------------------------- Persist -------------------------------- */
  let lastSave = 0;
  let saveTimer: NodeJS.Timeout | undefined;
  const save = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!options.persist || !cache.dirty) return;
    lastSave = Date.now();
    try {
      saveDiskCache(root, cache);
    } catch {
      /* the cache is an optimization */
    }
  };
  const scheduleSave = (): void => {
    if (!options.persist || !cache.dirty || saveTimer || closed) return;
    const wait = lastSave + saveIntervalMs - Date.now();
    if (wait <= 0) return save();
    saveTimer = setTimeout(save, wait);
    saveTimer.unref();
  };

  /* ------------------------------- Analysis -------------------------------- */
  /** An analyzed file whose mtime and size on disk are what the last analysis parsed. */
  const upToDate = (rel: string): boolean => {
    const entry = cache.files.get(rel);
    if (!entry) return false;
    try {
      const stat = fs.statSync(path.join(root, rel));
      return stat.mtimeMs === entry.mtimeMs && stat.size === entry.size;
    } catch {
      return false;
    }
  };
  /**
   * Forget reported files the last analysis already saw as they are now: watchers deliver events
   * late, often while the analysis that read the edit (e.g. one started by `verify`) was running.
   */
  const settle = (): void => {
    if (!data || lastError || dirtyAll) return;
    for (const rel of changedPaths) if (upToDate(rel)) changedPaths.delete(rel);
  };

  const run = (): Promise<void> => {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      // Start on the next tick: a run with nothing to do must not finish before `running` is set.
      await Promise.resolve();
      do {
        rerun = false;
        settle();
        if (!isDirty()) break;
        dirtyAll = false;
        const changed = [...changedPaths];
        changedPaths = new Set();
        const started = Date.now();
        const day = new Date().toDateString();
        let update: EngineUpdate | undefined;
        try {
          gitStamp = await readGitStamp();
          const coverageBefore = readCoverageStamp();
          const next = await analyze({ ...options, root, cache, onProgress: engineOptions.onProgress });
          const prev = data;
          data = next;
          // The first analysis names the workspaces (and with them the report files) only now.
          coverageStamp = new Map(coverageFiles(false).map((file) => [file, coverageBefore.get(file) ?? coverageSignature(file)]));
          version++;
          analyzedDay = day;
          lastError = undefined;
          if (engineOptions.writeHistory && next.scope.type === 'project') {
            try {
              writeHistory(root, next.history);
            } catch {
              /* history is best effort */
            }
          }
          watcher?.ignoreDirectories(next.project.subprojects ?? []);
          watcher?.addDirectories(directoriesOf(cache.files.keys()));
          if (watcher) watchCoverage();
          scheduleSave();
          const durationMs = Date.now() - started;
          const events = prev ? liveEvents(prev, next, changed, version) : seedLive(next, version);
          update = { data: next, prev, changed, durationMs, version, ...(events ? { events } : {}) };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
        if (update) notify(updateListeners, update);
        else if (lastError) notify(errorListeners, lastError);
      } while (rerun && !closed);
      running = undefined;
      startWatching();
    })();
    return running;
  };

  const markDirty = (paths?: string[]): void => {
    if (closed) return;
    if (!paths) dirtyAll = true;
    for (const p of paths ?? []) changedPaths.add(p.split(path.sep).join('/'));
    if (!eager) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, debounceMs);
  };
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  /** Edits the watcher has not reported yet: analyzed files whose mtime or size changed, or that are gone. */
  const verifyFiles = (): string[] => [...cache.files.keys()].filter((id) => !upToDate(id));

  const current = async (opts: { verify?: boolean } = {}): Promise<ReportData> => {
    if (running) await running;
    if (opts.verify && data) {
      for (const id of verifyFiles()) changedPaths.add(id);
      if (analyzedDay !== new Date().toDateString()) dirtyAll = true;
      // A push (the upstream moved) or a commit the git watcher did not report.
      if (wantsGit && (await readGitStamp()) !== gitStamp) dirtyAll = true;
      // A coverage report written since (a test run with coverage the poller has not seen yet).
      if (!sameStamp(readCoverageStamp(), coverageStamp)) dirtyAll = true;
    }
    for (let i = 0; i < MAX_CATCH_UP && (isDirty() || running); i++) {
      flush();
      await (isDirty() ? run() : running);
    }
    if (lastError) throw lastError;
    if (!data) throw new Error('The analysis is not available.');
    return data;
  };

  /* -------------------------------- Watch ---------------------------------- */
  // Watching starts after the first analysis (like before the engine existed): macOS reports the
  // writes of the last moments right after a watch starts, which would only trigger a second run.
  let watcher: ProjectWatcher | undefined;
  let gitWatcher: fs.FSWatcher | undefined;
  let remoteWatcher: fs.FSWatcher | undefined;
  // --- test-intelligence: a new coverage report (a test run with coverage) re-analyzes ---
  const coveragePollMs = engineOptions.coveragePollMs ?? 1000;
  const polled = new Map<string, (curr: fs.Stats, prev: fs.Stats) => void>();
  const watchCoverage = (): void => {
    if (closed || !data || engineOptions.watch === false || coveragePollMs <= 0) return;
    const wanted = coverageFiles(true);
    for (const [file, listener] of polled) {
      if (wanted.includes(file)) continue;
      fs.unwatchFile(file, listener);
      polled.delete(file);
    }
    for (const file of wanted) {
      if (polled.has(file)) continue;
      const listener = (curr: fs.Stats, prev: fs.Stats): void => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) markDirty();
      };
      fs.watchFile(file, { interval: coveragePollMs, persistent: false }, listener);
      polled.set(file, listener);
    }
  };
  /**
   * The report files the analysis reads (none when coverage is off). `polled`: only the root and packages
   * with a test runner of their own (where runners write `coverage/`), so a monorepo with hundreds of
   * packages does not poll hundreds of files every second.
   */
  function coverageFiles(polledOnly: boolean): string[] {
    if (options.coverage === false || !data) return [];
    let configured: { paths?: string[]; enabled?: boolean } | undefined;
    try {
      configured = (options.config ?? loadConfig(root)).config.coverage;
    } catch {
      configured = undefined;
    }
    if (configured?.enabled === false) return [];
    const runners = data.project.testRunners ?? {};
    const dirs = (data.project.workspaces ?? []).filter((d) => !polledOnly || !!runners[d]?.unit || !!runners[d]?.e2e);
    return coverageCandidates(root, { dirs, paths: options.coverage || configured?.paths });
  }
  const unwatchCoverage = (): void => {
    for (const [file, listener] of polled) fs.unwatchFile(file, listener);
    polled.clear();
  };
  // --- /test-intelligence ---
  const startWatching = (): void => {
    if (watcher || closed || engineOptions.watch === false) return;
    watcher = watchProject({
      root,
      platform: engineOptions.platform,
      watch: engineOptions.watchFn,
      log,
      onChange: (rel) => markDirty(rel ? [rel] : undefined),
      // Nested fixture / example projects the analysis leaves out: editing them changes nothing.
      ignoredDirectories: data?.project.subprojects,
    });
    watcher.addDirectories(directoriesOf(cache.files.keys()));
    watchCoverage();
    void git(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir']).then((out) => {
      const [gitDir, commonDir] = (out ?? '').trim().split('\n');
      if (closed || !gitDir || !fs.existsSync(gitDir)) return;
      // HEAD, index and refs change on commit, checkout, stage, pull…
      gitWatcher = watchGitDir(gitDir, () => markDirty(), engineOptions.watchFn);
      // …and remote-tracking refs on push and fetch (worktrees share them in the common directory).
      if (commonDir) remoteWatcher = watchRemoteRefs(path.resolve(root, commonDir), () => markDirty(), engineOptions.watchFn);
    });
  };

  void run(); // the first analysis starts right away

  return {
    root,
    current,
    latest: () => data,
    version: () => version,
    async reanalyze(paths) {
      markDirty(paths);
      if (!closed) dirtyAll = true; // explicit: analyze even when the files look unchanged
      flush();
      await run();
      if (lastError) throw lastError;
      return data!;
    },
    markDirty,
    onUpdate(cb) {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    async whatIf(file, text, whatIfOptions = {}) {
      // Do not interleave with a re-analysis that is pruning the shared cache.
      if (running) await running;
      const overlay = typeof file === 'string' ? { [file]: text ?? null } : file;
      // Copy-paste detection only when the comparison needs new clones (a pre-edit guard does not).
      let clones = whatIfOptions.clones;
      if (clones === undefined) {
        try {
          clones = currentConfig().check?.maxNewClones !== undefined;
        } catch {
          clones = false;
        }
      }
      // Unchanged files come from the cache, the proposed text is parsed once per content (cache.byHash).
      return analyze({ ...options, root, cache, overlay, persist: false, git: false, changes: false, history: false, compare: false, includeSource: false, clones });
    },
    feed: () => guard?.feed(version) ?? { version, events: [], open: [] },
    watchMode: () => watcher?.mode ?? (engineOptions.watch === false ? 'none' : 'pending'),
    close() {
      if (closed) return;
      flush();
      watcher?.close();
      gitWatcher?.close();
      remoteWatcher?.close();
      unwatchCoverage();
      save();
      closed = true;
      // --- mcp-server: an analysis still running (a client that left during warm-up) is kept for the next start ---
      void running?.then(save);
    },
  };
}

/** Every folder (and ancestor) that contains one of the files. */
export function directoriesOf(ids: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const id of ids) {
    let dir = path.posix.dirname(id);
    while (dir !== '.' && !dirs.has(dir)) {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return dirs;
}
