/**
 * The guardrail hooks an AI agent runs (`code-visualizer hook <event>`):
 *
 * - session-start: a short brief (branch, rules and layers, the most depended-on files, the tools) and the
 *   session snapshot the other hooks compare with;
 * - pre-edit: refuses an edit that adds a forbidden import, a layer break, a cycle or an undeclared package;
 * - post-edit: tells the agent what its edits left behind (stale call sites, removed routes still called,
 *   complexity jumps, untested new exports);
 * - stop: with `--strict`, keeps the agent working until a passing test run covers its changes.
 *
 * Analyses come from a running `serve` (POST /api/whatif) when there is one, otherwise from this process
 * with the warm disk cache. Every hook fails open: an internal problem never blocks the agent.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AnalyzeCache } from '../analyzer/index.js';
import { readState } from '../analyzer/state.js';
import { cacheDisabledByEnv } from '../cli/engine.js';
import { connectToServer, type ServerConnection } from '../server/client.js';
import { sessionBriefMarkdown } from '../shared/markdown.js';
import type { AgentSession, GuardFinding, LastTestState, ReportData } from '../shared/types.js';
import { VERSION } from '../version.js';
import type { FileChange, HookInput, HookResult } from './dialect.js';
import { applyEdits, contextText, denyText, exportSignatures, findingFingerprints, GUARDED_FILE_RE, importsChanged, overlayLineChanges, postEditFindings, preEditFindings, revertEdits } from './guard.js';
import { changedSinceStart, diskText, pruneSessions, readSession, rememberOriginal, startState, textAt, writeSession } from './session.js';
import { mcpConfigFile, installedHooks, type AgentClient } from './setup.js';
import { lastTestCovers, transcriptCovers } from './stop-gate.js';

export interface HookContext {
  /** The project root. */
  root: string;
  input: HookInput;
  /** stop: keep the agent working (instead of only printing a summary). */
  strict?: boolean;
  /** Ask a running `serve` (default: unless the warm cache is off). */
  server?: boolean;
  now?: () => number;
}

/* -------------------------------------------------------------------------- */
/*                                  Analyses                                  */
/* -------------------------------------------------------------------------- */

type Overlay = Record<string, string | null>;

/** A running `serve` for the whole project that can answer what-ifs. */
async function serverFor(ctx: HookContext): Promise<ServerConnection | undefined> {
  if (ctx.server === false || cacheDisabledByEnv()) return undefined;
  const conn = await connectToServer(ctx.root);
  if (!conn) return undefined;
  try {
    const scope = JSON.parse(conn.info.fingerprint ?? '{}') as { file?: string; directory?: string };
    if (scope.file || scope.directory) return undefined;
  } catch {
    return undefined;
  }
  return conn;
}

/**
 * Analyses in this process: the project now and with overlays, sharing one warm parse cache. `clones:
 * false` skips copy-paste detection on both sides (the pre-edit guard reads no clone findings).
 */
class LocalAnalyses {
  private cache?: Promise<{ analyze: typeof import('../analyzer/index.js').analyze; cache: AnalyzeCache; save: () => void }>;
  private now?: Promise<ReportData>;
  constructor(
    private readonly root: string,
    private readonly clones?: false,
  ) {}

  private setup() {
    return (this.cache ??= (async () => {
      const [{ analyze, createAnalyzeCache }, { loadDiskCache, saveDiskCache }] = await Promise.all([import('../analyzer/index.js'), import('../analyzer/disk-cache.js')]);
      const cache = createAnalyzeCache();
      const persist = !cacheDisabledByEnv();
      if (persist) loadDiskCache(this.root, cache);
      const save = (): void => {
        if (!persist || !cache.dirty) return;
        try {
          saveDiskCache(this.root, cache);
        } catch {
          /* the cache is an optimization */
        }
      };
      return { analyze, cache, save };
    })());
  }

  private options(cache: AnalyzeCache) {
    return { root: this.root, cache, includeSource: false, git: false, changes: false, history: false, coverage: false as const, ...(this.clones === false ? { clones: false } : {}), toolVersion: VERSION };
  }

  current(): Promise<ReportData> {
    return (this.now ??= this.setup().then(({ analyze, cache }) => analyze(this.options(cache))));
  }

  async whatIf(overlay: Overlay): Promise<ReportData> {
    await this.current(); // the working tree first: the overlay run reuses its parse results
    const { analyze, cache } = await this.setup();
    return analyze({ ...this.options(cache), overlay });
  }

  async save(): Promise<void> {
    if (this.cache) (await this.cache).save();
  }
}

