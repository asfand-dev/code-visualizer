import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportData } from '../src/shared/types.js';
import { analyzeFixture, defaultComponent, expectEdge, expectRoute, expectSymbolEdge, getFile, getSymbol } from './helpers.js';

let data: ReportData;
beforeAll(async () => {
  data = await analyzeFixture('vue-app');
});

describe('vue-app: project', () => {
  it('detects Vue, vue-router and Pinia', () => {
    expect(data.project.frameworks.map((f) => f.id)).toEqual(expect.arrayContaining(['vue', 'vue-router', 'pinia', 'vite', 'typescript']));
  });

  it('parses all files without warnings or unresolved imports', () => {
    expect(data.warnings).toEqual([]);
    expect(data.files).toHaveLength(17);
    expect(data.files.filter((f) => f.unresolved.length).map((f) => [f.id, f.unresolved])).toEqual([]);
    expect(data.project.languages.find((l) => l.language === 'vue')!.files).toBe(9);
  });

  it('marks main.ts and the root App.vue as entries', () => {
    expect(getFile(data, 'src/main.ts')).toMatchObject({ isEntry: true });
    expect(getFile(data, 'src/App.vue')).toMatchObject({ isEntry: true, entryReason: 'root component' });
  });

  it('classifies file kinds', () => {
    const kinds = Object.fromEntries(data.files.map((f) => [f.id, f.kind]));
    expect(kinds).toMatchObject({
      'src/router/index.ts': 'router',
      'src/stores/counter.ts': 'store',
      'src/stores/todos.ts': 'store',
      'src/composables/useCounter.ts': 'composable',
      'src/components/TodoItem.vue': 'component',
      'src/views/HomeView.vue': 'component',
      'src/types.ts': 'types',
      'vite.config.ts': 'config',
    });
  });

  it('classifies src/main.ts (createApp(App).use(router)) as the entry, not a router', () => {
    expect(getFile(data, 'src/main.ts').kind).toBe('entry');
  });
});

describe('vue-app: single-file components', () => {
  it('reads <script setup> defineProps<{…}>() and call-signature defineEmits', () => {
    const item = defaultComponent(data, 'src/components/TodoItem.vue');
    expect(item.id).toBe('src/components/TodoItem.vue#TodoItem');
    expect(item.component).toMatchObject({ framework: 'vue', props: ['todo', 'editable'], emits: ['toggle', 'remove'] });
  });

  it('reads withDefaults(defineProps) and named-tuple defineEmits', () => {
    expect(defaultComponent(data, 'src/components/AppHeader.vue').component).toMatchObject({ props: ['title', 'subtitle'], emits: ['menu'] });
  });

  it('reads Options API props / emits / components and kebab-case template tags', () => {
    const list = getSymbol(data, 'src/components/TodoList.vue#TodoList');
    expect(list).toMatchObject({ kind: 'component', isDefault: true });
    expect(list.component).toMatchObject({ props: ['items', 'filter'], emits: ['toggle', 'remove'] });
    expect(list.component!.renders).toEqual(['TodoItem']);
  });

  it('records composables / stores used by components', () => {
    expect(defaultComponent(data, 'src/views/HomeView.vue').component!.hooks).toEqual(['useCounter']);
    expect(defaultComponent(data, 'src/views/TodoListView.vue').component!.hooks).toEqual(['useTodoStore']);
    expect(defaultComponent(data, 'src/views/TodoDetailView.vue').component!.props).toEqual(['id']);
  });

  it('tags Pinia stores and classifies the composable as a hook symbol', () => {
    expect(getSymbol(data, 'src/stores/counter.ts#useCounterStore').tags).toEqual(['store']);
    expect(getSymbol(data, 'src/stores/todos.ts#useTodoStore').tags).toEqual(['store']);
    expect(getSymbol(data, 'src/composables/useCounter.ts#useCounter').kind).toBe('hook');
  });

  it('only exposes the default component as a module export of an SFC', () => {
    expect(getFile(data, 'src/components/TodoItem.vue').exports.map((e) => e.name)).toEqual(['default']);
    expect(getFile(data, 'src/views/TodoListView.vue').exports.map((e) => e.name)).toEqual(['default']);
  });
});

