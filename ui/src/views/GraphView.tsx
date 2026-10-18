import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Core, ElementDefinition, EventObject, LayoutOptions, NodeSingular } from 'cytoscape';
import {
  Crosshair,
  Download,
  Expand,
  FolderOpen,
  FolderMinus,
  Info,
  Maximize2,
  Radar,
  Recycle,
  Route as PathIcon,
  GitPullRequestArrow,
  SlidersHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useModel } from '../data/context';
import { transitive } from '../../../src/shared/query';
import { shortestPath, type Model } from '../data/model';
import { categorical, freshness, heat, KIND_META } from '../lib/colors';
import { copyText, downloadBlob, downloadUrl, toDot, toMermaid, type ExportGraph } from '../lib/download';
import { basename, fmtNum, plural } from '../lib/format';
import { select, selectFile, useStore, type GraphMode } from '../state/store';
import type { FileInfo, FileKind } from '../types';
import { baseStyle, ensureCytoscape, fitTo, themeColors } from '../components/cy';
import { personColor } from '../components/companion';
import { KindDot, SearchInput, Select, Toggle } from '../components/ui';

/* -------------------------------------------------------------------------- */
/*                                   Settings                                 */
/* -------------------------------------------------------------------------- */

type LayoutName = 'fcose' | 'dagre' | 'dagre-tb' | 'concentric' | 'circle' | 'grid';
type ColorBy = 'kind' | 'folder' | 'complexity' | 'churn' | 'importance' | 'age' | 'owner';
type SizeBy = 'loc' | 'fanIn' | 'importance' | 'uniform';

interface Settings {
  level: number;
  expanded: string[];
  layout: LayoutName;
  colorBy: ColorBy;
  sizeBy: SizeBy;
  compound: boolean;
  showTests: boolean;
  showConfig: boolean;
  showTypeOnly: boolean;
  showPackages: boolean;
  labels: boolean;
  cycles: boolean;
  showChanges: boolean;
  hiddenKinds: FileKind[];
}

type Mode =
  | { type: 'explore' }
  | { type: 'focus'; id: string; depth: number; direction: 'both' | 'deps' | 'dependents' }
  | { type: 'impact'; id: string }
  | { type: 'subset'; files: string[]; label: string; cycle?: boolean; path?: string[] };

let persistedSettings: Settings | undefined;
let persistedMode: Mode | undefined;
let lastRequestNonce = -1;

function computeExpanded(model: Model, level: number, files: FileInfo[]): string[] {
  const expanded = new Set<string>();
  const visibleDirs = new Set<string>();
  for (const f of files) {
    const parts = f.dir ? f.dir.split('/') : [];
    for (let i = 1; i <= parts.length; i++) visibleDirs.add(parts.slice(0, i).join('/'));
  }
  for (const dir of visibleDirs) if (dir.split('/').length < level) expanded.add(dir);
  // Auto-expand "pass-through" folders that only wrap a single sub-folder (e.g. `src/`).
  const visit = (path: string): void => {
    const node = model.folderByPath.get(path);
    if (!node) return;
    const childFolders = node.folders.filter((f) => visibleDirs.has(f.path));
    const directFiles = node.files.filter((f) => files.includes(f));
    if (path && !expanded.has(path) && childFolders.length === 1 && directFiles.length === 0) expanded.add(path);
    if (!path || expanded.has(path)) childFolders.forEach((c) => visit(c.path));
  };
  visit('');
  return [...expanded];
}

function filterFiles(model: Model, s: Settings): FileInfo[] {
  const hidden = new Set(s.hiddenKinds);
  return model.files.filter((f) => {
    if (hidden.has(f.kind)) return false;
    if (!s.showTests && (f.kind === 'test' || f.kind === 'story')) return false;
    if (!s.showConfig && (f.kind === 'config' || f.kind === 'script')) return false;
    return true;
  });
}

function initialSettings(model: Model): Settings {
  const base: Settings = {
    level: 99,
    expanded: [],
    layout: 'fcose',
    colorBy: 'kind',
    sizeBy: 'loc',
    compound: true,
    showTests: false,
    showConfig: false,
    showTypeOnly: true,
    showPackages: false,
    labels: true,
    cycles: model.data.insights.cycles.length > 0 && model.data.insights.cycles.length < 20,
    showChanges: true,
    hiddenKinds: [],
  };
  const files = filterFiles(model, base);
  // Pick the deepest folder level that keeps the first view readable (~140 nodes).
  let level = model.maxDepth + 1;
  for (; level > 1; level--) {
    const expanded = new Set(computeExpanded(model, level, files));
    const reps = new Set(files.map((f) => repOf(f, expanded)));
    if (reps.size <= 90) break;
  }
  base.level = level;
  base.expanded = computeExpanded(model, level, files);
  if (files.length > 600) base.compound = false;
  return base;
}

function repOf(file: FileInfo, expanded: Set<string>): string {
  if (!file.dir) return file.id;
  const parts = file.dir.split('/');
  let p = '';
  for (const part of parts) {
    p = p ? `${p}/${part}` : part;
    if (!expanded.has(p)) return `dir:${p}`;
  }
  return file.id;
}

/* -------------------------------------------------------------------------- */
/*                                 Graph model                                */
/* -------------------------------------------------------------------------- */

interface NodeStats {
  id: string;
  type: 'file' | 'folder' | 'package';
  label: string;
  title: string;
  kind?: FileKind;
  files: number;
  loc: number;
  complexity: number;
  commits: number;
  importance: number;
  fanIn: number;
  lastModified: number;
  topFolder: string;
  parent?: string;
  kinds?: Map<FileKind, number>;
  inCycle?: boolean;
  scope?: string;
  authors?: Map<string, number>;
}

interface GEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  typeOnly: boolean;
  inCycle: boolean;
}

