import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bot, Eye, GitBranch, GitCommitHorizontal, ListChecks, Play, RefreshCw, Split, TestTube2, Timer } from 'lucide-react';
import { useModel } from '../data/context';
import { fetchReview, fetchReviewRefs, fetchReviewState, ReviewError, saveReviewViewed } from '../data/live';
import { reviewPlanMarkdown } from '../../../src/shared/markdown';
import { effortTime, independentChanges, suggestsSplit } from '../../../src/shared/review';
import { basename, plural, timeAgo } from '../lib/format';
import { selectFile, selectSymbol, setReview, toast, useStore } from '../state/store';
import type { ReviewPlan, ReviewRef, ReviewRole, ReviewStep } from '../types';
import { ArchitectureDeltaCard } from './ArchitectureDelta';
import { Avatar, CopyMarkdownButton, DiffView, PlusMinus, StatusBadge } from './companion';
import { Empty, Toggle } from './ui';

/**
 * Reviewer mode of My changes (review-mode): any branch or fetched pull request in reading order —
 * start here, independent parts, each file's reason, diffs, and per-file "viewed" checkboxes that
 * reset when the author changes the file. j / k move through the steps, v marks the current one viewed.
 */

const ROLE_STYLE: Record<ReviewRole, { label: string; className: string; title: string }> = {
  contract: { label: 'contract', className: 'badge accent', title: 'Types, schemas and contracts: read them first' },
  core: { label: 'core', className: 'badge info', title: 'Logic the other changed files build on' },
  consumer: { label: 'consumer', className: 'badge outline', title: 'Uses the other changes (pages, controllers, components…)' },
  test: { label: 'test', className: 'badge success', title: 'Tests of the code right before it' },
  config: { label: 'config', className: 'badge warn', title: 'Configuration' },
  mechanical: { label: 'skim', className: 'badge outline', title: 'Only needs a glance' },
  other: { label: 'other', className: 'badge outline', title: 'Documentation, styles, assets' },
};

export function RoleBadge({ role }: { role: ReviewRole }) {
  const s = ROLE_STYLE[role];
  return (
    <span className={s.className} title={s.title} style={{ minWidth: 62, justifyContent: 'center' }}>
      {s.label}
    </span>
  );
}

/** Inputs that take typed text: checkboxes, radios and buttons do not (j / k keep working after a click). */
const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/;

const isTyping = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT') return TEXT_INPUT.test((el as HTMLInputElement).type || 'text');
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};

/** Enter on a focused control (a button, link, toggle or checkbox) belongs to that control, not to the review path. */
const ownsEnter = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('button, a, summary, input, select, textarea, [role="button"], [role="switch"], [role="tab"], [role="checkbox"], [contenteditable="true"]');
};

function RefPicker({ refs, value, onPick }: { refs: ReviewRef[] | undefined; value?: string; onPick: (ref: string) => void }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const agents = (refs ?? []).filter((r) => r.agent);
  const others = (refs ?? []).filter((r) => !r.agent);
  const option = (r: ReviewRef) => (
    <option key={r.name} value={r.ref}>
      {r.ref}
      {r.current ? ' (checked out)' : ''} — {r.author}, {timeAgo(r.date)}
    </option>
  );
  return (
    <div className="row review-picker">
      <GitBranch size={15} className="muted" style={{ flexShrink: 0 }} />
      <select className="select" value={refs?.some((r) => r.ref === value) ? value : ''} onChange={(e) => e.target.value && onPick(e.target.value)} title="Branches and fetched pull requests updated in the last 14 days">
        <option value="">{refs === undefined ? 'Loading branches…' : refs.length ? 'Pick a branch to review…' : 'No branches updated in the last 14 days'}</option>
        {agents.length > 0 && <optgroup label="Agent branches">{agents.map(option)}</optgroup>}
        {others.length > 0 && <optgroup label="Recent branches">{others.map(option)}</optgroup>}
      </select>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onPick(text.trim());
        }}
      >
        <input className="input mono small" value={text} onChange={(e) => setText(e.target.value)} placeholder="any ref, #123 or !45" aria-label="Ref to review" />
        <button className="btn sm" type="submit" disabled={!text.trim()}>
          Review
        </button>
      </form>
    </div>
  );
}

