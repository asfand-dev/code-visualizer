import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  arc as d3arc,
  hierarchy,
  linkHorizontal,
  partition,
  select as d3select,
  tree as d3tree,
  treemap,
  treemapSquarify,
  zoom as d3zoom,
  zoomIdentity,
  type HierarchyNode,
  type HierarchyPointNode,
  type HierarchyRectangularNode,
  type ZoomBehavior,
} from 'd3';
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderTree, LayoutGrid, Network, Sun as SunIcon } from 'lucide-react';
import { useModel } from '../data/context';
import type { FolderNode, Model } from '../data/model';
import { categorical, freshness, heat, KIND_META, mix, SYMBOL_META } from '../lib/colors';
import { fmtNum, plural } from '../lib/format';
import { select, selectFile, selectSymbol, useStore } from '../state/store';
import type { FileInfo, SymbolInfo } from '../types';
import { KindDot, SearchInput, Segmented, Select } from '../components/ui';

type Tab = 'treemap' | 'sunburst' | 'mindmap' | 'explorer';
type ColorBy = 'kind' | 'folder' | 'complexity' | 'churn' | 'age' | 'importance';

interface TNode {
  name: string;
  path: string;
  type: 'folder' | 'file' | 'symbol';
  file?: FileInfo;
  symbol?: SymbolInfo;
  folder?: FolderNode;
  children?: TNode[];
  value?: number;
}

function toTree(folder: FolderNode, hideTests: boolean): TNode {
  const files = folder.files.filter((f) => !hideTests || (f.kind !== 'test' && f.kind !== 'story'));
  const children: TNode[] = [
    ...folder.folders.map((f) => toTree(f, hideTests)).filter((c) => (c.children?.length ?? 0) > 0),
    ...files.map((f) => ({ name: f.name, path: f.id, type: 'file' as const, file: f, value: Math.max(1, f.loc) })),
  ];
  return { name: folder.name || '/', path: folder.path, type: 'folder', folder, children };
}

function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.max(200, Math.floor(width)), height: Math.max(200, Math.floor(height)) });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function colorFor(file: FileInfo | undefined, colorBy: ColorBy, ctx: { topIndex: (path: string) => number; maxCommits: number; p95: number }): string {
  if (!file) return '#7c8aa5';
  switch (colorBy) {
    case 'folder':
      return categorical(ctx.topIndex(file.id));
    case 'complexity':
      return heat(file.complexity / ctx.p95);
    case 'churn':
      return heat((file.git?.commits ?? 0) / ctx.maxCommits);
    case 'age':
      return file.git ? freshness((Date.now() - file.git.lastModified) / (365 * 86_400_000)) : '#64748b';
    case 'importance':
      return heat(Math.sqrt(file.metrics.importance));
    default:
      return KIND_META[file.kind].color;
  }
}

function useColorContext(model: Model) {
  return useMemo(() => {
    const tops = [...new Set(model.files.map((f) => f.id.split('/')[0]))].sort();
    const maxCommits = Math.max(1, ...model.files.map((f) => f.git?.commits ?? 0));
    const cx = model.files.map((f) => f.complexity).sort((a, b) => a - b);
    const p95 = Math.max(1, cx[Math.floor(cx.length * 0.95)] ?? 1);
    return { topIndex: (path: string) => tops.indexOf(path.split('/')[0]), maxCommits, p95 };
  }, [model]);
}

