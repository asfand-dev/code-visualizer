/**
 * Claude Code tools found in a project and in `~/.claude`: skills, slash commands, subagents, memory files,
 * MCP servers, hooks and plugins. Reads their front matter, explains when and how to use each one, and checks
 * the project's setup. Pure — the analyzer reads the files.
 *
 * Privacy: what is kept is names, descriptions and where something lives. A hook shows its command with secrets
 * masked; an MCP server shows its transport and host name, never its arguments, headers or environment.
 */
import { plural } from './plural.js';
import { maskSecretsIn } from './risks.js';
import type { AiCatalog, AiItem, AiScope, ToolCheck } from './types.js';
import { isRecord, parseYaml } from './yaml.js';

const CHARS_PER_TOKEN = 4;
const MAX_DESCRIPTION = 300;
const MAX_COMMAND = 200;
const LONG_DESCRIPTION = 1024;
const LONG_MEMORY_LINES = 300;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/* ------------------------------- Front matter ------------------------------- */

export interface FrontMatter {
  data: Record<string, unknown>;
  /** The text after the front matter. */
  body: string;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const unquote = (value: string): string => {
  const v = value.trim();
  return v.length > 1 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]) ? v.slice(1, -1) : v;
};

/** `key: value` lines, for front matter that is not valid YAML (an unquoted `description: Use when X: do Y`). */
function looseKeyValues(block: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let last: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (match) {
      data[match[1]] = unquote(match[2]);
      last = match[1];
    } else if (last && /^\s+\S/.test(line)) {
      data[last] = `${String(data[last])} ${line.trim()}`.trim();
    }
  }
  return data;
}

export function parseFrontMatter(text: string): FrontMatter {
  const clean = text.replace(/^\uFEFF/, '');
  const match = FRONT_MATTER.exec(clean);
  if (!match) return { data: {}, body: clean };
  const parsed = parseYaml(match[1]);
  return { data: !parsed.error && isRecord(parsed.value) ? parsed.value : looseKeyValues(match[1]), body: clean.slice(match[0].length) };
}

/* -------------------------------- Utilities --------------------------------- */

const asText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined);

/** Tool lists are written `Read, Grep, Bash(git add:*)` or as a YAML list; commas inside parentheses do not split. */
function toolList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/,(?![^(]*\))/) : [];
  const tools = items.map((t) => t.trim()).filter(Boolean);
  return tools.length ? tools : undefined;
}

/** `argument-hint: [issue]` is a YAML list, but what the author meant is the text `[issue]`. */
const hintOf = (value: unknown): string | undefined => (Array.isArray(value) ? asText(`[${value.map(String).join(', ')}]`) : asText(value));

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Only what is set: `{ uses: undefined }` would show up as a key in the JSON. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export interface ItemSource {
  scope: AiScope;
  /** The plugin a tool comes from. */
  plugin?: string;
  /** Project-relative, or starting with `~/`. */
  path: string;
}

const lineCount = (text: string): number => (text ? text.split('\n').length : 0);

/* ---------------------------- Skills, commands, agents ---------------------------- */

/** A skill: a folder with a `SKILL.md`. Claude reads its description to decide when to use it. */
export function skillItem(folder: string, text: string, source: ItemSource): AiItem {
  const { data, body } = parseFrontMatter(text);
  const name = asText(data.name) ?? folder;
  const description = asText(data.description) ? oneLine(asText(data.description) as string) : undefined;
  const hint = hintOf(data['argument-hint']);
  const manualOnly = data['disable-model-invocation'] === true;
  const background = data['user-invocable'] === false;
  const invoke = background ? undefined : `/${source.plugin ? `${source.plugin}:` : ''}${name}${hint ? ` ${hint}` : ''}`;
  const slash = `/${source.plugin ? `${source.plugin}:` : ''}${name}`;
  const usage = manualOnly
    ? `Runs only when you type ${slash}${hint ? ` ${hint}` : ''}. Claude never starts it on its own.`
    : background
      ? 'Background knowledge: Claude loads it when a task matches the description. It is not a slash command.'
      : `Claude loads it by itself when your request matches the description. You can also run it directly with ${slash}${hint ? ` ${hint}` : ''}.`;
  const warning = !description ? 'No description: Claude cannot tell when to use it.' : description.length > LONG_DESCRIPTION ? 'The description is very long; every session loads it.' : undefined;
  return defined({
    kind: 'skill' as const,
    scope: source.scope,
    name,
    description: description && clip(description, MAX_DESCRIPTION),
    path: source.path,
    invoke,
    usage,
    plugin: source.plugin,
    tools: toolList(data['allowed-tools']),
    model: asText(data.model),
    auto: !manualOnly,
    lines: lineCount(body.trim()),
    tokens: estimateTokens(description ?? ''),
    warning,
  });
}

