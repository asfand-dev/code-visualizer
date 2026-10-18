import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { planCycleFix } from '../src/shared/cycles.js';
import type { ReportData } from '../src/shared/types.js';
import { makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

async function analyzeProject(files: Record<string, string>): Promise<ReportData> {
  const root = makeTempDir('cv-cycles-');
  writeFile(root, 'package.json', JSON.stringify({ name: 'app' }));
  for (const [file, text] of Object.entries(files)) writeFile(root, file, text);
  return analyze({ root, git: false, history: false, includeSource: false });
}

const plan = (data: ReportData, maxCuts?: number) => planCycleFix(data, data.insights.cycles[0], maxCuts);

describe('planCycleFix', () => {
  it('makes an import that only carries types a type import: the free fix', async () => {
    const data = await analyzeProject({
      'src/a.ts': "import { LIMIT } from './b';\nexport interface Config {\n  limit: number;\n}\nexport const a = (): number => LIMIT;\n",
      'src/b.ts': "import { Config } from './a';\nexport const LIMIT = 3;\nexport const cfg: Config = { limit: LIMIT };\n",
    });
    const result = plan(data);
    expect(result.complete).toBe(true);
    expect(result.cuts).toHaveLength(1);
    expect(result.cuts[0]).toMatchObject({ source: 'src/b.ts', target: 'src/a.ts', names: ['Config'], action: 'import-type', effort: 'trivial' });
    expect(result.cuts[0].advice).toContain('import type');
  });

  it('moves a shared value out when a cycle comes from one small import', async () => {
    const data = await analyzeProject({
      'src/a.ts': "import { LIMIT } from './b';\nexport function fromA(): number {\n  return LIMIT;\n}\n",
      'src/b.ts': "import { fromA } from './a';\nexport const LIMIT = 3;\nexport const double = (): number => fromA() * 2;\n",
    });
    expect(data.insights.cycles).toHaveLength(1);
    const result = plan(data);
    expect(result.complete).toBe(true);
    expect(result.cuts).toHaveLength(1);
    expect(result.cuts[0]).toMatchObject({ action: 'move-to-shared', effort: 'small' });
    expect(result.cuts[0].advice).toMatch(/move/);
  });

  it('cuts the cheaper import, not the one that pulls in a whole module', async () => {
    const data = await analyzeProject({
      'src/a.ts': "import * as b from './b';\nexport const fromA = (): number => b.one() + b.two();\n",
      'src/b.ts': "import { fromA } from './a';\nexport const one = (): number => 1;\nexport const two = (): number => fromA();\n",
    });
    const [cut] = plan(data).cuts;
    expect(cut).toMatchObject({ source: 'src/b.ts', target: 'src/a.ts', names: ['fromA'] });
  });

  it('asks for the whole cycle to be broken in as many cuts as it takes', async () => {
    const data = await analyzeProject({
      'src/a.ts': "import { b } from './b';\nexport const a = (): number => b();\n",
      'src/b.ts': "import { a } from './a';\nimport { c } from './c';\nexport const b = (): number => a() + c();\n",
      'src/c.ts': "import { b } from './b';\nexport const c = (): number => b();\n",
    });
    expect(data.insights.cycles).toHaveLength(1);
    expect(data.insights.cycles[0].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const full = plan(data);
    expect(full.cuts).toHaveLength(2);
    expect(full.complete).toBe(true);
    // Each cut points at a real import of the project.
    for (const cut of full.cuts) expect(data.edges.some((e) => e.source === cut.source && e.target === cut.target)).toBe(true);
    const partial = plan(data, 1);
    expect(partial.cuts).toHaveLength(1);
    expect(partial.complete).toBe(false);
  });

  it('plans nothing for files that are not in a cycle', async () => {
    const data = await analyzeProject({
      'src/a.ts': "import { b } from './b';\nexport const a = (): number => b();\n",
      'src/b.ts': 'export const b = (): number => 1;\n',
    });
    expect(planCycleFix(data, ['src/a.ts', 'src/b.ts'])).toEqual({ cuts: [], complete: true });
  });

  it('plans nothing for an empty cycle', async () => {
    const data = await analyzeProject({ 'src/a.ts': 'export const a = 1;\n' });
    expect(planCycleFix(data, [])).toEqual({ cuts: [], complete: true });
  });
});
