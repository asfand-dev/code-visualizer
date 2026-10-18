/**
 * Live guard: what got worse (or better) between two analyses of a running `serve` — a new cycle, a
 * broken layer rule, a function that got more complex, a signature change with importers, an edited
 * file no test reaches, the health score. Built on `compareReports` and works on two in-memory
 * reports (no git, no I/O); `LiveGuard` adds the session state: problems already announced stay
 * quiet until they are fixed, and the feed keeps the last 200 events.
 *
 * The checks of open problems are built by the module-level factories below and capture only
 * primitives (file ids, names, fingerprints): a closure over a report would keep that whole analysis
 * alive for as long as the problem stays open.
 */
import { exportChangeLabel, exportName, functionLabel } from '../shared/delta.js';
import {
  complexityFingerprint,
  cycleFingerprint,
  devDependencyInProductionFingerprint,
  fingerprint,
  missingDependencyFingerprint,
  RULE_IDS,
  unusedExportFingerprint,
  violationFingerprint,
} from '../shared/fingerprint.js';
import { severityRank } from '../shared/live.js';
import { testEvidence } from '../shared/query.js';
import { callMatchesRoute } from '../shared/route-match.js';
import { isCallable, paramRange } from '../shared/signature.js';
import { isTestableSource } from '../shared/testcmd.js';
import type { ArchitectureDelta, DependencyEdge, ExportChange, FileInfo, LiveEvent, LiveEventKind, LiveFeed, ReportData, RouteInfo, RuleViolation } from '../shared/types.js';
import { compareReports, COMPLEXITY_THRESHOLD, groupBy, importersOfName, measuredFunctions, routeKey, type MeasuredFunction } from './compare.js';
import type { CodeVisualizerConfig } from './config.js';
import { cloneDetector } from './clones.js';

/** An event before it gets its id, time and version. */
export type LiveEventDraft = Omit<LiveEvent, 'id' | 'at' | 'version'>;

/** What a detector found. Problems carry `stillOpen`; the guard announces each once until it is gone. */
export interface LiveCandidate {
  event: LiveEventDraft;
  /** A problem: is it still there in this analysis? While it is, repeats of its fingerprint stay quiet. */
  stillOpen?: (report: ReportData) => boolean;
  /** Announced when an open problem goes away without a fix event of its own (undefined: close silently). */
  resolved?: (report: ReportData) => LiveEventDraft | undefined;
  /** Announce an open problem again anyway (e.g. a complex function that grew a lot more). */
  repeat?: (announced: LiveEventDraft) => boolean;
  /** A problem that closed silently (e.g. its rule was commented out) is announced again once this holds. */
  revive?: (report: ReportData) => boolean;
  /** Open problems this one replaces (a cycle that grew): they close silently when it is announced. */
  supersedes?: (open: LiveEventDraft) => boolean;
  /**
   * A fix that is not certain yet (a cycle that only went away because one of its imports broke): held
   * back while `while` holds and announced once it does not, unless the problem came back first
   * (`returns`: a later problem that is this one again, which is then not news either).
   */
  hold?: { while: (report: ReportData) => boolean; returns: (event: LiveEventDraft) => boolean };
  /**
   * A change that can be undone (a signature): changing `key` back to what this session first saw
   * (`from` of its first change) is announced as `restored` instead of as another change.
   */
  track?: { key: string; from: string; to: string; restored: LiveEventDraft };
  /** An open problem's message as it stands in a later analysis (one of two stale calls fixed: "1 call site"). */
  refresh?: (report: ReportData) => Pick<LiveEventDraft, 'message'> | undefined;
}

/** An import that resolved in the previous analysis and broke because its target file is gone. */
export interface BrokenImport {
  importer: string;
  /** The file that was deleted or moved. */
  target: string;
  specifier: string;
  line: number;
  names: string[];
}

export interface LiveContext {
  prev: ReportData;
  next: ReportData;
  /** `compareReports(prev, next)` for the touched files (no area edges). */
  delta: ArchitectureDelta;
  /** Files whose content changed: reported by the watcher, added, deleted, or with another size. */
  touched: Set<string>;
  config?: CodeVisualizerConfig;
  /** Imports that broke because their target was deleted or moved without updating its importers. */
  broken: BrokenImport[];
  /**
   * Rule violations (fingerprints) of the last analysis whose configuration was valid (LiveGuard):
   * when a broken configuration is repaired, rule breaks made while it was ignored are news.
   */
  knownViolations?: ReadonlySet<string>;
}

/** One source of live events. Later features add theirs to LIVE_DETECTORS. */
export type LiveDetector = (ctx: LiveContext) => LiveCandidate[];

/** More files than this changed at once (checkout, pull, formatter): not "a save", so no untested-file nudges. */
const BULK_CHANGE = 10;
/** A complexity change worth an info event even below the threshold. */
const BIG_STEP = 5;
const MAX_CYCLE_MEMBERS = 6;
/** More files than this with new unused exports in one step: one event for all of them. */
const UNUSED_GROUP_FILES = 3;
/** Session memory for undone changes, held fixes and silently closed problems (oldest dropped first). */
const MEMORY = 200;

const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const fileMap = (report: ReportData): Map<string, FileInfo> => new Map(report.files.map((f) => [f.id, f]));
const fileOf = (report: ReportData, id: string): FileInfo | undefined => report.files.find((f) => f.id === id);
const edgeKey = (source: string, target: string): string => `${source}\0${target}`;

