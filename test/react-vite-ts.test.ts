import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportData } from '../src/shared/types.js';
import {
  analyzeFixture,
  expectEdge,
  expectRoute,
  expectSymbolEdge,
  getFile,
  getSymbol,
  routeSignatures,
} from './helpers.js';

let data: ReportData;
beforeAll(async () => {
  data = await analyzeFixture('react-vite-ts');
});

describe('react-vite-ts: project', () => {
  it('detects the stack from package.json', () => {
    const ids = data.project.frameworks.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['react', 'react-router', 'zustand', 'styled-components', 'vite', 'vitest', 'storybook', 'typescript']));
    expect(ids).not.toContain('next');
    expect(data.project.frameworks.find((f) => f.id === 'react')!.version).toBe('18.3.1');
    expect(data.project.name).toBe('react-vite-ts');
    expect(data.project.typescript).toBe(true);
  });

  it('analyzes every source file without warnings or unresolved imports', () => {
    expect(data.warnings).toEqual([]);
    expect(data.files.length).toBe(28);
    expect(data.files.filter((f) => f.unresolved.length).map((f) => [f.id, f.unresolved])).toEqual([]);
    expect(data.files.filter((f) => f.parseError)).toEqual([]);
  });

  it('marks src/main.tsx (referenced by index.html) as the only entry', () => {
    expect(data.files.filter((f) => f.isEntry).map((f) => f.id)).toEqual(['src/main.tsx']);
    expect(getFile(data, 'src/main.tsx').kind).toBe('entry');
  });

  it('classifies file kinds', () => {
    const kinds = Object.fromEntries(data.files.map((f) => [f.id, f.kind]));
    expect(kinds).toMatchObject({
      'src/components/Button.tsx': 'component',
      'src/components/Card.tsx': 'component',
      'src/components/UserCard.tsx': 'component',
      'src/hooks/useUsers.ts': 'hook',
      'src/hooks/useDebounce.ts': 'hook',
      'src/context/ThemeContext.tsx': 'context',
      'src/store/useCartStore.ts': 'store',
      'src/api/client.ts': 'api',
      'src/utils/format.ts': 'util',
      'src/utils/math.ts': 'util',
      'src/types.ts': 'types',
      'src/router.tsx': 'router',
      'src/components/Button.test.tsx': 'test',
      'src/components/Button.stories.tsx': 'story',
      'vite.config.ts': 'config',
      'src/vite-env.d.ts': 'types',
    });
    expect(getFile(data, 'src/components/Button.test.tsx').isTest).toBe(true);
    expect(data.stats.testFiles).toBe(1);
  });

  it('records the CSS side-effect import as an asset', () => {
    expect(getFile(data, 'src/main.tsx').assets).toEqual([expect.objectContaining({ specifier: './index.css', path: 'src/index.css' })]);
  });
});

