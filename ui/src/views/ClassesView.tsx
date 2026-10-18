import { useEffect, useMemo, useRef, useState } from 'react';
import dagre from '@dagrejs/dagre';
import { curveBasis, line, select as d3select, zoom as d3zoom, zoomIdentity, type ZoomBehavior } from 'd3';
import { Download, Maximize2, Shapes } from 'lucide-react';
import { useModel } from '../data/context';
import { SYMBOL_META } from '../lib/colors';
import { downloadBlob } from '../lib/download';
import { basename, plural } from '../lib/format';
import { selectSymbol, useStore } from '../state/store';
import type { FileInfo, MemberInfo, SymbolEdge, SymbolInfo } from '../types';
import { Empty, SearchInput, Select, Toggle } from '../components/ui';

interface Entity {
  id: string;
  symbol: SymbolInfo;
  file: FileInfo;
  stereotype?: string;
  attrs: string[];
  ops: string[];
  moreAttrs: number;
  moreOps: number;
  width: number;
  height: number;
}

const MAX_ROWS = 10;
const ROW = 16;
const CHAR = 6.7;

function memberLine(m: MemberInfo): string {
  const vis = m.visibility === 'private' ? '−' : m.visibility === 'protected' ? '#' : '+';
  const st = m.static ? 'static ' : '';
  if (m.kind === 'enumMember') return `${m.name}${m.value ? ` = ${m.value}` : ''}`;
  if (m.kind === 'method' || m.kind === 'constructor' || m.kind === 'call') {
    const params = (m.params ?? []).map((p) => `${p.name}${p.type ? `: ${p.type}` : ''}`).join(', ');
    const sig = `${vis} ${st}${m.name}(${params})${m.type ? `: ${m.type}` : ''}`;
    return sig.length > 56 ? `${sig.slice(0, 55)}…` : sig;
  }
  const t = m.type && !m.type.startsWith('= ') ? `: ${m.type}` : '';
  const s = `${vis} ${st}${m.readonly ? 'readonly ' : ''}${m.name}${m.optional ? '?' : ''}${t}`;
  return s.length > 56 ? `${s.slice(0, 55)}…` : s;
}

function makeEntity(symbol: SymbolInfo, file: FileInfo, showMembers: boolean): Entity {
  const members = symbol.members ?? [];
  const attrs = members.filter((m) => m.kind === 'property' || m.kind === 'enumMember' || m.kind === 'index' || m.kind === 'getter' || m.kind === 'setter');
  const ops = members.filter((m) => m.kind === 'method' || m.kind === 'constructor' || m.kind === 'call');
  const stereotype =
    symbol.kind === 'interface'
      ? '«interface»'
      : symbol.kind === 'enum'
        ? '«enum»'
        : symbol.kind === 'type'
          ? '«type»'
          : symbol.abstract
            ? '«abstract»'
            : symbol.decorators?.length
              ? `«${symbol.decorators[0]}»`
              : undefined;
  const attrLines = showMembers ? attrs.slice(0, MAX_ROWS).map(memberLine) : [];
  const opLines = showMembers ? ops.slice(0, MAX_ROWS).map(memberLine) : [];
  const widest = Math.max(symbol.name.length * 7.8, (stereotype?.length ?? 0) * 6.2, ...attrLines.map((l) => l.length * CHAR), ...opLines.map((l) => l.length * CHAR));
  const width = Math.max(150, Math.min(400, widest + 28));
  const header = stereotype ? 42 : 30;
  const moreAttrs = showMembers ? Math.max(0, attrs.length - MAX_ROWS) : 0;
  const moreOps = showMembers ? Math.max(0, ops.length - MAX_ROWS) : 0;
  const attrH = showMembers && (attrLines.length || symbol.kind !== 'enum') ? (attrLines.length + (moreAttrs ? 1 : 0)) * ROW + 10 : 0;
  const opH = showMembers && symbol.kind !== 'enum' && symbol.kind !== 'type' ? (opLines.length + (moreOps ? 1 : 0)) * ROW + 10 : 0;
  return { id: symbol.id, symbol, file, stereotype, attrs: attrLines, ops: opLines, moreAttrs, moreOps, width, height: header + attrH + opH };
}

interface Laid {
  nodes: (Entity & { x: number; y: number })[];
  edges: { edge: SymbolEdge; points: { x: number; y: number }[] }[];
  width: number;
  height: number;
}

