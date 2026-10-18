/**
 * Review mode: the order in which to read a change. Pure — shared by `code-visualizer review`, `pr`
 * (the "Review path" of your own change), the live server and the report UI.
 *
 * Files are read in dependency order: contracts and the code other changed files build on come first,
 * their users after them, and each test right after the code it covers. Independent changes (connected
 * components of the changed files) are read one after the other, riskiest first. Lockfiles, snapshots,
 * generated files and pure renames only need a glance ("skim").
 */
import { exportChangeLabel, exportName } from './delta.js';
import { httpTestedFiles } from './query.js';
import { tarjan } from './scc.js';
import { compactSignature } from './signature.js';
import { isTestableSource } from './testcmd.js';
import type { ApiCall, ArchitectureDelta, ChangedFile, ChangeSet, DependencyEdge, ExportChange, FileInfo, ReviewPlan, ReviewRole, ReviewStep, RouteInfo } from './types.js';

/** The parts of an analysis (of the reviewed head) a plan needs. */
export interface ReviewData {
  files: FileInfo[];
  edges: DependencyEdge[];
  routes?: RouteInfo[];
  apiCalls?: ApiCall[];
}

/** The parts of a change set a plan needs (`files` with their diffs; the rest is optional). */
export type ReviewChanges = Pick<ChangeSet, 'files'> & Partial<Pick<ChangeSet, 'symbols' | 'commentOnly' | 'commits' | 'additions' | 'deletions'>>;

export interface ReviewPlanOptions {
  /** Place each test before the code it covers (read what it should do first). */
  testFirst?: boolean;
  /** Meaningful lines of a change (default `meaningfulLines`; analyze() passes one memoized per diff). */
  lines?: (file: ChangedFile) => number;
  ref?: string;
  base?: string;
  mergeBase?: string;
  head?: string;
}

/** Meaningful lines read per hour of review (SmartBear / Cisco: 200–400 LOC/h keeps defect detection high). */
export const REVIEW_LINES_PER_HOUR = 400;
/** Upper bounds of effort levels 1–4 in meaningful lines; above the last is level 5. */
export const EFFORT_LEVELS = [50, 200, 400, 800] as const;

const ROLE_RANK: Record<ReviewRole, number> = { contract: 0, core: 1, consumer: 2, config: 3, other: 4, test: 5, mechanical: 6 };
const MAX_REASONS = 4;

const LOCKFILE_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Podfile\.lock|flake\.lock|uv\.lock|Pipfile\.lock)$/;
const SNAPSHOT_RE = /(^|\/)__snapshots__\/|\.snap$/;
const GENERATED_RE = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|\.output|generated|__generated__)\/|\.generated\.|\.gen\.[cm]?[jt]sx?$|\.pb\.(go|[cm]?[jt]s)$|_pb2?(_grpc)?\.(py|[cm]?[jt]s)$/;
const MINIFIED_RE = /\.min\.(m?js|css)$|\.(js|css)\.map$/;
const BINARY_RE = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|jar|mp[34]|mov|webm|wav|ogg|wasm|node|dylib|so|dll|exe)$/i;
const CONTRACT_FILE_RE = /\.(graphql|gql|proto|prisma|avsc|thrift)$|(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$|\.schema\.json$/i;
const SCHEMA_SOURCE_RE = /(^|\/)(schemas?|contracts?|dtos?)(\/|\.[cm]?[jt]sx?$)|\.(schema|schemas|dto|contract|zod)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
const CONFIG_FILE_RE =
  /(^|\/)(package\.json|[tj]sconfig[^/]*\.json|\.env(\.[\w.-]+)?|\.npmrc|\.nvmrc|\.node-version|\.tool-versions|Dockerfile[^/]*|docker-compose[^/]*|compose\.ya?ml|Makefile|Procfile|CODEOWNERS|\.editorconfig|\.gitignore|\.gitattributes|\.prettierignore|\.eslintignore|[^/]*rc(\.json|\.ya?ml|\.[cm]?js)?|[^/]+\.config\.[cm]?[jt]s|[^/]+\.(ya?ml|toml|ini|cfg))$|(^|\/)\.(github|gitlab|circleci|husky|vscode|devcontainer)\//;
const DOC_RE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const STYLE_RE = /\.(css|scss|sass|less|styl|pcss)$/i;
const TYPE_KINDS = new Set(['interface', 'type', 'enum']);
const FUNCTION_KINDS = new Set(['function', 'method', 'component', 'hook', 'class']);

const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;
const dirName = (id: string): string => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '');
const callable = (name: string, kind?: string): string => (kind && FUNCTION_KINDS.has(kind) && kind !== 'class' ? `${name}()` : name);

const HASH_COMMENT_RE = /(^|\/)(Dockerfile[^/]*|Makefile|Procfile|\.env(\.[\w.-]+)?|\.gitignore|\.gitattributes|\.npmrc|[^/]*ignore)$|\.(ya?ml|toml|ini|cfg|conf|sh|bash|zsh|py|rb|pl|r)$/i;
const MARKUP_RE = /\.(html?|vue|svelte|astro|xml|svg|mdx?)$/i;

