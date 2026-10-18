import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { glob } from 'tinyglobby';
import ignore from 'ignore';
import { SOURCE_EXTENSIONS } from './resolve.js';
import { toPosix } from './project.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/jspm_packages/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.output/**',
  '**/.svelte-kit/**',
  '**/.astro/**',
  '**/.turbo/**',
  '**/.vercel/**',
  '**/.netlify/**',
  '**/.cache/**',
  '**/.parcel-cache/**',
  '**/.docusaurus/**',
  '**/.expo/**',
  '**/.git/**',
  '**/.code-visualizer/**',
  '**/target/**',
  '**/.angular/**',
  '**/.nx/**',
  '**/.vite/**',
  '**/.yarn/**',
  '**/.pnpm-store/**',
  '**/.serverless/**',
  '**/.wrangler/**',
  '**/.gradle/**',
  '**/Pods/**',
  '**/DerivedData/**',
  '**/storybook-static/**',
  '**/vendor/**',
  '**/public/**/*.js',
  '**/static/**/*.js',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.chunk.js',
];

export const IGNORE_DIR_NAMES = new Set(
  DEFAULT_IGNORES.filter((p) => p.endsWith('/**') && !p.includes('*.'))
    .map((p) => p.replace(/^\*\*\//, '').replace(/\/\*\*$/, ''))
    .filter((p) => !p.includes('/')),
);

export const MAX_FILE_BYTES = 1_500_000;

export interface DiscoveredFile {
  id: string;
  abs: string;
  ext: string;
  bytes: number;
  mtimeMs: number;
}

export interface DiscoverOptions {
  exclude?: string[];
  /** Project-relative directories to leave out entirely (nested fixture / example projects). */
  excludeDirs?: string[];
  maxFiles?: number;
}

export interface DiscoverResult {
  files: DiscoveredFile[];
  skipped: { id: string; reason: string }[];
  truncated: boolean;
  usedGit: boolean;
  /** The `excludeDirs` that actually contained source files. */
  excludedDirs: string[];
}

export function extOf(file: string): string {
  if (file.endsWith('.d.ts')) return '.ts';
  return path.extname(file).toLowerCase();
}

async function gitListFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout.split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

function isIgnoredByDefault(id: string): boolean {
  const parts = id.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORE_DIR_NAMES.has(parts[i])) return true;
  }
  const base = parts[parts.length - 1];
  if (/\.(min|bundle|chunk)\.js$/.test(base)) return true;
  if ((parts.includes('public') || parts.includes('static')) && /\.js$/.test(base)) return true;
  return false;
}

/**
 * The path checks discovery applies (extension, default ignores, user excludes, excluded sub-project
 * folders) — also used for overlay-only files.
 */
export function discoveryFilter(exclude: string[] = [], excludeDirs: string[] = []): (id: string) => boolean {
  const exts = new Set(SOURCE_EXTENSIONS);
  const userIgnore = ignore().add(exclude);
  return (id) => exts.has(extOf(id)) && !isIgnoredByDefault(id) && !userIgnore.ignores(id) && !excludeDirs.some((d) => id.startsWith(`${d}/`));
}

export async function discoverFiles(root: string, options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const exts = new Set(SOURCE_EXTENSIONS);
  const accept = discoveryFilter(options.exclude);
  let candidates = await gitListFiles(root);
  // The folder may be git-ignored by a parent repository (e.g. a package inside node_modules).
  if (candidates && !candidates.some((c) => exts.has(extOf(c)))) candidates = undefined;
  const usedGit = !!candidates;
  if (!candidates) {
    const gi = ignore();
    for (const file of ['.gitignore', '.ignore']) {
      const p = path.join(root, file);
      if (fs.existsSync(p)) gi.add(fs.readFileSync(p, 'utf8'));
    }
    const found = await glob(
      SOURCE_EXTENSIONS.map((e) => `**/*${e}`),
      { cwd: root, ignore: DEFAULT_IGNORES, dot: false, followSymbolicLinks: false },
    );
    candidates = found.filter((f) => !gi.ignores(f));
  }

  const files: DiscoveredFile[] = [];
  const skipped: DiscoverResult['skipped'] = [];
  const excludeDirs = options.excludeDirs ?? [];
  const excludedDirs = new Set<string>();
  for (const raw of candidates) {
    const id = toPosix(raw);
    if (!accept(id)) continue;
    const ext = extOf(id);
    const dir = excludeDirs.length ? excludeDirs.find((d) => id.startsWith(`${d}/`)) : undefined;
    if (dir) {
      excludedDirs.add(dir);
      continue;
    }
    const abs = path.join(root, id);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // deleted in working tree
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_FILE_BYTES) {
      skipped.push({ id, reason: `larger than ${(MAX_FILE_BYTES / 1e6).toFixed(1)} MB` });
      continue;
    }
    files.push({ id, abs, ext, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => a.id.localeCompare(b.id));
  const max = options.maxFiles ?? 20000;
  let truncated = false;
  if (files.length > max) {
    truncated = true;
    // Prefer application source over tests when truncating.
    files.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
    files.length = max;
    files.sort((a, b) => a.id.localeCompare(b.id));
  }
  return { files, skipped, truncated, usedGit, excludedDirs: excludeDirs.filter((d) => excludedDirs.has(d)) };
}

function rank(id: string): number {
  if (/(^|\/)(test|tests|__tests__|e2e|spec)\//.test(id) || /\.(test|spec)\./.test(id)) return 2;
  if (/(^|\/)(src|app|lib|packages|apps)\//.test(id)) return 0;
  return 1;
}
