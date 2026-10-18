import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeHistory } from '../src/analyzer/health.js';
import { analyze, createAnalyzeCache } from '../src/analyzer/index.js';
import type { ApiCall, HistoryPoint, ReportData } from '../src/shared/types.js';
import { appendFile, copyFixture, fixtureDir, removeTempDirs, writeFile } from './companion-helpers.js';
import { expectRoute, getFile, routeSignatures } from './helpers.js';

const root = fixtureDir('fullstack-next');
let data: ReportData;
beforeAll(async () => {
  data = await analyze({ root, git: false, includeSource: false, history: false });
});
afterAll(removeTempDirs);

function callsOf(file: string): ApiCall[] {
  return data.apiCalls.filter((c) => c.file === file);
}

function routeOf(call: ApiCall): string | undefined {
  const r = data.routes.find((x) => x.id === call.route);
  return r && `${r.method} ${r.path}`;
}

describe('fullstack-next: project', () => {
  it('analyzes every file without warnings or unresolved imports', () => {
    expect(data.warnings).toEqual([]);
    expect(data.files.map((f) => f.id)).toEqual([
      'app/api/users/[id]/route.ts',
      'app/api/users/route.ts',
      'app/layout.tsx',
      'app/page.tsx',
      'app/settings.ts',
      'app/users/[id]/page.tsx',
      'components/UserProfile.tsx',
      'components/UserTable.tsx',
      'lib/api.ts',
      'lib/billing.ts',
      'lib/db.ts',
      'lib/format.ts',
      'lib/types.ts',
      'lib/users-client.ts',
      'next.config.mjs',
      'test/users.test.ts',
    ]);
    expect(data.files.filter((f) => f.unresolved.length)).toEqual([]);
    expect(data.project.frameworks.map((f) => f.id)).toEqual(expect.arrayContaining(['next', 'react', 'axios', 'vitest', 'typescript']));
    expect(data.insights.missingDependencies).toEqual([]);
    expect(data.insights.unusedDependencies).toEqual([]);
  });

  it('finds the app-router pages and API routes', () => {
    expect(routeSignatures(data).sort()).toEqual(['DELETE /api/users/[id]', 'GET /api/users', 'GET /api/users/[id]', 'LAYOUT /', 'PAGE /', 'PAGE /users/[id]', 'POST /api/users'].sort());
    expectRoute(data, 'GET', '/api/users/[id]', { file: 'app/api/users/[id]/route.ts', handlerSymbol: 'app/api/users/[id]/route.ts#GET', params: ['id'] });
    expectRoute(data, 'DELETE', '/api/users/[id]', { handlerSymbol: 'app/api/users/[id]/route.ts#DELETE' });
  });

  it('summarizes the config file', () => {
    expect(data.config).toEqual({
      file: 'code-visualizer.config.json',
      rules: 1,
      layers: ['app/**', 'components/**', 'lib/**'],
      // agent-guardrails: the named rules, for session briefs and the AGENTS.md block
      ruleList: [
        {
          name: 'components-use-public-lib',
          from: ['components/**'],
          to: ['lib/**'],
          allow: ['lib/format.ts', 'lib/types.ts', 'lib/users-client.ts'],
          severity: 'error',
          message: 'Components may only import the public lib modules',
        },
      ],
    });
  });
});

