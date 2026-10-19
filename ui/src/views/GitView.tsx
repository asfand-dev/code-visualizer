import { Archive, Check, FolderGit2, GitBranch, GitCommitHorizontal, LifeBuoy, TriangleAlert } from 'lucide-react';
import { OLD_STASH_DAYS, usesConventionalCommits } from '../../../src/shared/git-insights';
import { useModel } from '../data/context';
import { fmtBytes, fmtNum, pct, plural, timeAgo } from '../lib/format';
import { useRefreshOnFocus } from '../lib/use-refresh-on-focus';
import { AttentionList, useRepoAttention } from '../components/RepoAttention';
import { CommandBlock } from '../components/CommandBlock';
import { GitBranches } from '../components/GitBranches';
import { RefreshButton } from '../components/RefreshButton';
import { BarList, CopyButton, Empty, Stat } from '../components/ui';
import type { CommitStyle, ConfigAdvice, GitHygiene, RepoInsights, StashInfo, WorktreeInfo } from '../types';

const MS_PER_DAY = 86_400_000;
/** Longest list of tracked files, stashes or commits the cards show before a "+N more". */
const LISTED = 8;
const UNWANTED_TONE: Record<GitHygiene['unwanted'][number]['kind'], string> = { secret: 'danger', dependency: 'warn', build: '', junk: '' };

function StashesCard({ stashes }: { stashes: StashInfo[] }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Stashes</h3>
        <span className="faint num small">({stashes.length})</span>
      </div>
      {stashes.length === 0 ? (
        <div className="muted small" style={{ padding: '14px 18px' }}>
          Nothing stashed.
        </div>
      ) : (
        <div className="card-body stack" style={{ gap: 10 }}>
          {stashes.slice(0, LISTED).map((stash) => (
            <div key={stash.ref} className="row nowrap small" style={{ gap: 8, alignItems: 'flex-start' }}>
              <span className="mono faint" style={{ flexShrink: 0 }}>
                {stash.ref}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className="truncate" style={{ display: 'block' }} title={stash.message}>
                  {stash.message}
                </span>
                <span className="tiny faint" title={stash.files.join('\n')}>
                  {plural(stash.fileCount, 'file')} · {timeAgo(stash.date)}
                </span>
              </span>
              {Date.now() - stash.date > OLD_STASH_DAYS * MS_PER_DAY && (
                <span className="badge warn" title="Apply or drop it before you forget what it holds">
                  old
                </span>
              )}
              <CopyButton text={`git stash show -p ${stash.ref}`} />
            </div>
          ))}
          {stashes.length > LISTED && <div className="tiny faint">+{stashes.length - LISTED} more: git stash list</div>}
          <div className="tiny faint">
            Copy gives <code>git stash show -p</code>; then <code>git stash apply</code> keeps it, <code>git stash pop</code> uses it up.
          </div>
        </div>
      )}
    </div>
  );
}

function WorktreesCard({ worktrees }: { worktrees: WorktreeInfo[] }) {
  const prunable = worktrees.some((w) => w.prunable);
  return (
    <div className="card">
      <div className="card-head">
        <h3>Worktrees</h3>
        <span className="faint num small">({worktrees.length})</span>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {worktrees.map((tree) => (
          <div key={tree.path} className="small">
            <div className="row nowrap" style={{ gap: 6 }}>
              <FolderGit2 size={14} className="muted" style={{ flexShrink: 0 }} />
              <span className="mono truncate" title={tree.path}>
                {tree.path}
              </span>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 3, paddingLeft: 20 }}>
              <span className="mono tiny">{tree.branch ?? (tree.detached ? 'detached HEAD' : '–')}</span>
              {tree.head && <span className="tiny faint mono">{tree.head.slice(0, 7)}</span>}
              {tree.main && <span className="badge">main</span>}
              {tree.locked && <span className="badge">locked</span>}
              {tree.prunable && <span className="badge warn">folder is gone</span>}
            </div>
          </div>
        ))}
        {worktrees.length <= 1 && (
          <div className="tiny faint">
            A worktree gives a branch its own folder, so you can review a pull request without stashing your work: <code>git worktree add ../review-x some-branch</code>.
          </div>
        )}
        {prunable && <CommandBlock commands="git worktree prune" />}
      </div>
    </div>
  );
}

