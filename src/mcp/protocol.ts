/**
 * The Model Context Protocol as code-visualizer speaks it: JSON-RPC 2.0 messages over stdio, the shape
 * of tools, resources and prompts, argument validation against a tool's input schema, and the text
 * helpers every answer uses (an output budget, fenced repo text). No dependencies, no Node APIs.
 */
import type { ReportData } from '../shared/types.js';

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC and MCP error codes. */
export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** MCP: the resource does not exist. */
  resourceNotFound: -32002,
  /** MCP 2026-07-28: the request's protocol version is not supported (data: { supported, requested }). */
  unsupportedVersion: -32022,
} as const;

/** Handshake-based revisions answered through `initialize` (newest first). */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Stateless revisions: the version rides on every request (`_meta`), discovery is `server/discover`. */
export const MODERN_VERSIONS = ['2026-07-28'] as const;
/** The `_meta` key that carries a stateless request's protocol version. */
export const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
export const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

export type ResponseFormat = 'concise' | 'detailed';

/** A rendered answer: Markdown for the model and the same facts as structured data. */
export interface RenderedAnswer {
  text: string;
  structured: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** What a tool, resource or prompt handler can use: the analysis, cancellation and progress. */
export interface McpContext {
  /** Absolute project root. */
  root: string;
  /** The up-to-date analysis (re-analyzes what changed since the last call). */
  report(): Promise<ReportData>;
  /** Aborted when the client cancels the request (`notifications/cancelled`) or disconnects. */
  signal: AbortSignal;
  /** Report progress when the client asked for it (`_meta.progressToken`); ignored otherwise. */
  progress(n: number, total?: number, msg?: string): void;
  /** A one-off analysis with another base for "my changes" (`review_changes { base }`). */
  reportFor?(options: { base?: string }): Promise<ReportData>;
  /**
   * The analysis again after these project-relative files changed: a file created a moment ago (or
   * with `--no-watch`) that the last analysis has not seen yet.
   */
  refresh?(paths: string[]): Promise<ReportData>;
  /** What this server analyzes: without git (`--no-git`) there is no history and no change detection. */
  analysis?: { git: boolean; changes: boolean };
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
  run(args: Record<string, unknown>, ctx: McpContext): Promise<ToolResult>;
}

/** A fixed resource (`cv://project/summary`) or a template (`cv://file/{path}`). */
export interface ResourceDef {
  /** The URI, or the RFC 6570 template for template resources. */
  uri: string;
  template?: boolean;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Whether this definition serves `uri` (templates match a prefix). */
  matches(uri: string): boolean;
  read(uri: string, ctx: McpContext): Promise<string>;
}

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
  get(args: Record<string, string>, ctx: McpContext): Promise<{ description: string; messages: PromptMessage[] }>;
}

/** A JSON-RPC error that a handler throws to answer the request with this error. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Every tool only reads the analysis: safe to call any time, any number of times, offline. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** The `limit` and `response_format` arguments every tool accepts. */
export const COMMON_PROPERTIES = {
  limit: { type: 'integer', minimum: 1, maximum: 500, default: 30, description: 'Max items per list.' },
  response_format: { type: 'string', enum: ['concise', 'detailed'], default: 'concise', description: 'detailed: more items and fields.' },
} as const;

/* -------------------------------------------------------------------------- */
/*                              Argument checking                             */
/* -------------------------------------------------------------------------- */

interface PropertySchema {
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  enum?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  items?: { type?: string };
  default?: unknown;
}

const BOOLEAN_WORDS: Record<string, boolean> = { true: true, false: false, yes: true, no: false, '1': true, '0': false };

type Checked = { value: unknown } | { error: string };

/** Per JSON type: the value in its proper type (accepting obvious encodings), or an error naming the argument. */
const CHECKS: Record<string, (key: string, v: unknown, prop: PropertySchema) => Checked> = {
  string(key, v, prop) {
    const text = typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;
    if (typeof text !== 'string') return { error: `"${key}" must be a string.` };
    if (prop.enum) {
      const hit = prop.enum.find((e) => e.toLowerCase() === text.trim().toLowerCase());
      return hit ? { value: hit } : { error: `"${key}" must be one of ${prop.enum.map((e) => `"${e}"`).join(', ')}.` };
    }
    return prop.minLength && text.trim().length < prop.minLength ? { error: `"${key}" must not be empty.` } : { value: text };
  },
  integer: (key, v, prop) => checkNumber(key, v, prop, true),
  number: (key, v, prop) => checkNumber(key, v, prop, false),
  boolean(key, v) {
    const word = typeof v === 'string' ? BOOLEAN_WORDS[v.trim().toLowerCase()] : v;
    return typeof word === 'boolean' ? { value: word } : { error: `"${key}" must be true or false.` };
  },
  array(key, v, prop) {
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) return { error: `"${key}" must be a list of strings.` };
    return prop.minItems && list.length < prop.minItems ? { error: `"${key}" needs at least ${plural(prop.minItems, 'item')}.` } : { value: list };
  },
};

function checkNumber(key: string, v: unknown, prop: PropertySchema, integer: boolean): Checked {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || (integer && !Number.isInteger(n))) return { error: `"${key}" must be ${integer ? 'a whole number' : 'a number'}.` };
  const low = prop.minimum ?? -Infinity;
  const high = prop.maximum ?? Infinity;
  return n < low || n > high ? { error: `"${key}" must be between ${prop.minimum ?? '-∞'} and ${prop.maximum ?? '∞'} (got ${n}).` } : { value: n };
}

/**
 * Check tool arguments against the tool's input schema (the small subset the tools use: required keys,
 * no extra keys, string / integer / number / boolean / string-array types, enums and bounds) and fill in
 * defaults. Obvious encodings are accepted (`"2"` for 2, `"true"`, one string for a list), because models
 * produce them; anything else is an error message naming the argument.
 */
