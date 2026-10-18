/**
 * Stable identities for findings, so two analyses (base vs head, a baseline file vs today) can tell
 * new problems from old ones. Fingerprints never contain line numbers: inserting code above a
 * function must not turn its old findings into "new" ones. Pure — shared by the CLI and the report UI.
 */
import type { RuleViolation } from './types.js';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** FNV-1a (64-bit) of `ruleId`, `file` and `subject`, as 16 hex characters. */
export function fingerprint(ruleId: string, file: string, subject: string): string {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(`${ruleId}\0${file}\0${subject}`)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** A cycle rotated so its lexicographically smallest member comes first: a → b → c ≡ b → c → a. */
export function cycleKey(members: string[]): string {
  if (!members.length) return '';
  let start = 0;
  for (let i = 1; i < members.length; i++) if (members[i] < members[start]) start = i;
  return [...members.slice(start), ...members.slice(0, start)].join(' → ');
}

/**
 * Identity of a reported cycle. Reported cycles are strongly connected components (a sample path
 * followed by the other members), so the member set identifies them — the sample path inside can
 * change when unrelated imports are reordered.
 */
export function cycleSetKey(members: string[]): string {
  return cycleKey([...new Set(members)].sort());
}

export function violationKey(v: Pick<RuleViolation, 'rule' | 'source' | 'target'>): string {
  return `${v.rule}|${v.source}|${v.target}`;
}

/** Rule ids shared by every surface that reports findings (check, SARIF, baselines, the live feed). */
export const RULE_IDS = {
  cycle: 'cv/cycle',
  rule: 'cv/architecture-rule',
  layer: 'cv/layer-violation',
  missingDependency: 'cv/missing-dependency',
  complexity: 'cv/complexity',
  unusedExport: 'cv/unused-export',
  devDependencyInProduction: 'cv/dev-dependency-in-production',
  // --- new-only-gates ---
  complexityIncrease: 'cv/complexity-increase',
  health: 'cv/health',
  healthDrop: 'cv/health-drop',
  changeRisk: 'cv/change-risk',
  // --- test-intelligence ---
  patchCoverage: 'cv/patch-coverage',
  // --- daily-loop: hygiene of the lines a change adds ---
  focusedTest: 'cv/focused-test',
  debuggerStatement: 'cv/debugger',
  conflictMarker: 'cv/conflict-marker',
  // --- clone-radar: copied code ---
  duplicateCode: 'cv/duplicate-code',
} as const;

export function cycleFingerprint(members: string[]): string {
  return fingerprint(RULE_IDS.cycle, '', cycleSetKey(members));
}

export function violationFingerprint(v: Pick<RuleViolation, 'rule' | 'source' | 'target'>): string {
  return fingerprint(v.rule === 'layers' ? RULE_IDS.layer : RULE_IDS.rule, v.source, violationKey(v));
}

export function missingDependencyFingerprint(name: string): string {
  return fingerprint(RULE_IDS.missingDependency, '', name);
}

/** `symbol` is the symbol id (`file#name`), which already names the file. */
export function complexityFingerprint(file: string, symbol: string): string {
  return fingerprint(RULE_IDS.complexity, file, symbol);
}

export function unusedExportFingerprint(file: string, name: string): string {
  return fingerprint(RULE_IDS.unusedExport, file, name);
}

/** A devDependency imported by production code (accuracy-pass), per declaring package.json ('' = root). */
export function devDependencyInProductionFingerprint(name: string, manifest = ''): string {
  return fingerprint(RULE_IDS.devDependencyInProduction, '', `dev-in-production|${name}|${manifest}`);
}

/** A function whose complexity grew in this change (`check --no-worse`), whatever its size. */
export function complexityIncreaseFingerprint(file: string, symbol: string): string {
  return fingerprint(RULE_IDS.complexityIncrease, file, symbol);
}
