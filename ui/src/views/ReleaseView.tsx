import { useMemo, useState } from 'react';
import { Check, ExternalLink, GitCommitHorizontal, Rocket, TriangleAlert, Users, X } from 'lucide-react';
import { useModel } from '../data/context';
import { releaseNotesMarkdown } from '../../../src/shared/release';
import { fmtNum, plural, timeAgo } from '../lib/format';
import { selectFile } from '../state/store';
import { CopyButton, Empty, Stat, Tabs, Toggle } from '../components/ui';
import type { CommitType, ExportChange, ReleaseBump, ReleaseCheck, ReleaseCommit, ReleasePlan } from '../types';

const BUMP_TONE: Record<ReleaseBump, string> = { none: '', patch: 'success', minor: 'info', major: 'danger' };
const COMMIT_TONE: Partial<Record<CommitType, string>> = { feat: 'accent', fix: 'success', perf: 'info', revert: 'warn' };
/** Commits listed in the view; the plan keeps at most a few hundred and `commitCount` has the real number. */
const MAX_LISTED_COMMITS = 100;

function BumpCard({ plan }: { plan: ReleasePlan }) {
  const { bump } = plan;
  return (
    <div className="card" style={{ flex: 2, minWidth: 320 }}>
      <div className="card-head">
        <h3>Suggested version</h3>
        <span className="spacer" />
        {plan.compareUrl && (
          <a className="btn ghost sm" href={plan.compareUrl} target="_blank" rel="noreferrer" title={plan.compareUrl}>
            <ExternalLink size={13} /> Compare on the host
          </a>
        )}
      </div>
      <div className="card-body">
        <div className="row" style={{ gap: 12, alignItems: 'baseline' }}>
          <span className={`badge ${BUMP_TONE[bump.level]}`} style={{ fontSize: 13, textTransform: 'uppercase' }}>
            {bump.level}
          </span>
          {bump.next ? (
            <span className="mono" style={{ fontSize: 22, fontWeight: 700 }}>
              {plan.lastVersion} <span className="faint">→</span> {bump.next}
            </span>
          ) : (
            <span className="muted">{bump.level === 'none' ? 'Nothing to release' : 'No semantic version to bump'}</span>
          )}
        </div>
        <ul className="small" style={{ margin: '12px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
          {bump.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {bump.fromApi && bump.fromApi !== bump.fromCommits && (
          <p className="tiny muted" style={{ marginTop: 10 }}>
            The commits alone ask for <b>{bump.fromCommits}</b>; the changes to the published API ask for <b>{bump.fromApi}</b>. The higher one wins.
          </p>
        )}
        {plan.packageVersion && plan.lastVersion && plan.packageVersion !== plan.lastVersion && (
          <p className="tiny" style={{ marginTop: 10, color: 'var(--warning)' }}>
            package.json says {plan.packageVersion}, but the last tag is {plan.tag}.
          </p>
        )}
      </div>
    </div>
  );
}

function ChecksCard({ checks }: { checks: ReleaseCheck[] }) {
  return (
    <div className="card" style={{ flex: 1, minWidth: 280 }}>
      <div className="card-head">
        <h3>Ready to release?</h3>
      </div>
      <div className="card-body">
        {checks.map((check) => (
          <div key={check.id} className="row nowrap small" style={{ gap: 8, padding: '4px 0', alignItems: 'flex-start' }} title={check.detail}>
            {check.ok ? <Check size={15} style={{ color: 'var(--success)', flexShrink: 0 }} /> : <X size={15} style={{ color: 'var(--danger)', flexShrink: 0 }} />}
            <span>
              {check.label}
              {!check.ok && check.detail && <span className="tiny muted"> · {check.detail}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApiChanges({ changes }: { changes: ExportChange[] }) {
  const [internal, setInternal] = useState(false);
  const published = changes.filter((c) => c.entry);
  const shown = internal ? changes : published;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h3>
          {internal ? 'Export changes' : 'Published API changes'} <span className="faint num">({fmtNum(shown.length)})</span>
        </h3>
        <span className="spacer" />
        {changes.length > published.length && <Toggle checked={internal} onChange={setInternal} label="Include internal exports" title="Exports no package.json entry point publishes: only this project's own code imports them" />}
      </div>
      {shown.length === 0 ? (
        <div className="muted small" style={{ padding: '14px 16px' }}>
          {published.length === 0 && changes.length > 0 ? 'The published API did not change.' : 'No changes to what the package exposes.'}
        </div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 360 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Change</th>
                <th>Export</th>
                <th>Declaration</th>
                <th className="num">Importers</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={`${c.file}#${c.name}`} onClick={() => selectFile(c.file, c.line)} title={c.file}>
                  <td>
                    <span className={`badge ${c.breaking ? 'danger' : 'success'}`}>{c.breaking ? `breaking · ${c.change}` : c.change}</span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontWeight: 600 }}>
                      {c.name}
                    </span>
                    <div className="tiny faint mono truncate">{c.file}</div>
                  </td>
                  <td className="mono tiny muted" style={{ maxWidth: 420 }}>
                    {c.before && c.after ? `${c.before} → ${c.after}` : (c.after ?? c.before ?? '')}
                  </td>
                  <td className="num">{c.importers.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CommitRow({ commit }: { commit: ReleaseCommit }) {
  return (
    <div className="row nowrap small" style={{ gap: 8, padding: '5px 12px' }}>
      <span className={`badge ${commit.breaking ? 'danger' : (COMMIT_TONE[commit.type] ?? '')}`} style={{ minWidth: 64, justifyContent: 'center' }}>
        {commit.breaking ? 'breaking' : commit.type}
      </span>
      <span className="truncate" title={commit.subject}>
        {commit.scope && <b>{commit.scope}: </b>}
        {commit.description}
      </span>
      {commit.pr && <span className="tiny faint">#{commit.pr}</span>}
      <span className="spacer" />
      <span className="tiny muted truncate" style={{ maxWidth: 140 }}>
        {commit.author}
      </span>
      <span className="tiny faint">{timeAgo(commit.date)}</span>
      <span className="mono tiny faint">{commit.hash.slice(0, 7)}</span>
    </div>
  );
}

function CommitsAndNotes({ plan }: { plan: ReleasePlan }) {
  const [tab, setTab] = useState<'commits' | 'notes'>('commits');
  const notes = useMemo(() => releaseNotesMarkdown(plan, { date: new Date() }), [plan]);
  const hidden = plan.commitCount - Math.min(plan.commits.length, MAX_LISTED_COMMITS);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'commits', label: 'Commits', count: plan.commitCount, icon: GitCommitHorizontal },
            { value: 'notes', label: 'Release notes' },
          ]}
        />
        <span className="spacer" />
        {tab === 'notes' && <CopyButton text={notes} label="Copy Markdown" />}
      </div>
      {tab === 'notes' ? (
        <pre style={{ margin: 0, padding: 16, whiteSpace: 'pre-wrap', maxHeight: 520, overflow: 'auto', fontSize: 12.5 }}>{notes}</pre>
      ) : (
        <div style={{ padding: '6px 0', maxHeight: 520, overflowY: 'auto' }}>
          {plan.commits.slice(0, MAX_LISTED_COMMITS).map((commit) => (
            <CommitRow key={commit.hash} commit={commit} />
          ))}
          {hidden > 0 && <div className="tiny faint" style={{ padding: '8px 12px' }}>+{fmtNum(hidden)} older commits</div>}
          {!plan.commits.length && <div className="muted small" style={{ padding: '14px 16px' }}>No commits since {plan.tag}.</div>}
        </div>
      )}
    </div>
  );
}

export function ReleaseView() {
  const { data } = useModel();
  const plan = data.release;
  if (!plan) return <Empty icon={Rocket} title="No release plan" />;
  if (!plan.tag) {
    return (
      <div className="page">
        <Empty icon={Rocket} title="No version tag yet">
          {plan.bump.reasons[0]} Once a release is tagged, this view lists what changed since, the version that fits and the release notes.
        </Empty>
      </div>
    );
  }
  const contributors = new Set(plan.commits.map((c) => c.author)).size;
  const published = plan.apiChanges.filter((c) => c.entry);
  const breaking = published.filter((c) => c.breaking).length;
  return (
    <div className="page">
      {plan.warnings?.map((warning) => (
        <div key={warning} className="card small" style={{ padding: '10px 14px', marginBottom: 12, color: 'var(--warning)' }}>
          <TriangleAlert size={14} style={{ verticalAlign: -2 }} /> {warning}
        </div>
      ))}
      <div className="grid cols-3 stats">
        <Stat icon={Rocket} value={plan.tag} label="Last release" hint={plan.tagDate ? timeAgo(plan.tagDate) : undefined} color="#a78bfa" />
        <Stat icon={GitCommitHorizontal} value={fmtNum(plan.commitCount)} label="Commits since" hint={plural(plan.commits.filter((c) => c.type === 'feat').length, 'feature') + ', ' + plural(plan.commits.filter((c) => c.type === 'fix').length, 'fix', 'fixes')} color="#38bdf8" />
        <Stat icon={Users} value={fmtNum(contributors)} label="Contributors" hint={breaking ? `${plural(breaking, 'breaking API change')}` : 'no breaking API changes'} color={breaking ? '#f87171' : '#34d399'} />
      </div>
      <div className="row" style={{ gap: 16, marginTop: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <BumpCard plan={plan} />
        {plan.checks.length > 0 && <ChecksCard checks={plan.checks} />}
      </div>
      <ApiChanges changes={plan.apiChanges} />
      <CommitsAndNotes plan={plan} />
      <p className="tiny faint" style={{ marginTop: 12 }}>
        Commits are read as Conventional Commits; other messages are sorted by their first verb. The API changes compare your code with {plan.tag}, so a commit called “fix” that removes an export still asks for a major version. Run{' '}
        <code>code-visualizer release --notes</code> for the same notes in the terminal.
      </p>
    </div>
  );
}
