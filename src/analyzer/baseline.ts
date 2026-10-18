/**
 * The committed baseline (`code-visualizer.baseline.json`): known findings that `check` tolerates, stored
 * as fingerprints per rule. Like ESLint's bulk suppressions it holds identities and counts, never line
 * numbers, so unrelated edits do not invalidate it. Updates are a ratchet: fixed findings leave the file,
 * new ones only enter it with `--force`. Import cycles also keep their files, so a known cycle that lost
 * files or split in two is still known.
 *
 * Fingerprints include file paths: renaming or moving a file makes its known findings look new (and the
 * old entries fixed) until the baseline is updated with `--update-baseline --force`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Baseline, Finding } from '../shared/types.js';
import { RULE_IDS } from '../shared/fingerprint.js';
import { writeFileAtomic } from './state.js';

export const DEFAULT_BASELINE_FILE = 'code-visualizer.baseline.json';
const TOOL = 'code-visualizer';

export class BaselineError extends Error {}

/** Count of each fingerprint per rule. */
type Counts = Map<string, Map<string, number>>;

/** A finding as the baseline sees it: its rule, its identity and, for import cycles, its files. */
export interface BaselineEntry {
  ruleId: string;
  fingerprint: string;
  members?: string[];
}

/** The files of a cycle finding (its subject is the sorted member set, see `cycleSetKey`). */
export function cycleMembers(f: { ruleId: string; subject?: string }): string[] | undefined {
  return f.ruleId === RULE_IDS.cycle && f.subject ? f.subject.split(' → ') : undefined;
}

function countsOf(findings: Record<string, string[]>): Counts {
  const counts: Counts = new Map();
  for (const [rule, fps] of Object.entries(findings)) {
    const perRule = new Map<string, number>();
    for (const fp of fps) perRule.set(fp, (perRule.get(fp) ?? 0) + 1);
    counts.set(rule, perRule);
  }
  return counts;
}

/** Every entry of a baseline, once per occurrence, with the files of its cycles. */
function entriesOf(baseline: Baseline): BaselineEntry[] {
  const entries: BaselineEntry[] = [];
  for (const [ruleId, fps] of Object.entries(baseline.findings)) {
    for (const fp of fps) {
      const members = ruleId === RULE_IDS.cycle ? baseline.cycles?.[fp] : undefined;
      entries.push(members ? { ruleId, fingerprint: fp, members } : { ruleId, fingerprint: fp });
    }
  }
  return entries;
}

/** The baseline holding exactly these entries: sorted rules and fingerprints, cycle files by fingerprint. */
function fromEntries(entries: BaselineEntry[]): Baseline {
  const byRule = new Map<string, string[]>();
  const cycles = new Map<string, string[]>();
  for (const e of entries) {
    byRule.set(e.ruleId, [...(byRule.get(e.ruleId) ?? []), e.fingerprint]);
    if (e.ruleId === RULE_IDS.cycle && e.members?.length) cycles.set(e.fingerprint, [...new Set(e.members)].sort());
  }
  const findings: Record<string, string[]> = {};
  for (const rule of [...byRule.keys()].sort()) findings[rule] = byRule.get(rule)!.sort();
  const baseline: Baseline = { version: 1, tool: TOOL, findings };
  if (cycles.size) baseline.cycles = Object.fromEntries([...cycles].sort((a, b) => a[0].localeCompare(b[0])));
  return baseline;
}

/** The baseline that tolerates exactly these findings (fixed ones are ignored). */
export function baselineFromFindings(findings: (Pick<Finding, 'ruleId' | 'fingerprint'> & Partial<Pick<Finding, 'status' | 'subject'>>)[]): Baseline {
  return fromEntries(
    findings
      .filter((f) => f.status !== 'fixed')
      .map((f) => {
        const members = cycleMembers(f);
        return members ? { ruleId: f.ruleId, fingerprint: f.fingerprint, members } : { ruleId: f.ruleId, fingerprint: f.fingerprint };
      }),
  );
}

export function baselineSize(baseline: Baseline): number {
  return Object.values(baseline.findings).reduce((n, list) => n + list.length, 0);
}

