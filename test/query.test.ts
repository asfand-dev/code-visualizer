import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import {
  callersOf,
  calleesOf,
  filesOfTarget,
  httpTestedFiles,
  impactOf,
  importPath,
  pathFiles,
  resolveTarget,
  routeFor,
  routeTestReach,
  suggest,
  testEvidence,
  testsFor,
  transitive,
  untestedChanges,
  usesOf,
  whoOf,
} from '../src/shared/query.js';
import { buildTestCommand } from '../src/shared/testcmd.js';
import { callMatchesRoute, routeScore, segments } from '../src/shared/route-match.js';
import type { ChangedFile, ReportData } from '../src/shared/types.js';
import { selectTests } from '../src/analyzer/test-select.js';
import { commitAll, copyFixture, DAY, daysAgo, editFile, emailOf, fixtureDir, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';
import { analyzeFixture } from './helpers.js';

let react: ReportData;
let express: ReportData;
let fullstack: ReportData;
beforeAll(async () => {
  [react, express, fullstack] = await Promise.all([
    analyzeFixture('react-vite-ts'),
    analyzeFixture('express-api'),
    analyze({ root: fixtureDir('fullstack-next'), git: false, includeSource: false, history: false }),
  ]);
});
afterAll(removeTempDirs);

const FORMAT_DATE = 'src/utils/format.ts#formatDate';

describe('resolveTarget', () => {
  it('resolves exact paths, unique suffixes, path#Name, Class.method, folders and symbol names', () => {
    expect(resolveTarget(react, 'src/components/Button.tsx')).toEqual({ target: { type: 'file', id: 'src/components/Button.tsx' }, suggestions: [] });
    expect(resolveTarget(react, './src/components/Button.tsx').target).toEqual({ type: 'file', id: 'src/components/Button.tsx' });
    expect(resolveTarget(react, `${react.project.rootPath}/src/components/Button.tsx`).target).toEqual({ type: 'file', id: 'src/components/Button.tsx' });
    expect(resolveTarget(react, 'Button.tsx').target).toEqual({ type: 'file', id: 'src/components/Button.tsx' });
    expect(resolveTarget(react, 'components/Button').target).toEqual({ type: 'file', id: 'src/components/Button.tsx' });
    expect(resolveTarget(react, 'useDebounce').target).toEqual({ type: 'symbol', id: 'src/hooks/useDebounce.ts#useDebounce' });
    expect(resolveTarget(react, 'src/utils/format.ts#formatDate').target).toEqual({ type: 'symbol', id: FORMAT_DATE });
    expect(resolveTarget(react, 'format.ts#formatdate').target).toEqual({ type: 'symbol', id: FORMAT_DATE });
    expect(resolveTarget(react, 'src/components').target).toEqual({ type: 'dir', id: 'src/components' });
    expect(resolveTarget(react, 'src/components/').target).toEqual({ type: 'dir', id: 'src/components' });
    expect(resolveTarget(react, 'components').target).toEqual({ type: 'dir', id: 'src/components' });
    expect(resolveTarget(react, '.').target).toEqual({ type: 'dir', id: '' });
    expect(resolveTarget(express, 'UserService.findById').target).toEqual({ type: 'symbol', id: 'services/UserService.js#UserService.findById' });
    // A bare method name finds the class member.
    expect(resolveTarget(express, 'findById').target).toEqual({ type: 'symbol', id: 'services/UserService.js#UserService.findById' });
  });

  it('resolves a concrete URL to the route that serves it', () => {
    expect(resolveTarget(fullstack, 'GET /api/users/42').target).toEqual({ type: 'route', id: 'app/api/users/[id]/route.ts:7:GET:/api/users/[id]' });
    expect(resolveTarget(fullstack, 'delete /api/users/1').target).toEqual({ type: 'route', id: 'app/api/users/[id]/route.ts:13:DELETE:/api/users/[id]' });
    // Route paths in any parameter syntax, and pages.
    expect(resolveTarget(fullstack, 'GET /api/users/:id').target?.id).toBe('app/api/users/[id]/route.ts:7:GET:/api/users/[id]');
    expect(resolveTarget(fullstack, 'GET /users/7').target?.id).toBe('app/users/[id]/page.tsx:3:PAGE:/users/[id]');
    expect(resolveTarget(express, 'GET /api/users/42').target?.id).toBe('routes/users.js:10:GET:/api/users/:id');
    // Wrong method: the routes that do match are suggested.
    expect(resolveTarget(express, 'PUT /api/users/42')).toEqual({ suggestions: ['DELETE /api/users/:id', 'GET /api/users/:id', 'PATCH /api/users/:id'] });
  });

  it('ranks same-named symbols and reports the others', () => {
    const r = resolveTarget(fullstack, 'GET');
    expect(r.target?.type).toBe('symbol');
    expect(r.alternatives?.length).toBeGreaterThan(0);
    expect([r.target!.id, ...r.alternatives!].sort()).toEqual(['app/api/users/[id]/route.ts#GET', 'app/api/users/route.ts#GET']);
  });

  it('suggests close matches for typos and lists ambiguous files', () => {
    const typo = resolveTarget(react, 'Buton');
    expect(typo.target).toBeUndefined();
    expect(typo.suggestions).toContain('Button');
    expect(resolveTarget(react, 'useDebounse').suggestions).toContain('useDebounce');
    expect(resolveTarget(react, 'src/compnents/').suggestions).toContain('src/components/');
    expect(suggest(react, 'zzzzzzzzzz')).toEqual([]);
    // Two files end with route.ts: nothing is picked, both are offered.
    expect(resolveTarget(fullstack, 'route.ts')).toEqual({ suggestions: expect.arrayContaining(['app/api/users/route.ts', 'app/api/users/[id]/route.ts']) });
  });
});

describe('usesOf', () => {
  it('lists imports and the exact call lines with argument counts', () => {
    const uses = usesOf(react, { type: 'symbol', id: FORMAT_DATE });
    expect(uses.imports).toEqual([{ file: 'src/components/UserCard.tsx', line: 2, kind: 'import', names: ['formatDate'] }]);
    expect(uses.sites).toEqual([{ file: 'src/components/UserCard.tsx', line: 16, kind: 'call', argc: 1, symbol: 'src/components/UserCard.tsx#UserCard', target: FORMAT_DATE }]);
    expect(uses.files).toBe(1);
  });

  it('finds renders through barrels, with the barrel as `via`', () => {
    const uses = usesOf(react, { type: 'symbol', id: 'src/components/Button.tsx#Button' });
    expect(uses.sites.map((s) => [s.file, s.line, s.kind])).toEqual([
      ['src/components/ThemeToggle.tsx', 9, 'render'],
      ['src/components/UserCard.tsx', 20, 'render'],
      ['src/pages/Settings.tsx', 24, 'render'],
    ]);
    expect(uses.imports.find((i) => i.file === 'src/pages/Settings.tsx')).toMatchObject({ line: 2, kind: 'import', names: ['Button'], via: 'src/components/index.ts' });
    expect(uses.imports.find((i) => i.file === 'src/components/index.ts')).toMatchObject({ kind: 'reexport', names: ['Button'] });
  });

  it('reports method calls, `new` sites and HTTP callers of route handlers', () => {
    const findById = usesOf(express, { type: 'symbol', id: 'services/UserService.js#UserService.findById' });
    expect(findById.sites.map((s) => [s.file, s.line, s.symbol])).toEqual([
      ['controllers/usersController.js', 27, 'controllers/usersController.js#getById'],
      ['services/UserService.js', 26, 'services/UserService.js#UserService.update'],
      ['services/UserService.js', 32, 'services/UserService.js#UserService.remove'],
    ]);
    const notFound = usesOf(express, { type: 'symbol', id: 'utils/errors.js#NotFoundError' });
    expect(notFound.sites).toContainEqual(expect.objectContaining({ file: 'services/UserService.js', line: 16, kind: 'new', argc: 1 }));
    expect(usesOf(express, { type: 'symbol', id: 'utils/errors.js#AppError' }).refs).toContainEqual({ symbol: 'utils/errors.js#NotFoundError', file: 'utils/errors.js', kind: 'extends', target: 'utils/errors.js#AppError' });
    const handler = usesOf(fullstack, { type: 'route', id: 'app/api/users/[id]/route.ts:13:DELETE:/api/users/[id]' });
    expect(handler.http.map((s) => [s.file, s.line, s.method])).toEqual([
      ['components/UserTable.tsx', 18, 'DELETE'],
      ['test/users.test.ts', 20, 'DELETE'],
    ]);
  });

  it('for a file: importers, plus the calls into each of its symbols', () => {
    const uses = usesOf(react, { type: 'file', id: 'src/utils/format.ts' });
    expect(uses.imports.map((i) => [i.file, i.names])).toEqual([
      ['src/components/UserCard.tsx', ['formatDate']],
      ['src/pages/Settings.tsx', ['formatCurrency']],
      ['src/utils/math.ts', ['formatNumber']],
    ]);
    expect(uses.sites).toContainEqual(expect.objectContaining({ file: 'src/pages/Settings.tsx', line: 23, target: 'src/utils/format.ts#formatCurrency' }));
  });

  it('callers and callees include HTTP hops to route handlers', () => {
    expect(calleesOf(fullstack, 'lib/users-client.ts#fetchUser')).toContainEqual({ id: 'app/api/users/[id]/route.ts#GET', kind: 'http', count: 1, lines: [10], label: 'GET /api/users/[id]' });
    expect(callersOf(fullstack, 'app/api/users/[id]/route.ts#GET').map((l) => l.id)).toEqual(['lib/users-client.ts#fetchUser']);
    expect(callersOf(fullstack, 'lib/db.ts#findUser')).toEqual([{ id: 'app/api/users/[id]/route.ts#GET', kind: 'calls', count: 1, lines: [8] }]);
  });
});

describe('impactOf', () => {
  it('for a symbol, ignores files that import only other exports of its file', () => {
    const impact = impactOf(react, { type: 'symbol', id: FORMAT_DATE });
    expect(impact.precision).toBe('symbol');
    expect(impact.direct.map((d) => d.file)).toEqual(['src/components/UserCard.tsx']);
    expect(impact.direct[0].via).toEqual(['formatDate']);
    expect(impact.direct[0].sites).toContainEqual(expect.objectContaining({ line: 16, kind: 'call' }));
    const all = impact.byDepth.flatMap((d) => d.files);
    expect(all).not.toContain('src/utils/math.ts'); // imports formatNumber
    expect(impact.byDepth[0]).toEqual({ depth: 1, files: ['src/components/UserCard.tsx'] });
    const file = impactOf(react, { type: 'file', id: 'src/utils/format.ts' });
    expect(file.precision).toBe('file');
    expect(file.direct.map((d) => d.file)).toEqual(['src/components/UserCard.tsx', 'src/pages/Settings.tsx', 'src/utils/math.ts']);
    expect(file.total + (file.truncated ?? 0)).toBeGreaterThan(impact.total + (impact.truncated ?? 0));
  });

  it('limits the listed depth and counts the rest', () => {
    const shallow = impactOf(react, { type: 'symbol', id: FORMAT_DATE }, { depth: 1 });
    const deep = impactOf(react, { type: 'symbol', id: FORMAT_DATE }, { depth: 20 });
    expect(shallow.byDepth.map((d) => d.depth)).toEqual([1]);
    expect(shallow.total + (shallow.truncated ?? 0)).toBe(deep.total);
    expect(deep.truncated).toBeUndefined();
  });

  it('falls back to file precision for namespace imports', async () => {
    const root = makeTempDir('cv-query-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'ns', type: 'module' }));
    writeFile(root, 'src/fmt.ts', 'export function a(x: number) { return x + 1; }\nexport function b(x: number) { return x * 2; }\n');
    writeFile(root, 'src/named.ts', "import { b } from './fmt';\nexport const useB = () => b(2);\n");
    writeFile(root, 'src/star.ts', "import * as fmt from './fmt';\nexport const useA = () => fmt.a(1);\n");
    writeFile(root, 'src/main.ts', "import { useB } from './named';\nimport { useA } from './star';\nconsole.log(useA(), useB());\n");
    const data = await analyze({ root, git: false, includeSource: false, history: false, persist: false });
    const impact = impactOf(data, { type: 'symbol', id: 'src/fmt.ts#a' });
    expect(impact.precision).toBe('file');
    expect(impact.precisionNote).toContain('src/star.ts');
    expect(impact.direct.map((d) => d.file)).toEqual(['src/star.ts']); // named.ts imports only b
    expect(impact.direct[0].sites).toContainEqual(expect.objectContaining({ line: 2, kind: 'call' }));
    // A private helper reached only through an exported function counts as that function.
    writeFile(root, 'src/helper.ts', "function inner() { return 1; }\nexport function outer() { return inner(); }\nexport function other() { return 2; }\n");
    writeFile(root, 'src/useOuter.ts', "import { outer } from './helper';\nexport const v = outer();\n");
    writeFile(root, 'src/useOther.ts', "import { other } from './helper';\nexport const w = other();\n");
    const next = await analyze({ root, git: false, includeSource: false, history: false, persist: false });
    const helper = impactOf(next, { type: 'symbol', id: 'src/helper.ts#inner' });
    expect(helper.precision).toBe('symbol');
    expect(helper.direct.map((d) => d.file)).toEqual(['src/useOuter.ts']);
  });

  it('passes a change on through files that are targets themselves', () => {
    // POST changed in route.ts, listUsers changed in db.ts: GET (in route.ts) calls listUsers.
    const impact = impactOf(fullstack, [
      { type: 'symbol', id: 'lib/db.ts#listUsers' },
      { type: 'symbol', id: 'app/api/users/route.ts#POST' },
    ]);
    expect(impact.direct.map((d) => d.file)).not.toContain('app/api/users/route.ts');
    expect(impact.routes.map((r) => r.label)).toEqual(expect.arrayContaining(['GET /api/users', 'POST /api/users']));
    expect(impact.byDepth.flatMap((d) => d.files)).toContain('test/users.test.ts');
  });

  it('reaches routes, HTTP callers, tests and owners', () => {
    const route = impactOf(fullstack, { type: 'route', id: 'app/api/users/[id]/route.ts:13:DELETE:/api/users/[id]' });
    expect(route.direct.map((d) => d.file)).toEqual(['components/UserTable.tsx', 'test/users.test.ts']);
    expect(route.direct[0].sites).toEqual([expect.objectContaining({ line: 18, kind: 'http', method: 'DELETE' })]);
    expect(route.routes.map((r) => r.label)).toEqual(expect.arrayContaining(['DELETE /api/users/[id]', 'PAGE /']));
    expect(route.tests.files).toEqual(['test/users.test.ts']);
    expect(route.tests.command).toBe('npx vitest run test/users.test.ts');
    expect(route.owners.map((o) => o.owner)).toEqual(expect.arrayContaining(['@acme/web', '@acme/qa']));
    const button = impactOf(react, { type: 'symbol', id: 'src/components/Button.tsx#Button' });
    expect(button.tests).toEqual({ files: ['src/components/Button.test.tsx'], command: 'npx vitest run src/components/Button.test.tsx', untested: [] });
    expect(button.routes.map((r) => r.label)).toContain('PAGE /settings');
  });
});

describe('impactOf: what symbol precision must not miss', () => {
  const project = async (files: Record<string, string>): Promise<ReportData> => {
    const root = makeTempDir('cv-query-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'p', type: 'module', devDependencies: { vitest: '1' } }));
    for (const [file, content] of Object.entries(files)) writeFile(root, file, content);
    return analyze({ root, git: false, includeSource: false, history: false, persist: false });
  };
  const affected = (data: ReportData, id: string): string[] => impactOf(data, { type: 'symbol', id }, { depth: 10 }).byDepth.flatMap((d) => d.files).sort();

  it('follows value references between exports of one file (constants, handler maps, returned callbacks)', async () => {
    const data = await project({
      'src/cfg.ts': "export const columns = ['a', 'b'];\nexport function table() {\n  return columns.map((c) => c.toUpperCase());\n}\n",
      'src/t.ts': "import { table } from './cfg';\nexport const t = table();\n",
      'src/format.ts': 'export function formatDate(d: string) {\n  return d;\n}\nexport const formatters = { date: formatDate };\nexport const API = "/api";\nexport function fetchUser(id: string) {\n  return fetch(`${API}/users/${id}`);\n}\n',
      'src/report.ts': "import { formatters } from './format';\nexport const row = (x: string) => formatters.date(x);\n",
      'src/z.ts': "import { fetchUser } from './format';\nexport const z = () => fetchUser('1');\n",
      'src/lib.ts': 'export function onClick() {\n  return 1;\n}\nexport function register() {\n  return [onClick];\n}\n',
      'src/a.ts': "import { register } from './lib';\nexport const a = () => register();\n",
    });
    expect(data.files.find((f) => f.id === 'src/cfg.ts')!.symbols.find((s) => s.name === 'table')!.localRefs).toEqual(['columns']);
    expect(affected(data, 'src/cfg.ts#columns')).toEqual(['src/t.ts']);
    expect(affected(data, 'src/format.ts#formatDate')).toEqual(['src/report.ts']);
    expect(affected(data, 'src/format.ts#API')).toEqual(['src/z.ts']);
    expect(affected(data, 'src/lib.ts#onClick')).toEqual(['src/a.ts']);
    expect(impactOf(data, { type: 'symbol', id: 'src/format.ts#API' }).precision).toBe('symbol');
    // `uses`: the importer of the sibling export is listed apart and not counted as a use.
    const uses = usesOf(data, { type: 'symbol', id: 'src/format.ts#formatDate' });
    expect(uses.files).toBe(0);
    expect(uses.through.map((s) => [s.file, s.names])).toEqual([['src/report.ts', ['formatters']]]);
  });

  it('falls back to file level for symbols that module-level code uses, but not for `X.displayName = …`', async () => {
    const data = await project({
      'src/setup.ts': 'export function init() {\n  (globalThis as any).x = 1;\n}\ninit();\nexport const other = 3;\n',
      'src/d.ts': "import { other } from './setup';\nexport const d = other;\n",
      'src/Button.tsx': "export function Button() {\n  return <button />;\n}\nButton.displayName = 'Button';\nexport const Other = () => null;\n",
      'src/use.tsx': "import { Other } from './Button';\nexport const U = () => <Other />;\n",
    });
    const init = impactOf(data, { type: 'symbol', id: 'src/setup.ts#init' });
    expect(init.precision).toBe('file');
    expect(init.precisionNote).toContain('module-level code');
    expect(init.byDepth.flatMap((d) => d.files)).toEqual(['src/d.ts']);
    const button = impactOf(data, { type: 'symbol', id: 'src/Button.tsx#Button' });
    expect(button.precision).toBe('symbol');
    expect(button.byDepth).toEqual([]);
  });

  it('passes a change through a barrel only to the files that import the changed names', () => {
    const userCard = impactOf(react, { type: 'symbol', id: 'src/components/UserCard.tsx#UserCard' }, { depth: 10 });
    const files = userCard.byDepth.flatMap((d) => d.files);
    expect(files).toEqual(expect.arrayContaining(['src/components/index.ts', 'src/pages/Home.tsx']));
    // Settings imports Button, Card and ThemeToggle from the barrel; Reports only Card.
    expect(files).not.toContain('src/pages/Settings.tsx');
    expect(files).not.toContain('src/pages/admin/Reports.tsx');
    expect(userCard.routes.map((r) => r.label)).not.toContain('PAGE /settings');
    expect(userCard.routes.map((r) => r.label)).not.toContain('PAGE /admin/reports');
    // File level too: an importer of the barrel that takes only other names is not affected.
    const file = impactOf(react, { type: 'file', id: 'src/components/UserCard.tsx' }, { depth: 10 });
    expect(file.byDepth.flatMap((d) => d.files)).not.toContain('src/pages/admin/Reports.tsx');
  });

  it('counts only the routes whose handler uses the symbol in a multi-route file', async () => {
    const findUser = impactOf(fullstack, { type: 'symbol', id: 'lib/db.ts#findUser' });
    expect(findUser.routes.map((r) => r.label)).toEqual(['GET /api/users/[id]']);
    // No test reaches findUser's users (the test requests DELETE and the list route): said for the symbol, not the file.
    expect(findUser.tests).toEqual({ files: [], command: undefined, untested: ['lib/db.ts#findUser'] });
    const nest = await analyze({ root: fixtureDir('nest-api'), git: false, includeSource: false, history: false, persist: false });
    const service = nest.files.flatMap((f) => f.symbols).find((s) => s.name === 'UsersService')!;
    const findOne = impactOf(nest, { type: 'symbol', id: `${service.id}.findOne` });
    expect(findOne.routes.map((r) => r.label).sort()).toEqual(['GET /users/:id', 'PATCH /users/:id']);
  });

  it('adds the tests that request an affected route over HTTP', () => {
    const del = impactOf(fullstack, { type: 'symbol', id: 'lib/db.ts#deleteUser' });
    expect(del.routes.map((r) => r.label)).toEqual(['DELETE /api/users/[id]']);
    expect(del.tests.files).toEqual(['test/users.test.ts']);
    expect(del.tests.untested).toEqual([]);
  });
});

describe('query fixes: resolving, uses of members, routes, who', () => {
  it('resolves path#Name through barrels, `dir/` to folders, and CommonJS `module.member`', async () => {
    expect(resolveTarget(react, 'src/components/index.ts#Button').target).toEqual({ type: 'symbol', id: 'src/components/Button.tsx#Button' });
    expect(resolveTarget(react, 'components/index.ts#button').target).toEqual({ type: 'symbol', id: 'src/components/Button.tsx#Button' });
    expect(resolveTarget(react, 'src/components/index.ts#Buton').suggestions).toContain('src/components/index.ts#Button');
    expect(resolveTarget(express, 'usersController.getById').target).toEqual({ type: 'symbol', id: 'controllers/usersController.js#getById' });
    const root = makeTempDir('cv-query-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'p', type: 'module' }));
    writeFile(root, 'src/api.ts', 'export const k = 1;\n');
    writeFile(root, 'src/api/index.ts', 'export const j = 2;\n');
    const data = await analyze({ root, git: false, includeSource: false, history: false, persist: false });
    expect(resolveTarget(data, 'src/api/').target).toEqual({ type: 'dir', id: 'src/api' });
    expect(resolveTarget(data, 'src/api').target).toEqual({ type: 'file', id: 'src/api.ts' });
    expect(resolveTarget(data, 'api/').target).toEqual({ type: 'dir', id: 'src/api' });
  });

  it('uses of a class member: call sites, `new` in its own file, and the class importers apart', async () => {
    const root = makeTempDir('cv-query-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'p', type: 'module' }));
    writeFile(root, 'src/svc.ts', 'export class Svc {\n  run() { return 1; }\n  stop() { return 2; }\n}\nexport function boot() {\n  const s = new Svc();\n  return s;\n}\n');
    writeFile(root, 'src/s1.ts', "import { Svc } from './svc';\nexport const s1 = new Svc().run();\n");
    writeFile(root, 'src/s2.ts', "import { Svc } from './svc';\nexport const s2 = new Svc().stop();\n");
    const data = await analyze({ root, git: false, includeSource: false, history: false, persist: false });
    const run = usesOf(data, { type: 'symbol', id: 'src/svc.ts#Svc.run' });
    expect(run.imports).toEqual([]);
    expect(run.through.map((s) => s.file)).toEqual(['src/s1.ts', 'src/s2.ts']);
    expect(run.sites).toEqual([expect.objectContaining({ file: 'src/svc.ts', line: 6, kind: 'new', symbol: 'src/svc.ts#boot' })]);
    expect(run.files).toBe(1);
  });

  it('tests-for a route does not flag the handler that an HTTP test reaches', () => {
    const r = testsFor(fullstack, ['DELETE /api/users/1']);
    expect(r.files).toEqual(['test/users.test.ts']);
    expect(r.untested).toEqual([]);
    // A folder with a route handler that only HTTP tests reach is not "untested" either.
    expect(testsFor(fullstack, ['app/api/users/[id]/route.ts']).untested).toEqual([]);
  });

  it('places app-level middleware at its declaration and flags error handlers', () => {
    const [get] = routeFor(express, 'GET', '/api/users/42');
    expect(get.appMiddlewares).toEqual([{ label: 'errorHandler', file: 'middleware/errorHandler.js', line: 2, onError: true }]);
  });
});

describe('graph walks', () => {
  it('importPath returns the chain with lines and names, or undefined', () => {
    const chain = importPath(react, 'src/pages/Settings.tsx', 'src/utils/math.ts')!;
    expect(chain.hops).toEqual([
      { source: 'src/pages/Settings.tsx', target: 'src/utils/format.ts', line: 5, names: ['formatCurrency'], typeOnly: false, kind: 'import' },
      { source: 'src/utils/format.ts', target: 'src/utils/math.ts', line: 1, names: ['round'], typeOnly: false, kind: 'import' },
    ]);
    expect(pathFiles('src/pages/Settings.tsx', chain)).toEqual(['src/pages/Settings.tsx', 'src/utils/format.ts', 'src/utils/math.ts']);
    expect(importPath(react, 'src/hooks/useDebounce.ts', 'src/pages/Settings.tsx')).toBeUndefined();
    expect(importPath(react, 'src/pages/Settings.tsx', 'src/pages/Settings.tsx')).toEqual({ hops: [] });
    expect(importPath(react, 'nope.ts', 'src/pages/Settings.tsx')).toBeUndefined();
  });

  it('transitive walks dependents and dependencies with distances', () => {
    const deps = transitive(react, 'src/pages/Settings.tsx', 'deps', 1);
    expect(deps.get('src/utils/format.ts')).toBe(1);
    expect(deps.has('src/utils/math.ts')).toBe(false);
    expect(transitive(react, 'src/utils/math.ts', 'dependents').get('src/utils/format.ts')).toBe(1);
  });
});

describe('routeFor', () => {
  it('finds the handler, middleware, callers and tests for a URL', () => {
    const [get] = routeFor(express, 'GET', '/api/users/42');
    expect(get).toMatchObject({ label: 'GET /api/users/:id', exact: true, handler: { file: 'controllers/usersController.js', line: 25, symbol: 'controllers/usersController.js#getById' }, middlewares: ['auth'] });
    expect(get.appMiddlewares).toContainEqual(expect.objectContaining({ label: 'errorHandler', file: 'middleware/errorHandler.js' }));
    expect(routeFor(express, undefined, '/api/users/42').map((m) => m.label)).toEqual(['DELETE /api/users/:id', 'GET /api/users/:id', 'PATCH /api/users/:id']);
    expect(routeFor(express, 'POST', '/api/users/42')).toEqual([]);
    const [next] = routeFor(fullstack, 'DELETE', 'http://localhost:3000/api/users/9?force=1');
    expect(next.callers.map((c) => `${c.file}:${c.line}`)).toEqual(['components/UserTable.tsx:18', 'test/users.test.ts:20']);
    expect(next.tests).toEqual(['test/users.test.ts']);
    // A URL pasted from staging, production or a log: its host does not matter.
    expect(routeFor(fullstack, 'GET', 'https://api.example.com/api/users/1').map((m) => m.label)).toEqual(['GET /api/users/[id]']);
    expect(routeFor(express, undefined, 'https://api.example.com/api/users/42?x=1#top').map((m) => m.label)).toEqual(['DELETE /api/users/:id', 'GET /api/users/:id', 'PATCH /api/users/:id']);
    expect(resolveTarget(express, 'GET https://staging.example.com/api/users/42').target?.id).toBe('routes/users.js:10:GET:/api/users/:id');
  });

  it('shares the API map matching rules', () => {
    expect(segments('/api/users/?q=1')).toEqual(['api', 'users']);
    expect(routeScore({ method: 'GET', type: 'api' }, ['api', 'users', ':id'], 'GET', ['users', ':param'])).toBeGreaterThan(0); // base-URL suffix
    expect(routeScore({ method: 'GET', type: 'api' }, ['api', 'users', ':id'], 'GET', ['about'])).toBe(0);
    expect(callMatchesRoute({ method: 'PAGE', path: '/users/[id]', type: 'page' }, { method: 'GET', url: '/users/1', client: 'fetch' })).toBe(false);
    expect(callMatchesRoute({ method: 'PAGE', path: '/users/[id]', type: 'page' }, { method: 'GET', url: '/users/1', client: 'supertest' })).toBe(true);
  });
});

describe('testsFor', () => {
  it('collects the tests, the command and untested files', () => {
    const r = testsFor(react, ['src/components/Button.tsx', 'src/utils', 'nope.ts']);
    expect(r.files).toEqual(['src/components/Button.test.tsx']);
    expect(r.command).toBe('npx vitest run src/components/Button.test.tsx');
    expect(r.unknown).toEqual(['nope.ts']);
    expect(r.untested).toEqual(['src/utils/format.ts', 'src/utils/legacyStorage.ts', 'src/utils/math.ts']);
    expect(r.byPath).toEqual([
      { path: 'src/components/Button.tsx', tests: ['src/components/Button.test.tsx'] },
      { path: 'src/utils', tests: [] },
    ]);
    // A route: tests that request it over HTTP count too.
    expect(testsFor(fullstack, [{ type: 'route', id: 'app/api/users/[id]/route.ts:13:DELETE:/api/users/[id]' }]).files).toEqual(['test/users.test.ts']);
    expect(filesOfTarget(fullstack, { type: 'dir', id: 'lib' })).toHaveLength(6);
  });

  it('builds one command per workspace runner', () => {
    const runners = { '': { unit: 'vitest' }, 'packages/api': { unit: 'jest', pm: 'pnpm' }, 'apps/web': { unit: 'vitest', e2e: 'playwright' } };
    expect(buildTestCommand(['src/a.test.ts', 'packages/api/test/b.test.ts', 'apps/web/e2e/login.spec.ts', 'apps/web/src/c.test.tsx'], runners)).toEqual({
      command:
        'npx vitest run src/a.test.ts && (cd apps/web && npx vitest run src/c.test.tsx) && (cd apps/web && npx playwright test e2e/login.spec.ts) && (cd packages/api && pnpm exec jest --runTestsByPath test/b.test.ts)',
      runner: 'vitest + playwright + jest',
    });
    expect(buildTestCommand(['a.test.ts'], { unit: 'jest', pm: 'yarn' })).toEqual({ command: 'yarn jest --runTestsByPath a.test.ts', runner: 'jest' });
    // POSIX single quotes: nothing in a file name is expanded when the command is pasted into a shell.
    expect(buildTestCommand(['my tests/a.test.ts'], { '': { unit: 'node' } }).command).toBe("node --test 'my tests/a.test.ts'");
    expect(buildTestCommand(['test/$(echo PWNED).test.ts', 'test/`id`.test.ts', "test/it's.test.ts"], { unit: 'vitest' }).command).toBe(
      "npx vitest run 'test/$(echo PWNED).test.ts' 'test/`id`.test.ts' 'test/it'\\''s.test.ts'",
    );
    // Support files under test/ are not tests: vitest / jest would fail on them ("No test files found").
    expect(buildTestCommand(['test/helpers.ts', 'test/a.test.ts'], { unit: 'vitest' }).command).toBe('npx vitest run test/a.test.ts');
    expect(buildTestCommand(['test/helpers.ts'], { unit: 'vitest' })).toEqual({});
    expect(buildTestCommand(['test/helpers.js'], { unit: 'mocha' }).command).toBe('npx mocha test/helpers.js');
    expect(buildTestCommand([], { '': { unit: 'vitest' } })).toEqual({});
    expect(react.project.testRunners).toEqual({ '': { unit: 'vitest' } });
  });
});

// --- integration (wave 3): one rule for "no test reaches this change" (My changes, pr, MCP review_changes) ---
describe('untestedChanges', () => {
  const change = (id: string, status: ChangedFile['status'] = 'modified'): ChangedFile => ({ id, status, additions: 1, deletions: 1, lines: [1], analyzed: true });

  it('lists changed source files no test imports or requests, leaving out comment-only edits, deletions, tests and configs', () => {
    const files = [
      change('lib/billing.ts'),
      change('lib/users-client.ts'),
      change('app/api/users/[id]/route.ts'),
      change('app/api/users/route.ts'),
      change('lib/format.ts'),
      change('lib/db.ts', 'deleted'),
      change('test/users.test.ts'),
      change('next.config.mjs'),
    ];
    const data = { ...fullstack, changes: { files, commentOnly: ['lib/format.ts'] } };
    const untested = untestedChanges(data);
    expect(untested).toContain('lib/users-client.ts');
    // Requested over HTTP by test/users.test.ts (`request(app).delete('/api/users/1')`), and imported by it.
    expect(untested).not.toContain('app/api/users/[id]/route.ts');
    // release fixes: what that handler imports is reached too (the route-e2e rule of `code-visualizer test`).
    expect(untested).not.toContain('lib/billing.ts');
    expect(untested).not.toContain('app/api/users/route.ts');
    for (const id of ['lib/format.ts', 'lib/db.ts', 'test/users.test.ts', 'next.config.mjs']) expect(untested).not.toContain(id);
    expect(untestedChanges({ ...fullstack, changes: undefined })).toEqual([]);
    // A coverage report that saw its lines run (test-intelligence) is evidence too.
    const covered = fullstack.files.map((f) => (f.id === 'lib/users-client.ts' ? { ...f, coverage: { lines: { total: 4, covered: 1 }, uncovered: [2, 3, 4], source: 'lcov' as const } } : f));
    expect(untestedChanges({ ...fullstack, files: covered, changes: { files, commentOnly: [] } })).not.toContain('lib/users-client.ts');
  });
});

// --- release fixes: one definition of "reached by a test" (test, tests-for, impact, untested changes) ---
describe('reached by a test: the route-e2e rule everywhere', () => {
  it('tests-for and impact name the HTTP test of a route whose handler imports lib/pricing.ts, as `test` selects it', async () => {
    const root = copyFixture('fullstack-next', 'cv-reach-');
    writeFile(root, 'lib/pricing.ts', 'export function closingFee(balance: number): number {\n  return balance > 100 ? Math.round(balance * 0.02) : 0;\n}\n');
    editFile(root, 'app/api/users/[id]/route.ts', "import { deleteUser, findUser } from '@/lib/db';", "import { deleteUser, findUser } from '@/lib/db';\nimport { closingFee } from '@/lib/pricing';");
    editFile(root, 'app/api/users/[id]/route.ts', 'await chargeClosingBalance(params.id);', 'await chargeClosingBalance(params.id, closingFee(120));');
    const data = await analyze({ root, git: false, includeSource: false, history: false });
    // No test imports lib/pricing.ts: test/users.test.ts reaches it through `request(app).delete('/api/users/1')`.
    expect(data.files.find((f) => f.id === 'lib/pricing.ts')!.tests ?? []).toEqual([]);
    const plan = selectTests(data, ['lib/pricing.ts'], { full: false });
    expect(plan.selected).toEqual([expect.objectContaining({ file: 'test/users.test.ts', reason: 'route-e2e' })]);
    const tests = testsFor(data, ['lib/pricing.ts']);
    expect(tests.files).toEqual(plan.selected.map((t) => t.file));
    expect(tests.untested).toEqual([]);
    expect(tests.command).toContain('test/users.test.ts');
    // impact's "no test reaches" list agrees with its own Tests list.
    const impact = impactOf(data, { type: 'file', id: 'lib/pricing.ts' });
    expect(impact.tests.files).toContain('test/users.test.ts');
    expect(impact.tests.untested).toEqual([]);
    // My changes / pr / MCP review_changes and the live guard share the rule.
    expect(routeTestReach(data).get('lib/pricing.ts')).toEqual(['test/users.test.ts']);
    expect(httpTestedFiles(data).has('lib/pricing.ts')).toBe(true);
    expect(untestedChanges({ ...data, changes: { files: [{ id: 'lib/pricing.ts', status: 'modified', additions: 1, deletions: 0, lines: [2], analyzed: true }] } })).toEqual([]);
    // A file only the client code uses is still untested.
    const client = data.files.find((f) => f.id === 'lib/users-client.ts')!;
    expect(testEvidence(data, client)).toBeUndefined();
    expect(testsFor(data, ['lib/users-client.ts']).untested).toEqual(['lib/users-client.ts']);
    expect(selectTests(data, ['lib/users-client.ts'], { full: false }).selected).toEqual([]);
  });

  it('counts lines the coverage report saw run as reached (testEvidence)', () => {
    const client = fullstack.files.find((f) => f.id === 'lib/users-client.ts')!;
    expect(testEvidence(fullstack, client)).toBeUndefined();
    expect(testEvidence(fullstack, { ...client, coverage: { lines: { total: 3, covered: 3 }, uncovered: [], source: 'lcov' } })).toBe('coverage');
    expect(testEvidence(fullstack, fullstack.files.find((f) => f.id === 'lib/billing.ts')!)).toBe('route');
    expect(testEvidence(fullstack, fullstack.files.find((f) => f.id === 'app/api/users/route.ts')!)).toBe('imports');
  });
});

describe.skipIf(!hasGit)('whoOf', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => restoreEnv?.());

  it('weights recent work, flags inactive people and computes the bus factor', async () => {
    const repo = initRepo('react-vite-ts');
    commitAll(repo, { author: 'Old Timer', date: daysAgo(400), message: 'Initial import' });
    for (let i = 0; i < 3; i++) {
      editFile(repo, 'src/utils/format.ts', /month: '(short|long)'/, `month: '${i % 2 ? 'short' : 'long'}'`);
      commitAll(repo, { author: 'Old Timer', date: daysAgo(390 - i), message: `Tweak dates ${i}` });
    }
    editFile(repo, 'src/utils/format.ts', "day: 'numeric'", "day: '2-digit'");
    commitAll(repo, { author: 'New Person', date: daysAgo(5), message: 'Two-digit days' });
    const data = await analyze({ root: repo, includeSource: false, history: false, changes: false, persist: false });
    const who = whoOf(data, { type: 'file', id: 'src/utils/format.ts' });
    expect(who.hasHistory).toBe(true);
    expect(who.experts.map((e) => e.name)).toEqual(['New Person', 'Old Timer']);
    const [fresh, old] = who.experts;
    expect(old.commits).toBe(4);
    expect(fresh.commits).toBe(1);
    expect(fresh.score).toBeGreaterThan(old.score); // 1 commit 5 days ago beats 4 commits over a year ago
    expect(old).toMatchObject({ inactive: true, email: emailOf('Old Timer') });
    expect(fresh.inactive).toBe(false);
    expect(fresh.share + old.share).toBeCloseTo(1, 1);
    expect(who.busFactor).toBe(1);
    expect(who.lastCommit).toMatchObject({ author: 'New Person', subject: 'Two-digit days', file: 'src/utils/format.ts' });
    // A folder aggregates its files; a symbol stands for its file.
    const dir = whoOf(data, { type: 'dir', id: 'src/utils' }, { limit: 1 });
    expect(dir.files).toBeGreaterThan(1);
    expect(dir.experts).toHaveLength(1);
    expect(whoOf(data, { type: 'symbol', id: FORMAT_DATE }).experts.map((e) => e.name)).toEqual(['New Person', 'Old Timer']);
    // Recency is relative to "now".
    const later = whoOf(data, { type: 'file', id: 'src/utils/format.ts' }, { now: Date.now() + 200 * DAY });
    expect(later.experts.every((e) => e.inactive)).toBe(true);
  });

  it('counts a commit that touches several files of a folder once, and a 50/50 split as two people', async () => {
    const repo = initRepo('fullstack-next');
    commitAll(repo, { author: 'Alice', date: daysAgo(200), message: 'Initial import' });
    editFile(repo, 'lib/db.ts', 'Hard cap for list endpoints.', 'Hard cap for list responses.');
    commitAll(repo, { author: 'Bob', date: daysAgo(3), message: 'Wording' });
    const data = await analyze({ root: repo, includeSource: false, history: false, changes: false, persist: false });
    const lib = whoOf(data, { type: 'dir', id: 'lib' });
    expect(lib.files).toBeGreaterThan(1);
    const alice = lib.experts.find((e) => e.name === 'Alice')!;
    const bob = lib.experts.find((e) => e.name === 'Bob')!;
    expect(alice.commits).toBe(1); // one commit, not one per file
    expect(bob.commits).toBe(1);
    expect(lib.experts[0].name).toBe('Bob'); // recent work weighs more
    expect(alice.inactive).toBe(true);
    // Two authors with one commit each on the same day: neither "made most of the changes".
    const tie = initRepo('react-vite-ts');
    commitAll(tie, { author: 'Ann', date: daysAgo(2), message: 'Initial import' });
    editFile(tie, 'src/utils/format.ts', "day: 'numeric'", "day: '2-digit'");
    commitAll(tie, { author: 'Ben', date: daysAgo(2) + 60_000, message: 'Days' });
    const tieData = await analyze({ root: tie, includeSource: false, history: false, changes: false, persist: false });
    expect(whoOf(tieData, { type: 'file', id: 'src/utils/format.ts' }).busFactor).toBe(2);
  });

  it('reads CODEOWNERS and answers without history', () => {
    const who = whoOf(fullstack, { type: 'file', id: 'lib/billing.ts' });
    expect(who).toMatchObject({ owners: ['@acme/payments', 'billing-lead@acme.dev'], experts: [], hasHistory: false, busFactor: undefined });
    expect(whoOf(fullstack, { type: 'dir', id: 'app' }).owners[0]).toBe('@acme/web');
  });
});

describe('public API', () => {
  it('exports the query core as `query`', async () => {
    const api = await import('../src/index.js');
    for (const fn of ['resolveTarget', 'impactOf', 'usesOf', 'whoOf', 'routeFor', 'testsFor', 'importPath', 'transitive', 'callersOf', 'calleesOf'] as const) expect(typeof api.query[fn]).toBe('function');
    expect(api.query.impactOf(react, { type: 'symbol', id: FORMAT_DATE }).direct[0].file).toBe('src/components/UserCard.tsx');
    expect(typeof api.buildTestCommand).toBe('function');
  });
});
