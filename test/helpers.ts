import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import type {
  DependencyEdge,
  FileInfo,
  ReportData,
  RouteInfo,
  SymbolEdgeKind,
  SymbolInfo,
} from '../src/shared/types.js';

export type FixtureName = 'react-vite-ts' | 'next-app' | 'express-api' | 'vue-app' | 'nest-api' | 'sveltekit-app';

export function fixturePath(name: FixtureName): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const cache = new Map<FixtureName, Promise<ReportData>>();

/** Analyze a fixture once per test run (each test file shares the result). */
export function analyzeFixture(name: FixtureName): Promise<ReportData> {
  let pending = cache.get(name);
  if (!pending) {
    pending = analyze({ root: fixturePath(name), git: false, includeSource: false });
    cache.set(name, pending);
  }
  return pending;
}

export function getFile(data: ReportData, id: string): FileInfo {
  const file = data.files.find((f) => f.id === id);
  if (!file) throw new Error(`File "${id}" not in report. Files: ${data.files.map((f) => f.id).join(', ')}`);
  return file;
}

export function getSymbol(data: ReportData, symbolId: string): SymbolInfo {
  const fileId = symbolId.slice(0, symbolId.indexOf('#'));
  const symbol = getFile(data, fileId).symbols.find((s) => s.id === symbolId);
  if (!symbol) {
    const ids = getFile(data, fileId).symbols.map((s) => s.id);
    throw new Error(`Symbol "${symbolId}" not found. Symbols in file: ${ids.join(', ')}`);
  }
  return symbol;
}

/** The default-exported component of an SFC / module. */
export function defaultComponent(data: ReportData, fileId: string): SymbolInfo {
  const symbol = getFile(data, fileId).symbols.find((s) => s.isDefault && s.kind === 'component');
  if (!symbol) throw new Error(`No default component in ${fileId}`);
  return symbol;
}

export function findEdge(data: ReportData, source: string, target: string): DependencyEdge | undefined {
  return data.edges.find((e) => e.source === source && e.target === target);
}

export function expectEdge(data: ReportData, source: string, target: string, kind?: DependencyEdge['kind']): DependencyEdge {
  const edge = findEdge(data, source, target);
  expect(edge, `expected dependency edge ${source} -> ${target}`).toBeDefined();
  if (kind) expect(edge!.kind).toBe(kind);
  return edge!;
}

export function hasSymbolEdge(data: ReportData, kind: SymbolEdgeKind, source: string, target: string): boolean {
  return data.symbolEdges.some((e) => e.kind === kind && e.source === source && e.target === target);
}

export function symbolEdgesOf(data: ReportData, source: string, kind?: SymbolEdgeKind): string[] {
  return data.symbolEdges.filter((e) => e.source === source && (!kind || e.kind === kind)).map((e) => `${e.kind}:${e.target}`);
}

export function expectSymbolEdge(data: ReportData, kind: SymbolEdgeKind, source: string, target: string): void {
  expect(
    hasSymbolEdge(data, kind, source, target),
    `expected ${kind} edge ${source} -> ${target}; edges from source: ${JSON.stringify(symbolEdgesOf(data, source))}`,
  ).toBe(true);
}

export function findRoutes(data: ReportData, method: string, path: string): RouteInfo[] {
  return data.routes.filter((r) => r.method === method && r.path === path);
}

export function expectRoute(data: ReportData, method: string, path: string, match: Partial<RouteInfo> = {}): RouteInfo {
  const candidates = findRoutes(data, method, path);
  const listing = data.routes.map((r) => `${r.method} ${r.path} (${r.file})`).join('\n');
  expect(candidates.length, `expected route ${method} ${path}; routes:\n${listing}`).toBeGreaterThan(0);
  const hit = candidates.find((r) => Object.entries(match).every(([k, v]) => JSON.stringify(r[k as keyof RouteInfo]) === JSON.stringify(v)));
  expect(hit ?? candidates[0], `route ${method} ${path}`).toMatchObject(match);
  return hit ?? candidates[0];
}

export function routeSignatures(data: ReportData, filter: (r: RouteInfo) => boolean = () => true): string[] {
  return data.routes.filter(filter).map((r) => `${r.method} ${r.path}`);
}
