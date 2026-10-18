import { useMemo, useState } from 'react';
import type { ElementDefinition, LayoutOptions } from 'cytoscape';
import { Atom, Crosshair, X } from 'lucide-react';
import { useModel } from '../data/context';
import { fileOfSymbolId, type Model } from '../data/model';
import { KIND_META } from '../lib/colors';
import { basename, plural } from '../lib/format';
import { selectSymbol, useStore } from '../state/store';
import type { FileInfo, SymbolInfo } from '../types';
import { CyCanvas, cardSize } from '../components/CyCanvas';
import { Empty, SearchInput, Segmented, Select, Toggle } from '../components/ui';

interface Comp {
  id: string;
  symbol: SymbolInfo;
  file: FileInfo;
  renders: number;
  renderedBy: number;
}

function collect(model: Model): Comp[] {
  const list: Comp[] = [];
  for (const f of model.files) {
    if (f.kind === 'test' || f.kind === 'story') continue;
    for (const s of f.symbols) {
      if (s.kind !== 'component') continue;
      const out = (model.symOut.get(s.id) ?? []).filter((e) => e.kind === 'renders').length;
      const inn = (model.symIn.get(s.id) ?? []).filter((e) => e.kind === 'renders').length;
      list.push({ id: s.id, symbol: s, file: f, renders: out, renderedBy: inn });
    }
  }
  return list;
}

const LAYOUT_TB = { name: 'dagre', rankDir: 'TB', nodeSep: 18, rankSep: 70, edgeSep: 10, animate: false } as LayoutOptions;
const LAYOUT_LR = { name: 'dagre', rankDir: 'LR', nodeSep: 12, rankSep: 90, edgeSep: 8, animate: false } as LayoutOptions;

