/**
 * Quality gates: what `check`, `pr --check`, the job summary and the CI formats judge. Pure — no I/O.
 *
 * Every gate is a provider that turns an analysis into findings with stable fingerprints. Compared with a
 * base commit (`check --changed`, `--new-since`, `--staged`: `data.changes.delta`) or with a committed
 * baseline, only *new* findings fail a gate ("clean as you code"); old debt is counted, not blamed.
 * Features add gates by appending a provider to GATE_PROVIDERS.
 */
import type { ArchitectureDelta, Baseline, CheckMode, CheckResult, Finding, FindingStatus, GateResult, ReportData, RuleViolation } from '../shared/types.js';
import {
  complexityFingerprint,
  complexityIncreaseFingerprint,
  cycleFingerprint,
  cycleSetKey,
  devDependencyInProductionFingerprint,
  missingDependencyFingerprint,
  RULE_IDS,
  unusedExportFingerprint,
  violationFingerprint,
  violationKey,
} from '../shared/fingerprint.js';
import { functionLabel, healthDrop } from '../shared/delta.js';
import { ruleDescriptor } from '../shared/rules-catalog.js';
import { BaselineMatcher, cycleMembers } from './baseline.js';
import { measuredFunctions, type MeasuredFunction } from './compare.js';
import type { CheckConfig } from './config.js';
import { clonesGate } from './clones.js';
import { patchCoverageGate } from './coverage.js';
import { hygieneGate } from './hygiene.js';

/** The `check` block of the configuration with command-line flags applied. */
export type Thresholds = CheckConfig;

export interface GateContext {
  mode: CheckMode;
  /** Only new findings fail gates (compared with a base commit or the baseline). */
  newOnly: boolean;
  thresholds: Thresholds;
  /** The comparison with the base commit, when there is one. */
  delta?: ArchitectureDelta;
  /** `check.changedMode: "files"`: only findings in the files you touched count; true for everything otherwise. */
  inScope(file: string): boolean;
  /** `check.changedMode: "files"`: the symbols your change touched (complexity is judged for these only). */
  changedSymbols?: Set<string>;
}

/** What a provider returns: a gate result plus optional hints for the comparison. */
export interface GateOutcome extends GateResult {
  /**
   * Rule ids this gate reports (so baseline entries of a rule without current findings still count as
   * fixed for this gate). Defaults to the rule ids of `findings`.
   */
  ruleIds?: string[];
  /**
   * `false` for gates judged as reported in every mode (health, risk, `--no-worse`): they decide `ok`
   * themselves. By default a failing gate passes in new-only modes when none of its errors is new.
   */
  newOnly?: boolean;
  /** Findings the base had that are gone (from the delta); baseline leftovers are added automatically. */
  fixed?: Finding[];
  /**
   * Compared with a base commit: decide whether a finding is new. Undefined falls back to the delta: by
   * fingerprint for the rules compareReports fingerprints (DELTA_RULE_IDS), otherwise by whether the
   * finding is on a line (or, without a line, in a file) your change touched. A provider whose findings
   * need another notion of "new" (e.g. comparing with its own base data) answers here, or presets
   * `status` on its findings.
   */
  isNew?: (finding: Finding) => boolean | undefined;
  /**
   * Keep `detail` when comparing with a base (test-intelligence: "72% (18/25 changed lines, min 80%)" says
   * more than "1 new · 0 existing"); `counts` are still set.
   */
  keepDetail?: boolean;
}

export type GateProvider = (data: ReportData, ctx: GateContext) => GateOutcome | undefined;

export interface EvaluateOptions {
  mode: CheckMode;
  /** Comparison with the base commit (default: `data.changes.delta`). */
  delta?: ArchitectureDelta;
  /** For `mode: 'baseline'`. */
  baseline?: Baseline;
  /** What new findings were compared with, for the result (`origin/main`, the baseline file…). */
  base?: string;
  /** `files`: `--changed` judges every finding in the touched files (no comparison). */
  changedMode?: 'new' | 'files';
  /** Gates to run (default: GATE_PROVIDERS). */
  providers?: GateProvider[];
  /**
   * The analysis covers part of the project (`--directory`, `--file`, `--exclude`, `--max-files`):
   * baseline entries without a finding may be outside it, so they are not counted as fixed.
   */
  partial?: boolean;
}

