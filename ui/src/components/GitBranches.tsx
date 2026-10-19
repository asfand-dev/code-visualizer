import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2, Undo2 } from 'lucide-react';
import { deletableBranches, shellWord, STALE_BRANCH_DAYS } from '../../../src/shared/git-insights';
import { deleteBranches, liveConfig } from '../data/live';
import { fmtNum, plural, timeAgo } from '../lib/format';
import { useRequest, type RequestHandle } from '../lib/use-request';
import { toast } from '../state/store';
import type { BranchDeleteResult, BranchInfo, RepoInsights } from '../types';
import { CommandBlock } from './CommandBlock';
import { SearchInput, Segmented } from './ui';

type BranchFilter = 'merged' | 'attention' | 'local' | 'remote';

const MS_PER_DAY = 86_400_000;

interface Flag {
  label: string;
  tone: string;
  title?: string;
}

/** What is notable about a branch, as badges. */
function branchFlags(branch: BranchInfo, context: { hasRemote: boolean; base: string; now: number }): Flag[] {
  const flags: Flag[] = [];
  if (branch.current) flags.push({ label: 'current', tone: 'accent' });
  if (branch.worktree) flags.push({ label: 'worktree', tone: 'info', title: `Checked out in ${branch.worktree}` });
  else if (branch.protected && !branch.current) flags.push({ label: 'protected', tone: '', title: 'The base branch or a name like main or develop: never offered for deletion' });
  if (branch.remote) return flags;
  if (branch.merged && !branch.protected) flags.push({ label: 'merged', tone: 'success', title: `Every commit is already in ${context.base}` });
  if (branch.gone && !branch.merged) flags.push({ label: 'remote deleted', tone: 'warn', title: 'The branch it tracked was deleted on the remote (usually after its pull request was merged)' });
  if (branch.unpushed) flags.push({ label: `${branch.unpushed} unpushed`, tone: 'warn', title: 'Commits that exist only on this computer' });
  else if (context.hasRemote && !branch.upstream && !branch.protected && branch.ahead > 0) flags.push({ label: 'never pushed', tone: 'warn', title: 'Only on this computer' });
  if (!branch.protected && !branch.merged && context.now - branch.date > STALE_BRANCH_DAYS * MS_PER_DAY) flags.push({ label: 'stale', tone: '', title: `Untouched for more than ${STALE_BRANCH_DAYS} days` });
  return flags;
}

const needsLook = (flags: Flag[]): boolean => flags.some((f) => f.tone === 'warn' || f.label === 'stale');

function Distance({ branch, base }: { branch: BranchInfo; base: string }) {
  if (branch.protected && !branch.ahead && !branch.behind) return <span className="faint">–</span>;
  return (
    <span className="row nowrap num" style={{ gap: 8 }} title={`${plural(branch.ahead, 'commit')} that ${base} does not have, ${plural(branch.behind, 'commit')} of ${base} it does not have`}>
      <span className={branch.ahead ? '' : 'faint'}>
        <ArrowUp size={11} style={{ verticalAlign: -1 }} />
        {branch.ahead}
      </span>
      <span className={branch.behind ? 'muted' : 'faint'}>
        <ArrowDown size={11} style={{ verticalAlign: -1 }} />
        {branch.behind}
      </span>
    </span>
  );
}

/**
 * The result of a deletion: what was removed (with the commands to bring it back) and what git or the server refused.
 * It lives outside the list of merged branches, which is gone once the analysis catches up.
 */
