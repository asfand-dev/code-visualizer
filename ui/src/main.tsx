import './styles/global.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ModelProvider } from './data/context';
import { connectLive, fetchLiveData, fetchLiveFeed, liveConfig, type LiveConfig } from './data/live';
import { loadReportData } from './data/load';
import { buildModel, type Model } from './data/model';
import { canShow, notifyDesktop, showLiveEvent } from './components/LiveFeed';
import { initPersonal } from './state/personal';
import { getState, pushLiveEvents, setState, toast } from './state/store';
import { openProblemCount, topEvent } from '../../src/shared/live';
import type { LiveUpdate, ReportData } from './types';

/* --- live-guard --- */
/** Load this session's feed and open problems (after connecting, and from servers that send no open list). */
async function syncLiveFeed(live: LiveConfig): Promise<void> {
  const feed = await fetchLiveFeed(live);
  if (!feed) return;
  setState({ liveFeed: feed.events, liveOpen: feed.open, liveOpenCount: openProblemCount(feed.open) });
}

/** A toast with a button stays at least this long before a live update may replace it (it would move under the cursor). */
const ACTIONABLE_TOAST_MS = 3000;
let deferredAnnouncement: ReturnType<typeof setTimeout> | undefined;

/** The update toast: the most important live event with a "Show" button, otherwise what changed and how fast. */
function announce(info: LiveUpdate, model: Model): void {
  const top = topEvent(info.events);
  // A git event or a refresh that changed no file and found nothing (a checkout's second analysis) is no news.
  if (!top && !info.changed.length) return;
  const show = (): void => {
    if (!top) {
      const what = info.changed.length === 1 ? info.changed[0].split('/').pop() : `${info.changed.length} files`;
      toast(`${what} changed · updated in ${info.durationMs} ms`);
      return;
    }
    const others = info.events.length - 1;
    // "Show" only when there is something to open (a configuration problem has no file in the analysis).
    const action = canShow(top, model) ? { label: 'Show', run: () => showLiveEvent(top, model) } : undefined;
    toast(`${top.message}${others > 0 ? ` (+${others} more)` : ''}`, { tone: top.severity, action });
  };
  if (top && getState().desktopNotify) notifyDesktop(info.events, model.data.project.name);
  const current = getState().toast;
  const wait = current?.action ? (current.shownAt ?? 0) + ACTIONABLE_TOAST_MS - Date.now() : 0;
  if (wait > 0) {
    // Never pull a "Show" button away right after it appeared: plain updates are dropped, events wait their turn.
    if (!top) return;
    clearTimeout(deferredAnnouncement);
    deferredAnnouncement = setTimeout(show, wait);
    return;
  }
  show();
}
/* --- /live-guard --- */

const container = document.getElementById('root')!;

/** Holds the analysis; in live mode (`code-visualizer serve`) it is replaced whenever the project changes. */
function Root({ initial }: { initial: ReportData }) {
  const [model, setModel] = useState(() => buildModel(initial));
  useEffect(() => {
    const live = liveConfig();
    if (!live) return;
    setState({ live: { connected: false, version: live.version, updatedAt: Date.now(), changed: [] } });
    return connectLive(live, {
      onStatus: (connected) => {
        setState((s) => ({ live: { ...(s.live ?? { version: live.version, updatedAt: Date.now(), changed: [] }), connected } }));
        if (connected) void syncLiveFeed(live);
      },
      onUpdate: async (info) => {
        // The open list comes with every update: problems also close without an event (a commit, a revert).
        pushLiveEvents(info.events, info.open, info.openProblems);
        try {
          const data = await fetchLiveData(live);
          const next = buildModel(data);
          setModel(next);
          setState((s) => ({ live: { ...(s.live ?? { connected: true }), connected: true, version: info.version, updatedAt: Date.now(), changed: info.changed } }));
          announce(info, next);
          if (!info.openProblems && info.events.length) void syncLiveFeed(live);
        } catch (error) {
          toast(`Could not refresh: ${(error as Error).message}`);
        }
      },
      onError: (message) => toast(`Analysis failed: ${message}`),
    });
  }, []);
  return (
    <ModelProvider value={model}>
      <App />
    </ModelProvider>
  );
}

loadReportData()
  .then(async (data) => {
    await initPersonal(data.project.rootPath);
    createRoot(container).render(<Root initial={data} />);
  })
  .catch((error: unknown) => {
    console.error(error);
    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'boot';
    const title = document.createElement('h2');
    title.textContent = 'Could not load the report';
    const msg = document.createElement('p');
    msg.textContent = error instanceof Error ? error.message : String(error);
    box.append(title, msg);
    container.append(box);
  });
