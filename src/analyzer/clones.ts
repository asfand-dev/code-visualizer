/**
 * Clone and reuse radar: copy-paste code found through a token index over the parse results.
 *
 * - Every source file is tokenized once with the TypeScript scanner (cached with its parse result):
 *   identifiers (and contextual keywords such as `type`, which can be names) become `I`, string / number /
 *   template / regex literals `L`, other keywords and punctuation stay; import and export-from statements
 *   are left out. Vue / Svelte / Astro files contribute their script blocks, with the file's line numbers.
 * - Matching: Rabin-Karp hashes of every 20-token window, thinned by winnowing (each run of 11 windows
 *   keeps its smallest hash, so any common run of 30 tokens shares a fingerprint). Each declaration is
 *   fingerprinted on its own, so code next to it never changes what is found in it; a file's fingerprints are
 *   memoized with its tokens. Equal fingerprints are verified token by token and extended to the maximal
 *   match; boilerplate hashes (found in more than 50 declarations) are skipped. Pairs between files that did
 *   not change are kept from the last run (`CloneCache`).
 * - A copy belongs to one declaration (class members on their own, module-level code on its own): matches
 *   are cut where either side enters another declaration, so a copy never runs into its neighbour. Parts
 *   between the same two declarations a few tokens apart are chained (near-miss clone: a copy with a small
 *   edit stays one), and a few lines apart merged.
 * - A copy counts with ≥ `minTokens` shared tokens over ≥ `minLines` lines on both sides, when it looks
 *   like logic rather than data (keywords and operators, varied token sequences), not inside one
 *   declaration and not between two test files. Each pair's similarity is the share of the larger of its
 *   two declarations that is copied. Copies are grouped into families (union-find); `minSimilarity` decides
 *   which pairs count for the gate, drift and health.
 *
 * Also here: `findSimilar` (is there already code like this snippet?), the `check --max-new-clones`
 * gate, the live `clone-added` event and a token store for commands that only have a ReportData.
 * The TypeScript compiler is loaded on first tokenization only, so importing this module stays cheap.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ignore from 'ignore';
import type TypeScript from 'typescript';
import { cloneFingerprint, cloneSides, DEFAULT_MIN_SIMILARITY, fragmentKey, fragmentLocation, newCloneMessage, pastedClones, significantCopies } from '../shared/clones.js';
import { fingerprint, RULE_IDS } from '../shared/fingerprint.js';
import { isCallable, signature } from '../shared/signature.js';
import type { ChangeCoupling, CloneFamily, CloneFragment, ClonePair, DependencyEdge, FileInfo, Finding, ReportData, SimilarMatch, SymbolInfo } from '../shared/types.js';
import type { GateProvider } from './gates.js';
import type { AnalyzeCache } from './index.js';
import type { LiveCandidate, LiveDetector } from './live-events.js';

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

/** The `clones` block of the configuration (see src/analyzer/config.ts). */
export interface CloneSettings {
  /** Shared tokens a clone needs (default 50). */
  minTokens: number;
  /** Lines each copy needs (default 6). */
  minLines: number;
  /** Files left out of clone detection (gitignore-style globs). */
  ignore: string[];
  /**
   * 0..1: the share of its declaration a copy needs to count for the gate, `pr`, `serve`, clone drift and
   * the Duplication health score (default 0.5). Smaller shared blocks are listed in Insights only.
   */
  minSimilarity: number;
}

export const DEFAULT_CLONE_SETTINGS: CloneSettings = { minTokens: 50, minLines: 6, ignore: [], minSimilarity: DEFAULT_MIN_SIMILARITY };

/** The settings from the configuration's `clones` block, or undefined when it turns detection off. */
export function cloneSettings(config: { enabled?: boolean; minTokens?: number; minLines?: number; ignore?: string[]; minSimilarity?: number } | undefined): CloneSettings | undefined {
  if (config?.enabled === false) return undefined;
  return {
    minTokens: Math.max(MIN_SEGMENT, Math.round(config?.minTokens ?? DEFAULT_CLONE_SETTINGS.minTokens)),
    minLines: Math.max(1, Math.round(config?.minLines ?? DEFAULT_CLONE_SETTINGS.minLines)),
    ignore: config?.ignore ?? [],
    minSimilarity: Math.min(1, Math.max(0, config?.minSimilarity ?? DEFAULT_MIN_SIMILARITY)),
  };
}

/** Families kept in `insights.clones` (the report stays small; health and drift see all of them). */
export const MAX_FAMILIES = 1000;

/* -------------------------------------------------------------------------- */
/*                                  Tokenizer                                 */
/* -------------------------------------------------------------------------- */

/** A file as clone detection sees it: normalized token kinds and the line of each token. */
export interface CloneTokens {
  /** `1` identifier, `2` literal, `0` a barrier between script blocks, otherwise the TypeScript SyntaxKind. */
  kinds: Uint8Array;
  /** 1-based line of each token. */
  lines: Uint32Array;
}

const BARRIER = 0;
const IDENT = 1;
const LITERAL = 2;
const UNKNOWN = 3;

const requireModule = createRequire(import.meta.url);
let compiler: typeof TypeScript | undefined;
/** The TypeScript compiler, loaded on first use (gates and the MCP tool list import this module without it). */
function typescript(): typeof TypeScript {
  return (compiler ??= requireModule('typescript') as typeof TypeScript);
}

interface KindTable {
  eof: number;
  slash: number;
  slashEquals: number;
  templateHead: number;
  templateTail: number;
  openBrace: number;
  closeBrace: number;
  openParen: number;
  closeParen: number;
  semicolon: number;
  dot: number;
  questionDot: number;
  asterisk: number;
  string: number;
  importKw: number;
  exportKw: number;
  fromKw: number;
  typeKw: number;
  identifiers: Set<number>;
  /** Contextual keywords (`type`, `of`, `out`, `get`, `string`…) can be names too: they count as identifiers. */
  firstContextual: number;
  lastContextual: number;
  literals: Set<number>;
  valueEnd: Set<number>;
  /** After `import`, these mean it is an expression or a property name (`import(…)`, `import.meta`, `{ import: … }`). */
  notImportDeclaration: Set<number>;
  /** Keywords that start a new statement: an unterminated import / export list ends before them. */
  statementStart: Set<number>;
  /** Reserved words and operators (comparison, arithmetic, logical, assignment): what makes code logic rather than data. */
  logic: Uint8Array;
  /** Declaration headers and bodies (`canonicalCallable`). */
  arrow: number;
  equals: number;
  colon: number;
  returnKw: number;
  functionKw: number;
  /** `const` / `let` / `var`. */
  variable: Set<number>;
  /** What a declaration header before its parameters may hold: `export default async function* name<T>`, `static`… */
  header: Set<number>;
  /** Open and close brackets of every kind (types in a return type: `Promise<{ a: T[] }>`). */
  opens: Set<number>;
  closes: Set<number>;
  /** After these, `{` starts a type (`: { a: number }`), not a function body. */
  typeStart: Set<number>;
}

let kindTable: KindTable | undefined;
/** The kind table (loads the compiler on first use). */
const kindsOf = (): KindTable => kinds(typescript());
function kinds(ts: typeof TypeScript): KindTable {
  if (kindTable) return kindTable;
  const S = ts.SyntaxKind;
  kindTable = {
    eof: S.EndOfFileToken,
    slash: S.SlashToken,
    slashEquals: S.SlashEqualsToken,
    templateHead: S.TemplateHead,
    templateTail: S.TemplateTail,
    openBrace: S.OpenBraceToken,
    closeBrace: S.CloseBraceToken,
    openParen: S.OpenParenToken,
    closeParen: S.CloseParenToken,
    semicolon: S.SemicolonToken,
    dot: S.DotToken,
    questionDot: S.QuestionDotToken,
    asterisk: S.AsteriskToken,
    string: S.StringLiteral,
    importKw: S.ImportKeyword,
    exportKw: S.ExportKeyword,
    fromKw: S.FromKeyword,
    typeKw: S.TypeKeyword,
    identifiers: new Set([S.Identifier, S.PrivateIdentifier]),
    firstContextual: S.AbstractKeyword,
    lastContextual: S.LastKeyword,
    literals: new Set([S.StringLiteral, S.NumericLiteral, S.BigIntLiteral, S.NoSubstitutionTemplateLiteral, S.RegularExpressionLiteral]),
    valueEnd: new Set([
      S.Identifier,
      S.PrivateIdentifier,
      S.NumericLiteral,
      S.BigIntLiteral,
      S.StringLiteral,
      S.RegularExpressionLiteral,
      S.NoSubstitutionTemplateLiteral,
      S.TemplateTail,
      S.CloseParenToken,
      S.CloseBracketToken,
      S.CloseBraceToken,
      S.ThisKeyword,
      S.SuperKeyword,
      S.TrueKeyword,
      S.FalseKeyword,
      S.NullKeyword,
      S.PlusPlusToken,
      S.MinusMinusToken,
    ]),
    notImportDeclaration: new Set([S.OpenParenToken, S.DotToken, S.ColonToken, S.CommaToken, S.CloseBraceToken, S.CloseParenToken, S.EqualsToken, S.SemicolonToken, S.QuestionToken]),
    logic: (() => {
      const table = new Uint8Array(256);
      const mark = (from: number, to: number): void => {
        for (let k = from; k <= to; k++) table[k] = 1;
      };
      mark(S.LessThanEqualsToken, S.QuestionToken);
      mark(S.QuestionQuestionToken, S.QuestionQuestionToken);
      mark(S.EqualsToken, S.CaretEqualsToken);
      mark(S.BreakKeyword, S.YieldKeyword);
      return table;
    })(),
    arrow: S.EqualsGreaterThanToken,
    equals: S.EqualsToken,
    colon: S.ColonToken,
    returnKw: S.ReturnKeyword,
    functionKw: S.FunctionKeyword,
    variable: new Set([S.ConstKeyword, S.LetKeyword, S.VarKeyword]),
    header: new Set([S.ExportKeyword, S.DefaultKeyword, S.FunctionKeyword, S.AsteriskToken, S.ConstKeyword, S.LetKeyword, S.VarKeyword, S.EqualsToken, S.LessThanToken, S.GreaterThanToken, S.CommaToken, S.ExtendsKeyword, S.StaticKeyword, S.PublicKeyword, S.PrivateKeyword, S.ProtectedKeyword]),
    opens: new Set([S.OpenParenToken, S.OpenBracketToken, S.OpenBraceToken, S.LessThanToken]),
    closes: new Set([S.CloseParenToken, S.CloseBracketToken, S.CloseBraceToken, S.GreaterThanToken]),
    typeStart: new Set([S.ColonToken, S.BarToken, S.AmpersandToken, S.CommaToken, S.LessThanToken, S.EqualsGreaterThanToken, S.OpenParenToken, S.OpenBracketToken]),
    statementStart: new Set([S.ConstKeyword, S.LetKeyword, S.VarKeyword, S.FunctionKeyword, S.ClassKeyword, S.IfKeyword, S.ForKeyword, S.WhileKeyword, S.ReturnKeyword, S.InterfaceKeyword, S.EnumKeyword, S.ExportKeyword, S.ImportKeyword, S.AtToken]),
  };
  return kindTable;
}

