import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AnalyzeOptions } from '../analyzer/index.js';
import { readServerInfo, removeServerInfo } from '../analyzer/state.js';
import type { ReportData, ServerInfo } from '../shared/types.js';

/**
 * Client for a running `code-visualizer serve`, found through `.code-visualizer/server.json`.
 * Deliberately light (no analyzer imports) so status lines and hooks can use it cheaply.
 */

export interface ServerRequest {
  method?: string;
  query?: Record<string, string>;
  /** JSON-encoded as the request body. */
  body?: unknown;
  timeoutMs?: number;
}

export interface ServerConnection {
  info: ServerInfo;
  /** The page URL to open in a browser. */
  url: string;
  /** An authenticated JSON request to the server's API (`/api/...`). */
  request<T = unknown>(pathname: string, init?: ServerRequest): Promise<T>;
  /**
   * The server's analysis. `fresh` (default) makes the server pick up edits it has not seen yet;
   * `source: false` (default) leaves out embedded file sources.
   */
  data(opts?: { source?: boolean; fresh?: boolean; timeoutMs?: number }): Promise<ReportData>;
}

/** Analysis options that decide which data a server holds (clients only reuse matching data). */
export function analysisFingerprint(root: string, options: Omit<AnalyzeOptions, 'cache' | 'onProgress'>): string {
  const rel = (p: string | undefined): string | undefined => (p === undefined ? undefined : path.relative(root, path.resolve(process.cwd(), p)).split(path.sep).join('/'));
  return JSON.stringify({
    file: rel(options.file),
    directory: rel(options.directory),
    depth: options.file ? (options.depth ?? null) : null,
    exclude: [...new Set(([] as string[]).concat(options.exclude ?? []))].sort(),
    maxFiles: options.maxFiles ?? null,
    git: options.git !== false,
    base: options.base ?? null,
    // test-intelligence: explicit coverage reports (`--coverage <path>`); the default leaves the fingerprint as it was.
    ...(options.coverage !== undefined ? { coverage: options.coverage === false ? false : [...new Set(options.coverage.map((p) => path.resolve(root, p)))].sort() } : {}),
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function localAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.add(a.address.toLowerCase());
  return out;
}

/**
 * Where to reach a registered server, or undefined when it cannot be one this user started on this
 * machine. Wildcard binds are reached on loopback; besides loopback only addresses of this machine's
 * own interfaces are allowed. A host name or a remote address is never contacted.
 */
export function connectHost(host: string): string | undefined {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '0.0.0.0' || h === '::' || h === '') return '127.0.0.1';
  if (h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return h;
  return net.isIP(h) && localAddresses().has(h) ? h : undefined;
}

function requestJson<T>(info: ServerInfo, host: string, pathname: string, init: ServerRequest = {}): Promise<T> {
  const query = new URLSearchParams(init.query ?? {}).toString();
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        host: host.replace(/^\[|\]$/g, ''),
        port: info.port,
        path: `${pathname}${query ? `?${query}` : ''}`,
        method: init.method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          'X-CV-Token': info.token,
          'Accept-Encoding': 'gzip',
          Host: `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${info.port}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          try {
            let buf = Buffer.concat(chunks);
            if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
            const text = buf.toString('utf8');
            if ((res.statusCode ?? 0) >= 400) {
              let message = text;
              try {
                message = (JSON.parse(text) as { error?: string }).error ?? text;
              } catch {
                /* plain text */
              }
              return reject(new HttpError(res.statusCode ?? 0, message));
            }
            resolve(JSON.parse(text) as T);
          } catch (error) {
            reject(error as Error);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(init.timeoutMs ?? 30_000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function processAlive(pid: number): boolean {
  if (!(pid > 0)) return false; // 0 and negative pids address process groups
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: another user's process, so not a server this user started.
    return false;
  }
}

/** What `.code-visualizer/server.json` leads to. */
export type ServerProbe =
  | { status: 'running'; connection: ServerConnection }
  /** Registered and alive, but it did not answer in time (busy re-analyzing, or stopped). */
  | { status: 'busy'; info: ServerInfo }
  | { status: 'none' };

/**
 * Find the `serve` that analyzes `root`: reads `.code-visualizer/server.json` (only a private file
 * written by this user counts), checks the process and pings the server (default timeout 200 ms).
 * Stale registrations (dead process, nothing listening, another project or token) are removed.
 */
export async function probeServer(root: string, opts: { timeoutMs?: number } = {}): Promise<ServerProbe> {
  const info = readServerInfo(root);
  if (!info) return { status: 'none' };
  const host = connectHost(info.host);
  if (!host) return { status: 'none' }; // not ours: never contacted, left alone
  const stale = (): ServerProbe => {
    removeServerInfo(root, info.token);
    return { status: 'none' };
  };
  if (!processAlive(info.pid)) return stale();
  let ping: { ok?: boolean; root?: string; pid?: number };
  try {
    ping = await requestJson(info, host, '/api/ping', { timeoutMs: opts.timeoutMs ?? 200 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || error instanceof HttpError || error instanceof SyntaxError) return stale();
    return { status: 'busy', info };
  }
  // An authorized ping names the root and pid; anything else on that port is not our server.
  if (!ping.ok || ping.pid !== info.pid || typeof ping.root !== 'string' || realpath(ping.root) !== realpath(root) || realpath(info.root) !== realpath(root)) return stale();
  const display = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = info.url ?? `http://${display}:${info.port}/`;
  const connection: ServerConnection = {
    info,
    url,
    request: (pathname, init) => requestJson(info, host, pathname, init),
    async data({ source = false, fresh = true, timeoutMs } = {}) {
      const query: Record<string, string> = {};
      if (!source) query.source = '0';
      if (fresh) query.fresh = '1';
      return requestJson<ReportData>(info, host, '/api/data', { query, timeoutMs: timeoutMs ?? 60_000 });
    },
  };
  return { status: 'running', connection };
}

/**
 * The running `serve` for `root`, or undefined (none registered, stale, or busy: a server that does
 * not answer in time is left registered and treated as absent). See `probeServer` for the reason.
 */
export async function connectToServer(root: string, opts: { timeoutMs?: number } = {}): Promise<ServerConnection | undefined> {
  const probe = await probeServer(root, opts);
  return probe.status === 'running' ? probe.connection : undefined;
}
