import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { parseSource, type ParsedFile } from '../src/analyzer/parse.js';
import { findSecret, isPlaceholder, maskSecret, maskSecretsIn } from '../src/shared/risks.js';
import type { RiskRule } from '../src/shared/types.js';
import { makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

function parse(text: string, id = 'src/file.ts'): ParsedFile {
  const parsed = parseSource(id, text, id.slice(id.lastIndexOf('.')));
  expect(parsed.parseError).toBeUndefined();
  return parsed;
}

const envOf = (text: string, id?: string) => parse(text, id).env ?? [];
const rulesOf = (text: string, id?: string): RiskRule[] => (parse(text, id).risks ?? []).map((r) => r.rule);

// Secret-shaped values are assembled at runtime: this file must not contain strings secret scanners flag.
const AWS_KEY = ['AKIA', 'QWERTYUIOP123456'].join('');
const GITHUB_TOKEN = ['ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
const KEY_BODY = 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn';
const PRIVATE_KEY = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ') + `\n${KEY_BODY}\n` + ['-----END RSA', 'PRIVATE KEY-----'].join(' ');

describe('environment reads', () => {
  it('finds process.env reads by property and by element access', () => {
    const reads = envOf(`
      const a = process.env.API_URL;
      const b = process.env['DB_HOST'];
    `);
    expect(reads).toEqual([
      { name: 'API_URL', line: 2, access: 'process.env' },
      { name: 'DB_HOST', line: 3, access: 'process.env' },
    ]);
  });

  it('finds import.meta.env, Deno.env.get and Bun.env', () => {
    const reads = envOf(`
      const a = import.meta.env.VITE_API;
      const b = Deno.env.get('DENO_KEY');
      const c = Bun.env.BUN_KEY;
    `);
    expect(reads.map((r) => [r.name, r.access])).toEqual([
      ['VITE_API', 'import.meta.env'],
      ['DENO_KEY', 'Deno.env'],
      ['BUN_KEY', 'Bun.env'],
    ]);
  });

  it('treats a default as a fallback, however it is written', () => {
    const reads = envOf(`
      const a = process.env.A || 'x';
      const b = process.env.B ?? 'x';
      const c = Number(process.env.C) || 3000;
      const d = parseInt(process.env.D ?? '1', 10);
      const e = process.env.E;
    `);
    const byName = Object.fromEntries(reads.map((r) => [r.name, !!r.fallback]));
    expect(byName).toEqual({ A: true, B: true, C: true, D: true, E: false });
  });

  it('reads destructuring, with and without defaults', () => {
    const reads = envOf(`const { HOST, PORT = '80' } = process.env;`);
    expect(reads.map((r) => [r.name, !!r.fallback])).toEqual([
      ['HOST', false],
      ['PORT', true],
    ]);
  });

  it('ignores writes and reads of the whole object', () => {
    const reads = envOf(`
      process.env.FOO = 'x';
      process.env['BAR'] = 'y';
      const all = { ...process.env };
      delete process.env.BAZ;
    `);
    expect(reads.map((r) => r.name)).not.toContain('FOO');
    expect(reads.map((r) => r.name)).not.toContain('BAR');
  });

  it('ignores dynamic names it cannot know', () => {
    expect(envOf(`const v = process.env[name];`)).toEqual([]);
  });

  it('reports the line in the whole file for the script of a Vue component', () => {
    const reads = envOf(['<template><div /></template>', '<script setup lang="ts">', 'const a = import.meta.env.VITE_KEY;', '</script>'].join('\n'), 'src/App.vue');
    expect(reads).toEqual([{ name: 'VITE_KEY', line: 3, access: 'import.meta.env' }]);
  });
});

describe('security findings', () => {
  it('finds a hardcoded secret and never keeps the secret in the snippet', () => {
    const parsed = parse(`const key = '${AWS_KEY}';\nconst token = '${GITHUB_TOKEN}';`);
    expect(parsed.risks?.map((r) => r.rule)).toEqual(['hardcoded-secret', 'hardcoded-secret']);
    for (const risk of parsed.risks ?? []) {
      expect(risk.snippet).not.toContain(AWS_KEY);
      expect(risk.snippet).not.toContain(GITHUB_TOKEN);
      expect(risk.snippet).toContain('characters');
    }
  });

  it('skips placeholder secrets', () => {
    expect(rulesOf(`const key = 'AKIA_YOUR_KEY_HERE';\nconst t = 'ghp_your_token_here';`)).toEqual([]);
  });

  it('finds credentials assigned to credential-named variables and properties', () => {
    expect(
      rulesOf(`
        const dbPassword = 'hunter2-Prod9';
        const config = { apiKey: 'k8s9Xy2Zq7Lm4' };
      `),
    ).toEqual(['hardcoded-credential', 'hardcoded-credential']);
  });

  it('does not take names, paths and placeholders for credentials', () => {
    expect(
      rulesOf(`
        const password = 'changeme';
        const accessToken = process.env.TOKEN;
        const tokenKey = 'access_token';
        const secretFile = './secret.json';
        const compass = 'north-by-north-west';
        const label = { token: '' };
      `),
    ).toEqual([]);
  });

  it('finds eval and new Function on dynamic code, and timers given a string', () => {
    expect(
      rulesOf(`
        eval(code);
        const f = new Function('a', body);
        setTimeout('tick()', 10);
        setTimeout(() => tick(), 10);
      `),
    ).toEqual(['eval', 'eval', 'eval']);
  });

  it('leaves eval of a constant alone: nothing can be injected', () => {
    expect(rulesOf(`eval('1 + 1');\nconst f = new Function('a', 'return a');`)).toEqual([]);
  });

  it('finds html injection sinks and ignores constant markup', () => {
    expect(
      rulesOf(
        `
        el.innerHTML = userHtml;
        el.innerHTML = '<b>static</b>';
        el.insertAdjacentHTML('beforeend', html);
        document.write(html);
        const c = <div dangerouslySetInnerHTML={{ __html: html }} />;
      `,
        'src/file.tsx',
      ),
    ).toEqual(['html-injection', 'html-injection', 'html-injection', 'html-injection']);
  });

  it('finds shell injection only through child_process with a dynamic command', () => {
    const risky = rulesOf(`
      import { exec, execFile } from 'node:child_process';
      exec('ls ' + dir);
      exec(\`rm -rf \${dir}\`);
      exec('ls -la');
      execFile('ls', [dir]);
    `);
    expect(risky).toEqual(['shell-injection', 'shell-injection']);
  });

  it('does not take RegExp.exec for a shell command', () => {
    expect(rulesOf(`const m = /a(b)/.exec(input);\nconst n = re.exec(value + more);`)).toEqual([]);
  });

  it('finds SQL built from dynamic text, in strings and in raw queries', () => {
    expect(
      rulesOf(`
        db.query('SELECT * FROM users WHERE id = ' + id);
        db.query(\`SELECT * FROM users WHERE name = '\${name}'\`);
        prisma.$queryRawUnsafe(sql);
      `),
    ).toEqual(['sql-injection', 'sql-injection', 'sql-injection']);
  });

  it('accepts parameterised queries and tagged templates', () => {
    expect(
      rulesOf(`
        db.query('SELECT * FROM users WHERE id = $1', [id]);
        const rows = await sql\`SELECT * FROM users WHERE id = \${id}\`;
      `),
    ).toEqual([]);
  });

  it('finds disabled TLS verification', () => {
    expect(
      rulesOf(`
        const agent = new https.Agent({ rejectUnauthorized: false });
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      `),
    ).toEqual(['tls-disabled', 'tls-disabled']);
  });

  it('reports one finding per rule and line', () => {
    expect(rulesOf(`eval(a); eval(b);`)).toEqual(['eval']);
  });

  it('is quiet about ordinary code', () => {
    expect(rulesOf(`export const add = (a: number, b: number) => a + b;`)).toEqual([]);
  });
});

describe('type-safety escapes', () => {
  it('counts any, non-null assertions and suppression comments', () => {
    const parsed = parse(`
      // @ts-ignore
      const a: any = 1;
      // @ts-expect-error: on purpose
      const b = foo!.bar;
      /* eslint-disable no-console */
      const c = (x as any) as string[];
      // eslint-disable-next-line
      const d = y!;
    `);
    expect(parsed.escapes).toEqual({ any: 2, nonNull: 2, tsIgnore: 1, tsExpectError: 1, lintDisable: 2 });
  });

  it('leaves escapes unset for clean code', () => {
    expect(parse(`export const a: number = 1;`).escapes).toBeUndefined();
  });

  it('does not count the words in strings', () => {
    expect(parse(`const s = 'use any type and @ts-ignore';`).escapes).toBeUndefined();
  });
});

describe('findings in an analysis', () => {
  async function analyzeRisky() {
    const root = makeTempDir('cv-risks-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'app' }));
    writeFile(root, 'src/db.ts', `export const key = '${AWS_KEY}';\nexport const find = (db: { query(sql: string): void }, id: string) => db.query('SELECT * FROM t WHERE id = ' + id);\n`);
    writeFile(root, 'src/view.tsx', 'export const show = (el: HTMLElement, html: string) => {\n  el.innerHTML = html;\n};\n');
    writeFile(root, 'test/fixtures/leak.ts', `export const fake = '${GITHUB_TOKEN}';\n`);
    writeFile(root, 'src/loose.ts', 'export const a: any = 1;\nexport const b = (JSON.parse("{}") as { c?: number }).c!;\n');
    writeFile(root, 'src/types.d.ts', 'declare const ambient: any;\n');
    return analyze({ root, git: false, history: false, includeSource: false });
  }

  it('lists the most severe findings first and test fixtures last', async () => {
    const { insights } = await analyzeRisky();
    const risks = insights.risks ?? [];
    expect(risks.map((r) => [r.file, r.rule, r.severity, !!r.test])).toEqual([
      ['src/db.ts', 'hardcoded-secret', 'high', false],
      ['src/db.ts', 'sql-injection', 'high', false],
      ['src/view.tsx', 'html-injection', 'medium', false],
      ['test/fixtures/leak.ts', 'hardcoded-secret', 'high', true],
    ]);
  });

  it('never lets a secret into the report, wherever the code mentions it', async () => {
    const root = makeTempDir('cv-risks-leak-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'app' }));
    writeFile(
      root,
      'src/leaky.ts',
      [
        // In a symbol's type, a TODO, a URL and a default value.
        `export const key = '${AWS_KEY}';`,
        `// TODO: rotate ${GITHUB_TOKEN}`,
        `export const call = () => fetch('https://api.example.com/v1?key=${AWS_KEY}');`,
        `export function connect(token = '${AWS_KEY}'): string {`,
        '  return token;',
        '}',
        // A secret that straddles the end of the 160 characters kept of a line.
        `export const pad = '${'x'.repeat(107)}'; export const late = '${AWS_KEY}';`,
        `export const pem = \`${PRIVATE_KEY}\`;`,
      ].join('\n'),
    );
    const data = await analyze({ root, git: false, history: false, includeSource: false });
    const json = JSON.stringify(data);
    for (const secret of [AWS_KEY, GITHUB_TOKEN, KEY_BODY]) expect(json).not.toContain(secret);
    // Not even the start of one that was cut.
    expect(json).not.toContain(AWS_KEY.slice(0, 8));
    expect(data.insights.risks?.some((r) => r.rule === 'hardcoded-secret' && r.snippet.includes('characters'))).toBe(true);
    expect(data.insights.risks?.filter((r) => r.rule === 'hardcoded-secret').length).toBeGreaterThanOrEqual(5);
  });

  it('counts type-safety escapes per file, except in declaration files', async () => {
    const { files } = await analyzeRisky();
    expect(files.find((f) => f.id === 'src/loose.ts')?.escapes).toEqual({ any: 1, nonNull: 1, tsIgnore: 0, tsExpectError: 0, lintDisable: 0 });
    expect(files.find((f) => f.id === 'src/types.d.ts')?.escapes).toBeUndefined();
    expect(files.find((f) => f.id === 'src/db.ts')?.escapes).toBeUndefined();
  });

  it('has no findings for clean code', async () => {
    const root = makeTempDir('cv-risks-clean-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'app' }));
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    const { insights } = await analyze({ root, git: false, history: false, includeSource: false });
    expect(insights.risks).toBeUndefined();
  });
});

describe('secret masking', () => {
  it('keeps the start of a secret, never the rest', () => {
    expect(maskSecret(AWS_KEY)).toBe('AKIA…(20 characters)');
    expect(maskSecret('abc')).toBe('…(3 characters)');
  });

  it('masks every kind of secret inside a line of code', () => {
    const masked = maskSecretsIn(`const a = '${AWS_KEY}', b = '${GITHUB_TOKEN}', url = 'postgres://app:hunter2pass@db.local/app';`);
    for (const secret of [AWS_KEY, GITHUB_TOKEN, 'hunter2pass']) expect(masked).not.toContain(secret);
    expect(masked).toContain('postgres://app:');
  });

  it('masks the body of a private key, not just its header', () => {
    const masked = maskSecretsIn(`const key = \`${PRIVATE_KEY}\`;`);
    expect(masked).not.toContain(KEY_BODY);
    expect(masked).toContain('const key = `');
  });

  it('masks a private key whose end is cut off', () => {
    expect(maskSecretsIn(`${PRIVATE_KEY.slice(0, PRIVATE_KEY.indexOf('-----END'))}`)).not.toContain(KEY_BODY);
  });

  it('leaves ordinary text alone', () => {
    const text = "const note = 'AKIA is the prefix of AWS keys'; // postgres://localhost/db";
    expect(maskSecretsIn(text)).toBe(text);
  });

  it('finds the secret in a string and skips placeholders', () => {
    expect(findSecret(`Bearer ${GITHUB_TOKEN}`)).toEqual({ label: 'GitHub token', secret: GITHUB_TOKEN });
    // Keys written for documentation are not leaks.
    expect(findSecret('AKIAXXXXXXXXXXXXXXXX')).toBeUndefined();
    expect(findSecret(['AKIA', 'IOSFODNN7EXAMPLE'].join(''))).toBeUndefined();
    for (const value of ['', 'changeme', 'your-api-key', '${TOKEN}', '<token>', '********', 'password', 'test_secret']) expect(isPlaceholder(value)).toBe(true);
    for (const value of ['k8s9Xy2Zq7Lm4', 'correct-horse-9']) expect(isPlaceholder(value)).toBe(false);
  });
});
