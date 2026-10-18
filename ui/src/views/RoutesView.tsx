import { useMemo, useState } from 'react';
import type { ElementDefinition, LayoutOptions } from 'cytoscape';
import { ArrowLeftRight, ChevronDown, ChevronRight, GitFork, Route as RouteIcon, Table2 } from 'lucide-react';
import { useModel } from '../data/context';
import { symbolLabel, type Model } from '../data/model';
import { METHOD_COLORS } from '../lib/colors';
import { basename, plural } from '../lib/format';
import { select, selectFile, selectSymbol, useStore } from '../state/store';
import type { RouteInfo } from '../types';
import { CyCanvas, cardSize } from '../components/CyCanvas';
import { Empty, SearchInput, Segmented, Select } from '../components/ui';

interface Trie {
  segment: string;
  path: string;
  routes: RouteInfo[];
  children: Map<string, Trie>;
  count: number;
}

function buildTrie(routes: RouteInfo[]): Trie {
  const root: Trie = { segment: '/', path: '/', routes: [], children: new Map(), count: 0 };
  for (const r of routes) {
    const parts = r.path.split('/').filter(Boolean);
    let node = root;
    node.count++;
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      let child = node.children.get(part);
      if (!child) {
        child = { segment: part, path: acc, routes: [], children: new Map(), count: 0 };
        node.children.set(part, child);
      }
      child.count++;
      node = child;
    }
    node.routes.push(r);
  }
  return root;
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span className="method" style={{ ['--m' as string]: METHOD_COLORS[method] ?? '#94a3b8' }}>
      {method}
    </span>
  );
}

