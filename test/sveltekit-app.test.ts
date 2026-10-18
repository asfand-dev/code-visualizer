import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportData } from '../src/shared/types.js';
import { analyzeFixture, defaultComponent, expectEdge, expectRoute, expectSymbolEdge, getFile, routeSignatures } from './helpers.js';

let data: ReportData;
beforeAll(async () => {
  data = await analyzeFixture('sveltekit-app');
});

describe('sveltekit-app: project', () => {
  it('detects SvelteKit from devDependencies', () => {
    expect(data.project.frameworks.map((f) => f.id)).toEqual(expect.arrayContaining(['sveltekit', 'svelte', 'vite', 'typescript']));
  });

  it('parses all files without warnings', () => {
    expect(data.warnings).toEqual([]);
    expect(data.files).toHaveLength(15);
  });

  it('treats SvelteKit generated `./$types` imports as virtual, not unresolved', () => {
    expect(data.files.filter((f) => f.unresolved.length).map((f) => [f.id, f.unresolved.map((u) => u.specifier)])).toEqual([]);
  });

  it('marks hooks.server.ts as entry', () => {
    expect(getFile(data, 'src/hooks.server.ts')).toMatchObject({ isEntry: true, entryReason: 'SvelteKit hooks' });
  });

  it('classifies route files and components', () => {
    const kinds = Object.fromEntries(data.files.map((f) => [f.id, f.kind]));
    expect(kinds).toMatchObject({
      'src/routes/+page.svelte': 'page',
      'src/routes/blog/[slug]/+page.svelte': 'page',
      'src/routes/+layout.svelte': 'layout',
      'src/routes/api/items/+server.ts': 'route',
      'src/lib/components/Header.svelte': 'component',
      'src/lib/components/PostCard.svelte': 'component',
      'svelte.config.js': 'config',
      'vite.config.ts': 'config',
    });
  });

  it('classifies the ambient declaration file src/app.d.ts as types (not config)', () => {
    expect(getFile(data, 'src/app.d.ts').kind).toBe('types');
  });

  it('classifies a module that only exports interfaces (src/lib/types.ts) as types', () => {
    expect(getFile(data, 'src/lib/types.ts').kind).toBe('types');
  });
});

describe('sveltekit-app: routes', () => {
  it('derives routes from src/routes', () => {
    expect(routeSignatures(data).sort()).toEqual(['GET /api/items', 'LAYOUT /', 'PAGE /', 'PAGE /blog/[slug]', 'POST /api/items']);
    expect(data.routes.every((r) => r.framework === 'sveltekit')).toBe(true);
  });

  it('links pages / layouts to their component and endpoints to their handlers', () => {
    expectRoute(data, 'PAGE', '/blog/[slug]', { file: 'src/routes/blog/[slug]/+page.svelte', params: ['slug'], handlerSymbol: defaultComponent(data, 'src/routes/blog/[slug]/+page.svelte').id });
    expectRoute(data, 'LAYOUT', '/', { file: 'src/routes/+layout.svelte', type: 'layout' });
    expectRoute(data, 'GET', '/api/items', { type: 'api', handlerSymbol: 'src/routes/api/items/+server.ts#GET' });
    expectRoute(data, 'POST', '/api/items', { type: 'api', handlerSymbol: 'src/routes/api/items/+server.ts#POST' });
  });
});

describe('sveltekit-app: components', () => {
  it('reads Svelte 4 `export let` props without turning them into module exports', () => {
    expect(defaultComponent(data, 'src/lib/components/Header.svelte').component).toMatchObject({ framework: 'svelte', props: ['title', 'subtitle'] });
    expect(getFile(data, 'src/lib/components/Header.svelte').exports.map((e) => e.name)).toEqual(['default']);
  });

  it('reads Svelte 5 $props() destructuring', () => {
    expect(defaultComponent(data, 'src/lib/components/PostCard.svelte').component!.props).toEqual(['post', 'compact']);
    expect(defaultComponent(data, 'src/routes/+layout.svelte').component!.props).toEqual(['children']);
  });

  it('resolves $lib imports and links renders', () => {
    expect(expectEdge(data, 'src/routes/+page.svelte', 'src/lib/components/PostCard.svelte').specifier).toBe('$lib/components/PostCard.svelte');
    expectEdge(data, 'src/routes/+layout.svelte', 'src/lib/components/Header.svelte');
    expectEdge(data, 'src/routes/blog/[slug]/+page.server.ts', 'src/lib/server/posts.ts');
    expectEdge(data, 'src/lib/server/posts.ts', 'src/lib/types.ts');
    expectSymbolEdge(data, 'renders', defaultComponent(data, 'src/routes/+page.svelte').id, 'src/lib/components/PostCard.svelte#PostCard');
    expectSymbolEdge(data, 'renders', defaultComponent(data, 'src/routes/+layout.svelte').id, 'src/lib/components/Header.svelte#Header');
    expectSymbolEdge(data, 'calls', 'src/routes/blog/[slug]/+page.server.ts#load', 'src/lib/server/posts.ts#getPost');
    expectSymbolEdge(data, 'calls', 'src/lib/components/PostCard.svelte#PostCard', 'src/lib/utils.ts#formatDate');
  });
});

describe('sveltekit-app: insights', () => {
  it('has no orphans, cycles, unused exports or dependency problems', () => {
    expect(data.insights.orphans).toEqual([]);
    expect(data.insights.cycles).toEqual([]);
    expect(data.insights.unusedExports).toEqual([]);
    expect(data.insights.unusedDependencies).toEqual([]);
    expect(data.insights.missingDependencies).toEqual([]);
  });
});
