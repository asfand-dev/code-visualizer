import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import { AnalyzeError } from '../analyzer/errors.js';
import type { AnalyzeStage } from '../analyzer/index.js';
import { cacheDisabledByEnv } from '../cli/engine.js';
import { STAGE_LABELS } from '../cli/shared.js';
import { closest } from '../shared/delta.js';
import { VERSION } from '../version.js';
import {
  ERROR,
  fitText,
  LEGACY_VERSIONS,
  MODERN_VERSIONS,
  PROTOCOL_VERSION_META,
  RpcError,
  SERVER_INFO_META,
  toolError,
  validateArguments,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpContext,
  type PromptDef,
  type ResourceDef,
  type ToolDef,
} from './protocol.js';
import { PROMPTS, RESOURCES } from './resources.js';
import { createDataSource, type DataSource, type DataSourceOptions } from './source.js';
import { TOOLS } from './tools.js';

/**
 * `code-visualizer mcp`: a Model Context Protocol server over stdio that gives AI agents the project
 * map — impact, tests to run, symbols, owners, architecture rules, routes and the current changes.
 *
 * One JSON-RPC message per line on stdin and stdout (stdout carries protocol messages only; logs go to
 * stderr). Handshake-based clients (`initialize`, protocol 2024-11-05 … 2025-11-25) and stateless ones
 * (2026-07-28: the version in every request's `_meta`, `server/discover`) are both served. Requests are
 * answered concurrently; `notifications/cancelled` stops the answer, `_meta.progressToken` gets
 * `notifications/progress` while an analysis runs.
 */

export const SERVER_NAME = 'code-visualizer';

/** What the server tells the model about itself (shown in the agent's system prompt by most clients). */
export const INSTRUCTIONS = [
  'code-visualizer knows this project’s dependency graph: use it instead of grep for impact, dependents, tests to run, owners, architecture rules and routes.',
  '- impact: before editing an exported function or a widely used file — dependents by depth with exact call sites, routes, tests to run (with the command), owners, risk.',
  '- tests_for: the tests to run after editing, with the command. find_symbol: definitions and use sites.',
  '- check_architecture: before adding an import across folders — is it allowed, and what to use instead.',
  '- review_changes: your diff — impacted files, tests, breaking changes with call sites not yet updated.',
  '- route: which handler serves a URL. who: owners and experts. project_overview: stack, commands, rules.',
  // --- clone-radar ---
  '- find_similar: before writing a helper — existing functions that already do it (import them instead of copying).',
  'Paths are relative to the project root; answers cite file:line.',
].join('\n');

const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } };

/** The order analyze() reports its stages in (progress must only grow). */
const STAGE_ORDER: AnalyzeStage[] = ['project', 'discover', 'parse', 'link', 'git', 'insights', 'changes', 'compare', 'done'];

export interface McpServerOptions {
  /** The project to answer about. */
  root: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Diagnostics (stderr by default; never stdout). */
  log?: (message: string) => void;
  /** The tools to offer (default: all of `TOOLS`, see `--tools`). */
  tools?: ToolDef[];
  resources?: ResourceDef[];
  prompts?: PromptDef[];
  /** Analysis options (default: no embedded sources, persistent warm cache, architecture delta, no history). */
  analysis?: DataSourceOptions['analysis'];
  /** Watch files and git (default true). Without it, every call still checks analyzed files for edits. */
  watch?: boolean;
  /** Use a running `code-visualizer serve` for the same project (default: unless the analysis has `persist: false`). */
  useServer?: boolean;
  /** Where analyses come from (injected by tests and embedders; default: running serve, else a warm engine). */
  source?: DataSource;
  /**
   * Quiet time after a message before the first analysis starts in the background (default 500 ms, and
   * at most 2 s after the first message): a client that only checks the server (initialize, tools/list,
   * close) starts no analysis.
   */
  warmDelayMs?: number;
}

