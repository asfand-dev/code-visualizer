import path from 'node:path';
import { builtinModules } from 'node:module';
import type { PathsConfig, ProjectContext, WorkspacePackage } from './project.js';
import { toPosix } from './project.js';

export type Resolution =
  | { type: 'file'; id: string }
  | { type: 'package'; name: string }
  | { type: 'builtin'; name: string }
  | { type: 'asset'; path?: string }
  | { type: 'virtual' }
  | { type: 'unresolved' };

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro'];

const ASSET_RE =
  /\.(css|scss|sass|less|styl|pcss|postcss|svg|png|jpe?g|gif|webp|avif|ico|bmp|json|json5|md|mdx|html?|txt|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|wasm|graphql|gql|ya?ml|csv|toml|glsl|frag|vert|pdf)$/i;

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

const VIRTUAL_PREFIXES = [
  'virtual:',
  '~icons/',
  'astro:',
  '$app/',
  '$env/',
  '$service-worker',
  '#app',
  '#imports',
  '#components',
  '#build',
  '#internal',
  '#vue-router',
  'nuxt/schema',
  'bun:',
  'cloudflare:',
  'data:',
  'http:',
  'https:',
];

const DEFAULT_ALIASES: [prefix: string, targets: string[]][] = [
  ['@/', ['src/', 'app/', '']],
  ['~/', ['src/', 'app/', '']],
  ['~~/', ['']],
  ['@@/', ['']],
  ['#/', ['src/', '']],
  ['$lib/', ['src/lib/']],
  ['src/', ['src/']],
];

export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

export class ModuleResolver {
  private readonly cache = new Map<string, Resolution>();
  private readonly tsconfigByDir = new Map<string, PathsConfig[]>();
  private readonly workspaceByName = new Map<string, WorkspacePackage>();

  constructor(
    private readonly ctx: ProjectContext,
    private readonly files: Set<string>,
  ) {
    for (const w of ctx.workspaces) this.workspaceByName.set(w.name, w);
  }