/** Keep a session map small: drop the oldest entries. */
function trim<K, V>(map: Map<K, V>, max = MEMORY): void {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

/* ------------------------------ Configuration ------------------------------ */

const configStillBroken =
  (error: string) =>
  (r: ReportData): boolean =>
    r.config?.error === error;

const configRepaired =
  (files: string[], fp: string) =>
  (r: ReportData): LiveEventDraft | undefined =>
    // Another error got an event of its own.
    r.config?.error ? undefined : { kind: 'config', severity: 'success', message: 'configuration is valid again', detail: 'rules, layers and serve settings apply again', files, fingerprint: fp };

/** A configuration that cannot be read turns every rule and layer off: say so instead of going quiet. */
const configuration: LiveDetector = ({ prev, next }) => {
  const error = next.config?.error;
  if (!error || error === prev.config?.error) return [];
  const file = next.config?.file?.replace(/#.*$/, '');
  const files = file ? [file] : [];
  const fp = fingerprint('cv/config', file ?? '', error);
  return [
    {
      event: { kind: 'config', severity: 'warning', message: `configuration ignored — ${error}`, detail: 'rules, layers and serve settings are off until it is fixed', files, fingerprint: fp },
      stillOpen: configStillBroken(error),
      resolved: configRepaired(files, fp),
    },
  ];
};

/* ---------------------------------- Cycles --------------------------------- */

/** `src/a.ts → src/b.ts → src/a.ts`, long ones shortened: `a → b → c → … (+4 more) → a`. */
export function cyclePath(cycle: string[]): string {
  if (cycle.length <= MAX_CYCLE_MEMBERS) return [...cycle, cycle[0]].join(' → ');
  return [...cycle.slice(0, MAX_CYCLE_MEMBERS - 1), `… (+${cycle.length - MAX_CYCLE_MEMBERS + 1} more)`, cycle[0]].join(' → ');
}

const overlap = (members: Set<string>, files: readonly string[]): number => files.reduce((n, f) => n + (members.has(f) ? 1 : 0), 0);

/** A cycle stays open while some cycle still holds two of its files (it shrank or grew: the same problem). */
const cycleStillThere = (members: string[]) => {
  const set = new Set(members);
  const needed = Math.min(2, members.length);
  return (r: ReportData): boolean => r.insights.cycles.some((c) => overlap(set, c) >= needed);
};

/** An open cycle that shares two files with this one merged into it. */
const cycleOverlaps = (members: string[]) => {
  const set = new Set(members);
  const needed = Math.min(2, members.length);
  return (open: LiveEventDraft): boolean => open.kind === 'cycle-added' && overlap(set, open.files) >= needed;
};

/** Imports of a cycle that broke (deleted or moved file) and are still broken. */
const importsStillBroken = (pairs: [string, string][], gone: string[]) => (r: ReportData): boolean => {
  if (gone.every((id) => r.files.some((f) => f.id === id))) return false; // the files are back
  return pairs.some(([importer, specifier]) => fileOf(r, importer)?.unresolved.some((u) => u.specifier === specifier));
};

/** The cycle again once its importers point at the moved file: its other files plus at most as many new ones as went away. */
const cycleReturns = (survivors: string[], replaced: number) => (event: LiveEventDraft): boolean => {
  if (event.kind !== 'cycle-added' || !survivors.length) return false;
  const files = new Set(event.files);
  return survivors.every((m) => files.has(m)) && event.files.length <= survivors.length + replaced;
};

/**
 * A readable new cycle: it starts at the file whose new import closed it (the edited one, when it can
 * tell), walks real imports back to it, and points at that import's line.
 */
function readableCycle(cycle: string[], next: ReportData, before: Set<string>, touched: Set<string>): { path: string[]; line?: number } {
  const members = new Set(cycle);
  const inside = next.edges.filter((e) => !e.typeOnly && members.has(e.source) && members.has(e.target) && e.source !== e.target);
  const fresh = inside.filter((e) => !before.has(edgeKey(e.source, e.target)));
  const closing = fresh.find((e) => touched.has(e.source)) ?? fresh[0];
  if (!closing) {
    const edge = inside.find((e) => e.source === cycle[0] && e.target === cycle[1 % cycle.length]);
    return { path: cycle, line: edge?.line };
  }
  // Shortest way back from the import's target to its source, within the cycle.
  const adjacency = groupBy(inside, (e) => e.source);
  const from = new Map<string, string>();
  const queue = [closing.target];
  const seen = new Set(queue);
  while (queue.length && !seen.has(closing.source)) {
    const node = queue.shift()!;
    for (const e of adjacency.get(node) ?? []) {
      if (seen.has(e.target)) continue;
      seen.add(e.target);
      from.set(e.target, node);
      queue.push(e.target);
    }
  }
  if (closing.target !== closing.source && !seen.has(closing.source)) return { path: cycle, line: closing.line };
  const back: string[] = [];
  for (let node: string | undefined = closing.source; node && node !== closing.target; node = from.get(node)) back.unshift(node);
  const path = [closing.source, closing.target, ...back.slice(0, -1)];
  return { path, line: closing.line };
}

const cycles: LiveDetector = ({ prev, next, delta, touched, broken }) => {
  const result: LiveCandidate[] = [];
  const before = delta.newCycles.length ? new Set(prev.edges.map((e) => edgeKey(e.source, e.target))) : new Set<string>();
  for (const cycle of delta.newCycles) {
    const { path, line } = readableCycle(cycle, next, before, touched);
    const members = unique([...path, ...cycle]);
    result.push({
      event: { kind: 'cycle-added', severity: 'error', message: `new cycle: ${cyclePath(path)}`, files: members, line, fingerprint: cycleFingerprint(cycle) },
      stillOpen: cycleStillThere(members),
      supersedes: cycleOverlaps(members),
    });
  }
  for (const cycle of delta.fixedCycles) {
    const event: LiveEventDraft = { kind: 'cycle-fixed', severity: 'success', message: `cycle fixed: ${cyclePath(cycle)}`, files: unique(cycle), fingerprint: cycleFingerprint(cycle) };
    const members = new Set(cycle);
    const breaks = broken.filter((b) => members.has(b.importer) && members.has(b.target));
    if (!breaks.length) {
      result.push({ event });
      continue;
    }
    // Gone only because one of its imports broke (a file deleted or moved, its importers not updated yet): not fixed.
    const gone = unique(breaks.map((b) => b.target));
    result.push({
      event,
      hold: {
        while: importsStillBroken(
          breaks.map((b) => [b.importer, b.specifier]),
          gone,
        ),
        returns: cycleReturns(
          cycle.filter((m) => !gone.includes(m)),
          gone.length,
        ),
      },
    });
  }
  return result;
};

/* ---------------------------------- Rules ---------------------------------- */

const ruleName = (v: RuleViolation): string => (v.rule === 'layers' ? 'layer rule' : `rule ${v.rule}`);
const hasViolation = (r: ReportData, fp: string): boolean => r.insights.ruleViolations.some((x) => violationFingerprint(x) === fp);

/** While the configuration cannot be read, rules are not checked: a known violation is not fixed by that. */
const violationStillThere =
  (fp: string) =>
  (r: ReportData): boolean =>
    !!r.config?.error || hasViolation(r, fp);

/** A violation whose rule was taken out and put back is the same problem again. */
const violationBack =
  (fp: string) =>
  (r: ReportData): boolean =>
    !r.config?.error && hasViolation(r, fp);

function violationCandidate(v: RuleViolation): LiveCandidate {
  const fp = violationFingerprint(v);
  return {
    event: {
      kind: 'rule-violation',
      severity: v.severity === 'error' ? 'error' : 'warning',
      message: `${ruleName(v)} broken in ${v.source}:${v.line}`,
      detail: `imports ${v.target}${v.message ? ` — ${v.message}` : ''}`,
      files: [v.source, v.target],
      line: v.line,
      fingerprint: fp,
    },
    stillOpen: violationStillThere(fp),
    revive: violationBack(fp),
  };
}

const rules: LiveDetector = ({ prev, next, delta, knownViolations }) => {
  const result = delta.newViolations.map(violationCandidate);
  // A repaired configuration: rule breaks made while it was ignored are news now.
  if (prev.config?.error && !next.config?.error && knownViolations) {
    const announced = new Set(delta.newViolations.map(violationFingerprint));
    for (const v of next.insights.ruleViolations) {
      const fp = violationFingerprint(v);
      if (!knownViolations.has(fp) && !announced.has(fp)) result.push(violationCandidate(v));
    }
  }
  for (const v of delta.fixedViolations) {
    result.push({
      event: { kind: 'rule-fixed', severity: 'success', message: `${ruleName(v)} fixed in ${v.source}`, detail: `no longer imports ${v.target}`, files: [v.source, v.target], fingerprint: violationFingerprint(v) },
    });
  }
  return result;
};

/* ------------------------------- Dependencies ------------------------------ */

const stillMissing =
  (name: string) =>
  (r: ReportData): boolean =>
    r.insights.missingDependencies.some((m) => m.name === name);

const missingResolved =
  (name: string, fp: string) =>
  (r: ReportData): LiveEventDraft => {
    const used = r.packages.some((p) => p.name === name && p.importedBy.length);
    return { kind: 'missing-dependency', severity: 'success', message: used ? `"${name}" is declared now` : `"${name}" is no longer imported`, files: [], fingerprint: fp };
  };

const devStillInProduction =
  (name: string, manifest: string) =>
  (r: ReportData): boolean =>
    (r.insights.devDependenciesInProduction ?? []).some((x) => x.name === name && (x.manifest ?? '') === manifest);

const devResolved =
  (name: string, fp: string) =>
  (): LiveEventDraft => ({ kind: 'missing-dependency', severity: 'success', message: `devDependency "${name}" is no longer used in production code`, files: [], fingerprint: fp });

const dependencies: LiveDetector = ({ delta, next }) => {
  const result: LiveCandidate[] = [];
  for (const name of delta.newMissingDependencies) {
    const info = next.insights.missingDependencies.find((m) => m.name === name);
    const manifest = info?.manifests?.[0] ? `${info.manifests[0]}/package.json` : 'package.json';
    const fp = missingDependencyFingerprint(name);
    result.push({
      event: { kind: 'missing-dependency', severity: 'error', message: `"${name}" is imported but not declared in ${manifest}`, files: info?.files.slice(0, 20) ?? [], fingerprint: fp },
      stillOpen: stillMissing(name),
      resolved: missingResolved(name, fp),
    });
  }
  for (const d of delta.newDevDependenciesInProduction ?? []) {
    const fp = devDependencyInProductionFingerprint(d.name, d.manifest);
    result.push({
      event: { kind: 'missing-dependency', severity: 'warning', message: `devDependency "${d.name}" is used in production code`, detail: 'it is missing when installed with --omit=dev', files: d.files, fingerprint: fp },
      stillOpen: devStillInProduction(d.name, d.manifest ?? ''),
      resolved: devResolved(d.name, fp),
    });
  }
  return result;
};

/* ---------------------------------- Exports -------------------------------- */

/** Edges by target, per report (weak: the index never keeps a report alive). */
const importIndex = new WeakMap<ReportData, Map<string, DependencyEdge[]>>();
function importsOf(report: ReportData, file: string): DependencyEdge[] {
  let index = importIndex.get(report);
  if (!index) {
    index = groupBy(report.edges, (e) => e.target);
    importIndex.set(report, index);
  }
  return index.get(file) ?? [];
}

/**
 * Files that import `name` from `file`: by name, through re-exporting barrels (`export * from`) or
 * with a namespace import. `import()` counts for the default export only: React.lazy and friends load
 * a module for its default, so dropping one of its named exports breaks nobody.
 */
export function liveImporters(report: ReportData, file: string, name: string): string[] {
  return importersOfName((target) => importsOf(report, target), file, name, { dynamicNamed: false });
}

/** Whether `file` exports `name`, itself or through `export * from` chains. */
function exportsName(report: ReportData, file: string, name: string, seen = new Set<string>()): boolean {
  const f = fileOf(report, file);
  if (!f || seen.has(file)) return false;
  seen.add(file);
  if (f.exports.some((x) => x.name === name)) return true;
  if (name === 'default') return false;
  return report.edges.some((e) => e.source === file && e.kind === 'reexport' && e.names.includes('*') && exportsName(report, e.target, name, seen));
}

/** The declaration's symbol id (`file#name`) in a report. */
function symbolIdOf(report: ReportData, file: string, name: string): string | undefined {
  const f = fileOf(report, file);
  const s = name === 'default' ? f?.symbols.find((x) => x.isDefault) : f?.symbols.find((x) => x.exported && x.name === name);
  return s?.id;
}

/** Calls of a symbol whose argument count does not fit its parameters (needs call-site data, see SymbolEdge.argc). */
export function staleCallCount(report: ReportData, symbolId: string): number {
  const fileId = symbolId.slice(0, symbolId.indexOf('#'));
  const symbol = fileOf(report, fileId)?.symbols.find((s) => s.id === symbolId);
  if (!symbol || !isCallable(symbol)) return 0;
  const range = paramRange(symbol.params);
  let count = 0;
  for (const e of report.symbolEdges) {
    if (e.target !== symbolId || e.kind !== 'calls' || !e.argc) continue;
    for (const n of e.argc) if (n >= 0 && (n < range.required || n > range.max)) count++;
  }
  return count;
}

/** A removed export stays a problem while its file is there without it and something still imports it. */
const removedStillImported =
  (file: string, name: string) =>
  (r: ReportData): boolean =>
    r.files.some((f) => f.id === file) && !exportsName(r, file, name) && liveImporters(r, file, name).length > 0;

const removedResolved =
  (file: string, name: string, label: string, fp: string) =>
  (r: ReportData): LiveEventDraft | undefined => {
    // A deleted file is announced with its broken imports.
    if (!r.files.some((f) => f.id === file)) return undefined;
    const back = exportsName(r, file, name);
    return { kind: 'signature-changed', severity: 'success', message: back ? `${label} is exported again` : `nothing imports the removed ${label} any more`, files: [file], fingerprint: fp };
  };

const staleCallsRemain =
  (symbol: string) =>
  (r: ReportData): boolean =>
    staleCallCount(r, symbol) > 0;

const callsUpdated =
  (file: string, name: string, symbol: string, fp: string) =>
  (r: ReportData): LiveEventDraft | undefined =>
    symbolIdOf(r, file, name) ? { kind: 'signature-changed', severity: 'success', message: `all calls of ${functionLabel(exportName({ file, name }))} updated`, files: [file], symbol, fingerprint: fp } : undefined;

const removedMessage = (label: string, importers: number): string => `${label} removed but still imported by ${plural(importers, 'file')}`;

/** How many files still import the removed export, now. */
const removedNow =
  (file: string, name: string, label: string) =>
  (r: ReportData): Pick<LiveEventDraft, 'message'> | undefined => {
    const importers = liveImporters(r, file, name).length;
    return importers ? { message: removedMessage(label, importers) } : undefined;
  };

function removedExportCandidate(e: ExportChange, next: ReportData): LiveCandidate | undefined {
  const name = exportName(e);
  const fp = fingerprint('cv/export-change', e.file, `${e.name}|removed`);
  // The same importers as the open problem will see (barrels and namespace imports included).
  const importers = e.name === '*' ? e.importers : liveImporters(next, e.file, e.name);
  if (!importers.length) {
    return e.entry ? { event: { kind: 'signature-changed', severity: 'warning', message: `${name} removed from a public entry point`, files: [e.file], line: e.line, fingerprint: fp } } : undefined;
  }
  return {
    event: {
      kind: 'signature-changed',
      severity: 'error',
      message: removedMessage(name, importers.length),
      files: unique([e.file, ...importers]).slice(0, 20),
      line: e.line,
      fingerprint: fp,
    },
    stillOpen: removedStillImported(e.file, e.name),
    resolved: removedResolved(e.file, e.name, name, fp),
    ...(e.name === '*' ? {} : { refresh: removedNow(e.file, e.name, name) }),
  };
}

/** `formatDate() signature changed (3 importers, 2 call sites not updated)`. */
function signatureMessage(label: string, importers: number, entry: boolean | undefined, stale: number): string {
  const impact = [importers ? plural(importers, 'importer') : entry ? 'public entry point' : '', stale ? `${plural(stale, 'call site')} not updated` : ''].filter(Boolean).join(', ');
  return `${label}${impact ? ` (${impact})` : ''}`;
}

/** The call sites still not updated, now: an open signature change says "1 call site" once one of two is fixed. */
const signatureNow =
  (label: string, file: string, name: string, symbol: string, entry: boolean | undefined) =>
  (r: ReportData): Pick<LiveEventDraft, 'message'> | undefined => {
    const stale = staleCallCount(r, symbol);
    if (!stale) return undefined;
    return { message: signatureMessage(label, importersOfName((target) => importsOf(r, target), file, name).length, entry, stale) };
  };

function changedExportCandidate(e: ExportChange, next: ReportData): LiveCandidate {
  const name = exportName(e);
  const symbol = symbolIdOf(next, e.file, e.name);
  const stale = e.staleCallSites.length;
  // One identity per export and kind of change: undoing it, or calls catching up, closes the same problem.
  const fp = fingerprint('cv/export-change', e.file, `${e.name}|${e.change}`);
  const label = e.change === 'kind' ? `${name} changed its kind` : `${functionLabel(name)} signature changed`;
  const candidate: LiveCandidate = {
    event: {
      kind: 'signature-changed',
      severity: stale ? 'error' : 'warning',
      message: signatureMessage(label, e.importers.length, e.entry, stale),
      detail: exportChangeLabel(e, true),
      files: unique([e.file, ...e.staleCallSites.map((s) => s.file), ...e.importers]).slice(0, 20),
      line: e.line,
      symbol,
      fingerprint: fp,
    },
    track: {
      key: fp,
      from: e.before ?? '',
      to: e.after ?? '',
      restored: {
        kind: 'signature-changed',
        severity: 'success',
        message: e.change === 'kind' ? `${name} restored` : `${functionLabel(name)} signature restored`,
        detail: e.after,
        files: [e.file],
        line: e.line,
        symbol,
        fingerprint: fp,
      },
    },
  };
  // Without call-site data there is no telling when the callers were updated: announce once.
  if (stale && symbol) {
    candidate.stillOpen = staleCallsRemain(symbol);
    candidate.resolved = callsUpdated(e.file, e.name, symbol, fp);
    candidate.refresh = signatureNow(label, e.file, e.name, symbol, e.entry);
  }
  return candidate;
}

/** A deleted or moved file stays a problem while it is gone and one of its importers still has the broken import. */
const brokenStillThere =
  (file: string, pairs: [string, string][]) =>
  (r: ReportData): boolean =>
    !r.files.some((f) => f.id === file) && pairs.some(([importer, specifier]) => fileOf(r, importer)?.unresolved.some((u) => u.specifier === specifier));

const brokenResolved =
  (file: string, movedTo: string | undefined, fp: string) =>
  (r: ReportData): LiveEventDraft => ({
    kind: 'signature-changed',
    severity: 'success',
    message: r.files.some((f) => f.id === file) ? `${file} is back` : movedTo ? `imports of the moved ${file} updated` : `nothing imports the deleted ${file} any more`,
    files: movedTo && !r.files.some((f) => f.id === file) ? [movedTo] : [],
    fingerprint: fp,
  });

/** A file that is gone (deleted, or moved without updating its importers) but still imported: one event per file. */
function brokenFileCandidate(file: string, imports: BrokenImport[], movedTo: string | undefined): LiveCandidate {
  const importers = unique(imports.map((b) => b.importer)).sort();
  const first = imports.find((b) => b.importer === importers[0]);
  const names = unique(imports.flatMap((b) => b.names).filter((n) => n !== '*')).sort();
  const fp = fingerprint('cv/export-change', file, 'deleted');
  return {
    event: {
      kind: 'signature-changed',
      severity: 'error',
      message: movedTo ? `${file} moved to ${movedTo} but ${plural(importers.length, 'file')} still import${importers.length === 1 ? 's' : ''} the old path` : `${file} deleted but still imported by ${plural(importers.length, 'file')}`,
      detail: names.length ? `uses ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}` : undefined,
      files: importers.slice(0, 20),
      line: first?.line,
      fingerprint: fp,
    },
    stillOpen: brokenStillThere(
      file,
      imports.map((b) => [b.importer, b.specifier]),
    ),
    resolved: brokenResolved(file, movedTo, fp),
  };
}

/**
 * Imports of `prev` whose target file is gone in `next` while the importer still has the import (now
 * unresolved). Independent of rename detection: a moved file whose importers were not updated is broken.
 */
export function brokenImports(prev: ReportData, next: ReportData): BrokenImport[] {
  const after = fileMap(next);
  const gone = new Set(prev.files.filter((f) => !after.has(f.id)).map((f) => f.id));
  if (!gone.size) return [];
  const result: BrokenImport[] = [];
  for (const e of prev.edges) {
    if (!gone.has(e.target)) continue;
    const u = after.get(e.source)?.unresolved.find((x) => x.specifier === e.specifier);
    if (u) result.push({ importer: e.source, target: e.target, specifier: e.specifier, line: u.line || e.line, names: e.names });
  }
  return result;
}

const exportsDetector: LiveDetector = ({ delta, next, touched, broken }) => {
  const result: LiveCandidate[] = [];
  const renamedTo = new Map((delta.renamed ?? []).map((r) => [r.from, r.to]));
  for (const [file, list] of groupBy(broken, (b) => b.target)) result.push(brokenFileCandidate(file, list, renamedTo.get(file)));
  const exists = new Set(next.files.map((f) => f.id));
  for (const e of delta.exports) {
    // Changed files only; deleted ones are announced with their broken imports above.
    if (!e.breaking || !touched.has(e.file) || !exists.has(e.file)) continue;
    if (e.change === 'removed') {
      const c = removedExportCandidate(e, next);
      if (c) result.push(c);
    } else if (e.importers.length || e.staleCallSites.length || e.entry) {
      result.push(changedExportCandidate(e, next));
    }
  }
  return result;
};

/* ---------------------------------- Routes --------------------------------- */

const routeStillCalled =
  (route: Pick<RouteInfo, 'method' | 'path' | 'type'>, key: string) =>
  (r: ReportData): boolean =>
    !r.routes.some((x) => routeKey(x) === key) && r.apiCalls.some((c) => !c.external && !c.route && callMatchesRoute(route, c));

const routeResolved =
  (label: string, key: string, fp: string) =>
  (r: ReportData): LiveEventDraft => ({
    kind: 'route-removed',
    severity: 'success',
    message: r.routes.some((x) => routeKey(x) === key) ? `${label} is back` : `nothing calls the removed ${label} any more`,
    files: [],
    fingerprint: fp,
  });

const routes: LiveDetector = ({ delta, prev }) =>
  delta.routes.removed.map((removed): LiveCandidate => {
    const route = prev.routes.find((r) => r.id === removed.id);
    const key = route ? routeKey(route) : removed.label;
    const fp = fingerprint('cv/route-removed', '', key);
    const callers = removed.stillCalledFrom;
    if (!callers.length || !route) {
      return { event: { kind: 'route-removed', severity: 'info', message: `${removed.label} removed`, files: route ? [route.file] : [], fingerprint: fp } };
    }
    return {
      event: {
        kind: 'route-removed',
        severity: 'error',
        message: `${removed.label} removed but still called from ${plural(callers.length, 'place')}`,
        files: unique(callers.map((c) => c.file)),
        line: callers[0].line,
        fingerprint: fp,
      },
      stillOpen: routeStillCalled({ method: route.method, path: route.path, type: route.type }, key),
      resolved: routeResolved(removed.label, key, fp),
    };
  });

/* -------------------------------- Complexity ------------------------------- */

/** Functions of the given files by symbol id, measured like the delta and the gates (compare.ts). */
function functionsIn(report: ReportData, files: Set<string>): Map<string, MeasuredFunction> {
  return new Map(measuredFunctions(report.files, (f) => files.has(f.id)).map((m) => [m.symbol, m]));
}

const stillComplex = (file: string, symbol: string, limit: number) => {
  const files = new Set([file]);
  return (r: ReportData): boolean => (functionsIn(r, files).get(symbol)?.complexity ?? 0) > limit;
};

/** The complexity limit `check` uses (`check.maxComplexity`), so the feed and the gate agree; default 10. */
export const complexityLimit = (config: CodeVisualizerConfig | undefined): number => config?.check?.maxComplexity ?? COMPLEXITY_THRESHOLD;

/** Still growing: say it again once it is clearly worse than what was announced. */
const grewClearly =
  (after: number) =>
  (announced: LiveEventDraft): boolean =>
    announced.after !== undefined && after >= announced.after + BIG_STEP;

const complexity: LiveDetector = ({ delta, prev, next, touched, config }) => {
  const result: LiveCandidate[] = [];
  const limit = complexityLimit(config);
  for (const c of delta.complexity) {
    if (!touched.has(c.file)) continue;
    const above = c.after > limit;
    if (!above && c.after - c.before < BIG_STEP) continue;
    const event: LiveEventDraft = {
      kind: 'complexity-up',
      severity: above ? 'warning' : 'info',
      message: c.before ? `${functionLabel(c.name)} complexity ${c.before} → ${c.after}` : `new ${functionLabel(c.name)} with complexity ${c.after}`,
      files: [c.file],
      line: c.line,
      symbol: c.symbol,
      fingerprint: complexityFingerprint(c.file, c.symbol),
      before: c.before,
      after: c.after,
    };
    result.push(above ? { event, stillOpen: stillComplex(c.file, c.symbol, limit), repeat: grewClearly(c.after) } : { event });
  }
  const before = functionsIn(prev, touched);
  const after = functionsIn(next, touched);
  for (const [id, was] of before) {
    const is = after.get(id);
    if (!is || is.complexity >= was.complexity) continue;
    const fixed = was.complexity > limit && is.complexity <= limit;
    if (!fixed && (was.complexity <= limit || was.complexity - is.complexity < BIG_STEP)) continue;
    result.push({
      event: {
        kind: 'complexity-down',
        severity: fixed ? 'success' : 'info',
        message: `${functionLabel(is.name)} complexity ${was.complexity} → ${is.complexity}`,
        files: [is.file],
        line: is.line,
        symbol: id,
        fingerprint: complexityFingerprint(is.file, id),
        before: was.complexity,
        after: is.complexity,
      },
    });
  }
  return result;
};

/* ---------------------------------- Tests ---------------------------------- */

const untestedFingerprint = (file: string): string => fingerprint('cv/untested', file, '');
/**
 * No test imports it, none requests or visits a route whose code uses it, and the coverage report saw none
 * of its lines run (query.testEvidence: the rule of `tests-for`, impact, My changes and the change risk).
 */
const isUntested = (f: FileInfo | undefined, report: ReportData): boolean => !!f && isTestableSource(f) && !f.isGenerated && !testEvidence(report, f);
/**
 * With git, only files of your current work count (a file reverted to its committed version is no
 * change; a clean working tree has no change set at all). Without git every touched file does.
 */
const inWork = (report: ReportData, file: string): boolean => (report.changes ? report.changes.files.some((f) => f.id === file) : !report.git);

/** Open while untested and part of your work (reverted or committed files drop out quietly). */
const stillUntested =
  (file: string) =>
  (r: ReportData): boolean =>
    isUntested(fileOf(r, file), r) && inWork(r, file);

const untestedResolved =
  (file: string, fp: string) =>
  (r: ReportData): LiveEventDraft | undefined => {
    const now = fileOf(r, file);
    return now && !isUntested(now, r) ? { kind: 'untested-change', severity: 'success', message: `${file} is now reached by a test`, files: [file], fingerprint: fp } : undefined;
  };

const untested: LiveDetector = ({ next, touched }) => {
  // Projects without tests would get this on every file; bulk changes are not "a save".
  if (!next.stats.testFiles || touched.size > BULK_CHANGE) return [];
  const files = fileMap(next);
  return [...touched]
    .filter((id) => isUntested(files.get(id), next) && inWork(next, id))
    .map((file): LiveCandidate => {
      const fp = untestedFingerprint(file);
      return {
        event: { kind: 'untested-change', severity: 'warning', message: `${file} changed and no test reaches it`, files: [file], fingerprint: fp },
        stillOpen: stillUntested(file),
        resolved: untestedResolved(file, fp),
      };
    });
};

/* ------------------------------- Dead exports ------------------------------ */

const unusedExports: LiveDetector = ({ delta, broken }) => {
  // A moved file whose importers still use the old path is not unused: they are broken (announced as such).
  const movedAway = new Set(broken.map((b) => b.target));
  const moved = new Set((delta.renamed ?? []).filter((r) => movedAway.has(r.from)).map((r) => r.to));
  const fresh = moved.size ? delta.newUnusedExports.filter((u) => !moved.has(u.file)) : delta.newUnusedExports;
  const byFile = groupBy(fresh, (u) => u.file);
  // Many files at once (an agent's sweeping edit): one event instead of a line per file.
  if (byFile.size > UNUSED_GROUP_FILES) {
    const all = [...fresh].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
    return [
      {
        event: {
          kind: 'unused-export',
          severity: 'info',
          message: `${plural(all.length, 'new export')} in ${plural(byFile.size, 'file')} that nothing imports`,
          detail: all.slice(0, 8).map((u) => exportName(u)).join(', ') + (all.length > 8 ? ', …' : ''),
          files: [...byFile.keys()].sort().slice(0, 20),
          fingerprint: fingerprint(RULE_IDS.unusedExport, '', all.map((u) => `${u.file}#${u.name}`).join(',')),
        },
      },
    ];
  }
  return [...byFile].map(([file, list]): LiveCandidate => {
    const names = list.map((u) => u.name).sort();
    const one = list.length === 1;
    return {
      event: {
        kind: 'unused-export',
        severity: 'info',
        message: one ? `${exportName({ name: names[0], file })} is exported but nothing imports it` : `${plural(list.length, 'export')} of ${file} are not imported anywhere`,
        detail: one ? undefined : names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : ''),
        files: [file],
        line: list[0].line,
        fingerprint: one ? unusedExportFingerprint(file, names[0]) : fingerprint(RULE_IDS.unusedExport, file, names.join(',')),
      },
    };
  });
};

/* ---------------------------------- Health --------------------------------- */

const unresolvedImports = (r: ReportData): number => r.files.reduce((n, f) => n + f.unresolved.length, 0);

/**
 * Health on shared categories (`delta.health`): a category only one side has counts as unchanged, so
 * comparing with a git-less what-if analysis does not report a drop. Not while imports break or get
 * repaired (a moved file, a half-typed path): a broken import "removes" a cycle and its score with it.
 */
const health: LiveDetector = ({ prev, next, delta, broken }) => {
  const { before, after } = delta.health;
  if (Math.abs(after - before) < 1 || broken.length || unresolvedImports(prev) !== unresolvedImports(next)) return [];
  const meta = new Map(next.health.categories.map((c) => [c.id, c]));
  const weight = (c: { id: string; before: number; after: number }): number => Math.abs(c.after - c.before) * (meta.get(c.id)?.weight ?? 1);
  const moved = delta.health.categories
    .filter((c) => meta.has(c.id))
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, 2)
    .map((c) => `${meta.get(c.id)!.label} ${c.before} → ${c.after}`);
  return [
    {
      event: {
        kind: 'health',
        severity: after < before ? 'warning' : 'success',
        message: `health ${before} → ${after}`,
        detail: moved.length ? moved.join(', ') : undefined,
        files: [],
        fingerprint: fingerprint('cv/health', '', ''),
        before,
        after,
      },
    },
  ];
};

