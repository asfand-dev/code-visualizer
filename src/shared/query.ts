/**
 * Query core: answers to the reachability questions developers ask many times a day, over one
 * analysis — who knows this code, who uses a symbol and where exactly, what a change affects, how two
 * files are connected, which handler serves a URL and which tests to run.
 *
 * Pure (no Node APIs): the CLI (`who`, `uses`, `impact`, `path`, `route`, `tests-for`), the MCP server,
 * git hooks, `My changes` and the report UI all share these functions.
 */
import { isTestableSource, isTestEntry, buildTestCommand } from './testcmd.js';
import { match, routeLabel, routeScore, segments, isCatchAll, isParam, visitMatchesRoute } from './route-match.js';
import type {
  ApiCall,
  CallSite,
  ChangeSet,
  CommitRef,
  DependencyEdge,
  EdgeKind,
  FileInfo,
  MemberInfo,
  ReportData,
  RouteInfo,
  SymbolEdge,
  SymbolEdgeKind,
  SymbolInfo,
} from './types.js';

/** The parts of an analysis the queries read (a full `ReportData` works; so does a partial one built in the analyzer). */
export type QueryData = Pick<ReportData, 'files' | 'edges' | 'symbolEdges' | 'routes'> & Partial<Pick<ReportData, 'apiCalls' | 'folders' | 'project' | 'git'>>;

export type QueryTarget =
  | { type: 'file'; id: string }
  | { type: 'symbol'; id: string }
  | { type: 'route'; id: string }
  | { type: 'dir'; id: string };

export interface ResolveResult {
  target?: QueryTarget;
  /** "Did you mean" candidates when nothing matched (or several files did). */
  suggestions: string[];
  /** Other symbols with the same name when a bare name matched several (the best-ranked one was taken). */
  alternatives?: string[];
}

export interface Expert {
  name: string;
  email?: string;
  /** Commits weighted by recency: Σ commits × e^(−age in days / 180). */
  score: number;
  commits: number;
  /** Time of their latest commit to these files. */
  last: number;
  /** No commit to these files in the last 90 days. */
  inactive: boolean;
  /** Share of the total score (0..1). */
  share: number;
  /** The person running the analysis. */
  me?: boolean;
}

export interface WhoResult {
  target: QueryTarget;
  /** Number of analyzed files the answer is about. */
  files: number;
  /** CODEOWNERS owners, most files first. */
  owners: string[];
  experts: Expert[];
  /** How many people together made more than half of the (recency-weighted) changes. */
  busFactor?: number;
  /** The most recent commit touching these files. */
  lastCommit?: CommitRef & { file: string };
  /** Whether any of the files has git history in this analysis. */
  hasHistory: boolean;
}

/** A use of a target: a `CallSite` with what was imported, through which barrel, and which symbol it reaches. */
export interface UseSite extends CallSite {
  names?: string[];
  typeOnly?: boolean;
  /** The barrel file the import goes through (`export … from`). */
  via?: string;
  /** The symbol that is used (for file and class targets: which of their symbols). */
  target?: string;
  /** HTTP calls: the request method, URL and client (`fetch`, `axios`…). */
  method?: string;
  url?: string;
  client?: string;
}

export interface UsesResult {
  target: QueryTarget;
  /** Imports of the target (through barrels too), with the imported names and line. */
  imports: UseSite[];
  /** Exact call, render and `new` sites. */
  sites: UseSite[];
  /** Symbols that use it without a call site: type references, `extends` / `implements`. */
  refs: { symbol: string; file: string; kind: SymbolEdgeKind; target: string }[];
  /** HTTP requests to the routes the target handles. */
  http: UseSite[];
  /**
   * Imports of other exports that reach the target without naming it: a sibling export that calls it, the
   * class of a member. Not counted in `files`.
   */
  through: UseSite[];
  /** Distinct files that use the target (imports, sites, HTTP requests and references; not `through`). */
  files: number;
}

export interface ImpactResult {
  targets: QueryTarget[];
  /** `symbol`: only importers and callers of the changed symbols count; `file`: every importer of the files. */
  precision: 'symbol' | 'file';
  /** Why the answer is file-level although a symbol was asked about. */
  precisionNote?: string;
  /** Files that use the targets directly: how (imported names, `*`, or the HTTP route) and where. */
  direct: { file: string; via: string[]; sites: UseSite[] }[];
  /** Affected files by distance (1 = direct). */
  byDepth: { depth: number; files: string[] }[];
  routes: { id: string; label: string; file: string; line?: number }[];
  /** `untested`: target files no test reaches, and symbol targets (`file#name`) when no test reaches any of their users. */
  tests: { files: string[]; command?: string; untested: string[] };
  /** CODEOWNERS of the affected files, to notify. */
  owners: { owner: string; files: string[] }[];
  /** Affected files up to the requested depth. */
  total: number;
  /** Affected files beyond the requested depth (not listed). */
  truncated?: number;
}

export interface PathHop {
  source: string;
  target: string;
  line?: number;
  names: string[];
  typeOnly: boolean;
  kind?: EdgeKind;
}

export interface PathResult {
  hops: PathHop[];
  /** No chain leads from the first to the second file, so this is the chain the other way round. */
  reversed?: boolean;
}

export interface RouteMatch {
  route: RouteInfo;
  label: string;
  /** The URL matched the route path itself (not only a base-URL suffix of it). */
  exact: boolean;
  score: number;
  handler?: { file: string; line?: number; symbol?: string };
  middlewares: string[];
  /** Middleware registered for a path prefix (`app.use(auth)`, Next.js middleware) that also runs; `onError`: an error handler. */
  appMiddlewares: { label: string; file: string; line?: number; onError?: boolean }[];
  /** Code in the project that requests this route. */
  callers: UseSite[];
  /** Tests that reach the handler, or request the route. */
  tests: string[];
}

export interface TestsForResult {
  /** Test files that exercise the given code (through imports or HTTP requests), and given tests themselves. */
  files: string[];
  command?: string;
  runner?: string;
  /** Given source files no test reaches. */
  untested: string[];
  /** Inputs that are not analyzed files, folders, symbols or routes. */
  unknown: string[];
  byPath: { path: string; tests: string[] }[];
}

export interface CallLink {
  /** The symbol at the other end. */
  id: string;
  kind: SymbolEdgeKind | 'http';
  count: number;
  lines?: number[];
  /** HTTP links: `GET /api/users/:id`. */
  label?: string;
}

/* -------------------------------------------------------------------------- */
/*                                    Index                                   */
/* -------------------------------------------------------------------------- */

export interface QueryIndex {
  fileById: Map<string, FileInfo>;
  symbolById: Map<string, { symbol: SymbolInfo; file: FileInfo }>;
  out: Map<string, DependencyEdge[]>;
  in: Map<string, DependencyEdge[]>;
  symOut: Map<string, SymbolEdge[]>;
  symIn: Map<string, SymbolEdge[]>;
  routeById: Map<string, RouteInfo>;
  routesByHandler: Map<string, RouteInfo[]>;
  apiByRoute: Map<string, ApiCall[]>;
  httpOut: Map<string, CallLink[]>;
  httpIn: Map<string, CallLink[]>;
  /** Every folder that contains analyzed files ('' = the root). */
  dirs: Set<string>;
  /** Symbols of the same file that read a symbol without an edge (`SymbolInfo.localRefs`), by the symbol read. */
  refIn: Map<string, string[]>;
}

const INDEXES = new WeakMap<object, QueryIndex>();

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Lookup tables for the queries, built once per analysis object. */
export function buildIndex(data: QueryData): QueryIndex {
  const cached = INDEXES.get(data);
  if (cached) return cached;
  const fileById = new Map(data.files.map((f) => [f.id, f]));
  const symbolById = new Map<string, { symbol: SymbolInfo; file: FileInfo }>();
  const dirs = new Set<string>(['']);
  for (const file of data.files) {
    for (const symbol of file.symbols) symbolById.set(symbol.id, { symbol, file });
    let dir = file.dir;
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    }
  }
  const out = new Map<string, DependencyEdge[]>();
  const inn = new Map<string, DependencyEdge[]>();
  for (const e of data.edges) {
    push(out, e.source, e);
    push(inn, e.target, e);
  }
  const symOut = new Map<string, SymbolEdge[]>();
  const symIn = new Map<string, SymbolEdge[]>();
  for (const e of data.symbolEdges) {
    push(symOut, e.source, e);
    push(symIn, e.target, e);
  }
  const routeById = new Map(data.routes.map((r) => [r.id, r]));
  const routesByHandler = new Map<string, RouteInfo[]>();
  for (const r of data.routes) if (r.handlerSymbol) push(routesByHandler, r.handlerSymbol, r);
  const apiByRoute = new Map<string, ApiCall[]>();
  // HTTP links: a function calling fetch('/api/x') → the handler serving that route (full-stack flow).
  const httpOut = new Map<string, CallLink[]>();
  const httpIn = new Map<string, CallLink[]>();
  for (const c of data.apiCalls ?? []) {
    if (!c.route) continue;
    push(apiByRoute, c.route, c);
    const r = routeById.get(c.route);
    if (!c.symbol || !r?.handlerSymbol) continue;
    const label = `${c.method} ${r.path}`;
    push(httpOut, c.symbol, { id: r.handlerSymbol, kind: 'http', count: 1, lines: [c.line], label });
    push(httpIn, r.handlerSymbol, { id: c.symbol, kind: 'http', count: 1, lines: [c.line], label });
  }
  const refIn = new Map<string, string[]>();
  for (const file of data.files) {
    let byName: Map<string, SymbolInfo[]> | undefined;
    for (const s of file.symbols) {
      if (!s.localRefs?.length) continue;
      if (!byName) {
        byName = new Map();
        for (const x of file.symbols) push(byName, x.name, x);
      }
      for (const name of s.localRefs) for (const t of byName.get(name) ?? []) if (t !== s) push(refIn, t.id, s.id);
    }
  }
  const index: QueryIndex = { fileById, symbolById, out, in: inn, symOut, symIn, routeById, routesByHandler, apiByRoute, httpOut, httpIn, dirs, refIn };
  INDEXES.set(data, index);
  return index;
}

