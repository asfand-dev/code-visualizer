import { describe, expect, it } from 'vitest';
import { CLAUDE_GUIDE, CODE_VISUALIZER_TOOLS, guideTemplates, projectCommands } from '../src/shared/ai-guide.js';
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
  parseFrontMatter,
  permissionSummary,
  pluginItem,
  skillItem,
  startupTokens,
  type AiFacts,
} from '../src/shared/ai.js';
import type { AiItem } from '../src/shared/types.js';
import { parseYaml } from '../src/shared/yaml.js';

const project = { scope: 'project' as const, path: '.claude/x' };

describe('parseFrontMatter', () => {
  it('reads the YAML block and returns the body', () => {
    const { data, body } = parseFrontMatter('---\nname: review\ndescription: Reviews code\nallowed-tools:\n  - Read\n  - Grep\n---\n# Body\ntext');
    expect(data).toEqual({ name: 'review', description: 'Reviews code', 'allowed-tools': ['Read', 'Grep'] });
    expect(body).toBe('# Body\ntext');
  });

  it('handles a file without front matter, a BOM and Windows line endings', () => {
    expect(parseFrontMatter('# Just text')).toEqual({ data: {}, body: '# Just text' });
    expect(parseFrontMatter('\uFEFF---\r\nname: a\r\n---\r\nbody').data).toEqual({ name: 'a' });
    expect(parseFrontMatter('---\nname: a\n---').body).toBe('');
  });

  it('reads folded and quoted descriptions', () => {
    expect(parseFrontMatter('---\ndescription: >\n  one\n  two\n---\n').data.description).toBe('one two\n');
    expect(parseFrontMatter('---\ndescription: "Use when: a"\n---\n').data.description).toBe('Use when: a');
  });

  it('keeps going when the front matter is not valid YAML', () => {
    // A description that wraps onto a line with "word:" in it, as real skills do.
    const wrapped = 'name: deploy\ndescription: Use when asked to ship\n  Note: needs approval\nmodel: "haiku"';
    expect(parseYaml(wrapped).error).toBeDefined();
    expect(parseFrontMatter(`---\n${wrapped}\n---\nbody`).data).toEqual({ name: 'deploy', description: 'Use when asked to ship Note: needs approval', model: 'haiku' });
    expect(parseFrontMatter('---\ndescription: "Unterminated\nname: a\n---\n').data).toEqual({ description: '"Unterminated', name: 'a' });
  });

  it('keeps a description that has a colon in it', () => {
    expect(parseFrontMatter('---\ndescription: Use when X: do Y\n---\n').data.description).toBe('Use when X: do Y');
  });

  it('does not take a horizontal rule in the middle of the text for front matter', () => {
    expect(parseFrontMatter('intro\n---\nname: a\n---\n').data).toEqual({});
  });
});

describe('skillItem', () => {
  it('describes a skill Claude uses by itself, and how to call it', () => {
    const item = skillItem('pdf', '---\ndescription: Fill PDF forms\n---\nSteps\n1\n2', { ...project, path: '.claude/skills/pdf/SKILL.md' });
    expect(item).toMatchObject({ kind: 'skill', name: 'pdf', description: 'Fill PDF forms', invoke: '/pdf', auto: true, lines: 3 });
    expect(item.usage).toContain('by itself');
    expect(item.usage).toContain('/pdf');
    expect(item.warning).toBeUndefined();
  });

  it('uses the name in the front matter over the folder, and shows the argument hint', () => {
    const item = skillItem('folder', '---\nname: fix-issue\ndescription: d\nargument-hint: "[number]"\nallowed-tools: Read, Bash(git add:*), Bash(git commit:*)\nmodel: sonnet\n---\n', project);
    expect(item).toMatchObject({ name: 'fix-issue', invoke: '/fix-issue [number]', model: 'sonnet', tools: ['Read', 'Bash(git add:*)', 'Bash(git commit:*)'] });
  });

  it('handles skills only you can start and background skills', () => {
    const manual = skillItem('deploy', '---\ndescription: Deploy\ndisable-model-invocation: true\n---\n', project);
    expect(manual).toMatchObject({ auto: false, invoke: '/deploy' });
    expect(manual.usage).toContain('never starts it on its own');
    const background = skillItem('style', '---\ndescription: House style\nuser-invocable: false\n---\n', project);
    expect(background.invoke).toBeUndefined();
    expect(background.usage).toContain('not a slash command');
  });

  it('warns about a missing or very long description', () => {
    expect(skillItem('a', '# no front matter', project).warning).toContain('No description');
    expect(skillItem('a', `---\ndescription: ${'x'.repeat(1100)}\n---\n`, project).warning).toContain('very long');
  });

  it('counts only the description toward the startup cost, and shortens it for display', () => {
    const item = skillItem('a', `---\ndescription: ${'word '.repeat(100).trim()}\n---\n${'body '.repeat(1000)}`, project);
    expect(item.tokens).toBe(estimateTokens('word '.repeat(100).trim()));
    expect(skillItem('a', `---\ndescription: ${'x'.repeat(400)}\n---\n`, project).description).toHaveLength(300);
  });

  it('prefixes plugin skills with the plugin name', () => {
    expect(skillItem('review', '---\ndescription: d\n---\n', { scope: 'plugin', plugin: 'toolkit', path: '~/.claude/plugins/x' })).toMatchObject({ invoke: '/toolkit:review', plugin: 'toolkit' });
  });
});

