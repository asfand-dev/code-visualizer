import type { AnalyzeOptions, AnalyzeStage } from '../analyzer/index.js';
import { connectToServer, getReport, serverMatches } from '../cli/engine.js';
import type { Engine, EngineOptions } from '../server/engine.js';
import type { ReportData } from '../shared/types.js';

/**
 * Where MCP answers get their analysis: a running `code-visualizer serve` for the same project and
 * options (no second analysis, no second watcher), otherwise an in-process warm engine in lazy mode —
 * the file watcher only marks the analysis dirty, and the next tool call re-analyzes what changed.
 * The analyzer (and with it the TypeScript compiler) is loaded only when the engine is needed.
 */

export type ProgressListener = (stage: AnalyzeStage, detail?: { done?: number; total?: number }) => void;

export interface DataSource {
  /** The up-to-date analysis. `onProgress` hears the stages of an analysis this call waits for. */
  report(opts?: { onProgress?: ProgressListener }): Promise<ReportData>;
  /** The analysis again after these project-relative files changed (a file created since the last analysis). */
  refresh(paths: string[]): Promise<ReportData>;
  /** A one-off analysis with other options (another base for "my changes"). */
  reportFor(options: { base?: string }): Promise<ReportData>;
  /** Start analyzing in the background (or find the running server). */
  warm(): void;
  /** `server` while a running `serve` answers, `engine` once the in-process engine runs. */
  kind(): 'pending' | 'server' | 'engine';
  close(): void;
}

export interface DataSourceOptions {
  root: string;
  /** Analysis options of the engine (what a `serve` must match to be used). */
  analysis: Omit<AnalyzeOptions, 'root' | 'cache' | 'onProgress'>;
  /** Watch files and git (default true); without it every call still checks analyzed files for edits. */
  watch?: boolean;
  /** Ask a running `serve` first (default true). */
  useServer?: boolean;
  log?: (message: string) => void;
}

export function createDataSource(opts: DataSourceOptions): DataSource {
  const { root, analysis } = opts;
  const log = opts.log ?? (() => undefined);
  const useServer = opts.useServer ?? true;
  const listeners = new Set<ProgressListener>();
  let engine: Engine | undefined;
  let starting: Promise<Engine> | undefined;
  let mode: 'pending' | 'server' | 'engine' = 'pending';
  let closed = false;
  let warming: Promise<void> | undefined;
  /** The last analysis a server sent, with the server's analysis version before it was fetched. */
  let served: { pid: number; token: string; version: number; data: ReportData } | undefined;

  const ensureEngine = (): Promise<Engine> => {
    if (engine) return Promise.resolve(engine);
    starting ??= import('../server/engine.js').then(({ createEngine }) => {
      if (closed) throw new Error('The MCP server is shutting down.');
      const options: EngineOptions = {
        root,
        options: analysis,
        mode: 'lazy',
        watch: opts.watch !== false,
        log,
        onProgress: (stage, detail) => {
          for (const l of listeners) l(stage, detail);
        },
      };
      engine = createEngine(options);
      mode = 'engine';
      return engine;
    });
    return starting;
  };

  /**
   * The running server's analysis, when one serves this project with matching options. The server
   * checks for edits first (`fresh`); when its analysis is still the one fetched last time (`since`),
   * it says so instead of sending it again, and the same object (with its query index) is reused.
   */
  const fromServer = async (): Promise<ReportData | undefined> => {
    if (!useServer || engine || closed) return undefined;
    const connection = await connectToServer(root).catch(() => undefined);
    if (!connection || !serverMatches(root, connection.info, { ...analysis, root })) return undefined;
    const { pid, token } = connection.info;
    const last = served?.pid === pid && served.token === token ? served : undefined;
    try {
      // The version before the server checks for edits: never newer than the data it sends next.
      const before = await connection.request<{ version?: number }>('/api/ping', { timeoutMs: 2000 }).catch(() => ({ version: undefined }));
      const query = { source: '0', fresh: '1', ...(last ? { since: String(last.version) } : {}) };
      const reply = await connection.request<ReportData | { unchanged: true }>('/api/data', { query, timeoutMs: 60_000 });
      if (last && 'unchanged' in reply && reply.unchanged) return last.data;
      const data = reply as ReportData;
      if (mode !== 'server') log(`answering from the running serve (pid ${pid})`);
      mode = 'server';
      data.stats.cache = { reused: data.stats.cache?.reused ?? data.stats.files, parsed: data.stats.cache?.parsed ?? 0, source: 'server' };
      served = typeof before.version === 'number' ? { pid, token, version: before.version, data } : undefined;
      return data;
    } catch {
      served = undefined;
      return undefined; // busy or gone: analyze in-process
    }
  };

  const report: DataSource['report'] = async ({ onProgress } = {}) => {
    const fromServe = await fromServer();
    if (fromServe) return fromServe;
    const e = await ensureEngine();
    if (onProgress) listeners.add(onProgress);
    try {
      // `verify`: an agent edits a file and asks right away, before the watcher has reported the write.
      return await e.current({ verify: true });
    } catch (error) {
      // Nothing analyzed yet (no sources so far, a transient failure): try again on the next call, also
      // without a watcher to notice that files appeared.
      if (!e.latest()) e.markDirty();
      throw error;
    } finally {
      if (onProgress) listeners.delete(onProgress);
    }
  };

  return {
    report,
    async refresh(paths) {
      if (!engine && mode === 'server') {
        // The server's watcher reports a new file within moments; ask again after that.
        await new Promise((resolve) => setTimeout(resolve, 300));
        served = undefined;
        return report();
      }
      const e = await ensureEngine();
      e.markDirty(paths);
      return report();
    },
    reportFor: ({ base }) => getReport({ ...analysis, root, base, server: useServer }),
    warm() {
      warming ??= (async () => {
        if (useServer) {
          const connection = await connectToServer(root).catch(() => undefined);
          // Answers come from it (see report()); the engine starts only if it goes away.
          if (connection && serverMatches(root, connection.info, { ...analysis, root })) return;
        }
        if (!closed) await ensureEngine();
      })().catch((error: Error) => log(`! ${error.message}`));
    },
    kind: () => mode,
    close() {
      closed = true;
      engine?.close();
      // An engine still being created closes as soon as it exists.
      void starting?.then((e) => e.close()).catch(() => undefined);
    },
  };
}