const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;

/** `packages/a/package.json` for a project-relative directory ('' is the root). */
export function manifestPath(dir: string): string {
  return dir ? `${dir}/package.json` : 'package.json';
}

/** The deepest of `dirs` that contains `file` ('' contains everything). */
function nearestDir(dirs: string[], file: string): string {
  return dirs.filter((d) => !d || file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
}

function finding(gate: string, ruleId: string, f: Omit<Finding, 'gate' | 'ruleId'>): Finding {
  return { ruleId, gate, ...f };
}

/* -------------------------------------------------------------------------- */
/*                                Built-in gates                              */
/* -------------------------------------------------------------------------- */

function violationFinding(v: RuleViolation, status?: FindingStatus): Finding {
  return finding('rules', v.rule === 'layers' ? RULE_IDS.layer : RULE_IDS.rule, {
    file: v.source,
    line: v.line,
    message: `${v.message ?? `Forbidden import (${v.rule})`}: ${v.source} → ${v.target}`,
    severity: v.severity === 'error' ? 'error' : 'warning',
    subject: violationKey(v),
    fingerprint: violationFingerprint(v),
    ...(status ? { status } : {}),
  });
}

export const rulesGate: GateProvider = (data, ctx) => {
  const violations = data.insights.ruleViolations.filter((v) => ctx.inScope(v.source));
  const fixed = ctx.delta?.fixedViolations ?? [];
  if (!data.config?.rules && !data.config?.layers?.length && !violations.length && !fixed.length) return undefined;
  const errors = violations.filter((v) => v.severity === 'error');
  return {
    id: 'rules',
    label: 'Architecture rules',
    ok: !!ctx.thresholds.allowRuleViolations || errors.length === 0,
    detail: violations.length ? `${errors.length} errors, ${violations.length - errors.length} warnings` : 'no violations',
    findings: violations.map((v) => violationFinding(v)),
    ruleIds: [RULE_IDS.rule, RULE_IDS.layer],
    fixed: fixed.map((v) => violationFinding(v, 'fixed')),
  };
};

export const dependenciesGate: GateProvider = (data, ctx) => {
  const t = ctx.thresholds;
  const missing = data.insights.missingDependencies.filter((m) => m.files.some((f) => ctx.inScope(f)));
  const devInProduction = (data.insights.devDependenciesInProduction ?? []).filter((d) => d.files.some((f) => ctx.inScope(f)));
  const allowDev = t.allowDevDependenciesInProduction ?? false;
  const devAllowed = (name: string): boolean => allowDev === true || (Array.isArray(allowDev) && allowDev.includes(name));
  const devFails = devInProduction.some((d) => !devAllowed(d.name));
  const findings: Finding[] = [
    ...missing.map((m) => {
      const file = m.files.find((f) => ctx.inScope(f)) ?? m.files[0];
      const manifest = manifestPath(nearestDir(m.manifests ?? [''], file));
      const elsewhere = m.declaredBy?.length ? ` (only ${m.declaredBy.map(manifestPath).join(', ')} declares it)` : '';
      return finding('dependencies', RULE_IDS.missingDependency, {
        file,
        message: `"${m.name}" is imported but not declared in ${manifest}${elsewhere}`,
        severity: t.allowMissingDependencies ? 'warning' : 'error',
        subject: m.name,
        fingerprint: missingDependencyFingerprint(m.name),
      });
    }),
    ...devInProduction.map((d) =>
      finding('dependencies', RULE_IDS.devDependencyInProduction, {
        file: d.files.find((f) => ctx.inScope(f)) ?? d.files[0],
        message:
          d.declareIn !== undefined
            ? `"${d.name}" is only a devDependency of ${manifestPath(d.manifest ?? '')} but production code in ${d.declareIn || 'the root'} imports it (declare it in "dependencies" of ${manifestPath(d.declareIn)})`
            : `"${d.name}" is only a devDependency${d.manifest ? ` of ${manifestPath(d.manifest)}` : ''} but production code imports it (move it to "dependencies")`,
        severity: devAllowed(d.name) ? 'warning' : 'error',
        subject: `${d.name}|${d.manifest ?? ''}`,
        fingerprint: devDependencyInProductionFingerprint(d.name, d.manifest),
      }),
    ),
  ];
  const fixed: Finding[] = [
    ...(ctx.delta?.fixedMissingDependencies ?? []).map((name) =>
      finding('dependencies', RULE_IDS.missingDependency, { file: 'package.json', message: `"${name}" is declared or no longer imported`, severity: 'error', subject: name, fingerprint: missingDependencyFingerprint(name), status: 'fixed' }),
    ),
    ...(ctx.delta?.fixedDevDependenciesInProduction ?? []).map((d) =>
      finding('dependencies', RULE_IDS.devDependencyInProduction, {
        file: manifestPath(d.manifest ?? ''),
        message: `"${d.name}" is no longer a devDependency used in production code`,
        severity: 'error',
        subject: `${d.name}|${d.manifest ?? ''}`,
        fingerprint: devDependencyInProductionFingerprint(d.name, d.manifest),
        status: 'fixed',
      }),
    ),
  ];
  return {
    id: 'dependencies',
    label: 'Declared dependencies',
    ok: (!!t.allowMissingDependencies || missing.length === 0) && !devFails,
    detail:
      [
        missing.length && `${missing.length} imported but missing from package.json`,
        devInProduction.length && `${devInProduction.length} devDependenc${devInProduction.length === 1 ? 'y' : 'ies'} used in production code`,
      ]
        .filter(Boolean)
        .join(', ') || 'all imports are declared',
    findings,
    ruleIds: [RULE_IDS.missingDependency, RULE_IDS.devDependencyInProduction],
    fixed,
  };
};

/** The line of the import that starts the cycle's sample path (its first member imports the second). */
function cycleLine(data: ReportData, cycle: string[]): number | undefined {
  const next = cycle[1] ?? cycle[0];
  return data.edges.find((e) => e.source === cycle[0] && e.target === next && !e.typeOnly)?.line ?? data.edges.find((e) => e.source === cycle[0] && e.target === next)?.line;
}

function cycleFinding(cycle: string[], severity: Finding['severity'], line?: number, status?: FindingStatus): Finding {
  return finding('cycles', RULE_IDS.cycle, {
    file: cycle[0],
    line,
    message: `Circular dependency: ${cycle.slice(0, 6).join(' → ')}${cycle.length > 6 ? ' → …' : ''}`,
    severity,
    subject: cycleSetKey(cycle),
    fingerprint: cycleFingerprint(cycle),
    weight: new Set(cycle).size,
    ...(status ? { status } : {}),
  });
}

export const cyclesGate: GateProvider = (data, ctx) => {
  const max = ctx.thresholds.maxCycles;
  const cycles = data.insights.cycles.filter((c) => c.some((f) => ctx.inScope(f)));
  const fixed = ctx.delta?.fixedCycles ?? [];
  if (max === undefined && !cycles.length && !fixed.length) return undefined;
  // Cycles are errors once the project sets a limit; without one they are reported as warnings.
  const severity = max !== undefined ? 'error' : 'warning';
  return {
    id: 'cycles',
    label: 'Circular dependencies',
    ok: max === undefined || cycles.length <= max,
    detail: `${cycles.length}${max !== undefined ? ` (max ${max})` : ''}`,
    findings: cycles.map((c) => cycleFinding(c, severity, cycleLine(data, c))),
    ruleIds: [RULE_IDS.cycle],
    fixed: fixed.map((c) => cycleFinding(c, severity, undefined, 'fixed')),
  };
};

/** Every function of the analyzed scope measured by its worst part (the same measure as the delta), most complex first. */
function rankedFunctions(data: ReportData): MeasuredFunction[] {
  return measuredFunctions(data.files, (f) => f.scope !== 'context').sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file) || a.line - b.line);
}

