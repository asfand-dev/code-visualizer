import { useEffect, useMemo, useState } from 'react';
import type { ElementDefinition, LayoutOptions } from 'cytoscape';
import { Workflow } from 'lucide-react';
import { useModel } from '../data/context';
import { callersOf, calleesOf } from '../../../src/shared/query';
import { fileOfSymbolId, symbolLabel, type Model } from '../data/model';
import { SYMBOL_META } from '../lib/colors';
import { basename, plural } from '../lib/format';
import { selectSymbol, setState, useStore } from '../state/store';
import { CyCanvas, cardSize } from '../components/CyCanvas';
import { Empty, SearchInput, Segmented, Select, SymbolIcon } from '../components/ui';

type Direction = 'both' | 'callees' | 'callers';

interface Callable {
  id: string;
  label: string;
  file: string;
  kind: 'function' | 'hook' | 'component' | 'method' | 'class';
  out: number;
  in: number;
}

function callables(model: Model): Callable[] {
  const ids = new Set<string>();
  for (const e of model.data.symbolEdges) {
    if (e.kind !== 'calls' && e.kind !== 'instantiates') continue;
    ids.add(e.source);
    ids.add(e.target);
  }
  const list: Callable[] = [];
  for (const id of ids) {
    const ref = model.resolveSymbol(id);
    if (!ref) continue;
    const kind = ref.member ? 'method' : ref.symbol.kind;
    if (!['function', 'hook', 'component', 'method', 'class'].includes(kind)) continue;
    list.push({
      id,
      label: ref.label,
      file: ref.file.id,
      kind: kind as Callable['kind'],
      out: calleesOf(model.data, id, ['calls', 'instantiates'], false).length,
      in: callersOf(model.data, id, ['calls', 'instantiates'], false).length,
    });
  }
  return list.sort((a, b) => b.out + b.in - (a.out + a.in));
}

const LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 14, rankSep: 80, edgeSep: 8, animate: false } as LayoutOptions;