describe('fullstack-next: API map', () => {
  it('links fetch() calls of the client component to the route handlers (incl. the [id] route)', () => {
    expect(callsOf('components/UserTable.tsx').map((c) => [c.method, c.url, c.client, routeOf(c)])).toEqual([
      ['GET', '/api/users', 'fetch', 'GET /api/users'],
      ['DELETE', '/api/users/:param', 'fetch', 'DELETE /api/users/[id]'],
      ['POST', '/api/reports/export', 'fetch', undefined],
    ]);
    expect(callsOf('components/UserTable.tsx').every((c) => c.symbol === 'components/UserTable.tsx#UserTable')).toBe(true);
  });

  it('links the axios instance with a base URL ("/users" → /api/users) to the right handlers', () => {
    expect(callsOf('lib/users-client.ts').map((c) => [c.symbol, c.method, c.url, c.client, routeOf(c)])).toEqual([
      ['lib/users-client.ts#fetchUsers', 'GET', '/users', 'api', 'GET /api/users'],
      ['lib/users-client.ts#fetchUser', 'GET', '/users/:param', 'api', 'GET /api/users/[id]'],
      ['lib/users-client.ts#createUser', 'POST', '/users', 'api', 'POST /api/users'],
    ]);
  });

  it('records calls to external services without linking them', () => {
    expect(callsOf('lib/billing.ts')).toEqual([
      { id: 'lib/billing.ts:6:0', file: 'lib/billing.ts', symbol: 'lib/billing.ts#chargeClosingBalance', line: 6, method: 'POST', url: 'https://api.stripe.com/v1/charges', client: 'fetch', route: undefined, external: 'api.stripe.com' },
    ]);
  });

  it('leaves calls to endpoints that do not exist unlinked', () => {
    const unmatched = data.apiCalls.filter((c) => !c.route && !c.external);
    expect(unmatched.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/reports/export']);
  });

  it('links supertest requests in tests', () => {
    expect(callsOf('test/users.test.ts').map((c) => [c.client, c.method, c.url, routeOf(c)])).toEqual([
      ['supertest', 'GET', '/api/users', 'GET /api/users'],
      ['supertest', 'DELETE', '/api/users/1', 'DELETE /api/users/[id]'],
    ]);
  });

  it('gives every call a unique id', () => {
    expect(new Set(data.apiCalls.map((c) => c.id)).size).toBe(data.apiCalls.length);
  });
});

describe('fullstack-next: insights', () => {
  it('lists the @deprecated function with the places that still use it', () => {
    expect(data.insights.deprecated).toEqual([
      {
        symbol: 'lib/format.ts#formatUserName',
        file: 'lib/format.ts',
        name: 'formatUserName',
        line: 12,
        note: 'Use displayName() instead.',
        usages: expect.arrayContaining(['components/UserTable.tsx']),
      },
    ]);
    expect(getFile(data, 'lib/format.ts').symbols.find((s) => s.name === 'displayName')!.deprecated).toBeUndefined();
  });

  it('reports the forbidden import and the layer violation from the config', () => {
    expect(data.insights.ruleViolations).toEqual([
      { rule: 'components-use-public-lib', severity: 'error', source: 'components/UserTable.tsx', target: 'lib/db.ts', line: 4, message: 'Components may only import the public lib modules' },
      { rule: 'layers', severity: 'error', source: 'lib/billing.ts', target: 'app/settings.ts', line: 1, message: '“lib/**” must not depend on the higher layer “app/**”' },
    ]);
  });

  it('maps tests to the files they reach and lists important untested files', () => {
    expect(getFile(data, 'app/api/users/route.ts').tests).toEqual(['test/users.test.ts']);
    expect(getFile(data, 'lib/db.ts').tests).toEqual(['test/users.test.ts']);
    expect(getFile(data, 'lib/types.ts').tests).toBeUndefined(); // only reached through type imports
    expect(getFile(data, 'test/users.test.ts').tests).toBeUndefined();
    expect(data.stats.testReach).toBe(0.154); // 2 of 13 testable files
    expect(data.insights.untested).toHaveLength(11);
    expect(data.insights.untested).toContain('components/UserTable.tsx');
    expect(data.insights.untested).not.toContain('lib/db.ts');
    expect(data.insights.untested).not.toContain('lib/types.ts');
  });

  it('reads CODEOWNERS (last matching rule wins) for files and folders', () => {
    const owners = Object.fromEntries(data.files.map((f) => [f.id, f.owners]));
    expect(owners).toMatchObject({
      'app/page.tsx': ['@acme/web'],
      'app/api/users/route.ts': ['@acme/backend'],
      'app/api/users/[id]/route.ts': ['@acme/backend'],
      'components/UserTable.tsx': ['@acme/web'],
      'lib/db.ts': ['@acme/backend'],
      'lib/billing.ts': ['@acme/payments', 'billing-lead@acme.dev'],
      'test/users.test.ts': ['@acme/qa'],
      'next.config.mjs': ['@acme/platform'],
    });
    const folder = (p: string) => data.folders.find((f) => f.path === p)!;
    expect(folder('lib').owners).toEqual(['@acme/backend', '@acme/payments', 'billing-lead@acme.dev']);
    expect(folder('components').owners).toEqual(['@acme/web']);
    expect(folder('lib').experts).toBeUndefined(); // no git history
  });

  it('loads the CodeTour from .tours/', () => {
    expect(data.tours).toEqual([
      {
        title: 'Intro to the users feature',
        description: 'How the user list travels from the database to the screen.',
        source: '.tours/intro.tour',
        steps: [
          { title: 'The API', description: 'Route handlers live next to the URL they serve.', file: 'app/api/users/route.ts', line: 4 },
          { title: 'The table', description: 'The client component fetches `/api/users`.', file: 'components/UserTable.tsx', line: 11 },
          { title: 'Shared code', description: 'Helpers used by both sides.', directory: 'lib' },
        ],
      },
    ]);
    // Steps point at files that exist in the report.
    for (const step of data.tours[0].steps) if (step.file) expect(data.files.some((f) => f.id === step.file), step.file).toBe(true);
  });

  it('computes a health report without git', () => {
    // clone-radar: Duplication takes 10% of the score.
    expect(data.health.categories.map((c) => c.id)).toEqual(['modularity', 'complexity', 'size', 'dead-code', 'dependencies', 'tests', 'duplication']);
    expect(data.health.score).toBeGreaterThan(0);
    expect(data.health.improvements[0]).toMatchObject({ id: 'tests' });
    expect(data.history).toHaveLength(1);
    expect(data.history[0]).toMatchObject({ score: data.health.score, files: 16, cycles: 0, unusedExports: 2, testReach: 0.154 });
    expect(data.changes).toBeUndefined();
    expect(data.git).toBeUndefined();
  });
});

describe('fullstack-next: history and incremental re-analysis', () => {
  it('appends to .code-visualizer/history.json unless history is disabled', async () => {
    const copy = copyFixture('fullstack-next');
    const old: HistoryPoint = { date: Date.now() - 7 * 3600 * 1000, score: 50, files: 3, loc: 10, cycles: 0, unusedExports: 0, avgComplexity: 1, testReach: 0, todos: 0 };
    writeHistory(copy, [old]);
    const withHistory = await analyze({ root: copy, git: false, includeSource: false });
    expect(withHistory.history).toHaveLength(2);
    expect(withHistory.history[0]).toEqual(old);
    expect(withHistory.history[1]).toMatchObject({ score: withHistory.health.score, files: 16 });
    const without = await analyze({ root: copy, git: false, includeSource: false, history: false });
    expect(without.history).toHaveLength(1);
  });

  it('reuses cached parses for unchanged files and matches a fresh analysis', async () => {
    const copy = copyFixture('fullstack-next');
    const cache = createAnalyzeCache();
    const opts = { root: copy, git: false, includeSource: false, history: false } as const;
    const first = await analyze({ ...opts, cache });
    expect([...cache.files.keys()].sort()).toEqual(first.files.map((f) => f.id).sort());
    const before = new Map([...cache.files].map(([id, entry]) => [id, entry.parsed]));

    appendFile(copy, 'lib/format.ts', '\nexport function initials(name: string): string {\n  return name.slice(0, 1);\n}\n');
    fs.rmSync(path.join(copy, 'lib/billing.ts'));
    writeFile(copy, 'lib/flags.ts', 'export const FLAGS = { beta: true };\n');
    const second = await analyze({ ...opts, cache });

    expect(cache.files.has('lib/billing.ts')).toBe(false);
    expect(cache.files.has('lib/flags.ts')).toBe(true);
    expect(cache.files.get('lib/db.ts')!.parsed).toBe(before.get('lib/db.ts'));
    expect(cache.files.get('lib/format.ts')!.parsed).not.toBe(before.get('lib/format.ts'));
    expect(getFile(second, 'lib/format.ts').symbols.map((s) => s.name)).toContain('initials');
    expect(getFile(second, 'app/api/users/[id]/route.ts').unresolved).toEqual([{ specifier: '@/lib/billing', line: 2 }]);
    expect(second.apiCalls.some((c) => c.file === 'lib/billing.ts')).toBe(false);

    // Two files changed (format.ts edited, flags.ts added); everything else came from the cache.
    expect(first.stats.cache).toEqual({ reused: 0, parsed: 16, source: 'cold' });
    expect(second.stats.cache).toEqual({ reused: 14, parsed: 2, source: 'memory' });
    const strip = (d: ReportData) => ({ ...d, generatedAt: '', stats: { ...d.stats, durationMs: 0, cache: undefined }, history: d.history.map((h) => ({ ...h, date: 0 })) });
    const fresh = await analyze(opts);
    expect(strip(second)).toEqual(strip(fresh));
  });
});