export const complexityGate: GateProvider = (data, ctx) => {
  const max = ctx.thresholds.maxComplexity;
  if (max === undefined) return undefined;
  const tooComplex = rankedFunctions(data).filter((f) => f.complexity > max && ctx.inScope(f.file) && (!ctx.changedSymbols || ctx.changedSymbols.has(f.symbol)));
  // New when the function is new above the limit or got more complex (an old finding that grew is new debt).
  const before = new Map((ctx.delta?.complexity ?? []).filter((c) => c.after > c.before).map((c) => [c.symbol, c.before]));
  const fixed = (ctx.delta?.fixedComplexity ?? []).filter((c) => c.complexity > max);
  return {
    id: 'complexity',
    label: 'Function complexity',
    ok: tooComplex.length === 0,
    detail: tooComplex.length ? `${plural(tooComplex.length, 'function')} above ${max}` : `all ≤ ${max}`,
    findings: tooComplex.map((f) => {
      const was = before.get(f.symbol);
      return finding('complexity', RULE_IDS.complexity, {
        file: f.file,
        line: f.line,
        // "was 301": a function that grew is old code that got worse, not a new function.
        message: `${f.name} has cyclomatic complexity ${f.complexity} (max ${max}${was ? `, was ${was}` : ''})`,
        severity: 'error',
        subject: f.symbol,
        fingerprint: complexityFingerprint(f.file, f.symbol),
        weight: f.complexity,
        ...(was !== undefined && was > max ? { worsened: true } : {}),
      });
    }),
    ruleIds: [RULE_IDS.complexity],
    isNew: (f) => before.has(f.subject) || undefined,
    fixed: fixed.map((c) =>
      finding('complexity', RULE_IDS.complexity, {
        file: c.file,
        line: c.line,
        message: `${c.name} is no longer above ${max} (was ${c.complexity})`,
        severity: 'error',
        subject: c.symbol,
        fingerprint: complexityFingerprint(c.file, c.symbol),
        status: 'fixed',
      }),
    ),
  };
};