function TrieNode({ node, depth, prefix, onPrefix }: { node: Trie; depth: number; prefix: string; onPrefix: (p: string) => void }) {
  const [open, setOpen] = useState(depth < 2);
  const children = [...node.children.values()].sort((a, b) => a.segment.localeCompare(b.segment));
  const methods = [...new Set(node.routes.map((r) => r.method))];
  const active = prefix === node.path;
  return (
    <>
      <div className={`tree-row${active ? ' active' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => onPrefix(active ? '' : node.path)}>
        <span
          className="chev"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {children.length ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
        </span>
        <span className="mono small truncate" style={{ color: node.segment.startsWith(':') || node.segment.startsWith('[') ? 'var(--accent)' : undefined }}>
          {depth === 0 ? '/' : `/${node.segment}`}
        </span>
        <span className="row nowrap" style={{ gap: 3, marginLeft: 'auto' }}>
          {methods.slice(0, 3).map((m) => (
            <span key={m} className="dot" style={{ ['--c' as string]: METHOD_COLORS[m] ?? '#94a3b8' }} title={m} />
          ))}
          <span className="tiny faint" style={{ marginLeft: 4 }}>
            {node.count}
          </span>
        </span>
      </div>
      {open && children.map((c) => <TrieNode key={c.path} node={c} depth={depth + 1} prefix={prefix} onPrefix={onPrefix} />)}
    </>
  );
}

function flowElements(model: Model, routes: RouteInfo[]): ElementDefinition[] {
  const els: ElementDefinition[] = [];
  const seen = new Set<string>();
  const addNode = (id: string, data: Record<string, unknown>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    els.push({ group: 'nodes', data: { id, ...data } });
  };
  for (const r of routes.slice(0, 150)) {
    const rid = `route:${r.id}`;
    const label = `${r.method} ${r.path}`;
    addNode(rid, { label, type: 'card', color: METHOD_COLORS[r.method] ?? '#94a3b8', ...cardSize(label) });
    let prev = rid;
    for (const m of r.middlewares ?? []) {
      // One node per route keeps each request chain readable.
      const mid = `mw:${m}:${r.id}`;
      addNode(mid, { label: m, type: 'symbol', color: '#eab308', size: 16, shape: 'round-octagon' });
      els.push({ group: 'edges', data: { id: `${prev}>${mid}:${r.id}`, source: prev, target: mid, width: 1.2, dashed: true } });
      prev = mid;
    }
    if (r.handlerSymbol) {
      const ref = model.resolveSymbol(r.handlerSymbol);
      const hl = ref?.label ?? symbolLabel(r.handlerSymbol);
      addNode(r.handlerSymbol, { label: `${hl}\n${basename(ref?.file.id ?? '')}`, type: 'card', color: '#10b981', ...cardSize(hl, basename(ref?.file.id ?? '')) });
      els.push({ group: 'edges', data: { id: `${prev}>${r.handlerSymbol}:${r.id}`, source: prev, target: r.handlerSymbol, width: 1.6 } });
      for (const e of model.symOut.get(r.handlerSymbol) ?? []) {
        if (e.kind !== 'calls') continue;
        const t = model.resolveSymbol(e.target);
        const tl = t?.label ?? symbolLabel(e.target);
        addNode(e.target, { label: `${tl}\n${basename(t?.file.id ?? '')}`, type: 'card', color: '#64748b', ...cardSize(tl, basename(t?.file.id ?? '')) });
        const id = `${r.handlerSymbol}>${e.target}`;
        if (!seen.has(id)) {
          seen.add(id);
          els.push({ group: 'edges', data: { id, source: r.handlerSymbol, target: e.target, width: 1 } });
        }
      }
    }
  }
  return els;
}

const FLOW_LAYOUT = { name: 'dagre', rankDir: 'LR', nodeSep: 10, rankSep: 70, edgeSep: 6, animate: false } as LayoutOptions;

export function RoutesView() {
  const model = useModel();
  const selection = useStore((s) => s.selection);
  const routes = model.data.routes;
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [method, setMethod] = useState('all');
  const [prefix, setPrefix] = useState('');
  const [mode, setMode] = useState<'table' | 'flow' | 'calls'>('table');
  const trie = useMemo(() => buildTrie(routes), [routes]);
  const types = [...new Set(routes.map((r) => r.type))];
  const methods = [...new Set(routes.map((r) => r.method))].sort();
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return routes.filter(
      (r) =>
        (type === 'all' || r.type === type) &&
        (method === 'all' || r.method === method) &&
        (!prefix || r.path === prefix || r.path.startsWith(`${prefix}/`)) &&
        (!q || `${r.method} ${r.path} ${r.handler ?? ''} ${r.file}`.toLowerCase().includes(q)),
    );
  }, [routes, search, type, method, prefix]);
  const elements = useMemo(() => (mode === 'flow' ? flowElements(model, filtered) : []), [mode, model, filtered]);

  if (!routes.length) {
    return (
      <Empty icon={RouteIcon} title="No routes detected">
        Routes are detected for Express, Fastify, Koa, Hono, NestJS, Next.js, Nuxt, SvelteKit, Remix, Astro, React Router, Vue Router and Angular.
      </Empty>
    );
  }
  const frameworks = [...new Set(routes.map((r) => r.framework))];
  return (
    <div className="split" style={{ flex: 1, minHeight: 0 }}>
      <div className="split-side">
        <div className="side-head">
          <strong className="small">URL map</strong>
          <span className="tiny muted">
            {plural(routes.length, 'route')} · {frameworks.join(', ')}
          </span>
        </div>
        <div className="side-body">
          <TrieNode node={trie} depth={0} prefix={prefix} onPrefix={setPrefix} />
        </div>
      </div>
      <div className="split-main">
        <div className="toolbar">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'table', label: 'Table', icon: Table2 },
              { value: 'flow', label: 'Flow', icon: GitFork },
              ...(model.data.apiCalls.length ? [{ value: 'calls' as const, label: `Client calls (${model.data.apiCalls.length})`, icon: ArrowLeftRight }] : []),
            ]}
          />
          <SearchInput value={search} onChange={setSearch} placeholder="Filter routes…" style={{ width: 220 }} />
          <Select value={type} onChange={setType} options={[{ value: 'all', label: 'All types' }, ...types.map((t) => ({ value: t, label: t }))]} />
          <Select value={method} onChange={setMethod} options={[{ value: 'all', label: 'All methods' }, ...methods.map((m) => ({ value: m, label: m }))]} />
          {prefix && (
            <button className="btn sm" onClick={() => setPrefix('')}>
              {prefix} ✕
            </button>
          )}
          <span className="spacer" />
          <span className="small muted">{plural(filtered.length, 'route')}</span>
        </div>
        {mode === 'calls' ? (
          <div className="table-wrap" style={{ flex: 1 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Request</th>
                  <th>Served by</th>
                  <th>From</th>
                  <th>Client</th>
                </tr>
              </thead>
              <tbody>
                {model.data.apiCalls
                  .filter((c) => !search.trim() || `${c.method} ${c.url} ${c.file}`.toLowerCase().includes(search.trim().toLowerCase()))
                  .map((c) => {
                    const r = c.route ? model.routeById.get(c.route) : undefined;
                    return (
                      <tr key={c.id} onClick={() => (r ? select({ type: 'route', id: r.id }) : selectFile(c.file, c.line))}>
                        <td>
                          <MethodBadge method={c.method} />
                        </td>
                        <td className="mono small">{c.url}</td>
                        <td className="small">
                          {r ? (
                            <span className="mono">
                              {r.method} {r.path} <span className="faint">· {r.file}</span>
                            </span>
                          ) : c.external ? (
                            <span className="badge">external · {c.external}</span>
                          ) : (
                            <span className="badge warn">no matching route</span>
                          )}
                        </td>
                        <td className="mono tiny muted">
                          <a
                            onClick={(e) => {
                              e.stopPropagation();
                              if (c.symbol) selectSymbol(c.symbol);
                              else selectFile(c.file, c.line);
                            }}
                          >
                            {c.symbol ? `${symbolLabel(c.symbol)} · ` : ''}
                            {c.file}:{c.line}
                          </a>
                        </td>
                        <td className="tiny muted">{c.client}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : mode === 'table' ? (
          <div className="table-wrap" style={{ flex: 1 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Handler</th>
                  <th>Middleware</th>
                  <th title="Code in this project that calls the route (fetch, axios, supertest…)">Called from</th>
                  <th>File</th>
                  <th>Framework</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className={selection?.type === 'route' && selection.id === r.id ? 'active' : undefined} onClick={() => select({ type: 'route', id: r.id })}>
                    <td>
                      <MethodBadge method={r.method} />
                    </td>
                    <td className="mono small" style={{ fontWeight: 600 }}>
                      {r.path.split('/').map((seg, i) => (
                        <span key={i}>
                          {i > 0 && '/'}
                          <span style={{ color: seg.startsWith(':') || seg.startsWith('[') || seg.startsWith('*') ? 'var(--accent)' : undefined }}>{seg}</span>
                        </span>
                      ))}
                    </td>
                    <td className="mono small">
                      {r.handlerSymbol ? (
                        <a
                          onClick={(e) => {
                            e.stopPropagation();
                            selectSymbol(r.handlerSymbol!);
                          }}
                        >
                          {r.handler ?? symbolLabel(r.handlerSymbol)}
                        </a>
                      ) : (
                        <span className="muted">{r.handler ?? '—'}</span>
                      )}
                    </td>
                    <td className="small muted">{r.middlewares?.join(', ') ?? ''}</td>
                    <td className="small">
                      {(model.apiByRoute.get(r.id)?.length ?? 0) > 0 ? (
                        <span className="badge info" title={model.apiByRoute.get(r.id)!.map((c) => `${c.file}:${c.line}`).join('\n')}>
                          {model.apiByRoute.get(r.id)!.length} call{model.apiByRoute.get(r.id)!.length === 1 ? '' : 's'}
                        </span>
                      ) : r.type === 'api' && model.data.apiCalls.length ? (
                        <span className="faint tiny">—</span>
                      ) : null}
                    </td>
                    <td className="mono tiny muted">
                      {r.file}
                      {r.line ? `:${r.line}` : ''}
                    </td>
                    <td>
                      <span className="badge">{r.framework}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <CyCanvas
            elements={elements}
            layout={FLOW_LAYOUT}
            exportName="routes-flow"
            onTap={(id) => {
              if (id.startsWith('route:')) select({ type: 'route', id: id.slice(6) });
              else if (!id.startsWith('mw:')) selectSymbol(id);
            }}
          >
            <div className="floating legend">
              <span className="tiny muted">Request → middleware → handler → functions it calls{filtered.length > 150 ? ' (first 150 routes)' : ''}</span>
            </div>
          </CyCanvas>
        )}
      </div>
    </div>
  );
}
