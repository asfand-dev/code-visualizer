/**
 * clone-radar: the token index (tokenizer, exact and near-miss clones, families), `findSimilar`, new clones
 * in the architecture delta, clone drift in My changes, the `check --max-new-clones` gate, the Duplication
 * health category, the `similar` command and the live `clone-added` event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyze, createAnalyzeCache } from '../src/analyzer/index.js';
import { byImportance, canonicalCallable, cloneSettings, clonesGate, cloneTokens, CloneTokenStore, detectClones, findSimilar, similarTo, snippetTokens, unitsOf, type CloneSource } from '../src/analyzer/clones.js';
import { compareReports } from '../src/analyzer/compare.js';
import { normalizeConfig } from '../src/analyzer/config.js';
import { deserialize, loadDiskCache, serialize } from '../src/analyzer/disk-cache.js';
import type { GateContext } from '../src/analyzer/gates.js';
import { diffLive, liveCandidates, LiveGuard } from '../src/analyzer/live-events.js';
import { runCli } from '../src/cli/run.js';
import { TOOLS } from '../src/mcp/tools.js';
import { sarifLog } from '../src/report/formats/sarif.js';
import { cloneDelta, cloneDrift, cloneFingerprint, cloneSides, coChangeLabel, driftMessage, newCloneMessage, pastedClones, reuseAdvice, similarityRange } from '../src/shared/clones.js';
import { architectureDeltaMarkdown, prSummaryMarkdown } from '../src/shared/markdown.js';
import type { ChangedFile, CloneFamily, ReportData, SimilarMatch } from '../src/shared/types.js';
import { commitAll, copyFixture, daysAgo, editFile, fixtureDir, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

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

/** A 9-line helper of about 80 tokens. */
const SLUGIFY = `export function slugify(text: string): string {
  const lower = text.toLowerCase().trim();
  const parts = lower.split(/[^a-z0-9]+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return 'item';
  }
  const joined = parts.join('-');
  return joined.length > 60 ? joined.slice(0, 60) : joined;
}
`;

/** The same code with every identifier renamed and other literals: a copy all the same. */
const TO_SLUG = `export function toSlug(input: string): string {
  const small = input.toLowerCase().trim();
  const pieces = small.split(/[^a-z]+/).filter((p) => p.length > 1);
  if (pieces.length === 0) {
    return 'entry';
  }
  const result = pieces.join('_');
  return result.length > 80 ? result.slice(0, 80) : result;
}
`;

const USER = `import { slugify } from '../lib/strings';

export function userUrl(name: string): string {
  return \`/users/\${slugify(name)}\`;
}
`;

/** Two neighbouring declarations copied together into another file (an `emit` helper and a command). */
const COMMAND = (name: string) => `function emit(text: string, out: { write(s: string): void }, json: boolean): void {
  if (json) out.write(JSON.stringify({ text }) + '\\n');
  else out.write(text.endsWith('\\n') ? text : text + '\\n');
}

export const ${name}Command = {
  name: '${name}',
  aliases: [] as string[],
  run(argv: string[], out: { write(s: string): void }): number {
    const json = argv.includes('--json');
    const rest = argv.filter((a) => !a.startsWith('-'));
    if (rest.length > 2) {
      emit('too many arguments', out, json);
      return 2;
    }
    for (const a of rest) emit(a.toUpperCase(), out, json);
    return rest.length ? 0 : 1;
  },
};
`;

/** A temp project (package.json + files). */
function project(files: Record<string, string>, config?: Record<string, unknown>): string {
  const root = path.join(makeTempDir('cv-clones-'), 'app');
  writeFile(root, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: { typescript: '5.0.0' } }));
  if (config) writeFile(root, 'code-visualizer.config.json', JSON.stringify(config));
  for (const [file, text] of Object.entries(files)) writeFile(root, file, text);
  return root;
}

const run = (root: string, extra: Parameters<typeof analyze>[0] = {}): Promise<ReportData> => analyze({ root, git: false, history: false, includeSource: false, ...extra });

const fragmentsOf = (fam: CloneFamily | undefined): string[] => (fam?.fragments ?? []).map((f) => `${f.file}:${f.start}-${f.end}${f.name ? ` ${f.name}` : ''}`);

describe('clone-radar: tokens', () => {
  const kinds = (text: string, ext = '.ts'): number[] => [...cloneTokens(text, ext).kinds];

  it('normalizes identifiers and literals and leaves import / export-from statements out', () => {
    const a = kinds(`import { x } from './x';\nimport type { T } from "./t"\nexport * from './all';\nexport { a, b } from './ab';\nconst total = add(1, 'two');\n`);
    const b = kinds(`import './side-effect';\nimport y = require('y');\nexport { c };\nlet sum = plus(42, \`three\`);\n`);
    // Only `const|let I = I ( L , L ) ;` is left (const and let are different keywords).
    expect(a.slice(1)).toEqual(b.slice(1));
    expect(a).toHaveLength(10);
  });

  it('treats contextual keywords used as names (`out`, `type`, `of`) as identifiers, and keeps regex and templates apart', () => {
    expect(kinds('const out = type + of;')).toEqual(kinds('const res = kind + num;'));
    expect(kinds('const r = /a\\/b/g.test(s); const t = `x${y}z`;')).toHaveLength(kinds('const r = /c/.test(s); const t = `${y}`;').length);
  });

  it('reads the script blocks of Vue files with the file’s line numbers', () => {
    const vue = `<template>\n  <div>{{ msg }}</div>\n</template>\n\n<script setup lang="ts">\nconst msg = compute(1);\n</script>\n`;
    const t = cloneTokens(vue, '.vue');
    expect(t.lines[0]).toBe(6);
    expect([...t.kinds]).toEqual(kinds('const msg = compute(1);'));
    // Astro frontmatter after blank lines starts on the line after its `---`.
    expect(cloneTokens('\n\n---\nconst a = 1;\n---\n<div/>\n', '.astro').lines[0]).toBe(4);
    expect(cloneTokens('---\r\nconst a = 1;\r\n---\r\n<div/>\r\n', '.astro').lines[0]).toBe(2);
    // A Vue / Svelte snippet without its <script> wrapper is its script.
    expect([...snippetTokens('const msg = compute(1);', '.vue').kinds]).toEqual(kinds('const msg = compute(1);'));
  });

  it('compares declarations whatever their style: function, arrow, expression body, return type', () => {
    const canon = (text: string): number[] => [...canonicalCallable(cloneTokens(text, '.ts').kinds)];
    const fn = canon('export function twice(a: number): number { return a * 2; }');
    expect(canon('export const twice = (a: number): number => a * 2;')).toEqual(fn);
    expect(canon('const twice = async (a: number) => { return a * 2; };')).toEqual(fn);
    expect(canon('export default function (a: number): Promise<{ v: number[] }> { return a * 2; }')).toEqual(fn);
    // Statements and calls are left as they are.
    expect(canon('run(a); if (b) { c(); }')).toEqual(kinds('run(a); if (b) { c(); }'));
    expect(canon('x = f(a) + 1;')).toEqual(kinds('x = f(a) + 1;'));
  });
});

