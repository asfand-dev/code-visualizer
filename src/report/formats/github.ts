/**
 * `check --format github`: GitHub Actions workflow commands (annotations on the PR diff). GitHub shows
 * at most 10 annotations per level and step, so the most useful ones come first — new findings, those on
 * lines you changed, errors before warnings — and one notice says how many more there are.
 */
import type { CheckResult, Finding, GateResult } from '../../shared/types.js';

/** Annotations per level that GitHub displays (actions/toolkit). */
export const ANNOTATIONS_PER_LEVEL = 10;

type Level = 'error' | 'warning' | 'notice';

/** Message text: `%`, CR and LF are escaped (actions/toolkit `escapeData`). */
export function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Property values additionally escape `:` and `,` (actions/toolkit `escapeProperty`). */
export function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** A finding's path as GitHub knows it: relative to the repository root. */
export function repoPath(file: string, prefix = ''): string {
  return `${prefix}${file}`;
}

interface Annotation {
  level: Level;
  file?: string;
  line?: number;
  title: string;
  message: string;
  rank: number[];
  /** Ties within a rank: the worse finding first (higher complexity, larger cycle). */
  weight: number;
}

function levelOf(f: Finding, gate: GateResult): Level {
  if (f.severity === 'note') return 'notice';
  return f.severity === 'error' && !gate.ok ? 'error' : 'warning';
}

/** Sort key: new first, then on changed lines, then errors (then the worse finding, then by place). */
function rank(f: Finding, level: Level): number[] {
  return [f.status === 'new' ? 0 : 1, f.onChangedLine ? 0 : 1, level === 'error' ? 0 : level === 'warning' ? 1 : 2];
}

function compare(a: Annotation, b: Annotation): number {
  for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
  return b.weight - a.weight || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.message.localeCompare(b.message);
}

function command(a: Pick<Annotation, 'level' | 'file' | 'line' | 'title' | 'message'>): string {
  const props = [a.file ? `file=${escapeProperty(a.file)}` : '', a.line ? `line=${a.line}` : '', `title=${escapeProperty(a.title)}`].filter(Boolean).join(',');
  return `::${a.level} ${props}::${escapeData(a.message)}`;
}

/**
 * Workflow commands for a check result. In new-only modes only new findings are annotated (old debt
 * is in the job summary and SARIF); failing gates without findings (health, risk) get one annotation each.
 */
export function githubAnnotations(result: CheckResult, options: { prefix?: string; max?: number } = {}): string {
  const max = options.max ?? ANNOTATIONS_PER_LEVEL;
  const annotations: Annotation[] = [];
  for (const gate of result.gates) {
    const newOnly = !!gate.counts;
    if (!gate.ok && !gate.findings.length) annotations.push({ level: 'error', title: `code-visualizer: ${gate.label}`, message: `${gate.label}: ${gate.detail}`, rank: [0, 0, 0], weight: 0 });
    for (const f of gate.findings) {
      if (newOnly && f.status !== 'new') continue;
      const level = levelOf(f, gate);
      annotations.push({ level, file: repoPath(f.file, options.prefix), line: f.line, title: `code-visualizer: ${gate.label}`, message: f.message, rank: rank(f, level), weight: f.weight ?? 0 });
    }
  }
  annotations.sort(compare);
  const shown: Record<Level, number> = { error: 0, warning: 0, notice: 0 };
  const lines: string[] = [];
  let omitted = 0;
  for (const a of annotations) {
    // One notice slot stays free for the "+N more" line.
    const cap = a.level === 'notice' ? max - 1 : max;
    if (shown[a.level] >= cap) {
      omitted++;
      continue;
    }
    shown[a.level]++;
    lines.push(command(a));
  }
  if (omitted) lines.push(`::notice::${escapeData(`+${omitted} more — see job summary or SARIF`)}`);
  const failed = result.gates.filter((g) => !g.ok).length;
  // No gates ran (nothing changed, nothing staged): say that instead of "all gates passed".
  const outcome = failed ? `${failed} gate(s) failed` : result.gates.length ? 'all gates passed' : (result.notes?.find((n) => /nothing to check/i.test(n)) ?? 'nothing to check');
  lines.push(`code-visualizer check: ${outcome} — health ${result.health}/100`);
  return `${lines.join('\n')}\n`;
}
