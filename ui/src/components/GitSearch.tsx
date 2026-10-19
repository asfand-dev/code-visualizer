import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { shellWord } from '../../../src/shared/git-insights';
import { fetchCommitDetail, liveConfig, searchHistory } from '../data/live';
import { fmtDate, fmtNum, plural, timeAgo } from '../lib/format';
import { useRequest } from '../lib/use-request';
import type { GitSearchCommit, GitSearchMode } from '../types';
import { CommandBlock } from './CommandBlock';
import { CopyButton, Segmented, Toggle } from './ui';

interface ModeInfo {
  label: string;
  placeholder: string;
  help: string;
}

const MODES: Record<GitSearchMode, ModeInfo> = {
  text: { label: 'Code', placeholder: 'a function name, a string, a setting…', help: 'Commits that added or removed exactly this text. The way to find who deleted a function, or when a value changed.' },
  regex: { label: 'Regex', placeholder: 'handle(Click|Press)', help: 'Commits whose changes contain a line matching this regular expression.' },
  message: { label: 'Message', placeholder: 'words from the commit message', help: 'Commits whose message contains this text (any case).' },
  author: { label: 'Author', placeholder: 'a name or part of an e-mail address', help: 'Commits by this author (any case).' },
  file: { label: 'File history', placeholder: 'src/auth/login.ts', help: 'Every commit that touched this file, following renames.' },
};
const MODE_ORDER: GitSearchMode[] = ['text', 'regex', 'message', 'author', 'file'];
/** The option each text search uses, given the text already quoted for a shell. */
const OPTION: Record<Exclude<GitSearchMode, 'file'>, (text: string) => string> = {
  text: (text) => `-S${text}`,
  regex: (text) => `-G${text}`,
  message: (text) => `--fixed-strings --regexp-ignore-case --grep=${text}`,
  author: (text) => `--fixed-strings --regexp-ignore-case --author=${text}`,
};

/** The same search for a terminal. */
function searchCommand(mode: GitSearchMode, query: string, all: boolean): string {
  const scope = all ? ' --all' : '';
  if (mode === 'file') return `git log --follow --oneline${scope} -- ${shellWord(query)}`;
  return `git log --oneline${scope} ${OPTION[mode](shellWord(query))}`;
}