export interface McpServer {
  /** Resolves once the input ended and the requests already sent were answered (or close() was called), and the engine is closed. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface InFlight {
  controller: AbortController;
  progressToken?: string | number;
  lastProgress: number;
  lastProgressAt: number;
  done: boolean;
}

/** Default analysis for agents: everything the tools read, nothing they don't (sources, history). */
export function mcpAnalysisOptions(overrides: DataSourceOptions['analysis'] = {}): DataSourceOptions['analysis'] {
  return { includeSource: false, history: false, compare: true, persist: !cacheDisabledByEnv(), toolVersion: VERSION, ...overrides };
}

const errorMessage = (id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/* -------------------------------------------------------------------------- */
/*                        Stateless protocol (2026-07-28)                     */
/* -------------------------------------------------------------------------- */

/**
 * How a request speaks: `modern` requests carry their protocol version in `_meta` (or are a discovery);
 * an unsupported modern version is an error naming the supported ones. Everything else is the
 * handshake-based protocol.
 */
function requestEra(method: string, params: Record<string, unknown>): { modern: boolean; error?: RpcError } {
  const meta = params._meta && typeof params._meta === 'object' ? (params._meta as Record<string, unknown>) : undefined;
  const requested = meta?.[PROTOCOL_VERSION_META];
  if (requested === undefined) return { modern: method === 'server/discover' };
  if (typeof requested === 'string' && (MODERN_VERSIONS as readonly string[]).includes(requested)) return { modern: true };
  return { modern: true, error: new RpcError(ERROR.unsupportedVersion, 'Unsupported protocol version', { supported: [...MODERN_VERSIONS], requested }) };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...MODERN_VERSIONS],
    capabilities: CAPABILITIES,
    instructions: INSTRUCTIONS,
    _meta: { [SERVER_INFO_META]: { name: SERVER_NAME, title: 'Code Visualizer', version: VERSION } },
  };
}

/** Stateless results say whether they are complete (multi-round-trip results are not used here). */
const modernResult = (result: Record<string, unknown>): Record<string, unknown> => ({ resultType: 'complete', ...result });

/* -------------------------------------------------------------------------- */
/*                                    Server                                  */
/* -------------------------------------------------------------------------- */

