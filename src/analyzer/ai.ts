/**
 * Finds the Claude Code tools of a project: CLAUDE.md, skills, slash commands, subagents, MCP servers, hooks and
 * permissions, and (unless `personal` is off) the ones in `~/.claude` and installed plugins. What is kept is names,
 * descriptions and where each lives, never absolute paths, arguments, headers or secrets (see src/shared/ai.ts).
 * Reading only: nothing is created or changed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedHooks, mcpConfigFile, parseJsonc } from '../agent/setup.js';
import {
  agentItem,
  aiChecks,
  attachUsage,
  commandItem,
  denyRules,
  estimateTokens,
  hookItems,
  markDuplicates,
  mcpItems,
  memoryItem,
  permissionSummary,
  pluginItem,
  skillItem,
  startupTokens,
} from '../shared/ai.js';
import { isEnvTemplateName } from '../shared/env.js';
import type { AiCatalog, AiInstructionFile, AiItem, AiScope } from '../shared/types.js';
import { isRecord } from '../shared/yaml.js';
import { isEnvFileName } from './env.js';
import { git } from './git.js';
import { toPosix } from './project.js';

/** A file larger than this is not a Markdown or JSON file of a tool. */
const MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 400;
/** Folder levels searched below `commands/` and `agents/`. */
const MAX_DEPTH = 3;
const MAX_NESTED_MEMORY = 20;

export interface AiOptions {
  /** Include `~/.claude` and installed plugins (default). `false` reads nothing outside the project. */
  personal?: boolean;
  /** Home folder to read instead of the user's own (tests). */
  home?: string;
}

/** Instruction files written for other assistants. */
const OTHER_INSTRUCTIONS: [file: string, tool: string][] = [
  ['AGENTS.md', 'Codex and other agents'],
  ['GEMINI.md', 'Gemini'],
  ['.github/copilot-instructions.md', 'GitHub Copilot'],
  ['.cursorrules', 'Cursor'],
  ['.windsurfrules', 'Windsurf'],
  ['.clinerules', 'Cline'],
];

function readText(file: string): string | undefined {
  try {
    return fs.statSync(file).size <= MAX_BYTES ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  const text = readText(file);
  return text === undefined ? undefined : parseJsonc(file, text).value;
}

/** Child folders (a symlink to a folder counts: skills are often linked in). */
function childDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => fs.statSync(path.join(dir, name)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

interface MarkdownFile {
  file: string;
  /** The file name without `.md`. */
  name: string;
  /** The folder below the starting one that groups it. */
  folder?: string;
}

function markdownFiles(dir: string, folder = '', depth = 0): MarkdownFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name): MarkdownFile[] => {
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    if (stat.isDirectory()) return depth < MAX_DEPTH ? markdownFiles(file, folder ? `${folder}/${name}` : name, depth + 1) : [];
    return stat.isFile() && name.endsWith('.md') ? [{ file, name: name.slice(0, -'.md'.length), ...(folder ? { folder } : {}) }] : [];
  });
}

type Display = (absolute: string) => string;

/** The skills, commands and agents under a folder (`.claude/`, `~/.claude/`, or a plugin's root). */
function readComponents(base: string, scope: AiScope, display: Display, plugin?: string): AiItem[] {
  const skills = childDirs(path.join(base, 'skills')).flatMap((folder) => {
    const file = path.join(base, 'skills', folder, 'SKILL.md');
    const text = readText(file);
    return text === undefined ? [] : [skillItem(folder, text, { scope, plugin, path: display(file) })];
  });
  const readAll = (kind: 'commands' | 'agents', make: (f: MarkdownFile, text: string) => AiItem): AiItem[] =>
    markdownFiles(path.join(base, kind)).flatMap((f) => {
      const text = readText(f.file);
      return text === undefined ? [] : [make(f, text)];
    });
  return [
    ...skills,
    ...readAll('commands', (f, text) => commandItem(f.name, f.folder, text, { scope, plugin, path: display(f.file) })),
    ...readAll('agents', (f, text) => agentItem(f.name, text, { scope, plugin, path: display(f.file) })),
  ];
}

