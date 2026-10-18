/**
 * `agents init` / `agents remove`: register the code-visualizer MCP server and the guardrail hooks in each
 * AI client's project configuration — Claude Code (.mcp.json, .claude/settings.json), Cursor
 * (.cursor/mcp.json, .cursor/hooks.json), VS Code (.vscode/mcp.json), Codex (.codex/config.toml) and Gemini
 * (.gemini/settings.json) — plus the optional skill and the managed AGENTS.md block.
 *
 * Planning is pure apart from reading the files: every change is a `PlannedWrite` (before → after) that
 * can be shown as a diff first. Only entries named `code-visualizer` are ever added, changed or removed;
 * everything else in those files is kept. A second `init` changes nothing, and `remove` restores what
 * `init` changed exactly (from the backup in `.code-visualizer/state.json` while the file is as init left
 * it, otherwise by taking our entries out).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type TypeScript from 'typescript';
import { AGENTS_BLOCK_START, removeManagedBlock, upsertManagedBlock } from '../shared/markdown.js';
import { VERSION } from '../version.js';

export const AGENT_CLIENTS = ['claude', 'cursor', 'vscode', 'codex', 'gemini'] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];
export const HOOK_MODES = ['none', 'guard', 'strict'] as const;
export type HooksMode = (typeof HOOK_MODES)[number];

/** The name every entry is registered under. */
export const SERVER_NAME = 'code-visualizer';

export interface PlannedWrite {
  /** Project-relative path (absolute for `user` scope). */
  path: string;
  scope: 'project' | 'user';
  kind: 'json-merge' | 'toml-table' | 'text-block' | 'copy';
  /** The current text (undefined: the file does not exist). */
  before?: string;
  /** The new text ('' together with `remove`). */
  after: string;
  /** Delete the file (`agents remove` of a file that only held our entries). */
  remove?: boolean;
  /** What the change is for (`claude`, `cursor`…, `skill`, `agents-md`). */
  owner: AgentClient | 'skill' | 'agents-md';
  /** Caveats: comments that cannot be kept, formatting that is normalized, a file that cannot be parsed. */
  notes?: string[];
  /** The file cannot be changed safely (unparseable JSON, unbalanced markers): left as it is, `notes` say why. */
  skipped?: boolean;
  /** `path` is a symlink (or lies in a linked folder): where the change really goes (project-relative). */
  link?: string;
}

/** `.code-visualizer/state.json` → `agents`: what `init` changed, for an exact `remove`. */
export interface AgentsState {
  files: Record<string, { before: string | null; after: string }>;
  /** Folders `init` created (project-relative): `remove` deletes them again once they are empty. */
  dirs?: string[];
}

/* -------------------------------------------------------------------------- */
/*                                  Detection                                 */
/* -------------------------------------------------------------------------- */

const exists = (p: string): boolean => fs.existsSync(p);

function onPath(bin: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, `${bin}.ps1`, bin] : [bin];
  return dirs.some((dir) => names.some((n) => exists(path.join(dir, n))));
}

/**
 * The agents a project (or this machine) uses, with what gave each away: their project folders and files,
 * their CLIs on PATH, and for Claude Code also its environment (CLAUDECODE, CLAUDE_PROJECT_DIR) and ~/.claude.
 */