/** The project now: from a running `serve`, else analyzed here (warm). */
async function currentAnalysis(ctx: HookContext, local: LocalAnalyses): Promise<ReportData> {
  const conn = await serverFor(ctx);
  if (conn) {
    try {
      return await conn.data({ source: false, timeoutMs: 20_000 });
    } catch {
      /* analyze here */
    }
  }
  return local.current();
}

async function loadedConfig(root: string) {
  const { loadConfig } = await import('../analyzer/config.js');
  return loadConfig(root);
}

/**
 * An invalid configuration turns the rules off without a word: tell the person every time (stderr) and
 * the agent once per session, so neither takes the silence for "no rule was broken".
 */
async function configWarning(ctx: HookContext, session: AgentSession): Promise<{ note?: string; context?: string }> {
  const { error, file } = await loadedConfig(ctx.root);
  if (!error) return {};
  const text = `${file ? path.basename(file) : 'The code-visualizer configuration'} is invalid (${error}): its architecture rules and layers are not checked until it is fixed.`;
  const key = `config-error|${error}`;
  if (session.reported?.includes(key)) return { note: `code-visualizer: ${text}` };
  session.reported = [...(session.reported ?? []), key];
  return { note: `code-visualizer: ${text}`, context: `code-visualizer: ${text}` };
}

const joinText = (...parts: (string | undefined)[]): string | undefined => parts.filter(Boolean).join('\n\n') || undefined;

export interface WhatIfRequest {
  guard: 'pre-edit' | 'post-edit';
  /** Project-relative path → text (null: deleted): the proposed edit (pre-edit) or the session's originals (post-edit). */
  overlay: Overlay;
  /** The files the edit or the session touched. */
  files: string[];
  /** post-edit: export signatures of the touched files when the session started. */
  signatures?: Record<string, string>;
}

/** Findings for an edit: through a running `serve` when there is one (POST /api/whatif), else here. */
export async function guardFindings(ctx: HookContext, request: WhatIfRequest, local = new LocalAnalyses(ctx.root, request.guard === 'pre-edit' ? false : undefined)): Promise<GuardFinding[]> {
  const conn = await serverFor(ctx);
  if (conn) {
    try {
      const answer = await conn.request<{ findings?: GuardFinding[] }>('/api/whatif', { method: 'POST', body: request, timeoutMs: 12_000 });
      if (Array.isArray(answer.findings)) return answer.findings;
    } catch {
      /* an older server without the endpoint, or a busy one: analyze here */
    }
  }
  const { config } = await loadedConfig(ctx.root);
  const [now, other] = await Promise.all([local.current(), local.whatIf(request.overlay)]);
  await local.save();
  const options = { files: request.files, config, complexityThreshold: config.check?.maxComplexity };
  if (request.guard === 'pre-edit') return preEditFindings(now, other, options);
  return postEditFindings(other, now, { ...options, signatures: request.signatures, changedLines: overlayLineChanges(request.overlay, (file) => diskText(ctx.root, file)) });
}

/* -------------------------------------------------------------------------- */
/*                                   Files                                    */
/* -------------------------------------------------------------------------- */

const posix = (p: string): string => p.split(path.sep).join('/');

/** `abs` with its deepest existing folder resolved through symlinks (the file and new folders may not exist yet). */
function realish(abs: string): string {
  let dir = abs;
  const rest: string[] = [];
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return abs;
    rest.unshift(path.basename(dir));
    dir = parent;
  }
  try {
    return path.join(fs.realpathSync(dir), ...rest);
  } catch {
    return abs;
  }
}

