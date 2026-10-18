import type {
  ApiCall,
  ChangedFile,
  DependencyEdge,
  FileInfo,
  FileKind,
  FolderSummary,
  MemberInfo,
  PackageInfo,
  ReportData,
  RouteInfo,
  SymbolEdge,
  SymbolInfo,
} from '../types';

export interface FolderNode {
  path: string;
  name: string;
  depth: number;
  folders: FolderNode[];
  files: FileInfo[];
  fileCount: number;
  loc: number;
  summary?: FolderSummary;
}

export interface SymbolRef {
  /** Full id, possibly a method id: `file#Class.method`. */
  id: string;
  file: FileInfo;
  symbol: SymbolInfo;
  /** Set when the id points at a class member. */
  member?: MemberInfo;
  label: string;
}

export interface Model {
  data: ReportData;
  files: FileInfo[];
  fileById: Map<string, FileInfo>;
  symbolById: Map<string, { symbol: SymbolInfo; file: FileInfo }>;
  out: Map<string, DependencyEdge[]>;
  in: Map<string, DependencyEdge[]>;
  symOut: Map<string, SymbolEdge[]>;
  symIn: Map<string, SymbolEdge[]>;
  root: FolderNode;
  folderByPath: Map<string, FolderNode>;
  maxDepth: number;
  packageByName: Map<string, PackageInfo>;
  routesByFile: Map<string, RouteInfo[]>;
  routeById: Map<string, RouteInfo>;
  cyclesByFile: Map<string, number[]>;
  kinds: { kind: FileKind; count: number }[];
  hasComponents: boolean;
  hasClasses: boolean;
  hasRoutes: boolean;
  hasCalls: boolean;
  hasGit: boolean;
  /** Changed files of your current work (uncommitted / branch). */
  changed: Map<string, ChangedFile>;
  /** Files affected by your changes through imports. */
  impacted: Set<string>;
  apiByRoute: Map<string, ApiCall[]>;
  apiByFile: Map<string, ApiCall[]>;
  resolveSymbol(id: string): SymbolRef | undefined;
}

export function fileOfSymbolId(id: string): string {
  const i = id.indexOf('#');
  return i === -1 ? id : id.slice(0, i);
}