interface SettingsFile {
  doc: Record<string, unknown>;
  scope: AiScope;
  path: string;
}

function readSettings(file: string, scope: AiScope, display: Display): SettingsFile[] {
  const doc = readJson(file);
  return doc ? [{ doc, scope, path: display(file) }] : [];
}

function memoryOf(file: string, label: string, scope: AiScope, display: Display): AiItem[] {
  const text = readText(file);
  return text === undefined ? [] : [memoryItem(label, text, { scope, path: display(file) })];
}

/** `CLAUDE.md` files in subfolders: Claude reads them when it works there. */
async function nestedMemory(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*CLAUDE.md']);
  return (out ?? '')
    .split('\0')
    .filter((rel) => rel.includes('/') && path.posix.basename(rel) === 'CLAUDE.md')
    .slice(0, MAX_NESTED_MEMORY);
}

function childFiles(dir: string, extensions: string[]): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => extensions.some((extension) => name.endsWith(extension)))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Instructions for other assistants (Codex, Gemini, Copilot, Cursor…): how much of the context window each takes. */
function otherInstructions(root: string): AiInstructionFile[] {
  const files: [file: string, tool: string][] = [
    ...OTHER_INSTRUCTIONS.map(([rel, tool]): [string, string] => [path.join(root, rel), tool]),
    ...childFiles(path.join(root, '.cursor', 'rules'), ['.md', '.mdc']).map((file): [string, string] => [file, 'Cursor']),
  ];
  return files.flatMap(([file, tool]) => {
    const text = readText(file);
    return text === undefined ? [] : [{ tool, path: toPosix(path.relative(root, file)), lines: text.split('\n').length, tokens: estimateTokens(text) }];
  });
}

function hasEnvFiles(root: string): boolean {
  try {
    return fs.readdirSync(root).some((name) => isEnvFileName(name) && !isEnvTemplateName(name));
  } catch {
    return false;
  }
}

interface UserFolders {
  /** `~/.claude` (or `$CLAUDE_CONFIG_DIR`). */
  configDir: string;
  /** `~/.claude.json`. */
  stateFile: string;
}

function userFolders(options: AiOptions): UserFolders {
  const home = options.home ?? os.homedir();
  const configured = options.home ? undefined : process.env.CLAUDE_CONFIG_DIR;
  const configDir = configured ?? path.join(home, '.claude');
  return { configDir, stateFile: configured ? path.join(configured, '.claude.json') : path.join(home, '.claude.json') };
}

/** Installed plugins and what they add; project-scoped ones only when they were installed for this project. */
function readPlugins(configDir: string, root: string, enabled: Map<string, boolean>, display: Display): AiItem[] {
  const installed = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  const plugins = isRecord(installed?.plugins) ? installed.plugins : {};
  const pluginsDir = path.join(configDir, 'plugins');
  return Object.entries(plugins).flatMap(([key, value]) => {
    if (enabled.get(key) === false) return [];
    const installs = (Array.isArray(value) ? value : [value]).filter(isRecord);
    const install = installs.find((i) => (i.scope === undefined || i.scope === 'user' ? true : typeof i.projectPath === 'string' && path.resolve(i.projectPath) === path.resolve(root)));
    const installPath = typeof install?.installPath === 'string' ? path.resolve(install.installPath) : undefined;
    // What a plugin lists is read only from inside the plugins folder.
    if (!installPath || path.relative(pluginsDir, installPath).startsWith('..')) return [];
    const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'));
    const name = typeof manifest?.name === 'string' ? manifest.name : key.split('@')[0];
    const components = readComponents(installPath, 'plugin', display, name);
    const count = (kind: AiItem['kind']): number => components.filter((c) => c.kind === kind).length;
    const meta = { name: name, description: typeof manifest?.description === 'string' ? manifest.description : undefined, version: typeof manifest?.version === 'string' ? manifest.version : undefined };
    return [pluginItem(key, meta, { scope: 'plugin', path: display(installPath) }, { skills: count('skill'), commands: count('command'), agents: count('agent') }), ...components];
  });
}

