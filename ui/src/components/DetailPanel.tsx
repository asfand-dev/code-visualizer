import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Crosshair,
  ExternalLink,
  FileCode2,
  Folder,
  GitCommitHorizontal,
  Network,
  Package,
  Radar,
  Route as RouteIcon,
  Workflow,
  X,
} from 'lucide-react';
import { useModel } from '../data/context';
import { fileOfSymbolId, symbolLabel, transitive, type Model } from '../data/model';
import { KIND_META, METHOD_COLORS, SYMBOL_META } from '../lib/colors';
import { EDITORS, editorUrl } from '../lib/editor';
import { basename, fmtNum, pct, plural, timeAgo } from '../lib/format';
import { select, selectFile, selectSymbol, setState, showFlow, showInGraph, useStore, type EditorId } from '../state/store';
import type { FileInfo, MemberInfo, ParamInfo, SymbolEdge, SymbolInfo } from '../types';
import { CodeView, sliceLines } from './CodeView';
import { KIND_ICONS, SYMBOL_ICONS } from './icons';
import { BarList, CopyButton, Empty, FileChip, KindBadge, KindDot, SymbolIcon, Tabs } from './ui';

export function DetailPanel() {
  const selection = useStore((s) => s.selection);
  if (!selection) return null;
  let content: ReactNode;
  switch (selection.type) {
    case 'file':
      content = <FilePanel key={selection.id} id={selection.id} line={selection.line} />;
      break;
    case 'symbol':
      content = <SymbolPanel key={selection.id} id={selection.id} />;
      break;
    case 'folder':
      content = <FolderPanel key={selection.id} path={selection.id} />;
      break;
    case 'package':
      content = <PackagePanel key={selection.id} name={selection.id} />;
      break;
    case 'route':
      content = <RoutePanel key={selection.id} id={selection.id} />;
      break;
  }
  return (
    <aside className="panel" aria-label="Details">
      {content}
    </aside>
  );
}

function CloseButton() {
  return (
    <button className="btn ghost icon sm" onClick={() => select(null)} aria-label="Close details" title="Close (Esc)" style={{ marginLeft: 'auto', flexShrink: 0 }}>
      <X size={15} />
    </button>
  );
}

