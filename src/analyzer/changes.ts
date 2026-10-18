import ts from 'typescript';
import { impactOf, testEvidence, type QueryTarget } from '../shared/query.js';
import { buildTestCommand, type TestRunners } from '../shared/testcmd.js';
import { cloneDrift } from '../shared/clones.js';
import { COMPONENT_FILE_RE } from '../shared/source-files.js';
import type { ApiCall, ChangedFile, ChangedSymbol, ChangeSet, CloneFamily, DependencyEdge, FileInfo, HotspotInfo, RouteInfo, SymbolEdge, SymbolInfo } from '../shared/types.js';
import type { RawChanges } from './git.js';
import type { CodeOwners } from './owners.js';
import { isTestableSource, testCommand, type TestMap, type TestRunner } from './tests.js';

const DAY = 24 * 3600 * 1000;
const BOT_RE = /\[bot\]|dependabot|renovate|github-actions|semantic-release/i;

interface Input {
  raw: RawChanges;
  files: FileInfo[];
  edges: DependencyEdge[];
  symbolEdges: SymbolEdge[];
  routes: RouteInfo[];
  /** HTTP calls (tests requesting a handler's route count as testing it, as in My changes and `pr`). */
  apiCalls?: ApiCall[];
  hotspots: HotspotInfo[];
  testMap: TestMap;
  runners: { unit?: TestRunner; e2e?: TestRunner };
  /** Runners per workspace (`ProjectInfo.testRunners`); preferred over `runners` when given. */
  testRunners?: TestRunners;
  /** Current text of a changed file, to tell comment-only edits from code edits. */
  fileText?: (id: string) => string | undefined;
  /**
   * What earlier analyses found in each diff (`AnalyzeCache.codeChanges`), by `memoKey` — the identity of a
   * changed file's content and diff — so a re-analysis classifies only the files edited since.
   */
  memo?: Map<string, CodeChange | null>;
  memoKey?: (file: ChangedFile) => string | undefined;
  /** Code lines of a file's current text (memoized by the caller), see `codeLinesFor`. */
  codeLinesOf?: (id: string, text: string) => Set<number>;
  owners?: CodeOwners;
  /** Your author name in the history (never suggested as your own reviewer). */
  user?: string;
  /** Your `git config user.email`; preferred over the name to recognise you. */
  userEmail?: string;
  // --- clone-radar ---
  /** Clone families of the analysis: edits to one copy that leave the others alone are clone drift. */
  clones?: CloneFamily[];
  /** Copies need this similarity to drift (`clones.minSimilarity`). */
  cloneMinSimilarity?: number;
}

/** The sorted `lines` from `start` to `end` (binary search: a new file has every line changed). */
function linesWithin(lines: readonly number[], start: number, end: number): number[] {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  const out: number[] = [];
  for (let i = lo; i < lines.length && lines[i] <= end; i++) out.push(lines[i]);
  return out;
}

/** Map changed line numbers onto the symbols (and class methods) that contain them. */
function changedSymbols(file: FileInfo, changedLines: number[], usedBy: (s: SymbolInfo, memberName?: string) => number): ChangedSymbol[] {
  if (!changedLines.length) return [];
  const lines = [...changedLines].sort((a, b) => a - b);
  const result: ChangedSymbol[] = [];
  const sorted = [...file.symbols].sort((a, b) => a.line - b.line);
  for (const s of sorted) {
    const hits = linesWithin(lines, s.line, s.endLine);
    if (!hits.length) continue;
    if (s.kind === 'class' && s.members?.length) {
      const members = [...s.members].filter((m) => m.kind === 'method' || m.kind === 'constructor' || m.kind === 'getter' || m.kind === 'setter').sort((a, b) => a.line - b.line);
      let matchedMember = false;
      for (let i = 0; i < members.length; i++) {
        const start = members[i].line;
        const end = i + 1 < members.length ? members[i + 1].line - 1 : s.endLine;
        if (hits.some((l) => l >= start && l <= end)) {
          matchedMember = true;
          result.push({ id: `${s.id}.${members[i].name}`, file: file.id, name: `${s.name}.${members[i].name}`, kind: 'method', exported: s.exported, usedBy: usedBy(s, members[i].name) });
        }
      }
      if (matchedMember) continue;
    }
    result.push({ id: s.id, file: file.id, name: s.name, kind: s.kind, exported: s.exported, usedBy: usedBy(s) });
  }
  return result;
}

