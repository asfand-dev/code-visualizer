import { useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, Wand2 } from 'lucide-react';
import { commitCommand, formatCommit, lintCommitMessage, setCommitType, suggestCommit, type CommitProblem } from '../../../src/shared/git-commit';
import { usesConventionalCommits } from '../../../src/shared/git-insights';
import { useModel } from '../data/context';
import type { CommitType } from '../types';
import { CommandBlock } from './CommandBlock';
import { CopyButton, Select } from './ui';

const TYPES: CommitType[] = ['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore'];
const LEVEL_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info };
const LEVEL_COLOR = { error: 'var(--danger)', warning: 'var(--warning)', info: 'var(--info)' };

function Problems({ problems, message }: { problems: CommitProblem[]; message: string }) {
  if (!message.trim()) return <div className="tiny faint">Write or generate a message: it is checked the way reviewers read it.</div>;
  if (!problems.length) {
    return (
      <div className="small">
        <CircleCheck size={14} style={{ color: 'var(--success)', verticalAlign: -2 }} /> Reads well.
      </div>
    );
  }
  return (
    <ul className="stack" style={{ gap: 6, listStyle: 'none', margin: 0, padding: 0 }}>
      {problems.map((problem) => {
        const Icon = LEVEL_ICON[problem.level];
        return (
          <li key={problem.text} className="row nowrap small" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon size={14} style={{ color: LEVEL_COLOR[problem.level], flexShrink: 0, marginTop: 2 }} />
            <span>{problem.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Checks a commit message and writes one from your changes. Nothing is committed: you copy the command. */
export function CommitHelper() {
  const { data } = useModel();
  const [message, setMessage] = useState('');
  const conventional = !!data.repo && usesConventionalCommits(data.repo.style);
  const problems = useMemo(() => lintCommitMessage(message, { conventional }), [message, conventional]);
  const changes = data.changes;
  const suggestion = useMemo(() => (changes?.mode === 'working' ? suggestCommit(changes.files, changes.symbols) : undefined), [changes]);
  const type = /^(\w+)[(!:]/.exec(message)?.[1] ?? '';

  return (
    <div className="card">
      <div className="card-head">
        <h3>Commit message</h3>
        <span className="tiny faint">{conventional ? 'your history uses Conventional Commits' : 'checked like a reviewer would'}</span>
        <span className="spacer" />
        {suggestion && (
          <button className="btn sm" onClick={() => setMessage(formatCommit(suggestion))} title="Written from the files and functions you changed">
            <Wand2 size={13} /> Write from my changes
          </button>
        )}
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        <textarea className="input" rows={6} value={message} placeholder={'feat(cart): add a discount code\n\nWhy the change is needed, in a few lines.'} onChange={(e) => setMessage(e.target.value)} spellCheck style={{ resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 12.5, height: 'auto', padding: 10 }} aria-label="Commit message" />
        <div className="row" style={{ gap: 8 }}>
          <span className="tiny faint">Type</span>
          <Select
            value={TYPES.includes(type as CommitType) ? type : ''}
            options={[{ value: '', label: '–' }, ...TYPES.map((value) => ({ value, label: value }))]}
            onChange={(value) => value && setMessage(setCommitType(message, value))}
            title="Change the type of the message"
          />
          <span className="spacer" />
          <CopyButton text={message} label="Copy message" />
        </div>
        <Problems problems={problems} message={message} />
        {message.trim() && <CommandBlock commands={commitCommand(message)} />}
        {suggestion && !message && <div className="tiny faint">You have {data.changes?.files.length} uncommitted files: “Write from my changes” drafts a message from them; check the type, it cannot be known from the files.</div>}
      </div>
    </div>
  );
}
