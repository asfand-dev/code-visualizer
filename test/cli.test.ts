import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COMMAND_GROUPS, COMMANDS, runCli } from '../src/cli/run.js';
import { exitOnBrokenPipe, findProjectRoot, toProjectPath } from '../src/cli/commands/query.js';
import { createLinker, editorLink } from '../src/cli/format.js';
import { writeServerInfo } from '../src/analyzer/state.js';
import { VERSION } from '../src/version.js';
import { commitAll, copyFixture, daysAgo, editFile, fixtureDir, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs } from './companion-helpers.js';

afterAll(removeTempDirs);

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Run the CLI in-process and capture what it writes. */
async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return cliWith(runCli, argv);
}

async function cliWith(run: typeof runCli, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
    const code = await run(argv);
    return { code, stdout: strip(stdout), stderr: strip(stderr) };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const fullstack = fixtureDir('fullstack-next');

interface CheckJson {
  ok: boolean;
  mode: string;
  health: number;
  changedOnly: boolean;
  gates: {
    id: string;
    label: string;
    ok: boolean;
    detail: string;
    counts?: { new: number; existing: number; fixed: number };
    findings: { ruleId: string; file: string; line?: number; message: string; severity: string; fingerprint: string; status?: string }[];
  }[];
  fixed: { ruleId: string; fingerprint: string }[];
}

describe('cli: help and version', () => {
  it('prints the version', async () => {
    expect(await cli('--version')).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
    expect((await cli('-v')).stdout).toBe(`${VERSION}\n`);
  });

  it('prints the main help with every command, grouped, within 80 columns', async () => {
    const { code, stdout } = await cli('--help');
    expect(code).toBe(0);
    for (const name of ['report', 'serve', 'check', 'pr', 'diff', 'review', 'context', 'who', 'uses', 'impact', 'path', 'route', 'tests-for', 'mcp', 'cache', 'test', 'coverage', 'status', 'hooks', 'sync', 'similar', 'agents', 'hook']) expect(stdout).toMatch(new RegExp(`^\\s+${name}\\s`, 'm'));
    // Every registered command is listed (none is hidden today), under its group's heading.
    for (const c of COMMANDS.filter((d) => !d.hidden)) expect(stdout).toMatch(new RegExp(`^  ${c.name} +\\S`, 'm'));
    for (const group of ['Get started', 'Explore', 'Ask', 'Everyday', 'Review & CI', 'AI agents', 'Setup']) expect(stdout).toMatch(new RegExp(`^${group.replace('&', '\\&')}$`, 'm'));
    expect(stdout.indexOf('\nAI agents\n')).toBeLessThan(stdout.indexOf('  hook '));
    expect(stdout).toMatch(/^ {2}hook +.*\(run by agents\)/m);
    expect(stdout).toMatch(/^ {2}serve +.*\(live, watch, dev\)$/m);
    expect(stdout).toMatch(/^ {2}uses +.*\(refs\)$/m);
    expect(stdout).toContain('$ npx code-visualizer check --changed');
    for (const line of stdout.split('\n')) expect(line.length, line).toBeLessThanOrEqual(80);
    expect(stdout).toContain('$ cviz [command] [options]');
    expect(stdout).toContain('once installed: npm i -g code-visualizer'); // `npx cviz` would fetch another package
  });

  it('describes every command in one short help line', () => {
    for (const d of COMMANDS) {
      expect(COMMAND_GROUPS, d.name).toContain(d.group);
      expect((d.brief ?? d.summary).length, d.name).toBeLessThan(64);
    }
  });

  it.each(['report', 'serve', 'check', 'pr', 'diff', 'review', 'context', 'who', 'uses', 'impact', 'path', 'route', 'tests-for', 'mcp', 'cache', 'test', 'coverage', 'status', 'hooks', 'sync', 'similar', 'agents', 'hook'])('"%s --help" exits 0 with usage', async (name) => {
    const { code, stdout, stderr } = await cli(name, '--help');
    expect(code).toBe(0);
    expect(stdout).toContain(`$ code-visualizer ${name}`);
    expect(stderr).toBe('');
  });

  it('supports "help <command>", "--help <command>" and command aliases', async () => {
    const viaHelp = await cli('help', 'check');
    expect(viaHelp.code).toBe(0);
    expect(viaHelp.stdout).toContain('$ code-visualizer check');
    for (const argv of [['--help', 'check'], ['-h', 'check']]) {
      const flag = await cli(...argv);
      expect(flag.code).toBe(0);
      expect(flag.stdout).toContain('$ code-visualizer check [root] [options]');
    }
    const nope = await cli('help', 'nope');
    expect(nope.code).toBe(2);
    expect(nope.stdout).toBe('');
    expect(nope.stderr).toContain('Unknown command "nope"');
    const alias = await cli('live', '--help');
    expect(alias.code).toBe(0);
    expect(alias.stdout).toContain('$ code-visualizer serve');
  });

  it('rejects unknown commands and options', async () => {
    const unknown = await cli('frobnicate');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown command "frobnicate".');
    expect(unknown.stderr).not.toContain('Did you mean');
    // A typo gets the closest command, on stderr only (no help dump on stdout).
    const typo = await cli('chek');
    expect(typo).toMatchObject({ code: 2, stdout: '' });
    expect(typo.stderr).toContain('✖ Unknown command "chek". Did you mean "check"?');
    expect(typo.stderr).toContain('Run code-visualizer --help');
    expect((await cli('tset')).stderr).toContain('Did you mean "test"?');
    expect((await cli('rfes')).stderr).toContain('Did you mean "refs"?');
    // …and an unknown option the closest option of that command (Damerau-Levenshtein ≤ 2).
    const option = await cli('check', '--jsno');
    expect(option.code).toBe(2);
    expect(option.stderr).toContain('Unknown option --jsno. Did you mean --json?');
    for (const [command, typoed, meant] of [
      ['report', '--no-opne', '--no-open'],
      ['serve', '--prot', '--port'],
      ['test', '--dryrun', '--dry-run'],
      ['coverage', '--mn', '--min'],
      ['similar', '--limt', '--limit'],
      ['impact', '--dpeth', '--depth'],
      // integration (release fixes): every command parses its options the same way.
      ['pr', '--bsae', '--base'],
      ['context', '--sumary', '--summary'],
      ['diff', '--stagd', '--staged'],
      ['review', '--jsn', '--json'],
      ['sync', '--brnches', '--branches'],
      ['status', '--fromat', '--format'],
      ['hooks', '--glboal-hooks', '--global-hooks'],
      ['agents', '--wirte', '--write'],
      ['mcp', '--rot', '--root'],
      ['cache', '--jsno', '--json'],
    ]) {
      const r = await cli(command, typoed, 'x');
      expect(r.code, command).toBe(2);
      expect(r.stderr, command).toContain(`Did you mean ${meant}?`);
    }
    expect((await cli('check', '--frobnicate')).stderr).not.toContain('Did you mean');
    expect((await cli('check', '--bogus')).code).toBe(2);
    expect((await cli('pr', '--bogus')).code).toBe(2);
    expect((await cli('context', '--bogus')).code).toBe(2);
    expect((await cli('diff', '--bogus')).code).toBe(2);
    expect((await cli('mcp', '--bogus')).code).toBe(2);
    expect((await cli('status', '--bogus')).code).toBe(2);
    expect((await cli('hooks', 'status', '--bogus')).code).toBe(2);
    expect((await cli('sync', '--bogus')).code).toBe(2);
    expect((await cli('similar', '--bogus')).code).toBe(2);
  });

  it('prints MCP registration snippets without starting a server', async () => {
    const claude = await cli('mcp', '--print-config', 'claude');
    expect(claude.code).toBe(0);
    // The command `agents init` registers: the project's own install, else the published package at this major version.
    expect(claude.stdout.trim()).toMatch(/^claude mcp add --scope project code-visualizer -- (cmd \/c )?npx (-y code-visualizer@\d+|--no-install code-visualizer) mcp$/);
    const cursor = await cli('mcp', '--print-config', 'cursor', '--tools', 'impact,tests_for');
    expect(JSON.parse(cursor.stdout).mcpServers['code-visualizer'].args).toEqual(expect.arrayContaining(['mcp', '--root', '${workspaceFolder}', '--tools', 'impact,tests_for']));
    expect(cursor.stderr).toContain('.cursor/mcp.json');
    expect(JSON.parse((await cli('mcp', '--print-config', 'codex', '--json')).stdout)).toMatchObject({ client: 'codex', file: '.codex/config.toml', format: 'toml' });
    expect((await cli('mcp', '--print-config', 'emacs')).code).toBe(2);
    const unknownTool = await cli('mcp', '--tools', 'impact,nope', '--print-config', 'claude');
    expect(unknownTool.code).toBe(2);
    expect(unknownTool.stderr).toContain('Unknown tool "nope"');
    expect((await cli('mcp', '--tools', 'impct', '--print-config', 'claude')).stderr).toContain('did you mean "impact"');
    // --json belongs to --print-config: alone it is a usage error, not a server start.
    const json = await cli('mcp', '--json');
    expect(json.code).toBe(2);
    expect(json.stderr).toContain('--json only applies to --print-config');
    // The root given is part of the printed registration.
    const rooted = await cli('mcp', 'packages/web', '--print-config', 'cursor');
    expect(JSON.parse(rooted.stdout).mcpServers['code-visualizer'].args).toEqual(expect.arrayContaining(['--root', '${workspaceFolder}/packages/web']));
  });
});

describe('cli: lazy command registry', () => {
  it('describes every command exactly like the command it loads', async () => {
    for (const d of COMMANDS) {
      const command = await d.load();
      expect({ name: command.name, aliases: command.aliases, summary: command.summary }).toEqual({ name: d.name, aliases: d.aliases, summary: d.summary });
    }
  });

  it('answers --version and --help without loading the analyzer (no TypeScript compiler)', async () => {
    vi.resetModules();
    vi.doMock('typescript', () => {
      throw new Error('typescript was loaded');
    });
    try {
      // The mock is effective: anything that needs the compiler fails to load…
      await expect(import('../src/analyzer/index.js')).rejects.toThrow();
      // …while a fresh CLI still answers.
      const { runCli: fresh } = await import('../src/cli/run.js');
      expect(await cliWith(fresh, ['--version'])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
      const help = await cliWith(fresh, ['--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('cache');
      // Commands that can answer from a running server do not load the compiler up front either.
      for (const load of [
        () => import('../src/cli/commands/report.js'),
        () => import('../src/cli/commands/context.js'),
        () => import('../src/cli/commands/serve.js'),
        () => import('../src/cli/commands/cache.js'),
        () => import('../src/cli/commands/query.js'),
        () => import('../src/cli/commands/mcp.js'),
        () => import('../src/mcp/tools.js'),
        () => import('../src/cli/commands/test.js'),
        () => import('../src/cli/commands/coverage.js'),
        () => import('../src/cli/commands/review.js'),
        // --- daily-loop ---
        () => import('../src/cli/commands/status.js'),
        () => import('../src/cli/commands/hooks.js'),
        () => import('../src/cli/commands/sync.js'),
        // --- clone-radar ---
        () => import('../src/cli/commands/similar.js'),
        () => import('../src/analyzer/gates.js'),
        // --- agent-guardrails ---
        () => import('../src/cli/commands/agents.js'),
        () => import('../src/cli/commands/hook.js'),
        () => import('../src/agent/dialect.js'),
      ])
        await expect(load()).resolves.toBeDefined();
    } finally {
      vi.doUnmock('typescript');
      vi.resetModules();
    }
  });
});

describe('cli: check', () => {
  it('fails on the forbidden import and layer violation (text output)', async () => {
    const { code, stdout } = await cli('check', fullstack, '--no-git');
    expect(code).toBe(1);
    expect(stdout).toMatch(/✖ Architecture rules 2 errors, 0 warnings/);
    expect(stdout).toContain('components/UserTable.tsx:4 Components may only import the public lib modules: components/UserTable.tsx → lib/db.ts');
    expect(stdout).toContain('lib/billing.ts:1 “lib/**” must not depend on the higher layer “app/**”: lib/billing.ts → app/settings.ts');
    expect(stdout).toMatch(/✔ Declared dependencies/);
    expect(stdout).toMatch(/✔ Circular dependencies 0 \(max 0\)/); // maxCycles from the config file
    expect(stdout).toContain('1 gate failed');
  });

  it('prints machine-readable JSON with --format json', async () => {
    const { code, stdout } = await cli('check', fullstack, '--no-git', '--format', 'json');
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as CheckJson;
    expect(report).toMatchObject({ ok: false, changedOnly: false, health: expect.any(Number) });
    expect(report.gates.map((g) => [g.id, g.ok])).toEqual([
      ['rules', false],
      ['dependencies', true],
      ['cycles', true],
    ]);
    expect(report.gates[0].findings.map(({ file, line, message, severity, ruleId }) => ({ file, line, message, severity, ruleId }))).toEqual([
      { file: 'components/UserTable.tsx', line: 4, message: 'Components may only import the public lib modules: components/UserTable.tsx → lib/db.ts', severity: 'error', ruleId: 'cv/architecture-rule' },
      { file: 'lib/billing.ts', line: 1, message: '“lib/**” must not depend on the higher layer “app/**”: lib/billing.ts → app/settings.ts', severity: 'error', ruleId: 'cv/layer-violation' },
    ]);
    expect(report.mode).toBe('all');
    // Fingerprints have no line numbers and no status without a comparison.
    for (const f of report.gates[0].findings) {
      expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(f.status).toBeUndefined();
    }
  });

  it('prints GitHub Actions annotations with --format github', async () => {
    const { code, stdout } = await cli('check', fullstack, '--no-git', '--format', 'github');
    expect(code).toBe(1);
    const lines = stdout.trim().split('\n');
    // Property values are escaped like actions/toolkit does (`:` → %3A); GitHub shows them unescaped.
    expect(lines).toContain('::error file=components/UserTable.tsx,line=4,title=code-visualizer%3A Architecture rules::Components may only import the public lib modules: components/UserTable.tsx → lib/db.ts');
    expect(lines.filter((l) => l.startsWith('::error '))).toHaveLength(2);
    expect(lines[lines.length - 1]).toMatch(/^code-visualizer check: 1 gate\(s\) failed — health \d+\/100$/);
  });

  it('applies thresholds from flags', async () => {
    const react = fixtureDir('react-vite-ts');
    const json = async (...flags: string[]) => {
      const r = await cli('check', react, '--no-git', '--format', 'json', ...flags);
      return { code: r.code, report: JSON.parse(r.stdout) as CheckJson };
    };
    const lenient = await json();
    expect(lenient.code).toBe(0);
    expect(lenient.report.gates.find((g) => g.id === 'cycles')).toMatchObject({ ok: true, detail: '1' }); // reported, but no limit
    expect((await json('--max-cycles', '0')).report.gates.find((g) => g.id === 'cycles')).toMatchObject({ ok: false, detail: '1 (max 0)' });
    expect((await json('--max-cycles', '0')).code).toBe(1);
    expect((await json('--min-health', '100')).report.gates.find((g) => g.id === 'health')!.ok).toBe(false);
    // Health is a score from 0 to 100: a limit outside that range is a usage error, not a gate that can never pass.
    const outOfRange = await cli('check', react, '--no-git', '--min-health', '101');
    expect(outOfRange.code).toBe(2);
    expect(outOfRange.stderr).toContain('--min-health must be a number from 0 to 100');
    const complexity = await json('--max-complexity', '1');
    expect(complexity.code).toBe(1);
    expect(complexity.report.gates.find((g) => g.id === 'complexity')!.findings.length).toBeGreaterThan(0);
    expect((await json('--max-cycles', '1', '--min-health', '0', '--max-complexity', '100')).code).toBe(0);
  });

  it('exits 2 when the configuration file is invalid', async () => {
    const copy = copyFixture('fullstack-next', 'cv-cli-');
    fs.writeFileSync(path.join(copy, 'code-visualizer.config.json'), '{ "rules": [ ');
    const { code, stdout, stderr } = await cli('check', copy, '--no-git', '--format', 'json');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/Invalid configuration — code-visualizer\.config\.json:1:\d+: /);
  });

  it('passes a clean project and rejects invalid options', async () => {
    const clean = await cli('check', fixtureDir('next-app'), '--no-git');
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('All gates passed');
    expect((await cli('check', fullstack, '--no-git', '--format', 'xml')).code).toBe(2);
    expect((await cli('check', fullstack, '--no-git', '--max-cycles', 'many')).code).toBe(2);
    const missing = await cli('check', path.join(makeTempDir('cv-cli-'), 'nope'), '--no-git');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('is not a directory');
  });
});

describe('cli: context', () => {
  it('prints Markdown context for a file', async () => {
    const { code, stdout, stderr } = await cli('context', path.join(fullstack, 'components/UserTable.tsx'), '--root', fullstack, '--no-git');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.startsWith('# Context: components/UserTable.tsx\n')).toBe(true);
    expect(stdout).toContain('## HTTP calls');
    expect(stdout).toContain('- `GET /api/users` → served by `app/api/users/route.ts`');
    expect(stdout).not.toContain('## Source');
  });

  it('includes the source with --source and writes to a file with -o', async () => {
    const withSource = await cli('context', path.join(fullstack, 'lib/api.ts'), '--root', fullstack, '--no-git', '--source');
    expect(withSource.stdout).toContain("## Source\n\n```ts\nimport axios from 'axios';");
    const out = path.join(makeTempDir('cv-cli-'), 'context.md');
    const written = await cli('context', path.join(fullstack, 'lib/api.ts'), '--root', fullstack, '--no-git', '-o', out);
    expect(written.code).toBe(0);
    expect(written.stdout).toBe('');
    expect(written.stderr).toContain(`Wrote ${out}`);
    expect(fs.readFileSync(out, 'utf8')).toMatch(/^# Context: lib\/api\.ts\n[\s\S]*\n$/);
  });

  it('prints the project summary with --summary', async () => {
    const { code, stdout } = await cli('context', '--summary', '--root', fullstack, '--no-git');
    expect(code).toBe(0);
    expect(stdout.startsWith('# fullstack-next — architecture overview\n')).toBe(true);
    expect(stdout).toContain('## Architecture rules');
  });

  it('explains what is wrong with the arguments', async () => {
    const unknown = await cli('context', path.join(fullstack, 'README.md'), '--root', fullstack, '--no-git');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('is not an analyzed source file');
    const nothing = await cli('context');
    expect(nothing.code).toBe(2);
    expect(nothing.stderr).toContain('$ code-visualizer context');
  });
});

describe('cli: query commands', () => {
  const react = fixtureDir('react-vite-ts');
  const express = fixtureDir('express-api');
  const q = (...argv: string[]) => cli(...argv, '--no-cache', '--no-git');
  const json = async (...argv: string[]): Promise<any> => {
    const r = await q(...argv, '--json');
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it('who, uses, impact, path, route and tests-for answer with --json', async () => {
    expect(await json('who', 'lib/billing.ts', '--root', fullstack)).toMatchObject({ label: 'lib/billing.ts', owners: ['@acme/payments', 'billing-lead@acme.dev'], hasHistory: false });
    const uses = await json('uses', 'formatDate', '--root', react);
    expect(uses.sites).toEqual([expect.objectContaining({ file: 'src/components/UserCard.tsx', line: 16, kind: 'call', argc: 1 })]);
    expect((await json('refs', 'src/utils/format.ts#formatDate', '--root', react)).files).toBe(1);
    const impact = await json('impact', 'formatDate', '--root', react, '--depth', '1');
    expect(impact).toMatchObject({ precision: 'symbol', byDepth: [{ depth: 1, files: ['src/components/UserCard.tsx'] }] });
    expect(impact.truncated).toBeGreaterThan(0);
    const chain = await json('path', 'src/pages/Settings.tsx', 'math.ts', '--root', react);
    expect(chain).toMatchObject({ from: 'src/pages/Settings.tsx', to: 'src/utils/math.ts', found: true });
    expect(chain.hops.map((h: { line: number }) => h.line)).toEqual([5, 1]);
    const route = await json('route', 'GET', '/api/users/42', '--root', express);
    expect(route.matches.map((m: { label: string }) => m.label)).toEqual(['GET /api/users/:id']);
    expect(route.matches[0].handler).toEqual({ file: 'controllers/usersController.js', line: 25, symbol: 'controllers/usersController.js#getById' });
    expect(await json('tests-for', 'src/components/Button.tsx', '--root', react)).toMatchObject({ files: ['src/components/Button.test.tsx'], command: 'npx vitest run src/components/Button.test.tsx' });
  });

  it('prints readable answers with file:line locations', async () => {
    const uses = await q('uses', 'Button', '--root', react);
    expect(uses.code).toBe(0);
    expect(uses.stdout).toContain('Button  src/components/Button.tsx:10');
    expect(uses.stdout).toMatch(/src\/pages\/Settings\.tsx\n.*:2 {2}import \{ Button \} via src\/components\/index\.ts/);
    expect(uses.stdout).toMatch(/:24 {2}render in Settings/);
    const impact = await q('impact', 'GET /api/users/:id', '--root', express);
    expect(impact.code).toBe(0);
    expect(impact.stdout).toContain('file-level — routes/users.js imports the whole module');
    const route = await q('route', '/api/users/42', '--root', express);
    expect(route.stdout).toContain('Handler     controllers/usersController.js:25 getById');
    expect(route.stdout).toContain('Middleware  auth');
    const tests = await q('tests-for', 'src/utils', '--root', react);
    expect(tests.stdout).toContain('No test reaches');
    // No escape sequences for hyperlinks when stdout is not a terminal.
    expect(uses.stdout).not.toContain('\x1b]8;;');
  });

  it('exits 1 with suggestions when nothing matches, and 2 on usage errors', async () => {
    const typo = await q('uses', 'Buton', '--root', react);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain('Did you mean: Button');
    expect(JSON.parse((await q('impact', 'Buton', '--root', react, '--json')).stdout)).toMatchObject({ error: 'not-found', input: 'Buton', suggestions: expect.arrayContaining(['Button']) });
    expect((await q('route', 'POST', '/api/users/42', '--root', express)).code).toBe(1);
    expect((await q('path', 'src/utils/legacyStorage.ts', 'src/hooks/useDebounce.ts', '--root', react)).code).toBe(1);
    // Only the other way round: answered, with a note.
    const reversed = await q('path', 'src/hooks/useDebounce.ts', 'src/pages/Settings.tsx', '--root', react);
    expect(reversed.code).toBe(0);
    expect(reversed.stdout).toContain('does not import src/pages/Settings.tsx — but the other way round');
    expect((await q('tests-for', 'nope.ts', '--root', react)).code).toBe(1);
    expect((await q('uses')).code).toBe(2);
    expect((await q('path', 'a.ts')).code).toBe(2);
    expect((await q('who', 'Button', '--limit', 'x', '--root', react)).code).toBe(2);
    expect((await q('impact', 'Button', '--bogus', '--root', react)).code).toBe(2);
  });
});

describe('cli: query commands in real layouts', () => {
  const react = fixtureDir('react-vite-ts');
  const express = fixtureDir('express-api');
  const q = (...argv: string[]) => cli(...argv, '--no-cache', '--no-git');

  /** An npm-workspaces monorepo: packages/web calls fmt from packages/core. */
  const monorepo = (): string => {
    const root = makeTempDir('cv-mono-');
    fs.mkdirSync(path.join(root, '.git'));
    const put = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    };
    put('package.json', JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }));
    put('packages/core/package.json', JSON.stringify({ name: '@m/core', main: 'src/index.ts' }));
    put('packages/core/src/index.ts', 'export function fmt(x: number) {\n  return String(x);\n}\n');
    put('packages/web/package.json', JSON.stringify({ name: '@m/web', dependencies: { '@m/core': '*' } }));
    put('packages/web/src/app.ts', "import { fmt } from '@m/core';\nexport const v = fmt(1);\n");
    put('tools/standalone/package.json', JSON.stringify({ name: 'standalone' })); // not a workspace package
    return root;
  };

  it('finds the workspace root from inside a package, and paths relative to the git root', async () => {
    const root = monorepo();
    expect(findProjectRoot(path.join(root, 'packages/core/src'))).toEqual({ root, gitRoot: root });
    expect(findProjectRoot(path.join(root, 'tools/standalone'))).toEqual({ root: path.join(root, 'tools/standalone'), gitRoot: root });
    // `$(git diff --name-only)` prints paths relative to the git root, whatever the current folder.
    const location = { root, gitRoot: root };
    expect(toProjectPath(location, 'packages/web/src/app.ts', path.join(root, 'packages/core/src'))).toBe('packages/web/src/app.ts');
    expect(toProjectPath(location, '../../web/src/app.ts', path.join(root, 'packages/core/src'))).toBe('packages/web/src/app.ts');
    expect(toProjectPath(location, 'packages/core/', root)).toBe('packages/core/');
    expect(toProjectPath(location, 'GET /packages/x', root)).toBe('GET /packages/x');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'packages/core/src'));
    try {
      const uses = await q('uses', 'fmt', '--json');
      expect(uses.code, uses.stderr).toBe(0);
      expect(JSON.parse(uses.stdout).sites).toEqual([expect.objectContaining({ file: 'packages/web/src/app.ts', line: 2, kind: 'call' })]);
    } finally {
      cwd.mockRestore();
    }
  });

  it('refuses to analyze a folder that is not inside any project', async () => {
    const dir = makeTempDir('cv-noproject-');
    if (findProjectRoot(dir)) return; // something above the temp folder is a project on this machine
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const r = await q('uses', 'Button');
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Not inside a project');
    } finally {
      cwd.mockRestore();
    }
  });

  it('impact answers for the targets it knows and reports the others', async () => {
    const both = await q('impact', 'src/utils/format.ts', 'src/utils/deleted.ts', '--root', react);
    expect(both.code).toBe(0);
    expect(both.stderr).toContain('matches "src/utils/deleted.ts"');
    expect(both.stdout).toContain('Impact of src/utils/format.ts');
    const json = await q('impact', 'src/utils/format.ts', 'src/utils/deleted.ts', '--root', react, '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ unknown: [{ input: 'src/utils/deleted.ts' }], precision: 'file' });
    expect((await q('impact', 'nope1.ts', 'nope2.ts', '--root', react)).code).toBe(1);
  });

  it('keeps --json one document and reports ambiguous names', async () => {
    const path2 = await q('path', 'nope1', 'nope2', '--root', react, '--json');
    expect(path2.code).toBe(1);
    expect(JSON.parse(path2.stdout)).toMatchObject({ error: 'not-found', inputs: [{ input: 'nope1' }, { input: 'nope2' }] });
    const ambiguous = await q('uses', 'GET', '--root', fullstack, '--json');
    expect(JSON.parse(ambiguous.stdout).alternatives).toHaveLength(1);
  });

  it('rejects malformed route arguments and options of other commands', async () => {
    const lone = await q('route', 'GET', '--root', express);
    expect(lone.code).toBe(2);
    expect(lone.stderr).toContain('route needs a URL');
    expect((await q('route', 'GET', '/api/users/1', 'extra', '--root', express)).code).toBe(2);
    expect((await q('route', 'GET /api/users/1', 'extra', '--root', express)).code).toBe(2);
    const depth = await q('uses', 'Button', '--depth', '2', '--root', react);
    expect(depth.code).toBe(2);
    expect(depth.stderr).toContain('--depth is an option of impact only');
    const usage = await q('path', 'a.ts');
    expect(usage.stderr).toContain('path needs 2 targets');
    // A pasted production URL finds the local route; error handlers are listed apart.
    const prod = await q('route', 'GET', 'https://api.example.com/api/users/42', '--root', express);
    expect(prod.code).toBe(0);
    expect(prod.stdout).toContain('Middleware  auth');
    expect(prod.stdout).toContain('On error    errorHandler (middleware/errorHandler.js:2)');
  });

  it('stops quietly when the reader of the output goes away (| head)', () => {
    const stream = new EventEmitter() as unknown as NodeJS.WriteStream;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      exitOnBrokenPipe(stream);
      exitOnBrokenPipe(stream); // once per stream
      expect((stream as unknown as EventEmitter).listenerCount('error')).toBe(1);
      stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      expect(exit).toHaveBeenCalledTimes(1);
      expect(() => stream.emit('error', Object.assign(new Error('boom'), { code: 'EIO' }))).toThrow('boom');
    } finally {
      exit.mockRestore();
    }
  });

  it('editor links encode # and ?, and NO_HYPERLINKS=0 keeps them on', () => {
    expect(editorLink('/Users/me/C#/proj/a?b.ts', 3, {})).toBe('vscode://file/Users/me/C%23/proj/a%3Fb.ts:3:1');
    const tty = Object.assign(new EventEmitter(), { isTTY: true }) as unknown as NodeJS.WriteStream;
    expect(createLinker({ root: '/p', stream: tty, env: { NO_HYPERLINKS: '0' } })('a.ts', 2)).toContain('\x1b]8;;vscode://file/p/a.ts:2:1');
    expect(createLinker({ root: '/p', stream: tty, env: { NO_HYPERLINKS: '1' } })('a.ts', 2)).toBe('a.ts:2');
  });
});

