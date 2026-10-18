/**
 * Matching URLs against route paths (`/api/users/:id`, `/users/[id]`, `/files/[...slug]`, `{id}`, `$id`).
 * Pure, so the analyzer's API map, route queries (`code-visualizer route`), MCP and the report UI agree.
 */
import type { ApiCall, RouteInfo, UrlVisit } from './types.js';

/** Path segments of a route or URL path, without query string, hash and trailing slash. */
export function segments(p: string): string[] {
  return p
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
}

export const isParam = (s: string): boolean => s.startsWith(':') || /^\[[^\].]+\]$/.test(s) || /^\{.+\}$/.test(s) || /^\$\w+$/.test(s);
export const isCatchAll = (s: string): boolean => s === '*' || /^\[\[?\.\.\..+\]\]?$/.test(s) || /^:\w+\*$/.test(s);

export interface SegmentMatch {
  /** Higher is better, 0 = no match. */
  score: number;
  /** How many literal (non-parameter) segments matched. */
  literals: number;
}

const NO_MATCH: SegmentMatch = { score: 0, literals: 0 };

/** How well a call path matches a route path. */
export function match(route: string[], call: string[]): SegmentMatch {
  let score = 1;
  let literals = 0;
  for (let i = 0; i < route.length; i++) {
    const r = route[i];
    if (isCatchAll(r)) return { score: score + 0.5, literals };
    const c = call[i];
    if (c === undefined) return NO_MATCH;
    if (isParam(r)) {
      score += 1;
      continue;
    }
    if (c === ':param' || c.startsWith(':')) return NO_MATCH; // dynamic call segment vs a literal route segment
    if (r.toLowerCase() !== c.toLowerCase()) return NO_MATCH;
    score += 3;
    literals++;
  }
  return route.length === call.length ? { score, literals } : NO_MATCH;
}

/** Path part of a call URL, or undefined for calls to other hosts. */
export function localPath(url: string): string | undefined {
  const abs = url.match(/^https?:\/\/([^/:]+)(?::\d+)?(\/.*)?$/);
  if (!abs) return url;
  const host = abs[1];
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith(':param') ? (abs[2] ?? '/') : undefined;
}

/** Host of an absolute URL to another service (undefined for relative and local URLs). */
export function externalHost(url: string): string | undefined {
  const abs = url.match(/^https?:\/\/([^/:]+)(?::\d+)?(\/.*)?$/);
  if (!abs) return undefined;
  const host = abs[1];
  return host === 'localhost' || host === '127.0.0.1' || host.startsWith(':param') ? undefined : host;
}

export interface RouteScoreOptions {
  /** Let page routes match (the API map only does that for supertest-style test clients). */
  pages?: boolean;
  /** Any method matches (a URL looked up without a method). */
  anyMethod?: boolean;
}

/**
 * How well a request (`method` + path segments) matches a route: 0 = no match. An exact match beats a
 * base-URL suffix match (a client calling `/users` served by `/api/users`), which scores half and needs
 * at least one literal segment, so `/about` never matches `/api/users/:id` through a parameter.
 */
export function routeScore(route: Pick<RouteInfo, 'method' | 'type'>, routeSegs: string[], method: string, callSegs: string[], options: RouteScoreOptions = {}): number {
  if (route.type !== 'api' && route.type !== 'page') return 0;
  if (route.type === 'page' && !options.pages) return 0;
  const m = route.method;
  if (!options.anyMethod && m !== 'ALL' && m !== 'USE' && m !== 'PAGE' && m !== method) return 0;
  const exact = match(routeSegs, callSegs).score;
  if (exact) return exact;
  if (callSegs.length && routeSegs.length > callSegs.length) {
    const suffix = match(routeSegs.slice(routeSegs.length - callSegs.length), callSegs);
    if (suffix.literals > 0) return suffix.score * 0.5;
  }
  return 0;
}

/** Whether `route` could serve an HTTP call (the matching rules of `linkApiCalls`, for a single route). */
export function callMatchesRoute(route: Pick<RouteInfo, 'method' | 'path' | 'type'>, call: Pick<ApiCall, 'method' | 'url' | 'client'>): boolean {
  const pathPart = localPath(call.url);
  if (pathPart === undefined) return false;
  return routeScore(route, segments(route.path), call.method, segments(pathPart), { pages: call.client === 'supertest' }) > 0;
}

/**
 * test-intelligence: whether a URL a test visits or requests (`page.goto`, `cy.visit`, `request(app).get`)
 * is served by `route` — exact path match only; visits are GETs and also match pages.
 */
export function visitMatchesRoute(route: Pick<RouteInfo, 'method' | 'path' | 'type'>, visit: Pick<UrlVisit, 'url' | 'method'>): boolean {
  if (route.type !== 'api' && route.type !== 'page') return false;
  const pathPart = localPath(visit.url);
  if (pathPart === undefined) return false;
  const method = (visit.method ?? 'GET').toUpperCase();
  if (route.type === 'page') {
    if (method !== 'GET') return false;
  } else if (!['ALL', 'USE', 'PAGE', method].includes(route.method)) return false;
  return match(segments(route.path), segments(pathPart)).score > 0;
}

/** `GET /api/users/:id` */
export function routeLabel(route: Pick<RouteInfo, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}