describe('commandItem', () => {
  it('takes the description from the front matter, or from the first line', () => {
    expect(commandItem('test', undefined, '---\ndescription: Run tests\n---\nGo', project).description).toBe('Run tests');
    expect(commandItem('test', undefined, '# Run the tests\n\nGo', project).description).toBe('Run the tests');
    expect(commandItem('test', undefined, '', project).warning).toContain('No description');
  });

  it('tells whether it takes arguments', () => {
    const withArgs = commandItem('fix', undefined, 'Fix $ARGUMENTS', project);
    expect(withArgs.usage).toContain('followed by what it should work on');
    // `[issue]` is a YAML list for a parser, and `[issue] [priority]` is not YAML at all.
    expect(commandItem('fix', undefined, '---\nargument-hint: [issue]\n---\nx', project)).toMatchObject({ invoke: '/fix [issue]' });
    expect(commandItem('fix', undefined, '---\nargument-hint: [a, b]\n---\nx', project)).toMatchObject({ invoke: '/fix [a, b]' });
    expect(commandItem('fix', undefined, '---\nargument-hint: [issue] [priority]\n---\nx', project)).toMatchObject({ invoke: '/fix [issue] [priority]' });
    expect(skillItem('fix', '---\ndescription: d\nargument-hint: [issue]\n---\n', project).invoke).toBe('/fix [issue]');
    expect(commandItem('status', undefined, 'Show git status', project).usage).toBe('Type /status in Claude Code.');
  });

  it('names the folder as a group, not as part of the command', () => {
    const item = commandItem('lint', 'frontend', 'Lint', project);
    expect(item.invoke).toBe('/lint');
    expect(item.usage).toContain('Grouped under frontend/');
  });

  it('namespaces plugin commands', () => {
    expect(commandItem('lint', undefined, 'Lint', { scope: 'plugin', plugin: 'kit', path: 'p' }).invoke).toBe('/kit:lint');
  });
});

describe('agentItem', () => {
  it('lists its tools, or all tools', () => {
    const limited = agentItem('reviewer', '---\nname: code-reviewer\ndescription: Reviews\ntools: Read, Grep\nmodel: haiku\n---\nbody', project);
    expect(limited).toMatchObject({ name: 'code-reviewer', tools: ['Read', 'Grep'], model: 'haiku', auto: true });
    expect(limited.usage).toContain('use the code-reviewer agent');
    expect(limited.usage).toContain('Read, Grep');
    expect(agentItem('x', '---\ndescription: d\n---\n', project).usage).toContain('all tools');
  });

  it('falls back to the file name and warns without a description', () => {
    const item = agentItem('planner', 'You plan.', project);
    expect(item.name).toBe('planner');
    expect(item.warning).toContain('No description');
  });
});

describe('memoryItem', () => {
  it('counts lines and tokens', () => {
    expect(memoryItem('CLAUDE.md', 'a\nb\nc\n', project)).toMatchObject({ kind: 'memory', name: 'CLAUDE.md', lines: 3, tokens: 2 });
    expect(memoryItem('CLAUDE.md', '', project)).toMatchObject({ lines: 0, tokens: 0 });
  });

  it('warns about a long file', () => {
    expect(memoryItem('CLAUDE.md', 'x\n'.repeat(400), project).warning).toContain('400 lines');
    expect(memoryItem('CLAUDE.md', 'x\n'.repeat(100), project).warning).toBeUndefined();
  });
});

