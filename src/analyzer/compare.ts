/**
 * `compareReports(base, head)`: what changed architecturally between two analyses — new imports and
 * dependencies between areas, cycles, rule violations, API (export) and route changes, complexity,
 * dead code and health. Pure: no I/O, works on in-memory reports and stored snapshots alike.
 */
import type { ArchitectureDelta, CallSite, ChangeSet, CloneFragment, DependencyEdge, ExportChange, ExportInfo, FileInfo, ReportSnapshot, RouteInfo, RuleViolation, SymbolInfo, SymbolKind } from '../shared/types.js';
import { areaName, defaultAreaDepth } from '../shared/architecture.js';
import {
  complexityFingerprint,
  cycleFingerprint,
  devDependencyInProductionFingerprint,
  missingDependencyFingerprint,
  unusedExportFingerprint,
  violationFingerprint,
  violationKey,
} from '../shared/fingerprint.js';
import { isCallable, paramRange, signature } from '../shared/signature.js';
import { callMatchesRoute, routeLabel } from '../shared/route-match.js';
import { cloneDelta, cloneFingerprint, fragmentKey, type CloneDeltaOptions } from '../shared/clones.js';
import { cloneSettings, declarationHashesOf, unitsOf, type CloneUnit } from './clones.js';
import { evaluateRules, type CodeVisualizerConfig } from './config.js';

export interface CompareOptions {
  /**
   * The head's configuration. Base violations are re-evaluated with it, so adding a rule does not
   * turn every existing import into a "new" violation.
   */
  config?: CodeVisualizerConfig;
  /** Names for the two sides (default: short commits, `working tree`). */
  base?: string;
  baseCommit?: string;
  head?: string;
  /** Maximum entries per list (default 500); the fingerprint lists are always complete. */
  limit?: number;
  /**
   * Files renamed or moved between base and head, old id → new id (e.g. from `git diff -M`). Their
   * cycles, unused exports, complexity and violations keep their identity instead of turning "new".
   * Files that moved without git knowing (same declarations, same length) are paired as well.
   */
  renames?: Map<string, string> | Record<string, string>;
  /** `baseCommit` is where head left `base` (their merge-base), not base's current tip. */
  mergeBase?: boolean;
  /**
   * Complexity above which a function is a finding (new-only-gates: `check.maxComplexity`). Default
   * COMPLEXITY_THRESHOLD; new functions are listed from the lower of the two.
   */
  complexityThreshold?: number;
  // --- live-guard ---
  /**
   * The files that changed; all others are the same on both sides (two consecutive analyses of a
   * running `serve`). Exports, declarations that moved, complexity and imports are compared for these
   * files only, which keeps comparing large projects cheap. Unchanged barrels re-exporting them and
   * imports between two unchanged files (e.g. after a tsconfig paths change) are not listed.
   */
  changedFiles?: Iterable<string>;
  /** `false` leaves out the dependencies between areas (`areaEdges` stays empty). */
  areas?: boolean;
  /**
   * The head's changes against this very base (`analyze({ compare })` passes its ChangeSet): a copy of
   * duplicated code counts as edited only when its lines changed. Without it, by its declaration's tokens
   * (two analyses of this process) or, failing that, its length.
   */
  changes?: Pick<ChangeSet, 'files' | 'commentOnly'>;
}

/** Functions above this complexity count as findings (new ones and increases are reported). */
export const COMPLEXITY_THRESHOLD = 10;

/** Kinds within a family can replace each other without breaking importers (function ↔ const arrow…). */
const KIND_FAMILY: Record<SymbolKind, string> = {
  function: 'value',
  hook: 'value',
  component: 'value',
  constant: 'value',
  variable: 'value',
  class: 'class',
  interface: 'type',
  type: 'type',
  enum: 'enum',
  namespace: 'namespace',
};

const edgeKey = (source: string, target: string): string => `${source}\0${target}`;
const fileOfSymbol = (id: string): string => id.slice(0, id.indexOf('#'));

/**
 * Method and path with parameter names left out: `/users/[id]`, `/users/[userId]` and `/users/:id` are
 * the same URL (catch-alls stay distinct from single segments).
 */
export function routeKey(r: Pick<RouteInfo, 'method' | 'path'>): string {
  const path = r.path
    .split('/')
    .map((seg) => {
      if (/^\[\[?\.\.\.[^\]]*\]\]?$|^\*\w*$|^:\w+[*+]$|^\{\.\.\.\w*\}$/.test(seg)) return '*';
      if (/^\[\[[^\]]+\]\]$|^:\w+\?$/.test(seg)) return ':?';
      if (/^\[[^\]]+\]$|^:\w+$|^\{\w+\}$|^\$\w+$/.test(seg)) return ':';
      return seg;
    })
    .join('/');
  return `${r.method} ${path}`;
}
const isEndpoint = (r: RouteInfo): boolean => r.type === 'api' || r.type === 'page';
const byFileLine = (a: { file: string; line: number }, b: { file: string; line: number }): number => a.file.localeCompare(b.file) || a.line - b.line;

export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/** Items of `a` whose key is not among the keys of `b`. */
function missingFrom<T>(a: T[], b: T[], key: (item: T) => string): T[] {
  const keys = new Set(b.map(key));
  return a.filter((item) => !keys.has(key(item)));
}

/* --------------------------------- Exports -------------------------------- */

