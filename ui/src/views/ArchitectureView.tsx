import { useEffect, useMemo, useRef, useState } from 'react';
import { chord, ribbon, arc as d3arc, descending, select as d3select, zoom as d3zoom, zoomIdentity, type Chord, type ChordGroup } from 'd3';
import type { Core } from 'cytoscape';
import { Grid3x3, Layers, Orbit } from 'lucide-react';
import { useModel } from '../data/context';
import { areaName, defaultAreaDepth } from '../../../src/shared/architecture';
import type { Model } from '../data/model';
import { categorical } from '../lib/colors';
import { fmtNum, plural } from '../lib/format';
import { select, selectFile, useStore } from '../state/store';
import { baseStyle, ensureCytoscape, fitTo, themeColors } from '../components/cy';
import { Segmented, Select, Toggle } from '../components/ui';

type Tab = 'matrix' | 'chord' | 'layers';

interface Groups {
  names: string[];
  matrix: number[][];
  files: number[];
  loc: number[];
  cellEdges: Map<string, { source: string; target: string }[]>;
}

function buildGroups(model: Model, depth: number, typeOnly: boolean, tests: boolean): Groups {
  const files = model.files.filter((f) => f.scope !== 'context' && (tests || (f.kind !== 'test' && f.kind !== 'story')));
  const fileGroup = new Map<string, string>();
  const counts = new Map<string, { files: number; loc: number }>();
  for (const f of files) {
    const g = areaName(f.dir, depth);
    fileGroup.set(f.id, g);
    const c = counts.get(g) ?? { files: 0, loc: 0 };
    c.files++;
    c.loc += f.loc;
    counts.set(g, c);
  }
  const names = [...counts.keys()];
  const index = new Map(names.map((n, i) => [n, i]));
  const matrix = names.map(() => names.map(() => 0));
  const cellEdges = new Map<string, { source: string; target: string }[]>();
  for (const e of model.data.edges) {
    if (!typeOnly && e.typeOnly) continue;
    const a = fileGroup.get(e.source);
    const b = fileGroup.get(e.target);
    if (a === undefined || b === undefined) continue;
    const i = index.get(a)!;
    const j = index.get(b)!;
    matrix[i][j]++;
    const key = `${i}:${j}`;
    const list = cellEdges.get(key) ?? [];
    list.push({ source: e.source, target: e.target });
    cellEdges.set(key, list);
  }
  // Order: consumers first, foundations last (so dependencies mostly point "down-right").
  const order = names.map((_, i) => {
    let fanOut = 0;
    let fanIn = 0;
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue;
      fanOut += matrix[i][j];
      fanIn += matrix[j][i];
    }
    return { i, instability: fanIn + fanOut ? fanOut / (fanIn + fanOut) : 0.5 };
  });
  order.sort((a, b) => b.instability - a.instability || names[a.i].localeCompare(names[b.i]));
  const perm = order.map((o) => o.i);
  const remapEdges = new Map<string, { source: string; target: string }[]>();
  perm.forEach((oi, ni) =>
    perm.forEach((oj, nj) => {
      const list = cellEdges.get(`${oi}:${oj}`);
      if (list) remapEdges.set(`${ni}:${nj}`, list);
    }),
  );
  return {
    names: perm.map((i) => names[i]),
    matrix: perm.map((i) => perm.map((j) => matrix[i][j])),
    files: perm.map((i) => counts.get(names[i])!.files),
    loc: perm.map((i) => counts.get(names[i])!.loc),
    cellEdges: remapEdges,
  };
}

/** Folder depth whose number of areas is closest to a readable ~12. */
function defaultDepth(model: Model): number {
  return defaultAreaDepth(model.files, model.maxDepth);
}