function RescueCard({ repo }: { repo: RepoInsights }) {
  if (!repo.rescue.length) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <LifeBuoy size={16} className="muted" />
        <h3>Commits no branch has any more</h3>
        <span className="faint num small">({repo.rescue.length})</span>
        <span className="spacer" />
        <span className="tiny faint">only the reflog remembers them; git deletes them after about a month</span>
      </div>
      <div className="card-body stack" style={{ gap: 8 }}>
        {repo.rescue.map((commit) => {
          const short = commit.hash.slice(0, 7);
          return (
            <div key={commit.hash} className="row nowrap small" style={{ gap: 8 }}>
              <span className="mono faint">{short}</span>
              <span className="truncate" style={{ flex: 1 }} title={commit.subject}>
                {commit.subject}
              </span>
              <span className="tiny faint truncate" style={{ maxWidth: 140 }}>
                {commit.author}
              </span>
              <span className="tiny faint" style={{ whiteSpace: 'nowrap' }}>
                {timeAgo(commit.date)}
              </span>
              <CopyButton text={`git branch rescue/${short} ${short}`} label="Rescue" />
            </div>
          );
        })}
        <div className="tiny faint">
          “Rescue” copies a command that puts a branch on the commit, so it is kept. Look at it first with <code>git show {repo.rescue[0].hash.slice(0, 7)}</code>.
        </div>
      </div>
    </div>
  );
}

function StyleCard({ style }: { style: CommitStyle }) {
  const own = style.analyzed - style.merges;
  const conventional = usesConventionalCommits(style);
  const types = Object.entries(style.types)
    .filter(([, count]) => count)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([type, count]) => ({ key: type, label: <span className="mono">{type}</span>, value: count ?? 0 }));
  const facts: [string, string, boolean?][] = [
    ['With an explanation in the body', pct(style.withBody, own)],
    ['Subjects over 72 characters', fmtNum(style.longSubjects), style.longSubjects > own / 5],
    ['Work-in-progress commits (wip, fixup!, squash!)', fmtNum(style.wip), style.wip > 0],
    ['Reverts', fmtNum(style.reverts)],
    ['Linked to a pull request', pct(style.prRefs, own)],
    ['Average subject length', `${style.avgSubject} characters`],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <GitCommitHorizontal size={16} className="muted" />
        <h3>Commit messages</h3>
        <span className="tiny faint">last {plural(style.analyzed, 'commit')}</span>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
          <span style={{ fontSize: 26, fontWeight: 700 }}>{pct(style.conventional, own)}</span>
          <span className="small muted">follow Conventional Commits (<code>type(scope): text</code>)</span>
        </div>
        {types.length > 0 && <BarList items={types} />}
        <div className="small">
          {facts.map(([label, value, warn]) => (
            <div key={label} className="row nowrap" style={{ gap: 8, padding: '3px 0' }}>
              <span className="muted truncate" style={{ flex: 1 }}>
                {label}
              </span>
              <span className="num" style={warn ? { color: 'var(--warning)', fontWeight: 600 } : undefined}>
                {value}
              </span>
            </div>
          ))}
        </div>
        <div className="tiny muted">
          {conventional
            ? 'The history is consistent: the Release view builds a changelog and the next version from it.'
            : 'Messages vary. Agreeing on one format (Conventional Commits is the common one) makes history searchable and releases automatic; the Git toolbox checks a message before you commit.'}
        </div>
      </div>
    </div>
  );
}

function HygieneCard({ hygiene }: { hygiene: GitHygiene }) {
  const { objects } = hygiene;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Repository hygiene</h3>
        <span className="tiny faint">{plural(hygiene.trackedFiles, 'tracked file')}</span>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {hygiene.unwanted.length === 0 && hygiene.large.length === 0 ? (
          <div className="small">
            <Check size={14} style={{ color: 'var(--success)', verticalAlign: -2 }} /> No secrets, installed dependencies or big files are tracked.
          </div>
        ) : (
          <>
            {hygiene.unwanted.slice(0, LISTED).map((item) => (
              <div key={item.path} className="row nowrap small" style={{ gap: 8 }}>
                <span className={`badge ${UNWANTED_TONE[item.kind]}`}>{item.kind}</span>
                <span className="mono truncate" title={item.path}>
                  {item.path}
                </span>
                {item.count !== undefined && <span className="tiny faint">{plural(item.count, 'file')}</span>}
              </div>
            ))}
            {hygiene.unwanted.length > LISTED && <div className="tiny faint">+{hygiene.unwanted.length - LISTED} more</div>}
            {hygiene.large.slice(0, LISTED).map((item) => (
              <div key={item.path} className="row nowrap small" style={{ gap: 8 }}>
                <span className="badge warn">{fmtBytes(item.size)}</span>
                <span className="mono truncate" title={item.path}>
                  {item.path}
                </span>
              </div>
            ))}
          </>
        )}
        <div className="small muted">
          History takes {fmtBytes(objects.packKiB * 1024)} in {plural(objects.packs, 'pack')}
          {objects.loose > 0 ? `, plus ${fmtNum(objects.loose)} loose objects (${fmtBytes(objects.looseKiB * 1024)})` : ''}.
        </div>
        {!hygiene.gitignore && (
          <div className="small" style={{ color: 'var(--warning)' }}>
            <TriangleAlert size={13} style={{ verticalAlign: -2 }} /> There is no .gitignore.
          </div>
        )}
      </div>
    </div>
  );
}

