import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, createAnalyzeCache, type AnalyzeOptions } from '../src/analyzer/index.js';
import {
  cacheDir,
  cacheStamp,
  clearDiskCache,
  codeStamp,
  deserialize,
  diskCacheStatus,
  loadDiskCache,
  parseCachePath,
  secretDir,
  serialize,
} from '../src/analyzer/disk-cache.js';
import { discoverFiles } from '../src/analyzer/files.js';
import { parseSource } from '../src/analyzer/parse.js';
import { readAllState, readServerInfo, readState, removeServerInfo, serverInfoPath, statePath, updateState, writeServerInfo } from '../src/analyzer/state.js';
import type { ReportData } from '../src/shared/types.js';
import { appendFile, commitAll, copyFixture, daysAgo, editFile, fixtureDir, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs } from './companion-helpers.js';

afterAll(removeTempDirs);

const FIXTURES = ['react-vite-ts', 'next-app', 'express-api', 'vue-app', 'nest-api', 'sveltekit-app', 'fullstack-next'];

/** Everything that legitimately differs between two runs over the same files. */
function comparable(d: ReportData): unknown {
  return {
    ...d,
    generatedAt: '',
    stats: { ...d.stats, durationMs: 0, cache: undefined },
    history: d.history.map((h) => ({ ...h, date: 0 })),
  };
}