/** Validate a parsed baseline file; throws a BaselineError that says what is wrong. */
export function parseBaseline(text: string, name = DEFAULT_BASELINE_FILE): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new BaselineError(`${name} is not valid JSON: ${(error as Error).message}`);
  }
  const value = raw as Partial<Baseline> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BaselineError(`${name} must contain a JSON object.`);
  if (value.version !== 1) throw new BaselineError(`${name} has an unsupported version (${JSON.stringify(value.version)}); expected 1.`);
  const findings = value.findings ?? {};
  if (typeof findings !== 'object' || Array.isArray(findings)) throw new BaselineError(`${name}: "findings" must map rule ids to lists of fingerprints.`);
  for (const [rule, list] of Object.entries(findings)) {
    if (!Array.isArray(list) || !list.every((fp) => typeof fp === 'string')) throw new BaselineError(`${name}: findings["${rule}"] must be a list of fingerprints.`);
  }
  const cycles = value.cycles;
  if (cycles !== undefined) {
    const valid = !!cycles && typeof cycles === 'object' && !Array.isArray(cycles) && Object.values(cycles).every((m) => Array.isArray(m) && m.every((f) => typeof f === 'string'));
    if (!valid) throw new BaselineError(`${name}: "cycles" must map cycle fingerprints to lists of files.`);
  }
  const baseline: Baseline = { version: 1, tool: typeof value.tool === 'string' ? value.tool : TOOL, findings: findings as Record<string, string[]> };
  if (cycles && Object.keys(cycles).length) baseline.cycles = cycles;
  return baseline;
}

/** The baseline at `file`, or undefined when there is none. Throws a BaselineError for invalid files. */
export function readBaseline(file: string): Baseline | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new BaselineError(`Cannot read ${file}: ${(error as Error).message}`);
  }
  return parseBaseline(text, path.basename(file));
}

/** Deterministic text: sorted keys and fingerprints, 2-space indent, trailing newline (stable diffs). */
export function serializeBaseline(baseline: Baseline): string {
  const sorted = fromEntries(entriesOf(baseline));
  return `${JSON.stringify({ version: 1, tool: baseline.tool || TOOL, findings: sorted.findings, ...(sorted.cycles ? { cycles: sorted.cycles } : {}) }, null, 2)}\n`;
}

export function writeBaseline(file: string, baseline: Baseline): void {
  writeFileAtomic(file, serializeBaseline(baseline));
}

/**
 * The next baseline: the current findings the previous baseline knew (only fixed findings leave; a cycle
 * that shrank or split stays known under its new fingerprint), and with `force` the new ones too.
 * `rules` are the rule ids that were judged: entries of other rules (a gate that did not run this time)
 * are kept as they are. `added` counts accepted new findings, `removed` fixed ones, `rejected` the new
 * findings left out.
 */
export function ratchetBaseline(
  previous: Baseline | undefined,
  current: Baseline,
  options: { force?: boolean; rules?: Iterable<string> } = {},
): { baseline: Baseline; added: number; removed: number; rejected: number } {
  const now = entriesOf(current);
  // A new baseline (no file yet) accepts everything: that is how a project adopts the gates.
  if (!previous) return { baseline: fromEntries(now), added: now.length, removed: 0, rejected: 0 };
  const judged = options.rules ? new Set(options.rules) : undefined;
  const matcher = new BaselineMatcher(previous);
  const next: BaselineEntry[] = [];
  let added = 0;
  let rejected = 0;
  for (const e of now) {
    if (matcher.claim(e)) next.push(e);
    else if (options.force) {
      next.push(e);
      added++;
    } else rejected++;
  }
  const previousRules = Object.keys(previous.findings);
  // Known cycles merged into a bigger one stay known (the merge itself was rejected or accepted above).
  if (!judged || judged.has(RULE_IDS.cycle)) next.push(...matcher.mergedCycles());
  const removed = matcher.takeLeftovers(previousRules.filter((r) => !judged || judged.has(r))).length;
  next.push(...entriesOf(previous).filter((e) => judged && !judged.has(e.ruleId)));
  return { baseline: fromEntries(next), added, removed, rejected };
}