/** Append the tokens of `text` (whose first line is line `lineOffset + 1` of the file). */
function scanTokens(text: string, jsx: boolean, lineOffset: number, out: { kinds: number[]; lines: number[] }): void {
  const ts = typescript();
  const k = kinds(ts);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  const peek = (): number => scanner.lookAhead(() => scanner.scan());
  let line = 1 + lineOffset;
  let newline = text.indexOf('\n');
  const templates: number[] = [];
  let braces = 0;
  let prev = -1;
  /** Inside an import declaration (1) or an export list / `export * from` (2): its tokens are left out. */
  let skipping = 0;
  let dropSemicolon = false;
  for (let kind: number = scanner.scan(); kind !== k.eof; kind = scanner.scan()) {
    // Regular expressions and template continuations are re-scanned the way the parser does.
    if ((kind === k.slash || kind === k.slashEquals) && (prev === -1 || !k.valueEnd.has(prev))) kind = scanner.reScanSlashToken();
    else if (kind === k.templateHead) templates.push(braces);
    else if (kind === k.openBrace) braces++;
    else if (kind === k.closeBrace) {
      if (templates.length && templates[templates.length - 1] === braces) {
        kind = scanner.reScanTemplateToken(false);
        if (kind === k.templateTail) templates.pop();
      } else braces--;
    }
    if (dropSemicolon) {
      dropSemicolon = false;
      if (kind === k.semicolon) {
        prev = kind;
        continue;
      }
    }
    if (skipping && !(scanner.hasPrecedingLineBreak() && k.statementStart.has(kind))) {
      if (kind === k.semicolon) skipping = 0;
      else if (kind === k.string && (prev === k.fromKw || prev === k.importKw)) {
        skipping = 0;
        dropSemicolon = true;
      } else if (kind === k.closeParen && prev === k.string) {
        // `import x = require('x')`
        skipping = 0;
        dropSemicolon = true;
      } else if (skipping === 2 && kind === k.closeBrace && peek() !== k.fromKw) {
        // `export { a, b }` without `from`
        skipping = 0;
        dropSemicolon = true;
      }
      prev = kind;
      continue;
    }
    skipping = 0;
    if (kind === k.importKw && prev !== k.dot && prev !== k.questionDot && !k.notImportDeclaration.has(peek())) {
      skipping = 1;
      prev = kind;
      continue;
    }
    if (kind === k.exportKw) {
      const [n1, n2] = scanner.lookAhead(() => [scanner.scan(), scanner.scan()]);
      if (n1 === k.openBrace || n1 === k.asterisk || (n1 === k.typeKw && (n2 === k.openBrace || n2 === k.asterisk))) {
        skipping = 2;
        prev = kind;
        continue;
      }
    }
    const pos = scanner.getTokenStart();
    while (newline !== -1 && newline < pos) {
      line++;
      newline = text.indexOf('\n', newline + 1);
    }
    const name = k.identifiers.has(kind) || (kind >= k.firstContextual && kind <= k.lastContextual);
    out.kinds.push(name ? IDENT : k.literals.has(kind) ? LITERAL : kind > 3 && kind < 256 ? kind : UNKNOWN);
    out.lines.push(line);
    prev = kind;
  }
}

const SFC_EXTS = new Set(['.vue', '.svelte', '.astro']);
const STANDARD_EXTS = new Set(['.ts', '.mts', '.cts']);

/** Script blocks of a Vue / Svelte / Astro file (Astro: the frontmatter too), with the lines before them. */
function scriptBlocks(text: string, ext: string): { content: string; lineOffset: number; jsx: boolean }[] {
  const blocks: { content: string; lineOffset: number; jsx: boolean }[] = [];
  const linesBefore = (index: number): number => {
    let n = 0;
    for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
    return n;
  };
  if (ext === '.astro') {
    const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    // The content starts on the line after the opening `---` (blank lines may come before it).
    if (front) blocks.push({ content: front[1], lineOffset: linesBefore(front.index + front[0].indexOf('\n', front[0].indexOf('---')) + 1), jsx: false });
  }
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const start = m.index + m[0].indexOf('>') + 1;
    const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(m[1])?.[1]?.toLowerCase();
    blocks.push({ content: m[2], lineOffset: linesBefore(start), jsx: lang === undefined || lang === 'jsx' || lang === 'tsx' || lang === 'js' });
  }
  return blocks;
}

/**
 * The normalized tokens of a source file (by its extension): identifiers (and contextual keywords such as
 * `type` or `of`, which can be names) → `I`, literals → `L`, other keywords and punctuation kept, import /
 * export-from statements dropped; Vue / Svelte / Astro script blocks only.
 */
export function cloneTokens(text: string, ext: string): CloneTokens {
  const out = { kinds: [] as number[], lines: [] as number[] };
  if (SFC_EXTS.has(ext)) {
    for (const block of scriptBlocks(text, ext)) {
      if (out.kinds.length) {
        out.kinds.push(BARRIER);
        out.lines.push(block.lineOffset + 1);
      }
      scanTokens(block.content, block.jsx, block.lineOffset, out);
    }
  } else scanTokens(text, !STANDARD_EXTS.has(ext), 0, out);
  return { kinds: Uint8Array.from(out.kinds), lines: Uint32Array.from(out.lines) };
}

/** The languages a snippet can be in (`similar --lang`), as extensions. */
export const SNIPPET_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'];

/**
 * The tokens of a source file, or of a snippet (`ext` decides JSX and script blocks; default `.tsx`). A
 * Vue / Svelte / Astro snippet without a `<script>` block (or frontmatter) is its script part.
 */
export function snippetTokens(text: string, ext = '.tsx'): CloneTokens {
  if (SFC_EXTS.has(ext) && !/<script\b/i.test(text) && !(ext === '.astro' && /^\s*---\r?\n/.test(text))) return cloneTokens(text, '.ts');
  return cloneTokens(text, ext);
}

