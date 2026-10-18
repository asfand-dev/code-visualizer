import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readServerInfo, serverInfoPath, writeServerInfo } from '../src/analyzer/state.js';
import { decideServe } from '../src/cli/commands/serve.js';
import { connectToServer, getReport, serverMatches, type ServerConnection, type ServerProbe } from '../src/cli/engine.js';
import { runCli } from '../src/cli/run.js';
import { analysisFingerprint, connectHost } from '../src/server/client.js';
import { isLoopbackHost, serve, type LiveServer } from '../src/server/index.js';
import type { LiveFeed, LiveUpdate, ReportData, ReviewPlan, ReviewRef, ServerInfo } from '../src/shared/types.js';
import { appendFile, commitAll, copyFixture, daysAgo, git, hasGit, httpRequest, initRepo, isolateGit, makeTempDir, openEventStream, removeTempDirs, writeFile, type HttpResult } from './companion-helpers.js';

const hasTemplate = fs.existsSync(fileURLToPath(new URL('../dist/report/index.html', import.meta.url)));


const json = (r: HttpResult): unknown => JSON.parse(r.text);

const SUPPORTED_EDITORS = 'vscode, cursor, windsurf, webstorm, idea, zed, sublime';

/**
 * Run `fn` with PATH pointing at an empty directory, so that even if a request reached the editor
 * launcher no editor could start (the server runs in this process and spawns with process.env).
 */
async function withoutEditorsOnPath<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = makeTempDir('cv-empty-path-');
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** Run the CLI in-process and capture stdout (colours stripped). */
async function runCliCaptured(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write);
  try {
    const code = await runCli(argv);
    return { code, stdout: stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') };
  } finally {
    spy.mockRestore();
  }
}

