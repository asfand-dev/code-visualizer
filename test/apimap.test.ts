import { describe, expect, it } from 'vitest';
import { linkApiCalls } from '../src/analyzer/apimap.js';
import { parseSource, type ParsedFile, type RawApiCall } from '../src/analyzer/parse.js';
import type { RouteInfo, SymbolInfo } from '../src/shared/types.js';

function route(method: string, path: string, overrides: Partial<RouteInfo> = {}): RouteInfo {
  const file = overrides.file ?? 'server.ts';
  return { id: `${file}:1:${method}:${path}`, method, path, file, framework: 'express', type: 'api', ...overrides };
}

const routes: RouteInfo[] = [
  route('GET', '/api/users'),
  route('POST', '/api/users'),
  route('GET', '/api/users/:id'),
  route('GET', '/api/users/me'),
  route('DELETE', '/api/users/[id]', { file: 'app/api/users/[id]/route.ts', framework: 'next-app' }),
  route('ALL', '/api/legacy', { file: 'pages/api/legacy.ts', framework: 'next-pages' }),
  route('GET', '/api/docs/[...slug]', { file: 'app/api/docs/[...slug]/route.ts', framework: 'next-app' }),
  route('GET', '/api/items/{id}'),
  route('PAGE', '/about', { type: 'page', file: 'app/about/page.tsx', framework: 'next-app' }),
  route('LAYOUT', '/', { type: 'layout', file: 'app/layout.tsx', framework: 'next-app' }),
];

/** Link one call and return the matched route signature (or undefined). */
function link(method: string, url: string, client = 'fetch'): { route?: string; external?: string } {
  const [call] = linkApiCalls([{ file: 'src/client.ts', symbols: [], raw: [{ method, url, client, line: 1 }] }], routes);
  const r = routes.find((x) => x.id === call.route);
  return { route: r ? `${r.method} ${r.path}` : undefined, external: call.external };
}