/** `src/a.ts#Foo.bar` → `src/a.ts` */
export function fileOfSymbol(id: string): string {
  const i = id.indexOf('#');
  return i === -1 ? id : id.slice(0, i);
}

export interface SymbolRef {
  id: string;
  file: FileInfo;
  symbol: SymbolInfo;
  /** Set when the id points at a class member (`file#Class.method`). */
  member?: MemberInfo;
  label: string;
  line: number;
}

/** A symbol id (top-level or `file#Class.member`) with its declaration. */
export function symbolRef(data: QueryData, id: string): SymbolRef | undefined {
  const idx = buildIndex(data);
  const direct = idx.symbolById.get(id);
  if (direct) return { id, ...direct, label: direct.symbol.name, line: direct.symbol.line };
  const hash = id.indexOf('#');
  const dot = id.lastIndexOf('.');
  if (hash === -1 || dot < hash) return undefined;
  const owner = idx.symbolById.get(id.slice(0, dot));
  if (!owner) return undefined;
  const name = id.slice(dot + 1);
  const member = owner.symbol.members?.find((m) => m.name === name);
  return { id, ...owner, member, label: `${owner.symbol.name}.${name}`, line: member?.line ?? owner.symbol.line };
}

/** Short human label of a target: `formatDate`, `src/utils/format.ts`, `GET /api/users/:id`, `src/components/`. */
export function targetLabel(data: QueryData, target: QueryTarget): string {
  switch (target.type) {
    case 'file':
      return target.id;
    case 'dir':
      return target.id ? `${target.id}/` : './';
    case 'route': {
      const r = buildIndex(data).routeById.get(target.id);
      return r ? routeLabel(r) : target.id;
    }
    case 'symbol':
      return symbolRef(data, target.id)?.label ?? target.id.slice(target.id.indexOf('#') + 1);
  }
}

/** Where a target is declared (a symbol's or route's file and line). */
export function targetLocation(data: QueryData, target: QueryTarget): { file?: string; line?: number } {
  if (target.type === 'file') return { file: target.id };
  if (target.type === 'symbol') {
    const ref = symbolRef(data, target.id);
    return { file: fileOfSymbol(target.id), line: ref?.line };
  }
  if (target.type === 'route') {
    const r = buildIndex(data).routeById.get(target.id);
    return r ? { file: r.file, line: r.line } : {};
  }
  return {};
}