function layoutDiagram(entities: Entity[], edges: SymbolEdge[]): Laid {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: 'BT', nodesep: 36, ranksep: 64, edgesep: 14, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const e of entities) g.setNode(e.id, { width: e.width, height: e.height });
  edges.forEach((e, i) => g.setEdge(e.source, e.target, { weight: e.kind === 'uses' ? 1 : 4, minlen: 1 }, `e${i}`));
  dagre.layout(g);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nodes = g.nodes().map((id) => {
    const n = g.node(id) as { x: number; y: number };
    return { ...byId.get(id)!, x: n.x, y: n.y };
  });
  const laidEdges = edges.map((edge, i) => {
    const data = g.edge({ v: edge.source, w: edge.target, name: `e${i}` }) as { points?: { x: number; y: number }[] } | undefined;
    return { edge, points: data?.points ?? [] };
  });
  const graph = g.graph() as { width?: number; height?: number };
  return { nodes, edges: laidEdges, width: graph.width ?? 800, height: graph.height ?? 600 };
}

export function ClassesView() {
  const model = useModel();
  const theme = useStore((s) => s.theme);
  const selection = useStore((s) => s.selection);
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState('');
  const [showMembers, setShowMembers] = useState(true);
  const [showUses, setShowUses] = useState(true);
  const [showIsolated, setShowIsolated] = useState(false);
  const [showTypes, setShowTypes] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const all = useMemo(() => {
    const list: { symbol: SymbolInfo; file: FileInfo }[] = [];
    for (const f of model.files) {
      if (f.kind === 'test' || f.kind === 'story') continue;
      for (const s of f.symbols) {
        if (s.kind === 'class' || s.kind === 'interface' || s.kind === 'enum' || (s.kind === 'type' && s.members?.length)) list.push({ symbol: s, file: f });
      }
    }
    return list;
  }, [model]);
  const folders = useMemo(() => [...new Set(all.map((x) => x.file.dir.split('/').slice(0, 2).join('/')))].filter(Boolean).sort(), [all]);
  const relationKinds = useMemo(() => new Set<SymbolEdge['kind']>(['extends', 'implements', ...(showUses ? (['uses'] as const) : [])]), [showUses]);

  const { entities, edges, total } = useMemo(() => {
    const q = search.trim().toLowerCase();
    let pool = all.filter((x) => (showTypes || x.symbol.kind !== 'type') && (!folder || x.file.dir === folder || x.file.dir.startsWith(`${folder}/`)));
    const ids = new Set(pool.map((x) => x.symbol.id));
    const rel = model.data.symbolEdges.filter((e) => relationKinds.has(e.kind) && ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
    const connected = new Set(rel.flatMap((e) => [e.source, e.target]));
    if (q) {
      const hits = new Set(pool.filter((x) => x.symbol.name.toLowerCase().includes(q) || x.file.id.toLowerCase().includes(q)).map((x) => x.symbol.id));
      // include direct relatives of matches for context
      for (const e of rel) {
        if (hits.has(e.source)) hits.add(e.target);
        if (hits.has(e.target)) hits.add(e.source);
      }
      pool = pool.filter((x) => hits.has(x.symbol.id));
    } else if (!showIsolated) {
      const filtered = pool.filter((x) => connected.has(x.symbol.id));
      if (filtered.length) pool = filtered;
    }
    const degree = new Map<string, number>();
    rel.forEach((e) => {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    });
    const limited = [...pool].sort((a, b) => (degree.get(b.symbol.id) ?? 0) - (degree.get(a.symbol.id) ?? 0)).slice(0, 160);
    const keep = new Set(limited.map((x) => x.symbol.id));
    return {
      entities: limited.map((x) => makeEntity(x.symbol, x.file, showMembers)),
      edges: rel.filter((e) => keep.has(e.source) && keep.has(e.target)),
      total: pool.length,
    };
  }, [all, search, folder, showMembers, showIsolated, showTypes, relationKinds, model]);

  const laid = useMemo(() => layoutDiagram(entities, edges), [entities, edges]);

  const fit = (): void => {
    if (!svgRef.current || !zoomRef.current || !wrapRef.current) return;
    const { clientWidth: w, clientHeight } = wrapRef.current;
    const h = Math.max(200, clientHeight - 80); // keep the legend from covering the diagram
    const scale = Math.min(1.2, Math.min(w / (laid.width + 40), h / (laid.height + 40)));
    const tx = (w - laid.width * scale) / 2;
    const ty = (h - laid.height * scale) / 2 + 8;
    d3select(svgRef.current).transition().duration(300).call(zoomRef.current.transform, zoomIdentity.translate(tx, ty).scale(scale));
  };

  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = d3select(svgRef.current);
    const g = d3select(gRef.current);
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 3])
      .on('zoom', (e) => g.attr('transform', e.transform.toString()));
    zoomRef.current = z;
    svg.call(z).on('dblclick.zoom', null);
    return () => void svg.on('.zoom', null);
  }, []);
  useEffect(fit, [laid]); // eslint-disable-line react-hooks/exhaustive-deps

  const lineGen = line<{ x: number; y: number }>()
    .x((p) => p.x)
    .y((p) => p.y)
    .curve(curveBasis);

  if (!all.length) {
    return (
      <Empty icon={Shapes} title="No classes, interfaces or enums">
        This codebase is written without classes or explicit types.
      </Empty>
    );
  }

  const selectedId = selection?.type === 'symbol' ? selection.id : null;
  const activeId = hover ?? selectedId;
  const related = new Set<string>();
  if (activeId) for (const e of edges) if (e.source === activeId || e.target === activeId) related.add(e.source).add(e.target);

  const exportSvg = (): void => {
    if (!svgRef.current) return;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('viewBox', `0 0 ${laid.width} ${laid.height}`);
    clone.setAttribute('width', String(laid.width));
    clone.setAttribute('height', String(laid.height));
    clone.querySelector('g')?.removeAttribute('transform');
    const css = getComputedStyle(document.documentElement);
    let text = new XMLSerializer().serializeToString(clone);
    text = text.replace(/var\((--[\w-]+)\)/g, (_, v: string) => css.getPropertyValue(v).trim() || '#888');
    downloadBlob(`${model.data.project.name}-classes.svg`, text, 'image/svg+xml');
  };

  return (
    <>
      <div className="toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Find a class or interface…" style={{ width: 240 }} />
        <Select value={folder} onChange={setFolder} options={[{ value: '', label: 'All folders' }, ...folders.map((f) => ({ value: f, label: f }))]} />
        <Toggle checked={showMembers} onChange={setShowMembers} label="Members" />
        <Toggle checked={showUses} onChange={setShowUses} label="Associations" />
        <Toggle checked={showIsolated} onChange={setShowIsolated} label="Unrelated" />
        <Toggle checked={showTypes} onChange={setShowTypes} label="Type aliases" />
        <span className="spacer" />
        <span className="small muted">
          {plural(entities.length, 'entity', 'entities')}
          {total > entities.length ? ` of ${total}` : ''} · {plural(edges.length, 'relation')}
        </span>
      </div>
      <div className="canvas-wrap" ref={wrapRef}>
        <svg ref={svgRef} className="svg-canvas" data-theme={theme}>
          <defs>
            <marker id="uml-tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="13" markerHeight="13" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M1,1 L11,6 L1,11 Z" fill="var(--graph-bg)" stroke="var(--text-dim)" strokeWidth="1.3" />
            </marker>
            <marker id="uml-tri-hl" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="13" markerHeight="13" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M1,1 L11,6 L1,11 Z" fill="var(--graph-bg)" stroke="var(--accent)" strokeWidth="1.5" />
            </marker>
            <marker id="uml-open" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="11" markerHeight="11" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
              <path d="M1,1 L10,6 L1,11" fill="none" stroke="var(--text-faint)" strokeWidth="1.3" />
            </marker>
          </defs>
          <g ref={gRef}>
            {laid.edges.map(({ edge, points }, i) => {
              const hl = activeId && (edge.source === activeId || edge.target === activeId);
              const dim = activeId && !hl;
              const isUses = edge.kind === 'uses';
              return (
                <path
                  key={i}
                  d={lineGen(points) ?? ''}
                  fill="none"
                  stroke={hl ? 'var(--accent)' : isUses ? 'var(--text-faint)' : 'var(--text-dim)'}
                  strokeWidth={hl ? 2 : isUses ? 1 : 1.4}
                  strokeDasharray={edge.kind === 'implements' ? '6 4' : isUses ? '3 4' : undefined}
                  opacity={dim ? 0.15 : 1}
                  markerEnd={`url(#${isUses ? 'uml-open' : hl ? 'uml-tri-hl' : 'uml-tri'})`}
                />
              );
            })}
            {laid.nodes.map((n) => {
              const meta = SYMBOL_META[n.symbol.kind];
              const x = n.x - n.width / 2;
              const y = n.y - n.height / 2;
              const header = n.stereotype ? 42 : 30;
              const dim = activeId && !related.has(n.id) && activeId !== n.id;
              const isActive = activeId === n.id;
              const attrTop = y + header;
              const attrH = showMembers && (n.attrs.length || n.symbol.kind !== 'enum') ? (n.attrs.length + (n.moreAttrs ? 1 : 0)) * ROW + 10 : 0;
              return (
                <g key={n.id} opacity={dim ? 0.25 : 1} style={{ cursor: 'pointer', transition: 'opacity .15s' }} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => selectSymbol(n.id)}>
                  <rect x={x} y={y} width={n.width} height={n.height} rx={8} fill="var(--surface)" stroke={isActive ? 'var(--accent)' : meta.color} strokeWidth={isActive ? 2.5 : 1.3} />
                  <path d={`M${x},${y + 8} a8,8 0 0 1 8,-8 h${n.width - 16} a8,8 0 0 1 8,8 v${header - 8} h${-n.width} Z`} fill={meta.color} fillOpacity={0.16} />
                  {n.stereotype && (
                    <text x={n.x} y={y + 15} textAnchor="middle" fontSize={10} fill="var(--text-dim)" fontStyle="italic">
                      {n.stereotype}
                    </text>
                  )}
                  <text x={n.x} y={y + (n.stereotype ? 32 : 20)} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--text)" fontStyle={n.symbol.abstract || n.symbol.kind === 'interface' ? 'italic' : undefined}>
                    {n.symbol.name}
                  </text>
                  {showMembers && attrH > 0 && <line x1={x} x2={x + n.width} y1={attrTop} y2={attrTop} stroke={meta.color} strokeOpacity={0.4} />}
                  {n.attrs.map((a, i) => (
                    <text key={`a${i}`} x={x + 10} y={attrTop + 15 + i * ROW} fontSize={11} fill="var(--text-2)" style={{ fontFamily: 'var(--mono)' }}>
                      {a}
                    </text>
                  ))}
                  {n.moreAttrs > 0 && (
                    <text x={x + 10} y={attrTop + 15 + n.attrs.length * ROW} fontSize={10.5} fill="var(--text-faint)">
                      … {n.moreAttrs} more
                    </text>
                  )}
                  {showMembers && n.symbol.kind !== 'enum' && n.symbol.kind !== 'type' && (
                    <>
                      <line x1={x} x2={x + n.width} y1={attrTop + attrH} y2={attrTop + attrH} stroke={meta.color} strokeOpacity={0.4} />
                      {n.ops.map((o, i) => (
                        <text key={`o${i}`} x={x + 10} y={attrTop + attrH + 15 + i * ROW} fontSize={11} fill="var(--text-2)" style={{ fontFamily: 'var(--mono)' }}>
                          {o}
                        </text>
                      ))}
                      {n.moreOps > 0 && (
                        <text x={x + 10} y={attrTop + attrH + 15 + n.ops.length * ROW} fontSize={10.5} fill="var(--text-faint)">
                          … {n.moreOps} more
                        </text>
                      )}
                    </>
                  )}
                  <title>{`${n.symbol.name} — ${n.file.id}:${n.symbol.line}`}</title>
                </g>
              );
            })}
          </g>
        </svg>
        {!entities.length && (
          <div className="empty" style={{ position: 'absolute', inset: 0 }}>
            <h3>No matches</h3>
            <p>Try another search, or enable “Unrelated” to show entities without relations.</p>
          </div>
        )}
        <div className="floating legend">
          <span className="legend-item">
            <svg width="34" height="10">
              <line x1="0" y1="5" x2="26" y2="5" stroke="var(--text-dim)" strokeWidth="1.4" />
              <path d="M24,1 L33,5 L24,9 Z" fill="var(--graph-bg)" stroke="var(--text-dim)" />
            </svg>
            extends
          </span>
          <span className="legend-item">
            <svg width="34" height="10">
              <line x1="0" y1="5" x2="26" y2="5" stroke="var(--text-dim)" strokeWidth="1.4" strokeDasharray="5 3" />
              <path d="M24,1 L33,5 L24,9 Z" fill="var(--graph-bg)" stroke="var(--text-dim)" />
            </svg>
            implements
          </span>
          <span className="legend-item">
            <svg width="34" height="10">
              <line x1="0" y1="5" x2="30" y2="5" stroke="var(--text-faint)" strokeDasharray="3 3" />
              <path d="M26,1 L32,5 L26,9" fill="none" stroke="var(--text-faint)" />
            </svg>
            uses
          </span>
          {(['class', 'interface', 'enum'] as const).map((k) => (
            <span key={k} className="legend-item">
              <span className="dot" style={{ ['--c' as string]: SYMBOL_META[k].color }} /> {SYMBOL_META[k].label}
            </span>
          ))}
          <span className="legend-item faint">+ public · − private · # protected</span>
        </div>
        <div className="floating zoom-controls">
          <button className="btn ghost icon sm" onClick={fit} aria-label="Fit">
            <Maximize2 size={15} />
          </button>
          <button className="btn ghost icon sm" onClick={exportSvg} aria-label="Download SVG" title="Download SVG">
            <Download size={15} />
          </button>
        </div>
        {hover && (
          <div className="floating graph-stats">
            <span className="mono">{basename(entities.find((e) => e.id === hover)?.file.id ?? '')}</span>
          </div>
        )}
      </div>
    </>
  );
}
