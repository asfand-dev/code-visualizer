/**
 * Real test coverage from the reports your test runner already writes: istanbul JSON
 * (`coverage/coverage-final.json`, Jest and Vitest) and lcov (`coverage/lcov.info`). No dependencies and
 * no instrumentation of our own — the analysis only reads the newest report of the project root and of
 * each workspace package, maps its paths onto the analyzed files and derives:
 *
 * - per-file line coverage (`FileInfo.coverage`) and the project's line coverage (`Stats.lineCoverage`),
 * - patch coverage: which of the lines your change added a test executed (`ChangeSet.coverage`),
 * - the `patch-coverage` quality gate (`check --min-patch-coverage`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fingerprint, RULE_IDS } from '../shared/fingerprint.js';
import { formatRanges } from '../shared/coverage.js';
import { isE2eTest, isTestableSource, isTestEntry, type TestRunners } from '../shared/testcmd.js';
import type { ChangedFile, CoverageSummary, FileCoverage, Finding, LastTestState, PatchCoverage, PatchCoverageFile, ReportData } from '../shared/types.js';
import type { GateProvider, Thresholds } from './gates.js';
import { readState } from './state.js';

export type CoverageSource = 'lcov' | 'istanbul';

/** Hits per line of one file, plus function and branch totals when the report has them. */
export interface RawFileCoverage {
  lines: Map<number, number>;
  functions?: { total: number; covered: number };
  branches?: { total: number; covered: number };
}

/** A parsed report: file paths exactly as the report names them → coverage. */
export interface ParsedReport {
  source: CoverageSource;
  files: Map<string, RawFileCoverage>;
}

/** Report file names, in the order they are preferred when equally new. */
export const REPORT_NAMES: { name: string; source: CoverageSource }[] = [
  { name: 'coverage-final.json', source: 'istanbul' },
  { name: 'lcov.info', source: 'lcov' },
];

/** Reports larger than this are skipped (parsing them would cost more than the analysis). */
const MAX_REPORT_BYTES = 200 * 1024 * 1024;
/** `FileCoverage.uncovered` keeps at most this many lines. */
const MAX_UNCOVERED = 2000;

/* -------------------------------------------------------------------------- */
/*                                   Parsers                                  */
/* -------------------------------------------------------------------------- */

function mergeLine(lines: Map<number, number>, line: number, hits: number): void {
  if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits)) return;
  const prev = lines.get(line);
  if (prev === undefined || hits > prev) lines.set(line, hits);
}

/**
 * lcov tracefiles (`SF:` … `end_of_record`): `DA:<line>,<hits>` line hits, `FNF`/`FNH` and `BRF`/`BRH`
 * totals. Unknown records (TN, FN, FNDA, BRDA, LF, LH, checksums) are ignored.
 */
export function parseLcov(text: string): ParsedReport {
  const files = new Map<string, RawFileCoverage>();
  let current: RawFileCoverage | undefined;
  let fnf: number | undefined;
  let fnh: number | undefined;
  let brf: number | undefined;
  let brh: number | undefined;
  const close = (): void => {
    if (current) {
      if (fnf !== undefined) current.functions = { total: fnf, covered: Math.min(fnf, fnh ?? 0) };
      if (brf !== undefined) current.branches = { total: brf, covered: Math.min(brf, brh ?? 0) };
    }
    current = undefined;
    fnf = fnh = brf = brh = undefined;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    const tag = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1);
    if (tag === 'SF') {
      close();
      const name = value.trim();
      // The same file twice (several test runs in one tracefile): merge into one entry.
      current = files.get(name) ?? { lines: new Map() };
      files.set(name, current);
    } else if (tag === 'end_of_record') close();
    else if (!current) continue;
    else if (tag === 'DA') {
      const [l, hits] = value.split(',');
      mergeLine(current.lines, Number(l), Number(hits));
    } else if (tag === 'FNF') fnf = Number(value) || 0;
    else if (tag === 'FNH') fnh = Number(value) || 0;
    else if (tag === 'BRF') brf = Number(value) || 0;
    else if (tag === 'BRH') brh = Number(value) || 0;
  }
  close();
  return { source: 'lcov', files };
}

