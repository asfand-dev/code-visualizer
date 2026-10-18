import path from 'node:path';
import type { RouteFramework, RouteType } from '../shared/types.js';
import type { ProjectContext } from './project.js';
import { hasFramework } from './project.js';

export type FileRole = 'page' | 'layout' | 'route' | 'middleware';

export interface FileRoute {
  file: string;
  method: string;
  path: string;
  type: RouteType;
  framework: RouteFramework;
  params: string[];
}

export interface FileRoutesResult {
  routes: FileRoute[];
  roles: Map<string, FileRole>;
}

const HTTP_EXPORTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function paramsOf(routePath: string): string[] {
  const params: string[] = [];
  for (const m of routePath.matchAll(/\[\[?(?:\.\.\.)?([^\]]+)\]?\]|:(\w+)|\$(\w+)/g)) params.push(m[1] ?? m[2] ?? m[3]);
  return params;
}

function cleanSegments(segments: string[]): string[] {
  return segments.filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@') && !s.startsWith('_'));
}

function toPath(segments: string[]): string {
  const clean = segments.filter(Boolean);
  return `/${clean.join('/')}`;
}

/** Directories that contain a given config file (e.g. next.config.js) — the roots of framework apps. */
function rootsWith(ids: string[], pattern: RegExp, includeProjectRoot: boolean): string[] {
  const roots = new Set<string>();
  for (const id of ids) {
    const base = path.posix.basename(id);
    if (pattern.test(base)) {
      const dir = path.posix.dirname(id);
      roots.add(dir === '.' ? '' : `${dir}/`);
    }
  }
  if (includeProjectRoot) roots.add('');
  return [...roots];
}