/** Detectors in the order their events are listed (worst kinds first); health always closes the list. */
export const LIVE_DETECTORS: LiveDetector[] = [configuration, cycles, rules, dependencies, exportsDetector, routes, complexity, untested, unusedExports];
// --- clone-radar: "this already exists: import it instead" ---
LIVE_DETECTORS.push(cloneDetector);

/**
 * When the configuration becomes unreadable or readable again, what is analyzed changes with it
 * (excluded files, rules): only these detectors compare across such a step.
 */
const ACROSS_CONFIG_CHANGES = new Set<LiveDetector>([configuration, rules]);

/* ---------------------------------- Guard ---------------------------------- */

/** Files whose content changed between two analyses: reported ones, added, deleted, or with another size. */
export function touchedFiles(prev: ReportData, next: ReportData, changed: Iterable<string>): Set<string> {
  const before = fileMap(prev);
  const after = fileMap(next);
  const touched = new Set<string>();
  for (const id of changed) if (after.has(id) || before.has(id)) touched.add(id);
  for (const f of next.files) {
    const b = before.get(f.id);
    if (!b || b.bytes !== f.bytes || b.loc !== f.loc) touched.add(f.id);
  }
  for (const id of before.keys()) if (!after.has(id)) touched.add(id);
  return touched;
}

