import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import type { AnalyzeOptions } from '../analyzer/index.js';
import { blameFile } from '../analyzer/git.js';
import { ensureStateDir } from '../analyzer/health.js';
import { removeServerInfo, writeServerInfo } from '../analyzer/state.js';
import { SyncError } from '../analyzer/sync.js';
import { toCodeTour } from '../analyzer/tours.js';
import { findTemplate, renderReportHtml } from '../report/html.js';
import { liveEventLine, openProblemCount } from '../shared/live.js';
import type { LiveEvent, LiveEventKind, LiveUpdate, ReportData, ServerInfo } from '../shared/types.js';
import { VERSION } from '../version.js';
import { analysisFingerprint } from './client.js';
import { createDailyLoopService } from './daily-loop.js';
import { createEngine, type Engine } from './engine.js';
import { createReviewService } from './review.js';

export interface ServeOptions extends Omit<AnalyzeOptions, 'cache' | 'onProgress'> {
  port?: number;
  host?: string;
  writeHistory?: boolean;
  log?: (message: string) => void;
  /**
   * Register the server in `.code-visualizer/server.json` so other commands reuse its analysis
   * (default: true). `serve --new` next to a running server does not take over the registration.
   */
  register?: boolean;
  /**
   * Live events (what got worse or better) of every re-analysis. Without it they are written to `log`
   * as plain lines under the update line. `serve` (CLI) colours them.
   */
  onEvents?: (events: LiveEvent[]) => void;
  /** Event kinds not to announce (also `serve.events.exclude` in the configuration). */
  excludeEvents?: LiveEventKind[];
}

export interface LiveServer {
  url: string;
  /** True when the server listens on a non-loopback interface (reachable from other machines). */
  exposed: boolean;
  /** The latest analysis. */
  current(): ReportData;
  close(): Promise<void>;
  /** Resolves after the next re-analysis (used in tests). */
  refresh(): Promise<void>;
  /** The analysis engine (watchers, re-analysis queue, update listeners). */
  engine: Engine;
  /** What is (or, without `register`, would be) written to `.code-visualizer/server.json`. */
  info: ServerInfo;
}

const EDITORS: Record<string, (file: string, line: number) => [string, string[]]> = {
  vscode: (f, l) => ['code', ['-g', `${f}:${l}`]],
  cursor: (f, l) => ['cursor', ['-g', `${f}:${l}`]],
  windsurf: (f, l) => ['windsurf', ['-g', `${f}:${l}`]],
  webstorm: (f, l) => ['webstorm', ['--line', String(l), f]],
  idea: (f, l) => ['idea', ['--line', String(l), f]],
  zed: (f, l) => ['zed', [`${f}:${l}`]],
  sublime: (f, l) => ['subl', [`${f}:${l}`]],
};