describe('react-vite-ts: module graph', () => {
  it('resolves the tsconfig "@/*" alias', () => {
    const e = expectEdge(data, 'src/components/UserCard.tsx', 'src/utils/format.ts', 'import');
    expect(e.specifier).toBe('@/utils/format');
    expect(e.names).toEqual(['formatDate']);
    expectEdge(data, 'src/main.tsx', 'src/context/ThemeContext.tsx');
    expectEdge(data, 'src/hooks/useUsers.ts', 'src/api/client.ts');
  });

  it('resolves the "@/components" barrel and its re-exports', () => {
    const e = expectEdge(data, 'src/pages/Home.tsx', 'src/components/index.ts', 'import');
    expect(e.names.sort()).toEqual(['Spinner', 'UserCard']);
    expect(expectEdge(data, 'src/components/index.ts', 'src/components/Spinner.tsx', 'reexport').names).toEqual(['default']);
    expect(expectEdge(data, 'src/components/index.ts', 'src/components/Card.tsx', 'reexport').names).toEqual(['*']);
    expectEdge(data, 'src/components/index.ts', 'src/components/Button.tsx', 'reexport');
  });

  it('marks type-only imports', () => {
    expect(expectEdge(data, 'src/api/client.ts', 'src/types.ts').typeOnly).toBe(true);
    expect(expectEdge(data, 'src/hooks/useUsers.ts', 'src/api/client.ts').typeOnly).toBe(false);
  });

  it('records lazy import() calls as dynamic edges', () => {
    expectEdge(data, 'src/App.tsx', 'src/pages/Settings.tsx', 'dynamic');
    expectEdge(data, 'src/router.tsx', 'src/pages/admin/Reports.tsx', 'dynamic');
  });

  it('tracks external packages and builtins', () => {
    const pkg = (name: string) => data.packages.find((p) => p.name === name);
    expect(pkg('react')!.declaredAs).toBe('dependencies');
    expect(pkg('react-router-dom')!.importedBy).toEqual(expect.arrayContaining(['src/App.tsx', 'src/router.tsx', 'src/pages/Home.tsx']));
    expect(pkg('zustand')!.importedBy).toEqual(['src/store/useCartStore.ts']);
    expect(pkg('@testing-library/react')!.declaredAs).toBe('devDependencies');
    expect(pkg('path')).toMatchObject({ builtin: true, importedBy: ['vite.config.ts'] });
  });

  it('has fan-in / fan-out metrics', () => {
    const button = getFile(data, 'src/components/Button.tsx');
    expect(button.metrics.fanIn).toBeGreaterThanOrEqual(4);
    expect(getFile(data, 'src/main.tsx').metrics.fanIn).toBe(0);
    expect(getFile(data, 'src/types.ts').metrics.importance).toBeGreaterThan(getFile(data, 'src/main.tsx').metrics.importance);
  });
});

describe('react-vite-ts: components and hooks', () => {
  it('reads forwardRef<HTMLButtonElement, ButtonProps> components', () => {
    const button = getSymbol(data, 'src/components/Button.tsx#Button');
    expect(button.kind).toBe('component');
    expect(button.tags).toContain('forwardRef');
    expect(button.component!.props).toEqual(expect.arrayContaining(['variant', 'size', 'loading', 'className', 'children']));
  });

  it('reads memo() components', () => {
    const avatar = getSymbol(data, 'src/components/Avatar.tsx#Avatar');
    expect(avatar).toMatchObject({ kind: 'component', tags: ['memo'] });
    expect(avatar.component!.props).toEqual(['name', 'src', 'size']);
  });

  it('reads arrow-function and function-declaration components with their props', () => {
    expect(getSymbol(data, 'src/components/UserCard.tsx#UserCard').component!.props).toEqual(['user', 'joinedAt', 'onSelect']);
    expect(getSymbol(data, 'src/components/Card.tsx#Card').component!.props).toEqual(['title', 'footer', 'children']);
    expect(getSymbol(data, 'src/components/Spinner.tsx#Spinner')).toMatchObject({ kind: 'component', isDefault: true });
  });

  it('detects styled-components', () => {
    expect(getSymbol(data, 'src/components/Card.tsx#Wrapper')).toMatchObject({ kind: 'component', tags: ['styled'] });
  });

  it('records hooks used by components and classifies custom hooks', () => {
    expect(getSymbol(data, 'src/pages/Home.tsx#Home').component!.hooks).toEqual(expect.arrayContaining(['useUsers', 'useNavigate']));
    expect(getSymbol(data, 'src/components/Layout.tsx#Nav').component!.hooks).toEqual(['useCartStore']);
    expect(getSymbol(data, 'src/hooks/useUsers.ts#useUsers').kind).toBe('hook');
    expect(getSymbol(data, 'src/hooks/useDebounce.ts#useDebounce').kind).toBe('hook');
    expect(getSymbol(data, 'src/context/ThemeContext.tsx#useTheme').kind).toBe('hook');
  });

  it('tags the React context and the zustand store', () => {
    expect(getSymbol(data, 'src/context/ThemeContext.tsx#ThemeContext').tags).toEqual(['context']);
    expect(getSymbol(data, 'src/store/useCartStore.ts#useCartStore').tags).toEqual(['store']);
    expect(getSymbol(data, 'src/context/ThemeContext.tsx#ThemeProvider').component!.contexts).toEqual(['ThemeContext']);
    expect(getSymbol(data, 'src/components/ThemeToggle.tsx#ThemeToggle').component!.contexts).toEqual(['ThemeContext']);
  });

  it('counts components and hooks in stats', () => {
    expect(data.stats.components).toBeGreaterThanOrEqual(14);
    expect(data.stats.hooks).toBe(3);
  });
});

