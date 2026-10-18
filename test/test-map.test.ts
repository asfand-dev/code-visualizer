import { describe, expect, it } from 'vitest';
import { buildTestMap, detectTestRunners, isE2eTest, isTestableSource, testCommand } from '../src/analyzer/tests.js';
import type { DependencyEdge, FileKind } from '../src/shared/types.js';

const f = (id: string, kind: FileKind) => ({ id, kind });
const e = (source: string, target: string, typeOnly = false): DependencyEdge => ({ source, target, kind: 'import', typeOnly, names: ['x'], line: 1, specifier: target });

describe('isTestableSource', () => {
  it('excludes tests, stories, configs, scripts, type modules and declaration files', () => {
    expect(isTestableSource(f('src/a.ts', 'util'))).toBe(true);
    expect(isTestableSource(f('src/Button.tsx', 'component'))).toBe(true);
    for (const kind of ['test', 'story', 'config', 'script', 'types'] as const) expect(isTestableSource(f('src/x.ts', kind)), kind).toBe(false);
    expect(isTestableSource(f('src/env.d.ts', 'module'))).toBe(false);
  });
});

describe('buildTestMap', () => {
  const files = [
    f('src/a.ts', 'util'),
    f('src/b.ts', 'util'),
    f('src/c.ts', 'util'),
    f('src/types.ts', 'types'),
    f('src/untested.ts', 'util'),
    f('src/a.test.ts', 'test'),
    f('src/b.test.ts', 'test'),
    f('test/helpers.ts', 'test'),
    f('vite.config.ts', 'config'),
  ];
  const edges = [
    e('src/a.test.ts', 'src/a.ts'),
    e('src/a.test.ts', 'test/helpers.ts'),
    e('test/helpers.ts', 'src/c.ts'),
    e('src/a.ts', 'src/b.ts'),
    e('src/b.ts', 'src/a.ts'), // cycle
    e('src/a.ts', 'src/types.ts', true),
    e('src/b.test.ts', 'src/b.ts'),
    e('src/b.ts', 'src/untested.ts', true), // type-only imports do not execute code
  ];
  const map = buildTestMap(files, edges);

  it('lists the test files', () => {
    expect(map.testFiles).toEqual(['src/a.test.ts', 'src/b.test.ts', 'test/helpers.ts']);
  });

  it('maps source files to the tests that reach them through runtime imports (also via helpers and cycles)', () => {
    expect(map.coveredBy.get('src/a.ts')?.sort()).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(map.coveredBy.get('src/b.ts')?.sort()).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(map.coveredBy.get('src/c.ts')?.sort()).toEqual(['src/a.test.ts', 'test/helpers.ts']);
    expect(map.coveredBy.has('src/types.ts')).toBe(false);
    expect(map.coveredBy.has('src/untested.ts')).toBe(false);
  });

  it('computes the share of testable sources that a test reaches', () => {
    // a, b, c reached; untested.ts not; types/test/config files don't count.
    expect(map.reach).toBe(3 / 4);
    expect(buildTestMap([f('src/a.ts', 'util')], []).reach).toBe(0);
    expect(buildTestMap([], []).reach).toBe(0);
  });

  it('caps the number of tests recorded per file', () => {
    const many = Array.from({ length: 60 }, (_, i) => f(`t/${i}.test.ts`, 'test'));
    const result = buildTestMap([f('src/core.ts', 'util'), ...many], many.map((t) => e(t.id, 'src/core.ts')));
    expect(result.coveredBy.get('src/core.ts')).toHaveLength(40);
  });
});