const CONFIG_TONE: Record<ConfigAdvice['status'], string> = { ok: 'success', missing: 'warn', differs: 'info' };
const CONFIG_LABEL: Record<ConfigAdvice['status'], string> = { ok: 'set', missing: 'not set', differs: 'differs' };

function ConfigCard({ config }: { config: ConfigAdvice[] }) {
  const todo = config.filter((c) => c.status !== 'ok' && c.command);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h3>Git settings</h3>
        <span className="tiny faint">{config.length - todo.length} of {config.length} as recommended</span>
        <span className="spacer" />
        {todo.length > 0 && <CopyButton text={todo.map((c) => c.command).join('\n')} label="Copy all fixes" />}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Setting</th>
              <th>Now</th>
              <th>Why it helps</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {config.map((c) => (
              <tr key={c.key}>
                <td>
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {c.key}
                  </span>
                  <div className="tiny faint">{c.label}</div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span className={`badge ${c.essential && c.status === 'missing' ? 'danger' : CONFIG_TONE[c.status]}`}>{CONFIG_LABEL[c.status]}</span>
                  {c.value && <span className="mono tiny muted"> {c.value}</span>}
                  {c.status !== 'ok' && c.recommended && <div className="tiny faint">suggested: {c.recommended}</div>}
                </td>
                <td className="small muted" style={{ maxWidth: 420 }}>
                  {c.why}
                </td>
                <td>{c.status !== 'ok' && c.command && <CopyButton text={c.command} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function GitView() {
  const { data } = useModel();
  const repo = data.repo;
  const attention = useRepoAttention(repo);
  useRefreshOnFocus();
  if (!repo) {
    return (
      <div className="page">
        <Empty icon={GitBranch} title="No git repository">
          Git insights need a repository with at least one commit.
        </Empty>
      </div>
    );
  }
  const oldest = repo.stashes.length ? Math.min(...repo.stashes.map((s) => s.date)) : undefined;
  const own = repo.style.analyzed - repo.style.merges;
  return (
    <div className="page">
      <div className="grid cols-4 stats">
        <Stat icon={GitBranch} value={fmtNum(repo.branchTotals.local)} label="Local branches" hint={`${plural(repo.branchTotals.merged, 'merged branch', 'merged branches')} · ${fmtNum(repo.branchTotals.remote)} remote`} color="#38bdf8" />
        <Stat icon={Archive} value={fmtNum(repo.stashes.length)} label="Stashes" hint={oldest ? `oldest ${timeAgo(oldest)}` : 'nothing stashed'} color={repo.stashes.length ? '#fbbf24' : '#34d399'} />
        <Stat icon={LifeBuoy} value={fmtNum(repo.rescue.length)} label="Lost commits" hint={repo.rescue.length ? 'only the reflog has them' : 'nothing to rescue'} color={repo.rescue.length ? '#f87171' : '#34d399'} />
        <Stat icon={GitCommitHorizontal} value={pct(repo.style.conventional, own)} label="Conventional commits" hint={`of the last ${plural(repo.style.analyzed, 'commit')}`} color="#a78bfa" />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Needs attention</h3>
          <span className="faint num small">({attention.length})</span>
          <span className="spacer" />
          <RefreshButton />
        </div>
        <div className="card-body">
          {attention.length ? (
            <AttentionList items={attention} />
          ) : (
            <div className="small">
              <Check size={14} style={{ color: 'var(--success)', verticalAlign: -2 }} /> The repository is in good shape: no stale branches, lost commits or risky files.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <GitBranches repo={repo} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <StashesCard stashes={repo.stashes} />
        <WorktreesCard worktrees={repo.worktrees} />
      </div>

      <RescueCard repo={repo} />

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <StyleCard style={repo.style} />
        <HygieneCard hygiene={repo.hygiene} />
      </div>

      <ConfigCard config={repo.config} />
      <p className="tiny faint" style={{ marginTop: 12 }}>
        Everything here is read with plain git commands; nothing is fetched, and git settings are read from a short list (never your e-mail address or credentials). Deleting merged branches is the only thing the page can change, and only with the live server.
      </p>
    </div>
  );
}