describe('react-vite-ts: symbol edges', () => {
  it('links renders across files, through the barrel and default-as-named re-exports', () => {
    expectSymbolEdge(data, 'renders', 'src/pages/Home.tsx#Home', 'src/components/UserCard.tsx#UserCard');
    expectSymbolEdge(data, 'renders', 'src/pages/Home.tsx#Home', 'src/components/Spinner.tsx#Spinner');
    expectSymbolEdge(data, 'renders', 'src/pages/Settings.tsx#Settings', 'src/components/Card.tsx#Card'); // export *
    expectSymbolEdge(data, 'renders', 'src/components/UserCard.tsx#UserCard', 'src/components/Button.tsx#Button');
    expectSymbolEdge(data, 'renders', 'src/components/Card.tsx#Card', 'src/components/Card.tsx#Wrapper');
    expectSymbolEdge(data, 'renders', 'src/components/Layout.tsx#Layout', 'src/components/Layout.tsx#Nav');
    expectSymbolEdge(data, 'renders', 'src/App.tsx#App', 'src/components/Layout.tsx#Layout');
  });

  it('links calls to hooks, stores and utilities', () => {
    expectSymbolEdge(data, 'calls', 'src/pages/Home.tsx#Home', 'src/hooks/useUsers.ts#useUsers');
    expectSymbolEdge(data, 'calls', 'src/hooks/useUsers.ts#useUsers', 'src/api/client.ts#fetchUsers');
    expectSymbolEdge(data, 'calls', 'src/components/Layout.tsx#Nav', 'src/store/useCartStore.ts#useCartStore');
    expectSymbolEdge(data, 'calls', 'src/components/Layout.tsx#Layout', 'src/context/ThemeContext.tsx#useTheme');
    expectSymbolEdge(data, 'calls', 'src/api/client.ts#fetchUser', 'src/api/client.ts#request');
    expectSymbolEdge(data, 'calls', 'src/utils/math.ts#percent', 'src/utils/format.ts#formatNumber');
  });

  it('links context consumers and providers with `uses`', () => {
    expectSymbolEdge(data, 'uses', 'src/components/ThemeToggle.tsx#ThemeToggle', 'src/context/ThemeContext.tsx#ThemeContext');
    expectSymbolEdge(data, 'uses', 'src/context/ThemeContext.tsx#ThemeProvider', 'src/context/ThemeContext.tsx#ThemeContext');
    expectSymbolEdge(data, 'uses', 'src/components/UserCard.tsx#UserCardProps', 'src/types.ts#User');
  });
});

describe('react-vite-ts: routes', () => {
  it('extracts JSX <Routes> and createBrowserRouter routes with nested paths', () => {
    const sigs = routeSignatures(data);
    expect(sigs).toEqual(
      expect.arrayContaining(['PAGE /', 'PAGE /settings', 'PAGE /users/:userId', 'PAGE /admin', 'PAGE /admin/reports', 'PAGE /admin/users/:id']),
    );
    expect(data.routes.every((r) => r.framework === 'react-router' && r.type === 'page')).toBe(true);
    expect(data.routes.filter((r) => r.path === '/' && r.file === 'src/App.tsx').map((r) => r.handler).sort()).toEqual(['Home', 'Layout']);
  });

  it('links route elements to their page components', () => {
    expectRoute(data, 'PAGE', '/users/:userId', { file: 'src/App.tsx', handlerSymbol: 'src/pages/UserProfile.tsx#UserProfile', params: ['userId'] });
    expectRoute(data, 'PAGE', '/admin/users/:id', { file: 'src/router.tsx', handlerSymbol: 'src/pages/UserProfile.tsx#UserProfile' });
    expectRoute(data, 'PAGE', '/admin', { handlerSymbol: 'src/components/Layout.tsx#Layout' });
  });

  it('links a React.lazy() route element to the lazily imported page component', () => {
    // const Settings = lazy(() => import('./pages/Settings')); <Route path="settings" element={<Settings />} />
    expectRoute(data, 'PAGE', '/settings', { file: 'src/App.tsx', handlerSymbol: 'src/pages/Settings.tsx#Settings' });
  });

  it('links a react-router `lazy: () => import()` route to the route module `Component` export', () => {
    expectRoute(data, 'PAGE', '/admin/reports', { file: 'src/router.tsx', handlerSymbol: 'src/pages/admin/Reports.tsx#Component' });
  });
});