interface IstanbulLocation {
  start?: { line?: number };
}

interface IstanbulFile {
  path?: string;
  statementMap?: Record<string, IstanbulLocation>;
  s?: Record<string, number>;
  fnMap?: Record<string, unknown>;
  f?: Record<string, number>;
  branchMap?: Record<string, unknown>;
  b?: Record<string, number[]>;
  /** Older istanbul versions wrap the file coverage. */
  data?: IstanbulFile;
}

/**
 * Istanbul JSON (`coverage-final.json`): a line's hits are the most any statement starting on it got
 * (istanbul's own getLineCoverage); functions from `fnMap`/`f`, branches from `branchMap`/`b`.
 */
export function parseIstanbul(json: unknown): ParsedReport {
  const files = new Map<string, RawFileCoverage>();
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { source: 'istanbul', files };
  for (const [key, value] of Object.entries(json as Record<string, IstanbulFile>)) {
    const entry = value?.data && typeof value.data === 'object' ? value.data : value;
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.path === 'string' && entry.path ? entry.path : key;
    const lines = new Map<number, number>();
    const statements = entry.statementMap ?? {};
    for (const [id, hits] of Object.entries(entry.s ?? {})) {
      const line = statements[id]?.start?.line;
      if (line !== undefined) mergeLine(lines, line, Number(hits));
    }
    const coverage: RawFileCoverage = { lines };
    const fnHits = Object.values(entry.f ?? {});
    if (entry.fnMap) coverage.functions = { total: Object.keys(entry.fnMap).length, covered: fnHits.filter((h) => Number(h) > 0).length };
    if (entry.branchMap) {
      const arms = Object.values(entry.b ?? {}).flatMap((counts) => (Array.isArray(counts) ? counts : []));
      coverage.branches = { total: arms.length, covered: arms.filter((h) => Number(h) > 0).length };
    }
    const prev = files.get(name);
    files.set(name, prev ? mergeFile(prev, coverage) : coverage);
  }
  return { source: 'istanbul', files };
}

/** Two reports of the same file: the most hits per line, the better function and branch numbers. */
export function mergeFile(a: RawFileCoverage, b: RawFileCoverage): RawFileCoverage {
  const lines = new Map(a.lines);
  for (const [line, hits] of b.lines) mergeLine(lines, line, hits);
  const best = (x?: { total: number; covered: number }, y?: { total: number; covered: number }) =>
    !x ? y : !y ? x : { total: Math.max(x.total, y.total), covered: Math.max(x.covered, y.covered) };
  const merged: RawFileCoverage = { lines };
  const functions = best(a.functions, b.functions);
  const branches = best(a.branches, b.branches);
  if (functions) merged.functions = functions;
  if (branches) merged.branches = branches;
  return merged;
}

