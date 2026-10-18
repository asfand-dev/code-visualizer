import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { isEnvFileName, readEnvFiles } from '../src/analyzer/env.js';
import { buildEnvReport, envExampleText, envStatus, isEnvTemplateName, MAX_ENV_USES, parseEnvNames } from '../src/shared/env.js';
import type { EnvFile, EnvRead } from '../src/shared/types.js';
import { commitAll, daysAgo, git, hasGit, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const read = (name: string, extra: Partial<EnvRead> = {}): EnvRead => ({ name, line: 1, access: 'process.env', ...extra });
const dotenv = (path: string, names: string[], template = false): EnvFile => ({ path, template, names });

describe('parseEnvNames', () => {
  it('reads names and ignores values, comments and blank lines', () => {
    const text = ['# comment', '', 'DATABASE_URL=postgres://u:p@h/db', 'export API_KEY="abc"', '  PORT = 3000', 'EMPTY=', 'not a var', '=novalue', 'DATABASE_URL=again'].join('\n');
    expect(parseEnvNames(text)).toEqual(['DATABASE_URL', 'API_KEY', 'PORT', 'EMPTY']);
  });

  it('handles Windows line endings', () => {
    expect(parseEnvNames('A=1\r\nB=2\r\n')).toEqual(['A', 'B']);
  });
});

describe('dotenv file names', () => {
  it('recognises dotenv files and templates', () => {
    for (const name of ['.env', '.env.local', '.env.production', '.env.example', 'env.example', 'example.env']) expect(isEnvFileName(name)).toBe(true);
    for (const name of ['env.d.ts', '.env.json', 'environment.ts', 'README.md', '.envrc']) expect(isEnvFileName(name)).toBe(false);
    for (const name of ['.env.example', '.env.sample', '.env.template', 'env.example', 'example.env', '.env.defaults']) expect(isEnvTemplateName(name)).toBe(true);
    for (const name of ['.env', '.env.local', '.env.production']) expect(isEnvTemplateName(name)).toBe(false);
  });
});

describe('buildEnvReport', () => {
  it('joins what the code reads with what the templates declare', () => {
    const report = buildEnvReport(
      [
        { file: 'src/db.ts', reads: [read('DATABASE_URL', { line: 3 }), read('POOL_SIZE', { fallback: true })] },
        { file: 'src/api.ts', reads: [read('DATABASE_URL', { line: 9 }), read('STRIPE_SECRET')] },
      ],
      [dotenv('.env.example', ['DATABASE_URL', 'LEGACY_FLAG'], true), dotenv('.env', ['STRIPE_SECRET'])],
    );
    const database = report.vars.find((v) => v.name === 'DATABASE_URL')!;
    expect(database).toMatchObject({ useCount: 2, fileCount: 2, documented: true, required: true, declaredIn: ['.env.example'] });
    expect(database.uses.map((u) => `${u.file}:${u.line}`)).toEqual(['src/api.ts:9', 'src/db.ts:3']);
    expect(report.undocumented).toEqual(['STRIPE_SECRET']); // declared, but only in a private .env
    expect(report.unused).toEqual(['LEGACY_FLAG']);
  });

  it('does not ask for variables the code has a default for, nor platform ones', () => {
    const report = buildEnvReport([{ file: 'a.ts', reads: [read('POOL_SIZE', { fallback: true }), read('NODE_ENV'), read('GITHUB_SHA'), read('CI')] }], []);
    expect(report.undocumented).toEqual([]);
    expect(report.vars.find((v) => v.name === 'NODE_ENV')?.platform).toBe(true);
    expect(report.vars.find((v) => v.name === 'POOL_SIZE')?.required).toBe(false);
  });

  it('treats a variable as required when any read has no default', () => {
    const report = buildEnvReport([{ file: 'a.ts', reads: [read('A', { fallback: true }), read('A', { line: 2 })] }], []);
    expect(report.vars[0].required).toBe(true);
  });

  it('flags secrets that reach the browser, but not keys that are public by design', () => {
    const report = buildEnvReport(
      [
        {
          file: 'src/client.ts',
          reads: [
            read('VITE_ADMIN_TOKEN', { access: 'import.meta.env' }),
            read('NEXT_PUBLIC_API_SECRET'),
            read('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'),
            read('VITE_SUPABASE_ANON_KEY', { access: 'import.meta.env' }),
            read('SERVER_ONLY_TOKEN'),
          ],
        },
      ],
      [],
    );
    expect(report.exposedSecrets).toEqual(['NEXT_PUBLIC_API_SECRET', 'VITE_ADMIN_TOKEN']);
  });

  it('knows Vite built-ins only in import.meta.env', () => {
    const viaMeta = buildEnvReport([{ file: 'a.ts', reads: [read('MODE', { access: 'import.meta.env' })] }], []);
    const viaProcess = buildEnvReport([{ file: 'a.ts', reads: [read('MODE')] }], []);
    expect(viaMeta.vars[0].platform).toBe(true);
    expect(viaMeta.undocumented).toEqual([]);
    expect(viaProcess.undocumented).toEqual(['MODE']);
  });

  it('keeps the real count when a variable is read in many places', () => {
    const many = Array.from({ length: MAX_ENV_USES + 20 }, (_, i) => read('POPULAR', { line: i + 1 }));
    const [popular] = buildEnvReport([{ file: 'a.ts', reads: many }], []).vars;
    expect(popular.useCount).toBe(MAX_ENV_USES + 20);
    expect(popular.uses).toHaveLength(MAX_ENV_USES);
  });

  it('is empty for no input', () => {
    expect(buildEnvReport([], [])).toEqual({ vars: [], files: [], undocumented: [], unused: [], exposedSecrets: [] });
  });
});

describe('envStatus', () => {
  const report = buildEnvReport(
    [
      {
        file: 'src/a.ts',
        reads: [read('DOCUMENTED'), read('PRIVATE_ONLY'), read('MISSING'), read('WITH_DEFAULT', { fallback: true }), read('NODE_ENV'), read('VITE_LEAK_TOKEN', { access: 'import.meta.env' })],
      },
    ],
    [dotenv('.env.example', ['DOCUMENTED', 'VITE_LEAK_TOKEN'], true), dotenv('.env', ['PRIVATE_ONLY'])],
  );
  const statusOf = (name: string) => envStatus(report.vars.find((v) => v.name === name)!, report);

  it('names what each variable needs', () => {
    expect(statusOf('DOCUMENTED')).toEqual({ kind: 'documented', ok: true, note: 'documented in .env.example' });
    expect(statusOf('WITH_DEFAULT')).toMatchObject({ kind: 'optional', ok: true });
    expect(statusOf('NODE_ENV')).toMatchObject({ kind: 'platform', ok: true });
    expect(statusOf('PRIVATE_ONLY')).toEqual({ kind: 'private-only', ok: false, note: 'only in .env, which is not shared' });
    expect(statusOf('MISSING')).toEqual({ kind: 'undocumented', ok: false, note: 'not in any .env.example' });
  });

  it('puts a secret in the browser above everything else, documented or not', () => {
    expect(statusOf('VITE_LEAK_TOKEN')).toMatchObject({ kind: 'exposed-secret', ok: false });
  });

  it('says so when the project has no dotenv file at all', () => {
    const bare = buildEnvReport([{ file: 'a.ts', reads: [read('LONELY')] }], []);
    expect(envStatus(bare.vars[0], bare).note).toContain('there is none');
  });
});

describe('envExampleText', () => {
  const report = buildEnvReport(
    [{ file: 'src/a.ts', reads: [read('DATABASE_URL', { line: 4 }), read('PORT', { fallback: true }), read('NODE_ENV'), read('VITE_KEY', { access: 'import.meta.env' })] }],
    [dotenv('.env.example', ['DATABASE_URL'], true)],
  );

  it('lists required variables before optional ones, without values and without platform variables', () => {
    const text = envExampleText(report);
    expect(text).toContain('DATABASE_URL=\n');
    expect(text).toContain('PORT=\n');
    expect(text).not.toContain('NODE_ENV');
    expect(text.indexOf('DATABASE_URL')).toBeLessThan(text.indexOf('PORT'));
    expect(text).toContain('src/a.ts:4');
    expect(text).toContain('exposed to the browser');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('can list only the variables no template declares yet', () => {
    const text = envExampleText(report, { onlyMissing: true });
    expect(text).not.toContain('DATABASE_URL=');
    expect(text).toContain('VITE_KEY=');
  });
});

afterAll(removeTempDirs);

describe.runIf(hasGit)('readEnvFiles', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  it('reads names from the root and from workspaces, and nothing else', async () => {
    const root = makeTempDir('cv-env-');
    writeFile(root, '.env', 'SECRET_VALUE_ONE=hunter2\n');
    writeFile(root, '.env.example', 'API_URL=\n');
    writeFile(root, 'apps/web/.env.local', 'WEB_FLAG=1\n');
    writeFile(root, 'src/.env', 'NOT_SCANNED=1\n');
    writeFile(root, 'env.d.ts', 'declare const a: string;\n');
    const files = await readEnvFiles(root, ['apps/web'], false);
    expect(files.map((f) => [f.path, f.template, f.names])).toEqual([
      ['.env', false, ['SECRET_VALUE_ONE']],
      ['.env.example', true, ['API_URL']],
      ['apps/web/.env.local', false, ['WEB_FLAG']],
    ]);
    expect(JSON.stringify(files)).not.toContain('hunter2');
  });

  it('counts a dotenv file git tracks as documentation', async () => {
    const root = makeTempDir('cv-env-git-');
    git(root, ['init', '-q', '-b', 'main']);
    writeFile(root, '.env.production', 'PUBLIC_URL=\n');
    writeFile(root, '.env', 'LOCAL_ONLY=1\n');
    writeFile(root, '.gitignore', '.env\n');
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'init' });
    const files = await readEnvFiles(root, [], true);
    expect(files.find((f) => f.path === '.env.production')?.template).toBe(true);
    expect(files.find((f) => f.path === '.env')?.template).toBe(false);
    // Without git there is no way to know.
    expect((await readEnvFiles(root, [], false)).find((f) => f.path === '.env.production')?.template).toBe(false);
  });

  it('skips a dotenv file too large to be one', async () => {
    const root = makeTempDir('cv-env-big-');
    writeFile(root, '.env', `${'A=1\n'.repeat(100_000)}`);
    expect(await readEnvFiles(root, [], false)).toEqual([]);
  });
});

