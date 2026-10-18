/**
 * `similar --min` judges a match by the percentage it shows: a match listed as 80% passes `--min 80`.
 * Also: one source-extension pattern for the whole code base (src/shared/source-files.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GUARDED_FILE_RE } from '../src/agent/guard.js';
import { shownPercent } from '../src/cli/commands/similar.js';
import { runCli } from '../src/cli/run.js';
import { COMPONENT_FILE_RE, SCRIPT_EXT_RE, SOURCE_FILE_RE } from '../src/shared/source-files.js';
import { makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

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

describe('similar --min', () => {
  it('compares the rounded percentage that is shown', () => {
    expect(shownPercent({ similarity: 0.796 })).toBe(80);
    expect(shownPercent({ similarity: 0.794 })).toBe(79);
    expect(shownPercent({ similarity: 0.5, contained: 0.951 })).toBe(95);
  });

  it('a match shown as N% is listed with --min N and not with --min N+1', async () => {
    const root = makeTempDir('cv-similar-');
    writeFile(root, 'package.json', '{"name":"similar-min"}');
    const body = (name: string, extra: string): string =>
      [
        `export function ${name}(items: { price: number; qty: number; tags: string[] }[], rate: number): number {`,
        '  let total = 0;',
        '  for (const item of items) {',
        '    if (item.qty <= 0) continue;',
        "    const discounted = item.tags.includes('sale') ? item.price * 0.9 : item.price;",
        '    total += discounted * item.qty;',
        extra,
        '  }',
        '  const taxed = total * (1 + rate);',
        '  return Math.round(taxed * 100) / 100;',
        '}',
        '',
      ].join('\n');
    writeFile(root, 'src/a.ts', body('cartTotal', ''));
    writeFile(root, 'src/b.ts', body('basketTotal', "    if (total > 1000) console.log('big basket', total, items.length, rate);"));
    const all = await cli('similar', 'src/a.ts#cartTotal', '--root', root, '--no-cache', '--no-git', '--min', '1', '--json');
    expect(all.code, all.stderr).toBe(0);
    const match = (JSON.parse(all.stdout) as { matches: { file: string; similarity: number; contained?: number }[] }).matches.find((m) => m.file === 'src/b.ts');
    expect(match).toBeDefined();
    const shown = shownPercent(match!);
    expect(shown).toBeGreaterThan(1);
    expect(shown).toBeLessThan(100);
    const at = await cli('similar', 'src/a.ts#cartTotal', '--root', root, '--no-cache', '--no-git', '--min', String(shown));
    expect(at.stdout).toContain(`${shown}%`);
    expect(at.stdout).toContain('src/b.ts');
    const above = await cli('similar', 'src/a.ts#cartTotal', '--root', root, '--no-cache', '--no-git', '--min', String(shown + 1), '--json');
    expect((JSON.parse(above.stdout) as { matches: { file: string }[] }).matches.map((m) => m.file)).not.toContain('src/b.ts');
  });
});

describe('source file extensions', () => {
  it('one pattern: scripts, components, any case', () => {
    for (const f of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx', 'A.Vue', 'b.svelte', 'c.astro']) expect(SOURCE_FILE_RE.test(f), f).toBe(true);
    for (const f of ['a.md', 'a.json', 'a.css', 'a.d', 'tsx', 'a.vue.bak']) expect(SOURCE_FILE_RE.test(f), f).toBe(false);
    expect(SCRIPT_EXT_RE.test('a.tsx')).toBe(true);
    expect(SCRIPT_EXT_RE.test('a.vue')).toBe(false);
    expect(COMPONENT_FILE_RE.test('a.svelte')).toBe(true);
    expect(COMPONENT_FILE_RE.test('a.ts')).toBe(false);
    expect(GUARDED_FILE_RE).toBe(SOURCE_FILE_RE);
  });

  it('is written down once in src/ (outside the browser UI)', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const copies: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.name.endsWith('.ts') && fs.readFileSync(abs, 'utf8').includes('vue|svelte|astro)$')) copies.push(path.relative(src, abs).split(path.sep).join('/'));
      }
    };
    walk(src);
    expect(copies).toEqual(['shared/source-files.ts']);
    // The module has no imports: the agent hook's no-op path checks paths with it without loading anything.
    expect(fs.readFileSync(path.join(src, 'shared/source-files.ts'), 'utf8')).not.toMatch(/^import /m);
  });
});