/* ----------------------------- Code vs. trivia ----------------------------- */

/** Tokens after which a `/` starts a division, not a regular expression. */
const VALUE_END = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
]);

const TRIVIA = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.ShebangTrivia,
]);

/**
 * 1-based lines of `text` that hold code: any token that is not whitespace or a comment. Template
 * literals and regular expressions are re-scanned the way the parser does, so a `//` inside them does
 * not hide code.
 */
export function codeLines(text: string, jsx = true): Set<number> {
  const lineAt = lineIndex(text);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  const lines = new Set<number>();
  const templates: number[] = [];
  let braces = 0;
  let prev: ts.SyntaxKind | undefined;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (TRIVIA.has(kind)) continue;
    if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && (prev === undefined || !VALUE_END.has(prev))) kind = scanner.reScanSlashToken();
    else if (kind === ts.SyntaxKind.TemplateHead) templates.push(braces);
    else if (kind === ts.SyntaxKind.OpenBraceToken) braces++;
    else if (kind === ts.SyntaxKind.CloseBraceToken) {
      if (templates.length && templates[templates.length - 1] === braces) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
      } else braces--;
    }
    const first = lineAt(scanner.getTokenStart());
    const last = lineAt(Math.max(scanner.getTokenStart(), scanner.getTokenEnd() - 1));
    for (let l = first; l <= last; l++) lines.add(l);
    prev = kind;
  }
  return lines;
}

/** 1-based line of a character offset in `text`. */
function lineIndex(text: string): (pos: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Code lines of a JSX / TSX file, from the parsed tokens: text between JSX tags is code even when it
 * starts with `//` or contains `/*` (the scanner alone cannot tell), and `{/* … *\/}` holds only a comment.
 */
function parsedCodeLines(text: string, kind: ts.ScriptKind): Set<number> {
  const sf = ts.createSourceFile('changed.tsx', text, ts.ScriptTarget.Latest, true, kind);
  const lineAt = lineIndex(text);
  const lines = new Set<number>();
  const visit = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isJsxExpression(n) && !n.expression) return;
    if (ts.isJsxText(n)) {
      const first = lineAt(n.pos);
      text.slice(n.pos, n.end).split('\n').forEach((t, i) => t.trim() && lines.add(first + i));
      return;
    }
    const children = n.getChildren(sf);
    if (!children.length) {
      if (n.kind === ts.SyntaxKind.EndOfFileToken) return;
      const start = n.getStart(sf);
      for (let l = lineAt(start), last = lineAt(Math.max(start, n.end - 1)); l <= last; l++) lines.add(l);
      return;
    }
    children.forEach(visit);
  };
  visit(sf);
  return lines;
}

/**
 * Code lines of a Vue / Svelte / Astro file: script blocks (and Astro frontmatter) are scanned as code;
 * markup and styles count everywhere outside `<!-- -->` and CSS comments.
 */
