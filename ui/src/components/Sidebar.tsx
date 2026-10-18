import { ChevronsLeft, ChevronsRight, Moon, Sun } from 'lucide-react';
import { useModel } from '../data/context';
import { fmtCompact } from '../lib/format';
import { navigate, setState, toggleTheme, useStore, type ViewId } from '../state/store';
import { VIEW_ICONS } from './icons';

export interface NavEntry {
  id: ViewId;
  label: string;
  count?: number;
  section: string;
}

export function useNavEntries(): NavEntry[] {
  const model = useModel();
  const { data } = model;
  const symbols = data.files.flatMap((f) => (f.scope === 'context' ? [] : f.symbols));
  const issues =
    data.insights.cycles.length +
    data.insights.orphans.length +
    data.insights.unusedDependencies.length +
    data.insights.missingDependencies.length;
  const entries: NavEntry[] = [
    { id: 'overview', label: 'Overview', section: 'Explore' },
    { id: 'tour', label: 'Guided tour', section: 'Explore', count: data.tour.length },
    { id: 'graph', label: 'Dependency graph', section: 'Explore', count: data.files.length },
    { id: 'architecture', label: 'Architecture', section: 'Explore' },
    { id: 'structure', label: 'Structure', section: 'Explore' },
  ];
  if (model.hasComponents) entries.push({ id: 'components', label: 'Components', section: 'Code', count: symbols.filter((s) => s.kind === 'component').length });
  if (model.hasClasses)
    entries.push({ id: 'classes', label: 'Classes & types', section: 'Code', count: symbols.filter((s) => s.kind === 'class' || s.kind === 'interface' || s.kind === 'enum').length });
  if (model.hasRoutes) entries.push({ id: 'routes', label: 'Routes & APIs', section: 'Code', count: data.routes.length });
  if (model.hasCalls) entries.push({ id: 'flow', label: 'Call flow', section: 'Code' });
  entries.push({ id: 'packages', label: 'Packages', section: 'Code', count: data.packages.filter((p) => !p.builtin && p.importedBy.length).length });
  entries.push({ id: 'insights', label: 'Insights', section: 'Health', count: issues || undefined });
  return entries;
}

export function Sidebar() {
  const model = useModel();
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const collapsed = useStore((s) => s.navCollapsed);
  const entries = useNavEntries();
  const sections = [...new Set(entries.map((e) => e.section))];
  const { project } = model.data;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.6" fill="currentColor" />
            <circle cx="18" cy="6" r="2.6" fill="currentColor" />
            <circle cx="12" cy="18" r="3" fill="currentColor" />
            <path d="M6 6 12 18 18 6" opacity=".75" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name" title={project.name}>
            {project.name}
          </div>
          <div className="brand-sub">code-visualizer</div>
        </div>
      </div>
      <nav className="nav" aria-label="Views">
        {sections.map((section) => (
          <div key={section} style={{ display: 'contents' }}>
            <div className="nav-section">{section}</div>
            {entries
              .filter((e) => e.section === section)
              .map((e) => {
                const Icon = VIEW_ICONS[e.id];
                return (
                  <button key={e.id} className={`nav-item${view === e.id ? ' active' : ''}`} onClick={() => navigate(e.id)} title={e.label}>
                    <Icon size={17} />
                    <span className="label">{e.label}</span>
                    {e.count !== undefined && <span className="count">{fmtCompact(e.count)}</span>}
                  </button>
                );
              })}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <button className="nav-item" onClick={toggleTheme} title="Toggle theme">
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          <span className="label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
        <button className="nav-item desktop-only" onClick={() => setState({ navCollapsed: !collapsed })} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          <span className="label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