/** `--no-worse`: every function your change made more complex, whatever its size. */
export const noWorseGate: GateProvider = (data, ctx) => {
  if (!ctx.thresholds.noWorse) return undefined;
  const max = ctx.thresholds.maxComplexity;
  const all = (ctx.delta?.complexity ?? []).filter((c) => c.before > 0 && c.after > c.before && ctx.inScope(c.file));
  // Above the complexity limit, the complexity gate already reports the growth as a new finding.
  const grew = all.filter((c) => max === undefined || c.after <= max);
  const elsewhere = all.length - grew.length;
  const others = elsewhere ? ` (${elsewhere} more under Function complexity)` : '';
  return {
    id: 'no-worse',
    label: 'Complexity growth',
    ok: grew.length === 0,
    detail: !ctx.delta ? 'no base to compare with' : grew.length ? `${plural(grew.length, 'function')} got more complex${others}` : `no ${elsewhere ? 'other ' : ''}function got more complex${others}`,
    findings: grew.map((c) =>
      finding('no-worse', RULE_IDS.complexityIncrease, {
        file: c.file,
        line: c.line,
        message: `${functionLabel(c.name)} got more complex: ${c.before} → ${c.after}`,
        severity: 'error',
        subject: c.symbol,
        fingerprint: complexityIncreaseFingerprint(c.file, c.symbol),
        weight: c.after - c.before,
        status: 'new',
      }),
    ),
    ruleIds: [RULE_IDS.complexityIncrease],
    newOnly: false,
  };
};

