/**
 * Agent hook dialects: what Claude Code, Cursor and Codex send to a hook on stdin, normalized into one
 * `HookInput`, and what each of them expects back on stdout. Pure (no Node APIs), so it is cheap to load
 * on the hook's no-op path.
 *
 * - Claude Code (and Codex, which uses the same field names): `hook_event_name`, `session_id`, `cwd`,
 *   `transcript_path`, `stop_hook_active`, `tool_name` and `tool_input` (`file_path`, `content`,
 *   `old_string`, `new_string`, `replace_all`, `edits[]`). Codex edits files with `apply_patch`, whose
 *   patch text is parsed here.
 * - Cursor: `conversation_id`, `workspace_roots`, `afterFileEdit` with `file_path` and `edits[]`, and
 *   `stop` with `status` and `loop_count`.
 */

export const HOOK_EVENTS = ['session-start', 'pre-edit', 'post-edit', 'stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const DIALECTS = ['claude', 'cursor', 'codex'] as const;
export type Dialect = (typeof DIALECTS)[number];

export interface HookEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

/** One file a tool call writes. */
export interface FileChange {
  /** As the client gave it: absolute, or relative to `HookInput.cwd`. */
  file: string;
  /** Exact replacements, applied in order. */
  edits?: HookEdit[];
  /** The whole new content (Write, a new file in a patch). */
  fullText?: string;
  /** The tool call deletes the file. */
  deleted?: boolean;
  /** A patch that moves the file: where it was (deleted there). */
  movedFrom?: string;
}

export interface HookInput {
  dialect: Dialect;
  event: HookEvent;
  /** `session_id` (Claude, Codex) or `conversation_id` (Cursor); `default` when the client sends none. */
  sessionId: string;
  /** The folder the agent works in. */
  cwd: string;
  tool?: string;
  /** The (first) file the tool call writes. */
  file?: string;
  edits?: HookEdit[];
  fullText?: string;
  stopHookActive?: boolean;
  transcriptPath?: string;
  // Optional extras.
  /** Every file the tool call writes (several for a Codex `apply_patch`); `file`/`edits`/`fullText` describe the first. */
  changes?: FileChange[];
  /** Cursor `stop`: follow-ups this conversation already had (a follow-up must not loop). */
  loopCount?: number;
  /** Project folders the client reports (Cursor `workspace_roots`). */
  roots?: string[];
  /** Claude `SessionStart`: startup, resume, clear or compact. */
  source?: string;
  /** Cursor `stop`: how the agent's turn ended (`completed`, `aborted`, `error`). */
  status?: string;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Cursor's hook events (camelCase) and payload fields no other client sends. */
const CURSOR_EVENTS = new Set(['afterFileEdit', 'beforeReadFile', 'beforeShellExecution', 'afterShellExecution', 'beforeMCPExecution', 'afterMCPExecution', 'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'stop']);

/** Which client sent `payload`: Cursor by its fields, Codex by its patch tool or environment, otherwise Claude Code. */
export function detectDialect(payload: Json, env: Record<string, string | undefined> = {}): Dialect {
  if ('conversation_id' in payload || 'workspace_roots' in payload || 'generation_id' in payload || 'loop_count' in payload) return 'cursor';
  const event = str(payload.hook_event_name);
  if (event && CURSOR_EVENTS.has(event) && !('session_id' in payload)) return 'cursor';
  if (str(payload.tool_name) === 'apply_patch' || 'turn_id' in payload) return 'codex';
  if (!env.CLAUDE_PROJECT_DIR && !env.CLAUDECODE && (env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_MANAGED_BY_NPM)) return 'codex';
  return 'claude';
}

function editsOf(list: unknown): HookEdit[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const edits: HookEdit[] = [];
  for (const e of list) {
    if (!isObject(e)) return undefined;
    const oldText = str(e.old_string);
    const newText = str(e.new_string);
    if (oldText === undefined || newText === undefined) return undefined;
    edits.push({ oldText, newText, ...(e.replace_all === true ? { replaceAll: true } : {}) });
  }
  return edits;
}

/** The patch text of a Codex `apply_patch` call (`input`, `patch`, or `command: ['apply_patch', patch]`). */
function patchText(input: Json): string | undefined {
  for (const key of ['input', 'patch']) {
    const v = str(input[key]);
    if (v?.includes('*** Begin Patch')) return v;
  }
  const command = input.command;
  if (Array.isArray(command)) {
    const text = command.find((c): c is string => typeof c === 'string' && c.includes('*** Begin Patch'));
    if (text) return text.slice(text.indexOf('*** Begin Patch'));
  }
  return undefined;
}

/**
 * The files a Codex `apply_patch` patch writes: `*** Add File:` (the `+` lines), `*** Delete File:`, and
 * `*** Update File:` (each `@@` hunk becomes an exact replacement of its context and `-` lines by its
 * context and `+` lines), optionally `*** Move to:`.
 */
export function parseApplyPatch(patch: string): FileChange[] {
  const lines = patch.replace(/\r\n?/g, '\n').split('\n');
  const changes: FileChange[] = [];
  let current: FileChange | undefined;
  let mode: 'add' | 'update' | undefined;
  let added: string[] = [];
  let oldLines: string[] = [];
  let newLines: string[] = [];
  const flushHunk = (): void => {
    if (current && mode === 'update' && (oldLines.length || newLines.length)) {
      (current.edits ??= []).push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') });
    }
    oldLines = [];
    newLines = [];
  };
  const flushFile = (): void => {
    flushHunk();
    if (current && mode === 'add') current.fullText = added.length ? `${added.join('\n')}\n` : '';
    if (current) changes.push(current);
    current = undefined;
    mode = undefined;
    added = [];
  };
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      flushFile();
      const file = header[2].trim();
      if (header[1] === 'Delete') changes.push({ file, deleted: true });
      else {
        current = { file };
        mode = header[1] === 'Add' ? 'add' : 'update';
      }
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      current.movedFrom = current.file;
      current.file = move[1].trim();
      continue;
    }
    if (line.startsWith('*** ')) {
      // *** Begin Patch / *** End Patch / *** End of File
      if (/^\*\*\* End Patch/.test(line)) flushFile();
      continue;
    }
    if (!current) continue;
    if (mode === 'add') {
      if (line.startsWith('+')) added.push(line.slice(1));
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      continue;
    }
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line === '') {
      // A blank context line some writers emit without its leading space.
      oldLines.push('');
      newLines.push('');
    }
  }
  flushFile();
  return changes;
}

/** The files a Claude / Codex tool call writes (Write, Edit, MultiEdit, apply_patch). */
function claudeChanges(tool: string | undefined, input: Json): FileChange[] {
  const patch = tool === 'apply_patch' || !str(input.file_path) ? patchText(input) : undefined;
  if (patch) return parseApplyPatch(patch);
  const file = str(input.file_path) ?? str(input.path);
  if (!file) return [];
  const content = str(input.content);
  if (content !== undefined && (tool === 'Write' || (str(input.old_string) === undefined && !Array.isArray(input.edits)))) return [{ file, fullText: content }];
  const multi = editsOf(input.edits);
  if (multi) return [{ file, edits: multi }];
  const oldText = str(input.old_string);
  const newText = str(input.new_string);
  if (oldText !== undefined && newText !== undefined) return [{ file, edits: [{ oldText, newText, ...(input.replace_all === true ? { replaceAll: true } : {}) }] }];
  return [];
}

export interface ParseOptions {
  /** `auto` (default) detects the client from the payload. */
  dialect?: Dialect | 'auto';
  env?: Record<string, string | undefined>;
  /** Fallback for `cwd` (the hook process's folder). */
  cwd?: string;
}

/** stdin of a hook → HookInput, or an error message (malformed JSON, not an object). */
export function parseHookInput(text: string, event: HookEvent, options: ParseOptions = {}): HookInput | { error: string } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: text.trim() ? 'stdin is not JSON' : 'nothing on stdin' };
  }
  if (!isObject(payload)) return { error: 'stdin is not a JSON object' };
  const dialect = !options.dialect || options.dialect === 'auto' ? detectDialect(payload, options.env) : options.dialect;
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots.filter((r): r is string => typeof r === 'string' && !!r) : undefined;
  const input: HookInput = {
    dialect,
    event,
    sessionId: str(payload.session_id) ?? str(payload.conversation_id) ?? 'default',
    cwd: str(payload.cwd) ?? roots?.[0] ?? options.cwd ?? '.',
  };
  const tool = str(payload.tool_name);
  if (tool) input.tool = tool;
  let changes: FileChange[] = [];
  if (dialect === 'cursor') {
    const file = str(payload.file_path);
    const edits = editsOf(payload.edits);
    if (file) changes = [edits ? { file, edits } : { file }];
  } else if (isObject(payload.tool_input)) {
    changes = claudeChanges(tool, payload.tool_input);
  }
  if (changes.length) {
    const [first] = changes;
    input.changes = changes;
    input.file = first.file;
    if (first.edits) input.edits = first.edits;
    if (first.fullText !== undefined) input.fullText = first.fullText;
  }
  if (payload.stop_hook_active === true) input.stopHookActive = true;
  const transcript = str(payload.transcript_path);
  if (transcript) input.transcriptPath = transcript;
  if (typeof payload.loop_count === 'number') input.loopCount = payload.loop_count;
  if (roots?.length) input.roots = roots;
  const source = str(payload.source);
  if (source) input.source = source;
  const status = str(payload.status);
  if (status) input.status = status;
  return input;
}