function markupCodeLines(text: string): Set<number> {
  const lineAt = lineIndex(text);
  const lines = new Set<number>();
  const blocks: { start: number; content: string; jsx: boolean }[] = [];
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) blocks.push({ start: front[0].indexOf('\n') + 1, content: front[1], jsx: false });
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    blocks.push({ start: m.index! + m[0].indexOf('>') + 1, content: m[2], jsx: /\blang=["']?(tsx|jsx)\b/i.test(m[1]) });
  }
  const chars = text.split('');
  for (const b of blocks) {
    const offset = lineAt(b.start) - 1;
    for (const l of codeLines(b.content, b.jsx)) lines.add(l + offset);
    for (let i = b.start; i < b.start + b.content.length; i++) if (chars[i] !== '\n') chars[i] = ' ';
  }
  const masked = chars.join('');
  const styles = [...masked.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => {
    const start = m.index! + m[0].indexOf('>') + 1;
    return [start, start + m[1].length] as const;
  });
  for (let i = 0; i < masked.length; i++) {
    if (masked.startsWith('<!--', i) || (masked.startsWith('/*', i) && styles.some(([a, b]) => i >= a && i < b))) {
      const close = masked.startsWith('<!--', i) ? '-->' : '*/';
      const end = masked.indexOf(close, i + 2);
      i = end === -1 ? masked.length : end + close.length - 1;
      continue;
    }
    if (masked.charCodeAt(i) > 32) lines.add(lineAt(i));
  }
  return lines;
}

/** Code lines of a file, by its type (see `codeLines`). */
export function codeLinesFor(id: string, text: string): Set<number> {
  if (COMPONENT_FILE_RE.test(id)) return markupCodeLines(text);
  if (/\.tsx$/.test(id)) return parsedCodeLines(text, ts.ScriptKind.TSX);
  if (/\.[cm]?jsx?$/.test(id)) return parsedCodeLines(text, ts.ScriptKind.JSX);
  return codeLines(text, false);
}

interface Hunk {
  oldStart: number;
  newStart: number;
  newCount: number;
  lines: { type: ' ' | '+' | '-'; text: string }[];
}

function parseHunks(diff: string): Hunk[] | undefined {
  if (diff.includes('\n… diff truncated …')) return undefined;
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  for (const line of diff.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      hunk = { oldStart: Number(header[1]), newStart: Number(header[2]), newCount: header[3] === undefined ? 1 : Number(header[3]), lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('diff --git')) break;
    const type = line[0];
    if (type === ' ' || type === '+' || type === '-') hunk.lines.push({ type, text: line.slice(1) });
  }
  return hunks;
}

/** What a file's diff changed: code lines (new numbering), or only trivia. */
export interface CodeChange {
  /**
   * Lines of real (non-comment, non-blank) changes. A replaced line counts at its replacement; a plain
   * removal is anchored at the line before it.
   */
  lines: number[];
  /** Plain removals (not replaced by new lines), as the new lines they sit between (`[before, after]`). */
  removals: [number, number][];
  /** Every change is in comments or whitespace. */
  triviaOnly: boolean;
}

/**
 * Classify a modified file's hunks as code or trivia, by re-building the old text from the new text and
 * the diff and scanning both. Undefined when that is not possible (no diff, a truncated diff, a text
 * that does not match the diff).
 */
export function codeChange(file: Pick<ChangedFile, 'id' | 'diff'>, newText: string | undefined, codeLinesOf: (id: string, text: string) => Set<number> = codeLinesFor): CodeChange | undefined {
  if (!file.diff || newText === undefined) return undefined;
  const hunks = parseHunks(file.diff);
  // No hunks (a pure rename, a mode change): there is nothing to classify, and it is not "comment-only".
  if (!hunks?.length) return undefined;
  const newLines = newText.split('\n');
  const same = (a: string | undefined, b: string): boolean => a !== undefined && a.replace(/\r$/, '') === b.replace(/\r$/, '');
  const old: string[] = [];
  const added: number[] = [];
  const removed: { oldLine: number; before: number; replacedAt?: number }[] = [];
  let pending: typeof removed = [];
  let n = 1;
  for (const h of hunks) {
    const until = h.newCount === 0 ? h.newStart : h.newStart - 1;
    while (n <= until) old.push(newLines[n++ - 1] ?? '');
    pending = [];
    for (const l of h.lines) {
      if (l.type === '-') {
        old.push(l.text);
        const r = { oldLine: old.length, before: n - 1 };
        removed.push(r);
        pending.push(r);
        continue;
      }
      if (!same(newLines[n - 1], l.text)) return undefined;
      if (l.type === ' ') old.push(l.text);
      else {
        added.push(n);
        // Lines removed right before new ones were replaced by them.
        for (const r of pending) r.replacedAt = n;
      }
      pending = [];
      n++;
    }
  }
  while (n <= newLines.length) old.push(newLines[n++ - 1]);
  const newCode = codeLinesOf(file.id, newText);
  const oldCode = codeLinesFor(file.id, old.join('\n'));
  const lines = new Set<number>();
  const removals: [number, number][] = [];
  for (const l of added) if (newCode.has(l)) lines.add(l);
  for (const r of removed) {
    if (!oldCode.has(r.oldLine)) continue;
    if (r.replacedAt !== undefined) {
      lines.add(r.replacedAt);
      continue;
    }
    lines.add(Math.max(1, r.before));
    removals.push([r.before, r.before + 1]);
  }
  return { lines: [...lines].sort((a, b) => a - b), removals, triviaOnly: lines.size === 0 };
}

/** Imports of `file` that name exports it no longer has (a renamed, removed or un-exported declaration). */
function hasStaleImports(file: FileInfo, importers: DependencyEdge[]): boolean {
  const exported = new Set(file.exports.map((e) => e.name));
  if (file.exports.some((e) => e.isDefault)) exported.add('default');
  const open = file.exports.some((e) => e.name === '*'); // `export * from`: names are not listed
  return importers.some((e) => e.names.some((n) => n !== '*' && !exported.has(n) && !open));
}

/** Whether every changed line (and removal) lies inside one of the file's declarations. */
function insideSymbols(file: FileInfo, lines: number[], removals: [number, number][]): boolean {
  const within = (l: number): boolean => file.symbols.some((s) => l >= s.line && l <= s.endLine);
  const between = ([a, b]: [number, number]): boolean => file.symbols.some((s) => a >= s.line && b <= s.endLine);
  return lines.length > 0 && removals.every(between) && lines.filter((l) => !removals.some((r) => r[0] === l)).every(within);
}

interface CodeChanges {
  /** Files whose edits are only comments or blank lines. */
  commentOnly: Set<string>;
  /** Changed code lines per file (the git lines when the diff could not be classified). */
  lines: Map<string, number[]>;
  /** Plain removals per file (see `CodeChange.removals`). */
  removals: Map<string, [number, number][]>;
}

/** Entries a memo keeps beyond the files of the current change (other branches, the staged index). */
const MEMO_SPARE = 2000;

/**
 * What each file's diff changed in code (comment and blank-line edits do not count). With a memo, a
 * file whose content and diff were classified before is not parsed again.
 */
function classifyChanges(changed: ChangedFile[], input: Pick<Input, 'fileText' | 'memo' | 'memoKey' | 'codeLinesOf'>): CodeChanges {
  const result: CodeChanges = { commentOnly: new Set(), lines: new Map(), removals: new Map() };
  const { memo } = input;
  const used = new Set<string>();
  for (const c of changed) {
    // A renamed file changes every import of it, whatever its content does.
    let cc: CodeChange | undefined;
    if (c.status === 'modified' && c.diff) {
      const key = memo && input.memoKey?.(c);
      const known = key ? memo!.get(key) : undefined;
      if (known !== undefined) cc = known ?? undefined;
      else {
        cc = codeChange(c, input.fileText?.(c.id), input.codeLinesOf);
        if (key) memo!.set(key, cc ?? null);
      }
      if (key) used.add(key);
    }
    if (cc?.triviaOnly) result.commentOnly.add(c.id);
    result.lines.set(c.id, cc ? cc.lines : c.lines);
    result.removals.set(c.id, cc?.removals ?? []);
  }
  if (memo && memo.size > used.size + MEMO_SPARE) for (const key of memo.keys()) if (!used.has(key)) memo.delete(key);
  return result;
}

/**
 * What to measure the impact of: edits inside declarations count as those declarations (symbol-precise:
 * only their importers and callers are affected); anything else (module-level code, new files, a renamed
 * export that is still imported) counts as the whole file.
 */
function impactTargets(codeChanged: ChangedFile[], byId: Map<string, FileInfo>, edges: DependencyEdge[], code: CodeChanges, symbolsByFile: Map<string, ChangedSymbol[]>): QueryTarget[] {
  const importersOf = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    const list = importersOf.get(e.target);
    if (list) list.push(e);
    else importersOf.set(e.target, [e]);
  }
  const targets: QueryTarget[] = [];
  for (const c of codeChanged) {
    const file = byId.get(c.id)!;
    const isNew = c.status === 'added' || c.status === 'untracked' || c.status === 'renamed';
    const precise = !isNew && insideSymbols(file, code.lines.get(c.id)!, code.removals.get(c.id)!) && !hasStaleImports(file, importersOf.get(c.id) ?? []);
    if (precise) for (const s of symbolsByFile.get(c.id) ?? []) targets.push({ type: 'symbol', id: s.id });
    else targets.push({ type: 'file', id: c.id });
  }
  return targets;
}