interface ExportContext {
  head: ReportSnapshot;
  headFiles: Map<string, FileInfo>;
  /** Head edges by target file. */
  importsOf: Map<string, DependencyEdge[]>;
  /** Head `export * from` targets by file. */
  starTargets: Map<string, string[]>;
}

/** The declaration behind an export name (undefined for re-exports and aliases). */
function symbolFor(file: FileInfo, name: string): SymbolInfo | undefined {
  if (name === 'default') return file.symbols.find((s) => s.isDefault);
  return file.symbols.find((s) => s.exported && !s.isDefault && s.name === name) ?? file.symbols.find((s) => s.exported && s.name === name);
}

/** Names a file exports, including `export * from` chains. */
function exportedNames(ctx: ExportContext, fileId: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  const file = ctx.headFiles.get(fileId);
  if (!file || seen.has(fileId)) return names;
  seen.add(fileId);
  for (const e of file.exports) if (e.name !== '*') names.add(e.name);
  for (const target of ctx.starTargets.get(fileId) ?? []) {
    for (const n of exportedNames(ctx, target, seen)) if (n !== 'default') names.add(n);
  }
  return names;
}

/**
 * Files that import `name` from `file`: by name or with a namespace import, directly or through
 * re-exporting barrels (`export * from`). With `dynamicNamed: false`, `import()` counts for the default
 * export only (React.lazy and friends load a module for its default: dropping a named export breaks nobody).
 */
