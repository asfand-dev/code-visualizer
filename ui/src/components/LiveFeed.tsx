import { useMemo, useState } from 'react';
import { Activity, Bell, BellOff } from 'lucide-react';
import { useModel } from '../data/context';
import type { Model } from '../data/model';
import { countsAsProblem, liveLocation, liveMarker, severityRank } from '../../../src/shared/live';
import { navigate, selectFile, selectSymbol, setState, showInGraph, toast, useStore } from '../state/store';
import type { LiveEvent, LiveSeverity } from '../types';
import { Segmented } from './ui';

/**
 * Live feed (live-guard): what got worse or better with every save while `serve` runs — new cycles,
 * broken rules, complexity, signature changes, untested edits, health. Shown on Today and in My changes.
 */

export const SEVERITY_COLOR: Record<LiveSeverity, string> = {
  error: 'var(--danger)',
  warning: 'var(--warning)',
  success: 'var(--success)',
  info: 'var(--info)',
};

/** Open what an event is about: cycles in the graph, functions in the details panel, files at the line. */
export function showLiveEvent(e: LiveEvent, model: Model): void {
  if (e.kind === 'health') return navigate('insights');
  const files = e.files.filter((f) => model.fileById.has(f));
  if (e.kind === 'cycle-added' || e.kind === 'cycle-fixed') {
    if (files.length > 1) return showInGraph(files, e.kind === 'cycle-added' ? 'cycle' : 'files');
  }
  if (e.symbol && model.symbolById.has(e.symbol)) return selectSymbol(e.symbol);
  if (files[0]) return selectFile(files[0], files[0] === e.files[0] ? e.line : undefined);
  toast('Not in the current analysis any more');
}

/** Whether `show` can open something for the event. */
export function canShow(e: LiveEvent, model: Model): boolean {
  return e.kind === 'health' || e.files.some((f) => model.fileById.has(f)) || (!!e.symbol && model.symbolById.has(e.symbol));
}

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function LiveRow({ e, model }: { e: LiveEvent; model: Model }) {
  const marker = liveMarker(e) || (e.severity === 'success' ? '▲' : e.severity === 'warning' ? '▼' : '•');
  const where = e.kind === 'health' ? undefined : liveLocation(e);
  const clickable = canShow(e, model);
  return (
    <button className="list-item live-row" onClick={() => showLiveEvent(e, model)} disabled={!clickable} title={clickable ? 'Show' : undefined}>
      <span className="live-mark" style={{ ['--c' as string]: SEVERITY_COLOR[e.severity] }}>
        {marker}
      </span>
      <span className="live-text">
        <span className="small live-message">{e.message}</span>
        {(e.detail || (where && !e.message.includes(e.files[0]))) && (
          <span className="tiny faint truncate">
            {where && !e.message.includes(e.files[0]) ? <span className="mono">{where}</span> : null}
            {where && !e.message.includes(e.files[0]) && e.detail ? ' · ' : ''}
            {e.detail}
          </span>
        )}
      </span>
      <span className="meta">{clock(e.at)}</span>
    </button>
  );
}

type Filter = 'all' | 'problems' | 'success' | 'info';

const matches = (filter: Filter, e: LiveEvent): boolean =>
  filter === 'all' || (filter === 'problems' ? e.severity === 'error' || e.severity === 'warning' : e.severity === filter);

/** Ask the browser for permission the first time; remembered per browser. */
async function toggleDesktopNotify(on: boolean): Promise<void> {
  if (!on) return setState({ desktopNotify: false });
  if (typeof Notification === 'undefined') return toast('This browser has no desktop notifications');
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return toast('Notifications are blocked for this page in the browser settings');
  setState({ desktopNotify: true });
}