/** Start the CLI in-process; its output can be read while it runs (e.g. a server until SIGINT). */
function startCli(...argv: string[]): { done: Promise<number>; finished: () => boolean; output: () => string } {
  let output = '';
  let finished = false;
  const capture = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  const done = runCli(argv).finally(() => {
    finished = true;
    out.mockRestore();
    err.mockRestore();
  });
  return { done, finished: () => finished, output: () => output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') };
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const historyPoints = (root: string): unknown[] => (JSON.parse(fs.readFileSync(path.join(root, '.code-visualizer', 'history.json'), 'utf8')) as { points: unknown[] }).points;

/** A pid that certainly belongs to no running process. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

function setEnv(key: string, value: string | undefined): () => void {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
}

describe('connectHost (where a registered server may be contacted)', () => {
  it('allows loopback, wildcard binds and this machine\'s own addresses only', () => {
    expect(connectHost('0.0.0.0')).toBe('127.0.0.1');
    expect(connectHost('::')).toBe('127.0.0.1');
    for (const h of ['127.0.0.1', '127.0.0.5', 'localhost', '::1']) expect(connectHost(h), h).toBe(h);
    expect(connectHost('[::1]')).toBe('::1');
    const own = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (own) expect(connectHost(own.address)).toBe(own.address);
    for (const h of ['attacker.example', 'localhost.evil.com', '8.8.8.8', '203.0.113.7', '2001:db8::1']) expect(connectHost(h), h).toBeUndefined();
  });
});

describe('decideServe (one server per project)', () => {
  const root = path.resolve('/projects/app');
  const options = { root, git: false, includeSource: false, changes: false, persist: true };
  const info = {
    pid: 42,
    port: 4747,
    host: '127.0.0.1',
    token: 't',
    root,
    version: '1.0.0',
    startedAt: 1,
    fingerprint: analysisFingerprint(root, options),
    includeSource: false,
    changes: false,
    history: true,
  };
  const running = (over: Partial<typeof info> = {}): ServerProbe => ({ status: 'running', connection: { info: { ...info, ...over }, url: 'http://127.0.0.1:4747/' } as ServerConnection });

  it('reuses a server started with the same options', () => {
    expect(decideServe(running(), root, options, {})).toEqual({ action: 'reuse', url: 'http://127.0.0.1:4747/', pid: 42 });
    expect(decideServe(running(), root, options, { port: 4747, host: '127.0.0.1' }).action).toBe('reuse');
    expect(decideServe({ status: 'none' }, root, options, {})).toEqual({ action: 'start', register: true });
  });

  it('starts a separate, unregistered server for other options, --new, --no-cache or a busy server', () => {
    const separate = (d: ReturnType<typeof decideServe>) => d.action === 'start' && !d.register;
    expect(separate(decideServe(running(), root, { ...options, file: 'src/App.tsx' }, {}))).toBe(true);
    expect(separate(decideServe(running(), root, { ...options, exclude: ['test/**'] }, {}))).toBe(true);
    expect(separate(decideServe(running(), root, { ...options, includeSource: true }, {}))).toBe(true);
    expect(separate(decideServe(running(), root, { ...options, git: true, changes: true }, {}))).toBe(true);
    expect(separate(decideServe(running(), root, options, { port: 5000 }))).toBe(true);
    expect(separate(decideServe(running(), root, options, { host: '0.0.0.0' }))).toBe(true);
    expect(separate(decideServe(running(), root, options, { new: true }))).toBe(true);
    expect(separate(decideServe(running(), root, { ...options, persist: false }, {}))).toBe(true);
    const busy = decideServe({ status: 'busy', info }, root, options, {});
    expect(busy).toMatchObject({ action: 'start', register: false, note: expect.stringContaining('not responding') });
    expect(decideServe(running(), root, { ...options, file: 'src/App.tsx' }, {})).toMatchObject({ note: expect.stringContaining('with other options runs at http://127.0.0.1:4747/') });
  });
});

describe('serverMatches (whose data a CLI run may take)', () => {
  const root = path.resolve('/projects/app');
  const options = { root, includeSource: false, history: false };
  const info: ServerInfo = {
    pid: 42,
    port: 4747,
    host: '127.0.0.1',
    token: 't',
    root,
    version: '1.0.0',
    startedAt: 1,
    fingerprint: analysisFingerprint(root, options),
    includeSource: false,
    changes: true,
    history: true,
  };
  it('takes server data for an architecture delta (pr, check --changed) only when the server computes one', () => {
    expect(serverMatches(root, { ...info, compare: true }, { ...options, toolVersion: '1.0.0', compare: true })).toBe(true);
    expect(serverMatches(root, info, { ...options, toolVersion: '1.0.0', compare: true })).toBe(false);
    expect(serverMatches(root, info, { ...options, toolVersion: '1.0.0' })).toBe(true);
    // Without changes there is nothing to compare, locally or on the server.
    expect(serverMatches(root, { ...info, changes: false }, { ...options, toolVersion: '1.0.0', changes: false, compare: true })).toBe(true);
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback names and addresses', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.1', 'example.com', 'localhost.evil.com']) expect(isLoopbackHost(h), h).toBe(false);
  });
});

describe.skipIf(!hasTemplate)('live server (requires dist/report/index.html)', () => {
  let root: string;
  let outsideFile: string;
  let server: LiveServer;
  let base: string;
  let port: string;
  let token: string;
  const api = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    httpRequest(new URL(p, base).toString(), { ...init, headers: { 'X-CV-Token': token, ...init.headers } });

  let restoreEditor: () => void;

  beforeAll(async () => {
    root = copyFixture('react-vite-ts', 'cv-serve-');
    outsideFile = path.join(path.dirname(root), 'outside.txt');
    fs.writeFileSync(outsideFile, 'not part of the project');
    // A deterministic default editor whose CLI is never reachable in these tests (see withoutEditorsOnPath).
    restoreEditor = setEnv('CODE_VISUALIZER_EDITOR', 'zed');
    server = await serve({ root, port: 0, git: false, includeSource: false, writeHistory: false });
    base = server.url;
    port = new URL(base).port;
    const page = await httpRequest(base);
    const live = page.text.match(/window\.__CV_LIVE__=(\{[^<]*?\});/);
    if (!live) throw new Error('window.__CV_LIVE__ not found in the served page');
    token = (JSON.parse(live[1]) as { token: string }).token;
  });

  afterAll(async () => {
    await server?.close();
    restoreEditor?.();
    removeTempDirs();
  });

  describe('page and auth', () => {
    it('listens on the free port the OS picked for port 0', () => {
      expect(Number(port)).toBeGreaterThan(0);
    });

    it('serves the report on loopback with the live token and version embedded', async () => {
      expect(server.exposed).toBe(false);
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await httpRequest(base);
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.text).toContain('<title>react-vite-ts · Code Visualizer</title>');
      expect(token).toMatch(/^[\w-]{20,}$/);
      const live = JSON.parse(page.text.match(/window\.__CV_LIVE__=(\{[^<]*?\});/)![1]);
      expect(live).toMatchObject({ token, version: 1, editor: 'zed' });
      expect((await httpRequest(new URL('/index.html', base).toString())).status).toBe(200);
    });

    it('answers pings without a token', async () => {
      const ping = await httpRequest(new URL('/api/ping', base).toString());
      expect(ping.status).toBe(200);
      expect(json(ping)).toEqual({ ok: true, version: expect.any(Number) });
    });

    it('identifies itself (root, pid) only to pings with the token', async () => {
      const ping = await api('/api/ping');
      expect(json(ping)).toEqual({ ok: true, version: expect.any(Number), root, pid: process.pid, tool: expect.any(String), startedAt: expect.any(Number) });
    });

    it('rejects API calls without a valid token', async () => {
      for (const p of ['/api/data', '/api/events', '/api/notes', '/api/blame?file=src/main.tsx']) {
        const res = await httpRequest(new URL(p, base).toString());
        expect(res.status, p).toBe(401);
        expect(json(res), p).toEqual({ error: 'Missing or invalid token' });
      }
      expect((await httpRequest(new URL('/api/data', base).toString(), { headers: { 'X-CV-Token': 'wrong' } })).status).toBe(401);
      expect((await httpRequest(new URL('/api/data?token=wrong', base).toString())).status).toBe(401);
      const tour = await httpRequest(new URL('/api/tours', base).toString(), { method: 'POST', body: JSON.stringify({ title: 'Sneaky', steps: [{ description: 'x' }] }) });
      expect(tour.status).toBe(401);
      expect(fs.existsSync(path.join(root, '.tours', 'sneaky.tour'))).toBe(false);
      const notes = await httpRequest(new URL('/api/notes', base).toString(), { method: 'PUT', body: '{"x":1}' });
      expect(notes.status).toBe(401);
      expect(fs.existsSync(path.join(root, '.code-visualizer', 'notes.json'))).toBe(false);
    });

    it('rejects requests with a foreign Host header (DNS rebinding), even with the token', async () => {
      for (const p of ['/', '/api/ping', `/api/data?token=${token}`]) {
        const res = await httpRequest(new URL(p, base).toString(), { headers: { Host: `evil.example.com:${port}` } });
        expect(res.status, p).toBe(403);
        expect(res.text, p).toBe('Forbidden host');
      }
      expect((await httpRequest(new URL('/api/ping', base).toString(), { headers: { Host: 'evil.example.com' } })).status).toBe(403);
      expect((await httpRequest(new URL('/api/ping', base).toString(), { headers: { Host: `localhost:${port}` } })).status).toBe(200);
      expect((await httpRequest(new URL('/api/ping', base).toString(), { headers: { Host: `127.0.0.1:${port}` } })).status).toBe(200);
    });

    it('answers unknown paths with 404', async () => {
      expect((await httpRequest(new URL('/nope', base).toString())).status).toBe(404);
      const unknown = await api('/api/nope');
      expect(unknown.status).toBe(404);
      expect(json(unknown)).toEqual({ error: 'Unknown endpoint' });
    });
  });

  describe('data', () => {
    it('serves the analysis as JSON with the header token or ?token=', async () => {
      const viaHeader = await api('/api/data');
      expect(viaHeader.status).toBe(200);
      expect(viaHeader.headers['content-type']).toContain('application/json');
      const data = json(viaHeader) as { project: { name: string }; files: unknown[]; options: { git: boolean } };
      expect(data.project.name).toBe('react-vite-ts');
      expect(data.files).toHaveLength(28);
      expect(data.options.git).toBe(false);
      const viaQuery = await httpRequest(new URL(`/api/data?token=${encodeURIComponent(token)}`, base).toString());
      expect(viaQuery.status).toBe(200);
      expect((json(viaQuery) as typeof data).project.name).toBe('react-vite-ts');
    });

    it('gzips the analysis when the client accepts it', async () => {
      const res = await api('/api/data', { headers: { 'Accept-Encoding': 'gzip' } });
      expect(res.status).toBe(200);
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(Number(res.headers['x-cv-version'])).toBeGreaterThanOrEqual(1);
      const data = JSON.parse(zlib.gunzipSync(res.body).toString('utf8')) as { project: { name: string } };
      expect(data.project.name).toBe('react-vite-ts');
    });
  });

  describe('file access', () => {
    it('/api/blame refuses paths outside the project', async () => {
      const attempts = ['../outside.txt', 'src/../../outside.txt', outsideFile, '/etc/hosts', '', 'src/does-not-exist.ts'];
      for (const file of attempts) {
        const res = await api(`/api/blame?file=${encodeURIComponent(file)}`);
        expect(res.status, file).toBe(404);
        expect(json(res), file).toEqual({ error: 'File not found' });
      }
      expect((await api('/api/blame')).status).toBe(404);
      // A real project file gets past the path check (there is just no git history in this copy).
      const inside = await api('/api/blame?file=src/main.tsx');
      expect(inside.status).toBe(404);
      expect(json(inside)).toEqual({ error: 'No git history for this file' });
    });

    // Never let these requests start a real editor: `code` / `cursor` may be installed on the machine.
    const open = (body: object) => withoutEditorsOnPath(() => api('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

    it('/api/open refuses paths outside the project', async () => {
      for (const file of ['../outside.txt', outsideFile, 'src/../../outside.txt', '/etc/hosts', 'src/does-not-exist.ts']) {
        const res = await open({ file, line: 1, editor: 'zed' });
        expect(res.status, file).toBe(404);
        expect(json(res), file).toEqual({ error: 'File not found' });
      }
      expect((await open({})).status).toBe(404);
      const noToken = await withoutEditorsOnPath(() => httpRequest(new URL('/api/open', base).toString(), { method: 'POST', body: JSON.stringify({ file: '../outside.txt' }) }));
      expect(noToken.status).toBe(401);
    });

    it('/api/open rejects unknown editors and reports a missing editor command', async () => {
      const unknown = await open({ file: 'src/main.tsx', line: 3, editor: 'notepad' });
      expect(unknown.status).toBe(400);
      expect(json(unknown)).toEqual({ error: `Unknown editor "notepad" (supported: ${SUPPORTED_EDITORS})` });
      // With no editor CLI on PATH the launch fails cleanly — explicitly chosen and default (CODE_VISUALIZER_EDITOR) editor.
      for (const body of [{ file: 'src/main.tsx', line: 3, editor: 'zed' }, { file: 'src/main.tsx' }]) {
        const res = await open(body);
        expect(res.status, JSON.stringify(body)).toBe(404);
        expect(json(res)).toEqual({ error: 'Editor command not found on PATH' });
      }
    });
  });

  describe('notes and tours', () => {
    it('stores notes in .code-visualizer/notes.json', async () => {
      const notesFile = path.join(root, '.code-visualizer', 'notes.json');
      const empty = await api('/api/notes');
      expect(empty.status).toBe(200);
      expect(json(empty)).toEqual({});
      const notes = { 'src/main.tsx': [{ line: 3, text: 'Why is StrictMode off?', author: 'me' }] };
      const put = await api('/api/notes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(notes) });
      expect(put.status).toBe(200);
      expect(json(put)).toEqual({ ok: true });
      expect(JSON.parse(fs.readFileSync(notesFile, 'utf8'))).toEqual(notes);
      expect(fs.existsSync(path.join(root, '.code-visualizer', '.gitignore'))).toBe(true);
      expect(json(await api('/api/notes'))).toEqual(notes);

      const invalid = await api('/api/notes', { method: 'PUT', body: '{ not json' });
      expect(invalid.status).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(fs.readFileSync(notesFile, 'utf8'))).toEqual(notes);
    });

    it('saves tours as CodeTour files inside .tours/ and picks them up on the next analysis', async () => {
      const tour = { title: 'Onboarding: Day 1!', description: 'Where to start', steps: [{ title: 'Entry', description: 'The app boots here.', file: 'src/main.tsx', line: 1 }] };
      const res = await api('/api/tours', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tour) });
      expect(res.status).toBe(200);
      expect(json(res)).toEqual({ ok: true, path: '.tours/onboarding-day-1.tour' });
      const written = JSON.parse(fs.readFileSync(path.join(root, '.tours', 'onboarding-day-1.tour'), 'utf8'));
      expect(written).toEqual({ $schema: 'https://aka.ms/codetour-schema', ...tour });

      // Titles cannot escape the .tours folder.
      const sneaky = await api('/api/tours', { method: 'POST', body: JSON.stringify({ title: '../../outside', steps: [{ description: 'x' }] }) });
      expect(json(sneaky)).toEqual({ ok: true, path: '.tours/outside.tour' });
      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('not part of the project');

      for (const bad of [{ title: 'No steps', steps: [] }, { steps: [{ description: 'no title' }] }]) {
        const r = await api('/api/tours', { method: 'POST', body: JSON.stringify(bad) });
        expect(r.status).toBe(400);
        expect(json(r)).toEqual({ error: 'A tour needs a title and at least one step' });
      }

      await server.refresh();
      const tours = server.current().tours;
      expect(tours.find((t) => t.source === '.tours/onboarding-day-1.tour')).toMatchObject({ title: 'Onboarding: Day 1!', steps: [{ file: 'src/main.tsx', line: 1 }] });
    });
  });

  describe('live updates', () => {
    it('re-analyzes on refresh(): new version, change visible in current(), /api/data and an SSE "update"', async () => {
      const before = (json(await httpRequest(new URL('/api/ping', base).toString())) as { version: number }).version;
      const events = openEventStream(new URL(`/api/events?token=${encodeURIComponent(token)}`, base).toString());
      try {
        const hello = await events.waitFor((e) => e.event === 'hello');
        expect(hello.data).toEqual({ version: expect.any(Number) });

        appendFile(root, 'src/utils/math.ts', '\nexport function addedLater(): number {\n  return 42;\n}\n');
        await server.refresh();

        const after = (json(await httpRequest(new URL('/api/ping', base).toString())) as { version: number }).version;
        expect(after).toBeGreaterThan(before);
        const file = server.current().files.find((f) => f.id === 'src/utils/math.ts')!;
        expect(file.symbols.map((s) => s.name)).toContain('addedLater');
        const update = await events.waitFor((e) => e.event === 'update' && (e.data as { version: number }).version >= after);
        expect(update.data).toMatchObject({ version: expect.any(Number), changed: expect.any(Array), durationMs: expect.any(Number), files: 28 });

        const data = json(await api('/api/data')) as { files: { id: string; symbols: { name: string }[] }[] };
        expect(data.files.find((f) => f.id === 'src/utils/math.ts')!.symbols.map((s) => s.name)).toContain('addedLater');
        const page = await httpRequest(base);
        const live = page.text.match(/window\.__CV_LIVE__=(\{[^<]*?\});/);
        expect(JSON.parse(live![1])).toMatchObject({ token, version: expect.any(Number) });
        expect(JSON.parse(live![1]).version).toBeGreaterThanOrEqual(after);
      } finally {
        events.close();
      }
    });

    it('notices file changes by itself (file watcher) and reports the changed path', async () => {
      const events = openEventStream(new URL(`/api/events?token=${encodeURIComponent(token)}`, base).toString());
      try {
        await events.waitFor((e) => e.event === 'hello');
        appendFile(root, 'src/utils/format.ts', '\nexport function watchedLater(): string {\n  return "seen";\n}\n');
        const update = await events.waitFor((e) => e.event === 'update' && ((e.data as { changed: string[] }).changed ?? []).includes('src/utils/format.ts'), 15_000);
        expect(update.data).toMatchObject({ files: 28 });
        await server.refresh();
        expect(server.current().files.find((f) => f.id === 'src/utils/format.ts')!.symbols.map((s) => s.name)).toContain('watchedLater');
      } finally {
        events.close();
      }
    });

    it('announces a new cycle in the SSE update and keeps it in /api/events/history (live guard)', async () => {
      const events = openEventStream(new URL(`/api/events?token=${encodeURIComponent(token)}`, base).toString());
      const client = fs.readFileSync(path.join(root, 'src/api/client.ts'), 'utf8');
      try {
        await events.waitFor((e) => e.event === 'hello');
        fs.writeFileSync(path.join(root, 'src/api/client.ts'), `${client}import { useUsers } from '@/hooks/useUsers';\nexport const usersHook = useUsers;\n`);
        await server.refresh();
        const hasKind = (kind: string) => (e: { event: string; data: unknown }) => e.event === 'update' && ((e.data as LiveUpdate).events ?? []).some((x) => x.kind === kind);
        const update = (await events.waitFor(hasKind('cycle-added'))).data as LiveUpdate;
        const cycle = update.events.find((e) => e.kind === 'cycle-added')!;
        expect(cycle).toMatchObject({ severity: 'error', message: expect.stringMatching(/^new cycle: /), version: expect.any(Number) });
        expect([...cycle.files].sort()).toEqual(['src/api/client.ts', 'src/hooks/useUsers.ts']);
        expect(update.open).toBeGreaterThanOrEqual(1);
        // The open list rides along, so the browser's "Still open" never goes stale.
        expect(update.openProblems?.map((e) => e.fingerprint)).toContain(cycle.fingerprint);

        const history = await api('/api/events/history');
        expect(history.status).toBe(200);
        const feed = json(history) as LiveFeed;
        expect(feed.events.map((e) => e.id)).toContain(cycle.id);
        expect(feed.open.map((e) => e.fingerprint)).toContain(cycle.fingerprint);
        expect((await httpRequest(new URL('/api/events/history', base).toString())).status).toBe(401);

        // Undo it: the fix is announced and the problem is no longer open.
        fs.writeFileSync(path.join(root, 'src/api/client.ts'), client);
        await server.refresh();
        const fixed = (await events.waitFor(hasKind('cycle-fixed'))).data as LiveUpdate;
        expect(fixed.openProblems?.map((e) => e.fingerprint)).not.toContain(cycle.fingerprint);
        expect(server.engine.feed().open.map((e) => e.fingerprint)).not.toContain(cycle.fingerprint);
      } finally {
        fs.writeFileSync(path.join(root, 'src/api/client.ts'), client);
        events.close();
      }
    });

    it('did not write history because writeHistory is false', () => {
      expect(fs.existsSync(path.join(root, '.code-visualizer', 'history.json'))).toBe(false);
    });
  });

  describe('discovery by other commands', () => {
    it('registers itself in .code-visualizer/server.json (private, with the token)', () => {
      const info = readServerInfo(root)!;
      expect(info).toMatchObject({ pid: process.pid, port: Number(port), host: '127.0.0.1', token, root, url: base, includeSource: false, changes: false, compare: false });
      expect(info.fingerprint).toEqual(expect.any(String));
      expect(server.info).toEqual(info);
      if (process.platform !== 'win32') expect(fs.statSync(serverInfoPath(root)).mode & 0o777).toBe(0o600);
    });

    it('connectToServer finds it; getReport takes fresh data from it', async () => {
      const conn = await connectToServer(root);
      expect(conn?.url).toBe(base);
      expect(conn?.info.token).toBe(token);
      expect(await connectToServer(makeTempDir('cv-no-server-'))).toBeUndefined();

      // An edit the watcher has not reported yet is still in the answer (fresh=1 verifies files).
      appendFile(root, 'src/utils/math.ts', '\nexport const fromTheServer = 1;\n');
      // (The test environment sets CODE_VISUALIZER_NO_CACHE, so server reuse is requested explicitly.)
      const data = await getReport({ root, git: false, includeSource: false, history: false, server: true });
      expect(data.stats.cache?.source).toBe('server');
      expect(data.files.find((f) => f.id === 'src/utils/math.ts')!.symbols.map((s) => s.name)).toContain('fromTheServer');
      expect(data.files.every((f) => f.source === undefined)).toBe(true);
      expect(data.history).toHaveLength(1);
      expect(fs.existsSync(path.join(root, '.code-visualizer', 'cache'))).toBe(false); // nothing analyzed locally
    });

    it('getReport analyzes locally when the options differ from the server or the cache is off', async () => {
      const withGit = await getReport({ root, includeSource: false, history: false, persist: false, server: true });
      expect(withGit.stats.cache?.source).toBe('cold');
      const withSource = await getReport({ root, git: false, history: false, persist: false, server: true });
      expect(withSource.stats.cache?.source).toBe('cold');
      const noCache = await getReport({ root, git: false, includeSource: false, history: false, persist: false });
      expect(noCache.stats.cache?.source).toBe('cold');
      const scoped = await getReport({ root, git: false, includeSource: false, file: path.join(root, 'src/App.tsx'), persist: false, server: true });
      expect(scoped.stats.cache?.source).toBe('cold');
      expect(scoped.scope).toEqual({ type: 'file', path: 'src/App.tsx' });
    });

    it('"serve" for the same project prints the running server instead of starting another', async () => {
      const restore = setEnv('CODE_VISUALIZER_NO_CACHE', undefined);
      try {
        const { code, stdout } = await runCliCaptured('serve', root, '--no-open', '--no-git', '--no-source');
        expect(code).toBe(0);
        expect(stdout).toContain(`Already running at ${base} (pid ${process.pid})`);
        expect(stdout).not.toContain('--notify applies');
        // Notifications are set when a server starts: a reused one says so instead of ignoring the flag.
        const notify = await runCliCaptured('serve', root, '--no-open', '--no-git', '--no-source', '--notify=all');
        expect(notify.code).toBe(0);
        expect(notify.stdout).toContain(`--notify applies to a server when it starts: stop the running one (pid ${process.pid}) or use --new.`);
      } finally {
        restore();
      }
    });

    it('"serve" with other options starts a separate server and leaves the registration alone', async () => {
      const restore = setEnv('CODE_VISUALIZER_NO_CACHE', undefined);
      try {
        const cli = startCli('serve', root, '--no-open', '--no-git', '--no-source', '--file', path.join(root, 'src/App.tsx'), '--port', '4790');
        await waitFor(() => cli.output().includes('Live at') || cli.finished());
        expect(cli.finished()).toBe(false);
        expect(cli.output()).toContain(`with other options runs at ${base} (pid ${process.pid}); starting another one`);
        expect(readServerInfo(root)?.token).toBe(token); // still the first server's registration
        process.emit('SIGINT', 'SIGINT');
        expect(await cli.done).toBe(0);
        expect(readServerInfo(root)?.token).toBe(token);
        expect((await connectToServer(root))?.url).toBe(base);
      } finally {
        restore();
      }
    });

    it('never contacts a host named in server.json unless it is this machine', async () => {
      const elsewhere = makeTempDir('cv-foreign-');
      writeServerInfo(elsewhere, { ...server.info, root: elsewhere, host: 'attacker.example', port: 8080 });
      const request = vi.spyOn(http, 'request');
      try {
        expect(await connectToServer(elsewhere)).toBeUndefined();
        expect(request).not.toHaveBeenCalled();
      } finally {
        request.mockRestore();
      }
      expect(fs.existsSync(serverInfoPath(elsewhere))).toBe(true); // not ours: left alone
    });

    it('treats a pid of another user (or another process on the port) as not this server', async () => {
      const elsewhere = makeTempDir('cv-foreign-');
      // pid 1 always exists; kill(1, 0) fails with EPERM for normal users.
      writeServerInfo(elsewhere, { ...server.info, root: elsewhere, pid: 1 });
      expect(await connectToServer(elsewhere)).toBeUndefined();
      expect(fs.existsSync(serverInfoPath(elsewhere))).toBe(false);
      // The right root, port and token, but the registration names another live process.
      try {
        writeServerInfo(root, { ...server.info, pid: process.ppid });
        expect(await connectToServer(root)).toBeUndefined();
        expect(fs.existsSync(serverInfoPath(root))).toBe(false);
      } finally {
        writeServerInfo(root, server.info);
      }
      expect((await connectToServer(root))?.url).toBe(base);
    });
  });

  describe('history and running servers', () => {
    it('getReport never takes data from a server without history when history is wanted', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const s = await serve({ root: copy, port: 0, git: false, history: false, writeHistory: false });
      try {
        expect(s.info.history).toBe(false);
        const opts = { root: copy, git: false, persist: false, server: true } as const;
        expect((await getReport(opts)).stats.cache?.source).toBe('cold');
        expect((await getReport({ ...opts, history: false })).stats.cache?.source).toBe('server');
      } finally {
        await s.close();
      }
    });

    it('"report" next to a "serve --no-history" keeps the recorded trend', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const points = Array.from({ length: 6 }, (_, i) => ({ date: Date.now() - (6 - i) * 86_400_000, score: 70 + i, grade: 'C', files: 10, loc: 100, cycles: 0 }));
      fs.mkdirSync(path.join(copy, '.code-visualizer'), { recursive: true });
      fs.writeFileSync(path.join(copy, '.code-visualizer', 'history.json'), JSON.stringify({ version: 1, points }));
      const s = await serve({ root: copy, port: 0, git: false, history: false, writeHistory: false });
      const restore = setEnv('CODE_VISUALIZER_NO_CACHE', undefined);
      try {
        const { code, stdout } = await runCliCaptured('report', copy, '--no-git', '--no-open', '-o', path.join(makeTempDir('cv-out-'), 'r.html'));
        expect(code).toBe(0);
        expect(stdout).not.toContain('from the running server');
        expect(historyPoints(copy)).toHaveLength(7);
      } finally {
        restore();
        await s.close();
      }
    });

    it('"report" from a server with history points at the live page and leaves history to the server', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const s = await serve({ root: copy, port: 0, git: false });
      const restore = setEnv('CODE_VISUALIZER_NO_CACHE', undefined);
      try {
        const history = path.join(copy, '.code-visualizer', 'history.json');
        expect(historyPoints(copy)).toHaveLength(1); // written by the server
        const before = fs.statSync(history).mtimeMs;
        const { code, stdout } = await runCliCaptured('report', copy, '--no-git', '--no-open', '-o', path.join(makeTempDir('cv-out-'), 'r.html'));
        expect(code).toBe(0);
        expect(stdout).toContain('from the running server');
        expect(stdout).toContain(`Live    ${s.url}`);
        expect(stdout).not.toContain('Tip: run');
        expect(fs.statSync(history).mtimeMs).toBe(before);
      } finally {
        restore();
        await s.close();
      }
    });
  });

  describe('lifecycle', () => {
    it('serves data without embedded sources for ?source=0 and unregisters on close()', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const s = await serve({ root: copy, port: 0, git: false, writeHistory: false });
      try {
        expect(readServerInfo(copy)).toMatchObject({ includeSource: true, url: s.url });
        const t = readServerInfo(copy)!.token;
        const get = (q: string) => httpRequest(new URL(`/api/data${q}`, s.url).toString(), { headers: { 'X-CV-Token': t } }).then((r) => json(r) as ReportData);
        const full = await get('');
        expect(full.files.some((f) => typeof f.source === 'string' && f.source.length > 0)).toBe(true);
        const lite = await get('?source=0');
        expect(lite.files).toHaveLength(full.files.length);
        expect(lite.files.some((f) => 'source' in f)).toBe(false);
        expect((await get('?source=0&fresh=1')).files.some((f) => 'source' in f)).toBe(false);
      } finally {
        await s.close();
      }
      expect(fs.existsSync(serverInfoPath(copy))).toBe(false);
    });

    it('does not register with register: false, and leaves a foreign registration alone on close', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const s = await serve({ root: copy, port: 0, git: false, includeSource: false, writeHistory: false, register: false });
      expect(fs.existsSync(serverInfoPath(copy))).toBe(false);
      const other: ServerInfo = { ...s.info, token: 'someone-else' };
      writeServerInfo(copy, other);
      await s.close();
      expect(readServerInfo(copy)).toEqual(other);
    });

    it('connectToServer removes stale registrations', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const s = await serve({ root: copy, port: 0, git: false, includeSource: false, writeHistory: false });
      const info = s.info;
      await s.close();
      // Dead process.
      writeServerInfo(copy, { ...info, pid: deadPid() });
      expect(await connectToServer(copy)).toBeUndefined();
      expect(fs.existsSync(serverInfoPath(copy))).toBe(false);
      // Live process, but nothing listens on the port any more.
      writeServerInfo(copy, info);
      expect(await connectToServer(copy)).toBeUndefined();
      expect(fs.existsSync(serverInfoPath(copy))).toBe(false);
      // Another server (wrong token / other project) answers on that port.
      writeServerInfo(copy, { ...info, port: Number(port), token: 'wrong' });
      expect(await connectToServer(copy)).toBeUndefined();
      expect(fs.existsSync(serverInfoPath(copy))).toBe(false);
      writeServerInfo(copy, { ...info, port: Number(port), token });
      expect(await connectToServer(copy)).toBeUndefined(); // the server on that port analyzes `root`, not `copy`
      expect(fs.existsSync(serverInfoPath(copy))).toBe(false);
    });

    it('keeps the last good analysis and reports an SSE "error" when re-analysis fails', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const s = await serve({ root: copy, port: 0, git: false, includeSource: false, writeHistory: false });
      const page = await httpRequest(s.url);
      const liveToken = (JSON.parse(page.text.match(/window\.__CV_LIVE__=(\{[^<]*?\});/)![1]) as { token: string }).token;
      const events = openEventStream(new URL(`/api/events?token=${encodeURIComponent(liveToken)}`, s.url).toString());
      try {
        await events.waitFor((e) => e.event === 'hello');
        const lastGood = s.current();
        for (const entry of fs.readdirSync(copy)) if (entry !== 'package.json') fs.rmSync(path.join(copy, entry), { recursive: true, force: true });
        await s.refresh();
        const error = await events.waitFor((e) => e.event === 'error');
        expect((error.data as { message: string }).message).toMatch(/No JavaScript\/TypeScript source files/);
        expect(s.current()).toBe(lastGood);
        const data = await httpRequest(new URL('/api/data', s.url).toString(), { headers: { 'X-CV-Token': liveToken } });
        expect(data.status).toBe(200);
        expect((json(data) as { files: unknown[] }).files.length).toBe(lastGood.files.length);
      } finally {
        events.close();
        await s.close();
      }
    });

    it('writes .code-visualizer/history.json by default and stops listening after close()', async () => {
      const copy = copyFixture('express-api', 'cv-serve-');
      const logs: string[] = [];
      const restore = setEnv('CODE_VISUALIZER_EDITOR', 'NoTePad');
      let s: LiveServer;
      try {
        s = await serve({ root: copy, port: 0, git: false, includeSource: false, log: (m) => logs.push(m) });
      } finally {
        restore();
      }
      const ping = new URL('/api/ping', s.url).toString();
      try {
        // An unknown CODE_VISUALIZER_EDITOR is reported and replaced by the VS Code default.
        expect(logs.some((m) => m.includes('Unknown CODE_VISUALIZER_EDITOR "notepad"'))).toBe(true);
        const page = await httpRequest(s.url);
        expect(JSON.parse(page.text.match(/window\.__CV_LIVE__=(\{[^<]*?\});/)![1])).toMatchObject({ editor: 'vscode' });
        expect((await httpRequest(ping)).status).toBe(200);
        const history = JSON.parse(fs.readFileSync(path.join(copy, '.code-visualizer', 'history.json'), 'utf8')) as { version: number; points: unknown[] };
        expect(history.version).toBe(1);
        expect(history.points).toHaveLength(1);
        expect(fs.readFileSync(path.join(copy, '.code-visualizer', '.gitignore'), 'utf8')).toContain('*');
      } finally {
        await s.close();
      }
      await expect(httpRequest(ping)).rejects.toThrow();
    });
  });
});

// --- review-mode ---
describe.skipIf(!hasTemplate || !hasGit)('live server: review mode', () => {
  let restoreEnv: () => void;
  let repo: string;
  let server: LiveServer;
  let token: string;
  const api = (p: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    httpRequest(new URL(p, server.url).toString(), { ...init, headers: { 'X-CV-Token': token, ...init.headers } });
  const viewed = async (ref = 'feature'): Promise<string[]> => (json(await api(`/api/review-state?ref=${encodeURIComponent(ref)}`)) as { viewed: string[] }).viewed;
  const put = (body: unknown, ref = 'feature') => api(`/api/review-state?ref=${encodeURIComponent(ref)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    restoreEnv = isolateGit();
    repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(5), message: 'initial' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'src/utils/refunds.ts', "import { formatCurrency } from './format';\n\nexport const describeRefund = (amount: number): string => formatCurrency(amount);\n");
    appendFile(repo, 'src/utils/format.ts', '\nexport const VERSION = 2;\n');
    commitAll(repo, { author: 'Bob Builder', date: daysAgo(1), message: 'refunds' });
    git(repo, ['checkout', '-q', 'main']);
    server = await serve({ root: repo, port: 0, includeSource: false, writeHistory: false, register: false });
    token = (JSON.parse((await httpRequest(server.url)).text.match(/window\.__CV_LIVE__=(\{[^<]*?\});/)![1]) as { token: string }).token;
  });
  afterAll(async () => {
    await server?.close();
    restoreEnv?.();
  });

  it('plans any branch with diffs, and lists recent branches', async () => {
    const res = await api('/api/review?ref=feature');
    expect(res.status).toBe(200);
    const plan = json(res) as ReviewPlan;
    expect(plan).toMatchObject({ ref: 'feature', base: 'main' });
    expect(plan.steps.map((s) => s.file)).toEqual(['src/utils/format.ts', 'src/utils/refunds.ts']);
    expect(plan.files?.find((f) => f.id === 'src/utils/refunds.ts')?.diff).toContain('+export const describeRefund');
    // Nothing was checked out.
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    const refs = json(await api('/api/review-refs')) as { refs: ReviewRef[] };
    expect(refs.refs.map((r) => r.ref)).toEqual(['feature']);
  });

  it('answers unknown refs, unfetched pull requests and requests without a token', async () => {
    expect((await api('/api/review?ref=nope')).status).toBe(404);
    const pr = await api('/api/review?ref=%2342');
    expect(pr.status).toBe(404);
    expect(json(pr)).toMatchObject({ fetch: 'git fetch origin pull/42/head:pr/42' });
    expect((await api('/api/review?ref=--upload-pack=x')).status).toBe(400);
    expect((await api('/api/review')).status).toBe(400);
    expect((await httpRequest(new URL('/api/review?ref=feature', server.url).toString())).status).toBe(401);
    expect((await httpRequest(new URL('/api/review-state?ref=feature', server.url).toString(), { method: 'PUT', body: '{}' })).status).toBe(401);
  });

  it('review-state: PUT / GET round-trip; paths outside the project are refused', async () => {
    expect(await viewed()).toEqual([]);
    const res = await put({ file: 'src/utils/refunds.ts', viewed: true });
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({ ref: 'feature', viewed: ['src/utils/refunds.ts'] });
    expect(await viewed()).toEqual(['src/utils/refunds.ts']);
    expect((await put({ files: { 'src/utils/format.ts': true } })).status).toBe(200);
    expect(await viewed()).toEqual(['src/utils/format.ts', 'src/utils/refunds.ts']);
    // The plan carries the flags too.
    const plan = json(await api('/api/review?ref=feature')) as ReviewPlan;
    expect(plan.steps.map((s) => s.viewed)).toEqual([true, true]);
    expect((await put({ file: 'src/utils/format.ts', viewed: false })).status).toBe(200);
    expect(await viewed()).toEqual(['src/utils/refunds.ts']);
    for (const file of ['../outside.ts', '/etc/passwd', 'src/../../x.ts', 'C:/x.ts']) expect((await put({ file, viewed: true })).status).toBe(400);
    expect((await api('/api/review-state?ref=feature', { method: 'PUT', body: 'not json' })).status).toBe(400);
    // Stored per ref in .code-visualizer/reviews/<sha1(ref)>.json.
    const stored = fs.readdirSync(path.join(repo, '.code-visualizer', 'reviews'));
    expect(stored).toEqual([`${crypto.createHash('sha1').update('feature').digest('hex')}.json`]);
  });

  it('a viewed file is unviewed again once the author changes it', async () => {
    expect((await put({ files: { 'src/utils/refunds.ts': true, 'src/utils/format.ts': true } })).status).toBe(200);
    git(repo, ['checkout', '-q', 'feature']);
    appendFile(repo, 'src/utils/refunds.ts', '\nexport const REFUND_LIMIT = 100;\n');
    commitAll(repo, { author: 'Bob Builder', date: daysAgo(0), message: 'limit' });
    git(repo, ['checkout', '-q', 'main']);
    expect(await viewed()).toEqual(['src/utils/format.ts']);
    const plan = json(await api('/api/review?ref=feature')) as ReviewPlan;
    expect(Object.fromEntries(plan.steps.map((s) => [s.file, !!s.viewed]))).toEqual({ 'src/utils/format.ts': true, 'src/utils/refunds.ts': false });
  });

  it('review-state: concurrent PUTs keep every file', async () => {
    expect((await put({ files: { 'src/utils/refunds.ts': false, 'src/utils/format.ts': false } })).status).toBe(200);
    const results = await Promise.all([put({ file: 'src/utils/refunds.ts', viewed: true }), put({ file: 'src/utils/format.ts', viewed: true })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await viewed()).toEqual(['src/utils/format.ts', 'src/utils/refunds.ts']);
  });

  it('review-state: marks the version the reviewer was shown, not a newer push; ignores files outside the change', async () => {
    const shown = (json(await api('/api/review?ref=feature')) as ReviewPlan).head!;
    expect(shown).toMatch(/^[0-9a-f]{40}$/);
    expect((await put({ files: { 'src/utils/refunds.ts': false, 'src/utils/format.ts': false } })).status).toBe(200);
    // The author pushes while the reviewer's page still shows the older version.
    git(repo, ['checkout', '-q', 'feature']);
    appendFile(repo, 'src/utils/refunds.ts', '\nexport const REFUND_MINIMUM = 1;\n');
    const pushed = commitAll(repo, { author: 'Bob Builder', date: daysAgo(0), message: 'minimum' });
    git(repo, ['checkout', '-q', 'main']);
    const res = await put({ files: { 'src/utils/refunds.ts': true, 'src/utils/format.ts': true }, head: shown });
    expect(res.status).toBe(200);
    // refunds.ts changed after the shown version: not viewed; format.ts did not: viewed.
    expect(json(res)).toMatchObject({ commit: pushed, moved: true, viewed: ['src/utils/format.ts'] });
    expect(await viewed()).toEqual(['src/utils/format.ts']);
    // Files the branch did not change are not stored; a head that is not a commit is refused.
    expect(json(await put({ files: { 'src/App.tsx': true, 'not/in/plan.ts': true } }))).toMatchObject({ viewed: ['src/utils/format.ts'] });
    expect((await put({ file: 'src/utils/format.ts', viewed: true, head: 'not-a-commit' })).status).toBe(400);
    expect((await put({ file: 'src/utils/format.ts', viewed: true, head: 'f'.repeat(40) })).status).toBe(400);
  });
});