export function startMcpServer(options: McpServerOptions): McpServer {
  const root = path.resolve(options.root);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string) => void process.stderr.write(message.endsWith('\n') ? message : `${message}\n`));
  const tools = options.tools ?? TOOLS;
  const resources = options.resources ?? RESOURCES;
  const prompts = options.prompts ?? PROMPTS;
  const analysis = mcpAnalysisOptions(options.analysis);
  const analyzes = { git: analysis.git !== false, changes: analysis.changes !== false };
  // Like getReport(): a cold run (no persistent cache) does not take a server's data either.
  const useServer = options.useServer ?? analysis.persist !== false;
  const source = options.source ?? createDataSource({ root, analysis, watch: options.watch, useServer, log: (m) => log(`code-visualizer: ${m}`) });

  // stdout belongs to the protocol: a stray console.log from any library would corrupt it.
  const restoreConsole = output === process.stdout ? routeConsoleToStderr() : () => undefined;

  /* ------------------------------- Output -------------------------------- */
  let writing: Promise<void> = Promise.resolve();
  let outputClosed = false;
  const send = (message: JsonRpcMessage): Promise<void> => {
    const line = `${JSON.stringify(message)}\n`;
    writing = writing
      .then(async () => {
        if (outputClosed) return;
        if (!output.write(line)) await Promise.race([once(output, 'drain'), once(output, 'close')]);
      })
      .catch(() => undefined);
    return writing;
  };
  const onOutputError = (): void => {
    // The client went away (EPIPE): nothing more can be said.
    outputClosed = true;
    void finish(true);
  };
  output.on('error', onOutputError);

  /* ------------------------------- Warm-up ------------------------------- */
  // The analyzer loads the TypeScript compiler (a few hundred ms of blocking work): start it in the
  // background once the handshake burst (initialize, tools/list, …) has been answered.
  let warmTimer: NodeJS.Timeout | undefined;
  let firstMessageAt: number | undefined;
  let warmed = false;
  const warmDelay = options.warmDelayMs ?? 500;
  const noteActivity = (): void => {
    if (warmed || finished) return;
    firstMessageAt ??= Date.now();
    if (warmTimer) clearTimeout(warmTimer);
    const wait = Math.min(warmDelay, Math.max(0, firstMessageAt + Math.max(2000, warmDelay) - Date.now()));
    warmTimer = setTimeout(() => {
      warmed = true;
      source.warm();
    }, wait);
    warmTimer.unref?.();
  };

  /* ------------------------------ Requests ------------------------------- */
  const inflight = new Map<JsonRpcId, InFlight>();
  /** Requests still being answered (stdin may close while they run). */
  const running = new Set<Promise<void>>();

  const sendProgress = (entry: InFlight, n: number, total: number | undefined, message: string | undefined): void => {
    if (entry.progressToken === undefined || entry.done || entry.controller.signal.aborted || !(n > entry.lastProgress)) return;
    entry.lastProgress = n;
    entry.lastProgressAt = Date.now();
    void send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: entry.progressToken, progress: n, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) } });
  };

  const contextFor = (entry: InFlight): McpContext => {
    const signal = entry.controller.signal;
    const checked = async <T>(work: Promise<T>): Promise<T> => {
      const value = await work;
      if (signal.aborted) throw new Error('cancelled');
      return value;
    };
    const onProgress =
      entry.progressToken === undefined
        ? undefined
        : (stage: AnalyzeStage, detail?: { done?: number; total?: number }): void => {
            const index = STAGE_ORDER.indexOf(stage);
            if (index < 0) return;
            const fraction = stage === 'parse' && detail?.total ? Math.min(1, (detail.done ?? 0) / detail.total) : 0;
            // Parse reports every 50 files: a few updates per second are plenty.
            if (fraction > 0 && fraction < 1 && Date.now() - entry.lastProgressAt < 100) return;
            const label = STAGE_LABELS[stage] + (stage === 'parse' && detail?.total ? ` (${detail.done ?? 0}/${detail.total})` : '');
            sendProgress(entry, Math.round((index + fraction) * 100) / 100, STAGE_ORDER.length - 1, label);
          };
    return {
      root,
      signal,
      analysis: analyzes,
      report: () => checked(source.report({ onProgress })),
      reportFor: (o) => checked(source.reportFor(o)),
      refresh: (paths) => checked(source.refresh(paths)),
      progress: (n, total, message) => sendProgress(entry, n, total, message),
    };
  };

  const methods = protocolMethods({ tools, resources, prompts, log });
  const dispatch = async (method: string, params: Record<string, unknown>, ctx: McpContext): Promise<Record<string, unknown>> => {
    const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
    if (!handler) throw new RpcError(ERROR.methodNotFound, `Method not found: ${method}`);
    return handler(params, ctx);
  };

  const handleRequest = async (id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> => {
    if (inflight.has(id)) {
      void send(errorMessage(id, ERROR.invalidRequest, `Request id ${JSON.stringify(id)} is already in use by a running request.`));
      return;
    }
    const meta = params._meta && typeof params._meta === 'object' ? (params._meta as Record<string, unknown>) : undefined;
    const token = meta?.progressToken;
    const entry: InFlight = { controller: new AbortController(), progressToken: typeof token === 'string' || typeof token === 'number' ? token : undefined, lastProgress: -1, lastProgressAt: 0, done: false };
    inflight.set(id, entry);
    try {
      const era = requestEra(method, params);
      if (era.error) throw era.error;
      const result = await dispatch(method, params, contextFor(entry));
      entry.done = true;
      if (!entry.controller.signal.aborted) await send({ jsonrpc: '2.0', id, result: era.modern ? modernResult(result) : result });
    } catch (error) {
      entry.done = true;
      // A cancelled request gets no answer at all.
      if (entry.controller.signal.aborted) return;
      if (error instanceof RpcError) await send(errorMessage(id, error.code, error.message, error.data));
      else if (error instanceof AnalyzeError) {
        // Expected (no sources, a bad root…): the message says what to do, no stack needed.
        log(`code-visualizer: ${method}: ${error.message}`);
        await send(errorMessage(id, ERROR.internal, `The project cannot be analyzed: ${error.message}`));
      } else {
        log(`code-visualizer: ${method} failed: ${(error as Error).stack ?? String(error)}`);
        await send(errorMessage(id, ERROR.internal, `Internal error: ${(error as Error).message}`));
      }
    } finally {
      inflight.delete(id);
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown>): void => {
    if (method !== 'notifications/cancelled') return; // initialized, roots changes…: nothing to do
    const requestId = params.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    const entry = inflight.get(requestId);
    if (!entry || entry.done) return;
    entry.controller.abort(new Error(typeof params.reason === 'string' ? params.reason : 'cancelled'));
  };

  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    const parsed = parseMessage(line);
    if ('reply' in parsed) {
      void send(parsed.reply);
      return;
    }
    noteActivity();
    if ('ignore' in parsed) return;
    if (parsed.id === null) handleNotification(parsed.method, parsed.params);
    else {
      const pending = handleRequest(parsed.id, parsed.method, parsed.params);
      running.add(pending);
      void pending.finally(() => running.delete(pending));
    }
  };

  /* ------------------------------- Lifecycle ------------------------------ */
  let finished = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  /** Stop: `abort` drops the requests still running (close(), a broken pipe); otherwise they are answered first. */
  const finish = async (abort: boolean): Promise<void> => {
    if (finished) return closed;
    finished = true;
    if (warmTimer) clearTimeout(warmTimer);
    if (abort) for (const entry of inflight.values()) entry.controller.abort(new Error('the client disconnected'));
    else await Promise.allSettled([...running]);
    source.close();
    await writing;
    output.off('error', onOutputError);
    restoreConsole();
    resolveClosed();
    return closed;
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  rl.on('line', handleLine);
  // The client closes stdin to stop the server; what it already asked is still answered
  // (`printf '…' | code-visualizer mcp` works as a one-shot query).
  rl.on('close', () => void finish(false));

  return {
    closed,
    async close() {
      void finish(true);
      rl.close();
      await closed;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Messages                                  */
/* -------------------------------------------------------------------------- */

type Parsed = { reply: JsonRpcMessage } | { ignore: true } | { id: JsonRpcId | null; method: string; params: Record<string, unknown> };

/**
 * One line of input: a request (`id` set), a notification (`id` null), something to ignore (a response,
 * a malformed notification), or the error reply for a parse error, a batch or an invalid request.
 */
export function parseMessage(line: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { reply: errorMessage(null, ERROR.parse, 'Parse error: each line must be one JSON-RPC message.') };
  }
  if (Array.isArray(value)) return { reply: errorMessage(null, ERROR.invalidRequest, 'Invalid request: batches are not supported, send one message per line.') };
  if (!value || typeof value !== 'object') return { reply: errorMessage(null, ERROR.invalidRequest, 'Invalid request: expected a JSON-RPC object.') };
  const msg = value as JsonRpcMessage;
  const hasId = 'id' in msg && msg.id !== undefined;
  const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  const invalid = (why: string, code: number = ERROR.invalidRequest): Parsed => (hasId || code === ERROR.invalidRequest ? { reply: errorMessage(id, code, why) } : { ignore: true });
  if (typeof msg.method !== 'string') {
    // A response: this server never sends requests, so there is nothing to match it with.
    return 'result' in msg || 'error' in msg ? { ignore: true } : invalid('Invalid request: "method" is missing.');
  }
  if (msg.jsonrpc !== '2.0') return hasId ? invalid('Invalid request: "jsonrpc" must be "2.0".') : { ignore: true };
  if (hasId && id === null) return invalid('Invalid request: "id" must be a string or a number.');
  const params = msg.params ?? {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return invalid('Invalid params: "params" must be an object.', ERROR.invalidParams);
  return { id, method: msg.method, params };
}

/* -------------------------------------------------------------------------- */
/*                                   Methods                                  */
/* -------------------------------------------------------------------------- */

type MethodHandler = (params: Record<string, unknown>, ctx: McpContext) => Promise<Record<string, unknown>> | Record<string, unknown>;

interface Offer {
  tools: ToolDef[];
  resources: ResourceDef[];
  prompts: PromptDef[];
  log: (message: string) => void;
}

/** The requests the server answers, by method. */
function protocolMethods(offer: Offer): Record<string, MethodHandler> {
  const { tools, resources, prompts, log } = offer;
  return {
    initialize(params) {
      const requested = params.protocolVersion;
      const protocolVersion = typeof requested === 'string' && (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
      const client = params.clientInfo as { name?: string; version?: string } | undefined;
      if (client?.name) log(`code-visualizer: ${client.name}${client.version ? ` ${client.version}` : ''} connected (protocol ${protocolVersion})`);
      return { protocolVersion, capabilities: CAPABILITIES, serverInfo: { name: SERVER_NAME, title: 'Code Visualizer', version: VERSION }, instructions: INSTRUCTIONS };
    },
    'server/discover': () => discoverResult(),
    ping: () => ({}),
    'tools/list': () => ({ tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) }),
    'tools/call': (params, ctx) => callTool(tools, params, ctx, log),
    'resources/list': () => ({ resources: resources.filter((r) => !r.template).map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })) }),
    'resources/templates/list': () => ({
      resourceTemplates: resources.filter((r) => r.template).map(({ uri, name, title, description, mimeType }) => ({ uriTemplate: uri, name, title, description, mimeType })),
    }),
    async 'resources/read'(params, ctx) {
      const uri = params.uri;
      if (typeof uri !== 'string' || !uri) throw new RpcError(ERROR.invalidParams, 'resources/read needs a "uri".');
      const resource = resources.find((r) => r.matches(uri));
      if (!resource) throw new RpcError(ERROR.resourceNotFound, `Resource not found: ${uri}`, { uri });
      const text = fitText(await resource.read(uri, ctx), 'detailed', 'the tools give narrower answers');
      return { contents: [{ uri, mimeType: resource.mimeType, text }] };
    },
    'prompts/list': () => ({ prompts: prompts.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) }),
    async 'prompts/get'(params, ctx) {
      const prompt = prompts.find((p) => p.name === params.name);
      if (!prompt) throw new RpcError(ERROR.invalidParams, `Unknown prompt: ${String(params.name)}. Available: ${prompts.map((p) => p.name).join(', ')}.`);
      const result = await prompt.get(promptArguments(prompt, params.arguments), ctx);
      return { description: result.description, messages: result.messages.map((m) => ({ ...m, content: { ...m.content, text: fitText(m.content.text, 'detailed', 'the tools give narrower answers') } })) };
    },
  };
}

