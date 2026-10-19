import { useMemo } from 'react';
import {
  ArrowRight,
  BookOpen,
  Compass,
  Flame,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  History,
  Network,
  Pin,
  Radar,
  Search,
  Sparkles,
  StickyNote,
  TestTube2,
  Wand2,
} from 'lucide-react';
import { useModel } from '../data/context';
import { projectSummaryMarkdown, prSummaryMarkdown } from '../../../src/shared/markdown';
import { KIND_META } from '../lib/colors';
import { describeKey } from '../lib/keys';
import { basename, fmtNum, plural, timeAgo } from '../lib/format';
import { usePersonal } from '../state/personal';
import { navigate, select, selectFile, setState, showInGraph, useStore } from '../state/store';
import { Avatar, CopyMarkdownButton, PlusMinus, riskColor, ScoreRing, StatusBadge, TrendChart } from '../components/companion';
import { LiveFeedCard } from '../components/LiveFeed';
import { IncomingCard } from '../components/IncomingCard';
import { RepoRadarCard } from '../components/RepoAttention';
import { liveConfig } from '../data/live';
import { KindDot } from '../components/ui';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function TodayView() {
  const model = useModel();
  const live = useStore((s) => s.live);
  const pins = usePersonal((s) => s.pins);
  const recent = usePersonal((s) => s.recent);
  const notes = usePersonal((s) => s.notes);
  const previousVisit = usePersonal((s) => s.previousVisit);
  const { data } = model;
  const git = data.git;
  const user = git?.user;
  // accuracy-pass: you are recognised by `git config user.email` (through .mailmap), the name is the fallback.
  const myEmail = git?.userEmail?.toLowerCase();
  const isMe = (a: { name: string; email?: string }): boolean => (!!myEmail && a.email?.toLowerCase() === myEmail) || a.name === user;
  const me = git?.contributors.find((c) => c.name === user);
  const changes = data.changes;
  const health = data.health;
  const prev = data.history.length > 1 ? data.history[data.history.length - 2] : undefined;
  const delta = prev ? health.score - prev.score : 0;

  const since = previousVisit ?? Date.now() - 24 * 3600 * 1000;
  const newCommits = useMemo(() => (git?.commits ?? []).filter((c) => c.date > since), [git, since]);
  const newAuthors = [...new Set(newCommits.map((c) => c.author))];
  const touchedRecently = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of newCommits) for (const p of c.paths) counts.set(p, (counts.get(p) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [newCommits]);

  const myFiles = useMemo(() => {
    if (!user && !myEmail) return [];
    return model.files
      .filter((f) => f.git?.authors.some(isMe) && f.kind !== 'test')
      .map((f) => ({ f, mine: f.git!.authors.filter(isMe).reduce((n, a) => n + a.commits, 0) }))
      .sort((a, b) => b.mine * (1 + b.f.complexity / 50) - a.mine * (1 + a.f.complexity / 50))
      .slice(0, 6);
  }, [model, user, myEmail]);
  const unexplored = useMemo(() => {
    if (!me) return [];
    const mine = new Set(me.areas.map((a) => a.path));
    return data.folders
      .filter((f) => f.path && f.files >= 3 && f.path.split('/').length <= (model.folderByPath.has('src') ? 2 : 1) && f.path !== 'src')
      .filter((f) => ![...mine].some((m) => m === f.path || m.startsWith(`${f.path}/`) || f.path.startsWith(`${m}/`)))
      .sort((a, b) => b.loc - a.loc)
      .slice(0, 6);
  }, [data.folders, me, model.folderByPath]);

  const pinned = pins.map((k) => describeKey(model, k)).filter((x): x is NonNullable<typeof x> => !!x?.exists);
  const recents = recent
    .map((r) => ({ info: describeKey(model, r.key), at: r.at }))
    .filter((x) => x.info?.exists)
    .slice(0, 8);
  const firstVisit = previousVisit === undefined;
  const changedSource = changes?.files.filter((f) => f.analyzed) ?? [];

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 18, alignItems: 'flex-end', gap: 14 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="greeting">
            {greeting()}
            {user ? `, ${user.split(/\s+/)[0]}` : ''} 👋
          </h2>
          <div className="row small muted" style={{ marginTop: 6, gap: 12 }}>
            <span className="row nowrap" style={{ gap: 5 }}>
              <strong style={{ color: 'var(--text)' }}>{data.project.name}</strong>
            </span>
            {git?.branch && (
              <span className="row nowrap" style={{ gap: 5 }}>
                <GitBranch size={13} /> {git.branch}
                {git.upstream && (git.upstream.ahead || git.upstream.behind) ? (
                  <span className="faint">
                    {git.upstream.ahead ? ` ↑${git.upstream.ahead}` : ''}
                    {git.upstream.behind ? ` ↓${git.upstream.behind}` : ''} vs {git.upstream.name}
                  </span>
                ) : git.upstream ? (
                  <span className="faint"> · up to date with {git.upstream.name}</span>
                ) : null}
              </span>
            )}
            {!firstVisit && <span className="faint">last visit {timeAgo(previousVisit)}</span>}
          </div>
        </div>
        {live ? (
          <span className={`live-badge${live.connected ? '' : ' off'}`} title="This page updates by itself while you code">
            <span className="live-dot" /> {live.connected ? 'Live — updates as you code' : 'Reconnecting…'}
          </span>
        ) : (
          <span className="badge outline" title="Run `npx code-visualizer serve` for a live view">
            Snapshot · {timeAgo(new Date(data.generatedAt).getTime())}
          </span>
        )}
      </div>

      {firstVisit && (
        <div className="scope-banner" style={{ marginBottom: 16 }}>
          <Sparkles size={16} />
          <span>
            New to <strong>{data.project.name}</strong>? The guided tour explains how it is built and where to start reading.
          </span>
          <span className="spacer" />
          <button className="btn sm primary" onClick={() => navigate('tour')}>
            <BookOpen size={13} /> Start the tour
          </button>
        </div>
      )}

      <div className="grid two-col">
        {/* ----------------------------- Your work ----------------------------- */}
        <section className="card">
          <div className="card-head">
            <GitPullRequestArrow size={16} className="muted" />
            <h3>Your work</h3>
            <span className="tiny faint">{changes ? (changes.mode === 'branch' ? `branch vs ${changes.base}` : 'uncommitted changes') : ''}</span>
            <span className="spacer" />
            {changes && changes.files.length > 0 && (
              <button className="btn ghost sm" onClick={() => navigate('changes')}>
                Review <ArrowRight size={12} />
              </button>
            )}
          </div>
          {!changes || !changes.files.length ? (
            <div className="card-body">
              <div className="row nowrap" style={{ gap: 12 }}>
                <span className="badge success" style={{ width: 34, height: 34, padding: 0, justifyContent: 'center', borderRadius: 10 }}>
                  <GitCommitHorizontal size={16} />
                </span>
                <div>
                  <div style={{ fontWeight: 650 }}>{git ? 'Nothing to review — your working tree is clean' : 'Not a git repository'}</div>
                  <div className="small muted">
                    {git
                      ? live
                        ? 'Edit a file and this panel shows what it affects, which tests to run and who should review — instantly.'
                        : 'When you change code, this panel shows its impact, the tests to run and who should review it.'
                      : 'Initialise git to see your changes, their impact and suggested reviewers.'}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="card-body stack" style={{ gap: 14 }}>
              <div className="grid kpis">
                <div className="kpi">
                  <span className="v">{changes.files.length}</span>
                  <span className="l">
                    changed files · <PlusMinus add={changes.additions} del={changes.deletions} />
                  </span>
                </div>
                <div className="kpi">
                  <span className="v">{fmtNum(changes.impacted.length)}</span>
                  <span className="l">files affected</span>
                </div>
                <div className="kpi">
                  <span className="v">{changes.tests.files.length}</span>
                  <span className="l">tests to run</span>
                </div>
                <div className="kpi">
                  <span className="v" style={{ color: riskColor(changes.risk.level), textTransform: 'capitalize' }}>
                    {changes.risk.level}
                  </span>
                  <span className="l">risk · {changes.risk.score}/100</span>
                </div>
              </div>
              <div className="list">
                {changedSource.slice(0, 5).map((f) => {
                  const info = model.fileById.get(f.id);
                  const syms = changes.symbols.filter((s) => s.file === f.id).slice(0, 3);
                  return (
                    <button key={f.id} className="list-item" onClick={() => selectFile(f.id)} style={{ padding: '6px 8px' }}>
                      <StatusBadge status={f.status} />
                      {info && <KindDot kind={info.kind} />}
                      <span className="mono small truncate" style={{ flex: 1 }}>
                        {f.id}
                      </span>
                      {syms.length > 0 && <span className="tiny faint truncate desktop-only" style={{ maxWidth: 220 }}>{syms.map((s) => s.name).join(', ')}</span>}
                      <PlusMinus add={f.additions} del={f.deletions} />
                    </button>
                  );
                })}
                {changes.files.length > 5 && (
                  <button className="list-item" onClick={() => navigate('changes')}>
                    <span className="small muted">+ {changes.files.length - 5} more files…</span>
                  </button>
                )}
              </div>
              <div className="row">
                <CopyMarkdownButton label="Copy PR description" getText={() => prSummaryMarkdown(data)} primary small />
                <button className="btn sm" onClick={() => showInGraph(changedSource.map((f) => f.id), 'changes')}>
                  <Radar size={13} /> Blast radius
                </button>
                {changes.tests.command && (
                  <CopyMarkdownButton label="Copy test command" getText={() => changes.tests.command!} small />
                )}
              </div>
            </div>
          )}
        </section>

        {/* ------------------------------- Health ------------------------------ */}
        <section className="card">
          <div className="card-head">
            <Flame size={16} className="muted" />
            <h3>Codebase health</h3>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => navigate('insights')}>
              Details <ArrowRight size={12} />
            </button>
          </div>
          <div className="card-body stack" style={{ gap: 14 }}>
            <div className="row nowrap" style={{ gap: 16 }}>
              <ScoreRing score={health.score} size={96} sub={`grade ${health.grade}`} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="small" style={{ fontWeight: 650 }}>
                  {prev ? (
                    <span style={{ color: delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--text-dim)' }}>
                      {delta > 0 ? `▲ ${delta}` : delta < 0 ? `▼ ${-delta}` : '±0'} since {timeAgo(prev.date)}
                    </span>
                  ) : (
                    <span className="muted">First measurement — run again to see trends</span>
                  )}
                </div>
                <TrendChart points={data.history.slice(-40)} field="score" height={46} />
              </div>
            </div>
            {health.improvements.length > 0 && (
              <div className="stack" style={{ gap: 6 }}>
                <div className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650 }}>
                  Quick wins
                </div>
                {health.improvements.slice(0, 3).map((imp) => (
                  <button
                    key={imp.id}
                    className="list-item"
                    style={{ padding: '6px 8px' }}
                    onClick={() => (imp.files?.length ? showInGraph(imp.files, 'files') : imp.view && setState({ view: imp.view as never }))}
                    title={imp.detail}
                  >
                    <Wand2 size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    <span className="small truncate" style={{ flex: 1 }}>
                      {imp.title}
                    </span>
                    <span className="badge success">+{imp.gain}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* --- live-guard: what got worse or better while you code (serve only) --- */}
      {live && (
        <div style={{ marginTop: 16 }}>
          <LiveFeedCard compact />
        </div>
      )}
      {/* --- /live-guard --- */}

      {/* --- daily-loop: what the base branch brings before you rebase (serve only) --- */}
      {live && liveConfig() && git && (
        <div style={{ marginTop: 16 }}>
          <IncomingCard live={liveConfig()!} headKey={`${git.head ?? ''}|${git.upstream?.behind ?? ''}|${changes?.base ?? ''}|${changes?.baseCommit ?? ''}`} />
        </div>
      )}
      {/* --- /daily-loop --- */}

      {/* --- dev-companion: branches to clean up, lost commits, risky files --- */}
      {data.repo && (
        <div style={{ marginTop: 16 }}>
          <RepoRadarCard repo={data.repo} />
        </div>
      )}
      {/* --- /dev-companion --- */}

      <div className="grid even" style={{ marginTop: 16 }}>
        {/* --------------------------- Since last visit -------------------------- */}
        <section className="card">
          <div className="card-head">
            <History size={16} className="muted" />
            <h3>{previousVisit ? 'Since your last visit' : 'Last 24 hours'}</h3>
            <span className="spacer" />
            {git && (
              <button className="btn ghost sm" onClick={() => navigate('activity')}>
                Activity <ArrowRight size={12} />
              </button>
            )}
          </div>
          <div className="card-body">
            {!git ? (
              <div className="small muted">Git history is not available for this report.</div>
            ) : !newCommits.length ? (
              <div className="small muted">
                No new commits{git.lastCommit ? ` — the last one was ${timeAgo(git.lastCommit)}` : ''}.
              </div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                <div className="row small" style={{ gap: 8 }}>
                  <strong>{plural(newCommits.length, 'new commit')}</strong>
                  <span className="muted">by</span>
                  <span className="row nowrap" style={{ gap: 3 }}>
                    {newAuthors.slice(0, 6).map((a) => (
                      <Avatar key={a} name={a} size="sm" />
                    ))}
                  </span>
                  <span className="muted truncate">{newAuthors.slice(0, 3).join(', ')}</span>
                </div>
                <div className="list">
                  {newCommits.slice(0, 5).map((c) => (
                    <div key={c.hash} className="commit-row" style={{ padding: '6px 8px' }} onClick={() => c.paths.length && showInGraph(c.paths, 'files')} title="Show the files of this commit in the graph">
                      <Avatar name={c.author} size="sm" />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="small truncate" style={{ fontWeight: 550 }}>
                          {c.subject}
                        </div>
                        <div className="tiny faint">
                          {c.author === user ? 'you' : c.author} · {timeAgo(c.date)} · <PlusMinus add={c.additions} del={c.deletions} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {touchedRecently.length > 0 && (
                  <div className="tags">
                    {touchedRecently.map(([id, n]) => (
                      <button key={id} className="tag link" onClick={() => selectFile(id)} title={id}>
                        {basename(id)} ×{n}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* --------------------------- Pinned & recent -------------------------- */}
        <section className="card">
          <div className="card-head">
            <Pin size={16} className="muted" />
            <h3>Pinned & recent</h3>
          </div>
          <div className="card-body">
            {!pinned.length && !recents.length && (
              <div className="small muted">
                Pin files, functions or folders with <Pin size={12} style={{ verticalAlign: -1 }} /> in the details panel — and add notes so you don't have to re-learn them next time.
              </div>
            )}
            {pinned.length > 0 && (
              <div className="list" style={{ marginBottom: 10 }}>
                {pinned.slice(0, 6).map((p) => {
                  const note = notes[p.key]?.text.trim();
                  return (
                    <button key={p.key} className="list-item" onClick={p.open} style={{ padding: '6px 8px', alignItems: note ? 'flex-start' : undefined }}>
                      {p.icon}
                      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                          <span className="small truncate" style={{ fontWeight: 550, flexShrink: 0, maxWidth: '60%' }}>
                            {p.label}
                          </span>
                          <span className="tiny faint mono truncate">{p.sub}</span>
                        </span>
                        {note && (
                          <span className="tiny muted truncate" title={note}>
                            <StickyNote size={11} style={{ verticalAlign: -1.5, marginRight: 5 }} />
                            {note}
                          </span>
                        )}
                      </span>
                      <Pin size={12} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: note ? 3 : 0 }} />
                    </button>
                  );
                })}
              </div>
            )}
            {recents.length > 0 && (
              <>
                <div className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650, margin: '4px 0 6px' }}>
                  Recently viewed
                </div>
                <div className="list">
                  {recents.map(({ info, at }) => (
                    <button key={info!.key} className="list-item" onClick={info!.open} style={{ padding: '5px 8px' }}>
                      {info!.icon}
                      <span className="small truncate" style={{ flex: 1 }}>
                        {info!.label}
                      </span>
                      <span className="meta">{timeAgo(at)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      <div className="grid even" style={{ marginTop: 16 }}>
        <section className="card">
          <div className="card-head">
            <Compass size={16} className="muted" />
            <h3>{me ? 'Your corner of the codebase' : 'Where to look'}</h3>
          </div>
          <div className="card-body stack" style={{ gap: 12 }}>
            {me ? (
              <>
                <div className="small muted">
                  {plural(me.commits, 'commit')} across {plural(me.files, 'file')} · mostly in {me.areas.slice(0, 3).map((a) => a.path).join(', ') || '—'}
                </div>
                {myFiles.length > 0 && (
                  <div className="list">
                    {myFiles.map(({ f, mine }) => (
                      <button key={f.id} className="list-item" onClick={() => selectFile(f.id)} style={{ padding: '5px 8px' }}>
                        <KindDot kind={f.kind} />
                        <span className="mono small truncate" style={{ flex: 1 }}>
                          {f.id}
                        </span>
                        <span className="meta">
                          {mine} of your commits{f.complexity > 40 ? ' · complex' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {unexplored.length > 0 && (
                  <>
                    <div className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650 }}>
                      Areas you haven't touched yet
                    </div>
                    <div className="tags">
                      {unexplored.map((f) => (
                        <button key={f.path} className="tag link" onClick={() => select({ type: 'folder', id: f.path })} title={f.description}>
                          {f.path}/ · {f.files}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="list">
                {[...model.files]
                  .filter((f) => f.kind !== 'test' && f.kind !== 'config')
                  .sort((a, b) => b.metrics.importance - a.metrics.importance)
                  .slice(0, 6)
                  .map((f) => (
                    <button key={f.id} className="list-item" onClick={() => selectFile(f.id)} style={{ padding: '5px 8px' }}>
                      <KindDot kind={f.kind} />
                      <span className="mono small truncate" style={{ flex: 1 }}>
                        {f.id}
                      </span>
                      <span className="meta">{KIND_META[f.kind].label}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <Sparkles size={16} className="muted" />
            <h3>Quick actions</h3>
          </div>
          <div className="card-body grid cols-2" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setState({ paletteOpen: true })}>
              <Search size={14} /> Search everything
            </button>
            <button className="btn" onClick={() => navigate('search')}>
              <Search size={14} /> Search code text
            </button>
            <button className="btn" onClick={() => navigate('graph')}>
              <Network size={14} /> Dependency graph
            </button>
            <button className="btn" onClick={() => navigate('tour')}>
              <BookOpen size={14} /> Guided tour
            </button>
            <CopyMarkdownButton label="Copy project summary" getText={() => projectSummaryMarkdown(data)} />
            <button className="btn" onClick={() => (data.insights.untested.length ? showInGraph(data.insights.untested.slice(0, 30), 'files') : navigate('insights'))}>
              <TestTube2 size={14} /> Untested files
            </button>
          </div>
          <div className="tiny faint" style={{ padding: '0 18px 14px' }}>
            “Copy project summary” produces Markdown for onboarding notes or AI assistants (AGENTS.md, CLAUDE.md, Copilot instructions).
          </div>
        </section>
      </div>
    </div>
  );
}