export function detectFileRoutes(
  ids: string[],
  ctx: ProjectContext,
  exportsOf: (id: string) => string[],
): FileRoutesResult {
  const routes: FileRoute[] = [];
  const roles = new Map<string, FileRole>();
  const add = (file: string, method: string, routePath: string, type: RouteType, framework: RouteFramework): void => {
    routes.push({ file, method, path: routePath, type, framework, params: paramsOf(routePath) });
  };

  /* --------------------------------- Next.js -------------------------------- */
  if (hasFramework(ctx, 'next')) {
    const roots = rootsWith(ids, /^next\.config\.[cm]?[jt]s$/, true);
    for (const id of ids) {
      for (const root of roots) {
        if (!id.startsWith(root)) continue;
        const rel = id.slice(root.length);
        const app = rel.match(/^(?:src\/)?app\/(?:(.*)\/)?(page|layout|route|template|loading|error|not-found|default|global-error)\.(tsx|jsx|ts|js|mdx)$/);
        if (app) {
          const segments = cleanSegments((app[1] ?? '').split('/'));
          const routePath = toPath(segments);
          const kind = app[2];
          if (kind === 'page') {
            add(id, 'PAGE', routePath, 'page', 'next-app');
            roles.set(id, 'page');
          } else if (kind === 'layout') {
            add(id, 'LAYOUT', routePath, 'layout', 'next-app');
            roles.set(id, 'layout');
          } else if (kind === 'route') {
            const methods = exportsOf(id).filter((e) => HTTP_EXPORTS.includes(e));
            for (const method of methods.length ? methods : ['ALL']) add(id, method, routePath, 'api', 'next-app');
            roles.set(id, 'route');
          } else {
            roles.set(id, 'page');
          }
          break;
        }
        const pages = rel.match(/^(?:src\/)?pages\/(.*)\.(tsx|jsx|ts|js|mdx)$/);
        if (pages) {
          const raw = pages[1];
          const base = raw.split('/').pop() ?? '';
          if (base === '_document') {
            roles.set(id, 'layout');
            break;
          }
          if (base === '_app') {
            add(id, 'LAYOUT', '/', 'layout', 'next-pages');
            roles.set(id, 'layout');
            break;
          }
          const segments = raw.split('/').filter((s) => s !== 'index');
          const isApi = segments[0] === 'api';
          add(id, isApi ? 'ALL' : 'PAGE', toPath(segments), isApi ? 'api' : 'page', 'next-pages');
          roles.set(id, isApi ? 'route' : 'page');
          break;
        }
        if (/^(?:src\/)?middleware\.[jt]s$/.test(rel)) {
          add(id, 'MIDDLEWARE', '/', 'middleware', 'next-app');
          roles.set(id, 'middleware');
          break;
        }
      }
    }
  }

  /* ---------------------------------- Nuxt ---------------------------------- */
  if (hasFramework(ctx, 'nuxt')) {
    const roots = rootsWith(ids, /^nuxt\.config\.[cm]?[jt]s$/, true);
    for (const id of ids) {
      for (const root of roots) {
        if (!id.startsWith(root)) continue;
        const rel = id.slice(root.length).replace(/^app\//, '');
        const page = rel.match(/^pages\/(.*)\.vue$/);
        if (page) {
          const segments = page[1].split('/').filter((s) => s !== 'index');
          add(id, 'PAGE', toPath(cleanSegments(segments)), 'page', 'nuxt');
          roles.set(id, 'page');
          break;
        }
        if (/^layouts\/.*\.vue$/.test(rel) || rel === 'app.vue') {
          add(id, 'LAYOUT', '/', 'layout', 'nuxt');
          roles.set(id, 'layout');
          break;
        }
        const api = rel.match(/^server\/(api|routes)\/(.*)\.[jt]s$/);
        if (api) {
          let raw = api[2];
          let method = 'ALL';
          const verb = raw.match(/\.(get|post|put|patch|delete|head|options)$/);
          if (verb) {
            method = verb[1].toUpperCase();
            raw = raw.slice(0, -verb[0].length);
          }
          const segments = raw.split('/').filter((s) => s !== 'index');
          add(id, method, toPath([api[1] === 'api' ? 'api' : '', ...segments]), 'api', 'nuxt');
          roles.set(id, 'route');
          break;
        }
        if (/^(server\/)?middleware\/.*\.[jt]s$/.test(rel)) {
          add(id, 'MIDDLEWARE', '/', 'middleware', 'nuxt');
          roles.set(id, 'middleware');
          break;
        }
      }
    }
  }

  /* -------------------------------- SvelteKit ------------------------------- */
  if (hasFramework(ctx, 'sveltekit')) {
    for (const id of ids) {
      const m = id.match(/(?:^|\/)src\/routes\/(?:(.*)\/)?\+(page|layout|server|page\.server|layout\.server|page|error)\.(svelte|ts|js)$/);
      if (!m) continue;
      const segments = cleanSegments((m[1] ?? '').split('/'));
      const routePath = toPath(segments);
      const kind = m[2];
      if (kind === 'page' && m[3] === 'svelte') {
        add(id, 'PAGE', routePath, 'page', 'sveltekit');
        roles.set(id, 'page');
      } else if (kind === 'layout' && m[3] === 'svelte') {
        add(id, 'LAYOUT', routePath, 'layout', 'sveltekit');
        roles.set(id, 'layout');
      } else if (kind === 'server') {
        const methods = exportsOf(id).filter((e) => HTTP_EXPORTS.includes(e));
        for (const method of methods.length ? methods : ['ALL']) add(id, method, routePath, 'api', 'sveltekit');
        roles.set(id, 'route');
      } else {
        roles.set(id, 'page');
      }
    }
  }

  /* ------------------------ Remix / React Router (framework) ------------------------ */
  if (hasFramework(ctx, 'remix') || hasFramework(ctx, 'react-router-framework')) {
    for (const id of ids) {
      if (/(^|\/)app\/root\.(tsx|jsx|ts|js)$/.test(id)) {
        add(id, 'LAYOUT', '/', 'layout', 'remix');
        roles.set(id, 'layout');
        continue;
      }
      const m = id.match(/(?:^|\/)app\/routes\/(.+?)(?:\/route)?\.(tsx|jsx|ts|js)$/);
      if (!m) continue;
      const segments = m[1]
        .split(/[./]/)
        .filter((s) => s && s !== '_index' && s !== 'index' && s !== 'route')
        .map((s) => (s === '$' ? '*' : s.startsWith('$') ? `:${s.slice(1)}` : s.replace(/_$/, '')))
        .filter((s) => !s.startsWith('_'));
      const exported = exportsOf(id);
      const isResource = !exported.includes('default') && (exported.includes('loader') || exported.includes('action'));
      add(id, isResource ? 'ALL' : 'PAGE', toPath(segments), isResource ? 'api' : 'page', 'remix');
      roles.set(id, isResource ? 'route' : 'page');
    }
  }

  /* ---------------------------------- Astro --------------------------------- */
  if (hasFramework(ctx, 'astro')) {
    for (const id of ids) {
      const m = id.match(/(?:^|\/)src\/pages\/(.*)\.(astro|md|mdx|ts|js)$/);
      if (!m) continue;
      const segments = m[1].split('/').filter((s) => s !== 'index');
      const isEndpoint = m[2] === 'ts' || m[2] === 'js';
      if (isEndpoint) {
        const methods = exportsOf(id).filter((e) => HTTP_EXPORTS.includes(e) || e === 'ALL');
        for (const method of methods.length ? methods : ['GET']) add(id, method, toPath(segments), 'api', 'astro');
        roles.set(id, 'route');
      } else {
        add(id, 'PAGE', toPath(segments), 'page', 'astro');
        roles.set(id, 'page');
      }
    }
    for (const id of ids) if (/(?:^|\/)src\/layouts\/.*\.astro$/.test(id)) roles.set(id, 'layout');
  }

  return { routes, roles };
}