/**
 * `tools/call`. An unknown tool or a malformed request is a protocol error (-32602); arguments that
 * do not fit the tool's schema are a tool error (`isError`), so the model reads what to fix and retries
 * (MCP 2025-11-25 asks for input validation errors to be tool execution errors).
 */
async function callTool(tools: ToolDef[], params: Record<string, unknown>, ctx: McpContext, log: (message: string) => void): Promise<Record<string, unknown>> {
  const name = params.name;
  if (typeof name !== 'string') throw new RpcError(ERROR.invalidParams, 'tools/call needs the tool "name".');
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const hint = closest(name, tools.map((t) => t.name));
    throw new RpcError(ERROR.invalidParams, `Unknown tool: ${name}${hint ? ` (did you mean ${hint}?)` : ''}. Available: ${tools.map((t) => t.name).join(', ')}.`);
  }
  const raw = params.arguments;
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new RpcError(ERROR.invalidParams, `Invalid arguments for ${name}: arguments must be an object.`);
  const checked = validateArguments(tool.inputSchema, raw);
  if ('error' in checked) return { ...toolError(`Invalid arguments for ${name}: ${checked.error}`, { error: 'invalid-arguments', message: checked.error }) };
  try {
    return { ...(await tool.run(checked.value, ctx)) };
  } catch (error) {
    if (error instanceof RpcError || ctx.signal.aborted) throw error;
    // A failed analysis (not a project, git trouble…) is something the model can act on.
    if (error instanceof AnalyzeError) log(`code-visualizer: ${name}: ${error.message}`);
    else log(`code-visualizer: ${name} failed: ${(error as Error).stack ?? String(error)}`);
    return { ...toolError(`${name} failed: ${(error as Error).message}`) };
  }
}

/** A prompt's arguments as strings, checked against the ones it declares. */
function promptArguments(prompt: PromptDef, raw: unknown): Record<string, string> {
  const given = raw ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) throw new RpcError(ERROR.invalidParams, 'Prompt arguments must be an object of strings.');
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(given as Record<string, unknown>)) {
    if (!prompt.arguments.some((a) => a.name === key)) throw new RpcError(ERROR.invalidParams, `Unknown argument "${key}" for prompt ${prompt.name}.`);
    if (value !== undefined && value !== null) args[key] = String(value);
  }
  const missing = prompt.arguments.find((a) => a.required && !args[a.name]?.trim());
  if (missing) throw new RpcError(ERROR.invalidParams, `Prompt ${prompt.name} needs the argument "${missing.name}".`);
  return args;
}

/** console.log / info / debug write to stderr while the server owns stdout. */
function routeConsoleToStderr(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  return () => Object.assign(console, saved);
}
