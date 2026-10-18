import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { commitAll, daysAgo, git, hasGit, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Run the CLI in-process and capture what it writes. */
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

const PRIVATE_VALUE = 'value-that-must-never-leak';

/** Reads five variables; the template documents one of them, a private .env holds another. */
function envProject(documentAll = false): string {
  const root = makeTempDir('cv-env-cli-');
  writeFile(root, 'package.json', JSON.stringify({ name: 'app' }));
  writeFile(
    root,
    'src/config.ts',
    ['export const url = process.env.DATABASE_URL;', 'export const port = Number(process.env.PORT) || 3000;', 'export const stripe = process.env.STRIPE_SECRET;', 'export const token = import.meta.env.VITE_API_TOKEN;'].join('\n'),
  );
  writeFile(root, '.env.example', documentAll ? 'DATABASE_URL=\nSTRIPE_SECRET=\nVITE_API_TOKEN=\nOLD_FLAG=\n' : 'DATABASE_URL=\nOLD_FLAG=\n');
  writeFile(root, '.env', `STRIPE_SECRET=${PRIVATE_VALUE}\n`);
  return root;
}

describe('env command', () => {
  it('lists what needs attention and what is fine, with where it is read', async () => {
    const { code, stdout } = await cli('env', '--root', envProject());
    expect(code).toBe(0);
    expect(stdout).toContain('4 variables read by the code');
    expect(stdout).toMatch(/✖ STRIPE_SECRET\s+1 use\s+only in \.env, which is not shared/);
    expect(stdout).toMatch(/✖ VITE_API_TOKEN\s+1 use\s+a secret that reaches the browser bundle/);
    expect(stdout).toMatch(/✔ DATABASE_URL\s+1 use\s+documented in \.env\.example/);
    expect(stdout).toMatch(/✔ PORT\s+1 use\s+optional: the code has a default/);
    expect(stdout).toContain('src/config.ts:3');
    expect(stdout).toContain('declared in a template but never read: OLD_FLAG');
    // Problems first.
    expect(stdout.indexOf('STRIPE_SECRET')).toBeLessThan(stdout.indexOf('DATABASE_URL'));
    expect(stdout).not.toContain(PRIVATE_VALUE);
  });

  it('shows only the problems with --missing', async () => {
    const { stdout } = await cli('env', '--root', envProject(), '--missing');
    expect(stdout).toContain('STRIPE_SECRET');
    expect(stdout).not.toMatch(/✔ DATABASE_URL/);
  });

  it('fails --check on undocumented variables and passes when everything is written down', async () => {
    expect((await cli('env', '--root', envProject(), '--check')).code).toBe(1);
    const documented = await cli('env', '--root', envProject(true), '--check');
    // The template documents them all, but VITE_API_TOKEN still reaches the browser.
    expect(documented.code).toBe(1);
    expect(documented.stdout).not.toContain('no template documents');
    expect(documented.stdout).toContain('exposed to the browser: VITE_API_TOKEN');
  });

  it('prints the full report as JSON', async () => {
    const { code, stdout } = await cli('env', '--root', envProject(), '--json');
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { ok: boolean; undocumented: string[]; unused: string[]; exposedSecrets: string[]; vars: { name: string }[] };
    expect(json.ok).toBe(false);
    expect(json.undocumented).toEqual(['STRIPE_SECRET', 'VITE_API_TOKEN']);
    expect(json.unused).toEqual(['OLD_FLAG']);
    expect(json.exposedSecrets).toEqual(['VITE_API_TOKEN']);
    expect(stdout).not.toContain(PRIVATE_VALUE);
  });

  it('writes a .env.example from the code', async () => {
    const root = envProject();
    const printed = await cli('env', '--root', root, '--example');
    expect(printed.code).toBe(0);
    expect(printed.stdout).toContain('STRIPE_SECRET=\n');
    expect(printed.stdout).toContain('PORT=\n');
    expect(printed.stdout).not.toContain(PRIVATE_VALUE);

    const file = path.join(root, 'out', '.env.example');
    const written = await cli('env', '--root', root, '--example', '--missing', '--output', file);
    expect(written.code).toBe(0);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('STRIPE_SECRET=');
    expect(text).not.toContain('DATABASE_URL=');
  });

  it('says so when there is nothing to report', async () => {
    const root = makeTempDir('cv-env-cli-none-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'app' }));
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    const { code, stdout } = await cli('env', '--root', root);
    expect(code).toBe(0);
    expect(stdout).toContain('No environment variables');
  });

  it('rejects options that do not fit together', async () => {
    const root = envProject();
    expect((await cli('env', '--root', root, '--output', 'x')).code).toBe(2);
    expect((await cli('env', '--root', root, '--example', '--json')).code).toBe(2);
    expect((await cli('env', '--bogus')).code).toBe(2);
  });

  it('prints its help', async () => {
    const { code, stdout } = await cli('env', '--help');
    expect(code).toBe(0);
    expect(stdout).toContain('code-visualizer env');
    expect(stdout).toContain('--example');
  });
});

describe.runIf(hasGit)('release command', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  /** A published library tagged v1.0.0 whose next commit removes an export while calling itself a fix. */
  function library(): string {
    const root = makeTempDir('cv-release-cli-');
    git(root, ['init', '-q', '-b', 'main']);
    writeFile(root, 'package.json', JSON.stringify({ name: 'lib', version: '1.0.0', main: 'src/index.ts' }));
    writeFile(root, 'src/index.ts', 'export const keep = 1;\nexport const drop = 2;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(9), message: 'feat: first release' });
    git(root, ['tag', 'v1.0.0']);
    writeFile(root, 'src/index.ts', 'export const keep = 1;\n');
    commitAll(root, { author: 'Grace', date: daysAgo(1), message: 'fix: tidy the exports (#8)' });
    return root;
  }

  it('suggests the version and explains why, with the API change and the readiness checks', async () => {
    const { code, stdout } = await cli('release', '--root', library());
    expect(code).toBe(0);
    expect(stdout).toContain('Release since v1.0.0');
    expect(stdout).toContain('1 commit: 1 fix');
    expect(stdout).toMatch(/Suggested bump\s+MAJOR\s+1\.0\.0 → 2\.0\.0/);
    expect(stdout).toContain('1 breaking change to the published API (drop)');
    expect(stdout).toMatch(/✖ removed\s+drop\s+src\/index\.ts/);
    expect(stdout).toContain('✔ Working tree is clean');
  });

  it('prints only the version with --quiet', async () => {
    expect((await cli('release', '--root', library(), '--quiet')).stdout).toBe('2.0.0\n');
  });

  it('prints the release notes, to the terminal or to a file', async () => {
    const root = library();
    const printed = await cli('release', '--root', root, '--notes');
    expect(printed.code).toBe(0);
    expect(printed.stdout).toMatch(/^## v2\.0\.0 \(\d{4}-\d\d-\d\d\)/);
    expect(printed.stdout).toContain('### ⚠ Breaking changes');
    expect(printed.stdout).toContain('removed `drop`');
    expect(printed.stdout).toContain('tidy the exports (#8)');
    expect(printed.stdout).toContain('Thanks to Grace.');

    const file = path.join(root, 'notes', 'NEXT.md');
    expect((await cli('release', '--root', root, '--notes', '--output', file)).code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toContain('## v2.0.0');
  });

  it('prints the plan as JSON', async () => {
    const { code, stdout } = await cli('release', '--root', library(), '--json');
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { ok: boolean; tag: string; commitCount: number; bump: { level: string; next: string } };
    expect(json).toMatchObject({ ok: true, tag: 'v1.0.0', commitCount: 1, bump: { level: 'major', next: '2.0.0' } });
  });

  it('fails --check while the working tree has uncommitted work', async () => {
    const root = library();
    expect((await cli('release', '--root', root, '--check')).code).toBe(0);
    writeFile(root, 'src/wip.ts', 'export const wip = 1;\n');
    const dirty = await cli('release', '--root', root, '--check');
    expect(dirty.code).toBe(1);
    expect(dirty.stdout).toContain('✖ 1 uncommitted file');
  });

  it('starts from the tag or commit you name, and rejects one that does not exist', async () => {
    const root = library();
    const since = await cli('release', '--root', root, '--since', 'v1.0.0', '--json');
    expect(JSON.parse(since.stdout)).toMatchObject({ tag: 'v1.0.0', commitCount: 1 });
    const unknown = await cli('release', '--root', root, '--since', 'no-such-tag');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('no-such-tag');
  });

  it('explains how to start in a project without a version tag', async () => {
    const root = makeTempDir('cv-release-cli-untagged-');
    git(root, ['init', '-q', '-b', 'main']);
    writeFile(root, 'package.json', JSON.stringify({ name: 'lib', version: '0.1.0' }));
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'init' });
    const { code, stdout } = await cli('release', '--root', root);
    expect(code).toBe(0);
    expect(stdout).toContain('no version tag yet');
    expect(stdout).toContain('git tag v0.1.0');
  });

  it('refuses a folder that is not a git repository', async () => {
    const root = makeTempDir('cv-release-cli-nogit-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'lib' }));
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    const { code, stderr } = await cli('release', '--root', root);
    expect(code).toBe(1);
    expect(stderr).toContain('not a git repository');
  });

  it('rejects options that do not fit together', async () => {
    const root = library();
    expect((await cli('release', '--root', root, '--output', 'x')).code).toBe(2);
    expect((await cli('release', '--root', root, '--notes', '--json')).code).toBe(2);
    expect((await cli('release', '--root', root, '--since', ' ')).code).toBe(2);
  });

  it('prints its help', async () => {
    const { code, stdout } = await cli('release', '--help');
    expect(code).toBe(0);
    expect(stdout).toContain('code-visualizer release');
    expect(stdout).toContain('--since');
  });
});
