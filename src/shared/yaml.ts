/**
 * A small YAML reader for the files this tool inspects: GitHub workflows, Dependabot configuration and
 * the front matter of Claude skills. It handles what those files use — block and flow collections,
 * plain, quoted and block (`|`, `>`) scalars, anchors, aliases, `<<` merges, comments and multi-line
 * values — and records the line of every key and list item, so a finding can point at the exact line.
 *
 * It is not a complete YAML implementation: tags are ignored, keys are always strings and only the first
 * document is read. Scalars follow YAML 1.2 (`yes` and `on` are strings). Pure and dependency-free.
 */

export interface YamlError {
  message: string;
  /** 1-based line of the problem. */
  line: number;
}

export interface YamlResult {
  /** The document, or `undefined` when it could not be read (see `error`). An empty document is `null`. */
  value: unknown;
  error?: YamlError;
  /** Line of each key and list item, keyed by `yamlPath(...)`. */
  lines: ReadonlyMap<string, number>;
}

const PATH_SEPARATOR = '\u0001';
const MAX_DEPTH = 64;
const MAX_LINES = 20_000;
const ERROR_SNIPPET_LENGTH = 40;

/** The key of a position in the document: `yamlPath('jobs', 'build', 'steps', 0)`. */
export function yamlPath(...segments: (string | number)[]): string {
  return segments.join(PATH_SEPARATOR);
}

/** The line of the key or list item at `segments`, if the document has one. */
export function yamlLine(result: YamlResult, ...segments: (string | number)[]): number | undefined {
  return result.lines.get(yamlPath(...segments));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Line {
  /** 1-based. */
  no: number;
  indent: number;
  /** The content without indentation and comment; empty for blank and comment-only lines. */
  text: string;
  raw: string;
}

class YamlSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

export function parseYaml(source: string): YamlResult {
  try {
    const parser = new Parser(prepare(source));
    const value = parser.document();
    return { value, lines: parser.paths };
  } catch (error) {
    if (error instanceof YamlSyntaxError) return { value: undefined, error: { message: error.message, line: error.line }, lines: new Map() };
    if (error instanceof RangeError) return { value: undefined, error: { message: 'The document is nested too deeply', line: 1 }, lines: new Map() };
    throw error;
  }
}

/* --------------------------------- Lines ----------------------------------- */

function prepare(source: string): Line[] {
  const rows = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (rows.length > MAX_LINES) throw new YamlSyntaxError('The file is too long to read', 1);
  return rows.map((raw, index) => {
    const indent = raw.length - raw.trimStart().length;
    return { no: index + 1, indent, text: stripComment(raw.slice(indent)).trimEnd(), raw };
  });
}

/**
 * Cuts a comment (`#` after whitespace). A quote only starts a quoted string where a value starts (after
 * `- `, `: `, `[`, `{` or `,`): in a plain scalar such as `echo "a # b"` the comment really starts at ` #`.
 */
function stripComment(text: string): string {
  let atValueStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (atValueStart && (ch === '"' || ch === "'")) {
      const quoted = readQuoted(text, i);
      if (!quoted) return text; // continues on the next line
      i = quoted.end - 1;
      atValueStart = false;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
    if (ch === ' ') continue;
    const next = text[i + 1];
    atValueStart = (ch === '-' && (next === ' ' || next === undefined)) || (ch === ':' && (next === ' ' || next === undefined)) || ch === '[' || ch === '{' || ch === ',';
  }
  return text;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', b: '\b', f: '\f', e: '\u001b' };

/**
 * The quoted string that starts at `start` and where it ends; undefined when it is not closed. A bad escape
 * sequence is an error when `line` is given, and is kept as written when only scanning (`line` unset).
 */
function readQuoted(text: string, start: number, line?: number): { value: string; end: number } | undefined {
  const quote = text[start];
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch !== "'") {
        value += ch;
      } else if (text[i + 1] === "'") {
        value += "'";
        i++;
      } else {
        return { value, end: i + 1 };
      }
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    if (ch !== '\\') {
      value += ch;
      continue;
    }
    const escape = text[++i];
    if (escape === 'x' || escape === 'u') {
      const digits = escape === 'x' ? 2 : 4;
      const code = text.slice(i + 1, i + 1 + digits);
      const valid = code.length === digits && /^[0-9a-fA-F]+$/.test(code);
      if (!valid && line !== undefined) throw new YamlSyntaxError('Invalid escape sequence in a quoted string', line);
      value += valid ? String.fromCharCode(parseInt(code, 16)) : `\\${escape}`;
      if (valid) i += digits;
    } else if (escape !== undefined && escape in ESCAPES) value += ESCAPES[escape];
    else value += `\\${escape ?? ''}`;
  }
  return undefined;
}

