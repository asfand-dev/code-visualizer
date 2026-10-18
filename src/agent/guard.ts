/**
 * Agent guardrails, the analysis part: what an edit an AI agent proposes (pre-edit) or made (post-edit)
 * changes architecturally. Built on `compareReports` (compare-engine) and pure: it takes two analyses —
 * the project now and the project with the edit, or as the session started — so a running `serve`
 * (POST /api/whatif) and the hook process itself compute the same findings.
 *
 * - pre-edit `block`s a new forbidden import, a layer break, a new cycle or an import of a package no
 *   package.json declares, and names an allowed alternative; warn-level rules only `inform`.
 * - post-edit `inform`s about what the session's edits left behind: call sites of a changed signature
 *   that were not updated, a removed export or route that is still used, a complexity jump, a new export
 *   no test reaches, a copy of existing code, and a copy edited while its clone was not (clone-radar) —
 *   plus what later features add to POST_EDIT_DETECTORS.
 */
import ignore from 'ignore';
import { cloneSettings } from '../analyzer/clones.js';
import { compareReports, COMPLEXITY_THRESHOLD, measuredFunctions } from '../analyzer/compare.js';
import { evaluateRules, type CodeVisualizerConfig } from '../analyzer/config.js';
import { diffLines } from '../cli/text-diff.js';
import { cloneDrift, cloneSides, driftMessage, fragmentKey, fragmentLocation, newCloneMessage, WHOLE_COPY } from '../shared/clones.js';
import { cycleLabel, exportName, functionLabel } from '../shared/delta.js';
import { complexityFingerprint, cycleFingerprint, missingDependencyFingerprint, violationFingerprint } from '../shared/fingerprint.js';
import { buildIndex, httpTestedFiles, importPath } from '../shared/query.js';
import { compactSignature, isCallable, paramRange, signature } from '../shared/signature.js';
import { SOURCE_FILE_RE } from '../shared/source-files.js';
import { isTestableSource } from '../shared/testcmd.js';
import type { ArchitectureDelta, CallSite, ChangedFile, DependencyEdge, ExportChange, FileInfo, GuardFinding, ReportData, RuleViolation } from '../shared/types.js';
import type { HookEdit } from './dialect.js';

export type { GuardFinding };

/** Files the guard judges: the analyzer's source extensions (kept under this name for existing importers). */
export const GUARDED_FILE_RE = SOURCE_FILE_RE;

/** A complexity increase worth telling the agent (post-edit). */
export const COMPLEXITY_JUMP = 5;

const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;
const fileOfSymbol = (id: string): string => (id.includes('#') ? id.slice(0, id.indexOf('#')) : id);
const sites = (list: { file: string; line: number }[], max = 4): string => list.slice(0, max).map((s) => `${s.file}:${s.line}`).join(', ') + (list.length > max ? `, … (+${list.length - max} more)` : '');

/* -------------------------------------------------------------------------- */
/*                                Proposed text                               */
/* -------------------------------------------------------------------------- */

/**
 * The file's text after the edits: exact string replacements, in order (`replaceAll` replaces every
 * occurrence). Undefined when an old text is not found — the client will refuse that edit itself, so the
 * guard fails open. An empty old text creates the file (Claude's Edit on a new file).
 */
export function applyEdits(current: string, edits: HookEdit[]): string | undefined {
  let text = current;
  for (const e of edits) {
    if (e.oldText === '') {
      if (text !== '') return undefined;
      text = e.newText;
      continue;
    }
    const at = text.indexOf(e.oldText);
    if (at === -1) return undefined;
    text = e.replaceAll ? text.split(e.oldText).join(e.newText) : `${text.slice(0, at)}${e.newText}${text.slice(at + e.oldText.length)}`;
  }
  return text;
}

/** The text before the edits, from the text after them (best effort: undefined when a new text is not found). */
export function revertEdits(after: string, edits: HookEdit[]): string | undefined {
  return applyEdits(
    after,
    [...edits].reverse().map((e) => ({ oldText: e.newText, newText: e.oldText, replaceAll: e.replaceAll })),
  );
}

/** Lines changed by an edit, numbered in the new text: `lines` as a git diff marks them, `added` the `+` lines. */
export interface LineChanges {
  lines: number[];
  added: number[];
}

/** A rewritten middle larger than this (lines before × lines after) counts as replaced rather than diffed. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * What an edit changed, numbered in the new text the way `git diff` numbers it (clone drift reads it):
 * every added line, and the line after a deletion. A file that did not exist (`before` null) is all added.
 */
