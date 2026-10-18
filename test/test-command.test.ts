/**
 * `code-visualizer test`: command lines that fit cmd.exe on Windows (long selections are split or run as
 * the whole suite), the same per-workspace command as tests-for and impact, and repositories without
 * commits (every file is new, so test, pr and check agree).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { selectTests, type SelectionData } from '../src/analyzer/test-select.js';
import { planForPlatform } from '../src/cli/commands/test.js';
import { runCli } from '../src/cli/run.js';
import { buildTestCommand, fitCommandLines, runnerArgv, windowsLineLength, WINDOWS_LINE_BUDGET } from '../src/shared/testcmd.js';
import type { FileInfo, TestCommand } from '../src/shared/types.js';
import { commitAll, copyFixture, daysAgo, git, hasGit, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sink: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
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

afterAll(removeTempDirs);

/** A project whose `packages/web` (vitest) has `total` test files with long paths, `changed` of them changed. */
function project(total: number): SelectionData {
  const deep = 'src/features/checkout/payment-providers/international/very-long-folder-name-for-windows';
  const files = Array.from({ length: total }, (_, i) => ({ id: `packages/web/${deep}/payment-provider-${String(i).padStart(4, '0')}.test.ts`, kind: 'test', assets: [] }) as unknown as FileInfo);
  return { files, edges: [], routes: [], project: { testRunners: { '': { unit: 'vitest' }, 'packages/web': { unit: 'vitest', pm: 'pnpm' } }, workspaces: ['packages/web'] } };
}

describe('Windows command lines', () => {
  it('splits 500 long paths into several commands under 8,000 characters, each file once', () => {
    const data = project(2000);
    const changed = data.files.slice(0, 500).map((f) => f.id);
    const plan = selectTests(data, changed, { full: false });
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0].display.length).toBeGreaterThan(8191); // one line would not even start on cmd.exe

    const win = planForPlatform(plan, data, { platform: 'win32' });
    expect(win.commands.length).toBeGreaterThan(1);
    for (const c of win.commands) {
      expect(c.display.length).toBeLessThan(8000);
      expect(windowsLineLength(c.argv)).toBeLessThanOrEqual(WINDOWS_LINE_BUDGET);
      expect(c).toMatchObject({ cwd: 'packages/web', runner: 'vitest' });
      expect(c.display.startsWith('(cd packages/web && pnpm exec vitest run ')).toBe(true);
      // Package-relative paths in argv, project-relative in files.
      expect(c.argv.slice(4)).toEqual(c.files.map((f) => f.slice('packages/web/'.length)));
    }
    const all = win.commands.flatMap((c) => c.files);
    expect(all).toHaveLength(500);
    expect(new Set(all)).toEqual(new Set(changed));
    // Elsewhere the plan stays as it is (no shell, no line limit).
    expect(planForPlatform(plan, data, { platform: 'linux' })).toBe(plan);
    expect(planForPlatform(plan, data, { platform: 'darwin' })).toBe(plan);
  });

  it('runs the whole suite of a package when the selection is at least 80% of its tests', () => {
    const data = project(600);
    const plan = selectTests(data, data.files.slice(0, 500).map((f) => f.id), { full: false });
    const win = planForPlatform(plan, data, { platform: 'win32', coverage: true });
    expect(win.commands).toEqual([
      {
        cwd: 'packages/web',
        runner: 'vitest',
        argv: ['pnpm', 'exec', 'vitest', 'run', '--coverage'],
        display: '(cd packages/web && pnpm exec vitest run --coverage)',
        files: [],
        full: true,
      },
    ]);
  });

  it('keeps short commands, and never runs the root runner over packages that have their own', () => {
    const short: TestCommand = { cwd: '', runner: 'vitest', argv: ['npx', 'vitest', 'run', 'a.test.ts'], display: 'npx vitest run a.test.ts', files: ['a.test.ts'] };
    const argvFor = (c: TestCommand, files: string[]) => runnerArgv(c.runner, undefined, files);
    expect(fitCommandLines([short], { argvFor })[0]).toBe(short);
    // A root command that is too long but whose suite must not run: split, not run in full.
    const files = Array.from({ length: 400 }, (_, i) => `test/some/deeply/nested/folder/structure/for/the/root/runner/spec-${i}.test.ts`);
    const long: TestCommand = { cwd: '', runner: 'vitest', argv: argvFor({ ...short }, files)!, display: '', files };
    const fitted = fitCommandLines([long], { argvFor, suiteSize: () => undefined });
    expect(fitted.length).toBeGreaterThan(1);
    expect(fitted.every((c) => !c.full && windowsLineLength(c.argv) <= WINDOWS_LINE_BUDGET)).toBe(true);
    expect(fitted.flatMap((c) => c.files)).toEqual(files);
    // Cypress takes its specs as one comma-separated argument: split too.
    const specs = files.map((f) => f.replace('.test.ts', '.cy.ts'));
    const cypress: TestCommand = { cwd: '', runner: 'cypress', argv: runnerArgv('cypress', undefined, specs)!, display: '', files: specs };
    const parts = fitCommandLines([cypress], { argvFor });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.argv.slice(0, 4)).toEqual(['npx', 'cypress', 'run', '--spec']);
    expect(parts.flatMap((p) => p.argv[4].split(','))).toEqual(specs);
  });
});

