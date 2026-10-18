import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Eye, FileCode2, GitCommitHorizontal, GitPullRequestArrow, Radar, ShieldCheck, TestTube2, Users } from 'lucide-react';
import { useModel } from '../data/context';
import { prSummaryMarkdown } from '../../../src/shared/markdown';
import { formatPct, formatRanges, reportAge } from '../../../src/shared/coverage';
import { httpTestedFiles, untestedChanges } from '../../../src/shared/query';
import { METHOD_COLORS } from '../lib/colors';
import { basename, fmtNum, plural, timeAgo } from '../lib/format';
import { select, selectFile, selectSymbol, setChangesRole, showInGraph, useStore } from '../state/store';
import { Avatar, CopyMarkdownButton, DiffView, PlusMinus, riskColor, StatusBadge } from '../components/companion';
import { ArchitectureDeltaCard } from '../components/ArchitectureDelta';
import { LiveFeedCard } from '../components/LiveFeed';
import { CloneDriftCard } from '../components/Clones';
import { ReviewMode, RoleBadge } from '../components/ReviewMode';
import type { ReviewStep } from '../types';
import { Empty, KindDot, Segmented, SymbolIcon } from '../components/ui';

type Tab = 'files' | 'preview';

// --- review-mode: your own work (author) or another branch / pull request (reviewer) ---
function RoleToggle() {
  const role = useStore((s) => s.changesRole);
  return (
    <div className="row" style={{ marginBottom: 12 }}>
      <Segmented
        value={role}
        onChange={setChangesRole}
        options={[
          { value: 'author', label: 'Author', title: 'Your own work: uncommitted changes or your branch' },
          { value: 'reviewer', label: 'Reviewer', title: 'Review any branch or fetched pull request in reading order, without checking it out' },
        ]}
      />
    </div>
  );
}
// --- /review-mode ---