export function lineChanges(before: string | null, after: string): LineChanges {
  const b = after.split('\n');
  if (before === null) {
    const all = b.map((_, i) => i + 1);
    return { lines: all, added: all };
  }
  const a = before.split('\n');
  // Edits are local: diff only what lies between the common first and last lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const oldMiddle = a.slice(head, a.length - tail);
  const newMiddle = b.slice(head, b.length - tail);
  const script =
    oldMiddle.length * newMiddle.length > MAX_DIFF_CELLS
      ? [...oldMiddle.map((line) => ({ op: '-', line })), ...newMiddle.map((line) => ({ op: '+', line }))]
      : diffLines(oldMiddle, newMiddle);
  const lines = new Set<number>();
  const added: number[] = [];
  let line = head + 1;
  for (const s of script) {
    if (s.op === '+') {
      lines.add(line);
      added.push(line++);
    } else if (s.op === '-') lines.add(line);
    else line++;
  }
  return { lines: [...lines].sort((x, y) => x - y), added };
}

/**
 * `lineChanges` of each file of a post-edit overlay (the texts as the session found them) against its text
 * now (`current`, null when it is gone): what the session changed, for clone drift.
 */
export function overlayLineChanges(overlay: Record<string, string | null>, current: (file: string) => string | null): Record<string, LineChanges> {
  const out: Record<string, LineChanges> = {};
  for (const [file, before] of Object.entries(overlay)) {
    if (!GUARDED_FILE_RE.test(file)) continue;
    const now = current(file);
    if (now !== null && now !== before) out[file] = lineChanges(before, now);
  }
  return out;
}

/** Index after the string or template literal that starts at `i` (`${…}` expressions included). */
function skipString(text: string, i: number): number {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === quote) return j + 1;
    else if (quote !== '`' && c === '\n') return j; // unterminated (an apostrophe in JSX text)
    else if (quote === '`' && c === '$' && text[j + 1] === '{') j = skipExpression(text, j + 2) - 1;
  }
  return text.length;
}

/** Index after the `}` that closes a template expression starting at `i`. */
function skipExpression(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === '`') j = skipString(text, j) - 1;
    else if (c === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
      const end = text[j + 1] === '/' ? text.indexOf('\n', j) : text.indexOf('*/', j + 2);
      j = end === -1 ? text.length : text[j + 1] === '/' ? end : end + 1;
    } else if (c === '{') depth++;
    else if (c === '}' && depth-- === 0) return j + 1;
  }
  return text.length;
}

/** A `/` here starts a regular expression literal (not a division): after an operator, a bracket or a keyword. */
function startsRegex(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  if (j < 0 || text[j] === '\n') return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(text[j])) return true;
  return /\b(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(text.slice(Math.max(0, j - 9), j + 1));
}

/** Index after the regular expression literal starting at `i`. */
function skipRegex(text: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '\n') return j;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return j + 1;
  }
  return text.length;
}

/** A string right after these is a module specifier. */
const SPECIFIER_BEFORE = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*$/;

/**
 * The text as the module system sees it: comments removed, and strings that are not module specifiers
 * emptied — so a commented-out import, or import text inside a string, is not an import, and turning
 * one into a real import is a change.
 */
export function codeOnly(text: string): string {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let end = -1;
    let keep = '';
    if (c === '/' && text[i + 1] === '/') {
      end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
    } else if (c === '/' && text[i + 1] === '*') {
      end = text.indexOf('*/', i + 2);
      end = end === -1 ? text.length : end + 2;
      keep = ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      end = skipString(text, i);
      keep = SPECIFIER_BEFORE.test(text.slice(Math.max(0, i - 40), i)) ? text.slice(i, end) : `${c}${c}`;
    } else if (c === '/' && startsRegex(text, i)) {
      end = skipRegex(text, i);
      keep = '/./';
    }
    if (end === -1) continue;
    parts.push(text.slice(from, i), keep);
    from = end;
    i = end - 1;
  }
  parts.push(text.slice(from));
  return parts.join('');
}

/**
 * The import statements of a text, whitespace-normalized and sorted with repeats: `import … from '…'` and
 * `export … from '…'` as written (so `import type` ↔ `import` counts), plus `import '…'`, `import('…')`
 * and `require('…')`. Comments and other strings do not count (see `codeOnly`).
 */
