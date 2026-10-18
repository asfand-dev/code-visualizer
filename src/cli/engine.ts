import path from 'node:path';
import type { AnalyzeOptions } from '../analyzer/index.js';
import { analysisFingerprint, connectToServer, type ServerConnection } from '../server/client.js';
import type { ReportData, ServerInfo } from '../shared/types.js';
import { VERSION } from '../version.js';
import { cacheDisabledByEnv } from './shared.js';

export { connectToServer, probeServer } from '../server/client.js';
export type { ServerConnection, ServerProbe } from '../server/client.js';

/**
 * The fastest way to an analysis for CLI commands, hooks and agents: a running `serve` for the
 * same project and options, then the disk cache (`.code-visualizer/cache/`), then a cold run.
 * The analyzer (and with it the TypeScript compiler) is only loaded when the server cannot answer.
 */

export interface GetReportOptions extends AnalyzeOptions {
  /** Ask a running `serve` first (default: true unless `persist` is false; never for overlays). */
  server?: boolean;
  /** Called when the data came from a running server (e.g. to point at its live page). */
  onServer?: (connection: ServerConnection) => void;
}

// `CODE_VISUALIZER_NO_CACHE=1`: lives in the light src/cli/shared.ts (no server client); re-exported for existing callers.
export { cacheDisabledByEnv };

export async function getReport(options: GetReportOptions = {}): Promise<ReportData> {
  const started = Date.now();
  const root = path.resolve(options.root ?? process.cwd());
  const { server: useServer, onServer, ...rest } = options;
  const persist = options.persist ?? !cacheDisabledByEnv();
  // A snapshot (overlay / readText: another ref, the index, a proposed edit) is never what a server holds.
  const snapshot = !!options.overlay || !!options.readText;
  if (!snapshot && (useServer ?? (persist && !options.cache))) {
    const found = await fromServer(root, rest);
    if (found) {
      const { data, connection } = found;
      data.stats.durationMs = Date.now() - started;
      options.onProgress?.('done');
      onServer?.(connection);
      return data;
    }
  }
  const { analyze } = await import('../analyzer/index.js');
  return analyze({ ...rest, root, persist });
}

/**
 * True when a server registered with `info` holds what a local run with `options` would compute:
 * same tool version and analysis scope, and at least the sources, changes, architecture delta
 * (`compare`) and history asked for.
 */
export function serverMatches(root: string, info: ServerInfo, options: AnalyzeOptions): boolean {
  const wantsSource = options.includeSource !== false;
  const wantsChanges = options.git !== false && options.changes !== false;
  return (
    info.version === (options.toolVersion ?? VERSION) &&
    info.fingerprint === analysisFingerprint(root, options) &&
    (!wantsSource || info.includeSource === true) &&
    (!wantsChanges || info.changes === true) &&
    (!wantsChanges || !options.compare || info.compare === true) &&
    // A server without history holds only the current point: taking it would lose the trend.
    (options.history === false || info.history === true)
  );
}

/** The running server's analysis when it matches what was asked for. */
async function fromServer(root: string, options: AnalyzeOptions): Promise<{ data: ReportData; connection: ServerConnection } | undefined> {
  const connection = await connectToServer(root);
  if (!connection || !serverMatches(root, connection.info, options)) return undefined;
  const wantsSource = options.includeSource !== false;
  const wantsChanges = options.git !== false && options.changes !== false;
  let data: ReportData;
  try {
    data = await connection.data({ source: wantsSource });
  } catch {
    return undefined; // the server failed or timed out: analyze locally
  }
  // Present the data as a local run with these options would.
  if (!wantsChanges) delete data.changes;
  else if (!options.compare && data.changes) delete data.changes.delta;
  if (options.history === false) data.history = data.history.slice(-1);
  data.tool = { ...data.tool, version: options.toolVersion ?? data.tool.version };
  data.stats.cache = { reused: data.stats.cache?.reused ?? data.stats.files, parsed: data.stats.cache?.parsed ?? 0, source: 'server' };
  return { data, connection };
}
