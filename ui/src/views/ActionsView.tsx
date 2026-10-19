import { useMemo, useState } from 'react';
import { CirclePlay, Clock, ShieldCheck, TriangleAlert, Workflow as WorkflowIcon } from 'lucide-react';
import { describeCron, nextCronRun } from '../../../src/shared/cron';
import { triggerFilters, workflowMermaid } from '../../../src/shared/workflow-forecast';
import { useModel } from '../data/context';
import { fmtNum, pct, plural, timeUntil } from '../lib/format';
import { useRefreshOnFocus } from '../lib/use-refresh-on-focus';
import { PathLink } from '../components/PathLink';
import { RefreshButton } from '../components/RefreshButton';
import { WorkflowFindings } from '../components/WorkflowFindings';
import { WorkflowForecast } from '../components/WorkflowForecast';
import { WorkflowGraph } from '../components/WorkflowGraph';
import { CopyButton, Empty, SearchInput, Select, Stat, Tabs } from '../components/ui';
import type { ActionPin, ActionUse, CiReport, ScriptUse, WorkflowInfo } from '../types';

/** Workflows shown as tabs; more than this become a menu. */
const MAX_TABS = 5;
/** Rows of the tables before "show all". */
const TABLE_ROWS = 12;
const PIN_TONE: Record<ActionPin, string> = { sha: 'success', tag: '', branch: 'warn', none: 'danger' };
const PIN_HINT: Record<ActionPin, string> = {
  sha: 'Pinned to a commit: it cannot change under you',
  tag: 'A tag can be moved to different code',
  branch: 'Follows a branch: changes whenever the author pushes',
  none: 'No version: runs the default branch',
};

function WorkflowDetail({ workflow, ci }: { workflow: WorkflowInfo; ci: CiReport }) {
  const findings = ci.findings.filter((f) => f.file === workflow.file);
  const mermaid = useMemo(() => workflowMermaid(workflow), [workflow]);
  return (
    <div className="card-body stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8 }}>
        {ci.base ? <span className="mono tiny muted">{workflow.file}</span> : <PathLink path={workflow.file} />}
        <span className="tiny faint">{plural(workflow.lines, 'line')}</span>
        {workflow.permissions && <span className="badge" title="Permissions of the workflow token">{workflow.permissions}</span>}
        {workflow.concurrency && <span className="badge success" title="A newer run cancels or queues behind an older one">concurrency</span>}
        {workflow.nodeVersions?.map((version) => (
          <span key={version} className="badge info" title="Node.js version the jobs install">
            node {version}
          </span>
        ))}
        <span className="spacer" />
        <CopyButton text={mermaid} label="Copy Mermaid" />
      </div>

      {workflow.error ? (
        <div className="small" style={{ color: 'var(--danger)' }}>
          <TriangleAlert size={14} style={{ verticalAlign: -2 }} /> Not valid YAML (line {workflow.error.line}): {workflow.error.message}
        </div>
      ) : (
        <>
          <div>
            <div className="section-title">Runs when</div>
            <div className="stack" style={{ gap: 6 }}>
              {workflow.triggers.map((trigger) => (
                <div key={trigger.event} className="row nowrap small" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <span className="badge accent mono">{trigger.event}</span>
                  <span className="muted wrap-anywhere" style={{ minWidth: 0 }}>
                    {triggerFilters(trigger).join(' · ') || 'always'}
                  </span>
                </div>
              ))}
              {!workflow.triggers.length && <span className="small muted">no trigger: it never runs</span>}
            </div>
          </div>
          <div>
            <div className="section-title">Jobs</div>
            <WorkflowGraph workflow={workflow} findings={findings} />
          </div>
        </>
      )}
    </div>
  );
}

function WorkflowsCard({ ci }: { ci: CiReport }) {
  const [file, setFile] = useState(ci.workflows[0]?.file);
  const workflow = ci.workflows.find((w) => w.file === file) ?? ci.workflows[0];
  const options = ci.workflows.map((w) => ({ value: w.file, label: w.name }));
  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <WorkflowIcon size={16} className="muted" />
        <h3>Workflows</h3>
        <span className="spacer" />
        {ci.workflows.length > MAX_TABS ? <Select value={workflow.file} options={options} onChange={setFile} /> : <Tabs value={workflow.file} onChange={setFile} tabs={ci.workflows.map((w) => ({ value: w.file, label: w.name, count: w.jobs.length }))} />}
      </div>
      <WorkflowDetail key={workflow.file} workflow={workflow} ci={ci} />
    </div>
  );
}