export function importersOfName(importsOf: (file: string) => readonly DependencyEdge[], file: string, name: string, options: { dynamicNamed?: boolean } = {}): string[] {
  const result = new Set<string>();
  const seen = new Set<string>();
  const queue: [string, string][] = [[file, name]];
  while (queue.length && seen.size < 5000) {
    const [target, n] = queue.shift()!;
    const key = `${target}\0${n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const e of importsOf(target)) {
      if (e.kind === 'side-effect') continue;
      const star = e.names.includes('*');
      if (e.kind === 'reexport') {
        if (e.names.includes(n) || (star && n !== 'default')) queue.push([e.source, n]);
      } else if (e.names.includes(n) || (star && (options.dynamicNamed !== false || e.kind !== 'dynamic' || n === 'default'))) {
        result.add(e.source);
      }
    }
  }
  result.delete(file);
  return [...result].sort();
}

/** Files that import `name` from `file` in the head (any import, `import()` included). */
const importersOf = (ctx: ExportContext, file: string, name: string): string[] => importersOfName((target) => ctx.importsOf.get(target) ?? [], file, name);

/** Calls whose argument count is outside the new signature's range (needs SymbolEdge.lines / argc). */
function staleCalls(head: ReportSnapshot, target: string, range: { required: number; max: number }): CallSite[] {
  const sites: CallSite[] = [];
  for (const e of head.symbolEdges) {
    if (e.target !== target || e.kind !== 'calls' || !e.lines || !e.argc) continue;
    const argc = e.argc;
    e.lines.forEach((line, i) => {
      const n = argc[i];
      // Spread arguments (-1) can't be judged.
      if (n !== undefined && n >= 0 && (n < range.required || n > range.max)) sites.push({ file: fileOfSymbol(e.source), line, argc: n, kind: 'call', symbol: e.source });
    });
  }
  return sites.sort(byFileLine);
}

/** How one export that exists on both sides changed (undefined when its declaration did not). */
function changedExport(ctx: ExportContext, before: FileInfo, after: FileInfo, name: string): ExportChange | undefined {
  const bs = symbolFor(before, name);
  const hs = symbolFor(after, name);
  if (!bs || !hs) return undefined;
  const common = { file: after.id, name, importers: importersOf(ctx, after.id, name), staleCallSites: [], line: hs.line, entry: isPublicEntry(after) || undefined };
  if (KIND_FAMILY[bs.kind] !== KIND_FAMILY[hs.kind]) return { ...common, change: 'kind', before: signature(bs), after: signature(hs), breaking: true };
  const callable = isCallable(bs) && isCallable(hs);
  if (!callable && !(bs.kind === 'type' && hs.kind === 'type')) return undefined;
  const sigBefore = signature(bs);
  const sigAfter = signature(hs);
  if (sigBefore === sigAfter) return undefined;
  // Components are rendered with one props object whatever their parameter list, so arity says
  // nothing about their JSX users (props types are not compared).
  if (!callable || bs.kind === 'component' || hs.kind === 'component') return { ...common, change: 'signature', before: sigBefore, after: sigAfter, breaking: false };
  const was = paramRange(bs.params);
  const is = paramRange(hs.params);
  const breaking = is.required > was.required || is.max < was.max;
  return { ...common, change: 'signature', before: sigBefore, after: sigAfter, breaking, staleCallSites: breaking ? staleCalls(ctx.head, hs.id, is) : [] };
}

/**
 * Files that package.json publishes (main, module, exports, bin, source…): code outside the project may
 * import them. Framework and conventional entries (app/layout, src/main) are not public API.
 */
function isPublicEntry(f: FileInfo): boolean {
  return f.isEntry && !!f.entryReason?.startsWith('package.json');
}

/** Export changes of a file that exists on both sides. */
function fileExportChanges(ctx: ExportContext, before: FileInfo, after: FileInfo): ExportChange[] {
  const named = (list: ExportInfo[]): Map<string, ExportInfo> => new Map(list.filter((e) => e.name !== '*').map((e) => [e.name, e]));
  const beforeNames = named(before.exports);
  const afterNames = named(after.exports);
  const stillExported = exportedNames(ctx, after.id);
  const entry = isPublicEntry(after) || undefined;
  const changes: ExportChange[] = [];
  for (const [name, exp] of beforeNames) {
    if (!stillExported.has(name)) {
      const bs = exp.from ? undefined : symbolFor(before, name);
      changes.push({ file: after.id, name, change: 'removed', before: bs && signature(bs), breaking: true, importers: importersOf(ctx, after.id, name), staleCallSites: [], line: exp.line, entry });
      continue;
    }
    const now = afterNames.get(name);
    // Re-exports: the declaring file reports the change.
    const change = now && !exp.from && !now.from ? changedExport(ctx, before, after, name) : undefined;
    if (change) changes.push(change);
  }
  for (const [name, exp] of afterNames) {
    if (beforeNames.has(name)) continue;
    const hs = exp.from ? undefined : symbolFor(after, name);
    changes.push({ file: after.id, name, change: 'added', after: hs && signature(hs), breaking: false, importers: importersOf(ctx, after.id, name), staleCallSites: [], line: exp.line, entry });
  }
  return changes;
}

/** A deleted file whose importers kept an import that no longer resolves. */
function deletedFileChanges(ctx: ExportContext, before: FileInfo, imports: DependencyEdge[]): ExportChange[] {
  const byName = new Map<string, Set<string>>();
  for (const e of imports) {
    const importer = ctx.headFiles.get(e.source);
    if (!importer?.unresolved.some((u) => u.specifier === e.specifier)) continue;
    for (const name of e.names.length ? e.names : ['*']) byName.set(name, (byName.get(name) ?? new Set()).add(e.source));
  }
  return [...byName].map(([name, importers]) => {
    const bs = name === '*' ? undefined : symbolFor(before, name);
    return { file: before.id, name, change: 'removed', before: bs && signature(bs), breaking: true, importers: [...importers].sort(), staleCallSites: [], line: bs?.line, entry: isPublicEntry(before) || undefined };
  });
}

/** Breaking changes that break something first, then other breaking ones, signature changes, additions. */
function exportRank(c: ExportChange): number {
  if (!c.breaking) return c.change === 'signature' ? 2 : 3;
  return c.importers.length || c.staleCallSites.length || c.entry ? 0 : 1;
}

function exportChanges(base: ReportSnapshot, head: ReportSnapshot, moved: (id: string) => string, only?: Set<string>): ExportChange[] {
  const ctx: ExportContext = { head, headFiles: new Map(head.files.map((f) => [f.id, f])), importsOf: groupBy(head.edges, (e) => e.target), starTargets: new Map() };
  for (const e of head.edges) if (e.kind === 'reexport' && e.names.includes('*')) ctx.starTargets.set(e.source, [...(ctx.starTargets.get(e.source) ?? []), e.target]);
  const baseImports = groupBy(base.edges, (e) => e.target);
  const changes: ExportChange[] = [];
  for (const before of base.files) {
    if (only && !only.has(before.id) && !only.has(moved(before.id))) continue;
    // A renamed file is compared with its new version.
    const after = ctx.headFiles.get(moved(before.id));
    changes.push(...(after ? fileExportChanges(ctx, before, after) : deletedFileChanges(ctx, before, baseImports.get(before.id) ?? [])));
  }
  return changes.sort(
    (a, b) =>
      exportRank(a) - exportRank(b) ||
      b.staleCallSites.length - a.staleCallSites.length ||
      b.importers.length - a.importers.length ||
      a.file.localeCompare(b.file) ||
      a.name.localeCompare(b.name),
  );
}

/* --------------------------------- Renames -------------------------------- */

/** What a file looks like without its path: two files with the same shape are the same file moved. */
function fileShape(f: FileInfo): string | undefined {
  if (!f.symbols.length) return undefined;
  return `${f.ext}|${f.loc}|${f.symbols.map((s) => `${s.kind}:${s.name}:${s.exported ? 1 : 0}:${s.complexity ?? ''}`).join(',')}`;
}

/** Renamed files, old id → new id: the given ones (from git) plus unambiguous moves with the same shape. */
function fileRenames(base: ReportSnapshot, head: ReportSnapshot, given: CompareOptions['renames']): Map<string, string> {
  const baseIds = new Set(base.files.map((f) => f.id));
  const headIds = new Set(head.files.map((f) => f.id));
  const renames = new Map<string, string>();
  const pairs = given instanceof Map ? [...given] : Object.entries(given ?? {});
  for (const [from, to] of pairs) if (baseIds.has(from) && !headIds.has(from) && headIds.has(to) && !baseIds.has(to)) renames.set(from, to);
  const taken = new Set(renames.values());
  const gone = groupBy(
    base.files.filter((f) => !headIds.has(f.id) && !renames.has(f.id) && fileShape(f)),
    (f) => fileShape(f)!,
  );
  const added = groupBy(
    head.files.filter((f) => !baseIds.has(f.id) && !taken.has(f.id) && fileShape(f)),
    (f) => fileShape(f)!,
  );
  for (const [shape, [from, ...more]] of gone) {
    const to = added.get(shape);
    if (!more.length && to?.length === 1) renames.set(from.id, to[0].id);
  }
  return renames;
}

/**
 * Declarations that moved to another file: gone from one file and new in exactly one other, with the
 * same name and kind (old symbol id → new id). Renamed files are applied first.
 */
function symbolMoves(base: ReportSnapshot, head: ReportSnapshot, renamedSymbol: (id: string) => string, only?: Set<string>): Map<string, string> {
  // Unchanged files neither lose nor gain declarations.
  const baseFiles = only ? base.files.filter((f) => only.has(f.id) || only.has(fileOfSymbol(renamedSymbol(`${f.id}#`)))) : base.files;
  const headFiles = only ? head.files.filter((f) => only.has(f.id)) : head.files;
  const headIds = new Set(headFiles.flatMap((f) => f.symbols.map((s) => s.id)));
  const baseIds = new Set(baseFiles.flatMap((f) => f.symbols.map((s) => renamedSymbol(s.id))));
  const key = (s: SymbolInfo): string => `${s.kind}:${s.name}`;
  const gone = groupBy(
    baseFiles.flatMap((f) => f.symbols.filter((s) => !headIds.has(renamedSymbol(s.id)))),
    key,
  );
  const added = groupBy(
    headFiles.flatMap((f) => f.symbols.filter((s) => !baseIds.has(s.id))),
    key,
  );
  const moves = new Map<string, string>();
  for (const [k, [from, ...more]] of gone) {
    const to = added.get(k);
    if (!more.length && to?.length === 1 && fileOfSymbol(from.id) !== fileOfSymbol(to[0].id)) moves.set(from.id, to[0].id);
  }
  return moves;
}

/* ---------------------------- Areas and imports --------------------------- */

/**
 * Base areas that were renamed: every file of the area that still exists moved to one other area,
 * and the old area is gone. A single file moving to another area is a real change and stays one.
 */
function areaRenames(base: ReportSnapshot, head: ReportSnapshot, depth: number, moved: (id: string) => string): Map<string, string> {
  const headDir = new Map(head.files.map((f) => [f.id, f.dir]));
  const headAreas = new Set(head.files.map((f) => areaName(f.dir, depth)));
  const target = new Map<string, string | null>();
  for (const f of base.files) {
    const from = areaName(f.dir, depth);
    const dir = headDir.get(moved(f.id));
    if (headAreas.has(from) || dir === undefined) continue;
    const to = areaName(dir, depth);
    const seen = target.get(from);
    target.set(from, seen === undefined || seen === to ? to : null);
  }
  return new Map([...target].filter((e): e is [string, string] => e[1] !== null && e[1] !== e[0]));
}

function areaCounts(report: ReportSnapshot, depth: number, rename?: Map<string, string>): Map<string, number> {
  const area = new Map<string, string>();
  for (const f of report.files) {
    if (f.kind === 'test' || f.kind === 'story') continue;
    const name = areaName(f.dir, depth);
    area.set(f.id, rename?.get(name) ?? name);
  }
  const counts = new Map<string, number>();
  for (const e of report.edges) {
    const a = area.get(e.source);
    const b = area.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}\0${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Changed import counts between areas, at the folder depth the Architecture view opens with. */
function areaDelta(base: ReportSnapshot, head: ReportSnapshot, newEdges: { source: string; target: string; line?: number }[], moved: (id: string) => string, movedTo: Set<string>): ArchitectureDelta['areaEdges'] {
  const depth = defaultAreaDepth(head.files);
  const before = areaCounts(base, depth, areaRenames(base, head, depth, moved));
  const after = areaCounts(head, depth);
  const headArea = new Map(head.files.map((f) => [f.id, areaName(f.dir, depth)]));
  // Imports behind an increase: new ones first, then those of moved files.
  const isNewEdge = new Set(newEdges.map((e) => edgeKey(e.source, e.target)));
  const ordered = [...newEdges, ...head.edges.filter((e) => !isNewEdge.has(edgeKey(e.source, e.target)) && (movedTo.has(e.source) || movedTo.has(e.target)))];
  const examples = groupBy(ordered, (e) => `${headArea.get(e.source)}\0${headArea.get(e.target)}`);
  return [...new Set([...before.keys(), ...after.keys()])]
    .map((key) => {
      const [from, to] = key.split('\0');
      const was = before.get(key) ?? 0;
      const is = after.get(key) ?? 0;
      const via = is > was ? examples.get(key)?.slice(0, 3).map((e) => ({ source: e.source, target: e.target, line: e.line })) : undefined;
      return { from, to, before: was, after: is, isNew: was === 0 && is > 0, ...(via?.length ? { via } : {}) };
    })
    .filter((a) => a.before !== a.after)
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.after - b.before - (a.after - a.before) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/* --------------------------------- Cycles --------------------------------- */

/**
 * Reported cycles are strongly connected components. A head cycle is new unless all its files were
 * already in one base cycle (a cycle that shrank or split is old debt); one that grew or merged two
 * old cycles is new. A base cycle is fixed only when no two of its files share a cycle any more.
 * `baseCycles` are in head paths (renames applied); `rawBase` holds the same cycles as reported.
 */
function cycleDelta(rawBase: string[][], baseCycles: string[][], headCycles: string[][]): { added: string[][]; fixed: string[][] } {
  const baseOf = new Map<string, number>();
  baseCycles.forEach((c, i) => c.forEach((m) => baseOf.set(m, i)));
  const headOf = new Map<string, number>();
  headCycles.forEach((c, i) => c.forEach((m) => headOf.set(m, i)));
  const added = headCycles.filter((c) => {
    const first = baseOf.get(c[0]);
    return first === undefined || c.some((m) => baseOf.get(m) !== first);
  });
  const fixed = rawBase.filter((_, i) => {
    const members = baseCycles[i];
    if (members.length === 1) return !headOf.has(members[0]);
    const seen = new Set<number>();
    for (const m of members) {
      const h = headOf.get(m);
      if (h === undefined) continue;
      if (seen.has(h)) return false;
      seen.add(h);
    }
    return true;
  });
  return { added, fixed };
}

/* ------------------------------ Other findings ----------------------------- */

/** How complex a function is: its worst part, its own code or its most complex inline callback (like health and check). */
export interface MeasuredFunction {
  /** The symbol's own id (in its report). */
  symbol: string;
  file: string;
  /** `name`, or `name › callback` when an inline callback is the worst part. */
  name: string;
  line: number;
  complexity: number;
}

/**
 * Every callable symbol outside tests, measured by its worst part. The one measure shared by the delta,
 * the complexity gates (new-only-gates) and the live guard, so they agree on every number.
 */
export function measuredFunctions(files: readonly FileInfo[], only?: (file: FileInfo) => boolean): MeasuredFunction[] {
  const list: MeasuredFunction[] = [];
  for (const f of files) {
    if (f.kind === 'test' || (only && !only(f))) continue;
    for (const s of f.symbols) {
      if (!isCallable(s) || s.complexity === undefined) continue;
      const nested = s.nested && s.nested.complexity > s.complexity ? s.nested : undefined;
      list.push(
        nested
          ? { symbol: s.id, file: f.id, name: `${s.name} › ${nested.name}`, line: nested.line, complexity: nested.complexity }
          : { symbol: s.id, file: f.id, name: s.name, line: s.line, complexity: s.complexity },
      );
    }
  }
  return list;
}

function functionsOf(report: ReportSnapshot, key: (id: string) => string = (id) => id, only?: (file: string) => boolean): Map<string, MeasuredFunction> {
  return new Map(measuredFunctions(report.files, only && ((f) => only(f.id))).map((m) => [key(m.symbol), m]));
}

interface ComplexityDelta {
  changed: ArchitectureDelta['complexity'];
  /** Crossed the threshold (new findings). */
  crossed: { symbol: string; file: string }[];
  /** Already above the threshold and got worse (the same finding as before). */
  worsened: { symbol: string; file: string }[];
  /** Base findings that went away (the base's own symbol id, file, name and complexity). */
  fixed: { symbol: string; file: string; name: string; line: number; complexity: number }[];
}

/**
 * Functions that got more complex (any increase) or are new above the threshold, and the findings that
 * appeared, grew or went away. New functions are listed from the lower of `threshold` and
 * COMPLEXITY_THRESHOLD, so a gate with a stricter limit sees every new function it would flag. With
 * `only` (live-guard), just the functions of those files are measured.
 */
function complexityDelta(
  base: ReportSnapshot,
  head: ReportSnapshot,
  movedSymbol: (id: string) => string,
  threshold = COMPLEXITY_THRESHOLD,
  only?: Set<string>,
): ComplexityDelta {
  const before = functionsOf(base, movedSymbol, only && ((id) => only.has(id) || only.has(fileOfSymbol(movedSymbol(`${id}#`)))));
  const after = functionsOf(head, undefined, only && ((id) => only.has(id)));
  const listFrom = Math.min(threshold, COMPLEXITY_THRESHOLD);
  const result: ComplexityDelta = { changed: [], crossed: [], worsened: [], fixed: [] };
  for (const [id, fn] of after) {
    const was = before.get(id)?.complexity;
    const is = fn.complexity;
    const worse = was === undefined ? is > listFrom : is > was;
    if (!worse) continue;
    result.changed.push({ symbol: id, file: fn.file, name: fn.name, line: fn.line, before: was ?? 0, after: is });
    if (is > threshold) (was !== undefined && was > threshold ? result.worsened : result.crossed).push({ symbol: id, file: fn.file });
  }
  result.changed.sort((a, b) => b.after - b.before - (a.after - a.before) || b.after - a.after || a.symbol.localeCompare(b.symbol));
  for (const [id, fn] of before) {
    if (fn.complexity > threshold && (after.get(id)?.complexity ?? 0) <= threshold) result.fixed.push({ symbol: fn.symbol, file: fn.file, name: fn.name, line: fn.line, complexity: fn.complexity });
  }
  return result;
}

/** Routes by method + path (parameter names aside); removed endpoints list the HTTP calls that still target them. */
function routeDelta(base: ReportSnapshot, head: ReportSnapshot): ArchitectureDelta['routes'] {
  const before = new Map(base.routes.filter(isEndpoint).map((r) => [routeKey(r), r]));
  const after = new Map(head.routes.filter(isEndpoint).map((r) => [routeKey(r), r]));
  const unlinked = head.apiCalls.filter((c) => !c.external && !c.route);
  const removed = [...before]
    .filter(([key]) => !after.has(key))
    .map(([, r]) => ({
      id: r.id,
      label: routeLabel(r),
      stillCalledFrom: unlinked
        .filter((c) => callMatchesRoute(r, c))
        .map((c) => ({ file: c.file, line: c.line }))
        .sort(byFileLine),
    }))
    .sort((a, b) => b.stillCalledFrom.length - a.stillCalledFrom.length || a.label.localeCompare(b.label));
  const added = [...after].filter(([key]) => !before.has(key)).map(([, r]) => routeLabel(r));
  return { added: [...new Set(added)].sort(), removed };
}

/**
 * Health on the head's categories, with the base's category scores (a category only one side has
 * counts as unchanged). A base without source files (before the project existed) is neutral.
 */
function healthDelta(base: ReportSnapshot, head: ReportSnapshot): ArchitectureDelta['health'] {
  if (!base.files.length) return { before: head.health.score, after: head.health.score, categories: [] };
  const baseCats = new Map(base.health.categories.map((c) => [c.id, c.score]));
  const weight = head.health.categories.reduce((n, c) => n + c.weight, 0);
  const weighted = head.health.categories.reduce((n, c) => n + (baseCats.get(c.id) ?? c.score) * c.weight, 0);
  return {
    before: weight ? Math.max(0, Math.min(100, Math.round(weighted / weight))) : base.health.score,
    after: head.health.score,
    categories: head.health.categories.filter((c) => baseCats.has(c.id) && baseCats.get(c.id) !== c.score).map((c) => ({ id: c.id, before: baseCats.get(c.id)!, after: c.score })),
  };
}

/* --------------------------------- Clones --------------------------------- */

/**
 * clone-radar: what `cloneDelta` needs to tell a new copy from an edited old one — the declarations each
 * copy overlaps on both sides (a small edit can move most of a copy into the neighbouring declaration),
 * declarations that moved to another file, the lines of each declaration (a copy replaced by a call is a
 * fix, an edited copy is drift), which files changed (by size, when the caller does not say) and the
 * similarity copies need (`clones.minSimilarity`).
 */
function cloneContext(
  base: ReportSnapshot,
  head: ReportSnapshot,
  moved: (id: string) => string,
  moves: Map<string, string>,
  only: Set<string> | undefined,
  options: Pick<CompareOptions, 'config' | 'changes'>,
): CloneDeltaOptions {
  if (!head.insights.clones?.length && !base.insights.clones?.length) return {};
  type Lines = { start: number; end: number };
  const index = (files: readonly FileInfo[], fileId: (id: string) => string) => {
    const units = new Map<string, CloneUnit[]>();
    const declarations = new Map<string, Lines>();
    for (const f of files) {
      const file = fileId(f.id);
      // A class with members is split into them: two methods of one class are two declarations.
      const list = unitsOf(f).filter((u) => u.member || u.info.kind !== 'class' || !u.info.members?.length);
      units.set(file, list);
      declarations.set(`${file}#`, { start: 1, end: Math.max(1, f.loc) });
      for (const u of list) declarations.set(`${file}#${u.name}`, { start: u.start, end: u.end });
    }
    return { units, declarations };
  };
  const before = index(base.files, moved);
  const after = index(head.files, (id) => id);
  // Head declaration → where the base had it, for declarations that moved to another file (class members follow their class).
  const movedFrom = new Map<string, string>();
  for (const [from, to] of moves) {
    const hash = from.indexOf('#');
    movedFrom.set(to, `${moved(from.slice(0, hash))}${from.slice(hash)}`);
  }
  const origin = (key: string): string | undefined => {
    const hash = key.indexOf('#');
    const dot = key.indexOf('.', hash);
    const own = movedFrom.get(key);
    if (own || dot < 0) return own;
    const owner = movedFrom.get(key.slice(0, dot));
    return owner && `${owner}${key.slice(dot)}`;
  };
  /** The copy's own declaration and every declaration at least 2 of its lines overlap. */
  const overlapping = (units: CloneUnit[] | undefined, f: CloneFragment, file: string): string[] => {
    const keys = new Set([fragmentKey({ file, name: f.name })]);
    for (const u of units ?? []) if (Math.min(f.end, u.end) - Math.max(f.start, u.start) + 1 >= Math.min(2, f.end - f.start + 1)) keys.add(`${file}#${u.name}`);
    return [...keys];
  };
  const headKeys = (f: CloneFragment): string[] => {
    const keys = overlapping(after.units.get(f.file), f, f.file);
    return [...keys, ...keys.map(origin).filter((k): k is string => !!k)];
  };
  // Changed files: edited, added and deleted ones.
  const sizes = new Map(base.files.map((f) => [moved(f.id), f.bytes]));
  const changed = new Set(head.files.filter((f) => sizes.get(f.id) !== f.bytes).map((f) => f.id));
  const kept = new Set(head.files.map((f) => f.id));
  for (const id of sizes.keys()) if (!kept.has(id)) changed.add(id);
  const { changes } = options;
  for (const f of changes?.files ?? []) changed.add(f.id);
  const changedFiles = only ?? changed;
  // The lines the change edited (head numbering; every line of a new file), when the caller knows them.
  const editedLines = new Map<string, Set<number> | 'all'>();
  const commentOnly = new Set(changes?.commentOnly ?? []);
  for (const f of changes?.files ?? []) {
    if (f.status === 'added' || f.status === 'untracked') editedLines.set(f.id, 'all');
    else if (f.status !== 'deleted') editedLines.set(f.id, new Set(commentOnly.has(f.id) ? [] : [...f.lines, ...(f.added ?? [])]));
  }
  // Declaration hashes are kept by base file ids; `origin` and the declaration indexes speak head ids.
  const baseIdOf = new Map(base.files.map((f) => [moved(f.id), f.id]));
  const inBaseIds = (key: string): string => {
    const hash = key.indexOf('#');
    const file = key.slice(0, hash);
    return `${baseIdOf.get(file) ?? file}${key.slice(hash)}`;
  };
  const baseHashes = declarationHashesOf(base.insights.clones);
  const headHashes = declarationHashesOf(head.insights.clones);
  const edited = (f: CloneFragment, side: 'base' | 'head'): boolean => {
    const file = side === 'head' ? f.file : moved(f.file);
    if (!changedFiles.has(file)) return false;
    const key = fragmentKey({ file, name: f.name });
    const was = origin(key) ?? key;
    const now = after.declarations.get(key);
    // A declaration the change added, or removed.
    if (side === 'head' ? !before.declarations.has(was) : !now) return true;
    const lines = editedLines.get(file);
    if (lines) {
      if (lines === 'all') return true;
      const range = side === 'head' ? f : now!;
      for (const l of lines) if (l >= range.start && l <= range.end) return true;
      return false;
    }
    const tokensBefore = baseHashes?.get(inBaseIds(was));
    const tokensNow = headHashes?.get(key);
    if (tokensBefore !== undefined && tokensNow !== undefined) return tokensBefore !== tokensNow;
    // Neither lines nor tokens (a stored snapshot): by its length.
    const span = before.declarations.get(was);
    return !span || !now || span.end - span.start !== now.end - now.start;
  };
  return {
    minSimilarity: cloneSettings(options.config?.clones)?.minSimilarity,
    baseKeys: (f) => overlapping(before.units.get(moved(f.file)), f, moved(f.file)),
    headKeys,
    existed: (f) => headKeys(f).some((k) => before.declarations.has(k)),
    baseDeclaration: (key) => before.declarations.get(key),
    headDeclaration: (key) => after.declarations.get(key),
    changedFiles,
    edited,
  };
}

/* -------------------------------- Compare --------------------------------- */

export function compareReports(base: ReportSnapshot, head: ReportSnapshot, options: CompareOptions = {}): ArchitectureDelta {
  const limit = options.limit ?? 500;
  const truncated: Record<string, number> = {};
  const cap = <T>(name: string, list: T[]): T[] => {
    if (list.length > limit) truncated[name] = list.length - limit;
    return list.slice(0, limit);
  };

  const only = options.changedFiles ? new Set(options.changedFiles) : undefined;
  // Base findings are matched in head paths, so renamed and moved files keep their findings.
  const renames = fileRenames(base, head, options.renames);
  const moved = (id: string): string => renames.get(id) ?? id;
  const renamedSymbol = (id: string): string => {
    const hash = id.indexOf('#');
    return hash > 0 ? `${moved(id.slice(0, hash))}${id.slice(hash)}` : id;
  };
  // Functions moved to another module keep their complexity and unused-export findings too.
  const moves = symbolMoves(base, head, renamedSymbol, only);
  const movedSymbol = (id: string): string => moves.get(id) ?? renamedSymbol(id);

  // With changedFiles, imports between two unchanged files are taken as unchanged.
  const baseEdges = only ? base.edges.filter((e) => only.has(e.source) || only.has(e.target) || only.has(moved(e.source)) || only.has(moved(e.target))) : base.edges;
  const headEdges = only ? head.edges.filter((e) => only.has(e.source) || only.has(e.target)) : head.edges;
  const baseEdgeKeys = new Set(baseEdges.map((e) => edgeKey(moved(e.source), moved(e.target))));
  const headEdgeKeys = new Set(headEdges.map((e) => edgeKey(e.source, e.target)));
  const newEdges = headEdges
    .filter((e) => !baseEdgeKeys.has(edgeKey(e.source, e.target)))
    .map((e) => ({ source: e.source, target: e.target, names: e.names, line: e.line, typeOnly: e.typeOnly || undefined }));
  const removedEdges = baseEdges.filter((e) => !headEdgeKeys.has(edgeKey(moved(e.source), moved(e.target)))).map((e) => ({ source: e.source, target: e.target }));
  const cycles = cycleDelta(
    base.insights.cycles,
    base.insights.cycles.map((c) => c.map(moved)),
    head.insights.cycles,
  );
  // Violations are judged with the head's rules on both sides (on the base's own paths, so moving a
  // file into a forbidden area is new), then matched in head paths.
  const baseViolations: RuleViolation[] = options.config ? evaluateRules(options.config, base.edges) : base.insights.ruleViolations;
  const movedViolationKey = (v: RuleViolation): string => violationKey({ rule: v.rule, source: moved(v.source), target: moved(v.target) });
  const baseViolationKeys = new Set(baseViolations.map(movedViolationKey));
  const headViolationKeys = new Set(head.insights.ruleViolations.map(violationKey));
  const newViolations = head.insights.ruleViolations.filter((v) => !baseViolationKeys.has(violationKey(v)));
  const fixedViolations = baseViolations.filter((v) => !headViolationKeys.has(movedViolationKey(v)));
  const missingNames = (r: ReportSnapshot): string[] => r.insights.missingDependencies.map((m) => m.name);
  const newMissing = missingFrom(missingNames(head), missingNames(base), String).sort();
  const fixedMissing = missingFrom(missingNames(base), missingNames(head), String);
  // devDependencies imported by production code, per declaring package.json.
  const devKey = (d: { name: string; manifest?: string }): string => `${d.name}\0${d.manifest ?? ''}`;
  const devInProduction = (r: ReportSnapshot) => r.insights.devDependenciesInProduction ?? [];
  const baseDevKeys = new Set(devInProduction(base).map(devKey));
  const headDevKeys = new Set(devInProduction(head).map(devKey));
  const newDev = devInProduction(head).filter((d) => !baseDevKeys.has(devKey(d)));
  const fixedDev = devInProduction(base).filter((d) => !headDevKeys.has(devKey(d)));
  const usedPackages = (r: ReportSnapshot): string[] => r.packages.filter((p) => !p.builtin && p.importedBy.length).map((p) => p.name);
  const complexityThreshold = options.complexityThreshold ?? COMPLEXITY_THRESHOLD;
  const complexity = complexityDelta(base, head, movedSymbol, complexityThreshold, only);
  const unused = (r: ReportSnapshot): { file: string; name: string; line: number }[] => r.insights.unusedExports.filter((u) => !u.typeOnly).map((u) => ({ file: u.file, name: u.name, line: u.line }));
  const movedUnusedKey = (u: { file: string; name: string }): string => movedSymbol(`${u.file}#${u.name}`);
  const baseUnusedKeys = new Set(unused(base).map(movedUnusedKey));
  const headUnusedKeys = new Set(unused(head).map((u) => `${u.file}#${u.name}`));
  const newUnused = unused(head).filter((u) => !baseUnusedKeys.has(`${u.file}#${u.name}`));
  const fixedUnused = unused(base).filter((u) => !headUnusedKeys.has(movedUnusedKey(u)));
  // --- clone-radar: copies that were not clones of each other in the base ---
  const clones = cloneDelta(base.insights.clones, head.insights.clones, { moved, ...cloneContext(base, head, moved, moves, only, options) });

  const fingerprints = {
    new: [
      ...cycles.added.map(cycleFingerprint),
      ...newViolations.map(violationFingerprint),
      ...complexity.crossed.map((c) => complexityFingerprint(c.file, c.symbol)),
      ...newUnused.map((u) => unusedExportFingerprint(u.file, u.name)),
      ...newMissing.map(missingDependencyFingerprint),
      ...newDev.map((d) => devDependencyInProductionFingerprint(d.name, d.manifest)),
      ...clones.added.map(cloneFingerprint),
    ],
    fixed: [
      ...cycles.fixed.map(cycleFingerprint),
      ...fixedViolations.map(violationFingerprint),
      ...complexity.fixed.map((c) => complexityFingerprint(c.file, c.symbol)),
      ...fixedUnused.map((u) => unusedExportFingerprint(u.file, u.name)),
      ...fixedMissing.map(missingDependencyFingerprint),
      ...fixedDev.map((d) => devDependencyInProductionFingerprint(d.name, d.manifest)),
      ...clones.fixed.map(cloneFingerprint),
    ],
    worsened: complexity.worsened.map((c) => complexityFingerprint(c.file, c.symbol)),
  };
  const routes = routeDelta(base, head);

  const delta: ArchitectureDelta = {
    base: options.base ?? base.commit?.slice(0, 10) ?? 'base',
    baseCommit: options.baseCommit ?? base.commit ?? '',
    head: options.head ?? head.commit?.slice(0, 10) ?? 'working tree',
    newEdges: cap('newEdges', newEdges),
    removedEdges: cap('removedEdges', removedEdges),
    areaEdges: options.areas === false ? [] : cap('areaEdges', areaDelta(base, head, newEdges, moved, new Set(renames.values()))),
    newCycles: cap('newCycles', cycles.added),
    fixedCycles: cap('fixedCycles', cycles.fixed),
    newViolations: cap('newViolations', newViolations),
    fixedViolations: cap('fixedViolations', fixedViolations),
    newMissingDependencies: newMissing,
    addedPackages: missingFrom(usedPackages(head), usedPackages(base), String).sort(),
    removedPackages: missingFrom(usedPackages(base), usedPackages(head), String).sort(),
    complexity: cap('complexity', complexity.changed),
    exports: cap('exports', exportChanges(base, head, moved, only)),
    routes: { added: cap('routesAdded', routes.added), removed: cap('routesRemoved', routes.removed) },
    newUnusedExports: cap('newUnusedExports', newUnused),
    health: healthDelta(base, head),
    fingerprints: { new: [...new Set(fingerprints.new)].sort(), fixed: [...new Set(fingerprints.fixed)].sort(), worsened: [...new Set(fingerprints.worsened)].sort() },
  };
  if (newDev.length) delta.newDevDependenciesInProduction = newDev.map((d) => ({ name: d.name, ...(d.manifest ? { manifest: d.manifest } : {}), files: d.files.slice(0, 5) }));
  if (renames.size) delta.renamed = [...renames].map(([from, to]) => ({ from, to })).sort((a, b) => a.to.localeCompare(b.to));
  if (options.mergeBase) delta.mergeBase = true;
  // --- new-only-gates: what went away, so gates can report "N fixed" with names ---
  if (fixedMissing.length) delta.fixedMissingDependencies = [...fixedMissing].sort();
  if (fixedDev.length) delta.fixedDevDependenciesInProduction = fixedDev.map((d) => ({ name: d.name, ...(d.manifest ? { manifest: d.manifest } : {}) }));
  if (complexity.fixed.length) delta.fixedComplexity = cap('fixedComplexity', complexity.fixed);
  if (fixedUnused.length) delta.fixedUnusedExports = cap('fixedUnusedExports', fixedUnused);
  if (complexityThreshold !== COMPLEXITY_THRESHOLD) delta.complexityThreshold = complexityThreshold;
  // --- clone-radar ---
  if (clones.added.length) delta.newClones = cap('newClones', clones.added);
  if (clones.fixed.length) delta.fixedClones = cap('fixedClones', clones.fixed);
  if (clones.drifted.length) delta.driftedClones = cap('driftedClones', clones.drifted);
  if (Object.keys(truncated).length) delta.truncated = truncated;
  return delta;
}
