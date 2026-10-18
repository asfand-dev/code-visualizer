/**
 * Coverage wording shared by the CLI (`coverage`, `test`, `check`), the PR description and the report UI.
 * Pure — no Node APIs.
 */
import type { PatchCoverage } from './types.js';

/** `L40-55, L60` (at most `max` ranges, then `…`). */
export function formatRanges(ranges: [number, number][], max = 4): string {
  const shown = ranges.slice(0, max).map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`));
  return `${shown.join(', ')}${ranges.length > max ? ', …' : ''}`;
}

/** `72%` / `66.6%` */
export function formatPct(pct: number): string {
  return `${Math.round(pct * 10) / 10}%`;
}

/** `Patch coverage 72% (18/25 changed lines)` — or why there is nothing to measure. */
export function patchCoverageLine(patch: PatchCoverage): string {
  if (!patch.coverable) return 'Patch coverage: no executable lines changed';
  return `Patch coverage ${formatPct(patch.pct)} (${patch.covered}/${patch.coverable} changed lines)`;
}

/** The changed lines most worth a test, for one-line summaries: `src/cart.ts L40-55`. */
export function topUncovered(patch: PatchCoverage, max = 2): string[] {
  return patch.files.filter((f) => f.uncovered.length).slice(0, max).map((f) => `${f.file} ${formatRanges(f.uncovered, 2)}`);
}

/** `3 min ago` / `2 h ago` / `5 d ago` (for "report from …"). */
export function reportAge(date: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - date) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
