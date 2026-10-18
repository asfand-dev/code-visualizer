import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parseCachePath } from '../src/analyzer/disk-cache.js';
import { createEngine, directoriesOf, type Engine, type EngineUpdate } from '../src/server/engine.js';
import { isIgnoredPath, watchProject } from '../src/server/watch.js';
import { appendFile, copyFixture, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const ANALYSIS = { git: false, includeSource: false, history: false } as const;

const engines: Engine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.close();
});

function start(root: string, extra: Partial<Parameters<typeof createEngine>[0]> = {}): Engine {
  const engine = createEngine({ root, options: ANALYSIS, debounceMs: 50, ...extra });
  engines.push(engine);
  return engine;
}

/** Resolve with the first update that matches, or fail after `timeoutMs`. */
function nextUpdate(engine: Engine, match: (u: EngineUpdate) => boolean = () => true, timeoutMs = 10_000): Promise<EngineUpdate> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no matching engine update within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = engine.onUpdate((u) => {
      if (!match(u)) return;
      clearTimeout(timer);
      off();
      resolve(u);
    });
  });
}

const symbolsOf = (engine: Engine, id: string): string[] => engine.latest()!.files.find((f) => f.id === id)?.symbols.map((s) => s.name) ?? [];

/** Native watchers report nothing for a moment after they start (macOS FSEvents). */
const watchersReady = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

/** A stand-in for fs.watch: the test delivers the events itself, so timing is deterministic. */
function fakeWatch(root: string): { watchFn: typeof fs.watch; fire: (rel: string, event?: string) => void } {
  const listeners: { target: string; cb: (event: string, filename: string | null) => void }[] = [];
  const watchFn = ((target: fs.PathLike, a: unknown, b?: unknown) => {
    listeners.push({ target: String(target), cb: (typeof a === 'function' ? a : b) as (event: string, filename: string | null) => void });
    return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as fs.FSWatcher;
  }) as unknown as typeof fs.watch;
  return {
    watchFn,
    fire(rel, event = 'change') {
      const project = listeners.find((l) => path.resolve(l.target) === path.resolve(root));
      if (!project) throw new Error('the project is not watched (yet)');
      project.cb(event, rel);
    },
  };
}