export function importStatements(text: string): string[] {
  const code = codeOnly(text);
  // Formatting (line breaks, trailing commas) is not a change.
  const normal = (statement: string): string => statement.replace(/\s+/g, ' ').replace(/\s*,?\s*}/g, ' }').replace(/{\s*/g, '{ ');
  const found: string[] = [];
  // A statement never spans another `import`/`export` keyword: that keeps the scan linear on files with many exports.
  for (const m of code.matchAll(/\b(?:import|export)\b(?:(?!\b(?:import|export)\b)[^;'"`])*?\bfrom\s*(['"`])[^'"`\n]+\1/g)) found.push(normal(m[0]));
  for (const m of code.matchAll(/\b(?:import|require)\s*\(?\s*(['"`])[^'"`\n]+\1/g)) found.push(normal(m[0]));
  return found.sort();
}

/**
 * Whether an edit can change the import graph at all. Forbidden imports, layer breaks, cycles and
 * undeclared packages all come from import statements, so an edit that keeps them needs no analysis.
 */
export function importsChanged(before: string | null, after: string | null): boolean {
  // A new file without imports adds no edge; a deleted file breaks importers but breaks no rule.
  const a = importStatements(before ?? '');
  const b = importStatements(after ?? '');
  return a.length !== b.length || a.some((s, i) => s !== b[i]);
}

/* -------------------------------------------------------------------------- */
/*                               Session baseline                             */
/* -------------------------------------------------------------------------- */

/** Fingerprints of the findings an analysis has: cycles, rule violations, missing packages, complex functions. */
export function findingFingerprints(data: ReportData, complexityThreshold = COMPLEXITY_THRESHOLD): string[] {
  const list = [
    ...data.insights.cycles.map(cycleFingerprint),
    ...data.insights.ruleViolations.map(violationFingerprint),
    ...data.insights.missingDependencies.map((m) => missingDependencyFingerprint(m.name)),
    ...measuredFunctions(data.files)
      .filter((f) => f.complexity > complexityThreshold)
      .map((f) => complexityFingerprint(f.file, f.symbol)),
  ];
  return [...new Set(list)].sort();
}

/** Signatures of exported functions, hooks and components (symbol id → signature). */
export function exportSignatures(data: ReportData, files?: Iterable<string>): Record<string, string> {
  const only = files ? new Set(files) : undefined;
  const out: Record<string, string> = {};
  for (const f of data.files) {
    if (f.kind === 'test' || (only && !only.has(f.id))) continue;
    for (const s of f.symbols) if (s.exported && isCallable(s)) out[s.id] = signature(s);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                            Allowed alternatives                            */
/* -------------------------------------------------------------------------- */

/** Files that start, route or check the program: importing them is never the way to reuse their code. */
const NOT_A_MODULE = new Set(['test', 'story', 'script', 'config', 'entry', 'page', 'layout', 'route', 'router', 'controller', 'middleware']);

export interface Alternative {
  file: string;
  /** What to use from it: an exported function that already uses the target, or the names it re-exports. */
  uses?: string;
  /** It exports the very names the edit imports (a facade or barrel). */
  reexports?: boolean;
}

function layerMatchers(config: CodeVisualizerConfig): ((id: string) => boolean)[] {
  return (config.layers ?? []).map((layer) => {
    const list = (Array.isArray(layer) ? layer : [layer]).filter(Boolean).map((p) => p.replace(/^\.\//, ''));
    const ig = ignore().add(list);
    return (id: string) => list.length > 0 && ig.ignores(id);
  });
}

const edge = (source: string, target: string): DependencyEdge => ({ source, target, kind: 'import', typeOnly: false, names: [], line: 0, specifier: '' });

/** Whether `to` can be reached from `from` through runtime imports (a new import from→… would close a cycle). */
function reaches(data: ReportData, from: string, to: string): boolean {
  return !!importPath(data, from, to, { runtimeOnly: true });
}

/** Folders whose files are the app's screens (React Router pages, views): their code is not a module to reuse. */
const SCREEN_DIR_RE = /(^|\/)(pages|views|screens|routes)\//;
/** Exported symbols that hand out what the target does (not UI, not types). */
const REUSABLE = new Set(['hook', 'function', 'class', 'constant', 'variable', 'namespace', 'enum']);

/**
 * Where to get what a forbidden import wanted: files that already import `target` (and are allowed to),
 * that `source` may import without breaking a rule or closing a cycle, and that either export the very
 * names the edit wanted (a facade) or export a function, hook or class that already calls into `target`.
 * Screens (pages, routed components, React components) are never offered for their data. Ranked: a facade
 * first, then a function using the wanted names, then the source's own layer, then the most used.
 */
export function allowedAlternatives(data: ReportData, config: CodeVisualizerConfig, source: string, target: string, names: string[] = [], limit = 2): Alternative[] {
  const idx = buildIndex(data);
  const wanted = names.filter((n) => n !== '*' && n !== 'default');
  const wantedIds = new Set(wanted.map((n) => `${target}#${n}`));
  const layers = layerMatchers(config);
  const layerOf = (id: string): number => layers.findIndex((m) => m(id));
  const sourceLayer = layerOf(source);
  const routed = new Set(data.routes.flatMap((r) => [r.file, ...(r.handlerSymbol ? [fileOfSymbol(r.handlerSymbol)] : [])]));
  const candidates = new Map<string, DependencyEdge>();
  for (const e of idx.in.get(target) ?? []) if (e.source !== source && !e.typeOnly && !candidates.has(e.source)) candidates.set(e.source, e);
  const ranked = [...candidates.entries()]
    .map(([file, e]) => ({ file, e, f: idx.fileById.get(file) }))
    .filter((c): c is { file: string; e: DependencyEdge; f: FileInfo } => !!c.f && !c.f.isEntry && !NOT_A_MODULE.has(c.f.kind))
    .filter((c) => !evaluateRules(config, [edge(source, c.file), edge(c.file, target)]).length)
    .map((c) => {
      const exported = new Set(c.f.exports.map((x) => x.name));
      const reexports = wanted.length > 0 && wanted.every((n) => exported.has(n));
      // Exported functions, hooks or classes of the candidate that already call into the target.
      const users = c.f.symbols.filter((x) => x.exported && REUSABLE.has(x.kind));
      const calls = data.symbolEdges.filter((s) => fileOfSymbol(s.target) === target && users.some((x) => x.id === s.source));
      const best = calls.find((s) => wantedIds.has(s.target)) ?? calls[0];
      return {
        ...c,
        reexports,
        symbol: best ? users.find((x) => x.id === best.source) : undefined,
        sameLayer: sourceLayer !== -1 && layerOf(c.file) === sourceLayer,
        usesNames: !!best && wantedIds.has(best.target),
      };
    })
    // A screen is not where data comes from, unless it is a facade for exactly the wanted names.
    .filter((c) => c.reexports || (!!c.symbol && c.f.kind !== 'component' && !routed.has(c.file) && !SCREEN_DIR_RE.test(c.file)))
    .sort(
      (p, q) =>
        Number(q.reexports) - Number(p.reexports) ||
        Number(q.usesNames) - Number(p.usesNames) ||
        Number(q.sameLayer) - Number(p.sameLayer) ||
        q.f.metrics.fanIn - p.f.metrics.fanIn ||
        p.file.localeCompare(q.file),
    );
  const out: Alternative[] = [];
  for (const c of ranked) {
    if (out.length >= limit) break;
    // Importing it must not close a cycle back to the source.
    if (reaches(data, c.file, source)) continue;
    if (c.reexports) out.push({ file: c.file, uses: wanted.join(', '), reexports: true });
    else if (c.symbol) out.push({ file: c.file, uses: isCallable(c.symbol) ? `${c.symbol.name}()` : c.symbol.name });
  }
  return out;
}

/** `src/services/cart.ts exports getCart(), which already uses src/db/client.ts.` */
export function alternativeText(alternatives: Alternative[], target: string): string | undefined {
  if (!alternatives.length) return undefined;
  const one = (a: Alternative): string => {
    if (a.reexports) return `${a.file} exports ${a.uses} too`;
    return a.uses ? `${a.file} exports ${a.uses}, which already uses ${target}` : `${a.file} already uses ${target}`;
  };
  return `${alternatives.map(one).join('; ')}.`;
}

/* -------------------------------------------------------------------------- */
/*                         Architecture (pre and post)                        */
/* -------------------------------------------------------------------------- */

export interface GuardOptions {
  /** The files the edit (pre-edit) or the session (post-edit) changed, project-relative. */
  files: string[];
  /** The configuration as it is now (rules and layers). */
  config?: CodeVisualizerConfig;
  /** `check.maxComplexity` (default 10). */
  complexityThreshold?: number;
}

function compare(base: ReportData, head: ReportData, options: GuardOptions): ArchitectureDelta {
  return compareReports(base, head, {
    config: options.config,
    changedFiles: options.files,
    areas: false,
    complexityThreshold: options.complexityThreshold ?? options.config?.check?.maxComplexity,
  });
}

function violationFinding(v: RuleViolation, base: ReportData, config: CodeVisualizerConfig, names: string[], severity: GuardFinding['severity']): GuardFinding {
  const layer = v.rule === 'layers';
  // A warn-level rule lets the edit through: it advises rather than forbids.
  const verb = v.severity === 'warn' ? 'should not import' : 'must not import';
  const message = layer
    ? `${v.source} ${verb} ${v.target}: ${v.message ?? 'a lower layer must not import a higher one'} (layers in the configuration).`
    : `${v.source} ${verb} ${v.target} (rule ${v.rule})${v.message ? `: ${v.message}` : ''}.`;
  const fixes: string[] = [];
  const alternative = alternativeText(allowedAlternatives(base, config, v.source, v.target, names), v.target);
  if (alternative) fixes.push(alternative);
  // A rule with `includeTypes: false` allows type-only imports.
  if (!layer && !evaluateRules(config, [{ ...edge(v.source, v.target), typeOnly: true }]).some((x) => x.rule === v.rule)) fixes.push('A type-only import (`import type`) is allowed.');
  if (!fixes.length) fixes.push(`No file that ${v.source} may import uses ${v.target} yet; the shared code belongs in a module both sides may import.`);
  return { kind: layer ? 'layer' : 'forbidden-import', severity, file: v.source, line: v.line || undefined, message, fix: fixes.join(' '), fingerprint: violationFingerprint(v), key: `violation|${v.rule}|${v.source}|${v.target}` };
}

function cycleFinding(cycle: string[], delta: ArchitectureDelta, base: ReportData, touched: Set<string>, severity: GuardFinding['severity']): GuardFinding {
  const members = new Set(cycle);
  const closing = delta.newEdges.find((e) => !e.typeOnly && members.has(e.source) && members.has(e.target) && touched.has(e.source));
  let fix = 'Shared code belongs in a module both sides may import.';
  let file = cycle.find((id) => touched.has(id)) ?? cycle[0];
  let line: number | undefined;
  if (closing) {
    file = closing.source;
    line = closing.line;
    const back = importPath(base, closing.target, closing.source, { runtimeOnly: true });
    const chain = back ? [closing.target, ...back.hops.map((h) => h.target)].join(' → ') : undefined;
    fix = `${closing.target} already depends on ${closing.source}${chain ? ` (${chain})` : ''}. ${fix}`;
  }
  return { kind: 'new-cycle', severity, file, line, message: `This creates a circular dependency: ${cycleLabel(cycle)}.`, fix, fingerprint: cycleFingerprint(cycle), key: `cycle|${cycleFingerprint(cycle)}` };
}

const INSTALL: Record<string, string> = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add', bun: 'bun add' };
const INSTALL_DEV: Record<string, string> = { npm: 'npm install -D', pnpm: 'pnpm add -D', yarn: 'yarn add -D', bun: 'bun add -d' };
/** Files whose packages belong in devDependencies. */
const DEV_KINDS = new Set(['test', 'story', 'config', 'script']);

function packageFinding(name: string, head: ReportData, touched: Set<string>, severity: GuardFinding['severity']): GuardFinding | undefined {
  const missing = head.insights.missingDependencies.find((m) => m.name === name);
  const file = missing?.files.find((f) => touched.has(f));
  if (!file) return undefined;
  const manifest = missing?.manifests?.[0];
  const where = manifest ? `${manifest}/package.json` : 'package.json';
  // Only tests, stories, configs or scripts import it: a dev dependency.
  const kinds = new Map(head.files.map((f) => [f.id, f.kind]));
  const dev = (missing?.files ?? []).every((f) => DEV_KINDS.has(kinds.get(f) ?? ''));
  const pm = head.project.packageManager ?? 'npm';
  const install = (dev ? INSTALL_DEV[pm] : INSTALL[pm]) ?? (dev ? 'npm install -D' : 'npm install');
  const elsewhere = missing?.declaredBy?.length ? ` It is declared by ${missing.declaredBy.map((d) => (d ? `${d}/package.json` : 'package.json')).join(', ')}, not by the package this file belongs to.` : '';
  return {
    kind: 'undeclared-package',
    severity,
    file,
    message: `${file} imports "${name}", which ${where} does not declare.${elsewhere}`,
    fix: `Adding it comes first: ${manifest ? `(cd ${manifest} && ${install} ${name})` : `${install} ${name}`}.`,
    fingerprint: missingDependencyFingerprint(name),
    key: `package|${name}`,
  };
}

/**
 * New rule violations, cycles and undeclared packages of the touched files. Error-level ones get
 * `blocking` severity (pre-edit: refuse), warn-level rules always `inform`.
 */
function architectureFindings(base: ReportData, head: ReportData, delta: ArchitectureDelta, options: GuardOptions, blocking: GuardFinding['severity']): GuardFinding[] {
  const touched = new Set(options.files);
  const config = options.config ?? {};
  const findings: GuardFinding[] = [];
  for (const v of delta.newViolations) {
    if (!touched.has(v.source) && !touched.has(v.target)) continue;
    const names = delta.newEdges.find((e) => e.source === v.source && e.target === v.target)?.names ?? [];
    findings.push(violationFinding(v, base, config, names, v.severity === 'error' ? blocking : 'inform'));
  }
  for (const cycle of delta.newCycles) if (cycle.some((id) => touched.has(id))) findings.push(cycleFinding(cycle, delta, base, touched, blocking));
  for (const name of delta.newMissingDependencies) {
    const f = packageFinding(name, head, touched, blocking);
    if (f) findings.push(f);
  }
  return findings;
}

/** What a proposed edit would break before it is written: `current` is the project now, `proposed` with the edit. */
export function preEditFindings(current: ReportData, proposed: ReportData, options: GuardOptions): GuardFinding[] {
  return architectureFindings(current, proposed, compare(current, proposed, options), options, 'block');
}

/* -------------------------------------------------------------------------- */
/*                                  Post-edit                                 */
/* -------------------------------------------------------------------------- */

export interface PostEditOptions extends GuardOptions {
  /**
   * Signatures of the touched files' exports when the session started (symbol id → signature): a
   * changed signature whose old text is not available as a `before` file is still judged by them.
   */
  signatures?: Record<string, string>;
  /**
   * The lines the session changed in each touched file (`overlayLineChanges`): an edited copy of
   * duplicated code whose clone was left as it was is clone drift. Without them only copies that no
   * longer match are reported.
   */
  changedLines?: Record<string, LineChanges>;
}

export interface PostEditContext {
  /** The project as the session started (touched files at their original text). */
  before: ReportData;
  /** The project now. */
  after: ReportData;
  delta: ArchitectureDelta;
  touched: Set<string>;
  options: PostEditOptions;
}

/** A source of post-edit findings. Later features append theirs to POST_EDIT_DETECTORS. */
export type PostEditDetector = (ctx: PostEditContext) => GuardFinding[];

/** `3 call sites still pass 1 argument` / `2 call sites pass 1 or 4 arguments` */
function staleText(staleSites: CallSite[]): string {
  const counts = [...new Set(staleSites.map((s) => s.argc ?? -1).filter((n) => n >= 0))].sort((a, b) => a - b);
  const one = staleSites.length === 1;
  const what = counts.length === 1 ? `still pass${one ? 'es' : ''} ${plural(counts[0], 'argument')}` : `pass${one ? 'es' : ''} ${counts.join(' or ')} arguments`;
  return `${plural(staleSites.length, 'call site')} ${what}: ${sites(staleSites)}`;
}

function exportFinding(e: ExportChange, deletedFile: boolean): GuardFinding | undefined {
  if (!e.breaking) return undefined;
  const name = exportName(e);
  const base = { kind: 'breaking-export' as const, severity: 'inform' as const, file: e.file, line: e.line };
  if (e.change === 'signature' && e.staleCallSites.length) {
    const after = e.after ? compactSignature(e.after) : `${name}()`;
    return { ...base, message: `${after} changed its parameters: ${staleText(e.staleCallSites)}.`, fix: 'Those calls need the new arguments.', key: `stale|${e.file}#${e.name}|${e.staleCallSites.map((s) => `${s.file}:${s.line}`).join(',')}` };
  }
  if (e.change === 'removed' && e.importers.length) {
    const what = deletedFile ? `${e.file} was deleted` : `${name} was removed from ${e.file}`;
    return { ...base, message: `${what}, but ${e.importers.slice(0, 4).join(', ')}${e.importers.length > 4 ? ` (+${e.importers.length - 4} more)` : ''} still import${e.importers.length === 1 ? 's' : ''} it.`, key: `removed|${e.file}#${e.name}|${e.importers.join(',')}` };
  }
  if (e.change === 'kind' && e.importers.length) {
    return { ...base, message: `${name} in ${e.file} changed from \`${e.before}\` to \`${e.after}\`; ${plural(e.importers.length, 'file')} import it.`, key: `kind|${e.file}#${e.name}|${e.after}` };
  }
  return undefined;
}

const exportsDetector: PostEditDetector = ({ before, after, delta }) => {
  const afterFiles = new Set(after.files.map((f) => f.id));
  const deleted = (file: string): boolean => !afterFiles.has(file) && before.files.some((f) => f.id === file);
  return delta.exports.map((e) => exportFinding(e, deleted(e.file))).filter((f): f is GuardFinding => !!f);
};

/** Signature changes judged by the session's recorded signatures (no `before` text for the file). */
const signaturesDetector: PostEditDetector = ({ after, delta, touched, options }) => {
  const recorded = options.signatures;
  if (!recorded) return [];
  const known = new Set(delta.exports.map((e) => `${e.file}#${e.name}`));
  const out: GuardFinding[] = [];
  for (const f of after.files) {
    if (!touched.has(f.id)) continue;
    for (const s of f.symbols) {
      if (!s.exported || !isCallable(s) || known.has(`${f.id}#${s.name}`)) continue;
      const was = recorded[s.id];
      const now = signature(s);
      if (was === undefined || was === now) continue;
      const range = paramRange(s.params);
      const stale: CallSite[] = [];
      for (const e of after.symbolEdges) {
        if (e.target !== s.id || e.kind !== 'calls' || !e.lines || !e.argc) continue;
        e.lines.forEach((line, i) => {
          const n = e.argc![i];
          if (n !== undefined && n >= 0 && (n < range.required || n > range.max)) stale.push({ file: fileOfSymbol(e.source), line, argc: n, kind: 'call', symbol: e.source });
        });
      }
      if (!stale.length) continue;
      stale.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      out.push({
        kind: 'breaking-export',
        severity: 'inform',
        file: f.id,
        line: s.line,
        message: `${compactSignature(now)} changed its parameters: ${staleText(stale)}.`,
        fix: 'Those calls need the new arguments.',
        key: `stale|${s.id}|${stale.map((x) => `${x.file}:${x.line}`).join(',')}`,
      });
    }
  }
  return out;
};

const routesDetector: PostEditDetector = ({ delta }) =>
  delta.routes.removed
    .filter((r) => r.stillCalledFrom.length)
    .map((r) => ({
      kind: 'removed-route' as const,
      severity: 'inform' as const,
      file: r.stillCalledFrom[0].file,
      line: r.stillCalledFrom[0].line,
      message: `${r.label} no longer exists, but ${sites(r.stillCalledFrom)} still request${r.stillCalledFrom.length === 1 ? 's' : ''} it.`,
      key: `route|${r.label}|${r.stillCalledFrom.map((s) => `${s.file}:${s.line}`).join(',')}`,
    }));

const complexityDetector: PostEditDetector = ({ delta, options }) => {
  const limit = options.complexityThreshold ?? options.config?.check?.maxComplexity ?? COMPLEXITY_THRESHOLD;
  return delta.complexity
    .filter((c) => c.after - c.before > COMPLEXITY_JUMP)
    .map((c) => ({
      kind: 'complexity-jump' as const,
      severity: 'inform' as const,
      file: c.file,
      line: c.line,
      message: c.before ? `${functionLabel(c.name)} in ${c.file}:${c.line} went from complexity ${c.before} to ${c.after}.` : `The new ${functionLabel(c.name)} in ${c.file}:${c.line} has complexity ${c.after}.`,
      fix: c.after > limit ? `Above ${limit}, \`check\` reports it (check.maxComplexity).` : undefined,
      fingerprint: c.after > limit && !c.before ? complexityFingerprint(c.file, c.symbol) : undefined,
      key: `complexity|${c.symbol}|${c.after}`,
    }));
};

/** Where a test for `file` would go, following the project's habit (next to the code, or in a test folder). */
function suggestedTest(data: ReportData, file: string): string {
  const tests = data.files.filter((f) => f.kind === 'test');
  const ext = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.exec(file)?.[1] ?? 'ts';
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const colocated = tests.filter((t) => !/(^|\/)(test|tests|__tests__|spec|e2e)\//.test(t.id)).length;
  const style = tests.find((t) => /\.spec\.[^.]+$/.test(t.id)) && !tests.find((t) => /\.test\.[^.]+$/.test(t.id)) ? 'spec' : 'test';
  if (tests.length && colocated * 2 < tests.length) {
    const folder = tests[0].id.match(/^(.*?(?:^|\/)(?:test|tests|__tests__|spec))\//)?.[1] ?? 'test';
    return `${folder}/${base}.${style}.${ext.replace(/^m?js$/, 'js')}`;
  }
  return `${dir ? `${dir}/` : ''}${base}.${style}.${ext}`;
}

/** New exports of touched files that no test reaches (only in projects that have tests). */
const untestedDetector: PostEditDetector = ({ before, after, touched }) => {
  if (!after.files.some((f) => f.kind === 'test')) return [];
  const overHttp = httpTestedFiles(after);
  const beforeFiles = new Map(before.files.map((f) => [f.id, f]));
  const out: GuardFinding[] = [];
  for (const f of after.files) {
    if (!touched.has(f.id) || !isTestableSource(f) || f.tests?.length || overHttp.has(f.id)) continue;
    const had = new Set(beforeFiles.get(f.id)?.exports.map((e) => e.name) ?? []);
    const fresh = f.symbols.filter((s) => s.exported && !had.has(s.isDefault ? 'default' : s.name) && !['interface', 'type'].includes(s.kind) && !f.exports.find((e) => e.name === s.name)?.typeOnly);
    if (!fresh.length) continue;
    const names = fresh.map((s) => (isCallable(s) ? `${s.name}()` : s.name));
    out.push({
      kind: 'untested-export',
      severity: 'inform',
      file: f.id,
      line: fresh[0].line,
      message: `New export${names.length === 1 ? '' : 's'} ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''} in ${f.id}: no test reaches this file.`,
      fix: `A test would go in ${suggestedTest(after, f.id)}.`,
      key: `untested|${f.id}|${fresh.map((s) => s.name).join(',')}`,
    });
  }
  return out;
};

/**
 * clone-radar: code the session's edits copied from existing code (`delta.newClones`, judged against the
 * files as the session found them) — "this already exists: import it instead", in the words `check`,
 * `pr` and `serve` use.
 */
const clonesDetector: PostEditDetector = ({ delta, touched }) => {
  const out: GuardFinding[] = [];
  for (const family of delta.newClones ?? []) {
    const { copy, original, similarity } = cloneSides(family);
    if (!original || !touched.has(copy.file)) continue;
    // A whole copy is named by its declarations; a shared block's message already has both line ranges.
    const whole = similarity >= WHOLE_COPY && !!copy.name && !!original.name;
    out.push({
      kind: 'clone',
      severity: 'inform',
      file: copy.file,
      line: copy.start,
      message: `${newCloneMessage(family)}.`,
      ...(whole ? { fix: `The existing one is at ${fragmentLocation(original)}.` } : {}),
      key: `clone|${fragmentKey(copy)}|${fragmentKey(original)}`,
    });
  }
  return out;
};

/**
 * clone-radar: the session edited one copy of duplicated code and left its clone as it was (a fix made in
 * one copy is probably needed in the other), or edited it until the copies no longer match. Copies the
 * session pasted are new clones, not drift.
 */
const cloneDriftDetector: PostEditDetector = ({ after, delta, touched, options }) => {
  const settings = cloneSettings(options.config?.clones);
  if (!settings) return [];
  const files: ChangedFile[] = Object.entries(options.changedLines ?? {})
    .filter(([id]) => touched.has(id))
    .map(([id, c]) => ({ id, status: 'modified', additions: c.added.length, deletions: 0, lines: c.lines, added: c.added, analyzed: true }));
  const out: GuardFinding[] = [];
  const told = new Set<string>();
  for (const d of [...(delta.driftedClones ?? []), ...cloneDrift(after.insights.clones, files, [], settings.minSimilarity)]) {
    if (!touched.has(d.changed.file) || !d.untouched.length) continue;
    const key = `drift|${fragmentKey(d.changed)}|${d.untouched.map(fragmentKey).sort().join(',')}`;
    if (told.has(key)) continue;
    told.add(key);
    const text = driftMessage(d);
    out.push({
      kind: 'clone',
      severity: 'inform',
      file: d.changed.file,
      line: d.changed.start,
      message: `${text[0].toUpperCase()}${text.slice(1)}.`,
      fix: d.untouched.length === 1 ? 'If the edit fixed something, the copy probably needs it too.' : 'If the edit fixed something, the copies probably need it too.',
      key,
    });
  }
  return out;
};

/** Post-edit detectors, in the order their findings are told. */
export const POST_EDIT_DETECTORS: PostEditDetector[] = [exportsDetector, signaturesDetector, routesDetector, complexityDetector, untestedDetector, clonesDetector, cloneDriftDetector];

/**
 * What the session's edits left behind: `before` is the project with the touched files as the session
 * found them, `after` the project now. Architecture problems are told too (never blocking: the edit is
 * done) — Cursor has no pre-edit hook, so this is where it hears about them.
 */
export function postEditFindings(before: ReportData, after: ReportData, options: PostEditOptions): GuardFinding[] {
  const delta = compare(before, after, options);
  const touched = new Set(options.files);
  const ctx: PostEditContext = { before, after, delta, touched, options };
  const findings = architectureFindings(before, after, delta, options, 'inform');
  for (const detect of POST_EDIT_DETECTORS) {
    try {
      findings.push(...detect(ctx));
    } catch {
      /* one detector must not silence the others */
    }
  }
  return findings;
}

/* -------------------------------------------------------------------------- */
/*                                  Messages                                  */
/* -------------------------------------------------------------------------- */

const findingLine = (f: GuardFinding): string => `- ${f.message}${f.fix ? ` ${f.fix}` : ''}`;

/** The reason a pre-edit refusal gives the agent (blocking findings first, then notes). */
export function denyText(findings: GuardFinding[], configFile = 'code-visualizer.config.json'): string {
  const block = findings.filter((f) => f.severity === 'block');
  const inform = findings.filter((f) => f.severity !== 'block');
  const lines = ['code-visualizer refused this edit (architecture guard):', ...block.map(findingLine)];
  if (inform.length) lines.push('Also:', ...inform.map(findingLine));
  if (findings.some((f) => f.kind === 'forbidden-import' || f.kind === 'layer')) lines.push(`The rules and layers are in ${configFile}.`);
  return lines.join('\n');
}

/** Context for the agent: warn-level notes before an edit, or what an edit left behind. */
export function contextText(findings: GuardFinding[], when: 'pre-edit' | 'post-edit'): string {
  const head = when === 'pre-edit' ? 'code-visualizer notes about this edit:' : 'code-visualizer found after this edit:';
  return [head, ...findings.map(findingLine)].join('\n');
}