describe('mcpItems', () => {
  it('shows the transport and the program or host, never arguments, headers or environment', () => {
    const items = mcpItems(
      {
        files: { command: '/usr/local/bin/npx', args: ['-y', 'server', '--token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz'], env: { API_KEY: 'secret-value' } },
        api: { type: 'http', url: 'https://user:pass@api.example.com/mcp?key=abc123', headers: { Authorization: 'Bearer abc' } },
        stream: { type: 'sse', url: 'not a url' },
      },
      project,
    );
    expect(items.map((i) => [i.name, i.detail])).toEqual([
      ['files', 'stdio · npx'],
      ['api', 'http · api.example.com'],
      ['stream', 'sse'],
    ]);
    const text = JSON.stringify(items);
    for (const secret of ['sk-ant', 'secret-value', 'abc123', 'pass', 'Bearer']) expect(text).not.toContain(secret);
    expect(items[0].usage).toContain('mcp__files__');
  });

  it('copes with anything that is not a server map', () => {
    expect(mcpItems(undefined, project)).toEqual([]);
    expect(mcpItems([], project)).toEqual([]);
    expect(mcpItems({ broken: 'text' }, project)).toEqual([expect.objectContaining({ name: 'broken', detail: 'stdio' })]);
  });
});

describe('hookItems', () => {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'code-visualizer hook pre-edit' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://x.test' }] }],
      Custom: [{ hooks: [{ type: 'command', command: 'echo' }] }],
    },
  };

  it('says when each hook runs and what it runs', () => {
    const items = hookItems(settings, project);
    expect(items[0]).toMatchObject({ kind: 'hook', name: 'PreToolUse', description: 'code-visualizer hook pre-edit', detail: 'matcher: Edit|Write' });
    expect(items[0].usage).toContain('before Claude uses a tool');
    expect(items[0].usage).toContain('Edit|Write');
    expect(items[1].detail).toBe('every time');
    expect(items[2].usage).toContain('on Custom');
  });

  it('masks secrets in commands', () => {
    const stop = hookItems(settings, project)[1];
    expect(stop.description).not.toContain('ghp_abcdefghij');
  });

  it('clips very long commands', () => {
    const long = hookItems({ hooks: { Stop: [{ hooks: [{ command: `echo ${'x'.repeat(500)}` }] }] } }, project)[0];
    expect(long.description).toHaveLength(200);
  });

  it('copes with malformed settings', () => {
    expect(hookItems(undefined, project)).toEqual([]);
    expect(hookItems({ hooks: 'x' }, project)).toEqual([]);
    expect(hookItems({ hooks: { Stop: [null, 'x', { hooks: [null, 3] }] } }, project)).toEqual([]);
  });
});

describe('permissions', () => {
  it('merges the rules of several settings files', () => {
    const shared = { permissions: { allow: ['Bash(npm test)', 'Read'], deny: ['Read(./.env)'], defaultMode: 'acceptEdits' } };
    const local = { permissions: { allow: ['Read', 'Edit'], ask: ['Bash(git push:*)'], defaultMode: 'plan' } };
    expect(permissionSummary([shared, local])).toEqual({ allow: 3, deny: 1, ask: 1, mode: 'acceptEdits' });
    expect(denyRules([shared, local])).toEqual(['Read(./.env)']);
  });

  it('has nothing to say without permissions', () => {
    expect(permissionSummary([{}, undefined, 'x'])).toBeUndefined();
    expect(permissionSummary([])).toBeUndefined();
    expect(denyRules([{ permissions: { deny: 'x' } }])).toEqual([]);
  });
});

describe('pluginItem', () => {
  it('describes what a plugin adds', () => {
    const item = pluginItem('toolkit@acme-market', { name: 'toolkit', description: 'Dev tools', version: '1.2.0' }, { scope: 'plugin', path: '~/.claude/plugins/x' }, { skills: 2, commands: 1, agents: 0 });
    expect(item).toMatchObject({ kind: 'plugin', name: 'toolkit', description: 'Dev tools', detail: '1.2.0' });
    expect(item.usage).toBe('Installed from acme-market; adds 2 skills, 1 command. Manage plugins with /plugin.');
  });

  it('works without a manifest', () => {
    expect(pluginItem('toolkit', undefined, { scope: 'plugin', path: 'p' }, { skills: 0, commands: 0, agents: 0 })).toMatchObject({ name: 'toolkit', usage: 'Installed from a marketplace. Manage plugins with /plugin.' });
  });
});

