import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  Bot,
  ListPlus,
  Pin,
  PinOff,
  StickyNote,
  GitPullRequestArrow,
  Users,
} from 'lucide-react';
import { fileContextMarkdown } from '../../../src/shared/markdown';
import { fetchBlame, liveConfig, openInEditor, type BlameRange } from '../data/live';
import { copyText } from '../lib/download';
import { addTourStep, selectionKey, setNote, togglePin, usePersonal } from '../state/personal';
import { Avatar, DiffView, PlusMinus, StatusBadge } from './companion';
import { useModel } from '../data/context';
import { fileOfSymbolId, symbolLabel, symbolRef, transitive, usesOf, type Model } from '../data/model';
import { routeTestReach, testEvidence, type UseSite, type UsesResult } from '../../../src/shared/query';
import { KIND_META, METHOD_COLORS, SYMBOL_META } from '../lib/colors';
import { EDITORS, editorUrl } from '../lib/editor';
import { basename, fmtNum, pct, plural, timeAgo } from '../lib/format';
import { select, selectFile, selectSymbol, setState, showFlow, showInGraph, toast, useStore, type EditorId, type Selection } from '../state/store';
import type { FileInfo, MemberInfo, ParamInfo, SymbolEdge, SymbolInfo } from '../types';
import { CodeView, sliceLines } from './CodeView';
import { SimilarCode } from './Clones';
import { familiesOf } from '../../../src/shared/clones';
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
  const live = !!liveConfig();
  const options = EDITORS.filter((e) => live || !e.liveOnly || e.id === editor);
  return (
    <span className="row nowrap" style={{ gap: 4 }}>
      {editor !== 'none' && (url || live) && (
        <a
          className="btn sm"
          href={url ?? '#'}
          title={`Open in ${label}`}
          onClick={async (e) => {
            if (!live) return;
            // The live server can launch the editor directly (no browser prompt).
            e.preventDefault();
            const ok = await openInEditor(file, line, editor);
            if (ok) return;
            if (url) window.location.href = url;
            else toast(`Could not start ${label}. Is its command-line launcher on your PATH?`);
          }}
        >
          <ExternalLink size={13} /> {label}
        </a>
      )}
      <select className="select" style={{ height: 26, fontSize: 12, padding: '0 22px 0 6px', width: 26, backgroundPosition: 'right 6px center' }} value={editor} onChange={(e) => setState({ editor: e.target.value as EditorId })} title="Choose editor">
        {options.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A small "open in editor" icon for one file:line (call sites, imports). */
function EditorLink({ file, line }: { file: string; line?: number }) {
  const model = useModel();
  const editor = useStore((s) => s.editor);
  const url = editorUrl(editor, model.data.project.rootPath, file, line);
  const live = !!liveConfig();
  if (editor === 'none' || (!url && !live)) return null;
  const label = EDITORS.find((e) => e.id === editor)?.label ?? 'editor';
  return (
    <a
      className="btn ghost icon sm"
      href={url ?? '#'}
      title={`Open ${file}:${line ?? 1} in ${label}`}
      aria-label={`Open ${file}:${line ?? 1} in ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        if (!live) return;
        e.preventDefault();
        if (await openInEditor(file, line, editor)) return;
        if (url) window.location.href = url;
        else toast(`Could not start ${label}. Is its command-line launcher on your PATH?`);
      }}
    >
      <ExternalLink size={12} />
    </a>
  );
}

/** `default, { a, b }`, or `* (whole module)` for namespace / CommonJS imports. */
function importedNames(names: string[] | undefined): string {
  const named = (names ?? []).filter((n) => n !== '*' && n !== 'default');
  const parts = [names?.includes('default') ? 'default' : '', named.length ? `{ ${named.join(', ')} }` : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : '* (whole module)';
}

const USE_KIND_LABEL: Record<UseSite['kind'], string> = { import: 'import', reexport: 're-export', call: 'call', render: 'render', new: 'new', http: 'HTTP' };

const REF_KIND_LABEL: Record<string, string> = { uses: 'type', extends: 'extends', implements: 'implements' };

/**
 * Exact places that use a symbol or file (query core), grouped by file, each opening the code or the
 * editor. `cycle`: importing files whose import is part of a dependency cycle.
 */
function UseSiteList({ uses, targetId, empty, cycle }: { uses: UsesResult; targetId?: string; empty: string; cycle?: Set<string> }) {
  const model = useModel();
  const groups = new Map<string, UseSite[]>();
  // Type and inheritance references have no call site: shown at the referencing symbol's line.
  const refSites: UseSite[] = uses.refs.map((r) => ({ file: r.file, line: symbolRef(model.data, r.symbol)?.line ?? 1, kind: 'call', symbol: r.symbol, target: r.target, names: [REF_KIND_LABEL[r.kind] ?? r.kind] }));
  const isRef = new Set(refSites);
  for (const site of [...uses.imports, ...uses.sites, ...uses.http, ...refSites].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    const list = groups.get(site.file);
    if (list) list.push(site);
    else groups.set(site.file, [site]);
  }
  if (!groups.size) return <div className="muted small">{empty}</div>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {[...groups.entries()].map(([file, sites]) => {
        const f = model.fileById.get(file);
        return (
          <div key={file}>
            <button className="list-item" onClick={() => selectFile(file)} title={file}>
              {f && <KindDot kind={f.kind} />}
              <div className="title truncate mono" style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                {file}
              </div>
              {cycle?.has(file) && <span className="badge danger">cycle</span>}
              {f?.scope === 'context' && <span className="badge outline">outside scope</span>}
            </button>
            {sites.map((site, i) => {
              const ref = isRef.has(site);
              const what = ref
                ? `${site.symbol ? symbolLabel(site.symbol) : ''}${site.target && site.target !== targetId ? ` → ${symbolLabel(site.target)}` : ''}`
                : site.kind === 'import' || site.kind === 'reexport'
                  ? `${importedNames(site.names)}${site.via ? ` via ${basename(site.via)}` : ''}`
                  : site.kind === 'http'
                    ? `${site.method ?? ''} ${site.url ?? ''}`
                    : `${site.symbol ? symbolLabel(site.symbol) : 'module code'}${site.target && site.target !== targetId ? ` → ${symbolLabel(site.target)}` : ''}${site.argc !== undefined && site.kind !== 'render' ? (site.argc < 0 ? ' (…spread)' : ` (${plural(site.argc, 'arg')})`) : ''}`;
              return (
                <div key={`${site.kind}:${site.line}:${site.symbol ?? ''}:${site.target ?? ''}:${site.argc ?? ''}:${i}`} className="sym-row" style={{ paddingLeft: 26 }} onClick={() => selectFile(site.file, site.line)} title={`${site.file}:${site.line}`}>
                  <span className={`badge${site.kind === 'http' ? ' info' : site.typeOnly || ref ? '' : ' outline'}`}>{ref ? site.names?.[0] : USE_KIND_LABEL[site.kind]}</span>
                  <span className="name">{what}</span>
                  {site.typeOnly && <span className="badge">type</span>}
                  <span className="line">:{site.line}</span>
                  <EditorLink file={site.file} line={site.line} />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Pin, note and "add to my tour" for anything shown in the panel. */
function PersonalBar({ sel, stepTitle }: { sel: Selection; stepTitle: string }) {
  const key = selectionKey(sel);
  const pinned = usePersonal((s) => s.pins.includes(key));
  const note = usePersonal((s) => s.notes[key]);
  const inTour = usePersonal((s) => s.tour.steps.some((st) => st.key === key));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note?.text ?? '');
  useEffect(() => setText(note?.text ?? ''), [note?.text, key]);
  const showEditor = editing || !!note;
  return (
    <>
      <div className="row" style={{ gap: 6 }}>
        <button className={`btn sm${pinned ? ' active' : ''}`} onClick={() => togglePin(key)} title={pinned ? 'Unpin' : 'Pin to Today'}>
          {pinned ? <PinOff size={13} /> : <Pin size={13} />} {pinned ? 'Pinned' : 'Pin'}
        </button>
        <button className={`btn sm${showEditor ? ' active' : ''}`} onClick={() => setEditing(!editing)} title="Write a note for your future self (or your team)">
          <StickyNote size={13} /> Note
        </button>
        <button
          className={`btn sm${inTour ? ' active' : ''}`}
          onClick={() => {
            addTourStep({ key, title: stepTitle, description: note?.text ?? '' });
            toast(inTour ? 'Tour step updated' : `Added “${stepTitle}” to your tour`);
          }}
          title="Add to your own tour (Guided tour → My tour)"
        >
          <ListPlus size={13} /> {inTour ? 'In tour' : 'Add to tour'}
        </button>
      </div>
      {showEditor && (
        <div>
          <textarea
            className="note-box"
            value={text}
            placeholder="What did you learn here? Why does it work like this? (saved automatically)"
            onChange={(e) => {
              setText(e.target.value);
              setNote(key, e.target.value);
            }}
            autoFocus={editing && !note}
          />
          <div className="tiny faint">{liveConfig() ? 'Saved to .code-visualizer/notes.json in the project' : 'Saved in this browser'}{note ? ` · ${new Date(note.updatedAt).toLocaleString()}` : ''}</div>
        </div>
      )}
    </>
  );
}

function CopyContextButton({ fileId }: { fileId: string }) {
  const model = useModel();
  return (
    <button
      className="btn sm"
      title="Copy Markdown context about this file (summary, API, dependencies, tests, history, source) to paste into ChatGPT / Claude / Copilot"
      onClick={async () => {
        if (await copyText(fileContextMarkdown(model.data, fileId, { source: true }))) toast('Context for AI copied to the clipboard');
      }}
    >
      <Bot size={13} /> Copy for AI
    </button>
  );
}

/* ---------------------------------------------------------------------------- */
/*                                     File                                     */
/* ---------------------------------------------------------------------------- */

type FileTab = 'outline' | 'imports' | 'usedby' | 'exports' | 'code' | 'diff' | 'history' | 'tests' | 'todos' | 'similar';

function FilePanel({ id, line }: { id: string; line?: number }) {
  const model = useModel();
  const detailTab = useStore((s) => s.detailTab);
  const file = model.fileById.get(id);
  const [tab, setTab] = useState<FileTab>((detailTab as FileTab) || (line ? 'code' : 'outline'));
  const impact = useMemo(() => {
    if (!file) return undefined;
    const dependents = transitive(model.data, file.id, 'dependents');
    const deps = transitive(model.data, file.id, 'deps');
    return { dependents: dependents.size, deps: deps.size };
  }, [model, file]);
  // Exact use sites (imports, calls into its symbols, HTTP requests to its routes) from the query core.
  const uses = useMemo(() => (file ? usesOf(model.data, { type: 'file', id: file.id }) : undefined), [model, file]);
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
    { value: 'usedby', label: 'Used by', count: uses?.files ?? usedBy.length },
    { value: 'exports', label: 'Exports', count: file.exports.length },
  ];
  const change = model.changed.get(file.id);
  if (file.source !== undefined) tabs.push({ value: 'code', label: 'Code' });
  if (change?.diff) tabs.push({ value: 'diff', label: 'Diff' });
  if (file.git) tabs.push({ value: 'history', label: 'History', count: file.git.commits });
  if (file.tests?.length) tabs.push({ value: 'tests', label: 'Tests', count: file.tests.length });
  if (file.todos.length) tabs.push({ value: 'todos', label: 'TODOs', count: file.todos.length });
  // --- clone-radar: copy-paste clones of this file, next to its exports (a narrow panel would scroll it out of sight) ---
  const similar = familiesOf(model.data.insights.clones, file.id).length;
  if (similar) tabs.splice(tabs.findIndex((t) => t.value === 'exports') + 1, 0, { value: 'similar', label: 'Similar code', count: similar });
  // The rule tests-for, impact, My changes and the live guard use (query.testEvidence).
  const reachedBy = testEvidence(model.data, file);
  const routeTests = reachedBy === 'route' ? (routeTestReach(model.data).get(file.id) ?? []) : [];
  const folder = model.folderByPath.get(file.dir)?.summary;
  const apiCalls = model.apiByFile.get(file.id) ?? [];

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
            {change && (
              <span className="badge warn" title="Changed in your current work">
                <GitPullRequestArrow size={11} /> {change.status} <PlusMinus add={change.additions} del={change.deletions} />
              </span>
            )}
            {model.impacted.has(file.id) && <span className="badge info">affected by your changes</span>}
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
            <CopyContextButton fileId={file.id} />
          </>
        }
      />
      <div className="panel-body">
        <div className="panel-section stack" style={{ gap: 10 }}>
          <PersonalBar sel={{ type: 'file', id: file.id }} stepTitle={file.name} />
        </div>
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
          {(file.owners?.length || folder?.experts?.length || file.tests !== undefined || reachedBy) && (
            <dl className="kv" style={{ marginTop: 12 }}>
              {file.owners?.length ? (
                <>
                  <dt>Code owners</dt>
                  <dd>{file.owners.join(', ')}</dd>
                </>
              ) : null}
              {(file.git?.authors.length || folder?.experts?.length) && (
                <>
                  <dt>Who to ask</dt>
                  <dd>
                    <div className="row" style={{ gap: 6 }}>
                      {(file.git?.authors.length ? file.git.authors.slice(0, 3).map((a) => a.name) : folder!.experts!.map((e) => e.name)).map((name) => (
                        <span key={name} className="row nowrap tiny" style={{ gap: 4 }}>
                          <Avatar name={name} size="sm" /> {name}
                        </span>
                      ))}
                    </div>
                  </dd>
                </>
              )}
              <dt>Tests</dt>
              <dd>
                {file.kind === 'test' ? (
                  'this is a test file'
                ) : file.tests?.length ? (
                  <a onClick={() => setTab('tests')}>
                    {plural(file.tests.length, 'test file')} {file.tests.length === 1 ? 'reaches' : 'reach'} this file
                  </a>
                ) : reachedBy === 'route' ? (
                  <span title={routeTests.join('\n')}>
                    {plural(routeTests.length, 'test')} {routeTests.length === 1 ? 'reaches it through a route it requests' : 'reach it through routes they request'}
                  </span>
                ) : reachedBy === 'coverage' ? (
                  <span title="The coverage report saw its lines run: tests load it in a way imports do not show">no test imports this file</span>
                ) : (
                  <span style={{ color: 'var(--warning)' }}>no test reaches this file</span>
                )}
                {/* --- test-intelligence: line coverage from the local coverage report --- */}
                {file.coverage && file.coverage.lines.total > 0 && (
                  <span className="faint" title={`${file.coverage.lines.covered} of ${file.coverage.lines.total} lines executed by tests (${file.coverage.source} report)${file.coverage.stale ? ' — the file changed since the report was written' : ''}`}>
                    {' '}
                    · {Math.round((file.coverage.lines.covered / file.coverage.lines.total) * 100)}% line coverage{file.coverage.stale ? ' (outdated)' : ''}
                  </span>
                )}
              </dd>
            </dl>
          )}
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
        {apiCalls.length > 0 && (
          <Section title="HTTP calls" count={apiCalls.length}>
            {apiCalls.slice(0, 12).map((c) => {
              const r = c.route ? model.routeById.get(c.route) : undefined;
              return (
                <div key={c.id} className="sym-row" onClick={() => (r ? select({ type: 'route', id: r.id }) : selectFile(file.id, c.line))}>
                  <span className="method" style={{ ['--m' as string]: METHOD_COLORS[c.method] }}>
                    {c.method}
                  </span>
                  <span className="name">{c.url}</span>
                  <span className="faint tiny truncate">{r ? `→ ${basename(r.file)}` : c.external ? c.external : 'no matching route'}</span>
                  <span className="line">:{c.line}</span>
                </div>
              );
            })}
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
            {uses ? (
              <UseSiteList
                uses={uses}
                cycle={new Set(usedBy.filter((e) => e.inCycle).map((e) => e.source))}
                empty={`No file in this report imports this file${file.isEntry ? ' — it is an entry point.' : '.'}`}
              />
            ) : (
              <EdgeList edges={usedBy.map((e) => ({ file: e.source, names: e.names, typeOnly: e.typeOnly, kind: e.kind, line: e.line, inCycle: e.inCycle }))} />
            )}
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
          <CodeTab file={file} line={line} changedLines={change ? new Set(change.lines) : undefined} uncoveredLines={uncoveredChangedLines(model, file.id)} />
        )}
        {tab === 'diff' && change?.diff && <DiffView diff={change.diff} maxHeight="calc(100vh - 220px)" />}
        {tab === 'history' && file.git && (
          <div className="panel-section">
            <dl className="kv" style={{ marginBottom: 12 }}>
              <dt>Commits</dt>
              <dd>{fmtNum(file.git.commits)}</dd>
              <dt>Last changed</dt>
              <dd>{timeAgo(file.git.lastModified)}</dd>
              <dt>Created</dt>
              <dd>{timeAgo(file.git.firstSeen)}</dd>
              <dt>Ownership</dt>
              <dd>
                {Math.round(file.git.ownership * 100)}% by {file.git.authors[0]?.name}
              </dd>
            </dl>
            <h4>Authors</h4>
            {file.git.authors.map((a) => (
              <div key={a.name} className="row nowrap small" style={{ gap: 8, padding: '3px 0' }}>
                <Avatar name={a.name} size="sm" />
                <span className="truncate" style={{ flex: 1 }}>
                  {a.name}
                </span>
                <span className="tiny faint">
                  {plural(a.commits, 'commit')} · {timeAgo(a.last)}
                </span>
              </div>
            ))}
            <h4 style={{ marginTop: 14 }}>Recent commits — why it looks like this</h4>
            {file.git.recent.map((c) => (
              <div key={c.hash} className="commit-row" style={{ padding: '6px 4px', cursor: 'default' }}>
                <Avatar name={c.author} size="sm" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="small">{c.subject}</div>
                  <div className="tiny faint">
                    {c.author} · {timeAgo(c.date)} · <span className="mono">{c.hash.slice(0, 7)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === 'tests' && file.tests && (
          <div className="panel-section">
            <div className="small muted" style={{ marginBottom: 8 }}>
              These test files import this file directly or indirectly — run them after changing it.
            </div>
            <div className="list">
              {file.tests.map((t) => (
                <button key={t} className="list-item" onClick={() => selectFile(t)}>
                  <KindDot kind="test" />
                  <span className="mono small truncate">{t}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'similar' && (
          <div className="panel-section">
            <SimilarCode fileId={file.id} />
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

/** test-intelligence: the changed lines of a file that no test executed (patch coverage ranges). */
function uncoveredChangedLines(model: Model, fileId: string): Set<number> | undefined {
  const entry = model.data.changes?.coverage?.files.find((f) => f.file === fileId);
  if (!entry?.uncovered.length) return undefined;
  const lines = new Set<number>();
  for (const [a, b] of entry.uncovered) for (let l = a; l <= b; l++) lines.add(l);
  return lines;
}

function CodeTab({ file, line, changedLines, uncoveredLines }: { file: FileInfo; line?: number; changedLines?: Set<number>; uncoveredLines?: Set<number> }) {
  const [blame, setBlame] = useState<BlameRange[] | undefined>();
  const [loading, setLoading] = useState(false);
  const live = !!liveConfig();
  return (
    <div>
      {(live || changedLines) && (
        <div className="row small" style={{ padding: '8px 18px', gap: 10, borderBottom: '1px solid var(--border)' }}>
          {live && (
            <button
              className={`btn sm${blame ? ' active' : ''}`}
              disabled={loading}
              onClick={async () => {
                if (blame) return setBlame(undefined);
                setLoading(true);
                const result = await fetchBlame(file.id).catch(() => undefined);
                setLoading(false);
                if (result) setBlame(result);
                else toast('No git blame for this file');
              }}
            >
              <Users size={13} /> {loading ? 'Loading…' : blame ? 'Hide blame' : 'Blame'}
            </button>
          )}
          {changedLines && (
            <span className="tiny muted">
              Lines you changed are marked in the gutter{uncoveredLines ? <>; <span style={{ color: 'var(--danger)' }}>red</span>: no test runs them</> : ''}.
            </span>
          )}
        </div>
      )}
      <CodeView source={file.source!} from={line} maxHeight="calc(100vh - 260px)" blame={blame} changedLines={changedLines} uncoveredLines={uncoveredLines} />
    </div>
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
                  <span className="badge warn" title={`Cyclomatic complexity${s.cognitive ? ` · cognitive ${s.cognitive}` : ''}`}>
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
  const uses = usesOf(model.data, { type: 'symbol', id });
  const siteCount = uses.imports.length + uses.sites.length + uses.http.length + uses.refs.length;

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
            {!member && symbol.deprecated !== undefined && (
              <span className="badge danger" title={symbol.deprecated || 'Deprecated'}>
                deprecated
              </span>
            )}
            {model.data.changes?.symbols.some((cs) => cs.id === id) && <span className="badge warn">changed in your work</span>}
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
        <div className="panel-section stack" style={{ gap: 10 }}>
          <PersonalBar sel={{ type: 'symbol', id }} stepTitle={ref.label} />
          {!member && symbol.deprecated ? <div className="small" style={{ color: 'var(--danger)' }}>Deprecated: {symbol.deprecated}</div> : null}
        </div>
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
          <div className="metrics cols-4">
            <Metric value={member ? '–' : fmtNum(symbol.loc)} label="Lines" />
            <Metric
              value={member ? '–' : (symbol.complexity ?? '–')}
              label="Complexity"
              title="Cyclomatic complexity: independent paths through this code (nested functions are counted on their own)"
            />
            {/* accuracy-pass: cognitive complexity next to the cyclomatic one */}
            <Metric
              value={member ? '–' : (symbol.cognitive ?? '–')}
              label="Cognitive"
              title="Cognitive complexity: how hard the code is to follow — branches count more the deeper they are nested"
            />
            <Metric value={fmtNum(uses.files)} label="Used by" title="Files that import, call, render, instantiate or reference it (the Used by list below)" />
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
        <Section title="Used by" count={uses.files} right={siteCount ? <span className="tiny faint">{plural(siteCount, 'place')}</span> : undefined}>
          <UseSiteList uses={uses} targetId={id} empty={symbol.exported ? 'No analyzed file imports or calls it.' : 'Not used outside its own code.'} />
        </Section>
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
                <h4 style={{ marginTop: 12 }}>Referenced by</h4>
                <SymbolLinks edges={[...by(inn, 'uses'), ...by(inn, 'instantiates')]} side="source" />
              </>
            )}
          </Section>
        )}
        {/* --- clone-radar: copies of this declaration elsewhere --- */}
        {familiesOf(model.data.insights.clones, file.id, { start: line, end: endLine }).length > 0 && (
          <Section title="Similar code" count={familiesOf(model.data.insights.clones, file.id, { start: line, end: endLine }).length}>
            <SimilarCode fileId={file.id} range={{ start: line, end: endLine }} />
          </Section>
        )}
        {/* --- /clone-radar --- */}
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
        <div className="panel-section stack" style={{ gap: 10 }}>
          <PersonalBar sel={{ type: 'folder', id: path }} stepTitle={`${folder.name || model.data.project.rootName}/`} />
        </div>
        {(folder.summary?.experts?.length || folder.summary?.owners?.length) && (
          <Section title="Who to ask">
            {folder.summary?.experts?.map((e) => (
              <div key={e.name} className="row nowrap small" style={{ gap: 8, padding: '3px 0' }}>
                <Avatar name={e.name} size="sm" />
                <span className="truncate" style={{ flex: 1 }}>
                  {e.name}
                </span>
                <span className="tiny faint">{Math.round(e.share * 100)}% of recent changes</span>
              </div>
            ))}
            {folder.summary?.busFactor !== undefined && (
              <div className="tiny" style={{ marginTop: 6, color: folder.summary.busFactor === 1 ? 'var(--danger)' : 'var(--text-dim)' }}>
                Bus factor {folder.summary.busFactor}
                {folder.summary.busFactor === 1 ? ' — one person holds most of the knowledge here' : ''}
              </div>
            )}
            {folder.summary?.owners?.length ? <div className="tiny faint" style={{ marginTop: 4 }}>Code owners: {folder.summary.owners.join(', ')}</div> : null}
          </Section>
        )}
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
        <div className="panel-section stack" style={{ gap: 10 }}>
          <PersonalBar sel={{ type: 'route', id }} stepTitle={`${route.method} ${route.path}`} />
        </div>
        {(model.apiByRoute.get(route.id)?.length ?? 0) > 0 && (
          <Section title="Called from" count={model.apiByRoute.get(route.id)!.length}>
            {model.apiByRoute.get(route.id)!.slice(0, 20).map((c) => {
              const f = model.fileById.get(c.file);
              const sym = c.symbol ? model.resolveSymbol(c.symbol) : undefined;
              return (
                <div key={c.id} className="sym-row" onClick={() => (c.symbol ? selectSymbol(c.symbol) : selectFile(c.file, c.line))}>
                  {f && <KindDot kind={f.kind} />}
                  <span className="name">{sym?.label ?? basename(c.file)}</span>
                  <span className="faint tiny truncate">
                    {c.client} {c.url}
                  </span>
                  <span className="line">
                    {basename(c.file)}:{c.line}
                  </span>
                </div>
              );
            })}
          </Section>
        )}
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
