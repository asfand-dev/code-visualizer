/**
 * Reading live events (live-guard): the list of kinds, severity order, the terminal marker and the
 * most important event of an update. Pure — shared by the server, the CLI and the report UI.
 */
import type { LiveEvent, LiveEventKind, LiveSeverity } from './types.js';

export const LIVE_EVENT_KINDS: readonly LiveEventKind[] = [
  'cycle-added',
  'cycle-fixed',
  'rule-violation',
  'rule-fixed',
  'complexity-up',
  'complexity-down',
  'signature-changed',
  'route-removed',
  'unused-export',
  'missing-dependency',
  'untested-change',
  'health',
  'config',
  // --- clone-radar ---
  'clone-added',
];

/** Worst first. */
const SEVERITY_RANK: Record<LiveSeverity, number> = { error: 0, warning: 1, success: 2, info: 3 };

export function severityRank(severity: LiveSeverity): number {
  return SEVERITY_RANK[severity];
}

export function isLiveEventKind(value: string): value is LiveEventKind {
  return (LIVE_EVENT_KINDS as readonly string[]).includes(value);
}

/** The event to show first: the worst severity, then the earliest detected (detectors run worst-first). */
export function topEvent(events: readonly LiveEvent[]): LiveEvent | undefined {
  let top: LiveEvent | undefined;
  for (const e of events) if (!top || severityRank(e.severity) < severityRank(top.severity)) top = e;
  return top;
}

/** `✖` broke, `▲` / `▼` complexity, `!` worse, `✔` fixed, `ℹ` worth knowing; health has none. */
export function liveMarker(e: Pick<LiveEvent, 'kind' | 'severity'>): string {
  if (e.kind === 'health') return '';
  if (e.kind === 'complexity-up' && e.severity !== 'error') return '▲';
  if (e.kind === 'complexity-down' && e.severity !== 'success') return '▼';
  if (e.severity === 'error') return '✖';
  if (e.severity === 'warning') return '!';
  if (e.severity === 'success') return '✔';
  return 'ℹ';
}

/** `src/a.ts:12` — where an event points (undefined when it has no file). */
export function liveLocation(e: Pick<LiveEvent, 'files' | 'line'>): string | undefined {
  const file = e.files[0];
  if (!file) return undefined;
  return e.line ? `${file}:${e.line}` : file;
}

/** Plain one-line form: `✖ new cycle: a.ts → b.ts → a.ts`, `▲ checkout() complexity 12 → 19 · src/cart.ts:40`. */
export function liveEventLine(e: LiveEvent): string {
  const marker = liveMarker(e);
  const where = liveLocation(e);
  // Messages that already name their file (cycles, rule breaks, untested files) need no location.
  const location = where && !e.message.includes(e.files[0]) && e.kind !== 'health' ? ` · ${where}` : '';
  return `${marker ? `${marker} ` : ''}${e.message}${location}`;
}

/**
 * Whether an open problem counts for the tab title: errors and warnings. Edited files no test reaches
 * stay listed as a nudge (apart from the problems), but they did not break anything.
 */
export function countsAsProblem(e: Pick<LiveEvent, 'kind' | 'severity'>): boolean {
  return (e.severity === 'error' || e.severity === 'warning') && e.kind !== 'untested-change';
}

export function openProblemCount(open: readonly Pick<LiveEvent, 'kind' | 'severity'>[]): number {
  return open.filter(countsAsProblem).length;
}