describe('react-vite-ts: insights', () => {
  it('finds the circular import between the util modules', () => {
    expect(data.insights.cycles.map((c) => [...c].sort())).toEqual([['src/utils/format.ts', 'src/utils/math.ts']]);
    expect(getFile(data, 'src/utils/format.ts').inCycle).toBe(true);
    expect(getFile(data, 'src/utils/math.ts').inCycle).toBe(true);
    expect(expectEdge(data, 'src/utils/format.ts', 'src/utils/math.ts').inCycle).toBe(true);
    expect(getFile(data, 'src/pages/Home.tsx').inCycle).toBeUndefined();
  });

  it('reports only the never-imported module as orphan', () => {
    expect(data.insights.orphans).toEqual(['src/utils/legacyStorage.ts']);
  });

  it('reports unused exports and keeps used / framework-consumed ones out', () => {
    const unused = data.insights.unusedExports.map((u) => `${u.file}#${u.name}`);
    expect(unused).toEqual(expect.arrayContaining(['src/utils/format.ts#slugify', 'src/utils/legacyStorage.ts#loadLegacySettings']));
    for (const used of [
      'src/utils/format.ts#formatDate',
      'src/utils/format.ts#formatCurrency',
      'src/utils/format.ts#formatNumber',
      'src/utils/math.ts#percent',
      'src/utils/math.ts#round',
      'src/components/Button.tsx#Button',
      'src/components/Card.tsx#Card',
      'src/components/Spinner.tsx#default',
      'src/components/Avatar.tsx#Avatar',
      'src/context/ThemeContext.tsx#useTheme',
      'src/context/ThemeContext.tsx#ThemeProvider',
      'src/store/useCartStore.ts#useCartStore',
      'src/api/client.ts#fetchUser',
      'src/pages/admin/Reports.tsx#Component',
      'src/pages/Settings.tsx#default',
      'src/components/Button.stories.tsx#Primary',
      'vite.config.ts#default',
    ]) {
      expect(unused, used).not.toContain(used);
    }
    expect(getFile(data, 'src/utils/format.ts').exports.find((e) => e.name === 'slugify')!.unused).toBe(true);
    expect(getFile(data, 'src/utils/format.ts').exports.find((e) => e.name === 'formatDate')!.unused).toBeUndefined();
  });

  it('reports no unused or missing dependencies', () => {
    expect(data.insights.unusedDependencies).toEqual([]);
    expect(data.insights.missingDependencies).toEqual([]);
  });

  it('collects TODO / FIXME comments', () => {
    const todos = data.files.flatMap((f) => f.todos.map((t) => `${f.id}:${t.line}:${t.tag}`));
    expect(todos.sort()).toEqual(['src/hooks/useDebounce.ts:6:FIXME', 'src/pages/Settings.tsx:14:TODO', 'src/utils/legacyStorage.ts:1:TODO']);
    expect(getFile(data, 'src/pages/Settings.tsx').todos[0].text).toBe('persist the display name to the server');
    expect(data.stats.todos).toBe(3);
  });

  it('builds folder summaries and an onboarding tour', () => {
    expect(data.folders.find((f) => f.path === 'src/components')!.kinds.component).toBe(7);
    expect(data.tour[0].id).toBe('welcome');
  });
});