export function FlowView() {
  const model = useModel();
  const flowRoot = useStore((s) => s.flowRoot);
  const selection = useStore((s) => s.selection);
  const list = useMemo(() => callables(model), [model]);
  const [search, setSearch] = useState('');
  const [depth, setDepth] = useState(2);
  const [direction, setDirection] = useState<Direction>('both');
  const [wholeFile, setWholeFile] = useState(false);
  const root = flowRoot && model.resolveSymbol(flowRoot) ? flowRoot : list[0]?.id;

  useEffect(() => {
    if (!flowRoot && list[0]) setState({ flowRoot: list[0].id });
  }, [flowRoot, list]);

  const elements = useMemo<ElementDefinition[]>(() => {
    if (!root) return [];
    const nodes = new Map<string, number>(); // id → column hint
    const edges = new Map<string, { source: string; target: string; count: number; http?: string }>();
    const isCall = (k: string): boolean => k === 'calls' || k === 'instantiates';
    if (wholeFile) {
      const file = fileOfSymbolId(root);
      const inFile = (id: string): boolean => fileOfSymbolId(id) === file;
      for (const e of model.data.symbolEdges) {
        if (!isCall(e.kind)) continue;
        if (!inFile(e.source) && !inFile(e.target)) continue;
        nodes.set(e.source, 0);
        nodes.set(e.target, 0);
        edges.set(`${e.source}>${e.target}`, { source: e.source, target: e.target, count: e.count });
      }
      nodes.set(root, 0);
    } else {
      nodes.set(root, 0);
      const walk = (dir: 'out' | 'in'): void => {
        const queue: [string, number][] = [[root, 0]];
        const seen = new Set([root]);
        while (queue.length) {
          const [id, d] = queue.shift()!;
          if (d >= depth) continue;
          // Calls and `new`, plus HTTP requests to route handlers (full-stack flow).
          const links = dir === 'out' ? calleesOf(model.data, id) : callersOf(model.data, id);
          for (const l of links) {
            const [source, target] = dir === 'out' ? [id, l.id] : [l.id, id];
            const key = `${source}>${target}`;
            if (l.kind === 'http') edges.set(key, { source, target, count: 1, http: l.label });
            else if (!edges.get(key)?.http) edges.set(key, { source, target, count: l.count });
            if (!nodes.has(l.id)) nodes.set(l.id, dir === 'out' ? d + 1 : -(d + 1));
            if (!seen.has(l.id)) {
              seen.add(l.id);
              queue.push([l.id, d + 1]);
            }
          }
        }
      };
      if (direction !== 'callers') walk('out');
      if (direction !== 'callees') walk('in');
    }
    const els: ElementDefinition[] = [];
    for (const id of nodes.keys()) {
      const ref = model.resolveSymbol(id);
      const label = ref?.label ?? symbolLabel(id);
      const sub = basename(fileOfSymbolId(id));
      const kind = ref?.member ? 'method' : (ref?.symbol.kind ?? 'function');
      els.push({ group: 'nodes', data: { id, label: `${label}\n${sub}`, type: 'card', color: id === root ? '#8b6dff' : SYMBOL_META[kind as keyof typeof SYMBOL_META]?.color ?? '#10b981', ...cardSize(label, sub) } });
    }
    for (const [key, e] of edges) {
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
      els.push({
        group: 'edges',
        data: { id: key, source: e.source, target: e.target, width: e.http ? 2 : Math.min(4, 1 + Math.log2(e.count)), label: e.http ? `HTTP ${e.http}` : e.count > 1 ? `×${e.count}` : undefined, dashed: !!e.http },
      });
    }
    return els;
  }, [root, depth, direction, wholeFile, model]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (q ? list.filter((c) => c.label.toLowerCase().includes(q) || c.file.toLowerCase().includes(q)) : list).slice(0, 400);
  }, [list, search]);

  if (!list.length) {
    return (
      <Empty icon={Workflow} title="No call relationships found">
        The analyzer links calls between functions it can resolve statically.
      </Empty>
    );
  }
  const rootRef = root ? model.resolveSymbol(root) : undefined;
  const highlight = selection?.type === 'symbol' ? selection.id : null;

  return (
    <div className="split" style={{ flex: 1, minHeight: 0 }}>
      <div className="split-side">
        <div className="side-head">
          <SearchInput value={search} onChange={setSearch} placeholder={`Search ${plural(list.length, 'function')}…`} />
          <span className="tiny muted">Sorted by number of call connections</span>
        </div>
        <div className="side-body">
          {filtered.map((c) => (
            <button key={c.id} className={`list-item${c.id === root ? ' active' : ''}`} onClick={() => setState({ flowRoot: c.id })} title={c.file}>
              <SymbolIcon kind={c.kind === 'method' ? 'function' : c.kind} method={c.kind === 'method'} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="title truncate mono" style={{ fontSize: 12.5 }}>
                  {c.label}
                </div>
                <div className="tiny faint mono truncate">{c.file}</div>
              </div>
              <span className="meta" title="Called by / calls">
                ←{c.in} →{c.out}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="split-main">
        <div className="toolbar">
          {rootRef && (
            <button className="chip" onClick={() => selectSymbol(root!)} title="Show details">
              <SymbolIcon kind={rootRef.member ? 'function' : rootRef.symbol.kind} method={!!rootRef.member} />
              <span className="mono">{rootRef.label}</span>
            </button>
          )}
          <Segmented
            value={wholeFile ? 'file' : direction}
            onChange={(v) => {
              if (v === 'file') setWholeFile(true);
              else {
                setWholeFile(false);
                setDirection(v as Direction);
              }
            }}
            options={[
              { value: 'both', label: 'Callers & callees' },
              { value: 'callees', label: 'Callees' },
              { value: 'callers', label: 'Callers' },
              { value: 'file', label: 'Whole file' },
            ]}
          />
          {!wholeFile && <Select value={String(depth)} onChange={(v) => setDepth(Number(v))} options={[1, 2, 3, 4, 5].map((d) => ({ value: String(d), label: `Depth ${d}` }))} />}
          <span className="spacer" />
          <span className="small muted">{plural(elements.filter((e) => e.group === 'nodes').length, 'function')}</span>
        </div>
        <CyCanvas
          elements={elements}
          layout={LAYOUT}
          highlight={highlight}
          exportName="call-flow"
          onTap={(id) => selectSymbol(id)}
          onDblTap={(id) => setState({ flowRoot: id })}
          tooltip={(id) => {
            const ref = model.resolveSymbol(id);
            return (
              <>
                <div className="tt-title mono">{ref?.label ?? symbolLabel(id)}</div>
                <div className="muted mono tiny">{fileOfSymbolId(id)}</div>
                <div className="muted tiny">Double-click to center the flow here</div>
              </>
            );
          }}
        >
          <div className="floating legend">
            <span className="tiny muted">Arrows point from caller to callee; dashed arrows are HTTP requests to a route handler. Double-click a function to re-center.</span>
          </div>
        </CyCanvas>
      </div>
    </div>
  );
}
