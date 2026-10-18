/**
 * Helpers for the "daily companion" tests: temp copies of fixtures, throw-away git repositories
 * with scripted history, and a tiny HTTP client for the live server.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAY = 24 * 3600 * 1000;

export function fixtureDir(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

/* -------------------------------------------------------------------------- */
/*                                 Temp dirs                                  */
/* -------------------------------------------------------------------------- */

const tempDirs: string[] = [];

/** A fresh directory in os.tmpdir(); removed by `removeTempDirs()`. */
export function makeTempDir(prefix = 'cv-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** Copy a fixture to `<fresh temp dir>/<name>` (so the parent folder is empty, e.g. no lock files). */
export function copyFixture(name: string, prefix = 'cv-copy-'): string {
  const root = path.join(makeTempDir(prefix), name);
  fs.cpSync(fixtureDir(name), root, { recursive: true });
  return root;
}

export function writeFile(root: string, file: string, content: string): void {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function appendFile(root: string, file: string, content: string): void {
  fs.appendFileSync(path.join(root, file), content);
}

/** Replace text in a file; throws when the pattern is not found so fixture drift is noticed. */
export function editFile(root: string, file: string, from: string | RegExp, to: string): void {
  const abs = path.join(root, file);
  const text = fs.readFileSync(abs, 'utf8');
  const next = text.replace(from, to);
  if (next === text) throw new Error(`editFile(${file}): ${String(from)} not found`);
  fs.writeFileSync(abs, next);
}

/** Strip fenced code blocks and inline code so only prose remains (for "no undefined/NaN" checks). */
export function proseOf(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/* -------------------------------------------------------------------------- */
/*                                    Git                                     */
/* -------------------------------------------------------------------------- */

export const hasGit: boolean = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const REPO_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
];

/**
 * Make git deterministic inside this test process (the analyzer shells out to git with process.env):
 * ignore the developer's global / system config (user.name, diff prefixes, signing, hooks…) and
 * repository env vars that leak in when tests run from a git hook. Returns a restore function.
 */
export function isolateGit(): () => void {
  const saved = new Map<string, string | undefined>();
  const set = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const globalConfig = path.join(makeTempDir('cv-gitconfig-'), 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  set('GIT_CONFIG_GLOBAL', globalConfig);
  set('GIT_CONFIG_NOSYSTEM', '1');
  set('GIT_TERMINAL_PROMPT', '0');
  for (const key of REPO_ENV) set(key, undefined);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Local midnight, computed exactly like the analyzer does for `dailyActivity`. */
export function startOfToday(now = Date.now()): number {
  return new Date(new Date(now).toDateString()).getTime();
}

const TODAY = startOfToday();

/**
 * Fixed commit dates for this test run: noon `n` days before today (always in the past for n >= 1).
 * Dates are relative to today because activity charts and reviewer recency are relative to "now".
 */
export function daysAgo(n: number): number {
  return TODAY - n * DAY + 12 * 3600 * 1000;
}

/** How many days have passed since the dates above were computed (0 unless the run crossed midnight). */
export function dayShift(todayStart = startOfToday()): number {
  return Math.round((todayStart - TODAY) / DAY);
}

export function emailOf(author: string): string {
  return `${author.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`;
}

/** Stage everything and commit it as `author` at `date` (user.name / user.email passed per command). */
export function commitAll(repo: string, opts: { author: string; date: number; message: string }): string {
  const stamp = `@${Math.floor(opts.date / 1000)} +0000`;
  git(repo, ['add', '-A']);
  git(
    repo,
    ['-c', `user.name=${opts.author}`, '-c', `user.email=${emailOf(opts.author)}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '--allow-empty', '-m', opts.message],
    { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  );
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/** Copy a fixture into os.tmpdir() and turn it into a git repository on `main` (no commits yet). */
export function initRepo(fixture: string): string {
  const repo = copyFixture(fixture, 'cv-git-');
  git(repo, ['init', '-q', '-b', 'main']);
  return repo;
}

/* -------------------------------------------------------------------------- */
/*                                    HTTP                                    */
/* -------------------------------------------------------------------------- */

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
}

/** Plain node:http request (fetch would not allow overriding the Host header). */
export function httpRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET', headers: opts.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error(`Request to ${url} timed out`)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export interface ServerSentEvent {
  event: string;
  data: unknown;
}

/** Subscribe to a Server-Sent Events endpoint and wait for specific events. */
export function openEventStream(url: string): { waitFor(match: (e: ServerSentEvent) => boolean, timeoutMs?: number): Promise<ServerSentEvent>; events: ServerSentEvent[]; close(): void } {
  const events: ServerSentEvent[] = [];
  const waiters: { match: (e: ServerSentEvent) => boolean; resolve: (e: ServerSentEvent) => void }[] = [];
  let buffer = '';
  const req = http.get(url, { agent: false }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data && event === 'message') continue; // comments / pings
        const parsed: ServerSentEvent = { event, data: data ? JSON.parse(data) : undefined };
        events.push(parsed);
        for (const w of [...waiters]) {
          if (w.match(parsed)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(parsed);
          }
        }
      }
    });
  });
  req.on('error', () => undefined);
  return {
    events,
    waitFor(match, timeoutMs = 10_000) {
      const seen = events.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No matching server-sent event within ${timeoutMs}ms; got ${JSON.stringify(events)}`)), timeoutMs);
        waiters.push({
          match,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close() {
      req.destroy();
    },
  };
}