describe('the same command everywhere', () => {
  it('buildTestCommand runs each file from the package that declares its runner, like test does', () => {
    // The root also "sees" the workspace's vitest; the package still runs it from its own folder.
    const runners = { '': { unit: 'vitest' }, 'packages/web': { unit: 'vitest' }, 'packages/api': { unit: 'jest' } };
    expect(buildTestCommand(['packages/web/src/greeting.test.ts', 'packages/api/test/users.test.js'], runners)).toEqual({
      command: '(cd packages/api && npx jest --runTestsByPath test/users.test.js) && (cd packages/web && npx vitest run src/greeting.test.ts)',
      runner: 'jest + vitest',
    });
  });

  describe.skipIf(!hasGit)('in a workspace monorepo (monorepo-ws)', () => {
    let restoreGit: () => void;
    beforeAll(() => {
      restoreGit = isolateGit();
    });
    afterAll(() => restoreGit());

    it('tests-for and test print the same command', async () => {
      const repo = copyFixture('monorepo-ws', 'cv-mono-');
      git(repo, ['init', '-q', '-b', 'main']);
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'initial' });
      fs.appendFileSync(path.join(repo, 'packages/web/src/format.ts'), '\nexport const shout = (s: string): string => s.toUpperCase();\n');
      const testsFor = await cli('tests-for', 'packages/web/src/format.ts', '--root', repo, '--json', '--no-cache');
      expect(testsFor.code, testsFor.stderr).toBe(0);
      const plan = await cli('test', repo, '--dry-run', '--json', '--no-cache');
      expect(plan.code, plan.stderr).toBe(0);
      const command = (JSON.parse(plan.stdout) as { commands: TestCommand[] }).commands.map((c) => c.display).join(' && ');
      expect(command).toBe('(cd packages/web && npx vitest run src/greeting.test.ts)');
      expect(JSON.parse(testsFor.stdout).command).toBe(command);
    });
  });
});

describe.skipIf(!hasGit)('a repository without commits', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  it('treats every file as new: test selects the staged and the untracked test, pr describes them', async () => {
    const repo = path.join(makeTempDir('cv-unborn-'), 'app');
    writeFile(repo, 'package.json', JSON.stringify({ name: 'app', private: true, scripts: { test: 'vitest' }, devDependencies: { vitest: '^2.1.1' } }));
    writeFile(repo, 'src/sum.ts', 'export const sum = (a: number, b: number): number => a + b;\n');
    writeFile(repo, 'src/sum.test.ts', "import { sum } from './sum';\nimport { expect, it } from 'vitest';\nit('adds', () => expect(sum(1, 2)).toBe(3));\n");
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', 'package.json', 'src/sum.ts', 'src/sum.test.ts']);
    writeFile(repo, 'src/extra.test.ts', "import { sum } from './sum';\nimport { expect, it } from 'vitest';\nit('adds zero', () => expect(sum(1, 0)).toBe(1));\n");
    expect(() => git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).toThrow();

    const test = await cli('test', repo, '--dry-run', '--json', '--no-cache');
    expect(test.code, test.stderr).toBe(0);
    const plan = JSON.parse(test.stdout) as { selected: { file: string; reason: string }[]; changed: string[] };
    expect(plan.changed).toEqual(expect.arrayContaining(['src/sum.ts', 'src/sum.test.ts', 'src/extra.test.ts']));
    expect(plan.selected.map((s) => s.file).sort()).toEqual(['src/extra.test.ts', 'src/sum.test.ts']);

    const pr = await cli('pr', repo);
    expect(pr.code, pr.stderr).toBe(0);
    expect(pr.stdout).toContain('src/sum.ts');
    expect(pr.stdout).toContain('src/extra.test.ts');
  });
});