/* -------------------------------------------------------------------------- */
/*                                   Output                                   */
/* -------------------------------------------------------------------------- */

/** What a hook decided, independent of the client. */
export interface HookResult {
  /** Context for the agent: the session brief, what an edit changed, warn-level rule notes. */
  context?: string;
  /** Refuse the edit (pre-edit) with this reason. */
  deny?: string;
  /** Do not let the agent stop yet (stop) with this reason. */
  block?: string;
  /** For the person running the agent (stderr). */
  note?: string;
}

export interface HookOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Claude Code takes at most 10,000 characters of additional context. */
export const MAX_CONTEXT = 9_500;

const clip = (text: string, max = MAX_CONTEXT): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const CLAUDE_EVENT: Record<HookEvent, string> = { 'session-start': 'SessionStart', 'pre-edit': 'PreToolUse', 'post-edit': 'PostToolUse', stop: 'Stop' };

/**
 * The result as the client expects it. Claude Code: `hookSpecificOutput` (additionalContext,
 * permissionDecision `deny`) and `{decision: 'block'}` for stop. Codex: the same JSON for context, and the
 * exit-code-2 convention (reason on stderr) for refusals. Cursor: `followup_message` when it stops (its
 * afterFileEdit takes no answer) and `permission: 'deny'` for its before-hooks.
 */