describe('attachUsage', () => {
  const skill = (name: string, plugin?: string): AiItem => skillItem(name, '---\ndescription: d\n---\n', { scope: plugin ? 'plugin' : 'user', plugin, path: 'p' });

  it('adds how often a skill was used', () => {
    const [a, b] = attachUsage([skill('a'), skill('b')], { a: { usageCount: 7, lastUsedAt: 1000 } });
    expect(a.uses).toEqual({ count: 7, last: 1000 });
    expect(b.uses).toBeUndefined();
  });

  it('matches plugin skills by their namespaced name', () => {
    expect(attachUsage([skill('review', 'kit')], { 'kit:review': { usageCount: 2, lastUsedAt: 5 } })[0].uses).toEqual({ count: 2, last: 5 });
  });

  it('ignores commands, malformed entries and missing data', () => {
    const command = commandItem('a', undefined, 'x', project);
    expect(attachUsage([command], { a: { usageCount: 1 } })[0].uses).toBeUndefined();
    expect(attachUsage([skill('a')], { a: 'x' })[0].uses).toBeUndefined();
    expect(attachUsage([skill('a')], undefined)[0].uses).toBeUndefined();
    expect(attachUsage([skill('a')], { a: { usageCount: 3 } })[0].uses).toEqual({ count: 3, last: 0 });
  });
});

describe('markDuplicates', () => {
  it('warns about the later definition of a tool, pointing to the first', () => {
    const mine = skillItem('lint', '---\ndescription: d\n---\n', { scope: 'project', path: '.claude/skills/lint/SKILL.md' });
    const theirs = skillItem('lint', '---\ndescription: d\n---\n', { scope: 'user', path: '~/.claude/skills/lint/SKILL.md' });
    const [first, second] = markDuplicates([mine, theirs]);
    expect(first.warning).toBeUndefined();
    expect(second.warning).toBe('Also defined in .claude/skills/lint/SKILL.md; only one of them is used.');
  });

  it('keeps a warning that is already there and leaves plugin tools and other kinds alone', () => {
    const plain = skillItem('lint', '---\ndescription: d\n---\n', project);
    const undocumented = skillItem('lint', 'x', { scope: 'user', path: 'u' });
    const plugin = skillItem('lint', '---\ndescription: d\n---\n', { scope: 'plugin', plugin: 'kit', path: 'k' });
    const command = commandItem('lint', undefined, 'Lint', project);
    const out = markDuplicates([plain, undocumented, plugin, command]);
    expect(out[1].warning).toContain('No description');
    expect(out[2].warning).toBeUndefined();
    expect(out[3].warning).toBeUndefined();
  });
});

describe('startupTokens', () => {
  it('adds memory files and the descriptions Claude loads, not hooks or servers', () => {
    const items: AiItem[] = [
      memoryItem('CLAUDE.md', 'x'.repeat(400), project),
      skillItem('a', `---\ndescription: ${'y'.repeat(40)}\n---\nlong body ${'z'.repeat(4000)}`, project),
      ...mcpItems({ s: { command: 'x' } }, project),
    ];
    expect(startupTokens(items)).toBe(100 + 10);
    expect(startupTokens([])).toBe(0);
  });
});