export function StructureView() {
  const model = useModel();
  const [tab, setTab] = useState<Tab>('treemap');
  const [colorBy, setColorBy] = useState<ColorBy>('kind');
  const [rootPath, setRootPath] = useState('');
  const [hideTests, setHideTests] = useState(true);
  const rootFolder = model.folderByPath.get(rootPath) ?? model.root;
  const data = useMemo(() => toTree(rootFolder, hideTests), [rootFolder, hideTests]);
  const crumbs = rootPath ? rootPath.split('/') : [];

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'treemap', label: 'Treemap', icon: LayoutGrid },
            { value: 'sunburst', label: 'Sunburst', icon: SunIcon },
            { value: 'mindmap', label: 'Mind map', icon: Network },
            { value: 'explorer', label: 'Explorer', icon: FolderTree },
          ]}
        />
        {tab !== 'explorer' && tab !== 'mindmap' && (
          <Select
            value={colorBy}
            onChange={setColorBy}
            options={[
              { value: 'kind', label: 'Color: file type' },
              { value: 'folder', label: 'Color: top folder' },
              { value: 'complexity', label: 'Color: complexity' },
              { value: 'importance', label: 'Color: importance' },
              ...(model.data.git
                ? [
                    { value: 'churn' as const, label: 'Color: churn' },
                    { value: 'age' as const, label: 'Color: last change' },
                  ]
                : []),
            ]}
          />
        )}
        <label className="toggle">
          <input type="checkbox" checked={hideTests} onChange={(e) => setHideTests(e.target.checked)} />
          <span className="track" />
          <span>Hide tests</span>
        </label>
        <span className="spacer" />
        <div className="row nowrap small" style={{ gap: 4, minWidth: 0, overflow: 'hidden' }}>
          <button className="btn ghost sm" onClick={() => setRootPath('')}>
            <FolderOpen size={13} /> {model.data.project.rootName}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="row nowrap" style={{ gap: 4 }}>
              <ChevronRight size={12} className="faint" />
              <button className="btn ghost sm mono" onClick={() => setRootPath(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            </span>
          ))}
        </div>
      </div>
      {tab === 'treemap' && <Treemap data={data} colorBy={colorBy} onZoom={setRootPath} />}
      {tab === 'sunburst' && <Sunburst data={data} colorBy={colorBy} onZoom={setRootPath} rootPath={rootPath} />}
      {tab === 'mindmap' && <MindMap key={rootPath} data={data} />}
      {tab === 'explorer' && <Explorer root={rootFolder} hideTests={hideTests} />}
    </>
  );
}

/* --------------------------------- Treemap -------------------------------- */

