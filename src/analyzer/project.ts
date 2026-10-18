import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import ignore from 'ignore';
import { glob } from 'tinyglobby';
import type { DeclaredAs, FrameworkCategory, FrameworkInfo } from '../shared/types.js';
import { projectFiles, type ProjectFiles, type ReadText } from './readtext.js';

export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  main?: string;
  module?: string;
  source?: string;
  browser?: string | Record<string, unknown>;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface WorkspacePackage {
  name: string;
  /** Project-relative directory. */
  dir: string;
  pkg: PackageJson;
}

export type Declarations = Map<string, { version: string; declaredAs: DeclaredAs }>;

/** A package.json that takes part in the analysis. */
export interface Manifest {
  /** Project-relative directory ('' for the root package, even when its package.json lives above the root). */
  dir: string;
  pkg: PackageJson;
  /**
   * `ancestor` is the monorepo root above an analyzed workspace: its declarations are visible to the
   * analyzed code (hoisting), but its own dependencies are never judged.
   */
  role: 'root' | 'workspace' | 'subproject' | 'ancestor';
  /** Dependencies declared by this package.json (runtime fields win over devDependencies). */
  declared: Declarations;
}

export interface LoadProjectOptions {
  /**
   * Nested packages inside test / fixture / example folders are left out by default.
   * `true` keeps all of them; globs keep the matching directories.
   */
  includeSubprojects?: boolean | string[];
  /**
   * A project-relative path the user asked for explicitly (`--file` / `--directory`): sub-projects that
   * contain it, or that it contains, are analyzed.
   */
  keep?: string;
  /**
   * Show the project as it is in a snapshot (another ref, the index, an edit): manifest and config
   * reads go through `readText` (see AnalyzeOptions.readText), and `extraFiles` are root-relative
   * files that exist only in the snapshot, so globbed lookups (tsconfigs, workspaces) find them.
   */
  readText?: ReadText;
  extraFiles?: string[];
}

export interface PathsConfig {
  /** Absolute directory of the tsconfig file. */
  dir: string;
  /** Absolute base for `paths` (baseUrl or tsconfig dir). */
  pathsBase: string;
  baseUrl?: string;
  paths: Record<string, string[]>;
}