export const unusedExportsGate: GateProvider = (data, ctx) => {
  const max = ctx.thresholds.maxUnusedExports;
  if (max === undefined) return undefined;
  const unused = data.insights.unusedExports.filter((u) => !u.typeOnly && ctx.inScope(u.file));
  const toFinding = (u: { file: string; name: string; line: number }, status?: FindingStatus): Finding =>
    finding('unused-exports', RULE_IDS.unusedExport, {
      file: u.file,
      line: u.line,
      message: status === 'fixed' ? `Export "${u.name}" is used (or gone) now` : `Export "${u.name}" is never imported`,
      // A limit makes them gate-worthy (like cycles): over the limit, a new one fails the gate.
      severity: 'error',
      subject: `${u.file}#${u.name}`,
      fingerprint: unusedExportFingerprint(u.file, u.name),
      ...(status ? { status } : {}),
    });
  return {
    id: 'unused-exports',
    label: 'Unused exports',
    ok: unused.length <= max,
    detail: `${unused.length} (max ${max})`,
    findings: unused.map((u) => toFinding(u)),
    ruleIds: [RULE_IDS.unusedExport],
    fixed: (ctx.delta?.fixedUnusedExports ?? []).map((u) => toFinding(u, 'fixed')),
  };
};

export const healthGate: GateProvider = (data, ctx) => {
  const min = ctx.thresholds.minHealth;
  if (min === undefined) return undefined;
  const score = data.health.score;
  const drop = ctx.delta ? healthDrop(ctx.delta) : 0;
  // New-only: a score that was already below the minimum only fails when your change lowers it further.
  const lowered = !ctx.newOnly || !ctx.delta || drop > 0;
  return {
    id: 'health',
    label: 'Health score',
    ok: score >= min || !lowered,
    detail: `${score}/100 (min ${min}${ctx.newOnly && ctx.delta && score < min ? `, ${drop > 0 ? `−${drop}` : 'not lowered'} by this change` : ''})`,
    findings: [],
    newOnly: false,
  };
};

export const healthDropGate: GateProvider = (data, ctx) => {
  const max = ctx.thresholds.maxHealthDrop;
  if (max === undefined) return undefined;
  if (!ctx.delta) return { id: 'health-drop', label: 'Health drop', ok: true, detail: 'no base to compare with', findings: [], newOnly: false };
  const drop = healthDrop(ctx.delta);
  const { before, after } = ctx.delta.health;
  return {
    id: 'health-drop',
    label: 'Health drop',
    ok: drop <= max,
    detail: `${before} → ${after} (${drop > 0 ? `−${drop}` : drop < 0 ? `+${-drop}` : '±0'}, max drop ${max})`,
    findings: [],
    newOnly: false,
  };
};

export const riskGate: GateProvider = (data, ctx) => {
  const max = ctx.thresholds.maxRisk;
  if (max === undefined || !data.changes) return undefined;
  const risk = data.changes.risk;
  return { id: 'risk', label: 'Change risk', ok: risk.score <= max, detail: `${risk.score}/100 (${risk.level}, max ${max})`, findings: [], newOnly: false };
};

/**
 * The gates `check` runs, in display order. Other features append their provider here (one line each),
 * e.g. patch coverage, clones or hygiene.
 */
export const GATE_PROVIDERS: GateProvider[] = [rulesGate, dependenciesGate, cyclesGate, complexityGate, noWorseGate, unusedExportsGate, healthGate, healthDropGate, riskGate];
// --- test-intelligence ---
GATE_PROVIDERS.push(patchCoverageGate);
// --- clone-radar: `check --max-new-clones` ---
GATE_PROVIDERS.push(clonesGate);

/* -------------------------------------------------------------------------- */
/*                                 Evaluation                                 */
/* -------------------------------------------------------------------------- */

/** Modes that compare with a base commit. */
const DELTA_MODES: CheckMode[] = ['changed', 'new-since', 'staged'];

