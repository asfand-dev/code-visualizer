import { useMemo, useState } from 'react';
import { planCycleFix, type CycleAction, type CycleCut } from '../../../src/shared/cycles';
import { useModel } from '../data/context';
import { basename } from '../lib/format';
import { selectFile } from '../state/store';
import { CopyButton } from './ui';

const ACTION_LABEL: Record<CycleAction, string> = {
  'import-type': 'Type-only import',
  'move-to-shared': 'Move to a shared module',
  invert: 'Invert the dependency',
  extract: 'Extract a module',
};

const planAsText = (cuts: CycleCut[]): string => cuts.map((c, i) => `${i + 1}. ${c.source}:${c.line} → ${c.target} — ${ACTION_LABEL[c.action]}: ${c.advice}`).join('\n');

function CutRow({ cut, index }: { cut: CycleCut; index: number }) {
  return (
    <li style={{ padding: '6px 0' }}>
      <div className="row nowrap small" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="faint">{index + 1}.</span>
        <button className="chip" onClick={() => selectFile(cut.source, cut.line)} title={`${cut.source}:${cut.line}`}>
          <span className="mono">
            {basename(cut.source)}:{cut.line}
          </span>
        </button>
        <span className="faint">→</span>
        <button className="chip" onClick={() => selectFile(cut.target)} title={cut.target}>
          <span className="mono">{basename(cut.target)}</span>
        </button>
        <span className={`badge ${cut.effort === 'trivial' ? 'success' : cut.effort === 'small' ? 'info' : 'warn'}`}>{ACTION_LABEL[cut.action]}</span>
      </div>
      <div className="tiny muted" style={{ marginTop: 3, paddingLeft: 18 }}>
        {cut.advice}
      </div>
    </li>
  );
}

/** The imports to cut to break a cycle, cheapest first. Planned when opened: a report can have many cycles. */
export function CycleFix({ cycle }: { cycle: string[] }) {
  const { data } = useModel();
  const [open, setOpen] = useState(false);
  const plan = useMemo(() => (open ? planCycleFix(data, cycle) : undefined), [open, data, cycle]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)} style={{ marginTop: 8 }}>
      <summary className="tiny muted" style={{ cursor: 'pointer' }}>
        How to break it
      </summary>
      {plan && (
        <div style={{ marginTop: 6 }}>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {plan.cuts.map((cut, i) => (
              <CutRow key={`${cut.source}>${cut.target}`} cut={cut} index={i} />
            ))}
          </ol>
          <div className="row" style={{ gap: 8, marginTop: 4 }}>
            <span className="tiny faint">{plan.complete ? `Making ${plan.cuts.length === 1 ? 'this change' : `these ${plan.cuts.length} changes`} removes the cycle.` : 'More cuts will be needed after these: the files are tangled, not held by one bad import.'}</span>
            <span className="spacer" />
            <CopyButton text={planAsText(plan.cuts)} label="Copy plan" />
          </div>
        </div>
      )}
    </details>
  );
}