export interface ProjectContext {
  root: string;
  pkg: PackageJson;
  pkgDir: string;
  workspaces: WorkspacePackage[];
  /** All dependencies declared across root and workspace package.json files. */
  declared: Map<string, { version: string; declaredAs: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies' }>;
  frameworks: FrameworkInfo[];
  packageManager?: string;
  tsconfigs: PathsConfig[];
  aliases: Map<string, string[]>;
  hasTypeScript: boolean;
  /** Script entry points found in package.json scripts and index.html files. */
  scriptEntries: Set<string>;
  /** The subset of `scriptEntries` loaded by an index.html (browser bundles). */
  htmlEntries: Set<string>;
  /** Root, workspace and nested package.json files whose code is analyzed (deepest directory first). */
  manifests: Manifest[];
  /**
   * Directories of nested packages (not workspaces) inside test / fixture / example folders. Their files
   * are left out of the analysis unless `includeSubprojects` is set.
   */
  excludedSubprojects: string[];
  /** `includeSubprojects` globs that matched no nested package (likely a typo). */
  unmatchedSubprojectGlobs: string[];
}

const FRAMEWORKS: [pkg: string, id: string, name: string, category: FrameworkCategory][] = [
  ['next', 'next', 'Next.js', 'fullstack'],
  ['nuxt', 'nuxt', 'Nuxt', 'fullstack'],
  ['@remix-run/react', 'remix', 'Remix', 'fullstack'],
  ['@react-router/dev', 'react-router-framework', 'React Router (framework)', 'fullstack'],
  ['@sveltejs/kit', 'sveltekit', 'SvelteKit', 'fullstack'],
  ['astro', 'astro', 'Astro', 'fullstack'],
  ['gatsby', 'gatsby', 'Gatsby', 'fullstack'],
  ['@redwoodjs/core', 'redwood', 'RedwoodJS', 'fullstack'],
  ['@builder.io/qwik', 'qwik', 'Qwik', 'frontend'],
  ['@angular/core', 'angular', 'Angular', 'frontend'],
  ['react', 'react', 'React', 'frontend'],
  ['vue', 'vue', 'Vue', 'frontend'],
  ['svelte', 'svelte', 'Svelte', 'frontend'],
  ['solid-js', 'solid', 'SolidJS', 'frontend'],
  ['preact', 'preact', 'Preact', 'frontend'],
  ['lit', 'lit', 'Lit', 'frontend'],
  ['react-router-dom', 'react-router', 'React Router', 'frontend'],
  ['react-router', 'react-router', 'React Router', 'frontend'],
  ['@tanstack/react-router', 'tanstack-router', 'TanStack Router', 'frontend'],
  ['vue-router', 'vue-router', 'Vue Router', 'frontend'],
  ['react-native', 'react-native', 'React Native', 'mobile'],
  ['expo', 'expo', 'Expo', 'mobile'],
  ['@ionic/core', 'ionic', 'Ionic', 'mobile'],
  ['electron', 'electron', 'Electron', 'desktop'],
  ['@tauri-apps/api', 'tauri', 'Tauri', 'desktop'],
  ['@nestjs/core', 'nestjs', 'NestJS', 'backend'],
  ['express', 'express', 'Express', 'backend'],
  ['fastify', 'fastify', 'Fastify', 'backend'],
  ['koa', 'koa', 'Koa', 'backend'],
  ['hono', 'hono', 'Hono', 'backend'],
  ['@hapi/hapi', 'hapi', 'hapi', 'backend'],
  ['@trpc/server', 'trpc', 'tRPC', 'backend'],
  ['socket.io', 'socket.io', 'Socket.IO', 'backend'],
  ['@apollo/server', 'apollo-server', 'Apollo Server', 'backend'],
  ['graphql', 'graphql', 'GraphQL', 'data'],
  ['@apollo/client', 'apollo-client', 'Apollo Client', 'data'],
  ['@tanstack/react-query', 'tanstack-query', 'TanStack Query', 'data'],
  ['@tanstack/vue-query', 'tanstack-query', 'TanStack Query', 'data'],
  ['swr', 'swr', 'SWR', 'data'],
  ['axios', 'axios', 'Axios', 'data'],
  ['@prisma/client', 'prisma', 'Prisma', 'data'],
  ['prisma', 'prisma', 'Prisma', 'data'],
  ['drizzle-orm', 'drizzle', 'Drizzle ORM', 'data'],
  ['mongoose', 'mongoose', 'Mongoose', 'data'],
  ['typeorm', 'typeorm', 'TypeORM', 'data'],
  ['sequelize', 'sequelize', 'Sequelize', 'data'],
  ['@supabase/supabase-js', 'supabase', 'Supabase', 'data'],
  ['firebase', 'firebase', 'Firebase', 'data'],
  ['zod', 'zod', 'Zod', 'data'],
  ['@reduxjs/toolkit', 'redux', 'Redux Toolkit', 'state'],
  ['redux', 'redux', 'Redux', 'state'],
  ['zustand', 'zustand', 'Zustand', 'state'],
  ['mobx', 'mobx', 'MobX', 'state'],
  ['pinia', 'pinia', 'Pinia', 'state'],
  ['vuex', 'vuex', 'Vuex', 'state'],
  ['jotai', 'jotai', 'Jotai', 'state'],
  ['recoil', 'recoil', 'Recoil', 'state'],
  ['xstate', 'xstate', 'XState', 'state'],
  ['@ngrx/store', 'ngrx', 'NgRx', 'state'],
  ['tailwindcss', 'tailwind', 'Tailwind CSS', 'styling'],
  ['styled-components', 'styled-components', 'styled-components', 'styling'],
  ['@emotion/react', 'emotion', 'Emotion', 'styling'],
  ['sass', 'sass', 'Sass', 'styling'],
  ['@mui/material', 'mui', 'Material UI', 'styling'],
  ['@chakra-ui/react', 'chakra', 'Chakra UI', 'styling'],
  ['antd', 'antd', 'Ant Design', 'styling'],
  ['@radix-ui/react-slot', 'shadcn', 'Radix / shadcn', 'styling'],
  ['vuetify', 'vuetify', 'Vuetify', 'styling'],
  ['bootstrap', 'bootstrap', 'Bootstrap', 'styling'],
  ['vite', 'vite', 'Vite', 'build'],
  ['webpack', 'webpack', 'webpack', 'build'],
  ['turbo', 'turborepo', 'Turborepo', 'build'],
  ['nx', 'nx', 'Nx', 'build'],
  ['esbuild', 'esbuild', 'esbuild', 'build'],
  ['rollup', 'rollup', 'Rollup', 'build'],
  ['parcel', 'parcel', 'Parcel', 'build'],
  ['tsup', 'tsup', 'tsup', 'build'],
  ['jest', 'jest', 'Jest', 'testing'],
  ['vitest', 'vitest', 'Vitest', 'testing'],
  ['@playwright/test', 'playwright', 'Playwright', 'testing'],
  ['cypress', 'cypress', 'Cypress', 'testing'],
  ['@testing-library/react', 'testing-library', 'Testing Library', 'testing'],
  ['@testing-library/vue', 'testing-library', 'Testing Library', 'testing'],
  ['mocha', 'mocha', 'Mocha', 'testing'],
  ['storybook', 'storybook', 'Storybook', 'testing'],
  ['@storybook/react', 'storybook', 'Storybook', 'testing'],
  ['typescript', 'typescript', 'TypeScript', 'language'],
];

const DISK: ProjectFiles = projectFiles('');

export function readJson<T>(file: string, files: ProjectFiles = DISK): T | undefined {
  try {
    const text = files.read(file);
    if (text === undefined) return undefined;
    // Strip BOM and tolerate comments / trailing commas (tsconfig-style JSON).
    const parsed = ts.parseConfigFileTextToJson(file, text.replace(/^﻿/, ''));
    return parsed.config as T;
  } catch {
    return undefined;
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function findUp(start: string, file: string, stopAt?: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || (stopAt && dir === stopAt)) return undefined;
    dir = parent;
  }
}

/** `.json` files read through `files` (a snapshot) also resolve `extends` chains through it. */
function configHost(files: ProjectFiles): ts.ParseConfigHost {
  return { ...ts.sys, readFile: (p) => files.read(p), fileExists: (p) => files.exists(p) };
}

function detectPackageManager(root: string, pkg: PackageJson): string | undefined {
  if (pkg.packageManager) return pkg.packageManager.split('@')[0];
  const dirs = [root, path.dirname(root)];
  for (const dir of dirs) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  }
  return undefined;
}