/**
 * Rule ids whose findings compareReports fingerprints in `delta.fingerprints`: compared with a base commit,
 * their findings are new by fingerprint. Findings of other rules (gates other features add) are new when
 * they are on a changed line, unless their provider decides (`isNew`). A feature that adds its findings
 * to compareReports' fingerprints adds its rule id here.
 */
export const DELTA_RULE_IDS = new Set<string>([RULE_IDS.cycle, RULE_IDS.rule, RULE_IDS.layer, RULE_IDS.missingDependency, RULE_IDS.devDependencyInProduction, RULE_IDS.complexity, RULE_IDS.unusedExport]);

export function isNewOnlyMode(mode: CheckMode, changedMode: 'new' | 'files' = 'new'): boolean {
  return mode === 'baseline' || (DELTA_MODES.includes(mode) && changedMode !== 'files');
}

/** `1 new · 14 existing · 2 fixed` */
export function countsLabel(counts: NonNullable<GateResult['counts']>): string {
  return `${counts.new} new · ${counts.existing} existing · ${counts.fixed} fixed`;
}

function fixedFromBaseline(gate: string, entries: { ruleId: string; fingerprint: string }[]): Finding[] {
  return entries.map((e) => ({
    ruleId: e.ruleId,
    gate,
    file: '',
    message: `${ruleDescriptor(e.ruleId).shortDescription} (no longer found)`,
    severity: 'note',
    subject: e.fingerprint,
    fingerprint: e.fingerprint,
    status: 'fixed',
  }));
}

/** How findings get their status: by fingerprint against the base commit, or occurrence by occurrence against a baseline. */
interface Comparison {
  isNew(f: Finding, outcome: GateOutcome): boolean;
  /** What went away since the base, for one gate. */
  fixed(outcome: GateOutcome): Finding[];
}

/** The rule ids a gate judges: the ones it declares and the ones of its findings. */
function outcomeRuleIds(outcome: GateOutcome): string[] {
  return [...new Set([...(outcome.ruleIds ?? []), ...outcome.findings.map((f) => f.ruleId)])];
}

function deltaComparison(delta: ArchitectureDelta): Comparison {
  const fps = new Set([...delta.fingerprints.new, ...(delta.fingerprints.worsened ?? [])]);
  return {
    isNew: (f, outcome) => outcome.isNew?.(f) ?? (DELTA_RULE_IDS.has(f.ruleId) ? fps.has(f.fingerprint) : fps.has(f.fingerprint) || !!f.onChangedLine),
    fixed: (outcome) => outcome.fixed ?? [],
  };
}

/**
 * Against the baseline. Entries of rules whose gate did not run (a threshold left out this time) are
 * neither new nor fixed; in a partial analysis nothing is fixed (the finding may be outside it).
 */
function baselineComparison(baseline: Baseline, partial: boolean): Comparison {
  const matcher = new BaselineMatcher(baseline);
  return {
    isNew: (f) => !matcher.claim({ ruleId: f.ruleId, fingerprint: f.fingerprint, members: cycleMembers(f) }),
    fixed: (outcome) => (partial ? [] : fixedFromBaseline(outcome.id, matcher.takeLeftovers(outcomeRuleIds(outcome)))),
  };
}

/** Classify a gate's findings and judge it: compared with a base, old debt does not fail it — only a new error does. */
function judge(outcome: GateOutcome, comparison: Comparison | undefined, changedLines: Map<string, Set<number>>): { gate: GateResult; fixed: Finding[] } {
  const { ruleIds: _ruleIds, newOnly, fixed: _fixed, isNew: _isNew, keepDetail, ...gate } = outcome;
  for (const f of gate.findings) {
    const lines = changedLines.get(f.file);
    if (lines && (f.line === undefined || lines.has(f.line))) f.onChangedLine = true;
    if (comparison && !f.status) f.status = comparison.isNew(f, outcome) ? 'new' : 'existing';
  }
  if (!comparison) return { gate, fixed: [] };
  const fixed = comparison.fixed(outcome);
  if (newOnly !== false && gate.findings.length && !gate.ok) gate.ok = !gate.findings.some((f) => f.status === 'new' && f.severity === 'error');
  if (newOnly !== false || gate.findings.length) {
    gate.counts = { new: gate.findings.filter((f) => f.status === 'new').length, existing: gate.findings.filter((f) => f.status === 'existing').length, fixed: fixed.length };
    if (!keepDetail) gate.detail = countsLabel(gate.counts);
  }
  return { gate, fixed };
}

