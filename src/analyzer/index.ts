import fs from 'node:fs';
import path from 'node:path';
import type {
  DependencyEdge,
  EdgeKind,
  FileInfo,
  Language,
  PackageInfo,
  ReportData,
  RouteInfo,
  Scope,
  ScopeRole,
  Stats,
  SymbolEdge,
  SymbolEdgeKind,
  SymbolInfo,
} from '../shared/types.js';
import { SCHEMA_VERSION } from '../shared/types.js';
import { classifyFile, isTestFile } from './classify.js';
import { discoverFiles } from './files.js';
import { analyzeGit } from './git.js';
import { buildAdjacency, pageRank, reachable, reverse, sampleCycle, stronglyConnectedComponents } from './graph.js';
import { buildFolders, buildTour, findDuplicates, markPackageHealth, symbolEdgeKey } from './insights.js';
import { joinRoute, parseSource, toPascalCase, type ParsedFile, type RawRoute } from './parse.js';
import { loadProject, toPosix, type ProjectContext } from './project.js';
import { ModuleResolver } from './resolve.js';
import { detectFileRoutes, type FileRole } from './routes.js';

export interface AnalyzeOptions {
  /** Project root (defaults to `process.cwd()`). */
  root?: string;
  /** Focus the report on a single file (path relative to cwd or absolute). */
  file?: string;
  /** Focus the report on a directory (path relative to cwd or absolute). */
  directory?: string;
  /** For `file` scope: how many levels of dependents / dependencies to include. */
  depth?: number;
  /** Extra gitignore-style patterns to exclude. */
  exclude?: string[];
  /** Embed file sources so the report can show code (default: true). */
  includeSource?: boolean;
  /** Analyze git history for churn, ownership and change coupling (default: true). */
  git?: boolean;
  maxFiles?: number;
  /** Version of the tool, stored in the report. */
  toolVersion?: string;
  onProgress?: (stage: AnalyzeStage, detail?: { done?: number; total?: number }) => void;
}

export type AnalyzeStage = 'project' | 'discover' | 'parse' | 'link' | 'git' | 'insights' | 'done';

export class AnalyzeError extends Error {}

interface Binding {
  file?: string;
  pkg?: string;
  imported: string;
}

interface FileState {
  id: string;
  ext: string;
  bytes: number;
  text: string;
  parsed: ParsedFile;
  bindings: Map<string, Binding>;
  assets: FileInfo['assets'];
  unresolved: FileInfo['unresolved'];
  packages: Set<string>;
  symbolsByName: Map<string, SymbolInfo[]>;
}

const TYPE_KINDS = new Set(['interface', 'type', 'class', 'enum']);
const EDGE_PRIORITY: Record<EdgeKind, number> = { import: 5, reexport: 4, require: 3, dynamic: 2, 'side-effect': 1 };
const MAX_SOURCE_BYTES = 400_000;
const MAX_TOTAL_SOURCE = 60_000_000;