/* -------------------------------- Scalars ---------------------------------- */

function resolvePlain(text: string): unknown {
  if (text === '' || text === '~' || /^(null|Null|NULL)$/.test(text)) return null;
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : text;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

const isItem = (text: string): boolean => text === '-' || text.startsWith('- ');

/** `key: rest` → the key and what follows the colon. Quoted keys are supported; flow collections are not keys. */
function splitKey(text: string): { key: string; rest: string } | undefined {
  const first = text[0];
  if (first === '[' || first === '{' || first === '|' || first === '>' || first === '*') return undefined;
  if (first === '"' || first === "'") {
    const quoted = readQuoted(text, 0);
    if (!quoted) return undefined;
    const after = /^\s*:(?:\s+(.*))?$/.exec(text.slice(quoted.end));
    return after ? { key: quoted.value, rest: (after[1] ?? '').trim() } : undefined;
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ':' || (i + 1 < text.length && text[i + 1] !== ' ')) continue;
    const key = text.slice(0, i).trim();
    return key ? { key, rest: text.slice(i + 1).trim() } : undefined;
  }
  return undefined;
}

/** Leading `&anchor` and `!tag` of a value. Only clean tag names count, so `!cancelled()` stays text. */
function takeProps(text: string): { anchor?: string; text: string } {
  let rest = text;
  let anchor: string | undefined;
  for (;;) {
    const anchorMatch = /^&(\S+)\s*/.exec(rest);
    const tagMatch = anchorMatch ? undefined : /^!{1,2}[\w-]*(?:\s+|$)/.exec(rest);
    const match = anchorMatch ?? tagMatch;
    if (!match) return { anchor, text: rest };
    if (anchorMatch) anchor = anchorMatch[1];
    rest = rest.slice(match[0].length);
  }
}

function fold(lines: string[]): string {
  let out = '';
  lines.forEach((line, i) => {
    if (i === 0) out = line;
    else if (line === '') out += '\n';
    else if (lines[i - 1] === '') out += line;
    else out += (/^\s/.test(line) || /^\s/.test(lines[i - 1]) ? '\n' : ' ') + line;
  });
  return out;
}

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** True when every `[` and `{` outside quotes and `${{ }}` expressions is closed. */
function isBalanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '$' && text.startsWith('${{', i)) {
      const end = text.indexOf('}}', i + 3);
      if (end < 0) return false;
      i = end + 1;
    } else if (ch === '"' || ch === "'") {
      const quoted = readQuoted(text, i);
      if (!quoted) return false;
      i = quoted.end - 1;
    } else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth <= 0;
}

/* ---------------------------------- Flow ----------------------------------- */

/** Reads `[a, b]` and `{a: 1}`; `${{ … }}` expressions stay inside a plain scalar. */
class FlowReader {
  private i = 0;

  constructor(
    private readonly s: string,
    private readonly line: number,
    private readonly anchors: Map<string, unknown>,
  ) {}

  read(): unknown {
    const value = this.value();
    this.skipSpace();
    if (this.i < this.s.length) throw new YamlSyntaxError('Unexpected text after a flow collection', this.line);
    return value;
  }

  private skipSpace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private value(): unknown {
    this.skipSpace();
    const ch = this.s[this.i];
    if (ch === '[') return this.sequence();
    if (ch === '{') return this.mapping();
    return this.scalar(false);
  }

  private sequence(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.skipSpace();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) throw new YamlSyntaxError('Unterminated list', this.line);
      out.push(this.value());
      this.skipSpace();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') throw new YamlSyntaxError('Expected "," or "]" in a list', this.line);
    }
  }

  private mapping(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipSpace();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      if (this.i >= this.s.length) throw new YamlSyntaxError('Unterminated mapping', this.line);
      const key = String(this.scalar(true) ?? '');
      this.skipSpace();
      let value: unknown = null;
      if (this.s[this.i] === ':') {
        this.i++;
        this.skipSpace();
        if (this.s[this.i] !== ',' && this.s[this.i] !== '}') value = this.value();
      }
      define(out, key, value);
      this.skipSpace();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') throw new YamlSyntaxError('Expected "," or "}" in a mapping', this.line);
    }
  }

  private scalar(isKey: boolean): unknown {
    this.skipSpace();
    const ch = this.s[this.i];
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(this.s, this.i, this.line);
      if (!quoted) throw new YamlSyntaxError('Unterminated quoted string', this.line);
      this.i = quoted.end;
      return quoted.value;
    }
    if (ch === '*' && !isKey) {
      const name = /^\*([^\s,\]}]+)/.exec(this.s.slice(this.i));
      if (name) {
        this.i += name[0].length;
        return this.anchors.has(name[1]) ? structuredClone(this.anchors.get(name[1])) : name[0];
      }
    }
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '$' && this.s.startsWith('${{', this.i)) {
        const end = this.s.indexOf('}}', this.i + 3);
        this.i = end < 0 ? this.s.length : end + 2;
        continue;
      }
      if (c === ',' || c === ']' || c === '}') break;
      if (c === ':' && (this.i + 1 >= this.s.length || ' ,]}'.includes(this.s[this.i + 1]))) break;
      this.i++;
    }
    const text = this.s.slice(start, this.i).trim();
    return isKey ? text : resolvePlain(text);
  }
}