describe.skipIf(!hasGit)('cli: commands that read git changes', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => restoreEnv?.());

  function repoWithHistory(): string {
    const repo = initRepo('fullstack-next');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(7), message: 'Initial import' });
    return repo;
  }

  it('pr: writes a pull-request description for uncommitted changes', async () => {
    const repo = repoWithHistory();
    editFile(repo, 'lib/db.ts', 'return [...users.values()].slice(0, MAX_USERS);', 'return [...users.values()].filter(Boolean).slice(0, MAX_USERS);');
    const { code, stdout } = await cli('pr', repo);
    expect(code).toBe(0);
    expect(stdout).toContain('## Summary');
    expect(stdout).toContain('This change touches **1 file** (+1 / −1)');
    expect(stdout).toContain('| `lib/db.ts` | modified | +1 −1 |');
    expect(stdout).toMatch(/- `listUsers` in `lib\/db\.ts`/);
    expect(stdout).toContain('- 1 related test file: `users.test.ts`');
    expect(stdout).toContain('- Run them: `npx vitest run test/users.test.ts`');
    expect(stdout).toContain('- Code owners: @acme/backend');
    expect(stdout).toContain('- Suggested reviewers (know these files best): Alice Archer');
  });

  it('pr: exits 1 when there is nothing to describe', async () => {
    const repo = repoWithHistory();
    const { code, stderr } = await cli('pr', repo);
    expect(code).toBe(1);
    expect(stderr).toContain('No changes found');
  });

  it('check --changed: fails only on what your change made worse, not on old debt next to it', async () => {
    const repo = repoWithHistory();
    editFile(repo, 'components/UserProfile.tsx', '<p>Loading…</p>', '<p>Loading user…</p>');
    const clean = await cli('check', repo, '--changed', '--format', 'json');
    expect(clean.code).toBe(0);
    const report = JSON.parse(clean.stdout) as CheckJson;
    expect(report).toMatchObject({ ok: true, changedOnly: true, mode: 'changed' });
    // The two existing violations are counted, not blamed.
    expect(report.gates.find((g) => g.id === 'rules')).toMatchObject({ ok: true, counts: { new: 0, existing: 2, fixed: 0 } });

    const risky = await cli('check', repo, '--changed', '--format', 'json', '--max-risk', '0');
    expect(risky.code).toBe(1);
    expect((JSON.parse(risky.stdout) as CheckJson).gates.find((g) => g.id === 'risk')).toMatchObject({ ok: false });

    // Editing the file that already breaks a rule (behaviour change: this used to fail the gate).
    editFile(repo, 'components/UserTable.tsx', 'list.slice(0, MAX_USERS)', 'list.slice(0, MAX_USERS - 1)');
    const touched = await cli('check', repo, '--changed', '--format', 'json');
    expect(touched.code).toBe(0);
    // `check.changedMode: "files"` restores the old behaviour: every finding in a touched file counts.
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'code-visualizer.config.json'), 'utf8')) as { check: Record<string, unknown> };
    fs.writeFileSync(path.join(repo, 'code-visualizer.config.json'), JSON.stringify({ ...config, check: { ...config.check, changedMode: 'files' } }));
    const files = await cli('check', repo, '--changed', '--format', 'json');
    expect(files.code).toBe(1);
    expect((JSON.parse(files.stdout) as CheckJson).gates.find((g) => g.id === 'rules')!.findings.map((f) => f.file)).toEqual(['components/UserTable.tsx']);
    fs.writeFileSync(path.join(repo, 'code-visualizer.config.json'), JSON.stringify(config));

    // A new forbidden import fails, and only it is new.
    editFile(repo, 'components/UserProfile.tsx', "'use client';\n", "'use client';\nimport { listUsers } from '@/lib/db';\n");
    const violating = await cli('check', repo, '--changed', '--format', 'json');
    expect(violating.code).toBe(1);
    const rules = (JSON.parse(violating.stdout) as CheckJson).gates.find((g) => g.id === 'rules')!;
    expect(rules.findings.filter((f) => f.status === 'new').map((f) => f.file)).toEqual(['components/UserProfile.tsx']);
    expect(rules.counts).toEqual({ new: 1, existing: 2, fixed: 0 });
  });

  it('diff and pr start warm: parse cache and base snapshots are kept, shown and cleared like the rest of the cache', async () => {
    const repo = repoWithHistory();
    editFile(repo, 'lib/db.ts', 'return [...users.values()].slice(0, MAX_USERS);', 'return [...users.values()].filter(Boolean).slice(0, MAX_USERS);');
    const saved = process.env.CODE_VISUALIZER_NO_CACHE;
    delete process.env.CODE_VISUALIZER_NO_CACHE;
    try {
      const first = await cli('diff', repo, '--json');
      expect(first.code).toBe(0);
      const again = await cli('diff', repo, '--json');
      expect(JSON.parse(again.stdout)).toEqual(JSON.parse(first.stdout));
      expect((await cli('pr', repo)).stdout).toContain('## Summary');

      const status = JSON.parse((await cli('cache', repo, '--json')).stdout) as { files: { name: string; kind: string }[] };
      expect(status.files.filter((f) => f.kind === 'parse')).toHaveLength(1);
      expect(status.files.filter((f) => f.kind === 'snapshot').map((f) => f.name)).toEqual([`snapshots/${git(repo, ['rev-parse', 'HEAD']).trim()}.json.gz`]);
      expect((await cli('cache', repo)).stdout).toMatch(/commits\s+1 snapshot · /);

      const cleared = JSON.parse((await cli('cache', 'clear', repo, '--json')).stdout) as { cleared: { files: number } };
      expect(cleared.cleared.files).toBe(status.files.length);
      expect(fs.existsSync(path.join(repo, '.code-visualizer', 'snapshots'))).toBe(false);

      // --no-cache: nothing is written.
      expect((await cli('diff', repo, '--json', '--no-cache')).code).toBe(0);
      expect(fs.existsSync(path.join(repo, '.code-visualizer', 'cache'))).toBe(false);
      expect(fs.existsSync(path.join(repo, '.code-visualizer', 'snapshots'))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CODE_VISUALIZER_NO_CACHE;
      else process.env.CODE_VISUALIZER_NO_CACHE = saved;
    }
  });
});

const distCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.skipIf(!fs.existsSync(distCli))('cli: built binary (dist/cli.js)', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [distCli, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CI: '1' }, timeout: 60_000 });

  it('propagates exit codes and prints parseable JSON', () => {
    const version = run('--version');
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const check = run('check', copyFixture('fullstack-next', 'cv-dist-'), '--no-git', '--format', 'json');
    expect(check.status).toBe(1);
    expect((JSON.parse(check.stdout) as CheckJson).gates.find((g) => g.id === 'rules')!.ok).toBe(false);
    expect(run('check', '--help').status).toBe(0);
  });

  it('cviz chek: a suggestion on stderr, nothing on stdout, exit 2', () => {
    const typo = run('chek');
    expect(typo.status).toBe(2);
    expect(typo.stdout).toBe('');
    expect(typo.stderr).toContain('Did you mean "check"');
  });

  it('report -o into a folder it cannot write: a clean message and exit 2, no stack trace', () => {
    const root = copyFixture('react-vite-ts', 'cv-dist-out-');
    const blocker = path.join(makeTempDir('cv-dist-out-'), 'a-file');
    fs.writeFileSync(blocker, '');
    const targets = [path.join(blocker, 'x.html'), ...(process.platform === 'darwin' ? ['/System/x.html'] : [])];
    for (const target of targets) {
      const r = run('report', root, '--no-git', '--no-cache', '--no-open', '-q', '-o', target);
      expect(r.status, target).toBe(2);
      expect(r.stderr).toContain(`✖ Cannot write ${target}`);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
  });

  it('serve --port 0 listens on a free port and records it in server.json', async () => {
    const root = copyFixture('react-vite-ts', 'cv-dist-serve-');
    const child = spawn(process.execPath, [distCli, 'serve', root, '--port', '0', '--no-open', '--no-git', '--no-cache'], { env: { ...process.env, NO_COLOR: '1', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`no "Live at" line:\n${out}`)), 60_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          out += chunk;
          const m = /Live at http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
          if (m) {
            clearTimeout(timer);
            resolve(Number(m[1]));
          }
        });
        child.once('exit', (code) => reject(new Error(`serve exited with ${code}:\n${out}`)));
      });
      expect(port).toBeGreaterThan(0);
      const info = JSON.parse(fs.readFileSync(path.join(root, '.code-visualizer/server.json'), 'utf8')) as { port: number; pid: number };
      expect(info).toMatchObject({ port, pid: child.pid });
    } finally {
      // Only the server this test started.
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }, 90_000);

  it('serves MCP over stdio: only protocol lines on stdout, answers what was asked, exits when stdin closes', () => {
    const root = copyFixture('react-vite-ts', 'cv-dist-mcp-');
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dist-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tests_for', arguments: { paths: ['src/components/Button.tsx'] } } },
    ];
    const res = spawnSync(process.execPath, [distCli, 'mcp', root, '--no-git'], { input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n', encoding: 'utf8', timeout: 60_000 });
    expect(res.status).toBe(0);
    const out = res.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown[]; structuredContent?: unknown } });
    expect(out.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(out[1].result!.tools!.length).toBeLessThanOrEqual(9);
    expect(out[2].result!.structuredContent).toMatchObject({ command: 'npx vitest run src/components/Button.test.tsx' });
    expect(res.stderr).toContain('MCP server for');
  });
});

