import { useMemo } from 'react';
import { ArrowRight, GitBranch, Sparkles } from 'lucide-react';
import { repoAttention } from '../../../src/shared/git-insights';
import { navigate } from '../state/store';
import type { RepoAttention, RepoInsights } from '../types';
import { CommandBlock } from './CommandBlock';

const TONE: Record<RepoAttention['severity'], string> = { high: 'danger', medium: 'warn', low: 'info' };
/** Items the Today card lists; the Git view has all of them. */
const RADAR_ITEMS = 4;

/** What deserves a look in the repository, most urgent first. */
export function useRepoAttention(repo: RepoInsights | undefined): RepoAttention[] {
  return useMemo(() => (repo ? repoAttention(repo, { now: Date.now(), hasRemote: repo.branches.some((b) => b.remote) }) : []), [repo]);
}

export function AttentionList({ items, limit }: { items: RepoAttention[]; limit?: number }) {
  return (
    <div className="stack" style={{ gap: 0 }}>
      {items.slice(0, limit).map((item) => (
        <div key={item.id} className="attention">
          <div className="row nowrap" style={{ gap: 8, alignItems: 'flex-start' }}>
            <span className={`badge ${TONE[item.severity]}`} style={{ marginTop: 1 }}>
              {item.severity}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="small" style={{ fontWeight: 600 }}>
                {item.title}
              </div>
              {item.detail && <div className="tiny muted">{item.detail}</div>}
              {item.command && (
                <div style={{ marginTop: 6 }}>
                  <CommandBlock commands={item.command} />
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The Today card: the few things in the repository that need a look, or the news that nothing does. */
export function RepoRadarCard({ repo }: { repo: RepoInsights }) {
  const items = useRepoAttention(repo);
  return (
    <section className="card">
      <div className="card-head">
        <GitBranch size={16} className="muted" />
        <h3>Repository care</h3>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => navigate('git')}>
          Git insights <ArrowRight size={12} />
        </button>
      </div>
      <div className="card-body">
        {items.length ? (
          <>
            <AttentionList items={items} limit={RADAR_ITEMS} />
            {items.length > RADAR_ITEMS && (
              <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => navigate('git')}>
                {items.length - RADAR_ITEMS} more in the Git view
              </button>
            )}
          </>
        ) : (
          <div className="small muted">
            <Sparkles size={14} style={{ verticalAlign: -2, color: 'var(--success)' }} /> Branches, stashes and settings look tidy. Nothing to do here.
          </div>
        )}
      </div>
    </section>
  );
}
