import { useMemo, useState, type ReactNode } from 'react';
import { Copy, Flame, Ghost, GitCompareArrows, ListTodo, Network, Recycle, Ruler, Sigma, Unlink } from 'lucide-react';
import { useModel } from '../data/context';
import { Scatter } from '../charts/charts';
import { KIND_META } from '../lib/colors';
import { basename, fmtNum, plural, timeAgo } from '../lib/format';
import { selectFile, selectSymbol, showInGraph } from '../state/store';
import type { FileInfo } from '../types';
import { KindDot, Segmented, Toggle } from '../components/ui';

function Card({ id, icon: Icon, title, count, hint, children, right, tone }: { id: string; icon: typeof Flame; title: string; count?: number; hint?: string; children: ReactNode; right?: ReactNode; tone?: string }) {
  return (
    <section className="card" id={`insight-${id}`} style={{ scrollMarginTop: 16 }}>
      <div className="card-head">
        <span className={`badge ${tone ?? ''}`} style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', borderRadius: 7 }}>
          <Icon size={14} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h3>
            {title} {count !== undefined && <span className="faint num">({fmtNum(count)})</span>}
          </h3>
          {hint && <div className="tiny muted">{hint}</div>}
        </div>
        <span className="spacer" />
        {right}
      </div>
      <div style={{ padding: 8, maxHeight: 460, overflowY: 'auto' }}>{children}</div>
    </section>
  );
}

function FileRow({ file, meta, onClick }: { file?: FileInfo; meta?: ReactNode; onClick?: () => void }) {
  if (!file) return null;
  return (
    <button className="list-item" onClick={onClick ?? (() => selectFile(file.id))} title={file.id}>
      <KindDot kind={file.kind} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="title truncate" style={{ fontSize: 13 }}>
          {file.name}
        </div>
        <div className="tiny faint mono truncate">{file.id}</div>
      </div>
      {meta && <span className="meta">{meta}</span>}
    </button>
  );
}

function None({ children }: { children: ReactNode }) {
  return <div className="muted small" style={{ padding: '14px 12px' }}>{children}</div>;
}