function leftTruncate(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

export function ArchitectureView() {
  const model = useModel();
  const [tab, setTab] = useState<Tab>('matrix');
  const [depth, setDepth] = useState(() => defaultDepth(model));
  const [typeOnly, setTypeOnly] = useState(true);
  const [tests, setTests] = useState(false);
  const groups = useMemo(() => buildGroups(model, depth, typeOnly, tests), [model, depth, typeOnly, tests]);
  const depthOptions = Array.from({ length: Math.max(1, model.maxDepth) }, (_, i) => ({ value: String(i + 1), label: `Folder depth ${i + 1}` }));

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'matrix', label: 'Matrix', icon: Grid3x3 },
            { value: 'chord', label: 'Chord', icon: Orbit },
            { value: 'layers', label: 'Layers', icon: Layers },
          ]}
        />
        <Select value={String(depth)} options={depthOptions} onChange={(v) => setDepth(Number(v))} />
        <Toggle checked={typeOnly} onChange={setTypeOnly} label="Type-only imports" />
        <Toggle checked={tests} onChange={setTests} label="Tests" />
        <span className="spacer" />
        <span className="small muted">
          {plural(groups.names.length, 'area')} · {fmtNum(groups.matrix.flat().reduce((a, b) => a + b, 0))} imports
        </span>
      </div>
      {tab === 'matrix' && <Matrix groups={groups} />}
      {tab === 'chord' && <ChordDiagram groups={groups} />}
      {tab === 'layers' && <LayerGraph groups={groups} />}
    </>
  );
}

/* --------------------------------- Matrix --------------------------------- */

