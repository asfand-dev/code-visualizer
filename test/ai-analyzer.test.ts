import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeAi } from '../src/analyzer/ai.js';
import { analyze } from '../src/analyzer/index.js';
import type { AiCatalog, AiItem } from '../src/shared/types.js';
import { git, hasGit, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const skill = (name: string, description?: string, extra = ''): string => `---\nname: ${name}\n${description ? `description: ${description}\n` : ''}${extra}---\n\n# ${name}\nSteps.\n`;

function buildProject(): string {
  const root = makeTempDir('cv-ai-project-');
  git(root, ['init', '-q', '-b', 'main']);
  writeFile(root, 'CLAUDE.md', '# Shop\n\nRun `npm test`.\n');
  writeFile(root, 'packages/api/CLAUDE.md', '# API\n');
  writeFile(root, '.claude/skills/pdf/SKILL.md', skill('pdf', 'Fill in PDF forms. Use when asked to complete a form.', 'allowed-tools: Read, Bash(python:*)\n'));
  writeFile(root, '.claude/skills/bare/SKILL.md', '# no front matter\n');
  writeFile(root, '.claude/commands/fix-issue.md', '---\ndescription: Fix an issue\nargument-hint: [number]\n---\nFix $ARGUMENTS.\n');
  writeFile(root, '.claude/commands/frontend/lint.md', '# Lint the front end\nRun the linter.\n');
  writeFile(root, '.claude/agents/reviewer.md', '---\nname: code-reviewer\ndescription: Reviews changes\ntools: Read, Grep\n---\nYou review.\n');
  writeFile(
    root,
    '.claude/settings.json',
    JSON.stringify({
      permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] },
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: `curl -H "Authorization: Bearer ${TOKEN}" https://hooks.test` }] }] },
      enabledPlugins: { 'disabled@market': false },
    }),
  );
  writeFile(root, '.claude/settings.local.json', JSON.stringify({ permissions: { ask: ['Bash(git push:*)'] } }));
  writeFile(root, 'CLAUDE.local.md', 'my notes\n');
  writeFile(root, '.mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-server', `--token=${TOKEN}`], env: { KEY: 'secret-value' } } } }));
  writeFile(root, '.env', 'KEY=1\n');
  writeFile(root, 'AGENTS.md', '# Agents\nBe brief.\n');
  writeFile(root, '.cursor/rules/style.mdc', 'Use tabs.\n');
  writeFile(root, 'node_modules/dep/CLAUDE.md', 'not ours\n');
  writeFile(root, '.gitignore', 'node_modules\n');
  return root;
}

function buildHome(root: string): string {
  const home = makeTempDir('cv-ai-home-');
  writeFile(home, '.claude/CLAUDE.md', '# Mine\n');
  writeFile(home, '.claude/skills/pdf/SKILL.md', skill('pdf', 'My own PDF skill'));
  writeFile(home, '.claude/skills/standup/SKILL.md', skill('standup', 'Write my standup', 'disable-model-invocation: true\n'));
  writeFile(home, '.claude/commands/ship.md', 'Ship it $ARGUMENTS\n');
  writeFile(home, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, permissions: { deny: ['Bash(rm:*)'] } }));
  writeFile(home, '.claude.json', JSON.stringify({
    mcpServers: { github: { type: 'http', url: `https://api.github.test/mcp?token=${TOKEN}`, headers: { Authorization: `Bearer ${TOKEN}` } } },
    projects: { [root]: { mcpServers: { private: { command: '/usr/bin/private-server', args: ['--secret'] } } } },
    skillUsage: { standup: { usageCount: 12, lastUsedAt: 1_700_000_000_000 } },
  }));
  const plugins = path.join(home, '.claude', 'plugins');
  const toolkit = path.join(plugins, 'cache', 'market', 'toolkit', '1.0.0');
  writeFile(toolkit, '.claude-plugin/plugin.json', JSON.stringify({ name: 'toolkit', description: 'Dev toolkit', version: '1.0.0' }));
  writeFile(toolkit, 'skills/review/SKILL.md', skill('review', 'Review a pull request'));
  writeFile(toolkit, 'commands/release.md', 'Cut a release\n');
  const other = path.join(plugins, 'cache', 'market', 'other', '2.0.0');
  writeFile(other, 'skills/secret/SKILL.md', skill('secret', 'Belongs to another project'));
  const disabled = path.join(plugins, 'cache', 'market', 'disabled', '1.0.0');
  writeFile(disabled, 'skills/off/SKILL.md', skill('off', 'Turned off'));
  const elsewhere = makeTempDir('cv-elsewhere-');
  writeFile(elsewhere, 'skills/escape/SKILL.md', skill('escape', 'Outside the plugins folder'));
  writeFile(home, '.claude/plugins/installed_plugins.json', JSON.stringify({
    version: 2,
    plugins: {
      'toolkit@market': [{ scope: 'user', installPath: toolkit, version: '1.0.0' }],
      'other@market': [{ scope: 'project', installPath: other, projectPath: '/somewhere/else' }],
      'disabled@market': [{ scope: 'user', installPath: disabled }],
      'escape@market': [{ scope: 'user', installPath: elsewhere }],
    },
  }));
  return home;
}

