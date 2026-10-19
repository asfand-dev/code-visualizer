import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { jobLevels } from '../../../src/shared/workflow-forecast';
import type { WorkflowFinding, WorkflowInfo, WorkflowJob, WorkflowStep } from '../types';

interface Edge {
  key: string;
  path: string;
}

/** The command a step runs, cut to its first line. */
const firstLine = (text: string): string => text.split('\n')[0];

function stepLabel(step: WorkflowStep): { title: string; detail?: string } {
  if (step.name) return { title: step.name, detail: step.uses ?? (step.run ? firstLine(step.run) : undefined) };
  if (step.uses) return { title: step.uses };
  if (step.run) return { title: firstLine(step.run) };
  return { title: 'step' };
}

function severityOf(findings: WorkflowFinding[]): 'error' | 'warning' | 'info' | undefined {
  return findings.some((f) => f.severity === 'error') ? 'error' : findings.some((f) => f.severity === 'warning') ? 'warning' : findings.length ? 'info' : undefined;
}

function JobCard({ job, findings, open, onToggle, register }: { job: WorkflowJob; findings: WorkflowFinding[]; open: boolean; onToggle: () => void; register: (id: string, element: HTMLElement | null) => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  const worst = severityOf(findings);
  return (
    <div className={`dag-job${worst ? ` has-${worst}` : ''}`} ref={(element) => register(job.id, element)}>
      <button className="dag-job-head" onClick={onToggle} aria-expanded={open} title={`${job.id} · line ${job.line}`}>
        <Chevron size={13} style={{ flexShrink: 0 }} />
        <span className="truncate" style={{ fontWeight: 600 }}>
          {job.name ?? job.id}
        </span>
      </button>
      <div className="dag-job-meta">
        {job.uses ? <span className="badge info" title={job.uses}>reusable workflow</span> : job.runsOn.length > 0 && <span className="mono tiny muted">{job.runsOn.join(', ')}</span>}
        {job.matrix && (
          <span className="badge" title={job.matrix.dims.map((d) => `${d.name}: ${d.values.join(', ')}`).join('\n')}>
            ×{job.matrix.combos}
            {job.matrix.dynamic ? '+' : ''}
          </span>
        )}
        {job.if && <span className="badge" title={`if: ${job.if}`}>conditional</span>}
        {job.environment && <span className="badge accent">{job.environment}</span>}
        {worst && (
          <span className={`badge ${worst === 'error' ? 'danger' : worst === 'warning' ? 'warn' : 'info'}`} title={findings.map((f) => f.message).join('\n')}>
            {findings.length}
          </span>
        )}
      </div>
      {open && (
        <ol className="dag-steps">
          {job.steps.map((step, index) => {
            const { title, detail } = stepLabel(step);
            return (
              <li key={`${step.line}:${index}`} title={`line ${step.line}`}>
                <span className="small">{title}</span>
                {detail && <div className="tiny mono muted truncate">{detail}</div>}
              </li>
            );
          })}
          {!job.steps.length && <li className="tiny muted">{job.uses ? `Calls ${job.uses}` : 'No steps'}</li>}
        </ol>
      )}
    </div>
  );
}

/** The jobs of a workflow in columns (a job comes after the jobs it needs), joined by the `needs` lines. */
export function WorkflowGraph({ workflow, findings }: { workflow: WorkflowInfo; findings: WorkflowFinding[] }) {
  const levels = useMemo(() => jobLevels(workflow.jobs), [workflow.jobs]);
  const jobsById = useMemo(() => new Map(workflow.jobs.map((job) => [job.id, job])), [workflow.jobs]);
  const [open, setOpen] = useState<string>();
  const [edges, setEdges] = useState<Edge[]>([]);
  const canvas = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const register = (id: string, element: HTMLElement | null): void => {
    if (element) nodes.current.set(id, element);
    else nodes.current.delete(id);
  };

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = (): void => {
      const origin = element.getBoundingClientRect();
      const next: Edge[] = [];
      for (const job of workflow.jobs) {
        for (const need of job.needs) {
          const from = nodes.current.get(need)?.getBoundingClientRect();
          const to = nodes.current.get(job.id)?.getBoundingClientRect();
          if (!from || !to) continue;
          const [x1, y1] = [from.right - origin.left, from.top + from.height / 2 - origin.top];
          const [x2, y2] = [to.left - origin.left, to.top + to.height / 2 - origin.top];
          const middle = (x1 + x2) / 2;
          next.push({ key: `${need}>${job.id}`, path: `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}` });
        }
      }
      setEdges(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [workflow, open]);

  return (
    <div className="dag-scroll">
      <div className="dag" ref={canvas}>
        <svg className="dag-edges" aria-hidden>
          <defs>
            <marker id="dag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--text-faint)" />
            </marker>
          </defs>
          {edges.map((edge) => (
            <path key={edge.key} d={edge.path} markerEnd="url(#dag-arrow)" />
          ))}
        </svg>
        {levels.map((column, index) => (
          <div key={index} className="dag-column">
            {column.map((id) => {
              const job = jobsById.get(id);
              return job && <JobCard key={id} job={job} findings={findings.filter((f) => f.job === id)} open={open === id} onToggle={() => setOpen(open === id ? undefined : id)} register={register} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