describe('analysis engine', () => {
  it('analyzes on creation and notifies listeners after a file write (watcher)', async () => {
    const root = copyFixture('react-vite-ts', 'cv-engine-');
    const engine = start(root);
    const first = await engine.current();
    expect(first.stats.files).toBe(28);
    expect(engine.version()).toBeGreaterThanOrEqual(1);
    expect(['recursive', 'directories']).toContain(engine.watchMode());
    await watchersReady();

    const update = nextUpdate(engine, (u) => u.changed.includes('src/utils/math.ts'));
    appendFile(root, 'src/utils/math.ts', '\nexport function watched(): number {\n  return 1;\n}\n');
    const u = await update;
    expect(u.prev).toBe(first);
    expect(u.version).toBeGreaterThanOrEqual(2);
    expect(u.durationMs).toBeGreaterThanOrEqual(0);
    expect(u.data.files.find((f) => f.id === 'src/utils/math.ts')!.symbols.map((s) => s.name)).toContain('watched');
    // Only the edited file was parsed again.
    expect(u.data.stats.cache).toMatchObject({ parsed: 1, source: 'memory' });
  });

  it('markDirty followed by current() re-analyzes exactly once (lazy mode)', async () => {
    const root = copyFixture('express-api', 'cv-engine-');
    const engine = start(root, { mode: 'lazy', watch: false });
    const first = await engine.current();
    let runs = 0;
    engine.onUpdate(() => runs++);
    expect(await engine.current()).toBe(first); // nothing dirty: no work
    expect(runs).toBe(0);

    engine.markDirty(['routes/users.js']);
    engine.markDirty();
    const [a, b] = await Promise.all([engine.current(), engine.current()]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
    expect(a).not.toBe(first);
    expect(await engine.current()).toBe(a);
    expect(runs).toBe(1);
    expect(engine.version()).toBe(2);
  });

  it('lazy engines only mark what the watcher reports dirty; the next current() picks it up', async () => {
    const root = copyFixture('express-api', 'cv-engine-');
    const { watchFn, fire } = fakeWatch(root);
    const engine = start(root, { mode: 'lazy', platform: 'darwin', watchFn });
    await engine.current();
    const updates: EngineUpdate[] = [];
    engine.onUpdate((u) => updates.push(u));
    // Without a watcher event (and without verify) an edit stays invisible…
    appendFile(root, 'routes/users.js', '\n// unreported\n');
    await engine.current();
    expect(updates).toHaveLength(0);
    // …a reported one is analyzed by the next current(), not before.
    appendFile(root, 'utils/object.js', '\nfunction lazyLater() {}\nmodule.exports.lazyLater = lazyLater;\n');
    fire('utils/object.js');
    await new Promise((r) => setTimeout(r, 200));
    expect(updates).toHaveLength(0);
    const data = await engine.current();
    expect(updates).toHaveLength(1);
    expect(updates[0].changed).toEqual(['utils/object.js']);
    expect(data.files.find((f) => f.id === 'utils/object.js')!.symbols.map((s) => s.name)).toContain('lazyLater');
  });

  it.each(['lazy', 'eager'] as const)('%s: a verify run names the files it found, and the late watcher event does not analyze again', async (mode) => {
    const root = copyFixture('react-vite-ts', 'cv-engine-');
    const { watchFn, fire } = fakeWatch(root);
    const engine = start(root, { mode, platform: 'darwin', watchFn });
    await engine.current();
    const updates: EngineUpdate[] = [];
    engine.onUpdate((u) => updates.push(u));
    appendFile(root, 'src/App.tsx', '\nexport const verifiedEdit = 1;\n');
    const data = await engine.current({ verify: true });
    expect(updates.map((u) => u.changed)).toEqual([['src/App.tsx']]);
    expect(updates[0].prev).toBeDefined();
    expect(data.files.find((f) => f.id === 'src/App.tsx')!.symbols.map((s) => s.name)).toContain('verifiedEdit');
    // The watcher reports the same edit late: already analyzed, so nothing runs.
    fire('src/App.tsx');
    await new Promise((r) => setTimeout(r, 200));
    expect(await engine.current()).toBe(data);
    expect(updates).toHaveLength(1);
    // A further edit is analyzed as usual.
    appendFile(root, 'src/App.tsx', '\nexport const secondEdit = 2;\n');
    const next = mode === 'eager' ? nextUpdate(engine) : undefined;
    fire('src/App.tsx');
    if (next) await next;
    await engine.current();
    expect(updates.map((u) => u.changed)).toEqual([['src/App.tsx'], ['src/App.tsx']]);
  });

  it('current({ verify: true }) re-analyzes once on a new day (activity charts and history are per day)', async () => {
    const root = copyFixture('express-api', 'cv-engine-');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 16, 23, 59, 0));
      const engine = start(root, { mode: 'lazy', watch: false });
      const first = await engine.current();
      expect(await engine.current({ verify: true })).toBe(first);
      vi.setSystemTime(new Date(2026, 9, 17, 0, 1, 0));
      expect(await engine.current()).toBe(first); // only verifying clients ask for today's analysis
      const today = await engine.current({ verify: true });
      expect(today).not.toBe(first);
      expect(new Date(today.generatedAt).getDate()).toBe(17);
      expect(await engine.current({ verify: true })).toBe(today);
      expect(engine.version()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('current({ verify: true }) notices edits the watcher has not reported', async () => {
    const root = copyFixture('react-vite-ts', 'cv-engine-');
    const engine = start(root, { watch: false });
    await engine.current();
    appendFile(root, 'src/utils/format.ts', '\nexport const verified = true;\n');
    expect(symbolsOf(engine, 'src/utils/format.ts')).not.toContain('verified');
    await engine.current(); // without verify the unwatched edit stays invisible
    expect(symbolsOf(engine, 'src/utils/format.ts')).not.toContain('verified');
    const data = await engine.current({ verify: true });
    expect(data.files.find((f) => f.id === 'src/utils/format.ts')!.symbols.map((s) => s.name)).toContain('verified');
  });

  it('keeps the last good analysis when a re-analysis fails, and recovers', async () => {
    const root = copyFixture('express-api', 'cv-engine-');
    const engine = start(root, { watch: false });
    const good = await engine.current();
    const errors: string[] = [];
    engine.onError((e) => errors.push(e.message));
    const backup = path.join(path.dirname(root), 'backup');
    fs.renameSync(root, backup);
    fs.mkdirSync(root);
    await expect(engine.reanalyze()).rejects.toThrow(/not a directory|No JavaScript/);
    expect(errors).toHaveLength(1);
    expect(engine.latest()).toBe(good);
    await expect(engine.current()).rejects.toThrow();
    fs.rmSync(root, { recursive: true });
    fs.renameSync(backup, root);
    const back = await engine.reanalyze();
    expect(back.stats.files).toBe(good.stats.files);
    expect(await engine.current()).toBe(back);
  });

  it('isolates listeners: a throwing listener neither fails the analysis nor stops the others', async () => {
    const logs: string[] = [];
    const engine = start(copyFixture('express-api', 'cv-engine-'), { watch: false, log: (m) => logs.push(m) });
    await engine.current();
    const seen: number[] = [];
    engine.onUpdate(() => {
      throw new Error('listener bug');
    });
    const off = engine.onUpdate((u) => seen.push(u.version));
    const data = await engine.reanalyze();
    expect(data).toBe(engine.latest());
    expect(seen).toEqual([2]);
    expect(logs).toContain('✖ listener bug');
    off();
    await engine.reanalyze();
    expect(seen).toEqual([2]);
  });

  it('whatIf analyzes a proposed edit without writing it, reusing the warm cache', async () => {
    const root = copyFixture('express-api', 'cv-engine-');
    const engine = start(root, { watch: false });
    const before = await engine.current();
    const original = fs.readFileSync(path.join(root, 'utils/object.js'), 'utf8');
    const proposed = `${original}\nexport function proposedHelper(value) {\n  return value ? 1 : 0;\n}\n`;
    const what = await engine.whatIf(path.join(root, 'utils/object.js'), proposed);
    expect(what.files.find((f) => f.id === 'utils/object.js')?.symbols.map((s) => s.name)).toContain('proposedHelper');
    expect(what.stats.cache).toMatchObject({ parsed: 1, reused: what.stats.files - 1 });
    // Nothing was written, and the engine's own analysis is untouched.
    expect(fs.readFileSync(path.join(root, 'utils/object.js'), 'utf8')).toBe(original);
    expect(engine.latest()).toBe(before);
    expect(symbolsOf(engine, 'utils/object.js')).not.toContain('proposedHelper');
    // A deleted file, and a path outside the project.
    const gone = await engine.whatIf('utils/object.js', null);
    expect(gone.files.some((f) => f.id === 'utils/object.js')).toBe(false);
    await expect(engine.whatIf('../elsewhere.js', '')).rejects.toThrow(/outside of the project root/);
  });

  it('persist: loads the disk cache on start and saves it on close', async () => {
    const root = copyFixture('vue-app', 'cv-engine-');
    const a = start(root, { watch: false, options: { ...ANALYSIS, persist: true } });
    expect((await a.current()).stats.cache?.source).toBe('cold');
    a.close();
    expect(fs.existsSync(parseCachePath(root))).toBe(true);
    const b = start(root, { watch: false, options: { ...ANALYSIS, persist: true } });
    const data = await b.current();
    expect(data.stats.cache).toEqual({ reused: data.stats.files, parsed: 0, source: 'disk' });
  });

  it('announces live events with `events` and honours serve.events.exclude from the configuration', async () => {
    const root = copyFixture('react-vite-ts', 'cv-engine-');
    const engine = start(root, { watch: false, events: true });
    await engine.current();
    const client = fs.readFileSync(path.join(root, 'src/api/client.ts'), 'utf8');
    writeFile(root, 'src/api/client.ts', `${client}import { useUsers } from '@/hooks/useUsers';\nexport const usersHook = useUsers;\n`);
    let update = nextUpdate(engine);
    await engine.reanalyze(['src/api/client.ts']);
    const added = (await update).events ?? [];
    expect(added.map((e) => e.kind)).toContain('cycle-added');
    expect(added.every((e) => e.version === engine.version())).toBe(true);
    expect(engine.feed()).toMatchObject({ version: engine.version(), events: added });
    expect(engine.feed().open.map((e) => e.kind)).toContain('cycle-added');

    // The configuration is read with every analysis: excluded kinds stay quiet, the problem still closes.
    writeFile(root, 'code-visualizer.config.json', JSON.stringify({ serve: { events: { exclude: ['cycle-fixed', 'health'] } } }));
    writeFile(root, 'src/api/client.ts', client);
    update = nextUpdate(engine);
    await engine.reanalyze(['src/api/client.ts', 'code-visualizer.config.json']);
    const fixed = (await update).events ?? [];
    expect(fixed.map((e) => e.kind)).not.toContain('cycle-fixed');
    expect(fixed.map((e) => e.kind)).not.toContain('health');
    expect(engine.feed().open.map((e) => e.kind)).not.toContain('cycle-added');
  });

  it('announces a configuration that cannot be read, read from disk with every analysis (live guard)', async () => {
    const root = copyFixture('react-vite-ts', 'cv-engine-');
    const rules = { rules: [{ name: 'no-api-in-utils', from: 'src/utils/**', to: 'src/api/**' }] };
    writeFile(root, 'code-visualizer.config.json', JSON.stringify(rules));
    const engine = start(root, { watch: false, events: true, options: { git: false, includeSource: false } });
    await engine.current();
    const format = fs.readFileSync(path.join(root, 'src/utils/format.ts'), 'utf8');
    writeFile(root, 'src/utils/format.ts', `import { fetchUsers } from '@/api/client';\nexport const users = fetchUsers;\n${format}`);
    let update = nextUpdate(engine);
    await engine.reanalyze(['src/utils/format.ts']);
    expect(((await update).events ?? []).map((e) => e.kind)).toContain('rule-violation');

    writeFile(root, 'code-visualizer.config.json', JSON.stringify({ ...rules, serve: { events: { exclude: ['unused-exports'] } } }));
    update = nextUpdate(engine);
    await engine.reanalyze(['code-visualizer.config.json']);
    const typo = (await update).events ?? [];
    expect(typo).toEqual([expect.objectContaining({ kind: 'config', severity: 'warning', message: expect.stringContaining('did you mean "unused-export"') })]);
    const problems = () => engine.feed().open.filter((e) => e.kind !== 'untested-change').map((e) => e.kind).sort();
    expect(problems()).toEqual(['config', 'rule-violation']);

    writeFile(root, 'code-visualizer.config.json', JSON.stringify(rules));
    update = nextUpdate(engine);
    await engine.reanalyze(['code-visualizer.config.json']);
    expect(((await update).events ?? []).map((e) => `${e.kind} ${e.severity}`)).toEqual(['config success']);
    expect(problems()).toEqual(['rule-violation']);
  });

  it('has no live events without `events`', async () => {
    const engine = start(copyFixture('express-api', 'cv-engine-'), { watch: false });
    await engine.current();
    const update = nextUpdate(engine);
    await engine.reanalyze();
    expect((await update).events).toBeUndefined();
    expect(engine.feed()).toEqual({ version: 2, events: [], open: [] });
  });

  it('writes history after project-wide analyses when asked', async () => {
    const root = copyFixture('express-api', 'cv-engine-');
    const engine = start(root, { watch: false, writeHistory: true, options: { git: false, includeSource: false } });
    await engine.current();
    expect(JSON.parse(fs.readFileSync(path.join(root, '.code-visualizer', 'history.json'), 'utf8')).points).toHaveLength(1);
  });
});

describe('per-directory watching (Linux)', () => {
  it('watches project folders (not dependencies), follows new folders and reports changes', async () => {
    const root = copyFixture('react-vite-ts', 'cv-engine-');
    writeFile(root, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    writeFile(root, 'dist/assets/app.js', 'console.log(1);\n');
    const watched: string[] = [];
    const watchFn = ((target: fs.PathLike, ...rest: unknown[]) => {
      watched.push(path.relative(root, String(target)).split(path.sep).join('/'));
      return (fs.watch as (...args: unknown[]) => fs.FSWatcher)(target, ...rest);
    }) as typeof fs.watch;
    const engine = start(root, { platform: 'linux', watchFn });
    await engine.current();
    expect(engine.watchMode()).toBe('directories');
    expect(watched).toEqual(expect.arrayContaining(['', 'src', 'src/components', 'src/utils', 'src/pages/admin']));
    expect(watched.some((w) => w.startsWith('node_modules') || w.startsWith('dist'))).toBe(false);
    expect(watched.every((w) => !w.startsWith('..'))).toBe(true);
    await watchersReady();

    const edit = nextUpdate(engine, (u) => u.changed.includes('src/hooks/useDebounce.ts'));
    appendFile(root, 'src/hooks/useDebounce.ts', '\nexport const linuxWatched = 1;\n');
    await edit;

    // A new folder: its creation is reported, and from then on its files are watched too.
    const created = nextUpdate(engine, (u) => u.data.files.some((f) => f.id === 'src/features/flags.ts'));
    writeFile(root, 'src/features/flags.ts', 'export const FLAGS = { beta: true };\n');
    await created;
    await engine.current();
    expect(watched).toContain('src/features');
    const nested = nextUpdate(engine, (u) => u.changed.includes('src/features/flags.ts'));
    appendFile(root, 'src/features/flags.ts', 'export const MORE = 1;\n');
    await nested;
  });

  it('sees the first source file in a folder that had none (scripts/, e2e/…)', async () => {
    const root = copyFixture('react-vite-ts', 'cv-engine-');
    writeFile(root, 'scripts/README.md', '# Scripts\n');
    const engine = start(root, { platform: 'linux' });
    await engine.current();
    await watchersReady();
    const created = nextUpdate(engine, (u) => u.data.files.some((f) => f.id === 'scripts/seed.ts'));
    writeFile(root, 'scripts/seed.ts', 'export const seed = 1;\n');
    await created;
  });

  it('ignores edits inside nested fixture projects the analysis leaves out, but not their package.json', async () => {
    const root = copyFixture('nested-subprojects', 'cv-engine-');
    const { watchFn, fire } = fakeWatch(root);
    const engine = start(root, { mode: 'lazy', platform: 'darwin', watchFn });
    const first = await engine.current();
    expect(first.project.subprojects).toEqual(['test/fixtures/app']);
    const updates: EngineUpdate[] = [];
    engine.onUpdate((u) => updates.push(u));
    fire('test/fixtures/app/page.tsx');
    expect(await engine.current()).toBe(first);
    expect(updates).toHaveLength(0);
    // Removing (or changing) its package.json can make the folder part of the project.
    fire('test/fixtures/app/package.json');
    await engine.current();
    expect(updates.map((u) => u.changed)).toEqual([['test/fixtures/app/package.json']]);
  });

  it('does not watch the folders of excluded sub-projects on Linux', () => {
    const root = copyFixture('nested-subprojects', 'cv-engine-');
    fs.mkdirSync(path.join(root, 'test/fixtures/app/components'), { recursive: true });
    const changes: (string | undefined)[] = [];
    const watcher = watchProject({ root, platform: 'linux', onChange: (rel) => changes.push(rel), ignoredDirectories: ['test/fixtures/app'] });
    try {
      expect(watcher.watched()).toEqual(expect.arrayContaining(['test', 'test/fixtures', 'test/fixtures/app']));
      expect(watcher.watched()).not.toContain('test/fixtures/app/components');
      watcher.ignoreDirectories([]);
      watcher.addDirectories(['test/fixtures/app/components']);
      expect(watcher.watched()).toContain('test/fixtures/app/components');
      watcher.ignoreDirectories(['test/fixtures']);
      expect(watcher.watched().filter((d) => d.startsWith('test/fixtures/'))).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it('ignores dependency, build, dot and state folders', () => {
    const root = copyFixture('express-api', 'cv-engine-');
    for (const dir of ['node_modules/x', 'dist', '.code-visualizer', '.github/workflows', 'docs/guide']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    const changes: (string | undefined)[] = [];
    const watcher = watchProject({ root, platform: 'linux', onChange: (rel) => changes.push(rel) });
    try {
      watcher.addDirectories(['node_modules/x', 'dist', '.code-visualizer', 'routes', 'a/b/c']);
      const watched = watcher.watched();
      expect(watched).toEqual(expect.arrayContaining(['', 'routes', 'docs', 'docs/guide']));
      expect(watched.filter((w) => /^(node_modules|dist|\.code-visualizer|\.github|a)(\/|$)/.test(w))).toEqual([]);
    } finally {
      watcher.close();
    }
    expect(watcher.watched()).toEqual([]);
  });

  it('treats dependency, build and state folders as ignored at any depth, also when they appear', () => {
    for (const p of ['node_modules/x/index.js', '.git/index', 'lib/.code-visualizer', 'lib/.code-visualizer/cache/parse.json.gz', 'packages/a/node_modules', 'packages/a/dist/x.js', '.code-visualizer'])
      expect(isIgnoredPath(p), p).toBe(true);
    for (const p of ['src/index.ts', 'src/build.ts', 'lib/vendor.ts', 'distance.ts', '.gitignore'])
      expect(isIgnoredPath(p), p).toBe(false);
  });

  it('lists every folder and ancestor of the analyzed files', () => {
    expect([...directoriesOf(['a.ts', 'src/x/y/z.ts', 'src/x/w.ts', 'lib/q.ts'])].sort()).toEqual(['lib', 'src', 'src/x', 'src/x/y']);
  });
});