/** What `~/.claude.json` keeps for this project (keyed by its path, as typed or resolved through symlinks). */
function projectEntry(state: Record<string, unknown> | undefined, root: string): Record<string, unknown> | undefined {
  if (!isRecord(state?.projects)) return undefined;
  const real = ((): string => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  })();
  return [root, real].map((key) => (state.projects as Record<string, unknown>)[key]).find(isRecord);
}

/** Which plugins the settings turn off (`enabledPlugins`), later files overriding earlier ones. */
function enabledPlugins(settings: SettingsFile[]): Map<string, boolean> {
  const enabled = new Map<string, boolean>();
  for (const { doc } of settings) {
    if (!isRecord(doc.enabledPlugins)) continue;
    for (const [key, value] of Object.entries(doc.enabledPlugins)) if (typeof value === 'boolean') enabled.set(key, value);
  }
  return enabled;
}

export async function analyzeAi(root: string, options: AiOptions = {}): Promise<AiCatalog> {
  const personal = options.personal !== false;
  const { configDir, stateFile } = userFolders(options);
  const display: Display = (absolute) => {
    const fromRoot = path.relative(root, absolute);
    if (!fromRoot.startsWith('..') && !path.isAbsolute(fromRoot)) return toPosix(fromRoot);
    const fromConfig = path.relative(configDir, absolute);
    return !fromConfig.startsWith('..') && !path.isAbsolute(fromConfig) ? `~/.claude/${toPosix(fromConfig)}` : path.basename(absolute);
  };

  const projectSettings = [...readSettings(path.join(root, '.claude', 'settings.json'), 'project', display), ...readSettings(path.join(root, '.claude', 'settings.local.json'), 'local', display)];
  const userSettings = personal ? readSettings(path.join(configDir, 'settings.json'), 'user', display) : [];
  const state = personal ? readJson(stateFile) : undefined;
  const projectState = projectEntry(state, root);

  const nested = await nestedMemory(root);
  const items: AiItem[] = [
    ...memoryOf(path.join(root, 'CLAUDE.md'), 'CLAUDE.md', 'project', display),
    ...memoryOf(path.join(root, '.claude', 'CLAUDE.md'), '.claude/CLAUDE.md', 'project', display),
    ...nested.flatMap((rel) => memoryOf(path.join(root, rel), rel, 'project', display)),
    ...memoryOf(path.join(root, 'CLAUDE.local.md'), 'CLAUDE.local.md', 'local', display),
    ...readComponents(path.join(root, '.claude'), 'project', display),
    ...mcpItems(readJson(path.join(root, '.mcp.json'))?.mcpServers, { scope: 'project', path: '.mcp.json' }),
    ...[...projectSettings, ...userSettings].flatMap((s) => hookItems(s.doc, { scope: s.scope, path: s.path })),
  ];
  if (personal) {
    items.push(
      ...memoryOf(path.join(configDir, 'CLAUDE.md'), '~/.claude/CLAUDE.md', 'user', display),
      ...readComponents(configDir, 'user', display),
      ...mcpItems(state?.mcpServers, { scope: 'user', path: '~/.claude.json' }),
      ...mcpItems(projectState?.mcpServers, { scope: 'local', path: '~/.claude.json' }),
      ...readPlugins(configDir, root, enabledPlugins([...userSettings, ...projectSettings]), display),
    );
  }

  const settingsDocs = projectSettings.map((s) => s.doc);
  const catalogItems = markDuplicates(attachUsage(items, state?.skillUsage)).slice(0, MAX_ITEMS);
  return {
    items: catalogItems,
    instructions: otherInstructions(root),
    permissions: permissionSummary(settingsDocs),
    checks: aiChecks({
      items: catalogItems,
      mcpRegistered: mcpConfigFile(root, 'claude') !== undefined,
      hooksRegistered: installedHooks(root, 'claude').length > 0,
      hasEnvFiles: hasEnvFiles(root),
      denyRules: denyRules(settingsDocs),
    }),
    personal,
    startupTokens: startupTokens(catalogItems),
  };
}