/* --------------------------------- Parser ---------------------------------- */

class Parser {
  readonly paths = new Map<string, number>();
  private index = 0;
  private readonly anchors = new Map<string, unknown>();

  constructor(private readonly lines: Line[]) {}

  document(): unknown {
    while (this.index < this.lines.length) {
      const { text } = this.lines[this.index];
      if (text !== '' && !text.startsWith('%') && text !== '---') break;
      this.index++;
    }
    const first = this.peek();
    if (!first) return null;
    const value = this.node([], -1, 0);
    const extra = this.peek();
    if (extra) throw new YamlSyntaxError(`Unexpected content: ${clip(extra.text)}`, extra.no);
    return value;
  }

  /** The next line with content; undefined at the end of the document (`---` and `...` end it). */
  private peek(): Line | undefined {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index];
      if (line.text === '') {
        this.index++;
        continue;
      }
      if (line.indent === 0 && (line.text === '---' || line.text === '...')) return undefined;
      if (/^ *\t/.test(line.raw)) throw new YamlSyntaxError('Tabs cannot be used for indentation', line.no);
      return line;
    }
    return undefined;
  }

  /** A node that starts on the next line. `parentIndent` is the indentation of the key or dash it belongs to. */
  private node(path: string[], parentIndent: number, depth: number): unknown {
    if (depth > MAX_DEPTH) throw new YamlSyntaxError('The document is nested too deeply', this.lines[this.index]?.no ?? 1);
    const line = this.peek();
    if (!line) return null;
    if (isItem(line.text)) return this.sequence(line.indent, path, depth);
    if (splitKey(line.text)) return this.mapping(line.indent, path, depth);
    this.index++;
    return this.value(line.text, line, parentIndent, path, depth, false);
  }

  private sequence(indent: number, path: string[], depth: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new YamlSyntaxError('Unexpected indentation', line.no);
      if (!isItem(line.text)) break;
      const itemPath = [...path, String(out.length)];
      this.paths.set(itemPath.join(PATH_SEPARATOR), line.no);
      const rest = line.text === '-' ? '' : line.text.slice(1).trimStart();
      if (rest === '') {
        this.index++;
        out.push(this.value('', line, indent, itemPath, depth, false));
        continue;
      }
      // What follows the dash is read as if it started on a line of its own, indented to where it begins.
      this.lines[this.index] = { ...line, indent: indent + (line.text.length - rest.length), text: rest };
      out.push(this.node(itemPath, indent, depth + 1));
    }
    return out;
  }

  private mapping(indent: number, path: string[], depth: number): Record<string, unknown> {
    const explicit: Record<string, unknown> = {};
    const merged: Record<string, unknown> = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent < indent) break;
      if (line.indent > indent) throw new YamlSyntaxError('Unexpected indentation', line.no);
      if (isItem(line.text)) throw new YamlSyntaxError('Unexpected list item', line.no);
      const entry = splitKey(line.text);
      if (!entry) throw new YamlSyntaxError(`Expected "key: value", found "${clip(line.text)}"`, line.no);
      this.index++;
      const keyPath = [...path, entry.key];
      this.paths.set(keyPath.join(PATH_SEPARATOR), line.no);
      const value = this.value(entry.rest, line, indent, keyPath, depth, true);
      if (entry.key === '<<') mergeInto(merged, value);
      else define(explicit, entry.key, value);
    }
    if (!Object.keys(merged).length) return explicit;
    // Keys the mapping sets itself win over the ones merged in.
    for (const [key, value] of Object.entries(explicit)) define(merged, key, value);
    return merged;
  }

  /**
   * The value that starts on `line`: `text` is what is left of the line after the key or the dash. An empty
   * value is whatever the next, more indented lines hold (a list may sit at the key's own indentation).
   */
  private value(text: string, line: Line, parentIndent: number, path: string[], depth: number, listMaySitAtKey: boolean): unknown {
    const props = takeProps(text);
    let result: unknown;
    if (props.text === '') {
      const next = this.peek();
      if (next && next.indent > parentIndent) result = this.node(path, parentIndent, depth + 1);
      else if (listMaySitAtKey && next && next.indent === parentIndent && isItem(next.text)) result = this.sequence(parentIndent, path, depth + 1);
      else result = null;
    } else result = this.inline(props.text, line, parentIndent);
    if (props.anchor) this.anchors.set(props.anchor, result);
    return result;
  }

  private inline(text: string, line: Line, parentIndent: number): unknown {
    switch (text[0]) {
      case '|':
      case '>':
        return this.blockScalar(text, line, parentIndent);
      case '[':
      case '{':
        return this.flow(text, line);
      case '"':
      case "'":
        return this.quoted(text, line);
      case '*': {
        const name = text.slice(1).trim();
        return this.anchors.has(name) ? structuredClone(this.anchors.get(name)) : text;
      }
      default:
        return this.plain(text, parentIndent);
    }
  }

  /** A plain scalar; more indented lines that follow continue it, folded into one line. */
  private plain(text: string, parentIndent: number): unknown {
    let out = text;
    for (;;) {
      const next = this.peek();
      if (!next || next.indent <= parentIndent) break;
      // A plain scalar cannot contain ": ", so this is a key that is indented too far.
      if (splitKey(next.text)) throw new YamlSyntaxError('Unexpected indentation', next.no);
      out += ` ${next.text}`;
      this.index++;
    }
    return resolvePlain(out);
  }

  private quoted(text: string, line: Line): string {
    let source = text;
    for (;;) {
      const quoted = readQuoted(source, 0, line.no);
      if (quoted) {
        if (source.slice(quoted.end).trim()) throw new YamlSyntaxError('Unexpected text after a quoted value', line.no);
        return quoted.value;
      }
      const next = this.lines[this.index];
      if (!next) throw new YamlSyntaxError('Unterminated quoted string', line.no);
      this.index++;
      source += next.raw.trim() === '' ? '\n' : ` ${next.raw.trim()}`;
    }
  }

  private flow(text: string, line: Line): unknown {
    let source = text;
    while (!isBalanced(source)) {
      const next = this.lines[this.index];
      if (!next) throw new YamlSyntaxError('Unterminated flow collection', line.no);
      this.index++;
      source += ` ${next.text}`;
    }
    return new FlowReader(source, line.no, this.anchors).read();
  }

  /** `|` keeps line breaks, `>` folds them; `-` and `+` strip or keep the trailing ones. */
  private blockScalar(header: string, line: Line, parentIndent: number): string {
    const match = /^([|>])([+-]?)([1-9]?)([+-]?)$/.exec(header);
    if (!match) throw new YamlSyntaxError(`Invalid block scalar header: ${clip(header)}`, line.no);
    const folded = match[1] === '>';
    const chomp = match[2] || match[4];
    let blockIndent = match[3] ? Math.max(parentIndent, 0) + Number(match[3]) : -1;
    const body: string[] = [];
    while (this.index < this.lines.length) {
      const next = this.lines[this.index];
      const blank = next.raw.trim() === '';
      if (!blank) {
        if (blockIndent < 0) {
          if (next.indent <= parentIndent) break;
          blockIndent = next.indent;
        } else if (next.indent < blockIndent) break;
      }
      body.push(blank ? next.raw.slice(Math.max(blockIndent, 0)) : next.raw.slice(blockIndent));
      this.index++;
    }
    let end = body.length;
    while (end > 0 && body[end - 1].trim() === '') end--;
    const content = body.slice(0, end);
    const trailing = body.length - end;
    if (content.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
    const text = folded ? fold(content) : content.join('\n');
    if (chomp === '-') return text;
    return chomp === '+' ? text + '\n'.repeat(1 + trailing) : `${text}\n`;
  }
}

/** `<<: *base` and `<<: [*a, *b]`: copies keys the mapping does not set itself. */
function mergeInto(target: Record<string, unknown>, source: unknown): void {
  const sources = Array.isArray(source) ? source : [source];
  for (const item of sources) {
    if (!isRecord(item)) continue;
    for (const [key, value] of Object.entries(item)) if (!(key in target)) define(target, key, value);
  }
}

const clip = (text: string): string => (text.length > ERROR_SNIPPET_LENGTH ? `${text.slice(0, ERROR_SNIPPET_LENGTH)}…` : text);