describe('vue-app: graph and symbol edges', () => {
  it('resolves the "@/*" alias and relative .vue imports', () => {
    expect(expectEdge(data, 'src/App.vue', 'src/components/AppHeader.vue').specifier).toBe('@/components/AppHeader.vue');
    expectEdge(data, 'src/views/HomeView.vue', 'src/composables/useCounter.ts');
    expectEdge(data, 'src/components/TodoList.vue', 'src/components/TodoItem.vue');
    expectEdge(data, 'src/main.ts', 'src/router/index.ts');
  });

  it('records lazy route components as dynamic edges', () => {
    expectEdge(data, 'src/router/index.ts', 'src/views/AboutView.vue', 'dynamic');
    expectEdge(data, 'src/router/index.ts', 'src/views/TodoDetailView.vue', 'dynamic');
    expectEdge(data, 'src/router/index.ts', 'src/views/HomeView.vue', 'import');
  });

  it('links SFC renders (PascalCase and kebab-case) and composable / store calls', () => {
    expectSymbolEdge(data, 'renders', 'src/App.vue#App', 'src/components/AppHeader.vue#AppHeader');
    expectSymbolEdge(data, 'renders', 'src/components/TodoList.vue#TodoList', 'src/components/TodoItem.vue#TodoItem');
    expectSymbolEdge(data, 'renders', 'src/views/TodoListView.vue#TodoListView', 'src/components/TodoList.vue#TodoList');
    expectSymbolEdge(data, 'renders', 'src/views/TodoDetailView.vue#TodoDetailView', 'src/components/TodoItem.vue#TodoItem');
    expectSymbolEdge(data, 'calls', 'src/views/HomeView.vue#HomeView', 'src/composables/useCounter.ts#useCounter');
    expectSymbolEdge(data, 'calls', 'src/views/TodoListView.vue#TodoListView', 'src/stores/todos.ts#useTodoStore');
    expectSymbolEdge(data, 'calls', 'src/App.vue#App', 'src/stores/counter.ts#useCounterStore');
  });
});

describe('vue-app: routes', () => {
  it('extracts vue-router routes including nested children', () => {
    expectRoute(data, 'PAGE', '/', { file: 'src/router/index.ts', framework: 'vue-router', handlerSymbol: 'src/views/HomeView.vue#HomeView' });
    expectRoute(data, 'PAGE', '/about', { handlerSymbol: 'src/views/AboutView.vue#AboutView' });
    expectRoute(data, 'PAGE', '/todos', { handlerSymbol: 'src/views/TodosLayout.vue#TodosLayout' });
    expectRoute(data, 'PAGE', '/todos', { handlerSymbol: 'src/views/TodoListView.vue#TodoListView' });
    expectRoute(data, 'PAGE', '/todos/:id', { handlerSymbol: 'src/views/TodoDetailView.vue#TodoDetailView', params: ['id'] });
    expectRoute(data, 'REDIRECT', '/:pathMatch(.*)*', { file: 'src/router/index.ts' });
  });

  it('reports only vue-router routes (app.use(router) is not an HTTP middleware)', () => {
    const others = data.routes.filter((r) => r.framework !== 'vue-router').map((r) => `${r.framework} ${r.method} ${r.path} (${r.file})`);
    expect(others).toEqual([]);
    expect(data.routes).toHaveLength(6);
  });
});

describe('vue-app: insights', () => {
  it('has no orphans, cycles, unused exports or dependency problems', () => {
    expect(data.insights.orphans).toEqual([]);
    expect(data.insights.cycles).toEqual([]);
    expect(data.insights.unusedExports).toEqual([]);
    expect(data.insights.unusedDependencies).toEqual([]);
    expect(data.insights.missingDependencies).toEqual([]);
  });

  it('collects the TODO inside a <script setup> block with the .vue line number', () => {
    expect(getFile(data, 'src/views/TodoDetailView.vue').todos).toEqual([{ line: 8, tag: 'TODO', text: 'show a 404 state instead of an empty page' }]);
  });
});