  resolve(fromId: string, rawSpecifier: string): Resolution {
    const fromDir = path.posix.dirname(fromId);
    const key = `${fromDir}\0${rawSpecifier}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result = this.resolveUncached(fromId, fromDir, rawSpecifier);
    this.cache.set(key, result);
    return result;
  }

  private resolveUncached(fromId: string, fromDir: string, rawSpecifier: string): Resolution {
    // Strip loaders / query strings: `./x.svg?react`, `!!raw-loader!./file`
    const specifier = rawSpecifier.replace(/^.*!/, '').replace(/[?#].*$/, '');
    if (!specifier) return { type: 'unresolved' };
    if (specifier.startsWith('node:')) return { type: 'builtin', name: specifier.slice(5).split('/')[0] };
    if (VIRTUAL_PREFIXES.some((p) => specifier.startsWith(p))) return { type: 'virtual' };
    // SvelteKit generated route types (`./$types`)
    if (/(^|\/)\$types$/.test(specifier)) return { type: 'virtual' };

    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = specifier.startsWith('/')
        ? path.posix.normalize(specifier.slice(1))
        : path.posix.normalize(path.posix.join(fromDir, specifier));
      const hit = this.lookup(base);
      if (hit) return { type: 'file', id: hit };
      if (ASSET_RE.test(specifier)) return { type: 'asset', path: base.startsWith('..') ? undefined : base };
      return { type: 'unresolved' };
    }

    // tsconfig `paths` and `baseUrl`
    const configs = this.configsFor(fromId);
    for (const cfg of configs) {
      const hit = this.matchPaths(cfg, specifier);
      if (hit) return hit;
    }

    // Workspace packages (monorepos)
    const pkgName = packageNameOf(specifier);
    const workspace = this.workspaceByName.get(pkgName);
    if (workspace) {
      const hit = this.resolveWorkspace(workspace, specifier.slice(pkgName.length).replace(/^\//, ''));
      if (hit) return { type: 'file', id: hit };
      return { type: 'package', name: pkgName };
    }

    // Bundler aliases (vite / webpack / nuxt) and common conventions such as `@/` and `~/`
    for (const [alias, targets] of this.ctx.aliases) {
      if (specifier === alias || specifier.startsWith(`${alias}/`)) {
        const rest = specifier.slice(alias.length).replace(/^\//, '');
        for (const target of targets) {
          const hit = this.lookup(path.posix.normalize(path.posix.join(this.relRoot(target), rest)));
          if (hit) return { type: 'file', id: hit };
          if (ASSET_RE.test(rest)) return { type: 'asset', path: path.posix.join(target, rest) };
        }
      }
    }
    for (const [prefix, targets] of DEFAULT_ALIASES) {
      if (!specifier.startsWith(prefix)) continue;
      const rest = specifier.slice(prefix.length);
      for (const target of targets) {
        const hit = this.lookup(path.posix.normalize(target + rest));
        if (hit) return { type: 'file', id: hit };
      }
      if (ASSET_RE.test(rest)) return { type: 'asset' };
      if (prefix !== 'src/') return { type: 'unresolved' };
    }

    if (BUILTINS.has(pkgName) || BUILTINS.has(specifier)) return { type: 'builtin', name: pkgName };
    if (ASSET_RE.test(specifier) && !this.ctx.declared.has(pkgName)) return { type: 'asset' };
    if (/^[a-z0-9@][\w.\-/@]*$/i.test(specifier)) return { type: 'package', name: pkgName };
    return { type: 'unresolved' };
  }

  /** Convert a path relative to the project root, allowing absolute alias targets. */
  private relRoot(target: string): string {
    if (path.isAbsolute(target)) return toPosix(path.relative(this.ctx.root, target));
    return target;
  }

  /** Find a project file for a project-relative path, trying extensions and index files. */
  lookup(base: string): string | undefined {
    if (!base || base.startsWith('..')) return undefined;
    const clean = base === '.' ? '' : base.replace(/\/$/, '');
    if (clean && this.files.has(clean)) return clean;
    const prefix = clean ? `${clean}` : '';
    for (const ext of SOURCE_EXTENSIONS) if (this.files.has(prefix + ext)) return prefix + ext;
    const indexBase = clean ? `${clean}/index` : 'index';
    for (const ext of SOURCE_EXTENSIONS) if (this.files.has(indexBase + ext)) return indexBase + ext;
    // TypeScript ESM style: `./foo.js` → `./foo.ts`
    const m = clean.match(/^(.*)\.(m|c)?jsx?$/);
    if (m) {
      const stem = m[1];
      const variants = m[2] === 'm' ? ['.mts', '.ts'] : m[2] === 'c' ? ['.cts', '.ts'] : ['.ts', '.tsx'];
      for (const ext of variants) if (this.files.has(stem + ext)) return stem + ext;
    }
    return undefined;
  }

  private configsFor(fromId: string): PathsConfig[] {
    const absDir = path.join(this.ctx.root, path.dirname(fromId));
    const cached = this.tsconfigByDir.get(absDir);
    if (cached) return cached;
    // Nearest tsconfig directory wins; configs in the same directory are merged (tsconfig.app.json etc.).
    let best: PathsConfig[] = [];
    let bestLen = -1;
    for (const cfg of this.ctx.tsconfigs) {
      const rel = path.relative(cfg.dir, absDir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (cfg.dir.length > bestLen) {
        best = [cfg];
        bestLen = cfg.dir.length;
      } else if (cfg.dir.length === bestLen) {
        best.push(cfg);
      }
    }
    // Fall back to root configs (a referenced tsconfig.app.json may hold the paths).
    const rootConfigs = this.ctx.tsconfigs.filter((c) => c.dir === this.ctx.root);
    const merged = [...best, ...rootConfigs.filter((c) => !best.includes(c))].filter((c) => Object.keys(c.paths).length || c.baseUrl);
    this.tsconfigByDir.set(absDir, merged);
    return merged;
  }

  private matchPaths(cfg: PathsConfig, specifier: string): Resolution | undefined {
    let bestPattern: string | undefined;
    let bestCapture = '';
    let bestPrefixLen = -1;
    for (const pattern of Object.keys(cfg.paths)) {
      const star = pattern.indexOf('*');
      if (star === -1) {
        if (pattern === specifier && pattern.length > bestPrefixLen) {
          bestPattern = pattern;
          bestCapture = '';
          bestPrefixLen = pattern.length;
        }
        continue;
      }
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length && prefix.length > bestPrefixLen) {
        bestPattern = pattern;
        bestCapture = specifier.slice(prefix.length, specifier.length - suffix.length);
        bestPrefixLen = prefix.length;
      }
    }
    if (bestPattern !== undefined) {
      for (const target of cfg.paths[bestPattern]) {
        const abs = path.resolve(cfg.pathsBase, target.replace('*', bestCapture));
        const rel = toPosix(path.relative(this.ctx.root, abs));
        const hit = this.lookup(rel);
        if (hit) return { type: 'file', id: hit };
        if (ASSET_RE.test(rel)) return { type: 'asset', path: rel };
      }
    }
    if (cfg.baseUrl) {
      const rel = toPosix(path.relative(this.ctx.root, path.resolve(cfg.baseUrl, specifier)));
      const hit = this.lookup(rel);
      if (hit) return { type: 'file', id: hit };
    }
    return undefined;
  }

  private resolveWorkspace(workspace: WorkspacePackage, subpath: string): string | undefined {
    const dir = workspace.dir;
    if (subpath) {
      return this.lookup(path.posix.join(dir, subpath)) ?? this.lookup(path.posix.join(dir, 'src', subpath));
    }
    const pkg = workspace.pkg;
    const fields: unknown[] = [pkg.source, pkg.module, pkg.main, pkg.types];
    const exp = pkg.exports;
    if (typeof exp === 'string') fields.unshift(exp);
    else if (exp && typeof exp === 'object') {
      const dot = (exp as Record<string, unknown>)['.'] ?? exp;
      if (typeof dot === 'string') fields.unshift(dot);
      else if (dot && typeof dot === 'object') {
        for (const cond of ['source', 'development', 'import', 'module', 'default', 'require', 'types']) {
          const v = (dot as Record<string, unknown>)[cond];
          if (typeof v === 'string') fields.push(v);
          else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).default === 'string') {
            fields.push((v as Record<string, unknown>).default);
          }
        }
      }
    }
    for (const field of fields) {
      if (typeof field !== 'string') continue;
      const rel = path.posix.normalize(path.posix.join(dir, field));
      const direct = this.lookup(rel.replace(/\.d\.ts$/, ''));
      if (direct) return direct;
      // dist/index.js → src/index.ts
      const mapped = rel.replace(new RegExp(`^${escapeRe(dir)}/(dist|build|lib|out|esm|cjs)/`), `${dir}/src/`).replace(/\.(d\.ts|[cm]?js)$/, '');
      const hit = this.lookup(mapped);
      if (hit) return hit;
    }
    return this.lookup(path.posix.join(dir, 'src/index')) ?? this.lookup(path.posix.join(dir, 'index'));
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
