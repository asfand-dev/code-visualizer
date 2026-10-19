import { useEffect, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { standupGroups, standupMarkdown } from '../../../src/shared/git-commit';
import { useModel } from '../data/context';
import { fetchStandup, liveConfig } from '../data/live';
import { timeAgo } from '../lib/format';
import { useRequest } from '../lib/use-request';
import { CopyButton } from './ui';

/** Days of commits the server returns; the standup shows today and the last working day before it. */
const STANDUP_DAYS = 7;

/** What you did yesterday and today, from your commits on every branch (live) or on this one (report). Ready to paste. */
export function Standup() {
  const { data } = useModel();
  const live = !!liveConfig();
  const { state, run } = useRequest(fetchStandup);
  useEffect(() => {
    if (live) void run(STANDUP_DAYS);
  }, [live, run]);

  // Live: only what the server answered (all branches). Report: the commits of the analyzed branch.
  const fetched = state.status === 'done' ? state.value : undefined;
  const user = live ? fetched?.user : data.git?.user;
  const commits = live ? fetched?.commits : data.git?.commits;
  const groups = useMemo(() => standupGroups(commits ?? [], { user, now: Date.now() }), [commits, user]);
  const text = standupMarkdown(groups);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Standup</h3>
        <span className="tiny faint">{live ? 'from all your branches' : 'from this branch'}</span>
        <span className="spacer" />
        {live && (
          <button className="btn ghost sm icon" onClick={() => run(STANDUP_DAYS)} title="Read the commits again" aria-label="Refresh standup">
            <RefreshCw size={13} className={state.status === 'loading' ? 'spin' : undefined} />
          </button>
        )}
        {text && <CopyButton text={text} label="Copy Markdown" />}
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {state.status === 'error' && <div className="small" style={{ color: 'var(--danger)' }}>{state.message}</div>}
        {groups.length === 0 && state.status === 'loading' && <div className="small muted">Reading your commits…</div>}
        {groups.length === 0 && (!live || state.status === 'done') && (
          <div className="small muted">{user ? `No commits by ${user} today or on the last day you committed.` : 'No recent commits.'}</div>
        )}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="small" style={{ fontWeight: 650, marginBottom: 4 }}>
              {group.label}
            </div>
            <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
              {group.commits.map((commit) => (
                <li key={commit.hash} title={timeAgo(commit.date)}>
                  {commit.subject}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {!user && groups.length > 0 && <div className="tiny faint">Git does not know your name here, so these are everybody’s commits: set it with <code>git config user.name</code>.</div>}
      </div>
    </div>
  );
}