function Treemap({ data, colorBy, onZoom }: { data: TNode; colorBy: ColorBy; onZoom: (path: string) => void }) {
  const model = useModel();
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(ref);
  const ctx = useColorContext(model);
  const [hover, setHover] = useState<{ x: number; y: number; node: HierarchyRectangularNode<TNode> } | null>(null);
  const root = useMemo(() => {
    const h = hierarchy(data)
      .sum((d) => (d.type === 'file' ? (d.value ?? 1) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<TNode>()
      .tile(treemapSquarify.ratio(1.3))
      .size([width, height])
      .paddingOuter((d) => (d.depth <= 3 ? 3 : 1))
      .paddingTop((d) => (d.depth === 0 ? 3 : d.depth <= 3 && d.x1 - d.x0 > 60 && d.y1 - d.y0 > 50 ? 20 : 2))
      .paddingInner(d3PaddingInner)
      .round(true)(h);
  }, [data, width, height]);
  // Draw everything that is big enough to see (deep folders included), capped for DOM size.
  const nodes = root
    .descendants()
    .filter((d) => d.depth > 0 && d.x1 - d.x0 >= 2 && d.y1 - d.y0 >= 2)
    .slice(0, 6000);
  return (
    <div className="canvas-wrap" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        {nodes.map((d) => {
          const w = d.x1 - d.x0;
          const h = d.y1 - d.y0;
          if (w < 1 || h < 1) return null;
          const isFolder = d.data.type === 'folder';
          const color = isFolder ? 'transparent' : colorFor(d.data.file, colorBy, ctx);
          return (
            <g
              key={d.data.path}
              transform={`translate(${d.x0},${d.y0})`}
              onMouseMove={(e) => {
                const rect = ref.current!.getBoundingClientRect();
                setHover({ x: e.clientX - rect.left, y: e.clientY - rect.top, node: d });
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (isFolder) onZoom(d.data.path);
                else if (d.data.file) selectFile(d.data.file.id);
              }}
              style={{ cursor: 'pointer' }}
            >
              {isFolder ? (
                <>
                  <rect width={w} height={h} rx={d.depth <= 3 ? 6 : 2} fill="var(--surface)" fillOpacity={0.35} stroke="var(--border-strong)" strokeWidth={d.depth <= 3 ? 1 : 0.5} />
                  {w > 60 && h > 50 && d.depth <= 3 && (
                    <text x={6} y={14} fontSize={11} fontWeight={650} fill="var(--text-2)" style={{ fontFamily: 'var(--mono)', pointerEvents: 'none' }}>
                      {truncate(`${d.data.name}/`, w / 7)}
                    </text>
                  )}
                </>
              ) : (
                <>
                  <rect width={w} height={h} rx={3} fill={color} fillOpacity={hover?.node === d ? 1 : 0.78} />
                  {w > 46 && h > 18 && (
                    <text x={5} y={13} fontSize={10.5} fontWeight={600} fill="#fff" style={{ pointerEvents: 'none', textShadow: '0 1px 2px rgba(0,0,0,.5)' }}>
                      {truncate(d.data.name, w / 6.3)}
                    </text>
                  )}
                  {w > 46 && h > 32 && (
                    <text x={5} y={26} fontSize={9.5} fill="rgba(255,255,255,.8)" style={{ pointerEvents: 'none' }}>
                      {fmtNum(d.data.file?.loc)} loc
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
      {hover && <TreeTooltip x={hover.x} y={hover.y} node={hover.node.data} value={hover.node.value ?? 0} />}
      <div className="floating legend">
        <span className="tiny muted">Area = lines of code. Click a folder to zoom in, a file to inspect it.</span>
      </div>
    </div>
  );
}

function d3PaddingInner(d: HierarchyRectangularNode<TNode>): number {
  return d.depth <= 2 ? 2 : 1;
}

function truncate(text: string, max: number): string {
  const m = Math.floor(max);
  if (text.length <= m) return text;
  return m <= 2 ? '' : `${text.slice(0, m - 1)}…`;
}

function TreeTooltip({ x, y, node, value }: { x: number; y: number; node: TNode; value: number }) {
  return (
    <div className="tooltip" style={{ left: x + 14, top: y + 14 }}>
      <div className="tt-title mono">{node.type === 'folder' ? `${node.path || '/'}/` : node.path}</div>
      {node.file ? (
        <div className="muted">
          {KIND_META[node.file.kind].label} · {fmtNum(node.file.loc)} lines · complexity {node.file.complexity}
          {node.file.git ? ` · ${node.file.git.commits} commits` : ''}
        </div>
      ) : (
        <div className="muted">
          {plural(node.folder?.fileCount ?? 0, 'file')} · {fmtNum(value)} lines
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Sunburst -------------------------------- */

function Sunburst({ data, colorBy, onZoom, rootPath }: { data: TNode; colorBy: ColorBy; onZoom: (path: string) => void; rootPath: string }) {
  const model = useModel();
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(ref);
  const ctx = useColorContext(model);
  const [hover, setHover] = useState<HierarchyRectangularNode<TNode> | null>(null);
  const radius = Math.max(120, Math.min(width, height) / 2 - 20);
  const root = useMemo(() => {
    const h = hierarchy(data)
      .sum((d) => (d.type === 'file' ? (d.value ?? 1) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return partition<TNode>().size([2 * Math.PI, radius])(h);
  }, [data, radius]);
  const maxDepth = 5;
  const ringWidth = radius / Math.min(maxDepth + 1, (root.height || 1) + 1);
  const arcGen = d3arc<HierarchyRectangularNode<TNode>>()
    .startAngle((d) => d.x0)
    .endAngle((d) => d.x1)
    .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.004))
    .padRadius(radius / 2)
    .innerRadius((d) => d.depth * ringWidth)
    .outerRadius((d) => (d.depth + 1) * ringWidth - 1.5)
    .cornerRadius(2);
  const nodes = root.descendants().filter((d) => d.depth > 0 && d.depth <= maxDepth && d.x1 - d.x0 > 0.002);
  const branchColor = (d: HierarchyRectangularNode<TNode>): string => {
    if (d.data.type === 'file' && colorBy !== 'folder') return colorFor(d.data.file, colorBy, ctx);
    let top = d;
    while (top.depth > 1 && top.parent) top = top.parent;
    const base = categorical(root.children?.indexOf(top) ?? 0);
    return mix(base, '#ffffff', Math.min(0.5, (d.depth - 1) * 0.12));
  };
  const parentPath = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/')) : '';
  return (
    <div className="canvas-wrap" ref={ref}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        <g transform={`translate(${width / 2},${height / 2})`}>
          {nodes.map((d) => (
            <path
              key={d.data.path}
              d={arcGen(d) ?? ''}
              fill={branchColor(d)}
              fillOpacity={hover && !isAncestorOrSelf(d, hover) ? 0.35 : 0.88}
              stroke="var(--graph-bg)"
              strokeWidth={0.5}
              style={{ cursor: 'pointer', transition: 'fill-opacity .15s' }}
              onMouseEnter={() => setHover(d)}
              onMouseLeave={() => setHover(null)}
              onClick={() => (d.data.type === 'folder' ? onZoom(d.data.path) : d.data.file && selectFile(d.data.file.id))}
            />
          ))}
          {nodes
            .filter((d) => (d.x1 - d.x0) * (d.depth + 0.5) * ringWidth > 40 && ringWidth > 26)
            .map((d) => {
              const angle = (((d.x0 + d.x1) / 2) * 180) / Math.PI;
              const r = (d.depth + 0.5) * ringWidth;
              const flip = angle > 180;
              return (
                <text
                  key={`t${d.data.path}`}
                  transform={`rotate(${angle - 90}) translate(${r},0) rotate(${flip ? 90 : -90})`}
                  textAnchor="middle"
                  dy="0.35em"
                  fontSize={10}
                  fontWeight={600}
                  fill="#fff"
                  style={{ pointerEvents: 'none', textShadow: '0 1px 2px rgba(0,0,0,.6)' }}
                >
                  {truncate(d.data.name, ((d.x1 - d.x0) * r) / 6.5)}
                </text>
              );
            })}
          <circle r={ringWidth - 4} fill="var(--surface)" stroke="var(--border)" style={{ cursor: rootPath ? 'pointer' : 'default' }} onClick={() => rootPath && onZoom(parentPath)} />
          <text textAnchor="middle" dy="-0.2em" fontSize={13} fontWeight={700} fill="var(--text)" style={{ pointerEvents: 'none' }}>
            {truncate(hover ? hover.data.name : data.name, (ringWidth * 2) / 7.5)}
          </text>
          <text textAnchor="middle" dy="1.3em" fontSize={10.5} fill="var(--text-dim)" style={{ pointerEvents: 'none' }}>
            {fmtNum(hover ? hover.value : root.value)} lines
          </text>
        </g>
      </svg>
      <div className="floating legend">
        <span className="tiny muted">Rings go from folders (inside) to files (outside); angle = lines of code. Click to zoom, click the center to go up.</span>
      </div>
    </div>
  );
}

function isAncestorOrSelf(node: HierarchyNode<TNode>, of: HierarchyNode<TNode>): boolean {
  let cur: HierarchyNode<TNode> | null = of;
  while (cur) {
    if (cur === node) return true;
    cur = cur.parent;
  }
  return of.ancestors().includes(node) || node.ancestors().includes(of);
}

/* -------------------------------- Mind map -------------------------------- */

function MindMap({ data }: { data: TNode }) {
  const theme = useStore((s) => s.theme);
  const ref = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const { width, height } = useSize(ref);
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>([`${data.type}:${data.path}`]);
    for (const c of data.children ?? []) if (c.type === 'folder') s.add(`folder:${c.path}`);
    return s;
  });
  const key = (n: TNode): string => `${n.type}:${n.path}`;
  const visible = useMemo(() => {
    const build = (n: TNode): TNode => {
      if (!open.has(key(n))) return { ...n, children: undefined };
      let children = n.children;
      if (n.type === 'file' && n.file) {
        children = n.file.symbols.slice(0, 40).map((s) => ({ name: s.name, path: s.id, type: 'symbol' as const, symbol: s }));
      }
      return { ...n, children: children?.map(build) };
    };
    return build(data);
  }, [data, open]);
  const root = useMemo(() => d3tree<TNode>().nodeSize([30, 230])(hierarchy(visible)), [visible]);
  const nodes = root.descendants();
  const links = root.links();
  const linkGen = linkHorizontal<{ source: HierarchyPointNode<TNode>; target: HierarchyPointNode<TNode> }, HierarchyPointNode<TNode>>()
    .x((d) => d.y)
    .y((d) => d.x);

  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = d3select(svgRef.current);
    const g = d3select(gRef.current);
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 3])
      .on('zoom', (e) => g.attr('transform', e.transform.toString()));
    zoomRef.current = z;
    svg.call(z).on('dblclick.zoom', null);
    svg.call(z.transform, zoomIdentity.translate(80, height / 2));
    return () => void svg.on('.zoom', null);
  }, [height]);

  const branchIndex = (d: HierarchyPointNode<TNode>): number => {
    let top = d;
    while (top.depth > 1 && top.parent) top = top.parent;
    return root.children?.indexOf(top) ?? 0;
  };
  const hasKids = (n: TNode): boolean => (n.type === 'folder' && !!n.folder && n.folder.fileCount > 0) || (n.type === 'file' && !!n.file?.symbols.length);

  return (
    <div className="canvas-wrap" ref={ref}>
      <svg ref={svgRef} className="svg-canvas" width={width} height={height} data-theme={theme}>
        <g ref={gRef}>
          {links.map((l) => (
            <path key={`${key(l.source.data)}>${key(l.target.data)}`} d={linkGen(l) ?? ''} fill="none" stroke={categorical(branchIndex(l.target))} strokeOpacity={0.45} strokeWidth={l.source.depth === 0 ? 2.5 : 1.6} />
          ))}
          {nodes.map((d) => {
            const n = d.data;
            const color = d.depth === 0 ? 'var(--accent)' : n.type === 'symbol' ? SYMBOL_META[n.symbol!.kind].color : n.type === 'file' ? KIND_META[n.file!.kind].color : categorical(branchIndex(d));
            const label = n.type === 'folder' ? `${n.name}/` : n.name;
            const w = Math.min(200, label.length * 7 + (n.type === 'folder' ? 44 : 28));
            const isOpen = open.has(key(n));
            const toggle = (): void => {
              if (!hasKids(n)) return;
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(key(n))) next.delete(key(n));
                else next.add(key(n));
                return next;
              });
            };
            return (
              <g key={key(n)} transform={`translate(${d.y},${d.x})`} style={{ cursor: 'pointer' }}>
                <rect
                  x={0}
                  y={-11}
                  width={w}
                  height={22}
                  rx={11}
                  fill={d.depth === 0 ? 'var(--accent)' : 'var(--surface)'}
                  stroke={color}
                  strokeWidth={1.5}
                  onClick={() => {
                    if (n.type === 'symbol' && n.symbol) selectSymbol(n.symbol.id);
                    else if (n.type === 'file' && n.file) selectFile(n.file.id);
                    else if (n.type === 'folder') select({ type: 'folder', id: n.path });
                  }}
                  onDoubleClick={toggle}
                />
                <circle cx={11} cy={0} r={4} fill={color} pointerEvents="none" />
                <text x={21} y={4} fontSize={11.5} fontWeight={n.type === 'folder' ? 650 : 500} fill={d.depth === 0 ? '#fff' : 'var(--text)'} style={{ pointerEvents: 'none', fontFamily: n.type === 'symbol' ? 'var(--mono)' : undefined }}>
                  {truncate(label, (w - 30) / 6.6)}
                </text>
                {hasKids(n) && (
                  <g transform={`translate(${w + 10},0)`} onClick={toggle}>
                    <circle r={8} fill="var(--surface-3)" stroke={color} strokeWidth={1} />
                    <text textAnchor="middle" dy="0.35em" fontSize={11} fontWeight={700} fill="var(--text-2)" style={{ pointerEvents: 'none' }}>
                      {isOpen ? '−' : '+'}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="floating legend">
        <span className="tiny muted">Click a node to inspect it, use ⊕ to expand folders → files → symbols. Drag to pan, scroll to zoom.</span>
      </div>
    </div>
  );
}

/* -------------------------------- Explorer -------------------------------- */

function Explorer({ root, hideTests }: { root: FolderNode; hideTests: boolean }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set([root.path, ...root.folders.map((f) => f.path)]));
  const selection = useStore((s) => s.selection);
  const q = filter.trim().toLowerCase();
  const toggle = (p: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const matches = (f: FileInfo): boolean => (!hideTests || (f.kind !== 'test' && f.kind !== 'story')) && (!q || f.id.toLowerCase().includes(q));
  const rows: ReactNode[] = [];
  const walk = (folder: FolderNode, depth: number): void => {
    for (const sub of folder.folders) {
      const files = countMatching(sub, matches);
      if (!files) continue;
      const isOpen = q ? true : open.has(sub.path);
      rows.push(
        <div key={`d:${sub.path}`} className={`tree-row${selection?.type === 'folder' && selection.id === sub.path ? ' active' : ''}`} style={{ paddingLeft: 8 + depth * 16 }} onClick={() => toggle(sub.path)} onDoubleClick={() => select({ type: 'folder', id: sub.path })}>
          <span className="chev">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          {isOpen ? <FolderOpen size={15} style={{ color: 'var(--accent)' }} /> : <Folder size={15} style={{ color: 'var(--accent)' }} />}
          <span className="truncate" style={{ fontWeight: 550 }}>
            {sub.name}
          </span>
          <span className="tiny faint">{files}</span>
          <span className="cols">
            <span>{fmtNum(sub.loc)}</span>
            <span />
            <span />
            <span />
          </span>
        </div>,
      );
      if (isOpen) walk(sub, depth + 1);
    }
    for (const f of folder.files) {
      if (!matches(f)) continue;
      rows.push(
        <div key={f.id} className={`tree-row${selection?.type === 'file' && selection.id === f.id ? ' active' : ''}`} style={{ paddingLeft: 8 + depth * 16 + 16 }} onClick={() => selectFile(f.id)}>
          <KindDot kind={f.kind} />
          <span className="truncate mono small">{f.name}</span>
          {f.inCycle && <span className="badge danger" style={{ height: 17 }}>cycle</span>}
          {f.orphan && <span className="badge warn" style={{ height: 17 }}>orphan</span>}
          <span className="cols">
            <span>{fmtNum(f.loc)}</span>
            <span>{f.symbols.length}</span>
            <span>{f.metrics.fanIn}</span>
            <span style={{ color: f.complexity > 50 ? 'var(--warning)' : undefined }}>{f.complexity}</span>
          </span>
        </div>,
      );
    }
  };
  walk(root, 0);
  return (
    <div className="view" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter files…" style={{ width: 280 }} />
        <span className="spacer" />
        <div className="tree-row" style={{ cursor: 'default', height: 'auto' }}>
          <span className="cols tiny" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>
            <span>Lines</span>
            <span>Symbols</span>
            <span>Used by</span>
            <span>Complexity</span>
          </span>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 8px 40px' }}>{rows.length ? rows : <div className="empty">No files match.</div>}</div>
    </div>
  );
}

function countMatching(folder: FolderNode, matches: (f: FileInfo) => boolean): number {
  let n = folder.files.filter(matches).length;
  for (const sub of folder.folders) n += countMatching(sub, matches);
  return n;
}