describe('cli: warm cache', () => {
  /** The test environment turns the cache off (CODE_VISUALIZER_NO_CACHE); these tests turn it back on. */
  async function withCache<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.CODE_VISUALIZER_NO_CACHE;
    delete process.env.CODE_VISUALIZER_NO_CACHE;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.CODE_VISUALIZER_NO_CACHE;
      else process.env.CODE_VISUALIZER_NO_CACHE = saved;
    }
  }

  interface StatusJson {
    root: string;
    totalBytes: number;
    files: { name: string; kind: string; entries?: number; current?: boolean }[];
    server: unknown;
    state: string[];
    disabled: boolean;
  }

  it('analyzing commands fill the cache; "cache status" and "cache clear" show and remove it', async () => {
    const copy = copyFixture('fullstack-next', 'cv-cli-cache-');
    await withCache(async () => {
      const empty = JSON.parse((await cli('cache', 'status', copy, '--json')).stdout) as StatusJson;
      expect(empty).toMatchObject({ root: copy, files: [], server: null, disabled: false });

      expect((await cli('check', copy, '--no-git', '--format', 'json')).code).toBe(1);
      const warm = await cli('check', copy, '--no-git', '--format', 'json');
      expect(warm.code).toBe(1);
      expect((JSON.parse(warm.stdout) as CheckJson).gates.find((g) => g.id === 'rules')!.ok).toBe(false);

      const status = JSON.parse((await cli('cache', copy, '--json')).stdout) as StatusJson;
      expect(status.files).toEqual([expect.objectContaining({ kind: 'parse', current: true, entries: 16 })]);
      const text = await cli('cache', copy);
      expect(text.code).toBe(0);
      expect(text.stdout).toMatch(/Cache\s+.*cache · 1 file · /);
      expect(text.stdout).toMatch(/parse\s+16 files · /);
      expect(text.stdout).toContain('not running');

      const cleared = await cli('cache', 'clear', copy, '--json');
      expect(cleared.code).toBe(0);
      expect(JSON.parse(cleared.stdout)).toEqual({ root: copy, cleared: { files: 1, bytes: status.totalBytes } });
      expect(fs.existsSync(path.join(copy, '.code-visualizer', 'cache'))).toBe(false);
      expect((await cli('cache', 'clear', copy)).stdout).toContain('Nothing to clear');
    });
  });

  it('--no-cache (and CODE_VISUALIZER_NO_CACHE) run cold and write no cache', async () => {
    const copy = copyFixture('fullstack-next', 'cv-cli-cache-');
    await withCache(async () => {
      expect((await cli('check', copy, '--no-git', '--no-cache', '--format', 'json')).code).toBe(1);
      expect((await cli('context', '--summary', '--root', copy, '--no-git', '--no-cache')).code).toBe(0);
      expect((await cli('report', copy, '--no-git', '--no-cache', '--no-open', '-q', '-o', path.join(makeTempDir('cv-cli-out-'), 'r.html'))).code).toBe(0);
      expect(fs.existsSync(path.join(copy, '.code-visualizer', 'cache'))).toBe(false);
    });
    expect((await cli('check', copy, '--no-git', '--format', 'json')).code).toBe(1); // the env var is set in tests
    expect(fs.existsSync(path.join(copy, '.code-visualizer', 'cache'))).toBe(false);
    const status = JSON.parse((await cli('cache', copy, '--json')).stdout) as StatusJson;
    expect(status.disabled).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('"cache clear" reports a folder it cannot remove instead of crashing', async () => {
    const copy = copyFixture('express-api', 'cv-cli-cache-');
    const dir = path.join(copy, '.code-visualizer', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'parse-x.json.gz'), 'x');
    fs.chmodSync(dir, 0o555);
    try {
      const text = await cli('cache', 'clear', copy);
      expect(text.code).toBe(1);
      expect(text.stderr).toMatch(/✖ Could not clear .*cache: E[A-Z]+/);
      expect(text.stderr).not.toContain('    at ');
      const json = await cli('cache', 'clear', copy, '--json');
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ root: copy, error: expect.stringContaining('Could not clear') });
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('"cache status" tells a registered but unresponsive server from no server', async () => {
    const copy = copyFixture('express-api', 'cv-cli-cache-');
    // Accepts connections but never answers (a server busy re-analyzing, or stopped with SIGSTOP).
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as net.AddressInfo).port;
    try {
      writeServerInfo(copy, { pid: process.pid, port, host: '127.0.0.1', token: 't', root: copy, version: VERSION, startedAt: Date.now() });
      const json = JSON.parse((await cli('cache', copy, '--json')).stdout) as StatusJson;
      expect(json.server).toMatchObject({ status: 'busy', pid: process.pid, port });
      const text = await cli('cache', copy);
      expect(text.stdout).toContain(`registered (pid ${process.pid}) but not responding`);
      expect(fs.existsSync(path.join(copy, '.code-visualizer', 'server.json'))).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it('rejects unknown actions and missing folders', async () => {
    const typo = await cli('cache', 'stats');
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('Unknown cache action "stats"');
    expect((await cli('cache', 'status', '.', 'extra')).code).toBe(2);
    expect((await cli('cache', '--bogus')).code).toBe(2);
    const missing = await cli('cache', 'status', path.join(makeTempDir('cv-cli-'), 'nope'));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('is not a directory');
  });
});