export function InsightsView() {
  const model = useModel();
  const { insights } = model.data;
  const files = model.files.filter((f) => f.scope !== 'context' && f.kind !== 'test' && f.kind !== 'story');
  const [hideTypeExports, setHideTypeExports] = useState(true);
  const [todoTag, setTodoTag] = useState<string>('all');
  const hasGit = !!model.data.git;

  const scatter = useMemo(() => {
    const pool = hasGit ? files.filter((f) => f.git) : files;
    return pool
      .filter((f) => f.complexity > 1)
      .map((f) => ({
        key: f.id,
        x: f.complexity,
        y: hasGit ? (f.git?.commits ?? 0) : f.metrics.fanIn,
        r: f.loc,
        color: KIND_META[f.kind].color,
        label: f.id,
        detail: `complexity ${f.complexity} · ${hasGit ? `${f.git?.commits ?? 0} commits` : `used by ${f.metrics.fanIn}`} · ${fmtNum(f.loc)} lines`,
      }));
  }, [files, hasGit]);

  const riskyCore = useMemo(
    () =>
      [...files]
        .map((f) => ({ f, score: f.complexity * Math.log2(2 + f.metrics.fanIn) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12),
    [files],
  );
  const largest = [...files].sort((a, b) => b.loc - a.loc).slice(0, 15);
  const hubs = [...files].sort((a, b) => b.metrics.fanIn + b.metrics.fanOut - (a.metrics.fanIn + a.metrics.fanOut)).slice(0, 12);
  const unusedExports = insights.unusedExports.filter((u) => !hideTypeExports || !u.typeOnly);
  const unusedByFile = useMemo(() => {
    const map = new Map<string, typeof unusedExports>();
    for (const u of unusedExports) map.set(u.file, [...(map.get(u.file) ?? []), u]);
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [unusedExports]);
  const todos = model.files.flatMap((f) => f.todos.map((t) => ({ ...t, file: f.id })));
  const todoTags = [...new Set(todos.map((t) => t.tag))];
  const shownTodos = todos.filter((t) => todoTag === 'all' || t.tag === todoTag);
  const stale = hasGit
    ? [...files]
        .filter((f) => f.git)
        .sort((a, b) => (a.git!.lastModified ?? 0) - (b.git!.lastModified ?? 0))
        .slice(0, 10)
    : [];

  const nav = [
    { id: 'hotspots', label: hasGit ? 'Hotspots' : 'Risky core', icon: Flame },
    { id: 'cycles', label: `Cycles (${insights.cycles.length})`, icon: Recycle },
    { id: 'complex', label: 'Complex functions', icon: Sigma },
    { id: 'unused', label: `Unused exports (${unusedExports.length})`, icon: Unlink },
    { id: 'orphans', label: `Orphans (${insights.orphans.length})`, icon: Ghost },
    { id: 'size', label: 'Large files', icon: Ruler },
    ...(insights.changeCoupling.length ? [{ id: 'coupling', label: 'Change coupling', icon: GitCompareArrows }] : []),
    { id: 'dupes', label: 'Duplicate names', icon: Copy },
    { id: 'todos', label: `TODOs (${todos.length})`, icon: ListTodo },
  ];

  return (
    <div className="page">
      <div className="row" style={{ gap: 6, marginBottom: 16 }}>
        {nav.map((n) => (
          <button key={n.id} className="chip" onClick={() => document.getElementById(`insight-${n.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            <n.icon size={13} />
            {n.label}
          </button>
        ))}
      </div>

      <div className="grid cols-2">
        <section className="card" id="insight-hotspots" style={{ gridColumn: '1 / -1' }}>
          <div className="card-head">
            <span className="badge danger" style={{ width: 26, height: 26, padding: 0, justifyContent: 'center', borderRadius: 7 }}>
              <Flame size={14} />
            </span>
            <div>
              <h3>{hasGit ? 'Hotspots: complexity × change frequency' : 'Risky core: complexity × number of dependents'}</h3>
              <div className="tiny muted">
                {hasGit
                  ? 'Files in the upper-right are both complicated and changed often — the best candidates for refactoring and extra tests.'
                  : 'Files in the upper-right are complicated and many files depend on them — changes there have a large blast radius.'}
              </div>
            </div>
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', padding: 12, gap: 12 }}>
            <Scatter points={scatter} xLabel="Cyclomatic complexity" yLabel={hasGit ? 'Commits' : 'Used by (files)'} onClick={(id) => selectFile(id)} />
            <div className="list">
              {(hasGit ? insights.hotspots.slice(0, 12).map((h) => ({ f: model.fileById.get(h.file), meta: `${h.commits} commits · cx ${h.complexity}` })) : riskyCore.map(({ f }) => ({ f, meta: `cx ${f.complexity} · ↑${f.metrics.fanIn}` }))).map(({ f, meta }, i) => (
                <FileRow key={f?.id ?? i} file={f} meta={meta} />
              ))}
            </div>
          </div>
        </section>

        <Card id="cycles" icon={Recycle} title="Circular dependencies" count={insights.cycles.length} tone={insights.cycles.length ? 'danger' : 'success'} hint="Modules that (indirectly) import themselves — they cause initialization-order bugs and make code hard to split.">
          {!insights.cycles.length && <None>No circular imports. 🎉</None>}
          {insights.cycles.map((cycle, i) => (
            <div key={i} className="card" style={{ padding: '10px 12px', margin: 4 }}>
              <div className="row" style={{ gap: 4 }}>
                {cycle.slice(0, 7).map((id, j) => (
                  <span key={id} className="row nowrap" style={{ gap: 4 }}>
                    <button className="chip" onClick={() => selectFile(id)} title={id}>
                      <span className="mono">{basename(id)}</span>
                    </button>
                    {j < Math.min(cycle.length, 7) - 1 && <span className="faint">→</span>}
                  </span>
                ))}
                {cycle.length > 7 ? <span className="faint small">+{cycle.length - 7} more</span> : <span className="faint">↺</span>}
                <span className="spacer" />
                <button className="btn sm" onClick={() => showInGraph(cycle, 'cycle')}>
                  <Network size={13} /> Graph
                </button>
              </div>
            </div>
          ))}
        </Card>

        <Card id="complex" icon={Sigma} title="Most complex functions" count={insights.complexFunctions.length} tone="warn" hint="Cyclomatic complexity: 1–10 simple, 11–20 moderate, 21+ hard to test and change.">
          {insights.complexFunctions.slice(0, 30).map((c) => (
            <button key={c.symbol} className="list-item" onClick={() => selectSymbol(c.symbol)}>
              <span
                className="badge"
                style={{
                  minWidth: 38,
                  justifyContent: 'center',
                  background: c.complexity > 20 ? 'color-mix(in srgb, var(--danger) 18%, transparent)' : c.complexity > 10 ? 'color-mix(in srgb, var(--warning) 18%, transparent)' : undefined,
                  color: c.complexity > 20 ? 'var(--danger)' : c.complexity > 10 ? 'var(--warning)' : undefined,
                }}
              >
                {c.complexity}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="title mono truncate" style={{ fontSize: 12.5 }}>
                  {c.name}
                </div>
                <div className="tiny faint mono truncate">
                  {c.file}:{c.line}
                </div>
              </div>
              <span className="meta">{c.loc} lines</span>
            </button>
          ))}
        </Card>

        <Card
          id="unused"
          icon={Unlink}
          title="Unused exports"
          count={unusedExports.length}
          tone="warn"
          hint="Exported but never imported by another file — possibly dead code (excluding entry points and framework files)."
          right={<Toggle checked={hideTypeExports} onChange={setHideTypeExports} label="Hide types" />}
        >
          {!unusedByFile.length && <None>Every export is used somewhere.</None>}
          {unusedByFile.slice(0, 80).map(([file, items]) => (
            <div key={file} style={{ padding: '6px 8px' }}>
              <button className="row nowrap mono small" style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0, color: 'var(--text)' }} onClick={() => selectFile(file)}>
                <KindDot kind={model.fileById.get(file)?.kind ?? 'module'} /> {file}
              </button>
              <div className="tags" style={{ marginTop: 6, paddingLeft: 16 }}>
                {items.map((u) => (
                  <button key={u.name} className="tag link" onClick={() => selectFile(file, u.line)}>
                    {u.name}
                    {u.typeOnly ? ' (type)' : ''}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Card>

        <Card id="orphans" icon={Ghost} title="Orphan files" count={insights.orphans.length} tone="warn" hint="Not imported by any other file and not an entry point, route, test or config.">
          {!insights.orphans.length && <None>No orphan files.</None>}
          {insights.orphans.map((id) => (
            <FileRow key={id} file={model.fileById.get(id)} meta={`${fmtNum(model.fileById.get(id)?.loc)} lines`} />
          ))}
        </Card>

        <Card id="size" icon={Ruler} title="Largest files & hubs" hint="Big files and files with many connections are harder to understand and change.">
          <div className="grid cols-2" style={{ gap: 4 }}>
            <div>
              <div className="tiny faint" style={{ padding: '4px 12px', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                By lines
              </div>
              {largest.map((f) => (
                <FileRow key={f.id} file={f} meta={fmtNum(f.loc)} />
              ))}
            </div>
            <div>
              <div className="tiny faint" style={{ padding: '4px 12px', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                By connections
              </div>
              {hubs.map((f) => (
                <FileRow key={f.id} file={f} meta={`↑${f.metrics.fanIn} ↓${f.metrics.fanOut}`} />
              ))}
            </div>
          </div>
        </Card>

        {insights.changeCoupling.length > 0 && (
          <Card id="coupling" icon={GitCompareArrows} title="Change coupling" count={insights.changeCoupling.length} tone="info" hint="Files that are usually committed together. Pairs without an import between them reveal hidden dependencies.">
            {insights.changeCoupling.slice(0, 40).map((c) => {
              const linked = model.out.get(c.a)?.some((e) => e.target === c.b) || model.out.get(c.b)?.some((e) => e.target === c.a);
              return (
                <div key={`${c.a}|${c.b}`} className="list-item" style={{ cursor: 'default' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="row nowrap small" style={{ gap: 6 }}>
                      <a className="mono truncate" onClick={() => selectFile(c.a)}>
                        {basename(c.a)}
                      </a>
                      <span className="faint">⇄</span>
                      <a className="mono truncate" onClick={() => selectFile(c.b)}>
                        {basename(c.b)}
                      </a>
                      {!linked && <span className="badge info">hidden</span>}
                    </div>
                    <div className="tiny faint">
                      {c.count} commits together · {Math.round(c.ratio * 100)}% of the time
                    </div>
                  </div>
                  <button className="btn ghost sm" onClick={() => showInGraph([c.a, c.b], 'files')}>
                    <Network size={13} />
                  </button>
                </div>
              );
            })}
          </Card>
        )}

        <Card id="dupes" icon={Copy} title="Duplicate names" count={insights.duplicateSymbols.length} hint="Different files exporting a component, function or type with the same name — easy to import the wrong one.">
          {!insights.duplicateSymbols.length && <None>No duplicate exported names.</None>}
          {insights.duplicateSymbols.map((d) => (
            <div key={`${d.kind}:${d.name}`} style={{ padding: '6px 10px' }}>
              <div className="row nowrap small">
                <strong className="mono">{d.name}</strong>
                <span className="badge">{d.kind}</span>
                <span className="faint tiny">in {plural(d.files.length, 'file')}</span>
              </div>
              <div className="tags" style={{ marginTop: 6 }}>
                {d.files.map((f) => (
                  <button key={f} className="tag link" onClick={() => selectFile(f)} title={f}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Card>

        <Card
          id="todos"
          icon={ListTodo}
          title="TODO / FIXME notes"
          count={todos.length}
          tone="info"
          right={
            todoTags.length > 1 ? (
              <Segmented value={todoTag} onChange={setTodoTag} options={[{ value: 'all', label: 'All' }, ...todoTags.map((t) => ({ value: t, label: t }))]} />
            ) : undefined
          }
        >
          {!shownTodos.length && <None>No TODO, FIXME or HACK comments.</None>}
          {shownTodos.slice(0, 200).map((t, i) => (
            <button key={i} className="list-item" onClick={() => selectFile(t.file, t.line)}>
              <span className={`badge ${t.tag === 'FIXME' || t.tag === 'BUG' ? 'danger' : t.tag === 'HACK' || t.tag === 'XXX' ? 'warn' : 'info'}`}>{t.tag}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="small truncate">{t.text}</div>
                <div className="tiny faint mono truncate">
                  {t.file}:{t.line}
                </div>
              </div>
            </button>
          ))}
        </Card>

        {stale.length > 0 && (
          <Card id="stale" icon={Ghost} title="Least recently changed" hint="Files nobody touched for a long time: stable foundations — or forgotten code.">
            {stale.map((f) => (
              <FileRow key={f.id} file={f} meta={timeAgo(f.git?.lastModified)} />
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