/** Every candidate event of one step, before the session state (suppression) is applied. */
export function liveCandidates(
  prev: ReportData,
  next: ReportData,
  changed: Iterable<string>,
  config?: CodeVisualizerConfig,
  memory: { knownViolations?: ReadonlySet<string> } = {},
): LiveCandidate[] {
  const touched = touchedFiles(prev, next, changed);
  // Exports and complexity matter for the changed files only, and areas not at all: that keeps it cheap.
  // Complexity is judged with the limit `check` uses, so a function the gate accepts is not a warning here.
  const delta = compareReports(prev, next, { config, changedFiles: touched, areas: false, complexityThreshold: complexityLimit(config) });
  const ctx: LiveContext = { prev, next, delta, touched, config, broken: brokenImports(prev, next), knownViolations: memory.knownViolations };
  const scopeChanged = !!prev.config?.error !== !!next.config?.error;
  const detectors = scopeChanged ? LIVE_DETECTORS.filter((d) => ACROSS_CONFIG_CHANGES.has(d)) : LIVE_DETECTORS;
  return [...detectors.flatMap((detect) => detect(ctx)), ...(scopeChanged ? [] : health(ctx))];
}

export interface LiveGuardOptions {
  /** Kinds never announced (added to `serve.events.exclude` from the configuration). */
  exclude?: LiveEventKind[];
  /** Events kept in the feed (default 200). */
  historySize?: number;
  /** At most this many events per update besides health (default 20); the rest are summed up in one more. */
  maxEvents?: number;
  now?: () => number;
}