export function validateArguments(schema: JsonSchemaObject, raw: unknown): { value: Record<string, unknown> } | { error: string } {
  const input = (raw ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'arguments must be an object.' };
  const props = schema.properties as Record<string, PropertySchema>;
  const known = Object.keys(props);
  const extra = Object.keys(input).find((key) => !Object.hasOwn(props, key));
  if (extra !== undefined) return { error: `Unknown argument "${extra}"${known.length ? ` (expected: ${known.join(', ')})` : ' (this tool takes no arguments)'}.` };
  const missing = (schema.required ?? []).find((key) => input[key] === undefined || input[key] === null);
  if (missing !== undefined) return { error: `Missing required argument "${missing}".` };
  const value: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (prop.default !== undefined) value[key] = prop.default;
      continue;
    }
    const checked = prop.type ? CHECKS[prop.type](key, v, prop) : { value: v };
    if ('error' in checked) return checked;
    value[key] = checked.value;
  }
  return { value };
}

/* -------------------------------------------------------------------------- */
/*                                Answer text                                 */
/* -------------------------------------------------------------------------- */

/** Characters of text per answer: concise answers stay cheap for the model, detailed ones may be long. */
export const TEXT_BUDGET: Record<ResponseFormat, number> = { concise: 10_000, detailed: 40_000 };

/** Inline code; backticks inside are replaced so the span cannot break. */
export function code(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

/** `src/a.ts:12` (or the file alone). */
export function loc(file: string, line?: number): string {
  return line ? `${file}:${line}` : file;
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;
}

/**
 * Text that comes from the repository and is not code the agent asked for — commit subjects, TODO
 * notes, doc comments — in a fenced block, so it reads as data and never as instructions. The fence is
 * longer than any backtick run inside.
 */
export function fence(text: string, lang = 'text'): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}${lang}\n${text.replace(/\r\n?/g, '\n').trimEnd()}\n${marks}`;
}

/** `items` rendered one per line, at most `limit`, then `… N more <noun>s — raise limit`. */
export function capList<T>(items: T[], limit: number, render: (item: T) => string, noun = 'item', hint = 'raise limit to list them'): string[] {
  const lines = items.slice(0, limit).map(render);
  if (items.length > limit) lines.push(`… ${plural(items.length - limit, `more ${noun}`)} — ${hint}`);
  return lines;
}

/**
 * Keep an answer within the budget of its format: cut at a line boundary (closing an open fence, also
 * an indented one) and end with `… N more lines — <hint>` (each tool names its own way to narrow).
 */
export function fitText(text: string, format: ResponseFormat, hint = 'lower limit to narrow the answer'): string {
  const max = TEXT_BUDGET[format];
  if (text.length <= max) return text;
  const room = max - 120;
  const lines = text.split('\n');
  const kept: string[] = [];
  let size = 0;
  let open: { indent: string; marks: string } | undefined;
  for (const line of lines) {
    if (size + line.length + 1 > room) {
      // A single huge line (a long command) is cut itself rather than dropped whole.
      if (!kept.length) kept.push(`${line.slice(0, room - 1)}…`);
      break;
    }
    kept.push(line);
    size += line.length + 1;
    const fenceLine = /^(\s*)(`{3,})/.exec(line);
    if (fenceLine && !open) open = { indent: fenceLine[1], marks: fenceLine[2] };
    else if (open && line.trim() === open.marks) open = undefined;
  }
  const left = lines.length - kept.length;
  return `${kept.join('\n')}${open ? `\n${open.indent}${open.marks}` : ''}\n… ${left} more line${left === 1 ? '' : 's'} — ${hint}`;
}

/**
 * Characters of structured data per answer. Some clients hand `structuredContent` to the model too, so
 * it gets a budget of its own (twice the text's: JSON is wordier than Markdown).
 */
export const STRUCTURED_BUDGET: Record<ResponseFormat, number> = { concise: 20_000, detailed: 80_000 };

/** The array in `value` (at any depth) whose JSON is the longest, with that length. */
function longestArray(value: unknown): { list: unknown[]; size: number } | undefined {
  let best: { list: unknown[]; size: number } | undefined;
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      const size = JSON.stringify(v).length;
      if (v.length > 1 && (!best || size > best.size)) best = { list: v, size };
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) visit(child);
  };
  visit(value);
  return best;
}

/**
 * Keep structured data within the budget of its format: the longest list is halved until the JSON fits,
 * and `truncated: true` says that lists were cut (the text answer names the totals).
 */
export function fitStructured(structured: Record<string, unknown>, format: ResponseFormat): Record<string, unknown> {
  const max = STRUCTURED_BUDGET[format];
  if (JSON.stringify(structured).length <= max) return structured;
  const copy = structuredClone(structured);
  for (let round = 0; round < 60 && JSON.stringify(copy).length > max; round++) {
    const longest = longestArray(copy);
    if (!longest) break;
    longest.list.length = Math.floor(longest.list.length / 2);
  }
  return { ...copy, truncated: true };
}

/** A successful tool answer: Markdown for the model, plus the same facts as structured data, both within budget. */
export function answer(text: string, format: ResponseFormat, structured?: Record<string, unknown>, hint?: string): ToolResult {
  return { content: [{ type: 'text', text: fitText(text, format, hint) }], ...(structured ? { structuredContent: fitStructured(structured, format) } : {}) };
}

/** A tool-level failure the model can act on (an unknown file with suggestions, a missing argument pair). */
export function toolError(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], isError: true, ...(structured ? { structuredContent: structured } : {}) };
}