describe('clone-radar: detection', () => {
  it('finds two functions that differ only in names and literals: one family, similarity 1', async () => {
    const data = await run(project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': `// helpers\n\n${TO_SLUG}`, 'src/pages/user.ts': USER }));
    expect(data.insights.clones).toHaveLength(1);
    const [fam] = data.insights.clones!;
    expect(fam.similarity).toBe(1);
    expect(fragmentsOf(fam)).toEqual(['src/lib/strings.ts:1-9 slugify', 'src/ui/utils.ts:3-11 toSlug']);
    expect(fam.fragments[0]).toMatchObject({ symbol: 'src/lib/strings.ts#slugify', exported: true, importers: 1 });
    expect(fam.id).toMatch(/^[0-9a-f]{16}$/);
    expect(fam.tokens).toBeGreaterThanOrEqual(50);
    expect(data.stats.duplicatedLines).toBe(18);
  });

  it('ignores copies shorter than minLines, and follows the clones settings', async () => {
    const dense = `export function slugify(text: string): string { const lower = text.toLowerCase().trim();
  const parts = lower.split(/[^a-z0-9]+/).filter((part) => part.length > 0); if (parts.length === 0) { return 'item'; }
  const joined = parts.join('-'); return joined.length > 60 ? joined.slice(0, 60) : joined; }
`;
    const short = await run(project({ 'src/a.ts': dense, 'src/b.ts': dense.replace('slugify', 'toSlug') }));
    expect(short.insights.clones).toEqual([]);
    // Lower thresholds report it; "clones": false turns detection (and the health category) off.
    expect((await run(project({ 'src/a.ts': dense, 'src/b.ts': dense }, { clones: { minLines: 3 } }))).insights.clones).toHaveLength(1);
    const off = await run(project({ 'src/a.ts': SLUGIFY, 'src/b.ts': TO_SLUG }, { clones: false }));
    expect(off.insights.clones).toBeUndefined();
    expect(off.health.categories.map((c) => c.id)).not.toContain('duplication');
    const ignored = await run(project({ 'src/a.ts': SLUGIFY, 'src/generated/b.ts': TO_SLUG }, { clones: { ignore: ['src/generated/**'] } }));
    expect(ignored.insights.clones).toEqual([]);
  });

  it('does not match the same statements in another order', async () => {
    const a = `export function a(list: number[]): number {
  const first = list[0] ?? 0;
  const doubled = list.map((x) => x * 2);
  const total = doubled.reduce((s, x) => s + x, 0);
  if (!list.length) throw new Error('empty');
  const label = \`\${first}:\${total}\`;
  console.log(label, list.length > 3);
  return total + first;
}
`;
    const b = `export function b(list: number[]): number {
  console.log(label, list.length > 3);
  const total = doubled.reduce((s, x) => s + x, 0);
  const label = \`\${first}:\${total}\`;
  const first = list[0] ?? 0;
  if (!list.length) throw new Error('empty');
  const doubled = list.map((x) => x * 2);
  return total + first;
}
`;
    expect((await run(project({ 'src/a.ts': a, 'src/b.ts': b }))).insights.clones).toEqual([]);
  });

  it('ignores a block repeated inside one function, and copies between two test files', async () => {
    const block = `  for (const item of items) {
    if (item.size > limit && item.name.startsWith('x')) {
      total += item.size * 2 + item.name.length;
    } else if (item.size < 0) {
      throw new Error(\`bad \${item.name}\`);
    } else {
      total -= Math.max(item.size, limit);
    }
  }
`;
    const twice = `export function twice(items: { size: number; name: string }[], limit: number): number {\n  let total = 0;\n${block}${block}  return total;\n}\n`;
    expect((await run(project({ 'src/twice.ts': twice }))).insights.clones).toEqual([]);
    const tests = await run(project({ 'src/a.test.ts': SLUGIFY, 'src/b.test.ts': TO_SLUG }));
    expect(tests.insights.clones).toEqual([]);
    // A test that re-implements production code is reported.
    expect((await run(project({ 'src/strings.ts': SLUGIFY, 'src/strings.test.ts': TO_SLUG }))).insights.clones).toHaveLength(1);
  });

  it('keeps a copy with a small edit in the middle as one near-miss clone', async () => {
    const edited = TO_SLUG.replace("  if (pieces.length === 0) {\n", "  if (!input) throw new TypeError('input');\n  if (pieces.length === 0) {\n");
    const data = await run(project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': edited }));
    expect(data.insights.clones).toHaveLength(1);
    const [fam] = data.insights.clones!;
    expect(fragmentsOf(fam)).toEqual(['src/lib/strings.ts:1-9 slugify', 'src/ui/utils.ts:1-10 toSlug']);
    expect(fam.similarity).toBeGreaterThan(0.75);
    expect(fam.similarity).toBeLessThan(1);
  });

  it('reports class methods on their own and Vue script blocks with the file’s lines', async () => {
    const vue = `<template>\n  <p>{{ title }}</p>\n</template>\n\n<script setup lang="ts">\n${TO_SLUG.replace('export ', '')}const title = toSlug('Hello World');\n</script>\n`;
    const service = `export class Names {\n  count = 0;\n\n  slug(text: string): string {\n${SLUGIFY.split('\n').slice(1, 8).join('\n')}\n  }\n}\n`;
    const data = await run(project({ 'src/lib/strings.ts': SLUGIFY, 'src/components/Title.vue': vue, 'src/names.ts': service }));
    const [fam] = data.insights.clones!;
    expect(fragmentsOf(fam)).toEqual(['src/components/Title.vue:6-14 toSlug', 'src/lib/strings.ts:1-9 slugify', expect.stringMatching(/^src\/names\.ts:[4-5]-1[0-2] Names\.slug$/)]);
  });

  it('ranks families whose files are committed together first, and names it a drift risk', () => {
    const tokens = cloneTokens(SLUGIFY, '.ts');
    const sources: CloneSource[] = ['a', 'b', 'c', 'd'].map((n) => ({ id: `src/${n}.ts`, tokens, units: [], test: false }));
    const families = detectClones(sources);
    expect(families).toHaveLength(1);
    expect(families[0].fragments).toHaveLength(4);
    expect(families[0].pairs).toHaveLength(6);
    const frag = (file: string) => ({ file, start: 1, end: 9, name: 'f' });
    const fam = (id: string, tokens: number, similarity: number, coChanges?: number): CloneFamily => ({ id, tokens, lines: 9, similarity, fragments: [frag(`src/${id}1.ts`), frag(`src/${id}2.ts`)], ...(coChanges ? { coChanges } : {}) });
    const big = fam('big', 400, 1);
    const together = fam('together', 60, 0.9, 9);
    const block = fam('block', 300, 0.1, 12);
    const partial = fam('partial', 500, 0.4);
    // Changed together first (only for copies of some size), then whole copies, then the most tokens.
    expect([partial, block, big, together].sort(byImportance).map((f) => f.id)).toEqual(['together', 'big', 'partial', 'block']);
    expect(coChangeLabel(together)).toBe('changed together 9 times: drift risk');
    // A small block shared by two hub files that always change together is no drift risk.
    expect(coChangeLabel(block)).toBeUndefined();
  });

  it('keeps a copy inside its declaration: the line before it and the next function are not part of it', async () => {
    const helpers = `export const VERSION = 2;\n\n${SLUGIFY}export function debounce(fn: () => void, ms = 200): () => void {\n  let t: ReturnType<typeof setTimeout> | undefined;\n  return () => {\n    clearTimeout(t);\n    t = setTimeout(fn, ms);\n  };\n}\n`;
    const other = `export const NAME = 'x';\n${TO_SLUG}export function round(v: number): number {\n  return Math.round(v * 100) / 100;\n}\n`;
    const data = await run(project({ 'src/lib/strings.ts': helpers, 'src/ui/utils.ts': other }));
    expect(data.insights.clones).toHaveLength(1);
    expect(fragmentsOf(data.insights.clones![0])).toEqual(['src/lib/strings.ts:3-11 slugify', 'src/ui/utils.ts:2-10 toSlug']);
  });

  it('two blocks shared at both ends of two long functions do not claim the lines between them', async () => {
    const head = `  const lower = text.toLowerCase().trim();\n  const parts = lower.split(/[^a-z0-9]+/).filter((part) => part.length > 0);\n  if (parts.length === 0 || parts.some((p) => p.length > 40)) {\n    throw new Error(\`bad input \${text}\`);\n  }\n  const seen = new Set<string>();\n`;
    const tail = `  for (const p of parts) {\n    if (seen.has(p)) continue;\n    seen.add(p);\n    out.push(p.length > 10 ? p.slice(0, 10) : p.padEnd(3, '-'));\n  }\n  return out.join('/');\n`;
    const fillA = Array.from({ length: 200 }, (_, i) => `  out.push(String(${i}));`).join('\n');
    const fillB = Array.from({ length: 200 }, (_, i) => `  if (out.length < ${i}) seen.delete('${i}');`).join('\n');
    const big = (name: string, fill: string) => `export function ${name}(text: string): string {\n  const out: string[] = [];\n${head}${fill}\n${tail}}\n`;
    const data = await run(project({ 'src/a.ts': big('alpha', fillA), 'src/b.ts': big('beta', fillB) }));
    const families = data.insights.clones!;
    expect(families.length).toBeGreaterThanOrEqual(1);
    for (const fam of families) for (const f of fam.fragments) expect(f.end - f.start).toBeLessThan(20);
    // Small blocks of 210-line functions are listed, but they are not what makes code duplicated.
    expect(data.stats.duplicatedLines).toBe(0);
    expect(data.health.categories.find((c) => c.id === 'duplication')?.score).toBe(100);
  });

  it('a block shared with a third function keeps its own similarity; a small idiom does not join a whole copy', async () => {
    const third = `export function report(items: string[], text: string): string {\n  const lines: string[] = [];\n  for (const item of items) lines.push(item.toUpperCase());\n  const lower = text.toLowerCase().trim();\n  const parts = lower.split(/[^a-z0-9]+/).filter((part) => part.length > 0);\n  if (parts.length === 0) {\n    return 'item';\n  }\n  const joined = parts.join('-');\n  lines.push(joined.length > 60 ? joined.slice(0, 60) : joined);\n  for (const l of lines) if (l.length > 100) throw new Error('long');\n  const result = lines.map((l, i) => \`\${i + 1}. \${l}\`).join(', ');\n  if (result.length > 5000) console.warn('long report', result.length, items.length);\n  return result.trim() || 'empty';\n}\n`;
    const data = await run(project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': TO_SLUG, 'src/report.ts': third }));
    const fam = data.insights.clones!.find((f) => f.fragments.some((x) => x.name === 'toSlug'))!;
    const pairOf = (x: string, y: string) => fam.pairs!.find((p) => [fam.fragments[p.a].name, fam.fragments[p.b].name].sort().join() === [x, y].sort().join())?.similarity;
    expect(pairOf('slugify', 'toSlug')).toBe(1);
    expect(pairOf('report', 'slugify')).toBeLessThan(0.5);
    expect(similarityRange(fam)).toMatch(/^\d+–100%$/);
    // A new report() is a shared block (its own similarity), not "100% similar: import it instead".
    const asNew = { ...fam, fragments: fam.fragments.map((f) => (f.name === 'report' ? { ...f, isNew: true } : f)) };
    expect(newCloneMessage(asNew)).toMatch(/^report in src\/report\.ts \(lines \d+-\d+\) duplicates (slugify|toSlug) in .* extract a shared helper$/);

    // A loop shared with a third function, much smaller than the copied function, is a family of its own.
    const tailLines = [
      '  const avg = items.length ? total / items.length : 0;',
      '  const rounded = Math.round(avg * 100) / 100;',
      "  if (rounded > 1000) console.warn('large', rounded, limit);",
      '  const capped = Math.min(rounded, limit * 10);',
      '  while (total > capped && total % 3 !== 1) total -= 1;',
      "  const label = `${items.length}:${capped}`;",
      '  try {',
      '    localStorage.setItem(label, String(total));',
      '  } catch (error) {',
      '    console.error(error instanceof Error ? error.message : error);',
      '  }',
      '  switch (Math.sign(total)) {',
      '    case -1: return -capped;',
      '    default: break;',
      '  }',
    ].join('\n');
    const bigFn = (name: string) => `export function ${name}(items: number[], limit: number): number {\n  let total = 0;\n  for (const item of items) {\n    if (item > limit && item % 2 === 0) {\n      total += item * 2;\n    } else if (item < 0) {\n      throw new Error(\`negative \${item}\`);\n    }\n  }\n${tailLines}\n  return total;\n}\n`;
    const small = `export function third(values: number[], max: number): string {\n  let total = 0;\n  for (const item of values) {\n    if (item > max && item % 2 === 0) {\n      total += item * 2;\n    } else if (item < 0) {\n      throw new Error(\`negative \${item}\`);\n    }\n  }\n  return total ? String(total) : 'none';\n}\n`;
    const d3 = await run(project({ 'src/a.ts': bigFn('bigA'), 'src/b.ts': bigFn('bigB'), 'src/c.ts': small }));
    const whole = d3.insights.clones!.find((f) => f.fragments.some((x) => x.name === 'bigB'))!;
    expect(whole.fragments.map((f) => f.name)).toEqual(['bigA', 'bigB']);
    expect(whole.similarity).toBe(1);
    const loop = d3.insights.clones!.find((f) => f.fragments.some((x) => x.name === 'third'))!;
    expect(loop).toBeDefined();
    expect(loop.similarity).toBeLessThan(0.5);
  });
});

describe('clone-radar: findSimilar', () => {
  let react: string;
  let data: ReportData;
  let store: CloneTokenStore;
  beforeAll(async () => {
    react = copyFixture('react-vite-ts', 'cv-similar-');
    data = await run(react);
    store = new CloneTokenStore(react, false);
  });

  it('finds the fixture helper from a pasted, renamed copy, first', async () => {
    const pasted = `function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z]+/g, '_')
    .replace(/^_|_$/g, '');
}`;
    const answer = await similarTo(data, store, { snippet: pasted });
    expect(answer.matches[0]).toMatchObject({ symbol: 'src/utils/format.ts#slugify', file: 'src/utils/format.ts', name: 'slugify', signature: 'slugify(text: string): string', exported: true });
    expect(answer.matches[0].similarity).toBeGreaterThanOrEqual(0.9);
    // Something else entirely matches nothing; a two-token snippet is too short to compare.
    expect((await similarTo(data, store, { snippet: 'export function sum(values: number[]) { let t = 0; for (const v of values) t += v; return t; }' })).matches).toEqual([]);
    expect((await similarTo(data, store, { snippet: 'x()' })).error).toBe('too-short');
  });

  it('finds a short helper written in the other declaration style (arrow or function)', async () => {
    const arrow = 'export const limitTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));';
    const answer = await similarTo(data, store, { snippet: arrow });
    expect(answer.matches[0]).toMatchObject({ symbol: 'src/utils/math.ts#clamp', similarity: 1 });
    // The other way round: a function declaration finds an existing arrow.
    const root = project({ 'src/cli/shared.ts': "export const isTTY = (stream: NodeJS.WriteStream = process.stdout): boolean => !!stream.isTTY && !process.env.CI;\n" });
    const own = await run(root);
    const fn = 'export function isInteractive(s: NodeJS.WriteStream = process.stdout) {\n  return !!s.isTTY && !process.env.CI;\n}';
    const found = await similarTo(own, new CloneTokenStore(root, false), { snippet: fn });
    expect(found.matches[0]).toMatchObject({ name: 'isTTY', similarity: 1 });
  });

  it('says which copy to keep: an exported, used match — or the code asked about', () => {
    const match = (name: string, extra: Partial<SimilarMatch> = {}): SimilarMatch => ({ symbol: `src/${name}.ts#${name}`, file: `src/${name}.ts`, line: 1, name, similarity: 1, signature: `${name}()`, importers: 0, ...extra });
    // A snippet: import the exported, most used of the most similar copies.
    expect(reuseAdvice({}, [match('copy'), match('original', { exported: true, importers: 6, similarity: 0.95 })])).toMatchObject({ kind: 'import', keep: { name: 'original' } });
    expect(reuseAdvice({}, [match('local')])).toMatchObject({ kind: 'export', keep: { name: 'local' } });
    expect(reuseAdvice({}, [match('weak', { similarity: 0.6 })])).toBeUndefined();
    // Asked about the original (exported, used): keep it, the copies should import it.
    expect(reuseAdvice({ name: 'debounce', exported: true, importers: 4 }, [match('debounced', { exported: true })])).toEqual({ kind: 'keep-query', copies: [match('debounced', { exported: true })] });
    // Asked about a copy: import the original.
    expect(reuseAdvice({ name: 'debounced', exported: true }, [match('debounce', { exported: true, importers: 4 })])).toMatchObject({ kind: 'import', keep: { name: 'debounce' } });
  });

  it('compares lines of a file and leaves the code itself out of the answer', async () => {
    const own = await similarTo(data, store, { file: 'src/utils/format.ts', start: 17 });
    expect(own.query).toMatchObject({ file: 'src/utils/format.ts', name: 'slugify' });
    expect(own.matches.map((m) => m.symbol)).not.toContain('src/utils/format.ts#slugify');
    const tokensOf = (f: { id: string }) => cloneTokens(fs.readFileSync(path.join(react, f.id), 'utf8'), path.extname(f.id));
    expect(findSimilar(data, 'const a = 1;', { tokensOf })).toEqual([]);
    expect((await similarTo(data, store, { file: 'src/nope.ts', start: 1, end: 3 })).error).toBe('not-found');
  });
});

describe('clone-radar: new clones, drift and the gate', () => {
  it('an overlay adding a copy gives exactly one new clone, marked new, with an "import it instead" message', async () => {
    const root = project({ 'src/lib/strings.ts': SLUGIFY, 'src/pages/user.ts': USER });
    const cache = createAnalyzeCache();
    const base = await run(root, { cache });
    const head = await run(root, { cache, overlay: { 'src/ui/utils.ts': TO_SLUG } });
    const delta = compareReports(base, head);
    expect(delta.newClones).toHaveLength(1);
    const [fam] = delta.newClones!;
    expect(fam.fragments.find((f) => f.isNew)).toMatchObject({ file: 'src/ui/utils.ts', name: 'toSlug' });
    expect(newCloneMessage(fam)).toBe('toSlug in src/ui/utils.ts is 100% similar to exported slugify in src/lib/strings.ts (used in 1 file): import it instead');
    // (toSlug is also a new unused export.)
    expect(delta.fingerprints.new).toContain(cloneFingerprint(fam));
    expect(architectureDeltaMarkdown(delta)).toContain('**1 new copy-paste clone**');
    // The other way round the copy is gone: fixed, and nothing is new.
    const back = compareReports(head, base);
    expect(back.newClones).toBeUndefined();
    expect(back.fixedClones).toHaveLength(1);
    // Comparing a head with itself, or with a base without clone data, reports nothing.
    expect(compareReports(head, head).newClones).toBeUndefined();
    expect(compareReports({ ...base, insights: { ...base.insights, clones: undefined } }, head).newClones).toBeUndefined();
  });

  it('renaming a copy, or a third copy of an existing family, is judged by its declarations', () => {
    const frag = (file: string, name: string) => ({ file, start: 1, end: 9, name });
    const fam = (id: string, ...fragments: ReturnType<typeof frag>[]): CloneFamily => ({ id, tokens: 80, lines: 9, similarity: 1, fragments });
    const base = [fam('f1', frag('src/a.ts', 'slugify'), frag('src/b.ts', 'toSlug'))];
    expect(cloneDelta(base, [fam('f1', frag('src/a.ts', 'slugify'), frag('src/b.ts', 'renamed'))]).added).toEqual([]);
    const third = cloneDelta(base, [fam('f1', frag('src/a.ts', 'slugify'), frag('src/b.ts', 'toSlug'), frag('src/c.ts', 'again'))]).added;
    expect(third).toHaveLength(1);
    expect(third[0].fragments.filter((f) => f.isNew).map((f) => f.file)).toEqual(['src/c.ts']);
    // A block inside larger declarations is not "import it instead".
    expect(newCloneMessage({ similarity: 0.3, fragments: [{ ...frag('src/a.ts', 'render'), start: 40, end: 58, isNew: true }, { ...frag('src/b.ts', 'draw'), start: 12, end: 30 }] })).toBe(
      'render in src/a.ts (lines 40-58) duplicates draw in src/b.ts (lines 12-30): extract a shared helper',
    );
    // Renamed files keep their clones.
    expect(cloneDelta(base, [fam('f1', frag('src/a.ts', 'slugify'), frag('src/lib/b.ts', 'toSlug'))], { moved: (f) => (f === 'src/b.ts' ? 'src/lib/b.ts' : f) }).added).toEqual([]);
  });

  it('an edit inside an existing copy, or next to it, is never a new clone', async () => {
    const root = project({ 'src/lib/strings.ts': `${SLUGIFY}\nexport const LIMIT = 60;\n`, 'src/ui/utils.ts': TO_SLUG, 'src/cli/context.ts': COMMAND('context'), 'src/cli/diff.ts': COMMAND('diff'), 'src/pages/user.ts': USER });
    const cache = createAnalyzeCache();
    const base = await run(root, { cache });
    expect(base.insights.clones?.length).toBeGreaterThanOrEqual(2);
    const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    let edits = 0;
    for (const fam of base.insights.clones!) {
      for (const f of fam.fragments) {
        const lines = read(f.file);
        for (const at of new Set([f.start, Math.floor((f.start + f.end) / 2), f.end])) {
          // A statement inserted after the line, an argument added on it, and the line before / after the copy edited.
          const variants = [
            [...lines.slice(0, at), "  console.debug('edited');", ...lines.slice(at)],
            lines.map((l, i) => (i === at - 1 ? l.replace(/\)(;?)$/, ", 'extra')$1").replace(/^(\s*)name: '(\w+)',$/, "$1name: '$2', aliases: ['x'],") : l)),
          ];
          for (const text of variants) {
            const head = await run(root, { cache, overlay: { [f.file]: text.join('\n') } });
            expect(compareReports(base, head).newClones, `${f.file}:${at}`).toBeUndefined();
            edits++;
          }
        }
      }
    }
    expect(edits).toBeGreaterThan(10);
  });

  it('moving a copy into another file, or a block that is a small part of its function, is no new clone', async () => {
    const root = project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': `${TO_SLUG}\nexport const KEEP = 1;\n`, 'src/pages/user.ts': USER });
    const cache = createAnalyzeCache();
    const base = await run(root, { cache });
    const moved = await run(root, { cache, overlay: { 'src/ui/utils.ts': 'export const KEEP = 1;\n', 'src/ui/slug.ts': TO_SLUG } });
    expect(moved.insights.clones?.[0].fragments.map((f) => f.file)).toEqual(['src/lib/strings.ts', 'src/ui/slug.ts']);
    expect(compareReports(base, moved).newClones).toBeUndefined();
    // A function that shares a block with slugify but is mostly other code: listed, not "new copy-paste".
    const report = `export function report(items: string[], text: string): string {\n  const lines: string[] = [];\n  for (const item of items) lines.push(item.toUpperCase());\n  const lower = text.toLowerCase().trim();\n  const parts = lower.split(/[^a-z0-9]+/).filter((part) => part.length > 0);\n  if (parts.length === 0) {\n    return 'item';\n  }\n  const joined = parts.join('-');\n  lines.push(joined.length > 60 ? joined.slice(0, 60) : joined);\n  for (const l of lines) if (l.length > 100) throw new Error('long');\n  const result = lines.map((l, i) => \`\${i + 1}. \${l}\`).join(', ');\n  if (result.length > 5000) console.warn('long report', result.length, items.length);\n  return result.trim() || 'empty';\n}\n`;
    const partial = await run(root, { cache, overlay: { 'src/report.ts': report } });
    expect(partial.insights.clones!.some((fam) => fam.fragments.some((f) => f.name === 'report'))).toBe(true);
    expect(compareReports(base, partial).newClones).toBeUndefined();
    // …unless the configured minimum similarity is lower.
    expect(compareReports(base, partial, { config: { clones: { minSimilarity: 0.2 } } }).newClones).toHaveLength(1);
  });

  it('a copy fixed on one side so that it no longer matches is drift, not a fix; a copy replaced by a call is a fix', async () => {
    const root = project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': TO_SLUG, 'src/pages/user.ts': USER });
    const cache = createAnalyzeCache();
    const base = await run(root, { cache });
    const rewritten = SLUGIFY.replace(
      /  const lower[\s\S]*?  \}\n/,
      "  const words: string[] = [];\n  for (const w of text.normalize('NFKD').split(/\\s+/)) if (w) words.push(w.toLowerCase());\n  while (words.length > 8) words.pop();\n  if (!words.length) throw new Error('empty');\n  const parts = words;\n",
    );
    const head = await run(root, { cache, overlay: { 'src/lib/strings.ts': rewritten } });
    expect(head.insights.clones).toEqual([]);
    const delta = compareReports(base, head);
    expect(delta.fixedClones).toBeUndefined();
    expect(delta.driftedClones).toHaveLength(1);
    expect(delta.driftedClones![0]).toMatchObject({ changed: { file: 'src/lib/strings.ts', name: 'slugify', start: 1 }, untouched: [{ file: 'src/ui/utils.ts', name: 'toSlug' }], similarity: 1 });
    expect(architectureDeltaMarkdown(delta)).toContain('Clone drift: `src/lib/strings.ts:1-9` changed, its clone `src/ui/utils.ts:1-9` did not — they no longer match');
    expect(architectureDeltaMarkdown(delta)).not.toContain('merged or removed');
    // toSlug now calls slugify: merged.
    const merged = await run(root, { cache, overlay: { 'src/ui/utils.ts': "import { slugify } from '../lib/strings';\n\nexport function toSlug(input: string): string {\n  return slugify(input);\n}\n" } });
    const fixed = compareReports(base, merged);
    expect(fixed.fixedClones).toHaveLength(1);
    expect(fixed.driftedClones).toBeUndefined();
    expect(architectureDeltaMarkdown(fixed)).toContain('✅ 1 copy-paste clone merged or removed');
  });

  it('new-clone messages name the copy the new one is most similar to, with that pair’s similarity', () => {
    const f = (file: string, name: string, extra = {}) => ({ file, start: 1, end: 9, name, ...extra });
    const family: CloneFamily = {
      id: 'x',
      tokens: 120,
      lines: 9,
      similarity: 1,
      fragments: [f('src/a.ts', 'emit'), f('src/b.ts', 'emit'), f('src/new.ts', 'run', { isNew: true }), f('src/lib.ts', 'run', { exported: true, importers: 3 })],
      pairs: [
        { a: 0, b: 1, similarity: 1 },
        { a: 1, b: 2, similarity: 0.3 },
        { a: 2, b: 3, similarity: 0.92 },
      ],
    };
    expect(cloneSides(family)).toMatchObject({ copy: { file: 'src/new.ts' }, original: { file: 'src/lib.ts' }, similarity: 0.92 });
    expect(newCloneMessage(family)).toBe('run in src/new.ts is 92% similar to exported run in src/lib.ts (used in 3 files) and 2 more copies: import it instead');
    expect(newCloneMessage(family, (n) => `\`${n}\``)).toContain('`run` in src/new.ts is 92% similar to exported `run`');
    // Its only partner a small shared block: no "import it instead".
    const block = { ...family, pairs: [{ a: 0, b: 1, similarity: 1 }, { a: 1, b: 2, similarity: 0.3 }] };
    expect(newCloneMessage(block)).toBe('run in src/new.ts (lines 1-9) duplicates emit in src/b.ts (lines 1-9) and 2 more copies: extract a shared helper');
    // Prefer a copy outside tests as the original.
    const tests: CloneFamily = { id: 't', tokens: 80, lines: 9, similarity: 1, fragments: [f('src/a.test.ts', 'helper', { exported: true, importers: 9 }), f('src/new.ts', 'helper', { isNew: true }), f('src/lib.ts', 'helper')] };
    expect(cloneSides(tests).original?.file).toBe('src/lib.ts');
  });

  it('cloneDrift: one copy edited, the other not (pasted copies and comment-only edits are no drift)', () => {
    const families: CloneFamily[] = [{ id: 'f', tokens: 80, lines: 9, similarity: 1, fragments: [{ file: 'src/a.ts', start: 10, end: 20, name: 'a' }, { file: 'src/b.ts', start: 1, end: 9, name: 'b' }] }];
    const changed = (id: string, lines: number[], extra: Partial<ChangedFile> = {}): ChangedFile => ({ id, status: 'modified', additions: 1, deletions: 1, lines, added: lines, analyzed: true, ...extra });
    const [d] = cloneDrift(families, [changed('src/a.ts', [12])]);
    expect(d).toMatchObject({ changed: { file: 'src/a.ts' }, untouched: [{ file: 'src/b.ts' }], family: 'f' });
    expect(driftMessage(d)).toBe('you changed src/a.ts:10-20; its clone src/b.ts:1-9 was not changed');
    expect(cloneDrift(families, [changed('src/a.ts', [12]), changed('src/b.ts', [3])])).toEqual([]);
    expect(cloneDrift(families, [changed('src/a.ts', [12])], ['src/a.ts'])).toEqual([]);
    expect(cloneDrift(families, [changed('src/a.ts', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])])).toEqual([]);
    expect(cloneDrift(families, [changed('src/a.ts', [30])])).toEqual([]);
    // A copy pasted in a new file is a new clone: it is no "unchanged copy" of the edited one.
    const three: CloneFamily[] = [{ ...families[0], fragments: [...families[0].fragments, { file: 'src/new.ts', start: 1, end: 9, name: 'c' }] }];
    expect(cloneDrift(three, [changed('src/a.ts', [12]), changed('src/new.ts', [1, 2, 3, 4, 5, 6, 7, 8, 9], { status: 'untracked' })])[0].untouched.map((f) => f.file)).toEqual(['src/b.ts']);
    // A copy pasted into an existing file (all its lines added, but for the line git saw as unchanged) is no drift either.
    const pasted: CloneFamily[] = [{ ...families[0], fragments: [...families[0].fragments, { file: 'src/b.ts', start: 20, end: 29, name: 'c' }] }];
    expect(cloneDrift(pasted, [changed('src/b.ts', [20, 21, 22, 23, 24, 25, 26, 27, 28])])).toEqual([]);
    // Small shared blocks (low similarity) drift only when their files are committed together.
    const block: CloneFamily[] = [{ ...families[0], similarity: 0.35, pairs: [{ a: 0, b: 1, similarity: 0.35 }] }];
    expect(cloneDrift(block, [changed('src/a.ts', [12])])).toEqual([]);
    expect(cloneDrift([{ ...block[0], coChanges: 6 }], [changed('src/a.ts', [12])])).toHaveLength(1);
    expect(cloneDrift([{ ...block[0], similarity: 0.1, pairs: [{ a: 0, b: 1, similarity: 0.1 }], coChanges: 6 }], [changed('src/a.ts', [12])])).toEqual([]);
    expect(cloneDrift(block, [changed('src/a.ts', [12])], [], 0.3)).toHaveLength(1);
    // Only the copies the edited one is similar to are named.
    const mixed: CloneFamily[] = [{ id: 'm', tokens: 80, lines: 9, similarity: 1, fragments: [...families[0].fragments, { file: 'src/c.ts', start: 1, end: 9, name: 'c' }], pairs: [{ a: 0, b: 1, similarity: 1 }, { a: 0, b: 2, similarity: 0.2 }] }];
    expect(cloneDrift(mixed, [changed('src/a.ts', [12])])[0].untouched.map((f) => f.file)).toEqual(['src/b.ts']);
  });

  it('the gate says when it cannot judge, and judges by the added lines when the comparison failed', () => {
    const fam: CloneFamily = { id: 'f', tokens: 80, lines: 9, similarity: 1, fragments: [{ file: 'src/a.ts', start: 1, end: 9, name: 'a', exported: true }, { file: 'src/b.ts', start: 1, end: 9, name: 'b' }] };
    const data = (extra: Partial<ReportData>) => ({ insights: { clones: [fam] }, ...extra }) as unknown as ReportData;
    const ctx = (extra: Partial<GateContext> = {}): GateContext => ({ mode: 'changed', newOnly: false, thresholds: { maxNewClones: 0 }, inScope: () => true, ...extra });
    expect(clonesGate({ insights: {} } as unknown as ReportData, ctx())).toMatchObject({ ok: true, detail: 'not judged: clone detection is off ("clones": false)' });
    expect(clonesGate(data({}), ctx({ mode: 'all' }))).toMatchObject({ ok: true, detail: 'not judged: no base to compare with (needs git)' });
    expect(clonesGate(data({ changes: { files: [] } as never }), ctx({ mode: 'all' }))).toMatchObject({ ok: true, detail: 'no new clones (max 0) · nothing changed' });
    const pastedB = { id: 'src/b.ts', status: 'untracked', additions: 9, deletions: 0, lines: [1, 2, 3, 4, 5, 6, 7, 8, 9], analyzed: true } as ChangedFile;
    const fallback = clonesGate(data({ changes: { files: [pastedB] } as never }), ctx())!;
    expect(fallback).toMatchObject({ ok: false, detail: '1 new clone (max 0) · judged by the added lines (no base to compare with)' });
    expect(fallback.findings[0]).toMatchObject({ file: 'src/b.ts', ruleId: 'cv/duplicate-code', status: 'new' });
    expect(pastedClones([fam], [{ ...pastedB, id: 'src/c.ts' }])).toEqual([]);
    // With a comparison: new, fixed and drifted families are counted.
    const delta = { newClones: [], fixedClones: [fam], driftedClones: [{ changed: fam.fragments[0], untouched: [fam.fragments[1]] }] } as never;
    const judged = clonesGate(data({}), ctx({ delta }))!;
    expect(judged).toMatchObject({ ok: true, detail: 'no new clones (max 0) · 1 fixed · 1 drifted apart (see clone drift)' });
    expect(judged.fixed?.[0]).toMatchObject({ status: 'fixed', severity: 'note', fingerprint: cloneFingerprint(fam) });
  });

  describe.skipIf(!hasGit)('with git', () => {
    let restoreEnv: () => void;
    beforeAll(() => {
      restoreEnv = isolateGit();
    });
    afterAll(() => restoreEnv?.());

    function repoWithClone(): string {
      const repo = initRepo('react-vite-ts');
      writeFile(repo, 'src/lib/strings.ts', SLUGIFY);
      writeFile(repo, 'src/ui/utils.ts', TO_SLUG);
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'Add helpers' });
      return repo;
    }

    it('My changes and pr report clone drift when only one copy is edited', async () => {
      const repo = repoWithClone();
      editFile(repo, 'src/lib/strings.ts', "return 'item';", "return 'untitled';");
      const data = await analyze({ root: repo, history: false, includeSource: false });
      expect(data.changes?.cloneDrift).toHaveLength(1);
      expect(data.changes!.cloneDrift![0]).toMatchObject({ changed: { file: 'src/lib/strings.ts', name: 'slugify' }, untouched: [{ file: 'src/ui/utils.ts', name: 'toSlug' }] });
      expect(prSummaryMarkdown(data)).toContain('Clone drift: `src/lib/strings.ts:1-9` changed, its clone `src/ui/utils.ts:1-9` did not');
    });

    it('My changes and pr: editing the function next to a copy, or pasting a copy, is no drift', async () => {
      const repo = initRepo('react-vite-ts');
      writeFile(repo, 'src/lib/strings.ts', `${SLUGIFY}export function debounce(fn: () => void, ms = 200): () => void {\n  let t: ReturnType<typeof setTimeout> | undefined;\n  return () => {\n    clearTimeout(t);\n    t = setTimeout(fn, ms);\n  };\n}\n`);
      writeFile(repo, 'src/ui/utils.ts', `${TO_SLUG}export function round2(v: number): number {\n  return Math.round(v * 100) / 100;\n}\n`);
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'Add helpers' });
      editFile(repo, 'src/lib/strings.ts', 'ms = 200', 'ms = 300');
      const next = await analyze({ root: repo, history: false, includeSource: false, compare: true });
      expect(next.changes?.cloneDrift).toBeUndefined();
      // A copy pasted right before an existing function is a new clone, not drift.
      git(repo, ['checkout', '-q', '--', '.']);
      editFile(repo, 'src/ui/utils.ts', 'export function round2', `${TO_SLUG.replace('toSlug', 'slugAgain')}export function round2`);
      const pasted = await analyze({ root: repo, history: false, includeSource: false, compare: true });
      expect(pasted.changes?.cloneDrift).toBeUndefined();
      expect(pasted.changes?.delta?.newClones).toHaveLength(1);
      expect(pasted.changes!.delta!.newClones![0].fragments.find((f) => f.isNew)).toMatchObject({ file: 'src/ui/utils.ts', name: 'slugAgain', start: 10, end: 18 });
    });

    it('pr reports a copy fixed on one side as drift, not as a merged clone', async () => {
      const repo = repoWithClone();
      editFile(repo, 'src/lib/strings.ts', "  if (parts.length === 0) {\n    return 'item';\n  }\n", '');
      const data = await analyze({ root: repo, history: false, includeSource: false, compare: true });
      expect(data.changes?.cloneDrift).toHaveLength(1);
      expect(data.changes!.cloneDrift![0]).toMatchObject({ changed: { file: 'src/lib/strings.ts' }, untouched: [{ file: 'src/ui/utils.ts' }] });
      const md = prSummaryMarkdown(data);
      expect(md).toContain('Clone drift: `src/lib/strings.ts:1-');
      expect(md).not.toContain('merged or removed');
      expect(md.match(/Clone drift/g)).toHaveLength(1);
    });

    it('check --max-new-clones 0 passes on existing clones and fails on a new one', async () => {
      const repo = repoWithClone();
      expect((await cli('check', repo, '--max-new-clones', '0', '--no-cache')).code).toBe(0);
      // Edited copies and other edits compared with the base: still no new clone.
      editFile(repo, 'src/lib/strings.ts', "return 'item';", "return 'untitled';");
      editFile(repo, 'src/utils/math.ts', 'const factor = 10 ** digits;', 'const factor = Math.pow(10, digits);');
      const edited = JSON.parse((await cli('check', repo, '--changed', '--max-new-clones', '0', '--no-cache', '--format', 'json')).stdout) as { gates: { id: string; ok: boolean; detail: string }[] };
      expect(edited.gates.find((g) => g.id === 'clones')).toMatchObject({ ok: true, detail: 'no new clones (max 0)' });
      git(repo, ['checkout', '-q', '--', '.']);
      expect((await cli('check', repo, '--max-new-clones', '-1')).code).toBe(2);
      writeFile(repo, 'src/pages/copy.ts', TO_SLUG.replace('toSlug', 'slugAgain'));
      const res = await cli('check', repo, '--max-new-clones', '0', '--no-cache');
      expect(res.code).toBe(1);
      expect(res.stdout).toMatch(/✖ New duplication 1 new clone \(max 0\)/);
      expect(res.stdout).toContain('src/pages/copy.ts:1 slugAgain in src/pages/copy.ts is 100% similar to');
      const report = JSON.parse((await cli('check', repo, '--changed', '--max-new-clones', '0', '--no-cache', '--format', 'json')).stdout) as { ok: boolean; gates: { id: string; ok: boolean; findings: { ruleId: string; status: string }[] }[] };
      expect(report.ok).toBe(false);
      expect(report.gates.find((g) => g.id === 'clones')).toMatchObject({ ok: false, findings: [{ ruleId: 'cv/duplicate-code', status: 'new' }] });
      // SARIF: Type-2 token matching is not "very-high" precision.
      const rules = sarifLog(report as never, { version: '1.0.0' }).runs[0].tool.driver.rules as { id: string; properties: { precision: string } }[];
      expect(rules.find((r) => r.id === 'cv/duplicate-code')?.properties.precision).toBe('medium');
      expect(rules.find((r) => r.id === 'cv/cycle')?.properties.precision).toBe('very-high');
      // A limit of 1 allows it; the config key works like the flag.
      expect((await cli('check', repo, '--max-new-clones', '1', '--no-cache')).code).toBe(0);
      writeFile(repo, 'code-visualizer.config.json', JSON.stringify({ check: { maxNewClones: 0 } }));
      expect((await cli('check', repo, '--no-cache')).code).toBe(1);
    });

    it('similar finds the other copy from a file range (text and --json)', async () => {
      const repo = repoWithClone();
      const res = await cli('similar', 'src/ui/utils.ts:1-9', '--root', repo, '--no-cache');
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Similar to toSlug src/ui/utils.ts:1-9');
      expect(res.stdout).toMatch(/100%\s+slugify\(text: string\): string\s+src\/lib\/strings\.ts:1/);
      expect(res.stdout).toContain('Already copied');
      // The family is described by its shared tokens, not by a second percentage for the same two functions.
      expect(res.stdout).toMatch(/≈ slugify src\/lib\/strings\.ts:1-9 {2}\d+ shared tokens/);
      expect(res.stdout).toContain('Import slugify from src/lib/strings.ts instead of keeping this copy.');
      const json = JSON.parse((await cli('similar', 'toSlug', '--root', repo, '--no-cache', '--json')).stdout) as { query: { file: string; name: string }; matches: { symbol: string; similarity: number }[] };
      expect(json.query).toMatchObject({ file: 'src/ui/utils.ts', name: 'toSlug' });
      expect(json.matches[0]).toMatchObject({ symbol: 'src/lib/strings.ts#slugify', similarity: 1 });
      expect((await cli('similar', 'nothingLikeThis', '--root', repo, '--no-cache')).code).toBe(1);
      expect((await cli('similar', '--root', repo)).code).toBe(2);
      expect((await cli('similar', 'a.ts', '--min', '120', '--root', repo)).code).toBe(2);
      // Lines that are not in the file; a mistyped file; a language that is not one.
      const far = await cli('similar', 'src/ui/utils.ts:500', '--root', repo, '--no-cache');
      expect(far.code).toBe(2);
      expect(far.stderr).toContain('src/ui/utils.ts has 9 lines: line 500 is not in it.');
      const typo = await cli('similar', 'src/ui/utilz.ts:3', '--root', repo, '--no-cache');
      expect(typo.code).toBe(1);
      expect(typo.stderr).toMatch(/Did you mean: .*src\/ui\/utils\.ts/);
      expect((await cli('similar', '--stdin', '--lang', 'py', '--root', repo)).stderr).toContain('--lang must be one of ts, tsx');
      // --min 0.8 is 80%, like the MCP tool's min_similarity.
      expect((await cli('similar', 'toSlug', '--min', '0.8', '--root', repo, '--no-cache')).stdout).toContain('at least 80% similar');
    });

    it('similar on the exported, used original says to keep it (not to import its copy)', async () => {
      const repo = repoWithClone();
      writeFile(repo, 'src/pages/user.ts', USER);
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'Use slugify' });
      const res = await cli('similar', 'src/lib/strings.ts#slugify', '--root', repo, '--no-cache');
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Keep slugify (exported · used in 1 file): replace toSlug in src/ui/utils.ts with an import of it.');
      expect(res.stdout).not.toContain('Import toSlug');
    });

    it('review names a copy the branch adds', async () => {
      const repo = repoWithClone();
      git(repo, ['checkout', '-q', '-b', 'feature']);
      writeFile(repo, 'src/pages/copy.ts', TO_SLUG.replace('toSlug', 'slugAgain'));
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(1), message: 'Copy' });
      git(repo, ['checkout', '-q', 'main']);
      const res = await cli('review', 'feature', '--root', repo, '--no-cache');
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/! new copy slugAgain in src\/pages\/copy\.ts is 100% similar to/);
      expect(res.stdout).toMatch(/Code health {2}\d+ → \d+ \(−\d+\) .*duplication \d+ → \d+/);
    });

    // integration (wave 4): review-mode shows drift of copies that still match, not only of those that no longer do.
    it('review names a copy the branch edited while its clone stayed as it was', async () => {
      const repo = repoWithClone();
      git(repo, ['checkout', '-q', '-b', 'fix']);
      editFile(repo, 'src/lib/strings.ts', "return 'item';", "return 'untitled';");
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(1), message: 'Fix one copy' });
      git(repo, ['checkout', '-q', 'main']);
      const res = await cli('review', 'fix', '--root', repo, '--no-cache');
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('! clone drift you changed src/lib/strings.ts:1-9; its clone src/ui/utils.ts:1-9 was not changed');
    });
  });
});