describe('aiChecks', () => {
  const facts = (extra: Partial<AiFacts> = {}): AiFacts => ({
    items: [memoryItem('CLAUDE.md', 'short', project)],
    mcpRegistered: true,
    hooksRegistered: true,
    hasEnvFiles: false,
    denyRules: [],
    ...extra,
  });
  const failing = (extra: Partial<AiFacts>): string[] => aiChecks(facts(extra)).filter((c) => !c.ok).map((c) => c.id);

  it('passes for a project that is set up', () => {
    expect(failing({})).toEqual([]);
  });

  it('asks for a CLAUDE.md, with the fix', () => {
    expect(failing({ items: [] })).toEqual(['memory']);
    expect(aiChecks(facts({ items: [] }))[0].fix).toContain('/init');
    // A user-level memory file is not the project's.
    expect(failing({ items: [memoryItem('~/.claude/CLAUDE.md', 'x', { scope: 'user', path: '~/.claude/CLAUDE.md' })] })).toEqual(['memory']);
  });

  it('flags a long CLAUDE.md', () => {
    expect(failing({ items: [memoryItem('CLAUDE.md', 'x\n'.repeat(400), project)] })).toEqual(['memory-size']);
  });

  it('flags project tools without a description but not tools from elsewhere', () => {
    const bare = skillItem('bare', 'x', project);
    expect(failing({ items: [...facts().items, bare] })).toEqual(['descriptions']);
    expect(aiChecks(facts({ items: [...facts().items, bare] })).find((c) => c.id === 'descriptions')?.label).toBe('1 skill, command or agent has no description');
    expect(aiChecks(facts({ items: [...facts().items, bare, commandItem('c', undefined, '', project)] })).find((c) => c.id === 'descriptions')?.label).toBe('2 skills, commands or agents have no description');
    expect(failing({ items: [...facts().items, skillItem('bare', 'x', { scope: 'user', path: 'u' })] })).toEqual([]);
    expect(aiChecks(facts({ items: [...facts().items, bare] })).find((c) => c.id === 'descriptions')?.detail).toContain('bare');
  });

  it('suggests registering code-visualizer for MCP and hooks', () => {
    expect(failing({ mcpRegistered: false, hooksRegistered: false })).toEqual(['mcp', 'hooks']);
    expect(aiChecks(facts({ mcpRegistered: false })).find((c) => c.id === 'mcp')?.fix).toBe('code-visualizer agents init --write');
  });

  it('checks .env protection only when the project has .env files', () => {
    expect(aiChecks(facts()).some((c) => c.id === 'env-deny')).toBe(false);
    expect(failing({ hasEnvFiles: true })).toEqual(['env-deny']);
    expect(failing({ hasEnvFiles: true, denyRules: ['Read(./.env)'] })).toEqual([]);
    expect(failing({ hasEnvFiles: true, denyRules: ['Bash(rm:*)'] })).toEqual(['env-deny']);
  });
});

describe('guide', () => {
  it('has unique entries in every section', () => {
    for (const section of CLAUDE_GUIDE) {
      const names = section.entries.map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
      expect(section.entries.every((e) => e.text.length > 10)).toBe(true);
    }
  });

  it('describes every tool the MCP server offers', () => {
    expect(CODE_VISUALIZER_TOOLS.map((t) => t.name).sort()).toEqual(['check_architecture', 'find_similar', 'find_symbol', 'impact', 'project_overview', 'review_changes', 'route', 'tests_for', 'who']);
  });
});

describe('projectCommands', () => {
  it('lists the scripts that exist, with the package manager of the project', () => {
    expect(projectCommands({ packageManager: 'pnpm', scripts: { build: 'x', test: 'y', other: 'z' } })).toEqual(['- Build: `pnpm build`', '- Run the tests: `pnpm test`']);
    expect(projectCommands({ packageManager: 'yarn@4.1.0', scripts: { lint: 'x' } })).toEqual(['- Lint: `yarn lint`']);
    expect(projectCommands({ packageManager: 'bun', scripts: { dev: 'x' } })).toEqual(['- Start the dev server: `bun run dev`']);
    expect(projectCommands({ scripts: { test: 'x', typecheck: 'y' } })).toEqual(['- Run the tests: `npm test`', '- Check the types: `npm run typecheck`']);
    expect(projectCommands({})).toEqual([]);
  });
});

describe('guideTemplates', () => {
  const templates = guideTemplates({ name: 'shop', description: 'An online shop.', packageManager: 'npm', scripts: { test: 'vitest' } });
  const byId = Object.fromEntries(templates.map((t) => [t.id, t]));

  it('writes a CLAUDE.md for this project', () => {
    expect(byId['claude-md'].content).toContain('# shop');
    expect(byId['claude-md'].content).toContain('An online shop.');
    expect(byId['claude-md'].content).toContain('`npm test`');
  });

  it('has placeholders when the project has no scripts or description', () => {
    const bare = guideTemplates({ name: 'x' }).find((t) => t.id === 'claude-md');
    expect(bare?.content).toContain('Run the tests: `…`');
  });

  it('gives templates that read back as the tool they are', () => {
    const skill = skillItem('release-notes', byId.skill.content, project);
    const command = commandItem('fix-issue', undefined, byId.command.content, project);
    const agent = agentItem('code-reviewer', byId.agent.content, project);
    expect(skill.name).toBe('release-notes');
    expect(command.invoke).toBe('/fix-issue [issue number]');
    expect(agent.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash(git diff:*)']);
    // A template that a checker would complain about is no help.
    expect([skill, command, agent].map((i) => i.warning)).toEqual([undefined, undefined, undefined]);
    expect(hookItems(JSON.parse(byId.hook.content), project)).toHaveLength(1);
  });
});