export interface LiveUpdateOptions {
  /** The configuration of `next`: rules are re-judged with it, and `serve.events.exclude` applies. */
  config?: CodeVisualizerConfig;
  /** Analysis version, stored on the events. */
  version?: number;
}

interface OpenProblem {
  candidate: LiveCandidate;
  event: LiveEvent;
}

const safely = <T>(check: () => T, fallback: T): T => {
  try {
    return check();
  } catch {
    return fallback;
  }
};

const violationFingerprints = (report: ReportData): Set<string> => new Set(report.insights.ruleViolations.map(violationFingerprint));

/**
 * The problems a piece of work already has against its base (its `changes.delta`) for a guard that starts
 * on it: new cycles, broken rules, removed exports still imported and signature changes whose calls were
 * not updated — what the Architecture changes card lists as breaking.
 */
function seedCandidates(data: ReportData, delta: ArchitectureDelta): LiveCandidate[] {
  const result: LiveCandidate[] = [];
  for (const cycle of delta.newCycles) {
    const members = unique(cycle);
    const edge = data.edges.find((e) => e.source === cycle[0] && e.target === cycle[1 % cycle.length]);
    result.push({
      event: { kind: 'cycle-added', severity: 'error', message: `new cycle: ${cyclePath(cycle)}`, files: members, line: edge?.line, fingerprint: cycleFingerprint(cycle) },
      stillOpen: cycleStillThere(members),
      supersedes: cycleOverlaps(members),
    });
  }
  result.push(...delta.newViolations.map(violationCandidate));
  const exists = new Set(data.files.map((f) => f.id));
  for (const e of delta.exports) {
    if (!e.breaking || !exists.has(e.file)) continue;
    const c = e.change === 'removed' ? removedExportCandidate(e, data) : e.staleCallSites.length ? changedExportCandidate(e, data) : undefined;
    if (c?.stillOpen) result.push(c);
  }
  return result;
}