/** Whether a changed line (trimmed, without the +/-) is only a comment, given the file type and an open block comment. */
function commentLine(text: string, hashComments: boolean, markup: boolean, block: { open: boolean }): boolean {
  if (block.open) {
    if (text.includes('*/')) {
      block.open = false;
      return !text.slice(text.indexOf('*/') + 2).trim();
    }
    return true;
  }
  if (hashComments) return text.startsWith('#');
  if (markup && /^<!--.*-->$/.test(text)) return true;
  if (text.startsWith('//') || text.startsWith('*/') || /^\*(\s|$)/.test(text)) return true;
  if (text.startsWith('/*')) {
    const close = text.indexOf('*/', 2);
    if (close === -1) {
      block.open = true;
      return true;
    }
    return !text.slice(close + 2).trim();
  }
  return false;
}

/**
 * Added and removed lines of a unified diff that are not blank and not only a comment. Without a diff
 * (binary files, untracked files, a truncated diff) the line counts of the change are used.
 */
export function meaningfulLines(file: Pick<ChangedFile, 'id' | 'diff' | 'additions' | 'deletions'>): number {
  if (!file.diff || file.diff.includes('\n… diff truncated …')) return file.additions + file.deletions;
  const hash = HASH_COMMENT_RE.test(file.id);
  const markup = MARKUP_RE.test(file.id);
  const docs = DOC_RE.test(file.id);
  let count = 0;
  let inHunk = false;
  // Added and removed lines are separate texts: each keeps its own open block comment.
  const blocks = { '+': { open: false }, '-': { open: false } };
  for (const line of file.diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      blocks['+'].open = blocks['-'].open = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    const sign = line[0];
    if (sign !== '+' && sign !== '-') continue;
    const text = line.slice(1).trim();
    if (!text) continue;
    if (!docs && commentLine(text, hash, markup, blocks[sign])) continue;
    count++;
  }
  return count;
}

/** Effort to review this many meaningful lines: minutes at 400 lines per hour and a level from 1 to 5. */
export function reviewEffort(lines: number): ReviewPlan['effort'] {
  const level = (EFFORT_LEVELS.findIndex((max) => lines <= max) + 1 || 5) as 1 | 2 | 3 | 4 | 5;
  const minutes = lines > 0 ? Math.max(1, Math.round((lines * 60) / REVIEW_LINES_PER_HOUR)) : 0;
  return { minutes, level, meaningfulLines: lines };
}

/** Why a file only needs a glance (undefined when it needs reading). */
export function skimReason(f: ChangedFile, info: FileInfo | undefined, commentOnly: boolean): string | undefined {
  if (LOCKFILE_RE.test(f.id)) return 'lockfile';
  if (SNAPSHOT_RE.test(f.id)) return 'test snapshot';
  if (info?.isGenerated || GENERATED_RE.test(f.id)) return 'generated file';
  if (MINIFIED_RE.test(f.id)) return 'minified or source map';
  if (BINARY_RE.test(f.id) || (!f.diff && f.additions + f.deletions === 0 && f.status !== 'renamed' && f.status !== 'deleted' && f.status !== 'untracked')) return 'binary file';
  if (f.status === 'renamed' && f.additions + f.deletions <= 2) return f.oldPath ? `renamed from ${f.oldPath}${f.additions + f.deletions ? ` (${plural(f.additions + f.deletions, 'line')} changed)` : ''}` : 'renamed';
  if (commentOnly) return 'only comments or blank lines changed';
  return undefined;
}

interface Node {
  file: string;
  change: ChangedFile;
  info?: FileInfo;
  role: ReviewRole;
  lines: number;
  /** Changed symbols (names) and their kinds. */
  symbols: { id: string; name: string; kind: string; usedBy: number; exported: boolean }[];
  usedBy: number;
  complexity: number;
  untested: boolean;
  /** Raw risk before normalization. */
  raw: number;
  reasons: string[];
  /** How many reasons need attention before merging (breaking API changes, new cycles, rule breaks…). */
  urgent: number;
  /** How many reasons are urgent or notable (the rest is context: where the file sits, what it adds). */
  headline: number;
  /** Tests that cover it (changed tests only). */
  tests: string[];
  group?: number;
}

/** Contract, config, other or (for analyzed source files) undefined: core or consumer is decided by topology. */
function fileRole(n: Pick<Node, 'file' | 'info' | 'symbols'>): ReviewRole | undefined {
  const { file, info } = n;
  if (!info) {
    if (CONTRACT_FILE_RE.test(file)) return 'contract';
    if (CONFIG_FILE_RE.test(file)) return 'config';
    return 'other';
  }
  if (info.kind === 'test' || info.isTest) return 'test';
  if (info.kind === 'config') return 'config';
  if (info.kind === 'types' || SCHEMA_SOURCE_RE.test(file)) return 'contract';
  const kinds = n.symbols.length ? n.symbols : info.symbols.map((s) => ({ kind: s.kind, name: s.name }));
  // Only types changed (or only `fooSchema` constants: zod / yup / valibot schemas).
  if (kinds.length && kinds.every((s) => TYPE_KINDS.has(s.kind) || (s.kind === 'constant' && /Schema$/.test(s.name)))) return 'contract';
  return undefined;
}

/** Union-find over file ids. */
function unionFind(ids: Iterable<string>): { find: (x: string) => string; union: (a: string, b: string) => void } {
  const parent = new Map<string, string>();
  for (const id of ids) parent.set(id, id);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let k = x; k !== r; ) {
      const next = parent.get(k)!;
      parent.set(k, r);
      k = next;
    }
    return r;
  };
  return {
    find,
    union(a, b) {
      const [ra, rb] = [find(a), find(b)];
      // Deterministic: the smaller id is the representative.
      if (ra !== rb) ra < rb ? parent.set(rb, ra) : parent.set(ra, rb);
    },
  };
}