/**
 * Run the gates over an analysis. Compared with a base commit (`changed`, `new-since`, `staged`: the
 * delta) or a baseline, findings get a status and a gate only fails on new errors; `all` judges everything.
 */
export function evaluateGates(data: ReportData, thresholds: Thresholds, options: EvaluateOptions): CheckResult {
  const { mode } = options;
  const notes: string[] = [];
  const delta = options.delta ?? data.changes?.delta;
  let changedMode = options.changedMode ?? 'new';
  // Without a delta (the comparison failed), --changed falls back to judging the touched files.
  if (DELTA_MODES.includes(mode) && changedMode === 'new' && !delta) {
    changedMode = 'files';
    notes.push('Could not compare with the base commit — judging every finding in the changed files instead.');
  }
  let comparison: Comparison | undefined;
  if (mode === 'baseline' && options.baseline) {
    comparison = baselineComparison(options.baseline, !!options.partial);
    if (options.partial) notes.push('Only part of the project was analyzed: known findings outside it are not counted as fixed.');
  }
  else if (delta && isNewOnlyMode(mode, changedMode) && mode !== 'baseline') comparison = deltaComparison(delta);
  const filesMode = DELTA_MODES.includes(mode) && changedMode === 'files' && !!data.changes;
  const touched = new Set((data.changes?.files ?? []).map((f) => f.id));
  const ctx: GateContext = {
    mode,
    newOnly: !!comparison,
    thresholds,
    delta,
    inScope: filesMode ? (file) => touched.has(file) : () => true,
    changedSymbols: filesMode ? new Set((data.changes?.symbols ?? []).map((s) => s.id)) : undefined,
  };
  const changedLines = new Map((data.changes?.files ?? []).map((f) => [f.id, new Set(f.lines)]));

  const gates: GateResult[] = [];
  const fixed: Finding[] = [];
  const ruleIds = new Set<string>();
  for (const provider of options.providers ?? GATE_PROVIDERS) {
    const outcome = provider(data, ctx);
    if (!outcome) continue;
    for (const id of outcomeRuleIds(outcome)) ruleIds.add(id);
    const judged = judge(outcome, comparison, changedLines);
    gates.push(judged.gate);
    fixed.push(...judged.fixed);
  }

  const result: CheckResult = { ok: gates.every((g) => g.ok), mode, health: data.health.score, gates, fixed, newOnly: !!comparison, ruleIds: [...ruleIds].sort() };
  const base = options.base ?? (DELTA_MODES.includes(mode) ? (delta?.base ?? data.changes?.base) : undefined);
  if (base) result.base = base;
  if (delta) result.healthDelta = delta.health.after - delta.health.before;
  if (notes.length) result.notes = notes;
  return result;
}

/** Every finding of a result, gate by gate (fixed ones excluded). */
export function allFindings(result: Pick<CheckResult, 'gates'>): Finding[] {
  return result.gates.flatMap((g) => g.findings);
}

/** Findings that make their gate fail: new errors in new-only modes, errors otherwise. */
export function failingFindings(gate: GateResult): Finding[] {
  if (gate.ok) return [];
  const newOnly = !!gate.counts;
  return gate.findings.filter((f) => f.severity === 'error' && (!newOnly || f.status === 'new'));
}

// --- daily-loop: focused tests, debugger statements and conflict markers on added lines (shown last) ---
GATE_PROVIDERS.push(hygieneGate);