/** The first line of the body, without Markdown heading marks: a command's description when it has none. */
function firstLine(body: string): string | undefined {
  const line = body.split('\n').find((l) => l.trim() && !l.startsWith('```'));
  return line ? oneLine(line.replace(/^#+\s*/, '')) : undefined;
}

/** A slash command: a Markdown file whose name is what you type after `/`. A folder only groups them. */
export function commandItem(name: string, folder: string | undefined, text: string, source: ItemSource): AiItem {
  const { data, body } = parseFrontMatter(text);
  const described = asText(data.description);
  const description = described ? oneLine(described) : firstLine(body);
  const hint = hintOf(data['argument-hint']);
  const takesArguments = /\$ARGUMENTS|\$\d\b/.test(body) || !!hint;
  const slash = `/${source.plugin ? `${source.plugin}:` : ''}${name}`;
  const usage = `Type ${slash}${takesArguments ? ` followed by ${hint ?? 'what it should work on'}` : ''} in Claude Code.${folder ? ` Grouped under ${folder}/.` : ''}${data['disable-model-invocation'] === true ? ' Claude never runs it on its own.' : ''}`;
  return defined({
    kind: 'command' as const,
    scope: source.scope,
    name,
    description: description && clip(description, MAX_DESCRIPTION),
    path: source.path,
    invoke: `${slash}${hint ? ` ${hint}` : ''}`,
    usage,
    plugin: source.plugin,
    tools: toolList(data['allowed-tools']),
    model: asText(data.model),
    lines: lineCount(body.trim()),
    tokens: estimateTokens(description ?? ''),
    warning: description ? undefined : 'No description: it shows without one in the / menu.',
  });
}

/** A subagent: a Markdown file with its own instructions, tools and context window. */
export function agentItem(fileName: string, text: string, source: ItemSource): AiItem {
  const { data, body } = parseFrontMatter(text);
  const name = asText(data.name) ?? fileName;
  const description = asText(data.description) ? oneLine(asText(data.description) as string) : undefined;
  const tools = toolList(data.tools);
  return defined({
    kind: 'agent' as const,
    scope: source.scope,
    name,
    description: description && clip(description, MAX_DESCRIPTION),
    path: source.path,
    invoke: `Use the ${name} agent to …`,
    usage: `Claude hands matching work to it by itself, or you ask for it by name (“use the ${name} agent to …”). It works in its own context window with ${tools ? tools.join(', ') : 'all tools'}, then reports back. Manage it with /agents.`,
    plugin: source.plugin,
    tools,
    model: asText(data.model),
    auto: true,
    lines: lineCount(body.trim()),
    tokens: estimateTokens(description ?? ''),
    warning: description ? undefined : 'No description: Claude cannot tell when to hand work to it.',
  });
}

/** A memory file (`CLAUDE.md`): instructions Claude reads at the start of every session. */
export function memoryItem(label: string, text: string, source: ItemSource): AiItem {
  const lines = lineCount(text.trim());
  return defined({
    kind: 'memory' as const,
    scope: source.scope,
    name: label,
    path: source.path,
    usage: 'Claude reads it at the start of every session and follows it like standing instructions. Open it with /memory.',
    lines,
    tokens: estimateTokens(text),
    warning: lines > LONG_MEMORY_LINES ? `${lines} lines are loaded into every session; move rarely needed detail into skills or documents it links to.` : undefined,
  });
}

/* ------------------------------ MCP servers, hooks ------------------------------ */

const baseName = (command: string): string => command.split(/[\\/]/).pop() ?? command;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** `mcpServers` of a `.mcp.json` or `~/.claude.json`: name and transport; arguments, headers and tokens are never kept. */
export function mcpItems(servers: unknown, source: ItemSource): AiItem[] {
  if (!isRecord(servers)) return [];
  return Object.entries(servers).map(([name, config]) => {
    const server = isRecord(config) ? config : {};
    const url = asText(server.url);
    const command = asText(server.command);
    const type = asText(server.type) ?? (url ? 'http' : 'stdio');
    const where = url ? hostOf(url) : command ? baseName(command) : undefined;
    return defined({
      kind: 'mcp' as const,
      scope: source.scope,
      name,
      path: source.path,
      usage: `Claude can call the tools this server offers (they are named mcp__${name}__…). Check it, or sign in, with /mcp.`,
      detail: where ? `${type} · ${where}` : type,
      plugin: source.plugin,
    });
  });
}

const HOOK_EVENTS: Record<string, string> = {
  PreToolUse: 'before Claude uses a tool; it can block the call',
  PostToolUse: 'after a tool finished',
  UserPromptSubmit: 'when you send a prompt',
  Stop: 'when Claude finishes answering',
  SubagentStop: 'when a subagent finishes',
  Notification: 'when Claude needs your attention',
  SessionStart: 'when a session starts or resumes',
  SessionEnd: 'when a session ends',
  PreCompact: 'before the conversation is compacted',
};

/** The `hooks` of a settings file: when each one runs and what it runs (secrets masked). */
export function hookItems(settings: unknown, source: ItemSource): AiItem[] {
  const hooks = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks : {};
  return Object.entries(hooks).flatMap(([event, groups]) =>
    (Array.isArray(groups) ? groups : []).flatMap((group) => {
      if (!isRecord(group)) return [];
      const matcher = asText(group.matcher);
      return (Array.isArray(group.hooks) ? group.hooks : []).flatMap((hook) => {
        if (!isRecord(hook)) return [];
        const command = asText(hook.command) ?? asText(hook.prompt);
        return [
          defined({
            kind: 'hook' as const,
            scope: source.scope,
            name: event,
            description: command && clip(maskSecretsIn(oneLine(command)), MAX_COMMAND),
            path: source.path,
            usage: `Runs automatically ${HOOK_EVENTS[event] ?? `on ${event}`}${matcher ? `, for ${matcher}` : ''}. Edit it with /hooks.`,
            detail: matcher ? `matcher: ${matcher}` : 'every time',
          }),
        ];
      });
    }),
  );
}

/** Allow, deny and ask rules of the settings files together, and the default permission mode (the first file that sets it). */
export function permissionSummary(settings: unknown[]): AiCatalog['permissions'] {
  const rules = (key: string): Set<string> =>
    new Set(settings.flatMap((s) => (isRecord(s) && isRecord(s.permissions) && Array.isArray(s.permissions[key]) ? (s.permissions[key] as unknown[]).map(String) : [])));
  const mode = settings.map((s) => (isRecord(s) && isRecord(s.permissions) ? asText(s.permissions.defaultMode) : undefined)).find(Boolean);
  const summary = { allow: rules('allow').size, deny: rules('deny').size, ask: rules('ask').size, ...(mode ? { mode } : {}) };
  return summary.allow || summary.deny || summary.ask || mode ? summary : undefined;
}

/** The permission rules that deny something, for the checks. */
export function denyRules(settings: unknown[]): string[] {
  return settings.flatMap((s) => (isRecord(s) && isRecord(s.permissions) && Array.isArray(s.permissions.deny) ? (s.permissions.deny as unknown[]).map(String) : []));
}

/* ----------------------------- Plugins and usage ------------------------------ */

export interface PluginManifest {
  name?: string;
  description?: string;
  version?: string;
}

/** An installed plugin (`name@marketplace`); what it contains is listed as items of its own. */
export function pluginItem(key: string, manifest: PluginManifest | undefined, source: ItemSource, counts: { skills: number; commands: number; agents: number }): AiItem {
  const name = manifest?.name ?? key.split('@')[0];
  const parts = [counts.skills && plural(counts.skills, 'skill'), counts.commands && plural(counts.commands, 'command'), counts.agents && plural(counts.agents, 'agent')].filter(Boolean);
  return defined({
    kind: 'plugin' as const,
    scope: source.scope,
    name,
    description: manifest?.description ? clip(oneLine(manifest.description), MAX_DESCRIPTION) : undefined,
    path: source.path,
    usage: `Installed from ${key.split('@')[1] ?? 'a marketplace'}${parts.length ? `; adds ${parts.join(', ')}` : ''}. Manage plugins with /plugin.`,
    detail: manifest?.version,
  });
}

export interface UsageStat {
  usageCount?: number;
  lastUsedAt?: number;
}

/** Adds how often Claude Code recorded using each skill (`~/.claude.json` → `skillUsage`). */
export function attachUsage(items: AiItem[], usage: unknown): AiItem[] {
  if (!isRecord(usage)) return items;
  return items.map((item) => {
    const stat = item.kind === 'skill' ? usage[item.plugin ? `${item.plugin}:${item.name}` : item.name] ?? usage[item.name] : undefined;
    if (!isRecord(stat) || typeof stat.usageCount !== 'number') return item;
    return { ...item, uses: { count: stat.usageCount, last: typeof stat.lastUsedAt === 'number' ? stat.lastUsedAt : 0 } };
  });
}

const duplicateKey = (item: AiItem): string | undefined => (['skill', 'command', 'agent'].includes(item.kind) && !item.plugin ? `${item.kind}:${item.name}` : undefined);

/** Tools defined twice (in the project and in `~/.claude`) conflict: one of them is ignored. Plugin tools are namespaced, so they never do. */
export function markDuplicates(items: AiItem[]): AiItem[] {
  const first = new Map<string, AiItem>();
  for (const item of items) {
    const key = duplicateKey(item);
    if (key && !first.has(key)) first.set(key, item);
  }
  return items.map((item) => {
    const key = duplicateKey(item);
    const original = key ? first.get(key) : undefined;
    if (!original || original === item || item.warning) return item;
    return { ...item, warning: `Also defined in ${original.path}; only one of them is used.` };
  });
}

/** Tokens Claude loads at the start of every session: memory files and the descriptions of skills, commands and agents. */
export function startupTokens(items: AiItem[]): number {
  return items.filter((i) => i.kind === 'memory' || i.kind === 'skill' || i.kind === 'command' || i.kind === 'agent').reduce((sum, i) => sum + (i.tokens ?? 0), 0);
}

/* ---------------------------------- Checks ---------------------------------- */

export interface AiFacts {
  items: AiItem[];
  /** The project's `.mcp.json` registers this tool's server. */
  mcpRegistered: boolean;
  /** The project's Claude settings register this tool's hooks. */
  hooksRegistered: boolean;
  /** The project has dotenv files. */
  hasEnvFiles: boolean;
  /** Deny rules of the project's settings. */
  denyRules: string[];
}

const SETUP_COMMAND = 'code-visualizer agents init --write';

/** Is the project ready for Claude Code to work well in it? Every check says what to do when it fails. */
export function aiChecks(facts: AiFacts): ToolCheck[] {
  const projectMemory = facts.items.filter((i) => i.kind === 'memory' && i.scope === 'project');
  const longest = projectMemory.reduce((max, i) => Math.max(max, i.lines ?? 0), 0);
  const undocumented = facts.items.filter((i) => ['skill', 'command', 'agent'].includes(i.kind) && i.scope === 'project' && !i.description);
  const checks: ToolCheck[] = [
    {
      id: 'memory',
      ok: projectMemory.length > 0,
      label: projectMemory.length ? 'The project has a CLAUDE.md' : 'No CLAUDE.md',
      detail: projectMemory.length ? undefined : 'Claude starts every session knowing nothing about your commands, conventions or layout.',
      fix: projectMemory.length ? undefined : 'Run /init in Claude Code: it reads the project and writes one.',
    },
  ];
  if (projectMemory.length) {
    checks.push({
      id: 'memory-size',
      ok: longest <= LONG_MEMORY_LINES,
      label: longest <= LONG_MEMORY_LINES ? `CLAUDE.md is ${longest} lines` : `CLAUDE.md is ${longest} lines long`,
      detail: longest <= LONG_MEMORY_LINES ? undefined : 'All of it is loaded into every session, and long instructions are followed less closely.',
      fix: longest <= LONG_MEMORY_LINES ? undefined : 'Keep the commands and rules that matter every time; move the rest into skills or documents it links to.',
    });
  }
  checks.push(
    {
      id: 'descriptions',
      ok: undocumented.length === 0,
      label: undocumented.length ? `${plural(undocumented.length, 'skill, command or agent has', 'skills, commands or agents have')} no description` : 'Every skill, command and agent has a description',
      detail: undocumented.length ? `${undocumented.slice(0, 4).map((i) => i.name).join(', ')}. Claude chooses what to use by its description.` : undefined,
      fix: undocumented.length ? 'Add `description:` to the front matter of each.' : undefined,
    },
    {
      id: 'mcp',
      ok: facts.mcpRegistered,
      label: facts.mcpRegistered ? 'code-visualizer is available to Claude as an MCP server' : 'Claude cannot ask code-visualizer about the code yet',
      detail: facts.mcpRegistered ? undefined : 'With it Claude can look up impact, tests to run, owners and architecture rules instead of guessing.',
      fix: facts.mcpRegistered ? undefined : SETUP_COMMAND,
    },
    {
      id: 'hooks',
      ok: facts.hooksRegistered,
      label: facts.hooksRegistered ? 'Guardrail hooks are installed' : 'No guardrail hooks',
      detail: facts.hooksRegistered ? undefined : 'Hooks give Claude a brief at the start and warn it before an edit breaks an architecture rule.',
      fix: facts.hooksRegistered ? undefined : SETUP_COMMAND,
    },
  );
  if (facts.hasEnvFiles) {
    const denied = facts.denyRules.some((rule) => /\.env/.test(rule));
    checks.push({
      id: 'env-deny',
      ok: denied,
      label: denied ? 'Claude is not allowed to read .env files' : '.env files can be read by Claude',
      detail: denied ? undefined : 'Their contents would be sent to the model.',
      fix: denied ? undefined : 'In .claude/settings.json: { "permissions": { "deny": ["Read(./.env)", "Read(./.env.*)"] } }',
    });
  }
  return checks;
}