/** The analyzed files a target stands for (a folder: every file in it; a route: its file and handler file). */
export function filesOfTarget(data: QueryData, target: QueryTarget): string[] {
  const idx = buildIndex(data);
  switch (target.type) {
    case 'file':
      return idx.fileById.has(target.id) ? [target.id] : [];
    case 'symbol':
      return idx.fileById.has(fileOfSymbol(target.id)) ? [fileOfSymbol(target.id)] : [];
    case 'dir':
      return data.files.filter((f) => !target.id || f.id.startsWith(`${target.id}/`)).map((f) => f.id);
    case 'route': {
      const r = idx.routeById.get(target.id);
      if (!r) return [];
      const files = [r.file];
      if (r.handlerSymbol && fileOfSymbol(r.handlerSymbol) !== r.file) files.push(fileOfSymbol(r.handlerSymbol));
      return files.filter((f) => idx.fileById.has(f));
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                               Target resolution                            */
/* -------------------------------------------------------------------------- */

const ROUTE_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL|PAGE)\s+(\S+)$/i;
const MEMBER_RE = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$#][\w$]*)$/;

const stripExt = (id: string): string => id.replace(/\.[^./]+$/, '');
const baseName = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/** The path of a request URL, for any host: `https://api.example.com/api/users/42?x=1` → `/api/users/42?x=1`. */
function requestPath(url: string): string {
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(url);
  return abs ? abs[1] || '/' : url;
}

/** Trim, use forward slashes, make paths under the project root relative, drop `./` and trailing slashes. */
function normalizePath(data: QueryData, raw: string): string {
  let input = raw.trim().replace(/\\/g, '/');
  const rootPath = data.project?.rootPath?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (rootPath && (input === rootPath || input.startsWith(`${rootPath}/`))) input = input.slice(rootPath.length);
  input = input.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  while (input.startsWith('./')) input = input.slice(2);
  if (input === '.') input = '';
  return input.replace(/\/+$/, '');
}

function fanIn(idx: QueryIndex, file: string): number {
  return idx.fileById.get(file)?.metrics.fanIn ?? 0;
}

/** Files a path-like input could mean: a path suffix (`components/Button.tsx`, `Button.tsx`) or a path without extension. */
function fileCandidates(data: QueryData, input: string): string[] {
  if (!input) return [];
  const lower = input.toLowerCase();
  const hasSlash = input.includes('/');
  const hits = data.files.filter((f) => {
    const id = f.id;
    if (id.endsWith(`/${input}`)) return true;
    if (!hasSlash) return false;
    const noExt = stripExt(id);
    return noExt === input || noExt.endsWith(`/${input}`) || id.toLowerCase() === lower;
  });
  return hits.map((f) => f.id);
}

function rankFiles(idx: QueryIndex, ids: string[]): string[] {
  return [...ids].sort((a, b) => fanIn(idx, b) - fanIn(idx, a) || a.length - b.length || a.localeCompare(b));
}

/** Symbols (and class members) with this name, best first: exported, then most imported file. */
function symbolsNamed(data: QueryData, idx: QueryIndex, name: string): string[] {
  const rank = (ids: string[]): string[] =>
    ids.sort((a, b) => {
      const sa = idx.symbolById.get(a)?.symbol ?? idx.symbolById.get(a.slice(0, a.lastIndexOf('.')))?.symbol;
      const sb = idx.symbolById.get(b)?.symbol ?? idx.symbolById.get(b.slice(0, b.lastIndexOf('.')))?.symbol;
      return Number(!!sb?.exported) - Number(!!sa?.exported) || fanIn(idx, fileOfSymbol(b)) - fanIn(idx, fileOfSymbol(a)) || a.localeCompare(b);
    });
  const all = data.files.flatMap((f) => f.symbols);
  const exact = all.filter((s) => s.name === name).map((s) => s.id);
  if (exact.length) return rank(exact);
  const members: string[] = [];
  for (const s of all) {
    if (s.kind !== 'class') continue;
    for (const m of s.members ?? []) if (m.name === name && (m.kind === 'method' || m.kind === 'getter' || m.kind === 'setter')) members.push(`${s.id}.${m.name}`);
  }
  if (members.length) return rank(members);
  const lower = name.toLowerCase();
  return rank(all.filter((s) => s.name.toLowerCase() === lower).map((s) => s.id));
}

/** A symbol of `file` by name: `Name`, `Class.method`, or the default export as `default`. */
function symbolInFile(file: FileInfo, name: string): string | undefined {
  if (name === 'default') return file.symbols.find((s) => s.isDefault)?.id;
  const top = file.symbols.find((s) => s.name === name) ?? file.symbols.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (top) return top.id;
  const m = MEMBER_RE.exec(name);
  if (m) {
    const cls = file.symbols.find((s) => s.name === m[1]);
    if (cls?.members?.some((x) => x.name === m[2])) return `${cls.id}.${m[2]}`;
  }
  return undefined;
}

/** Route path with every parameter written the same way (`/users/[id]` = `/users/:id` = `/users/{id}`). */
function canonicalRoutePath(p: string): string {
  return `/${segments(p)
    .map((s) => (isCatchAll(s) ? '*' : isParam(s) ? ':' : s.toLowerCase()))
    .join('/')}`;
}

/**
 * What the user means: an exact file id, a unique path suffix, `path#Name`, `Class.method`, a route
 * (`GET /api/users/42`), a folder, or a symbol name (exact, then case-insensitive; best ranked first).
 */
export function resolveTarget(data: QueryData, raw: string): ResolveResult {
  const idx = buildIndex(data);
  const trimmed = raw.trim();
  const route = ROUTE_RE.exec(trimmed);
  if (route) {
    const method = route[1].toUpperCase();
    const url = route[2];
    const wanted = canonicalRoutePath(requestPath(url));
    const exact = data.routes.find((r) => r.method === method && canonicalRoutePath(r.path) === wanted && r.type !== 'mount');
    const hit = exact ?? routeFor(data, method, url)[0]?.route;
    if (hit) return { target: { type: 'route', id: hit.id }, suggestions: [] };
    const others = routeFor(data, undefined, url).map((m) => m.label);
    return { suggestions: others.length ? others.slice(0, 5) : suggest(data, url) };
  }
  const input = normalizePath(data, trimmed);
  // `src/api/` names the folder, even when a file src/api.ts exists too.
  if (/[\\/]$/.test(trimmed)) return resolveDir(data, idx, input);
  if (idx.fileById.has(input)) return { target: { type: 'file', id: input }, suggestions: [] };
  const hash = input.indexOf('#');
  if (hash > 0) {
    const pathPart = input.slice(0, hash);
    const name = input.slice(hash + 1);
    const files = idx.fileById.has(pathPart) ? [pathPart] : fileCandidates(data, pathPart);
    if (files.length !== 1) return { suggestions: files.length ? rankFiles(idx, files).slice(0, 5).map((f) => `${f}#${name}`) : suggest(data, pathPart) };
    const file = idx.fileById.get(files[0])!;
    // Declared in the file, or re-exported by it (a barrel: `src/cart/index.ts#useCart`).
    const id = symbolInFile(file, name) ?? reexportedSymbol(idx, file, name);
    if (id) return { target: { type: 'symbol', id }, suggestions: [] };
    const names = [...file.symbols.map((s) => s.name), ...file.exports.filter((x) => x.name !== '*').map((x) => x.name)];
    return { suggestions: closest(name, names).map((n) => `${file.id}#${n}`) };
  }
  const files = fileCandidates(data, input);
  if (files.length === 1) return { target: { type: 'file', id: files[0] }, suggestions: [] };
  if (files.length > 1) return { suggestions: rankFiles(idx, files).slice(0, 5) };
  const member = MEMBER_RE.exec(input);
  if (member) {
    const hits = data.files.flatMap((f) => f.symbols.filter((s) => s.name === member[1] && s.members?.some((m) => m.name === member[2])).map((s) => `${s.id}.${member[2]}`));
    if (hits.length) return { target: { type: 'symbol', id: hits[0] }, suggestions: [], alternatives: hits.length > 1 ? hits.slice(1, 6) : undefined };
    // A module used as a namespace (CommonJS `usersController.getById`): file stem + symbol.
    const stem = member[1].toLowerCase();
    const inFiles = data.files
      .filter((f) => stripExt(baseName(f.id)).toLowerCase() === stem)
      .map((f) => symbolInFile(f, member[2]))
      .filter((id): id is string => !!id);
    if (inFiles.length === 1) return { target: { type: 'symbol', id: inFiles[0] }, suggestions: [] };
    if (inFiles.length > 1) return { suggestions: rankFiles(idx, inFiles.map(fileOfSymbol)).slice(0, 5).map((f) => inFiles.find((id) => fileOfSymbol(id) === f)!) };
  }
  if (input === '' || idx.dirs.has(input)) return { target: { type: 'dir', id: input }, suggestions: [] };
  if (input.includes('/')) {
    const dirs = [...idx.dirs].filter((d) => d.endsWith(`/${input}`));
    if (dirs.length === 1) return { target: { type: 'dir', id: dirs[0] }, suggestions: [] };
    if (dirs.length > 1) return { suggestions: dirs.slice(0, 5).map((d) => `${d}/`) };
  }
  const symbols = symbolsNamed(data, idx, input);
  if (symbols.length) return { target: { type: 'symbol', id: symbols[0] }, suggestions: [], alternatives: symbols.length > 1 ? symbols.slice(1, 6) : undefined };
  // Last resort: a file name without its extension (`format` → src/utils/format.ts), or a folder name.
  const byStem = data.files.filter((f) => stripExt(baseName(f.id)).toLowerCase() === input.toLowerCase()).map((f) => f.id);
  if (byStem.length === 1) return { target: { type: 'file', id: byStem[0] }, suggestions: [] };
  if (byStem.length > 1) return { suggestions: rankFiles(idx, byStem).slice(0, 5) };
  const dirs = [...idx.dirs].filter((d) => d && baseName(d) === input);
  if (dirs.length === 1) return { target: { type: 'dir', id: dirs[0] }, suggestions: [] };
  return { suggestions: suggest(data, input) };
}

/** A folder by path, path suffix or name (the input ended with `/`). */
function resolveDir(data: QueryData, idx: QueryIndex, input: string): ResolveResult {
  if (idx.dirs.has(input)) return { target: { type: 'dir', id: input }, suggestions: [] };
  const bySuffix = [...idx.dirs].filter((d) => d.endsWith(`/${input}`));
  const hits = bySuffix.length ? bySuffix : [...idx.dirs].filter((d) => d && baseName(d).toLowerCase() === input.toLowerCase());
  if (hits.length === 1) return { target: { type: 'dir', id: hits[0] }, suggestions: [] };
  if (hits.length > 1) return { suggestions: hits.sort().slice(0, 5).map((d) => `${d}/`) };
  const all = suggest(data, input);
  const folders = all.filter((x) => x.endsWith('/'));
  return { suggestions: folders.length ? folders : all };
}

/** The declaration behind a name a barrel re-exports (`export { Button } from './Button'`, `export *`). */
function reexportedSymbol(idx: QueryIndex, file: FileInfo, name: string, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const exported = file.exports.find((x) => x.name === name) ?? file.exports.find((x) => x.name.toLowerCase() === name.toLowerCase());
  const wanted = exported?.name ?? name;
  for (const e of idx.out.get(file.id) ?? []) {
    if (e.kind !== 'reexport') continue;
    const target = idx.fileById.get(e.target);
    if (!target) continue;
    const candidates = new Set<string>();
    if (exported?.from === e.specifier) {
      // `export { default as Button } from './Button'`: the edge names what is taken from the module.
      if (e.names.includes(wanted)) candidates.add(wanted);
      else e.names.filter((n) => n !== '*').forEach((n) => candidates.add(n));
    }
    if (e.names.includes('*')) candidates.add(wanted);
    for (const n of candidates) {
      const own = n === 'default' ? target.symbols.find((s) => s.isDefault) : target.symbols.find((s) => s.name === n);
      const id = own?.id ?? reexportedSymbol(idx, target, n, depth + 1);
      if (id) return id;
    }
  }
  return undefined;
}

/** Levenshtein distance, giving up (returning `max + 1`) once it exceeds `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** Up to 5 of `candidates` within a few edits of `query` (1 per 3 characters, at most 3), or containing it. */
function closest(query: string, candidates: Iterable<string>, keyOf: (c: string) => string[] = (c) => [c]): string[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const max = Math.min(3, Math.max(1, Math.floor(q.length / 3)));
  const scored: { c: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    let best = Infinity;
    for (const key of keyOf(c)) {
      const k = key.toLowerCase();
      if (q.length >= 3 && k.includes(q)) best = Math.min(best, 0.5 + (k.length - q.length) / 100);
      else {
        const d = distance(q, k, max);
        if (d <= max) best = Math.min(best, d);
      }
    }
    if (best <= max) scored.push({ c, score: best });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.c.length - b.c.length || a.c.localeCompare(b.c))
    .slice(0, 5)
    .map((s) => s.c);
}

/** "Did you mean" candidates across symbol names, files, folders and routes. */
export function suggest(data: QueryData, input: string): string[] {
  const idx = buildIndex(data);
  const q = input.trim();
  if (!q) return [];
  const names = new Set<string>();
  for (const f of data.files) for (const s of f.symbols) names.add(s.name);
  const pool = [
    ...names,
    ...data.files.map((f) => f.id),
    ...[...idx.dirs].filter(Boolean).map((d) => `${d}/`),
    ...data.routes.filter((r) => r.type === 'api' || r.type === 'page').map(routeLabel),
  ];
  return closest(q.replace(/\/+$/, ''), pool, (c) => (c.includes('/') ? [c.replace(/\/$/, ''), baseName(c.replace(/\/$/, '')), stripExt(baseName(c))] : [c]));
}

/* -------------------------------------------------------------------------- */
/*                                Symbol users                                */
/* -------------------------------------------------------------------------- */

interface Importer {
  file: string;
  edge: DependencyEdge;
  /** Names it imports that lead to the target (`*` for namespace / CommonJS imports). */
  names: string[];
  /** Barrel it imports through. */
  via?: string;
  /** For a barrel (`export … from`): the names it exports that lead to the target. */
  onward?: string[];
}

interface SymbolUse {
  /** The target plus the symbols of its own file that (transitively) use it. */
  closure: Set<string>;
  /** Export names through which other files reach the closure. */
  names: string[];
  importers: Importer[];
  /** Other files' symbols with an edge into the closure. */
  external: SymbolEdge[];
  /** Routes the closure handles. */
  routes: RouteInfo[];
  /** An importer uses a namespace / CommonJS / dynamic import, so it may or may not use the target. */
  star: string[];
  /** How the target reaches other files is not visible (module-level code, an aliased export). */
  unknown?: string;
}

const topName = (symbolId: string): string => {
  const name = symbolId.slice(symbolId.indexOf('#') + 1);
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
};

/** `src/a.ts#Foo.bar` → `src/a.ts#Foo` */
const topId = (symbolId: string): string => {
  const hash = symbolId.indexOf('#');
  const dot = symbolId.indexOf('.', hash + 1);
  return hash === -1 || dot === -1 ? symbolId : symbolId.slice(0, dot);
};

/** Names under which `file` exports `symbol` (`default` for a default export). */
function exportNames(file: FileInfo, symbol: SymbolInfo): string[] {
  const names: string[] = [];
  if (symbol.isDefault) names.push('default');
  if (file.exports.some((e) => e.name === symbol.name && !e.from)) names.push(symbol.name);
  return names;
}

/** Files importing `names` of `file`, following barrels (`export … from`). */
function importersOf(idx: QueryIndex, file: string, names: Set<string>): Importer[] {
  const found = new Map<string, Importer>();
  const visited = new Set<string>();
  const visit = (target: string, wanted: Set<string>, via: string | undefined, depth: number): void => {
    for (const e of idx.in.get(target) ?? []) {
      if (e.source === file) continue;
      const named = e.names.filter((n) => wanted.has(n));
      if (e.kind === 'reexport') {
        const barrel = idx.fileById.get(e.source);
        const onward = new Set<string>();
        if (e.names.includes('*')) for (const n of wanted) if (n !== 'default') onward.add(n);
        for (const n of named) {
          if (barrel?.exports.some((x) => x.name === n)) onward.add(n);
          // Renamed (`export { default as Button } from`): every name the barrel takes from that module.
          else for (const x of barrel?.exports ?? []) if (x.from === e.specifier && x.name !== '*') onward.add(x.name);
        }
        if (!onward.size) continue;
        const known = found.get(e.source);
        if (!known) found.set(e.source, { file: e.source, edge: e, names: named.length ? named : [...onward], via, onward: [...onward] });
        else if (known.onward) known.onward = [...new Set([...known.onward, ...onward])];
        const key = `${e.source}\0${[...onward].sort().join(',')}`;
        if (depth < 8 && !visited.has(key)) {
          visited.add(key);
          visit(e.source, onward, e.source, depth + 1);
        }
        continue;
      }
      const star = e.names.includes('*');
      if (!named.length && !star) continue;
      const existing = found.get(e.source);
      if (!existing || existing.onward || (existing.names.includes('*') && named.length)) found.set(e.source, { file: e.source, edge: e, names: named.length ? named : ['*'], via });
    }
  };
  visit(file, names, undefined, 0);
  return [...found.values()];
}

/**
 * `seeds` plus the symbols of `fileId` that (transitively) use them: callers, renderers, code that reads
 * them as values or mentions them as types, and the class of every member.
 */
function inFileClosure(idx: QueryIndex, fileId: string, seeds: Iterable<string>): Set<string> {
  const closure = new Set<string>();
  const queue: string[] = [];
  const add = (id: string): void => {
    if (closure.has(id)) return;
    closure.add(id);
    queue.push(id);
    const top = topId(id);
    if (top !== id) add(top);
  };
  for (const s of seeds) add(s);
  while (queue.length) {
    const id = queue.pop()!;
    for (const e of idx.symIn.get(id) ?? []) if (fileOfSymbol(e.source) === fileId) add(e.source);
    for (const reader of idx.refIn.get(id) ?? []) add(reader);
  }
  return closure;
}

/** The first symbol of the closure that module-level code of its file uses. */
function moduleUser(idx: QueryIndex, closure: Set<string>): SymbolInfo | undefined {
  for (const id of closure) {
    const s = idx.symbolById.get(topId(id))?.symbol;
    if (s?.moduleRef) return s;
  }
  return undefined;
}

/** How a symbol reaches the rest of the code: in-file users, export names, importers, external callers, routes. */
function symbolUse(idx: QueryIndex, symbolId: string): SymbolUse {
  const fileId = fileOfSymbol(symbolId);
  const file = idx.fileById.get(fileId);
  const closure = inFileClosure(idx, fileId, [symbolId]);
  const names = new Set<string>();
  let unknown: string | undefined;
  let exported = false;
  for (const top of new Set([...closure].map(topId))) {
    const s = idx.symbolById.get(top)?.symbol;
    if (!s?.exported || !file) continue;
    exported = true;
    const n = exportNames(file, s);
    if (!n.length) unknown = `${s.name} is exported under another name`;
    n.forEach((x) => names.add(x));
  }
  // Importing the file runs its module-level code (`init();`, `app.get('/', handler)`), so every importer counts.
  const mod = moduleUser(idx, closure);
  if (mod) unknown = `${mod.name} is used by module-level code of ${fileId}`;
  const external = [...closure].flatMap((id) => (idx.symIn.get(id) ?? []).filter((e) => fileOfSymbol(e.source) !== fileId));
  const routes = [...closure].flatMap((id) => idx.routesByHandler.get(id) ?? []);
  if (!unknown && !exported && !external.length && !routes.length) {
    unknown = `${topName(symbolId)} is not exported and no analyzed code uses it`;
  }
  const importers = names.size ? importersOf(idx, fileId, names) : [];
  const star = importers.filter((i) => i.names.includes('*')).map((i) => i.file);
  return { closure, names: [...names], importers, external, routes, star, unknown };
}

const SITE_KIND: Partial<Record<SymbolEdgeKind, CallSite['kind']>> = { calls: 'call', renders: 'render', instantiates: 'new' };

/** Exact sites of a symbol edge (one per line), or the source symbol's line when the edge has none. */
function edgeSites(data: QueryData, e: SymbolEdge): UseSite[] {
  const kind = SITE_KIND[e.kind];
  if (!kind) return [];
  const file = fileOfSymbol(e.source);
  if (e.lines?.length) return e.lines.map((line, i) => ({ file, line, kind, symbol: e.source, target: e.target, argc: e.argc?.[i] }));
  const line = symbolRef(data, e.source)?.line;
  return line ? [{ file, line, kind, symbol: e.source, target: e.target }] : [];
}

function httpSites(calls: ApiCall[]): UseSite[] {
  return calls.map((c) => ({ file: c.file, line: c.line, kind: 'http', symbol: c.symbol, method: c.method, url: c.url, client: c.client, target: c.route }));
}

const bySite = (a: CallSite, b: CallSite): number => a.file.localeCompare(b.file) || a.line - b.line;

/* -------------------------------------------------------------------------- */
/*                                    Uses                                    */
/* -------------------------------------------------------------------------- */

/** Who uses a target, and exactly where: imports (with names), call / render / `new` sites, type references, HTTP requests. */
export function usesOf(data: QueryData, target: QueryTarget): UsesResult {
  const idx = buildIndex(data);
  const imports: UseSite[] = [];
  const through: UseSite[] = [];
  const sites: UseSite[] = [];
  const refs: UsesResult['refs'] = [];
  let http: UseSite[] = [];
  const addEdges = (edges: SymbolEdge[]): void => {
    for (const e of edges) {
      if (SITE_KIND[e.kind]) sites.push(...edgeSites(data, e));
      else refs.push({ symbol: e.source, file: fileOfSymbol(e.source), kind: e.kind, target: e.target });
    }
  };
  const importSite = (i: Importer): UseSite => ({
    file: i.file,
    line: i.edge.line,
    kind: i.edge.kind === 'reexport' ? 'reexport' : 'import',
    names: i.names,
    typeOnly: i.edge.typeOnly || undefined,
    via: i.via,
  });
  const symbolTarget = (id: string): void => {
    const use = symbolUse(idx, id);
    const fileId = fileOfSymbol(id);
    const file = idx.fileById.get(fileId);
    const ref = symbolRef(data, id);
    // Imports of the target's own export names; importers of the other exports that reach it (a sibling
    // export that calls it, the class of a member) are listed apart and not counted as users.
    const own = ref && !ref.member && file ? exportNames(file, ref.symbol) : [];
    const direct = own.length ? importersOf(idx, fileId, new Set(own)) : [];
    const key = (i: Importer): string => `${i.file}:${i.edge.line}`;
    const directKeys = new Set(direct.map(key));
    imports.push(...direct.map(importSite));
    through.push(...use.importers.filter((i) => !directKeys.has(key(i))).map(importSite));
    // Direct references only: the symbol itself, or a class's members from outside the class.
    const ids = [id];
    if (ref && !ref.member && ref.symbol.kind === 'class') for (const m of ref.symbol.members ?? []) ids.push(`${id}.${m.name}`);
    const classPrefix = `${id}.`;
    addEdges(ids.flatMap((x) => idx.symIn.get(x) ?? []).filter((e) => e.source !== id && !e.source.startsWith(classPrefix)));
    // A member is reached through instances: `new Class()` in its own file (`const a = new A(); a.run()`).
    if (ref?.member) {
      const cls = ref.symbol.id;
      addEdges((idx.symIn.get(cls) ?? []).filter((e) => e.kind === 'instantiates' && fileOfSymbol(e.source) === fileId && topId(e.source) !== cls));
    }
    http.push(...httpSites(use.routes.flatMap((r) => idx.apiByRoute.get(r.id) ?? []).filter((c) => !use.closure.has(c.symbol ?? ''))));
  };
  const fileTargets = (files: Set<string>): void => {
    for (const fileId of files) {
      for (const e of idx.in.get(fileId) ?? []) {
        if (files.has(e.source)) continue;
        imports.push({ file: e.source, line: e.line, kind: e.kind === 'reexport' ? 'reexport' : 'import', names: e.names, typeOnly: e.typeOnly || undefined });
      }
      const file = idx.fileById.get(fileId)!;
      const ids = file.symbols.flatMap((s) => [s.id, ...(s.kind === 'class' ? (s.members ?? []).map((m) => `${s.id}.${m.name}`) : [])]);
      addEdges(ids.flatMap((x) => idx.symIn.get(x) ?? []).filter((e) => !files.has(fileOfSymbol(e.source))));
    }
    const routes = data.routes.filter((r) => files.has(r.file) || (r.handlerSymbol && files.has(fileOfSymbol(r.handlerSymbol))));
    http = httpSites(routes.flatMap((r) => idx.apiByRoute.get(r.id) ?? []).filter((c) => !files.has(c.file)));
  };
  if (target.type === 'symbol') symbolTarget(target.id);
  else if (target.type === 'route') {
    const r = idx.routeById.get(target.id);
    if (r?.handlerSymbol) symbolTarget(r.handlerSymbol);
    http = httpSites(idx.apiByRoute.get(target.id) ?? []);
  } else {
    fileTargets(new Set(filesOfTarget(data, target)));
  }
  imports.sort(bySite);
  through.sort(bySite);
  http.sort(bySite);
  const uniqueRefs = new Map(refs.map((r) => [`${r.symbol}\0${r.kind}\0${r.target}`, r]));
  const sortedRefs = [...uniqueRefs.values()].sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol) || a.target.localeCompare(b.target));
  const unique = mostSpecificSites(data, sites).sort(bySite);
  const files = new Set([...imports, ...unique, ...http].map((s) => s.file).concat(sortedRefs.map((r) => r.file)));
  return { target, imports, sites: unique, refs: sortedRefs, http, through, files: files.size };
}