function ActionsCard({ actions }: { actions: ActionUse[] }) {
  const [search, setSearch] = useState('');
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const risk = (a: ActionUse): number => (a.kind === 'marketplace' && !a.official && a.versions.some((v) => v.pin !== 'sha') ? 1 : 0);
    const q = search.trim().toLowerCase();
    return actions.filter((a) => !q || a.name.toLowerCase().includes(q)).sort((a, b) => risk(b) - risk(a) || b.count - a.count || a.name.localeCompare(b.name));
  }, [actions, search]);
  const shown = all ? rows : rows.slice(0, TABLE_ROWS);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Actions used</h3>
        <span className="faint num small">({actions.length})</span>
        <span className="spacer" />
        <SearchInput value={search} onChange={setSearch} placeholder="Filter…" style={{ width: 150 }} />
      </div>
      <div className="table-wrap" style={{ maxHeight: 440 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Version</th>
              <th className="num">Uses</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((action) => (
              <tr key={action.name}>
                <td style={{ maxWidth: 260 }}>
                  <span className="mono truncate" style={{ fontWeight: 600, display: 'block' }} title={action.workflows.join('\n')}>
                    {action.name}
                  </span>
                  <span className="tiny faint">{action.official ? 'first-party' : action.kind}</span>
                </td>
                <td>
                  <span className="row" style={{ gap: 4 }}>
                    {action.versions.map((version) => (
                      <span key={version.ref} className={`badge ${PIN_TONE[version.pin]} mono`} title={PIN_HINT[version.pin]}>
                        {version.ref ? version.ref.slice(0, 12) : 'none'}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="num">{action.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">No action matches.</div>}
      </div>
      {rows.length > TABLE_ROWS && (
        <div style={{ padding: '8px 14px' }}>
          <button className="btn ghost sm" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

function ScriptsCard({ scripts }: { scripts: ScriptUse[] }) {
  const missing = scripts.filter((s) => !s.runs.length);
  const [all, setAll] = useState(false);
  const rows = [...scripts].sort((a, b) => Number(!!a.runs.length) - Number(!!b.runs.length) || a.name.localeCompare(b.name));
  const shown = all ? rows : rows.slice(0, TABLE_ROWS);
  return (
    <div className="card">
      <div className="card-head">
        <h3>package.json scripts in CI</h3>
        <span className="tiny faint">{scripts.length - missing.length} of {scripts.length} run</span>
      </div>
      <div className="card-body stack" style={{ gap: 6 }}>
        {shown.map((script) => (
          <div key={script.name} className="row nowrap small" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span className="mono" style={{ fontWeight: 600, minWidth: 100 }}>
              {script.name}
            </span>
            {script.runs.length ? (
              <span className="muted truncate" title={script.runs.map((r) => `${r.file.replace('.github/workflows/', '')} › ${r.job}`).join('\n')}>
                {script.runs.map((r) => `${r.job}`).join(', ')}
              </span>
            ) : (
              <span className="badge" title="No workflow runs it: a regression here is only found on your machine">
                not run by CI
              </span>
            )}
          </div>
        ))}
        {rows.length > TABLE_ROWS && (
          <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </button>
        )}
        {!scripts.length && <div className="small muted">package.json has no scripts.</div>}
      </div>
    </div>
  );
}

function SchedulesCard({ workflows }: { workflows: WorkflowInfo[] }) {
  const now = Date.now();
  const schedules = workflows
    .flatMap((w) => w.triggers.filter((t) => t.event === 'schedule').flatMap((t) => (t.cron ?? []).map((cron) => ({ workflow: w.name, cron, next: nextCronRun(cron, now) }))))
    .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
  return (
    <div className="card">
      <div className="card-head">
        <Clock size={16} className="muted" />
        <h3>Schedules</h3>
        <span className="tiny faint">cron runs in UTC</span>
      </div>
      <div className="card-body stack" style={{ gap: 8 }}>
        {schedules.map((s) => (
          <div key={`${s.workflow}:${s.cron}`} className="small">
            <div className="row nowrap" style={{ gap: 8 }}>
              <b className="truncate">{s.workflow}</b>
              <span className="spacer" />
              <span className="badge info" title={s.next ? new Date(s.next).toLocaleString() : undefined}>
                {timeUntil(s.next)}
              </span>
            </div>
            <div className="tiny muted">
              {describeCron(s.cron)} <span className="mono faint">({s.cron})</span>
            </div>
          </div>
        ))}
        {!schedules.length && <div className="small muted">No workflow runs on a schedule.</div>}
      </div>
    </div>
  );
}

function SetupCard({ ci }: { ci: CiReport }) {
  const secrets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of ci.workflows) for (const name of w.secrets) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [ci.workflows]);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Setup</h3>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="small">
          <span className="muted">Node.js tested: </span>
          {ci.nodeVersions.length ? ci.nodeVersions.map((v) => (
              <span key={v} className="badge info" style={{ marginRight: 4 }}>
                {v}
              </span>
            )) : <span className="muted">no setup-node step</span>}
        </div>
        <div className="small">
          <span className="muted">Dependabot: </span>
          {ci.dependabot ? ci.dependabot.ecosystems.map((e) => (
              <span key={`${e.name}:${e.directory}`} className={`badge ${e.name === 'github-actions' ? 'success' : ''}`} style={{ marginRight: 4 }} title={`${e.directory}${e.interval ? ` · ${e.interval}` : ''}`}>
                {e.name}
              </span>
            )) : <span className="muted">not configured</span>}
        </div>
        {ci.localActions.length > 0 && (
          <div className="small">
            <div className="muted" style={{ marginBottom: 4 }}>Local actions</div>
            {ci.localActions.map((action) => (
              <div key={action.path} className="row nowrap" style={{ gap: 8, padding: '2px 0' }}>
                <span className="mono truncate" title={action.description}>{action.path.replace('.github/actions/', '')}</span>
                <span className="tiny faint">{action.inputs.length ? plural(action.inputs.length, 'input') : 'no inputs'}</span>
                <span className="spacer" />
                <span className={`badge ${action.usedBy ? '' : 'warn'}`}>{action.usedBy ? `used ${action.usedBy}×` : 'unused'}</span>
              </div>
            ))}
          </div>
        )}
        {secrets.length > 0 && (
          <div className="small">
            <div className="muted" style={{ marginBottom: 4 }}>Secrets the workflows read (names only)</div>
            <span className="row" style={{ gap: 4 }}>
              {secrets.map(([name, count]) => (
                <span key={name} className="badge mono" title={`${plural(count, 'workflow')}`}>
                  {name}
                </span>
              ))}
            </span>
            <div className="tiny faint" style={{ marginTop: 4 }}>Check each exists under Settings → Secrets: a missing one is an empty string, not an error.</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ActionsView() {
  const { data } = useModel();
  const ci = data.ci;
  useRefreshOnFocus();
  if (!ci) {
    return (
      <div className="page">
        <Empty icon={CirclePlay} title="No GitHub Actions workflows">
          Workflows live in <code>.github/workflows/*.yml</code>. Add one and this view maps its jobs, checks it for mistakes and shows what runs for your changes.
        </Empty>
      </div>
    );
  }
  const errors = ci.findings.filter((f) => f.severity === 'error').length;
  const warnings = ci.findings.filter((f) => f.severity === 'warning').length;
  const thirdParty = ci.actions.filter((a) => a.kind === 'marketplace' && !a.official);
  const pinned = thirdParty.filter((a) => a.versions.every((v) => v.pin === 'sha')).length;
  const jobs = ci.workflows.reduce((n, w) => n + w.jobs.length, 0);
  const scheduled = ci.workflows.filter((w) => w.triggers.some((t) => t.event === 'schedule'));
  return (
    <div className="page">
      <div className="grid cols-4 stats">
        <Stat icon={WorkflowIcon} value={fmtNum(ci.workflows.length)} label="Workflows" hint={plural(jobs, 'job')} color="#38bdf8" />
        <Stat icon={TriangleAlert} value={fmtNum(ci.findings.length)} label="Findings" hint={`${plural(errors, 'error')}, ${plural(warnings, 'warning')}`} color={errors ? '#f87171' : warnings ? '#fbbf24' : '#34d399'} />
        <Stat icon={ShieldCheck} value={thirdParty.length ? pct(pinned, thirdParty.length) : '–'} label="Third-party actions pinned" hint={thirdParty.length ? `${pinned} of ${thirdParty.length} use a commit SHA` : 'only first-party actions'} color={thirdParty.length && pinned < thirdParty.length ? '#fbbf24' : '#34d399'} />
        <Stat icon={Clock} value={fmtNum(scheduled.length)} label="Scheduled workflows" hint={scheduled.length ? scheduled.map((w) => w.name).join(', ') : 'nothing runs on a timer'} color="#a78bfa" />
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <RefreshButton what="workflows" />
      </div>
      <WorkflowsCard ci={ci} />

      <div style={{ marginTop: 16 }}>
        <WorkflowForecast ci={ci} />
      </div>
      <div style={{ marginTop: 16 }}>
        <WorkflowFindings findings={ci.findings} linkable={!ci.base} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <ActionsCard actions={ci.actions} />
        <ScriptsCard scripts={ci.scripts} />
      </div>
      <div className="grid cols-2" style={{ marginTop: 16, alignItems: 'start' }}>
        <SchedulesCard workflows={ci.workflows} />
        <SetupCard ci={ci} />
      </div>
      <p className="tiny faint" style={{ marginTop: 12 }}>
        Read from <code>.github/workflows</code> without running anything or asking GitHub: the rules are the common ones (script injection, unpinned actions, missing permissions, scripts that do not exist), so they are hints, not a replacement for <code>actionlint</code>.
      </p>
    </div>
  );
}
