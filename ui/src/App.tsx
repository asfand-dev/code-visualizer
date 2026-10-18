import { useEffect } from 'react';
import { Menu, Moon, Search, Sun } from 'lucide-react';
import { useModel } from './data/context';
import { CommandPalette } from './components/CommandPalette';
import { DetailPanel } from './components/DetailPanel';
import { Sidebar, useNavEntries } from './components/Sidebar';
import { setState, toggleTheme, useStore, type ViewId } from './state/store';
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

const SUBTITLES: Record<ViewId, string> = {
  overview: 'Everything at a glance',
  tour: 'A guided walkthrough for newcomers',
  graph: 'How files depend on each other — zoom out for folders, in for files',
  architecture: 'Dependencies between areas of the codebase',
  structure: 'Treemap, sunburst, mind map and file explorer',
  components: 'Which components render which',
  classes: 'UML class diagram of classes, interfaces and enums',
  routes: 'Pages, API endpoints and their handlers',
  flow: 'Function-level call graph',
  packages: 'External dependencies and how they are used',
  insights: 'Cycles, hotspots, dead code and other findings',
};

const FILL_VIEWS = new Set<ViewId>(['graph', 'architecture', 'structure', 'components', 'classes', 'routes', 'flow']);

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
  const entries = useNavEntries();
  const current = entries.find((e) => e.id === view) ?? entries[0];
  const activeView = entries.some((e) => e.id === view) ? view : 'overview';

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
    document.title = `${model.data.project.name} · ${current.label} · Code Visualizer`;
  }, [current.label, model.data.project.name]);

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
          <button className="btn ghost icon" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </header>
        <div className="workspace">
          <div className={`view${FILL_VIEWS.has(activeView) ? ' fill' : ''}`}>
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
            {activeView === 'insights' && <InsightsView />}
          </div>
          {selection && <DetailPanel />}
        </div>
      </main>
      {paletteOpen && <CommandPalette />}
    </div>
  );
}
