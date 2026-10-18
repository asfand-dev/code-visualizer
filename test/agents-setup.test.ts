import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cliCommand, detectAgents, detectAgentsWithReasons, parseLaunch, planInit, planRemove, registeredMcp, removeTomlTable, upsertTomlTable, withClaudeImport, withoutClaudeImport, writeTarget } from '../src/agent/setup.js';
import { runCli } from '../src/cli/run.js';
import { managedBlockProblem, removeManagedBlock, upsertManagedBlock } from '../src/shared/markdown.js';
import { copyFixture, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sink: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stdout.write;
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture((s) => (stdout += s)));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture((s) => (stderr += s)));
  try {
    const code = await runCli(argv);
    return { code, stdout: strip(stdout), stderr: strip(stderr) };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** Every file below `root` (outside .code-visualizer/), path → content. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel === '.code-visualizer' || rel === 'node_modules') continue;
      if (entry.isDirectory()) walk(abs);
      else out[rel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

const json = (root: string, file: string): Record<string, any> => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const mtimes = (root: string, files: string[]): number[] => files.map((f) => fs.statSync(path.join(root, f)).mtimeMs);

const savedHome = process.env.HOME;
beforeAll(() => {
  // Nothing here may touch the real user configuration.
  process.env.HOME = makeTempDir('cv-home-');
});
afterAll(() => {
  process.env.HOME = savedHome;
  removeTempDirs();
});

/** A small project to set up (with a source file, so --agents-md can analyze it). */
function project(): string {
  const root = path.join(makeTempDir('cv-agents-'), 'app');
  fs.mkdirSync(root);
  writeFile(root, 'package.json', '{ "name": "app", "scripts": { "test": "vitest" }, "devDependencies": { "vitest": "^2.0.0" } }\n');
  writeFile(root, 'src/a.ts', "export const a = (x: number): number => x + 1;\n");
  writeFile(root, 'src/b.ts', "import { a } from './a';\nexport const b = a(1);\n");
  return root;
}

describe('agents init / remove', () => {
  it('previews by default: prints the diff and writes nothing', async () => {
    const root = project();
    const before = snapshot(root);
    const { code, stdout } = await cli('agents', 'init', root, '--agents', 'claude');
    expect(code).toBe(0);
    expect(stdout).toContain('+++ b/.mcp.json');
    expect(stdout).toContain('+++ b/.claude/settings.json');
    expect(stdout).toContain('Preview only — nothing was written.');
    expect(snapshot(root)).toEqual(before);
  });

  it('--write creates the expected configuration for every agent', async () => {
    const root = project();
    const { code, stdout, stderr } = await cli('agents', 'init', root, '--agents', 'all', '--hooks', 'strict', '--skill', '--write');
    expect(code).toBe(0);
    // Codex gets the MCP server only, and the full hook command line to register by hand.
    expect(`${stdout}${stderr}`).toContain('Codex can run them by hand: "npx -y code-visualizer@0 hook <session-start|pre-edit|post-edit|stop> --dialect codex".');
    const npx = { command: 'npx', args: ['-y', 'code-visualizer@0'] };
    expect(json(root, '.mcp.json')).toEqual({ mcpServers: { 'code-visualizer': { type: 'stdio', command: 'npx', args: [...npx.args, 'mcp'] } } });
    const settings = json(root, '.claude/settings.json');
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'npx -y code-visualizer@0 hook pre-edit', timeout: 15 }] }]);
    expect(settings.hooks.PostToolUse[0].hooks[0]).toMatchObject({ command: 'npx -y code-visualizer@0 hook post-edit', timeout: 15 });
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('npx -y code-visualizer@0 hook stop --strict');
    expect(json(root, '.cursor/mcp.json').mcpServers['code-visualizer']).toEqual({ command: 'npx', args: [...npx.args, 'mcp', '--root', '${workspaceFolder}'] });
    expect(json(root, '.cursor/hooks.json')).toEqual({
      version: 1,
      hooks: { afterFileEdit: [{ command: 'npx -y code-visualizer@0 hook post-edit --dialect cursor' }], stop: [{ command: 'npx -y code-visualizer@0 hook stop --dialect cursor --strict' }] },
    });
    expect(json(root, '.vscode/mcp.json')).toEqual({ servers: { 'code-visualizer': { type: 'stdio', command: 'npx', args: [...npx.args, 'mcp', '--root', '${workspaceFolder}'] } } });
    expect(fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8')).toBe(
      ['# code-visualizer:start', '[mcp_servers.code-visualizer]', 'command = "npx"', 'args = ["-y", "code-visualizer@0", "mcp"]', 'startup_timeout_sec = 30', 'tool_timeout_sec = 120', '# code-visualizer:end', ''].join('\n'),
    );
    expect(json(root, '.gemini/settings.json')).toEqual({ mcpServers: { 'code-visualizer': { command: 'npx', args: [...npx.args, 'mcp'], timeout: 120000 } } });
    const skill = fs.readFileSync(path.join(root, '.claude/skills/code-visualizer/SKILL.md'), 'utf8');
    expect(skill).toBe(fs.readFileSync(new URL('../skills/code-visualizer/SKILL.md', import.meta.url), 'utf8'));
    expect(skill).toMatch(/^---\nname: code-visualizer\ndescription: /);
  });

  it('a second run changes nothing (files keep their mtime)', async () => {
    const root = project();
    await cli('agents', 'init', root, '--agents', 'all', '--write');
    const files = ['.mcp.json', '.claude/settings.json', '.cursor/mcp.json', '.cursor/hooks.json', '.vscode/mcp.json', '.codex/config.toml', '.gemini/settings.json'];
    const before = mtimes(root, files);
    const again = await cli('agents', 'init', root, '--agents', 'all', '--write');
    expect(again.stdout).toContain('Already set up for claude, cursor, vscode, codex, gemini: nothing to change.');
    expect(mtimes(root, files)).toEqual(before);
  });

  it("keeps other servers and the user's own hooks", async () => {
    const root = project();
    writeFile(root, '.mcp.json', `${JSON.stringify({ mcpServers: { other: { command: 'other-mcp' } } }, null, 2)}\n`);
    const userHooks = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    };
    writeFile(root, '.claude/settings.json', `${JSON.stringify(userHooks, null, 2)}\n`);
    await cli('agents', 'init', root, '--agents', 'claude', '--write');
    expect(Object.keys(json(root, '.mcp.json').mcpServers)).toEqual(['other', 'code-visualizer']);
    const settings = json(root, '.claude/settings.json');
    expect(settings.permissions).toEqual(userHooks.permissions);
    expect(settings.hooks.PreToolUse[0]).toEqual(userHooks.hooks.PreToolUse[0]);
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toContain('hook pre-edit');
    expect(settings.hooks.Stop).toEqual(userHooks.hooks.Stop); // guard mode: no stop gate of ours
    // Switching to strict replaces our entries instead of adding a second set.
    await cli('agents', 'init', root, '--agents', 'claude', '--hooks', 'strict', '--write');
    const strict = json(root, '.claude/settings.json');
    expect(strict.hooks.PreToolUse).toHaveLength(2);
    expect(strict.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0].command)).toEqual(['say done', 'npx -y code-visualizer@0 hook stop --strict']);
  });

  it('keeps a single Codex table across re-runs, replacing a hand-written one', async () => {
    const root = project();
    writeFile(root, '.codex/config.toml', 'model = "o3"\n\n[mcp_servers.code-visualizer]\ncommand = "code-visualizer"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "x"\n');
    await cli('agents', 'init', root, '--agents', 'codex', '--write');
    await cli('agents', 'init', root, '--agents', 'codex', '--write');
    const toml = fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8');
    expect(toml.match(/\[mcp_servers\.code-visualizer\]/g)).toHaveLength(1);
    expect(toml).toContain('model = "o3"');
    expect(toml).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(toml).toContain('args = ["-y", "code-visualizer@0", "mcp"]');
  });

  it('remove --write restores the original files byte for byte', async () => {
    const root = project();
    // Hand-formatted files (not 2-space JSON, no final newline, comments): only the backup can restore them exactly.
    writeFile(root, '.mcp.json', '{"mcpServers":{"other":{"command":"x"}}}');
    writeFile(root, '.claude/settings.json', '{\n\t// mine\n\t"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}\n}\n');
    writeFile(root, '.codex/config.toml', 'model = "o3"');
    writeFile(root, 'AGENTS.md', '# Notes\n\nKeep it simple.\n');
    fs.mkdirSync(path.join(root, '.cursor'));
    const original = snapshot(root);
    const init = await cli('agents', 'init', root, '--agents', 'all', '--hooks', 'strict', '--skill', '--agents-md', '--write');
    expect(init.code).toBe(0);
    expect(init.stdout).toContain('the comments in .claude/settings.json are not kept');
    expect(snapshot(root)).not.toEqual(original);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('# Notes\n\nKeep it simple.\n\n<!-- code-visualizer:start -->');
    const removed = await cli('agents', 'remove', root, '--write');
    expect(removed.code).toBe(0);
    expect(snapshot(root)).toEqual(original);
    expect(fs.readdirSync(path.join(root, '.cursor'))).toEqual([]);
    expect(fs.existsSync(path.join(root, '.vscode'))).toBe(false);
    expect((await cli('agents', 'remove', root, '--write')).stdout).toContain("Nothing of code-visualizer's to remove.");
  });

  it('remove without a backup takes out only our entries (canonical files come back exactly)', async () => {
    const root = project();
    writeFile(root, '.mcp.json', `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`);
    writeFile(root, '.claude/settings.json', `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, null, 2)}\n`);
    writeFile(root, '.codex/config.toml', 'model = "o3"\n');
    writeFile(root, 'CLAUDE.md', '# Rules\n');
    const original = snapshot(root);
    await cli('agents', 'init', root, '--agents', 'claude,codex,cursor', '--agents-md', '--write');
    // Another machine (or a cleared .code-visualizer/) has no backup.
    fs.rmSync(path.join(root, '.code-visualizer'), { recursive: true, force: true });
    await cli('agents', 'remove', root, '--write');
    expect(snapshot(root)).toEqual(original);
  });

  it('builds commands for Windows (cmd /c) and for a local install (npx --no-install)', () => {
    const root = project();
    const [mcp] = planInit(root, { agents: ['claude'], hooks: 'none', platform: 'win32', version: '1.4.2' });
    expect(JSON.parse(mcp.after).mcpServers['code-visualizer']).toEqual({ type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'code-visualizer@1', 'mcp'] });
    writeFile(root, 'node_modules/.bin/code-visualizer', '#!/bin/sh\n');
    expect(cliCommand(root, 'linux')).toEqual({ command: 'npx', args: ['--no-install', 'code-visualizer'], local: true });
    const [local] = planInit(root, { agents: ['gemini'] });
    expect(JSON.parse(local.after).mcpServers['code-visualizer'].args).toEqual(['--no-install', 'code-visualizer', 'mcp']);
  });

  it('detects agents from project folders and CLIs on PATH', () => {
    const root = project();
    const bin = makeTempDir('cv-bin-');
    expect(detectAgents(root, { PATH: '' }, 'linux')).toEqual([]);
    fs.mkdirSync(path.join(root, '.cursor'));
    writeFile(bin, 'codex', '');
    expect(detectAgents(root, { PATH: bin }, 'linux')).toEqual(['cursor', 'codex']);
    writeFile(root, 'CLAUDE.md', '# x\n');
    expect(detectAgents(root, { PATH: '' }, 'linux')).toEqual(['claude', 'cursor']);
    // Cursor's own command on PATH counts too.
    const other = project();
    const cursorBin = makeTempDir('cv-bin-');
    writeFile(cursorBin, 'cursor', '');
    expect(detectAgents(other, { PATH: cursorBin }, 'linux')).toEqual(['cursor']);
  });

  it('--hooks none takes out hooks an earlier init installed, and keeps the user\'s', async () => {
    const root = project();
    writeFile(root, '.claude/settings.json', `${JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }] } }, null, 2)}\n`);
    await cli('agents', 'init', root, '--agents', 'claude,cursor', '--write');
    expect(json(root, '.claude/settings.json').hooks.PreToolUse).toHaveLength(1);
    const none = await cli('agents', 'init', root, '--agents', 'claude,cursor', '--hooks', 'none', '--write');
    expect(none.stdout).not.toContain('nothing to change');
    expect(none.stdout).toContain('.claude/settings.json (update)');
    expect(json(root, '.claude/settings.json')).toEqual({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier --write' }] }] } });
    expect(fs.existsSync(path.join(root, '.cursor/hooks.json'))).toBe(false);
    expect(json(root, '.mcp.json').mcpServers['code-visualizer']).toBeDefined();
    expect((await cli('agents', 'init', root, '--agents', 'claude,cursor', '--hooks', 'none', '--write')).stdout).toContain('nothing to change');
  });

  it('reports files it cannot parse as not changed, and fails the --write', async () => {
    const root = project();
    writeFile(root, '.vscode/mcp.json', '{ "servers": ');
    const plan = JSON.parse((await cli('agents', 'init', root, '--agents', 'claude,vscode', '--json')).stdout) as { changes: { path: string; action: string }[] };
    expect(plan.changes.map((c) => [c.path, c.action])).toEqual([
      ['.mcp.json', 'create'],
      ['.claude/settings.json', 'create'],
      ['.vscode/mcp.json', 'skipped'],
    ]);
    const run = await cli('agents', 'init', root, '--agents', 'claude,vscode', '--write');
    expect(run.code).toBe(1);
    expect(run.stdout).toContain('✔ Set up: .mcp.json (create), .claude/settings.json (create)');
    expect(run.stdout).not.toContain('.vscode/mcp.json (update)');
    expect(run.stdout).toContain('Not changed (fix by hand, then run again): .vscode/mcp.json');
    expect(fs.readFileSync(path.join(root, '.vscode/mcp.json'), 'utf8')).toBe('{ "servers": ');
    const state = JSON.parse(fs.readFileSync(path.join(root, '.code-visualizer/state.json'), 'utf8')) as { agents: { files: Record<string, unknown> } };
    expect(Object.keys(state.agents.files)).not.toContain('.vscode/mcp.json');
    // Unbalanced AGENTS.md markers are left alone the same way.
    writeFile(root, 'AGENTS.md', '# Notes\n\n<!-- code-visualizer:start -->\nold\n\nKeep this.\n');
    const md = JSON.parse((await cli('agents', 'init', root, '--agents', 'claude', '--agents-md', '--json')).stdout) as { changes: { path: string; action: string; notes?: string[] }[] };
    expect(md.changes.find((c) => c.path === 'AGENTS.md')).toMatchObject({ action: 'skipped' });
  });

  it('keeps the indentation of hand-formatted JSON', async () => {
    const root = project();
    const settings = `${JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }, null, 4)}\n`;
    writeFile(root, '.claude/settings.json', settings);
    const { stdout } = await cli('agents', 'init', root, '--agents', 'claude');
    expect(stdout).not.toContain('rewritten');
    // Only additions in the diff: the user's lines stay as they were.
    const diff = stdout.slice(stdout.indexOf('+++ b/.claude/settings.json'));
    expect(diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))).toEqual([]);
    await cli('agents', 'init', root, '--agents', 'claude', '--write');
    const after = fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8');
    expect(after).toContain('\n    "permissions": {\n        "allow": [');
    expect(after).toContain('\n    "hooks": {\n        "SessionStart": [');
  });

  it('remove --agents takes out only those clients (the skill and AGENTS.md serve the others)', async () => {
    const root = project();
    await cli('agents', 'init', root, '--agents', 'all', '--agents-md', '--skill', '--write');
    const plan = JSON.parse((await cli('agents', 'remove', root, '--agents', 'cursor', '--json')).stdout) as { agents: string[]; changes: { path: string }[] };
    expect(plan.agents).toEqual(['cursor']);
    expect(plan.changes.map((c) => c.path)).toEqual(['.cursor/mcp.json', '.cursor/hooks.json']);
    const md = JSON.parse((await cli('agents', 'remove', root, '--agents', 'cursor', '--agents-md', '--json')).stdout) as { changes: { path: string }[] };
    expect(md.changes.map((c) => c.path)).toEqual(['.cursor/mcp.json', '.cursor/hooks.json', 'AGENTS.md', 'CLAUDE.md']);
    const all = JSON.parse((await cli('agents', 'remove', root, '--json')).stdout) as { agents: string[]; changes: { path: string }[] };
    expect(all.agents).toEqual(['claude', 'cursor', 'vscode', 'codex', 'gemini']);
    expect(all.changes.map((c) => c.path)).toContain('.claude/skills/code-visualizer/SKILL.md');
  });

  it('works on the project around the current folder when no root is given', async () => {
    const root = project();
    fs.mkdirSync(path.join(root, 'src/deep'), { recursive: true });
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'src/deep'));
    try {
      const plan = JSON.parse((await cli('agents', 'init', '--agents', 'claude', '--json')).stdout) as { root: string; changes: { path: string }[] };
      expect(fs.realpathSync(plan.root)).toBe(fs.realpathSync(root));
    } finally {
      cwd.mockRestore();
    }
  });

  it('reports the plan as JSON and rejects unknown agents', async () => {
    const root = project();
    const { code, stdout } = await cli('agents', 'init', root, '--agents', 'cursor', '--json');
    expect(code).toBe(0);
    const plan = JSON.parse(stdout) as { written: boolean; changes: { path: string; action: string }[] };
    expect(plan.written).toBe(false);
    expect(plan.changes.map((c) => [c.path, c.action])).toEqual([
      ['.cursor/mcp.json', 'create'],
      ['.cursor/hooks.json', 'create'],
    ]);
    const bad = await cli('agents', 'init', root, '--agents', 'cursr');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('did you mean "cursor"');
    expect((await cli('agents', 'nope')).code).toBe(2);
    expect((await cli('agents', 'init', root, '--hooks', 'loud')).code).toBe(2);
  });

  it('keeps every hook deadline inside the timeout init installs for it', async () => {
    const { DEADLINE_MS } = await import('../src/cli/commands/hook.js');
    const settings = planInit(project(), { agents: ['claude'], hooks: 'strict' }).find((w) => w.path === '.claude/settings.json')!;
    const hooks = JSON.parse(settings.after).hooks as Record<string, { hooks: { timeout: number }[] }[]>;
    const timeout = (event: string): number => hooks[event][0].hooks[0].timeout * 1000;
    expect(DEADLINE_MS['session-start']).toBeLessThan(timeout('SessionStart'));
    expect(DEADLINE_MS['pre-edit']).toBeLessThan(timeout('PreToolUse'));
    expect(DEADLINE_MS['post-edit']).toBeLessThan(timeout('PostToolUse'));
    expect(DEADLINE_MS.stop).toBeLessThan(timeout('Stop'));
  });

  it('plans nothing to remove in an untouched project', () => {
    expect(planRemove(project())).toEqual([]);
  });
});