describe('linkApiCalls: matching calls to routes', () => {
  it('matches exact paths and respects the HTTP method', () => {
    expect(link('GET', '/api/users').route).toBe('GET /api/users');
    expect(link('POST', '/api/users').route).toBe('POST /api/users');
    expect(link('PATCH', '/api/users').route).toBeUndefined();
  });

  it('ignores query strings, hashes, trailing slashes and letter case', () => {
    expect(link('GET', '/api/users?limit=10&page=:param').route).toBe('GET /api/users');
    expect(link('GET', '/api/users/#top').route).toBe('GET /api/users');
    expect(link('GET', '/API/Users').route).toBe('GET /api/users');
  });

  it('matches dynamic segments in every route syntax (:id, [id], [...slug], {id})', () => {
    expect(link('GET', '/api/users/42').route).toBe('GET /api/users/:id');
    expect(link('GET', '/api/users/:param').route).toBe('GET /api/users/:id');
    expect(link('DELETE', '/api/users/:param').route).toBe('DELETE /api/users/[id]');
    expect(link('GET', '/api/docs/guides/setup/linux').route).toBe('GET /api/docs/[...slug]');
    expect(link('GET', '/api/items/7').route).toBe('GET /api/items/{id}');
  });

  it('prefers literal segments over parameters, and never matches a dynamic call against a literal route', () => {
    expect(link('GET', '/api/users/me').route).toBe('GET /api/users/me');
    // `/api/users/${x}` could be anything, but not specifically "/api/users/me"
    expect(link('GET', '/api/users/:param').route).not.toBe('GET /api/users/me');
  });

  it('lets ALL routes (pages-router API, Express app.all) serve every method', () => {
    expect(link('PUT', '/api/legacy').route).toBe('ALL /api/legacy');
  });

  it('matches clients with a base URL by path suffix ("/users" → "/api/users")', () => {
    expect(link('GET', '/users', 'api').route).toBe('GET /api/users');
    expect(link('GET', '/users/:param', 'api').route).toBe('GET /api/users/:id');
    expect(link('POST', '/users', 'api').route).toBe('POST /api/users');
  });

  it('records external hosts and treats localhost URLs as same-origin', () => {
    expect(link('POST', 'https://api.stripe.com/v1/charges')).toEqual({ route: undefined, external: 'api.stripe.com' });
    expect(link('GET', 'https://api.github.com/api/users')).toEqual({ route: undefined, external: 'api.github.com' });
    expect(link('GET', 'http://localhost:3000/api/users')).toEqual({ route: 'GET /api/users', external: undefined });
    expect(link('GET', 'http://127.0.0.1/api/users').route).toBe('GET /api/users');
  });

  it('only matches pages for supertest-style requests and never matches layouts', () => {
    expect(link('GET', '/about', 'supertest').route).toBe('PAGE /about');
    expect(link('GET', '/about').route).not.toBe('PAGE /about');
    expect(link('GET', '/', 'supertest').route).toBeUndefined();
  });

  it('does not base-URL-match a call whose only overlap with the route is a trailing parameter', () => {
    // Neither call has anything to do with `GET /api/users/:id` (or the `[...slug]` catch-all).
    expect(link('GET', '/about').route).toBeUndefined();
    expect(link('GET', '/logout', 'api').route).toBeUndefined();
  });

  it('leaves unknown endpoints unmatched', () => {
    expect(link('GET', '/api/reports/export')).toEqual({ route: undefined, external: undefined });
    expect(link('GET', '/').route).toBeUndefined();
  });

  it('builds stable ids and attaches the innermost enclosing symbol', () => {
    const sym = (name: string, line: number, endLine: number): SymbolInfo => ({ id: `src/client.ts#${name}`, name, kind: 'function', line, endLine, exported: true, loc: endLine - line + 1 });
    const raw: RawApiCall[] = [
      { method: 'GET', url: '/api/users', client: 'fetch', line: 5 },
      { method: 'GET', url: '/api/users', client: 'fetch', line: 20 },
      { method: 'POST', url: '/api/users', client: 'axios', line: 40 },
    ];
    const calls = linkApiCalls([{ file: 'src/client.ts', symbols: [sym('outer', 1, 30), sym('inner', 18, 22)], raw }], routes);
    expect(calls.map((c) => [c.id, c.symbol, c.client])).toEqual([
      ['src/client.ts:5:0', 'src/client.ts#outer', 'fetch'],
      ['src/client.ts:20:1', 'src/client.ts#inner', 'fetch'],
      ['src/client.ts:40:2', undefined, 'axios'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */

function parse(text: string, id = 'src/client.ts'): ParsedFile {
  const parsed = parseSource(id, text, id.slice(id.lastIndexOf('.')));
  expect(parsed.parseError).toBeUndefined();
  return parsed;
}

const calls = (p: ParsedFile): string[] => p.apiCalls.map((c) => `${c.client} ${c.method} ${c.url}`);

describe('parse: HTTP calls', () => {
  it('detects fetch, $fetch, ofetch, useFetch and useSWR (incl. key arrays) with the method from options', () => {
    const p = parse(`
      export async function load(id: string) {
        await fetch('/api/users');
        await fetch(\`/api/users/\${id}\`, { method: 'delete' });
        await $fetch('/api/cart', { method: 'POST', body: {} });
        await ofetch('/api/ping');
        const { data } = useFetch('/api/todos');
        useSWR('/api/me', fetcher);
        useSWR(['/api/orders', id], fetcher);
        return data;
      }
    `);
    expect(calls(p)).toEqual([
      'fetch GET /api/users',
      'fetch DELETE /api/users/:param',
      '$fetch POST /api/cart',
      'ofetch GET /api/ping',
      'useFetch GET /api/todos',
      'useSWR GET /api/me',
      'useSWR GET /api/orders',
    ]);
    expect(p.apiCalls[0].line).toBe(3);
  });

  it('detects axios, axios instances and custom API clients', () => {
    const p = parse(`
      import axios from 'axios';
      import { api } from './api';
      const http = axios.create({ baseURL: '/api' });
      export const client = {
        list: () => axios.get('/api/users'),
        create: (u: unknown) => axios.post('/api/users', u),
        remove: (id: string) => axios({ url: \`/api/users/\${id}\`, method: 'delete' }),
        raw: () => axios('/api/raw'),
        mine: () => http.patch('/me', {}),
        orders: () => api.get('/orders'),
        req: () => api.request({ url: '/reports', method: 'put' }),
      };
    `);
    expect(calls(p)).toEqual([
      'axios GET /api/users',
      'axios POST /api/users',
      'axios DELETE /api/users/:param',
      'axios GET /api/raw',
      'http PATCH /me',
      'api GET /orders',
      'api PUT /reports',
    ]);
  });

  it('detects Angular HttpClient calls on this.http', () => {
    const p = parse(
      `
      export class UserService {
        constructor(private http: HttpClient) {}
        list() { return this.http.get<User[]>('/api/users'); }
        save(u: User) { return this.http.put(\`/api/users/\${u.id}\`, u); }
      }
    `,
      'src/user.service.ts',
    );
    expect(calls(p)).toEqual(['http GET /api/users', 'http PUT /api/users/:param']);
  });

  it('detects supertest requests in tests', () => {
    const p = parse(
      `
      import request from 'supertest';
      import { app } from '../src/app';
      it('works', async () => {
        await request(app).get('/api/users').expect(200);
        await request(app).post('/api/users').send({ name: 'x' });
      });
    `,
      'test/users.test.ts',
    );
    expect(calls(p)).toEqual(['supertest GET /api/users', 'supertest POST /api/users']);
  });

  it('turns template and concatenated URLs into :param and drops unknown bases', () => {
    const p = parse(`
      const BASE = process.env.API_URL;
      export const go = (id: string, q: string) => {
        fetch('/api/users/' + id + '/posts');
        fetch(\`\${BASE}/users/\${id}\`);
        fetch(\`/api/search?q=\${q}\`);
      };
    `);
    expect(calls(p)).toEqual(['fetch GET /api/users/:param/posts', 'fetch GET /users/:param', 'fetch GET /api/search?q=:param']);
  });

  it('ignores calls whose URL is not a path or absolute URL', () => {
    const p = parse(`
      export function f(u: string) {
        fetch(u);
        fetch('relative/path');
        cache.get('/not-an-http-client');
        map.get('/api/users');
        api.create('/api/users');
      }
    `);
    expect(calls(p)).toEqual([]);
  });

  it('does not treat Express route definitions as requests', () => {
    const p = parse(
      `
      import express from 'express';
      const api = express.Router();
      api.get('/users', (req, res) => res.json([]));
      export default api;
    `,
      'src/routes.ts',
    );
    expect(p.apiCalls).toEqual([]);
    expect(p.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /users']);
  });

  it('keeps absolute URLs as they are', () => {
    const p = parse("export const charge = () => fetch('https://api.stripe.com/v1/charges', { method: 'POST' });");
    expect(p.apiCalls).toEqual([{ method: 'POST', url: 'https://api.stripe.com/v1/charges', client: 'fetch', line: 1 }]);
  });
});

describe('parse: @deprecated', () => {
  it('records the deprecation note of functions, constants, classes and types', () => {
    const p = parse(`
      /**
       * Old helper.
       * @deprecated Use newHelper() instead.
       */
      export function oldHelper() {}

      /** @deprecated */
      export const LEGACY_LIMIT = 10;

      /** @deprecated Prefer the Store class. */
      export class OldStore {}

      /** @deprecated */
      export type OldId = string;

      /** Still fine. */
      export function newHelper() {}
    `);
    const byName = Object.fromEntries(p.symbols.map((s) => [s.name, s.deprecated]));
    expect(byName).toEqual({ oldHelper: 'Use newHelper() instead.', LEGACY_LIMIT: '', OldStore: 'Prefer the Store class.', OldId: '', newHelper: undefined });
  });
});