/** Parse a report by its content: istanbul JSON starts with `{`, everything else is lcov. */
export function parseReport(text: string): ParsedReport {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{')) return parseIstanbul(JSON.parse(trimmed) as unknown);
  return parseLcov(trimmed);
}

/* -------------------------------------------------------------------------- */
/*                                    Paths                                   */
/* -------------------------------------------------------------------------- */

const toSlashes = (p: string): string => p.replace(/\\/g, '/');
const isAbsoluteAny = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Maps report paths onto analyzed file ids: absolute paths inside the root (also through its real path,
 * e.g. /private/var on macOS), paths relative to the report's package or to the root, and — for reports
 * written on another machine (CI) or OS — the longest path suffix that is an analyzed file. A path that
 * names a file inside the root which is not analyzed (an excluded example app, a fixture) maps to nothing:
 * borrowing the coverage of a same-named analyzed file would be wrong.
 */
export class CoveragePathMapper {
  private readonly roots: string[];
  private readonly ids: Set<string>;
  private readonly topLevel = new Map<string, boolean>();

  constructor(
    root: string,
    ids: Iterable<string>,
    /** Whether a project-relative path exists on disk (default: the file system under `root`). */
    private readonly exists: (rel: string) => boolean = (rel) => fs.existsSync(path.join(root, rel)),
  ) {
    const variants = [root, realpath(root)].map((r) => toSlashes(r).replace(/\/+$/, ''));
    this.roots = [...new Set(variants)];
    this.ids = new Set(ids);
  }

  /** The analyzed file id a report path stands for (`base`: project-relative folder relative paths start from). */
  toId(reportPath: string, base = ''): string | undefined {
    let p = toSlashes(reportPath.trim());
    if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7)).replace(/^\/([A-Za-z]:\/)/, '$1');
    if (!p || /(^|\/)node_modules\//.test(p)) return undefined;
    if (isAbsoluteAny(p)) {
      for (const root of this.roots) {
        const windows = /^[A-Za-z]:\//.test(root);
        const inside = windows ? p.toLowerCase().startsWith(`${root.toLowerCase()}/`) : p.startsWith(`${root}/`);
        // Inside the root: the file itself, or nothing (never another file with the same suffix).
        if (inside) return this.known(p.slice(root.length + 1));
      }
      return this.bySuffix(p);
    }
    const relative = path.posix.normalize(base ? `${base}/${p}` : p).replace(/^(\.\/)+/, '');
    if (this.ids.has(relative)) return relative;
    const fromRoot = path.posix.normalize(p).replace(/^(\.\/)+/, '');
    if (this.ids.has(fromRoot)) return fromRoot;
    // Relative to a folder above the root (the repository when a sub-folder is analyzed): `packages/web/src/a.ts`.
    const parts = fromRoot.split('/');
    for (let i = 1; i < parts.length; i++) {
      const rest = parts.slice(i).join('/');
      if (this.ids.has(rest) && this.roots.some((r) => r.endsWith(`/${parts.slice(0, i).join('/')}`))) return rest;
    }
    return undefined;
  }

  private lowerIds?: Map<string, string>;

  private known(rel: string): string | undefined {
    if (this.ids.has(rel)) return rel;
    // Case-insensitive file systems (Windows, macOS) may report another spelling.
    this.lowerIds ??= new Map([...this.ids].map((id) => [id.toLowerCase(), id]));
    return this.lowerIds.get(rel.toLowerCase());
  }

  /**
   * `/home/runner/work/app/app/src/a.ts` → `src/a.ts` (the longest suffix that is an analyzed file). A
   * longer suffix that exists in the root but is not analyzed stops the search: `<ci>/examples/demo/src/a.ts`
   * is the excluded demo's file, not `src/a.ts`.
   */
  private bySuffix(p: string): string | undefined {
    const parts = p.split('/').filter((x) => x && x !== '.' && !/^[A-Za-z]:$/.test(x));
    for (let i = 1; i < parts.length; i++) {
      const candidate = parts.slice(i).join('/');
      if (this.ids.has(candidate)) return candidate;
      if (i < parts.length - 1 && this.inRoot(parts[i]) && this.exists(candidate)) return undefined;
    }
    return undefined;
  }

  /** Whether the root has a top-level entry of this name (cached: one stat per name, not per report path). */
  private inRoot(name: string): boolean {
    let known = this.topLevel.get(name);
    if (known === undefined) this.topLevel.set(name, (known = this.exists(name)));
    return known;
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Loading                                  */
/* -------------------------------------------------------------------------- */

/** A report found on disk. */
export interface ReportFile {
  abs: string;
  /** Project-relative path (posix). */
  file: string;
  source: CoverageSource;
  mtimeMs: number;
  size: number;
  /** Project-relative folder its relative paths start from ('' = the root). */
  base: string;
  /** The package it describes: the deepest workspace package (or the root, '') that contains it. */
  scope: string;
}

/** Coverage of one analyzed file, merged over all reports. */
export interface FileCoverageData extends RawFileCoverage {
  source: CoverageSource;
  /** mtime of the newest report with data for the file. */
  reportMtime: number;
  /** Project-relative path of that report. */
  report: string;
}

export interface LoadedCoverage {
  reports: (ReportFile & { files: number })[];
  /** Analyzed file id → coverage. */
  files: Map<string, FileCoverageData>;
  /**
   * Project-relative folders the reports describe ('' = everything): a source file in one of them that
   * the reports do not mention was not loaded by any test.
   */
  scopes: { base: string; mtimeMs: number; report: string }[];
  warnings: string[];
}

export interface CoverageOptions {
  /** Workspace package folders (project-relative); the root is always looked at. */
  dirs?: string[];
  /** Report files or folders (absolute, or relative to the root) instead of the auto-detected ones. */
  paths?: string[];
  /** Analyzed file ids (report paths are mapped onto them; everything else is ignored). */
  ids: Iterable<string>;
}

function statFile(abs: string): fs.Stats | undefined {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st : undefined;
  } catch {
    return undefined;
  }
}

function sourceOf(abs: string): CoverageSource {
  return /\.json$/i.test(abs) ? 'istanbul' : 'lcov';
}

/** The folder a report's relative paths start from: the parent of a `coverage/` folder, else its own folder. */
function baseOf(root: string, abs: string): string {
  let dir = path.dirname(abs);
  if (path.basename(dir) === 'coverage') dir = path.dirname(dir);
  const rel = toSlashes(path.relative(root, dir));
  return rel === '' || rel.startsWith('..') || isAbsoluteAny(rel) ? '' : rel;
}

/** The package a folder belongs to: the deepest of `dirs` that contains it, else the root (''). */
function packageOf(dir: string, dirs: string[]): string {
  return dirs.filter((d) => d && (dir === d || dir.startsWith(`${d}/`))).sort((a, b) => b.length - a.length)[0] ?? '';
}

function reportFile(root: string, abs: string, st: fs.Stats, dirs: string[]): ReportFile {
  const rel = toSlashes(path.relative(root, abs));
  const base = baseOf(root, abs);
  return { abs, file: rel.startsWith('..') || isAbsoluteAny(rel) ? toSlashes(abs) : rel, source: sourceOf(abs), mtimeMs: st.mtimeMs, size: st.size, base, scope: packageOf(base, dirs) };
}

/** The newest report in a folder (istanbul JSON when both are equally new). */
function newestIn(root: string, dir: string, dirs: string[]): ReportFile | undefined {
  let best: ReportFile | undefined;
  for (const { name } of REPORT_NAMES) {
    const abs = path.join(dir, name);
    const st = statFile(abs);
    if (st && (!best || st.mtimeMs > best.mtimeMs)) best = reportFile(root, abs, st, dirs);
  }
  return best;
}

/** Where coverage reports are looked for: `<dir>/coverage/<name>` for the root and every workspace package. */
export function coverageCandidates(root: string, options: Pick<CoverageOptions, 'dirs' | 'paths'> = {}): string[] {
  if (options.paths?.length) {
    return options.paths.flatMap((p) => {
      const abs = path.resolve(root, p);
      const st = (() => {
        try {
          return fs.statSync(abs);
        } catch {
          return undefined;
        }
      })();
      return st?.isDirectory() ? REPORT_NAMES.flatMap(({ name }) => [path.join(abs, name), path.join(abs, 'coverage', name)]) : [abs];
    });
  }
  const dirs = [...new Set(['', ...(options.dirs ?? [])])];
  return dirs.flatMap((d) => REPORT_NAMES.map(({ name }) => path.join(root, d, 'coverage', name)));
}

/** The reports to read: the explicit paths, or the newest report of the root and of each workspace package. */
export function findReports(root: string, options: Pick<CoverageOptions, 'dirs' | 'paths'> = {}): ReportFile[] {
  const found: ReportFile[] = [];
  const dirs = options.dirs ?? [];
  if (options.paths?.length) {
    for (const p of options.paths) {
      const abs = path.resolve(root, p);
      const st = (() => {
        try {
          return fs.statSync(abs);
        } catch {
          return undefined;
        }
      })();
      if (!st) continue;
      if (st.isFile()) found.push(reportFile(root, abs, st, dirs));
      else if (st.isDirectory()) {
        const report = newestIn(root, abs, dirs) ?? newestIn(root, path.join(abs, 'coverage'), dirs);
        if (report) found.push(report);
      }
    }
  } else {
    for (const dir of [...new Set(['', ...dirs])]) {
      const report = newestIn(root, path.join(root, dir, 'coverage'), dirs);
      if (report) found.push(report);
    }
  }
  const seen = new Set<string>();
  return found.filter((r) => !seen.has(r.abs) && seen.add(r.abs));
}

/** Report files or folders in `paths` (absolute, or relative to the root) that do not exist, as given. */
export function missingReports(root: string, paths: string[] | undefined): string[] {
  return (paths ?? []).filter((p) => !fs.existsSync(path.resolve(root, p)));
}

/** Parsed reports by path, reused while the file is unchanged (a live server re-analyzes often). */
const PARSED = new Map<string, { mtimeMs: number; size: number; report: ParsedReport }>();
const PARSED_LIMIT = 16;

function readReport(report: ReportFile): ParsedReport {
  const cached = PARSED.get(report.abs);
  if (cached && cached.mtimeMs === report.mtimeMs && cached.size === report.size) return cached.report;
  const parsed = parseReport(fs.readFileSync(report.abs, 'utf8'));
  PARSED.delete(report.abs);
  PARSED.set(report.abs, { mtimeMs: report.mtimeMs, size: report.size, report: parsed });
  while (PARSED.size > PARSED_LIMIT) PARSED.delete(PARSED.keys().next().value!);
  return parsed;
}

/**
 * Read the project's coverage reports and map them onto the analyzed files (undefined when there is
 * no report). Several reports (one per package, or lcov and istanbul for the same run) are merged by
 * the most hits per line.
 */
export function loadCoverage(root: string, options: CoverageOptions): LoadedCoverage | undefined {
  const reports = findReports(root, options);
  // Named reports that are not there: say so (a moved CI artifact must not look like "no coverage").
  const warnings = missingReports(root, options.paths).map((p) => `No coverage report at ${p}.`);
  const files = new Map<string, FileCoverageData>();
  if (!reports.length) return warnings.length ? { reports: [], files, scopes: [], warnings } : undefined;
  const mapper = new CoveragePathMapper(root, options.ids);
  const loaded: LoadedCoverage['reports'] = [];
  for (const report of reports) {
    if (report.size > MAX_REPORT_BYTES) {
      warnings.push(`Skipped the coverage report ${report.file} (larger than ${MAX_REPORT_BYTES / 1024 / 1024} MB).`);
      continue;
    }
    let parsed: ParsedReport;
    try {
      parsed = readReport(report);
    } catch (error) {
      // A report being written right now (a watch run) is read again on the next analysis.
      warnings.push(`Could not read the coverage report ${report.file}: ${(error as Error).message}`);
      continue;
    }
    let count = 0;
    for (const [name, data] of parsed.files) {
      const id = mapper.toId(name, report.base);
      if (!id) continue;
      count++;
      const prev = files.get(id);
      const merged = prev ? mergeFile(prev, data) : data;
      const newer = !prev || report.mtimeMs >= prev.reportMtime;
      files.set(id, { ...merged, source: newer ? parsed.source : prev!.source, reportMtime: newer ? report.mtimeMs : prev!.reportMtime, report: newer ? report.file : prev!.report });
    }
    loaded.push({ ...report, files: count });
  }
  if (!loaded.length) return warnings.length ? { reports: [], files, scopes: [], warnings } : undefined;
  return { reports: loaded, files, scopes: loaded.map((r) => ({ base: r.scope, mtimeMs: r.mtimeMs, report: r.file })), warnings };
}

/** The report scope a file belongs to (the deepest one), or undefined when no report describes its folder. */
export function scopeOf(coverage: Pick<LoadedCoverage, 'scopes'>, id: string): LoadedCoverage['scopes'][number] | undefined {
  return coverage.scopes.filter((s) => !s.base || id.startsWith(`${s.base}/`)).sort((a, b) => b.base.length - a.base.length || b.mtimeMs - a.mtimeMs)[0];
}

/**
 * Package folders whose unit tests no report describes ('' = the root): line coverage from the other
 * packages' reports must not pass for the whole project's. e2e specs are left out (they rarely write
 * line coverage of the app).
 */
export function unmeasuredPackages(coverage: Pick<LoadedCoverage, 'scopes'>, testFiles: string[], runners: TestRunners, workspaces: string[]): string[] {
  const out = new Set<string>();
  for (const t of testFiles) {
    if (!isTestEntry(t, runners) || isE2eTest(t, runners) || scopeOf(coverage, t)) continue;
    out.add(packageOf(path.posix.dirname(t), workspaces));
  }
  return [...out].sort();
}

/** `FileInfo.coverage` of one file (`mtimeMs`: the file's own mtime, to tell a stale report). */
export function fileCoverage(data: FileCoverageData, mtimeMs?: number): FileCoverage {
  let covered = 0;
  const uncovered: number[] = [];
  for (const [line, hits] of data.lines) {
    if (hits > 0) covered++;
    else uncovered.push(line);
  }
  uncovered.sort((a, b) => a - b);
  const result: FileCoverage = { lines: { total: data.lines.size, covered }, uncovered: uncovered.slice(0, MAX_UNCOVERED), source: data.source };
  if (data.functions) result.functions = data.functions;
  if (data.branches) result.branches = data.branches;
  if (mtimeMs !== undefined && mtimeMs > data.reportMtime) result.stale = true;
  return result;
}

/**
 * Whether the newest report came from a `code-visualizer test --coverage` run of only the affected tests
 * (`lastTest` in `.code-visualizer/state.json`): its numbers are right for the changed code, not for the project.
 */
export function isPartialRun(root: string, coverage: Pick<LoadedCoverage, 'reports'>): boolean {
  let last: LastTestState | undefined;
  try {
    last = readState<LastTestState>(root, 'lastTest');
  } catch {
    return false;
  }
  if (!last?.coverage || last.full || typeof last.at !== 'number') return false;
  const newest = Math.max(0, ...coverage.reports.map((r) => r.mtimeMs));
  const started = last.at - (last.durationMs ?? 0) - 2000;
  return newest >= started && newest <= last.at + 2000;
}

/** `ReportData.coverage`: the reports and the project's line coverage over the analyzed source files. */
export function coverageSummary(coverage: LoadedCoverage, perFile: Map<string, FileCoverage>, isSource: (id: string) => boolean, partial: boolean): CoverageSummary {
  let total = 0;
  let covered = 0;
  let files = 0;
  let stale = false;
  for (const [id, c] of perFile) {
    if (!isSource(id)) continue;
    files++;
    total += c.lines.total;
    covered += c.lines.covered;
    if (c.stale) stale = true;
  }
  const summary: CoverageSummary = {
    reports: coverage.reports.map((r) => ({ file: r.file, source: r.source, date: Math.round(r.mtimeMs), files: r.files })),
    lines: { total, covered },
    pct: total ? Math.round((covered / total) * 1000) / 1000 : 0,
    files,
  };
  if (stale) summary.stale = true;
  if (partial) summary.partial = true;
  return summary;
}

/* -------------------------------------------------------------------------- */
/*                               Patch coverage                               */
/* -------------------------------------------------------------------------- */

export interface PatchCoverageOptions {
  /** Source files whose changed lines count (not tests, stories, configs, scripts or declarations). */
  isSource(id: string): boolean;
  /** Lines with code (not comments or blank lines), for files the report has no data for. */
  codeLines?(id: string): Set<number> | undefined;
  /** mtime of an analyzed file, to tell a report that is older than the change. */
  mtime?(id: string): number | undefined;
}

/** Index of the first element of sorted `list` that is greater than `value`. */
function upperBound(list: number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether sorted `list` has a value strictly between `a` and `b`. */
function hasBetween(list: number[], a: number, b: number): boolean {
  const i = upperBound(list, a);
  return i < list.length && list[i] < b;
}

/**
 * Sorted uncovered lines → `[start, end]` ranges. Neighbours merge only across added lines that are not
 * executable (comments, braces, blank lines of the same change), so `L40-55` reads as one block but never
 * spans a line nobody changed.
 */
function toRanges(lines: number[], covered: number[], added: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const line of lines) {
    const last = ranges[ranges.length - 1];
    const gap = last ? line - last[1] : 0;
    const bridged = last && !hasBetween(covered, last[1], line) && upperBound(added, line - 1) - upperBound(added, last[1]) === gap - 1;
    if (bridged) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}

/**
 * Coverage of the added lines: the executable ones (the report has data for them and they hold code — V8
 * reports list blank and comment lines too) and how many a test ran. Deleted lines are not part of it.
 * A changed source file the report does not mention, in a folder the report describes, was not loaded by
 * any test: its added code lines all count as uncovered. Changed files in a folder no report describes
 * (a workspace package without a report) are listed as `unmeasured`.
 */
export function patchCoverage(changed: ChangedFile[], coverage: LoadedCoverage, options: PatchCoverageOptions): PatchCoverage | undefined {
  if (!coverage.reports.length) return undefined;
  const newest = coverage.reports.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const files: PatchCoverageFile[] = [];
  const unmeasured: string[] = [];
  let coverable = 0;
  let covered = 0;
  let stale = false;
  for (const c of changed) {
    if (c.status === 'deleted' || !c.analyzed || !options.isSource(c.id)) continue;
    // Only `+` lines: `lines` also marks where lines were deleted, which no test can run.
    const added = [...new Set(c.added ?? [])].sort((a, b) => a - b);
    if (!added.length) continue;
    const code = options.codeLines?.(c.id);
    const data = coverage.files.get(c.id);
    const scope = data ? undefined : scopeOf(coverage, c.id);
    if (!data && !scope) {
      if (!code || added.some((l) => code.has(l))) unmeasured.push(c.id);
      continue;
    }
    const reportMtime = data?.reportMtime ?? scope!.mtimeMs;
    const mtime = options.mtime?.(c.id);
    const fileStale = mtime !== undefined && mtime > reportMtime;
    const lines = added.filter((l) => (!data || data.lines.has(l)) && (!code || code.has(l)));
    const hitsOf = (l: number): number => data?.lines.get(l) ?? 0;
    if (!lines.length) continue;
    const hit = lines.filter((l) => hitsOf(l) > 0).length;
    const missed = lines.filter((l) => hitsOf(l) === 0);
    const coveredLines = data ? [...data.lines].filter(([l, h]) => h > 0 && (!code || code.has(l))).map(([l]) => l).sort((a, b) => a - b) : [];
    const entry: PatchCoverageFile = { file: c.id, coverable: lines.length, covered: hit, uncovered: toRanges(missed, coveredLines, added) };
    if (!data) entry.missing = true;
    if (fileStale) entry.stale = true;
    files.push(entry);
    coverable += lines.length;
    covered += hit;
    if (fileStale) stale = true;
  }
  files.sort((a, b) => b.coverable - b.covered - (a.coverable - a.covered) || a.file.localeCompare(b.file));
  const patch: PatchCoverage = {
    coverable,
    covered,
    pct: coverable ? Math.floor((covered / coverable) * 1000) / 10 : 100,
    files,
    report: newest.file,
    reportDate: Math.round(newest.mtimeMs),
    stale,
  };
  if (unmeasured.length) patch.unmeasured = unmeasured.sort();
  return patch;
}

/* -------------------------------------------------------------------------- */
/*                                    Gate                                    */
/* -------------------------------------------------------------------------- */

export const PATCH_COVERAGE_RULE = RULE_IDS.patchCoverage;

const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/**
 * Changed files with added lines a coverage report would measure (analyzed source files, not deleted,
 * not comment-only edits) — whether a missing report hides anything.
 */
function coverableChanges(data: ReportData): string[] {
  const kinds = new Map((data.files ?? []).map((f) => [f.id, f]));
  const commentOnly = new Set(data.changes?.commentOnly ?? []);
  return (data.changes?.files ?? [])
    .filter((c) => c.status !== 'deleted' && c.analyzed && (c.added?.length ?? c.lines.length) > 0 && !commentOnly.has(c.id))
    .filter((c) => kinds.has(c.id) && isTestableSource(kinds.get(c.id)!))
    .map((c) => c.id);
}

/** `check.patchCoverage.allowMissingReport`: skip the gate (instead of failing it) when there is no report. */
function allowsMissingReport(thresholds: Thresholds): boolean {
  const setting = (thresholds as { patchCoverage?: unknown }).patchCoverage;
  if (!setting || typeof setting !== 'object') return false;
  const allow = (setting as { allowMissingReport?: unknown }).allowMissingReport;
  return allow === true || (typeof allow === 'string' && /^(true|yes|on|1)$/i.test(allow.trim()));
}

/**
 * `check --min-patch-coverage <pct>` (`check.minPatchCoverage`): the share of the lines your change added
 * that a test executed. It judges the change itself, so it is the same in every mode. Without a coverage
 * report it fails when the change adds code (a forgotten coverage step must not pass the gate), unless
 * `check.patchCoverage.allowMissingReport` says to skip it.
 */
export const patchCoverageGate: GateProvider = (data, ctx) => {
  const min = ctx.thresholds.minPatchCoverage;
  if (min === undefined) return undefined;
  const gate = { id: 'patch-coverage', label: 'Patch coverage', ruleIds: [PATCH_COVERAGE_RULE], newOnly: false as const, keepDetail: true };
  const patch = data.changes?.coverage;
  if (!data.changes?.files.length) return { ...gate, ok: true, detail: 'no changes', findings: [] };
  if (!patch) {
    const run = 'run your tests with coverage, e.g. code-visualizer test --coverage';
    const changed = coverableChanges(data);
    if (!changed.length) return { ...gate, ok: true, detail: `no coverage report, and no code changed (min ${min}%)`, findings: [] };
    if (allowsMissingReport(ctx.thresholds)) return { ...gate, ok: true, detail: `skipped: no coverage report (${run})`, findings: [] };
    const files = `${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}`;
    return { ...gate, ok: false, detail: `no coverage report found for ${plural(changed.length, 'changed file')} (${files}) — ${run}, or set "check": { "patchCoverage": { "allowMissingReport": true } }`, findings: [] };
  }
  const unmeasured = patch.unmeasured?.length ? ` · not measured (no coverage report): ${patch.unmeasured.slice(0, 3).join(', ')}${patch.unmeasured.length > 3 ? ', …' : ''}` : '';
  if (!patch.coverable) return { ...gate, ok: true, detail: `no executable lines changed (min ${min}%)${unmeasured}`, findings: [] };
  const ok = patch.pct >= min;
  const findings: Finding[] = patch.files
    .filter((f) => f.uncovered.length)
    .map((f) => {
      const missed = f.coverable - f.covered;
      return {
        ruleId: PATCH_COVERAGE_RULE,
        gate: gate.id,
        file: f.file,
        line: f.uncovered[0][0],
        message: `${plural(missed, 'changed line')} not covered by tests: ${formatRanges(f.uncovered)}${f.missing ? ' (no test loads this file)' : ''}`,
        severity: ok ? 'warning' : 'error',
        subject: f.file,
        fingerprint: fingerprint(PATCH_COVERAGE_RULE, f.file, 'uncovered-changed-lines'),
        // Uncovered added lines are part of this change by definition.
        status: 'new',
        weight: missed,
      };
    });
  const staleNote = patch.stale ? ' · the report is older than your changes' : '';
  return { ...gate, ok, detail: `${patch.pct}% (${patch.covered}/${patch.coverable} changed lines, min ${min}%)${staleNote}${unmeasured}`, findings };
};
