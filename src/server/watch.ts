import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIR_NAMES } from '../analyzer/files.js';

/**
 * True for dependency, build, VCS or state folders and anything inside them (never worth a
 * re-analysis), at any depth: `lib/.code-visualizer` appearing is as irrelevant as its contents.
 */
export function isIgnoredPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => IGNORE_DIR_NAMES.has(part) || part === '.git' || part === '.code-visualizer');
}

function isIgnoredDir(rel: string): boolean {
  return rel.split('/').some((p) => IGNORE_DIR_NAMES.has(p) || p === '.git' || p === '.code-visualizer');
}

export type WatchFn = typeof fs.watch;

/** Folders without analyzed files watched on Linux (so their first source file is seen), at most. */
const MAX_EXTRA_DIRS = 2_000;

export interface ProjectWatcherOptions {
  root: string;
  /** A project file or folder changed (project-relative posix path; undefined when the OS does not say which). */
  onChange: (rel: string | undefined) => void;
  /** Defaults to process.platform (injectable for tests). */
  platform?: NodeJS.Platform;
  /** Defaults to fs.watch (injectable for tests). */
  watch?: WatchFn;
  log?: (message: string) => void;
  /** Folders whose changes never matter (see `ProjectWatcher.ignoreDirectories`). */
  ignoredDirectories?: Iterable<string>;
}

export interface ProjectWatcher {
  /**
   * `recursive`: one native recursive watch (macOS, Windows).
   * `directories`: one watch per project folder outside dependency, build and dot folders (Linux,
   * where a recursive watch would walk node_modules and exhaust inotify watches).
   */
  readonly mode: 'recursive' | 'directories' | 'none';
  /** Folders (project-relative, posix) that contain analyzed files; ignored in recursive mode. */
  addDirectories(dirs: Iterable<string>): void;
  /**
   * Folders the analysis leaves out (nested fixture / example projects, accuracy-pass): changes inside
   * them are not reported, except their own package.json (removing it makes the folder part of the
   * project again). Replaces the previous list.
   */
  ignoreDirectories(dirs: Iterable<string>): void;
  /** Watched folders (project-relative, '' is the root). */
  watched(): string[];
  close(): void;
}

/** Watch the project for edits: recursively where the OS supports it, per directory on Linux. */
export function watchProject(options: ProjectWatcherOptions): ProjectWatcher {
  const { root } = options;
  const log = options.log ?? (() => undefined);
  const watchFn = options.watch ?? fs.watch;
  const platform = options.platform ?? process.platform;
  let ignoredDirs = [...(options.ignoredDirectories ?? [])];
  /** Strictly inside an ignored folder (the folder itself stays watched for its package.json). */
  const insideIgnored = (rel: string): boolean => ignoredDirs.some((d) => rel.startsWith(`${d}/`));
  const onChange = (rel: string | undefined): void => {
    if (rel && insideIgnored(rel) && !ignoredDirs.some((d) => rel === `${d}/package.json`)) return;
    options.onChange(rel);
  };

  if (platform === 'darwin' || platform === 'win32') {
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = watchFn(root, { recursive: true }, (_event, filename) => {
        if (!filename) return onChange(undefined);
        const rel = filename.toString();
        if (!isIgnoredPath(rel)) onChange(rel.split(path.sep).join('/'));
      });
      watcher.on('error', () => undefined);
    } catch {
      log('! File watching is not available on this platform; reload the page after changes.');
    }
    return {
      mode: watcher ? 'recursive' : 'none',
      addDirectories: () => undefined,
      ignoreDirectories(dirs) {
        ignoredDirs = [...dirs];
      },
      watched: () => (watcher ? [''] : []),
      close: () => watcher?.close(),
    };
  }

  const watchers = new Map<string, fs.FSWatcher>();
  let exhausted = false;
  let closed = false;
  const unwatch = (rel: string): void => {
    for (const [dir, w] of watchers) {
      if (dir === rel || dir.startsWith(`${rel}/`)) {
        w.close();
        watchers.delete(dir);
      }
    }
  };
  const add = (rel: string): boolean => {
    if (closed || exhausted || watchers.has(rel)) return watchers.has(rel);
    if (rel && (isIgnoredDir(rel) || insideIgnored(rel))) return false;
    try {
      const w = watchFn(path.join(root, rel), (event, filename) => {
        if (!filename) return onChange(rel || undefined);
        const child = rel ? `${rel}/${filename.toString()}` : filename.toString();
        if (isIgnoredPath(child)) return;
        // 'rename' = created, deleted or moved: start watching new folders, forget removed ones.
        if (event === 'rename') addTree(child);
        onChange(child);
      });
      w.on('error', () => unwatch(rel));
      watchers.set(rel, w);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EMFILE') {
        exhausted = true;
        log('! Reached the system limit of file watchers (fs.inotify.max_user_watches); some folders are not watched.');
      }
      return false;
    }
  };
  const addTree = (rel: string, depth = 0): void => {
    let entries: fs.Dirent[];
    try {
      if (!fs.statSync(path.join(root, rel)).isDirectory()) return;
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      unwatch(rel); // removed
      return;
    }
    if (!add(rel) || depth > 30) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) addTree(`${rel}/${e.name}`, depth + 1);
  };

  add('');
  if (!watchers.size) log('! File watching is not available on this platform; reload the page after changes.');
  // Folders that hold no analyzed file yet (scripts/, e2e/, tools/…) are watched too, so the first
  // source file created in them is noticed. Breadth-first and capped: shallow folders come first.
  let budget = MAX_EXTRA_DIRS;
  const queue = watchers.size ? [''] : [];
  while (queue.length && budget > 0 && !exhausted) {
    const rel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (isIgnoredDir(child)) continue;
      if (budget-- <= 0) break;
      if (add(child)) queue.push(child);
    }
  }
  return {
    mode: watchers.size ? 'directories' : 'none',
    addDirectories(dirs) {
      for (const dir of dirs) {
        const parts = dir.split('/').filter((p) => p && p !== '.');
        // Ancestors first, so a new sibling folder of an analyzed one is noticed too.
        for (let i = 1; i <= parts.length; i++) add(parts.slice(0, i).join('/'));
      }
    },
    ignoreDirectories(dirs) {
      ignoredDirs = [...dirs];
      for (const dir of [...watchers.keys()]) if (insideIgnored(dir)) unwatch(dir);
    },
    watched: () => [...watchers.keys()].sort(),
    close() {
      closed = true;
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}

/**
 * Watch the remote-tracking refs (`<common git dir>/refs/remotes`): `git push` and `git fetch` move them
 * without touching HEAD or the index, and trunk mode compares your branch with its upstream there.
 */
export function watchRemoteRefs(commonDir: string, onChange: () => void, watchFn: WatchFn = fs.watch): fs.FSWatcher | undefined {
  try {
    const w = watchFn(path.join(commonDir, 'refs', 'remotes'), { recursive: true }, () => onChange());
    w.on('error', () => undefined);
    return w;
  } catch {
    return undefined; // no remotes yet, or no recursive watching: `current({ verify })` still notices a moved upstream
  }
}

/** Watch the git directory for commits, checkouts, staging, fetches and merges. */
export function watchGitDir(gitDir: string, onChange: () => void, watchFn: WatchFn = fs.watch): fs.FSWatcher | undefined {
  try {
    const w = watchFn(gitDir, (_event, filename) => {
      const name = filename?.toString() ?? '';
      if (/^(HEAD|index|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|packed-refs)$/.test(name)) onChange();
    });
    w.on('error', () => undefined);
    return w;
  } catch {
    return undefined;
  }
}
