import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { WORKFLOW_RULES } from '../../../src/shared/workflows';
import type { WorkflowFinding, WorkflowSeverity } from '../types';
import { PathLink } from './PathLink';
import { Segmented } from './ui';

type SeverityFilter = 'all' | WorkflowSeverity;

const TONE: Record<WorkflowSeverity, string> = { error: 'danger', warning: 'warn', info: 'info' };
const RANK: Record<WorkflowSeverity, number> = { error: 0, warning: 1, info: 2 };
/** Findings listed per rule before "+N more". */
const PER_RULE = 8;

const ruleInfo = (rule: string): { title: string; advice: string } | undefined => (Object.hasOwn(WORKFLOW_RULES, rule) ? WORKFLOW_RULES[rule as keyof typeof WORKFLOW_RULES] : undefined);

interface Group {
  rule: string;
  severity: WorkflowSeverity;
  findings: WorkflowFinding[];
}

function groupByRule(findings: WorkflowFinding[]): Group[] {
  const groups = new Map<string, Group>();
  for (const finding of findings) {
    const group = groups.get(finding.rule) ?? { rule: finding.rule, severity: finding.severity, findings: [] };
    group.findings.push(finding);
    groups.set(finding.rule, group);
  }
  return [...groups.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.findings.length - a.findings.length);
}

function RuleGroup({ group, linkable }: { group: Group; linkable: boolean }) {
  const info = ruleInfo(group.rule);
  return (
    <div style={{ padding: '8px 4px 12px' }}>
      <div className="row nowrap" style={{ gap: 8, padding: '0 8px' }}>
        <span className={`badge ${TONE[group.severity]}`}>{group.severity}</span>
        <b className="small">{info?.title ?? group.rule}</b>
        <span className="faint num small">({group.findings.length})</span>
      </div>
      {info && (
        <div className="tiny muted" style={{ padding: '2px 8px 6px' }}>
          {info.advice}
        </div>
      )}
      {group.findings.slice(0, PER_RULE).map((finding) => (
        <div key={`${finding.file}:${finding.line}:${finding.job}:${finding.message}`} className="row nowrap small" style={{ gap: 8, padding: '3px 8px', alignItems: 'flex-start' }}>
          <span style={{ flexShrink: 0 }}>
            {linkable ? <PathLink path={finding.file} line={finding.line} label={`${finding.file.replace('.github/workflows/', '')}${finding.line ? `:${finding.line}` : ''}`} /> : <span className="mono tiny muted">{finding.file.replace('.github/workflows/', '')}{finding.line ? `:${finding.line}` : ''}</span>}
          </span>
          <span className="muted wrap-anywhere" style={{ minWidth: 0 }}>
            {finding.job && <span className="mono">{finding.job}: </span>}
            {finding.message.replace(/`/g, '')}
          </span>
        </div>
      ))}
      {group.findings.length > PER_RULE && <div className="tiny faint" style={{ padding: '4px 8px' }}>+{group.findings.length - PER_RULE} more</div>}
    </div>
  );
}

/** What is wrong with the workflows, grouped by rule with the advice for each; `linkable`: the files can be opened. */
export function WorkflowFindings({ findings, linkable }: { findings: WorkflowFinding[]; linkable: boolean }) {
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const count = (severity: WorkflowSeverity): number => findings.filter((f) => f.severity === severity).length;
  const groups = useMemo(() => groupByRule(findings.filter((f) => filter === 'all' || f.severity === filter)), [findings, filter]);
  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <h3>Findings</h3>
        <span className="faint num small">({findings.length})</span>
        <span className="spacer" />
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All (${findings.length})` },
            { value: 'error', label: `Errors (${count('error')})`, title: 'GitHub rejects the workflow, it always fails, or it can be taken over' },
            { value: 'warning', label: `Warnings (${count('warning')})` },
            { value: 'info', label: `Tips (${count('info')})` },
          ]}
        />
      </div>
      <div style={{ maxHeight: 520, overflowY: 'auto', padding: '4px 8px' }}>
        {groups.map((group) => (
          <RuleGroup key={group.rule} group={group} linkable={linkable} />
        ))}
        {!groups.length && (
          <div className="small" style={{ padding: '14px 10px' }}>
            <Check size={14} style={{ color: 'var(--success)', verticalAlign: -2 }} /> {filter === 'all' ? 'Nothing found: the workflows look sound.' : 'Nothing at this level.'}
          </div>
        )}
      </div>
    </div>
  );
}
