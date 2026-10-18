import { useMemo, useState } from 'react';
import { AlertTriangle, Box, Cpu, Package, PackageCheck, PackageX } from 'lucide-react';
import { useModel } from '../data/context';
import { fmtNum, plural } from '../lib/format';
import { select, useStore } from '../state/store';
import type { PackageInfo } from '../types';
import { BarList, SearchInput, Segmented, Stat } from '../components/ui';

type Filter = 'all' | 'external' | 'builtin' | 'unused' | 'missing' | 'dev' | 'production';
type Sort = 'files' | 'name' | 'imports';

export function PackagesView() {
  const model = useModel();
  const selection = useStore((s) => s.selection);
  const pkgs = model.data.packages;
  const [filter, setFilter] = useState<Filter>('external');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('files');
  const external = pkgs.filter((p) => !p.builtin && p.importedBy.length);
  const builtins = pkgs.filter((p) => p.builtin);
  // accuracy-pass: a package one package.json declares without using (while other code imports it) counts too
  const unused = pkgs.filter((p) => p.unused || p.unusedIn?.length);
  const missing = pkgs.filter((p) => p.missing);
  // accuracy-pass: devDependencies that production code imports
  const devInProduction = useMemo(() => new Map((model.data.insights.devDependenciesInProduction ?? []).map((d) => [d.name, d])), [model]);
  const manifestLabel = (dir: string): string => (dir ? `${dir}/package.json` : 'package.json');
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (p: PackageInfo): boolean => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      switch (filter) {
        case 'external':
          return !p.builtin && p.importedBy.length > 0;
        case 'builtin':
          return p.builtin;
        case 'unused':
          return !!p.unused || !!p.unusedIn?.length;
        case 'missing':
          return !!p.missing;
        case 'dev':
          return p.declaredAs === 'devDependencies' && p.importedBy.length > 0;
        case 'production':
          return devInProduction.has(p.name);
        default:
          return true;
      }
    };
    return pkgs
      .filter(match)
      .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'imports' ? b.importCount - a.importCount : b.importedBy.length - a.importedBy.length || a.name.localeCompare(b.name)));
  }, [pkgs, filter, search, sort, devInProduction]);
  const top = external.slice(0, 14);
  const totalFiles = model.files.filter((f) => f.scope !== 'context').length;

  return (
    <div className="page">
      <div className="grid cols-4 stats">
        <Stat icon={Package} value={fmtNum(external.length)} label="External packages used" hint={`${model.data.packages.filter((p) => p.declaredAs).length} declared in package.json`} color="#f59e0b" onClick={() => setFilter('external')} />
        <Stat icon={Cpu} value={fmtNum(builtins.length)} label="Node.js built-ins" hint={builtins.slice(0, 4).map((b) => b.name).join(', ') || '—'} color="#64748b" onClick={() => setFilter('builtin')} />
        <Stat icon={PackageX} value={fmtNum(unused.length)} label="Possibly unused" hint="declared but never imported" color={unused.length ? '#fbbf24' : '#34d399'} onClick={() => setFilter('unused')} />
        <Stat icon={AlertTriangle} value={fmtNum(missing.length)} label="Missing from package.json" hint="imported but not declared" color={missing.length ? '#f87171' : '#34d399'} onClick={() => setFilter('missing')} />
      </div>
      {top.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Most used packages</h3>
            <span className="spacer" />
            <span className="tiny faint">number of files importing each package</span>
          </div>
          <div className="card-body">
            <BarList
              items={top.map((p) => ({
                key: p.name,
                label: (
                  <span className="row nowrap" style={{ gap: 6 }}>
                    <Box size={13} className="faint" />
                    <span className="mono">{p.name}</span>
                  </span>
                ),
                value: p.importedBy.length,
                color: p.declaredAs === 'devDependencies' ? '#94a3b8' : undefined,
              }))}
              onClick={(name) => select({ type: 'package', id: name })}
              format={(v) => `${v} · ${Math.round((v / Math.max(1, totalFiles)) * 100)}%`}
            />
          </div>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'external', label: `Used (${external.length})` },
              { value: 'dev', label: 'Dev deps' },
              { value: 'builtin', label: `Built-in (${builtins.length})` },
              { value: 'unused', label: `Unused (${unused.length})` },
              { value: 'missing', label: `Missing (${missing.length})` },
              ...(devInProduction.size ? [{ value: 'production' as const, label: `Dev deps in production (${devInProduction.size})` }] : []),
              { value: 'all', label: 'All' },
            ]}
          />
          <span className="spacer" />
          <SearchInput value={search} onChange={setSearch} placeholder="Filter packages…" style={{ width: 220 }} />
        </div>
        <div className="table-wrap" style={{ maxHeight: 640 }}>
          <table className="table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => setSort('name')}>
                  Package {sort === 'name' && '↓'}
                </th>
                <th>Version</th>
                <th>Declared as</th>
                <th className="num sortable" onClick={() => setSort('files')}>
                  Files {sort === 'files' && '↓'}
                </th>
                <th className="num sortable" onClick={() => setSort('imports')}>
                  Imports {sort === 'imports' && '↓'}
                </th>
                <th>Imported names</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.name} className={selection?.type === 'package' && selection.id === p.name ? 'active' : undefined} onClick={() => select({ type: 'package', id: p.name })}>
                  <td>
                    <span className="row nowrap" style={{ gap: 8 }}>
                      {p.unused ? <PackageX size={14} style={{ color: 'var(--warning)' }} /> : p.missing ? <AlertTriangle size={14} style={{ color: 'var(--danger)' }} /> : <PackageCheck size={14} className="faint" />}
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {p.name}
                      </span>
                      {p.typeOnly && p.importedBy.length > 0 && <span className="badge">types</span>}
                    </span>
                  </td>
                  <td className="mono small muted">{p.version ?? (p.builtin ? 'built-in' : '—')}</td>
                  <td className="small">
                    {p.declaredAs ?? (p.builtin ? '' : <span style={{ color: 'var(--danger)' }}>not declared</span>)}
                    {devInProduction.has(p.name) && (
                      <span className="badge warn" style={{ marginLeft: 6 }} title={`Imported by production code: ${devInProduction.get(p.name)!.files.join(', ')} — move it to "dependencies"`}>
                        used in production
                      </span>
                    )}
                    {!p.unused && !!p.unusedIn?.length && (
                      <span className="badge warn" style={{ marginLeft: 6 }} title="Declared there as a dependency, but no code under that package.json imports it">
                        unused in {p.unusedIn.map(manifestLabel).join(', ')}
                      </span>
                    )}
                  </td>
                  <td className="num">{p.importedBy.length}</td>
                  <td className="num muted">{p.importCount}</td>
                  <td className="mono tiny muted truncate" style={{ maxWidth: 360 }}>
                    {p.names.filter((n) => n !== '*').slice(0, 8).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <div className="empty">{filter === 'unused' || filter === 'missing' ? 'Nothing here — good job!' : 'No packages match.'}</div>}
        </div>
      </div>
      <p className="tiny faint" style={{ marginTop: 12 }}>
        {plural(external.length, 'package')} imported from source. “Possibly unused” only checks runtime <code>dependencies</code> that no analyzed file imports; tools used via CLI, configs or framework conventions may still need them.
      </p>
    </div>
  );
}