function Matrix({ groups }: { groups: Groups }) {
  const model = useModel();
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const [picked, setPicked] = useState<{ i: number; j: number } | null>(null);
  const n = groups.names.length;
  const cell = Math.max(16, Math.min(40, Math.floor(640 / Math.max(n, 1))));
  const labelW = Math.min(260, Math.max(...groups.names.map((s) => s.length)) * 7 + 24);
  const maxChars = Math.floor((labelW - 16) / 7);
  const max = Math.max(1, ...groups.matrix.flatMap((row, i) => row.filter((_, j) => j !== i)));
  const size = n * cell;
  const top = labelW;
  const cellEdges = picked ? (groups.cellEdges.get(`${picked.i}:${picked.j}`) ?? []) : [];
  const mutual = (i: number, j: number): boolean => i !== j && groups.matrix[i][j] > 0 && groups.matrix[j][i] > 0;

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', flex: 1, minHeight: 0 }}>
      <div style={{ overflow: 'auto', padding: 24 }}>
        <div className="small muted" style={{ marginBottom: 14, maxWidth: 760 }}>
          Each cell counts imports from the <strong>row</strong> folder to the <strong>column</strong> folder. Areas are ordered from consumers (top) to foundations (bottom), so a healthy layered architecture keeps most cells <em>above</em> the diagonal. Cells outlined in red depend on each other in both directions.
        </div>
        <svg width={labelW + size + 20} height={top + size + 20} style={{ display: 'block', fontFamily: 'var(--font)' }} onMouseLeave={() => setHover(null)}>
          {groups.names.map((name, j) => (
            <text
              key={`c${j}`}
              transform={`translate(${labelW + j * cell + cell / 2 + 4}, ${top - 8}) rotate(-60)`}
              fontSize="11.5"
              fill={hover?.j === j ? 'var(--text)' : 'var(--text-dim)'}
              fontWeight={hover?.j === j ? 700 : 500}
              style={{ fontFamily: 'var(--mono)' }}
            >
              {leftTruncate(name, maxChars)}
              <title>{name}</title>
            </text>
          ))}
          {groups.names.map((name, i) => (
            <text
              key={`r${i}`}
              x={labelW - 10}
              y={top + i * cell + cell / 2 + 4}
              textAnchor="end"
              fontSize="11.5"
              fill={hover?.i === i ? 'var(--text)' : 'var(--text-dim)'}
              fontWeight={hover?.i === i ? 700 : 500}
              style={{ fontFamily: 'var(--mono)', cursor: 'pointer' }}
              onClick={() => model.folderByPath.has(name) && select({ type: 'folder', id: name })}
            >
              {leftTruncate(name, maxChars)}
              <title>{name}</title>
            </text>
          ))}
          <g transform={`translate(${labelW}, ${top})`}>
            {hover && <rect x={0} y={hover.i * cell} width={size} height={cell} fill="var(--accent)" opacity="0.07" />}
            {hover && <rect x={hover.j * cell} y={0} width={cell} height={size} fill="var(--accent)" opacity="0.07" />}
            {groups.matrix.map((row, i) =>
              row.map((v, j) => {
                const diag = i === j;
                const t = v ? Math.log1p(v) / Math.log1p(max) : 0;
                const below = j < i;
                return (
                  <g key={`${i}:${j}`} onMouseEnter={() => setHover({ i, j })} onClick={() => v && setPicked({ i, j })} style={{ cursor: v ? 'pointer' : 'default' }}>
                    <rect
                      x={j * cell + 1}
                      y={i * cell + 1}
                      width={cell - 2}
                      height={cell - 2}
                      rx={4}
                      fill={diag ? 'var(--surface-3)' : v ? (below ? `rgba(251, 146, 60, ${0.18 + t * 0.75})` : `rgba(139, 109, 255, ${0.18 + t * 0.75})`) : 'var(--surface-2)'}
                      stroke={mutual(i, j) ? 'var(--danger)' : picked?.i === i && picked?.j === j ? 'var(--text)' : 'none'}
                      strokeWidth={mutual(i, j) ? 1.5 : 2}
                    />
                    {v > 0 && cell >= 22 && (
                      <text x={j * cell + cell / 2} y={i * cell + cell / 2 + 4} textAnchor="middle" fontSize={cell >= 30 ? 11 : 9.5} fill={diag ? 'var(--text-dim)' : 'var(--text)'} fontWeight={600} pointerEvents="none">
                        {v}
                      </text>
                    )}
                  </g>
                );
              }),
            )}
          </g>
        </svg>
        <div className="row small muted" style={{ marginTop: 16, gap: 18 }}>
          <span className="row nowrap" style={{ gap: 6 }}>
            <span style={{ width: 14, height: 14, borderRadius: 4, background: 'rgba(139,109,255,.7)' }} /> downward dependency
          </span>
          <span className="row nowrap" style={{ gap: 6 }}>
            <span style={{ width: 14, height: 14, borderRadius: 4, background: 'rgba(251,146,60,.7)' }} /> upward dependency (possible layering violation)
          </span>
          <span className="row nowrap" style={{ gap: 6 }}>
            <span style={{ width: 14, height: 14, borderRadius: 4, border: '1.5px solid var(--danger)' }} /> mutual dependency
          </span>
        </div>
        {hover && (
          <div className="small" style={{ marginTop: 10 }}>
            <span className="mono">{groups.names[hover.i]}</span> → <span className="mono">{groups.names[hover.j]}</span>: <strong>{groups.matrix[hover.i][hover.j]}</strong> imports
          </div>
        )}
      </div>
      <div className="split-side" style={{ borderLeft: '1px solid var(--border)', borderRight: 0 }}>
        <div className="side-head">
          <strong className="small">{picked ? 'Imports in this cell' : 'Click a cell'}</strong>
          {picked && (
            <div className="tiny muted mono">
              {groups.names[picked.i]} → {groups.names[picked.j]}
            </div>
          )}
        </div>
        <div className="side-body">
          {!picked && <div className="muted small" style={{ padding: 10 }}>Select any non-empty cell to list the exact file-to-file imports behind it.</div>}
          {cellEdges.map((e) => (
            <div key={`${e.source}>${e.target}`} className="list-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }} onClick={() => selectFile(e.source)}>
              <span className="mono tiny truncate" style={{ maxWidth: '100%' }}>
                {e.source}
              </span>
              <span className="mono tiny faint truncate" style={{ maxWidth: '100%' }}>
                → {e.target}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Chord --------------------------------- */

function ChordDiagram({ groups }: { groups: Groups }) {
  const model = useModel();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const size = 760;
  const outer = size / 2 - 120;
  const inner = outer - 16;
  const data = useMemo(() => {
    const m = groups.matrix.map((row, i) => row.map((v, j) => (i === j ? 0 : v)));
    return chord().padAngle(0.03).sortSubgroups(descending)(m);
  }, [groups]);
  const ribbonGen = ribbon<Chord, ChordGroup>().radius(inner);
  const arcGen = d3arc<ChordGroup>().innerRadius(inner).outerRadius(outer);

  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = d3select(svgRef.current);
    const g = d3select(gRef.current);
    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.4, 4])
      .on('zoom', (e) => g.attr('transform', e.transform.toString()));
    svg.call(z);
    svg.call(z.transform, zoomIdentity);
    return () => void svg.on('.zoom', null);
  }, []);

  if (!data.length) return <div className="empty">No dependencies between areas at this depth.</div>;
  return (
    <div className="canvas-wrap" style={{ display: 'grid', placeItems: 'center' }}>
      <svg ref={svgRef} className="svg-canvas" viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}>
        <g ref={gRef}>
          <g>
            {data.map((c, i) => {
              const active = hover === null || c.source.index === hover || c.target.index === hover;
              return (
                <path
                  key={i}
                  d={ribbonGen(c) as unknown as string}
                  fill={categorical(c.source.index)}
                  fillOpacity={active ? 0.55 : 0.05}
                  stroke={categorical(c.source.index)}
                  strokeOpacity={active ? 0.6 : 0.05}
                  style={{ transition: 'fill-opacity .2s' }}
                >
                  <title>{`${groups.names[c.source.index]} → ${groups.names[c.target.index]}: ${c.source.value}\n${groups.names[c.target.index]} → ${groups.names[c.source.index]}: ${c.target.value}`}</title>
                </path>
              );
            })}
          </g>
          {data.groups.map((g) => {
            const angle = (g.startAngle + g.endAngle) / 2;
            const flip = angle > Math.PI;
            return (
              <g key={g.index} onMouseEnter={() => setHover(g.index)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }} onClick={() => model.folderByPath.has(groups.names[g.index]) && select({ type: 'folder', id: groups.names[g.index] })}>
                <path d={arcGen(g) ?? ''} fill={categorical(g.index)} stroke="var(--graph-bg)" />
                <text
                  transform={`rotate(${(angle * 180) / Math.PI - 90}) translate(${outer + 10}) ${flip ? 'rotate(180)' : ''}`}
                  textAnchor={flip ? 'end' : 'start'}
                  dy="0.35em"
                  fontSize="12"
                  fill={hover === g.index ? 'var(--text)' : 'var(--text-2)'}
                  fontWeight={hover === g.index ? 700 : 500}
                  style={{ fontFamily: 'var(--mono)' }}
                >
                  {groups.names[g.index]}
                </text>
                <title>{`${groups.names[g.index]}: ${groups.files[g.index]} files`}</title>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="floating legend" style={{ bottom: 14 }}>
        <span className="tiny muted">Ribbons connect areas that import each other; ribbon width shows the number of imports. Hover an area to isolate it, scroll to zoom.</span>
      </div>
    </div>
  );
}

/* --------------------------------- Layers --------------------------------- */

function LayerGraph({ groups }: { groups: Groups }) {
  const model = useModel();
  const theme = useStore((s) => s.theme);
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  useEffect(() => {
    const cytoscape = ensureCytoscape();
    const maxLoc = Math.max(1, ...groups.loc);
    const maxW = Math.max(1, ...groups.matrix.flatMap((r, i) => r.filter((_, j) => j !== i)));
    const elements = [
      ...groups.names.map((name, i) => ({
        group: 'nodes' as const,
        data: {
          id: `g${i}`,
          name,
          label: `${name}\n${groups.files[i]} files · ${fmtNum(groups.loc[i])} loc`,
          type: 'card',
          color: categorical(i),
          size: 40 + 26 * Math.sqrt(groups.loc[i] / maxLoc),
          w: Math.max(120, name.length * 7.5 + 30),
          tw: `${Math.max(110, name.length * 7.5 + 20)}px`,
          shape: 'round-rectangle',
        },
      })),
      ...groups.matrix.flatMap((row, i) =>
        row
          .map((v, j) => ({ v, j }))
          .filter(({ v, j }) => v > 0 && j !== i)
          .map(({ v, j }) => ({
            group: 'edges' as const,
            data: { id: `e${i}-${j}`, source: `g${i}`, target: `g${j}`, width: 1 + 5 * Math.sqrt(v / maxW), label: String(v), cycle: groups.matrix[j][i] > 0 },
          })),
      ),
    ];
    const cy = cytoscape({
      container: ref.current,
      elements,
      style: baseStyle(themeColors(), { curve: 'bezier' }),
      layout: { name: 'dagre', rankDir: 'TB', nodeSep: 40, rankSep: 90, padding: 30 } as never,
      minZoom: 0.1,
      maxZoom: 3,
      wheelSensitivity: 0.25,
    });
    fitTo(cy);
    cy.on('tap', 'node', (e) => {
      const name = e.target.data('name') as string;
      if (model.folderByPath.has(name)) select({ type: 'folder', id: name });
    });
    const ro = new ResizeObserver(() => cy.resize());
    if (ref.current) ro.observe(ref.current);
    cyRef.current = cy;
    return () => {
      ro.disconnect();
      cy.destroy();
    };
  }, [groups, model]);
  useEffect(() => {
    cyRef.current?.style(baseStyle(themeColors(), { curve: 'bezier' }));
  }, [theme]);
  return (
    <div className="canvas-wrap">
      <div ref={ref} className="canvas" />
      <div className="floating legend">
        <span className="tiny muted">Areas laid out top-down by dependency direction. Edge labels count imports; red edges are mutual (cyclic) dependencies.</span>
      </div>
    </div>
  );
}