/** A desktop notification for new errors while the page is in the background (when switched on). */
export function notifyDesktop(events: LiveEvent[], project: string): void {
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const errors = events.filter((e) => e.severity === 'error');
  if (!errors.length) return;
  try {
    const n = new Notification(`${project} · code-visualizer`, { body: `${errors[0].message}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`, tag: 'cv-live' });
    n.onclick = () => window.focus();
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export function LiveFeedCard({ compact }: { compact?: boolean }) {
  const model = useModel();
  const feed = useStore((s) => s.liveFeed);
  const open = useStore((s) => s.liveOpen);
  const openCount = useStore((s) => s.liveOpenCount);
  const desktopNotify = useStore((s) => s.desktopNotify);
  const [filter, setFilter] = useState<Filter>('all');
  const newestFirst = useMemo(() => [...feed].reverse(), [feed]);
  // Worst first, then newest; edited files no test reaches are a nudge of their own, not counted as problems.
  const [problems, nudges] = useMemo(() => {
    const sorted = [...open].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.at - a.at);
    return [sorted.filter(countsAsProblem), sorted.filter((e) => !countsAsProblem(e))];
  }, [open]);
  const counts = useMemo(() => {
    const c = { problems: 0, success: 0, info: 0 };
    for (const e of feed) {
      if (e.severity === 'error' || e.severity === 'warning') c.problems++;
      else c[e.severity]++;
    }
    return c;
  }, [feed]);
  // Compact (Today): the open problems are listed above, so the latest events leave them out.
  const openIds = new Set(compact ? open.map((e) => e.id) : []);
  const shown = newestFirst.filter((e) => matches(filter, e) && !openIds.has(e.id)).slice(0, compact ? 6 : 100);

  return (
    <section className="card live-feed">
      <div className="card-head">
        <Activity size={16} className="muted" />
        <h3>Live feed</h3>
        {openCount > 0 ? (
          <span className="badge danger" title="Problems that appeared in this session and are still there (edited files no test reaches are listed apart, not counted)">
            {openCount} open
          </span>
        ) : feed.length ? (
          <span className="badge success">nothing open</span>
        ) : null}
        <span className="spacer" />
        <button
          className={`btn ghost sm icon${desktopNotify ? ' active' : ''}`}
          onClick={() => void toggleDesktopNotify(!desktopNotify)}
          title={desktopNotify ? 'Desktop notifications for new errors are on (while this tab is in the background)' : 'Notify me about new errors while this tab is in the background'}
          aria-pressed={desktopNotify}
        >
          {desktopNotify ? <Bell size={14} /> : <BellOff size={14} />}
        </button>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {!feed.length && !open.length ? (
          <div className="small muted">
            Save a file: what gets worse — a new cycle, a broken rule, a more complex function, a changed signature, an untested edit — or better shows up here, whether you or an AI agent made the edit.
          </div>
        ) : (
          <>
            {problems.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <div className="tiny faint section-label">Still open</div>
                <div className="list">
                  {problems.slice(0, compact ? 4 : 50).map((e) => (
                    <LiveRow key={`open-${e.id}`} e={e} model={model} />
                  ))}
                </div>
              </div>
            )}
            {nudges.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <div className="tiny faint section-label" title="Files of your current work that no test reaches (not counted as problems)">
                  Untested edits
                </div>
                <div className="list">
                  {nudges.slice(0, compact ? 3 : 50).map((e) => (
                    <LiveRow key={`open-${e.id}`} e={e} model={model} />
                  ))}
                </div>
              </div>
            )}
            {!compact && feed.length > 0 && (
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: `All ${feed.length}` },
                  { value: 'problems', label: `Worse ${counts.problems}` },
                  { value: 'success', label: `Better ${counts.success}` },
                  { value: 'info', label: `Info ${counts.info}` },
                ]}
              />
            )}
            {feed.length > 0 && (shown.length > 0 || !compact) && (
              <div className="stack" style={{ gap: 4 }}>
                {compact && <div className="tiny faint section-label">Latest</div>}
                <div className="list">
                  {shown.map((e) => (
                    <LiveRow key={e.id} e={e} model={model} />
                  ))}
                  {!shown.length && <div className="small muted" style={{ padding: '4px 8px' }}>Nothing of this kind yet.</div>}
                </div>
                {compact && feed.length > shown.length + openIds.size && (
                  <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('changes')}>
                    All {feed.length} events in My changes
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