describe('environment variables in an analysis', () => {
  const PRIVATE_VALUE = 'value-that-must-never-leak';

  function project(): string {
    const root = makeTempDir('cv-env-analysis-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0' }));
    writeFile(
      root,
      'src/config.ts',
      [
        'export const url = process.env.DATABASE_URL;',
        'export const port = Number(process.env.PORT) || 3000;',
        'export const stripe = process.env.STRIPE_SECRET;',
        'export const apiToken = import.meta.env.VITE_API_TOKEN;',
        'export const analytics = process.env.NEXT_PUBLIC_ANALYTICS;',
      ].join('\n'),
    );
    writeFile(root, '.env.example', 'DATABASE_URL=\nOLD_FLAG=\n');
    writeFile(root, '.env', `STRIPE_SECRET=${PRIVATE_VALUE}\nPORT=1\n`);
    return root;
  }

  it('reports undocumented, unused and browser-exposed variables, never a value', async () => {
    const { env } = await analyze({ root: project(), git: false, history: false, includeSource: false });
    expect(env).toBeDefined();
    expect(env!.undocumented).toEqual(['NEXT_PUBLIC_ANALYTICS', 'STRIPE_SECRET', 'VITE_API_TOKEN']);
    expect(env!.unused).toEqual(['OLD_FLAG']);
    expect(env!.exposedSecrets).toEqual(['VITE_API_TOKEN']);
    expect(env!.files.map((f) => f.path)).toEqual(['.env', '.env.example']);
    expect(JSON.stringify(env)).not.toContain(PRIVATE_VALUE);
  });

  it('leaves out what tests, fixtures and stories read: that is their own setup, not something to document', async () => {
    const root = project();
    writeFile(root, 'src/config.test.ts', 'export const flag = process.env.ONLY_IN_TESTS;\nexport const url = process.env.DATABASE_URL;\n');
    writeFile(root, 'test/helpers.ts', 'export const home = process.env.TEST_HELPER_HOME;\n');
    writeFile(root, 'examples/demo/main.ts', 'export const demo = process.env.DEMO_ONLY;\n');
    const { env } = await analyze({ root, git: false, history: false, includeSource: false });
    const names = env!.vars.map((v) => v.name);
    expect(names).not.toContain('ONLY_IN_TESTS');
    expect(names).not.toContain('TEST_HELPER_HOME');
    expect(names).not.toContain('DEMO_ONLY');
    // The test's read of a real variable does not count as a use either.
    expect(env!.vars.find((v) => v.name === 'DATABASE_URL')).toMatchObject({ useCount: 1, fileCount: 1 });
  });

  it('has nothing to say about a project that does not use the environment', async () => {
    const root = makeTempDir('cv-env-none-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'app' }));
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    const data = await analyze({ root, git: false, history: false, includeSource: false });
    expect(data.env).toBeUndefined();
  });
});