interface Built {
  nodes: NodeStats[];
  groups: { id: string; label: string; parent?: string }[];
  edges: GEdge[];
  fileIds: Set<string>;
  repOfFile: Map<string, string>;
}

function topFolderOf(dir: string, srcHeavy: boolean): string {
  const parts = dir.split('/');
  if (srcHeavy && parts[0] === 'src' && parts.length > 1) return `src/${parts[1]}`;
  return parts[0] ?? '';
}

function buildGraph(model: Model, s: Settings, mode: Mode): Built {
  let files = filterFiles(model, s);
  let expanded = new Set(s.expanded);
  const runtimeOnly = !s.showTypeOnly;
  if (mode.type !== 'explore') {
    let keep: Set<string>;
    if (mode.type === 'focus') {
      keep = new Set([mode.id]);
      if (mode.direction !== 'dependents') for (const id of transitive(model.data, mode.id, 'deps', mode.depth, runtimeOnly).keys()) keep.add(id);
      if (mode.direction !== 'deps') for (const id of transitive(model.data, mode.id, 'dependents', mode.depth, runtimeOnly).keys()) keep.add(id);
    } else if (mode.type === 'impact') {
      keep = new Set([mode.id, ...transitive(model.data, mode.id, 'dependents', Infinity, runtimeOnly).keys()]);
    } else {
      keep = new Set(mode.files);
    }
    files = model.files.filter((f) => keep.has(f.id));
    expanded = new Set([...model.folderByPath.keys()]);
  }
  const srcHeavy = files.filter((f) => f.id.startsWith('src/')).length > files.length * 0.6;
  const fileIds = new Set(files.map((f) => f.id));
  const repOfFile = new Map<string, string>();
  const stats = new Map<string, NodeStats>();
  for (const f of files) {
    const rep = repOf(f, expanded);
    repOfFile.set(f.id, rep);
    let n = stats.get(rep);
    if (!n) {
      const isFolder = rep.startsWith('dir:');
      const folderPath = isFolder ? rep.slice(4) : '';
      const label = isFolder
        ? `${basename(folderPath)}/`
        : /^(index|page|layout|route|main|\+page|\+layout|\+server)\./.test(f.name) && f.dir
          ? `${basename(f.dir)}/${f.name}`
          : f.name;
      n = {
        id: rep,
        type: isFolder ? 'folder' : 'file',
        label,
        title: isFolder ? folderPath : f.id,
        kind: isFolder ? undefined : f.kind,
        files: 0,
        loc: 0,
        complexity: 0,
        commits: 0,
        importance: 0,
        fanIn: 0,
        lastModified: 0,
        topFolder: topFolderOf(isFolder ? folderPath : f.dir, srcHeavy),
        kinds: isFolder ? new Map() : undefined,
        scope: isFolder ? undefined : f.scope,
      };
      stats.set(rep, n);
    }
    n.files++;
    n.loc += f.loc;
    n.complexity += f.complexity;
    n.commits += f.git?.commits ?? 0;
    n.importance = Math.max(n.importance, f.metrics.importance);
    n.fanIn += f.metrics.fanIn;
    n.lastModified = Math.max(n.lastModified, f.git?.lastModified ?? 0);
    if (f.inCycle) n.inCycle = true;
    n.kinds?.set(f.kind, (n.kinds.get(f.kind) ?? 0) + 1);
    const top = f.git?.authors[0];
    if (top) {
      n.authors ??= new Map();
      n.authors.set(top.name, (n.authors.get(top.name) ?? 0) + f.git!.commits);
    }
  }
  for (const n of stats.values()) {
    if (n.type === 'folder') {
      n.label = `${n.label}\n${n.files} files`;
      n.complexity = n.complexity / Math.max(1, n.files);
    }
  }

  // Edges
  const edgeMap = new Map<string, GEdge>();
  for (const e of model.data.edges) {
    if (runtimeOnly && e.typeOnly) continue;
    const a = repOfFile.get(e.source);
    const b = repOfFile.get(e.target);
    if (!a || !b || a === b) continue;
    const key = `${a}->${b}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight++;
      existing.typeOnly = existing.typeOnly && e.typeOnly;
      existing.inCycle = existing.inCycle || !!e.inCycle;
    } else edgeMap.set(key, { id: key, source: a, target: b, weight: 1, typeOnly: e.typeOnly, inCycle: !!e.inCycle });
  }

  // External packages
  if (s.showPackages) {
    const pkgs = model.data.packages
      .filter((p) => !p.builtin)
      .map((p) => ({ p, files: p.importedBy.filter((id) => fileIds.has(id)) }))
      .filter((x) => x.files.length)
      .sort((a, b) => b.files.length - a.files.length)
      .slice(0, 40);
    for (const { p, files: importers } of pkgs) {
      const id = `pkg:${p.name}`;
      stats.set(id, { id, type: 'package', label: p.name, title: p.name, files: importers.length, loc: 0, complexity: 0, commits: 0, importance: 0, fanIn: importers.length, lastModified: 0, topFolder: '' });
      for (const fid of importers) {
        const rep = repOfFile.get(fid)!;
        const key = `${rep}->${id}`;
        const existing = edgeMap.get(key);
        if (existing) existing.weight++;
        else edgeMap.set(key, { id: key, source: rep, target: id, weight: 1, typeOnly: false, inCycle: false });
      }
    }
  }

  // Compound folder boxes (skipping boxes that would only wrap a single child)
  const groups: Built['groups'] = [];
  if (s.compound) {
    const containerOf = (n: NodeStats): string => {
      if (n.type === 'package') return '';
      if (n.type === 'folder') {
        const p = n.id.slice(4);
        return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      }
      return model.fileById.get(n.id)?.dir ?? '';
    };
    const parentDir = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    const containers = new Map<string, { nodes: NodeStats[]; children: Set<string> }>();
    const ensure = (p: string): { nodes: NodeStats[]; children: Set<string> } => {
      let c = containers.get(p);
      if (!c) {
        c = { nodes: [], children: new Set() };
        containers.set(p, c);
        if (p) ensure(parentDir(p)).children.add(p);
      }
      return c;
    };
    for (const n of stats.values()) ensure(containerOf(n)).nodes.push(n);
    const alive = new Map<string, string>(); // container → surviving container it maps to
    const order = [...containers.keys()].sort((a, b) => b.split('/').length - a.split('/').length);
    const survivors = new Set<string>();
    for (const p of order) {
      if (!p) continue;
      const c = containers.get(p)!;
      const childCount = c.nodes.length + [...c.children].filter((x) => survivors.has(x)).length;
      if (childCount >= 2) survivors.add(p);
    }
    const resolve = (p: string): string => {
      let cur = p;
      while (cur && !survivors.has(cur)) cur = parentDir(cur);
      return cur;
    };
    for (const p of containers.keys()) alive.set(p, resolve(p));
    for (const p of survivors) {
      const parent = resolve(parentDir(p));
      const label = parent ? p.slice(parent.length + 1) : p;
      groups.push({ id: `grp:${p}`, label: `${label}/`, parent: parent ? `grp:${parent}` : undefined });
    }
    for (const n of stats.values()) {
      const c = alive.get(containerOf(n));
      if (c) n.parent = `grp:${c}`;
    }
  }

  return { nodes: [...stats.values()], groups, edges: [...edgeMap.values()], fileIds, repOfFile };
}

/* -------------------------------------------------------------------------- */
/*                                  Visuals                                   */
/* -------------------------------------------------------------------------- */

function dominantKind(n: NodeStats): FileKind | undefined {
  if (n.kind) return n.kind;
  let best: FileKind | undefined;
  let max = 0;
  for (const [k, v] of n.kinds ?? []) if (v > max) (best = k), (max = v);
  return best;
}

function decorate(built: Built, s: Settings, model: Model): Map<string, { color: string; size: number; w: number; shape: string }> {
  const nodes = built.nodes;
  const tops = [...new Set(nodes.map((n) => n.topFolder))].sort();
  const maxLoc = Math.max(1, ...nodes.filter((n) => n.type !== 'package').map((n) => n.loc));
  const maxFan = Math.max(1, ...nodes.map((n) => n.fanIn));
  const maxCommits = Math.max(1, ...nodes.map((n) => n.commits));
  const complexities = nodes.filter((n) => n.type !== 'package').map((n) => n.complexity).sort((a, b) => a - b);
  const p95 = Math.max(1, complexities[Math.floor(complexities.length * 0.95)] ?? 1);
  const maxFiles = Math.max(1, ...nodes.filter((n) => n.type === 'folder').map((n) => n.files));
  const now = Date.now();
  const out = new Map<string, { color: string; size: number; w: number; shape: string }>();
  for (const n of nodes) {
    let color = '#7c8aa5';
    if (n.type === 'package') color = '#f59e0b';
    else if (s.colorBy === 'kind') color = KIND_META[dominantKind(n) ?? 'module'].color;
    else if (s.colorBy === 'folder') color = categorical(tops.indexOf(n.topFolder));
    else if (s.colorBy === 'complexity') color = heat(n.complexity / p95);
    else if (s.colorBy === 'churn') color = model.data.git ? heat(n.commits / maxCommits) : '#7c8aa5';
    else if (s.colorBy === 'importance') color = heat(Math.sqrt(n.importance));
    else if (s.colorBy === 'age') color = n.lastModified ? freshness((now - n.lastModified) / (365 * 86_400_000)) : '#64748b';
    else if (s.colorBy === 'owner') {
      const owner = n.authors ? [...n.authors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] : undefined;
      color = owner ? personColor(owner) : '#64748b';
    }
    let size = 26;
    if (n.type === 'folder') size = 44 + 46 * Math.sqrt(n.files / maxFiles);
    else if (n.type === 'package') size = 18 + 18 * Math.sqrt(n.fanIn / maxFan);
    else if (s.sizeBy === 'loc') size = 16 + 38 * Math.sqrt(n.loc / maxLoc);
    else if (s.sizeBy === 'fanIn') size = 16 + 38 * Math.sqrt(n.fanIn / maxFan);
    else if (s.sizeBy === 'importance') size = 16 + 38 * Math.sqrt(n.importance);
    const w = n.type === 'folder' ? Math.max(size * 1.6, n.label.split('\n')[0].length * 8 + 28) : n.type === 'package' ? Math.max(40, n.label.length * 6.2 + 16) : size;
    const shape = n.type === 'folder' || n.type === 'package' ? 'round-rectangle' : KIND_META[n.kind ?? 'module'].shape;
    out.set(n.id, { color, size: n.type === 'package' ? 22 : size, w, shape });
  }
  return out;
}

function layoutOptions(name: LayoutName, count: number, compound: boolean): LayoutOptions {
  const animate = count < 250;
  switch (name) {
    case 'dagre':
    case 'dagre-tb':
      return { name: 'dagre', rankDir: name === 'dagre' ? 'LR' : 'TB', nodeSep: 16, rankSep: 80, edgeSep: 8, animate, animationDuration: 450, fit: true, padding: 40 } as LayoutOptions;
    case 'concentric':
      return {
        name: 'concentric',
        concentric: (n: NodeSingular) => (n.data('importance') as number) * 10 + (n.data('fanIn') as number) / 50,
        levelWidth: () => 1.2,
        minNodeSpacing: 14,
        animate,
        fit: true,
        padding: 40,
      } as unknown as LayoutOptions;
    case 'circle':
      return { name: 'circle', animate, fit: true, padding: 40, avoidOverlap: true } as LayoutOptions;
    case 'grid':
      return { name: 'grid', animate, fit: true, padding: 40, avoidOverlap: true, condense: true } as LayoutOptions;
    default:
      return {
        name: 'fcose',
        quality: count > 900 ? 'draft' : 'default',
        randomize: true,
        animate,
        animationDuration: 650,
        fit: true,
        padding: 40,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 4500,
        idealEdgeLength: () => 55,
        edgeElasticity: () => 0.45,
        nestingFactor: compound ? 0.5 : 0.1,
        gravity: 0.6,
        gravityRangeCompound: 1.5,
        gravityCompound: 1.5,
        numIter: count > 900 ? 1200 : 2500,
        packComponents: true,
        componentSpacing: 30,
        tile: true,
        tilingPaddingVertical: 10,
        tilingPaddingHorizontal: 10,
      } as unknown as LayoutOptions;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Component                                 */
/* -------------------------------------------------------------------------- */

export function GraphView() {
  const model = useModel();
  const theme = useStore((s) => s.theme);
  const selection = useStore((s) => s.selection);
  const request = useStore((s) => s.graphRequest);
  const [settings, setSettingsState] = useState<Settings>(() => persistedSettings ?? initialSettings(model));
  const [mode, setModeState] = useState<Mode>(() => persistedMode ?? { type: 'explore' });
  const [showSettings, setShowSettings] = useState(false);
  const [search, setSearch] = useState('');
  const [hover, setHover] = useState<{ x: number; y: number; id: string } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [laying, setLaying] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const tapRef = useRef(false);
  const layingRef = useRef(false);
  const pendingCenter = useRef<string | null>(null);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      persistedSettings = next;
      return next;
    });
  }, []);
  const setMode = useCallback((m: Mode) => {
    persistedMode = m;
    setModeState(m);
    setActive(null);
  }, []);

  // Requests from other views ("Show in graph", "Impact", …)
  useEffect(() => {
    if (!request || request.nonce === lastRequestNonce) return;
    if (request.mode === 'changes') setSettings({ showChanges: true });
    lastRequestNonce = request.nonce;
    const kind: GraphMode = request.mode;
    if (kind === 'focus' && request.files[0]) setMode({ type: 'focus', id: request.files[0], depth: 1, direction: 'both' });
    else if (kind === 'impact' && request.files[0]) setMode({ type: 'impact', id: request.files[0] });
    else if (kind === 'cycle') setMode({ type: 'subset', files: request.files, label: `Circular dependency · ${plural(request.files.length, 'file')}`, cycle: true });
    else if (kind === 'changes') {
      const changed = request.files.length ? request.files : [...model.changed.values()].filter((f) => f.analyzed).map((f) => f.id);
      const affected = [...model.impacted].slice(0, Math.max(0, 300 - changed.length));
      setMode({ type: 'subset', files: [...changed, ...affected], label: `Blast radius · ${plural(changed.length, 'changed file')} → ${plural(model.impacted.size, 'affected file')}` });
    }
    else if (request.files.length) setMode({ type: 'subset', files: request.files, label: plural(request.files.length, 'selected file') });
  }, [request, setMode]);

  const structureKey = JSON.stringify([settings.expanded, settings.compound, settings.showTests, settings.showConfig, settings.showTypeOnly, settings.showPackages, settings.hiddenKinds, mode]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildGraph(model, settings, mode), [model, structureKey]);
  const visuals = useMemo(() => decorate(built, settings, model), [built, settings.colorBy, settings.sizeBy, model]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const els: ElementDefinition[] = [];
    for (const g of built.groups) els.push({ group: 'nodes', data: { id: g.id, label: g.label, parent: g.parent, type: 'group' } });
    for (const n of built.nodes) {
      const v = visuals.get(n.id)!;
      els.push({
        group: 'nodes',
        data: { id: n.id, label: n.label, type: n.type, parent: n.parent, color: v.color, size: v.size, w: v.w, shape: v.shape, importance: n.importance, fanIn: n.fanIn, inCycle: n.inCycle },
        classes: n.scope === 'context' ? 'context' : undefined,
      });
    }
    for (const e of built.edges) {
      els.push({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, width: Math.min(6, 1 + Math.log2(e.weight) * 1.1), dashed: e.typeOnly, cycle: e.inCycle && settings.cycles, weight: e.weight } });
    }
    return els;
    // visuals are applied separately to avoid re-layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built]);

  const runLayout = useCallback(
    (reason: 'structure' | 'layout') => {
      const cy = cyRef.current;
      if (!cy) return;
      const count = cy.nodes().length;
      const layoutName = mode.type === 'impact' && settings.layout === 'fcose' ? 'dagre' : settings.layout;
      const compound = settings.compound && (layoutName === 'fcose' || layoutName.startsWith('dagre'));
      const container = containerRef.current;
      setLaying(true);
      layingRef.current = true;
      // New elements: compute the layout invisibly and fade in (no pile-up in a corner).
      // Layout switch: animate nodes to their new positions.
      const options = { ...layoutOptions(layoutName, count, compound), animate: reason === 'layout' && count < 300 } as LayoutOptions;
      if (reason === 'structure' && container) container.style.opacity = '0';
      const layout = cy.layout(options);
      layout.one('layoutstop', () => {
        setLaying(false);
        layingRef.current = false;
        fitTo(cy);
        if (container) container.style.opacity = '1';
        const pending = pendingCenter.current;
        pendingCenter.current = null;
        if (pending) {
          const node = cy.getElementById(pending);
          if (node.nonempty()) cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: 350 });
        }
      });
      // Let the "Laying out…" indicator paint before heavy layouts.
      setTimeout(() => layout.run(), 20);
    },
    [settings.layout, settings.compound, mode.type],
  );

  // Create cytoscape once
  useEffect(() => {
    const cytoscape = ensureCytoscape();
    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: baseStyle(themeColors()),
      minZoom: 0.05,
      maxZoom: 4,
      wheelSensitivity: 0.25,
      boxSelectionEnabled: false,
      textureOnViewport: false,
      pixelRatio: 'auto',
    });
    // Cytoscape only listens to window resizes; the detail panel changes the container size too.
    const ro = new ResizeObserver(() => cy.resize());
    if (containerRef.current) ro.observe(containerRef.current);
    cyRef.current = cy;
    // Handy for power users: inspect or script the graph from the browser console.
    (window as unknown as { __CODE_VISUALIZER__?: unknown }).__CODE_VISUALIZER__ = { cy, model };
    return () => {
      ro.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const curve = cy.edges().length > 1500 ? 'straight' : 'bezier';
    cy.style(baseStyle(themeColors(), { labels: settings.labels, curve }));
  }, [theme, settings.labels, elements]);

  // Structure changes → replace elements and lay out
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    runLayout('structure');
  }, [elements]); // eslint-disable-line react-hooks/exhaustive-deps

  // Layout changes only
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    runLayout('layout');
  }, [settings.layout]); // eslint-disable-line react-hooks/exhaustive-deps

  // Visual changes → update data in place
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      for (const [id, v] of visuals) cy.getElementById(id).data({ color: v.color, size: v.size, w: v.w, shape: v.shape });
      cy.edges().forEach((e) => {
        const edge = built.edges.find((x) => x.id === e.id());
        if (edge) e.data('cycle', edge.inCycle && settings.cycles);
      });
    });
  }, [visuals, settings.cycles, built.edges]);

  // Events
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const onTap = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      const id = node.id();
      if (node.data('type') === 'group') return;
      if (pathFrom && pathFrom !== id && !id.startsWith('dir:') && !id.startsWith('pkg:')) {
        const path = shortestPath(model, pathFrom, id);
        setPathFrom(null);
        if (path) setMode({ type: 'subset', files: path, label: `Import path · ${path.length} files`, path });
        else window.alert('No import path connects these two files.');
        return;
      }
      tapRef.current = true;
      setActive(id);
      if (id.startsWith('dir:')) select({ type: 'folder', id: id.slice(4) });
      else if (id.startsWith('pkg:')) select({ type: 'package', id: id.slice(4) });
      else selectFile(id);
    };
    const onDblTap = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      const id = node.id();
      if (id.startsWith('dir:')) {
        const folder = id.slice(4);
        setSettings({ expanded: [...new Set([...settings.expanded, folder])] });
      } else if (id.startsWith('grp:')) {
        const folder = id.slice(4);
        setSettings({ expanded: settings.expanded.filter((p) => p !== folder && !p.startsWith(`${folder}/`)) });
      } else if (!id.startsWith('pkg:')) {
        setMode({ type: 'focus', id, depth: 1, direction: 'both' });
      }
    };
    const onBg = (evt: EventObject): void => {
      if (evt.target === cy) {
        setActive(null);
        setPathFrom(null);
      }
    };
    const onOver = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      if (node.data('type') === 'group') return;
      const pos = node.renderedPosition();
      setHover({ x: pos.x, y: pos.y, id: node.id() });
    };
    const onOut = (): void => setHover(null);
    cy.on('tap', 'node', onTap);
    cy.on('dbltap', 'node', onDblTap);
    cy.on('tap', onBg);
    cy.on('mouseover', 'node', onOver);
    cy.on('mouseout', 'node', onOut);
    cy.on('viewport', onOut);
    return () => {
      cy.off('tap', 'node', onTap);
      cy.off('dbltap', 'node', onDblTap);
      cy.off('tap', onBg);
      cy.off('mouseover', 'node', onOver);
      cy.off('mouseout', 'node', onOut);
      cy.off('viewport', onOut);
    };
  }, [model, settings.expanded, pathFrom, setMode, setSettings]);

  // External selection (palette, panels) → highlight the node that contains it
  useEffect(() => {
    if (tapRef.current) {
      tapRef.current = false;
      return;
    }
    const cy = cyRef.current;
    if (!cy || selection?.type !== 'file') return;
    const rep = built.repOfFile.get(selection.id);
    if (!rep) return;
    setActive(rep);
    if (layingRef.current) {
      pendingCenter.current = rep;
      return;
    }
    const node = cy.getElementById(rep);
    if (node.nonempty()) cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: 350 });
  }, [selection, built]);

  // Highlight active node neighbourhood / search matches / modes
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('faded focus match out in path dep dependent cycle dim changed affected');
      if (settings.showChanges && model.changed.size) {
        const changedReps = new Set<string>();
        const affectedReps = new Set<string>();
        for (const [fileId, rep] of built.repOfFile) {
          if (model.changed.has(fileId)) changedReps.add(rep);
          else if (model.impacted.has(fileId)) affectedReps.add(rep);
        }
        for (const id of changedReps) cy.getElementById(id).addClass('changed');
        for (const id of affectedReps) if (!changedReps.has(id)) cy.getElementById(id).addClass('affected');
      }
      const q = search.trim().toLowerCase();
      if (q) {
        const matches = cy.nodes().filter((n) => n.data('type') !== 'group' && (n.id().toLowerCase().includes(q) || String(n.data('label')).toLowerCase().includes(q)));
        cy.elements().addClass('faded');
        matches.removeClass('faded').addClass('match');
        matches.ancestors().removeClass('faded');
      }
      if (mode.type === 'impact') {
        const focus = cy.getElementById(mode.id);
        focus.addClass('focus');
        cy.nodes().not(focus).filter((n) => n.data('type') !== 'group').addClass('dependent');
      }
      if (mode.type === 'focus') cy.getElementById(mode.id).addClass('focus');
      if (mode.type === 'subset' && mode.path) {
        for (let i = 0; i < mode.path.length - 1; i++) {
          cy.getElementById(`${mode.path[i]}->${mode.path[i + 1]}`).addClass('path');
          cy.getElementById(`${mode.path[i + 1]}->${mode.path[i]}`).addClass('path');
        }
      }
      if (mode.type === 'subset' && mode.cycle) cy.nodes().filter((n) => n.data('type') !== 'group').addClass('cycle');
      if (active) {
        const node = cy.getElementById(active);
        if (node.nonempty()) {
          const hood = node.closedNeighborhood();
          cy.elements().not(hood).not(hood.ancestors()).addClass('faded');
          node.addClass('focus');
          node.outgoers('edge').addClass('out');
          node.incomers('edge').addClass('in');
        }
      }
    });
  }, [active, search, mode, elements, settings.showChanges, model, built]);

  const fit = (): void => {
    const cy = cyRef.current;
    if (cy) cy.animate({ fit: { eles: cy.elements(), padding: 40 } }, { duration: 300 });
  };
  const zoom = (factor: number): void => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ zoom: { level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 200 });
  };

  const exportGraph = (): ExportGraph => ({
    nodes: built.nodes.map((n) => ({ id: n.id, label: n.type === 'folder' ? `${n.title}/` : n.title })),
    edges: built.edges.map((e) => ({ source: e.source, target: e.target, dashed: e.typeOnly, label: e.weight > 1 ? String(e.weight) : undefined })),
  });
  const doExport = async (kind: 'png' | 'mermaid' | 'dot' | 'json'): Promise<void> => {
    setExportOpen(false);
    const cy = cyRef.current;
    const name = model.data.project.name.replace(/[^\w.-]+/g, '-');
    if (kind === 'png' && cy) {
      const url = cy.png({ full: true, scale: 2, bg: themeColors().bg, maxWidth: 8000, maxHeight: 8000 });
      downloadUrl(`${name}-dependencies.png`, url);
    } else if (kind === 'mermaid') {
      const text = toMermaid(exportGraph());
      await copyText(text);
      downloadBlob(`${name}-dependencies.mmd`, text);
    } else if (kind === 'dot') downloadBlob(`${name}-dependencies.dot`, toDot(exportGraph(), name));
    else downloadBlob(`${name}-dependencies.json`, JSON.stringify(exportGraph(), null, 2), 'application/json');
  };

  const filesForLevel = filterFiles(model, settings);
  const setLevel = (level: number): void => setSettings({ level, expanded: computeExpanded(model, level, filesForLevel) });
  const maxLevel = model.maxDepth + 1;
  const activeNode = active ? built.nodes.find((n) => n.id === active) : undefined;
  const activeFile = activeNode?.type === 'file' ? model.fileById.get(activeNode.id) : undefined;
  const hoverNode = hover ? built.nodes.find((n) => n.id === hover.id) : undefined;
  const kindsPresent = [...new Set(built.nodes.map((n) => n.kind).filter(Boolean))] as FileKind[];
  const exploring = mode.type === 'explore';

  return (
    <>
      <div className="toolbar">
        {exploring ? (
          <div className="row nowrap" style={{ gap: 10, minWidth: 220 }} title="Zoom level: from top-level folders to individual files">
            <span className="small muted nowrap">Folders</span>
            <input type="range" min={1} max={maxLevel} value={Math.min(settings.level, maxLevel)} onChange={(e) => setLevel(Number(e.target.value))} style={{ width: 120 }} aria-label="Granularity" />
            <span className="small muted nowrap">Files</span>
          </div>
        ) : (
          <div className="row nowrap" style={{ gap: 8 }}>
            <span className="badge accent">
              {mode.type === 'focus' && <Crosshair size={12} />}
              {mode.type === 'impact' && <Radar size={12} />}
              {mode.type === 'focus'
                ? `Focus: ${basename(mode.id)}`
                : mode.type === 'impact'
                  ? `Impact of changing ${basename(mode.id)}`
                  : mode.label}
            </span>
            {mode.type === 'focus' && (
              <>
                <Select
                  value={String(mode.depth) as '1' | '2' | '3'}
                  options={[
                    { value: '1', label: 'Depth 1' },
                    { value: '2', label: 'Depth 2' },
                    { value: '3', label: 'Depth 3' },
                  ]}
                  onChange={(v) => setMode({ ...mode, depth: Number(v) })}
                />
                <Select
                  value={mode.direction}
                  options={[
                    { value: 'both', label: 'Imports & importers' },
                    { value: 'deps', label: 'Only what it imports' },
                    { value: 'dependents', label: 'Only who imports it' },
                  ]}
                  onChange={(v) => setMode({ ...mode, direction: v })}
                />
              </>
            )}
            <button className="btn sm" onClick={() => setMode({ type: 'explore' })}>
              <X size={13} /> Exit
            </button>
          </div>
        )}
        <div className="sep desktop-only" />
        <SearchInput value={search} onChange={setSearch} placeholder="Highlight files…" style={{ width: 200 }} />
        <span className="spacer" />
        {[...model.changed.values()].some((f) => f.analyzed) && (
          <button
            className={`btn sm${settings.showChanges ? ' active' : ''}`}
            onClick={() => setSettings({ showChanges: !settings.showChanges })}
            title="Outline the files you changed (solid) and the files they affect (dashed)"
          >
            <GitPullRequestArrow size={13} /> My changes
          </button>
        )}
        {model.data.insights.cycles.length > 0 && (
          <button className={`btn sm${settings.cycles ? ' active' : ''}`} onClick={() => setSettings({ cycles: !settings.cycles })} title="Highlight circular dependencies in red">
            <Recycle size={13} /> Cycles
          </button>
        )}
        <Select
          value={settings.layout}
          onChange={(layout) => setSettings({ layout })}
          title="Layout"
          options={[
            { value: 'fcose', label: 'Organic' },
            { value: 'dagre', label: 'Hierarchy →' },
            { value: 'dagre-tb', label: 'Hierarchy ↓' },
            { value: 'concentric', label: 'Concentric' },
            { value: 'circle', label: 'Circle' },
            { value: 'grid', label: 'Grid' },
          ]}
        />
        <Select
          value={settings.colorBy}
          onChange={(colorBy) => setSettings({ colorBy })}
          title="Color nodes by"
          options={[
            { value: 'kind', label: 'Color: type' },
            { value: 'folder', label: 'Color: folder' },
            { value: 'complexity', label: 'Color: complexity' },
            { value: 'importance', label: 'Color: importance' },
            ...(model.data.git ? [{ value: 'owner' as const, label: 'Color: owner' }] : []),
            ...(model.data.git
              ? [
                  { value: 'churn' as const, label: 'Color: churn' },
                  { value: 'age' as const, label: 'Color: last change' },
                ]
              : []),
          ]}
        />
        <button className={`btn sm icon${showSettings ? ' active' : ''}`} onClick={() => setShowSettings((v) => !v)} title="Graph settings">
          <SlidersHorizontal size={14} />
        </button>
        <div style={{ position: 'relative' }}>
          <button className="btn sm" onClick={() => setExportOpen((v) => !v)} title="Export">
            <Download size={13} /> Export
          </button>
          {exportOpen && (
            <div className="floating" style={{ right: 0, top: 34, padding: 6, minWidth: 210, zIndex: 40 }}>
              <button className="list-item" onClick={() => doExport('png')}>
                PNG image
              </button>
              <button className="list-item" onClick={() => doExport('mermaid')}>
                Mermaid diagram (copied)
              </button>
              <button className="list-item" onClick={() => doExport('dot')}>
                Graphviz DOT
              </button>
              <button className="list-item" onClick={() => doExport('json')}>
                JSON (nodes & edges)
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="canvas-wrap">
        <div ref={containerRef} className="canvas" style={{ transition: 'opacity .25s ease' }} />
        {showSettings && (
          <div className="floating settings-panel">
            <div className="row nowrap">
              <strong className="small">Graph settings</strong>
              <span className="spacer" />
              <button className="btn ghost icon sm" onClick={() => setShowSettings(false)} aria-label="Close settings">
                <X size={14} />
              </button>
            </div>
            <div className="field">
              <label>Node size</label>
              <Select
                value={settings.sizeBy}
                onChange={(sizeBy) => setSettings({ sizeBy })}
                options={[
                  { value: 'loc', label: 'Lines of code' },
                  { value: 'fanIn', label: 'Number of importers' },
                  { value: 'importance', label: 'Importance' },
                  { value: 'uniform', label: 'Uniform' },
                ]}
              />
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <Toggle checked={settings.compound} onChange={(compound) => setSettings({ compound })} label="Group into folder boxes" />
              <Toggle checked={settings.labels} onChange={(labels) => setSettings({ labels })} label="Show labels" />
              <Toggle checked={settings.showTypeOnly} onChange={(showTypeOnly) => setSettings({ showTypeOnly })} label="Include type-only imports" />
              <Toggle checked={settings.showTests} onChange={(showTests) => setSettings({ showTests })} label="Tests & stories" />
              <Toggle checked={settings.showConfig} onChange={(showConfig) => setSettings({ showConfig })} label="Config files & scripts" />
              <Toggle checked={settings.showPackages} onChange={(showPackages) => setSettings({ showPackages })} label="External packages" />
            </div>
            <div className="tiny faint">
              Double-click a folder to open it, double-click a box to close it, double-click a file to focus on its neighbourhood.
            </div>
            <button className="btn sm" onClick={() => setSettings({ ...initialSettings(model) })}>
              Reset to defaults
            </button>
          </div>
        )}
        {!showSettings && activeNode && (
          <div className="floating node-card">
            <div className="row nowrap" style={{ gap: 8 }}>
              {activeNode.kind && <KindDot kind={activeNode.kind} size={10} />}
              <strong className="truncate" style={{ flex: 1 }} title={activeNode.title}>
                {activeNode.type === 'folder' ? `${activeNode.title}/` : activeNode.label}
              </strong>
              <button className="btn ghost icon sm" onClick={() => setActive(null)} aria-label="Clear selection">
                <X size={13} />
              </button>
            </div>
            <div className="tiny muted">
              {activeNode.type === 'folder'
                ? `${plural(activeNode.files, 'file')} · ${fmtNum(activeNode.loc)} lines`
                : activeNode.type === 'package'
                  ? `External package · imported by ${plural(activeNode.files, 'file')}`
                  : `${KIND_META[activeNode.kind ?? 'module'].label} · ${fmtNum(activeNode.loc)} lines · imports ${activeFile?.metrics.fanOut ?? 0} · used by ${activeFile?.metrics.fanIn ?? 0}`}
            </div>
            <div className="row" style={{ gap: 6 }}>
              {activeNode.type === 'folder' && (
                <button className="btn sm" onClick={() => setSettings({ expanded: [...new Set([...settings.expanded, activeNode.id.slice(4)])] })}>
                  <FolderOpen size={13} /> Open folder
                </button>
              )}
              {activeNode.type === 'file' && (
                <>
                  <button className="btn sm" onClick={() => setMode({ type: 'focus', id: activeNode.id, depth: 1, direction: 'both' })}>
                    <Crosshair size={13} /> Focus
                  </button>
                  <button className="btn sm" onClick={() => setMode({ type: 'impact', id: activeNode.id })}>
                    <Radar size={13} /> Impact
                  </button>
                  <button className={`btn sm${pathFrom ? ' active' : ''}`} onClick={() => setPathFrom(pathFrom ? null : activeNode.id)} title="Then click another file">
                    <PathIcon size={13} /> {pathFrom ? 'Click a target…' : 'Path to…'}
                  </button>
                </>
              )}
              {activeNode.parent && exploring && (
                <button
                  className="btn sm"
                  title="Collapse the folder that contains this node"
                  onClick={() => {
                    const folder = activeNode.parent!.slice(4);
                    setSettings({ expanded: settings.expanded.filter((p) => p !== folder && !p.startsWith(`${folder}/`)) });
                  }}
                >
                  <FolderMinus size={13} /> Collapse parent
                </button>
              )}
            </div>
          </div>
        )}
        {!activeNode && !showSettings && built.nodes.length > 0 && (
          <div className="floating graph-hint desktop-only">
            <Info size={14} className="muted" />
            <span>
              {exploring ? 'Scroll to zoom · drag to pan · click a node for details · double-click a folder to open it' : 'Double-click any file to re-center the focus'}
            </span>
          </div>
        )}
        <div className="floating graph-stats">
          {laying ? 'Laying out…' : `${plural(built.nodes.length, 'node')} · ${plural(built.edges.length, 'edge')}`}
        </div>
        {!built.nodes.length && (
          <div className="empty" style={{ position: 'absolute', inset: 0 }}>
            <h3>Nothing to show</h3>
            <p>All files are filtered out. Adjust the graph settings.</p>
          </div>
        )}
        <div className="floating zoom-controls">
          <button className="btn ghost icon sm" onClick={() => zoom(1.3)} aria-label="Zoom in">
            <ZoomIn size={15} />
          </button>
          <button className="btn ghost icon sm" onClick={() => zoom(1 / 1.3)} aria-label="Zoom out">
            <ZoomOut size={15} />
          </button>
          <button className="btn ghost icon sm" onClick={fit} aria-label="Fit to screen">
            <Maximize2 size={15} />
          </button>
          {exploring && (
            <button className="btn ghost icon sm" onClick={() => setLevel(maxLevel)} title="Expand everything to files" aria-label="Expand all">
              <Expand size={15} />
            </button>
          )}
        </div>
        {settings.colorBy === 'owner' ? (
          <div className="floating legend">
            {(model.data.git?.contributors ?? []).slice(0, 8).map((c) => (
              <span key={c.name} className="legend-item" style={{ cursor: 'default' }}>
                <span className="dot" style={{ ['--c' as string]: personColor(c.name) }} />
                {c.name}
              </span>
            ))}
            <span className="legend-item faint" style={{ cursor: 'default' }}>
              colored by who changed the file most
            </span>
          </div>
        ) : settings.colorBy === 'kind' ? (
          <div className="floating legend">
            {kindsPresent.map((k) => (
              <span key={k} className="legend-item" onClick={() => setSettings({ hiddenKinds: [...settings.hiddenKinds, k] })} title="Click to hide">
                <KindDot kind={k} />
                {KIND_META[k].label}
              </span>
            ))}
            {settings.hiddenKinds.map((k) => (
              <span key={k} className="legend-item off" onClick={() => setSettings({ hiddenKinds: settings.hiddenKinds.filter((x) => x !== k) })} title="Click to show">
                <KindDot kind={k} />
                {KIND_META[k].label}
              </span>
            ))}
            {built.nodes.some((n) => n.type === 'folder') && (
              <span className="legend-item faint" style={{ cursor: 'default' }}>
                ▢ folder (double-click to open)
              </span>
            )}
            <span className="legend-item faint" style={{ cursor: 'default' }}>
              <span style={{ color: '#60a5fa' }}>→</span> imports <span style={{ color: '#fb923c' }}>→</span> imported by
            </span>
            {settings.showChanges && model.changed.size > 0 && (
              <span className="legend-item faint" style={{ cursor: 'default' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2.5px solid #fbbf24' }} /> changed
                <span style={{ width: 10, height: 10, borderRadius: '50%', border: '2px dashed #fb923c', marginLeft: 6 }} /> affected
              </span>
            )}
          </div>
        ) : (
          <div className="floating legend" style={{ alignItems: 'center' }}>
            <span className="tiny muted">{settings.colorBy === 'age' ? 'recently changed' : 'low'}</span>
            <span style={{ width: 140, height: 8, borderRadius: 8, background: settings.colorBy === 'age' ? 'linear-gradient(90deg,#34d399,#64748b)' : 'linear-gradient(90deg,#22d3ee,#8b6dff,#f43f5e)' }} />
            <span className="tiny muted">{settings.colorBy === 'age' ? 'untouched for a year+' : 'high'}</span>
          </div>
        )}
        {hover && hoverNode && (
          <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <div className="tt-title">{hoverNode.type === 'folder' ? `${hoverNode.title}/` : hoverNode.title}</div>
            <div className="muted">
              {hoverNode.type === 'folder'
                ? `${plural(hoverNode.files, 'file')} · ${fmtNum(hoverNode.loc)} lines`
                : hoverNode.type === 'package'
                  ? `package · ${plural(hoverNode.files, 'importer')}`
                  : `${KIND_META[hoverNode.kind ?? 'module'].label} · ${fmtNum(hoverNode.loc)} lines · complexity ${Math.round(hoverNode.complexity)}`}
            </div>
            {hoverNode.inCycle && <div style={{ color: 'var(--danger)' }}>Part of a circular dependency</div>}
          </div>
        )}
      </div>
    </>
  );
}