/** A project-relative id for a path the agent gave, or undefined outside the project. */
export function projectFile(root: string, cwd: string, file: string): string | undefined {
  const abs = path.resolve(cwd, file);
  let rel = path.relative(root, abs);
  // macOS: /var/… vs /private/var/… — compare real folders when the plain paths disagree.
  if (rel.startsWith('..') || path.isAbsolute(rel)) rel = path.relative(realish(root), realish(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return posix(rel);
}

/** Files this tool call writes that the guard judges (source files inside the project, not dependencies). */
function guardedChanges(ctx: HookContext): { id: string; change: FileChange }[] {
  const out: { id: string; change: FileChange }[] = [];
  for (const change of ctx.input.changes ?? []) {
    const id = projectFile(ctx.root, ctx.input.cwd, change.file);
    if (!id || !GUARDED_FILE_RE.test(id) || /(^|\/)node_modules\//.test(id)) continue;
    out.push({ id, change });
    if (change.movedFrom) {
      const from = projectFile(ctx.root, ctx.input.cwd, change.movedFrom);
      if (from && GUARDED_FILE_RE.test(from)) out.push({ id: from, change: { file: change.movedFrom, deleted: true } });
    }
  }
  return out;
}

/** The text a change leaves in the file (undefined: it cannot be applied, the client will refuse it). */
function proposedText(current: string | null, change: FileChange, movedText?: string | null): string | null | undefined {
  if (change.deleted) return null;
  if (change.fullText !== undefined) return change.fullText;
  const base = change.movedFrom ? (movedText ?? null) : current;
  if (!change.edits) return undefined;
  return applyEdits(base ?? '', change.edits);
}

/* -------------------------------------------------------------------------- */
/*                                  Sessions                                  */
/* -------------------------------------------------------------------------- */

/**
 * The session, or one created by a later hook (Cursor has no session start; hooks installed
 * mid-session): its baseline is now. Creating one also clears out old sessions.
 */
async function lazySession(ctx: HookContext): Promise<AgentSession> {
  const existing = readSession(ctx.root, ctx.input.sessionId);
  if (existing) return existing;
  pruneSessions(ctx.root);
  return { id: ctx.input.sessionId, startedAt: (ctx.now ?? Date.now)(), fingerprints: [], exports: {}, ...(await startState(ctx.root)) };
}

/**
 * Write the session, merged with what hooks running at the same time wrote (an agent's parallel edits):
 * the first recorded original of a file wins, told findings add up.
 */
function saveSession(ctx: HookContext, session: AgentSession): void {
  try {
    const disk = readSession(ctx.root, session.id);
    if (disk && disk.startedAt === session.startedAt) {
      if (disk.originals) session.originals = { ...session.originals, ...disk.originals };
      if (disk.reported?.length) session.reported = [...new Set([...disk.reported, ...(session.reported ?? [])])];
    }
    writeSession(ctx.root, session);
  } catch {
    /* best effort: the next hook starts a new one */
  }
}

/* -------------------------------------------------------------------------- */
/*                                Session start                               */
/* -------------------------------------------------------------------------- */

const CLIENT_OF: Record<HookInput['dialect'], AgentClient> = { claude: 'claude', cursor: 'cursor', codex: 'codex' };

async function sessionStart(ctx: HookContext): Promise<HookResult> {
  const local = new LocalAnalyses(ctx.root);
  const [data, state, config] = await Promise.all([currentAnalysis(ctx, local), startState(ctx.root), loadedConfig(ctx.root)]);
  await local.save();
  const existing = readSession(ctx.root, ctx.input.sessionId);
  // A resumed or compacted session keeps the baseline it started with.
  if (!existing || (ctx.input.source !== 'resume' && ctx.input.source !== 'compact')) {
    saveSession(ctx, {
      id: ctx.input.sessionId,
      startedAt: (ctx.now ?? Date.now)(),
      ...state,
      fingerprints: findingFingerprints(data, config.config.check?.maxComplexity),
      exports: exportSignatures(data),
    });
    pruneSessions(ctx.root);
  }
  const { detectBaseBranch, git } = await import('../analyzer/git.js');
  const base = state.branch ? await detectBaseBranch(ctx.root) : undefined;
  const ahead = base && base !== state.branch ? Number((await git(ctx.root, ['rev-list', '--count', `${base}..HEAD`]))?.trim()) || 0 : 0;
  const client = CLIENT_OF[ctx.input.dialect];
  const mcpConfig = mcpConfigFile(ctx.root, client);
  const mcpTools = mcpConfig ? (await import('../mcp/tools.js')).TOOLS.map((t) => t.name) : undefined;
  const guarded = client === 'claude' ? installedHooks(ctx.root, 'claude').includes('PreToolUse') : false;
  const brief = sessionBriefMarkdown(data, { branch: state.branch, base: base && base !== state.branch ? base : undefined, ahead, uncommitted: Object.keys(state.dirty ?? {}), mcpTools, mcpConfig, guarded });
  return { context: brief };
}

/* -------------------------------------------------------------------------- */
/*                                  Pre-edit                                  */
/* -------------------------------------------------------------------------- */

async function preEdit(ctx: HookContext): Promise<HookResult> {
  const changes = guardedChanges(ctx);
  if (!changes.length) return {};
  const overlay: Overlay = {};
  const session = await lazySession(ctx);
  let remembered = false;
  let structural = false;
  for (const { id, change } of changes) {
    const current = diskText(ctx.root, id);
    const moved = change.movedFrom ? diskText(ctx.root, projectFile(ctx.root, ctx.input.cwd, change.movedFrom) ?? '') : undefined;
    const next = proposedText(current, change, moved);
    // An edit the client cannot apply (old text not found) is refused by the client itself.
    if (next === undefined) return { note: `code-visualizer: could not apply the edit to ${id} in memory; not checked.` };
    remembered = rememberOriginal(session, id, current) || remembered;
    if (next === current) continue;
    overlay[id] = next;
    structural ||= importsChanged(current, next);
  }
  if (remembered) saveSession(ctx, session);
  // Rules, layers, cycles and packages all follow imports: an edit that keeps them needs no analysis.
  if (!structural || !Object.keys(overlay).length) return {};
  const told = session.reported?.length ?? 0;
  const warning = await configWarning(ctx, session);
  const findings = await guardFindings(ctx, { guard: 'pre-edit', overlay, files: Object.keys(overlay) });
  if (findings.some((f) => f.severity === 'block')) {
    if ((session.reported?.length ?? 0) !== told) saveSession(ctx, session);
    const { file } = await loadedConfig(ctx.root);
    return { deny: joinText(denyText(findings, file), warning.context), note: joinText(warning.note, `code-visualizer: refused an edit of ${Object.keys(overlay).join(', ')}`) };
  }
  // Warn-level rules: the edit goes ahead, the agent hears about it (once).
  session.reported = [...new Set([...(session.reported ?? []), ...findings.map((f) => f.key).filter((k): k is string => !!k)])];
  if (session.reported.length !== told) saveSession(ctx, session);
  return { context: joinText(warning.context, findings.length ? contextText(findings, 'pre-edit') : undefined), note: warning.note };
}

/* -------------------------------------------------------------------------- */
/*                                  Post-edit                                 */
/* -------------------------------------------------------------------------- */

/**
 * A file's text before the session first edited it: recorded by pre-edit, else HEAD (when it was clean),
 * else the edit reverted, else HEAD anyway (an edit that only deleted text cannot be reverted: the
 * committed text is the best guess, and it keeps a removed export visible to the radar).
 */
async function originalOf(ctx: HookContext, session: AgentSession, id: string, change: FileChange | undefined): Promise<string | null | undefined> {
  if (session.originals && Object.hasOwn(session.originals, id)) return session.originals[id];
  const wasDirty = !!session.dirty && Object.hasOwn(session.dirty, id);
  if (session.head && !wasDirty) {
    const text = await textAt(ctx.root, session.head, id);
    if (text !== undefined) return text;
  }
  const now = diskText(ctx.root, id);
  if (now !== null && change?.edits?.length) {
    const reverted = revertEdits(now, change.edits);
    if (reverted !== undefined) return reverted;
  }
  if (session.head && wasDirty) return textAt(ctx.root, session.head, id);
  return undefined;
}

async function postEdit(ctx: HookContext): Promise<HookResult> {
  const changes = guardedChanges(ctx);
  if (!changes.length) return {};
  const session = await lazySession(ctx);
  for (const { id, change } of changes) {
    if (session.originals && Object.hasOwn(session.originals, id)) continue;
    const original = await originalOf(ctx, session, id, change);
    if (original !== undefined) rememberOriginal(session, id, original);
  }
  // Everything the session edited, compared as the session found it.
  const overlay: Overlay = {};
  for (const [id, text] of Object.entries(session.originals ?? {})) if (text !== diskText(ctx.root, id)) overlay[id] = text;
  const touched = [...new Set([...Object.keys(overlay), ...changes.map((c) => c.id)])];
  const signatures = Object.fromEntries(Object.entries(session.exports).filter(([symbol]) => touched.includes(symbol.slice(0, symbol.indexOf('#')))));
  let findings: GuardFinding[] = [];
  let warning: { note?: string; context?: string } = {};
  if (Object.keys(overlay).length || Object.keys(signatures).length) {
    warning = await configWarning(ctx, session);
    findings = await guardFindings(ctx, { guard: 'post-edit', overlay, files: touched, signatures });
  }
  // Only what the session added, and each finding once.
  const known = new Set(session.fingerprints);
  const told = new Set(session.reported ?? []);
  const fresh = findings.filter((f) => !(f.fingerprint && known.has(f.fingerprint)) && !(f.key && told.has(f.key)));
  if (fresh.length) {
    session.reported = [...told, ...fresh.map((f) => f.key).filter((k): k is string => !!k)];
  }
  const context = joinText(warning.context, fresh.length ? contextText(fresh, 'post-edit') : undefined);
  // Cursor takes no answer after an edit: its stop hook relays these.
  if (context && ctx.input.dialect === 'cursor') session.pending = [...(session.pending ?? []), ...(warning.context ? [warning.context] : []), ...fresh.map((f) => `${f.message}${f.fix ? ` ${f.fix}` : ''}`)].slice(-30);
  saveSession(ctx, session);
  return { ...(context ? { context } : {}), ...(warning.note ? { note: warning.note } : {}) };
}

/* -------------------------------------------------------------------------- */
/*                                    Stop                                    */
/* -------------------------------------------------------------------------- */

const MAX_TRANSCRIPT = 4 * 1024 * 1024;

/** The last few MB of a transcript (best effort). */
function readTail(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, MAX_TRANSCRIPT);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

async function stop(ctx: HookContext): Promise<HookResult> {
  // A stop hook that already sent the agent back must never loop.
  if (ctx.input.stopHookActive || (ctx.input.loopCount ?? 0) > 0) return {};
  // Cursor: the person stopped the agent (or it failed) — a follow-up would restart it. Pending findings wait for the next stop.
  if (ctx.input.dialect === 'cursor' && ctx.input.status && ctx.input.status !== 'completed') return {};
  // No session: this agent edited nothing through the hooks, and the uncommitted work in the tree is not its own.
  const session = readSession(ctx.root, ctx.input.sessionId);
  if (!session) return {};
  const pending = session.pending ?? [];
  if (pending.length) {
    session.pending = [];
    saveSession(ctx, session);
  }
  const relay = pending.length ? ['code-visualizer found after your edits:', ...pending.map((m) => `- ${m}`)].join('\n') : undefined;
  const changed = await changedSinceStart(ctx.root, session);
  if (!changed.length) return relay ? { context: relay } : {};
  const local = new LocalAnalyses(ctx.root);
  const data = await currentAnalysis(ctx, local);
  await local.save();
  const { selectTests } = await import('../analyzer/test-select.js');
  // Unit tests only: end-to-end specs need a running app and browser an agent rarely has.
  const plan = selectTests(data, changed, { full: false, e2e: false });
  const required = plan.selected.filter((s) => s.runner).map((s) => s.file);
  if (!required.length || !plan.commands.length) return relay ? { context: relay } : {};
  const { workingTreeId } = await import('../analyzer/git.js');
  const lastTest = readState<LastTestState>(ctx.root, 'lastTest');
  if (lastTestCovers(lastTest, required, await workingTreeId(ctx.root))) return relay ? { context: relay } : {};
  if (ctx.input.transcriptPath && transcriptCovers(readTail(ctx.input.transcriptPath), required, plan.commands)) return relay ? { context: relay } : {};
  const byId = new Map(data.files.map((f) => [f.id, f]));
  const sources = changed.filter((id) => byId.has(id) && byId.get(id)!.kind !== 'test');
  // The changed files the selected tests stand for (a changed test stands for itself).
  const covered = new Set(plan.selected.filter((s) => s.runner).map((s) => s.via ?? s.file).filter((id) => sources.includes(id)));
  const command = plan.commands.map((c) => c.display).join(' && ');
  const they = required.length === 1 ? 'it' : 'they';
  const cover = required.length === 1 ? 'covers' : 'cover';
  const covers = !covered.size
    ? `${they} test${required.length === 1 ? 's' : ''} what you changed`
    : covered.size === sources.length
      ? `${they} ${cover} the ${sources.length === 1 ? 'file' : `${sources.length} files`} you changed`
      : `${they} ${cover} ${covered.size} of the ${sources.length} files you changed`;
  const failed = lastTest && lastTest.passed === false ? 'The last test run failed. ' : '';
  // A long list of files reads better as the command that selects them itself.
  const reason =
    command.length > 400
      ? `${failed}Run: npx code-visualizer test (it runs the ${plural(required.length, 'test file')} that cover what you changed and records the result).`
      : `${failed}Run: ${command} (${covers}). \`npx code-visualizer test\` runs the same tests and records the result.`;
  if (!ctx.strict) return { ...(relay ? { context: relay } : {}), note: `code-visualizer: ${plural(required.length, 'test file')} cover${required.length === 1 ? 's' : ''} your changes and no passing run covers this tree. ${reason}` };
  return { block: reason, ...(relay ? { context: relay } : {}) };
}

const plural = (count: number, word: string): string => `${count} ${count === 1 ? word : `${word}s`}`;

/* -------------------------------------------------------------------------- */
/*                                  Dispatch                                  */
/* -------------------------------------------------------------------------- */

export async function runHook(ctx: HookContext): Promise<HookResult> {
  switch (ctx.input.event) {
    case 'session-start':
      return sessionStart(ctx);
    case 'pre-edit':
      return preEdit(ctx);
    case 'post-edit':
      return postEdit(ctx);
    case 'stop':
      return stop(ctx);
  }
}