function CommitDetail({ hash }: { hash: string }) {
  const { state, run } = useRequest(fetchCommitDetail);
  useEffect(() => {
    void run(hash);
  }, [hash, run]);
  if (state.status === 'error') return <div className="small" style={{ color: 'var(--danger)', padding: '8px 0' }}>{state.message}</div>;
  if (state.status !== 'done') return <div className="small muted" style={{ padding: '8px 0' }}>Loading…</div>;
  const commit = state.value;
  const short = commit.hash.slice(0, 7);
  return (
    <div className="commit-detail">
      {commit.body && <pre className="commit-body">{commit.body}</pre>}
      <div className="tiny muted" style={{ margin: '6px 0' }}>
        {fmtDate(commit.date)} · {plural(commit.fileCount, 'file')} · <span style={{ color: 'var(--success)' }}>+{fmtNum(commit.additions)}</span> <span style={{ color: 'var(--danger)' }}>−{fmtNum(commit.deletions)}</span>
        {commit.parents.length > 1 && ' · a merge, shown against its first parent'}
      </div>
      <div className="stack" style={{ gap: 2 }}>
        {commit.files.slice(0, 30).map((file) => (
          <div key={file.path} className="row nowrap tiny" style={{ gap: 8 }}>
            <span className="mono truncate" style={{ flex: 1 }} title={file.path}>
              {file.path}
            </span>
            {file.binary ? <span className="faint">binary</span> : <span className="num">
                <span style={{ color: 'var(--success)' }}>+{file.additions}</span> <span style={{ color: 'var(--danger)' }}>−{file.deletions}</span>
              </span>}
          </div>
        ))}
        {commit.fileCount > 30 && <div className="tiny faint">+{commit.fileCount - 30} more files</div>}
      </div>
      {commit.containedIn.length > 0 && (
        <div className="row" style={{ gap: 4, marginTop: 8 }}>
          <span className="tiny faint">In</span>
          {commit.containedIn.map((name) => (
            <span key={name} className="badge mono">
              {name}
            </span>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <CommandBlock commands={[`git show ${short}`, `git revert ${short}        # undo it with a new commit`, `git cherry-pick ${short}    # copy it onto the current branch`]} />
      </div>
    </div>
  );
}

function ResultRow({ commit, open, onToggle }: { commit: GitSearchCommit; open: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="search-result">
      <button className="list-item stacked" onClick={onToggle} aria-expanded={open}>
        <Chevron size={14} style={{ flexShrink: 0, marginTop: 3 }} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className="small wrap-anywhere" style={{ fontWeight: 600, display: 'block' }}>
            {commit.subject}
          </span>
          <span className="tiny faint mono truncate" style={{ display: 'block' }}>
            {commit.files.join(', ')}
            {commit.fileCount > commit.files.length ? ` +${commit.fileCount - commit.files.length}` : ''}
          </span>
        </span>
        <span className="meta">
          {commit.author} · {timeAgo(commit.date)} · <span className="mono">{commit.hash.slice(0, 7)}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px 36px' }}>
          <CommitDetail hash={commit.hash} />
        </div>
      )}
    </div>
  );
}

/** Looks through the history on the live server; in a report it still writes the command for your terminal. */
export function GitSearch() {
  const live = !!liveConfig();
  const [mode, setMode] = useState<GitSearchMode>('text');
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string>();
  const { state, run } = useRequest(searchHistory);
  const trimmed = query.trim();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setOpen(undefined);
    if (live && trimmed) void run(mode, trimmed, { all });
  };

  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <Search size={16} className="muted" />
        <h3>Search the history</h3>
        <span className="spacer" />
        <Segmented value={mode} onChange={setMode} options={MODE_ORDER.map((value) => ({ value, label: MODES[value].label }))} />
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        <div className="tiny muted">{MODES[mode].help}</div>
        <form className="row nowrap" style={{ gap: 8 }} onSubmit={submit}>
          <input className="input" style={{ flex: 1, minWidth: 0 }} value={query} placeholder={MODES[mode].placeholder} onChange={(e) => setQuery(e.target.value)} spellCheck={false} maxLength={200} aria-label="Search text" />
          <button className="btn primary" type="submit" disabled={!live || !trimmed || state.status === 'loading'}>
            Search
          </button>
        </form>
        <div className="row" style={{ gap: 12 }}>
          {mode !== 'file' && <Toggle checked={all} onChange={setAll} label="All branches" title="Also look in branches you have not checked out" />}
          {!live && <span className="tiny faint">Searching runs in the live server (code-visualizer serve). The command below does the same in your terminal.</span>}
        </div>
        {trimmed && <CommandBlock commands={searchCommand(mode, trimmed, all)} />}
        {state.status === 'loading' && <div className="small muted">Searching…</div>}
        {state.status === 'error' && <div className="small" style={{ color: 'var(--danger)' }}>{state.message}</div>}
        {state.status === 'done' && (
          <>
            <div className="row" style={{ gap: 8 }}>
              <b className="small">
                {state.value.commits.length ? `${state.value.truncated ? 'First ' : ''}${plural(state.value.commits.length, 'commit')}` : 'No commits found'}
              </b>
              <span className="tiny faint">newest first</span>
              <span className="spacer" />
              {state.value.commits.length > 0 && <CopyButton text={state.value.commits.map((c) => `${c.hash.slice(0, 7)} ${c.subject}`).join('\n')} label="Copy list" />}
            </div>
            <div className="list">
              {state.value.commits.map((commit) => (
                <ResultRow key={commit.hash} commit={commit} open={open === commit.hash} onToggle={() => setOpen(open === commit.hash ? undefined : commit.hash)} />
              ))}
            </div>
            {state.value.truncated && <div className="tiny faint">There are more. Make the search more specific, or use the command above.</div>}
          </>
        )}
      </div>
    </div>
  );
}
