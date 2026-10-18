import { useEffect } from 'react';
import { Menu, Moon, Search, Sun } from 'lucide-react';
import { useModel } from './data/context';
import { CommandPalette } from './components/CommandPalette';
import { DetailPanel } from './components/DetailPanel';
import { Sidebar, useNavEntries } from './components/Sidebar';
import { dismissToast, setState, toggleTheme, useStore, type ViewId } from './state/store';
import { SEVERITY_COLOR } from './components/LiveFeed';
import { OverviewView } from './views/OverviewView';
import { TourView } from './views/TourView';
import { GraphView } from './views/GraphView';
import { ArchitectureView } from './views/ArchitectureView';
import { StructureView } from './views/StructureView';
import { ComponentsView } from './views/ComponentsView';
import { ClassesView } from './views/ClassesView';
import { RoutesView } from './views/RoutesView';
import { FlowView } from './views/FlowView';
import { PackagesView } from './views/PackagesView';
import { InsightsView } from './views/InsightsView';
import { EnvView } from './views/EnvView';
import { ReleaseView } from './views/ReleaseView';
import { TodayView } from './views/TodayView';
import { ChangesView } from './views/ChangesView';
import { SearchView } from './views/SearchView';
import { ActivityView } from './views/ActivityView';
import { recordVisit } from './state/personal';
import { selectionKey } from './state/personal';

const SUBTITLES: Record<ViewId, string> = {
  today: 'Your daily starting point',
  changes: 'What your work changes, affects and needs before review',
  search: 'Full-text search across every file',
  activity: 'Commits, people and who knows what',
  overview: 'Everything at a glance',
  tour: 'A guided walkthrough for newcomers',
  graph: 'How files depend on each other — zoom out for folders, in for files',
  architecture: 'Dependencies between areas of the codebase',
  structure: 'Treemap, sunburst, mind map and file explorer',
  components: 'Which components render which',
  classes: 'UML class diagram of classes, interfaces and enums',
  routes: 'Pages, API endpoints and their handlers',
  flow: 'Function-level call graph',
  packages: 'External dependencies, their licenses and install scripts',
  env: 'Environment variables the code reads, and what documents them',
  insights: 'Health score, trends, hotspots, dead code, security and risks',
  release: 'What the next release contains and the version that fits',
};

const FILL_VIEWS = new Set<ViewId>(['graph', 'architecture', 'structure', 'components', 'classes', 'routes', 'flow', 'search', 'activity', 'tour']);

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function App() {
  const model = useModel();
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const collapsed = useStore((s) => s.navCollapsed);
  const mobileNav = useStore((s) => s.mobileNav);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const selection = useStore((s) => s.selection);
  const live = useStore((s) => s.live);
  const toastMsg = useStore((s) => s.toast);
  const liveOpenCount = useStore((s) => s.liveOpenCount);
  const entries = useNavEntries();
  const current = entries.find((e) => e.id === view) ?? entries[0];
  const activeView = entries.some((e) => e.id === view) ? view : 'today';

  useEffect(() => {
    if (selection && (selection.type === 'file' || selection.type === 'symbol' || selection.type === 'folder' || selection.type === 'route')) recordVisit(selectionKey(selection));
  }, [selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setState((s) => ({ paletteOpen: !s.paletteOpen }));
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === '/') {
        e.preventDefault();
        setState({ paletteOpen: true });
      } else if (e.key === 'Escape') {
        setState((s) => (s.paletteOpen ? { paletteOpen: false } : { selection: null, mobileNav: false }));
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const target = entries[Number(e.key) - 1];
        if (target) setState({ view: target.id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries]);

  useEffect(() => {
    // live-guard: problems that appeared while `serve` runs and are still open, e.g. "(2) app · Today · Code Visualizer".
    document.title = `${liveOpenCount > 0 ? `(${liveOpenCount}) ` : ''}${model.data.project.name} · ${current.label} · Code Visualizer`;
  }, [current.label, model.data.project.name, liveOpenCount]);

  return (
    <div className={`app${collapsed ? ' nav-collapsed' : ''}${mobileNav ? ' mobile-nav' : ''}`}>
      <Sidebar />
      {mobileNav && <div className="scrim" onClick={() => setState({ mobileNav: false })} />}
      <main className="main">
        <header className="topbar">
          <button className="btn ghost icon mobile-only" onClick={() => setState({ mobileNav: true })} aria-label="Open navigation">
            <Menu size={18} />
          </button>
          <div className="topbar-title">
            <h1>{current.label}</h1>
            <span className="sub desktop-only">{SUBTITLES[activeView]}</span>
          </div>
          <button className="search-trigger" onClick={() => setState({ paletteOpen: true })} aria-label="Search">
            <Search size={15} />
            <span className="label">Search files, symbols, routes…</span>
            <span className="kbd-group">
              <kbd>{navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'}</kbd>
              <kbd>K</kbd>
            </span>
          </button>
          {live && (
            <span className={`live-badge desktop-only${live.connected ? '' : ' off'}`} title={live.connected ? 'Connected to code-visualizer serve — updates automatically' : 'Lost connection — retrying'}>
              <span className="live-dot" />
              {live.connected ? 'Live' : 'Offline'}
            </span>
          )}
          <button className="btn ghost icon" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </header>
        <div className={`workspace${selection ? ' panel-open' : ''}`}>
          <div className={`view${FILL_VIEWS.has(activeView) ? ' fill' : ''}`}>
            {activeView === 'today' && <TodayView />}
            {activeView === 'changes' && <ChangesView />}
            {activeView === 'search' && <SearchView />}
            {activeView === 'activity' && <ActivityView />}
            {activeView === 'overview' && <OverviewView />}
            {activeView === 'tour' && <TourView />}
            {activeView === 'graph' && <GraphView />}
            {activeView === 'architecture' && <ArchitectureView />}
            {activeView === 'structure' && <StructureView />}
            {activeView === 'components' && <ComponentsView />}
            {activeView === 'classes' && <ClassesView />}
            {activeView === 'routes' && <RoutesView />}
            {activeView === 'flow' && <FlowView />}
            {activeView === 'packages' && <PackagesView />}
            {activeView === 'env' && <EnvView />}
            {activeView === 'insights' && <InsightsView />}
            {activeView === 'release' && <ReleaseView />}
          </div>
          {selection && <DetailPanel />}
        </div>
      </main>
      {paletteOpen && <CommandPalette />}
      {toastMsg && (
        <div className={`toast${toastMsg.tone ? ` tone-${toastMsg.tone}` : ''}`} key={toastMsg.id} role="status" style={toastMsg.tone ? { ['--tone' as string]: SEVERITY_COLOR[toastMsg.tone] } : undefined}>
          <span className="toast-text">{toastMsg.text}</span>
          {toastMsg.action && (
            <button
              className="btn sm"
              onClick={() => {
                toastMsg.action!.run();
                dismissToast();
              }}
            >
              {toastMsg.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
