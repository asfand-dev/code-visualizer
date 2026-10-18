/**
 * The daily-loop endpoints of `serve`: `GET /api/status` (the status line, current by construction) and
 * `GET /api/sync` (the sync forecast for the Today page), plus the status snapshot `serve` stores after
 * every analysis so prompts stay right after the server stops.
 */
import { loadConfig } from '../analyzer/config.js';
import { findRepo, indexMtime, readHead, resolveShortRef, type RepoLocation } from '../analyzer/repo-state.js';
import { readAllState, untrustedState, updateState } from '../analyzer/state.js';
import { analyzeSync, syncState, upstreamStatus, type UpstreamStatus } from '../analyzer/sync.js';
import { openProblemCount } from '../shared/live.js';
import { buildStatus, statusContextFromState } from '../shared/status.js';
import type { ReportData, StatusSnapshot, SyncReport } from '../shared/types.js';
import type { Engine } from './engine.js';

export interface DailyLoopService {
  /**
   * The status of the latest analysis (with the live page and its open problems); undefined when the
   * server analyzes part of the project (`--directory`, `--file`), which is not what `status` shows.
   */
  status(): Promise<StatusSnapshot | undefined>;
  /** Store the status snapshot soon (debounced): called after every analysis. */
  scheduleWrite(): void;
  /** The sync forecast (memoized per analysis, base and options). */
  sync(options: { base?: string; branches?: boolean; since?: number }): Promise<SyncReport>;
  close(): void;
}

/** The base of your work: what My changes compares with, else the branch's upstream. */
function baseOf(data: ReportData): string | undefined {
  return data.changes?.base ?? data.git?.upstream?.name;
}

export function createDailyLoopService(o: { root: string; engine: Engine; url: () => string; persist: boolean; base?: string; log?: (message: string) => void }): DailyLoopService {
  const repo: RepoLocation | undefined = findRepo(o.root);
  /** Upstream counts depend only on HEAD and the base's tip: recomputed when either moves. */
  let upstreamMemo: { key: string; value: Promise<UpstreamStatus | undefined> } | undefined;
  const upstreamFor = (data: ReportData): Promise<UpstreamStatus | undefined> => {
    const base = baseOf(data);
    if (!base || !repo) return Promise.resolve(undefined);
    const key = `${base}\0${readHead(repo)}\0${resolveShortRef(repo, base)}`;
    if (upstreamMemo?.key !== key) upstreamMemo = { key, value: upstreamStatus(o.root, base).catch(() => undefined) };
    return upstreamMemo.value;
  };

  const snapshotOf = async (data: ReportData, live: boolean): Promise<StatusSnapshot> => {
    const generatedAt = Date.parse(data.generatedAt) || Date.now();
    const upstream = await upstreamFor(data);
    const open = live ? openProblemCount(o.engine.feed().open) : undefined;
    // A state file that came with the repository (or from another user) is not read, as in `status`.
    const trusted = !repo || !untrustedState(o.root, repo);
    return buildStatus(data, {
      ...statusContextFromState(trusted ? readAllState(o.root) : {}),
      upstream,
      generatedAt,
      head: repo ? readHead(repo) : undefined,
      indexMtime: repo ? indexMtime(repo) : undefined,
      ...(live ? { live: { url: o.url(), ...(open ? { open } : {}) } } : {}),
    });
  };

  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const write = async (): Promise<void> => {
    const data = o.engine.latest();
    // Only a project-wide analysis describes what `status` shows.
    if (!data || data.scope.type !== 'project' || closed) return;
    // Never rewrite a state file git tracks or that is not ours (`status` ignores it anyway).
    if (repo && untrustedState(o.root, repo)) return;
    const snapshot = await snapshotOf(data, false);
    // Re-read by `status` on every call; not stored with the snapshot.
    delete snapshot.lastCheck;
    delete snapshot.lastTest;
    delete snapshot.testsCovered;
    updateState(o.root, 'status', snapshot);
  };

  let syncMemo: { key: string; at: number; value: Promise<SyncReport> } | undefined;
  return {
    status: async () => {
      const data = o.engine.latest();
      if (!data) throw new Error('The analysis is not available yet.');
      return data.scope.type === 'project' ? snapshotOf(data, true) : undefined;
    },
    scheduleWrite() {
      if (!o.persist || closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        write().catch((error: Error) => o.log?.(`! Could not store the status snapshot: ${error.message}`));
      }, 1000);
      timer.unref();
    },
    async sync(options) {
      const data = await o.engine.current();
      // The same base as `code-visualizer sync`: asked for, serve's --base, else the configuration's.
      const base = options.base ?? o.base ?? loadConfig(o.root).config.base;
      const key = JSON.stringify([o.engine.version(), base ?? null, !!options.branches, options.since ?? null, repo ? readHead(repo) : null]);
      // Snapshots and trial merges take a moment: answer repeated requests (other tabs, reloads) from memory.
      if (syncMemo?.key === key && Date.now() - syncMemo.at < 5 * 60_000) return syncMemo.value;
      const value = analyzeSync(o.root, { ...options, base, data, persist: o.persist }).then((report) => {
        if (o.persist) {
          try {
            updateState(o.root, 'sync', syncState(report));
          } catch {
            /* read-only checkout */
          }
        }
        return report;
      });
      syncMemo = { key, at: Date.now(), value };
      value.catch(() => {
        if (syncMemo?.value === value) syncMemo = undefined;
      });
      return value;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