function launchEditor(editor: string, file: string, line: number): Promise<boolean> {
  const [cmd, args] = EDITORS[editor](file, line);
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    if (win && /["%^&|<>]/.test(file)) return resolve(false);
    const child = spawn(cmd, win ? args.map((a) => `"${a}"`) : args, { detached: true, stdio: 'ignore', shell: win, windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return !!address && (address === '::1' || /^(::ffff:)?127\./.test(address));
}

async function readBody(req: http.IncomingMessage, limit = 2_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tour';
}

/**
 * Live companion: serves the report on localhost, watches the project and git,
 * re-analyzes incrementally and pushes updates to open browser tabs (Server-Sent Events).
 */
export async function serve(options: ServeOptions): Promise<LiveServer> {
  const root = path.resolve(options.root ?? process.cwd());
  const log = options.log ?? (() => undefined);
  const host = options.host ?? '127.0.0.1';
  const envEditor = process.env.CODE_VISUALIZER_EDITOR?.trim().toLowerCase();
  const defaultEditor = envEditor && Object.hasOwn(EDITORS, envEditor) ? envEditor : 'vscode';
  if (envEditor && envEditor !== defaultEditor) log(`! Unknown CODE_VISUALIZER_EDITOR "${envEditor}" (supported: ${Object.keys(EDITORS).join(', ')}); using vscode.`);
  // On a non-loopback interface other machines can connect, so even the page itself requires the token.
  const exposed = !isLoopbackHost(host);
  const token = crypto.randomBytes(18).toString('base64url');
  const template = findTemplate();
  const notesFile = path.join(root, '.code-visualizer', 'notes.json');
  const { port: _port, host: _host, writeHistory: _history, log: _log, register: _register, onEvents: _onEvents, excludeEvents, ...rest } = options;
  // compare: `changes.delta` on every update; the base snapshot is computed once per base commit
  // (memoized), later runs only diff.
  const analysis = { ...rest, compare: rest.compare ?? true };

  // The engine owns the cache, the watchers and the coalescing re-analysis queue.
  // events: the live guard compares every analysis with the previous one (a few ms).
  const engine = createEngine({ root, options: analysis, mode: 'eager', writeHistory: options.writeHistory !== false, log, events: { exclude: excludeEvents } });
  try {
    await engine.current();
  } catch (error) {
    engine.close();
    throw error;
  }
  const latest = (): ReportData => engine.latest()!;
  let html: { data: ReportData; body: Buffer } | undefined;
  // Gzipped JSON per analysis, with and without embedded sources.
  let json: { data: ReportData; full?: Buffer; lite?: Buffer } | undefined;
  const jsonBody = (data: ReportData, withSource: boolean): Buffer => {
    if (json?.data !== data) json = { data };
    const key = withSource ? 'full' : 'lite';
    const payload = withSource || !data.options.includeSource ? data : { ...data, files: data.files.map(({ source: _s, ...f }) => f) };
    return (json[key] ??= zlib.gzipSync(JSON.stringify(payload), { level: 4 }));
  };

  // --- review-mode: plans of other branches / pull requests, and what the reviewer viewed ---
  const reviews = createReviewService(root, analysis);
  // --- /review-mode ---

  const clients = new Set<http.ServerResponse>();
  const broadcast = (event: string, payload: unknown): void => {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(message);
  };
  const offUpdate = engine.onUpdate(({ data, changed, durationMs, version, events = [] }) => {
    const open = engine.feed().open;
    // The open list rides along: problems also close silently (a commit, a revert), without an event.
    const update: LiveUpdate = { version, changed: changed.slice(0, 50), durationMs, files: data.stats.files, events, open: openProblemCount(open), openProblems: open.slice(-50) };
    broadcast('update', update);
    log(`↻ ${changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'}` : 'update'} · re-analyzed ${data.stats.files} files in ${durationMs}ms`);
    if (!events.length) return;
    if (options.onEvents) options.onEvents(events);
    else for (const e of events) log(`  ${liveEventLine(e)}`);
  });
  // --- daily-loop: GET /api/status, GET /api/sync, and the status snapshot for prompts ---
  const daily = createDailyLoopService({ root, engine, url: () => info.url ?? '', persist: !!analysis.persist, base: analysis.base, log });
  const offStatus = engine.onUpdate(() => daily.scheduleWrite());
  daily.scheduleWrite();
  const offError = engine.onError((error) => {
    broadcast('error', { message: error.message });
    log(`✖ ${error.message}`);
  });

  const info: ServerInfo = {
    pid: process.pid,
    port: 0,
    host,
    token,
    root,
    version: options.toolVersion ?? VERSION,
    startedAt: Date.now(),
    fingerprint: analysisFingerprint(root, analysis),
    includeSource: analysis.includeSource !== false,
    changes: analysis.git !== false && analysis.changes !== false,
    history: analysis.history !== false && options.writeHistory !== false,
    // A delta needs changes to compare (see analyze()).
    compare: analysis.compare === true && analysis.git !== false && analysis.changes !== false,
  };

  const allowedHosts = new Set<string>();
  const checkHost = (req: http.IncomingMessage): boolean => {
    if (host === '0.0.0.0' || host === '::') return true;
    const h = (req.headers.host ?? '').toLowerCase();
    return allowedHosts.has(h);
  };
  const authorized = (req: http.IncomingMessage, url: URL): boolean => req.headers['x-cv-token'] === token || url.searchParams.get('token') === token;
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(text);
  };
  const resolveInRoot = (rel: string | null): string | undefined => {
    if (!rel) return undefined;
    const abs = path.resolve(root, rel);
    const relative = path.relative(root, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return fs.existsSync(abs) ? abs : undefined;
  };
  // --- agent-guardrails: what-if paths may name files that do not exist yet, but never leave the root ---
  const inRoot = (rel: string): boolean => {
    if (!rel || rel.includes('\0')) return false;
    const relative = path.relative(root, path.resolve(root, rel));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  /** A path inside the root (relative or absolute) as the project-relative id analyses use. */
  const projectId = (file: string): string => path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  /** The text of a project file (an id inside the root) as it is on disk now; null when it is gone. */
  const projectText = (id: string): string | null => {
    try {
      return fs.readFileSync(path.join(root, id), 'utf8');
    } catch {
      return null;
    }
  };
  /** `{file, text}` or `{overlay: {path: text | null}}` as an overlay, or what is wrong with it. */
  const whatIfOverlay = (body: { file?: unknown; text?: unknown; overlay?: unknown }): Record<string, string | null> | string => {
    const raw: Record<string, unknown> =
      body.overlay && typeof body.overlay === 'object' && !Array.isArray(body.overlay) ? (body.overlay as Record<string, unknown>) : typeof body.file === 'string' ? { [body.file]: body.text ?? null } : {};
    const entries = Object.entries(raw);
    if (!entries.length) return 'Pass {file, text} or {overlay: {path: text}}';
    const overlay: Record<string, string | null> = {};
    for (const [file, text] of entries) {
      if (!inRoot(file)) return `Not a path inside the project: ${file}`;
      if (text !== null && typeof text !== 'string') return `The text of ${file} must be a string or null`;
      overlay[projectId(file)] = text;
    }
    return overlay;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!checkHost(req)) return send(res, 403, 'Forbidden host');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (exposed && !authorized(req, url)) return send(res, 401, 'Open the link printed in the terminal that runs code-visualizer — it contains an access token.');
        const data = latest();
        if (html?.data !== data) html = { data, body: Buffer.from(renderReportHtml(data, template, { live: { token, version: engine.version(), editor: defaultEditor } })) };
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html.body);
      }
      if (url.pathname === '/api/ping') {
        // With the token, the ping also identifies the server (CLI clients check the root).
        const ping = { ok: true, version: engine.version() };
        return send(res, 200, authorized(req, url) ? { ...ping, root, pid: process.pid, tool: info.version, startedAt: info.startedAt } : ping);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, 'Not found');
      if (!authorized(req, url)) return send(res, 401, { error: 'Missing or invalid token' });

      if (req.method === 'GET' && url.pathname === '/api/data') {
        // `fresh=1` (CLI clients): first pick up edits the watcher has not reported yet. `source=0`: no embedded sources.
        const data = url.searchParams.get('fresh') === '1' ? await engine.current({ verify: true }) : latest();
        // --- mcp-server: `since=<version>` (a client holding that analysis) gets a short answer when nothing changed ---
        if (url.searchParams.get('since') === String(engine.version())) return send(res, 200, { unchanged: true, version: engine.version() });
        const body = jsonBody(data, url.searchParams.get('source') !== '0');
        if (gzip) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', 'X-CV-Version': String(engine.version()) });
          return res.end(body);
        }
        return send(res, 200, zlib.gunzipSync(body).toString('utf8'), { 'Content-Type': 'application/json; charset=utf-8' });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ version: engine.version() })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      // --- review-mode ---
      if (url.pathname === '/api/review' || url.pathname === '/api/review-state' || url.pathname === '/api/review-refs') {
        const review = await reviews.handle(req.method ?? 'GET', url.pathname, url.searchParams, () => readBody(req));
        if (!review) return send(res, 405, { error: 'Method not allowed' });
        const text = JSON.stringify(review.body);
        // Plans carry the diffs of the reviewed change.
        if (gzip && text.length > 32_768) {
          res.writeHead(review.status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
          return res.end(zlib.gzipSync(text, { level: 4 }));
        }
        return send(res, review.status, text, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      // --- /review-mode ---
      // --- daily-loop ---
      if (req.method === 'GET' && url.pathname === '/api/status') {
        // A server for part of the project does not describe the project: status lines use their snapshot.
        const status = await daily.status();
        return status ? send(res, 200, status) : send(res, 404, { error: 'This server analyzes part of the project.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/sync') {
        // Local refs only: fetching is the CLI's opt-in (`sync --fetch`), never a page's.
        const base = url.searchParams.get('base')?.trim() || undefined;
        if (base?.startsWith('-')) return send(res, 400, { error: 'Invalid base' });
        const days = Number(url.searchParams.get('since') ?? '');
        try {
          return send(res, 200, await daily.sync({ base, branches: url.searchParams.get('branches') === '1', since: days > 0 ? days * 24 * 3600 * 1000 : undefined }));
        } catch (error) {
          if (error instanceof SyncError) return send(res, 400, { error: error.message });
          throw error;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/events/history') {
        // This session's live feed (ring buffer) and the problems still open.
        return send(res, 200, engine.feed());
      }
      // --- agent-guardrails: what an edit would change (pre-edit guard), or left behind (post-edit radar) ---
      if (req.method === 'POST' && url.pathname === '/api/whatif') {
        if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, 403, { error: 'What-if analyses are only answered on the machine that runs code-visualizer' });
        let body: { file?: unknown; text?: unknown; overlay?: unknown; guard?: unknown; files?: unknown; signatures?: unknown };
        try {
          body = JSON.parse(await readBody(req, 16_000_000)) as typeof body;
        } catch (error) {
          return send(res, 400, { error: `Invalid request: ${(error as Error).message}` });
        }
        const overlay = whatIfOverlay(body);
        if (typeof overlay === 'string') return send(res, 400, { error: overlay });
        const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === 'string' && inRoot(f)).map(projectId) : Object.keys(overlay);
        const guard = body.guard === 'pre-edit' || body.guard === 'post-edit' ? body.guard : undefined;
        const [{ compareReports }, { loadConfig }] = await Promise.all([import('../analyzer/compare.js'), import('../analyzer/config.js')]);
        const { config } = loadConfig(root);
        // The project now (with edits the watcher has not reported yet) and with the overlay.
        const now = await engine.current({ verify: true });
        // Copies the session pasted are post-edit findings; the pre-edit guard needs no clone detection.
        const other = await engine.whatIf(overlay, undefined, { clones: guard !== 'pre-edit' });
        const options = { files, config, complexityThreshold: config.check?.maxComplexity };
        if (guard) {
          const { overlayLineChanges, postEditFindings, preEditFindings } = await import('../agent/guard.js');
          const signatures = body.signatures && typeof body.signatures === 'object' && !Array.isArray(body.signatures) ? (body.signatures as Record<string, string>) : undefined;
          // post-edit: the overlay holds the touched files as the session found them; the disk has them now.
          const changedLines = guard === 'post-edit' ? overlayLineChanges(overlay, projectText) : undefined;
          const findings = guard === 'pre-edit' ? preEditFindings(now, other, options) : postEditFindings(other, now, { ...options, signatures, changedLines });
          return send(res, 200, { version: engine.version(), findings });
        }
        return send(res, 200, { version: engine.version(), delta: compareReports(now, other, { config, changedFiles: files, areas: false, complexityThreshold: options.complexityThreshold }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/open') {
        if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, 403, { error: 'Files can only be opened on the machine that runs code-visualizer' });
        const body = JSON.parse(await readBody(req)) as { file?: string; line?: number; editor?: string };
        const abs = resolveInRoot(body.file ?? null);
        if (!abs) return send(res, 404, { error: 'File not found' });
        const editor = body.editor ?? defaultEditor;
        if (!Object.hasOwn(EDITORS, editor)) return send(res, 400, { error: `Unknown editor "${editor}" (supported: ${Object.keys(EDITORS).join(', ')})` });
        const ok = await launchEditor(editor, abs, Math.max(1, Number(body.line) || 1));
        return send(res, ok ? 200 : 404, ok ? { ok } : { error: 'Editor command not found on PATH' });
      }
      if (req.method === 'GET' && url.pathname === '/api/blame') {
        const file = url.searchParams.get('file');
        if (!resolveInRoot(file)) return send(res, 404, { error: 'File not found' });
        const ranges = await blameFile(root, file!);
        return send(res, ranges ? 200 : 404, ranges ?? { error: 'No git history for this file' });
      }
      if (url.pathname === '/api/notes') {
        if (req.method === 'GET') {
          const text = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '{}';
          return send(res, 200, text, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (req.method === 'PUT') {
          const body = await readBody(req);
          JSON.parse(body); // validate
          ensureStateDir(path.dirname(notesFile));
          fs.writeFileSync(notesFile, body);
          return send(res, 200, { ok: true });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/tours') {
        const tour = JSON.parse(await readBody(req)) as { title?: string; description?: string; steps?: { title?: string; description: string; file?: string; line?: number }[] };
        if (!tour.title || !tour.steps?.length) return send(res, 400, { error: 'A tour needs a title and at least one step' });
        const rel = path.join('.tours', `${slugify(tour.title)}.tour`);
        fs.mkdirSync(path.join(root, '.tours'), { recursive: true });
        fs.writeFileSync(path.join(root, rel), toCodeTour({ title: tour.title, description: tour.description, steps: tour.steps }));
        engine.markDirty([rel]);
        return send(res, 200, { ok: true, path: rel.split(path.sep).join('/') });
      }
      return send(res, 404, { error: 'Unknown endpoint' });
    } catch (error) {
      return send(res, 500, { error: (error as Error).message });
    }
  });

  const listen = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      let attempt = options.port ?? 4747;
      const tryListen = (): void => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attempt < (options.port ?? 4747) + 20) {
            attempt++;
            tryListen();
          } else reject(err);
        });
        // Read the port back: with `port: 0` the OS picks a free one.
        server.listen(attempt, host, () => resolve((server.address() as AddressInfo | null)?.port ?? attempt));
      };
      tryListen();
    });

  let port: number;
  try {
    port = await listen();
  } catch (error) {
    engine.close();
    throw error;
  }
  for (const h of ['127.0.0.1', 'localhost', '[::1]', host]) allowedHosts.add(`${h}:${port}`.toLowerCase());
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host === '127.0.0.1' ? '127.0.0.1' : host;
  const url = `http://${displayHost.includes(':') && !displayHost.startsWith('[') ? `[${displayHost}]` : displayHost}:${port}/${exposed ? `?token=${token}` : ''}`;
  Object.assign(info, { port, url });

  // Let other commands (CLI, hooks, MCP) find and reuse this server; unregister on the way out.
  const register = options.register !== false;
  const unregister = (): void => removeServerInfo(root, token);
  if (register) {
    try {
      writeServerInfo(root, info);
      process.on('exit', unregister);
    } catch (error) {
      log(`! Could not write .code-visualizer/server.json (${(error as Error).message}); other commands will not reuse this server.`);
    }
  }

  return {
    url,
    exposed,
    current: latest,
    engine,
    info,
    async close() {
      offUpdate();
      offStatus();
      daily.close();
      offError();
      engine.close();
      if (register) {
        process.off('exit', unregister);
        unregister();
      }
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async refresh() {
      await engine.reanalyze().catch(() => undefined);
    },
  };
}
