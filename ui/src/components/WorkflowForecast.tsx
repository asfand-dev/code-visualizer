import { useMemo, useState } from 'react';
import { Check, Minus } from 'lucide-react';
import { forecastRuns } from '../../../src/shared/workflow-forecast';
import { useModel } from '../data/context';
import { plural } from '../lib/format';
import type { CiReport } from '../types';
import { Segmented } from './ui';

type EventName = 'push' | 'pull_request';

/** `origin/main` → `main`: workflows filter on branch names, not on remote-tracking refs. */
const branchName = (ref: string): string => ref.replace(/^origin\//, '');

/** Joins the folder the analysis started in (relative to the repository) with a path inside it. */
const fromRepositoryRoot = (base: string, file: string): string => (base ? `${base}/${file}` : file);

/** Which workflows run for your changes, and why the others do not: the branch and path filters, read for you. */
export function WorkflowForecast({ ci }: { ci: CiReport }) {
  const { data } = useModel();
  const [event, setEvent] = useState<EventName>('push');
  const [typed, setTyped] = useState<string>();
  const current = data.git?.branch;
  const target = data.repo?.base ? branchName(data.repo.base) : 'main';
  // A push is to your branch; a pull request is to the branch it merges into.
  const branch = typed ?? (event === 'push' ? (current ?? target) : target);
  const files = useMemo(() => (data.changes?.files ?? []).map((f) => fromRepositoryRoot(ci.base, f.id)), [data.changes, ci.base]);
  const forecasts = useMemo(
    () => forecastRuns(ci.workflows, { name: event, branch, files }).sort((a, b) => Number(b.runs) - Number(a.runs)),
    [ci.workflows, event, branch, files],
  );
  const running = forecasts.filter((f) => f.runs).length;

  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <h3>What runs for my changes</h3>
        <span className="tiny faint">
          {plural(running, 'workflow')} of {ci.workflows.length}
        </span>
        <span className="spacer" />
        <Segmented
          value={event}
          onChange={(value) => {
            setEvent(value);
            setTyped(undefined);
          }}
          options={[
            { value: 'push', label: 'Push', title: 'You push to a branch' },
            { value: 'pull_request', label: 'Pull request', title: 'A pull request is opened against a branch' },
          ]}
        />
        <label className="row nowrap small" style={{ gap: 6 }}>
          <span className="muted">{event === 'push' ? 'to' : 'into'}</span>
          <input className="input mono" style={{ width: 150, height: 28 }} value={branch} onChange={(e) => setTyped(e.target.value)} spellCheck={false} aria-label="Branch" />
        </label>
      </div>
      <div className="card-body stack" style={{ gap: 8 }}>
        {forecasts.map((forecast) => (
          <div key={forecast.file} className="row nowrap small" style={{ gap: 10, alignItems: 'flex-start' }}>
            {forecast.runs ? <Check size={15} style={{ color: 'var(--success)', flexShrink: 0, marginTop: 1 }} /> : <Minus size={15} className="faint" style={{ flexShrink: 0, marginTop: 1 }} />}
            <span style={{ minWidth: 0 }}>
              <b className={forecast.runs ? '' : 'muted'}>{forecast.name}</b> <span className="tiny faint mono">{forecast.file.replace('.github/workflows/', '')}</span>
              <div className="tiny muted wrap-anywhere">{forecast.reason.replace(/`/g, '')}</div>
            </span>
          </div>
        ))}
        <div className="tiny faint">
          {files.length ? `Using your ${plural(files.length, 'changed file')} for the path filters.` : 'You have no changed files, so path filters are not applied.'} Only <code>push</code> and <code>pull_request</code> are forecast.
        </div>
      </div>
    </div>
  );
}