/**
 * One site per place: a call in a component's script setup is also recorded for the constant it
 * initializes (`const store = useStore()`), so keep the innermost enclosing symbol.
 */
function mostSpecificSites(data: QueryData, sites: UseSite[]): UseSite[] {
  const span = (id: string | undefined): number => {
    const ref = id ? symbolRef(data, id) : undefined;
    return !ref ? Infinity : ref.member ? 0 : ref.symbol.endLine - ref.symbol.line;
  };
  const best = new Map<string, UseSite>();
  for (const site of sites) {
    const key = `${site.file}:${site.line}:${site.kind}:${site.target ?? ''}:${site.argc ?? ''}`;
    const prev = best.get(key);
    if (!prev || span(site.symbol) < span(prev.symbol)) best.set(key, site);
  }
  return [...best.values()];
}

/** Symbols calling (or rendering, instantiating…) `symbolId`, plus HTTP callers of a route handler. */
export function callersOf(data: QueryData, symbolId: string, kinds: readonly SymbolEdgeKind[] = ['calls', 'instantiates'], http = true): CallLink[] {
  const idx = buildIndex(data);
  const links: CallLink[] = (idx.symIn.get(symbolId) ?? []).filter((e) => kinds.includes(e.kind)).map((e) => ({ id: e.source, kind: e.kind, count: e.count, lines: e.lines }));
  if (http) links.push(...(idx.httpIn.get(symbolId) ?? []));
  return links;
}