/**
 * The session state of the live feed: problems already announced (by fingerprint) stay quiet until
 * they are fixed, which is then announced; the last `historySize` events are kept for the feed.
 */
export class LiveGuard {
  private readonly open = new Map<string, OpenProblem>();
  /** Problems that closed silently but are announced again when they come back (`revive`). */
  private readonly dormant = new Map<string, OpenProblem>();
  /** Fixes held back until they are certain (`hold`), with the open problem they would close. */
  private readonly held = new Map<string, { candidate: LiveCandidate; reopen?: OpenProblem }>();
  /** What tracked changes (`track`) looked like when this session first saw them change. */
  private readonly tracked = new Map<string, string>();
  private knownViolations?: Set<string>;
  private readonly history: LiveEvent[] = [];
  private readonly session = Date.now().toString(36);
  private seq = 0;

  constructor(private readonly options: LiveGuardOptions = {}) {}

  private excluded(opts: LiveUpdateOptions): Set<LiveEventKind> {
    return new Set<LiveEventKind>([...(this.options.exclude ?? []), ...(opts.config?.serve?.events?.exclude ?? [])]);
  }

  private eventMaker(opts: LiveUpdateOptions): (draft: LiveEventDraft) => LiveEvent {
    const now = this.options.now?.() ?? Date.now();
    return (draft) => ({ id: `${this.session}-${++this.seq}`, at: now, ...draft, ...(opts.version !== undefined ? { version: opts.version } : {}) });
  }