function Header({ icon, color, title, sub, badges, actions }: { icon: ReactNode; color: string; title: ReactNode; sub?: ReactNode; badges?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="panel-head">
      <div className="panel-title">
        <div className="icon-box" style={{ ['--c' as string]: color }}>
          {icon}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2>{title}</h2>
          {sub && <div className="path">{sub}</div>}
        </div>
        <CloseButton />
      </div>
      {badges && <div className="tags">{badges}</div>}
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

function Section({ title, count, children, right }: { title: string; count?: number; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="panel-section">
      <h4>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
        {right && <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{right}</span>}
      </h4>
      {children}
    </div>
  );
}

function Metric({ value, label, title }: { value: ReactNode; label: string; title?: string }) {
  return (
    <div className="metric" title={title}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function EditorButton({ file, line }: { file: string; line?: number }) {
  const model = useModel();
  const editor = useStore((s) => s.editor);
  const url = editorUrl(editor, model.data.project.rootPath, file, line);
  const label = EDITORS.find((e) => e.id === editor)?.label ?? 'editor';
  return (
    <span className="row nowrap" style={{ gap: 4 }}>
      {url && (
        <a className="btn sm" href={url} title={`Open in ${label}`}>
          <ExternalLink size={13} /> {label}
        </a>
      )}
      <select className="select" style={{ height: 26, fontSize: 12, padding: '0 22px 0 6px', width: 26, backgroundPosition: 'right 6px center' }} value={editor} onChange={(e) => setState({ editor: e.target.value as EditorId })} title="Choose editor">
        {EDITORS.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/* ---------------------------------------------------------------------------- */
/*                                     File                                     */
/* ---------------------------------------------------------------------------- */

type FileTab = 'outline' | 'imports' | 'usedby' | 'exports' | 'code' | 'todos';

function FilePanel({ id, line }: { id: string; line?: number }) {
  const model = useModel();
  const detailTab = useStore((s) => s.detailTab);
  const file = model.fileById.get(id);
  const [tab, setTab] = useState<FileTab>((detailTab as FileTab) || (line ? 'code' : 'outline'));
  const impact = useMemo(() => {
    if (!file) return undefined;
    const dependents = transitive(model, file.id, 'dependents');
    const deps = transitive(model, file.id, 'deps');
    return { dependents: dependents.size, deps: deps.size };
  }, [model, file]);
  if (!file) {
    return (
      <>
        <Header icon={<FileCode2 size={17} />} color="#64748b" title={basename(id)} sub={id} />
        <Empty icon={FileCode2} title="Not part of this report">
          This file is outside the analyzed scope.
        </Empty>
      </>
    );
  }
  const meta = KIND_META[file.kind];
  const Icon = KIND_ICONS[file.kind];
  const imports = model.out.get(file.id) ?? [];
  const usedBy = model.in.get(file.id) ?? [];
  const packages = model.data.packages.filter((p) => p.importedBy.includes(file.id));
  const routes = model.routesByFile.get(file.id) ?? [];
  const cycles = model.cyclesByFile.get(file.id) ?? [];
  const tabs: { value: FileTab; label: string; count?: number }[] = [
    { value: 'outline', label: 'Outline', count: file.symbols.length },
    { value: 'imports', label: 'Imports', count: imports.length + packages.length },
    { value: 'usedby', label: 'Used by', count: usedBy.length },
    { value: 'exports', label: 'Exports', count: file.exports.length },
  ];
  if (file.source !== undefined) tabs.push({ value: 'code', label: 'Code' });
  if (file.todos.length) tabs.push({ value: 'todos', label: 'TODOs', count: file.todos.length });

  return (
    <>
      <Header
        icon={<Icon size={17} />}
        color={meta.color}
        title={file.name}
        sub={
          <span className="row nowrap" style={{ gap: 4 }}>
            <span className="truncate">{file.id}</span>
            <CopyButton text={file.id} />
          </span>
        }
        badges={
          <>
            <KindBadge kind={file.kind} />
            {file.isEntry && <span className="badge accent">Entry · {file.entryReason}</span>}
            {file.scope && file.scope !== 'member' && <span className="badge info">{file.scope}</span>}
            {file.inCycle && <span className="badge danger">In a dependency cycle</span>}
            {file.orphan && <span className="badge warn">Not imported anywhere</span>}
            {file.isGenerated && <span className="badge">Generated</span>}
            {file.directives?.map((d) => (
              <span key={d} className="badge outline">
                '{d}'
              </span>
            ))}
          </>
        }
        actions={
          <>
            <button className="btn sm" onClick={() => showInGraph([file.id], 'focus')} title="Show this file and its neighbours in the dependency graph">
              <Crosshair size={13} /> Focus
            </button>
            <button className="btn sm" onClick={() => showInGraph([file.id], 'impact')} title="Highlight everything affected by a change in this file">
              <Radar size={13} /> Impact
            </button>
            <EditorButton file={file.id} line={line} />
          </>
        }
      />
      <div className="panel-body">
        {file.description && (
          <div className="panel-section">
            <div className="prose small">{file.description}</div>
          </div>
        )}
        <div className="panel-section">
          <div className="metrics">
            <Metric value={fmtNum(file.loc)} label="Lines" title={`${fmtNum(file.sloc)} lines of code (excluding blanks/comments)`} />
            <Metric value={fmtNum(file.complexity)} label="Complexity" title="Cyclomatic complexity of the whole file" />
            <Metric value={fmtNum(file.symbols.length)} label="Symbols" />
            <Metric value={fmtNum(file.metrics.fanOut)} label="Imports" />
            <Metric value={fmtNum(file.metrics.fanIn)} label="Used by" />
            <Metric value={pct(file.metrics.importance, 1)} label="Importance" title="PageRank-style centrality (100% = the most depended-upon file)" />
          </div>
          {impact && (
            <div className="row small muted" style={{ marginTop: 12, gap: 14 }}>
              <span className="row nowrap" style={{ gap: 4 }} title="Files that import this file directly or indirectly">
                <ArrowUpRight size={14} /> {plural(impact.dependents, 'file')} affected by changes
              </span>
              <span className="row nowrap" style={{ gap: 4 }} title="Files this file needs directly or indirectly">
                <ArrowDownRight size={14} /> depends on {plural(impact.deps, 'file')}
              </span>
            </div>
          )}
        </div>
        {file.git && (
          <Section title="History">
            <dl className="kv">
              <dt>Commits</dt>
              <dd>{fmtNum(file.git.commits)}</dd>
              <dt>Last changed</dt>
              <dd>{timeAgo(file.git.lastModified)}</dd>
              <dt>Created</dt>
              <dd>{timeAgo(file.git.firstSeen)}</dd>
              <dt>Main authors</dt>
              <dd>
                {file.git.authors.slice(0, 3).map((a) => (
                  <div key={a.name} className="row nowrap" style={{ gap: 6 }}>
                    <GitCommitHorizontal size={12} className="faint" />
                    <span className="truncate">{a.name}</span>
                    <span className="faint tiny">{a.commits}</span>
                  </div>
                ))}
              </dd>
            </dl>
          </Section>
        )}
        {cycles.length > 0 && (
          <Section title="Circular dependency">
            {cycles.map((i) => (
              <CycleChain key={i} cycle={model.data.insights.cycles[i]} highlight={file.id} />
            ))}
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => showInGraph(model.data.insights.cycles[cycles[0]], 'cycle')}>
              <Network size={13} /> Show cycle in graph
            </button>
          </Section>
        )}
        <Tabs value={tab} tabs={tabs} onChange={setTab} />
        {tab === 'outline' && <Outline model={model} file={file} routes={routes} />}
        {tab === 'imports' && (
          <div className="panel-section">
            {!imports.length && !packages.length && !file.assets.length && <div className="muted small">This file imports nothing.</div>}
            <EdgeList edges={imports.map((e) => ({ file: e.target, names: e.names, typeOnly: e.typeOnly, kind: e.kind, line: e.line, inCycle: e.inCycle }))} />
            {packages.length > 0 && (
              <>
                <h4 style={{ marginTop: 14 }}>Packages</h4>
                <div className="tags">
                  {packages.map((p) => (
                    <button key={p.name} className="tag link" onClick={() => select({ type: 'package', id: p.name })}>
                      {p.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            {file.assets.length > 0 && (
              <>
                <h4 style={{ marginTop: 14 }}>Assets</h4>
                <div className="tags">
                  {file.assets.map((a) => (
                    <span key={a.specifier + a.line} className="tag" title={a.specifier}>
                      {a.specifier}
                    </span>
                  ))}
                </div>
              </>
            )}
            {file.unresolved.length > 0 && (
              <>
                <h4 style={{ marginTop: 14 }}>Unresolved</h4>
                <div className="tags">
                  {file.unresolved.map((u) => (
                    <span key={u.specifier + u.line} className="tag" style={{ color: 'var(--warning)' }}>
                      {u.specifier}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {tab === 'usedby' && (
          <div className="panel-section">
            {!usedBy.length && <div className="muted small">No file in this report imports this file{file.isEntry ? ' — it is an entry point.' : '.'}</div>}
            <EdgeList edges={usedBy.map((e) => ({ file: e.source, names: e.names, typeOnly: e.typeOnly, kind: e.kind, line: e.line, inCycle: e.inCycle }))} />
          </div>
        )}
        {tab === 'exports' && (
          <div className="panel-section">
            {!file.exports.length && <div className="muted small">No exports.</div>}
            {file.exports.map((e) => (
              <div key={`${e.name}:${e.from ?? ''}`} className="sym-row" onClick={() => selectFile(file.id, e.line)}>
                <span className="name">{e.name === '*' ? `* from '${e.from}'` : e.name}</span>
                {e.isDefault && <span className="badge">default</span>}
                {e.typeOnly && <span className="badge">type</span>}
                {e.from && e.name !== '*' && <span className="faint tiny truncate">from {e.from}</span>}
                {e.unused && (
                  <span className="badge warn" title="No file in the project imports this export">
                    unused
                  </span>
                )}
                <span className="line">:{e.line}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'code' && file.source !== undefined && (
          <div style={{ borderTop: 0 }}>
            <CodeView source={file.source} from={line} maxHeight="calc(100vh - 220px)" />
          </div>
        )}
        {tab === 'todos' && (
          <div className="panel-section">
            {file.todos.map((t) => (
              <div key={t.line + t.text} className="sym-row" onClick={() => (setTab('code'), selectFile(file.id, t.line))}>
                <span className={`badge ${t.tag === 'FIXME' || t.tag === 'BUG' ? 'danger' : t.tag === 'HACK' || t.tag === 'XXX' ? 'warn' : 'info'}`}>{t.tag}</span>
                <span className="small truncate" style={{ flex: 1 }}>
                  {t.text}
                </span>
                <span className="line">:{t.line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function CycleChain({ cycle, highlight }: { cycle: string[]; highlight?: string }) {
  const shown = cycle.slice(0, 8);
  return (
    <div className="row small" style={{ gap: 4, marginBottom: 6 }}>
      {shown.map((id, i) => (
        <span key={id} className="row nowrap" style={{ gap: 4 }}>
          <button className="chip" style={id === highlight ? { borderColor: 'var(--danger)' } : undefined} onClick={() => selectFile(id)} title={id}>
            <span className="mono">{basename(id)}</span>
          </button>
          {i < shown.length - 1 && <span className="faint">→</span>}
        </span>
      ))}
      {cycle.length <= 8 ? <span className="faint">→ ↺</span> : <span className="faint">… +{cycle.length - 8} files</span>}
    </div>
  );
}

function EdgeList({ edges }: { edges: { file: string; names: string[]; typeOnly: boolean; kind: string; line: number; inCycle?: boolean }[] }) {
  const model = useModel();
  return (
    <div className="list">
      {edges.map((e) => {
        const f = model.fileById.get(e.file);
        const names = e.names.filter((n) => n !== '*').slice(0, 6);
        return (
          <button key={e.file} className="list-item" onClick={() => selectFile(e.file)} title={e.file}>
            {f && <KindDot kind={f.kind} />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="title truncate mono" style={{ fontSize: 12 }}>
                {e.file}
              </div>
              {(names.length > 0 || e.kind !== 'import') && (
                <div className="tiny faint truncate">
                  {e.kind !== 'import' && <span>{e.kind} · </span>}
                  {names.join(', ')}
                  {e.names.length > 6 ? ` +${e.names.length - 6}` : ''}
                </div>
              )}
            </div>
            {e.typeOnly && <span className="badge">type</span>}
            {e.inCycle && <span className="badge danger">cycle</span>}
            {f?.scope === 'context' && <span className="badge outline">outside scope</span>}
          </button>
        );
      })}
    </div>
  );
}

const OUTLINE_ORDER: SymbolInfo['kind'][] = ['component', 'hook', 'class', 'function', 'interface', 'type', 'enum', 'namespace', 'constant', 'variable'];

function Outline({ model, file, routes }: { model: Model; file: FileInfo; routes: { id: string; method: string; path: string; line?: number }[] }) {
  const groups = OUTLINE_ORDER.map((kind) => ({ kind, symbols: file.symbols.filter((s) => s.kind === kind) })).filter((g) => g.symbols.length);
  return (
    <div className="panel-section">
      {!file.symbols.length && <div className="muted small">No top-level declarations.</div>}
      {routes.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h4>Routes</h4>
          {routes.map((r) => (
            <div key={r.id} className="sym-row" onClick={() => select({ type: 'route', id: r.id })}>
              <span className="method" style={{ ['--m' as string]: METHOD_COLORS[r.method] }}>
                {r.method}
              </span>
              <span className="name">{r.path}</span>
              {r.line && <span className="line">:{r.line}</span>}
            </div>
          ))}
        </div>
      )}
      {groups.map((g) => (
        <div key={g.kind} style={{ marginBottom: 10 }}>
          <h4>
            {g.kind === 'class' ? 'Classes' : `${SYMBOL_META[g.kind].label}s`} <span className="count">{g.symbols.length}</span>
          </h4>
          {g.symbols.map((s) => {
            const usage = (model.symIn.get(s.id) ?? []).reduce((n, e) => n + (e.kind === 'calls' || e.kind === 'renders' ? 1 : 0), 0);
            return (
              <div key={s.id} className="sym-row" onClick={() => selectSymbol(s.id)}>
                <SymbolIcon kind={s.kind} />
                <span className="name">{s.name}</span>
                {s.exported && <span className="badge" title="Exported">{s.isDefault ? 'default' : 'export'}</span>}
                {(s.complexity ?? 0) >= 15 && (
                  <span className="badge warn" title="Cyclomatic complexity">
                    cx {s.complexity}
                  </span>
                )}
                {usage > 0 && (
                  <span className="faint tiny" title="Used by other symbols">
                    ↑{usage}
                  </span>
                )}
                <span className="line">:{s.line}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------- */
/*                                    Symbol                                    */
/* ---------------------------------------------------------------------------- */

function signature(name: string, params?: ParamInfo[], returnType?: string, asyncFn?: boolean): string {
  const ps = (params ?? []).map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional && !p.defaultValue ? '?' : ''}${p.type ? `: ${p.type}` : ''}${p.defaultValue ? ` = ${p.defaultValue}` : ''}`);
  return `${asyncFn ? 'async ' : ''}${name}(${ps.join(', ')})${returnType ? `: ${returnType}` : ''}`;
}

function memberText(m: MemberInfo): string {
  const vis = m.visibility === 'private' ? '−' : m.visibility === 'protected' ? '#' : '+';
  if (m.kind === 'enumMember') return `${m.name}${m.value ? ` = ${m.value}` : ''}`;
  if (m.kind === 'method' || m.kind === 'constructor' || m.kind === 'call') return `${vis} ${signature(m.name, m.params, m.type, m.async)}`;
  return `${vis} ${m.readonly ? 'readonly ' : ''}${m.name}${m.optional ? '?' : ''}${m.type ? `: ${m.type.replace(/^= /, '= ')}` : ''}`;
}

function SymbolLinks({ edges, side, empty }: { edges: SymbolEdge[]; side: 'source' | 'target'; empty?: string }) {
  const model = useModel();
  if (!edges.length) return empty ? <div className="muted small">{empty}</div> : null;
  // Merge edges that point at the same symbol (e.g. one caller calling several methods).
  const merged = new Map<string, SymbolEdge>();
  for (const e of edges) {
    const key = `${e[side]}:${e.kind}`;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, count: prev.count + e.count } : e);
  }
  return (
    <div className="list">
      {[...merged.values()].map((e) => {
        const id = e[side];
        const ref = model.resolveSymbol(id);
        const kind = ref?.member ? 'function' : (ref?.symbol.kind ?? 'function');
        return (
          <div key={id + e.kind} className="sym-row" onClick={() => selectSymbol(id)} title={id}>
            <SymbolIcon kind={kind} method={!!ref?.member} />
            <span className="name">{symbolLabel(id)}</span>
            <span className="faint tiny truncate">{basename(fileOfSymbolId(id))}</span>
            {e.count > 1 && <span className="line">×{e.count}</span>}
          </div>
        );
      })}
    </div>
  );
}

function SymbolPanel({ id }: { id: string }) {
  const model = useModel();
  const ref = model.resolveSymbol(id);
  if (!ref) {
    return (
      <>
        <Header icon={<FileCode2 size={17} />} color="#64748b" title={symbolLabel(id)} sub={fileOfSymbolId(id)} />
        <Empty icon={FileCode2} title="Symbol not found" />
      </>
    );
  }
  const { symbol, file, member } = ref;
  const kindMeta = SYMBOL_META[member ? 'method' : symbol.kind];
  const Icon = SYMBOL_ICONS[symbol.kind];
  const out = model.symOut.get(id) ?? [];
  const inn = model.symIn.get(id) ?? [];
  const by = (list: SymbolEdge[], kind: SymbolEdge['kind']): SymbolEdge[] => list.filter((e) => e.kind === kind).sort((a, b) => b.count - a.count);
  const line = member?.line ?? symbol.line;
  const endLine = member ? Math.min(member.line + 40, symbol.endLine) : symbol.endLine;
  const snippet = file.source !== undefined ? sliceLines(file.source, line, Math.min(endLine, line + 250)) : undefined;
  const callable = member ? member.kind === 'method' || member.kind === 'constructor' : ['function', 'component', 'hook'].includes(symbol.kind);
  const comp = !member ? symbol.component : undefined;
  const memberEdges = !member && symbol.kind === 'class' ? (symbol.members ?? []).flatMap((m) => model.symOut.get(`${symbol.id}.${m.name}`) ?? []) : [];
  // Calls into a class arrive at its methods (`Class.method`); show them on the class too.
  const memberCallers = !member && symbol.kind === 'class' ? (symbol.members ?? []).flatMap((m) => model.symIn.get(`${symbol.id}.${m.name}`) ?? []).filter((e) => fileOfSymbolId(e.source) !== file.id || !e.source.startsWith(`${symbol.id}.`)) : [];
  const callers = [...by(inn, 'calls'), ...memberCallers.filter((e) => e.kind === 'calls')];

  return (
    <>
      <Header
        icon={<Icon size={17} />}
        color={kindMeta.color}
        title={ref.label}
        sub={
          <button className="chip" style={{ marginTop: 4 }} onClick={() => selectFile(file.id, line)}>
            <KindDot kind={file.kind} />
            <span className="mono">
              {file.id}:{line}
            </span>
          </button>
        }
        badges={
          <>
            <span className="badge" style={{ background: `color-mix(in srgb, ${kindMeta.color} 16%, transparent)`, color: kindMeta.color }}>
              {kindMeta.label}
            </span>
            {!member && symbol.exported && <span className="badge accent">{symbol.isDefault ? 'default export' : 'exported'}</span>}
            {(member?.async ?? symbol.async) && <span className="badge">async</span>}
            {symbol.abstract && !member && <span className="badge">abstract</span>}
            {member?.static && <span className="badge">static</span>}
            {member?.visibility && <span className="badge">{member.visibility}</span>}
            {!member && symbol.tags?.map((t) => <span key={t} className="badge info">{t}</span>)}
            {(member?.decorators ?? (!member ? symbol.decorators : undefined))?.map((d) => (
              <span key={d} className="badge outline">
                @{d}
              </span>
            ))}
          </>
        }
        actions={
          <>
            {callable && model.hasCalls && (
              <button className="btn sm" onClick={() => showFlow(id)}>
                <Workflow size={13} /> Call flow
              </button>
            )}
            <button className="btn sm" onClick={() => selectFile(file.id, line)}>
              <FileCode2 size={13} /> Open file
            </button>
            <EditorButton file={file.id} line={line} />
          </>
        }
      />
      <div className="panel-body">
        {(symbol.doc && !member) && (
          <div className="panel-section">
            <div className="prose small">{symbol.doc}</div>
          </div>
        )}
        {(callable || symbol.typeText) && (
          <div className="panel-section">
            <code className="mono small" style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-2)' }}>
              {member ? memberText(member) : callable ? signature(symbol.name, symbol.params, symbol.returnType, symbol.async) : `${symbol.kind === 'type' ? 'type' : symbol.kind} ${symbol.name}${symbol.kind === 'type' ? ' = ' : ': '}${symbol.typeText}`}
            </code>
          </div>
        )}
        <div className="panel-section">
          <div className="metrics">
            <Metric value={member ? '–' : fmtNum(symbol.loc)} label="Lines" />
            <Metric value={member ? '–' : (symbol.complexity ?? '–')} label="Complexity" />
            <Metric value={fmtNum(new Set([...inn, ...memberCallers].map((e) => e.source)).size)} label="Used by" />
          </div>
        </div>
        {comp && (
          <Section title="Component">
            <dl className="kv">
              <dt>Framework</dt>
              <dd style={{ textTransform: 'capitalize' }}>{comp.framework}</dd>
              {comp.state ? (
                <>
                  <dt>State hooks</dt>
                  <dd>{comp.state}</dd>
                </>
              ) : null}
            </dl>
            {comp.props.length > 0 && (
              <>
                <h4 style={{ marginTop: 12 }}>Props</h4>
                <div className="tags">
                  {comp.props.map((p) => (
                    <span key={p} className="tag">
                      {p}
                    </span>
                  ))}
                </div>
              </>
            )}
            {comp.emits && comp.emits.length > 0 && (
              <>
                <h4 style={{ marginTop: 12 }}>Emits</h4>
                <div className="tags">
                  {comp.emits.map((p) => (
                    <span key={p} className="tag">
                      {p}
                    </span>
                  ))}
                </div>
              </>
            )}
            {comp.hooks.length > 0 && (
              <>
                <h4 style={{ marginTop: 12 }}>Hooks</h4>
                <div className="tags">
                  {comp.hooks.map((h) => {
                    const target = out.find((e) => e.kind === 'calls' && symbolLabel(e.target) === h);
                    return target ? (
                      <button key={h} className="tag link" onClick={() => selectSymbol(target.target)}>
                        {h}
                      </button>
                    ) : (
                      <span key={h} className="tag">
                        {h}
                      </span>
                    );
                  })}
                </div>
              </>
            )}
          </Section>
        )}
        {(by(out, 'renders').length > 0 || by(inn, 'renders').length > 0) && (
          <Section title="Renders" count={by(out, 'renders').length}>
            <SymbolLinks edges={by(out, 'renders')} side="target" empty="Renders no project components." />
            <h4 style={{ marginTop: 12 }}>
              Rendered by <span className="count">{by(inn, 'renders').length}</span>
            </h4>
            <SymbolLinks edges={by(inn, 'renders')} side="source" empty="Not rendered by any project component (a root or a page)." />
          </Section>
        )}
        {!member && symbol.members && symbol.members.length > 0 && (
          <Section title={symbol.kind === 'enum' ? 'Members' : 'Members'} count={symbol.members.length}>
            {symbol.members.map((m) => {
              const methodId = `${symbol.id}.${m.name}`;
              const isMethod = m.kind === 'method' || m.kind === 'constructor';
              return (
                <div
                  key={`${m.name}:${m.line}`}
                  className="sym-row"
                  onClick={() => (isMethod && symbol.kind === 'class' ? selectSymbol(methodId) : selectFile(file.id, m.line))}
                >
                  <span className="name" style={{ whiteSpace: 'normal' }}>
                    {memberText(m)}
                  </span>
                  {m.static && <span className="badge">static</span>}
                  {m.decorators?.map((d) => (
                    <span key={d} className="badge outline">
                      @{d}
                    </span>
                  ))}
                  <span className="line">:{m.line}</span>
                </div>
              );
            })}
          </Section>
        )}
        {(by(out, 'extends').length + by(out, 'implements').length + by(inn, 'extends').length + by(inn, 'implements').length > 0) && (
          <Section title="Inheritance">
            {by(out, 'extends').length > 0 && (
              <>
                <div className="tiny faint" style={{ marginBottom: 4 }}>
                  Extends
                </div>
                <SymbolLinks edges={by(out, 'extends')} side="target" />
              </>
            )}
            {by(out, 'implements').length > 0 && (
              <>
                <div className="tiny faint" style={{ margin: '8px 0 4px' }}>
                  Implements
                </div>
                <SymbolLinks edges={by(out, 'implements')} side="target" />
              </>
            )}
            {by(inn, 'extends').length > 0 && (
              <>
                <div className="tiny faint" style={{ margin: '8px 0 4px' }}>
                  Extended by
                </div>
                <SymbolLinks edges={by(inn, 'extends')} side="source" />
              </>
            )}
            {by(inn, 'implements').length > 0 && (
              <>
                <div className="tiny faint" style={{ margin: '8px 0 4px' }}>
                  Implemented by
                </div>
                <SymbolLinks edges={by(inn, 'implements')} side="source" />
              </>
            )}
          </Section>
        )}
        {(by(out, 'calls').length > 0 || callers.length > 0 || memberEdges.length > 0) && (
          <Section title="Calls" count={by(out, 'calls').length + memberEdges.filter((e) => e.kind === 'calls').length}>
            <SymbolLinks edges={[...by(out, 'calls'), ...memberEdges.filter((e) => e.kind === 'calls')]} side="target" empty="Calls no project functions." />
            <h4 style={{ marginTop: 12 }}>
              Called by <span className="count">{callers.length}</span>
            </h4>
            <SymbolLinks edges={callers} side="source" empty="Not called from analyzed code." />
          </Section>
        )}
        {(by(out, 'uses').length > 0 || by(inn, 'uses').length > 0 || by(out, 'instantiates').length > 0 || by(inn, 'instantiates').length > 0) && (
          <Section title="Uses">
            <SymbolLinks edges={[...by(out, 'uses'), ...by(out, 'instantiates')]} side="target" />
            {(by(inn, 'uses').length > 0 || by(inn, 'instantiates').length > 0) && (
              <>
                <h4 style={{ marginTop: 12 }}>Used by</h4>
                <SymbolLinks edges={[...by(inn, 'uses'), ...by(inn, 'instantiates')]} side="source" />
              </>
            )}
          </Section>
        )}
        {snippet !== undefined && (
          <Section title="Source">
            <div style={{ margin: '0 -18px -14px', borderTop: '1px solid var(--border)' }}>
              <CodeView source={snippet} startLine={line} maxHeight={420} />
            </div>
          </Section>
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------------- */
/*                                    Folder                                    */
/* ---------------------------------------------------------------------------- */

function FolderPanel({ path }: { path: string }) {
  const model = useModel();
  const folder = model.folderByPath.get(path);
  if (!folder) return <Header icon={<Folder size={17} />} color="#8b6dff" title={path || '/'} />;
  const prefix = path ? `${path}/` : '';
  const files = model.files.filter((f) => f.id.startsWith(prefix));
  const fileSet = new Set(files.map((f) => f.id));
  const kinds = new Map<string, number>();
  files.forEach((f) => kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1));
  const depth = path ? path.split('/').length : 0;
  const outside = (id: string): string => id.split('/').slice(0, Math.max(1, depth)).join('/') || id;
  const dependsOn = new Map<string, number>();
  const usedBy = new Map<string, number>();
  for (const e of model.data.edges) {
    const s = fileSet.has(e.source);
    const t = fileSet.has(e.target);
    if (s && !t) dependsOn.set(outside(e.target), (dependsOn.get(outside(e.target)) ?? 0) + 1);
    if (t && !s) usedBy.set(outside(e.source), (usedBy.get(outside(e.source)) ?? 0) + 1);
  }
  const top = [...files].sort((a, b) => b.metrics.importance - a.metrics.importance).slice(0, 8);
  const toList = (m: Map<string, number>): { key: string; label: ReactNode; value: number }[] =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => ({ key: k, label: <span className="mono">{k}</span>, value: v }));
  return (
    <>
      <Header
        icon={<Folder size={17} />}
        color="#8b6dff"
        title={`${folder.name || model.data.project.rootName}/`}
        sub={path || '(project root)'}
        actions={
          <>
            <button className="btn sm" onClick={() => showInGraph(files.map((f) => f.id), 'files')}>
              <Network size={13} /> Show in graph
            </button>
            <CopyButton text={path} label="Copy path" />
          </>
        }
      />
      <div className="panel-body">
        {folder.summary?.description && (
          <div className="panel-section">
            <div className="prose small">{folder.summary.description}</div>
          </div>
        )}
        <div className="panel-section">
          <div className="metrics">
            <Metric value={fmtNum(folder.fileCount)} label="Files" />
            <Metric value={fmtNum(folder.loc)} label="Lines" />
            <Metric value={fmtNum(folder.folders.length)} label="Subfolders" />
          </div>
        </div>
        <Section title="What's inside">
          <BarList
            items={[...kinds.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => ({ key: k, label: <span className="row nowrap"><KindDot kind={k as FileInfo['kind']} /> {KIND_META[k as FileInfo['kind']].label}</span>, value: v, color: KIND_META[k as FileInfo['kind']].color }))}
          />
        </Section>
        <Section title="Key files">
          <div className="list">
            {top.map((f) => (
              <button key={f.id} className="list-item" onClick={() => selectFile(f.id)}>
                <KindDot kind={f.kind} />
                <span className="mono small truncate">{f.id.slice(prefix.length)}</span>
                <span className="meta">↑{f.metrics.fanIn}</span>
              </button>
            ))}
          </div>
        </Section>
        {dependsOn.size > 0 && (
          <Section title="Depends on">
            <BarList items={toList(dependsOn)} onClick={(k) => (model.folderByPath.has(k) ? select({ type: 'folder', id: k }) : selectFile(k))} />
          </Section>
        )}
        {usedBy.size > 0 && (
          <Section title="Used by">
            <BarList items={toList(usedBy)} onClick={(k) => (model.folderByPath.has(k) ? select({ type: 'folder', id: k }) : selectFile(k))} />
          </Section>
        )}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------------- */
/*                                   Package                                    */
/* ---------------------------------------------------------------------------- */

function PackagePanel({ name }: { name: string }) {
  const model = useModel();
  const pkg = model.packageByName.get(name);
  if (!pkg) return <Header icon={<Package size={17} />} color="#f59e0b" title={name} />;
  return (
    <>
      <Header
        icon={<Package size={17} />}
        color={pkg.builtin ? '#64748b' : '#f59e0b'}
        title={pkg.name}
        sub={pkg.version ? `version ${pkg.version}` : pkg.builtin ? 'Node.js built-in module' : undefined}
        badges={
          <>
            {pkg.declaredAs && <span className="badge">{pkg.declaredAs}</span>}
            {pkg.builtin && <span className="badge">built-in</span>}
            {pkg.typeOnly && pkg.importedBy.length > 0 && <span className="badge">types only</span>}
            {pkg.unused && <span className="badge warn">declared but never imported</span>}
            {pkg.missing && <span className="badge danger">imported but not declared</span>}
          </>
        }
        actions={
          <>
            {pkg.importedBy.length > 0 && (
              <button className="btn sm" onClick={() => showInGraph(pkg.importedBy, 'files')}>
                <Network size={13} /> Show importers
              </button>
            )}
            {!pkg.builtin && (
              <a className="btn sm" href={`https://www.npmjs.com/package/${pkg.name}`} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={13} /> npm
              </a>
            )}
          </>
        }
      />
      <div className="panel-body">
        <div className="panel-section">
          <div className="metrics">
            <Metric value={fmtNum(pkg.importedBy.length)} label="Files" />
            <Metric value={fmtNum(pkg.importCount)} label="Imports" />
            <Metric value={fmtNum(pkg.names.length)} label="Names used" />
          </div>
        </div>
        {pkg.names.length > 0 && (
          <Section title="Imported names">
            <div className="tags">
              {pkg.names.map((n) => (
                <span key={n} className="tag">
                  {n === '*' ? '* (namespace / module)' : n}
                </span>
              ))}
            </div>
          </Section>
        )}
        <Section title="Imported by" count={pkg.importedBy.length}>
          {!pkg.importedBy.length && <div className="muted small">No source file imports this package. It may be used by tooling, configs or scripts — or it can be removed.</div>}
          <div className="list">
            {pkg.importedBy.map((id) => {
              const f = model.fileById.get(id);
              return (
                <button key={id} className="list-item" onClick={() => selectFile(id)}>
                  {f && <KindDot kind={f.kind} />}
                  <span className="mono small truncate">{id}</span>
                </button>
              );
            })}
          </div>
        </Section>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------------------- */
/*                                    Route                                     */
/* ---------------------------------------------------------------------------- */

function RoutePanel({ id }: { id: string }) {
  const model = useModel();
  const route = model.routeById.get(id);
  if (!route) return <Header icon={<RouteIcon size={17} />} color="#ec4899" title="Route not found" />;
  const handler = route.handlerSymbol ? model.resolveSymbol(route.handlerSymbol) : undefined;
  const callees = route.handlerSymbol ? (model.symOut.get(route.handlerSymbol) ?? []).filter((e) => e.kind === 'calls' || e.kind === 'renders') : [];
  const color = METHOD_COLORS[route.method] ?? '#ec4899';
  return (
    <>
      <Header
        icon={<RouteIcon size={17} />}
        color={color}
        title={
          <span className="row nowrap" style={{ gap: 8 }}>
            <span className="method" style={{ ['--m' as string]: color }}>
              {route.method}
            </span>
            <span className="mono truncate" style={{ fontSize: 14 }}>
              {route.path}
            </span>
          </span>
        }
        badges={
          <>
            <span className="badge">{route.framework}</span>
            <span className="badge outline">{route.type}</span>
            {route.params?.map((p) => (
              <span key={p} className="badge info">
                :{p}
              </span>
            ))}
          </>
        }
        actions={
          <>
            <FileChip id={route.file} line={route.line} label={`${basename(route.file)}${route.line ? `:${route.line}` : ''}`} />
            {route.handlerSymbol && model.hasCalls && (
              <button className="btn sm" onClick={() => showFlow(route.handlerSymbol!)}>
                <Workflow size={13} /> Call flow
              </button>
            )}
            <EditorButton file={route.file} line={route.line} />
          </>
        }
      />
      <div className="panel-body">
        <Section title="Request flow">
          <div className="stack" style={{ gap: 8 }}>
            <FlowStep label="Request" detail={`${route.method} ${route.path}`} color={color} />
            {route.middlewares?.map((m) => <FlowStep key={m} label="Middleware" detail={m} color="#eab308" />)}
            <FlowStep
              label={route.type === 'page' || route.type === 'layout' ? 'Component' : route.type === 'mount' ? 'Router' : 'Handler'}
              detail={handler?.label ?? route.handler ?? '(inline)'}
              color="#10b981"
              onClick={route.handlerSymbol ? () => selectSymbol(route.handlerSymbol!) : undefined}
            />
            {callees.length > 0 && (
              <div style={{ paddingLeft: 18, borderLeft: '2px dashed var(--border-strong)', marginLeft: 10 }}>
                <div className="tiny faint" style={{ margin: '2px 0 6px' }}>
                  which {callees.some((c) => c.kind === 'renders') ? 'renders / calls' : 'calls'}
                </div>
                <SymbolLinks edges={callees} side="target" />
              </div>
            )}
          </div>
        </Section>
      </div>
    </>
  );
}

function FlowStep({ label, detail, color, onClick }: { label: string; detail: string; color: string; onClick?: () => void }) {
  return (
    <div className={`card${onClick ? ' interactive' : ''}`} style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }} onClick={onClick}>
      <span className="dot lg" style={{ ['--c' as string]: color }} />
      <span className="tiny faint" style={{ width: 78, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 650 }}>
        {label}
      </span>
      <span className="mono small truncate">{detail}</span>
    </div>
  );
}