/** Symbols `symbolId` calls (or renders, instantiates…), plus route handlers it requests over HTTP. */
export function calleesOf(data: QueryData, symbolId: string, kinds: readonly SymbolEdgeKind[] = ['calls', 'instantiates'], http = true): CallLink[] {
  const idx = buildIndex(data);
  const links: CallLink[] = (idx.symOut.get(symbolId) ?? []).filter((e) => kinds.includes(e.kind)).map((e) => ({ id: e.target, kind: e.kind, count: e.count, lines: e.lines }));
  if (http) links.push(...(idx.httpOut.get(symbolId) ?? []));
  return links;
}

/* -------------------------------------------------------------------------- */
/*                                   Impact                                   */
/* -------------------------------------------------------------------------- */

export interface ImpactOptions {
  /** How many import levels to list (default 3). Everything beyond is counted in `truncated`. */
  depth?: number;
  /** Ignore type-only imports past the direct users. */
  runtimeOnly?: boolean;
}

/**
 * What a change to the targets affects. For a symbol only the files that import it (by name, or through
 * a barrel) or call it count, plus everything that depends on those; edits inside one function don't
 * spread to importers of its siblings, and a barrel passes a change on only to the files importing the
 * changed names from it. Namespace / CommonJS imports and symbols used by module-level code fall back to
 * file precision (`precisionNote` says why).
 */
export function impactOf(data: QueryData, targets: QueryTarget | QueryTarget[], options: ImpactOptions = {}): ImpactResult {
  const idx = buildIndex(data);
  const list = Array.isArray(targets) ? targets : [targets];
  const maxDepth = options.depth ?? 3;
  const start = directUsers(data, idx, list);
  const { seeds, fileLevelSeeds, direct } = start;

  // Everything that depends on the direct users, by import distance. The targets' own files are walked
  // through (a target file that uses another target passes the change on) but never listed.
  const reach = dependents(idx, new Map([...direct].map(([file, d]) => [file, d.full ? undefined : d.onward])), options.runtimeOnly);
  const precise = preciseUsers(idx, start, reach, options.runtimeOnly);
  for (const s of seeds) direct.delete(s);
  const depthOf = new Map([...reach].map(([file, r]) => [file, r.depth]));
  const affected = [...depthOf.keys()].filter((f) => !seeds.has(f));
  const shown = affected.filter((f) => depthOf.get(f)! <= maxDepth);
  const byDepth = new Map<number, string[]>();
  for (const f of shown) push(byDepth, depthOf.get(f)!, f);

  const touched = (f: string): boolean => depthOf.has(f) || fileLevelSeeds.has(f);
  const routes = affectedRoutes(data, start.handled, touched, precise);
  const owners = new Map<string, string[]>();
  for (const f of affected) for (const o of idx.fileById.get(f)?.owners ?? []) push(owners, o, f);
  return {
    targets: list,
    precision: start.precision,
    precisionNote: start.precision === 'file' && start.notes.length ? [...new Set(start.notes)].join('; ') : undefined,
    direct: [...direct.entries()]
      .map(([file, d]) => ({ file, via: [...d.via].sort(), sites: dedupeSites(d.sites) }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    byDepth: [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([depth, files]) => ({ depth, files: files.sort() })),
    routes,
    tests: impactTests(data, idx, [...depthOf.keys()], start, routes),
    owners: [...owners.entries()]
      .map(([owner, files]) => ({ owner, files: files.sort() }))
      .sort((a, b) => b.files.length - a.files.length || a.owner.localeCompare(b.owner)),
    total: shown.length,
    truncated: affected.length > shown.length ? affected.length - shown.length : undefined,
  };
}

interface DirectUse {
  via: Set<string>;
  sites: UseSite[];
  /** Uses the targets itself (imports, calls or requests them): every file importing it is affected. */
  full: boolean;
  /** Re-exports the targets (a barrel): files importing these names from it are affected. */
  onward: Set<string>;
  /** Symbols of the file that use the targets; `all` when that is not known (an import without a call site, module-level code). */
  users: Set<string> | 'all';
  /** Its import edges that lead to the targets. */
  edges: Set<DependencyEdge>;
}

interface ImpactStart {
  /** The targets' own files. */
  seeds: Set<string>;
  /** Target files every importer of which counts. */
  fileLevelSeeds: Set<string>;
  /** Target files of which only some symbols changed. */
  symbolSeeds: Set<string>;
  /** Symbol targets measured precisely. */
  symbols: Set<string>;
  /** Files using the targets → how (names, routes) and where. */
  direct: Map<string, DirectUse>;
  /** Route ids the targets serve. */
  handled: Set<string>;
  precision: ImpactResult['precision'];
  notes: string[];
}

/** The files that use the targets directly (importers, callers, files registering or requesting their routes). */
function directUsers(data: QueryData, idx: QueryIndex, targets: QueryTarget[]): ImpactStart {
  const start: ImpactStart = { seeds: new Set(), fileLevelSeeds: new Set(), symbolSeeds: new Set(), symbols: new Set(), direct: new Map(), handled: new Set(), precision: 'symbol', notes: [] };
  const useOf = (file: string, via: string[], sites: UseSite[]): DirectUse => {
    let d = start.direct.get(file);
    if (!d) start.direct.set(file, (d = { via: new Set(), sites: [], full: false, onward: new Set(), users: new Set(), edges: new Set() }));
    via.forEach((v) => d!.via.add(v));
    d.sites.push(...sites);
    return d;
  };
  const addUsers = (d: DirectUse, users: string[] | 'all'): void => {
    d.full = true;
    if (d.users === 'all') return;
    if (users === 'all') d.users = 'all';
    else users.forEach((u) => (d.users as Set<string>).add(u));
  };
  const importSite = (file: string, e: DependencyEdge): UseSite => ({ file, line: e.line, kind: e.kind === 'reexport' ? 'reexport' : 'import' });
  const routeCallers = (r: RouteInfo): void => {
    for (const c of idx.apiByRoute.get(r.id) ?? []) addUsers(useOf(c.file, [`${c.method} ${r.path}`], httpSites([c])), c.symbol ? [c.symbol] : 'all');
  };
  const fileLevel = (fileId: string): void => {
    start.precision = 'file';
    start.seeds.add(fileId);
    start.fileLevelSeeds.add(fileId);
    for (const e of idx.in.get(fileId) ?? []) {
      const d = useOf(e.source, e.names.length ? e.names : [e.kind], [importSite(e.source, e)]);
      d.edges.add(e);
      const onward = e.kind === 'reexport' ? onwardNames(idx, e, undefined) : undefined;
      if (onward) onward.forEach((n) => d.onward.add(n));
      else addUsers(d, 'all');
    }
    for (const r of data.routes) if (r.file === fileId || (r.handlerSymbol && fileOfSymbol(r.handlerSymbol) === fileId)) start.handled.add(r.id);
  };
  const symbolLevel = (symbolId: string): void => {
    const fileId = fileOfSymbol(symbolId);
    if (!idx.fileById.has(fileId)) return;
    const use = symbolUse(idx, symbolId);
    if (use.unknown) {
      start.notes.push(use.unknown);
      fileLevel(fileId);
      return;
    }
    start.seeds.add(fileId);
    start.symbolSeeds.add(fileId);
    start.symbols.add(symbolId);
    if (use.star.length) {
      start.precision = 'file';
      start.notes.push(`${use.star.length === 1 ? use.star[0] : `${use.star.length} files`} import${use.star.length === 1 ? 's' : ''} the whole module`);
    }
    for (const i of use.importers) {
      const d = useOf(i.file, i.names, [importSite(i.file, i.edge)]);
      d.edges.add(i.edge);
      if (i.onward) i.onward.forEach((n) => d.onward.add(n));
      else d.full = true;
    }
    for (const e of use.external) addUsers(useOf(fileOfSymbol(e.source), [topName(e.target)], edgeSites(data, e)), [e.source]);
    for (const r of use.routes) {
      start.handled.add(r.id);
      // The file registering the route (`router.get('/', controller.list)`) uses the handler too.
      if (r.file !== fileId) useOf(r.file, [routeLabel(r)], []).full = true;
      routeCallers(r);
    }
  };
  for (const t of targets) {
    if (t.type === 'symbol') symbolLevel(t.id);
    else if (t.type === 'route') {
      const r = idx.routeById.get(t.id);
      if (!r) continue;
      start.handled.add(r.id);
      if (r.handlerSymbol && symbolRef(data, r.handlerSymbol)) symbolLevel(r.handlerSymbol);
      else fileLevel(r.file);
      routeCallers(r);
    } else {
      for (const f of filesOfTarget(data, t)) fileLevel(f);
    }
  }
  // An import without a call site (a value use, module-level code): which of its symbols use it is unknown.
  for (const d of start.direct.values()) if (d.full && d.users !== 'all' && !d.users.size) d.users = 'all';
  return start;
}

interface Reach {
  /** Import distance (1 = a direct user). */
  depth: number;
  /** Only these exports of the file are affected (a barrel reached through re-exports); undefined: all. */
  names?: Set<string>;
}

/** Names a file exports (`default` for its default export); undefined when they are not all listed. */
function exportedNames(file: FileInfo | undefined): Set<string> | undefined {
  if (!file?.exports.length || file.exports.some((e) => e.name === '*')) return undefined;
  return new Set(file.exports.map((e) => (e.isDefault ? 'default' : e.name)));
}

/** The names a barrel passes on through re-export edge `e` when `names` of its target changed (undefined: all, or unknown). */
function onwardNames(idx: QueryIndex, e: DependencyEdge, names: Set<string> | undefined): Set<string> | undefined {
  const barrel = idx.fileById.get(e.source);
  const wanted = names ?? exportedNames(idx.fileById.get(e.target));
  if (!barrel || !wanted) return undefined;
  const onward = new Set<string>();
  const star = e.names.includes('*');
  if (star) {
    for (const n of wanted) if (n !== 'default') onward.add(n);
    // `export * as ns from`: the namespace.
    for (const x of barrel.exports) if (x.from === e.specifier && x.name !== '*') onward.add(x.name);
  }
  for (const n of e.names) {
    if (n === '*' || !wanted.has(n)) continue;
    if (barrel.exports.some((x) => x.name === n)) onward.add(n);
    else for (const x of barrel.exports) if (x.from === e.specifier && x.name !== '*') onward.add(x.name);
  }
  return onward;
}

/**
 * Whether the importer of edge `e` is affected when `names` of the imported file changed (undefined:
 * all): `false`, or which of the importer's own exports are (undefined: all of them).
 */
function passes(idx: QueryIndex, e: DependencyEdge, names: Set<string> | undefined, runtimeOnly?: boolean): Set<string> | undefined | false {
  if (runtimeOnly && e.typeOnly) return false;
  if (e.kind === 'reexport') {
    const onward = onwardNames(idx, e, names);
    return onward && !onward.size ? false : onward;
  }
  if (names && e.names.length && !e.names.includes('*') && !e.names.some((n) => names.has(n))) return false;
  return undefined;
}

/**
 * Files that (transitively) import the seeds, with their distance (the seeds are 1). A barrel passes a
 * change on by name: a file importing `{ Card }` from `components/index.ts` is not affected by a change
 * to `Button` that the barrel also re-exports.
 */
function dependents(idx: QueryIndex, seeds: Map<string, Set<string> | undefined>, runtimeOnly?: boolean): Map<string, Reach> {
  const reach = new Map<string, Reach>();
  const queue: string[] = [];
  const enqueue = (file: string, depth: number, names: Set<string> | undefined): void => {
    const prev = reach.get(file);
    if (!prev) {
      reach.set(file, { depth, names: names && new Set(names) });
      queue.push(file);
      return;
    }
    if (!prev.names) return;
    if (!names) prev.names = undefined;
    else {
      const before = prev.names.size;
      for (const n of names) prev.names.add(n);
      if (prev.names.size === before) return;
    }
    queue.push(file); // more of it is affected now: pass that on
  };
  for (const [file, names] of seeds) enqueue(file, 1, names);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    const { depth, names } = reach.get(node)!;
    for (const e of idx.in.get(node) ?? []) {
      const onward = passes(idx, e, names, runtimeOnly);
      if (onward !== false) enqueue(e.source, depth + 1, onward);
    }
  }
  return reach;
}

/**
 * Direct users of which only some symbols use the targets (through call / render / `new` sites, and no
 * other affected import): those symbols and their in-file users. Routes of such a file count only when
 * their handler is one of them (`impact findUser` lists `GET /users/:id`, not `DELETE` of the same file).
 */
function preciseUsers(idx: QueryIndex, start: ImpactStart, reach: Map<string, Reach>, runtimeOnly?: boolean): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [file, d] of start.direct) {
    if (!d.full || d.users === 'all' || !d.users.size || start.seeds.has(file)) continue;
    const other = (idx.out.get(file) ?? []).some((e) => {
      if (d.edges.has(e)) return false;
      const r = reach.get(e.target);
      return !!r && passes(idx, e, r.names, runtimeOnly) !== false;
    });
    if (other) continue;
    const closure = inFileClosure(idx, file, d.users);
    if (!moduleUser(idx, closure)) result.set(file, closure);
  }
  return result;
}