export function symbolLabel(id: string): string {
  const i = id.indexOf('#');
  return i === -1 ? id : id.slice(i + 1).replace(/~\d+$/, '');
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

import { registerPeople } from '../lib/people';
import { importPath, pathFiles } from '../../../src/shared/query';

export function buildModel(data: ReportData): Model {
  registerPeople((data.git?.contributors ?? []).map((c) => c.name));
  const fileById = new Map(data.files.map((f) => [f.id, f]));
  const symbolById = new Map<string, { symbol: SymbolInfo; file: FileInfo }>();
  for (const file of data.files) for (const symbol of file.symbols) symbolById.set(symbol.id, { symbol, file });

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

  // Folder tree
  const summaryByPath = new Map(data.folders.map((f) => [f.path, f]));
  const root: FolderNode = { path: '', name: data.project.rootName, depth: 0, folders: [], files: [], fileCount: 0, loc: 0, summary: summaryByPath.get('') };
  const folderByPath = new Map<string, FolderNode>([['', root]]);
  let maxDepth = 0;
  const ensure = (p: string): FolderNode => {
    const existing = folderByPath.get(p);
    if (existing) return existing;
    const parentPath = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const parent = ensure(parentPath);
    const node: FolderNode = {
      path: p,
      name: p.slice(p.lastIndexOf('/') + 1),
      depth: parent.depth + 1,
      folders: [],
      files: [],
      fileCount: 0,
      loc: 0,
      summary: summaryByPath.get(p),
    };
    maxDepth = Math.max(maxDepth, node.depth);
    parent.folders.push(node);
    folderByPath.set(p, node);
    return node;
  };
  for (const file of data.files) {
    const folder = ensure(file.dir);
    folder.files.push(file);
    let cursor: FolderNode | undefined = folder;
    for (;;) {
      cursor.fileCount++;
      cursor.loc += file.loc;
      if (!cursor.path) break;
      cursor = folderByPath.get(cursor.path.includes('/') ? cursor.path.slice(0, cursor.path.lastIndexOf('/')) : '');
      if (!cursor) break;
    }
  }
  const sortTree = (node: FolderNode): void => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.name.localeCompare(b.name));
    node.folders.forEach(sortTree);
  };
  sortTree(root);

  const routesByFile = new Map<string, RouteInfo[]>();
  for (const r of data.routes) push(routesByFile, r.file, r);
  const cyclesByFile = new Map<string, number[]>();
  data.insights.cycles.forEach((cycle, i) => cycle.forEach((id) => push(cyclesByFile, id, i)));

  const kindCounts = new Map<FileKind, number>();
  for (const f of data.files) if (f.scope !== 'context') kindCounts.set(f.kind, (kindCounts.get(f.kind) ?? 0) + 1);

  const allSymbols = data.files.flatMap((f) => f.symbols);
  const resolveCache = new Map<string, SymbolRef | undefined>();
  const resolveSymbol = (id: string): SymbolRef | undefined => {
    if (resolveCache.has(id)) return resolveCache.get(id);
    let result: SymbolRef | undefined;
    const direct = symbolById.get(id);
    if (direct) {
      result = { id, ...direct, label: direct.symbol.name };
    } else {
      const dot = id.lastIndexOf('.');
      const hash = id.indexOf('#');
      if (dot > hash && hash !== -1) {
        const owner = symbolById.get(id.slice(0, dot));
        if (owner) {
          const memberName = id.slice(dot + 1);
          const member = owner.symbol.members?.find((m) => m.name === memberName);
          result = { id, ...owner, member, label: `${owner.symbol.name}.${memberName}` };
        }
      }
    }
    resolveCache.set(id, result);
    return result;
  };

  const apiByRoute = new Map<string, ApiCall[]>();
  const apiByFile = new Map<string, ApiCall[]>();
  for (const c of data.apiCalls ?? []) {
    if (c.route) push(apiByRoute, c.route, c);
    push(apiByFile, c.file, c);
  }

  return {
    data,
    files: data.files,
    fileById,
    symbolById,
    out,
    in: inn,
    symOut,
    symIn,
    root,
    folderByPath,
    maxDepth,
    packageByName: new Map(data.packages.map((p) => [p.name, p])),
    routesByFile,
    routeById: new Map(data.routes.map((r) => [r.id, r])),
    cyclesByFile,
    kinds: [...kindCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    hasComponents: allSymbols.some((s) => s.kind === 'component'),
    hasClasses: allSymbols.some((s) => s.kind === 'class' || s.kind === 'interface' || s.kind === 'enum'),
    hasRoutes: data.routes.length > 0,
    hasCalls: data.symbolEdges.some((e) => e.kind === 'calls'),
    hasGit: !!data.git,
    changed: new Map((data.changes?.files ?? []).map((f) => [f.id, f])),
    impacted: new Set(data.changes?.impacted ?? []),
    apiByRoute,
    apiByFile,
    resolveSymbol,
  };
}

/* -------------------------------------------------------------------------- */
/*                              Graph algorithms                              */
/* -------------------------------------------------------------------------- */

// The walks live in the shared query core (also used by the CLI, MCP and hooks).
export { callersOf, calleesOf, importPath, pathFiles, symbolRef, transitive, usesOf } from '../../../src/shared/query';

/** Shortest import path from a to b (following imports), or from b to a. */
export function shortestPath(model: Model, a: string, b: string): string[] | undefined {
  const forward = importPath(model.data, a, b);
  if (forward) return pathFiles(a, forward);
  const back = importPath(model.data, b, a);
  return back ? pathFiles(b, back) : undefined;
}