describe('detectTestRunners', () => {
  it('detects vitest, jest, mocha and ava from dependencies or the test script', () => {
    expect(detectTestRunners([{ devDependencies: { vitest: '^2.0.0' } }], undefined).unit?.id).toBe('vitest');
    expect(detectTestRunners([{ scripts: { test: 'jest --coverage' } }], undefined).unit?.id).toBe('jest');
    expect(detectTestRunners([{ devDependencies: { 'ts-jest': '^29' } }], undefined).unit?.id).toBe('jest');
    expect(detectTestRunners([{ devDependencies: { mocha: '^10' } }], undefined).unit?.id).toBe('mocha');
    expect(detectTestRunners([{ devDependencies: { ava: '^6' } }], undefined).unit?.id).toBe('ava');
    expect(detectTestRunners([{ scripts: { test: 'node --test test/' } }], undefined).unit?.id).toBe('node');
    expect(detectTestRunners([{ scripts: { test: 'bun test' } }], undefined).unit?.id).toBe('bun');
    expect(detectTestRunners([{}], 'bun').unit?.id).toBe('bun');
    expect(detectTestRunners([{ dependencies: { react: '^18' } }], undefined)).toEqual({ unit: undefined, e2e: undefined });
  });

  it('prefers vitest when several runners are installed and merges workspace packages', () => {
    const runners = detectTestRunners([{ devDependencies: { jest: '^29' } }, { devDependencies: { vitest: '^2', '@playwright/test': '^1' } }], undefined);
    expect(runners.unit?.id).toBe('vitest');
    expect(runners.e2e?.id).toBe('playwright');
    expect(detectTestRunners([{ devDependencies: { cypress: '^13' } }], undefined).e2e?.id).toBe('cypress');
  });

  it('builds commands for the package manager in use', () => {
    const files = ['src/a.test.ts', 'src/my file.test.ts'];
    const vitest = (pm?: string) => detectTestRunners([{ devDependencies: { vitest: '^2' } }], pm).unit!.command(files);
    expect(vitest(undefined)).toBe("npx vitest run src/a.test.ts 'src/my file.test.ts'");
    expect(vitest('npm')).toBe("npx vitest run src/a.test.ts 'src/my file.test.ts'");
    expect(vitest('pnpm')).toBe("pnpm exec vitest run src/a.test.ts 'src/my file.test.ts'");
    expect(vitest('yarn')).toBe("yarn vitest run src/a.test.ts 'src/my file.test.ts'");
    expect(vitest('bun')).toBe("bunx vitest run src/a.test.ts 'src/my file.test.ts'");
    expect(detectTestRunners([{ devDependencies: { jest: '^29' } }], undefined).unit!.command(['a.test.ts'])).toBe('npx jest --runTestsByPath a.test.ts');
    expect(detectTestRunners([{ devDependencies: { cypress: '^13' } }], undefined).e2e!.command(['a.cy.ts', 'b.cy.ts'])).toBe('npx cypress run --spec a.cy.ts,b.cy.ts');
  });
});

describe('testCommand', () => {
  const runners = detectTestRunners([{ devDependencies: { vitest: '^2', '@playwright/test': '^1' } }], 'pnpm');

  it('returns nothing without files or without a runner', () => {
    expect(testCommand([], runners)).toEqual({});
    expect(testCommand(['src/a.test.ts'], {})).toEqual({});
  });

  it('runs unit tests with the unit runner', () => {
    expect(testCommand(['src/a.test.ts', 'src/b.test.ts'], runners)).toEqual({ command: 'pnpm exec vitest run src/a.test.ts src/b.test.ts', runner: 'vitest' });
  });

  it('splits end-to-end tests off to the e2e runner', () => {
    expect(testCommand(['e2e/login.spec.ts', 'src/a.test.ts'], runners)).toEqual({
      command: 'pnpm exec vitest run src/a.test.ts && pnpm exec playwright test e2e/login.spec.ts',
      runner: 'vitest + playwright',
    });
    expect(testCommand(['e2e/login.spec.ts'], runners)).toEqual({ command: 'pnpm exec playwright test e2e/login.spec.ts', runner: 'playwright' });
  });

  it('keeps e2e-looking files with the unit runner when no e2e runner is installed', () => {
    const unitOnly = detectTestRunners([{ devDependencies: { vitest: '^2' } }], undefined);
    expect(testCommand(['e2e/login.spec.ts'], unitOnly)).toEqual({ command: 'npx vitest run e2e/login.spec.ts', runner: 'vitest' });
  });

  it('recognises end-to-end test paths', () => {
    expect(isE2eTest('e2e/login.spec.ts')).toBe(true);
    expect(isE2eTest('apps/web/playwright/cart.spec.ts')).toBe(true);
    expect(isE2eTest('cypress/e2e/home.cy.ts')).toBe(true);
    expect(isE2eTest('src/checkout.e2e.ts')).toBe(true);
    expect(isE2eTest('src/checkout.test.ts')).toBe(false);
  });
});