// --- release fixes: a change next to a copy never makes it new; per-declaration boilerplate ---
/** One of 60 near-identical components; `trailer` varies what follows it in its file. */
const WIDGET = (i: number): string => `import { useState } from 'react';

export function Widget${i}({ items, limit }: { items: string[]; limit: number }) {
  const [open, setOpen] = useState(false);
  const visible = open ? items : items.slice(0, limit);
  const total = items.reduce((n, item) => n + item.length, 0);
  if (!items.length) return <p className="empty">Nothing here</p>;
  return (
    <section className="widget">
      <h2>{visible.length} of {items.length} ({total} chars)</h2>
      <ul>{visible.map((item) => <li key={item}>{item.trim()}</li>)}</ul>
      <button onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>
    </section>
  );
}
${[``, `export const ORDER_${i} = ${i};\n`, `export function label${i}(x: string): string {\n  return x.toUpperCase();\n}\n`, `export default Widget${i};\n`][i % 4]}`;

describe('clone-radar: stable copies (release fixes)', () => {
  it('fingerprints each declaration on its own: code appended after a function changes nothing about its copies', () => {
    const source = (id: string, text: string): CloneSource => {
      const tokens = cloneTokens(text, '.ts');
      const units = [{ start: 1, end: 9, name: id.includes('b') ? 'toSlug' : 'slugify', symbol: `${id}#f`, exported: true, callable: true, info: {} as never }];
      return { id, tokens, units, test: false };
    };
    const before = detectClones([source('src/a.ts', SLUGIFY), source('src/b.ts', TO_SLUG)]);
    const after = detectClones([source('src/a.ts', SLUGIFY), source('src/b.ts', `${TO_SLUG}export const EXTRA = 1;\nexport const MORE = [1, 2, 3].map((n) => n * 2);\n`)]);
    expect(after.map(fragmentsOf)).toEqual(before.map(fragmentsOf));
    expect(after.map((f) => f.id)).toEqual(before.map((f) => f.id));
  });

  it('keeps the pairs of unchanged files between runs and matches only the changed ones (same families as a cold run)', async () => {
    const root = project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': TO_SLUG, 'src/cli/context.ts': COMMAND('context'), 'src/cli/diff.ts': COMMAND('diff'), 'src/pages/user.ts': USER });
    const cache = createAnalyzeCache();
    const first = await run(root, { cache });
    const slug = (fams: CloneFamily[] | undefined) => fams?.find((fam) => fam.fragments.some((f) => f.name === 'toSlug'));
    // Mark the cached pair of two files that will not change: a warm run that re-matched them would lose the mark.
    const cached = cache.clones!.pairs.find((p) => [p.a, p.b].sort().join() === 'src/lib/strings.ts,src/ui/utils.ts')!;
    expect(cached.similarity).toBe(1);
    cached.similarity = 0.42;
    writeFile(root, 'src/pages/user.ts', `${USER}export const EXTRA = 1;\n`);
    const warm = await run(root, { cache });
    expect(slug(warm.insights.clones)?.similarity).toBe(0.42);
    // Editing one of the two files matches it again.
    writeFile(root, 'src/ui/utils.ts', `${TO_SLUG}export const KEEP = 1;\n`);
    const again = await run(root, { cache });
    expect(slug(again.insights.clones)?.similarity).toBe(1);
    // Warm runs find what a cold run finds.
    const cold = await run(root);
    expect(again.insights.clones).toEqual(cold.insights.clones);
    expect(again.insights.clones).toEqual(first.insights.clones);
    // A copy pasted into a changed file is found against the unchanged ones.
    writeFile(root, 'src/pages/user.ts', `${USER}\n${TO_SLUG.replace('toSlug', 'slugAgain')}`);
    const pasted = await run(root, { cache });
    expect(pasted.insights.clones).toEqual((await run(root)).insights.clones);
    expect(pasted.insights.clones!.some((fam) => fam.fragments.some((f) => f.name === 'slugAgain'))).toBe(true);
  });

  describe.skipIf(!hasGit)('sixty near-identical components with varied trailers', () => {
    let restoreEnv: () => void;
    let repo: string;
    beforeAll(() => {
      restoreEnv = isolateGit();
      repo = path.join(makeTempDir('cv-widgets-'), 'app');
      writeFile(repo, 'package.json', JSON.stringify({ name: 'widgets', version: '1.0.0', dependencies: { react: '^18.3.1' }, devDependencies: { typescript: '^5.6.2' } }));
      writeFile(repo, 'src/lib/strings.ts', SLUGIFY);
      for (let i = 0; i < 60; i++) writeFile(repo, `src/widgets/Widget${i}.tsx`, WIDGET(i));
      git(repo, ['init', '-q', '-b', 'main']);
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'Widgets' });
      git(repo, ['checkout', '-q', '-b', 'feature']);
    });
    afterAll(() => restoreEnv?.());

    it('appending `export const EXTRA = 1;` to one of them adds no clone: check, diff and the live guard agree', async () => {
      for (const i of [0, 4, 8, 1]) {
        const file = `src/widgets/Widget${i}.tsx`;
        const before = await analyze({ root: repo, git: false, history: false, includeSource: false });
        fs.appendFileSync(path.join(repo, file), 'export const EXTRA = 1;\n');
        try {
          const check = await cli('check', repo, '--changed', '--max-new-clones', '0', '--no-cache');
          expect(check.code, `${file}: ${check.stdout}`).toBe(0);
          expect(check.stdout).toMatch(/✔ New duplication no new clones \(max 0\)/);
          const diff = JSON.parse((await cli('diff', 'main', repo, '--json', '--no-cache')).stdout) as { delta: { newClones?: unknown[]; fixedClones?: unknown[] } };
          expect(diff.delta.newClones, file).toBeUndefined();
          expect(diff.delta.fixedClones, file).toBeUndefined();
          const after = await analyze({ root: repo, git: false, history: false, includeSource: false });
          const guard = new LiveGuard();
          expect(guard.update(before, after, [file]).filter((e) => e.kind === 'clone-added'), file).toEqual([]);
          expect(guard.update(after, before, [file]).filter((e) => e.kind === 'clone-added'), file).toEqual([]);
        } finally {
          git(repo, ['checkout', '-q', '--', '.']);
        }
      }
    });

    it('a real new copy still fails the gate', async () => {
      writeFile(repo, 'src/pages/copy.ts', TO_SLUG);
      try {
        const res = await cli('check', repo, '--changed', '--max-new-clones', '0', '--no-cache');
        expect(res.code).toBe(1);
        expect(res.stdout).toMatch(/✖ New duplication 1 new clone \(max 0\)/);
        expect(res.stdout).toContain('toSlug in src/pages/copy.ts is 100% similar to exported slugify in src/lib/strings.ts');
      } finally {
        fs.rmSync(path.join(repo, 'src/pages'), { recursive: true, force: true });
      }
    });
  });

  it.skipIf(!hasGit)('judges the head with the base’s boilerplate: the copy that tips a fingerprint over the limit is still new', async () => {
    const restore = isolateGit();
    try {
      // Fifty copies of one function: still a family. A fifty-first makes its fingerprints boilerplate on its own.
      const root = path.join(makeTempDir('cv-limit-'), 'app');
      writeFile(root, 'package.json', JSON.stringify({ name: 'limit', version: '1.0.0', devDependencies: { typescript: '5.0.0' } }));
      for (let i = 0; i < 50; i++) writeFile(root, `src/copies/c${i}.ts`, TO_SLUG.replace('toSlug', `toSlug${i}`));
      git(root, ['init', '-q', '-b', 'main']);
      commitAll(root, { author: 'Alice Archer', date: daysAgo(2), message: 'Fifty copies' });
      const base = await analyze({ root, history: false, includeSource: false, changes: false });
      expect(base.insights.clones?.[0]?.fragments).toHaveLength(50);
      expect(base.insights.cloneBoilerplate).toEqual([]);
      writeFile(root, 'src/copies/c50.ts', TO_SLUG.replace('toSlug', 'toSlug50'));
      const head = await analyze({ root, history: false, includeSource: false, compare: true });
      // On its own the head no longer sees the family (its fingerprints are in 51 declarations)…
      expect(head.insights.cloneBoilerplate!.length).toBeGreaterThan(0);
      expect(head.insights.clones).toEqual([]);
      // …but judged with the base's boilerplate, the new copy is new.
      expect(head.changes?.delta?.newClones).toHaveLength(1);
      expect(head.changes!.delta!.newClones![0].fragments.filter((f) => f.isNew).map((f) => f.file)).toEqual(['src/copies/c50.ts']);
      expect(head.changes?.delta?.fixedClones).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe('clone-radar: health, live guard, config and cache', () => {
  it('health has a Duplication category of weight 10; the others keep their proportions', async () => {
    const table = `export const TABLE = [\n${Array.from({ length: 120 }, (_, i) => `  ${i * 7},`).join('\n')}\n];\n`;
    const data = await run(project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': TO_SLUG, 'src/pages/user.ts': USER, 'src/table.ts': table }));
    const dup = data.health.categories.find((c) => c.id === 'duplication');
    expect(dup).toMatchObject({ label: 'Duplication', weight: 10 });
    expect(dup!.score).toBeLessThan(100);
    expect(dup!.detail).toMatch(/% of the source lines are copies \(18 lines in 1 clone family\)/);
    // 20 → 18, 15 → 13.5, 10 → 9 (Knowledge spread, 9, needs git): with it they add up to 100.
    expect(data.health.categories.map((c) => c.weight)).toEqual([18, 18, 9, 13.5, 9, 13.5, 10]);
    expect(data.history.at(-1)?.duplication).toBeGreaterThan(0);
    expect(data.health.improvements.find((i) => i.id === 'duplication')).toMatchObject({ title: 'Merge the largest copy-paste clone', detail: 'slugify exists twice' });
    const clean = await run(project({ 'src/lib/strings.ts': SLUGIFY, 'src/pages/user.ts': USER }));
    expect(clean.health.categories.find((c) => c.id === 'duplication')).toMatchObject({ score: 100, detail: 'No copy-paste clones' });
  });

  it('serve announces a new copy once ("import it instead") and its removal', async () => {
    const root = project({ 'src/lib/strings.ts': SLUGIFY, 'src/pages/user.ts': USER });
    const cache = createAnalyzeCache();
    const before = await run(root, { cache });
    const after = await run(root, { cache, overlay: { 'src/ui/utils.ts': TO_SLUG } });
    const candidates = liveCandidates(before, after, ['src/ui/utils.ts']).filter((c) => c.event.kind === 'clone-added');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].event).toMatchObject({ severity: 'warning', files: ['src/ui/utils.ts', 'src/lib/strings.ts'], line: 1 });
    expect(candidates[0].event.message).toBe('toSlug in src/ui/utils.ts is 100% similar to exported slugify in src/lib/strings.ts (used in 1 file): import it instead');
    expect(candidates[0].stillOpen?.(after)).toBe(true);
    expect(candidates[0].stillOpen?.(before)).toBe(false);
    // Through the guard: announced once.
    const events = diffLive(before, after, ['src/ui/utils.ts']).filter((e) => e.kind === 'clone-added');
    expect(events).toHaveLength(1);
  });

  it('mcp --help lists every tool, find_similar included', async () => {
    const help = (await cli('mcp', '--help')).stdout.replace(/\s+/g, ' ');
    for (const tool of TOOLS) expect(help).toContain(tool.name);
  });

  it('accepts the clones block in every shape and check.maxNewClones as a number', () => {
    expect(normalizeConfig({ clones: false }).config.clones).toEqual({ enabled: false });
    expect(normalizeConfig({ clones: 'src/gen/**' }).config.clones).toEqual({ ignore: ['src/gen/**'] });
    expect(normalizeConfig({ clones: { minTokens: '40', minLines: 4, ignore: 'x/**' } }).config.clones).toEqual({ minTokens: 40, minLines: 4, ignore: ['x/**'] });
    expect(normalizeConfig({ clones: { minToken: 3 } }).error).toMatch(/unknown key "minToken" — did you mean "minTokens"/);
    expect(normalizeConfig({ clones: { minLines: -1 } }).error).toMatch(/clones\.minLines must be a positive number/);
    expect(normalizeConfig({ check: { maxNewClones: '0' } }).config.check?.maxNewClones).toBe(0);
    expect(normalizeConfig({ check: { maxNewClones: -1 } }).error).toMatch(/check\.maxNewClones must be 0 or more/);
    // minSimilarity as a share or a percentage.
    expect(normalizeConfig({ clones: { minSimilarity: 0.6 } }).config.clones).toEqual({ minSimilarity: 0.6 });
    expect(normalizeConfig({ clones: { minSimilarity: 60 } }).config.clones).toEqual({ minSimilarity: 0.6 });
    expect(normalizeConfig({ clones: { minSimilarity: '60%' } }).config.clones).toEqual({ minSimilarity: 0.6 });
    expect(normalizeConfig({ clones: { minSimilarity: -2 } }).error).toMatch(/clones\.minSimilarity must be between 0 and 1/);
    expect(cloneSettings({ enabled: false })).toBeUndefined();
    expect(cloneSettings(undefined)).toEqual({ minTokens: 50, minLines: 6, ignore: [], minSimilarity: 0.5 });
  });

  it('keeps the token arrays in the warm parse cache (base64 in JSON, lines as small deltas)', async () => {
    const tokens = cloneTokens(SLUGIFY, '.ts');
    const json = serialize({ tokens });
    const back = deserialize<{ tokens: typeof tokens }>(json);
    expect(back.tokens.kinds).toBeInstanceOf(Uint8Array);
    expect(back.tokens.lines).toBeInstanceOf(Uint32Array);
    expect([...back.tokens.kinds]).toEqual([...tokens.kinds]);
    expect([...back.tokens.lines]).toEqual([...tokens.lines]);
    // One byte per token for the lines (not four), and any Uint32Array survives, decreasing or huge values too.
    expect(json.length).toBeLessThan(tokens.kinds.length * 3.5); // (Uint32 bytes alone would be 5.3 per token)
    const odd = Uint32Array.from([0, 4_000_000_000, 7, 7, 1, 300]);
    expect([...deserialize<{ v: Uint32Array }>(serialize({ v: odd })).v]).toEqual([...odd]);
    // Older caches (`$u32` bytes) still load.
    expect([...deserialize<{ v: Uint32Array }>(JSON.stringify({ v: { $u32: Buffer.from(odd.buffer).toString('base64') } })).v]).toEqual([...odd]);
    // analyze() writes the tokens to the disk cache and a warm run uses them.
    const root = project({ 'src/lib/strings.ts': SLUGIFY, 'src/ui/utils.ts': TO_SLUG });
    await analyze({ root, git: false, history: false, includeSource: false, persist: true });
    const cache = createAnalyzeCache();
    expect(loadDiskCache(root, cache)).toBe(true);
    expect([...cache.files.get('src/ui/utils.ts')!.parsed.tokens!.lines]).toEqual([...cloneTokens(TO_SLUG, '.ts').lines]);
    const warm = await analyze({ root, git: false, history: false, includeSource: false, cache });
    expect(warm.stats.cache).toMatchObject({ parsed: 0 });
    expect(warm.insights.clones).toHaveLength(1);
    // Units split classes into members.
    expect(unitsOf({ symbols: [] })).toEqual([]);
  });

  it('indexes 2,000 files of about 200 lines quickly (soft limit)', () => {
    let seed = 7;
    const rnd = (n: number): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
    const ops = ['+', '-', '*', '/', '%', '&&', '||', '??', '===', '!==', '<', '>='];
    const statement = (): string => {
      switch (rnd(8)) {
        case 0: return `const v = a ${ops[rnd(ops.length)]} b ${ops[rnd(ops.length)]} ${rnd(9)};`;
        case 1: return `if (x.${['size', 'length'][rnd(2)]} ${ops[rnd(ops.length)]} ${rnd(9)}) return ${rnd(2) ? 'null' : 'x'};`;
        case 2: return `for (const item of list) { total ${['+=', '-=', '*='][rnd(3)]} item.a; }`;
        case 3: return `result.push(${['await ', ''][rnd(2)]}load(\`/api/\${id}\`));`;
        case 4: return `while (i < n) { i${['++', '--'][rnd(2)]}; }`;
        case 5: return `try { run(${rnd(5)}); } catch (error) { log(error); }`;
        case 6: return `switch (kind) { case ${rnd(9)}: return 'k'; default: break; }`;
        default: return `x = typeof y === 'string' ? y.trim() : String(y ?? '');`;
      }
    };
    const files: string[] = [];
    for (let f = 0; f < 2000; f++) {
      let text = '';
      for (let i = 0; i < 20; i++) text += `export function f${i}(a: number, b: number) {\n${Array.from({ length: 8 }, () => `  ${statement()}`).join('\n')}\n}\n`;
      files.push(text);
    }
    // A distinctive helper in the first file, copied (renamed) into the last one.
    files[0] = `${SLUGIFY}${files[0]}`;
    files[1999] += `\n${TO_SLUG}`;
    const started = performance.now();
    const sources: CloneSource[] = files.map((text, i) => ({ id: `src/f${i}.ts`, tokens: cloneTokens(text, '.ts'), units: [], test: false }));
    const families = detectClones(sources);
    const ms = performance.now() - started;
    expect(families.some((fam) => fam.fragments.some((f) => f.file === 'src/f0.ts' && f.start === 1) && fam.fragments.some((f) => f.file === 'src/f1999.ts'))).toBe(true);
    // Target: under 1.5 s on a developer machine; generous here for slow CI runners.
    expect(ms).toBeLessThan(6000);
  });
});

describe('clone-radar: the fixtures', () => {
  it('react-vite-ts has no copy-paste clones (and a perfect Duplication score)', async () => {
    const data = await run(fixtureDir('react-vite-ts'));
    expect(data.insights.clones).toEqual([]);
    expect(data.health.categories.find((c) => c.id === 'duplication')?.score).toBe(100);
  });

  it('works on a git checkout with history: co-changes rank a family and are shown as drift risk', async () => {
    if (!hasGit) return;
    const restore = isolateGit();
    try {
      const repo = initRepo('react-vite-ts');
      writeFile(repo, 'src/lib/strings.ts', SLUGIFY);
      writeFile(repo, 'src/ui/utils.ts', TO_SLUG);
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(9), message: 'helpers' });
      for (let i = 0; i < 3; i++) {
        editFile(repo, 'src/lib/strings.ts', /return '[a-z0-9]+';/, `return 'item${i}';`);
        editFile(repo, 'src/ui/utils.ts', /return '[a-z0-9]+';/, `return 'entry${i}';`);
        commitAll(repo, { author: 'Alice Archer', date: daysAgo(8 - i), message: `tweak ${i}` });
      }
      expect(git(repo, ['log', '--oneline']).trim().split('\n')).toHaveLength(4);
      const data = await analyze({ root: repo, history: false, includeSource: false, changes: false });
      expect(data.insights.clones?.[0].coChanges).toBeGreaterThanOrEqual(3);
    } finally {
      restore();
    }
  });
});