export function ChangesView() {
  const model = useModel();
  const live = useStore((s) => s.live);
  const liveFeedSize = useStore((s) => s.liveFeed.length + s.liveOpen.length);
  const selection = useStore((s) => s.selection);
  const { data } = model;
  const c = data.changes;
  const [tab, setTab] = useState<Tab>('files');
  const [expanded, setExpanded] = useState<string | null>(null);
  const markdown = useMemo(() => (c ? prSummaryMarkdown(data) : ''), [data, c]);
  const role = useStore((s) => s.changesRole);

  if (!data.git) {
    return (
      <Empty icon={GitPullRequestArrow} title="Not a git repository">
        Change review needs git. Run code-visualizer inside a git repository.
      </Empty>
    );
  }
  // --- review-mode (a deep link to Reviewer in a static report explains that it needs `serve`) ---
  if (role === 'reviewer') {
    return (
      <div className="page" style={{ maxWidth: 1440 }}>
        <RoleToggle />
        <ReviewMode />
      </div>
    );
  }
  // --- /review-mode ---
  if (!c || !c.files.length) {
    return (
      <>
        {live && (
          <div className="page" style={{ paddingBottom: 0 }}>
            <RoleToggle />
          </div>
        )}
        <Empty icon={ShieldCheck} title="No changes to review">
          {c?.mode === 'branch' ? `Your branch has no changes compared to ${c.base}.` : 'Your working tree is clean.'} Edit some code
          {live ? ' — this page updates by itself.' : ' and generate the report again (or run `npx code-visualizer serve` for a live view).'}
        </Empty>
        {/* --- live-guard: the session's feed survives a commit --- */}
        {live && liveFeedSize > 0 && (
          <div className="page" style={{ paddingTop: 0 }}>
            <LiveFeedCard />
          </div>
        )}
        {/* --- /live-guard --- */}
      </>
    );
  }

  const routeById = model.routeById;
  const routeLabels = new Set<string>();
  const affectedRoutes = c.impactedRoutes
    .map((id) => routeById.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .filter((r) => {
      const label = `${r.method} ${r.path}`;
      if (routeLabels.has(label)) return false;
      routeLabels.add(label);
      return true;
    });
  const impactedFiles = c.impacted
    .map((id) => model.fileById.get(id))
    .filter((f): f is NonNullable<typeof f> => !!f)
    .sort((a, b) => b.metrics.importance - a.metrics.importance);
  const changedIds = c.files.filter((f) => f.analyzed).map((f) => f.id);
  const nonSource = c.files.filter((f) => !f.analyzed);
  // --- test-intelligence: comment-only edits need no test; handlers a test requests over HTTP are tested ---
  const commentOnly = new Set(c.commentOnly ?? []);
  const overHttp = httpTestedFiles(data);
  // The same rule as the PR description and the MCP review_changes tool.
  const untestedIds = new Set(untestedChanges(data));
  const untested = c.files.filter((f) => untestedIds.has(f.id));
  const patch = c.coverage;
  const patchColor = patch ? (patch.pct >= 80 ? 'var(--success)' : patch.pct >= 50 ? 'var(--warning)' : 'var(--danger)') : undefined;
  // --- /test-intelligence ---
  // Related changes (connected through imports) are reviewed together; the rest are independent.
  const related = c.clusters.filter((g) => g.length > 1);
  const singles = c.clusters.filter((g) => g.length === 1).flat();
  // --- review-mode: files in reading order (dependencies first, each test after its code) when available ---
  const order = c.readingOrder ?? [];
  const stepByFile = new Map<string, ReviewStep>(order.map((st) => [st.file, st]));
  const groupInfo = new Map((c.readingGroups ?? []).map((g) => [g.index, g]));
  const readingGroups: { label: string; files: string[] }[] = [];
  for (const st of order) {
    const last = readingGroups[readingGroups.length - 1];
    if (last && stepByFile.get(last.files[0])?.group === st.group) last.files.push(st.file);
    else readingGroups.push({ label: '', files: [st.file] });
  }
  readingGroups.forEach((g, i) => {
    const info = groupInfo.get(stepByFile.get(g.files[0])!.group);
    const otherOnly = info ? info.kind === 'other' : g.files.every((id) => ['config', 'other'].includes(stepByFile.get(id)!.role) && !model.fileById.has(id)) && i === readingGroups.length - 1 && i > 0;
    g.label = otherOnly ? 'Configuration and other files' : `Part ${i + 1} · ${plural(g.files.length, 'file')}`;
  });
  if (order.length) {
    // Only what the plan skimmed is "skim"; files past the reading order's limit still need reading.
    const skimReasons = new Map((c.readingSkim ?? []).map((s) => [s.file, s.reason]));
    const rest = c.files.filter((f) => !stepByFile.has(f.id)).map((f) => f.id);
    const skimmed = c.readingSkim ? rest.filter((id) => skimReasons.has(id)) : rest;
    const unordered = c.readingSkim ? rest.filter((id) => !skimReasons.has(id)) : [];
    if (unordered.length) readingGroups.push({ label: `More files (not in the reading order) · ${plural(unordered.length, 'file')}`, files: unordered });
    if (skimmed.length) readingGroups.push({ label: 'Skim: lockfiles, generated files, renames, comment-only edits', files: skimmed });
  }
  // --- /review-mode ---
  const groups = order.length
    ? readingGroups
    : [
        ...related.map((g, i) => ({ label: `Group ${i + 1} · ${plural(g.length, 'related file')}`, files: g })),
        ...(singles.length ? [{ label: related.length ? 'Independent changes' : 'Changes', files: singles }] : []),
      ];
  // query-core: edits that only touch comments affect nothing; `symbol` precision counts only real users of the changed declarations.
  const bySymbol = c.impactPrecision === 'symbol';
  const symbolsByFile = new Map<string, typeof c.symbols>();
  for (const s of c.symbols) symbolsByFile.set(s.file, [...(symbolsByFile.get(s.file) ?? []), s]);

  const fileRow = (id: string) => {
    const f = model.changed.get(id)!;
    const info = model.fileById.get(id);
    const syms = symbolsByFile.get(id) ?? [];
    const isOpen = expanded === id;
    const step = stepByFile.get(id);
    return (
      <div key={id} style={{ borderBottom: '1px solid var(--border)' }}>
        <div className={`list-item changed-file${selection?.type === 'file' && selection.id === id ? ' active' : ''}`} style={{ borderRadius: 0, padding: '8px 14px' }} onClick={() => (info ? selectFile(id) : f.diff && setExpanded(isOpen ? null : id))}>
          {step && <span className="mono tiny faint review-order">{step.order}.</span>}
          <StatusBadge status={f.status} />
          {step ? <RoleBadge role={step.role} /> : info && <KindDot kind={info.kind} />}
          <div className="changed-file-main">
            <div className="mono small truncate changed-file-path" style={{ color: 'var(--text)' }}>
              {f.oldPath ? `${f.oldPath} → ` : ''}
              {id}
            </div>
            {syms.length > 0 && (
              <div className="tags" style={{ marginTop: 5 }}>
                {syms.slice(0, 6).map((s) => (
                  <button
                    key={s.id}
                    className="tag link"
                    onClick={(e) => {
                      e.stopPropagation();
                      selectSymbol(s.id);
                    }}
                    title={s.usedBy ? `Used by ${s.usedBy}` : 'Not used elsewhere'}
                  >
                    {s.name}
                    {s.usedBy ? ` · ${s.usedBy}↑` : ''}
                  </button>
                ))}
                {syms.length > 6 && <span className="tiny faint">+{syms.length - 6}</span>}
              </div>
            )}
            {step && step.reasons.length > 0 && (
              <div className="tiny muted" style={{ marginTop: 4 }}>
                {step.reasons.join(' · ')}
              </div>
            )}
          </div>
          {commentOnly.has(id) && (
            <span className="badge info" title="Only comments or blank lines changed: nothing that uses this file is affected">
              comment-only
            </span>
          )}
          {info?.tests?.length ? (
            <span className="badge success" title={info.tests.join('\n')}>
              <TestTube2 size={11} /> {info.tests.length}
            </span>
          ) : info && overHttp.has(id) ? (
            <span className="badge success" title="A test requests or visits a route whose code uses this file (over HTTP)">
              <TestTube2 size={11} /> http
            </span>
          ) : untestedIds.has(id) ? (
            <span className="badge warn" title="No test reaches this file">
              no tests
            </span>
          ) : null}
          {info?.owners?.length ? <span className="tiny faint desktop-only">{info.owners[0]}</span> : null}
          <PlusMinus add={f.additions} del={f.deletions} />
          {f.diff && (
            <button
              className={`btn ghost icon sm${isOpen ? ' active' : ''}`}
              title="Show diff"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(isOpen ? null : id);
              }}
            >
              <Eye size={14} />
            </button>
          )}
        </div>
        {isOpen && f.diff && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            <DiffView diff={f.diff} maxHeight={480} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="page" style={{ maxWidth: 1440 }}>
      {/* --- review-mode --- */}
      {live && <RoleToggle />}
      {/* --- /review-mode --- */}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="row change-head" style={{ gap: 18, alignItems: 'center', flexWrap: 'nowrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row small muted" style={{ gap: 8 }}>
                <GitPullRequestArrow size={15} />
                {c.mode === 'branch' ? (
                  <span>
                    <strong style={{ color: 'var(--text)' }}>{data.git.branch}</strong> compared to <strong style={{ color: 'var(--text)' }}>{c.base}</strong>
                    {c.baseCommit ? <span className="faint mono"> (since {c.baseCommit.slice(0, 7)})</span> : null} · includes uncommitted edits
                  </span>
                ) : (
                  <span>
                    Uncommitted changes on <strong style={{ color: 'var(--text)' }}>{data.git.branch}</strong>
                  </span>
                )}
                {live && (
                  <span className={`live-badge${live.connected ? '' : ' off'}`}>
                    <span className="live-dot" /> live
                  </span>
                )}
              </div>
              <div className="row" style={{ gap: 26, marginTop: 12 }}>
                <div className="kpi">
                  <span className="v">{c.files.length}</span>
                  <span className="l">
                    files · <PlusMinus add={c.additions} del={c.deletions} />
                  </span>
                </div>
                {c.mode === 'branch' && (
                  <div className="kpi">
                    <span className="v">{c.commits.length}</span>
                    <span className="l">commits</span>
                  </div>
                )}
                <div className="kpi">
                  <span className="v">{c.symbols.length}</span>
                  <span className="l">functions & components touched</span>
                </div>
                <div className="kpi">
                  <span className="v">{fmtNum(c.impacted.length)}</span>
                  <span className="l" title={bySymbol ? 'Only files that use the changed functions, components or types' : 'Every file that imports a changed file'}>
                    files affected{bySymbol ? ' · by symbol' : ''}
                  </span>
                </div>
                <div className="kpi">
                  <span className="v">{affectedRoutes.length}</span>
                  <span className="l">routes affected</span>
                </div>
                <div className="kpi">
                  <span className="v">{c.tests.files.length}</span>
                  <span className="l">tests to run</span>
                </div>
                {/* --- test-intelligence: patch coverage chip --- */}
                {patch && patch.coverable > 0 && (
                  <div
                    className="kpi"
                    title={`${patch.covered} of ${patch.coverable} added executable lines ran in a test · ${patch.report} from ${reportAge(patch.reportDate)}${patch.stale ? ' — older than your changes, rerun the tests with coverage' : ''}`}
                  >
                    <span className="v" style={{ color: patchColor }}>
                      {formatPct(patch.pct)}
                    </span>
                    <span className="l">
                      patch coverage{patch.stale ? ' · outdated' : ''}
                    </span>
                  </div>
                )}
                {/* --- /test-intelligence --- */}
              </div>
            </div>
            <div className="risk-box" style={{ width: 240, flexShrink: 0 }}>
              <div className="row nowrap" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="small" style={{ fontWeight: 650 }}>
                  Risk: <span style={{ color: riskColor(c.risk.level), textTransform: 'capitalize' }}>{c.risk.level}</span>
                </span>
                <span className="tiny faint">{c.risk.score}/100</span>
              </div>
              <div className="risk-meter">
                <span style={{ left: `calc(${c.risk.score}% - 2px)` }} />
              </div>
              <div className="stack" style={{ gap: 3, marginTop: 10 }}>
                {c.risk.factors.slice(0, 4).map((f) => (
                  <div key={f.label} className="row nowrap tiny muted" style={{ justifyContent: 'space-between' }}>
                    <span className="truncate">{f.label}</span>
                    <span className="faint">+{f.points}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <CopyMarkdownButton label="Copy PR description" getText={() => markdown} primary />
            <button className="btn" onClick={() => showInGraph(changedIds, 'changes')}>
              <Radar size={14} /> Show blast radius
            </button>
            {c.tests.command && <CopyMarkdownButton label="Copy test command" getText={() => c.tests.command!} />}
            <span className="spacer" />
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'files', label: 'Changes' },
                { value: 'preview', label: 'PR description' },
              ]}
            />
          </div>
        </div>
      </section>

      {tab === 'preview' ? (
        <section className="card card-pad">
          <div className="small muted" style={{ marginBottom: 12 }}>
            Paste this into your pull request. It is plain GitHub-flavoured Markdown (the diagram renders on GitHub and GitLab).
          </div>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 14, borderRadius: 10, background: 'var(--code-bg)', border: '1px solid var(--border)', maxHeight: 640, overflow: 'auto' }}>
            {markdown}
          </pre>
        </section>
      ) : (
        <div className="grid review">
          <div className="stack">
            <section className="card">
              <div className="card-head">
                <FileCode2 size={15} className="muted" />
                <h3>Changed files</h3>
                <span className="tiny faint">
                  {order.length
                    ? 'in reading order: dependencies first, each test after its code'
                    : related.length
                      ? `${plural(related.length, 'group')} of files that depend on each other — review each group together`
                      : ''}
                </span>
              </div>
              {groups.map((g, i) => (
                <div key={g.label}>
                  {groups.length > 1 && (
                    <div className="day-header" style={{ paddingTop: i ? 16 : 10 }}>
                      {g.label}
                    </div>
                  )}
                  {g.files.map(fileRow)}
                </div>
              ))}
              {nonSource.length > 0 && !order.length && (
                <>
                  <div className="day-header">Other files</div>
                  {nonSource.map((f) => (
                    <div key={f.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="list-item" style={{ borderRadius: 0, padding: '7px 14px', cursor: f.diff ? 'pointer' : 'default' }} onClick={() => f.diff && setExpanded(expanded === f.id ? null : f.id)}>
                        <StatusBadge status={f.status} />
                        <span className="mono small truncate" style={{ flex: 1 }}>
                          {f.id}
                        </span>
                        <PlusMinus add={f.additions} del={f.deletions} />
                      </div>
                      {expanded === f.id && f.diff && <DiffView diff={f.diff} maxHeight={420} />}
                    </div>
                  ))}
                </>
              )}
            </section>
            {/* --- live-guard: what got worse or better with every save --- */}
            {live && <LiveFeedCard />}
            {/* --- /live-guard --- */}
          </div>

          <div className="stack">
            {/* --- live-guard: the architecture delta of your work --- */}
            {c.delta && <ArchitectureDeltaCard delta={c.delta} />}
            {/* --- /live-guard --- */}
            {/* --- clone-radar: you changed one copy, not its clones --- */}
            {c.cloneDrift?.length ? <CloneDriftCard drift={c.cloneDrift} /> : null}
            {/* --- /clone-radar --- */}

            <section className="card">
              <div className="card-head">
                <Radar size={15} className="muted" />
                <h3>Impact</h3>
                <span className="spacer" />
                <button className="btn ghost sm" onClick={() => showInGraph(changedIds, 'changes')}>
                  Graph <ArrowRight size={12} />
                </button>
              </div>
              <div className="card-body stack" style={{ gap: 12 }}>
                <div className="small muted">
                  {c.impacted.length
                    ? bySymbol
                      ? `${plural(c.impacted.length, 'file')} use the changed declarations directly or indirectly.`
                      : `${plural(c.impacted.length, 'file')} import your changes directly or indirectly.`
                    : commentOnly.size && changedIds.every((id) => commentOnly.has(id))
                      ? 'Only comments changed: nothing else is affected.'
                      : 'Nothing else imports the changed files.'}
                </div>
                {affectedRoutes.length > 0 && (
                  <div className="list">
                    {affectedRoutes.slice(0, 10).map((r) => (
                      <button key={r.id} className="list-item" style={{ padding: '5px 8px' }} onClick={() => select({ type: 'route', id: r.id })}>
                        <span className="method" style={{ ['--m' as string]: METHOD_COLORS[r.method] }}>
                          {r.method}
                        </span>
                        <span className="mono small truncate">{r.path}</span>
                      </button>
                    ))}
                    {affectedRoutes.length > 10 && <span className="tiny faint" style={{ padding: '2px 8px' }}>+ {affectedRoutes.length - 10} more routes</span>}
                  </div>
                )}
                {impactedFiles.length > 0 && (
                  <div className="list">
                    {impactedFiles.slice(0, 8).map((f) => (
                      <button key={f.id} className="list-item" style={{ padding: '5px 8px' }} onClick={() => selectFile(f.id)}>
                        <KindDot kind={f.kind} />
                        <span className="mono small truncate" style={{ flex: 1 }}>
                          {f.id}
                        </span>
                        {f.isEntry && <span className="badge accent">entry</span>}
                      </button>
                    ))}
                    {impactedFiles.length > 8 && <span className="tiny faint" style={{ padding: '2px 8px' }}>+ {impactedFiles.length - 8} more files</span>}
                  </div>
                )}
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <TestTube2 size={15} className="muted" />
                <h3>Tests to run</h3>
                <span className="tiny faint">{c.tests.runner}</span>
              </div>
              <div className="card-body stack" style={{ gap: 10 }}>
                {c.tests.files.length ? (
                  <>
                    <div className="list">
                      {c.tests.files.slice(0, 10).map((t) => (
                        <button key={t} className="list-item" style={{ padding: '5px 8px' }} onClick={() => selectFile(t)}>
                          <KindDot kind="test" />
                          <span className="mono small truncate" style={{ flex: 1 }}>
                            {t}
                          </span>
                          {c.tests.changedTests.includes(t) && <span className="badge info">changed</span>}
                        </button>
                      ))}
                    </div>
                    {c.tests.command && (
                      <div className="row nowrap" style={{ gap: 6 }}>
                        <code className="mono tiny truncate" style={{ flex: 1, padding: '6px 8px', borderRadius: 7, background: 'var(--code-bg)', border: '1px solid var(--border)' }} title={c.tests.command}>
                          {c.tests.command}
                        </code>
                        <CopyMarkdownButton label="Copy" getText={() => c.tests.command!} small />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="small muted">No test file reaches the changed code through imports.</div>
                )}
                {/* --- test-intelligence: changed lines no test ran --- */}
                {patch && patch.files.some((f) => f.uncovered.length) && (
                  <div className="stack" style={{ gap: 4 }}>
                    <div className="tiny faint">
                      Changed lines no test ran ({patch.coverable - patch.covered} of {patch.coverable}, report from {reportAge(patch.reportDate)}):
                    </div>
                    {patch.files
                      .filter((f) => f.uncovered.length)
                      .slice(0, 6)
                      .map((f) => (
                        <button key={f.file} className="list-item" style={{ padding: '4px 8px' }} onClick={() => selectFile(f.file, f.uncovered[0][0])}>
                          <span className="mono small truncate" style={{ flex: 1 }}>
                            {basename(f.file)}
                          </span>
                          <span className="tiny mono" style={{ color: 'var(--danger)' }}>
                            {formatRanges(f.uncovered, 3)}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
                {patch?.unmeasured?.length ? (
                  <div className="tiny faint" title={patch.unmeasured.join('\n')}>
                    Not measured (no coverage report for their package): {patch.unmeasured.slice(0, 3).map(basename).join(', ')}
                    {patch.unmeasured.length > 3 ? ', …' : ''}
                  </div>
                ) : null}
                {/* --- /test-intelligence --- */}
                {untested.length > 0 && (
                  <div className="row small" style={{ gap: 8, color: 'var(--warning)', alignItems: 'flex-start' }}>
                    <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
                    <span>
                      Not covered by any test:{' '}
                      {untested.slice(0, 5).map((f, i) => (
                        <span key={f.id}>
                          {i > 0 && ', '}
                          <a onClick={() => selectFile(f.id)} className="mono">
                            {basename(f.id)}
                          </a>
                        </span>
                      ))}
                      {untested.length > 5 ? ` and ${untested.length - 5} more` : ''}
                    </span>
                  </div>
                )}
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <Users size={15} className="muted" />
                <h3>Who should review</h3>
              </div>
              <div className="card-body stack" style={{ gap: 10 }}>
                {c.reviewers.length ? (
                  c.reviewers.map((r) => (
                    <div key={r.name} className="row nowrap" style={{ gap: 10 }}>
                      <Avatar name={r.name} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="small" style={{ fontWeight: 600 }}>
                          {r.name}
                        </div>
                        <div className="tiny faint">
                          knows {plural(r.files, 'changed file')} · last active {timeAgo(r.last)}
                        </div>
                      </div>
                      <div className="bar" style={{ maxWidth: 70 }}>
                        <span style={{ width: `${Math.min(100, (r.score / c.reviewers[0].score) * 100)}%` }} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="small muted">Nobody else has history in these files yet.</div>
                )}
                {c.owners.length > 0 && (
                  <div>
                    <div className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 650, margin: '6px 0' }}>
                      Code owners
                    </div>
                    <div className="tags">
                      {c.owners.map((o) => (
                        <span key={o.owner} className="tag" title={o.files.join('\n')}>
                          {o.owner} · {o.files.length}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {c.commits.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <GitCommitHorizontal size={15} className="muted" />
                  <h3>Commits on this branch</h3>
                </div>
                <div style={{ padding: 6 }}>
                  {c.commits.slice(0, 12).map((m) => (
                    <div key={m.hash} className="commit-row" onClick={() => m.paths.length && showInGraph(m.paths, 'files')}>
                      <Avatar name={m.author} size="sm" />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="small truncate" style={{ fontWeight: 550 }}>
                          {m.subject}
                        </div>
                        <div className="tiny faint">
                          {m.author} · {timeAgo(m.date)} · <span className="mono">{m.hash.slice(0, 7)}</span>
                        </div>
                      </div>
                      <PlusMinus add={m.additions} del={m.deletions} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {c.symbols.some((s) => s.usedBy > 0) && (
              <section className="card">
                <div className="card-head">
                  <h3>Most widely used code you touched</h3>
                </div>
                <div style={{ padding: 6 }}>
                  {c.symbols
                    .filter((s) => s.usedBy > 0)
                    .slice(0, 8)
                    .map((s) => (
                      <div key={s.id} className="sym-row" onClick={() => selectSymbol(s.id)}>
                        <SymbolIcon kind={s.kind === 'method' ? 'function' : s.kind} method={s.kind === 'method'} />
                        <span className="name">{s.name}</span>
                        <span className="faint tiny truncate">{basename(s.file)}</span>
                        <span className="line">used by {s.usedBy}</span>
                      </div>
                    ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
