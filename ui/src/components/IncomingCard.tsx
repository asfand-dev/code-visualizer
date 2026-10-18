import { useCallback, useEffect, useState } from 'react';
import { GitMerge, RefreshCw, Users } from 'lucide-react';
import { fetchSync, type LiveConfig } from '../data/live';
import { useModel } from '../data/context';
import { timeAgo } from '../lib/format';
import { selectFile, toast } from '../state/store';
import type { SyncReport } from '../types';
import { CopyMarkdownButton } from './companion';

/**
 * Incoming (daily-loop): what the base branch brings before you rebase — commits you don't have, files a
 * rebase would conflict in (a trial merge on the server), changes that merge cleanly but break your calls,
 * and teammates' branches touching your files. Live server only (`GET /api/sync`).
 */

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

function FileButton({ file, line, note }: { file: string; line?: number; note?: string }) {
  const model = useModel();
  const known = model.fileById.has(file);
  return (
    <button
      className="tag link mono"
      onClick={() => (known ? selectFile(file, line) : toast(`${file} is not part of the analysis`))}
      title={known ? 'Open' : undefined}
    >
      {file}
      {line ? `:${line}` : ''}
      {/* A flex item drops its leading space: the gap is a margin. */}
      {note && (
        <span className="faint" style={{ marginLeft: '0.6ch' }}>
          ({note})
        </span>
      )}
    </button>
  );
}

export function IncomingCard({ live, headKey }: { live: LiveConfig; headKey: string }) {
  const [report, setReport] = useState<SyncReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [branches, setBranches] = useState(false);

  const load = useCallback(
    (withBranches: boolean) => {
      setLoading(true);
      fetchSync(live, { branches: withBranches })
        .then((r) => {
          setReport(r);
          setError(undefined);
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [live],
  );
  // Again when HEAD or the base moves (a commit, a fetch, a branch switch).
  useEffect(() => load(branches), [load, headKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const behind = report?.behind ?? 0;
  const conflicts = report?.conflicts ?? [];
  // The trial merge covers your commits; uncommitted edits and untracked files are judged on the side.
  const committedConflicts = conflicts.filter((c) => !c.local);
  return (
    <section className="card">
      <div className="card-head">
        <GitMerge size={16} className="muted" />
        <h3>Incoming</h3>
        {report && <span className="tiny faint">from {report.base}</span>}
        <span className="spacer" />
        {!branches && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setBranches(true);
              load(true);
            }}
            title="Also check other branches that change your files"
          >
            <Users size={12} /> Branches
          </button>
        )}
        <button className="btn ghost sm" onClick={() => load(branches)} disabled={loading} title="Look again (uses the refs you fetched)">
          <RefreshCw size={12} style={{ opacity: loading ? 0.4 : 1 }} />
        </button>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {error && <div className="small" style={{ color: 'var(--danger)' }}>{error}</div>}
        {!report && !error && <div className="small muted">Looking at the base branch…</div>}
        {report && (
          <>
            <div className="small">
              {behind ? (
                <>
                  <strong>{report.base}</strong> is {plural(behind, 'commit')} ahead
                  {report.authors?.length ? <span className="muted"> · {report.authors.slice(0, 4).map((a) => `${a.name} ${a.commits}`).join(', ')}</span> : null}
                </>
              ) : (
                <span style={{ color: 'var(--success)' }}>✔ Up to date with {report.base}</span>
              )}
              {report.fetchedAgo !== undefined && <span className="faint"> · fetched {timeAgo(Date.now() - report.fetchedAgo)}</span>}
            </div>
            {behind > 0 && report.method === 'merge-tree' && !committedConflicts.length && (
              <div className="small" style={{ color: 'var(--success)' }}>✔ {report.ahead ? 'Your commits merge cleanly (trial merge)' : 'No commits of yours to merge'}</div>
            )}
            {conflicts.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                <div className="small" style={{ color: 'var(--danger)', fontWeight: 600 }}>✖ A rebase now conflicts in {plural(conflicts.length, 'file')}</div>
                <div className="tags">
                  {conflicts.slice(0, 8).map((c) => (
                    <FileButton key={c.file} file={c.file} note={c.local === 'uncommitted' ? 'your uncommitted edits' : c.local === 'untracked' ? 'untracked here, added upstream' : undefined} />
                  ))}
                </div>
              </div>
            )}
            {report.semantic.map((s) => (
              <div key={`${s.kind}:${s.file}:${s.symbol}`} className="stack" style={{ gap: 4 }}>
                <div className="small">
                  <span style={{ color: 'var(--warning)' }}>! </span>
                  <span className="mono">{s.message}</span>
                  {s.commit && (
                    <span className="faint">
                      {' '}
                      · {s.commit}
                      {s.author ? ` (${s.author})` : ''}
                    </span>
                  )}
                </div>
                <div className="row tiny muted" style={{ gap: 6 }}>
                  {s.kind === 'route-removed' ? 'you request it at' : s.kind === 'export-removed' ? 'you use it at' : 'you call it at'}
                  {s.yourSites.slice(0, 4).map((x) => (
                    <FileButton key={`${x.file}:${x.line}`} file={x.file} line={x.line} />
                  ))}
                </div>
              </div>
            ))}
            {report.overlap.length > 0 && (
              <div className="row tiny muted" style={{ gap: 6 }}>
                Also changed upstream:
                {report.overlap.slice(0, 6).map((o) => (
                  <FileButton key={o.file} file={o.file} note={o.clean ? 'merges cleanly' : o.local === 'uncommitted' ? 'uncommitted' : undefined} />
                ))}
              </div>
            )}
            {report.branches?.map((b) => (
              <div key={b.ref} className="small">
                <span style={{ color: b.result === 'conflict' ? 'var(--danger)' : 'var(--text-dim)' }}>{b.result === 'conflict' ? '✖' : '~'} </span>
                <strong className="mono">{b.ref}</strong>
                <span className="muted">
                  {' '}
                  ({b.author}, {timeAgo(b.updated)}) {b.result === 'conflict' ? 'conflicts with your work in' : 'also edits'}{' '}
                </span>
                <span className="mono">{(b.result === 'conflict' && b.conflictFiles.length ? b.conflictFiles : b.files).slice(0, 3).join(', ')}</span>
              </div>
            ))}
            {branches && report.branches && !report.branches.length && <div className="tiny faint">No other branch changes your files.</div>}
            {report.notes?.map((n) => (
              <div key={n} className="tiny" style={{ color: 'var(--warning)' }}>
                {n}
              </div>
            ))}
            {report.recommendation && (
              <div className="row" style={{ gap: 8 }}>
                <code className="small">{report.recommendation}</code>
                <span className="spacer" />
                <CopyMarkdownButton label="Copy command" getText={() => report.recommendation!} small />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