/** Every node's component (cyclic components have more than one member), dependencies first. */
function components(nodes: string[], adj: Map<string, string[]>): string[][] {
  return tarjan(nodes, (node) => adj.get(node) ?? []);
}

/** Sorted insert into `list` by `compare` (binary search; ties keep insertion order). */
function insertSorted<T>(list: T[], item: T, compare: (a: T, b: T) => number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(list[mid], item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, item);
}

/**
 * Dependency order of the files of one group: strongly connected components collapsed, then Kahn's
 * topological sort with imported files before their importers; ties by role, how widely the changed
 * symbols are used, and meaningful lines (descending), then path.
 */
function topologicalOrder(members: Node[], importsOf: (file: string) => string[]): Node[] {
  const byFile = new Map(members.map((n) => [n.file, n]));
  const key = (a: Node, b: Node): number => ROLE_RANK[a.role] - ROLE_RANK[b.role] || b.usedBy - a.usedBy || b.lines - a.lines || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  const sortedFiles = [...members].sort(key).map((n) => n.file);
  const adj = new Map<string, string[]>();
  for (const f of sortedFiles) adj.set(f, importsOf(f).filter((t) => byFile.has(t) && t !== f).sort());
  const comps = components(sortedFiles, adj).map((c) => c.map((f) => byFile.get(f)!).sort(key));
  const compOf = new Map<string, number>();
  comps.forEach((c, i) => c.forEach((n) => compOf.set(n.file, i)));
  // Edge imported → importer: the imported component must be read first.
  const indegree = new Array<number>(comps.length).fill(0);
  const dependents = comps.map(() => new Set<number>());
  for (const [file, targets] of adj) {
    const from = compOf.get(file)!;
    for (const t of targets) {
      const to = compOf.get(t)!;
      if (to === from || dependents[to].has(from)) continue;
      dependents[to].add(from);
      indegree[from]++;
    }
  }
  const compKey = (a: number, b: number): number => key(comps[a][0], comps[b][0]);
  const ready: number[] = [];
  comps.forEach((_, i) => indegree[i] === 0 && insertSorted(ready, i, compKey));
  const order: Node[] = [];
  while (ready.length) {
    const c = ready.shift()!;
    order.push(...comps[c]);
    for (const d of dependents[c]) if (--indegree[d] === 0) insertSorted(ready, d, compKey);
  }
  return order;
}

