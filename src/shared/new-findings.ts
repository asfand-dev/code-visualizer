/**
 * The findings of an analysis that are new compared with the base of the changes (`changes.delta`): the
 * fingerprints `check --changed` fails on. Pure — backs the report UI's "New only" filter.
 */
import { complexityFingerprint, cycleFingerprint, unusedExportFingerprint, violationFingerprint } from './fingerprint.js';
import type { ArchitectureDelta, Insights } from './types.js';

export type NewInsights = Pick<Insights, 'cycles' | 'complexFunctions' | 'unusedExports' | 'ruleViolations'> & {
  /** How many findings the four lists hold together. */
  count: number;
};

/** One entry per function, its worst part first: the list also names inline callbacks under their function. */
function oncePerSymbol<T extends { symbol: string; complexity: number }>(list: T[]): T[] {
  const seen = new Set<string>();
  return [...list]
    .sort((a, b) => b.complexity - a.complexity)
    .filter((c) => {
      if (seen.has(c.symbol)) return false;
      seen.add(c.symbol);
      return true;
    });
}

/**
 * Cycles, complex functions, unused exports and rule violations that are new: complexity counts when a
 * function is new above the limit the delta was judged with, or was above it and grew (not any growth).
 */
export function newInsightsOf(insights: Pick<Insights, 'cycles' | 'complexFunctions' | 'unusedExports' | 'ruleViolations'>, delta: Pick<ArchitectureDelta, 'fingerprints'>): NewInsights {
  const fps = new Set([...delta.fingerprints.new, ...(delta.fingerprints.worsened ?? [])]);
  const cycles = insights.cycles.filter((c) => fps.has(cycleFingerprint(c)));
  const complexFunctions = oncePerSymbol(insights.complexFunctions.filter((c) => fps.has(complexityFingerprint(c.file, c.symbol))));
  const unusedExports = insights.unusedExports.filter((u) => !u.typeOnly && fps.has(unusedExportFingerprint(u.file, u.name)));
  const ruleViolations = insights.ruleViolations.filter((v) => fps.has(violationFingerprint(v)));
  return { cycles, complexFunctions, unusedExports, ruleViolations, count: cycles.length + complexFunctions.length + unusedExports.length + ruleViolations.length };
}
