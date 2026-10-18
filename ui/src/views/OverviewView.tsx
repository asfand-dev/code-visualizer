import { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Atom,
  BookOpen,
  Boxes,
  Clock,
  FileCode2,
  GitBranch,
  Ghost,
  ListTodo,
  Network,
  Package,
  Recycle,
  Route,
  Shapes,
  Sigma,
  Target,
  Unlink,
  Users,
} from 'lucide-react';
import { useModel } from '../data/context';
import { Donut, Legend, Sparkline, type Slice } from '../charts/charts';
import { FRAMEWORK_CATEGORY_COLORS, KIND_META, LANGUAGE_COLORS, LANGUAGE_LABELS, SYMBOL_META } from '../lib/colors';
import { fmtCompact, fmtDate, fmtNum, plural, timeAgo } from '../lib/format';
import { navigate, select, selectFile, showInGraph } from '../state/store';
import { BarList, KindDot, SectionTitle, Stat } from '../components/ui';
import { KIND_ICONS } from '../components/icons';
import type { FileKind, SymbolKind } from '../types';

export function OverviewView() {
  const model = useModel();
  const { data } = model;
  const { project, stats, insights } = data;
  const coreFiles = data.files.filter((f) => f.scope !== 'context');

  const languageSlices: Slice[] = project.languages.map((l) => ({
    key: l.language,
    label: LANGUAGE_LABELS[l.language] ?? l.language,
    value: l.loc,
    color: LANGUAGE_COLORS[l.language] ?? '#8b6dff',
  }));

  const symbolSlices: Slice[] = useMemo(() => {
    const counts: [SymbolKind, number][] = [
      ['component', stats.components],
      ['hook', stats.hooks],
      ['function', stats.functions],
      ['class', stats.classes],
      ['interface', stats.interfaces],
      ['type', stats.types],
      ['enum', stats.enums],
      ['constant', stats.constants],
      ['variable', stats.variables],
    ];
    const plurals: Partial<Record<SymbolKind, string>> = { class: 'Classes' };
    return counts.filter(([, v]) => v > 0).map(([k, v]) => ({ key: k, label: plurals[k] ?? `${SYMBOL_META[k].label}s`, value: v, color: SYMBOL_META[k].color }));
  }, [stats]);

  const areas = useMemo(() => {
    const hasSrc = model.folderByPath.has('src');
    const list = [...model.folderByPath.values()].filter((f) => {
      if (!f.path || f.fileCount < 2) return false;
      const depth = f.path.split('/').length;
      if (hasSrc && f.path.startsWith('src/')) return depth === 2;
      return depth === 1 && f.path !== 'src';
    });
    return list.sort((a, b) => b.loc - a.loc).slice(0, 9);
  }, [model]);

  const important = [...coreFiles]
    .filter((f) => f.kind !== 'test' && f.kind !== 'config')
    .sort((a, b) => b.metrics.importance - a.metrics.importance)
    .slice(0, 8);

  const health = [
    { key: 'cycles', icon: Recycle, label: 'Circular dependencies', value: insights.cycles.length, tone: insights.cycles.length ? 'danger' : 'success' },
    { key: 'orphans', icon: Ghost, label: 'Orphan files', value: insights.orphans.length, tone: insights.orphans.length ? 'warn' : 'success' },
    { key: 'unused', icon: Unlink, label: 'Unused exports', value: insights.unusedExports.filter((u) => !u.typeOnly).length, tone: insights.unusedExports.length ? 'warn' : 'success' },
    { key: 'deps', icon: Package, label: 'Dependency issues', value: insights.unusedDependencies.length + insights.missingDependencies.length, tone: insights.unusedDependencies.length + insights.missingDependencies.length ? 'warn' : 'success' },
    { key: 'complexity', icon: Sigma, label: 'Avg. function complexity', value: stats.avgComplexity, tone: stats.avgComplexity > 10 ? 'warn' : 'success' },
    { key: 'todos', icon: ListTodo, label: 'TODO / FIXME notes', value: stats.todos, tone: stats.todos > 20 ? 'warn' : 'info' },
  ] as const;

  const stack = project.frameworks.filter((f) => f.category !== 'build');
  const git = data.git;

  return (
    <div className="page">
      {data.scope.type !== 'project' && (
        <div className="scope-banner" style={{ marginBottom: 16 }}>
          <Target size={16} />
          <span>
            This report is focused on the {data.scope.type} <code className="mono">{data.scope.path || '.'}</code>
            {data.scope.type === 'file' ? ' — showing its dependencies and the files that depend on it.' : ' — files outside it are shown as context only.'}
          </span>
          <span className="spacer" />
          {data.scope.type === 'file' && data.scope.path && (
            <button className="btn sm" onClick={() => selectFile(data.scope.path!)}>
              Open file
            </button>
          )}
        </div>
      )}

      <section className="hero">
        <div className="row" style={{ gap: 8, marginBottom: 10, position: 'relative', zIndex: 1 }}>
          {project.version && <span className="badge outline">v{project.version}</span>}
          {project.license && <span className="badge outline">{project.license}</span>}
          {project.git?.branch && (
            <span className="badge outline">
              <GitBranch size={11} /> {project.git.branch}
              {project.git.commit ? ` @ ${project.git.commit}` : ''}
            </span>
          )}
          {project.workspaces && <span className="badge accent">Monorepo · {project.workspaces.length} packages</span>}
          <span className="badge outline">
            <Clock size={11} /> {fmtDate(data.generatedAt)}
          </span>
        </div>
        <h2 style={{ position: 'relative', zIndex: 1 }}>
          <span className="gradient-text">{project.name}</span>
        </h2>
        <p className="lead" style={{ position: 'relative', zIndex: 1 }}>
          {project.description ??
            `A ${stack
              .filter((f) => ['fullstack', 'frontend', 'backend', 'mobile', 'desktop'].includes(f.category))
              .slice(0, 3)
              .map((f) => f.name)
              .join(' + ') || (project.typescript ? 'TypeScript' : 'JavaScript')} codebase with ${plural(stats.files, 'file')} and ${plural(stats.loc, 'line')} of code.`}
        </p>
        {stack.length > 0 && (
          <div className="tags" style={{ marginTop: 16, position: 'relative', zIndex: 1 }}>
            {stack.map((f) => (
              <span key={f.id} className="chip" style={{ cursor: 'default', borderColor: `color-mix(in srgb, ${FRAMEWORK_CATEGORY_COLORS[f.category]} 40%, var(--border))` }} title={`${f.category}${f.version ? ` · ${f.version}` : ''}`}>
                <span className="dot" style={{ ['--c' as string]: FRAMEWORK_CATEGORY_COLORS[f.category] }} />
                {f.name}
                {f.version && <span className="faint tiny">{f.version}</span>}
              </span>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 20, position: 'relative', zIndex: 1 }}>
          <button className="btn primary" onClick={() => navigate('tour')}>
            <BookOpen size={15} /> Take the guided tour
          </button>
          <button className="btn" onClick={() => navigate('graph')}>
            <Network size={15} /> Explore the dependency graph
          </button>
        </div>
      </section>

      <div className="grid cols-4 stats" style={{ marginTop: 16 }}>
        <Stat icon={FileCode2} value={fmtNum(stats.files)} label="Source files" hint={`${fmtNum(stats.testFiles)} test files`} color="#8b6dff" onClick={() => navigate('structure')} />
        <Stat icon={Activity} value={fmtCompact(stats.loc)} label="Lines of code" hint={`${fmtCompact(stats.sloc)} excluding comments & blanks`} color="#22d3ee" />
        <Stat icon={Boxes} value={fmtNum(stats.symbols)} label="Symbols" hint={`${fmtNum(stats.functions)} functions · ${fmtNum(stats.classes)} classes`} color="#10b981" />
        {stats.components > 0 ? (
          <Stat icon={Atom} value={fmtNum(stats.components)} label="Components" hint={`${fmtNum(stats.hooks)} hooks`} color="#3b82f6" onClick={() => navigate('components')} />
        ) : (
          <Stat icon={Shapes} value={fmtNum(stats.interfaces + stats.types)} label="Types & interfaces" hint={`${fmtNum(stats.enums)} enums`} color="#6366f1" onClick={() => model.hasClasses && navigate('classes')} />
        )}
        <Stat icon={Network} value={fmtNum(stats.internalEdges)} label="Internal imports" hint={`${(stats.internalEdges / Math.max(stats.files, 1)).toFixed(1)} per file`} color="#f472b6" onClick={() => navigate('graph')} />
        <Stat icon={Package} value={fmtNum(stats.packages)} label="External packages" hint={`${data.packages.filter((p) => p.builtin).length} Node built-ins`} color="#f59e0b" onClick={() => navigate('packages')} />
        <Stat icon={Route} value={fmtNum(stats.routes)} label="Routes & endpoints" hint={stats.routes ? `${data.routes.filter((r) => r.type === 'api').length} API · ${data.routes.filter((r) => r.type === 'page').length} pages` : 'No routes detected'} color="#ec4899" onClick={() => stats.routes && navigate('routes')} />
        <Stat icon={AlertTriangle} value={fmtNum(insights.cycles.length)} label="Circular dependencies" hint={insights.cycles.length ? 'Click to inspect' : 'None — nice!'} color={insights.cycles.length ? '#f87171' : '#34d399'} onClick={() => navigate('insights')} />
      </div>

      <div className="grid cols-3" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3>Languages</h3>
            <span className="spacer" />
            <span className="tiny faint">by lines of code</span>
          </div>
          <div className="card-body row nowrap" style={{ gap: 20, alignItems: 'center' }}>
            <Donut data={languageSlices} size={132} thickness={18} center={<div className="tiny muted">{project.languages.length} lang.</div>} />
            <Legend data={languageSlices} format={fmtCompact} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Symbols</h3>
            <span className="spacer" />
            <span className="tiny faint">{fmtNum(stats.symbols)} total</span>
          </div>
          <div className="card-body row nowrap" style={{ gap: 20, alignItems: 'center' }}>
            <Donut data={symbolSlices} size={132} thickness={18} center={<div className="tiny muted">symbols</div>} />
            <Legend data={symbolSlices.slice(0, 6)} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>File types</h3>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => navigate('graph')}>
              Graph <ArrowRight size={12} />
            </button>
          </div>
          <div className="card-body">
            <BarList
              items={model.kinds.slice(0, 7).map(({ kind, count }) => ({
                key: kind,
                label: (
                  <span className="row nowrap" style={{ gap: 8 }}>
                    <KindDot kind={kind as FileKind} />
                    {KIND_META[kind as FileKind].label}
                  </span>
                ),
                value: count,
                color: KIND_META[kind as FileKind].color,
              }))}
              onClick={(k) => showInGraph(coreFiles.filter((f) => f.kind === k).map((f) => f.id), 'files')}
            />
          </div>
        </div>
      </div>

      <SectionTitle>Areas of the codebase</SectionTitle>
      <div className="grid auto">
        {areas.map((a) => {
          const kinds = Object.entries(a.summary?.kinds ?? {}).sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0)) as [FileKind, number][];
          const total = kinds.reduce((n, [, v]) => n + v, 0);
          return (
            <div key={a.path} className="card card-pad interactive" onClick={() => select({ type: 'folder', id: a.path })}>
              <div className="row nowrap" style={{ gap: 8 }}>
                <span className="mono" style={{ fontWeight: 650, fontSize: 13 }}>
                  {a.path}/
                </span>
                <span className="spacer" />
                <span className="tiny faint">{plural(a.fileCount, 'file')}</span>
              </div>
              <div className="small muted" style={{ marginTop: 6, minHeight: 38 }}>
                {a.summary?.description || 'Source files'}
              </div>
              <div style={{ display: 'flex', height: 6, borderRadius: 6, overflow: 'hidden', marginTop: 12, background: 'var(--surface-3)' }}>
                {kinds.map(([k, v]) => (
                  <span key={k} title={`${KIND_META[k].label}: ${v}`} style={{ width: `${(v / total) * 100}%`, background: KIND_META[k].color }} />
                ))}
              </div>
              <div className="tiny faint" style={{ marginTop: 8 }}>
                {fmtNum(a.loc)} lines
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3>Most important files</h3>
            <span className="spacer" />
            <span className="tiny faint">ranked by how much depends on them</span>
          </div>
          <div style={{ padding: 6 }}>
            {important.map((f) => {
              const Icon = KIND_ICONS[f.kind];
              return (
                <button key={f.id} className="list-item" onClick={() => selectFile(f.id)}>
                  <Icon size={15} style={{ color: KIND_META[f.kind].color, flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="title truncate">{f.name}</div>
                    <div className="tiny faint mono truncate">{f.id}</div>
                  </div>
                  <span className="meta">used by {f.metrics.fanIn}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3>Health check</h3>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => navigate('insights')}>
              Insights <ArrowRight size={12} />
            </button>
          </div>
          <div className="card-body grid cols-2" style={{ gap: 10 }}>
            {health.map((h) => (
              <div key={h.key} className="card interactive" style={{ padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' }} onClick={() => navigate('insights')}>
                <span className={`badge ${h.tone}`} style={{ width: 30, height: 30, padding: 0, justifyContent: 'center', borderRadius: 8 }}>
                  <h.icon size={15} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 18 }} className="num">
                    {fmtNum(h.value)}
                  </div>
                  <div className="tiny muted truncate">{h.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {git && (
        <div className="grid cols-2" style={{ marginTop: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3>Activity</h3>
              <span className="spacer" />
              <span className="tiny faint">commits per week · last 12 months</span>
            </div>
            <div className="card-body">
              <Sparkline values={git.weeklyActivity} height={84} />
              <div className="row small muted" style={{ marginTop: 10, gap: 16 }}>
                <span>
                  <strong className="num" style={{ color: 'var(--text)' }}>
                    {fmtNum(git.commitsAnalyzed)}
                  </strong>{' '}
                  commits analyzed
                </span>
                <span>last commit {timeAgo(git.lastCommit)}</span>
                {git.firstCommit && <span>since {fmtDate(git.firstCommit)}</span>}
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>
                <Users size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
                Top contributors
              </h3>
            </div>
            <div className="card-body">
              <BarList items={git.contributors.slice(0, 6).map((c) => ({ key: c.name, label: c.name, value: c.commits }))} format={(v) => `${v} commits`} />
            </div>
          </div>
        </div>
      )}

      {project.scripts && Object.keys(project.scripts).length > 0 && (
        <>
          <SectionTitle>Scripts</SectionTitle>
          <div className="card">
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {Object.entries(project.scripts)
                    .slice(0, 14)
                    .map(([name, cmd]) => (
                      <tr key={name} style={{ cursor: 'default' }}>
                        <td style={{ width: 160 }}>
                          <code className="mono" style={{ color: 'var(--accent)' }}>
                            {project.packageManager === 'yarn' ? `yarn ${name}` : project.packageManager === 'pnpm' ? `pnpm ${name}` : `npm run ${name}`}
                          </code>
                        </td>
                        <td className="mono muted small" style={{ wordBreak: 'break-all' }}>
                          {cmd}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {data.warnings.length > 0 && (
        <details style={{ marginTop: 20 }} className="small muted">
          <summary style={{ cursor: 'pointer' }}>{plural(data.warnings.length, 'analysis warning')}</summary>
          <ul>
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="tiny faint" style={{ marginTop: 28, textAlign: 'center' }}>
        Generated by code-visualizer v{data.tool.version} in {data.stats.durationMs} ms · {fmtDate(data.generatedAt)} · This report is a single offline HTML file you can share.
      </p>
    </div>
  );
}
