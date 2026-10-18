import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { glob } from 'tinyglobby';
import type { FrameworkCategory, FrameworkInfo } from '../shared/types.js';

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

export function readJson<T>(file: string): T | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8');
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

async function findWorkspaces(root: string, pkg: PackageJson): Promise<WorkspacePackage[]> {
  let patterns: string[] = [];
  if (Array.isArray(pkg.workspaces)) patterns = pkg.workspaces;
  else if (pkg.workspaces?.packages) patterns = pkg.workspaces.packages;
  const pnpm = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpm)) {
    const text = fs.readFileSync(pnpm, 'utf8');
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
  const lerna = readJson<{ packages?: string[] }>(path.join(root, 'lerna.json'));
  if (lerna?.packages) patterns.push(...lerna.packages);
  if (!patterns.length) return [];
  const manifests = await glob(
    patterns.map((p) => `${p.replace(/\/+$/, '')}/package.json`),
    { cwd: root, ignore: ['**/node_modules/**'], absolute: false },
  );
  const result: WorkspacePackage[] = [];
  for (const manifest of manifests) {
    const wpkg = readJson<PackageJson>(path.join(root, manifest));
    if (!wpkg?.name) continue;
    result.push({ name: wpkg.name, dir: toPosix(path.dirname(manifest)), pkg: wpkg });
  }
  return result;
}

function parseTsconfig(file: string): PathsConfig | undefined {
  try {
    const read = ts.readConfigFile(file, ts.sys.readFile);
    if (!read.config) return undefined;
    const dir = path.dirname(file);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, file);
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
function readBundlerAliases(root: string): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const files = [
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
  for (const name of files) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
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

/** Find source files referenced by package.json scripts (`node scripts/build.js`) and index.html. */
function findScriptEntries(root: string, pkgs: { dir: string; pkg: PackageJson }[]): Set<string> {
  const entries = new Set<string>();
  for (const { dir, pkg } of pkgs) {
    for (const script of Object.values(pkg.scripts ?? {})) {
      for (const m of script.matchAll(/(?:^|\s)((?:\.\/)?[\w\-./]+\.(?:[cm]?[jt]sx?))(?=\s|$)/g)) {
        entries.add(toPosix(path.normalize(path.join(dir, m[1]))));
      }
    }
    for (const html of ['index.html', 'public/index.html', 'src/index.html']) {
      const file = path.join(root, dir, html);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<script[^>]+src=["']\/?([^"']+\.(?:[cm]?[jt]sx?))["']/g)) {
        entries.add(toPosix(path.normalize(path.join(dir, m[1]))));
      }
    }
  }
  return entries;
}

export async function loadProject(root: string): Promise<ProjectContext> {
  const pkgFile = fs.existsSync(path.join(root, 'package.json')) ? path.join(root, 'package.json') : findUp(root, 'package.json');
  const pkg = (pkgFile && readJson<PackageJson>(pkgFile)) || {};
  const pkgDir = pkgFile ? path.dirname(pkgFile) : root;
  const workspaces = await findWorkspaces(root, pkg);

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

  const tsconfigFiles = await glob(['**/tsconfig*.json', '**/jsconfig*.json'], {
    cwd: root,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.nuxt/**', '**/.svelte-kit/**'],
    absolute: true,
    deep: 6,
  });
  const tsconfigs = tsconfigFiles
    .sort((a, b) => a.length - b.length)
    .map(parseTsconfig)
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

  return {
    root,
    pkg,
    pkgDir,
    workspaces,
    declared,
    frameworks,
    packageManager: detectPackageManager(root, pkg),
    tsconfigs,
    aliases: readBundlerAliases(root),
    hasTypeScript,
    scriptEntries: findScriptEntries(root, allPkgs),
  };
}

export function hasFramework(ctx: ProjectContext, id: string): boolean {
  return ctx.frameworks.some((f) => f.id === id);
}
