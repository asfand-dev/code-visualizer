/**
 * Reading an ArchitectureDelta: one-line highlights, "is anything worse?" and `--fail-on` gates.
 * Pure — shared by `diff`, `pr`, the live server and the report UI.
 */
import { compactPair } from './signature.js';
import type { ArchitectureDelta, ExportChange } from './types.js';

const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;
const baseName = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

/** Breaking export changes that can actually break something: used in the repo, or part of an entry point. */
export function breakingExports(delta: ArchitectureDelta): ExportChange[] {
  return delta.exports.filter((e) => e.breaking && (e.importers.length > 0 || e.staleCallSites.length > 0 || e.entry));
}

function stillCalledRoutes(delta: ArchitectureDelta): ArchitectureDelta['routes']['removed'] {
  return delta.routes.removed.filter((r) => r.stillCalledFrom.length);
}

/** `analyze()`, or `registerRoutes › app.post callback` for a function's most complex inline callback. */
export function functionLabel(name: string): string {
  return name.includes(' › ') ? name : `${name}()`;
}

/** Health points lost (negative when health improved). */
export function healthDrop(delta: ArchitectureDelta): number {
  return delta.health.before - delta.health.after;
}

export function isEmptyDelta(delta: ArchitectureDelta): boolean {
  return (
    !delta.newEdges.length &&
    !delta.removedEdges.length &&
    !delta.newCycles.length &&
    !delta.fixedCycles.length &&
    !delta.newViolations.length &&
    !delta.fixedViolations.length &&
    !delta.newMissingDependencies.length &&
    !delta.newDevDependenciesInProduction?.length &&
    !delta.addedPackages.length &&
    !delta.removedPackages.length &&
    !delta.complexity.length &&
    !delta.exports.length &&
    !delta.routes.added.length &&
    !delta.routes.removed.length &&
    !delta.newUnusedExports.length &&
    !delta.newClones?.length &&
    !delta.driftedClones?.length &&
    delta.health.before === delta.health.after
  );
}

/** The export's name for messages: `formatDate`, or `default export of App.tsx`. */
export function exportName(e: Pick<ExportChange, 'name' | 'file'>): string {
  return e.name === 'default' ? `default export of ${baseName(e.file)}` : e.name;
}

/** `formatDate(iso: string) → formatDate(iso: string, locale: string)` or `formatDate removed`; `compact` drops the types. */
export function exportChangeLabel(e: ExportChange, compact = false): string {
  const name = exportName(e);
  if (e.change === 'removed') return `${name} removed`;
  if (e.change === 'added') return `${name} added`;
  if (!e.before || !e.after) return `${e.before ?? name} → ${e.after ?? name}`;
  const [before, after] = compact ? compactPair(e.before, e.after) : [e.before, e.after];
  return `${before} → ${after}`;
}

/** What an export change breaks, e.g. `3 calls not updated (a.ts:12, b.ts:4 …)` or `still imported by 2 files`. */
export function exportImpactLabel(e: ExportChange, maxSites = 2): string {
  if (e.staleCallSites.length) {
    if (maxSites <= 0) return `${plural(e.staleCallSites.length, 'call')} not updated`;
    const sites = e.staleCallSites.slice(0, maxSites).map((s) => `${baseName(s.file)}:${s.line}`).join(', ');
    return `${plural(e.staleCallSites.length, 'call')} not updated (${sites}${e.staleCallSites.length > maxSites ? ' …' : ''})`;
  }
  if (e.importers.length) return `${e.change === 'removed' ? 'still imported by' : 'imported by'} ${plural(e.importers.length, 'file')}`;
  return e.entry ? 'part of the public entry point' : 'not used in the project';
}

/**
 * The most important changes as short plain-text phrases, worst first, e.g.
 * `+3 imports src/ui→src/db`, `1 new cycle`, `GET /api/users/:id removed but still called from 2 places`, `health 78 → 76`.
 */
export function deltaHighlights(delta: ArchitectureDelta, max = 8): string[] {
  const parts: string[] = [];
  if (delta.newCycles.length) parts.push(`${plural(delta.newCycles.length, 'new cycle')}`);
  const errors = delta.newViolations.filter((v) => v.severity === 'error').length;
  if (delta.newViolations.length) parts.push(`${plural(delta.newViolations.length, 'new rule violation')}${errors && errors < delta.newViolations.length ? ` (${plural(errors, 'error')})` : ''}`);
  for (const e of breakingExports(delta).slice(0, 2)) parts.push(`${exportChangeLabel(e, true)}: ${exportImpactLabel(e)}`);
  for (const r of stillCalledRoutes(delta).slice(0, 2)) parts.push(`${r.label} removed but still called from ${plural(r.stillCalledFrom.length, 'place')}`);
  for (const name of delta.newMissingDependencies.slice(0, 2)) parts.push(`"${name}" is not in package.json`);
  for (const d of (delta.newDevDependenciesInProduction ?? []).slice(0, 2)) parts.push(`devDependency "${d.name}" used in production`);
  for (const a of delta.areaEdges.filter((x) => x.isNew).slice(0, 3)) parts.push(`+${plural(a.after, 'import')} ${a.from}→${a.to}`);
  const worse = delta.complexity.filter((c) => c.after > 10).sort((a, b) => b.after - b.before - (a.after - a.before));
  for (const c of worse.slice(0, 2)) parts.push(c.before ? `${functionLabel(c.name)} complexity ${c.before} → ${c.after}` : `new ${functionLabel(c.name)} with complexity ${c.after}`);
  // --- clone-radar ---
  if (delta.newClones?.length) parts.push(plural(delta.newClones.length, 'new copy-paste clone'));
  if (delta.fixedCycles.length) parts.push(`${plural(delta.fixedCycles.length, 'cycle')} fixed`);
  if (delta.fixedViolations.length) parts.push(`${plural(delta.fixedViolations.length, 'rule violation')} fixed`);
  // The health change always closes the line.
  const health = delta.health.before !== delta.health.after ? [`health ${delta.health.before} → ${delta.health.after}`] : [];
  return [...parts.slice(0, max - health.length), ...health];
}