/** The longest common folder of some files ('' when they share none). */
function commonDir(files: string[]): string {
  if (!files.length) return '';
  let parts = dirName(files[0]).split('/').filter(Boolean);
  for (const f of files.slice(1)) {
    const other = dirName(f).split('/');
    let i = 0;
    while (i < parts.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/');
}

function routeLabel(r: Pick<RouteInfo, 'method' | 'path'>): string {
  return `${r.method} ${r.path}`;
}

/**
 * `service.ts`, `api/index.ts`: as much of each path as it takes to tell it apart from the others (like
 * `shortNames` in delta.ts, but linear: one count per path suffix instead of comparing every pair).
 */
export function shortNamer(ids: string[]): (id: string) => string {
  const counts = new Map<string, number>();
  for (const id of new Set(ids)) {
    const parts = id.split('/');
    for (let k = 1; k <= parts.length; k++) {
      const suffix = parts.slice(-k).join('/');
      counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
    }
  }
  const cache = new Map<string, string>();
  return (id) => {
    let name = cache.get(id);
    if (name === undefined) {
      const parts = id.split('/');
      let k = 1;
      while (k < parts.length && (counts.get(parts.slice(-k).join('/')) ?? 0) > 1) k++;
      name = parts.slice(-k).join('/');
      cache.set(id, name);
    }
    return name;
  };
}

/** Parameter names of a declaration (`formatDate(iso, locale?)` → ['iso', 'locale']); undefined when it has none. */
function parameterNames(sig: string | undefined): string[] | undefined {
  if (!sig) return undefined;
  const compact = compactSignature(sig);
  const open = compact.indexOf('(');
  const close = compact.lastIndexOf(')');
  if (open <= 0 || close < open) return undefined;
  const inner = compact.slice(open + 1, close).trim();
  return inner ? inner.split(',').map((p) => p.trim().replace(/^\.\.\./, '').replace(/\?$/, '')) : [];
}

/** Whether a compatible signature change only appends parameters (the existing ones keep their names). */
function appendsParameters(before: string | undefined, after: string | undefined): boolean {
  const was = parameterNames(before);
  const is = parameterNames(after);
  return !!was && !!is && is.length > was.length && was.every((name, i) => is[i] === name);
}

/** Why each file matters, most important first (from the architecture delta, routes, complexity, tests, owners). */
function addReasons(nodes: Node[], data: ReviewData, delta: ArchitectureDelta | undefined, changedSources: Set<string>, importedBy: Map<string, string[]>, imports: Map<string, string[]>, short: (id: string) => string): void {
  const exportsByFile = new Map<string, ExportChange[]>();
  // Exports added to files that existed before: "adds X" rather than "changes X".
  const addedExports = new Map<string, Set<string>>();
  for (const e of delta?.exports ?? []) {
    if (e.change !== 'added') exportsByFile.set(e.file, [...(exportsByFile.get(e.file) ?? []), e]);
    else addedExports.set(e.file, (addedExports.get(e.file) ?? new Set()).add(e.name));
  }
  const added = new Set(delta?.routes.added ?? []);
  const newRoutes = new Map<string, string[]>();
  for (const r of data.routes ?? []) {
    const label = routeLabel(r);
    if (added.has(label) && r.type !== 'middleware' && r.type !== 'mount') newRoutes.set(r.file, [...new Set([...(newRoutes.get(r.file) ?? []), label])]);
  }
  const complexity = new Map<string, NonNullable<ArchitectureDelta['complexity']>>();
  for (const c of delta?.complexity ?? []) complexity.set(c.file, [...(complexity.get(c.file) ?? []), c]);
  const newCycleMembers = new Map<string, string[]>();
  for (const cycle of delta?.newCycles ?? []) for (const f of cycle) newCycleMembers.set(f, cycle);
  const violations = new Map<string, NonNullable<ArchitectureDelta['newViolations']>>();
  for (const v of delta?.newViolations ?? []) violations.set(v.source, [...(violations.get(v.source) ?? []), v]);
  // The owners most of the change belongs to: files owned by someone else are worth pointing out.
  const ownerCount = new Map<string, number>();
  for (const n of nodes) {
    const key = n.info?.owners?.join(', ');
    if (key) ownerCount.set(key, (ownerCount.get(key) ?? 0) + n.lines + 1);
  }
  const mainOwners = [...ownerCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const names = (files: string[]): string => `${files.slice(0, 2).map(short).join(', ')}${files.length > 2 ? ` +${files.length - 2}` : ''}`;
  const list = (symbols: Node['symbols']): string => `${symbols.slice(0, 3).map((s) => callable(s.name, s.kind)).join(', ')}${symbols.length > 3 ? ` +${symbols.length - 3}` : ''}`;

  for (const n of nodes) {
    const urgent: string[] = [];
    const notable: string[] = [];
    const context: string[] = [];
    for (const e of exportsByFile.get(n.file) ?? []) {
      const sym = n.symbols.find((s) => s.name === e.name || (e.name === 'default' && s.exported));
      const uses = Math.max(sym?.usedBy ?? 0, e.importers.length);
      if (e.change === 'signature') {
        const stale = e.staleCallSites.length ? `, ${plural(e.staleCallSites.length, 'call')} not updated` : '';
        const name = callable(exportName(e), sym?.kind ?? 'function');
        const used = uses ? ` used in ${plural(uses, 'place')}` : '';
        if (e.breaking) urgent.push(`changes signature of ${name}${used}${stale}`);
        // Only appended parameters extend a function; renamed or retyped ones change it (compatibly).
        else if (appendsParameters(e.before, e.after)) notable.push(`extends ${name} compatibly${uses ? ` (${used.trim()})` : ''}`);
        else notable.push(`changes signature of ${name} compatibly${uses ? ` (${used.trim()})` : ''}`);
      } else if (e.change === 'removed') {
        if (e.importers.length) urgent.push(`removes ${exportName(e)}, still imported by ${plural(e.importers.length, 'file')}`);
        else notable.push(`removes export ${exportName(e)}`);
      } else if (e.change === 'kind') (e.importers.length ? urgent : notable).push(`changes ${exportChangeLabel(e, true)}`);
    }
    for (const v of violations.get(n.file) ?? []) urgent.push(`breaks rule ${v.rule}: imports ${v.target}`);
    const cycle = newCycleMembers.get(n.file);
    if (cycle) urgent.push(`creates a new import cycle (${cycle.length} files)`);
    for (const label of newRoutes.get(n.file) ?? []) notable.push(`new route ${label}`);
    for (const c of (complexity.get(n.file) ?? []).sort((a, b) => b.after - b.before - (a.after - a.before)).slice(0, 2)) {
      const name = c.name.includes(' › ') ? c.name : `${c.name}()`;
      notable.push(c.before ? `${name} complexity ${c.before}→${c.after}` : `new ${name} with complexity ${c.after}`);
    }
    if (n.untested && n.role !== 'test') notable.push('untested');
    if (n.info?.inCycle && !cycle) context.push('inside an import cycle');
    if (mainOwners && n.info?.owners?.length && n.info.owners.join(', ') !== mainOwners) context.push(`owned by ${n.info.owners.join(', ')}`);
    const isNew = n.change.status === 'added' || n.change.status === 'untracked';
    if (isNew) context.push(`new file${n.lines ? ` (${plural(n.lines, 'line')})` : ''}`);
    else if (n.change.status === 'renamed' && n.change.oldPath) context.push(`renamed from ${n.change.oldPath}`);
    else if (n.change.status === 'deleted') context.push('deleted');
    const users = [...new Set((importedBy.get(n.file) ?? []).filter((f) => changedSources.has(f) && f !== n.file))];
    const uses = [...new Set((imports.get(n.file) ?? []).filter((f) => changedSources.has(f) && f !== n.file))];
    if (n.role === 'contract') context.push(users.length ? `types used by ${plural(users.length, 'changed file')}` : 'types and contracts');
    else if (n.role === 'core' && users.length) context.push(`${plural(users.length, 'changed file')} build${users.length === 1 ? 's' : ''} on it`);
    else if (n.role === 'consumer' && uses.length) context.push(`uses ${names(uses)}`);
    else if (n.role === 'test') context.push(n.tests.length ? `tests ${names(n.tests)}` : 'test');
    else if (n.role === 'config') context.push('configuration');
    else if (n.role === 'other') context.push(DOC_RE.test(n.file) ? 'documentation' : STYLE_RE.test(n.file) ? 'styles' : n.change.analyzed ? 'source' : 'not analyzed');
    const fanIn = n.info?.metrics.fanIn ?? 0;
    if ((n.role === 'core' || n.role === 'contract') && fanIn >= 3 && fanIn > users.length && !urgent.length && !users.length) context.push(`used by ${plural(fanIn, 'file')}`);
    // What changed, unless a reason above already names the functions: new exports are "added".
    if (!urgent.length && notable.every((r) => r === 'untested') && n.role !== 'test') {
      const changed = n.symbols.filter((s) => s.kind !== 'variable');
      const fresh = isNew ? changed : changed.filter((s) => addedExports.get(n.file)?.has(s.name));
      const modified = isNew ? [] : changed.filter((s) => !addedExports.get(n.file)?.has(s.name));
      if (fresh.length) context.push(`adds ${list(fresh)}`);
      if (modified.length) context.push(`changes ${list(modified)}`);
    }
    n.urgent = urgent.length;
    n.headline = urgent.length + notable.length;
    n.reasons = [...urgent, ...notable, ...context].slice(0, MAX_REASONS);
  }
}

/** `step 2`, `steps 1–3`, `steps 1, 4` */
function stepsLabel(orders: number[]): string {
  const sorted = [...new Set(orders)].sort((a, b) => a - b);
  if (sorted.length === 1) return `step ${sorted[0]}`;
  const contiguous = sorted.every((o, i) => i === 0 || o === sorted[i - 1] + 1);
  return contiguous ? `steps ${sorted[0]}–${sorted[sorted.length - 1]}` : `steps ${sorted.slice(0, 3).join(', ')}${sorted.length > 3 ? ' …' : ''}`;
}

/**
 * Start here: the main logical change of the riskiest independent change (Google's review guide: read
 * the main change first). That is the file with urgent reasons (a breaking API change, a new cycle, a
 * broken rule, a deleted file still in use), otherwise the largest logic change (meaningful lines ×
 * complexity) — not its types or tests, which the path lists before it as context.
 */
function startingPoint(steps: ReviewStep[], groups: ReviewPlan['groups'], nodeById: Map<string, Node>, imports: Map<string, string[]>, importedBy: Map<string, string[]>, changedSources: Set<string>, short: (id: string) => string): ReviewPlan['startHere'] {
  const group = groups.find((g) => g.kind === 'change' && steps.some((s) => s.group === g.index && s.role !== 'test'));
  const inGroup = steps.filter((s) => (group ? s.group === group.index : true) && s.role !== 'test');
  const logic = inGroup.filter((s) => s.role === 'core' || s.role === 'consumer');
  const candidates = logic.length ? logic : inGroup;
  if (!candidates.length) return undefined;
  const score = (s: ReviewStep): [number, number] => {
    const n = nodeById.get(s.file)!;
    return [n.urgent, n.lines * n.complexity];
  };
  const start = candidates.reduce((best, s) => {
    const [ua, la] = score(s);
    const [ub, lb] = score(best);
    return ua > ub || (ua === ub && la > lb) ? s : best;
  });
  // What the step is about (its urgent and notable reasons, then what it adds or changes), then where it
  // sits: what it builds on, or who builds on it.
  const { headline } = nodeById.get(start.file)!;
  const described = start.reasons.slice(headline).filter((r) => !/^uses |build(s)? on it$|^types used by |^types and contracts$|^(configuration|documentation|styles|source|test)$|^inside an import cycle$|^owned by /.test(r));
  const own = [...start.reasons.slice(0, headline), ...described].slice(0, 2);
  const orderOf = new Map(steps.map((s) => [s.file, s.order]));
  const deps = [...new Set(imports.get(start.file) ?? [])].filter((f) => f !== start.file && (orderOf.get(f) ?? Infinity) < start.order);
  const users = [...new Set(importedBy.get(start.file) ?? [])].filter((f) => f !== start.file && changedSources.has(f));
  const where = deps.length
    ? `builds on ${deps.slice(0, 2).map(short).join(' and ')}${deps.length > 2 ? ` +${deps.length - 2}` : ''} (${stepsLabel(deps.map((f) => orderOf.get(f)!))})`
    : users.length
      ? `${plural(users.length, 'changed file')} build${users.length === 1 ? 's' : ''} on it`
      : '';
  const reason = [...own, where].filter(Boolean).join('; ') || start.reasons.slice(0, 2).join('; ') || start.role;
  return { file: start.file, reason };
}

/** Recommend splitting only when at least two independent changes are big enough to review on their own. */
export const SPLIT_MIN_LINES = 20;

/** Whether the plan is worth splitting: two or more independent changes of at least SPLIT_MIN_LINES meaningful lines. */
export function suggestsSplit(plan: Pick<ReviewPlan, 'groups'>): boolean {
  return independentChanges(plan).filter((g) => g.lines >= SPLIT_MIN_LINES).length >= 2;
}

/**
 * The reading order of a change: steps in dependency order per independent change, start here, what to
 * skim, effort, API changes, untested functions and a checklist. `data` is the analysis of the head
 * (the reviewed ref, or your working tree); `delta` its comparison with the base, when available.
 */
export function reviewPlan(data: ReviewData, changes: ReviewChanges, delta?: ArchitectureDelta, options: ReviewPlanOptions = {}): ReviewPlan {
  const byId = new Map(data.files.map((f) => [f.id, f]));
  const commentOnly = new Set(changes.commentOnly ?? []);
  const symbolsByFile = new Map<string, Node['symbols']>();
  for (const s of changes.symbols ?? []) symbolsByFile.set(s.file, [...(symbolsByFile.get(s.file) ?? []), { id: s.id, name: s.name, kind: s.kind, usedBy: s.usedBy, exported: s.exported }]);
  // Removed exports that are still imported: a deleted file that breaks its users needs reading.
  const brokenByDeletion = new Set((delta?.exports ?? []).filter((e) => e.change === 'removed' && e.importers.length).map((e) => e.file));
  // Handlers a test requests over HTTP or visits by URL are tested (memoized per analysis; `edges` lets a
  // visit in a page object count for the specs that import it).
  const httpTested = data.routes ? httpTestedFiles(data as ReviewData & { routes: RouteInfo[] }) : new Set<string>();

  const skim: ReviewPlan['skim'] = [];
  const nodes: Node[] = [];
  for (const change of changes.files) {
    const info = change.status === 'deleted' ? undefined : byId.get(change.id);
    const reason = change.status === 'deleted' && !brokenByDeletion.has(change.id) ? `deleted (${plural(change.deletions, 'line')})` : skimReason(change, info, commentOnly.has(change.id));
    if (reason) {
      skim.push({ file: change.id, reason, blob: change.blob });
      continue;
    }
    const symbols = (symbolsByFile.get(change.id) ?? []).sort((a, b) => b.usedBy - a.usedBy);
    const n: Node = { file: change.id, change, info, role: 'core', lines: (options.lines ?? meaningfulLines)(change), symbols, usedBy: Math.max(0, ...symbols.map((s) => s.usedBy)), complexity: 1, untested: false, raw: 0, reasons: [], urgent: 0, headline: 0, tests: [] };
    n.role = change.status === 'deleted' ? 'core' : (fileRole(n) ?? 'core');
    if (info) {
      const fileSymbols = new Map(info.symbols.map((s) => [s.id, s]));
      const measured = symbols.map((s) => {
        const sym = fileSymbols.get(s.id) ?? fileSymbols.get(s.id.replace(/\.[^.#]+$/, ''));
        return Math.max(sym?.complexity ?? 0, sym?.nested?.complexity ?? 0);
      });
      n.complexity = Math.max(1, ...(measured.length ? measured : [info.maxComplexity]));
      // The same evidence as My changes' "no tests": imports, HTTP requests and URL visits, and lines a local coverage report saw run.
      n.untested = isTestableSource(info) && n.role !== 'contract' && n.role !== 'config' && !info.tests?.length && !httpTested.has(info.id) && !info.coverage?.lines.covered;
    }
    nodes.push(n);
  }

  // Graph of the changed files (any import, type-only too: types are read before their users).
  const nodeById = new Map(nodes.map((n) => [n.file, n]));
  const imports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  const link = (source: string, target: string): void => {
    const out = imports.get(source);
    if (out?.includes(target)) return;
    if (out) out.push(target);
    else imports.set(source, [target]);
    const into = importedBy.get(target);
    if (into) into.push(source);
    else importedBy.set(target, [source]);
  };
  const add = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const e of data.edges) {
    if (e.source === e.target || !nodeById.has(e.source) || !nodeById.has(e.target)) continue;
    link(e.source, e.target);
  }
  // A deleted file that is still imported is read before the changed files that import it.
  const brokenDeletion = (n: Node): boolean => n.change.status === 'deleted' && brokenByDeletion.has(n.file);
  for (const e of delta?.exports ?? []) {
    if (e.change !== 'removed' || !nodeById.get(e.file) || !brokenDeletion(nodeById.get(e.file)!)) continue;
    for (const importer of e.importers) if (importer !== e.file && nodeById.get(importer)?.info) link(importer, e.file);
  }
  const isSource = (n: Node): boolean => !!n.info && n.role !== 'test';
  const changedSources = new Set(nodes.filter(isSource).map((n) => n.file));
  // Core or consumer by topology: code other changed files build on is core; code that only uses them is a consumer.
  for (const n of nodes) {
    if (n.role !== 'core' || !n.info) continue;
    const users = (importedBy.get(n.file) ?? []).some((f) => changedSources.has(f));
    const uses = (imports.get(n.file) ?? []).some((f) => changedSources.has(f));
    if (!users && uses) n.role = 'consumer';
  }

  // Which changed sources each changed test covers: what it imports, directly or through unchanged files.
  const tests = nodes.filter((n) => n.role === 'test');
  const coveredBy = new Map<string, string[]>();
  // A test is placed next to what it imports directly; only a test that reaches changed code through
  // unchanged files is placed by what it reaches.
  const anchors = new Map<string, string[]>();
  const reaches = new Map<string, string[]>();
  for (const f of changedSources) for (const t of byId.get(f)?.tests ?? []) add(reaches, t, f);
  for (const t of tests) {
    const direct = [...new Set((imports.get(t.file) ?? []).filter((f) => changedSources.has(f)))].sort();
    const transitive = (reaches.get(t.file) ?? []).filter((f) => !direct.includes(f)).sort();
    t.tests = [...direct, ...transitive];
    anchors.set(t.file, direct.length ? direct : transitive);
    for (const f of t.tests) add(coveredBy, f, t.file);
  }
  for (const n of nodes) if (n.role !== 'test') n.tests = (coveredBy.get(n.file) ?? []).sort();

  // `service.ts, api/index.ts +2`: as much of each path as it takes to tell them apart.
  const short = shortNamer(nodes.map((n) => n.file));
  addReasons(nodes, data, delta, changedSources, importedBy, imports, short);

  // Independent changes: connected components of the changed files that are analyzed (and deleted
  // files that are still imported). Lone config files and everything outside the analysis (docs,
  // styles, package.json…) are read last, together.
  const inGraph = (n: Node): boolean => (!!n.info && n.change.status !== 'deleted') || brokenDeletion(n);
  const uf = unionFind(nodes.filter(inGraph).map((n) => n.file));
  for (const [source, targets] of imports) for (const t of targets) if (inGraph(nodeById.get(source)!) && inGraph(nodeById.get(t)!)) uf.union(source, t);
  // A test that reaches changed code only through unchanged files joins the code it covers best.
  for (const t of tests) {
    if ((imports.get(t.file) ?? []).some((f) => changedSources.has(f)) || !t.tests.length) continue;
    const best = t.tests.map((f) => nodeById.get(f)!).sort((a, b) => b.lines - a.lines || (a.file < b.file ? -1 : 1))[0];
    uf.union(t.file, best.file);
  }
  const groupsByRoot = new Map<string, Node[]>();
  const others: Node[] = [];
  for (const n of nodes) {
    const connected = inGraph(n) && ((imports.get(n.file)?.length ?? 0) + (importedBy.get(n.file)?.length ?? 0) > 0 || n.role !== 'config');
    if (!connected) {
      others.push(n);
      continue;
    }
    const root = uf.find(n.file);
    groupsByRoot.set(root, [...(groupsByRoot.get(root) ?? []), n]);
  }

  // Risk: churn share × complexity × users × untested (per file, then per group). Tests, configuration
  // and docs weigh less; what breaks the build or the architecture (urgent reasons) comes first.
  const totalLines = Math.max(1, nodes.reduce((sum, n) => sum + n.lines, 0));
  const weight = (n: Node): number => (n.role === 'test' ? 0.5 : n.role === 'config' || n.role === 'other' ? 0.3 : 1);
  for (const n of nodes) {
    const fanIn = n.info?.metrics.fanIn ?? 0;
    n.raw = (n.lines / totalLines) * n.complexity * (1 + Math.max(fanIn, n.usedBy)) * (n.untested ? 1.5 : 1) * weight(n);
  }
  // Each urgent reason outweighs any amount of ordinary churn (twice the largest plain risk).
  const maxBase = Math.max(1, ...nodes.map((n) => n.raw));
  for (const n of nodes) n.raw += n.urgent * 2 * maxBase;
  const groupRisk = (members: Node[]): number => {
    const lines = members.reduce((sum, n) => sum + n.lines * weight(n), 0);
    const complexity = Math.max(1, ...members.map((n) => n.complexity));
    const fanIn = Math.max(0, ...members.map((n) => Math.max(n.info?.metrics.fanIn ?? 0, n.usedBy)));
    return (lines / totalLines) * complexity * (1 + fanIn) * (members.some((n) => n.untested) ? 1.5 : 1);
  };
  const changeGroups = [...groupsByRoot.values()]
    .map((members) => ({ members, risk: groupRisk(members), lines: members.reduce((sum, n) => sum + n.lines, 0), urgent: members.reduce((sum, n) => sum + n.urgent, 0), sources: members.some((n) => n.role !== 'test') }))
    // Urgent changes first, then changes with code before test-only ones, then the riskiest.
    .sort((a, b) => Number(b.urgent > 0) - Number(a.urgent > 0) || Number(b.sources) - Number(a.sources) || b.risk - a.risk || b.lines - a.lines || (a.members[0].file < b.members[0].file ? -1 : 1));

  // Reading order per group: sources topologically, each test after the last source it covers
  // (before the first one with testFirst), tests that cover nothing at the end.
  const steps: ReviewStep[] = [];
  const groups: ReviewPlan['groups'] = [];
  const ordered: Node[][] = [];
  for (const g of changeGroups) {
    const sources = topologicalOrder(
      g.members.filter((n) => n.role !== 'test'),
      (f) => imports.get(f) ?? [],
    );
    const position = new Map(sources.map((n, i) => [n.file, i]));
    const groupTests = g.members.filter((n) => n.role === 'test').sort((a, b) => (a.file < b.file ? -1 : 1));
    const before = new Map<number, Node[]>();
    const after = new Map<number, Node[]>();
    const trailing: Node[] = [];
    for (const t of groupTests) {
      const at = (anchors.get(t.file) ?? []).map((f) => position.get(f)).filter((i): i is number => i !== undefined);
      if (!at.length) trailing.push(t);
      else if (options.testFirst) before.set(Math.min(...at), [...(before.get(Math.min(...at)) ?? []), t]);
      else after.set(Math.max(...at), [...(after.get(Math.max(...at)) ?? []), t]);
    }
    const order: Node[] = [];
    sources.forEach((n, i) => order.push(...(before.get(i) ?? []), n, ...(after.get(i) ?? [])));
    ordered.push(options.testFirst ? [...trailing, ...order] : [...order, ...trailing]);
  }
  if (others.length) {
    const otherKey = (a: Node, b: Node): number => ROLE_RANK[a.role] - ROLE_RANK[b.role] || b.raw - a.raw || (a.file < b.file ? -1 : 1);
    ordered.push([...others].sort(otherKey));
  }
  const maxRaw = Math.max(0, ...nodes.map((n) => n.raw));
  ordered.forEach((members, i) => {
    const isOther = i === changeGroups.length;
    const index = i + 1;
    for (const n of members) n.group = index;
    const main = members.find((n) => n.role !== 'test') ?? members[0];
    const dir = commonDir(members.map((n) => n.file));
    const symbol = main.symbols.find((s) => s.kind !== 'variable');
    const title = isOther ? 'Configuration and other files' : `${members.length === 1 || !dir ? main.file : `${dir}/`}${symbol ? ` · ${callable(symbol.name, symbol.kind)}` : ''}`;
    groups.push({ index, title, files: members.map((n) => n.file), lines: members.reduce((sum, n) => sum + n.lines, 0), risk: isOther ? 0 : Math.round(changeGroups[i].risk * 100) / 100, kind: isOther ? 'other' : 'change' });
  });

  for (const n of ordered.flat()) {
    steps.push({
      file: n.file,
      order: steps.length + 1,
      group: n.group!,
      role: n.role,
      reasons: n.reasons,
      risk: maxRaw > 0 ? Math.round((n.raw / maxRaw) * 100) : 0,
      meaningfulLines: n.lines,
      symbols: n.symbols.map((s) => s.name),
      tests: n.tests.length ? n.tests : undefined,
      blob: n.change.blob,
      status: n.change.status,
      oldPath: n.change.oldPath,
      additions: n.change.additions,
      deletions: n.change.deletions,
    });
  }

  const startHere = startingPoint(steps, groups, nodeById, imports, importedBy, changedSources, short);

  // Changed functions that no changed test covers.
  const untestedChanges: string[] = [];
  for (const n of nodes) {
    if (!n.info || n.role === 'test' || n.role === 'config' || n.role === 'contract' || !isTestableSource(n.info) || n.tests.length) continue;
    for (const s of n.symbols) if (FUNCTION_KINDS.has(s.kind)) untestedChanges.push(s.id);
  }

  const apiChanges = (delta?.exports ?? []).filter((e) => e.change !== 'added').sort((a, b) => Number(b.breaking) - Number(a.breaking) || b.importers.length - a.importers.length || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const meaningful = nodes.reduce((sum, n) => sum + n.lines, 0);
  const plan: ReviewPlan = {
    ref: options.ref ?? delta?.head ?? 'HEAD',
    base: options.base ?? delta?.base ?? '',
    mergeBase: options.mergeBase ?? delta?.baseCommit ?? '',
    head: options.head,
    startHere,
    steps,
    skim,
    groups,
    effort: reviewEffort(meaningful),
    apiChanges,
    delta,
    untestedChanges: untestedChanges.slice(0, 200),
    checklist: steps.map(checklistItem),
    testFirst: options.testFirst || undefined,
    commits: changes.commits,
    additions: changes.additions,
    deletions: changes.deletions,
  };
  return plan;
}

const ROLE_LABEL: Record<ReviewRole, string> = { contract: 'contract', core: 'core', consumer: 'consumer', test: 'test', config: 'config', mechanical: 'skim', other: 'other' };

/** `3. src/orders/service.ts (core) — changes signature of createOrder() used in 14 places; untested` */
export function checklistItem(step: Pick<ReviewStep, 'order' | 'file' | 'role' | 'reasons'>): string {
  return `${step.order}. \`${step.file}\` (${ROLE_LABEL[step.role]})${step.reasons.length ? ` — ${step.reasons.join('; ')}` : ''}`;
}

/** The independent changes of a plan (configuration and other files do not count). */
export function independentChanges(plan: Pick<ReviewPlan, 'groups'>): ReviewPlan['groups'] {
  return plan.groups.filter((g) => g.kind !== 'other');
}

/** `~22 min`, `~2 h 30 min` */
export function effortTime(effort: Pick<ReviewPlan['effort'], 'minutes'>): string {
  const { minutes } = effort;
  return `~${minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`}`;
}

/** `~22 min · level 3/5` */
export function effortLabel(effort: ReviewPlan['effort']): string {
  return `${effortTime(effort)} · level ${effort.level}/5`;
}

/** At most this many steps are kept on `ChangeSet.readingOrder` (the report embeds it). */
export const READING_ORDER_LIMIT = 300;
/** At most this many skimmed files are kept on `ChangeSet.readingSkim`. */
export const READING_SKIM_LIMIT = 1000;

/** The reading order of your own change (`ChangeSet.readingOrder`), for `pr` and My changes. */
export function readingOrder(data: ReviewData, changes: ChangeSet): ReviewStep[] {
  return reviewPlan(data, changes, changes.delta).steps.slice(0, READING_ORDER_LIMIT);
}

/**
 * Set `readingOrder` (the first READING_ORDER_LIMIT steps), `readingSkim` (what only needs a glance)
 * and `readingGroups` (the parts, without their files) on your own change set, for `pr` and My changes.
 */
export function setReadingOrder(data: ReviewData, changes: ChangeSet, options: Pick<ReviewPlanOptions, 'lines'> = {}): void {
  const plan = reviewPlan(data, changes, changes.delta, options);
  changes.readingOrder = plan.steps.slice(0, READING_ORDER_LIMIT);
  changes.readingSkim = plan.skim.slice(0, READING_SKIM_LIMIT).map(({ file, reason }) => ({ file, reason }));
  changes.readingGroups = plan.groups.map(({ files: _files, ...g }) => g);
}

/**
 * Mark the steps and skimmed files a reviewer viewed (`viewed`: file → blob it was viewed at; '' for a
 * deleted file). A file changed since then is unviewed again. Returns how many are viewed.
 */
export function applyViewed(plan: Pick<ReviewPlan, 'steps' | 'skim'>, viewed: Record<string, string>): number {
  let count = 0;
  for (const item of [...plan.steps, ...plan.skim]) {
    item.viewed = Object.hasOwn(viewed, item.file) && viewed[item.file] === (item.blob ?? '') ? true : undefined;
    if (item.viewed) count++;
  }
  return count;
}