const find = (catalog: AiCatalog, kind: AiItem['kind'], name: string): AiItem | undefined => catalog.items.find((i) => i.kind === kind && i.name === name);
const names = (catalog: AiCatalog, kind: AiItem['kind']): string[] => catalog.items.filter((i) => i.kind === kind).map((i) => i.name).sort();

describe.runIf(hasGit)('analyzeAi', () => {
  let restoreGit: () => void;
  let root: string;
  let home: string;
  let personal: AiCatalog;
  let projectOnly: AiCatalog;

  beforeAll(async () => {
    restoreGit = isolateGit();
    root = buildProject();
    home = buildHome(root);
    personal = await analyzeAi(root, { home });
    projectOnly = await analyzeAi(root, { home, personal: false });
  });
  afterAll(() => restoreGit());

  it('lists the memory files of the project, including nested ones, but not those of dependencies', () => {
    expect(names(personal, 'memory')).toEqual(['CLAUDE.local.md', 'CLAUDE.md', 'packages/api/CLAUDE.md', '~/.claude/CLAUDE.md']);
    expect(find(personal, 'memory', 'CLAUDE.local.md')?.scope).toBe('local');
    expect(find(personal, 'memory', 'CLAUDE.md')).toMatchObject({ scope: 'project', lines: 3, path: 'CLAUDE.md' });
  });

  it('lists skills, commands and agents with how to use them', () => {
    expect(find(personal, 'skill', 'pdf')).toMatchObject({ scope: 'project', invoke: '/pdf', tools: ['Read', 'Bash(python:*)'], path: '.claude/skills/pdf/SKILL.md' });
    expect(find(personal, 'skill', 'bare')?.warning).toContain('No description');
    expect(find(personal, 'command', 'fix-issue')).toMatchObject({ invoke: '/fix-issue [number]' });
    expect(find(personal, 'command', 'lint')).toMatchObject({ description: 'Lint the front end', invoke: '/lint' });
    expect(find(personal, 'agent', 'code-reviewer')).toMatchObject({ tools: ['Read', 'Grep'] });
  });

  it('lists MCP servers and hooks without arguments, headers or secrets', () => {
    expect(find(personal, 'mcp', 'docs')).toMatchObject({ scope: 'project', detail: 'stdio · npx' });
    expect(find(personal, 'mcp', 'github')).toMatchObject({ scope: 'user', detail: 'http · api.github.test' });
    expect(find(personal, 'mcp', 'private')).toMatchObject({ scope: 'local', detail: 'stdio · private-server' });
    const hook = personal.items.find((i) => i.kind === 'hook' && i.name === 'PreToolUse');
    expect(hook).toMatchObject({ scope: 'project', detail: 'matcher: Edit' });
    // The hook shows its command, with the token masked.
    expect(hook?.description).toContain('Authorization: Bearer ');
    const text = JSON.stringify(personal);
    for (const secret of [TOKEN, 'secret-value', '--secret', 'headers']) expect(text).not.toContain(secret);
  });

  it('never contains an absolute path', () => {
    const text = JSON.stringify(personal);
    for (const dir of [root, home, fs.realpathSync(root), fs.realpathSync(home)]) expect(text).not.toContain(dir);
    for (const item of personal.items) expect(item.path.startsWith('/')).toBe(false);
  });

  it('includes what ~/.claude and installed plugins add, and marks a duplicate', () => {
    expect(find(personal, 'skill', 'standup')).toMatchObject({ scope: 'user', auto: false, uses: { count: 12, last: 1_700_000_000_000 }, path: '~/.claude/skills/standup/SKILL.md' });
    expect(find(personal, 'command', 'ship')).toMatchObject({ scope: 'user' });
    expect(personal.items.find((i) => i.kind === 'hook' && i.name === 'Stop')).toMatchObject({ scope: 'user', description: 'say done' });
    const duplicate = personal.items.find((i) => i.kind === 'skill' && i.name === 'pdf' && i.scope === 'user');
    expect(duplicate?.warning).toBe('Also defined in .claude/skills/pdf/SKILL.md; only one of them is used.');
  });

  it('adds plugins with the tools they bring, namespaced, and skips the ones that do not apply', () => {
    expect(find(personal, 'plugin', 'toolkit')).toMatchObject({ description: 'Dev toolkit', detail: '1.0.0', usage: expect.stringContaining('1 skill, 1 command') });
    expect(find(personal, 'skill', 'review')).toMatchObject({ scope: 'plugin', plugin: 'toolkit', invoke: '/toolkit:review' });
    expect(find(personal, 'command', 'release')).toMatchObject({ invoke: '/toolkit:release' });
    // Another project's plugin, a disabled one and one outside the plugins folder.
    expect(names(personal, 'plugin')).toEqual(['toolkit']);
    for (const hidden of ['secret', 'off', 'escape']) expect(find(personal, 'skill', hidden)).toBeUndefined();
  });

  it('reads nothing outside the project with personal: false', () => {
    expect(projectOnly.personal).toBe(false);
    expect(projectOnly.items.filter((i) => i.scope === 'user' || i.scope === 'plugin')).toEqual([]);
    expect(find(projectOnly, 'mcp', 'private')).toBeUndefined();
    expect(find(projectOnly, 'skill', 'pdf')?.warning).toBeUndefined();
    expect(find(projectOnly, 'skill', 'pdf')?.uses).toBeUndefined();
    expect(projectOnly.startupTokens).toBeLessThan(personal.startupTokens);
  });

  it('counts the permission rules of the project, not of ~/.claude', () => {
    expect(personal.permissions).toEqual({ allow: 1, deny: 1, ask: 1 });
  });

  it('lists the instructions written for other assistants', () => {
    expect(personal.instructions.map((i) => [i.tool, i.path]).sort()).toEqual([
      ['Codex and other agents', 'AGENTS.md'],
      ['Cursor', '.cursor/rules/style.mdc'],
    ]);
    expect(personal.instructions[0]).toMatchObject({ lines: expect.any(Number), tokens: expect.any(Number) });
  });

  it('checks whether the project is ready for Claude Code', () => {
    const failing = personal.checks.filter((c) => !c.ok).map((c) => c.id);
    // CLAUDE.md exists and .env is denied; the skill without description, the unregistered MCP server and hooks fail.
    expect(failing).toEqual(['descriptions', 'mcp', 'hooks']);
    expect(personal.checks.find((c) => c.id === 'env-deny')?.ok).toBe(true);
  });

  it('adds the tokens Claude loads at the start', () => {
    expect(personal.startupTokens).toBeGreaterThan(0);
  });

  it('recognises code-visualizer when it is set up', async () => {
    writeFile(root, '.mcp.json', JSON.stringify({ mcpServers: { 'code-visualizer': { command: 'npx', args: ['code-visualizer', 'mcp'] } } }));
    writeFile(root, '.claude/settings.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx code-visualizer hook session-start' }] }] } }));
    const catalog = await analyzeAi(root, { home, personal: false });
    expect(catalog.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['descriptions', 'env-deny']);
  });
});