describe('managed text blocks', () => {
  it('upserts and removes the AGENTS.md block, the Codex table and the CLAUDE.md import exactly', () => {
    const block = '<!-- code-visualizer:start -->\nmap\n<!-- code-visualizer:end -->';
    for (const original of ['# Notes\n', '# Notes\n\nmore\n']) {
      const withBlock = upsertManagedBlock(original, block);
      expect(upsertManagedBlock(withBlock, block)).toBe(withBlock);
      expect(removeManagedBlock(withBlock)).toBe(original);
    }
    expect(upsertManagedBlock(null, block)).toBe(`# AGENTS.md\n\n${block}\n`);
    expect(removeManagedBlock(upsertManagedBlock(null, block))).toBeNull();
    const replaced = upsertManagedBlock(`a\n\n${block}\n\nb\n`, block.replace('map', 'new map'));
    expect(replaced).toBe(`a\n\n${block.replace('map', 'new map')}\n\nb\n`);

    const table = '# code-visualizer:start\n[mcp_servers.code-visualizer]\ncommand = "npx"\n# code-visualizer:end';
    expect(removeTomlTable(upsertTomlTable('model = "o3"\n', table))).toBe('model = "o3"\n');
    expect(removeTomlTable(upsertTomlTable(null, table))).toBeNull();

    expect(withClaudeImport('@AGENTS.md\n')).toBe('@AGENTS.md\n');
    expect(withoutClaudeImport(withClaudeImport('# Rules\n'))).toBe('# Rules\n');
    expect(withoutClaudeImport(withClaudeImport(null))).toBeNull();
  });

  it('matches the block markers only on lines of their own, and names unbalanced ones', () => {
    const block = '<!-- code-visualizer:start -->\nmap\n<!-- code-visualizer:end -->';
    const mention = 'It sits between `<!-- code-visualizer:start -->` and `<!-- code-visualizer:end -->`.\n';
    expect(upsertManagedBlock(mention, block)).toBe(`${mention}\n${block}\n`);
    expect(removeManagedBlock(mention)).toBe(mention);
    expect(managedBlockProblem('a\n<!-- code-visualizer:start -->\nb\n')).toBe('line 2 has <!-- code-visualizer:start --> without a matching <!-- code-visualizer:end -->');
    expect(managedBlockProblem('<!-- code-visualizer:end -->\n<!-- code-visualizer:start -->\n')).toContain('comes before');
    expect(managedBlockProblem(`${block}\n${block}\n`)).toContain('more than once');
    expect(() => upsertManagedBlock('<!-- code-visualizer:start -->\nNever deploy on Fridays.\n', block)).toThrow('without a matching');
    const orphan = '# x\n<!-- code-visualizer:start -->\nkeep\n';
    expect(removeManagedBlock(orphan)).toBe(orphan);
    // CRLF files work too.
    expect(upsertManagedBlock(`# x\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\n`, block.replace('map', 'new'))).toContain('new');
  });

  it('reads registered commands back and tells how they reach the CLI', () => {
    expect(parseLaunch('npx', ['-y', 'code-visualizer@0', 'mcp'])).toEqual({ via: 'registry', cliArgs: ['mcp'], pin: '0' });
    expect(parseLaunch('cmd', ['/c', 'npx', '--no-install', 'code-visualizer', 'mcp', '--root', '${workspaceFolder}'])).toEqual({ via: 'local', cliArgs: ['mcp', '--root', '${workspaceFolder}'] });
    expect(parseLaunch('node', ['/x/dist/cli.js', 'mcp'])).toEqual({ via: 'command', cliArgs: ['/x/dist/cli.js', 'mcp'] });
    const root = project();
    writeFile(root, '.codex/config.toml', 'model = "o3"\n\n[mcp_servers.code-visualizer]\ncommand = \'cviz\'\nargs = ["mcp"] # local\n');
    expect(registeredMcp(root, 'codex')).toEqual({ file: '.codex/config.toml', command: 'cviz', args: ['mcp'] });
  });
});