export function detectAgentsWithReasons(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { agent: AgentClient; reasons: string[] }[] {
  const found = new Map<AgentClient, string[]>();
  const add = (agent: AgentClient, reason: string): void => void found.set(agent, [...(found.get(agent) ?? []), reason]);
  const at = (p: string): boolean => exists(path.join(root, p));
  const files: [AgentClient, string, string][] = [
    ['claude', '.claude', '.claude/'],
    ['claude', 'CLAUDE.md', 'CLAUDE.md'],
    ['claude', '.mcp.json', '.mcp.json'],
    ['cursor', '.cursor', '.cursor/'],
    ['cursor', '.cursorrules', '.cursorrules'],
    ['vscode', '.vscode', '.vscode/'],
    ['codex', '.codex', '.codex/'],
    ['gemini', '.gemini', '.gemini/'],
    ['gemini', 'GEMINI.md', 'GEMINI.md'],
  ];
  for (const [agent, file, shown] of files) if (at(file)) add(agent, shown);
  for (const agent of ['claude', 'cursor', 'codex', 'gemini'] as const) if (onPath(agent, env, platform)) add(agent, `${agent} on PATH`);
  if (env.CLAUDECODE) add('claude', 'running in Claude Code');
  else if (env.CLAUDE_PROJECT_DIR) add('claude', 'CLAUDE_PROJECT_DIR is set');
  const home = env.HOME ?? env.USERPROFILE;
  if (home && !found.has('claude') && exists(path.join(home, '.claude'))) add('claude', '~/.claude');
  return AGENT_CLIENTS.filter((a) => found.has(a)).map((agent) => ({ agent, reasons: found.get(agent)! }));
}

/** The agents a project (or this machine) uses (see `detectAgentsWithReasons`). */
export function detectAgents(root: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AgentClient[] {
  return detectAgentsWithReasons(root, env, platform).map((d) => d.agent);
}

/* -------------------------------------------------------------------------- */
/*                                  Symlinks                                  */
/* -------------------------------------------------------------------------- */

/** The real path of `abs`, also when it does not exist yet (its nearest existing folder resolved). */
export function realPathOf(abs: string): string {
  const rest: string[] = [];
  for (let current = path.resolve(abs); ; ) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(abs);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

const inside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Where a write to `rel` (below `root`) really lands. `link`: it goes through a symlink — the real file,
 * project-relative, or absolute when it is `outside` the project (such a file must not be changed: it may
 * be anyone's, e.g. a shared settings file in the home folder).
 */
export function writeTarget(root: string, rel: string): { real: string; link?: string; outside: boolean } {
  const lexical = path.resolve(root, rel);
  const realRoot = realPathOf(root);
  const real = realPathOf(lexical);
  const expected = path.join(realRoot, path.relative(path.resolve(root), lexical));
  if (real === expected) return { real, outside: false };
  const outside = !inside(realRoot, real);
  return { real, outside, link: outside ? real : path.relative(realRoot, real).split(path.sep).join('/') };
}

/** `X is a symlink to <target> (outside the project), not changed`. */
export const outsideNote = (rel: string, target: string): string => `${rel} is a symlink to ${target} (outside the project), not changed`;

/**
 * Planned writes made safe for symlinks: a file whose real path is outside the project is not changed; one
 * that goes through a link inside the project names its target; two paths that are the same file are
 * written once (the first plan wins).
 */
function guardLinks(root: string, writes: PlannedWrite[]): PlannedWrite[] {
  const seen = new Map<string, PlannedWrite>();
  const out: PlannedWrite[] = [];
  for (const w of writes) {
    const target = writeTarget(root, w.path);
    if (target.outside) {
      out.push({ ...w, after: w.before ?? '', remove: undefined, skipped: true, link: target.link, notes: [outsideNote(w.path, target.link ?? target.real)] });
      continue;
    }
    const first = seen.get(target.real);
    if (first) {
      if (!w.skipped) first.notes = [...(first.notes ?? []), `${w.path} is the same file (a link): changed once`];
      continue;
    }
    const next = target.link ? { ...w, link: target.link } : w;
    seen.set(target.real, next);
    out.push(next);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                  Commands                                  */
/* -------------------------------------------------------------------------- */

/** The major version clients pin (`code-visualizer@0`), so a breaking release is not picked up silently. */
export function majorVersion(version = VERSION): string {
  return /^(\d+)/.exec(version)?.[1] ?? 'latest';
}

/**
 * How clients start the CLI: the project's own install when it has one (`npx --no-install`), otherwise
 * the published package at this major version. Windows runs npx through `cmd /c`.
 */
export function cliCommand(root: string, platform: NodeJS.Platform = process.platform, version = VERSION): { command: string; args: string[]; local: boolean } {
  const bin = path.join(root, 'node_modules', '.bin');
  const local = exists(path.join(bin, 'code-visualizer')) || exists(path.join(bin, 'code-visualizer.cmd'));
  const npx = local ? ['npx', '--no-install', SERVER_NAME] : ['npx', '-y', `${SERVER_NAME}@${majorVersion(version)}`];
  return platform === 'win32' ? { command: 'cmd', args: ['/c', ...npx], local } : { command: npx[0], args: npx.slice(1), local };
}

/** The hook command line (hooks run through a shell on every platform). */
export function hookCommandLine(root: string, event: string, extra: string[] = [], version = VERSION): string {
  const { args } = cliCommand(root, 'linux', version);
  return ['npx', ...args, 'hook', event, ...extra].join(' ');
}

/** A hook command of ours: `… code-visualizer[@x] hook …` or `cviz hook …`. */
export const isOurHookCommand = (command: unknown): boolean => typeof command === 'string' && /(^|[\s/])(code-visualizer(@\S+)?|cviz)\s+hook\s/.test(command);

/* -------------------------------------------------------------------------- */
/*                               JSON with comments                           */
/* -------------------------------------------------------------------------- */

const requireModule = createRequire(import.meta.url);
let ts: typeof TypeScript | undefined;

/** Whether a JSON-with-comments text has comments (outside strings). */
export function hasJsonComments(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

/** Parse a JSON(C) config file the way the editors do (comments and trailing commas allowed). */
export function parseJsonc(file: string, text: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return { value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? { value: value as Record<string, unknown> } : { error: `${file} does not contain a JSON object` };
  } catch {
    /* comments or trailing commas: TypeScript's tsconfig parser reads them */
  }
  ts ??= requireModule('typescript') as typeof TypeScript;
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (error) return { error: `${file}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}` };
  return config && typeof config === 'object' && !Array.isArray(config) ? { value: config as Record<string, unknown> } : { error: `${file} does not contain a JSON object` };
}

/** The indentation a JSON text uses (a tab, or its number of spaces); 2 for one-line or empty files. */
export function jsonIndent(text: string | undefined): string | number {
  const m = /^([ \t]+)["}\]]/m.exec(text ?? '');
  if (!m) return 2;
  return m[1].startsWith('\t') ? '\t' : m[1].length;
}

const toJson = (value: unknown, indent: string | number = 2): string => `${JSON.stringify(value, null, indent)}\n`;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/* -------------------------------------------------------------------------- */
/*                                Entry editing                               */
/* -------------------------------------------------------------------------- */

type JsonEdit = (doc: Record<string, unknown>) => Record<string, unknown>;

/** `doc[key][name] = value` (replacing ours in place, after the others when new); value undefined removes it. */
function setServer(key: string, value: unknown): JsonEdit {
  return (doc) => {
    const servers = isObject(doc[key]) ? { ...doc[key] } : {};
    if (value === undefined) delete servers[SERVER_NAME];
    else servers[SERVER_NAME] = value;
    const next = { ...doc };
    if (Object.keys(servers).length) next[key] = servers;
    else delete next[key];
    return next;
  };
}

const CLAUDE_TOOLS = 'Write|Edit|MultiEdit';

/** Claude Code hook groups (`{matcher?, hooks: [{type, command, timeout}]}`) per event for a mode. */
function claudeHooks(root: string, mode: HooksMode): Record<string, Record<string, unknown>> {
  if (mode === 'none') return {};
  const entry = (event: string, timeout: number, extra: string[] = []): Record<string, unknown> => ({ type: 'command', command: hookCommandLine(root, event, extra), timeout });
  const groups: Record<string, Record<string, unknown>> = {
    SessionStart: { hooks: [entry('session-start', 30)] },
    PreToolUse: { matcher: CLAUDE_TOOLS, hooks: [entry('pre-edit', 15)] },
    PostToolUse: { matcher: CLAUDE_TOOLS, hooks: [entry('post-edit', 15)] },
  };
  if (mode === 'strict') groups.Stop = { hooks: [entry('stop', 60, ['--strict'])] };
  return groups;
}

/**
 * Our hook groups in place of the ones we added before; the user's groups and hooks stay as they are.
 * A group that holds a hook of ours next to the user's keeps the user's hooks.
 */
function mergeClaudeHooks(ours: Record<string, Record<string, unknown>>): JsonEdit {
  return (doc) => {
    const hooks: Record<string, unknown> = isObject(doc.hooks) ? { ...doc.hooks } : {};
    for (const event of new Set([...Object.keys(hooks), ...Object.keys(ours)])) {
      const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      const kept: unknown[] = [];
      let at = -1;
      for (const group of groups) {
        const list = isObject(group) && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : undefined;
        const mine = list?.filter((h) => isObject(h) && isOurHookCommand(h.command)) ?? [];
        if (!list || !mine.length) {
          kept.push(group);
          continue;
        }
        if (at === -1) at = kept.length;
        const theirs = list.filter((h) => !mine.includes(h));
        if (theirs.length) kept.push({ ...(group as Record<string, unknown>), hooks: theirs });
      }
      if (ours[event]) kept.splice(at === -1 ? kept.length : at, 0, ours[event]);
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    const next = { ...doc };
    if (Object.keys(hooks).length) next.hooks = hooks;
    else delete next.hooks;
    return next;
  };
}

/** Cursor hooks (`{version: 1, hooks: {afterFileEdit: [{command}], stop: [{command}]}}`): ours replace ours. */
function mergeCursorHooks(root: string, mode: HooksMode | 'remove'): JsonEdit {
  return (doc) => {
    const hooks: Record<string, unknown> = isObject(doc.hooks) ? { ...doc.hooks } : {};
    // Cursor's afterFileEdit takes no answer: the radar's findings are relayed by the stop hook (strict adds the test gate).
    const ours: Record<string, string> =
      mode === 'remove' || mode === 'none'
        ? {}
        : { afterFileEdit: hookCommandLine(root, 'post-edit', ['--dialect', 'cursor']), stop: hookCommandLine(root, 'stop', ['--dialect', 'cursor', ...(mode === 'strict' ? ['--strict'] : [])]) };
    for (const event of new Set([...Object.keys(hooks), ...Object.keys(ours)])) {
      const list = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter((h) => !(isObject(h) && isOurHookCommand(h.command)));
      if (ours[event]) list.push({ command: ours[event] });
      if (list.length) hooks[event] = list;
      else delete hooks[event];
    }
    const next: Record<string, unknown> = { ...doc };
    if (Object.keys(hooks).length) {
      if (next.version === undefined) return { version: 1, ...next, hooks };
      next.hooks = hooks;
    } else {
      delete next.hooks;
      // A file that only held our hooks: the version key was ours too.
      if (Object.keys(next).length === 1 && next.version === 1) delete next.version;
    }
    return next;
  };
}

/** Whether a client config already holds an entry of ours. */
function hasOurJson(doc: Record<string, unknown>): boolean {
  for (const key of ['mcpServers', 'servers']) if (isObject(doc[key]) && SERVER_NAME in doc[key]) return true;
  const hooks = doc.hooks;
  if (!isObject(hooks)) return false;
  return Object.values(hooks).some(
    (list) => Array.isArray(list) && list.some((g) => isObject(g) && (isOurHookCommand(g.command) || (Array.isArray(g.hooks) && g.hooks.some((h) => isObject(h) && isOurHookCommand(h.command))))),
  );
}

/* -------------------------------------------------------------------------- */
/*                                    TOML                                    */
/* -------------------------------------------------------------------------- */

export const TOML_START = '# code-visualizer:start';
export const TOML_END = '# code-visualizer:end';

const tomlString = (s: string): string => JSON.stringify(s);

/** The Codex table, between markers. */
export function codexTable(command: string, args: string[]): string {
  return [
    TOML_START,
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    // The first run analyzes the whole project; later ones start warm.
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    TOML_END,
  ].join('\n');
}

const TABLE_RE = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*("?)${SERVER_NAME}\\1\\s*\\]\\s*(#.*)?$`);

/** `text` with our table (marked, or a hand-written `[mcp_servers.code-visualizer]`) replaced by `block`, or appended. */
export function upsertTomlTable(text: string | null, block: string): string {
  if (!text?.trim()) return `${block}\n`;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === TOML_START);
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === TOML_END);
  if (start !== -1 && end !== -1) return [...lines.slice(0, start), block, ...lines.slice(end + 1)].join('\n');
  const header = lines.findIndex((l) => TABLE_RE.test(l));
  if (header !== -1) {
    // A table written by hand: it ends at the next table header (blank lines before it stay).
    let stop = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l));
    if (stop === -1) stop = lines.length;
    while (stop - 1 > header && !lines[stop - 1].trim()) stop--;
    return [...lines.slice(0, header), block, ...lines.slice(stop)].join('\n');
  }
  return `${text.replace(/\n*$/, '')}\n\n${block}\n`;
}

/** `text` without our marked table (and the blank line before it); null when nothing else remains. */
export function removeTomlTable(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === TOML_START);
  const end = start === -1 ? -1 : lines.findIndex((l, i) => i > start && l.trim() === TOML_END);
  if (start === -1 || end === -1) return text;
  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  if (before.length && !before[before.length - 1].trim() && (!after.length || after.every((l) => !l.trim()))) before.pop();
  const next = [...before, ...after].join('\n');
  return next.trim() ? next : null;
}

/* -------------------------------------------------------------------------- */
/*                                 CLAUDE.md                                  */
/* -------------------------------------------------------------------------- */

const IMPORT_MARK = '<!-- code-visualizer: the project map for agents lives in AGENTS.md -->';

/** CLAUDE.md with an `@AGENTS.md` import (unless it already imports AGENTS.md). */
export function withClaudeImport(text: string | null): string {
  if (text !== null && /^@\.?\/?AGENTS\.md\s*$/m.test(text)) return text;
  const lines = `${IMPORT_MARK}\n@AGENTS.md\n`;
  if (text === null || !text.trim()) return lines;
  return `${text.replace(/\n*$/, '')}\n\n${lines}`;
}

/** CLAUDE.md without the import `withClaudeImport` added (its two lines, nowhere else); null when nothing else remains. */
export function withoutClaudeImport(text: string): string | null {
  const re = new RegExp(`\\n?\\n?^${IMPORT_MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n@AGENTS\\.md[ \\t]*$\\n?`, 'm');
  if (!re.test(text)) return text;
  const next = text.replace(re, '\n').replace(/^\n+/, '');
  return next.trim() ? next : null;
}

/* -------------------------------------------------------------------------- */
/*                                    Skill                                   */
/* -------------------------------------------------------------------------- */

export const SKILL_TARGET = '.claude/skills/code-visualizer/SKILL.md';

/** The SKILL.md this package ships (next to dist/ or src/ in the installed package). */
export function bundledSkill(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, 'skills', 'code-visualizer', 'SKILL.md');
    if (exists(file)) return fs.readFileSync(file, 'utf8');
    dir = path.dirname(dir);
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*                                  Planning                                  */
/* -------------------------------------------------------------------------- */

function read(root: string, rel: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return undefined;
  }
}

/** A JSON config file with `edit` applied (in the file's own indentation); undefined when nothing changes. */
function planJson(root: string, rel: string, owner: PlannedWrite['owner'], edit: JsonEdit, removing = false): PlannedWrite | undefined {
  const before = read(root, rel);
  if (before === undefined && removing) return undefined;
  const parsed = parseJsonc(rel, before ?? '');
  if (!parsed.value) {
    return { path: rel, scope: 'project', kind: 'json-merge', before, after: before ?? '', owner, skipped: true, notes: [`${parsed.error ?? `${rel} cannot be read`}; it is left as it is (add the entry by hand).`] };
  }
  if (removing && !hasOurJson(parsed.value)) return undefined;
  const next = edit(parsed.value);
  const notes: string[] = [];
  if (removing && !Object.keys(next).length) return { path: rel, scope: 'project', kind: 'json-merge', before, after: '', remove: true, owner };
  const indent = jsonIndent(before);
  const after = toJson(next, indent);
  if (after === before) return undefined;
  if (before !== undefined && before.trim()) {
    if (hasJsonComments(before)) notes.push(`the comments in ${rel} are not kept`);
    else if (toJson(parsed.value, indent) !== before) notes.push(`${rel} is rewritten as formatted JSON`);
  }
  return { path: rel, scope: 'project', kind: 'json-merge', before, after, owner, ...(notes.length ? { notes } : {}) };
}

function planText(root: string, rel: string, owner: PlannedWrite['owner'], kind: PlannedWrite['kind'], transform: (text: string | null) => string | null, removing = false): PlannedWrite | undefined {
  const before = read(root, rel);
  if (before === undefined && removing) return undefined;
  let next: string | null;
  try {
    next = transform(before ?? null);
  } catch (error) {
    // Markers that do not pair up: writing could duplicate our block or eat the user's text.
    return { path: rel, scope: 'project', kind, before, after: before ?? '', owner, skipped: true, notes: [`${rel}: ${(error as Error).message}; it is left as it is (fix the markers by hand).`] };
  }
  if (next === null) return before === undefined ? undefined : { path: rel, scope: 'project', kind, before, after: '', remove: true, owner };
  if (next === before) return undefined;
  return { path: rel, scope: 'project', kind, before, after: next, owner };
}

export interface InitOptions {
  agents: AgentClient[];
  hooks?: HooksMode;
  /** Copy the skill to .claude/skills/code-visualizer/. */
  skill?: boolean;
  /** The managed AGENTS.md block to write (built from an analysis by the caller). */
  agentsBlock?: string;
  platform?: NodeJS.Platform;
  /** Tool version (pins `code-visualizer@<major>` when the project has no local install). */
  version?: string;
}

/** Every change `agents init` would make (nothing when the project is already set up). */
export function planInit(root: string, options: InitOptions): PlannedWrite[] {
  const mode = options.hooks ?? 'guard';
  const { command, args } = cliCommand(root, options.platform, options.version);
  const writes: (PlannedWrite | undefined)[] = [];
  const agents = new Set(options.agents);
  // `--hooks none` takes out hooks an earlier init installed (only ours; a file that held nothing else goes).
  const none = mode === 'none';
  if (agents.has('claude')) {
    writes.push(planJson(root, '.mcp.json', 'claude', setServer('mcpServers', { type: 'stdio', command, args: [...args, 'mcp'] })));
    writes.push(planJson(root, '.claude/settings.json', 'claude', mergeClaudeHooks(claudeHooks(root, mode)), none));
  }
  if (agents.has('cursor')) {
    writes.push(planJson(root, '.cursor/mcp.json', 'cursor', setServer('mcpServers', { command, args: [...args, 'mcp', '--root', '${workspaceFolder}'] })));
    writes.push(planJson(root, '.cursor/hooks.json', 'cursor', mergeCursorHooks(root, mode), none));
  }
  if (agents.has('vscode')) writes.push(planJson(root, '.vscode/mcp.json', 'vscode', setServer('servers', { type: 'stdio', command, args: [...args, 'mcp', '--root', '${workspaceFolder}'] })));
  if (agents.has('codex')) writes.push(planText(root, '.codex/config.toml', 'codex', 'toml-table', (t) => upsertTomlTable(t, codexTable(command, [...args, 'mcp']))));
  if (agents.has('gemini')) writes.push(planJson(root, '.gemini/settings.json', 'gemini', setServer('mcpServers', { command, args: [...args, 'mcp'], timeout: 120000 })));
  if (options.skill) {
    const skill = bundledSkill();
    if (skill !== undefined) writes.push(planText(root, SKILL_TARGET, 'skill', 'copy', () => skill));
  }
  if (options.agentsBlock) {
    const block = options.agentsBlock;
    writes.push(planText(root, 'AGENTS.md', 'agents-md', 'text-block', (t) => upsertManagedBlock(t, block)));
    // Claude Code reads CLAUDE.md, not AGENTS.md — unless CLAUDE.md is AGENTS.md (a symlink to it).
    if (agents.has('claude') && !sameFile(root, 'CLAUDE.md', 'AGENTS.md')) writes.push(planText(root, 'CLAUDE.md', 'agents-md', 'text-block', withClaudeImport));
  }
  return guardLinks(
    root,
    writes.filter((w): w is PlannedWrite => !!w),
  );
}

/** Two project paths are one file (one links to the other). */
function sameFile(root: string, a: string, b: string): boolean {
  return writeTarget(root, a).real === writeTarget(root, b).real;
}

/** Our own state of a file without us: the structural removal used when no exact backup applies. */
function structuralRemoval(root: string, rel: string): PlannedWrite | undefined {
  switch (rel) {
    case '.mcp.json':
      return planJson(root, rel, 'claude', setServer('mcpServers', undefined), true);
    case '.claude/settings.json':
      return planJson(root, rel, 'claude', mergeClaudeHooks({}), true);
    case '.cursor/mcp.json':
      return planJson(root, rel, 'cursor', setServer('mcpServers', undefined), true);
    case '.cursor/hooks.json':
      return planJson(root, rel, 'cursor', mergeCursorHooks(root, 'remove'), true);
    case '.vscode/mcp.json':
      return planJson(root, rel, 'vscode', setServer('servers', undefined), true);
    case '.gemini/settings.json':
      return planJson(root, rel, 'gemini', setServer('mcpServers', undefined), true);
    case '.codex/config.toml':
      return planText(root, rel, 'codex', 'toml-table', (t) => (t === null ? null : removeTomlTable(t)), true);
    case SKILL_TARGET: {
      const shipped = bundledSkill();
      // Only the copy init made: a SKILL.md edited by the user stays.
      return planText(root, rel, 'skill', 'copy', (t) => (t !== null && (shipped === undefined || t === shipped) ? null : t), true);
    }
    case 'AGENTS.md':
      return planText(root, rel, 'agents-md', 'text-block', (t) => (t === null || !t.includes(AGENTS_BLOCK_START) ? t : removeManagedBlock(t)), true);
    case 'CLAUDE.md':
      return planText(root, rel, 'agents-md', 'text-block', (t) => (t === null ? null : withoutClaudeImport(t)), true);
    default:
      return undefined;
  }
}

/** Every file `agents init` may write, in a stable order. */
export const MANAGED_FILES = ['.mcp.json', '.claude/settings.json', '.cursor/mcp.json', '.cursor/hooks.json', '.vscode/mcp.json', '.codex/config.toml', '.gemini/settings.json', SKILL_TARGET, 'AGENTS.md', 'CLAUDE.md'];

const OWNER: Record<string, PlannedWrite['owner']> = {
  '.mcp.json': 'claude',
  '.claude/settings.json': 'claude',
  '.cursor/mcp.json': 'cursor',
  '.cursor/hooks.json': 'cursor',
  '.vscode/mcp.json': 'vscode',
  '.codex/config.toml': 'codex',
  '.gemini/settings.json': 'gemini',
  [SKILL_TARGET]: 'skill',
  'AGENTS.md': 'agents-md',
  'CLAUDE.md': 'agents-md',
};

export interface RemoveOptions {
  /** The clients to remove (default: every one, unless only `skill` / `agentsMd` are asked for). */
  agents?: AgentClient[];
  /** Also remove the copied skill (implied when every client goes). */
  skill?: boolean;
  /** Also remove the AGENTS.md block and the CLAUDE.md import (implied when every client goes). */
  agentsMd?: boolean;
  state?: AgentsState;
}

/** The clients and shared parts `remove` takes out: the skill and AGENTS.md serve every client, so they go only when asked or with all clients. */
export function removeScope(options: Pick<RemoveOptions, 'agents' | 'skill' | 'agentsMd'>): { clients: AgentClient[]; skill: boolean; agentsMd: boolean } {
  const clients = options.agents ?? (options.skill || options.agentsMd ? [] : [...AGENT_CLIENTS]);
  const all = AGENT_CLIENTS.every((a) => clients.includes(a));
  return { clients, skill: !!options.skill || all, agentsMd: !!options.agentsMd || all };
}

/**
 * Every change `agents remove` would make: our entries out of the chosen clients' files. A file still
 * exactly as `init` left it gets its text from before `init` back (byte for byte); otherwise our entries
 * are taken out and the rest is kept.
 */
export function planRemove(root: string, options: RemoveOptions = {}): PlannedWrite[] {
  const scope = removeScope(options);
  const writes: PlannedWrite[] = [];
  for (const rel of MANAGED_FILES) {
    const owner = OWNER[rel];
    if (owner === 'skill' ? !scope.skill : owner === 'agents-md' ? !scope.agentsMd : !scope.clients.includes(owner)) continue;
    const backup = options.state?.files[rel];
    const before = read(root, rel);
    if (backup && before !== undefined && before === backup.after) {
      if (backup.before === before) continue;
      const kind = rel.endsWith('.toml') ? 'toml-table' : rel.endsWith('.json') ? 'json-merge' : rel === SKILL_TARGET ? 'copy' : 'text-block';
      writes.push(backup.before === null ? { path: rel, scope: 'project', kind, before, after: '', remove: true, owner } : { path: rel, scope: 'project', kind, before, after: backup.before, owner });
      continue;
    }
    const w = structuralRemoval(root, rel);
    if (w && !w.skipped) writes.push(w);
  }
  // A CLAUDE.md that is AGENTS.md got no import: nothing of ours to take out of it.
  return guardLinks(
    root,
    writes.filter((w) => !(w.path === 'CLAUDE.md' && sameFile(root, 'CLAUDE.md', 'AGENTS.md'))),
  );
}

/**
 * The backups to keep after `init` applies `writes`: the text from before the first `init` while the
 * file stays as init left it (a re-run keeps the original), otherwise the text before this one.
 */
export function nextAgentsState(root: string, writes: PlannedWrite[], previous: AgentsState | undefined): AgentsState {
  const files = { ...(previous?.files ?? {}) };
  const dirs = new Set(previous?.dirs ?? []);
  for (const w of writes) {
    if (w.remove || w.skipped) continue;
    for (let dir = path.posix.dirname(w.path); dir !== '.' && !exists(path.join(root, dir)); dir = path.posix.dirname(dir)) dirs.add(dir);
  }
  for (const w of writes) {
    if (w.skipped) continue;
    if (w.remove) {
      delete files[w.path];
      continue;
    }
    const prior = files[w.path];
    const keep = prior && w.before === prior.after;
    let before: string | null = keep ? prior.before : (w.before ?? null);
    // A file with entries of ours that init did not record (another machine's init): its original is unknown.
    if (!keep && w.before !== undefined) {
      const without = structuralRemoval(root, w.path);
      if (without) before = without.remove ? null : without.after;
    }
    files[w.path] = { before, after: w.after };
  }
  return { files, ...(dirs.size ? { dirs: [...dirs].sort() } : {}) };
}

/**
 * Write the planned changes, creating folders. `createdDirs` (project-relative): folders init created, which
 * go again once a removal leaves them empty (.cursor/, .claude/skills/code-visualizer/…).
 */
export function applyWrites(root: string, writes: PlannedWrite[], createdDirs: Iterable<string> = []): void {
  const removable = new Set(createdDirs);
  for (const w of writes) {
    if (w.skipped) continue;
    const abs = path.resolve(root, w.path);
    // Checked again right before writing: never through a link that leads out of the project.
    const target = writeTarget(root, w.path);
    if (target.outside) continue;
    if (w.remove) {
      // A link to a file of ours: the file goes, and the link to it.
      if (target.link) fs.rmSync(target.real, { force: true });
      fs.rmSync(abs, { force: true });
      for (let dir = path.posix.dirname(w.path); dir !== '.' && removable.has(dir); dir = path.posix.dirname(dir)) {
        try {
          if (fs.readdirSync(path.join(root, dir)).length) break;
          fs.rmdirSync(path.join(root, dir));
        } catch {
          break;
        }
      }
      continue;
    }
    fs.mkdirSync(path.dirname(target.real), { recursive: true });
    fs.writeFileSync(target.real, w.after);
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Inspection                                */
/* -------------------------------------------------------------------------- */

const MCP_FILES: Record<AgentClient, string> = { claude: '.mcp.json', cursor: '.cursor/mcp.json', vscode: '.vscode/mcp.json', codex: '.codex/config.toml', gemini: '.gemini/settings.json' };

/** Where the code-visualizer MCP server is registered for a client in this project (undefined: not). */
export function mcpConfigFile(root: string, client: AgentClient): string | undefined {
  const rel = MCP_FILES[client];
  const text = read(root, rel);
  if (text === undefined) return undefined;
  if (rel.endsWith('.toml')) return text.split('\n').some((l) => TABLE_RE.test(l)) ? rel : undefined;
  const parsed = parseJsonc(rel, text).value;
  const key = client === 'vscode' ? 'servers' : 'mcpServers';
  return parsed && isObject(parsed[key]) && SERVER_NAME in parsed[key] ? rel : undefined;
}

/** Which guardrail hooks a client's project configuration runs (by event). */
export function installedHooks(root: string, client: 'claude' | 'cursor'): string[] {
  const rel = client === 'claude' ? '.claude/settings.json' : '.cursor/hooks.json';
  const text = read(root, rel);
  const doc = text === undefined ? undefined : parseJsonc(rel, text).value;
  if (!doc || !isObject(doc.hooks)) return [];
  const events: string[] = [];
  for (const [event, list] of Object.entries(doc.hooks)) {
    if (!Array.isArray(list)) continue;
    const ours = list.some((g) => isObject(g) && (isOurHookCommand(g.command) || (Array.isArray(g.hooks) && g.hooks.some((h) => isObject(h) && isOurHookCommand(h.command)))));
    if (ours) events.push(event);
  }
  return events;
}

/** A TOML value we write (a basic string or an array of them), parsed; undefined for anything else. */
function tomlValue(raw: string): unknown {
  const text = raw.replace(/\s+#[^"'\]]*$/, '').trim();
  for (const candidate of [text, text.replace(/'([^']*)'/g, (_, v: string) => JSON.stringify(v))]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* next form */
    }
  }
  return undefined;
}

/** How a client's configuration starts the code-visualizer MCP server (undefined: not registered). */
export function registeredMcp(root: string, client: AgentClient): { file: string; command: string; args: string[] } | undefined {
  const rel = MCP_FILES[client];
  const text = read(root, rel);
  if (text === undefined) return undefined;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : []);
  if (rel.endsWith('.toml')) {
    const lines = text.split('\n');
    const header = lines.findIndex((l) => TABLE_RE.test(l));
    if (header === -1) return undefined;
    let command: string | undefined;
    let args: string[] = [];
    for (let i = header + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
      const m = /^\s*(command|args)\s*=\s*(.+)$/.exec(lines[i]);
      if (!m) continue;
      const value = tomlValue(m[2]);
      if (m[1] === 'command' && typeof value === 'string') command = value;
      else if (m[1] === 'args') args = strings(value);
    }
    return command ? { file: rel, command, args } : undefined;
  }
  const doc = parseJsonc(rel, text).value;
  const servers = doc?.[client === 'vscode' ? 'servers' : 'mcpServers'];
  const entry = isObject(servers) ? servers[SERVER_NAME] : undefined;
  if (!isObject(entry) || typeof entry.command !== 'string') return undefined;
  return { file: rel, command: entry.command, args: strings(entry.args) };
}

/** Our hook command lines in a client's project configuration (event → command line). */
export function registeredHooks(root: string, client: 'claude' | 'cursor'): { event: string; command: string }[] {
  const rel = client === 'claude' ? '.claude/settings.json' : '.cursor/hooks.json';
  const text = read(root, rel);
  const doc = text === undefined ? undefined : parseJsonc(rel, text).value;
  if (!doc || !isObject(doc.hooks)) return [];
  const out: { event: string; command: string }[] = [];
  for (const [event, list] of Object.entries(doc.hooks)) {
    if (!Array.isArray(list)) continue;
    for (const group of list) {
      if (!isObject(group)) continue;
      const entries = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const h of entries) if (isObject(h) && isOurHookCommand(h.command)) out.push({ event, command: h.command as string });
    }
  }
  return out;
}

/** How a registered command reaches the CLI. */
export interface Launch {
  /**
   * `local`: the project's own install (`npx --no-install code-visualizer`); `registry`: the published
   * package (`npx -y code-visualizer@0`, fetched on first use); `command`: anything else, run as it is.
   */
  via: 'local' | 'registry' | 'command';
  /** The CLI's own arguments (`mcp …`, `hook pre-edit …`); for `command`, every argument. */
  cliArgs: string[];
  /** `code-visualizer@0` → '0'. */
  pin?: string;
}

/** What a registered command (program and arguments, `cmd /c` on Windows included) runs. */
export function parseLaunch(command: string, args: string[]): Launch {
  let words = [command, ...args];
  if (/^cmd(\.exe)?$/i.test(words[0]) && /^\/c$/i.test(words[1] ?? '')) words = words.slice(2);
  const at = words.findIndex((w) => /^(?:.*[\\/])?(code-visualizer|cviz)(@\S*)?$/.test(w));
  const launcher = words.slice(0, Math.max(at, 0));
  if (at === -1 || !/^(npx|bunx)(\.cmd)?$/i.test(launcher[0] ?? '')) return { via: 'command', cliArgs: at === -1 ? args : words.slice(at + 1) };
  const pin = /@(\S+)$/.exec(words[at])?.[1];
  const cliArgs = words.slice(at + 1);
  if (launcher.includes('--no-install') || launcher.includes('--no')) return { via: 'local', cliArgs, ...(pin ? { pin } : {}) };
  return { via: 'registry', cliArgs, ...(pin ? { pin } : {}) };
}