/* -------------------------------------------------------------------------- */
/*                                  --fail-on                                 */
/* -------------------------------------------------------------------------- */

const FAIL_ON_RULES = ['new-cycles', 'new-violations', 'breaking-exports', 'removed-routes', 'new-missing-deps', 'health-drop'] as const;
export type FailOnRule = (typeof FAIL_ON_RULES)[number];
export interface FailOn {
  rule: FailOnRule;
  /** For `health-drop:<n>`: the allowed drop in points. */
  threshold?: number;
}

/** Edit distance where swapping two neighbours counts as one edit (`mian` → `main`); for short strings such as refs. */
export function editDistance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
    }
    rows.push(row);
  }
  return rows[a.length][b.length];
}

/** The candidate closest to `value` when it looks like a typo of it (at most 2 edits, or a prefix). */
export function closest(value: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = c.startsWith(value) || value.startsWith(c) ? Math.min(1, editDistance(value, c)) : editDistance(value, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return bestDistance <= Math.min(2, Math.max(1, Math.floor(value.length / 3))) ? best : undefined;
}

/** Parse `new-cycles,health-drop:2` style values; throws an Error naming the bad value. */
export function parseFailOn(values: string[]): FailOn[] {
  const result: FailOn[] = [];
  for (const raw of values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)) {
    const [name, arg] = raw.split(':');
    if (!(FAIL_ON_RULES as readonly string[]).includes(name)) {
      const hint = closest(name, FAIL_ON_RULES);
      throw new Error(`Unknown --fail-on value "${raw}"${hint ? ` — did you mean "${hint}"?` : ''} (use ${FAIL_ON_RULES.map((r) => (r === 'health-drop' ? 'health-drop:<n>' : r)).join(', ')}).`);
    }
    const rule = name as FailOnRule;
    if (rule === 'health-drop') {
      const threshold = arg === undefined ? 0 : Number(arg);
      if (!Number.isFinite(threshold) || threshold < 0) throw new Error(`--fail-on health-drop:<n> needs a number of points, got "${raw}".`);
      result.push({ rule, threshold });
    } else {
      if (arg !== undefined) throw new Error(`--fail-on ${name} takes no value, got "${raw}".`);
      result.push({ rule });
    }
  }
  return result;
}

/** A cycle as `a.ts → b.ts → a.ts`, with as much of each path as it takes to tell the files apart. */
export function cycleLabel(cycle: string[]): string {
  const names = shortNames(cycle);
  return [...cycle, cycle[0]].map((id) => names.get(id) ?? id).join(' → ');
}

/** Shortest path suffix of each id that is unique among `ids` (`components/index.ts`, `hooks/index.ts`). */
export function shortNames(ids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of ids) {
    const parts = id.split('/');
    let n = 1;
    const suffix = (p: string[], k: number): string => p.slice(-k).join('/');
    while (n < parts.length && ids.some((other) => other !== id && suffix(other.split('/'), n) === suffix(parts, n))) n++;
    result.set(id, suffix(parts, n));
  }
  return result;
}

const more = (total: number, shown: number): string => (total > shown ? ` (+${total - shown} more)` : '');

/** The `--fail-on` gates a delta breaks, with a reason each (naming the first offenders). */
export function deltaFailures(delta: ArchitectureDelta, failOn: FailOn[]): { rule: FailOnRule; message: string }[] {
  const failures: { rule: FailOnRule; message: string }[] = [];
  for (const { rule, threshold } of failOn) {
    if (rule === 'new-cycles' && delta.newCycles.length) {
      failures.push({ rule, message: `${plural(delta.newCycles.length, 'new circular dependency', 'new circular dependencies')}: ${cycleLabel(delta.newCycles[0])}${more(delta.newCycles.length, 1)}` });
    }
    if (rule === 'new-violations') {
      const errors = delta.newViolations.filter((v) => v.severity === 'error');
      const first = errors[0];
      if (first) failures.push({ rule, message: `${plural(errors.length, 'new architecture rule violation')}: ${first.source}:${first.line} → ${first.target} (${first.rule})${more(errors.length, 1)}` });
    }
    if (rule === 'breaking-exports') {
      const breaking = breakingExports(delta);
      if (breaking.length) failures.push({ rule, message: `${plural(breaking.length, 'breaking export change')}: ${breaking.slice(0, 3).map(exportName).join(', ')}${breaking.length > 3 ? ', …' : ''}` });
    }
    if (rule === 'removed-routes' && delta.routes.removed.length) {
      failures.push({ rule, message: `${plural(delta.routes.removed.length, 'route')} removed: ${delta.routes.removed.slice(0, 3).map((r) => r.label).join(', ')}${delta.routes.removed.length > 3 ? ', …' : ''}` });
    }
    if (rule === 'new-missing-deps' && delta.newMissingDependencies.length) {
      failures.push({ rule, message: `${plural(delta.newMissingDependencies.length, 'package')} imported but not declared: ${delta.newMissingDependencies.slice(0, 5).join(', ')}` });
    }
    if (rule === 'health-drop' && healthDrop(delta) > (threshold ?? 0)) {
      failures.push({ rule, message: `health dropped by ${healthDrop(delta)} (${delta.health.before} → ${delta.health.after}, allowed ${threshold ?? 0})` });
    }
  }
  return failures;
}