async function findWorkspaces(root: string, pkg: PackageJson, files: ProjectFiles): Promise<WorkspacePackage[]> {
  let patterns: string[] = [];
  if (Array.isArray(pkg.workspaces)) patterns = pkg.workspaces;
  else if (pkg.workspaces?.packages) patterns = pkg.workspaces.packages;
  const text = files.read(path.join(root, 'pnpm-workspace.yaml'));
  if (text !== undefined) {
    const block = text.match(/packages:\s*\n((?:\s*-\s*.+\n?)+)/);
    if (block) {
      patterns.push(
        ...block[1]
          .split('\n')
          .map((l) => l.replace(/^\s*-\s*/, '').replace(/['"]/g, '').trim())
          .filter((l) => l && !l.startsWith('!')),
      );
    }
  }
  const lerna = readJson<{ packages?: string[] }>(path.join(root, 'lerna.json'), files);
  if (lerna?.packages) patterns.push(...lerna.packages);
  if (!patterns.length) return [];
  const globs = patterns.map((p) => `${p.replace(/\/+$/, '')}/package.json`);
  const found = await glob(globs, { cwd: root, ignore: ['**/node_modules/**'], absolute: false });
  const matcher = ignore().add(globs);
  const extra = files.extra.filter((rel) => rel.endsWith('/package.json') && !rel.includes('node_modules/') && matcher.ignores(rel));
  const manifests = [...new Set([...found.map(toPosix), ...extra])].sort();
  const result: WorkspacePackage[] = [];
  for (const manifest of manifests) {
    const wpkg = readJson<PackageJson>(path.join(root, manifest), files);
    if (!wpkg?.name) continue;
    result.push({ name: wpkg.name, dir: toPosix(path.dirname(manifest)), pkg: wpkg });
  }
  return result;
}

function parseTsconfig(file: string, files: ProjectFiles = DISK): PathsConfig | undefined {
  try {
    const read = ts.readConfigFile(file, (p) => files.read(p));
    if (!read.config) return undefined;
    const dir = path.dirname(file);
    const parsed = ts.parseJsonConfigFileContent(read.config, files === DISK ? ts.sys : configHost(files), dir, undefined, file);
    const options = parsed.options as ts.CompilerOptions & { pathsBasePath?: string };
    const paths = (options.paths ?? {}) as Record<string, string[]>;
    const baseUrl = options.baseUrl;
    return {
      dir,
      pathsBase: baseUrl ?? options.pathsBasePath ?? dir,
      baseUrl,
      paths,
    };
  } catch {
    return undefined;
  }
}

/** Extract `resolve.alias` entries from vite / webpack / nuxt / svelte configs (best effort). */
function readBundlerAliases(root: string, files: ProjectFiles): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const configs = [
    'vite.config.ts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.mts',
    'vitest.config.ts',
    'webpack.config.js',
    'webpack.config.ts',
    'nuxt.config.ts',
    'svelte.config.js',
    'quasar.config.js',
    'vue.config.js',
    'craco.config.js',
  ];
  for (const name of configs) {
    const text = files.read(path.join(root, name));
    if (text === undefined) continue;
    const re =
      /['"]?([@~#$][\w\-/]*|[A-Za-z][\w-]*)['"]?\s*:\s*(?:path\.)?(?:resolve|join)\(\s*(?:__dirname|process\.cwd\(\)|import\.meta\.dirname)\s*,\s*['"]\.?\/?([^'"]*)['"]\s*\)/g;
    for (const m of text.matchAll(re)) addAlias(aliases, m[1], m[2]);
    const urlRe = /['"]?([@~#$][\w\-/]*)['"]?\s*:\s*fileURLToPath\(\s*new URL\(\s*['"]\.?\/?([^'"]*)['"]/g;
    for (const m of text.matchAll(urlRe)) addAlias(aliases, m[1], m[2]);
    const findRe = /find:\s*['"]([^'"]+)['"]\s*,\s*replacement:\s*(?:path\.resolve\(\s*__dirname\s*,\s*)?['"]\.?\/?([^'"]*)['"]/g;
    for (const m of text.matchAll(findRe)) addAlias(aliases, m[1], m[2]);
  }
  return aliases;
}

function addAlias(aliases: Map<string, string[]>, key: string, target: string): void {
  const clean = key.replace(/\/\*?$/, '');
  const value = target.replace(/^\.\//, '').replace(/\/+$/, '');
  const list = aliases.get(clean) ?? [];
  if (!list.includes(value)) list.push(value);
  aliases.set(clean, list);
}

/** Folders whose nested packages are sample / fixture programs rather than part of the product. */
const SAMPLE_DIRS = new Set(['fixtures', '__fixtures__', 'example', 'examples']);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'e2e']);
/** A package that *is* a test harness (a Playwright / Cypress suite with its own package.json) belongs to the project. */
const HARNESS_RE = /^(e2e|tests?|__tests__|playwright|cypress|integration|acceptance|e2e-tests?)$/;

/** Directories the project scan (manifests, tsconfigs, index.html) never descends into. */
const PROJECT_SCAN_IGNORES = [
  '**/node_modules/**',
  '**/bower_components/**',
  '**/jspm_packages/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/target/**',
  '**/vendor/**',
  '**/Pods/**',
  '**/DerivedData/**',
  '**/storybook-static/**',
  '**/.*/**',
];

/** The same folders as PROJECT_SCAN_IGNORES, for snapshot-only paths that never went through the glob. */
const PROJECT_SCAN_IGNORE_DIRS = /(^|\/)(node_modules|bower_components|jspm_packages|dist|build|out|coverage|target|vendor|Pods|DerivedData|storybook-static|\.[^/]*)\//;
const PROJECT_SCAN_NAMES = /^([tj]sconfig[^/]*\.json|package\.json|index\.html|vite\.config\.[^/]*)$/;
const PROJECT_SCAN_DEPTH = 6;

/** A package.json that describes a package (not just a `{ "type": "module" }` marker). */
function isPackageManifest(pkg: PackageJson | undefined): pkg is PackageJson {
  if (!pkg || typeof pkg !== 'object') return false;
  if (pkg.name) return true;
  const fields = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies, pkg.scripts];
  return fields.some((f) => f && typeof f === 'object' && Object.keys(f).length > 0);
}

/**
 * Whether a nested package is a sample, fixture or example program:
 * - it is, or sits inside, a fixtures / examples folder (`test/fixtures/app`, `examples/basic`, `example/`);
 * - or it sits inside a test folder (`test/app`), unless it is a test harness itself (`e2e/`, `tests/e2e/`).
 */
export function isFixtureSubproject(dir: string): boolean {
  const parts = dir.split('/');
  const name = parts[parts.length - 1];
  const parents = parts.slice(0, -1);
  if (SAMPLE_DIRS.has(name) || parents.some((p) => SAMPLE_DIRS.has(p))) return true;
  if (HARNESS_RE.test(name)) return false;
  return parents.some((p) => TEST_DIRS.has(p));
}

/**
 * The monorepo root above `root` when the analyzed folder is one of its workspaces (`check packages/web`):
 * the nearest package.json above it that declares workspaces (or has pnpm-workspace.yaml / lerna.json).
 */
function enclosingWorkspaceRoot(root: string): { dir: string; pkg: PackageJson } | undefined {
  if (fs.existsSync(path.join(root, '.git'))) return undefined;
  let dir = path.dirname(root);
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = readJson<PackageJson>(file);
      const hasWorkspaces = !!pkg?.workspaces || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(dir, 'lerna.json'));
      if (pkg && hasWorkspaces) return { dir, pkg };
    }
    // Never look past the repository root.
    if (fs.existsSync(path.join(dir, '.git'))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

const DEFAULT_HTML = ['index.html', 'public/index.html', 'src/index.html'];

const VITE_CONFIG_RE = /^vite\.config\.[cm]?[jt]s$/;

/**
 * Vite roots: the folder of each vite config (or its `root: 'web'`) and `--root <dir>` /
 * `--config <dir>/vite.config.ts` in package.json scripts.
 */
function viteRoots(root: string, pkgs: { dir: string; pkg: PackageJson }[], viteConfigs: string[], read: (file: string) => string | undefined): Set<string> {
  const roots = new Set<string>();
  const configs = [...viteConfigs];
  for (const { dir, pkg } of pkgs) {
    for (const script of Object.values(pkg.scripts ?? {})) {
      if (typeof script !== 'string' || !/\bvite\b/.test(script)) continue;
      for (const m of script.matchAll(/--root[= ]+["']?([\w\-./]+)/g)) roots.add(toPosix(path.posix.normalize(path.posix.join(dir, m[1]))));
      for (const m of script.matchAll(/(?:--config|-c)[= ]+["']?([\w\-./]+)/g)) {
        const file = toPosix(path.posix.normalize(path.posix.join(dir, m[1])));
        configs.push(file);
        roots.add(path.posix.dirname(file));
      }
    }
  }
  for (const config of configs) {
    const text = read(path.join(root, config));
    if (!text) continue;
    const base = path.posix.dirname(config);
    const m =
      text.match(/\broot\s*:\s*['"`]([^'"`]+)['"`]/) ??
      text.match(/\broot\s*:\s*(?:path\.)?(?:resolve|join)\(\s*(?:__dirname|import\.meta\.dirname|process\.cwd\(\))\s*,\s*['"`]([^'"`]+)['"`]/);
    if (m) roots.add(toPosix(path.posix.normalize(path.posix.join(base, m[1].replace(/^\.?\//, '')))));
    else roots.add(base);
  }
  for (const r of [...roots]) if (r === '.' || r.startsWith('..')) roots.delete(r);
  return roots;
}

/**
 * Find source files referenced by package.json scripts (`node scripts/build.js`) and by `<script src>` in
 * index.html files: next to each package, in vite roots and anywhere up to three folders deep.
 */
function findScriptEntries(
  root: string,
  pkgs: { dir: string; pkg: PackageJson }[],
  htmlFiles: string[],
  viteConfigs: string[],
  files: ProjectFiles,
): { entries: Set<string>; html: Set<string> } {
  const entries = new Set<string>();
  const html = new Set<string>();
  const read = (file: string): string | undefined => files.read(file);
  const htmlPkgDir = new Map<string, string>();
  for (const { dir, pkg } of pkgs) {
    for (const script of Object.values(pkg.scripts ?? {})) {
      if (typeof script !== 'string') continue;
      for (const m of script.matchAll(/(?:^|\s)((?:\.\/)?[\w\-./]+\.(?:[cm]?[jt]sx?))(?=\s|$)/g)) {
        entries.add(toPosix(path.normalize(path.join(dir, m[1]))));
      }
    }
    for (const html of DEFAULT_HTML) htmlPkgDir.set(path.posix.join(dir, html), dir);
  }
  for (const dir of viteRoots(root, pkgs, viteConfigs, read)) if (!htmlPkgDir.has(`${dir}/index.html`)) htmlPkgDir.set(`${dir}/index.html`, dir);
  for (const html of htmlFiles) if (!htmlPkgDir.has(html)) htmlPkgDir.set(html, path.posix.dirname(html));
  for (const [file, pkgDir] of htmlPkgDir) {
    const text = read(path.join(root, file));
    if (!text) continue;
    const htmlDir = path.posix.dirname(file);
    for (const m of text.matchAll(/<script[^>]+src=["']([^"']+\.(?:[cm]?[jt]sx?))["']/g)) {
      if (/^[a-z]+:\/\//i.test(m[1])) continue;
      const src = m[1].replace(/^\//, '');
      // `/src/main.tsx` is served from the vite root (the html folder); keep the package-relative reading too.
      for (const base of new Set([htmlDir, pkgDir])) {
        const entry = toPosix(path.posix.normalize(path.posix.join(base === '.' ? '' : base, src)));
        entries.add(entry);
        html.add(entry);
      }
    }
  }
  return { entries, html };
}

/** Read package.json files, tsconfig paths, bundler aliases, frameworks and nested packages. */
export async function loadProject(root: string, options: LoadProjectOptions = {}): Promise<ProjectContext> {
  const files = options.readText ? projectFiles(root, options.readText, options.extraFiles ?? []) : DISK;
  const rootPkg = path.join(root, 'package.json');
  // A root package.json the snapshot does not have must not be found on disk again (findUp starts above).
  const pkgFile = files.exists(rootPkg) ? rootPkg : findUp(path.dirname(root), 'package.json');
  const pkg = (pkgFile && readJson<PackageJson>(pkgFile, files)) || {};
  const pkgDir = pkgFile ? path.dirname(pkgFile) : root;
  const [workspaces, globbed] = await Promise.all([
    findWorkspaces(root, pkg, files),
    glob(['**/tsconfig*.json', '**/jsconfig*.json', '**/package.json', '**/index.html', '**/vite.config.*'], {
      cwd: root,
      ignore: PROJECT_SCAN_IGNORES,
      absolute: false,
      deep: PROJECT_SCAN_DEPTH,
    }),
  ]);
  // In a snapshot: drop files it does not have, add the ones only it has.
  const scanned =
    files === DISK
      ? globbed
      : globbed
          .filter((rel) => files.exists(path.join(root, rel)))
          .concat(
            files.extra.filter(
              (rel) => PROJECT_SCAN_NAMES.test(path.posix.basename(rel)) && rel.split('/').length <= PROJECT_SCAN_DEPTH && !PROJECT_SCAN_IGNORE_DIRS.test(rel),
            ),
          )
          .sort();

  /* Nested packages: workspaces belong to the project, fixtures / examples inside test folders do not. */
  const workspaceDirs = new Set(workspaces.map((w) => w.dir));
  const include = options.includeSubprojects;
  const globs = Array.isArray(include) ? include.map((p) => p.replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean) : [];
  const matchers = globs.map((g) => ({ glob: g, matcher: ignore().add(g), used: false }));
  const keep = options.keep?.replace(/\/+$/, '');
  const asked = (dir: string): boolean => !!keep && (keep === dir || keep.startsWith(`${dir}/`) || dir.startsWith(`${keep}/`));
  const nested: Manifest[] = [];
  const excludedSubprojects: string[] = [];
  for (const file of scanned) {
    if (path.posix.basename(file) !== 'package.json') continue;
    const dir = toPosix(path.dirname(file));
    if (dir === '.' || workspaceDirs.has(dir)) continue;
    const npkg = readJson<PackageJson>(path.join(root, file), files);
    if (!isPackageManifest(npkg)) continue;
    let kept = include === true || !isFixtureSubproject(dir) || asked(dir);
    for (const m of matchers) {
      if (!m.matcher.ignores(dir)) continue;
      m.used = true;
      kept = true;
    }
    if (kept) nested.push({ dir, pkg: npkg, role: 'subproject', declared: declarationsOf(npkg) });
    else excludedSubprojects.push(dir);
  }
  // Keep only the outermost excluded folders (a fixture monorepo counts once).
  excludedSubprojects.sort();
  const excluded = excludedSubprojects.filter((d, i) => !excludedSubprojects.slice(0, i).some((p) => d.startsWith(`${p}/`)));
  const isExcluded = (rel: string): boolean => excluded.some((d) => rel === d || rel.startsWith(`${d}/`));
  // Analyzing one workspace of a monorepo: the monorepo root's declarations are visible to it too.
  const ancestor = pkgFile && path.resolve(pkgDir) === path.resolve(root) ? enclosingWorkspaceRoot(root) : undefined;
  const manifests: Manifest[] = [
    { dir: '', pkg, role: 'root' as const, declared: declarationsOf(pkg) },
    ...(ancestor ? [{ dir: '', pkg: ancestor.pkg, role: 'ancestor' as const, declared: declarationsOf(ancestor.pkg) }] : []),
    ...workspaces.map((w) => ({ dir: w.dir, pkg: w.pkg, role: 'workspace' as const, declared: declarationsOf(w.pkg) })),
    ...nested.filter((m) => !isExcluded(m.dir)),
  ].sort((a, b) => b.dir.length - a.dir.length); // stable: the root stays before its ancestor

  const declared: ProjectContext['declared'] = new Map();
  const allPkgs = [{ dir: '', pkg }, ...workspaces.map((w) => ({ dir: w.dir, pkg: w.pkg }))];
  for (const { pkg: p } of allPkgs) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const) {
      for (const [name, version] of Object.entries(p[field] ?? {})) {
        if (!declared.has(name)) declared.set(name, { version, declaredAs: field });
      }
    }
  }

  const frameworks: FrameworkInfo[] = [];
  const seen = new Set<string>();
  for (const [dep, id, name, category] of FRAMEWORKS) {
    const hit = declared.get(dep);
    if (!hit || seen.has(id)) continue;
    seen.add(id);
    frameworks.push({ id, name, category, version: hit.version.replace(/^[\^~>=<\s]+/, '') });
  }

  const tsconfigFiles = scanned
    .filter((f) => /^(tsconfig|jsconfig).*\.json$/.test(path.posix.basename(f)) && !isExcluded(toPosix(path.dirname(f))))
    .map((f) => path.join(root, f));
  const tsconfigs = tsconfigFiles
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .map((f) => parseTsconfig(f, files))
    .filter((c): c is PathsConfig => !!c);

  // Generated configs that frameworks put in hidden folders (.nuxt/tsconfig.json, .svelte-kit/tsconfig.json)
  for (const hidden of ['.nuxt/tsconfig.json', '.svelte-kit/tsconfig.json']) {
    const file = path.join(root, hidden);
    if (fs.existsSync(file)) {
      const cfg = parseTsconfig(file);
      if (cfg) tsconfigs.push({ ...cfg, dir: root });
    }
  }

  const hasTypeScript = declared.has('typescript') || tsconfigFiles.some((f) => path.basename(f).startsWith('tsconfig'));
  // index.html anywhere up to three folders deep (vite apps in sub folders such as `ui/` or `web/`).
  const htmlFiles = scanned.filter(
    (f) => path.posix.basename(f) === 'index.html' && f.split('/').length <= 4 && !/(^|\/)public\//.test(f) && !isExcluded(toPosix(path.dirname(f))),
  );
  const viteConfigs = scanned.filter((f) => VITE_CONFIG_RE.test(path.posix.basename(f)) && !isExcluded(toPosix(path.dirname(f))));
  const scripts = findScriptEntries(
    root,
    manifests.filter((m) => m.role !== 'ancestor'),
    htmlFiles,
    viteConfigs,
    files,
  );

  return {
    root,
    pkg,
    pkgDir,
    workspaces,
    declared,
    frameworks,
    packageManager: detectPackageManager(root, pkg),
    tsconfigs,
    aliases: readBundlerAliases(root, files),
    hasTypeScript,
    scriptEntries: scripts.entries,
    htmlEntries: scripts.html,
    manifests,
    excludedSubprojects: excluded,
    unmatchedSubprojectGlobs: matchers.filter((m) => !m.used).map((m) => m.glob),
  };
}

/** The package.json a file belongs to (manifests are ordered deepest first; the root matches everything). */
export function nearestManifest(manifests: Manifest[], fileId: string): Manifest | undefined {
  return manifests.find((m) => !m.dir || fileId.startsWith(`${m.dir}/`));
}

const DECLARATION_FIELDS: DeclaredAs[] = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];

/** The dependencies a package.json declares; a package listed in several fields counts for the runtime one. */
function declarationsOf(pkg: PackageJson): Declarations {
  const declared: Declarations = new Map();
  for (const field of DECLARATION_FIELDS) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, version] of Object.entries(deps)) {
      if (!declared.has(name)) declared.set(name, { version: String(version), declaredAs: field });
    }
  }
  return declared;
}

export function hasFramework(ctx: ProjectContext, id: string): boolean {
  return ctx.frameworks.some((f) => f.id === id);
}