/** Index of the first token on or after `line` (binary search over the sorted token lines). */
function tokenAtLine(lines: Uint32Array, line: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Tokens on lines `start..end` (inclusive) as a token range [from, to). */
function tokenRange(tokens: CloneTokens, start: number, end: number): [number, number] {
  return [tokenAtLine(tokens.lines, start), tokenAtLine(tokens.lines, end + 1)];
}

/** The tokens of lines `start..end` of a file (for "is there code like lines 40-58 of this file?"). */
export function sliceTokens(tokens: CloneTokens, start: number, end: number): CloneTokens {
  const [from, to] = tokenRange(tokens, start, end);
  return { kinds: tokens.kinds.subarray(from, to), lines: tokens.lines.subarray(from, to) };
}

/* -------------------------------------------------------------------------- */
/*                         Declarations (match units)                         */
/* -------------------------------------------------------------------------- */

/** A declaration copies are attributed to: a top-level symbol, or a member of a class. */
export interface CloneUnit {
  start: number;
  end: number;
  /** `slugify`, `CartService.checkout`. */
  name: string;
  /** The (top-level) symbol id. */
  symbol: string;
  exported: boolean;
  /** A function, hook, component or method. */
  callable: boolean;
  /** The symbol behind it, and the class member for methods (for signatures). */
  info: SymbolInfo;
  member?: NonNullable<SymbolInfo['members']>[number];
}

/** Top-level declarations of a file, with classes split into their members (two similar methods of one class are a clone). */
export function unitsOf(file: Pick<FileInfo, 'symbols'>): CloneUnit[] {
  const units: CloneUnit[] = [];
  for (const s of file.symbols) {
    units.push({ start: s.line, end: s.endLine, name: s.name, symbol: s.id, exported: s.exported, callable: isCallable(s), info: s });
    if (s.kind !== 'class' || !s.members?.length) continue;
    const members = [...s.members].filter((m) => m.line >= s.line && m.line <= s.endLine).sort((a, b) => a.line - b.line);
    members.forEach((m, i) => {
      const next = members.slice(i + 1).find((n) => n.line > m.line);
      const end = next ? Math.max(m.line, next.line - 1) : Math.max(m.line, s.endLine - 1);
      units.push({ start: m.line, end, name: `${s.name}.${m.name}`, symbol: s.id, exported: s.exported, callable: m.kind === 'method' || m.kind === 'constructor' || m.kind === 'getter' || m.kind === 'setter', info: s, member: m });
    });
  }
  return units;
}

/* -------------------------------------------------------------------------- */
/*                                 Detection                                  */
/* -------------------------------------------------------------------------- */

/** One file for clone detection. */
export interface CloneSource {
  id: string;
  tokens: CloneTokens;
  units: CloneUnit[];
  /** Test file: clones between two test files are not reported. */
  test: boolean;
}

/** Length of the hashed windows (k-grams). */
const SEED = 20;
/** Winnowing window: every run of SEED + WINNOW − 1 = 30 equal tokens shares a fingerprint. */
const WINNOW = 11;
/** Matches shorter than this are not kept as parts of a clone. */
const MIN_SEGMENT = SEED + WINNOW - 1;
/**
 * Fingerprints found in more declarations than this are boilerplate (`}); }); });`, the body of sixty
 * generated components): not used to find clones. Counted per declaration, and each declaration is
 * fingerprinted on its own, so code added next to a declaration never changes what is boilerplate in it.
 */
const MAX_DECLARATIONS = 50;
/** …and so are fingerprints repeated this often anywhere (a long table): matching them would take quadratic time. */
const MAX_OCCURRENCES = 400;
/** Tokens two parts of one near-miss clone may be apart (an inserted statement, a changed call)… */
const MAX_GAP = 15;
/** …or overlap (equal tokens next to the edit belong to both parts). */
const MAX_OVERLAP = 6;
/** A match needs this many different token kinds (`'a', 'b', 'c'` is data, not copied code)… */
const MIN_DISTINCT_KINDS = 10;
/** …and this share of different 3-token sequences: lists such as `[ts.X, ts.Y, …]` or `{ a: {…}, b: {…} }` repeat a few. */
const MIN_TRIGRAM_SHARE = 0.35;
/** …and this share of keywords and operators. */
const MIN_LOGIC_SHARE = 0.08;
const HASH_BASE = 0x01000193;
/** HASH_BASE^(SEED − 1) mod 2^32: rolls the oldest token out of a window. */
const WINDOW_POWER = (() => {
  let p = 1;
  for (let i = 0; i < SEED - 1; i++) p = Math.imul(p, HASH_BASE);
  return p;
})();
const FNV_OFFSET = 0x811c9dc5;

/** A maximal exact match between two places (token positions within each file). */
interface Segment {
  fa: number;
  a: number;
  fb: number;
  b: number;
  len: number;
}

/** A clone between two declarations (or module-level code) of two files (positions are token indexes within each file). */
interface Pair {
  fa: number;
  fb: number;
  /** The declarations (indexes into the files' units; -1: module-level code). */
  ua: number;
  ub: number;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  matched: number;
  /** The longest exact part (its position in the first file, and its length), for the family id. */
  core: { pos: number; len: number };
  /** The share of the larger of the two declarations that is copied. */
  similarity: number;
}

/**
 * What matching knows about one file, memoized per token array (and declaration layout): a warm
 * re-analysis indexes only the files that changed.
 */
interface FileIndex {
  /** The declarations it was built for (`start-end:name,…`). */
  layout: string;
  /** Each token's innermost declaration (an index into the units; -1 for module-level code)… */
  owner: Int32Array;
  /** …and how many tokens each declaration has. */
  size: Int32Array;
  /** Winnowed fingerprints by position: hash, token position and declaration (as in `owner`). */
  hashes: Float64Array;
  positions: Int32Array;
  owners: Int32Array;
  /** A hash of each declaration's normalized tokens by name (`''`: the module-level code). */
  declarations: Map<string, string>;
}

const fileIndexes = new WeakMap<Uint8Array, FileIndex>();

const layoutOf = (units: readonly CloneUnit[]): string => units.map((u) => `${u.start}-${u.end}:${u.name}`).join(',');

function fileIndex(src: CloneSource): FileIndex {
  const kinds = src.tokens.kinds;
  const layout = layoutOf(src.units);
  const known = fileIndexes.get(kinds);
  if (known?.layout === layout) return known;
  const { owner, size } = tokenOwners(src);
  const index: FileIndex = { layout, owner, size, ...winnow(kinds, owner), declarations: declarationHashes(src, owner) };
  fileIndexes.set(kinds, index);
  return index;
}

/**
 * The winnowed fingerprints of a file: the hash of every SEED-token window, of which each run of WINNOW
 * consecutive windows keeps its smallest (the rightmost on a tie). Each declaration (and each stretch of
 * module-level code) is fingerprinted on its own — windows never span two of them, nor a barrier between
 * script blocks — so what is found in a declaration does not depend on the code around it. Any common run of
 * 30 tokens inside one declaration still shares a fingerprint.
 */
function winnow(kinds: Uint8Array, owner: Int32Array): Pick<FileIndex, 'hashes' | 'positions' | 'owners'> {
  const hashes: number[] = [];
  const positions: number[] = [];
  const owners: number[] = [];
  const ringHash = new Float64Array(WINNOW).fill(Infinity);
  const ringPos = new Int32Array(WINNOW);
  let right = 0;
  let min = 0;
  let hash = 0;
  let run = 0;
  for (let i = 0; i < kinds.length; i++) {
    const t = kinds[i];
    if (t === BARRIER || (i > 0 && owner[i] !== owner[i - 1])) {
      ringHash.fill(Infinity);
      right = 0;
      min = 0;
      run = 0;
      hash = 0;
      if (t === BARRIER) continue;
    }
    if (run >= SEED) hash = (hash - Math.imul(kinds[i - SEED], WINDOW_POWER)) | 0;
    hash = (Math.imul(hash, HASH_BASE) + t) | 0;
    run++;
    if (run < SEED) continue;
    right = (right + 1) % WINNOW;
    ringHash[right] = hash >>> 0;
    ringPos[right] = i - SEED + 1;
    if (min === right) {
      // The previous minimum left the window: the rightmost smallest of the window.
      for (let j = (right - 1 + WINNOW) % WINNOW; j !== right; j = (j - 1 + WINNOW) % WINNOW) if (ringHash[j] < ringHash[min]) min = j;
    } else if (ringHash[right] <= ringHash[min]) min = right;
    else continue;
    if (positions[positions.length - 1] !== ringPos[min]) {
      hashes.push(ringHash[min]);
      positions.push(ringPos[min]);
      owners.push(owner[ringPos[min]]);
    }
  }
  return { hashes: Float64Array.from(hashes), positions: Int32Array.from(positions), owners: Int32Array.from(owners) };
}

/** FNV-1a over each declaration's own tokens (a class without its members, which are declarations of their own). */
function declarationHashes(src: CloneSource, owner: Int32Array): Map<string, string> {
  const kinds = src.tokens.kinds;
  const h = new Int32Array(src.units.length + 1).fill(FNV_OFFSET);
  for (let i = 0; i < kinds.length; i++) {
    const o = owner[i] + 1;
    h[o] = Math.imul(h[o] ^ kinds[i], HASH_BASE);
  }
  const out = new Map<string, string>([['', (h[0] >>> 0).toString(16)]]);
  src.units.forEach((u, i) => {
    const hex = (h[i + 1] >>> 0).toString(16);
    const seen = out.get(u.name);
    // Overloads share a name: one entry for all of them.
    out.set(u.name, seen === undefined ? hex : `${seen}+${hex}`);
  });
  return out;
}

/** The fingerprints of every file in one table, bucketed by hash, with what is boilerplate. */
interface FingerprintTable {
  /** Position of each file's first token in one concatenated stream (files are one position apart). */
  offsets: Int32Array;
  count: number;
  hashes: Float64Array;
  positions: Int32Array;
  fileOf: Int32Array;
  bucketOf: Int32Array;
  /** The previous fingerprint with the same hash (-1: none)… */
  earlier: Int32Array;
  /** …and the last one of each bucket (by slot). */
  latest: Int32Array;
  bucketSize: Int32Array;
  bucketDeclarations: Int32Array;
  /** Boilerplate hashes, ascending. */
  boilerplate: number[];
}

function fingerprintTable(kinds: readonly Uint8Array[], indexes: readonly FileIndex[]): FingerprintTable {
  const offsets = new Int32Array(kinds.length + 1);
  let count = 0;
  let at = 0;
  kinds.forEach((k, f) => {
    offsets[f] = at;
    at += k.length + 1;
    count += indexes[f].hashes.length;
  });
  offsets[kinds.length] = at;
  const hashes = new Float64Array(count);
  const positions = new Int32Array(count);
  const fileOf = new Int32Array(count);
  const declarationOf = new Int32Array(count);
  let k = 0;
  let declarations = 0;
  indexes.forEach((ix, f) => {
    hashes.set(ix.hashes, k);
    for (let i = 0; i < ix.positions.length; i++) {
      positions[k + i] = ix.positions[i] + offsets[f];
      fileOf[k + i] = f;
      declarationOf[k + i] = declarations + ix.owners[i] + 1;
    }
    k += ix.positions.length;
    declarations += ix.size.length + 1;
  });
  // Buckets of equal fingerprints (open addressing); each fingerprint links to the earlier ones of its bucket.
  let size = 16;
  while (size < count * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  const bucketSize = new Int32Array(size);
  const bucketDeclarations = new Int32Array(size);
  const lastDeclaration = new Int32Array(size).fill(-1);
  const bucketOf = new Int32Array(count);
  const earlier = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const h = hashes[i];
    let slot = (Math.imul(h, 0x9e3779b1) >>> 0) & (size - 1);
    while (table[slot] !== -1 && hashes[table[slot]] !== h) slot = (slot + 1) & (size - 1);
    earlier[i] = table[slot];
    table[slot] = i;
    bucketSize[slot]++;
    // A declaration's fingerprints come one after the other: it counts once.
    if (lastDeclaration[slot] !== declarationOf[i]) {
      lastDeclaration[slot] = declarationOf[i];
      bucketDeclarations[slot]++;
    }
    bucketOf[i] = slot;
  }
  const boilerplate: number[] = [];
  for (let slot = 0; slot < size; slot++) {
    if (table[slot] !== -1 && (bucketDeclarations[slot] > MAX_DECLARATIONS || bucketSize[slot] > MAX_OCCURRENCES)) boilerplate.push(hashes[table[slot]]);
  }
  boilerplate.sort((x, y) => x - y);
  return { offsets, count, hashes, positions, fileOf, bucketOf, earlier, latest: table, bucketSize, bucketDeclarations, boilerplate };
}

/**
 * Exact matches of at least MIN_SEGMENT tokens between two different places, verified token by token and
 * extended to the maximal match (within both files and script blocks). Only pairs with a file in `dirty`
 * are matched (the others are known from the last run); fingerprints `skip` says are boilerplate are not used.
 */
function exactMatches(kinds: readonly Uint8Array[], t: FingerprintTable, dirty: Uint8Array, skip: (i: number) => boolean): Segment[] {
  const segments: Segment[] = [];
  /** Per diagonal (b − a, in stream positions): where the last match on it ended (in a). */
  const covered = new Map<number, number>();
  /** Fingerprint `j` (earlier in the stream) and `i` (later) as the seed of a match. */
  const seed = (j: number, i: number): void => {
    const p = t.positions[i];
    const q = t.positions[j];
    const d = p - q;
    // Overlapping windows are a repetition inside one place (`a(); a(); a();`).
    if (d < SEED || (covered.get(d) ?? -1) > q) return;
    const fa = t.fileOf[j];
    const fb = t.fileOf[i];
    const A = kinds[fa];
    const B = kinds[fb];
    const oa = t.offsets[fa];
    const ob = t.offsets[fb];
    for (let x = 0; x < SEED; x++) if (A[q - oa + x] !== B[p - ob + x]) return;
    // Extend to the maximal match; the two places never overlap.
    let a0 = q;
    let b0 = p;
    while (a0 > oa && b0 > ob && b0 - 1 >= q + SEED && A[a0 - 1 - oa] !== BARRIER && A[a0 - 1 - oa] === B[b0 - 1 - ob]) {
      a0--;
      b0--;
    }
    let a1 = q + SEED;
    let b1 = p + SEED;
    const endA = oa + A.length;
    const endB = ob + B.length;
    while (b1 < endB && a1 < endA && a1 < b0 && A[a1 - oa] !== BARRIER && A[a1 - oa] === B[b1 - ob]) {
      a1++;
      b1++;
    }
    covered.set(d, a1);
    if (a1 - a0 >= MIN_SEGMENT) segments.push({ fa, a: a0 - oa, fb, b: b0 - ob, len: a1 - a0 });
  };
  if (dirty.every((x) => x === 1)) {
    // Everything is new: every fingerprint with each earlier one of its bucket.
    for (let i = 0; i < t.count; i++) if (!skip(i)) for (let j = t.earlier[i]; j !== -1; j = t.earlier[j]) seed(j, i);
    return segments;
  }
  // Only the changed files: the buckets of their fingerprints, in the order a full run would seed them
  // (later fingerprint first, then its earlier partners from the latest), so matches come out the same.
  const seeds: number[] = [];
  for (let i = 0; i < t.count; i++) {
    if (!dirty[t.fileOf[i]] || skip(i)) continue;
    for (let j = t.latest[t.bucketOf[i]]; j !== -1; j = t.earlier[j]) {
      if (j === i || (dirty[t.fileOf[j]] && j > i)) continue;
      seeds.push(Math.max(i, j), Math.min(i, j));
    }
  }
  const order = Array.from({ length: seeds.length / 2 }, (_, k) => k).sort((x, y) => seeds[2 * x] - seeds[2 * y] || seeds[2 * y + 1] - seeds[2 * x + 1]);
  for (const k of order) seed(seeds[2 * k + 1], seeds[2 * k]);
  return segments;
}

/** Union-find over indexes. */
class Groups {
  private readonly parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Chain exact matches between the same two files that are only a few tokens apart (a copy with small edits). */
function chainSegments(list: { a: number; b: number; len: number; pos: number }[]): { a: number; aEnd: number; b: number; bEnd: number; matched: number; core: { pos: number; len: number } }[] {
  list.sort((x, y) => x.a - y.a || x.b - y.b);
  const chains: { a: number; aEnd: number; b: number; bEnd: number; matched: number; core: { pos: number; len: number } }[] = [];
  for (const s of list) {
    let best: (typeof chains)[number] | undefined;
    let bestGap = Infinity;
    for (const c of chains) {
      // A few tokens of overlap: the next part extended left over tokens that happen to match on both sides.
      const ga = s.a - c.aEnd;
      const gb = s.b - c.bEnd;
      if (ga < -MAX_OVERLAP || gb < -MAX_OVERLAP || ga > MAX_GAP || gb > MAX_GAP || s.a <= c.a || s.b <= c.b) continue;
      if (Math.abs(ga) + Math.abs(gb) < bestGap) {
        best = c;
        bestGap = Math.abs(ga) + Math.abs(gb);
      }
    }
    if (best) {
      best.matched += s.len - Math.max(0, best.aEnd - s.a, best.bEnd - s.b);
      best.aEnd = Math.max(best.aEnd, s.a + s.len);
      best.bEnd = Math.max(best.bEnd, s.b + s.len);
      if (s.len > best.core.len) best.core = { pos: s.pos, len: s.len };
    } else chains.push({ a: s.a, aEnd: s.a + s.len, b: s.b, bEnd: s.b + s.len, matched: s.len, core: { pos: s.pos, len: s.len } });
  }
  return chains;
}

/**
 * Whether tokens [from, to) look like logic rather than data: varied kinds, few repeated 3-token sequences,
 * and enough keywords and operators (a table of `{ label: '…', color: '…' }` or a help text with
 * `${…}` parts has the shape of code but none of its logic).
 */
function codeLike(kinds: Uint8Array, from: number, to: number): boolean {
  const logic = kindsOf().logic;
  let logical = 0;
  for (let i = from; i < to; i++) logical += logic[kinds[i]];
  if (logical < (to - from) * MIN_LOGIC_SHARE) return false;
  const seen = new Uint8Array(256);
  let distinct = 0;
  for (let i = from; i < to; i++) {
    if (!seen[kinds[i]]) {
      seen[kinds[i]] = 1;
      distinct++;
    }
  }
  if (distinct < MIN_DISTINCT_KINDS) return false;
  const trigrams = new Set<number>();
  for (let i = from; i + 2 < to; i++) trigrams.add((kinds[i] << 16) | (kinds[i + 1] << 8) | kinds[i + 2]);
  return trigrams.size >= (to - from) * MIN_TRIGRAM_SHARE;
}

/** The family id: a fingerprint of the normalized token sequence (no lines, no paths). */
function sequenceId(kinds: Uint8Array, core: { pos: number; len: number }): string {
  const parts: string[] = [];
  const end = core.pos + Math.min(core.len, 4000);
  for (let i = core.pos; i < end; i += 1024) parts.push(String.fromCharCode(...kinds.subarray(i, Math.min(end, i + 1024))));
  return fingerprint(RULE_IDS.duplicateCode, '', parts.join(''));
}

/** Each token's innermost declaration (a class member rather than its class), and how many tokens each has. */
function tokenOwners(src: CloneSource): Pick<FileIndex, 'owner' | 'size'> {
  const owner = new Int32Array(src.tokens.kinds.length).fill(-1);
  const order = src.units.map((_, i) => i).sort((x, y) => src.units[y].end - src.units[y].start - (src.units[x].end - src.units[x].start));
  for (const i of order) {
    const [from, to] = tokenRange(src.tokens, src.units[i].start, src.units[i].end);
    owner.fill(i, from, to);
  }
  const size = new Int32Array(src.units.length);
  for (const o of owner) if (o >= 0) size[o]++;
  return { owner, size };
}

/** Two parts of one copy at most this many lines apart (an edit in the middle) are one copy; farther apart, two. */
const MERGE_GAP_LINES = 10;

/** A chain of exact matches between two declarations (positions are token indexes within each file). */
type Chain = ReturnType<typeof chainSegments>[number];

/**
 * Chains between the same two declarations a few lines apart are one copy (a function copied, then edited
 * in the middle beyond what a near-miss match bridges); farther apart (two small blocks at both ends of a
 * long function), they stay apart, so a copy never claims the lines between them.
 */
function mergeNearChains(chains: Chain[], A: CloneSource, B: CloneSource): Chain[] {
  const out: Chain[] = [];
  for (const c of [...chains].sort((x, y) => x.a - y.a)) {
    const last = out[out.length - 1];
    const gap = (src: CloneSource, end: number, start: number): number => src.tokens.lines[start] - src.tokens.lines[end - 1];
    if (last && c.b > last.b && gap(A, last.aEnd, c.a) <= MERGE_GAP_LINES && gap(B, last.bEnd, c.b) <= MERGE_GAP_LINES) {
      last.matched += c.matched;
      last.aEnd = Math.max(last.aEnd, c.aEnd);
      last.bEnd = Math.max(last.bEnd, c.bEnd);
      if (c.core.len > last.core.len) last.core = c.core;
    } else out.push({ ...c });
  }
  return out;
}

/**
 * Clone pairs from exact matches: cut where either side enters another declaration (a copy never runs into
 * its neighbour, so an edit next to it is no edit of the copy), grouped by the two declarations, chained into
 * near-miss copies and kept when they are large enough and look like logic. Pairs inside one declaration
 * and pairs of two test files are left out.
 */
function pairsOf(segments: readonly Segment[], sources: readonly CloneSource[], indexes: readonly FileIndex[], settings: CloneSettings): Pair[] {
  const byUnits = new Map<string, { fa: number; ua: number; fb: number; ub: number; list: { a: number; b: number; len: number; pos: number }[] }>();
  for (const seg of segments) {
    const { fa, fb } = seg;
    if (sources[fa].test && sources[fb].test) continue;
    const oa = indexes[fa].owner;
    const ob = indexes[fb].owner;
    let from = 0;
    for (let x = 1; x <= seg.len; x++) {
      if (x < seg.len && oa[seg.a + x] === oa[seg.a + from] && ob[seg.b + x] === ob[seg.b + from]) continue;
      const ua = oa[seg.a + from];
      const ub = ob[seg.b + from];
      // Both copies in one declaration (a function repeating itself) is not a clone to extract.
      if (!(fa === fb && ua === ub && ua !== -1)) {
        const key = `${fa},${ua},${fb},${ub}`;
        const group = byUnits.get(key) ?? { fa, ua, fb, ub, list: [] };
        group.list.push({ a: seg.a + from, b: seg.b + from, len: x - from, pos: seg.a + from });
        byUnits.set(key, group);
      }
      from = x;
    }
  }
  const pairs: Pair[] = [];
  for (const { fa, ua, fb, ub, list } of byUnits.values()) {
    const A = sources[fa];
    const B = sources[fb];
    for (const c of mergeNearChains(chainSegments(list), A, B)) {
      if (c.matched < settings.minTokens) continue;
      if (A.tokens.lines[c.aEnd - 1] - A.tokens.lines[c.a] + 1 < settings.minLines || B.tokens.lines[c.bEnd - 1] - B.tokens.lines[c.b] + 1 < settings.minLines) continue;
      if (!codeLike(A.tokens.kinds, c.a, c.aEnd)) continue;
      // The share of the larger declaration that is copied (module-level code: the copy itself).
      const sizeA = ua >= 0 ? indexes[fa].size[ua] : c.aEnd - c.a;
      const sizeB = ub >= 0 ? indexes[fb].size[ub] : c.bEnd - c.b;
      const similarity = Math.min(1, c.matched / Math.max(1, sizeA, sizeB));
      pairs.push({ fa, fb, ua, ub, aStart: c.a, aEnd: c.aEnd, bStart: c.b, bEnd: c.bEnd, matched: c.matched, core: c.core, similarity });
    }
  }
  return pairs;
}

/**
 * What clone detection keeps between the analyses of one project (`AnalyzeCache.clones`): the clone pairs
 * it found and the files they were found in. A warm re-analysis matches only the files that changed (and
 * new ones) against the others, and keeps the pairs between files that did not change — as long as the
 * settings and the boilerplate fingerprints are the same.
 */
export interface CloneCache {
  key?: string;
  files: Map<string, { kinds: Uint8Array; layout: string; test: boolean }>;
  /** Pairs by the ids of their files. */
  pairs: (Omit<Pair, 'fa' | 'fb'> & { a: string; b: string })[];
}

export function createCloneCache(): CloneCache {
  return { files: new Map(), pairs: [] };
}

export interface DetectOptions {
  /** Pairs of the last run, updated with this one's. */
  cache?: CloneCache;
  /**
   * Judge with these boilerplate fingerprints (ascending) instead of the ones counted here: a delta judges
   * both sides with the base's, so a copy that tips a fingerprint over the limit does not hide itself.
   */
  boilerplate?: readonly number[];
}

interface Detection {
  families: CloneFamily[];
  /** The boilerplate fingerprints counted in these sources, ascending. */
  boilerplate: number[];
  indexes: FileIndex[];
}

/** A short signature of a list of fingerprints. */
function listSignature(list: readonly number[]): string {
  let h = FNV_OFFSET;
  for (const x of list) h = Math.imul(h ^ x, HASH_BASE);
  return `${list.length}:${(h >>> 0).toString(16)}`;
}

function detect(sources: readonly CloneSource[], settings: CloneSettings, options: DetectOptions = {}): Detection {
  const indexes = sources.map(fileIndex);
  const kinds = sources.map((s) => s.tokens.kinds);
  const table = fingerprintTable(kinds, indexes);
  const override = options.boilerplate && new Set(options.boilerplate);
  const skip = override
    ? (i: number): boolean => override.has(table.hashes[i]) || table.bucketSize[table.bucketOf[i]] > MAX_OCCURRENCES
    : (i: number): boolean => table.bucketDeclarations[table.bucketOf[i]] > MAX_DECLARATIONS || table.bucketSize[table.bucketOf[i]] > MAX_OCCURRENCES;
  const key = `${settings.minTokens}|${settings.minLines}|${options.boilerplate ? `given ${listSignature(options.boilerplate)}` : listSignature(table.boilerplate)}`;
  const cache = options.cache;
  const reuse = !!cache && cache.key === key;
  const dirty = new Uint8Array(sources.length).fill(1);
  if (reuse) {
    sources.forEach((s, f) => {
      const was = cache.files.get(s.id);
      if (was && was.kinds === s.tokens.kinds && was.layout === indexes[f].layout && was.test === s.test) dirty[f] = 0;
    });
  }
  const pairs = pairsOf(exactMatches(kinds, table, dirty, skip), sources, indexes, settings);
  if (reuse) {
    const at = new Map(sources.map((s, i) => [s.id, i]));
    for (const { a, b, ...rest } of cache.pairs) {
      const fa = at.get(a);
      const fb = at.get(b);
      if (fa !== undefined && fb !== undefined && !dirty[fa] && !dirty[fb]) pairs.push({ ...rest, fa, fb });
    }
  }
  // One order whichever run found a pair: families and their ids do not depend on what was cached.
  pairs.sort((x, y) => x.fa - y.fa || x.fb - y.fb || x.aStart - y.aStart || x.bStart - y.bStart || x.ua - y.ua || x.ub - y.ub || x.aEnd - y.aEnd || x.bEnd - y.bEnd);
  if (cache) {
    cache.key = key;
    cache.files = new Map(sources.map((s, f) => [s.id, { kinds: s.tokens.kinds, layout: indexes[f].layout, test: s.test }]));
    cache.pairs = pairs.map(({ fa, fb, ...rest }) => ({ ...rest, a: sources[fa].id, b: sources[fb].id }));
  }
  return { families: familiesOf(pairs, sources), boilerplate: table.boilerplate, indexes };
}

/**
 * Clone families among `sources`: copies of at least `minTokens` tokens and `minLines` lines on both
 * sides. A copy belongs to one declaration (class members on their own; module-level code is its own):
 * matches are cut where they leave it, so a copy never runs into its neighbour and an edit next to it is
 * no edit of the copy. Pairs inside one declaration and pairs of two test files are left out. Each pair's
 * similarity is the share of the larger of its two declarations that is copied. Families come without
 * `coChanges` and importer counts (see `projectClones`).
 */
export function detectClones(sources: readonly CloneSource[], settings: CloneSettings = DEFAULT_CLONE_SETTINGS, options: DetectOptions = {}): CloneFamily[] {
  return detect(sources, settings, options).families;
}

/** Occurrences (two per pair) → fragments (occurrences in one file covering mostly the same lines) → families. */
function familiesOf(pairs: readonly Pair[], sources: readonly CloneSource[]): CloneFamily[] {
  if (!pairs.length) return [];
  interface Occurrence {
    file: number;
    start: number;
    end: number;
    unit: number;
  }
  const occurrences: Occurrence[] = [];
  for (const p of pairs) {
    occurrences.push(
      { file: p.fa, start: sources[p.fa].tokens.lines[p.aStart], end: sources[p.fa].tokens.lines[p.aEnd - 1], unit: p.ua },
      { file: p.fb, start: sources[p.fb].tokens.lines[p.bStart], end: sources[p.fb].tokens.lines[p.bEnd - 1], unit: p.ub },
    );
  }
  // Two occurrences are one copy when they are in one declaration and share at least half of the larger
  // one's lines: a small shared idiom inside a copied function is not that function (and does not join its family).
  const fragmentsOf = new Groups(occurrences.length);
  const order = occurrences.map((_, i) => i).sort((x, y) => occurrences[x].file - occurrences[y].file || occurrences[x].start - occurrences[y].start);
  for (let i = 0; i < order.length; i++) {
    const o = occurrences[order[i]];
    for (let j = i + 1; j < order.length; j++) {
      const p = occurrences[order[j]];
      if (p.file !== o.file || p.start > o.end) break;
      const overlap = Math.min(o.end, p.end) - p.start + 1;
      if (p.unit === o.unit && overlap * 2 >= Math.max(o.end - o.start + 1, p.end - p.start + 1)) fragmentsOf.union(order[i], order[j]);
    }
  }
  const familiesOfOccurrence = new Groups(occurrences.length);
  for (let i = 0; i < occurrences.length; i++) familiesOfOccurrence.union(i, fragmentsOf.find(i));
  for (let i = 0; i < occurrences.length; i += 2) familiesOfOccurrence.union(i, i + 1);

  const grouped = new Map<number, number[]>();
  occurrences.forEach((_, i) => {
    const root = familiesOfOccurrence.find(i);
    const list = grouped.get(root) ?? [];
    list.push(i);
    grouped.set(root, list);
  });
  const families: CloneFamily[] = [];
  const ids = new Map<string, number>();
  for (const members of grouped.values()) {
    const byFragment = new Map<number, number[]>();
    for (const i of members) {
      const root = fragmentsOf.find(i);
      byFragment.set(root, [...(byFragment.get(root) ?? []), i]);
    }
    if (byFragment.size < 2) continue;
    const parts = [...byFragment.values()]
      .map((occ) => {
        const { file, unit } = occurrences[occ[0]];
        return { file, unit, start: Math.min(...occ.map((o) => occurrences[o].start)), end: Math.max(...occ.map((o) => occurrences[o].end)), occ };
      })
      .sort((x, y) => x.file - y.file || x.unit - y.unit || x.start - y.start);
    // Copies of one declaration that overlap or nearly touch (it matched two others a little differently) are one copy.
    const merged: typeof parts = [];
    for (const part of parts) {
      const last = merged[merged.length - 1];
      if (last && last.file === part.file && last.unit === part.unit && part.unit >= 0 && part.start <= last.end + MERGE_GAP_LINES) {
        last.end = Math.max(last.end, part.end);
        last.occ = [...last.occ, ...part.occ];
      } else merged.push({ ...part });
    }
    if (merged.length < 2) continue;
    const list = merged.map(({ file, unit, start, end, occ }) => ({ src: sources[file], start, end, unit: unit >= 0 ? sources[file].units[unit] : undefined, occ }));
    list.sort((x, y) => Number(x.src.test) - Number(y.src.test) || x.src.id.localeCompare(y.src.id) || x.start - y.start);
    const fragments: CloneFragment[] = list.map(({ src, start, end, unit }) => ({
      file: src.id,
      start,
      end,
      ...(unit ? { symbol: unit.symbol, name: unit.name, ...(unit.exported ? { exported: true } : {}) } : {}),
    }));
    // Which copies each match joined, and how similar they are (the most similar match of each two copies).
    const fragmentOf = new Map<number, number>();
    list.forEach((item, i) => item.occ.forEach((o) => fragmentOf.set(o, i)));
    const similarities = new Map<string, number>();
    const pairIds = [...new Set(members.map((i) => i >> 1))];
    for (const id of pairIds) {
      const x = fragmentOf.get(id * 2)!;
      const y = fragmentOf.get(id * 2 + 1)!;
      if (x === y) continue;
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      similarities.set(key, Math.max(similarities.get(key) ?? 0, pairs[id].similarity));
    }
    if (!similarities.size) continue;
    const best = pairIds.map((i) => pairs[i]).sort((x, y) => y.matched - x.matched || y.core.len - x.core.len || x.fa - y.fa || x.core.pos - y.core.pos)[0];
    let id = sequenceId(sources[best.fa].tokens.kinds, best.core);
    const seen = (ids.get(id) ?? 0) + 1;
    ids.set(id, seen);
    if (seen > 1) id = `${id}~${seen}`;
    const familyPairs: ClonePair[] = [...similarities]
      .map(([key, similarity]) => {
        const [a, b] = key.split(',').map(Number);
        return { a, b, similarity: Math.round(similarity * 100) / 100 };
      })
      .sort((x, y) => x.a - y.a || x.b - y.b);
    families.push({
      id,
      tokens: best.matched,
      lines: Math.max(...fragments.map((f) => f.end - f.start + 1)),
      similarity: Math.max(...familyPairs.map((p) => p.similarity)),
      fragments,
      pairs: familyPairs,
    });
  }
  return families.sort((x, y) => y.tokens * (y.fragments.length - 1) - x.tokens * (x.fragments.length - 1) || x.id.localeCompare(y.id));
}

/* -------------------------------------------------------------------------- */
/*                                 The project                                */
/* -------------------------------------------------------------------------- */

export interface ProjectClones {
  /** Every family, most worth fixing first (changed together most often, then the largest). */
  families: CloneFamily[];
  /** Lines of copies per source file (tests left out): copies at least `minSimilarity` similar to another. */
  duplicatedLines: Map<string, number>;
  /** The source files detection looked at (tests, generated and ignored files left out). */
  measured: Set<string>;
  /** Fingerprints too common to find clones with (boilerplate), ascending: a delta judges its head with the base's. */
  boilerplate: number[];
  /** A hash of each declaration's normalized tokens, by `fragmentKey` (`src/a.ts#slugify`; `src/a.ts#` for module-level code). */
  declarations: Map<string, string>;
}

/** Declaration hashes of an analysis, by its `insights.clones` list (in memory only: they are not part of the report). */
const DECLARATIONS = new WeakMap<object, ReadonlyMap<string, string>>();

/** Keep the declaration hashes of an analysis next to its clone families (see `declarationHashesOf`). */
export function rememberDeclarations(families: readonly CloneFamily[], declarations: ReadonlyMap<string, string>): void {
  DECLARATIONS.set(families, declarations);
}

/**
 * The declaration hashes of an analysis made in this process (by its `insights.clones`): whether a copy's
 * declaration changed between two analyses without line numbers (the live guard, what-ifs). Undefined for
 * reports read from disk or sent by a server.
 */
export function declarationHashesOf(families: readonly CloneFamily[] | undefined): ReadonlyMap<string, string> | undefined {
  return families ? DECLARATIONS.get(families) : undefined;
}

/**
 * Most worth fixing first: copies that were changed together (they drift), then whole declarations copied
 * ("import it instead"), then the most duplicated tokens.
 */
export function byImportance(x: CloneFamily, y: CloneFamily): number {
  const whole = (f: CloneFamily): number => (f.similarity >= 0.5 ? 1 : 0);
  // Two big files that change together share a small block by chance: co-changes rank substantial copies only.
  const together = (f: CloneFamily): number => (f.similarity >= 0.3 ? (f.coChanges ?? 0) : 0);
  return together(y) - together(x) || whole(y) - whole(x) || y.tokens * (y.fragments.length - 1) - x.tokens * (x.fragments.length - 1) || y.similarity - x.similarity || x.id.localeCompare(y.id);
}

/** Whether a file takes part in clone detection: generated code and declaration files never do. */
function detectable(f: Pick<FileInfo, 'id' | 'isGenerated'>, ignored: (id: string) => boolean): boolean {
  return !f.isGenerated && !f.id.endsWith('.d.ts') && !ignored(f.id);
}

function ignoreMatcher(patterns: string[]): (id: string) => boolean {
  if (!patterns.length) return () => false;
  const ig = ignore().add(patterns.map((p) => p.replace(/^\.\//, '')));
  return (id) => ig.ignores(id);
}

/** Files importing each symbol name of each file (through any import of it, by name, default or namespace). */
export function importerCounts(edges: readonly DependencyEdge[]): (file: string, name: string, isDefault?: boolean) => number {
  const byTarget = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    const list = byTarget.get(e.target);
    if (list) list.push(e);
    else byTarget.set(e.target, [e]);
  }
  const memo = new Map<string, number>();
  return (file, name, isDefault) => {
    const key = `${file}\0${name}\0${isDefault ? 1 : 0}`;
    let n = memo.get(key);
    if (n === undefined) {
      const sources = new Set<string>();
      for (const e of byTarget.get(file) ?? []) {
        if (e.kind === 'reexport' || e.kind === 'side-effect') continue;
        if (e.names.includes(name) || e.names.includes('*') || (isDefault && e.names.includes('default'))) sources.add(e.source);
      }
      n = sources.size;
      memo.set(key, n);
    }
    return n;
  };
}

/**
 * Clone families of a project: detection over its source files, plus what makes a family worth acting on
 * (how often its files were committed together, how many files import the copies). With `cache`, only
 * the files that changed since the last run are matched (see `CloneCache`); `boilerplate` judges with
 * another analysis's boilerplate fingerprints.
 */
export function projectClones(
  files: readonly FileInfo[],
  tokensOf: (file: FileInfo) => CloneTokens | undefined,
  settings: CloneSettings,
  extra: { edges?: readonly DependencyEdge[]; coupling?: readonly ChangeCoupling[] } & DetectOptions = {},
): ProjectClones {
  const ignored = ignoreMatcher(settings.ignore);
  const sources: CloneSource[] = [];
  const small: CloneSource[] = [];
  const measured = new Set<string>();
  for (const f of files) {
    if (!detectable(f, ignored)) continue;
    const tokens = tokensOf(f);
    if (!tokens) continue;
    const test = f.isTest || f.kind === 'test';
    if (!test) measured.add(f.id);
    (tokens.kinds.length >= settings.minTokens ? sources : small).push({ id: f.id, tokens, units: unitsOf(f), test });
  }
  const { families, boilerplate, indexes } = detect(sources, settings, { cache: extra.cache, boilerplate: extra.boilerplate });
  const declarations = new Map<string, string>();
  const addDeclarations = (src: CloneSource, index: FileIndex): void => {
    for (const [name, hash] of index.declarations) declarations.set(`${src.id}#${name}`, hash);
  };
  sources.forEach((src, i) => addDeclarations(src, indexes[i]));
  for (const src of small) addDeclarations(src, fileIndex(src));
  const importers = importerCounts(extra.edges ?? []);
  const symbols = new Map(files.flatMap((f) => f.symbols.map((s) => [s.id, s] as const)));
  const coupling = new Map<string, number>();
  for (const c of extra.coupling ?? []) {
    coupling.set(`${c.a}\0${c.b}`, c.count);
    coupling.set(`${c.b}\0${c.a}`, c.count);
  }
  const duplicatedLines = new Map<string, Set<number>>();
  for (const fam of families) {
    // Shared blocks that are a small part of their declarations (JSX markup, argument parsing written the
    // same way) are listed, but they are not what makes code duplicated.
    const counted = significantCopies(fam, settings.minSimilarity);
    fam.fragments.forEach((fr, i) => {
      const s = fr.symbol ? symbols.get(fr.symbol) : undefined;
      if (s?.exported) {
        const n = importers(fr.file, s.name, s.isDefault);
        if (n) fr.importers = n;
      }
      if (counted.has(i) && measured.has(fr.file)) {
        const lines = duplicatedLines.get(fr.file) ?? new Set<number>();
        for (let l = fr.start; l <= fr.end; l++) lines.add(l);
        duplicatedLines.set(fr.file, lines);
      }
    });
    let together = 0;
    const filesOf = [...new Set(fam.fragments.map((f) => f.file))];
    for (let i = 0; i < filesOf.length; i++) for (let j = i + 1; j < filesOf.length; j++) together = Math.max(together, coupling.get(`${filesOf[i]}\0${filesOf[j]}`) ?? 0);
    if (together) fam.coChanges = together;
  }
  families.sort(byImportance);
  return { families, duplicatedLines: new Map([...duplicatedLines].map(([f, set]) => [f, set.size])), measured, boilerplate, declarations };
}

/* -------------------------------------------------------------------------- */
/*                                findSimilar                                 */
/* -------------------------------------------------------------------------- */

export interface FindSimilarOptions {
  /** The tokens of each analyzed file (from the parse cache, or read and tokenized). */
  tokensOf: (file: FileInfo) => CloneTokens | undefined;
  /** 0..1 (default 0.8). */
  minSimilarity?: number;
  /** Matches to return (default 5). */
  limit?: number;
  /** Where the snippet itself is (a range of a project file): declarations overlapping it are not matches. */
  exclude?: { file: string; start: number; end: number };
  /** Files left out (gitignore-style globs; the `clones.ignore` setting). */
  ignore?: string[];
}

/** Snippets shorter than this are too generic to compare. */
const MIN_QUERY_TOKENS = 12;

/** Index of the bracket closing the one at `open` (same kind), or -1. */
function closing(kinds: Uint8Array, open: number, end: number, close: number): number {
  const kind = kinds[open];
  let depth = 0;
  for (let i = open; i < end; i++) {
    if (kinds[i] === kind) depth++;
    else if (kinds[i] === close && --depth === 0) return i;
  }
  return -1;
}

function concat(...parts: ArrayLike<number>[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A declaration's tokens whatever style it is written in: its header (`export`, `async`, `function name`
 * / `const name =`, generics) and return type left out, then its parameters and its body as a block (an
 * expression-bodied arrow gets `{ return … ; }`). So `export const f = (a: T): R => a * 2;` and
 * `export function f(a: T) { return a * 2; }` compare equal. Anything else is returned as it is.
 */
export function canonicalCallable(kinds: Uint8Array): Uint8Array {
  const k = kindsOf();
  let end = kinds.length;
  while (end > 0 && kinds[end - 1] === k.semicolon) end--;
  const open = kinds.indexOf(k.openParen);
  if (open < 0 || open >= end) return kinds;
  let equals = false;
  let variable = false;
  for (let i = 0; i < open; i++) {
    const t = kinds[i];
    if (t !== IDENT && !k.header.has(t)) return kinds;
    if (t === k.equals) equals = true;
    else if (k.variable.has(t)) variable = true;
  }
  // `x = f(…)` is a statement; `const x` is a declaration only as `const x = (…) =>` / `= function (…)`.
  if (equals !== variable) return kinds;
  const close = closing(kinds, open, end, k.closeParen);
  if (close < 0) return kinds;
  // The return type, then the body (`{`, or `=>`).
  let body = close + 1;
  if (body < end && kinds[body] === k.colon) {
    let depth = 0;
    for (body++; body < end; body++) {
      const t = kinds[body];
      if (depth === 0 && (t === k.arrow || (t === k.openBrace && !k.typeStart.has(kinds[body - 1])))) break;
      if (k.opens.has(t)) depth++;
      else if (k.closes.has(t)) depth--;
    }
  }
  const arrow = kinds[body] === k.arrow;
  if (arrow) body++;
  if (body >= end) return kinds;
  const params = kinds.subarray(open, close + 1);
  if (kinds[body] === k.openBrace) return closing(kinds, body, end, k.closeBrace) === end - 1 ? concat(params, kinds.subarray(body, end)) : kinds;
  return arrow ? concat(params, [k.openBrace, k.returnKw], kinds.subarray(body, end), [k.semicolon, k.closeBrace]) : kinds;
}

/**
 * Existing declarations that look like `query` (a pasted snippet or a range of a file), most similar first:
 * windows of the snippet's normalized tokens are looked up in every declaration ("vote by enclosing
 * symbol"); similarity is the share of tokens both have in common, measured against the larger of the two.
 * Snippets under 50 tokens are compared with exported functions only (with shorter windows). A block that
 * exists unchanged inside a larger function is a match too (`contained`).
 */
export function findSimilar(data: Pick<ReportData, 'files' | 'edges'>, query: CloneTokens | string, options: FindSimilarOptions): SimilarMatch[] {
  const q = typeof query === 'string' ? snippetTokens(query) : query;
  // Declarations are compared without their header style (`function f(…) {}` ≈ `const f = (…) => {}`).
  const qk = canonicalCallable(q.kinds.filter((k) => k !== BARRIER));
  const n = qk.length;
  if (n < MIN_QUERY_TOKENS) return [];
  const short = n < 50;
  // Short snippets: windows of 12 over exported functions; longer ones: windows of 16 find more of the shared code around edits.
  const W = short ? Math.min(12, n) : 16;
  const minSimilarity = options.minSimilarity ?? 0.8;
  // Query windows by hash.
  let power = 1;
  for (let i = 0; i < W - 1; i++) power = Math.imul(power, HASH_BASE);
  const windows = new Map<number, number[]>();
  let hash = 0;
  for (let i = 0; i < n; i++) {
    if (i >= W) hash = (hash - Math.imul(qk[i - W], power)) | 0;
    hash = (Math.imul(hash, HASH_BASE) + qk[i]) | 0;
    if (i >= W - 1) {
      const h = hash >>> 0;
      const list = windows.get(h);
      if (list) list.push(i - W + 1);
      else windows.set(h, [i - W + 1]);
    }
  }
  const ignored = ignoreMatcher(options.ignore ?? []);
  const importers = importerCounts(data.edges);
  const results: SimilarMatch[] = [];
  for (const file of data.files) {
    if (file.isTest || file.kind === 'test' || !detectable(file, ignored)) continue;
    const units = unitsOf(file).filter((u) => (short ? u.exported && u.callable : true) && !(u.info.kind === 'class' && u.info.members?.length));
    if (!units.length) continue;
    const tokens = options.tokensOf(file);
    if (!tokens) continue;
    for (const u of units) {
      if (options.exclude && options.exclude.file === file.id && u.start <= options.exclude.end && u.end >= options.exclude.start) continue;
      const [from, to] = tokenRange(tokens, u.start, u.end);
      if (to - from < W) continue;
      const uk = u.callable ? canonicalCallable(tokens.kinds.subarray(from, to)) : tokens.kinds.subarray(from, to);
      const len = uk.length;
      if (len < W) continue;
      let coveredQuery: Uint8Array | undefined;
      let coveredUnit: Uint8Array | undefined;
      let h = 0;
      let run = 0;
      for (let i = 0; i < len; i++) {
        const t = uk[i];
        if (t === BARRIER) {
          run = 0;
          h = 0;
          continue;
        }
        if (run >= W) h = (h - Math.imul(uk[i - W], power)) | 0;
        h = (Math.imul(h, HASH_BASE) + t) | 0;
        run++;
        if (run < W) continue;
        const starts = windows.get(h >>> 0);
        if (!starts) continue;
        const s = i - W + 1;
        for (const qs of starts) {
          let same = true;
          for (let x = 0; x < W; x++) {
            if (qk[qs + x] !== uk[s + x]) {
              same = false;
              break;
            }
          }
          if (!same) continue;
          coveredQuery ??= new Uint8Array(n);
          coveredUnit ??= new Uint8Array(len);
          coveredQuery.fill(1, qs, qs + W);
          coveredUnit.fill(1, s, s + W);
        }
      }
      if (!coveredQuery || !coveredUnit) continue;
      const cq = coveredQuery.reduce((a, b) => a + b, 0);
      const cu = coveredUnit.reduce((a, b) => a + b, 0);
      const similarity = Math.min(cq, cu) / Math.max(n, len);
      const contained = cq / n;
      // A block copied out of a function at least half again as long as the snippet.
      const asBlock = !short && len >= n * 1.5 && contained >= Math.max(minSimilarity, 0.9);
      if (similarity < minSimilarity && !asBlock) continue;
      const s = u.info;
      const sig = u.member
        ? signature({ ...s, kind: 'function', name: u.name, params: u.member.params, async: u.member.async, returnType: u.member.type })
        : signature(s);
      results.push({
        symbol: u.member ? `${s.id}.${u.member.name}` : s.id,
        file: file.id,
        line: u.start,
        endLine: u.end,
        name: u.name,
        similarity: Math.round(similarity * 100) / 100,
        ...(asBlock && contained > similarity ? { contained: Math.round(contained * 100) / 100 } : {}),
        signature: sig,
        importers: s.exported ? importers(file.id, s.name, s.isDefault) : 0,
        ...(s.exported ? { exported: true } : {}),
      });
    }
  }
  return results
    .sort((a, b) => Math.max(b.similarity, b.contained ?? 0) - Math.max(a.similarity, a.contained ?? 0) || b.importers - a.importers || a.file.localeCompare(b.file) || a.line - b.line)
    .slice(0, options.limit ?? 5);
}

/* -------------------------------------------------------------------------- */
/*                                 Token store                                */
/* -------------------------------------------------------------------------- */

/**
 * Tokens of the files of an analysis for commands that only have its ReportData (a running `serve`
 * answered): taken from the warm parse cache when the file did not change since, otherwise read and
 * tokenized; remembered per file by mtime and size for the life of the process (the MCP server).
 */
export class CloneTokenStore {
  private readonly memo = new Map<string, { mtimeMs: number; size: number; tokens: CloneTokens }>();
  private seeded?: Promise<void>;

  constructor(
    readonly root: string,
    /** Seed from `.code-visualizer/cache/` (default: true). */
    private readonly useDiskCache = true,
  ) {}

  /** Tokens for these files (project-relative ids), keyed by id; files that cannot be read are missing. */
  async load(ids: Iterable<string>): Promise<Map<string, CloneTokens>> {
    if (this.useDiskCache) await (this.seeded ??= this.seed());
    const out = new Map<string, CloneTokens>();
    for (const id of ids) {
      const abs = path.join(this.root, id);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const hit = this.memo.get(id);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        out.set(id, hit.tokens);
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const tokens = cloneTokens(text, path.extname(id).toLowerCase());
      this.memo.set(id, { mtimeMs: stat.mtimeMs, size: stat.size, tokens });
      out.set(id, tokens);
    }
    return out;
  }

  private async seed(): Promise<void> {
    try {
      const { loadDiskCache } = await import('./disk-cache.js');
      const cache: AnalyzeCache = { files: new Map(), byHash: new Map() };
      if (!loadDiskCache(this.root, cache)) return;
      for (const [id, entry] of cache.files) if (entry.parsed.tokens) this.memo.set(id, { mtimeMs: entry.mtimeMs, size: entry.size, tokens: entry.parsed.tokens });
    } catch {
      /* no warm cache: files are tokenized on demand */
    }
  }
}

/** What to look for: a pasted snippet, or lines of a project file. */
export interface SimilarRequest {
  snippet?: string;
  /** Language of the snippet as an extension (`.ts`, `.tsx`, `.vue`…; default `.tsx`). */
  lang?: string;
  /** A project-relative file; with `start` / `end` (1-based, inclusive) its lines, else the whole file. */
  file?: string;
  start?: number;
  end?: number;
  /** 0..1 (default 0.8). */
  minSimilarity?: number;
  /** Default 5. */
  limit?: number;
}

export interface SimilarAnswer {
  /**
   * What was compared: the snippet, or a range of a file (one line stands for the declaration around it;
   * `name`, `exported` and `importers` describe that declaration). `lines`: the file's length.
   */
  query: { file?: string; start?: number; end?: number; name?: string; exported?: boolean; importers?: number; lines?: number; tokens: number };
  matches: SimilarMatch[];
  /** Clone families of the analysis that include the range (copies of it that already exist). */
  copies: CloneFamily[];
  /** The file could not be read, the lines are not in it, or the snippet has too few tokens to compare. */
  error?: 'not-found' | 'out-of-range' | 'too-short';
}

/**
 * The lines of a symbol id (`src/a.ts#slugify`; `src/a.ts#Cart.add` for a class member, whose first line
 * stands for the member) as a `similarTo` request.
 */
export function symbolLines(data: Pick<ReportData, 'files'>, id: string): { file: string; start: number; end?: number } | undefined {
  const hash = id.indexOf('#');
  if (hash <= 0) return undefined;
  const file = data.files.find((f) => f.id === id.slice(0, hash));
  const [top, member] = id.slice(hash + 1).split('.');
  const s = file?.symbols.find((x) => x.id === `${file.id}#${top}`) ?? file?.symbols.find((x) => x.name === top);
  if (!file || !s) return undefined;
  const m = member ? s.members?.find((x) => x.name === member) : undefined;
  return m ? { file: file.id, start: m.line } : { file: file.id, start: s.line, end: s.endLine };
}

/** Files whose tokens `findSimilar` compares with (sources; tests and generated files left out). */
const comparable = (f: FileInfo): boolean => !f.isTest && f.kind !== 'test' && !f.isGenerated && !f.id.endsWith('.d.ts');

/**
 * Existing code like a snippet or a range of a file (`code-visualizer similar`, MCP `find_similar`): the
 * most similar declarations, plus the clone families the range is already part of. Tokens come from
 * `store` (the warm parse cache, else the files on disk), so the answer also works on a ReportData that a
 * running `serve` sent, and on a file written a moment ago.
 */
export async function similarTo(data: ReportData, store: CloneTokenStore, request: SimilarRequest): Promise<SimilarAnswer> {
  const sources = data.files.filter(comparable);
  const ids = [...sources.map((f) => f.id), ...(request.file ? [request.file] : [])];
  const tokens = await store.load(ids);
  const tokensOf = (f: Pick<FileInfo, 'id'>): CloneTokens | undefined => tokens.get(f.id);
  let query: CloneTokens;
  const where: SimilarAnswer['query'] = { tokens: 0 };
  if (request.file) {
    const all = tokens.get(request.file);
    if (!all) return { query: { file: request.file, tokens: 0 }, matches: [], copies: [], error: 'not-found' };
    const info = data.files.find((f) => f.id === request.file);
    const lines = Math.max(info?.loc ?? 0, all.lines[all.lines.length - 1] ?? 0);
    if (request.start !== undefined && (request.start < 1 || request.start > lines)) return { query: { file: request.file, start: request.start, end: request.end, lines, tokens: 0 }, matches: [], copies: [], error: 'out-of-range' };
    let start = request.start ?? 1;
    let end = request.end ?? request.start ?? Number.MAX_SAFE_INTEGER;
    // One line: the declaration around it (the function you are looking at).
    let unit: CloneUnit | undefined;
    if (request.start !== undefined && (request.end === undefined || request.end === request.start) && info) {
      unit = unitsOf(info)
        .filter((u) => u.start <= start && u.end >= start)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      if (unit) {
        start = unit.start;
        end = unit.end;
      }
    } else if (info && request.start !== undefined) unit = unitsOf(info).find((u) => u.start === start && u.end === end);
    if (unit) {
      where.name = unit.name;
      // Whether it is the copy to keep: exported, and used by other files.
      if (unit.exported) Object.assign(where, { exported: true, importers: importerCounts(data.edges)(request.file, unit.info.name, unit.info.isDefault) });
    }
    query = request.start === undefined ? all : sliceTokens(all, start, end);
    Object.assign(where, { file: request.file, ...(request.start !== undefined ? { start, end: Math.min(end, all.lines[all.lines.length - 1] ?? end) } : {}) });
  } else query = snippetTokens(request.snippet ?? '', request.lang ? (request.lang.startsWith('.') ? request.lang : `.${request.lang}`) : '.tsx');
  where.tokens = [...query.kinds].filter((k) => k !== BARRIER).length;
  if (where.tokens < MIN_QUERY_TOKENS) return { query: where, matches: [], copies: [], error: 'too-short' };
  const exclude = request.file ? { file: request.file, start: where.start ?? 1, end: where.end ?? Number.MAX_SAFE_INTEGER } : undefined;
  const matches = findSimilar({ files: sources, edges: data.edges }, query, { tokensOf, minSimilarity: request.minSimilarity, limit: request.limit, exclude });
  const range = exclude && { start: exclude.start, end: exclude.end };
  const copies = request.file ? (data.insights.clones ?? []).filter((fam) => fam.fragments.some((f) => f.file === request.file && (!range || (f.start <= range.end && f.end >= range.start)))) : [];
  return { query: where, matches, copies };
}

/* -------------------------------------------------------------------------- */
/*                                  The gate                                  */
/* -------------------------------------------------------------------------- */

/** The copy a new-clone finding points at (the new one, else one in a file in scope). */
function newCopy(family: CloneFamily, inScope: (file: string) => boolean): CloneFragment | undefined {
  return family.fragments.find((f) => f.isNew && inScope(f.file)) ?? family.fragments.find((f) => inScope(f.file));
}

/**
 * `check --max-new-clones <n>` (`check.maxNewClones`): fails when the change adds more than n clone
 * families compared with its base (`changes.delta.newClones`: copies at least `clones.minSimilarity` of
 * their declaration). Copies that already existed are never blamed, in every mode, so the gate judges
 * itself. When the comparison with the base failed, copies pasted on added lines are new.
 */
export const clonesGate: GateProvider = (data, ctx) => {
  const max = ctx.thresholds.maxNewClones;
  if (max === undefined) return undefined;
  const base = { id: 'clones', label: 'New duplication', ruleIds: [RULE_IDS.duplicateCode as string], newOnly: false, keepDetail: true };
  if (!data.insights.clones) return { ...base, ok: true, detail: 'not judged: clone detection is off ("clones": false)', findings: [] };
  let added: CloneFamily[];
  let how = '';
  if (ctx.delta) added = ctx.delta.newClones ?? [];
  else if (data.changes?.files.length) {
    added = pastedClones(data.insights.clones, data.changes.files);
    how = ' · judged by the added lines (no base to compare with)';
  } else return { ...base, ok: true, detail: data.changes ? `no new clones (max ${max}) · nothing changed` : 'not judged: no base to compare with (needs git)', findings: [] };
  added = added.filter((fam) => !!newCopy(fam, ctx.inScope));
  const findings: Finding[] = added.map((fam) => {
    const copy = newCopy(fam, ctx.inScope)!;
    return {
      ruleId: RULE_IDS.duplicateCode,
      gate: 'clones',
      file: copy.file,
      line: copy.start,
      message: newCloneMessage(fam),
      severity: 'error',
      subject: fam.id,
      fingerprint: cloneFingerprint(fam),
      status: 'new',
      weight: fam.tokens,
    };
  });
  const fixed: Finding[] = (ctx.delta?.fixedClones ?? []).map((fam) => ({
    ruleId: RULE_IDS.duplicateCode,
    gate: 'clones',
    file: fam.fragments[0]?.file ?? '',
    line: fam.fragments[0]?.start,
    message: `Copy-paste clone merged or removed: ${fam.fragments.slice(0, 3).map(fragmentLocation).join(' ≈ ')}`,
    severity: 'note',
    subject: fam.id,
    fingerprint: cloneFingerprint(fam),
    status: 'fixed',
  }));
  const drifted = ctx.delta?.driftedClones?.length ?? 0;
  const extra = [fixed.length ? `${fixed.length} fixed` : '', drifted ? `${drifted} drifted apart (see clone drift)` : ''].filter(Boolean).map((x) => ` · ${x}`).join('');
  return {
    ...base,
    ok: added.length <= max,
    detail: `${added.length ? `${added.length} new clone${added.length === 1 ? '' : 's'}` : 'no new clones'} (max ${max})${extra}${how}`,
    findings,
    ...(fixed.length ? { fixed } : {}),
  };
};

/* -------------------------------------------------------------------------- */
/*                                 Live guard                                 */
/* -------------------------------------------------------------------------- */

/** Whether a report still has a family with both copies (by file and declaration); captures only strings. */
function stillCloned(copyKey: string, originalKey: string): (report: ReportData) => boolean {
  return (report) =>
    (report.insights.clones ?? []).some((fam) => {
      const keys = fam.fragments.map(fragmentKey);
      return keys.includes(copyKey) && keys.includes(originalKey);
    });
}

/** `serve`: "slugify() in src/ui/utils.ts is 94% similar to exported slugify() in src/lib/strings.ts …: import it instead". */
export const cloneDetector: LiveDetector = ({ delta }) =>
  (delta.newClones ?? []).slice(0, 5).flatMap((fam): LiveCandidate[] => {
    const { copy, original } = cloneSides(fam);
    if (!copy || !original) return [];
    const copyKey = fragmentKey(copy);
    const originalKey = fragmentKey(original);
    const name = copy.name ?? `the copy in ${copy.file}`;
    return [
      {
        event: {
          kind: 'clone-added',
          severity: 'warning',
          message: newCloneMessage(fam),
          detail: `${copy.file}:${copy.start}-${copy.end} ≈ ${original.file}:${original.start}-${original.end}`,
          files: [copy.file, original.file],
          line: copy.start,
          ...(copy.symbol ? { symbol: copy.symbol } : {}),
          fingerprint: cloneFingerprint(fam),
        },
        stillOpen: stillCloned(copyKey, originalKey),
        resolved: () => ({ kind: 'clone-added', severity: 'success', message: `${name} no longer duplicates ${original.name ?? original.file}`, files: [copy.file], fingerprint: cloneFingerprint(fam) }),
      },
    ];
  });
