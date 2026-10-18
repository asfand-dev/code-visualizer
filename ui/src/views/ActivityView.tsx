import { useEffect, useMemo, useRef, useState } from 'react';
import { hierarchy, treemap, treemapSquarify } from 'd3';
import { CalendarDays, GitCommitHorizontal, Map as MapIcon, Network, Users } from 'lucide-react';
import { useModel } from '../data/context';
import type { FolderNode } from '../data/model';
import { basename, fmtDate, fmtNum, plural, timeAgo } from '../lib/format';
import { select, selectFile, showInGraph, useStore } from '../state/store';
import type { CommitInfo, FileInfo } from '../types';
import { Avatar, personColor, PlusMinus } from '../components/companion';
import { Empty, KindDot, SearchInput, Segmented, Select } from '../components/ui';

type Tab = 'timeline' | 'calendar' | 'people' | 'ownership';

const DAY = 24 * 3600 * 1000;

function dayLabel(ts: number): string {
  const today = new Date(new Date().toDateString()).getTime();
  if (ts >= today) return 'Today';
  if (ts >= today - DAY) return 'Yesterday';
  if (ts >= today - 6 * DAY) return new Date(ts).toLocaleDateString('en-US', { weekday: 'long' });
  return fmtDate(ts);
}

export function ActivityView() {
  const model = useModel();
  const git = model.data.git;
  // Deep links: #/activity?tab=calendar
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('tab');
    return t === 'calendar' || t === 'people' || t === 'ownership' ? t : 'timeline';
  });
  const [author, setAuthor] = useState('');
  if (!git) {
    return (
      <Empty icon={GitCommitHorizontal} title="No git history">
        Activity, people and ownership come from git. Run code-visualizer inside a git repository (without --no-git).
      </Empty>
    );
  }
  return (
    <>
      <div className="toolbar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'timeline', label: 'Timeline', icon: GitCommitHorizontal },
            { value: 'calendar', label: 'Calendar', icon: CalendarDays },
            { value: 'people', label: 'People', icon: Users },
            { value: 'ownership', label: 'Ownership', icon: MapIcon },
          ]}
        />
        <span className="spacer" />
        <span className="small muted">
          {plural(git.commitsAnalyzed, 'commit')} · {plural(git.contributors.length, 'contributor')}
          {git.firstCommit ? ` · since ${fmtDate(git.firstCommit)}` : ''}
        </span>
      </div>
      <div className="view" style={{ flex: 1 }}>
        {tab === 'timeline' && <Timeline author={author} setAuthor={setAuthor} />}
        {tab === 'calendar' && <Calendar />}
        {tab === 'people' && (
          <People
            onPick={(name) => {
              setAuthor(name);
              setTab('timeline');
            }}
          />
        )}
        {tab === 'ownership' && <Ownership />}
      </div>
    </>
  );
}

/* -------------------------------- Timeline -------------------------------- */