  /**
   * Start on a piece of work that already breaks something: the problems of the first analysis's
   * `changes.delta` (new cycles, broken rules, removed exports still imported, signature changes with calls
   * not updated) are open from the start — silently, no events — so the feed agrees with the
   * Architecture changes card, and their fixes are announced like any other.
   */
  seed(data: ReportData, opts: LiveUpdateOptions = {}): void {
    if (!data.config?.error) this.knownViolations = violationFingerprints(data);
    const delta = data.changes?.delta;
    if (!delta) return;
    const exclude = this.excluded(opts);
    const toEvent = this.eventMaker(opts);
    for (const c of seedCandidates(data, delta)) {
      const fp = c.event.fingerprint;
      if (!c.stillOpen || exclude.has(c.event.kind) || this.open.has(fp)) continue;
      // Undoing the change later is "restored", as if this session had seen it happen.
      if (c.track && !this.tracked.has(c.track.key)) this.tracked.set(c.track.key, c.track.from);
      this.open.set(fp, { candidate: c, event: toEvent(c.event) });
    }
  }

  /** Events for the step from `prev` to `next` (`changed`: paths reported by the watcher). */
  update(prev: ReportData, next: ReportData, changed: Iterable<string> = [], opts: LiveUpdateOptions = {}): LiveEvent[] {
    const exclude = this.excluded(opts);
    const toEvent = this.eventMaker(opts);
    const drafts: LiveEventDraft[] = [];
    const seen = new Set<string>();
    const opened: [string, LiveCandidate][] = [];
    if (!this.knownViolations && !prev.config?.error) this.knownViolations = violationFingerprints(prev);

    for (const found of liveCandidates(prev, next, changed, opts.config, { knownViolations: this.knownViolations })) {
      // An undone change (a signature changed back) is a fix, not another change.
      const c = found.track ? this.trackChange(found) : found;
      const fp = c.event.fingerprint;
      if (c.stillOpen && this.returned(c, fp, seen)) continue;
      if (exclude.has(c.event.kind)) continue;
      if (c.stillOpen) {
        seen.add(fp);
        const known = this.open.get(fp);
        if (known) {
          known.candidate = c; // keep the latest checks
          if (!c.repeat?.(known.event)) continue;
        }
        opened.push([fp, c]);
        drafts.push(c.event);
      } else if (c.event.severity === 'success') {
        seen.add(fp);
        if (c.hold && safely(() => c.hold!.while(next), false)) {
          // Not fixed for sure yet: say it once it is (or say nothing when it comes back).
          this.held.set(fp, { candidate: c, reopen: this.open.get(fp) });
          trim(this.held);
          this.open.delete(fp);
          continue;
        }
        // A fix closes the problem it fixes (announced in this session or not).
        this.open.delete(fp);
        this.dormant.delete(fp);
        drafts.push(c.event);
      } else {
        drafts.push(c.event);
      }
    }
    // Held fixes whose broken imports were resolved without the problem coming back: fixed after all.
    for (const [fp, h] of this.held) {
      if (seen.has(fp) || safely(() => h.candidate.hold!.while(next), false)) continue;
      this.held.delete(fp);
      if (!exclude.has(h.candidate.event.kind)) drafts.push(h.candidate.event);
    }
    // Problems that closed silently and are back (a rule put back into the configuration).
    for (const [fp, entry] of this.dormant) {
      if (seen.has(fp) || this.open.has(fp)) {
        this.dormant.delete(fp);
        continue;
      }
      if (!safely(() => entry.candidate.revive!(next), false)) continue;
      this.dormant.delete(fp);
      if (exclude.has(entry.candidate.event.kind)) continue;
      seen.add(fp);
      opened.push([fp, entry.candidate]);
      drafts.push(entry.candidate.event);
    }
    // Open problems that went away without a fix event of their own (a test now reaches the file…).
    for (const [fp, entry] of this.open) {
      if (seen.has(fp)) continue;
      if (!safely(() => !entry.candidate.stillOpen!(next), true)) continue;
      this.open.delete(fp);
      const fix = safely(() => entry.candidate.resolved?.(next), undefined);
      if (fix) {
        if (!exclude.has(fix.kind)) drafts.push(fix);
      } else if (entry.candidate.revive) {
        this.dormant.set(fp, entry);
        trim(this.dormant);
      }
    }

    const events = this.limit(drafts).map(toEvent);
    for (const [fp, candidate] of opened) {
      // A cycle that grew replaces the open one it grew from.
      if (candidate.supersedes) for (const [other, entry] of this.open) if (other !== fp && candidate.supersedes(entry.event)) this.open.delete(other);
      const event = events.find((e) => e.fingerprint === fp && e.kind === candidate.event.kind);
      this.open.set(fp, { candidate, event: event ?? toEvent(candidate.event) });
    }
    // Open problems say what is true now (one of two stale calls fixed: "1 call site not updated").
    for (const entry of this.open.values()) {
      const now = safely(() => entry.candidate.refresh?.(next), undefined);
      if (now && now.message !== entry.event.message) entry.event = { ...entry.event, ...now };
    }
    if (!next.config?.error) this.knownViolations = violationFingerprints(next);
    this.history.push(...events);
    const size = this.options.historySize ?? 200;
    if (this.history.length > size) this.history.splice(0, this.history.length - size);
    return events;
  }