/**
 * Routes served by the targets, by affected handlers, or registered with inline handlers / middleware
 * in affected files (a page component's route counts only when the page itself is affected).
 */
function affectedRoutes(data: QueryData, handled: Set<string>, touched: (file: string) => boolean, precise: Map<string, Set<string>>): ImpactResult['routes'] {
  const ids = new Set(handled);
  for (const r of data.routes) {
    if (r.type === 'mount' || ids.has(r.id)) continue;
    const handlerFile = r.handlerSymbol ? fileOfSymbol(r.handlerSymbol) : undefined;
    if (handlerFile && touched(handlerFile)) {
      const known = precise.get(handlerFile);
      if (!known || known.has(r.handlerSymbol!)) ids.add(r.id);
    } else if (r.type !== 'middleware' && touched(r.file) && (!handlerFile || r.middlewares?.length)) {
      // Inline handlers are module-level code, whose calls are not tracked: they always count.
      if (!handlerFile || !precise.has(r.file)) ids.add(r.id);
    }
  }
  return data.routes
    .filter((r) => ids.has(r.id))
    .map((r) => ({ id: r.id, label: routeLabel(r), file: r.file, line: r.line }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Tests among the affected files, tests reaching them, tests requesting the affected routes over HTTP,
 * and (file-level) tests reaching the targets. Test support files (helpers, fixtures) are left out.
 */
function impactTests(data: QueryData, idx: QueryIndex, affected: string[], start: ImpactStart, routes: ImpactResult['routes']): ImpactResult['tests'] {
  const tests = new Set<string>();
  const isTest = (id: string): boolean => idx.fileById.get(id)?.kind === 'test';
  const addTestsOf = (fileId: string): void => {
    const f = idx.fileById.get(fileId);
    if (!f) return;
    if (f.kind === 'test') tests.add(f.id);
    for (const t of f.tests ?? []) tests.add(t);
  };
  affected.forEach(addTestsOf);
  start.fileLevelSeeds.forEach(addTestsOf);
  for (const s of start.symbolSeeds) if (isTest(s)) tests.add(s);
  for (const r of routes) for (const c of idx.apiByRoute.get(r.id) ?? []) if (isTest(c.file)) tests.add(c.file);
  // test-intelligence: e2e specs that visit an affected route (`page.goto('/users/1')`).
  for (const r of routes) for (const t of visitingTests(data).get(r.id) ?? []) tests.add(t);
  const files = [...tests].filter((t) => isTestEntry(t, data.project?.testRunners)).sort();
  const testable = (fileId: string): boolean => {
    const f = idx.fileById.get(fileId);
    return !!f && isTestableSource(f);
  };
  // The same rule as the Tests list: a target a test reaches through a route it requests is not untested.
  const untested = [
    ...[...start.fileLevelSeeds].filter((s) => testable(s) && !testEvidence(data, idx.fileById.get(s)!)),
    // Symbols: no test reaches any of their users (their file may still have tests for other code).
    ...(files.length ? [] : [...start.symbols].filter((id) => testable(fileOfSymbol(id)) && !start.fileLevelSeeds.has(fileOfSymbol(id)))),
  ].sort();
  return { files, command: buildTestCommand(files, data.project?.testRunners).command, untested };
}

function dedupeSites(sites: UseSite[]): UseSite[] {
  const seen = new Set<string>();
  return sites
    .filter((s) => {
      const key = `${s.file}:${s.line}:${s.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(bySite);
}

/** Every file that (transitively) depends on the symbols — the file-level "impacted" set of `My changes`. */
export function impactedFiles(data: QueryData, targets: QueryTarget[]): { files: string[]; routes: string[]; precision: ImpactResult['precision'] } {
  const r = impactOf(data, targets, { depth: Infinity });
  return { files: r.byDepth.flatMap((d) => d.files), routes: r.routes.map((x) => x.id), precision: r.precision };
}

/* -------------------------------------------------------------------------- */
/*                                 Graph walks                                */
/* -------------------------------------------------------------------------- */

/** Files reachable from `start` following imports (`deps`) or importers (`dependents`), with their distance. */
export function transitive(data: QueryData, start: string, direction: 'deps' | 'dependents', maxDepth = Infinity, runtimeOnly = false): Map<string, number> {
  const idx = buildIndex(data);
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    const d = depth.get(node)!;
    if (d >= maxDepth) continue;
    const edges = direction === 'deps' ? idx.out.get(node) : idx.in.get(node);
    for (const e of edges ?? []) {
      if (runtimeOnly && e.typeOnly) continue;
      const next = direction === 'deps' ? e.target : e.source;
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  depth.delete(start);
  return depth;
}

/** The shortest import chain from `from` to `to` (each hop with its import line and names), or undefined. */
export function importPath(data: QueryData, from: string, to: string, options: { runtimeOnly?: boolean } = {}): PathResult | undefined {
  const idx = buildIndex(data);
  if (!idx.fileById.has(from) || !idx.fileById.has(to)) return undefined;
  if (from === to) return { hops: [] };
  const prev = new Map<string, DependencyEdge>();
  const seen = new Set([from]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const e of idx.out.get(node) ?? []) {
      if (options.runtimeOnly && e.typeOnly) continue;
      if (seen.has(e.target)) continue;
      seen.add(e.target);
      prev.set(e.target, e);
      if (e.target === to) {
        const hops: PathHop[] = [];
        let cur = to;
        while (cur !== from) {
          const edge = prev.get(cur)!;
          hops.push({ source: edge.source, target: edge.target, line: edge.line, names: edge.names, typeOnly: edge.typeOnly, kind: edge.kind });
          cur = edge.source;
        }
        return { hops: hops.reverse() };
      }
      queue.push(e.target);
    }
  }
  return undefined;
}

/** `from`, then the file each hop leads to. */
export function pathFiles(from: string, result: PathResult): string[] {
  return result.hops.length ? [result.hops[0].source, ...result.hops.map((h) => h.target)] : [from];
}

/* -------------------------------------------------------------------------- */
/*                                     Who                                    */
/* -------------------------------------------------------------------------- */

const DAY = 24 * 3600 * 1000;
const BOT_RE = /\[bot\]|dependabot|renovate|github-actions|semantic-release/i;

export interface WhoOptions {
  /** Maximum number of experts (default 5). */
  limit?: number;
  /** "Now" for the recency weighting (tests). */
  now?: number;
}

/**
 * Who knows a file, folder, symbol or route: CODEOWNERS owners, and the people who changed it, weighted
 * by recency (Σ commits × e^(−days/180)); people without a commit in 90 days are `inactive`. A commit
 * that touches several of the files counts once (an initial import or a formatting pass is one commit).
 */
export function whoOf(data: QueryData, target: QueryTarget, options: WhoOptions = {}): WhoResult {
  const idx = buildIndex(data);
  const now = options.now ?? Date.now();
  const files = filesOfTarget(data, target)
    .map((id) => idx.fileById.get(id)!)
    .filter(Boolean);
  const myEmail = data.git?.userEmail?.toLowerCase();
  const weight = (date: number): number => Math.exp(-Math.max(0, (now - date) / DAY) / 180);
  let hasHistory = false;
  let lastCommit: WhoResult['lastCommit'];
  // The commits we know by hash: each file's latest ones, and the project's latest (with their paths).
  const ids = new Set(files.map((f) => f.id));
  const known = new Map<string, { date: number; author: string }>();
  const knownOnFile = new Map<string, Set<string>>(); // file → hashes
  const addKnown = (file: string, hash: string, date: number, author: string): void => {
    known.set(hash, { date, author });
    let set = knownOnFile.get(file);
    if (!set) knownOnFile.set(file, (set = new Set()));
    set.add(hash);
  };
  for (const f of files) {
    if (!f.git) continue;
    hasHistory = true;
    const recent = f.git.recent[0];
    if (recent && (!lastCommit || recent.date > lastCommit.date)) lastCommit = { ...recent, file: f.id };
    for (const c of f.git.recent) addKnown(f.id, c.hash, c.date, c.author);
  }
  for (const c of data.git?.commits ?? []) for (const p of c.paths) if (ids.has(p) && idx.fileById.get(p)?.git) addKnown(p, c.hash, c.date, c.author);

  interface Person { name: string; email?: string; hashes: Set<string>; older: number; olderScore: number; last: number; nameAt: number }
  const people = new Map<string, Person>();
  const byName = new Map<string, Person>();
  for (const f of files) {
    const g = f.git;
    if (!g) continue;
    const onFile = knownOnFile.get(f.id) ?? new Set<string>();
    const oldest = Math.min(...[...onFile].map((h) => known.get(h)!.date), g.lastModified);
    for (const a of g.authors) {
      if (BOT_RE.test(a.name)) continue;
      const key = a.email?.toLowerCase() || `name:${a.name}`;
      let p = people.get(key);
      if (!p) people.set(key, (p = { name: a.name, email: a.email, hashes: new Set(), older: 0, olderScore: 0, last: 0, nameAt: 0 }));
      byName.set(a.name, p);
      if (a.last >= p.nameAt) {
        p.name = a.name;
        p.nameAt = a.last;
      }
      p.last = Math.max(p.last, a.last);
      // Commits older than the ones we know by hash: at most as recent as the oldest known one. The same
      // old commit may have touched several files, so take the largest count, not the sum.
      const knownHere = [...onFile].filter((h) => known.get(h)!.author === a.name).length;
      const older = Math.max(0, a.commits - knownHere);
      if (older > p.older) {
        p.older = older;
        p.olderScore = older * weight(Math.min(oldest, a.last));
      }
    }
  }
  for (const [hash, c] of known) {
    if (BOT_RE.test(c.author)) continue;
    let p = byName.get(c.author);
    // Someone beyond a file's top authors: known only by their commits.
    if (!p) people.set(`name:${c.author}`, (p = { name: c.author, hashes: new Set(), older: 0, olderScore: 0, last: 0, nameAt: 0 }));
    byName.set(c.author, p);
    p.hashes.add(hash);
    p.last = Math.max(p.last, c.date);
  }
  const scored = [...people.values()].map((p) => {
    let score = p.olderScore;
    for (const h of p.hashes) score += weight(known.get(h)!.date);
    return { ...p, score, commits: p.hashes.size + p.older };
  });
  const total = scored.reduce((n, p) => n + p.score, 0);
  const ranked = scored.sort((a, b) => b.score - a.score || b.commits - a.commits || a.name.localeCompare(b.name));
  let busFactor: number | undefined;
  if (total > 0) {
    let sum = 0;
    busFactor = 0;
    for (const p of ranked) {
      sum += p.score;
      busFactor++;
      // Compare rounded shares: an exact 50/50 split (two people) must not read as one.
      if (Math.round((sum / total) * 100) > 50) break;
    }
  }
  const experts: Expert[] = ranked.slice(0, Math.max(1, options.limit ?? 5)).map((p) => {
    const e: Expert = {
      name: p.name,
      score: Math.round(p.score * 100) / 100,
      commits: p.commits,
      last: p.last,
      inactive: now - p.last > 90 * DAY,
      share: total > 0 ? Math.round((p.score / total) * 100) / 100 : 0,
    };
    if (p.email) e.email = p.email;
    if (myEmail ? p.email?.toLowerCase() === myEmail : data.git?.user === p.name) e.me = true;
    return e;
  });
  const ownerCounts = new Map<string, number>();
  for (const f of files) for (const o of f.owners ?? []) ownerCounts.set(o, (ownerCounts.get(o) ?? 0) + 1);
  if (!ownerCounts.size && target.type === 'dir') {
    for (const o of data.folders?.find((x) => x.path === target.id)?.owners ?? []) ownerCounts.set(o, 1);
  }
  const owners = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([o]) => o);
  return { target, files: files.length, owners, experts, busFactor, lastCommit, hasHistory };
}

/* -------------------------------------------------------------------------- */
/*                                Routes, tests                               */
/* -------------------------------------------------------------------------- */

/**
 * The routes that serve a request. Without a method, every method matches (and pages); `GET` also
 * matches pages. Exact path matches win over base-URL suffix matches, which are only returned when
 * nothing matches exactly.
 */
export function routeFor(data: QueryData, method: string | undefined, url: string): RouteMatch[] {
  const idx = buildIndex(data);
  const m = method?.toUpperCase();
  const callSegs = segments(requestPath(url.trim()));
  const scored: { route: RouteInfo; score: number; exact: boolean }[] = [];
  for (const route of data.routes) {
    const routeSegs = segments(route.path);
    const score = routeScore(route, routeSegs, m ?? 'GET', callSegs, { pages: !m || m === 'GET' || m === 'PAGE', anyMethod: !m });
    if (score > 0) scored.push({ route, score, exact: match(routeSegs, callSegs).score > 0 });
  }
  const anyExact = scored.some((s) => s.exact);
  return scored
    .filter((s) => s.exact || !anyExact)
    .sort((a, b) => b.score - a.score || a.route.method.localeCompare(b.route.method))
    .map(({ route, score, exact }) => {
      const handlerRef = route.handlerSymbol ? symbolRef(data, route.handlerSymbol) : undefined;
      const handler = handlerRef
        ? { file: handlerRef.file.id, line: handlerRef.line, symbol: handlerRef.id }
        : { file: route.file, line: route.line };
      const callers = httpSites(idx.apiByRoute.get(route.id) ?? []).sort(bySite);
      const tests = new Set<string>();
      for (const f of new Set([route.file, handler.file])) for (const t of idx.fileById.get(f)?.tests ?? []) tests.add(t);
      for (const c of callers) if (idx.fileById.get(c.file)?.kind === 'test') tests.add(c.file);
      for (const t of visitingTests(data).get(route.id) ?? []) if (isTestEntry(t, data.project?.testRunners)) tests.add(t);
      return {
        route,
        label: routeLabel(route),
        exact,
        score,
        handler,
        middlewares: route.middlewares ?? [],
        appMiddlewares: appMiddlewaresFor(data, route, callSegs),
        callers,
        tests: [...tests].sort(),
      };
    });
}

/** Express error middleware: four parameters (`(err, req, res, next)`), or named like one. */
function isErrorHandler(ref: SymbolRef | undefined, label: string): boolean {
  const params = ref?.member ? ref.member.params : ref?.symbol.params;
  return params?.length === 4 || /error[-_]?handler/i.test(label);
}

/**
 * Middleware routes (`app.use(fn)`, Next.js middleware) and mount middlewares whose path prefixes the
 * request, at their declaration (or registration, when the function is not known). Error handlers are
 * flagged: they run only when something fails.
 */
function appMiddlewaresFor(data: QueryData, route: RouteInfo, callSegs: string[]): RouteMatch['appMiddlewares'] {
  const result: RouteMatch['appMiddlewares'] = [];
  for (const r of data.routes) {
    if (r === route) continue;
    const isMiddleware = r.type === 'middleware';
    if (!isMiddleware && !(r.type === 'mount' && r.middlewares?.length)) continue;
    const prefix = segments(r.path);
    if (prefix.length > callSegs.length || (prefix.length && !match(prefix, callSegs.slice(0, prefix.length)).score)) continue;
    if (isMiddleware) {
      const ref = r.handlerSymbol ? symbolRef(data, r.handlerSymbol) : undefined;
      const label = r.handler ?? (r.handlerSymbol ? topName(r.handlerSymbol) : 'middleware');
      const entry: RouteMatch['appMiddlewares'][number] = ref ? { label, file: ref.file.id, line: ref.line } : { label, file: r.file, line: r.line };
      if (isErrorHandler(ref, label)) entry.onError = true;
      result.push(entry);
    }
    for (const name of r.middlewares ?? []) result.push({ label: name, file: r.file, line: r.line });
  }
  return result;
}

const HTTP_TESTED = new WeakMap<object, Set<string>>();
const VISITING = new WeakMap<object, Map<string, string[]>>();
const ROUTE_REACH = new WeakMap<object, Map<string, string[]>>();
const TEST_IMPORTERS = new WeakMap<object, Map<string, string[]>>();

/** The parts of an analysis that say which tests reach which files. */
type TestReachData = Pick<QueryData, 'files' | 'routes'> & Partial<Pick<QueryData, 'edges' | 'apiCalls'>>;

/** Test files that import `helper` at runtime (transitively, through other test files), the helper itself included. */
function testUsers(data: TestReachData, helper: string): string[] {
  let importers = TEST_IMPORTERS.get(data);
  if (!importers) {
    importers = new Map();
    const kinds = new Map(data.files.map((f) => [f.id, f.kind]));
    for (const e of data.edges ?? []) if (!e.typeOnly && kinds.get(e.source) === 'test') push(importers, e.target, e.source);
    TEST_IMPORTERS.set(data, importers);
  }
  const seen = new Set([helper]);
  const queue = [helper];
  for (let i = 0; i < queue.length; i++) {
    for (const s of importers.get(queue[i]) ?? []) {
      if (seen.has(s)) continue;
      seen.add(s);
      queue.push(s);
    }
  }
  return [...seen];
}

/**
 * test-intelligence: route id → test files that visit or request it by URL (`FileInfo.urlVisits`: e2e
 * specs reach routes over HTTP, not through imports). A visit in a page object or support file also
 * counts for the test files that import it (with `edges`). Memoized per analysis.
 */
export function visitingTests(data: Pick<QueryData, 'files' | 'routes'> & Partial<Pick<QueryData, 'edges'>>): Map<string, string[]> {
  const cached = VISITING.get(data);
  if (cached) return cached;
  const result = new Map<string, string[]>();
  const routes = data.routes.filter((r) => r.type === 'api' || r.type === 'page');
  for (const f of data.files) {
    if (f.kind !== 'test' || !f.urlVisits?.length) continue;
    const visited = routes.filter((r) => f.urlVisits!.some((v) => visitMatchesRoute(r, v)));
    if (!visited.length) continue;
    const users = testUsers(data, f.id);
    for (const r of visited) for (const t of users) if (!result.get(r.id)?.includes(t)) push(result, r.id, t);
  }
  VISITING.set(data, result);
  return result;
}

/** The file whose code a route runs: its handler's, or for an inline handler the file that registers it. */
export function routeCodeFile(r: Pick<RouteInfo, 'file' | 'handlerSymbol'>): string {
  return r.handlerSymbol ? fileOfSymbol(r.handlerSymbol) : r.file;
}

/** Layout routes whose path starts the page's (`/users` for `/users/[id]`). */
function layoutsAbove(layouts: readonly RouteInfo[], page: RouteInfo): RouteInfo[] {
  const segs = segments(page.path);
  return layouts.filter((l) => segments(l.path).every((s, i) => segs[i] === s));
}

/**
 * Routes whose code a change affects — the `route-e2e` rule of `code-visualizer test`, which `tests-for`,
 * impact, My changes and the live guard follow too: the handler's file (for an inline handler, the file
 * registering it) is among `affected` (the changed files and everything that imports them at runtime), or
 * the registration itself changed; pages below an affected layout as well. A router file that is affected
 * only because it imports every controller does not make all of its routes affected.
 */
export function routesAffectedBy(routes: readonly RouteInfo[], affected: ReadonlySet<string>, changed: ReadonlySet<string>): RouteInfo[] {
  const result = new Set<RouteInfo>();
  const layouts: RouteInfo[] = [];
  for (const r of routes) {
    if (r.type === 'mount' || r.type === 'middleware') continue;
    if (!affected.has(routeCodeFile(r)) && !changed.has(r.file)) continue;
    if (r.type === 'layout') layouts.push(r);
    else result.add(r);
  }
  for (const r of routes) if (r.type === 'page' && !result.has(r) && layoutsAbove(layouts, r).length) result.add(r);
  return [...result];
}

/**
 * File → the tests that reach it through routes: a test requests (supertest, fetch) or visits (`page.goto`,
 * `cy.visit`) a route — itself, or through a page object or helper it imports — whose code imports the
 * file, directly or through other files (runtime imports). The reverse of `routesAffectedBy`: exactly the
 * tests `code-visualizer test` selects as `route-e2e` when the file changes. Memoized per analysis.
 */
export function routeTestReach(data: TestReachData): Map<string, string[]> {
  const cached = ROUTE_REACH.get(data);
  if (cached) return cached;
  const kinds = new Map(data.files.map((f) => [f.id, f.kind]));
  const requested = new Map<string, Set<string>>();
  const request = (route: string, tests: Iterable<string>): void => {
    const set = requested.get(route) ?? new Set<string>();
    for (const t of tests) set.add(t);
    requested.set(route, set);
  };
  for (const c of data.apiCalls ?? []) if (c.route && kinds.get(c.file) === 'test') request(c.route, testUsers(data, c.file));
  for (const [route, tests] of visitingTests(data)) request(route, tests);
  const deps = new Map<string, string[]>();
  for (const e of data.edges ?? []) if (!e.typeOnly) push(deps, e.source, e.target);
  const closures = new Map<string, string[]>();
  /** A file and everything it imports at runtime. */
  const closure = (start: string): string[] => {
    let known = closures.get(start);
    if (known) return known;
    const seen = new Set([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const t of deps.get(queue[i]) ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        queue.push(t);
      }
    }
    closures.set(start, (known = [...seen]));
    return known;
  };
  const reach = new Map<string, Set<string>>();
  const mark = (file: string, tests: Set<string>): void => {
    const set = reach.get(file) ?? new Set<string>();
    for (const t of tests) set.add(t);
    reach.set(file, set);
  };
  const layouts = data.routes.filter((r) => r.type === 'layout');
  for (const r of data.routes) {
    const tests = requested.get(r.id);
    if (!tests?.size || r.type === 'mount' || r.type === 'middleware') continue;
    // Its registration, its code and what that imports; a page also runs the layouts above it.
    mark(r.file, tests);
    for (const owner of [r, ...(r.type === 'page' ? layoutsAbove(layouts, r) : [])]) {
      if (owner !== r) mark(owner.file, tests);
      for (const file of closure(routeCodeFile(owner))) mark(file, tests);
    }
  }
  const result = new Map([...reach].map(([file, tests]) => [file, [...tests].sort()]));
  ROUTE_REACH.set(data, result);
  return result;
}

/**
 * Files a test reaches without importing them: the code of routes that tests request over HTTP
 * (supertest, fetch in e2e tests) or visit (`page.goto`, `cy.visit`), and everything that code imports
 * (see `routeTestReach`). Cheap (no index) and memoized per analysis, so the live guard can ask on every save.
 */
export function httpTestedFiles(data: TestReachData): Set<string> {
  const cached = HTTP_TESTED.get(data);
  if (cached) return cached;
  const files = new Set(routeTestReach(data).keys());
  HTTP_TESTED.set(data, files);
  return files;
}

/**
 * Why a source file counts as reached by a test — the one rule behind `tests-for`, impact, My changes,
 * `pr`, the change risk, the live guard and the detail panel: `imports` (a test imports it, directly or
 * through other files), `route` (a test requests or visits a route whose code imports it), `coverage` (the
 * local coverage report saw its lines run, however the tests load it). Undefined: nothing does.
 */
export function testEvidence(data: TestReachData, f: Pick<FileInfo, 'id' | 'tests' | 'coverage'>): 'imports' | 'route' | 'coverage' | undefined {
  if (f.tests?.length) return 'imports';
  if (httpTestedFiles(data).has(f.id)) return 'route';
  if (f.coverage?.lines.covered) return 'coverage';
  return undefined;
}

/**
 * Changed source files no test reaches (`testEvidence`): no test imports them, none requests or visits a
 * route whose code uses them, and the local coverage report saw none of their lines run. Deleted files and
 * comment-only edits need no test. My changes, the PR description and the MCP `review_changes` tool share it.
 */
export function untestedChanges(data: TestReachData & { changes?: Pick<ChangeSet, 'files' | 'commentOnly'> }): string[] {
  const c = data.changes;
  if (!c) return [];
  const byId = new Map(data.files.map((f) => [f.id, f]));
  const commentOnly = new Set(c.commentOnly ?? []);
  return c.files
    .filter((f) => f.status !== 'deleted' && !commentOnly.has(f.id))
    .map((f) => byId.get(f.id))
    .filter((f): f is FileInfo => !!f && isTestableSource(f) && !testEvidence(data, f))
    .map((f) => f.id);
}

/**
 * Tests to run for files, folders, symbols or routes (plain paths are resolved like `resolveTarget`).
 * A symbol stands for its file here; `impactOf` gives the tests that reach a symbol's users.
 */
export function testsFor(data: QueryData, inputs: (string | QueryTarget)[]): TestsForResult {
  const idx = buildIndex(data);
  const runners = data.project?.testRunners;
  const all = new Set<string>();
  const unknown: string[] = [];
  const untested = new Set<string>();
  const byPath: TestsForResult['byPath'] = [];
  for (const input of inputs) {
    const target = typeof input === 'string' ? resolveTarget(data, input).target : input;
    const label = typeof input === 'string' ? input : targetLabel(data, input);
    const files = target ? filesOfTarget(data, target) : [];
    if (!target || !files.length) {
      unknown.push(label);
      continue;
    }
    const tests = new Set<string>();
    for (const id of files) {
      const f = idx.fileById.get(id)!;
      if (f.kind === 'test') tests.add(f.id);
      for (const t of f.tests ?? []) tests.add(t);
      // A test support file (helper, fixture builder): the tests that import it.
      if (f.kind === 'test' && !isTestEntry(f.id, runners)) {
        for (const dep of transitive(data, f.id, 'dependents').keys()) if (idx.fileById.get(dep)?.kind === 'test') tests.add(dep);
      }
    }
    // A route: tests that request it over HTTP (supertest, fetch in e2e tests) or visit it reach its handler too.
    // So do the tests of routes whose code uses a file (`tests-for lib/pricing.ts`), as `code-visualizer test` selects them.
    if (target.type === 'route') {
      for (const c of idx.apiByRoute.get(target.id) ?? []) if (idx.fileById.get(c.file)?.kind === 'test') tests.add(c.file);
      for (const t of visitingTests(data).get(target.id) ?? []) tests.add(t);
    }
    for (const id of files) for (const t of routeTestReach(data).get(id) ?? []) tests.add(t);
    const list = [...tests].filter((t) => isTestEntry(t, runners)).sort();
    for (const id of files) {
      const f = idx.fileById.get(id)!;
      if (!isTestableSource(f) || f.tests?.some((t) => isTestEntry(t, runners))) continue;
      if (target.type === 'route' && list.length) continue;
      if (testEvidence(data, f)) continue;
      untested.add(f.id);
    }
    list.forEach((t) => all.add(t));
    byPath.push({ path: label, tests: list });
  }
  const files = [...all].sort();
  const cmd = buildTestCommand(files, runners);
  return { files, command: cmd.command, runner: cmd.runner, untested: [...untested].sort(), unknown, byPath };
}