export function renderHookOutput(dialect: Dialect, event: HookEvent, result: HookResult): HookOutput {
  const out: HookOutput = { stdout: '', stderr: result.note ? `${result.note.replace(/\n?$/, '\n')}` : '', exitCode: 0 };
  const json = (value: unknown): string => `${JSON.stringify(value)}\n`;
  if (dialect === 'cursor') {
    if (event === 'stop') {
      const message = [result.block, result.context].filter(Boolean).join('\n\n');
      if (message) out.stdout = json({ followup_message: clip(message) });
    } else if (event === 'pre-edit' && result.deny) {
      out.stdout = json({ permission: 'deny', user_message: clip(result.deny, 2000), agent_message: clip(result.deny) });
    }
    return out;
  }
  if (result.deny && event === 'pre-edit') {
    if (dialect === 'codex') return { ...out, stderr: `${out.stderr}${clip(result.deny)}\n`, exitCode: 2 };
    out.stdout = json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: clip(result.deny) } });
    return out;
  }
  if (result.block && event === 'stop') {
    if (dialect === 'codex') return { ...out, stderr: `${out.stderr}${clip(result.block)}\n`, exitCode: 2 };
    out.stdout = json({ decision: 'block', reason: clip(result.block) });
    return out;
  }
  if (result.context && event !== 'stop') {
    out.stdout = json({ hookSpecificOutput: { hookEventName: CLAUDE_EVENT[event], additionalContext: clip(result.context) } });
  }
  return out;
}
