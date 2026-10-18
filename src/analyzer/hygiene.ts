/**
 * Hygiene of the lines a change adds: focused tests (`it.only(`, `fdescribe(`), `debugger` statements and
 * merge conflict markers. Only added lines are scanned (from the unified diffs in `data.changes`), so old
 * code never fails a commit. Pure — no I/O; the gate is part of GATE_PROVIDERS (src/analyzer/gates.ts).
 */
import ignore from 'ignore';
import { fingerprint, RULE_IDS } from '../shared/fingerprint.js';
import { SOURCE_FILE_RE } from '../shared/source-files.js';
import type { ChangedFile, Finding, HygieneFinding, ReportData } from '../shared/types.js';
import { HYGIENE_KINDS, type HygieneKind, type HygieneSetting } from './config.js';
import type { GateProvider } from './gates.js';

/**
 * Focused tests, matched on the code of a line (string contents blanked, comments cut) and never after a
 * member access or inside a name: `it.only(`, `test.describe.only(`, `describe.only.each(`; Jasmine's
 * `fit(` / `fdescribe(` only with a test name as the first argument (so `model.fit(xs)`, `fit()` methods
 * and a function called `fit(1)` are not focused tests).
 */
const FOCUSED = [/(?<![\w$.])(?:it|test|describe|context|suite)(?:\.(?:describe|serial|parallel|concurrent))*\.only(?:\.each)?\s*\(/, /(?<![\w$.])f(?:it|describe)\s*\(\s*['"`]/];
const DEBUGGER = /^\s*debugger\s*;?\s*$/;
const MARKER_START = /^<{7}(?: |$)/;
const MARKER_BASE = /^\|{7}(?: |$)/;
const MARKER_SEP = /^={7}$/;
const MARKER_END = /^>{7}(?: |$)/;
/** Test files by their path (files outside the analysis have no kind). */
const TEST_PATH_RE = /(^|\/)(__tests__|tests?|specs?|e2e|cypress|playwright)\/|\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/i;
const MAX_TEXT = 120;
/** Findings per file and in total (a pasted conflict can add hundreds of markers). */
const MAX_PER_FILE = 20;
const MAX_TOTAL = 200;

const RULE_OF: Record<HygieneKind, string> = {
  'focused-test': RULE_IDS.focusedTest,
  debugger: RULE_IDS.debuggerStatement,
  'conflict-marker': RULE_IDS.conflictMarker,
};
const LABEL: Record<HygieneKind, string> = {
  'focused-test': 'Focused test',
  debugger: '`debugger` statement',
  'conflict-marker': 'Merge conflict marker',
};

/** Lines a unified diff adds, with their line numbers in the new version. */
export function addedLines(diff: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let next = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      next = Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('+')) out.push({ line: next++, text: line.slice(1) });
    else if (line.startsWith(' ')) next++;
    // '-' (removed) and '\ No newline at end of file' do not move the new side.
  }
  return out;
}

const isComment = (text: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(text);

/**
 * The code of one line: the contents of string and template literals blanked (the quotes stay), block
 * comments blanked and a trailing `//` comment cut. `expect(lint('it.only(x)'))` has no focused test.
 */
export function codeOf(line: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') {
        out += i + 1 < line.length ? '  ' : ' ';
        i++;
      } else if (ch === quote) {
        quote = undefined;
        out += ch;
      } else out += ' ';
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      const stop = end < 0 ? line.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

/**
 * Conflict markers that form a complete block among the added lines (`<<<<<<<`, optionally `|||||||`,
 * `=======`, `>>>>>>>`, in this order): a lone `=======` is a Markdown heading underline, and a line that
 * merely starts with `<<<<<<<` (docs about git) is not a conflict either.
 */
function conflictBlocks(lines: { line: number; text: string }[]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let open: { line: number; text: string }[] | undefined;
  let separated = false;
  for (const l of lines) {
    if (MARKER_START.test(l.text)) {
      open = [l];
      separated = false;
    } else if (open && !separated && MARKER_BASE.test(l.text)) open.push(l);
    else if (open && MARKER_SEP.test(l.text)) {
      open.push(l);
      separated = true;
    } else if (open && separated && MARKER_END.test(l.text)) {
      out.push(...open, l);
      open = undefined;
    }
  }
  return out;
}

/** The hygiene findings in the added lines of one changed file. */
function scanFile(file: ChangedFile, kinds: Set<HygieneKind>, isTest: (id: string) => boolean): HygieneFinding[] {
  if (!file.diff || file.status === 'deleted') return [];
  const lines = addedLines(file.diff);
  // Files that hold JavaScript: `debugger` and focused tests only count there.
  const script = SOURCE_FILE_RE.test(file.id);
  const test = script && (isTest(file.id) || TEST_PATH_RE.test(file.id));
  const found: HygieneFinding[] = [];
  const add = (kind: HygieneKind, l: { line: number; text: string }): void => {
    const text = l.text.trim();
    found.push({ file: file.id, line: l.line, kind, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text });
  };
  const markers = kinds.has('conflict-marker') ? new Set(conflictBlocks(lines)) : new Set<{ line: number; text: string }>();
  for (const l of lines) {
    if (found.length >= MAX_PER_FILE) break;
    if (markers.has(l)) {
      add('conflict-marker', l);
      continue;
    }
    if (!script || isComment(l.text)) continue;
    const code = codeOf(l.text);
    if (kinds.has('debugger') && DEBUGGER.test(code)) add('debugger', l);
    else if (kinds.has('focused-test') && test && FOCUSED.some((re) => re.test(code))) add('focused-test', l);
  }
  return found.sort((a, b) => a.line - b.line);
}

export interface HygieneOptions {
  /** Kinds to look for (default: all). */
  kinds?: readonly HygieneKind[];
  /** Whether a project file is a test (e.g. its analyzed kind); test paths are recognised anyway. */
  isTest?: (file: string) => boolean;
}

/** Focused tests, `debugger` statements and conflict markers on the lines your change adds. */
export function hygieneFindings(files: readonly ChangedFile[] | undefined, options: HygieneOptions = {}): HygieneFinding[] {
  const kinds = new Set(options.kinds ?? HYGIENE_KINDS);
  const isTest = options.isTest ?? (() => false);
  const out: HygieneFinding[] = [];
  for (const file of files ?? []) {
    if (out.length >= MAX_TOTAL) break;
    out.push(...scanFile(file, kinds, isTest));
  }
  return out.slice(0, MAX_TOTAL);
}

/** The kinds `check.hygiene` turns on (`true` / undefined: all; `false`: none). */
export function hygieneKinds(setting: HygieneSetting | undefined): HygieneKind[] {
  if (setting === false) return [];
  if (setting === undefined || setting === true) return [...HYGIENE_KINDS];
  return Array.isArray(setting) ? setting : setting.kinds;
}

/** Paths `check.hygiene.exclude` leaves out (gitignore-style patterns). */
export function hygieneExclude(setting: HygieneSetting | undefined): string[] {
  return setting && typeof setting === 'object' && !Array.isArray(setting) ? setting.exclude : [];
}

export function hygieneFinding(h: HygieneFinding): Finding {
  const ruleId = RULE_OF[h.kind];
  return {
    ruleId,
    gate: 'hygiene',
    file: h.file,
    line: h.line,
    message: `${LABEL[h.kind]}: ${h.text}`,
    severity: 'error',
    subject: `${h.kind}|${h.text}`,
    // No line number: the same statement moving down a few lines stays the same finding.
    fingerprint: fingerprint(ruleId, h.file, h.text),
    // Added lines are new by definition.
    status: 'new',
  };
}

function testFiles(data: Pick<ReportData, 'files'>): (file: string) => boolean {
  const tests = new Set(data.files.filter((f) => f.kind === 'test').map((f) => f.id));
  return (file) => tests.has(file);
}

/**
 * The changed files the analysis covers: source files it analyzed (so `exclude`, ignored folders and
 * `--file` / `--directory` apply), other text files inside a `--directory` scope; minus
 * `check.hygiene.exclude`.
 */
function coveredFiles(data: Pick<ReportData, 'files' | 'scope' | 'changes'>, exclude: string[]): ChangedFile[] {
  const analyzed = new Set(data.files.map((f) => f.id));
  const scope = data.scope;
  const skip = exclude.length ? ignore().add(exclude) : undefined;
  return (data.changes?.files ?? []).filter((f) => {
    if (skip?.ignores(f.id)) return false;
    if (SOURCE_FILE_RE.test(f.id)) return f.analyzed && analyzed.has(f.id);
    if (scope.type === 'file') return false;
    return scope.type !== 'directory' || !scope.path || f.id.startsWith(`${scope.path}/`);
  });
}

/**
 * The hygiene gate. It judges the lines your change adds, so it runs wherever `data.changes` carries
 * diffs: always shown when comparing with a base (`--staged`, `--changed`, `--new-since`), and in a full
 * check (whose changes are your branch or uncommitted work) only when it finds something.
 * `"check": { "hygiene": false }` turns it off.
 */
export const hygieneGate: GateProvider = (data, ctx) => {
  const setting = ctx.thresholds.hygiene;
  const kinds = hygieneKinds(setting);
  if (!kinds.length || !data.changes?.files.length) return undefined;
  const files = coveredFiles(data, hygieneExclude(setting)).filter((f) => ctx.inScope(f.id));
  const found = hygieneFindings(files, { kinds, isTest: testFiles(data) });
  const comparing = ctx.mode === 'changed' || ctx.mode === 'new-since' || ctx.mode === 'staged';
  if (!found.length && !comparing) return undefined;
  const what = kinds.length === HYGIENE_KINDS.length ? 'no focused tests, debugger statements or conflict markers' : `no ${kinds.map((k) => LABEL[k].replace(/`/g, '').toLowerCase()).join(', ')}`;
  return {
    id: 'hygiene',
    label: 'Hygiene',
    ok: found.length === 0,
    detail: found.length ? `${found.length} in the lines you added` : `${what} in the lines you added`,
    findings: found.map(hygieneFinding),
    ruleIds: kinds.map((k) => RULE_OF[k]),
    // Added lines are new by definition: the gate fails on any finding, in every mode.
    newOnly: false,
  };
};