function CleanupResult({ result, onDismiss }: { result: BranchDeleteResult; onDismiss: () => void }) {
  const restore = result.deleted.map((d) => `git branch ${shellWord(d.name)} ${d.hash}`).join('\n');
  return (
    <div className="card-body cleanup-result stack" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="row" style={{ gap: 8 }}>
        {result.deleted.length > 0 ? (
          <>
            <b className="small">Deleted {plural(result.deleted.length, 'branch', 'branches')}.</b>
            <span className="tiny muted">Nothing is lost: each one can be brought back with the command below.</span>
          </>
        ) : (
          <b className="small">No branch was deleted.</b>
        )}
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {result.deleted.length > 0 && <CommandBlock commands={restore} />}
      {result.refused.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {result.refused.map((r) => (
            <li key={r.name}>
              <span className="mono">{r.name}</span> was kept: <span className="muted">{r.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The merged branches of a live server: pick and delete, in two clicks, with the undo command in hand. */
function Cleanup({ branches, base, request }: { branches: BranchInfo[]; base: string; request: RequestHandle<[string[]], BranchDeleteResult> }) {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const { state, run } = request;
  const chosen = branches.filter((b) => !skipped.has(b.name));
  const toggle = (name: string): void => {
    setConfirming(false);
    setSkipped((previous) => {
      const next = new Set(previous);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };
  const remove = async (): Promise<void> => {
    setConfirming(false);
    const result = await run(chosen.map((b) => b.name));
    if (result) toast(result.deleted.length ? `Deleted ${plural(result.deleted.length, 'branch', 'branches')}` : 'No branch was deleted', { tone: result.deleted.length ? 'success' : 'warning' });
  };
  return (
    <div className="cleanup">
      <div className="row" style={{ gap: 8 }}>
        <span className="small muted">
          <Trash2 size={13} style={{ verticalAlign: -2 }} /> {plural(chosen.length, 'merged branch', 'merged branches')} selected. The server checks each one again and only uses <code>git branch -d</code>, which refuses unmerged work.
        </span>
        <span className="spacer" />
        {confirming ? (
          <>
            <button className="btn sm" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn sm danger" onClick={remove}>
              Delete {plural(chosen.length, 'branch', 'branches')} of {base}
            </button>
          </>
        ) : (
          <button className="btn sm" disabled={!chosen.length || state.status === 'loading'} onClick={() => setConfirming(true)}>
            <Trash2 size={13} /> Delete selected…
          </button>
        )}
      </div>
      {state.status === 'error' && (
        <div className="small" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {state.message}
        </div>
      )}
      <div className="tiny faint" style={{ marginTop: 6 }}>
        <Undo2 size={11} style={{ verticalAlign: -1 }} /> Untick a branch to keep it.
      </div>
      <div className="cleanup-pick">
        {branches.map((b) => (
          <label key={b.name} className={`chip${skipped.has(b.name) ? ' keep' : ''}`} title={skipped.has(b.name) ? 'Kept' : 'Will be deleted'}>
            <input type="checkbox" checked={!skipped.has(b.name)} onChange={() => toggle(b.name)} />
            <span className="mono truncate">{b.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function GitBranches({ repo }: { repo: RepoInsights }) {
  const [filter, setFilter] = useState<BranchFilter>('merged');
  const [search, setSearch] = useState('');
  const context = useMemo(() => ({ hasRemote: repo.branches.some((b) => b.remote), base: repo.base, now: Date.now() }), [repo]);
  const rows = useMemo(() => repo.branches.map((branch) => ({ branch, flags: branchFlags(branch, context) })), [repo, context]);
  const locals = rows.filter((r) => !r.branch.remote);
  const merged = useMemo(() => deletableBranches(repo.branches), [repo.branches]);
  const attention = locals.filter((r) => needsLook(r.flags));

  const pool = filter === 'merged' ? locals.filter((r) => merged.includes(r.branch)) : filter === 'attention' ? attention : filter === 'local' ? locals : rows.filter((r) => r.branch.remote);
  const q = search.trim().toLowerCase();
  const shown = pool.filter((r) => !q || `${r.branch.name} ${r.branch.author} ${r.branch.subject}`.toLowerCase().includes(q));
  const live = !!liveConfig();
  const cleanup = useRequest(deleteBranches);

  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <h3>Branches</h3>
        <span className="tiny faint">compared with {repo.base}</span>
        <span className="spacer" />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'merged', label: `Merged (${merged.length})`, title: 'Safe to delete: every commit is already in the base branch' },
            { value: 'attention', label: `Needs a look (${attention.length})`, title: 'Unpushed, never pushed, remote deleted or stale' },
            { value: 'local', label: `Local (${repo.branchTotals.local})` },
            { value: 'remote', label: `Remote (${repo.branchTotals.remote})` },
          ]}
        />
        <SearchInput value={search} onChange={setSearch} placeholder="Filter branches…" style={{ width: 200 }} />
      </div>
      {cleanup.state.status === 'done' && <CleanupResult result={cleanup.state.value} onDismiss={cleanup.reset} />}
      {filter === 'merged' && merged.length > 0 && (
        <div className="card-body" style={{ borderBottom: '1px solid var(--border)' }}>
          {live ? <Cleanup branches={merged} base={repo.base} request={cleanup} /> : <CommandBlock commands={`git branch -d ${merged.map((b) => shellWord(b.name)).join(' ')}`} />}
        </div>
      )}
      <div className="table-wrap" style={{ maxHeight: 480 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Branch</th>
              {repo.aheadBehind && <th title={`Commits ahead of and behind ${repo.base}`}>vs {repo.base}</th>}
              <th>Last commit</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ branch, flags }) => (
              <tr key={`${branch.remote}:${branch.name}`}>
                <td style={{ maxWidth: 280 }}>
                  <span className="mono truncate" style={{ fontWeight: 600, display: 'block' }} title={branch.name}>
                    {branch.name}
                  </span>
                  <span className="tiny faint truncate" style={{ display: 'block' }} title={branch.upstream ? `tracks ${branch.upstream}` : undefined}>
                    {branch.upstream ? `→ ${branch.upstream}` : branch.remote ? '' : 'not pushed'}
                  </span>
                </td>
                {repo.aheadBehind && (
                  <td>
                    <Distance branch={branch} base={repo.base} />
                  </td>
                )}
                <td style={{ maxWidth: 320 }}>
                  <span className="small truncate" style={{ display: 'block' }} title={branch.subject}>
                    {branch.subject}
                  </span>
                  <span className="tiny faint">
                    {branch.author} · {timeAgo(branch.date)} · <span className="mono">{branch.hash}</span>
                  </span>
                </td>
                <td>
                  <span className="row" style={{ gap: 4 }}>
                    {flags.map((flag) => (
                      <span key={flag.label} className={`badge ${flag.tone}`} title={flag.title}>
                        {flag.label}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <div className="empty">{filter === 'merged' ? 'No merged branches: nothing to clean up.' : 'No branches match.'}</div>}
      </div>
      {(repo.branchTotals.local > locals.length || repo.branchTotals.remote > rows.length - locals.length) && (
        <div className="tiny faint" style={{ padding: '8px 18px' }}>
          Showing the {fmtNum(locals.length)} most recent local and {fmtNum(rows.length - locals.length)} remote branches of {fmtNum(repo.branchTotals.local)} and {fmtNum(repo.branchTotals.remote)}.
        </div>
      )}
      {!repo.aheadBehind && (
        <div className="tiny faint" style={{ padding: '8px 18px' }}>
          Your git is older than 2.41, so distances from {repo.base} are not shown; merged branches are still found.
        </div>
      )}
    </div>
  );
}