function Timeline({ author, setAuthor }: { author: string; setAuthor: (v: string) => void }) {
  const model = useModel();
  const git = model.data.git!;
  const user = git.user;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const commits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return git.commits.filter((c) => (!author || c.author === author) && (!q || c.subject.toLowerCase().includes(q) || c.paths.some((p) => p.toLowerCase().includes(q))));
  }, [git.commits, author, query]);
  const groups: { label: string; commits: CommitInfo[] }[] = [];
  for (const c of commits) {
    const label = dayLabel(c.date);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.commits.push(c);
    else groups.push({ label, commits: [c] });
  }
  const authors = [...new Set(git.commits.map((c) => c.author))].sort();
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <SearchInput value={query} onChange={setQuery} placeholder="Filter by message or file…" style={{ width: 280 }} />
        <Select value={author} onChange={setAuthor} options={[{ value: '', label: 'Everyone' }, ...authors.map((a) => ({ value: a, label: a === user ? `${a} (you)` : a }))]} />
        <span className="spacer" />
        <span className="small muted">{plural(commits.length, 'commit')} shown (latest {git.commits.length})</span>
      </div>
      {!commits.length && <div className="empty">No commits match.</div>}
      {groups.map((g) => (
        <div key={g.label}>
          <div className="day-header">{g.label}</div>
          <div className="card" style={{ padding: 4 }}>
            {g.commits.map((c) => {
              const isOpen = open === c.hash;
              return (
                <div key={c.hash}>
                  <div className="commit-row" onClick={() => setOpen(isOpen ? null : c.hash)}>
                    <Avatar name={c.author} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="small" style={{ fontWeight: 600 }}>
                        {c.subject}
                      </div>
                      <div className="tiny faint row nowrap" style={{ gap: 6 }}>
                        <span>{c.author === user ? 'you' : c.author}</span>·<span>{new Date(c.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>·<span className="mono">{c.hash.slice(0, 7)}</span>·
                        <span>{plural(c.files, 'file')}</span>
                      </div>
                    </div>
                    <PlusMinus add={c.additions} del={c.deletions} />
                  </div>
                  {isOpen && (
                    <div style={{ padding: '0 12px 12px 48px' }}>
                      <div className="tags">
                        {c.paths.slice(0, 40).map((p) => {
                          const f = model.fileById.get(p);
                          return (
                            <button key={p} className="chip" onClick={() => selectFile(p)} title={p}>
                              {f && <KindDot kind={f.kind} />}
                              <span className="mono">{basename(p)}</span>
                            </button>
                          );
                        })}
                        {c.files > c.paths.length && <span className="tiny faint">+{c.files - c.paths.length} other files</span>}
                      </div>
                      {c.paths.length > 0 && (
                        <button className="btn sm" style={{ marginTop: 10 }} onClick={() => showInGraph(c.paths, 'files')}>
                          <Network size={13} /> Show in graph
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------- Calendar -------------------------------- */

function Calendar() {
  const model = useModel();
  const git = model.data.git!;
  const days = git.dailyActivity;
  const max = Math.max(1, ...days);
  const today = new Date(new Date().toDateString());
  // Align columns to weeks: the grid starts on the Sunday of the first week.
  const startDate = new Date(today.getTime() - (days.length - 1) * DAY);
  const lead = startDate.getDay();
  const cells: { count: number; date: Date | null }[] = [];
  for (let i = 0; i < lead; i++) cells.push({ count: 0, date: null });
  days.forEach((count, i) => cells.push({ count, date: new Date(startDate.getTime() + i * DAY) }));
  const level = (n: number): number => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const total = days.reduce((a, b) => a + b, 0);
  let current = 0;
  for (let i = days.length - 1; i >= 0 && days[i] > 0; i--) current++;
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  for (const c of git.commits) {
    const d = new Date(c.date);
    hours[d.getHours()]++;
    weekdays[d.getDay()]++;
  }
  const maxHour = Math.max(1, ...hours);
  const maxWeekday = Math.max(1, ...weekdays);
  const months: { label: string; col: number }[] = [];
  cells.forEach((cell, i) => {
    if (cell.date && cell.date.getDate() <= 7 && i % 7 === cell.date.getDay()) {
      const label = cell.date.toLocaleDateString('en-US', { month: 'short' });
      const col = Math.floor(i / 7);
      if (!months.length || months[months.length - 1].label !== label) months.push({ label, col });
    }
  });
  return (
    <div className="page">
      <section className="card card-pad">
        <div className="row" style={{ marginBottom: 14 }}>
          <h3 className="card-title">{plural(total, 'commit')} in the last year</h3>
          <span className="spacer" />
          <span className="small muted">
            current streak <strong style={{ color: 'var(--text)' }}>{plural(current, 'day')}</strong> · longest <strong style={{ color: 'var(--text)' }}>{plural(longest, 'day')}</strong>
          </span>
        </div>
        <div style={{ overflowX: 'auto', paddingBottom: 6 }}>
          <div style={{ position: 'relative', height: 16, marginLeft: 0 }}>
            {months.map((m) => (
              <span key={`${m.label}${m.col}`} className="tiny faint" style={{ position: 'absolute', left: m.col * 15 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="heatmap">
            {cells.map((cell, i) => (
              <span
                key={i}
                className={cell.date ? undefined : 'future'}
                data-l={level(cell.count)}
                title={cell.date ? `${plural(cell.count, 'commit')} on ${cell.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : undefined}
              />
            ))}
          </div>
        </div>
        <div className="row tiny faint" style={{ marginTop: 10, gap: 6 }}>
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className="heatmap" style={{ display: 'inline-grid', gridTemplateRows: '12px' }}>
              <span data-l={l} />
            </span>
          ))}
          More
        </div>
      </section>
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <section className="card card-pad">
          <h3 className="card-title" style={{ marginBottom: 12 }}>
            When the team commits
          </h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 110 }}>
            {hours.map((h, i) => (
              <div key={i} title={`${String(i).padStart(2, '0')}:00 — ${plural(h, 'commit')}`} style={{ flex: 1, height: `${Math.max(3, (h / maxHour) * 100)}%`, borderRadius: 3, background: h ? 'var(--accent)' : 'var(--surface-3)', opacity: h ? 0.35 + (h / maxHour) * 0.65 : 1 }} />
            ))}
          </div>
          <div className="row tiny faint" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>23:00</span>
          </div>
        </section>
        <section className="card card-pad">
          <h3 className="card-title" style={{ marginBottom: 12 }}>
            By weekday
          </h3>
          <div className="stack" style={{ gap: 6 }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
              <div key={d} className="row nowrap small" style={{ gap: 10 }}>
                <span style={{ width: 34 }} className="muted">
                  {d}
                </span>
                <div className="bar">
                  <span style={{ width: `${(weekdays[i] / maxWeekday) * 100}%` }} />
                </div>
                <span className="tiny faint" style={{ width: 30, textAlign: 'right' }}>
                  {weekdays[i]}
                </span>
              </div>
            ))}
          </div>
          <div className="tiny faint" style={{ marginTop: 8 }}>
            Based on the latest {plural(git.commits.length, 'commit')}.
          </div>
        </section>
      </div>
    </div>
  );
}

/* --------------------------------- People --------------------------------- */

function People({ onPick }: { onPick: (name: string) => void }) {
  const model = useModel();
  const git = model.data.git!;
  const owned = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of model.files) {
      const top = f.git?.authors[0];
      if (top && f.git!.ownership >= 0.5) counts.set(top.name, (counts.get(top.name) ?? 0) + 1);
    }
    return counts;
  }, [model]);
  const maxCommits = Math.max(1, ...git.contributors.map((c) => c.commits));
  return (
    <div className="page">
      <div className="grid auto">
        {git.contributors.map((c) => {
          const inactive = Date.now() - c.last > 120 * DAY;
          return (
            <div key={c.name} className="card card-pad interactive" onClick={() => onPick(c.name)} title="Show their commits">
              <div className="row nowrap" style={{ gap: 12 }}>
                <Avatar name={c.name} size="lg" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="truncate" style={{ fontWeight: 650 }}>
                    {c.name}
                    {c.name === git.user && <span className="badge accent" style={{ marginLeft: 6 }}>you</span>}
                  </div>
                  <div className="tiny faint">
                    {inactive ? `last active ${timeAgo(c.last)}` : `active ${timeAgo(c.last)}`} · since {fmtDate(c.first)}
                  </div>
                </div>
                {inactive && <span className="badge">away</span>}
              </div>
              <div className="row" style={{ gap: 18, marginTop: 14 }}>
                <div className="kpi">
                  <span className="v" style={{ fontSize: 18 }}>
                    {fmtNum(c.commits)}
                  </span>
                  <span className="l">commits</span>
                </div>
                <div className="kpi">
                  <span className="v" style={{ fontSize: 18 }}>
                    {fmtNum(c.files)}
                  </span>
                  <span className="l">files touched</span>
                </div>
                <div className="kpi">
                  <span className="v" style={{ fontSize: 18 }}>
                    {fmtNum(owned.get(c.name) ?? 0)}
                  </span>
                  <span className="l">files they own</span>
                </div>
              </div>
              <div className="bar" style={{ marginTop: 12 }}>
                <span style={{ width: `${(c.commits / maxCommits) * 100}%`, ['--c' as string]: personColor(c.name) }} />
              </div>
              {c.areas.length > 0 && (
                <div className="tags" style={{ marginTop: 12 }}>
                  {c.areas.map((a) => (
                    <button
                      key={a.path}
                      className="tag link"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (model.folderByPath.has(a.path)) select({ type: 'folder', id: a.path });
                      }}
                    >
                      {a.path} · {a.commits}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------- Ownership ------------------------------- */

interface TNode {
  name: string;
  path: string;
  file?: FileInfo;
  children?: TNode[];
  value?: number;
}

function toTree(folder: FolderNode): TNode {
  return {
    name: folder.name,
    path: folder.path,
    children: [
      ...folder.folders.map(toTree).filter((c) => c.children?.length),
      ...folder.files.filter((f) => f.kind !== 'test' && f.kind !== 'story').map((f) => ({ name: f.name, path: f.id, file: f, value: Math.max(1, f.loc) })),
    ],
  };
}

function Ownership() {
  const model = useModel();
  const git = model.data.git!;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 460 });
  const [hover, setHover] = useState<{ x: number; y: number; f: FileInfo } | null>(null);
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.max(300, Math.floor(e.contentRect.width)), height: 460 }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const top = git.contributors.slice(0, 10).map((c) => c.name);
  const colorOf = (f: FileInfo): string => {
    const a = f.git?.authors[0]?.name;
    if (!a) return 'var(--surface-3)';
    return top.includes(a) ? personColor(a) : '#7c8aa5';
  };
  const leaves = useMemo(() => {
    const root = hierarchy(toTree(model.root))
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<TNode>().tile(treemapSquarify).size([size.width, size.height]).paddingInner(1).paddingOuter(2).round(true)(root).leaves();
  }, [model, size]);
  const folders = model.data.folders
    .filter((f) => f.path && f.experts?.length && f.files >= 3)
    .sort((a, b) => (a.busFactor ?? 9) - (b.busFactor ?? 9) || b.loc - a.loc)
    .slice(0, 40);
  const silos = model.data.insights.knowledgeSilos;
  return (
    <div className="page">
      <section className="card">
        <div className="card-head">
          <h3>Knowledge map</h3>
          <span className="tiny faint">each file is colored by the person who changed it most · area = lines of code</span>
        </div>
        <div className="card-body">
          <div ref={ref} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)} data-theme={theme}>
            <svg width={size.width} height={size.height} style={{ display: 'block' }}>
              {leaves.map((d) => {
                const f = d.data.file;
                if (!f) return null;
                const w = d.x1 - d.x0;
                const h = d.y1 - d.y0;
                if (w < 1 || h < 1) return null;
                return (
                  <rect
                    key={f.id}
                    x={d.x0}
                    y={d.y0}
                    width={w}
                    height={h}
                    rx={2}
                    fill={colorOf(f)}
                    fillOpacity={f.git ? 0.35 + 0.65 * (f.git.ownership ?? 0) : 1}
                    style={{ cursor: 'pointer' }}
                    onMouseMove={(e) => {
                      const r = ref.current!.getBoundingClientRect();
                      setHover({ x: e.clientX - r.left, y: e.clientY - r.top, f });
                    }}
                    onClick={() => selectFile(f.id)}
                  />
                );
              })}
            </svg>
            {hover && (
              <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
                <div className="tt-title mono">{hover.f.id}</div>
                <div className="muted">
                  {hover.f.git?.authors.slice(0, 3).map((a) => `${a.name} (${a.commits})`).join(', ') || 'no history'}
                </div>
              </div>
            )}
          </div>
          <div className="row tiny" style={{ marginTop: 12, gap: 12 }}>
            {top.map((name) => (
              <span key={name} className="row nowrap" style={{ gap: 5 }}>
                <span className="dot" style={{ ['--c' as string]: personColor(name) }} />
                {name}
              </span>
            ))}
            <span className="faint">· stronger color = more concentrated ownership</span>
          </div>
        </div>
      </section>
      <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <h3>Who to ask, by area</h3>
            <span className="tiny faint">bus factor = people holding half the knowledge</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Experts</th>
                  <th className="num">Bus factor</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.path} onClick={() => select({ type: 'folder', id: f.path })}>
                    <td className="mono small">{f.path}/</td>
                    <td>
                      <div className="row nowrap" style={{ gap: 6 }}>
                        {f.experts!.map((e) => (
                          <span key={e.name} className="row nowrap tiny" style={{ gap: 4 }} title={`${Math.round(e.share * 100)}%`}>
                            <Avatar name={e.name} size="sm" />
                            <span className="desktop-only">{e.name.split(' ')[0]}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="num">
                      <span className={`badge ${f.busFactor === 1 ? 'danger' : f.busFactor === 2 ? 'warn' : 'success'}`}>{f.busFactor}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <h3>Knowledge silos</h3>
            <span className="tiny faint">important files mostly written by one person</span>
          </div>
          <div style={{ padding: 6 }}>
            {!silos.length && <div className="small muted" style={{ padding: 12 }}>No knowledge silos among the important files. 🎉</div>}
            {silos.map((s) => {
              const f = model.fileById.get(s.file);
              const away = Date.now() - s.lastActive > 120 * DAY;
              return (
                <button key={s.file} className="list-item" onClick={() => selectFile(s.file)}>
                  {f && <KindDot kind={f.kind} />}
                  <span className="mono small truncate" style={{ flex: 1 }}>
                    {s.file}
                  </span>
                  <Avatar name={s.author} size="sm" />
                  <span className="meta">
                    {Math.round(s.share * 100)}%{away ? ' · away' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