describe.runIf(hasGit)('analyzeAi in a bare project', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  it('has no tools and says what to do first', async () => {
    const root = makeTempDir('cv-ai-bare-');
    git(root, ['init', '-q', '-b', 'main']);
    const catalog = await analyzeAi(root, { home: makeTempDir('cv-ai-nohome-') });
    expect(catalog.items).toEqual([]);
    expect(catalog.permissions).toBeUndefined();
    expect(catalog.checks.find((c) => c.id === 'memory')).toMatchObject({ ok: false, fix: expect.stringContaining('/init') });
    expect(catalog.checks.map((c) => c.id)).not.toContain('env-deny');
  });

  it('copes with broken files', async () => {
    const root = makeTempDir('cv-ai-broken-');
    writeFile(root, '.claude/settings.json', '{ not json');
    writeFile(root, '.mcp.json', '[1, 2]');
    writeFile(root, '.claude/skills/x/SKILL.md', '---\n: : :\n---\n');
    writeFile(root, '.claude/commands/big.md', 'x'.repeat(300 * 1024));
    const catalog = await analyzeAi(root, { home: makeTempDir('cv-ai-nohome-') });
    expect(names(catalog, 'skill')).toEqual(['x']);
    expect(names(catalog, 'command')).toEqual([]);
    expect(names(catalog, 'mcp')).toEqual([]);
  });

  it('reads symlinked skills', async () => {
    const root = makeTempDir('cv-ai-link-');
    const shared = makeTempDir('cv-ai-shared-');
    writeFile(shared, 'linked/SKILL.md', skill('linked', 'A linked skill'));
    fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(path.join(shared, 'linked'), path.join(root, '.claude', 'skills', 'linked'), 'dir');
    expect(names(await analyzeAi(root, { home: makeTempDir('cv-ai-nohome-') }), 'skill')).toEqual(['linked']);
  });
});

describe.runIf(hasGit)('analyze with the ai option', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  it('adds the catalog only when asked for, and honours personal: false', async () => {
    const root = buildProject();
    const home = buildHome(root);
    writeFile(root, 'src/index.ts', 'export const a = 1;\n');
    const options = { root, persist: false, history: false } as const;
    expect((await analyze(options)).ai).toBeUndefined();
    const withPersonal = await analyze({ ...options, ai: { home } });
    expect(withPersonal.ai?.personal).toBe(true);
    expect(names(withPersonal.ai!, 'skill')).toContain('standup');
    const projectOnly = await analyze({ ...options, ai: { home, personal: false } });
    expect(names(projectOnly.ai!, 'skill')).not.toContain('standup');
    expect(withPersonal.warnings).toEqual([]);
  });
});