  /** A held problem that came back (a cycle once its importers point at the moved file): old news, not a new problem. */
  private returned(c: LiveCandidate, fp: string, seen: Set<string>): boolean {
    for (const [heldFp, h] of this.held) {
      if (!safely(() => h.candidate.hold!.returns(c.event), false)) continue;
      this.held.delete(heldFp);
      seen.add(fp);
      // It was open in this session: it is open again, under its new identity.
      if (h.reopen) this.open.set(fp, { candidate: c, event: h.reopen.event });
      return true;
    }
    return false;
  }

  /** Changes back to what this session first saw become a "restored" fix. */
  private trackChange(c: LiveCandidate): LiveCandidate {
    const { key, from, to, restored } = c.track!;
    const first = this.tracked.get(key);
    if (first === undefined) {
      this.tracked.set(key, from);
      trim(this.tracked);
      return c;
    }
    if (first !== to) return c;
    this.tracked.delete(key);
    return { event: restored };
  }

  /** Worst first (stable), health last, at most `maxEvents` plus a summary of the rest. */
  private limit(drafts: LiveEventDraft[]): LiveEventDraft[] {
    const max = this.options.maxEvents ?? 20;
    const sorted = drafts
      .map((d, i) => ({ d, i }))
      .sort((a, b) => Number(a.d.kind === 'health') - Number(b.d.kind === 'health') || severityRank(a.d.severity) - severityRank(b.d.severity) || a.i - b.i)
      .map((x) => x.d);
    const healthEvents = sorted.filter((d) => d.kind === 'health');
    const rest = sorted.filter((d) => d.kind !== 'health');
    if (rest.length <= max) return sorted;
    const dropped = rest.slice(max - 1);
    const summary: LiveEventDraft = {
      kind: dropped[0].kind,
      severity: 'info',
      message: `… and ${plural(dropped.length, 'more change')} (see the report)`,
      files: unique(dropped.flatMap((d) => d.files)).slice(0, 20),
      fingerprint: fingerprint('cv/live-more', '', dropped.map((d) => d.fingerprint).join(',')),
    };
    return [...rest.slice(0, max - 1), summary, ...healthEvents];
  }

  /** This session's events (oldest first) and the problems still open. */
  feed(version = 0): LiveFeed {
    return { version, events: [...this.history], open: this.openProblems() };
  }

  /** Problems announced in this session that are still there, oldest first. */
  openProblems(): LiveEvent[] {
    return [...this.open.values()].map((o) => o.event);
  }
}

/**
 * What got worse or better from `prev` to `next`, with no session state: `changed` are the paths
 * reported as edited (complexity, signature and untested-file events are limited to changed files).
 */
export function diffLive(prev: ReportData, next: ReportData, changed: Iterable<string> = [], options: LiveGuardOptions & LiveUpdateOptions = {}): LiveEvent[] {
  return new LiveGuard(options).update(prev, next, changed, options);
}
