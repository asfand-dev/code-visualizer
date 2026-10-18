import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportData } from '../src/shared/types.js';
import { analyzeFixture, expectEdge, expectRoute, expectSymbolEdge, getFile, getSymbol, routeSignatures } from './helpers.js';

let data: ReportData;
beforeAll(async () => {
  data = await analyzeFixture('next-app');
});

describe('next-app: project', () => {
  it('detects Next.js and friends', () => {
    const ids = data.project.frameworks.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['next', 'react', 'prisma', 'zod', 'typescript']));
    expect(data.project.frameworks.find((f) => f.id === 'next')).toMatchObject({ category: 'fullstack', version: '14.2.14' });
  });

  it('parses all files without warnings or unresolved imports', () => {
    expect(data.warnings).toEqual([]);
    expect(data.files).toHaveLength(16);
    expect(data.files.filter((f) => f.unresolved.length).map((f) => [f.id, f.unresolved])).toEqual([]);
  });

  it('marks the root layout as entry', () => {
    expect(getFile(data, 'app/layout.tsx')).toMatchObject({ isEntry: true, entryReason: 'root layout' });
  });

  it('classifies app-router and pages-router files', () => {
    const kinds = Object.fromEntries(data.files.map((f) => [f.id, f.kind]));
    expect(kinds).toMatchObject({
      'app/page.tsx': 'page',
      'app/dashboard/[id]/page.tsx': 'page',
      'app/(marketing)/about/page.tsx': 'page',
      'app/layout.tsx': 'layout',
      'app/api/users/route.ts': 'route',
      'pages/api/legacy.ts': 'route',
      'middleware.ts': 'middleware',
      'next.config.mjs': 'config',
      'components/VisitCounter.tsx': 'component',
      'components/UserList.tsx': 'component',
      'next-env.d.ts': 'types',
    });
  });

  it("records 'use client' and 'use server' directives and tags server actions", () => {
    expect(getFile(data, 'components/VisitCounter.tsx').directives).toEqual(['use client']);
    expect(getFile(data, 'app/actions.ts').directives).toEqual(['use server']);
    expect(getSymbol(data, 'app/actions.ts#createUser').tags).toContain('server-action');
    expect(getSymbol(data, 'app/actions.ts#incrementVisits').tags).toContain('server-action');
    expect(getFile(data, 'app/page.tsx').directives).toBeUndefined();
  });
});

describe('next-app: routes', () => {
  it('derives page paths from the app directory (dynamic segments, route groups removed)', () => {
    expectRoute(data, 'PAGE', '/', { file: 'app/page.tsx', framework: 'next-app', type: 'page', handlerSymbol: 'app/page.tsx#HomePage' });
    expectRoute(data, 'PAGE', '/dashboard/[id]', { file: 'app/dashboard/[id]/page.tsx', params: ['id'], handlerSymbol: 'app/dashboard/[id]/page.tsx#DashboardPage' });
    expectRoute(data, 'PAGE', '/about', { file: 'app/(marketing)/about/page.tsx', handlerSymbol: 'app/(marketing)/about/page.tsx#AboutPage' });
    expect(data.routes.some((r) => r.path.includes('(marketing)'))).toBe(false);
  });

  it('turns route.ts HTTP-method exports into API routes', () => {
    expectRoute(data, 'GET', '/api/users', { file: 'app/api/users/route.ts', type: 'api', framework: 'next-app', handlerSymbol: 'app/api/users/route.ts#GET' });
    expectRoute(data, 'POST', '/api/users', { file: 'app/api/users/route.ts', type: 'api', handlerSymbol: 'app/api/users/route.ts#POST' });
    // `export const dynamic` is route config, not an HTTP method
    expect(data.routes.filter((r) => r.file === 'app/api/users/route.ts').map((r) => r.method).sort()).toEqual(['GET', 'POST']);
  });

  it('includes pages-router API routes, the root layout and middleware', () => {
    expectRoute(data, 'ALL', '/api/legacy', { file: 'pages/api/legacy.ts', framework: 'next-pages', type: 'api', handlerSymbol: 'pages/api/legacy.ts#handler' });
    expectRoute(data, 'LAYOUT', '/', { file: 'app/layout.tsx', type: 'layout', handlerSymbol: 'app/layout.tsx#RootLayout' });
    expectRoute(data, 'MIDDLEWARE', '/', { file: 'middleware.ts', type: 'middleware' });
    expect(routeSignatures(data)).toHaveLength(8);
  });

  it('links the middleware route to the exported `middleware` function', () => {
    expectRoute(data, 'MIDDLEWARE', '/', { file: 'middleware.ts', handler: 'middleware', handlerSymbol: 'middleware.ts#middleware' });
  });
});

describe('next-app: graph and symbols', () => {
  it('resolves the "@/*" alias mapped to the project root', () => {
    expect(expectEdge(data, 'app/page.tsx', 'lib/users.ts').specifier).toBe('@/lib/users');
    expectEdge(data, 'components/VisitCounter.tsx', 'app/actions.ts');
    expectEdge(data, 'app/api/users/route.ts', 'lib/validation.ts');
    expectEdge(data, 'lib/users.ts', 'lib/db.ts');
    expect(expectEdge(data, 'components/UserList.tsx', 'lib/users.ts').typeOnly).toBe(true);
  });

  it('links pages, route handlers and client components to the functions they call / render', () => {
    expectSymbolEdge(data, 'renders', 'app/layout.tsx#RootLayout', 'components/SiteHeader.tsx#SiteHeader');
    expectSymbolEdge(data, 'renders', 'app/page.tsx#HomePage', 'components/UserList.tsx#UserList');
    expectSymbolEdge(data, 'renders', 'app/dashboard/[id]/page.tsx#DashboardPage', 'components/VisitCounter.tsx#VisitCounter');
    expectSymbolEdge(data, 'calls', 'app/page.tsx#HomePage', 'lib/users.ts#getUsers');
    expectSymbolEdge(data, 'calls', 'app/api/users/route.ts#GET', 'lib/users.ts#getUsers');
    expectSymbolEdge(data, 'calls', 'app/api/users/route.ts#POST', 'lib/users.ts#insertUser');
    expectSymbolEdge(data, 'calls', 'components/VisitCounter.tsx#VisitCounter', 'app/actions.ts#incrementVisits');
    expectSymbolEdge(data, 'calls', 'pages/api/legacy.ts#handler', 'lib/users.ts#getUsers');
  });

  it('reads component props of server and client components', () => {
    expect(getSymbol(data, 'components/VisitCounter.tsx#VisitCounter').component).toMatchObject({ props: ['userId', 'initial'], hooks: ['useState', 'useTransition'] });
    expect(getSymbol(data, 'app/dashboard/[id]/page.tsx#DashboardPage')).toMatchObject({ kind: 'component', async: true, isDefault: true });
    expect(getSymbol(data, 'app/layout.tsx#RootLayout').component!.props).toEqual(['children']);
  });
});

describe('next-app: insights', () => {
  it('treats framework-consumed files and exports as used', () => {
    expect(data.insights.orphans).toEqual([]);
    expect(data.insights.unusedExports).toEqual([]);
  });

  it('has no cycles and no dependency problems', () => {
    expect(data.insights.cycles).toEqual([]);
    expect(data.insights.unusedDependencies).toEqual([]);
    expect(data.insights.missingDependencies).toEqual([]);
  });
});
