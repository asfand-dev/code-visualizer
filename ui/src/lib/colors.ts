import type { FileKind, SymbolKind } from '../types';

export const KIND_META: Record<FileKind, { label: string; color: string; shape: string; group: string }> = {
  entry: { label: 'Entry point', color: '#f43f5e', shape: 'star', group: 'App' },
  page: { label: 'Page', color: '#8b5cf6', shape: 'round-rectangle', group: 'App' },
  layout: { label: 'Layout', color: '#a78bfa', shape: 'round-rectangle', group: 'App' },
  route: { label: 'API route', color: '#ec4899', shape: 'round-tag', group: 'App' },
  component: { label: 'Component', color: '#3b82f6', shape: 'ellipse', group: 'UI' },
  hook: { label: 'Hook', color: '#06b6d4', shape: 'diamond', group: 'UI' },
  composable: { label: 'Composable', color: '#22d3ee', shape: 'diamond', group: 'UI' },
  context: { label: 'Context', color: '#0ea5e9', shape: 'barrel', group: 'State' },
  store: { label: 'Store', color: '#f59e0b', shape: 'barrel', group: 'State' },
  service: { label: 'Service', color: '#10b981', shape: 'round-hexagon', group: 'Logic' },
  api: { label: 'API client', color: '#14b8a6', shape: 'round-hexagon', group: 'Logic' },
  controller: { label: 'Controller', color: '#84cc16', shape: 'round-hexagon', group: 'Server' },
  middleware: { label: 'Middleware', color: '#eab308', shape: 'round-octagon', group: 'Server' },
  router: { label: 'Router', color: '#d946ef', shape: 'round-hexagon', group: 'Server' },
  model: { label: 'Model', color: '#f97316', shape: 'round-pentagon', group: 'Data' },
  types: { label: 'Types', color: '#6366f1', shape: 'round-pentagon', group: 'Data' },
  constants: { label: 'Constants', color: '#94a3b8', shape: 'ellipse', group: 'Data' },
  util: { label: 'Utility', color: '#64748b', shape: 'ellipse', group: 'Shared' },
  config: { label: 'Config', color: '#a8a29e', shape: 'round-rectangle', group: 'Tooling' },
  script: { label: 'Script', color: '#a3a3a3', shape: 'round-rectangle', group: 'Tooling' },
  test: { label: 'Test', color: '#22c55e', shape: 'ellipse', group: 'Tooling' },
  story: { label: 'Story', color: '#e879f9', shape: 'ellipse', group: 'Tooling' },
  module: { label: 'Module', color: '#7c8aa5', shape: 'ellipse', group: 'Shared' },
};

export const SYMBOL_META: Record<SymbolKind | 'method', { label: string; color: string; letter: string }> = {
  component: { label: 'Component', color: '#3b82f6', letter: '⚛' },
  hook: { label: 'Hook', color: '#06b6d4', letter: 'H' },
  function: { label: 'Function', color: '#10b981', letter: 'ƒ' },
  method: { label: 'Method', color: '#34d399', letter: 'm' },
  class: { label: 'Class', color: '#f97316', letter: 'C' },
  interface: { label: 'Interface', color: '#6366f1', letter: 'I' },
  type: { label: 'Type', color: '#8b5cf6', letter: 'T' },
  enum: { label: 'Enum', color: '#14b8a6', letter: 'E' },
  constant: { label: 'Constant', color: '#94a3b8', letter: 'K' },
  variable: { label: 'Variable', color: '#7c8aa5', letter: 'V' },
  namespace: { label: 'Namespace', color: '#ec4899', letter: 'N' },
};

export const METHOD_COLORS: Record<string, string> = {
  GET: '#22c55e',
  POST: '#3b82f6',
  PUT: '#f97316',
  PATCH: '#eab308',
  DELETE: '#ef4444',
  HEAD: '#94a3b8',
  OPTIONS: '#94a3b8',
  ALL: '#06b6d4',
  USE: '#7c8aa5',
  MIDDLEWARE: '#7c8aa5',
  PAGE: '#8b5cf6',
  LAYOUT: '#a78bfa',
  REDIRECT: '#64748b',
  QUERY: '#ec4899',
  MUTATION: '#f43f5e',
  SUBSCRIPTION: '#d946ef',
};

export const FRAMEWORK_CATEGORY_COLORS: Record<string, string> = {
  fullstack: '#8b5cf6',
  frontend: '#3b82f6',
  backend: '#10b981',
  mobile: '#f97316',
  desktop: '#f59e0b',
  state: '#ec4899',
  data: '#14b8a6',
  styling: '#d946ef',
  testing: '#22c55e',
  build: '#94a3b8',
  language: '#6366f1',
};

export const LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f7df1e',
  vue: '#42b883',
  svelte: '#ff3e00',
  astro: '#bc52ee',
};

export const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
};

/** Categorical palette for folders / groups (works on dark and light backgrounds). */
export const CATEGORICAL = [
  '#8b6dff',
  '#22d3ee',
  '#f472b6',
  '#34d399',
  '#fbbf24',
  '#60a5fa',
  '#fb7185',
  '#a3e635',
  '#c084fc',
  '#2dd4bf',
  '#fb923c',
  '#818cf8',
];

export function categorical(index: number): string {
  return CATEGORICAL[((index % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length];
}

const hashCache = new Map<string, number>();
export function hashString(value: string): number {
  let cached = hashCache.get(value);
  if (cached !== undefined) return cached;
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  cached = Math.abs(h);
  hashCache.set(value, cached);
  return cached;
}

function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Sequential "heat" scale: calm cyan → violet → hot rose. */
export function heat(t: number): string {
  const v = Math.max(0, Math.min(1, t));
  if (v < 0.5) return mix('#22d3ee', '#8b6dff', v * 2);
  return mix('#8b6dff', '#f43f5e', (v - 0.5) * 2);
}

/** Freshness scale: recently changed (green) → old (slate). */
export function freshness(t: number): string {
  return mix('#34d399', '#64748b', Math.max(0, Math.min(1, t)));
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