function StepRow({
  step,
  active,
  open,
  diff,
  onActivate,
  onToggleDiff,
  onViewed,
}: {
  step: ReviewStep;
  active: boolean;
  open: boolean;
  diff?: string;
  onActivate: () => void;
  onToggleDiff: () => void;
  onViewed: (viewed: boolean) => void;
}) {
  const model = useModel();
  const known = model.fileById.has(step.file);
  return (
    <div id={`review-step-${step.order}`} className="review-step-anchor" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className={`list-item review-step${active ? ' active' : ''}`} style={{ borderRadius: 0, padding: '8px 14px', alignItems: 'flex-start' }} onClick={onActivate}>
        <input
          type="checkbox"
          checked={!!step.viewed}
          title={step.viewed ? 'Viewed (resets when the file changes)' : 'Mark as viewed (v)'}
          onClick={(e) => {
            e.stopPropagation();
            onActivate();
          }}
          onChange={(e) => {
            onViewed(e.target.checked);
            // Keep j / k / v working: the keyboard belongs to the review path, not the checkbox.
            e.currentTarget.blur();
          }}
          style={{ marginTop: 3 }}
          aria-label={`Viewed ${step.file}`}
        />
        <span className="mono tiny faint" style={{ width: 24, textAlign: 'right', marginTop: 3, flexShrink: 0 }}>
          {step.order}.
        </span>
        <RoleBadge role={step.role} />
        <div className="review-step-main" style={{ opacity: step.viewed ? 0.6 : 1 }}>
          <div className="row nowrap" style={{ gap: 6 }}>
            {step.status && <StatusBadge status={step.status} />}
            <span
              className={`mono small truncate${known ? ' link' : ''}`}
              style={{ color: 'var(--text)' }}
              title={`${step.oldPath ? `${step.oldPath} → ${step.file}` : step.file}${known ? '\nOpens the version in your working tree (the diff shows the reviewed one)' : ''}`}
              onClick={(e) => {
                if (!known) return;
                e.stopPropagation();
                selectFile(step.file);
              }}
            >
              {step.file}
            </span>
          </div>
          {step.reasons.length > 0 && <div className="tiny muted" style={{ marginTop: 3 }}>{step.reasons.join(' · ')}</div>}
        </div>
        {step.tests?.length ? (
          <span className="badge success" title={step.tests.join('\n')}>
            <TestTube2 size={11} /> {step.tests.length}
          </span>
        ) : null}
        <PlusMinus add={step.additions ?? 0} del={step.deletions ?? 0} />
        {diff && (
          <button
            className={`btn ghost icon sm${open ? ' active' : ''}`}
            title="Show diff (Enter)"
            onClick={(e) => {
              e.stopPropagation();
              onToggleDiff();
            }}
          >
            <Eye size={14} />
          </button>
        )}
      </div>
      {open && diff && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <DiffView diff={diff} maxHeight={520} />
        </div>
      )}
    </div>
  );
}