type DoctorReport = { checks: { name: string; status: string; detail: string; ms?: number }[] };

describe('agents doctor', () => {
  it('checks the MCP handshake, analysis speed and a hook round-trip', async () => {
    const root = copyFixture('react-vite-ts');
    const { code, stdout } = await cli('agents', 'doctor', root, '--json');
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as DoctorReport;
    const byName = new Map(report.checks.map((c) => [c.name, c]));
    expect(byName.get('MCP')).toMatchObject({ status: 'ok' });
    expect(byName.get('MCP')!.detail).toMatch(/\d+ tools/);
    expect(byName.get('cold analysis')?.ms).toBeGreaterThanOrEqual(0);
    expect(byName.get('warm analysis')?.status).toBe('ok');
    expect(byName.get('pre-edit hook')?.status).toBe('ok');
    expect(byName.get('agents')?.status).toBe('warn'); // nothing set up in the fixture
    // The round-trip leaves no session behind.
    expect(fs.existsSync(path.join(root, '.code-visualizer/sessions/code-visualizer-doctor.json'))).toBe(false);
  });

  it('runs what is registered: a broken MCP command, a missing local install and a mistyped hook fail', async () => {
    const root = copyFixture('react-vite-ts');
    await cli('agents', 'init', root, '--agents', 'claude,cursor', '--write');
    const good = JSON.parse((await cli('agents', 'doctor', root, '--json')).stdout) as DoctorReport;
    expect(good.checks.find((c) => c.name === 'MCP (claude)')).toMatchObject({ status: 'ok' });
    expect(good.checks.find((c) => c.name === 'MCP (cursor)')).toMatchObject({ status: 'ok' });
    expect(good.checks.find((c) => c.name === 'pre-edit hook (claude)')).toMatchObject({ status: 'ok' });
    // A command that does not exist, and a hook event with a typo.
    const mcp = json(root, '.mcp.json');
    mcp.mcpServers['code-visualizer'].command = 'definitely-not-a-binary';
    writeFile(root, '.mcp.json', JSON.stringify(mcp));
    const settings = json(root, '.claude/settings.json');
    settings.hooks.PreToolUse[0].hooks[0].command = 'npx -y code-visualizer@0 hook pre-edt';
    writeFile(root, '.claude/settings.json', JSON.stringify(settings));
    const broken = await cli('agents', 'doctor', root, '--json');
    expect(broken.code).toBe(1);
    const checks = (JSON.parse(broken.stdout) as DoctorReport).checks;
    expect(checks.find((c) => c.name === 'MCP (claude)')).toMatchObject({ status: 'fail' });
    expect(checks.find((c) => c.name === 'MCP (claude)')!.detail).toContain('could not be started');
    expect(checks.find((c) => c.name === 'claude')!.detail).toContain('"pre-edt" is not a hook event');
    // Registered for a local install that is gone.
    const local = copyFixture('react-vite-ts');
    writeFile(local, '.mcp.json', JSON.stringify({ mcpServers: { 'code-visualizer': { type: 'stdio', command: 'npx', args: ['--no-install', 'code-visualizer', 'mcp'] } } }));
    const missing = JSON.parse((await cli('agents', 'doctor', local, '--json')).stdout) as DoctorReport;
    expect(missing.checks.find((c) => c.name === 'claude')).toMatchObject({ status: 'fail' });
    expect(missing.checks.find((c) => c.name === 'claude')!.detail).toContain('node_modules/.bin/code-visualizer is missing');
  });

  it('reports an invalid configuration and a project without sources instead of crashing', async () => {
    const root = copyFixture('react-vite-ts');
    writeFile(root, 'code-visualizer.config.json', '{ "rules": [ { "from": ');
    const invalid = JSON.parse((await cli('agents', 'doctor', root, '--json')).stdout) as DoctorReport;
    expect(invalid.checks.find((c) => c.name === 'configuration')).toMatchObject({ status: 'fail' });
    const empty = path.join(makeTempDir('cv-empty-'), 'empty');
    writeFile(empty, 'package.json', '{ "name": "empty" }\n');
    const run = await cli('agents', 'doctor', empty, '--json');
    expect(run.code).toBe(1);
    const checks = (JSON.parse(run.stdout) as DoctorReport).checks;
    expect(checks.find((c) => c.name === 'analysis')).toMatchObject({ status: 'fail' });
    expect(checks.find((c) => c.name === 'analysis')!.detail).toContain('No JavaScript/TypeScript source files');
    expect(checks.find((c) => c.name === 'MCP')).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                               Release fixes                                */
/* -------------------------------------------------------------------------- */

describe('agents doctor: commands the repository registered', () => {
  it('does not run a custom MCP command unless --run-registered says so', async () => {
    const root = copyFixture('react-vite-ts');
    const marker = path.join(makeTempDir('cv-pwned-'), 'pwned');
    writeFile(root, '.mcp.json', JSON.stringify({ mcpServers: { 'code-visualizer': { command: 'sh', args: ['-c', `echo RAN > '${marker}'`] } } }));
    const text = await cli('agents', 'doctor', root);
    expect(fs.existsSync(marker)).toBe(false);
    expect(text.stdout).toContain('not run');
    expect(text.stdout).toContain('--run-registered');
    const report = JSON.parse((await cli('agents', 'doctor', root, '--json')).stdout) as DoctorReport;
    expect(report.checks.find((c) => c.name === 'MCP (claude)')).toMatchObject({ status: 'warn', detail: expect.stringContaining('custom command, not run (pass --run-registered to execute it)') });
    expect(fs.existsSync(marker)).toBe(false);
    // Asked for: it runs (and fails the handshake, which is what doctor then reports).
    const ran = JSON.parse((await cli('agents', 'doctor', root, '--json', '--run-registered')).stdout) as DoctorReport;
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('RAN');
    expect(ran.checks.find((c) => c.name === 'MCP (claude)')).toMatchObject({ status: 'fail' });
    expect((await cli('agents', 'init', root, '--run-registered')).code).toBe(2);
  }, 60_000);

  it('does not run a custom hook line (sh -c … code-visualizer hook …) unless asked', async () => {
    const root = copyFixture('react-vite-ts');
    const marker = path.join(makeTempDir('cv-pwned-'), 'hooked');
    const line = `sh -c 'echo RAN > "${marker}"' code-visualizer hook pre-edit`;
    writeFile(root, '.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: line }] }] } }));
    const report = JSON.parse((await cli('agents', 'doctor', root, '--json')).stdout) as DoctorReport;
    expect(fs.existsSync(marker)).toBe(false);
    expect(report.checks.find((c) => c.name === 'pre-edit hook (claude)')).toMatchObject({ status: 'warn', detail: expect.stringContaining('not run') });
    expect(report.checks.find((c) => c.name === 'claude')!.detail).toContain('is a custom command, not run');
    await cli('agents', 'doctor', root, '--json', '--run-registered');
    expect(fs.existsSync(marker)).toBe(true);
  }, 60_000);

  it('runs code-visualizer itself: an installed package only when it really is code-visualizer', async () => {
    const root = copyFixture('react-vite-ts');
    const marker = path.join(makeTempDir('cv-pwned-'), 'fake');
    // node_modules/.bin/code-visualizer that is not the code-visualizer package.
    writeFile(root, 'node_modules/fake/package.json', '{ "name": "not-code-visualizer" }');
    writeFile(root, 'node_modules/fake/cli.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'RAN');\n`);
    fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    fs.symlinkSync('../fake/cli.js', path.join(root, 'node_modules/.bin/code-visualizer'));
    writeFile(root, '.mcp.json', JSON.stringify({ mcpServers: { 'code-visualizer': { type: 'stdio', command: 'npx', args: ['--no-install', 'code-visualizer', 'mcp'] } } }));
    const report = JSON.parse((await cli('agents', 'doctor', root, '--json')).stdout) as DoctorReport;
    expect(fs.existsSync(marker)).toBe(false);
    expect(report.checks.find((c) => c.name === 'MCP (claude)')!.detail).toContain('is not an installed code-visualizer package');
    // The real package (this checkout, built) is run as registered.
    const cliJs = new URL('../dist/cli.js', import.meta.url);
    if (!fs.existsSync(cliJs)) return;
    const real = copyFixture('react-vite-ts');
    fs.mkdirSync(path.join(real, 'node_modules/.bin'), { recursive: true });
    fs.symlinkSync(fs.realpathSync(new URL('..', import.meta.url)), path.join(real, 'node_modules/code-visualizer'));
    fs.symlinkSync('../code-visualizer/dist/cli.js', path.join(real, 'node_modules/.bin/code-visualizer'));
    writeFile(real, '.mcp.json', JSON.stringify({ mcpServers: { 'code-visualizer': { type: 'stdio', command: 'npx', args: ['--no-install', 'code-visualizer', 'mcp'] } } }));
    const good = JSON.parse((await cli('agents', 'doctor', real, '--json')).stdout) as DoctorReport;
    expect(good.checks.find((c) => c.name === 'MCP (claude)')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/\d+ tools/) });
  }, 90_000);
});

describe('agents init: symlinks', () => {
  it('CLAUDE.md linked to AGENTS.md: one block, no self-import', async () => {
    const root = project();
    writeFile(root, 'AGENTS.md', '# Notes\n\nKeep it simple.\n');
    fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
    const run = await cli('agents', 'init', root, '--agents', 'claude', '--agents-md', '--write');
    expect(run.code).toBe(0);
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agents.match(/<!-- code-visualizer:start -->/g)).toHaveLength(1);
    expect(agents).not.toMatch(/^@AGENTS\.md/m);
    expect(agents).toContain('Keep it simple.');
    expect(fs.lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    // A second run changes nothing; remove takes the block out of the one file.
    expect((await cli('agents', 'init', root, '--agents', 'claude', '--agents-md', '--write')).stdout).toContain('nothing to change');
    await cli('agents', 'remove', root, '--write');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe('# Notes\n\nKeep it simple.\n');
  });

  it('never writes through a link out of the project, and names it', async () => {
    const root = project();
    const outside = path.join(makeTempDir('cv-outside-'), 'settings.json');
    const original = '{ "theme": "dark" }\n';
    fs.writeFileSync(outside, original);
    fs.mkdirSync(path.join(root, '.claude'));
    fs.symlinkSync(outside, path.join(root, '.claude/settings.json'));
    const run = await cli('agents', 'init', root, '--agents', 'claude', '--write');
    expect(fs.readFileSync(outside, 'utf8')).toBe(original);
    expect(run.stdout).toContain(`.claude/settings.json is a symlink to ${fs.realpathSync(outside)} (outside the project), not changed`);
    expect(run.code).toBe(1);
    // The rest of the setup is done.
    expect(json(root, '.mcp.json').mcpServers['code-visualizer']).toBeDefined();
    // A linked folder that leads out is refused the same way.
    const other = project();
    const dir = makeTempDir('cv-outside-dir-');
    fs.symlinkSync(dir, path.join(other, '.cursor'));
    const plan = JSON.parse((await cli('agents', 'init', other, '--agents', 'cursor', '--json')).stdout) as { changes: { path: string; action: string; notes?: string[] }[] };
    expect(plan.changes.map((c) => c.action)).toEqual(['skipped', 'skipped']);
    await cli('agents', 'init', other, '--agents', 'cursor', '--write');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes the file a link inside the project points to, and says so in the preview', async () => {
    const root = project();
    writeFile(root, 'config/mcp.json', `${JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2)}\n`);
    fs.symlinkSync('config/mcp.json', path.join(root, '.mcp.json'));
    expect(writeTarget(root, '.mcp.json')).toMatchObject({ outside: false, link: 'config/mcp.json' });
    const preview = await cli('agents', 'init', root, '--agents', 'claude');
    expect(preview.stdout).toContain('+++ b/.mcp.json -> config/mcp.json');
    await cli('agents', 'init', root, '--agents', 'claude', '--yes');
    expect(fs.lstatSync(path.join(root, '.mcp.json')).isSymbolicLink()).toBe(true);
    expect(Object.keys(json(root, 'config/mcp.json').mcpServers)).toEqual(['other', 'code-visualizer']);
  });
});

describe('agents init: flags and detection', () => {
  it('accepts --yes as --write', async () => {
    const root = project();
    const run = await cli('agents', 'init', root, '--agents', 'claude', '--yes');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('✔ Set up: .mcp.json (create)');
    expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(true);
    expect((await cli('agents', 'doctor', root, '--write')).code).toBe(2);
  });

  it('says which agents it detected and why', async () => {
    const root = project();
    fs.mkdirSync(path.join(root, '.cursor'));
    const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, PATH: process.env.PATH };
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_PROJECT_DIR;
    process.env.PATH = makeTempDir('cv-empty-path-');
    try {
      const run = await cli('agents', 'init', root);
      expect(run.stderr).toContain('Detected: cursor (.cursor/)');
      expect(run.stderr).toContain('--agents cursor,claude');
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('detects Claude Code from its environment and ~/.claude', () => {
    const root = project();
    expect(detectAgentsWithReasons(root, { PATH: '', CLAUDECODE: '1' }, 'linux')).toEqual([{ agent: 'claude', reasons: ['running in Claude Code'] }]);
    expect(detectAgentsWithReasons(root, { PATH: '', CLAUDE_PROJECT_DIR: root }, 'linux')).toEqual([{ agent: 'claude', reasons: ['CLAUDE_PROJECT_DIR is set'] }]);
    const home = makeTempDir('cv-home-');
    expect(detectAgents(root, { PATH: '', HOME: home }, 'linux')).toEqual([]);
    fs.mkdirSync(path.join(home, '.claude'));
    expect(detectAgentsWithReasons(root, { PATH: '', HOME: home }, 'linux')).toEqual([{ agent: 'claude', reasons: ['~/.claude'] }]);
  });
});