export function ComponentsView() {
  const model = useModel();
  const selection = useStore((s) => s.selection);
  const comps = useMemo(() => collect(model), [model]);
  const byId = useMemo(() => new Map(comps.map((c) => [c.id, c])), [comps]);
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [depth, setDepth] = useState(3);
  const [showHooks, setShowHooks] = useState(true);
  const [showContexts, setShowContexts] = useState(true);
  const [direction, setDirection] = useState<'TB' | 'LR'>('TB');
  const [sort, setSort] = useState<'used' | 'renders' | 'name'>('used');

  const visible = useMemo(() => {
    if (focus) {
      const keep = new Map<string, number>([[focus, 0]]);
      const down = [focus];
      while (down.length) {
        const id = down.shift()!;
        const d = keep.get(id)!;
        if (d >= depth) continue;
        for (const e of model.symOut.get(id) ?? []) {
          if (e.kind !== 'renders' || keep.has(e.target)) continue;
          keep.set(e.target, d + 1);
          down.push(e.target);
        }
      }
      for (const e of model.symIn.get(focus) ?? []) if (e.kind === 'renders') keep.set(e.source, -1);
      return new Set(keep.keys());
    }
    const connected = comps.filter((c) => c.renders || c.renderedBy);
    const pool = connected.length ? connected : comps;
    return new Set(
      [...pool]
        .sort((a, b) => b.renderedBy + b.renders - (a.renderedBy + a.renders))
        .slice(0, 260)
        .map((c) => c.id),
    );
  }, [focus, depth, comps, model]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const els: ElementDefinition[] = [];
    const extra = new Map<string, ElementDefinition>();
    for (const id of visible) {
      const ref = model.resolveSymbol(id);
      if (!ref) continue;
      const sub = basename(ref.file.id);
      const label = `${ref.symbol.name}\n${sub}`;
      const color = KIND_META[ref.file.kind]?.color ?? '#3b82f6';
      els.push({ group: 'nodes', data: { id, label, type: 'card', color, ...cardSize(ref.symbol.name, sub) } });
    }
    for (const id of visible) {
      for (const e of model.symOut.get(id) ?? []) {
        if (e.kind === 'renders' && visible.has(e.target)) {
          els.push({ group: 'edges', data: { id: `${id}>${e.target}`, source: id, target: e.target, width: 1.6 } });
        } else if (showHooks && e.kind === 'calls') {
          const target = model.resolveSymbol(e.target);
          if (target?.symbol.kind !== 'hook' || target.member) continue;
          if (!extra.has(e.target)) extra.set(e.target, { group: 'nodes', data: { id: e.target, label: target.symbol.name, type: 'symbol', color: '#06b6d4', size: 18, shape: 'diamond' } });
          els.push({ group: 'edges', data: { id: `${id}>${e.target}`, source: id, target: e.target, width: 1, dashed: true } });
        } else if (showContexts && e.kind === 'uses') {
          const target = model.resolveSymbol(e.target);
          if (!target?.symbol.tags?.includes('context')) continue;
          if (!extra.has(e.target)) extra.set(e.target, { group: 'nodes', data: { id: e.target, label: target.symbol.name, type: 'symbol', color: '#0ea5e9', size: 22, shape: 'barrel' } });
          els.push({ group: 'edges', data: { id: `${id}>${e.target}`, source: id, target: e.target, width: 1, dashed: true } });
        }
      }
    }
    return [...els.filter((e) => e.group === 'nodes'), ...extra.values(), ...els.filter((e) => e.group === 'edges')];
  }, [visible, model, showHooks, showContexts]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = comps.filter((c) => !q || c.symbol.name.toLowerCase().includes(q) || c.file.id.toLowerCase().includes(q));
    return filtered.sort((a, b) => (sort === 'name' ? a.symbol.name.localeCompare(b.symbol.name) : sort === 'renders' ? b.renders - a.renders : b.renderedBy - a.renderedBy));
  }, [comps, search, sort]);

  if (!comps.length) {
    return (
      <Empty icon={Atom} title="No components found">
        This codebase has no React, Vue, Svelte, Angular or Astro components.
      </Empty>
    );
  }
  const roots = comps.filter((c) => !c.renderedBy && c.renders).length;
  const highlight = selection?.type === 'symbol' && visible.has(selection.id) ? selection.id : null;
  const focusRef = focus ? byId.get(focus) : undefined;

  return (
    <div className="split" style={{ flex: 1, minHeight: 0 }}>
      <div className="split-side">
        <div className="side-head">
          <SearchInput value={search} onChange={setSearch} placeholder={`Search ${comps.length} components…`} />
          <div className="row nowrap" style={{ justifyContent: 'space-between' }}>
            <span className="tiny muted">
              {plural(comps.length, 'component')} · {plural(roots, 'root')}
            </span>
            <Select
              value={sort}
              onChange={setSort}
              style={{ height: 26, fontSize: 12 }}
              options={[
                { value: 'used', label: 'Most reused' },
                { value: 'renders', label: 'Most children' },
                { value: 'name', label: 'Name' },
              ]}
            />
          </div>
        </div>
        <div className="side-body">
          {list.slice(0, 400).map((c) => (
            <button
              key={c.id}
              className={`list-item${focus === c.id ? ' active' : ''}`}
              onClick={() => {
                setFocus(c.id);
                selectSymbol(c.id);
              }}
              title={c.file.id}
            >
              <span className="dot" style={{ ['--c' as string]: KIND_META[c.file.kind].color }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="title truncate">{c.symbol.name}</div>
                <div className="tiny faint mono truncate">{c.file.id}</div>
              </div>
              <span className="meta" title="Rendered by / renders">
                ↑{c.renderedBy} ↓{c.renders}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="split-main">
        <div className="toolbar">
          {focusRef ? (
            <>
              <span className="badge accent">
                <Crosshair size={12} /> {focusRef.symbol.name}
              </span>
              <Select
                value={String(depth)}
                onChange={(v) => setDepth(Number(v))}
                options={[1, 2, 3, 4, 6, 10].map((d) => ({ value: String(d), label: `Depth ${d}` }))}
              />
              <button className="btn sm" onClick={() => setFocus(null)}>
                <X size={13} /> Show all
              </button>
            </>
          ) : (
            <span className="small muted">Showing {plural(visible.size, 'component')} — pick one on the left (or double-click a node) to see its subtree.</span>
          )}
          <span className="spacer" />
          <Toggle checked={showHooks} onChange={setShowHooks} label="Hooks" />
          <Toggle checked={showContexts} onChange={setShowContexts} label="Contexts" />
          <Segmented
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'TB', label: '↓' },
              { value: 'LR', label: '→' },
            ]}
          />
        </div>
        <CyCanvas
          elements={elements}
          layout={direction === 'TB' ? LAYOUT_TB : LAYOUT_LR}
          highlight={highlight}
          onTap={(id) => selectSymbol(id)}
          onDblTap={(id) => byId.has(id) && setFocus(id)}
          exportName="components"
          tooltip={(id) => {
            const ref = model.resolveSymbol(id);
            if (!ref) return null;
            const comp = ref.symbol.component;
            return (
              <>
                <div className="tt-title">{ref.symbol.name}</div>
                <div className="muted mono tiny">{fileOfSymbolId(id)}</div>
                {comp && (
                  <div className="muted">
                    {comp.props.length ? `props: ${comp.props.slice(0, 6).join(', ')}${comp.props.length > 6 ? '…' : ''}` : 'no props'}
                    {comp.hooks.length ? ` · hooks: ${comp.hooks.slice(0, 4).join(', ')}` : ''}
                  </div>
                )}
              </>
            );
          }}
        >
          <div className="floating legend">
            <span className="legend-item">
              <span className="dot" style={{ ['--c' as string]: KIND_META.page.color }} /> page
            </span>
            <span className="legend-item">
              <span className="dot" style={{ ['--c' as string]: KIND_META.layout.color }} /> layout
            </span>
            <span className="legend-item">
              <span className="dot" style={{ ['--c' as string]: KIND_META.component.color }} /> component
            </span>
            {showHooks && (
              <span className="legend-item">
                <span style={{ color: '#06b6d4' }}>◆</span> hook
              </span>
            )}
            {showContexts && (
              <span className="legend-item">
                <span style={{ color: '#0ea5e9' }}>▮</span> context
              </span>
            )}
            <span className="legend-item faint">arrow = renders</span>
          </div>
        </CyCanvas>
      </div>
    </div>
  );
}