export function ReviewMode() {
  const review = useStore((s) => s.review);
  const live = useStore((s) => s.live);
  const [refs, setRefs] = useState<ReviewRef[] | undefined>();
  const [plan, setPlan] = useState<ReviewPlan | undefined>();
  const [error, setError] = useState<ReviewError | undefined>();
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  /** j / k moves: the step is scrolled to after its diff rendered. */
  const [jump, setJump] = useState(0);
  const requested = useRef('');

  // Branches are listed again after every live update (commits, fetches, branch switches)…
  useEffect(() => {
    void fetchReviewRefs().then(setRefs);
  }, [live?.version]);
  // …and the plan is reloaded in the background when the reviewed branch moved.
  useEffect(() => {
    const moved = review && plan?.head && refs?.find((r) => r.ref === review.ref && r.commit !== plan.head);
    if (moved) setReload((n) => n + 1);
  }, [refs]);
  // A fetch in the terminal does not touch the working tree (no live update): check the ref again when
  // you come back to the page, and pick up files marked as viewed in another tab.
  useEffect(() => {
    if (!review || !plan?.head) return;
    const check = (): void => {
      if (document.visibilityState === 'hidden') return;
      void fetchReviewState(review.ref).then((state) => {
        if (!state) return;
        if (state.commit !== plan.head) setReload((n) => n + 1);
        else {
          const now = new Set(state.viewed);
          setPlan((p) => p && { ...p, steps: p.steps.map((st) => ({ ...st, viewed: now.has(st.file) || undefined })), skim: p.skim.map((st) => ({ ...st, viewed: now.has(st.file) || undefined })) });
        }
      });
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [review?.ref, plan?.head]);

  // Load the plan of the ref (a new ref starts from the top; a reload keeps your place).
  useEffect(() => {
    if (!review) {
      setPlan(undefined);
      setError(undefined);
      return;
    }
    const key = `${review.ref}\0${review.base ?? ''}\0${review.testFirst ? 1 : 0}`;
    const fresh = requested.current !== key;
    requested.current = key;
    if (fresh) {
      setLoading(true);
      setPlan(undefined);
      setActive(0);
      setOpen(new Set());
    }
    setError(undefined);
    let cancelled = false;
    fetchReview(review.ref, { base: review.base, testFirst: review.testFirst })
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        // A reload may have fewer steps: stay on the last one.
        setActive((a) => Math.min(a, Math.max(0, p.steps.length - 1)));
        if (fresh && p.steps[0]) setOpen(new Set([p.steps[0].file]));
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof ReviewError ? e : new ReviewError((e as Error).message)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [review?.ref, review?.base, review?.testFirst, reload]);

  const diffs = useMemo(() => new Map((plan?.files ?? []).map((f) => [f.id, f.diff])), [plan]);
  const markdown = useMemo(() => (plan ? reviewPlanMarkdown(plan) : ''), [plan]);

  const setViewed = async (files: string[], viewed: boolean): Promise<void> => {
    if (!plan || !review || !files.length) return;
    const apply = (p: ReviewPlan, set: (file: string) => boolean | undefined): ReviewPlan => ({
      ...p,
      steps: p.steps.map((s) => (files.includes(s.file) ? { ...s, viewed: set(s.file) } : s)),
      skim: p.skim.map((s) => (files.includes(s.file) ? { ...s, viewed: set(s.file) } : s)),
    });
    setPlan((p) => p && apply(p, () => viewed || undefined));
    try {
      // The version on screen is the one marked (the branch may have moved since the page loaded).
      const state = await saveReviewViewed(
        review.ref,
        Object.fromEntries(files.map((f) => [f, viewed])),
        { head: plan.head, base: review.base },
      );
      const now = new Set(state.viewed);
      setPlan((p) => p && apply(p, (f) => now.has(f) || undefined));
      if (plan.head && state.commit !== plan.head) {
        toast(`${review.ref} has new commits: reloaded the review path (files changed since are unviewed)`);
        setReload((n) => n + 1);
      }
    } catch (e) {
      setPlan((p) => p && apply(p, () => !viewed || undefined));
      toast(`Could not save: ${(e as Error).message}`, { tone: 'error' });
    }
  };

  // After j / k: the step at the top of the view, its diff (opened by the move, now rendered) below it.
  useEffect(() => {
    if (!jump || !plan) return;
    const step = plan.steps[Math.max(0, Math.min(plan.steps.length - 1, active))];
    if (step) document.getElementById(`review-step-${step.order}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [jump]); // eslint-disable-line react-hooks/exhaustive-deps

  // j / k: next / previous step (its diff opens), v: toggle viewed, Enter: toggle the diff.
  useEffect(() => {
    if (!plan?.steps.length) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const steps = plan.steps;
      const current = Math.max(0, Math.min(steps.length - 1, active));
      const move = (to: number): void => {
        const next = Math.max(0, Math.min(steps.length - 1, to));
        setActive(next);
        setOpen((o) => new Set([...o, steps[next].file]));
        // Scrolled once its diff has rendered (see below): measured now, the step would land off screen.
        setJump((n) => n + 1);
      };
      if (e.key === 'j') move(current + 1);
      else if (e.key === 'k') move(current - 1);
      else if (e.key === 'v') void setViewed([steps[current].file], !steps[current].viewed);
      else if (e.key === 'Enter') {
        // A focused button, link or toggle handles Enter itself.
        if (ownsEnter(e.target)) return;
        const file = steps[current].file;
        setOpen((o) => {
          const next = new Set(o);
          if (next.has(file)) next.delete(file);
          else next.add(file);
          return next;
        });
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!live) {
    return (
      <Empty icon={GitBranch} title="Reviewing needs the live companion">
        Run <code>npx code-visualizer review &lt;branch&gt; --open</code> (or <code>serve</code>) to review any branch or pull request here, or{' '}
        <code>npx code-visualizer review &lt;branch&gt;</code> in the terminal.
      </Empty>
    );
  }

  const pick = (ref: string): void => setReview({ ref, base: review?.base, testFirst: review?.testFirst });
  const parts = plan ? independentChanges(plan) : [];
  const viewedCount = plan ? plan.steps.filter((s) => s.viewed).length : 0;
  const reviewers = plan?.commits?.length ? [...new Set(plan.commits.map((c) => c.author))] : [];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <section className="card">
        <div className="card-body stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10, rowGap: 8 }}>
            <RefPicker refs={refs} value={review?.ref} onPick={pick} />
            <Toggle checked={!!review?.testFirst} onChange={(testFirst) => review && setReview({ ...review, testFirst: testFirst || undefined })} label="Tests first" title="Read each test before the code it covers" />
          </div>
          {plan && (
            <div className="row" style={{ gap: 26, alignItems: 'center' }}>
              <div className="kpi">
                <span className="v">
                  <Timer size={16} className="muted" /> {effortTime(plan.effort)}
                </span>
                <span className="l">
                  level {plan.effort.level}/5 · {plural(plan.effort.meaningfulLines, 'meaningful line')}
                </span>
              </div>
              <div className="kpi">
                <span className="v">{plan.steps.length}</span>
                <span className="l">
                  files to read{plan.skim.length ? ` · ${plan.skim.length} to skim` : ''}
                  {plan.additions !== undefined && (
                    <>
                      {' · '}
                      <PlusMinus add={plan.additions} del={plan.deletions ?? 0} />
                    </>
                  )}
                </span>
              </div>
              <div className="kpi">
                <span className="v">{plan.commits?.length ?? 0}</span>
                <span className="l">commits since {plan.mergeBase.slice(0, 7)}</span>
              </div>
              <div className="kpi" style={{ minWidth: 140 }}>
                <span className="v">
                  {viewedCount}/{plan.steps.length}
                </span>
                <span className="l">viewed</span>
                <div className="bar" style={{ marginTop: 4 }}>
                  <span style={{ width: `${plan.steps.length ? (viewedCount / plan.steps.length) * 100 : 0}%` }} />
                </div>
              </div>
              <span className="spacer" />
              <span className="small muted">
                <strong style={{ color: 'var(--text)' }}>{plan.ref}</strong> compared to <strong style={{ color: 'var(--text)' }}>{plan.base}</strong>
              </span>
              <CopyMarkdownButton label="Copy review checklist" getText={() => markdown} />
            </div>
          )}
          {loading && !plan && (
            <div className="row small muted" style={{ gap: 8 }}>
              <RefreshCw size={14} className="spin" /> Analyzing {review?.ref} without checking it out…
            </div>
          )}
          {error && (
            <div className="row small" style={{ gap: 8, color: 'var(--danger)', alignItems: 'flex-start' }}>
              <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>
                {error.message}
                {error.fetch && (
                  <>
                    {' '}
                    <CopyMarkdownButton label="Copy fetch command" getText={() => error.fetch!} small />
                  </>
                )}
              </span>
            </div>
          )}
          {!review && !error && <div className="small muted">Pick a branch or pull request: you get a reading order with a reason for every file, what to skim, the effort, and viewed checkboxes. Nothing is checked out.</div>}
        </div>
      </section>

      {plan && !plan.steps.length && !plan.skim.length && (
        <Empty icon={ListChecks} title="Nothing to review">
          {plan.ref} has no changes compared to {plan.base}.
        </Empty>
      )}

      {plan && (plan.steps.length > 0 || plan.skim.length > 0) && (
        <div className="grid review">
          <div className="stack">
            {plan.startHere && (
              <section className="card card-pad row nowrap" style={{ gap: 12, alignItems: 'flex-start', borderColor: 'var(--accent)' }}>
                <Play size={16} style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div className="small" style={{ fontWeight: 650 }}>
                    Start here: <span className="mono">{plan.startHere.file}</span>
                  </div>
                  <div className="tiny muted" style={{ marginTop: 3 }}>
                    {plan.startHere.reason}
                  </div>
                </div>
              </section>
            )}
            {suggestsSplit(plan) && (
              <section className="card card-pad row nowrap" style={{ gap: 12, alignItems: 'flex-start', borderColor: 'var(--warning)' }}>
                <Split size={16} style={{ color: 'var(--warning)', marginTop: 2, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div className="small" style={{ fontWeight: 650 }}>
                    This is {plural(parts.length, 'independent change')}: review them one at a time, or ask for a split.
                  </div>
                  <div className="stack" style={{ gap: 2, marginTop: 6 }}>
                    {parts.slice(0, 6).map((g) => (
                      <span key={g.index} className="tiny muted">
                        {g.index}. <span className="mono">{g.title}</span> — {plural(g.files.length, 'file')}, {plural(g.lines, 'line')}
                      </span>
                    ))}
                    {parts.length > 6 && <span className="tiny faint">+ {parts.length - 6} more</span>}
                  </div>
                </div>
              </section>
            )}
            <section className="card">
              <div className="card-head">
                <ListChecks size={15} className="muted" />
                <h3>Review path</h3>
                <span className="tiny faint">dependencies first · tests {plan.testFirst ? 'before' : 'after'} their code</span>
                <span className="spacer" />
                <span className="tiny faint desktop-only">
                  <kbd>j</kbd> <kbd>k</kbd> move · <kbd>v</kbd> viewed · <kbd>Enter</kbd> diff
                </span>
              </div>
              {plan.groups.map((g) => {
                const steps = plan.steps.filter((s) => s.group === g.index);
                if (!steps.length) return null;
                return (
                  <div key={g.index}>
                    {plan.groups.length > 1 && (
                      <div className="day-header" style={{ paddingTop: g.index > 1 ? 16 : 10 }}>
                        {g.kind === 'other' ? g.title : `Part ${g.index} · ${g.title}`}
                      </div>
                    )}
                    {steps.map((step) => (
                      <StepRow
                        key={step.file}
                        step={step}
                        active={plan.steps[active]?.file === step.file}
                        open={open.has(step.file)}
                        diff={diffs.get(step.file)}
                        onActivate={() => setActive(step.order - 1)}
                        onToggleDiff={() =>
                          setOpen((o) => {
                            const next = new Set(o);
                            if (next.has(step.file)) next.delete(step.file);
                            else next.add(step.file);
                            return next;
                          })
                        }
                        onViewed={(v) => void setViewed([step.file], v)}
                      />
                    ))}
                  </div>
                );
              })}
            </section>
            {plan.skim.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <Eye size={15} className="muted" />
                  <h3>Skim</h3>
                  <span className="tiny faint">lockfiles, snapshots, generated files, renames</span>
                  <span className="spacer" />
                  <button className="btn ghost sm" onClick={() => void setViewed(plan.skim.filter((s) => !s.viewed).map((s) => s.file), true)} disabled={plan.skim.every((s) => s.viewed)}>
                    Mark all viewed
                  </button>
                </div>
                <div style={{ padding: 6 }}>
                  {plan.skim.map((s) => (
                    <label key={s.file} className="list-item" style={{ padding: '5px 8px' }}>
                      <input type="checkbox" checked={!!s.viewed} onChange={(e) => void setViewed([s.file], e.target.checked)} />
                      <span className="mono small truncate" style={{ flex: 1, opacity: s.viewed ? 0.6 : 1 }}>
                        {s.file}
                      </span>
                      <span className="meta">{s.reason}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div className="stack">
            {plan.delta && <ArchitectureDeltaCard delta={plan.delta} />}
            {plan.untestedChanges.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <TestTube2 size={15} className="muted" />
                  <h3>Changed without test changes</h3>
                </div>
                <div style={{ padding: 6 }}>
                  {plan.untestedChanges.slice(0, 12).map((id) => (
                    <UntestedRow key={id} id={id} />
                  ))}
                  {plan.untestedChanges.length > 12 && <span className="tiny faint" style={{ padding: '2px 8px' }}>+ {plan.untestedChanges.length - 12} more</span>}
                </div>
              </section>
            )}
            {plan.commits && plan.commits.length > 0 && (
              <section className="card">
                <div className="card-head">
                  <GitCommitHorizontal size={15} className="muted" />
                  <h3>Commits</h3>
                  <span className="tiny faint">{reviewers.length ? `by ${reviewers.slice(0, 3).join(', ')}${reviewers.length > 3 ? ` +${reviewers.length - 3}` : ''}` : ''}</span>
                  {plan.commits.some((c) => /\[bot\]|copilot|codex|claude|devin|cursor/i.test(c.author)) && (
                    <span className="badge accent" title="Commits by a coding agent">
                      <Bot size={11} /> agent
                    </span>
                  )}
                </div>
                <div style={{ padding: 6 }}>
                  {plan.commits.slice(0, 12).map((m) => (
                    <div key={m.hash} className="commit-row">
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
            {(plan.warnings ?? []).map((w) => (
              <div key={w} className="row small" style={{ gap: 8, color: 'var(--warning)' }}>
                <AlertTriangle size={14} /> {w}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UntestedRow({ id }: { id: string }) {
  const model = useModel();
  const hash = id.indexOf('#');
  const file = id.slice(0, hash);
  const known = model.symbolById.has(id);
  return (
    <button className="sym-row" style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left' }} onClick={() => (known ? selectSymbol(id) : model.fileById.has(file) && selectFile(file))} disabled={!known && !model.fileById.has(file)}>
      <span className="name">{id.slice(hash + 1)}()</span>
      <span className="faint tiny truncate">{basename(file)}</span>
    </button>
  );
}