function relativeToRoot(root: string, input: string): string {
  const abs = path.resolve(process.cwd(), input);
  const rel = toPosix(path.relative(root, abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AnalyzeError(`"${input}" is outside of the project root (${root}).`);
  }
  return rel.replace(/\/$/, '');
}

export async function analyze(options: AnalyzeOptions = {}): Promise<ReportData> {
  const started = Date.now();
  const root = path.resolve(options.root ?? process.cwd());
  const progress = options.onProgress ?? (() => undefined);
  const warnings: string[] = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new AnalyzeError(`Project root "${root}" is not a directory.`);

  progress('project');
  const ctx = await loadProject(root);

  progress('discover');
  const discovered = await discoverFiles(root, { exclude: options.exclude, maxFiles: options.maxFiles });
  if (!discovered.files.length) {
    throw new AnalyzeError(`No JavaScript/TypeScript source files found in ${root}.`);
  }
  if (discovered.truncated) warnings.push(`Only the first ${discovered.files.length} files were analyzed (use --max-files to raise the limit).`);
  for (const s of discovered.skipped.slice(0, 20)) warnings.push(`Skipped ${s.id} (${s.reason}).`);

  let scope: Scope = { type: 'project' };
  if (options.file) scope = { type: 'file', path: relativeToRoot(root, options.file) };
  else if (options.directory) scope = { type: 'directory', path: relativeToRoot(root, options.directory) };

  /* ------------------------------- Parse files ------------------------------- */
  const states = new Map<string, FileState>();
  const total = discovered.files.length;
  let done = 0;
  progress('parse', { done, total });
  for (const f of discovered.files) {
    let text: string;
    try {
      text = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSource(f.id, text, f.ext);
    if (parsed.parseError) warnings.push(`Could not fully parse ${f.id}: ${parsed.parseError}`);
    states.set(f.id, {
      id: f.id,
      ext: f.ext,
      bytes: f.bytes,
      text,
      parsed,
      bindings: new Map(),
      assets: [],
      unresolved: [],
      packages: new Set(),
      symbolsByName: new Map(),
    });
    done++;
    if (done % 50 === 0) progress('parse', { done, total });
  }
  progress('parse', { done, total });

  if (scope.type === 'file' && !states.has(scope.path!)) {
    throw new AnalyzeError(`File "${scope.path}" is not a supported source file inside the project (or it is excluded).`);
  }
  if (scope.type === 'directory' && scope.path && ![...states.keys()].some((id) => id.startsWith(`${scope.path}/`))) {
    throw new AnalyzeError(`Directory "${scope.path}" contains no supported source files.`);
  }

  progress('link');
  const ids = [...states.keys()];
  const idSet = new Set(ids);
  const resolver = new ModuleResolver(ctx, idSet);

  /* ------------------------------- Symbol ids -------------------------------- */
  const symbolById = new Map<string, SymbolInfo>();
  for (const st of states.values()) {
    const used = new Map<string, number>();
    for (const s of st.parsed.symbols) {
      const n = (used.get(s.name) ?? 0) + 1;
      used.set(s.name, n);
      s.id = n === 1 ? `${st.id}#${s.name}` : `${st.id}#${s.name}~${n}`;
      symbolById.set(s.id, s);
      const list = st.symbolsByName.get(s.name) ?? [];
      list.push(s);
      st.symbolsByName.set(s.name, list);
    }
  }

  /* --------------------------- Imports → edges -------------------------------- */
  const edgeMap = new Map<string, DependencyEdge>();
  const pkgUsage = new Map<string, { files: Set<string>; names: Map<string, number>; count: number; typeOnly: boolean; builtin: boolean }>();
  const specCache = new Map<string, string | undefined>();
  const resolveFile = (from: string, specifier: string): string | undefined => {
    const key = `${from}\0${specifier}`;
    if (specCache.has(key)) return specCache.get(key);
    const r = resolver.resolve(from, specifier);
    const value = r.type === 'file' ? r.id : undefined;
    specCache.set(key, value);
    return value;
  };

  const addEdge = (source: string, target: string, kind: EdgeKind, typeOnly: boolean, names: string[], line: number, specifier: string): void => {
    if (source === target) return;
    const key = `${source}\0${target}`;
    const existing = edgeMap.get(key);
    if (!existing) {
      edgeMap.set(key, { source, target, kind, typeOnly, names: [...new Set(names)], line, specifier });
      return;
    }
    if (EDGE_PRIORITY[kind] > EDGE_PRIORITY[existing.kind]) existing.kind = kind;
    existing.typeOnly = existing.typeOnly && typeOnly;
    for (const n of names) if (!existing.names.includes(n)) existing.names.push(n);
  };

  const usePackage = (st: FileState, name: string, builtin: boolean, names: string[], typeOnly: boolean): void => {
    let usage = pkgUsage.get(name);
    if (!usage) {
      usage = { files: new Set(), names: new Map(), count: 0, typeOnly: true, builtin };
      pkgUsage.set(name, usage);
    }
    usage.files.add(st.id);
    usage.count++;
    usage.typeOnly = usage.typeOnly && typeOnly;
    for (const n of names) usage.names.set(n, (usage.names.get(n) ?? 0) + 1);
    st.packages.add(name);
  };

  for (const st of states.values()) {
    for (const imp of st.parsed.imports) {
      const r = resolver.resolve(st.id, imp.specifier);
      if (r.type === 'file') {
        addEdge(st.id, r.id, imp.kind, imp.typeOnly, imp.names, imp.line, imp.specifier);
        for (const b of imp.bindings) st.bindings.set(b.local, { file: r.id, imported: b.imported });
      } else if (r.type === 'package' || r.type === 'builtin') {
        if (ctx.pkg.name && r.name === ctx.pkg.name) continue;
        usePackage(st, r.name, r.type === 'builtin', imp.names, imp.typeOnly);
        for (const b of imp.bindings) st.bindings.set(b.local, { pkg: r.name, imported: b.imported });
      } else if (r.type === 'asset') {
        st.assets.push({ specifier: imp.specifier, line: imp.line, path: r.path });
      } else if (r.type === 'unresolved') {
        st.unresolved.push({ specifier: imp.specifier, line: imp.line });
      }
    }
    for (const re of st.parsed.reexports) {
      const r = resolver.resolve(st.id, re.specifier);
      const names = re.star ? ['*'] : re.names.map((n) => n.imported);
      if (r.type === 'file') addEdge(st.id, r.id, 'reexport', re.typeOnly, names, re.line, re.specifier);
      else if (r.type === 'package' || r.type === 'builtin') usePackage(st, r.name, r.type === 'builtin', names, re.typeOnly);
      else if (r.type === 'unresolved') st.unresolved.push({ specifier: re.specifier, line: re.line });
    }
  }

  /* --------------------------- Export resolution ----------------------------- */
  const valueSymbol = (st: FileState, name: string, space: 'value' | 'type' | 'any' = 'any'): SymbolInfo | undefined => {
    const list = st.symbolsByName.get(name);
    if (!list?.length) return undefined;
    if (space === 'value') return list.find((s) => s.kind !== 'interface' && s.kind !== 'type') ?? undefined;
    if (space === 'type') return list.find((s) => TYPE_KINDS.has(s.kind)) ?? list[0];
    return list.find((s) => s.kind !== 'namespace') ?? list[0];
  };

  const resolveExport = (file: string, name: string, space: 'value' | 'type' | 'any' = 'any', depth = 0): SymbolInfo | undefined => {
    if (depth > 15) return undefined;
    const st = states.get(file);
    if (!st) return undefined;
    const local = st.parsed.localExports.find((e) => e.name === name);
    if (local) {
      const s = valueSymbol(st, local.local, space);
      if (s) return s;
      const b = st.bindings.get(local.local);
      if (b?.file) return resolveExport(b.file, b.imported, space, depth + 1);
    }
    if (name === 'default') {
      const s = st.parsed.symbols.find((x) => x.isDefault);
      if (s) return s;
    }
    for (const re of st.parsed.reexports) {
      if (re.star) continue;
      const hit = re.names.find((n) => n.exported === name);
      if (!hit) continue;
      const target = resolveFile(file, re.specifier);
      if (target && hit.imported !== '*') return resolveExport(target, hit.imported, space, depth + 1);
      return undefined;
    }
    if (name !== 'default') {
      for (const re of st.parsed.reexports) {
        if (!re.star) continue;
        const target = resolveFile(file, re.specifier);
        const s = target ? resolveExport(target, name, space, depth + 1) : undefined;
        if (s) return s;
      }
    }
    const s = valueSymbol(st, name, space);
    return s?.exported ? s : undefined;
  };

  /** Resolve an identifier (or `ns.member`) as seen from inside `file`. */
  const resolveName = (file: string, name: string, space: 'value' | 'type' | 'any' = 'any'): SymbolInfo | undefined => {
    const st = states.get(file);
    if (!st || !name) return undefined;
    const dot = name.indexOf('.');
    if (dot > 0) {
      const head = name.slice(0, dot);
      const tail = name.slice(dot + 1);
      const b = st.bindings.get(head);
      if (b?.file) {
        if (b.imported === '*') return resolveExport(b.file, tail, space);
        const viaDefault = resolveExport(b.file, b.imported, 'any');
        if (viaDefault && viaDefault.kind !== 'class' && viaDefault.kind !== 'namespace') return resolveExport(b.file, tail, space);
      }
      return undefined;
    }
    const local = valueSymbol(st, name, space);
    const b = st.bindings.get(name);
    // `const Page = lazy(() => import('./Page'))` → the real component lives in the imported file.
    if (local?.tags?.includes('lazy') && b?.file) return resolveExport(b.file, 'default', space) ?? local;
    if (local) return local;
    if (b?.file) return resolveExport(b.file, b.imported === '*' ? 'default' : b.imported, space);
    return undefined;
  };

  /** `new UserService(...)` stored in a constant → the class it instantiates. */
  const instanceClass = (sym: SymbolInfo | undefined, file: string): SymbolInfo | undefined => {
    if (!sym || (sym.kind !== 'constant' && sym.kind !== 'variable')) return undefined;
    const m = sym.typeText?.match(/^new\s+([A-Za-z_$][\w$]*)/);
    if (!m) return undefined;
    const cls = resolveName(file, m[1], 'value');
    return cls?.kind === 'class' ? cls : undefined;
  };

  // Vue: globally registered / auto-imported components (Nuxt `components/` convention)
  const vueRegistry = new Map<string, string>();
  for (const st of states.values()) {
    if (st.ext !== '.vue') continue;
    const base = toPascalCase(path.posix.basename(st.id));
    if (!vueRegistry.has(base)) vueRegistry.set(base, st.id);
    const m = st.id.match(/(?:^|\/)components\/(.+)\.vue$/);
    if (m) {
      const prefixed = toPascalCase(m[1].replace(/\/index$/, '').replace(/\//g, '-'));
      if (!vueRegistry.has(prefixed)) vueRegistry.set(prefixed, st.id);
    }
  }

  /* ------------------------------ Symbol edges ------------------------------- */
  const symbolEdgeMap = new Map<string, SymbolEdge>();
  const addSymbolEdge = (source: string, target: string, kind: SymbolEdgeKind, count = 1): void => {
    if (!source || !target || source === target) return;
    const key = symbolEdgeKey({ source, target, kind });
    const existing = symbolEdgeMap.get(key);
    if (existing) existing.count += count;
    else symbolEdgeMap.set(key, { source, target, kind, count });
  };
  const hasMember = (cls: SymbolInfo, member: string): boolean => !!cls.members?.some((m) => m.name === member);

  const resolveCallee = (st: FileState, owner: string | undefined, fieldTypes: Map<string, string> | undefined, callee: string): { id: string; kind: SymbolEdgeKind } | undefined => {
    if (callee.startsWith('new:')) {
      const cls = resolveName(st.id, callee.slice(4), 'value');
      if (cls && (cls.kind === 'class' || cls.kind === 'component')) return { id: cls.id, kind: 'instantiates' };
      return undefined;
    }
    if (callee.startsWith('super.')) return undefined;
    if (callee.startsWith('this.')) {
      const parts = callee.split('.');
      if (!owner) return undefined;
      const cls = valueSymbol(st, owner, 'value');
      if (!cls) return undefined;
      if (parts.length === 2) return hasMember(cls, parts[1]) ? { id: `${cls.id}.${parts[1]}`, kind: 'calls' } : undefined;
      const typeName = fieldTypes?.get(parts[1]);
      if (!typeName) return undefined;
      const target = resolveName(st.id, typeName, 'type');
      if (target?.kind === 'class' && hasMember(target, parts[2])) return { id: `${target.id}.${parts[2]}`, kind: 'calls' };
      if (target && target.kind === 'interface') return { id: target.id, kind: 'uses' };
      return undefined;
    }
    const dot = callee.indexOf('.');
    if (dot > 0) {
      const head = callee.slice(0, dot);
      const tail = callee.slice(dot + 1);
      const localSym = valueSymbol(st, head, 'value');
      if (localSym?.kind === 'class') return hasMember(localSym, tail) ? { id: `${localSym.id}.${tail}`, kind: 'calls' } : undefined;
      const localInstance = instanceClass(localSym, st.id);
      if (localInstance) return hasMember(localInstance, tail) ? { id: `${localInstance.id}.${tail}`, kind: 'calls' } : undefined;
      const b = st.bindings.get(head);
      if (!b?.file) return undefined;
      if (b.imported !== '*') {
        const target = resolveExport(b.file, b.imported, 'value');
        if (target?.kind === 'class') return hasMember(target, tail) ? { id: `${target.id}.${tail}`, kind: 'calls' } : undefined;
        const inst = instanceClass(target, b.file);
        if (inst) return hasMember(inst, tail) ? { id: `${inst.id}.${tail}`, kind: 'calls' } : undefined;
      }
      const fn = resolveExport(b.file, tail, 'value');
      if (fn) return { id: fn.id, kind: 'calls' };
      // const svc = require('./userService') where the module exports `new UserService()`
      const inst = instanceClass(resolveExport(b.file, 'default', 'value'), b.file);
      if (inst && hasMember(inst, tail)) return { id: `${inst.id}.${tail}`, kind: 'calls' };
      return undefined;
    }
    const target = resolveName(st.id, callee, 'value');
    if (!target || target.kind === 'class' || target.kind === 'enum' || target.kind === 'namespace') return undefined;
    if (target.kind === 'constant' || target.kind === 'variable') {
      // Only link to callable constants (stores, factories); plain values are not calls.
      if (!target.tags?.length) return undefined;
    }
    return { id: target.id, kind: 'calls' };
  };

  for (const st of states.values()) {
    // Calls / instantiations
    for (const [key, facts] of st.parsed.facts) {
      let sourceId: string | undefined;
      const dot = key.indexOf('.');
      if (dot > 0) {
        const cls = valueSymbol(st, key.slice(0, dot), 'value');
        if (cls) sourceId = `${cls.id}.${key.slice(dot + 1)}`;
      } else {
        sourceId = valueSymbol(st, key, 'value')?.id ?? valueSymbol(st, key, 'type')?.id;
      }
      if (!sourceId) continue;
      const ownerFacts = facts.owner ? st.parsed.facts.get(facts.owner) : undefined;
      const fieldTypes = ownerFacts?.fieldTypes ?? facts.fieldTypes;
      for (const [callee, count] of facts.calls) {
        const hit = resolveCallee(st, facts.owner, fieldTypes, callee);
        if (hit) addSymbolEdge(sourceId, hit.id, hit.kind, count);
      }
    }
    for (const symbol of st.parsed.symbols) {
      // Renders
      if (symbol.component) {
        for (const r of symbol.component.renders) {
          let target = resolveName(st.id, r, 'value');
          if (!target && (st.ext === '.vue' || st.ext === '.astro')) {
            const regFile = vueRegistry.get(r);
            if (regFile && regFile !== st.id) {
              target = states.get(regFile)?.parsed.symbols.find((s) => s.isDefault && s.kind === 'component');
              if (target) addEdge(st.id, regFile, 'import', false, ['default'], symbol.line, `(auto-import) ${r}`);
            }
          }
          if (target && (target.kind === 'component' || target.kind === 'function' || target.kind === 'class')) addSymbolEdge(symbol.id, target.id, 'renders');
        }
        for (const c of symbol.component.contexts ?? []) {
          const target = resolveName(st.id, c, 'value');
          if (target) addSymbolEdge(symbol.id, target.id, 'uses');
        }
      }
      // Inheritance
      for (const e of symbol.extends ?? []) {
        const target = resolveName(st.id, e, 'type');
        if (target && target.id !== symbol.id) addSymbolEdge(symbol.id, target.id, 'extends');
      }
      for (const i of symbol.implements ?? []) {
        const target = resolveName(st.id, i, 'type');
        if (target) addSymbolEdge(symbol.id, target.id, 'implements');
      }
      // Type associations (UML "uses")
      if (TYPE_KINDS.has(symbol.kind) || symbol.kind === 'component') {
        const refs = st.parsed.facts.get(symbol.name)?.refs;
        if (!refs) continue;
        const inherited = new Set([...(symbol.extends ?? []), ...(symbol.implements ?? [])]);
        for (const ref of refs) {
          if (inherited.has(ref) || ref === symbol.name) continue;
          const target = resolveName(st.id, ref, 'type');
          if (target && TYPE_KINDS.has(target.kind) && target.id !== symbol.id) addSymbolEdge(symbol.id, target.id, 'uses');
        }
      }
    }
  }

  /* --------------------------------- Routes ---------------------------------- */
  const exportNames = (id: string): string[] => states.get(id)?.parsed.localExports.map((e) => e.name) ?? [];
  const fileRoutes = detectFileRoutes(ids, ctx, exportNames);
  const roles = fileRoutes.roles;
  const routes: RouteInfo[] = [];
  const routeIds = new Set<string>();
  const pushRoute = (route: Omit<RouteInfo, 'id'>): void => {
    const id = `${route.file}:${route.line ?? 0}:${route.method}:${route.path}`;
    if (routeIds.has(id)) return;
    routeIds.add(id);
    routes.push({ id, ...route });
  };
  for (const fr of fileRoutes.routes) {
    const st = states.get(fr.file);
    const handler = !st
      ? undefined
      : fr.type === 'api' && fr.method !== 'ALL'
        ? valueSymbol(st, fr.method, 'value')
        : fr.type === 'middleware'
          ? (valueSymbol(st, 'middleware', 'value') ?? st.parsed.symbols.find((s) => s.isDefault))
          : (st.parsed.symbols.find((s) => s.isDefault) ?? valueSymbol(st, 'handler', 'value') ?? valueSymbol(st, 'loader', 'value'));
    pushRoute({
      method: fr.method,
      path: fr.path,
      file: fr.file,
      line: handler?.line,
      handler: handler?.name,
      handlerSymbol: handler?.id,
      framework: fr.framework,
      type: fr.type,
      params: fr.params.length ? fr.params : undefined,
    });
  }

  // Express-style mounts: app.use('/api', router) → prefix routes in the router's file.
  const mounts: { parent: string; prefix: string; child: string }[] = [];
  const localMounts = new Map<string, string>(); // `${file}\0${receiver}` → prefix
  const filesWithServerRoutes = new Set(ids.filter((id) => states.get(id)!.parsed.routes.some((r) => r.type === 'api' || r.mountTargets || r.mountSpecifiers)));
  const mountKind = new Map<RawRoute, { children: string[] }>();
  for (const st of states.values()) {
    for (const r of st.parsed.routes) {
      if (r.method !== 'USE') continue;
      const children: string[] = [];
      for (const t of r.mountTargets ?? []) {
        const head = t.split('.')[0];
        const b = st.bindings.get(head);
        if (b?.file && filesWithServerRoutes.has(b.file)) children.push(b.file);
        else if (!b && st.parsed.routes.some((x) => x.receiver === head && x !== r)) localMounts.set(`${st.id}\0${head}`, r.path);
      }
      for (const s of r.mountSpecifiers ?? []) {
        const file = resolveFile(st.id, s);
        if (file && filesWithServerRoutes.has(file)) children.push(file);
      }
      for (const child of children) mounts.push({ parent: st.id, prefix: r.path, child });
      mountKind.set(r, { children });
    }
  }
  const prefixMemo = new Map<string, string[]>();
  const prefixesOf = (file: string, stack = new Set<string>()): string[] => {
    const memo = prefixMemo.get(file);
    if (memo) return memo;
    if (stack.has(file)) return [''];
    stack.add(file);
    const parents = mounts.filter((m) => m.child === file);
    const result = parents.length
      ? [...new Set(parents.flatMap((m) => prefixesOf(m.parent, stack).map((p) => joinRoute(p, m.prefix))))]
      : [''];
    stack.delete(file);
    prefixMemo.set(file, result);
    return result;
  };

  for (const st of states.values()) {
    for (const r of st.parsed.routes) {
      const localPrefix = r.receiver ? localMounts.get(`${st.id}\0${r.receiver}`) ?? '' : '';
      const prefixes = r.framework === 'nestjs' || r.type === 'page' || r.type === 'layout' ? [''] : prefixesOf(st.id);
      let handlerSymbol: string | undefined;
      if (r.framework === 'nestjs' && r.handler) {
        const [cls, method] = r.handler.split('.');
        const c = valueSymbol(st, cls, 'value');
        if (c) handlerSymbol = `${c.id}.${method}`;
      } else if (r.componentSpecifier) {
        const file = resolveFile(st.id, r.componentSpecifier);
        const target = file ? states.get(file) : undefined;
        handlerSymbol = target
          ? (target.parsed.symbols.find((s) => s.isDefault) ??
              valueSymbol(target, 'Component', 'value') ??
              target.parsed.symbols.find((s) => s.exported && s.kind === 'component'))?.id
          : undefined;
      } else if (r.component) {
        handlerSymbol = resolveName(st.id, r.component, 'value')?.id;
      } else if (r.handler && r.handler !== '(inline)') {
        handlerSymbol = resolveName(st.id, r.handler, 'value')?.id ?? resolveCallee(st, undefined, undefined, r.handler)?.id;
      }
      const isMount = r.method === 'USE' && (mountKind.get(r)?.children.length ?? 0) > 0;
      if (r.method === 'USE' && !isMount && !r.path.startsWith('/') && r.path !== '/') continue;
      for (const prefix of prefixes) {
        const full = r.type === 'page' || r.type === 'layout' ? r.path : joinRoute(prefix, localPrefix, r.path);
        pushRoute({
          method: r.method,
          path: r.path === '*' && !prefix && !localPrefix ? '*' : full,
          file: st.id,
          line: r.line,
          handler: r.handler,
          handlerSymbol,
          middlewares: r.middlewares,
          framework: r.framework,
          type: isMount ? 'mount' : r.type,
          params: [...full.matchAll(/:(\w+)|\[(?:\.\.\.)?(\w+)\]/g)].map((m) => m[1] ?? m[2]),
        });
      }
    }
  }
  for (const r of routes) if (r.params && !r.params.length) delete r.params;
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  /* -------------------------------- Entries ---------------------------------- */
  const entries = new Map<string, string>();
  const markEntry = (id: string | undefined, reason: string): void => {
    if (id && idSet.has(id) && !entries.has(id)) entries.set(id, reason);
  };
  const candidatesFor = (dir: string, field: string): string[] => {
    const rel = path.posix.normalize(path.posix.join(dir, field.replace(/^\.\//, '')));
    const noExt = rel.replace(/\.(d\.ts|[cm]?[jt]sx?)$/, '');
    const src = noExt.replace(/(^|\/)(dist|build|lib|out|esm|cjs)\//, '$1src/');
    return [rel, noExt, src];
  };
  const pkgs = [{ dir: '', pkg: ctx.pkg }, ...ctx.workspaces.map((w) => ({ dir: w.dir, pkg: w.pkg }))];
  const rootRel = toPosix(path.relative(root, ctx.pkgDir));
  for (const { dir: d, pkg } of pkgs) {
    const dir = d || (rootRel && !rootRel.startsWith('..') ? rootRel : '');
    const fields: [unknown, string][] = [
      [pkg.source, 'package.json "source"'],
      [pkg.main, 'package.json "main"'],
      [pkg.module, 'package.json "module"'],
      [typeof pkg.browser === 'string' ? pkg.browser : undefined, 'package.json "browser"'],
    ];
    if (typeof pkg.bin === 'string') fields.push([pkg.bin, 'package.json "bin"']);
    else if (pkg.bin) for (const v of Object.values(pkg.bin)) fields.push([v, 'package.json "bin"']);
    const collectExports = (value: unknown): void => {
      if (typeof value === 'string') fields.push([value, 'package.json "exports"']);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectExports);
    };
    collectExports(pkg.exports);
    for (const [field, reason] of fields) {
      if (typeof field !== 'string') continue;
      for (const c of candidatesFor(dir, field)) {
        const hit = resolver.lookup(c);
        if (hit) {
          markEntry(hit, reason);
          break;
        }
      }
    }
    const prefix = dir ? `${dir}/` : '';
    for (const id of ids) {
      if (!id.startsWith(prefix)) continue;
      const rel = id.slice(prefix.length);
      if (/^(src\/)?(main|index|server|app|cli|bootstrap)\.[cm]?[jt]sx?$/.test(rel)) markEntry(id, 'conventional entry file');
      if (/^(src\/)?(App|app)\.vue$/.test(rel)) markEntry(id, 'root component');
      if (/^app\/(root|entry\.client|entry\.server)\.[jt]sx?$/.test(rel)) markEntry(id, 'framework entry');
      if (/^(src\/)?app\/layout\.[jt]sx?$/.test(rel)) markEntry(id, 'root layout');
      if (/^(src\/)?pages\/_app\.[jt]sx?$/.test(rel)) markEntry(id, 'custom App');
      if (/^(src\/)?hooks\.(server|client)\.[jt]s$/.test(rel)) markEntry(id, 'SvelteKit hooks');
    }
  }
  for (const s of ctx.scriptEntries) markEntry(resolver.lookup(s), 'referenced by a script / index.html');
  // Build tool configs (tsup / vite / webpack / rollup…) point at entry files: `entry: 'src/cli.ts'`.
  for (const st of states.values()) {
    const base = path.posix.basename(st.id);
    if (!/(^|\.)config\.[cm]?[jt]s$/.test(base) && !/^(webpack|rollup|vite|tsup|esbuild|electron)\b/.test(base)) continue;
    const dir = path.posix.dirname(st.id);
    for (const m of st.text.matchAll(/['"`]((?:\.{1,2}\/)?[\w@\-./]+\.(?:[cm]?[jt]sx?|vue|svelte))['"`]/g)) {
      const candidate = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, m[1]));
      if (candidate === st.id) continue;
      markEntry(resolver.lookup(candidate), `referenced in ${base}`);
    }
  }

  /* -------------------------------- Metrics ---------------------------------- */
  const edges = [...edgeMap.values()];
  const allAdj = buildAdjacency(ids, edges);
  const runtimeAdj = buildAdjacency(
    ids,
    edges.filter((e) => !e.typeOnly),
  );
  const revAdj = reverse(allAdj);
  const importance = pageRank(allAdj);

  const sccs = stronglyConnectedComponents(runtimeAdj);
  const sccOf = new Map<string, number>();
  sccs.forEach((c, i) => c.forEach((id) => sccOf.set(id, i)));
  for (const e of edges) {
    const a = sccOf.get(e.source);
    if (a !== undefined && a === sccOf.get(e.target) && !e.typeOnly) e.inCycle = true;
  }
  const cycles = sccs.map((c) => {
    const sample = sampleCycle(runtimeAdj, c);
    return [...sample, ...c.filter((id) => !sample.includes(id))];
  });

  /* ---------------------------------- Git ------------------------------------ */
  let git: Awaited<ReturnType<typeof analyzeGit>>;
  if (options.git !== false) {
    progress('git');
    git = await analyzeGit(root, idSet).catch(() => undefined);
  }

  progress('insights');

  /* ----------------------------- Unused exports ------------------------------ */
  const used = new Map<string, Set<string>>();
  const allUsed = new Set<string>();
  const markUsed = (file: string, name: string, depth = 0): void => {
    if (depth > 15) return;
    const st = states.get(file);
    if (!st) return;
    if (name === '*') {
      if (allUsed.has(file)) return;
      allUsed.add(file);
      for (const re of st.parsed.reexports) {
        const t = resolveFile(file, re.specifier);
        if (!t) continue;
        if (re.star) markUsed(t, '*', depth + 1);
        else re.names.forEach((n) => markUsed(t, n.imported, depth + 1));
      }
      return;
    }
    let set = used.get(file);
    if (!set) {
      set = new Set();
      used.set(file, set);
    }
    if (set.has(name)) return;
    set.add(name);
    for (const re of st.parsed.reexports) {
      if (re.star) continue;
      for (const n of re.names) {
        if (n.exported !== name) continue;
        const t = resolveFile(file, re.specifier);
        if (t) markUsed(t, n.imported, depth + 1);
      }
    }
    if (!st.parsed.localExports.some((e) => e.name === name)) {
      for (const re of st.parsed.reexports) {
        if (!re.star) continue;
        const t = resolveFile(file, re.specifier);
        if (t) markUsed(t, name, depth + 1);
      }
    }
  };
  for (const e of edges) {
    if (e.kind === 'side-effect') continue;
    if (e.kind === 'dynamic' || e.kind === 'require' && e.names.includes('*')) {
      markUsed(e.target, '*');
      continue;
    }
    if (e.kind === 'reexport') continue; // handled through the chain when the barrel is used
    for (const n of e.names) markUsed(e.target, n);
  }
  // Things consumed by frameworks / tools count as used.
  const frameworkConsumed = (id: string): boolean => {
    const st = states.get(id)!;
    return (
      entries.has(id) ||
      roles.has(id) ||
      isTestFile(id) ||
      /\.(stories|story)\./.test(id) ||
      /\.d\.ts$/.test(id) ||
      /(^|\/)[\w.-]*config\.[cm]?[jt]s$/.test(id) ||
      st.ext === '.vue' ||
      st.ext === '.svelte' ||
      st.ext === '.astro'
    );
  };
  for (const id of ids) if (frameworkConsumed(id)) markUsed(id, '*');

  const unusedExports: ReportData['insights']['unusedExports'] = [];
  const unusedByFile = new Map<string, Set<string>>();
  for (const st of states.values()) {
    if (allUsed.has(st.id)) continue;
    const set = used.get(st.id);
    for (const e of st.parsed.localExports) {
      if (e.local === '__module_exports__') continue;
      if (set?.has(e.name)) continue;
      // CommonJS modules required without destructuring use everything.
      unusedExports.push({ file: st.id, name: e.name, line: e.line, typeOnly: e.typeOnly || undefined });
      const s = unusedByFile.get(st.id) ?? new Set();
      s.add(e.name);
      unusedByFile.set(st.id, s);
    }
  }

  /* --------------------------------- Files ----------------------------------- */
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of edges) {
    fanOut.set(e.source, (fanOut.get(e.source) ?? 0) + 1);
    fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1);
  }

  const includeSource = options.includeSource !== false;
  let sourceBudget = MAX_TOTAL_SOURCE;
  const files: FileInfo[] = [];
  for (const st of states.values()) {
    const p = st.parsed;
    const fi = fanIn.get(st.id) ?? 0;
    const fo = fanOut.get(st.id) ?? 0;
    const isEntry = entries.has(st.id);
    const role: FileRole | undefined = roles.get(st.id);
    const kind = classifyFile(st.id, p, role, isEntry);
    const dir = path.posix.dirname(st.id);
    const unusedNames = unusedByFile.get(st.id);
    const info: FileInfo = {
      id: st.id,
      name: path.posix.basename(st.id),
      dir: dir === '.' ? '' : dir,
      ext: st.ext,
      language: p.language,
      kind,
      loc: p.loc,
      sloc: p.sloc,
      bytes: st.bytes,
      complexity: p.complexity,
      maxComplexity: p.maxComplexity,
      symbols: p.symbols,
      exports: dedupeExports(p, unusedNames),
      assets: st.assets,
      unresolved: st.unresolved,
      isEntry,
      entryReason: entries.get(st.id),
      isTest: kind === 'test',
      isGenerated: p.isGenerated || undefined,
      inCycle: sccOf.has(st.id) || undefined,
      directives: p.directives.length ? p.directives : undefined,
      description: p.description,
      todos: p.todos,
      git: git?.files.get(st.id),
      metrics: {
        fanIn: fi,
        fanOut: fo,
        importance: importance.get(st.id) ?? 0,
        instability: fi + fo ? Math.round((fo / (fi + fo)) * 100) / 100 : 0,
        externalImports: st.packages.size,
      },
      parseError: p.parseError,
    };
    const orphanCandidate =
      fi === 0 &&
      !isEntry &&
      !role &&
      !['test', 'story', 'config', 'script'].includes(kind) &&
      !st.id.endsWith('.d.ts') &&
      !p.isGenerated &&
      !/(^|\/)(examples?|demo|docs?|playground|fixtures|__fixtures__|scripts)\//.test(st.id);
    if (orphanCandidate) info.orphan = true;
    if (includeSource && st.bytes <= MAX_SOURCE_BYTES && sourceBudget > 0) {
      info.source = st.text;
      sourceBudget -= st.bytes;
    }
    files.push(info);
  }

  /* ------------------------------ Packages ----------------------------------- */
  let packages: PackageInfo[] = [...pkgUsage.entries()].map(([name, u]) => {
    const declared = ctx.declared.get(name);
    return {
      name,
      version: declared?.version,
      declaredAs: declared?.declaredAs,
      builtin: u.builtin,
      importedBy: [...u.files].sort(),
      names: [...u.names.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([n]) => n),
      importCount: u.count,
      typeOnly: u.typeOnly,
    };
  });
  const scriptsText = Object.values(ctx.pkg.scripts ?? {}).join(' ');
  const hasManifest = Object.keys(ctx.pkg).length > 0;
  const health = hasManifest ? markPackageHealth(packages, ctx.declared, scriptsText) : { unused: [], missing: [] };
  const missingSet = new Set(health.missing.map((m) => m.name));
  for (const p of packages) if (missingSet.has(p.name)) p.missing = true;
  // Unused declared dependencies are listed as packages too so they show up in the Packages view.
  for (const name of health.unused) {
    const d = ctx.declared.get(name)!;
    packages.push({ name, version: d.version, declaredAs: d.declaredAs, builtin: false, importedBy: [], names: [], importCount: 0, typeOnly: false, unused: true });
  }

  /* --------------------------- Complex functions ----------------------------- */
  const complexFunctions = files
    .filter((f) => f.kind !== 'test')
    .flatMap((f) =>
      f.symbols
        .filter((s) => (s.kind === 'function' || s.kind === 'component' || s.kind === 'hook') && (s.complexity ?? 0) > 1)
        .map((s) => ({ symbol: s.id, file: f.id, name: s.name, complexity: s.complexity ?? 0, line: s.line, loc: s.loc })),
    )
    .sort((a, b) => b.complexity - a.complexity)
    .slice(0, 40);

  /* -------------------------------- Hotspots --------------------------------- */
  let hotspots: ReportData['insights']['hotspots'] = [];
  if (git) {
    const candidates = files.filter((f) => f.git && f.git.commits >= 2 && f.kind !== 'test' && f.kind !== 'config');
    const maxCommits = Math.max(1, ...candidates.map((f) => f.git!.commits));
    const maxComplexity = Math.max(1, ...candidates.map((f) => f.complexity));
    hotspots = candidates
      .map((f) => ({
        file: f.id,
        commits: f.git!.commits,
        complexity: f.complexity,
        loc: f.loc,
        score: Math.round((f.git!.commits / maxCommits) * (f.complexity / maxComplexity) * 1000) / 10,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }

  /* ------------------------------ Apply scope -------------------------------- */
  let roleOf: Map<string, ScopeRole> | undefined;
  if (scope.type === 'file') {
    const target = scope.path!;
    const deps = reachable(allAdj, target, options.depth ?? Infinity);
    const dependents = reachable(revAdj, target, options.depth ?? 2);
    roleOf = new Map();
    for (const id of dependents.keys()) roleOf.set(id, 'dependent');
    for (const id of deps.keys()) roleOf.set(id, 'dependency');
    roleOf.set(target, 'focus');
  } else if (scope.type === 'directory') {
    const dir = scope.path!;
    roleOf = new Map();
    for (const id of ids) if (!dir || id.startsWith(`${dir}/`)) roleOf.set(id, 'member');
    for (const e of edges) {
      const s = roleOf.get(e.source);
      const t = roleOf.get(e.target);
      if (s === 'member' && !t) roleOf.set(e.target, 'context');
      if (t === 'member' && !s) roleOf.set(e.source, 'context');
    }
  }

  let scopedFiles = files;
  let scopedEdges = edges;
  let scopedRoutes = routes;
  let symbolEdges = [...symbolEdgeMap.values()];
  if (roleOf) {
    const r = roleOf;
    const core = (id: string): boolean => r.has(id) && r.get(id) !== 'context';
    scopedFiles = files.filter((f) => r.has(f.id));
    for (const f of scopedFiles) f.scope = r.get(f.id);
    for (const f of scopedFiles) if (f.scope === 'context') delete f.source;
    scopedEdges = edges.filter((e) => r.has(e.source) && r.has(e.target) && (core(e.source) || core(e.target)));
    scopedRoutes = routes.filter((x) => core(x.file));
    const fileOfSymbol = (id: string): string => id.slice(0, id.indexOf('#'));
    symbolEdges = symbolEdges.filter((e) => r.has(fileOfSymbol(e.source)) && r.has(fileOfSymbol(e.target)));
    packages = packages
      .map((p) => ({ ...p, importedBy: p.importedBy.filter(core) }))
      .filter((p) => p.importedBy.length || (scope.type === 'directory' && !scope.path && p.unused));
  }
  const coreFiles = scopedFiles.filter((f) => f.scope !== 'context');
  const coreSet = new Set(coreFiles.map((f) => f.id));

  const insights: ReportData['insights'] = {
    cycles: cycles.filter((c) => c.some((id) => coreSet.has(id))),
    orphans: coreFiles.filter((f) => f.orphan).map((f) => f.id),
    unusedExports: unusedExports.filter((u) => coreSet.has(u.file)),
    unusedDependencies: roleOf ? [] : health.unused,
    missingDependencies: health.missing
      .map((m) => ({ ...m, files: m.files.filter((f) => coreSet.has(f)) }))
      .filter((m) => m.files.length),
    complexFunctions: complexFunctions.filter((c) => coreSet.has(c.file)),
    hotspots: hotspots.filter((h) => coreSet.has(h.file)),
    changeCoupling: (git?.coupling ?? []).filter((c) => coreSet.has(c.a) || coreSet.has(c.b)).slice(0, 60),
    duplicateSymbols: findDuplicates(coreFiles),
  };

  /* --------------------------------- Stats ----------------------------------- */
  const languages = new Map<Language, { files: number; loc: number }>();
  for (const f of coreFiles) {
    const l = languages.get(f.language) ?? { files: 0, loc: 0 };
    l.files++;
    l.loc += f.loc;
    languages.set(f.language, l);
  }
  const allSymbols = coreFiles.flatMap((f) => f.symbols);
  const countKind = (k: SymbolInfo['kind']): number => allSymbols.filter((s) => s.kind === k).length;
  const complexities = allSymbols.filter((s) => s.complexity && (s.kind === 'function' || s.kind === 'component' || s.kind === 'hook'));
  const stats: Stats = {
    files: coreFiles.length,
    loc: coreFiles.reduce((n, f) => n + f.loc, 0),
    sloc: coreFiles.reduce((n, f) => n + f.sloc, 0),
    symbols: allSymbols.length,
    components: countKind('component'),
    hooks: countKind('hook'),
    functions: countKind('function'),
    classes: countKind('class'),
    interfaces: countKind('interface'),
    types: countKind('type'),
    enums: countKind('enum'),
    constants: countKind('constant'),
    variables: countKind('variable'),
    routes: scopedRoutes.length,
    packages: packages.filter((p) => !p.builtin && p.importedBy.length).length,
    internalEdges: scopedEdges.length,
    testFiles: coreFiles.filter((f) => f.kind === 'test').length,
    todos: coreFiles.reduce((n, f) => n + f.todos.length, 0),
    avgComplexity: complexities.length
      ? Math.round((complexities.reduce((n, s) => n + (s.complexity ?? 0), 0) / complexities.length) * 10) / 10
      : 0,
    durationMs: 0,
  };

  const project: ReportData['project'] = {
    name: ctx.pkg.name ?? path.basename(root),
    version: ctx.pkg.version,
    description: ctx.pkg.description,
    rootName: path.basename(root),
    rootPath: root,
    frameworks: ctx.frameworks,
    languages: [...languages.entries()].map(([language, v]) => ({ language, ...v })).sort((a, b) => b.loc - a.loc),
    packageManager: ctx.packageManager,
    typescript: ctx.hasTypeScript || coreFiles.some((f) => f.language === 'typescript'),
    workspaces: ctx.workspaces.length ? ctx.workspaces.map((w) => w.dir) : undefined,
    scripts: ctx.pkg.scripts,
    engines: ctx.pkg.engines,
    license: ctx.pkg.license,
    git: git?.info,
  };

  const folders = buildFolders(coreFiles);
  const partial: Omit<ReportData, 'tour'> = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'code-visualizer', version: options.toolVersion ?? '0.0.0' },
    generatedAt: new Date().toISOString(),
    scope,
    options: { includeSource, git: !!git },
    project,
    files: scopedFiles.sort((a, b) => a.id.localeCompare(b.id)),
    edges: scopedEdges,
    packages: packages.sort((a, b) => b.importedBy.length - a.importedBy.length || a.name.localeCompare(b.name)),
    symbolEdges,
    routes: scopedRoutes,
    insights,
    folders,
    stats,
    git: git?.summary,
    warnings,
  };
  const tour = buildTour(partial);
  stats.durationMs = Date.now() - started;
  progress('done');
  return { ...partial, tour };
}

function dedupeExports(p: ParsedFile, unused: Set<string> | undefined): FileInfo['exports'] {
  const out: FileInfo['exports'] = [];
  const seen = new Set<string>();
  for (const e of p.localExports) {
    if (e.local === '__module_exports__' || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, line: e.line, isDefault: e.name === 'default' || undefined, typeOnly: e.typeOnly || undefined, unused: unused?.has(e.name) || undefined });
  }
  for (const re of p.reexports) {
    if (re.star) {
      out.push({ name: '*', line: re.line, from: re.specifier, typeOnly: re.typeOnly || undefined });
      continue;
    }
    for (const n of re.names) {
      if (seen.has(n.exported)) continue;
      seen.add(n.exported);
      out.push({ name: n.exported, line: re.line, from: re.specifier, typeOnly: re.typeOnly || undefined });
    }
  }
  return out;
}

export type { ProjectContext };
