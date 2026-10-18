/**
 * test-intelligence: `selectTests` (which tests a change needs, and why), URL visits in e2e specs, the
 * runner commands per workspace package, and the `test` command end to end (staged changes, exit codes,
 * lastTest state).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { parseSource } from '../src/analyzer/parse.js';
import { readState } from '../src/analyzer/state.js';
import { hasCoverageThresholds, playwrightTestDir } from '../src/analyzer/tests.js';
import { isFullRunTrigger, manifestAffectsTests, planFiles, planSummary, selectTests, visitMatchesRoute } from '../src/analyzer/test-select.js';
import { forwardsSigint, resolveRunner, runTestCommands, spawnArgv } from '../src/cli/commands/test.js';
import { runCli } from '../src/cli/run.js';
import * as query from '../src/shared/query.js';
import { argvDisplay, runnerArgv, runnerDirFor } from '../src/shared/testcmd.js';
import type { LastTestState, TestSelection } from '../src/shared/types.js';
import { commitAll, copyFixture, daysAgo, editFile, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';
import { analyzeFixture } from './helpers.js';

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

const reasons = (plan: TestSelection): Record<string, string> => Object.fromEntries(plan.selected.map((s) => [s.file, `${s.reason}${s.via ? ` ← ${s.via}` : ''}`]));

describe('runner commands', () => {
  it('builds argv arrays per runner and package manager (no shell)', () => {
    expect(runnerArgv('vitest', undefined, ['src/a.test.ts'])).toEqual(['npx', 'vitest', 'run', 'src/a.test.ts']);
    expect(runnerArgv('vitest', 'pnpm', [], { coverage: true })).toEqual(['pnpm', 'exec', 'vitest', 'run', '--coverage']);
    expect(runnerArgv('jest', 'yarn', ['a.test.js', 'b.test.js'], { extra: ['--ci'] })).toEqual(['yarn', 'jest', '--ci', '--runTestsByPath', 'a.test.js', 'b.test.js']);
    expect(runnerArgv('jest', undefined, [])).toEqual(['npx', 'jest']);
    expect(runnerArgv('node', 'npm', ['test/a.test.js'])).toEqual(['node', '--test', 'test/a.test.js']);
    expect(runnerArgv('playwright', 'bun', ['e2e/a.spec.ts'])).toEqual(['bunx', 'playwright', 'test', 'e2e/a.spec.ts']);
    expect(runnerArgv('cypress', undefined, ['a.cy.ts', 'b.cy.ts'])).toEqual(['npx', 'cypress', 'run', '--spec', 'a.cy.ts,b.cy.ts']);
    expect(runnerArgv('bun', undefined, ['a.test.ts'], { coverage: true })).toEqual(['bun', 'test', '--coverage', 'a.test.ts']);
    expect(runnerArgv('mocha', undefined, ['x.js'], { coverage: true })).toEqual(['npx', 'mocha', 'x.js']);
    expect(runnerArgv('karma', undefined, [])).toBeUndefined();
    expect(argvDisplay(['npx', 'vitest', 'run', "it's here.test.ts"])).toBe("npx vitest run 'it'\\''s here.test.ts'");
  });

  it('finds the package that runs a test (e2e specs go to the package with an e2e runner)', () => {
    const runners = { '': { unit: 'vitest', e2e: 'playwright' }, 'packages/web': { unit: 'vitest' }, 'packages/api': { unit: 'jest' } };
    expect(runnerDirFor('packages/api/test/a.test.js', runners)).toBe('packages/api');
    expect(runnerDirFor('packages/web/e2e/home.spec.ts', runners)).toBe('');
    expect(runnerDirFor('test/root.test.ts', runners)).toBe('');
  });

  it('runs a locally installed runner instead of npx, and never asks the registry for one', () => {
    const root = makeTempDir('cv-bin-');
    writeFile(root, 'node_modules/.bin/vitest', '#!/bin/sh\n');
    writeFile(root, 'node_modules/.bin/vitest.cmd', '@echo off\n');
    fs.mkdirSync(path.join(root, 'packages/web'), { recursive: true });
    expect(spawnArgv(['npx', 'vitest', 'run', 'a.test.ts'], path.join(root, 'packages/web'), root, 'linux')).toEqual([path.join(root, 'node_modules/.bin/vitest'), 'run', 'a.test.ts']);
    // Not installed: npx (and bunx) would resolve it on the registry — run it from PATH instead, or fail.
    expect(resolveRunner(['npx', 'jest', '--runTestsByPath', 'a.test.ts'], path.join(root, 'packages/web'), root, 'linux')).toEqual({ argv: ['jest', '--runTestsByPath', 'a.test.ts'], installed: false });
    expect(spawnArgv(['bunx', 'jest'], root, root, 'linux')).toEqual(['jest']);
    // pnpm exec and yarn only run installed binaries (Yarn PnP has no .bin folder): left as they are.
    expect(spawnArgv(['pnpm', 'exec', 'jest'], root, root, 'linux')).toEqual(['pnpm', 'exec', 'jest']);
    expect(spawnArgv(['yarn', 'vitest', 'run'], root, root, 'linux')).toEqual([path.join(root, 'node_modules/.bin/vitest'), 'run']);
    // Windows: the .cmd shim of the local install.
    expect(spawnArgv(['npx', 'vitest', 'run'], root, root, 'win32')).toEqual([path.join(root, 'node_modules/.bin/vitest.cmd'), 'run']);
    expect(spawnArgv(['node', '--test', 'a.test.js'], root, root, 'linux')).toEqual(['node', '--test', 'a.test.js']);
  });

  it('switches coverage thresholds off only for partial runs of packages that configure them', () => {
    expect(runnerArgv('vitest', undefined, ['a.test.ts'], { coverage: true })).toEqual(['npx', 'vitest', 'run', '--coverage', 'a.test.ts']);
    expect(runnerArgv('vitest', undefined, ['a.test.ts'], { coverage: true, thresholds: true })).toEqual([
      'npx',
      'vitest',
      'run',
      '--coverage',
      '--coverage.thresholds.lines=0',
      '--coverage.thresholds.functions=0',
      '--coverage.thresholds.branches=0',
      '--coverage.thresholds.statements=0',
      '--coverage.thresholds.autoUpdate=false',
      'a.test.ts',
    ]);
    expect(runnerArgv('vitest', undefined, [], { coverage: true, thresholds: true })).toEqual(['npx', 'vitest', 'run', '--coverage']); // the whole suite
    expect(runnerArgv('jest', undefined, ['a.test.js'], { coverage: true, thresholds: true })).toEqual(['npx', 'jest', '--coverage', '--coverageThreshold={}', '--runTestsByPath', 'a.test.js']);
    // node --test writes lcov itself next to its usual output.
    expect(runnerArgv('node', undefined, ['t.test.js'], { coverage: true })).toEqual([
      'node',
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      '--test-reporter-destination=coverage/lcov.info',
      't.test.js',
    ]);
    const files: Record<string, string> = {
      'vite.config.ts': 'export default { test: { coverage: { thresholds: { lines: 80 } } } };',
      'packages/api/jest.config.js': 'module.exports = { coverageThreshold: { global: { lines: 90 } } };',
    };
    const read = (rel: string): string | undefined => files[rel];
    expect(hasCoverageThresholds('', 'vitest', read)).toBe(true);
    expect(hasCoverageThresholds('packages/api', 'jest', read)).toBe(true);
    expect(hasCoverageThresholds('packages/web', 'vitest', read)).toBe(false);
    expect(hasCoverageThresholds('', 'jest', () => undefined, { name: 'x', jest: { coverageThreshold: { global: { lines: 1 } } } } as never)).toBe(true);
  });

  it('passes Ctrl+C on to the runner only when it does not share our terminal', () => {
    expect(forwardsSigint('inherit', true)).toBe(false); // the terminal already signalled the whole process group
    expect(forwardsSigint('inherit', false)).toBe(true); // kill -INT <pid> from a tool
    expect(forwardsSigint('ignore', true)).toBe(true);
  });
});

describe('URL visits in e2e specs', () => {
  it('collects page.goto, cy.visit / cy.request, browser.url and test HTTP clients, in test files only', () => {
    const spec = [
      "import { test } from '@playwright/test';",
      "test('profile', async ({ page, request }) => {",
      "  await page.goto('/users/42');",
      '  await page.goto(`${baseURL}/settings`);',
      '  await request.post(`/api/users/${id}/avatar`, { data: {} });',
      "  cy.visit({ url: '/checkout' });",
      "  cy.request('DELETE', '/api/cart/1');",
      "  cy.request({ method: 'patch', url: '/api/cart' });",
      "  await browser.url('http://localhost:3000/about');",
      "  await request(app).get('/api/health');",
      "  await page.goto(dynamicUrl);",
      "  await page.goto('https://example.com/elsewhere');",
      '});',
    ].join('\n');
    const visits = parseSource('e2e/profile.spec.ts', spec, '.ts').urlVisits;
    expect(visits).toEqual([
      { url: '/users/42', line: 3, method: 'GET' },
      { url: '/settings', line: 4, method: 'GET' },
      { url: '/api/users/:param/avatar', line: 5, method: 'POST' },
      { url: '/checkout', line: 6, method: 'GET' },
      { url: '/api/cart/1', line: 7, method: 'DELETE' },
      { url: '/api/cart', line: 8, method: 'PATCH' },
      { url: 'http://localhost:3000/about', line: 9, method: 'GET' },
      { url: '/api/health', line: 10, method: 'GET' },
      { url: 'https://example.com/elsewhere', line: 12, method: 'GET' },
    ]);
    expect(parseSource('src/nav.ts', "router.goto('/users/1');", '.ts').urlVisits).toBeUndefined();
  });

  it('matches visits to routes exactly (pages for GETs, API routes by method)', () => {
    expect(visitMatchesRoute({ method: 'PAGE', path: '/users/[id]', type: 'page' }, { url: '/users/42' })).toBe(true);
    expect(visitMatchesRoute({ method: 'PAGE', path: '/users/[id]', type: 'page' }, { url: '/users/:param' })).toBe(true);
    expect(visitMatchesRoute({ method: 'PAGE', path: '/users/[id]', type: 'page' }, { url: '/users/42', method: 'POST' })).toBe(false);
    expect(visitMatchesRoute({ method: 'GET', path: '/api/users/:id', type: 'api' }, { url: 'http://localhost:3000/api/users/1' })).toBe(true);
    expect(visitMatchesRoute({ method: 'GET', path: '/api/users/:id', type: 'api' }, { url: '/api/users/1', method: 'DELETE' })).toBe(false);
    expect(visitMatchesRoute({ method: 'GET', path: '/api/users', type: 'api' }, { url: '/users' })).toBe(false); // no suffix guessing
    expect(visitMatchesRoute({ method: 'GET', path: '/api/users', type: 'api' }, { url: 'https://example.com/api/users' })).toBe(false);
  });
});

describe('selectTests', () => {
  it('selects a test that imports a component which imports the changed util (imports-changed)', async () => {
    const root = copyFixture('react-vite-ts');
    writeFile(root, 'src/components/Price.tsx', "import { percent } from '../utils/math';\nexport const Price = ({ v }: { v: number }) => <span>{percent(v, 100)}</span>;\n");
    writeFile(root, 'src/components/Price.test.tsx', "import { it } from 'vitest';\nimport { Price } from './Price';\nit('renders', () => void Price);\n");
    const data = await analyze({ root, git: false, includeSource: false });
    const plan = selectTests(data, ['src/utils/math.ts']);
    expect(reasons(plan)).toEqual({ 'src/components/Price.test.tsx': 'imports-changed ← src/utils/math.ts' });
    expect(plan.commands).toEqual([{ cwd: '', runner: 'vitest', argv: ['npx', 'vitest', 'run', 'src/components/Price.test.tsx'], display: 'npx vitest run src/components/Price.test.tsx', files: ['src/components/Price.test.tsx'] }]);
    expect(plan).toMatchObject({ mode: 'working', full: false, totalTests: 2 });
    expect(planSummary(plan)).toBe('1 of 2 test files · vitest 1');
    // A changed test runs itself; a comment-only edit needs nothing.
    expect(reasons(selectTests(data, ['src/components/Button.test.tsx']))).toEqual({ 'src/components/Button.test.tsx': 'changed-test' });
    const skipped = selectTests(data, ['src/utils/math.ts'], { commentOnly: ['src/utils/math.ts'] });
    expect(skipped.selected).toEqual([]);
    expect(skipped.skipped).toEqual(['src/utils/math.ts']);
  });

  it('runs the whole suite after a tsconfig change (unless told not to)', async () => {
    const data = await analyzeFixture('react-vite-ts');
    const plan = selectTests(data, ['tsconfig.json', 'src/components/Button.tsx']);
    expect(plan).toMatchObject({ full: true, fullReason: 'tsconfig.json changed', fullPackages: [''] });
    expect(plan.commands).toEqual([{ cwd: '', runner: 'vitest', argv: ['npx', 'vitest', 'run'], display: 'npx vitest run', files: [], full: true }]);
    expect(planFiles(data, plan)).toEqual(['src/components/Button.test.tsx']);
    const narrow = selectTests(data, ['tsconfig.json', 'src/components/Button.tsx'], { full: false });
    expect(narrow.full).toBe(false);
    expect(narrow.commands[0].argv).toEqual(['npx', 'vitest', 'run', 'src/components/Button.test.tsx']);
    for (const f of ['package.json', 'pnpm-lock.yaml', 'apps/web/tsconfig.app.json', 'vitest.config.mts', 'src/setupTests.ts', 'jest.setup.js', 'bun.lockb', 'test/setup.ts', 'packages/api/tests/helpers/setup.js']) expect(isFullRunTrigger(f), f).toBe(true);
    // A setup.js outside a test folder is application code: it reaches its tests through imports.
    for (const f of ['src/package.ts', 'docs/tsconfig.md', 'src/setup.tsx.bak', 'lib/setup.js', 'setup.ts']) expect(isFullRunTrigger(f), f).toBe(false);
  });

  it('runs only the e2e suite after an e2e config change, and ignores package.json changes that cannot affect tests', async () => {
    const root = copyFixture('fullstack-next');
    editFile(root, 'package.json', '"supertest": "^7.0.0",', '"supertest": "^7.0.0",\n    "@playwright/test": "^1.48.0",');
    writeFile(root, 'e2e/home.spec.ts', "import { test } from '@playwright/test';\ntest('home', async ({ page }) => { await page.goto('/'); });\n");
    const data = await analyze({ root, git: false, includeSource: false });
    const plan = selectTests(data, ['playwright.config.ts']);
    expect(plan).toMatchObject({ full: true, fullReason: 'playwright.config.ts changed' });
    expect(plan.commands.map((c) => [c.runner, c.full ?? false])).toEqual([['playwright', true]]);
    // A version bump or a new bin entry is not a reason to run everything; a dependency or test script change is.
    const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'vitest', build: 'tsc' }, devDependencies: { vitest: '^3.0.0' } });
    const edit = (patch: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(pkg), ...patch });
    expect(manifestAffectsTests(pkg, edit({ version: '1.1.0', bin: { x: 'cli.js' }, scripts: { test: 'vitest', build: 'tsup' } }))).toBe(false);
    expect(manifestAffectsTests(pkg, edit({ devDependencies: { vitest: '^3.1.0' } }))).toBe(true);
    expect(manifestAffectsTests(pkg, edit({ scripts: { test: 'vitest --config v.ts', build: 'tsc' } }))).toBe(true);
    expect(manifestAffectsTests(pkg, edit({ type: 'module' }))).toBe(true);
    expect(manifestAffectsTests(undefined, pkg)).toBe(true); // a new package.json
    expect(manifestAffectsTests(pkg, '{ broken')).toBe(true);
    expect(selectTests(data, ['package.json'], { notTriggers: ['package.json'] }).full).toBe(false);
  });

  it('runs the Playwright specs of its testDir with Playwright (npm init playwright layout), and Playwright alone when it is the only runner', async () => {
    const root = makeTempDir('cv-pw-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'pw', scripts: { test: 'playwright test' }, devDependencies: { '@playwright/test': '^1.48.0' } }));
    writeFile(root, 'playwright.config.ts', "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests', use: { baseURL: 'http://localhost:3000' } });\n");
    writeFile(root, 'src/util.ts', 'export const add = (a: number, b: number) => a + b;\n');
    writeFile(root, 'tests/example.spec.ts', "import { test, expect } from '@playwright/test';\nimport { add } from '../src/util';\ntest('adds', () => expect(add(1, 2)).toBe(3));\n");
    const only = await analyze({ root, git: false, includeSource: false });
    expect(only.project.testRunners).toEqual({ '': { e2e: 'playwright', e2eDir: 'tests' } });
    expect(selectTests(only, ['src/util.ts']).commands.map((c) => c.argv)).toEqual([['npx', 'playwright', 'test', 'tests/example.spec.ts']]);
    // With vitest next to it, the spec in testDir still goes to Playwright and the unit test to vitest.
    writeFile(root, 'package.json', JSON.stringify({ name: 'pw', scripts: { test: 'vitest' }, devDependencies: { '@playwright/test': '^1.48.0', vitest: '^3.0.0' } }));
    writeFile(root, 'src/util.test.ts', "import { it } from 'vitest';\nimport { add } from './util';\nit('adds', () => void add(1, 2));\n");
    const both = await analyze({ root, git: false, includeSource: false });
    expect(selectTests(both, ['src/util.ts']).commands.map((c) => c.argv)).toEqual([
      ['npx', 'vitest', 'run', 'src/util.test.ts'],
      ['npx', 'playwright', 'test', 'tests/example.spec.ts'],
    ]);
    expect(playwrightTestDir('apps/web', (rel) => (rel === 'apps/web/playwright.config.js' ? "module.exports = { testDir: path.join(__dirname, 'e2e') }" : undefined))).toBe('apps/web/e2e');
    expect(playwrightTestDir('', () => 'export default { use: {} }')).toBeUndefined();
  });

  it('groups a workspace monorepo by package: two commands with their cwd and package-relative paths', async () => {
    const data = await analyzeFixture('monorepo-ws');
    const plan = selectTests(data, ['packages/web/src/format.ts', 'packages/api/src/users.js'], { coverage: true, extra: ['--silent'] });
    expect(plan.commands).toEqual([
      {
        cwd: 'packages/api',
        runner: 'jest',
        argv: ['npx', 'jest', '--coverage', '--silent', '--runTestsByPath', 'test/users.test.js'],
        display: '(cd packages/api && npx jest --coverage --silent --runTestsByPath test/users.test.js)',
        files: ['packages/api/test/users.test.js'],
      },
      {
        cwd: 'packages/web',
        runner: 'vitest',
        argv: ['npx', 'vitest', 'run', '--coverage', '--silent', 'src/greeting.test.ts'],
        display: '(cd packages/web && npx vitest run --coverage --silent src/greeting.test.ts)',
        files: ['packages/web/src/greeting.test.ts'],
      },
    ]);
    expect(plan.selected.map((s) => [s.file, s.package, s.runner])).toEqual([
      ['packages/api/test/users.test.js', 'packages/api', 'jest'],
      ['packages/web/src/greeting.test.ts', 'packages/web', 'vitest'],
    ]);
    expect(planSummary(plan)).toBe('2 of 3 test files · jest (packages/api) 1 · vitest (packages/web) 1');
    // A package's own manifest runs that package's suite only; the root's runs every package.
    const web = selectTests(data, ['packages/web/package.json', 'packages/api/src/users.js']);
    expect(web.fullPackages).toEqual(['packages/web']);
    expect(web.commands.map((c) => [c.cwd, c.argv.join(' ')])).toEqual([
      ['packages/api', 'npx jest --runTestsByPath test/users.test.js'],
      ['packages/web', 'npx vitest run'],
    ]);
    expect(planFiles(data, web)).toEqual(['packages/api/test/users.test.js', 'packages/web/src/greeting.test.ts', 'packages/web/src/other.test.ts']);
    const all = selectTests(data, ['package.json']);
    expect(all.commands.map((c) => [c.cwd, c.argv.join(' '), c.full])).toEqual([
      ['packages/api', 'npx jest', true],
      ['packages/web', 'npx vitest run', true],
    ]);
    // A workspace without tests (docs) has nothing to run in full.
    const withDocs = { ...data, project: { ...data.project, workspaces: [...data.project.workspaces!, 'packages/docs'] } };
    expect(selectTests(withDocs, ['packages/docs/package.json'])).toMatchObject({ full: false, commands: [] });
    // One runner at the root for every package: a package's suite runs by path, the root's in full only for a root change.
    const rootRunner = { ...data, project: { ...data.project, testRunners: { '': { unit: 'vitest' } } } };
    expect(selectTests(rootRunner, ['packages/web/package.json']).commands.map((c) => c.argv.join(' '))).toEqual(['npx vitest run packages/web/src/greeting.test.ts packages/web/src/other.test.ts']);
    expect(selectTests(rootRunner, ['package-lock.json']).commands.map((c) => [c.argv.join(' '), c.full])).toEqual([['npx vitest run', true]]);
  });

  it('selects an API test that requests an affected express route over HTTP (route-e2e)', async () => {
    const root = copyFixture('express-api');
    // No import of the app: the test reaches it over HTTP only.
    writeFile(root, 'test/users.api.test.js', "const request = require('supertest');\nconst api = process.env.API_URL;\n\ntest('gets a user', async () => {\n  await request(api).get('/api/users/1').expect(200);\n});\n");
    writeFile(root, 'test/health.api.test.js', "const request = require('supertest');\ntest('health', () => request(process.env.API_URL).get('/health'));\n");
    const data = await analyze({ root, git: false, includeSource: false });
    const plan = selectTests(data, ['services/UserService.js']);
    expect(reasons(plan)).toEqual({
      'test/users.api.test.js': 'route-e2e ← GET /api/users/:id',
      // Inline handlers (`app.get('/health', …)` in app.js) are module-level code whose calls are not
      // tracked: they count as soon as their file depends on the change (conservative).
      'test/health.api.test.js': 'route-e2e ← GET /health',
    });
    expect(plan.commands.map((c) => c.argv)).toEqual([['npx', 'jest', '--runTestsByPath', 'test/health.api.test.js', 'test/users.api.test.js']]);
    // routes/users.js imports the users controller only: a change to the posts controller does not reach GET /api/users/:id.
    expect(selectTests(data, ['controllers/postsController.js']).selected.map((s) => s.file)).not.toContain('test/users.api.test.js');
    // tests-for a handler file answers like `test` and `impact`: the tests that request its routes.
    expect(query.testsFor(data, ['controllers/usersController.js']).files).toContain('test/users.api.test.js');
    expect(query.testsFor(data, ['controllers/usersController.js']).untested).toEqual([]);
  });

  it('selects the spec that uses a page object or request helper, never the helper itself', async () => {
    const root = copyFixture('express-api');
    writeFile(root, 'playwright.config.js', "module.exports = { testDir: './e2e' };\n");
    editFile(root, 'package.json', '"supertest": "^7.0.0"', '"supertest": "^7.0.0",\n    "@playwright/test": "^1.48.0"');
    writeFile(root, 'e2e/support/usersApi.js', "exports.getUser = (request, id) => request.get(`/api/users/${id}`);\n");
    writeFile(root, 'e2e/pages/profile-page.js', "exports.ProfilePage = class { constructor(page) { this.page = page; } open(id) { return this.page.goto(`/api/users/${id}`); } };\n");
    writeFile(root, 'e2e/users.spec.js', "const { test } = require('@playwright/test');\nconst { getUser } = require('./support/usersApi');\ntest('user', async ({ request }) => { await getUser(request, 1); });\n");
    writeFile(root, 'e2e/profile.spec.js', "const { test } = require('@playwright/test');\nconst { ProfilePage } = require('./pages/profile-page');\ntest('profile', async ({ page }) => { await new ProfilePage(page).open(1); });\n");
    const data = await analyze({ root, git: false, includeSource: false });
    const plan = selectTests(data, ['controllers/usersController.js']);
    expect(reasons(plan)).toMatchObject({
      'e2e/users.spec.js': 'route-e2e ← GET /api/users/:id (usersApi.js)',
      'e2e/profile.spec.js': 'route-e2e ← GET /api/users/:id (profile-page.js)',
    });
    expect(Object.keys(reasons(plan))).not.toContain('e2e/support/usersApi.js');
    expect(Object.keys(reasons(plan))).not.toContain('e2e/pages/profile-page.js');
    expect(plan.commands.find((c) => c.runner === 'playwright')!.argv).toEqual(['npx', 'playwright', 'test', 'e2e/profile.spec.js', 'e2e/users.spec.js']);
    // Helpers are not counted as test files, and the query core gives the same answer.
    expect(plan.totalTests).toBe(data.files.filter((f) => f.kind === 'test' && /\.(spec|test)\.js$/.test(f.id)).length);
    expect(query.testsFor(data, ['controllers/usersController.js']).files).toEqual(expect.arrayContaining(['e2e/profile.spec.js', 'e2e/users.spec.js']));
  });

  it('lists selected tests that no detected runner runs (--list | xargs for tap, uvu, custom scripts)', () => {
    const data = {
      files: [
        { id: 'src/a.js', kind: 'util', assets: [] },
        { id: 'test/a.test.js', kind: 'test', assets: [] },
      ],
      edges: [{ source: 'test/a.test.js', target: 'src/a.js', typeOnly: false }],
      routes: [],
      project: { testRunners: undefined },
    } as unknown as Parameters<typeof selectTests>[0];
    const plan = selectTests(data, ['src/a.js']);
    expect(plan.commands).toEqual([]);
    expect(planFiles(data, plan)).toEqual(['test/a.test.js']);
  });

  it('selects a Playwright spec that visits a page whose component changed, unless --no-e2e', async () => {
    const root = copyFixture('fullstack-next');
    editFile(root, 'package.json', '"supertest": "^7.0.0",', '"supertest": "^7.0.0",\n    "@playwright/test": "^1.48.0",');
    writeFile(root, 'e2e/profile.spec.ts', "import { expect, test } from '@playwright/test';\n\ntest('profile', async ({ page }) => {\n  await page.goto(`/users/${42}`);\n  await expect(page.getByRole('heading')).toBeVisible();\n});\n");
    const data = await analyze({ root, git: false, includeSource: false });
    expect(data.project.testRunners).toEqual({ '': { unit: 'vitest', e2e: 'playwright' } });
    const plan = selectTests(data, ['components/UserProfile.tsx']);
    expect(reasons(plan)).toMatchObject({ 'e2e/profile.spec.ts': 'route-e2e ← PAGE /users/[id]' });
    expect(plan.commands.find((c) => c.runner === 'playwright')).toMatchObject({ argv: ['npx', 'playwright', 'test', 'e2e/profile.spec.ts'] });
    expect(selectTests(data, ['components/UserProfile.tsx'], { e2e: false }).selected.map((s) => s.file)).not.toContain('e2e/profile.spec.ts');
    // The supertest suite requests DELETE /api/users/1, served by app/api/users/[id]/route.ts.
    expect(reasons(selectTests(data, ['lib/db.ts']))).toMatchObject({ 'test/users.test.ts': expect.stringMatching(/^(imports-changed|route-e2e)/) });
    // The query core (impact, tests-for, route, untested files) knows the visit too.
    expect(query.impactOf(data, { type: 'file', id: 'components/UserProfile.tsx' }, { depth: Infinity }).tests.files).toContain('e2e/profile.spec.ts');
    const page = data.routes.find((r) => r.path === '/users/[id]' && r.type === 'page')!;
    expect(query.testsFor(data, [{ type: 'route', id: page.id }]).files).toContain('e2e/profile.spec.ts');
    expect(query.routeFor(data, 'GET', '/users/7')[0].tests).toContain('e2e/profile.spec.ts');
    expect(query.httpTestedFiles(data).has(page.file)).toBe(true);
  });
});

describe.skipIf(!hasGit)('selectTests with git history and the test command', () => {
  let restoreGit: () => void;
  const savedNoCache = process.env.CODE_VISUALIZER_NO_CACHE;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => {
    restoreGit();
    process.env.CODE_VISUALIZER_NO_CACHE = savedNoCache;
  });

  it('adds tests that usually change together with a changed file (co-change, --with-cochange)', async () => {
    const repo = initRepo('react-vite-ts');
    writeFile(repo, 'src/a.ts', 'export const a = 1;\n');
    writeFile(repo, 'src/b.test.ts', "import { it } from 'vitest';\nit('b', () => undefined);\n");
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(10), message: 'initial' });
    for (let i = 0; i < 3; i++) {
      writeFile(repo, 'src/a.ts', `export const a = ${i + 2};\n`);
      writeFile(repo, 'src/b.test.ts', `import { it } from 'vitest';\nit('b${i}', () => undefined);\n`);
      commitAll(repo, { author: 'Alice Archer', date: daysAgo(9 - i), message: `change ${i}` });
    }
    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.insights.changeCoupling).toContainEqual(expect.objectContaining({ a: 'src/a.ts', b: 'src/b.test.ts', count: 3 }));
    expect(selectTests(data, ['src/a.ts']).selected).toEqual([]);
    expect(reasons(selectTests(data, ['src/a.ts'], { withCochange: true }))).toEqual({ 'src/b.test.ts': 'co-change ← src/a.ts' });
  });

  it('test --staged ignores unstaged edits; --json prints the plan, --list the files', async () => {
    const repo = initRepo('monorepo-ws');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'initial' });
    editFile(repo, 'packages/web/src/format.ts', '.trim()', '.trim().normalize()');
    editFile(repo, 'packages/api/src/users.js', "name: 'Ada'", "name: 'Ada Lovelace'");
    git(repo, ['add', 'packages/api/src/users.js']);
    const staged = JSON.parse((await cli('test', repo, '--staged', '--json')).stdout) as TestSelection;
    expect(staged).toMatchObject({ mode: 'staged', changed: ['packages/api/src/users.js'], full: false });
    expect(staged.selected.map((s) => s.file)).toEqual(['packages/api/test/users.test.js']);
    const working = JSON.parse((await cli('test', repo, '--json')).stdout) as TestSelection;
    expect(working.selected.map((s) => s.file)).toEqual(['packages/api/test/users.test.js', 'packages/web/src/greeting.test.ts']);
    const list = await cli('test', repo, '--list');
    expect(list.stdout).toBe('packages/api/test/users.test.js\npackages/web/src/greeting.test.ts\n');
    const dry = await cli('test', repo, '--dry-run', '--verbose');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Tests to run: 2 of 3 test files · jest (packages/api) 1 · vitest (packages/web) 1');
    expect(dry.stdout).toMatch(/packages\/web\/src\/greeting\.test\.ts\s+imports packages\/web\/src\/format\.ts/);
    expect(dry.stdout).toContain('$ (cd packages/web && npx vitest run src/greeting.test.ts)');
    // "Tests to run" in My changes and the PR description is the same plan, with the same commands.
    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.changes!.tests).toMatchObject({
      files: ['packages/api/test/users.test.js', 'packages/web/src/greeting.test.ts'],
      command: '(cd packages/api && npx jest --runTestsByPath test/users.test.js) && (cd packages/web && npx vitest run src/greeting.test.ts)',
      runner: 'jest + vitest',
    });
    expect((await cli('test', repo, '--staged', '--push')).code).toBe(2);
    expect((await cli('test', repo, '--since', 'no-such-ref')).code).toBe(2);
    // A mistyped --base is an error, not a silent fallback to the detected base branch.
    const typo = await cli('test', repo, '--base', 'origin/develp', '--dry-run');
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('Unknown git ref "origin/develp"');
    // `--coverage <path>` belongs to report, check, pr and coverage; test says so instead of analyzing coverage/.
    writeFile(repo, 'coverage/lcov.info', 'SF:x\nend_of_record\n');
    const misuse = await cli('test', path.join(repo, 'coverage'), '--coverage', '--dry-run');
    expect(misuse.code).toBe(2);
    expect(misuse.stderr).toContain('test --coverage takes no path');
  });

  it('runs a package suite in full only when its package.json change can affect tests', async () => {
    const repo = initRepo('monorepo-ws');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'initial' });
    editFile(repo, 'packages/web/package.json', '"version": "1.0.0"', '"version": "1.0.1"');
    const bump = JSON.parse((await cli('test', repo, '--json')).stdout) as TestSelection;
    expect(bump).toMatchObject({ full: false, changed: ['packages/web/package.json'], commands: [] });
    editFile(repo, 'packages/web/package.json', '"vitest": "^2.1.1"', '"vitest": "^3.2.0"');
    const deps = JSON.parse((await cli('test', repo, '--json')).stdout) as TestSelection;
    expect(deps).toMatchObject({ full: true, fullPackages: ['packages/web'] });
    // Staged: the index against HEAD.
    git(repo, ['checkout', '--', 'packages/web/package.json']);
    editFile(repo, 'packages/web/package.json', '"version": "1.0.0"', '"version": "2.0.0"');
    git(repo, ['add', 'packages/web/package.json']);
    expect(JSON.parse((await cli('test', repo, '--staged', '--json')).stdout)).toMatchObject({ full: false });
  });

  it('test --push compares with the upstream (falling back to the base branch)', async () => {
    const repo = initRepo('monorepo-ws');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'initial' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    editFile(repo, 'packages/api/src/users.js', "name: 'Ada'", "name: 'Grace'");
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(1), message: 'grace' });
    editFile(repo, 'packages/web/src/format.ts', '.trim()', '.trim().normalize()'); // not committed: not pushed
    const plan = JSON.parse((await cli('test', repo, '--push', '--json')).stdout) as TestSelection;
    expect(plan).toMatchObject({ mode: 'push', base: 'main', changed: ['packages/api/src/users.js'] });
  });

  it('runs `node --test` for a package that uses it, propagates the failing exit code and records lastTest', async () => {
    const root = path.join(makeTempDir('cv-node-test-'), 'pkg');
    writeFile(root, 'package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }));
    writeFile(root, 'src/sum.js', 'export const sum = (a, b) => a + b;\n');
    writeFile(root, 'test/sum.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { sum } from '../src/sum.js';\n\ntest('sum', () => assert.equal(sum(1, 2), 3));\n");
    git(root, ['init', '-q', '-b', 'main']);
    commitAll(root, { author: 'Alice Archer', date: daysAgo(1), message: 'initial' });
    // lastTest is recorded with the cache off too (CODE_VISUALIZER_NO_CACHE=1 in this suite): it is an outcome, not a cache.
    expect(process.env.CODE_VISUALIZER_NO_CACHE).toBe('1');
    try {
      editFile(root, 'src/sum.js', 'a + b', 'a - b');
      const failing = await cli('test', root, '-q');
      expect(failing.code).toBe(1);
      expect(failing.stderr).toMatch(/tests failed \(exit code 1\) · ran 1 of 1 test file/);
      const failed = readState<LastTestState>(root, 'lastTest')!;
      expect(failed).toMatchObject({ passed: false, exitCode: 1, mode: 'working', files: ['test/sum.test.js'], full: false, command: 'node --test test/sum.test.js' });
      expect(failed.treeId).toMatch(/^[0-9a-f]{40,64}$/);

      editFile(root, 'src/sum.js', 'a - b', 'a + b ');
      const passing = await cli('test', root);
      expect(passing.code).toBe(0);
      expect(passing.stdout).toMatch(/✔ ran 1 of 1 test file in /);
      const passed = readState<LastTestState>(root, 'lastTest')!;
      expect(passed).toMatchObject({ passed: true, exitCode: 0 });
      // Another tree, another id; the same tree, the same id.
      expect(passed.treeId).not.toBe(failed.treeId);
      const { workingTreeId } = await import('../src/analyzer/git.js');
      expect(await workingTreeId(root)).toBe(passed.treeId);
    } finally {
      process.env.CODE_VISUALIZER_NO_CACHE = '1';
    }
  });

  it('says so when nothing needs to run', async () => {
    const repo = initRepo('monorepo-ws');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(2), message: 'initial' });
    expect((await cli('test', repo)).stdout).toContain('No changes — no tests to run.');
    writeFile(repo, 'README.md', '# hi\n');
    expect((await cli('test', repo)).stdout).toContain('No tests affected by your 1 changed file.');
  });

  it('runTestCommands returns the worst exit code and which runners failed', async () => {
    const root = makeTempDir('cv-run-');
    const node = (code: number, cwd = '') => ({ cwd, runner: 'node', argv: [process.execPath, '-e', `process.exit(${code})`], display: '', files: [] });
    fs.mkdirSync(path.join(root, 'packages/api'), { recursive: true });
    const result = await runTestCommands([node(0), node(3, 'packages/api'), node(1)], { root, stdio: 'ignore' });
    expect(result).toMatchObject({ exitCode: 3, interrupted: false, failed: [{ runner: 'node', cwd: 'packages/api', exitCode: 3 }, { runner: 'node', cwd: '', exitCode: 1 }] });
    expect((await runTestCommands([node(0)], { root, stdio: 'ignore' })).exitCode).toBe(0);
    const missing = await runTestCommands([{ cwd: '', runner: 'x', argv: ['definitely-not-a-command-cv'], display: '', files: [] }], { root, stdio: 'ignore' });
    expect(missing.exitCode).toBe(127);
    // A runner that is not installed (npx would ask the registry): exit 127, flagged for the "npm install" hint.
    const notInstalled = await runTestCommands([{ cwd: 'packages/api', runner: 'jest', argv: ['npx', 'definitely-not-a-runner-cv', '--runTestsByPath', 'a.test.js'], display: '', files: [] }], { root, stdio: 'ignore' });
    expect(notInstalled).toMatchObject({ exitCode: 127, failed: [{ runner: 'jest', cwd: 'packages/api', exitCode: 127, notInstalled: true }] });
  });

  it('test --coverage with node --test: a real V8 lcov report, patch coverage of code lines only, against --base', async () => {
    const root = path.join(makeTempDir('cv-node-cov-'), 'pkg');
    writeFile(root, 'package.json', JSON.stringify({ name: 'pkg', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }));
    writeFile(root, 'src/cart.js', 'export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n');
    writeFile(root, 'src/tax.js', 'export const tax = (v) => v * 0.2;\n');
    writeFile(root, 'test/cart.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\n\ntest('total', () => assert.equal(total([{ price: 2 }]), 2));\n");
    writeFile(root, 'test/tax.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { tax } from '../src/tax.js';\n\ntest('tax', () => assert.equal(tax(10), 2));\n");
    writeFile(root, '.gitignore', 'coverage/\n');
    git(root, ['init', '-q', '-b', 'main']);
    commitAll(root, { author: 'Alice Archer', date: daysAgo(3), message: 'initial' });
    // develop moves tax.js on; the feature branch starts from develop.
    git(root, ['checkout', '-q', '-b', 'develop']);
    writeFile(root, 'src/tax.js', 'export const tax = (v) => v * 0.2;\nexport const untaxed = (v) => {\n  return v;\n};\n');
    commitAll(root, { author: 'Alice Archer', date: daysAgo(2), message: 'untaxed' });
    git(root, ['checkout', '-q', '-b', 'feature']);
    // Uncommitted: a blank line, a comment and an untested function (V8 marks blank and comment lines as run).
    writeFile(root, 'src/cart.js', 'export const total = (items) => items.reduce((s, i) => s + i.price, 0);\n\n// Shipping is free above 50.\nexport const shipping = (sum) => {\n  if (sum > 50) return 0;\n  return 5;\n};\n');
    const run = await cli('test', root, '--coverage', '--base', 'develop');
    expect(run.code).toBe(0);
    expect(fs.existsSync(path.join(root, 'coverage/lcov.info'))).toBe(true);
    // Lines 5-6 (the body) never ran; 2-3 (blank, comment), which V8 reports as run, do not count; 4 and 7
    // ran when the module loaded. tax.js changed on develop, not here.
    expect(run.stdout).toContain('Patch coverage 50% (2/4 changed lines) — uncovered src/cart.js L5-6');
    expect(run.stdout).not.toContain('src/tax.js');
    expect(run.stdout).not.toContain('No coverage report found');
    const last = readState<LastTestState>(root, 'lastTest')!;
    expect(last).toMatchObject({ passed: true, coverage: true, files: ['test/cart.test.js'] });
    // The report came from a run of only the affected tests: patch coverage, not project coverage.
    const data = await analyze({ root, includeSource: false, history: false, base: 'develop' });
    expect(data.coverage!.partial).toBe(true);
    expect(data.stats.lineCoverage).toBeUndefined();
  });
});

describe('test command usage', () => {
  it('rejects conflicting modes and outputs', async () => {
    expect((await cli('test', '--staged', '--since', 'main')).code).toBe(2);
    expect((await cli('test', '--list', '--json')).code).toBe(2);
    expect((await cli('test', '--bogus')).code).toBe(2);
    const help = await cli('test', '--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('$ code-visualizer test');
  });

  it('needs a git repository', async () => {
    const root = copyFixture('monorepo-ws');
    const result = await cli('test', root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not a git repository');
  });
});