describe('serialize / deserialize', () => {
  it('round-trips the parse result of every file in every fixture, Maps and Sets included', async () => {
    let checked = 0;
    for (const fixture of FIXTURES) {
      const root = fixtureDir(fixture);
      const { files } = await discoverFiles(root);
      for (const f of files) {
        const parsed = parseSource(f.id, fs.readFileSync(f.abs, 'utf8'), f.ext);
        const back = deserialize<typeof parsed>(serialize(parsed));
        expect(back, `${fixture}/${f.id}`).toEqual(parsed);
        expect(back.facts).toBeInstanceOf(Map);
        for (const [name, facts] of back.facts) {
          expect(facts.calls, `${f.id} ${name}`).toBeInstanceOf(Map);
          expect(facts.refs, `${f.id} ${name}`).toBeInstanceOf(Set);
          if (facts.fieldTypes) expect(facts.fieldTypes).toBeInstanceOf(Map);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('restores nested and empty collections and leaves look-alike objects alone', () => {
    const value = {
      m: new Map<string, unknown>([
        ['a', new Set([1, 2])],
        ['b', { inner: new Map([[1, 'x']]) }],
      ]),
      empty: new Map(),
      none: new Set(),
      list: [new Set(['x']), { $m: 'not a map' }, { $s: [1], other: true }],
    };
    expect(deserialize(serialize(value))).toEqual(value);
    const back = deserialize<typeof value>(serialize(value));
    expect((back.m.get('b') as { inner: Map<number, string> }).inner.get(1)).toBe('x');
    expect(back.list[1]).toEqual({ $m: 'not a map' });
    expect(back.list[2]).toEqual({ $s: [1], other: true });
  });
});

describe('persistent parse cache', () => {
  const opts = (root: string): AnalyzeOptions => ({ root, persist: true, git: false, history: false, includeSource: false });

  it('reuses unchanged files across runs: mtime/size first, content hash after a touch', async () => {
    const root = copyFixture('react-vite-ts', 'cv-disk-');
    const first = await analyze(opts(root));
    const total = first.stats.files;
    expect(first.stats.cache).toEqual({ reused: 0, parsed: total, source: 'cold' });
    expect(fs.existsSync(parseCachePath(root))).toBe(true);
    expect(fs.readFileSync(path.join(root, '.code-visualizer', '.gitignore'), 'utf8')).toContain('*');

    const second = await analyze(opts(root));
    expect(second.stats.cache).toEqual({ reused: total, parsed: 0, source: 'disk' });

    editFile(root, 'src/utils/math.ts', /$/, '\nexport const ANSWER = 42;\n');
    const edited = await analyze(opts(root));
    expect(edited.stats.cache).toEqual({ reused: total - 1, parsed: 1, source: 'disk' });
    expect(edited.files.find((f) => f.id === 'src/utils/math.ts')!.symbols.map((s) => s.name)).toContain('ANSWER');

    // Same content, new mtime (checkout, formatter, `touch`): the sha1 matches, nothing is parsed.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'src/App.tsx'), later, later);
    const touched = await analyze(opts(root));
    expect(touched.stats.cache).toEqual({ reused: total, parsed: 0, source: 'disk' });
    // …and the new mtime was saved, so the next run takes the fast path again.
    const cache = createAnalyzeCache();
    expect(loadDiskCache(root, cache)).toBe(true);
    expect(cache.files.get('src/App.tsx')!.mtimeMs).toBe(fs.statSync(path.join(root, 'src/App.tsx')).mtimeMs);
    expect(cache.files.get('src/App.tsx')!.text).toBeUndefined(); // texts are never written to disk
  });

  it('forgets deleted files and picks up new ones', async () => {
    const root = copyFixture('express-api', 'cv-disk-');
    const first = await analyze(opts(root));
    fs.rmSync(path.join(root, 'utils/object.js'));
    fs.writeFileSync(path.join(root, 'utils/strings.js'), 'export const upper = (s) => s.toUpperCase();\n');
    const second = await analyze(opts(root));
    expect(second.stats.files).toBe(first.stats.files);
    expect(second.stats.cache).toMatchObject({ parsed: 1, source: 'disk' });
    const cache = createAnalyzeCache();
    loadDiskCache(root, cache);
    expect(cache.files.has('utils/object.js')).toBe(false);
    expect(cache.files.has('utils/strings.js')).toBe(true);
  });

  it('produces the same report as a cold run, with and without embedded sources', async () => {
    const root = copyFixture('fullstack-next', 'cv-disk-');
    for (const includeSource of [false, true]) {
      clearDiskCache(root);
      const cold = await analyze({ ...opts(root), includeSource, persist: false });
      await analyze({ ...opts(root), includeSource });
      const warm = await analyze({ ...opts(root), includeSource });
      expect(warm.stats.cache?.source).toBe('disk');
      expect(comparable(warm)).toEqual(comparable(cold));
      if (includeSource) expect(warm.files.find((f) => f.id === 'lib/api.ts')!.source).toContain("import axios from 'axios'");
    }
  });

  it('gives every run its own symbol objects (cached parse results are never mutated)', async () => {
    const root = copyFixture('react-vite-ts', 'cv-disk-');
    const cache = createAnalyzeCache();
    const a = await analyze({ ...opts(root), persist: false, cache });
    const b = await analyze({ ...opts(root), persist: false, cache });
    const sa = a.files.find((f) => f.id === 'src/App.tsx')!.symbols[0];
    const sb = b.files.find((f) => f.id === 'src/App.tsx')!.symbols[0];
    expect(sa).not.toBe(sb);
    expect(sa.id).toBe(sb.id);
    expect(cache.files.get('src/App.tsx')!.parsed.symbols.every((s) => s.id === '')).toBe(true);
  });

  it('falls back to a cold run on a corrupt, foreign or outdated cache without throwing', async () => {
    const root = copyFixture('vue-app', 'cv-disk-');
    const first = await analyze(opts(root));
    const total = first.stats.files;
    const file = parseCachePath(root);

    fs.writeFileSync(file, 'definitely not gzip');
    expect((await analyze(opts(root))).stats.cache).toEqual({ reused: 0, parsed: total, source: 'cold' });

    // Written by other analyzer code (another build or version): ignored, then replaced.
    const payload = deserialize<{ stamp: string }>(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    expect(payload.stamp).toBe(cacheStamp());
    fs.writeFileSync(file, zlib.gzipSync(serialize({ ...payload, stamp: 'dist-0' })));
    expect((await analyze(opts(root))).stats.cache?.source).toBe('cold');
    expect((await analyze(opts(root))).stats.cache?.source).toBe('disk');

    // Valid gzip + JSON with the wrong shape.
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ format: 1, stamp: cacheStamp(), files: [['x', 'y']] })));
    expect((await analyze(opts(root))).stats.cache?.source).toBe('cold');

    // Of the caches written by other tool versions only the newest survives the next save.
    const older = path.join(cacheDir(root), 'parse-s0-0.0.1-ts4.0.0.json.gz');
    const newer = path.join(cacheDir(root), 'parse-s0-0.0.2-ts4.0.0.json.gz');
    fs.writeFileSync(older, 'old');
    fs.writeFileSync(newer, 'newer');
    fs.utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    editFile(root, 'src/main.ts', /$/, '\n// touched\n');
    await analyze(opts(root));
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('never trusts a cache that comes with the repository: it cannot hide rule violations', async () => {
    const root = copyFixture('fullstack-next', 'cv-disk-');
    const violations = (d: ReportData) => d.insights.ruleViolations.map((v) => `${v.source} → ${v.target}`).sort();
    const cold = await analyze({ ...opts(root), persist: false });
    expect(violations(cold)).toContain('components/UserTable.tsx → lib/db.ts');
    await analyze(opts(root));

    // A crafted cache: the parse result of a "clean" UserTable.tsx, labelled with the real file's hash
    // (mtimes never match after a clone, so the hash is what would let it in).
    const file = parseCachePath(root);
    const payload = deserialize<{ stamp: string; files: [string, number, number, string, unknown][] }>(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    const real = fs.readFileSync(path.join(root, 'components/UserTable.tsx'), 'utf8');
    const clean = real.replace(/^import .*lib\/db.*$/m, '');
    expect(clean).not.toBe(real);
    const entry = payload.files.find((e) => e[0] === 'components/UserTable.tsx')!;
    entry[1] = 0; // a cloned file's mtime never matches
    entry[3] = crypto.createHash('sha1').update(real).digest('hex');
    entry[4] = parseSource('components/UserTable.tsx', clean, '.tsx');
    const write = (stamp: string) => fs.writeFileSync(file, zlib.gzipSync(serialize({ ...payload, stamp })));

    // What a repository can carry: everything but this user's key (here: the plain code stamp).
    write(codeStamp());
    const poisoned = await analyze(opts(root));
    expect(poisoned.stats.cache?.source).toBe('cold');
    expect(violations(poisoned)).toEqual(violations(cold));

    // Only a cache signed with this user's key is used (which is why the key must stay private).
    write(cacheStamp()!);
    expect(violations(await analyze(opts(root)))).not.toContain('components/UserTable.tsx → lib/db.ts');
  });

  it('a cache written under another user\'s key (another machine or account) is ignored', async () => {
    const root = copyFixture('express-api', 'cv-disk-');
    const total = (await analyze(opts(root))).stats.files;
    expect((await analyze(opts(root))).stats.cache?.source).toBe('disk');
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = makeTempDir('cv-other-user-');
    try {
      expect(secretDir().startsWith(process.env.TMPDIR)).toBe(true);
      expect((await analyze(opts(root))).stats.cache).toEqual({ reused: 0, parsed: total, source: 'cold' });
      expect((await analyze(opts(root))).stats.cache?.source).toBe('disk'); // now signed with this key
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    expect((await analyze(opts(root))).stats.cache?.source).toBe('cold');
  });

  it.skipIf(process.platform === 'win32')('keeps the key private, and uses no cache when it cannot be private', async () => {
    const root = copyFixture('express-api', 'cv-disk-');
    await analyze(opts(root));
    expect(fs.statSync(secretDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(secretDir(), 'cache-key')).mode & 0o777).toBe(0o600);

    const saved = process.env.TMPDIR;
    process.env.TMPDIR = makeTempDir('cv-shared-tmp-');
    try {
      fs.mkdirSync(secretDir(), { mode: 0o755 });
      fs.chmodSync(secretDir(), 0o755); // e.g. created by someone else in a shared /tmp
      expect(cacheStamp()).toBeUndefined();
      clearDiskCache(root);
      expect((await analyze(opts(root))).stats.cache?.source).toBe('cold');
      expect(fs.existsSync(parseCachePath(root))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  it('runs narrowed by --exclude keep the entries of the files they skipped', async () => {
    const root = copyFixture('react-vite-ts', 'cv-disk-');
    const total = (await analyze(opts(root))).stats.files;
    const narrowed = await analyze({ ...opts(root), exclude: ['src/components/**'] });
    expect(narrowed.stats.files).toBeLessThan(total);
    expect(narrowed.stats.cache?.parsed).toBe(0);
    const full = await analyze(opts(root));
    expect(full.stats.cache).toEqual({ reused: total, parsed: 0, source: 'disk' });
    // Files deleted meanwhile are still forgotten.
    fs.rmSync(path.join(root, 'src/components'), { recursive: true });
    await analyze({ ...opts(root), exclude: ['src/pages/**'] });
    const cache = createAnalyzeCache();
    loadDiskCache(root, cache);
    expect([...cache.files.keys()].some((id) => id.startsWith('src/components/'))).toBe(false);
    expect([...cache.files.keys()].some((id) => id.startsWith('src/pages/'))).toBe(true);
  });

  it('does not write anything without persist, and an unwritable folder is not an error', async () => {
    const root = copyFixture('nest-api', 'cv-disk-');
    await analyze({ ...opts(root), persist: false });
    expect(fs.existsSync(path.join(root, '.code-visualizer'))).toBe(false);
    // A file where the state folder should be: saving fails quietly.
    fs.writeFileSync(path.join(root, '.code-visualizer'), 'in the way');
    const data = await analyze(opts(root));
    expect(data.stats.cache?.source).toBe('cold');
  });

  it('reports and clears the cache folder', async () => {
    const root = copyFixture('react-vite-ts', 'cv-disk-');
    expect(diskCacheStatus(root).files).toEqual([]);
    const data = await analyze(opts(root));
    const status = diskCacheStatus(root);
    expect(status.dir).toBe(cacheDir(root));
    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({ kind: 'parse', current: true, entries: data.stats.files });
    expect(status.totalBytes).toBeGreaterThan(0);
    updateState(root, 'lastCheck', { ok: true });
    const cleared = clearDiskCache(root);
    expect(cleared).toEqual({ files: 1, bytes: status.totalBytes });
    expect(fs.existsSync(cacheDir(root))).toBe(false);
    expect(readState(root, 'lastCheck')).toEqual({ ok: true }); // state is kept
    expect(clearDiskCache(root)).toEqual({ files: 0, bytes: 0 });
  });
});

describe.skipIf(!hasGit)('persistent git cache', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => restoreEnv?.());

  it('reuses the git analysis for the same HEAD and keeps the newest three', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(10), message: 'Initial import' });
    const options: AnalyzeOptions = { root: repo, persist: true, history: false, includeSource: false };
    const cold = await analyze({ ...options, persist: false });
    await analyze(options);
    const gitFiles = () => fs.readdirSync(cacheDir(repo)).filter((n) => n.startsWith('git-'));
    expect(gitFiles()).toHaveLength(1);
    const warm = await analyze(options);
    expect(warm.git?.commitsAnalyzed).toBe(1);
    expect(comparable(warm)).toEqual(comparable(cold));
    expect(warm.files.find((f) => f.id === 'src/App.tsx')!.git?.authors[0].name).toBe('Alice Archer');

    for (let i = 0; i < 4; i++) {
      appendFile(repo, 'src/utils/math.ts', `\n// change ${i}\n`);
      commitAll(repo, { author: 'Bob Builder', date: daysAgo(9 - i), message: `Change ${i}` });
      const data = await analyze(options);
      expect(data.git?.commitsAnalyzed).toBe(i + 2);
    }
    expect(gitFiles()).toHaveLength(3);
  });

  it('a new branch at the same commit is not reported as the old one', async () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'Initial import' });
    const options: AnalyzeOptions = { root: repo, persist: true, history: false, includeSource: false };
    const main = (await analyze(options)).git?.branch;
    expect(main).toBeTruthy();
    git(repo, ['checkout', '-q', '-b', 'feature/new']);
    expect((await analyze(options)).git?.branch).toBe('feature/new');
    git(repo, ['checkout', '-q', main!]);
    expect((await analyze(options)).git?.branch).toBe(main);
  });
});

describe('state.json and server.json', () => {
  it('reads and updates sections atomically', () => {
    const root = makeTempDir('cv-state-');
    expect(readState(root, 'lastCheck')).toBeUndefined();
    updateState(root, 'lastCheck', { at: 1, ok: true });
    updateState(root, 'status', 'green');
    updateState<number>(root, 'counter', (prev) => (prev ?? 0) + 1);
    updateState<number>(root, 'counter', (prev) => (prev ?? 0) + 1);
    expect(readAllState(root)).toEqual({ lastCheck: { at: 1, ok: true }, status: 'green', counter: 2 });
    updateState(root, 'status', undefined);
    expect(readAllState(root)).toEqual({ lastCheck: { at: 1, ok: true }, counter: 2 });
    expect(fs.readdirSync(path.dirname(statePath(root))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(path.join(root, '.code-visualizer', '.gitignore'), 'utf8')).toContain('*');
    fs.writeFileSync(statePath(root), '{ broken');
    expect(readState(root, 'lastCheck')).toBeUndefined();
    updateState(root, 'lastCheck', { ok: false });
    expect(readAllState(root)).toEqual({ lastCheck: { ok: false } });
  });

  it('does not lose updates when several processes write at the same moment', async () => {
    const root = makeTempDir('cv-state-');
    const stateModule = pathToFileURL(fileURLToPath(new URL('../src/analyzer/state.ts', import.meta.url))).href;
    const child = path.join(makeTempDir('cv-state-child-'), 'writer.mts');
    fs.writeFileSync(
      child,
      `const { updateState } = await import(${JSON.stringify(stateModule)});
const [root, n, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
for (let i = 0; i < 15; i++) {
  updateState(root, 'counter', (prev) => (prev ?? 0) + 1);
  updateState(root, 'writer_' + n, i + 1);
}
`,
    );
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const startAt = Date.now() + 2_500; // past every child's startup, so they really overlap
    const runs = Array.from({ length: 6 }, (_, n) =>
      new Promise<number | null>((resolve) => {
        const p = spawn(process.execPath, ['--import', 'tsx', child, root, String(n), String(startAt)], { cwd, stdio: 'ignore' });
        p.on('close', resolve);
      }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0, 0]);
    const state = readAllState(root);
    expect(state.counter).toBe(6 * 15);
    for (let n = 0; n < 6; n++) expect(state[`writer_${n}`]).toBe(15);
    expect(fs.readdirSync(path.dirname(statePath(root))).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp'))).toEqual([]);
  }, 30_000);

  it('breaks a lock left behind by a crashed process', () => {
    const root = makeTempDir('cv-state-');
    updateState(root, 'a', 1);
    const lock = `${statePath(root)}.lock`;
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const started = Date.now();
    updateState(root, 'b', 2);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(readAllState(root)).toEqual({ a: 1, b: 2 });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('writes server.json privately and only removes its own registration', () => {
    const root = makeTempDir('cv-state-');
    const info = { pid: process.pid, port: 4747, host: '127.0.0.1', token: 'secret-a', root, version: '1.0.0', startedAt: 1 };
    writeServerInfo(root, info);
    expect(readServerInfo(root)).toEqual(info);
    if (process.platform !== 'win32') expect(fs.statSync(serverInfoPath(root)).mode & 0o777).toBe(0o600);
    removeServerInfo(root, 'secret-b');
    expect(readServerInfo(root)).toEqual(info);
    removeServerInfo(root, 'secret-a');
    expect(fs.existsSync(serverInfoPath(root))).toBe(false);
    fs.writeFileSync(serverInfoPath(root), JSON.stringify({ pid: 'nope' }));
    expect(readServerInfo(root)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('ignores a server.json that is not private (e.g. committed to the repository)', () => {
    const root = makeTempDir('cv-state-');
    const info = { pid: process.pid, port: 4747, host: '127.0.0.1', token: 't', root, version: '1.0.0', startedAt: 1 };
    writeServerInfo(root, info);
    fs.chmodSync(serverInfoPath(root), 0o644); // how a git checkout writes it
    expect(readServerInfo(root)).toBeUndefined();
    removeServerInfo(root, 't');
    expect(fs.existsSync(serverInfoPath(root))).toBe(true); // not ours to delete either
  });
});
