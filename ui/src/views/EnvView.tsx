import { useMemo, useState } from 'react';
import { FileX, KeyRound, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useModel } from '../data/context';
import { envExampleText, envStatus, type EnvStatus, type EnvStatusKind } from '../../../src/shared/env';
import { basename, fmtNum, plural } from '../lib/format';
import { selectFile } from '../state/store';
import { CopyButton, Empty, SearchInput, Segmented, Stat } from '../components/ui';
import type { EnvReport, EnvVar } from '../types';

type Filter = 'all' | 'attention' | 'unused';

const BADGE_TONE: Record<EnvStatusKind, string> = {
  'exposed-secret': 'danger',
  undocumented: 'danger',
  'private-only': 'warn',
  documented: 'success',
  optional: '',
  platform: '',
};

/** Places a variable is read at that the table lists; the rest is a "+N". */
const VISIBLE_SITES = 2;

interface Row {
  variable: EnvVar;
  status: EnvStatus;
}

function rowsOf(env: EnvReport): Row[] {
  return env.vars.map((variable) => ({ variable, status: envStatus(variable, env) }));
}

function Sites({ variable }: { variable: EnvVar }) {
  if (!variable.uses.length) return <span className="faint">never read</span>;
  const more = variable.useCount - VISIBLE_SITES;
  return (
    <span className="row nowrap" style={{ gap: 4 }}>
      {variable.uses.slice(0, VISIBLE_SITES).map((use) => (
        <button key={`${use.file}:${use.line}`} className="chip" onClick={() => selectFile(use.file, use.line)} title={`${use.file}:${use.line}${use.fallback ? ' (has a default)' : ''}`}>
          <span className="mono truncate">
            {basename(use.file)}:{use.line}
          </span>
        </button>
      ))}
      {more > 0 && <span className="tiny faint">+{more}</span>}
    </span>
  );
}

function VariableRow({ row }: { row: Row }) {
  const { variable, status } = row;
  const first = variable.uses[0];
  return (
    <tr onClick={first ? () => selectFile(first.file, first.line) : undefined}>
      <td>
        <span className="row nowrap" style={{ gap: 6 }}>
          <span className="mono" style={{ fontWeight: 600 }}>
            {variable.name}
          </span>
          {variable.exposed && !variable.platform && (
            <span className="badge info" title="Bundled into the browser code: everyone who loads the page can read it">
              browser
            </span>
          )}
          {variable.secretLike && (
            <span className="badge" title="The name suggests a secret">
              secret
            </span>
          )}
        </span>
      </td>
      <td className="small">
        {BADGE_TONE[status.kind] ? <span className={`badge ${BADGE_TONE[status.kind]}`}>{status.note}</span> : <span className="muted">{status.note}</span>}
      </td>
      <td className="num">{variable.useCount}</td>
      <td>
        <Sites variable={variable} />
      </td>
      <td className="mono tiny muted">{variable.declaredIn.join(', ') || '—'}</td>
    </tr>
  );
}

export function EnvView() {
  const { data } = useModel();
  const env = data.env;
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const rows = useMemo(() => (env ? rowsOf(env) : []), [env]);
  const attention = rows.filter((r) => r.variable.useCount > 0 && !r.status.ok);
  const unused = rows.filter((r) => r.variable.useCount === 0 && r.variable.documented);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = filter === 'unused' ? unused : filter === 'attention' ? attention : rows.filter((r) => r.variable.useCount > 0);
    return pool
      .filter((r) => !q || r.variable.name.toLowerCase().includes(q))
      .sort((a, b) => Number(a.status.ok) - Number(b.status.ok) || b.variable.useCount - a.variable.useCount || a.variable.name.localeCompare(b.variable.name));
  }, [rows, attention, unused, filter, search]);

  if (!env) return <Empty icon={KeyRound} title="No environment variables found" />;
  const used = rows.filter((r) => r.variable.useCount > 0).length;

  return (
    <div className="page">
      <div className="grid cols-4 stats">
        <Stat icon={KeyRound} value={fmtNum(used)} label="Variables read by the code" hint={env.files.length ? `${plural(env.files.length, 'dotenv file')} found` : 'no dotenv files found'} color="#38bdf8" onClick={() => setFilter('all')} />
        <Stat icon={TriangleAlert} value={fmtNum(env.undocumented.length)} label="Not documented" hint="no .env.example declares them" color={env.undocumented.length ? '#f87171' : '#34d399'} onClick={() => setFilter('attention')} />
        <Stat icon={FileX} value={fmtNum(env.unused.length)} label="Declared, never read" hint="in a template, but no code uses them" color={env.unused.length ? '#fbbf24' : '#34d399'} onClick={() => setFilter('unused')} />
        <Stat icon={ShieldAlert} value={fmtNum(env.exposedSecrets.length)} label="Secrets in the browser" hint="public prefix on a secret-looking name" color={env.exposedSecrets.length ? '#f87171' : '#34d399'} onClick={() => setFilter('attention')} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All (${used})` },
              { value: 'attention', label: `Need attention (${attention.length})` },
              { value: 'unused', label: `Never read (${unused.length})` },
            ]}
          />
          <span className="spacer" />
          <SearchInput value={search} onChange={setSearch} placeholder="Filter variables…" style={{ width: 220 }} />
          {env.undocumented.length > 0 && <CopyButton text={envExampleText(env, { onlyMissing: true })} label="Copy the missing ones" />}
          <CopyButton text={envExampleText(env)} label="Copy .env.example" />
        </div>
        <div className="table-wrap" style={{ maxHeight: 560 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Status</th>
                <th className="num">Reads</th>
                <th>Read at</th>
                <th>Declared in</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <VariableRow key={row.variable.name} row={row} />
              ))}
            </tbody>
          </table>
          {!shown.length && <div className="empty">{filter === 'all' ? 'No variables match.' : 'Nothing here: good job!'}</div>}
        </div>
      </div>

      {env.files.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head">
            <h3>Dotenv files</h3>
            <span className="spacer" />
            <span className="tiny faint">only the names are read, never the values</span>
          </div>
          <div className="card-body">
            {env.files.map((file) => (
              <div key={file.path} className="row nowrap small" style={{ gap: 8, padding: '4px 0' }}>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {file.path}
                </span>
                <span className={`badge ${file.template ? 'success' : ''}`} title={file.template ? 'Documents the variables for the team (a template, or tracked by git)' : 'Local to your machine: it is not shared, so it documents nothing'}>
                  {file.template ? 'shared template' : 'private'}
                </span>
                <span className="tiny faint">{plural(file.names.length, 'variable')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="tiny faint" style={{ marginTop: 12 }}>
        Reads of <code>process.env</code>, <code>import.meta.env</code>, <code>Deno.env</code> and <code>Bun.env</code> are found by name; a variable the code has a default for, or one the platform provides (NODE_ENV, CI…), is not asked for. Run{' '}
        <code>code-visualizer env --check</code> in CI to keep it that way.
      </p>
    </div>
  );
}