/**
 * Matches findings against a baseline, occurrence by occurrence: the first N findings with a fingerprint
 * the baseline lists N times are known, any further ones are new. Import cycles are judged like
 * compareReports judges them: a cycle is known when all its files belonged to one known cycle (it lost
 * files or split), and a known cycle is fixed only when no two of its files share a cycle any more. What
 * is left over was fixed.
 */
export class BaselineMatcher {
  private readonly remaining: Counts;
  /** Files of each known cycle, and file → the known cycle it belonged to. */
  private readonly cycleMembers = new Map<string, string[]>();
  private readonly cycleOf = new Map<string, string>();
  /** Known cycles a current (smaller) cycle was matched to: they live on under its fingerprint. */
  private readonly replaced = new Set<string>();
  /** File → the current cycle it is in (every cycle offered to `claim`). */
  private readonly currentOf = new Map<string, number>();
  private currentCount = 0;

  constructor(baseline: Baseline) {
    this.remaining = countsOf(baseline.findings);
    const known = this.remaining.get(RULE_IDS.cycle);
    for (const [fp, members] of Object.entries(baseline.cycles ?? {})) {
      if (!known?.has(fp)) continue;
      this.cycleMembers.set(fp, members);
      for (const m of members) this.cycleOf.set(m, fp);
    }
  }

  /** True (and the entry is used up) when the baseline knows this finding. */
  claim(f: BaselineEntry): boolean {
    const cycle = f.ruleId === RULE_IDS.cycle && f.members?.length ? f.members : undefined;
    if (cycle) {
      const id = this.currentCount++;
      for (const m of cycle) this.currentOf.set(m, id);
    }
    const perRule = this.remaining.get(f.ruleId);
    const n = perRule?.get(f.fingerprint) ?? 0;
    if (n) {
      perRule!.set(f.fingerprint, n - 1);
      return true;
    }
    if (cycle) {
      const first = this.cycleOf.get(cycle[0]);
      if (first !== undefined && cycle.every((m) => this.cycleOf.get(m) === first)) {
        this.replaced.add(first);
        return true;
      }
    }
    return false;
  }

  /** A known cycle whose files still (partly) form a cycle: two of them share one, or its only file is in one. */
  private alive(fp: string): boolean {
    const members = this.cycleMembers.get(fp);
    if (!members) return false;
    if (members.length === 1) return this.currentOf.has(members[0]);
    const seen = new Set<number>();
    for (const m of members) {
      const id = this.currentOf.get(m);
      if (id === undefined) continue;
      if (seen.has(id)) return true;
      seen.add(id);
    }
    return false;
  }

  /**
   * Known cycles that are not claimed but live on inside a bigger (new) cycle: neither fixed nor matched.
   * A baseline update keeps them, so undoing the merge is not "new".
   */
  mergedCycles(): BaselineEntry[] {
    const perRule = this.remaining.get(RULE_IDS.cycle);
    if (!perRule) return [];
    return [...perRule]
      .filter(([fp, n]) => n > 0 && !this.replaced.has(fp) && this.alive(fp))
      .map(([fp]) => ({ ruleId: RULE_IDS.cycle, fingerprint: fp, members: this.cycleMembers.get(fp) }));
  }

  /** Baseline entries of these rules that no finding claimed (fixed), and forget them. */
  takeLeftovers(ruleIds: Iterable<string>): { ruleId: string; fingerprint: string }[] {
    const result: { ruleId: string; fingerprint: string }[] = [];
    for (const ruleId of ruleIds) {
      const perRule = this.remaining.get(ruleId);
      if (!perRule) continue;
      for (const [fingerprint, n] of [...perRule].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (ruleId === RULE_IDS.cycle && (this.replaced.has(fingerprint) || this.alive(fingerprint))) continue;
        for (let i = 0; i < n; i++) result.push({ ruleId, fingerprint });
      }
      this.remaining.delete(ruleId);
    }
    return result;
  }

  /** All rules that still have unclaimed entries. */
  ruleIds(): string[] {
    return [...this.remaining.keys()].filter((r) => [...this.remaining.get(r)!.values()].some((n) => n > 0)).sort();
  }
}