/** The folder of a file, at most two levels deep: what the change risk counts as an area. */
export function areaOf(id: string): string {
  const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.';
  return dir.split('/').slice(0, 2).join('/');
}

export function buildChangeSet(input: Input): ChangeSet {
  const { raw, files, edges, symbolEdges, routes, testMap, runners, owners, user, userEmail } = input;
  const myEmail = userEmail?.toLowerCase();
  const isMe = (a: { name: string; email?: string }): boolean => (!!myEmail && a.email?.toLowerCase() === myEmail) || a.name === user;
  const byId = new Map(files.map((f) => [f.id, f]));
  const changed = raw.files.filter((f) => f.analyzed && f.status !== 'deleted' && byId.has(f.id));
  const changedIds = new Set(changed.map((f) => f.id));

  const code = classifyChanges(changed, input);
  const { commentOnly } = code;
  const codeChanged = changed.filter((c) => !commentOnly.has(c.id));

  // Changed symbols and how widely they are used.
  const symIn = new Map<string, number>();
  for (const e of symbolEdges) symIn.set(e.target, (symIn.get(e.target) ?? 0) + 1);
  const importers = new Map<string, Map<string, number>>();
  for (const e of edges) {
    let m = importers.get(e.target);
    if (!m) importers.set(e.target, (m = new Map()));
    for (const n of e.names) m.set(n, (m.get(n) ?? 0) + 1);
  }
  const usedBy = (file: FileInfo) => (s: SymbolInfo, member?: string): number => {
    if (member) return symIn.get(`${s.id}.${member}`) ?? 0;
    const names = importers.get(file.id);
    const viaImport = (names?.get(s.isDefault ? 'default' : s.name) ?? 0) + (names?.get('*') ?? 0);
    return (symIn.get(s.id) ?? 0) + viaImport;
  };
  const symbolsByFile = new Map<string, ChangedSymbol[]>();
  for (const c of codeChanged) {
    const file = byId.get(c.id)!;
    symbolsByFile.set(c.id, changedSymbols(file, code.lines.get(c.id)!, usedBy(file)));
  }
  const symbols = [...symbolsByFile.values()]
    .flat()
    .sort((a, b) => b.usedBy - a.usedBy)
    .slice(0, 400);

  const targets = impactTargets(codeChanged, byId, edges, code, symbolsByFile);
  const impact = targets.length ? impactOf({ files, edges, symbolEdges, routes }, targets, { depth: Infinity }) : undefined;
  const impacted = new Set((impact?.byDepth ?? []).flatMap((d) => d.files).filter((id) => !changedIds.has(id)));
  const impactedRoutes = (impact?.routes ?? []).map((r) => r.id);
  const precision = impact?.precision ?? 'symbol';

  // Review clusters: changed files connected through imports.
  const parent = new Map<string, string>([...changedIds].map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) {
    if (changedIds.has(e.source) && changedIds.has(e.target)) parent.set(find(e.source), find(e.target));
  }
  const groups = new Map<string, string[]>();
  for (const id of changedIds) {
    const r = find(id);
    const list = groups.get(r) ?? [];
    list.push(id);
    groups.set(r, list);
  }
  const clusters = [...groups.values()].map((g) => g.sort()).sort((a, b) => b.length - a.length);

  // Tests to run.
  const testSet = new Set<string>();
  const changedTests: string[] = [];
  for (const id of changedIds) {
    const f = byId.get(id)!;
    if (f.kind === 'test') changedTests.push(id);
    if (commentOnly.has(id)) continue;
    if (f.kind === 'test') testSet.add(id);
    for (const t of testMap.coveredBy.get(id) ?? []) testSet.add(t);
  }
  const testFiles = [...testSet].sort();
  const command = input.testRunners ? buildTestCommand(testFiles, input.testRunners) : testCommand(testFiles, runners);

  // Suggested reviewers: people who know the changed files, weighted by recency.
  const now = Date.now();
  const scores = new Map<string, { score: number; files: Set<string>; last: number }>();
  for (const c of changed) {
    const g = byId.get(c.id)?.git;
    if (!g) continue;
    for (const a of g.authors) {
      if (isMe(a) || BOT_RE.test(a.name)) continue;
      const recency = Math.exp(-(now - a.last) / (150 * DAY));
      const entry = scores.get(a.name) ?? { score: 0, files: new Set<string>(), last: 0 };
      entry.score += (a.commits / g.commits) * (0.3 + 0.7 * recency);
      entry.files.add(c.id);
      entry.last = Math.max(entry.last, a.last);
      scores.set(a.name, entry);
    }
  }
  const reviewers = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 5)
    .map(([name, v]) => ({ name, score: Math.round(v.score * 100) / 100, files: v.files.size, last: v.last }));

  const ownerMap = new Map<string, string[]>();
  if (owners) {
    for (const c of raw.files) {
      for (const o of owners.ownersOf(c.id) ?? []) {
        const list = ownerMap.get(o) ?? [];
        list.push(c.id);
        ownerMap.set(o, list);
      }
    }
  }

  // Risk score.
  const additions = raw.files.reduce((n, f) => n + f.additions, 0);
  const deletions = raw.files.reduce((n, f) => n + f.deletions, 0);
  const factors: { label: string; points: number }[] = [];
  const add = (label: string, points: number): void => {
    const p = Math.round(points);
    if (p > 0) factors.push({ label, points: p });
  };
  const lines = additions + deletions;
  add(`${lines.toLocaleString('en-US')} line${lines === 1 ? '' : 's'} changed`, Math.min(25, 8 * Math.log10(1 + lines)));
  // An area is a file's folder, at most two levels deep (`lib`, `src/analyzer`; `.` for the root).
  const areas = new Set(changed.map((c) => areaOf(c.id)));
  add(`${changed.length} source file${changed.length === 1 ? '' : 's'} in ${areas.size} area${areas.size === 1 ? '' : 's'}`, Math.min(15, changed.length * 0.8 + areas.size * 2));
  const sourceCount = files.filter(isTestableSource).length || 1;
  if (impacted.size) {
    // Absolute reach matters more than the ratio: small projects shouldn't look scary for every change.
    const what = precision === 'symbol' ? 'the changed symbols' : 'the changed files';
    add(`${impacted.size} other file${impacted.size === 1 ? ' depends' : 's depend'} on ${what}`, Math.min(20, 3 * Math.log2(1 + impacted.size) + (impacted.size / sourceCount) * 10 + Math.min(3, impactedRoutes.length * 0.5)));
  }
  const maxCx = Math.max(0, ...symbols.map((s) => {
    const f = byId.get(s.file);
    const sym = f?.symbols.find((x) => x.id === s.id);
    return sym?.complexity ?? 0;
  }));
  if (maxCx > 10) add(`touches a function with complexity ${maxCx}`, maxCx > 25 ? 15 : maxCx > 15 ? 10 : 6);
  const hot = new Set(input.hotspots.slice(0, 10).map((h) => h.file));
  const hotTouched = codeChanged.filter((c) => hot.has(c.id)).length;
  if (hotTouched) add(`${hotTouched} hotspot file${hotTouched === 1 ? '' : 's'}`, Math.min(10, hotTouched * 4));
  // The rule My changes, `pr` and the live guard use (query.testEvidence): a test imports the file, requests or
  // visits a route whose code uses it, or the coverage report saw its lines run.
  const evidence = { files, routes, apiCalls: input.apiCalls, edges };
  const untested = codeChanged.filter((c) => {
    const f = byId.get(c.id)!;
    return isTestableSource(f) && !testEvidence(evidence, f);
  });
  if (untested.length && testMap.testFiles.length) add(`${untested.length} changed file${untested.length === 1 ? ' has' : 's have'} no tests`, Math.min(12, untested.length * 3));
  else if (untested.length) add('the project has no tests', 6);
  if (codeChanged.some((c) => byId.get(c.id)?.inCycle)) add('changes files inside a dependency cycle', 5);
  // Exports of added or untracked files are new, not modified APIs (as review_changes and the reading order say).
  const newFiles = new Set(changed.filter((c) => c.status === 'added' || c.status === 'untracked').map((c) => c.id));
  const api = symbols.filter((s) => s.exported && s.usedBy >= 5 && !newFiles.has(s.file)).length;
  if (api) add(`${api} widely used export${api === 1 ? '' : 's'} modified`, Math.min(10, api * 3));
  const score = Math.min(100, factors.reduce((n, f) => n + f.points, 0));

  // --- clone-radar: an edited copy whose clones were left as they were ---
  const drift = cloneDrift(input.clones, changed, [...commentOnly], input.cloneMinSimilarity);

  return {
    mode: raw.mode,
    base: raw.base,
    baseCommit: raw.baseCommit,
    files: raw.files,
    additions,
    deletions,
    commits: raw.commits,
    symbols,
    impacted: [...impacted].slice(0, 3000),
    impactedRoutes,
    clusters,
    tests: { files: testFiles, command: command.command, runner: command.runner, changedTests },
    reviewers,
    owners: [...ownerMap.entries()].map(([owner, list]) => ({ owner, files: list })),
    risk: { score, level: score < 30 ? 'low' : score < 60 ? 'medium' : 'high', factors: factors.sort((a, b) => b.points - a.points) },
    impactPrecision: precision,
    commentOnly: commentOnly.size ? [...commentOnly].sort() : undefined,
    ...(drift.length ? { cloneDrift: drift } : {}),
  };
}
