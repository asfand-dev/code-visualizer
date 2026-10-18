import type { FileKind } from '../shared/types.js';
import type { ParsedFile } from './parse.js';
import type { FileRole } from './routes.js';

const TEST_DIR_RE = /(^|\/)(__tests__|__mocks__|__fixtures__|test|tests|spec|specs|e2e|cypress|playwright)\//;
const TEST_FILE_RE = /\.(test|spec|e2e|cy|bench)\.[cm]?[jt]sx?$/;
const STORY_RE = /\.(stories|story)\.(mdx|[cm]?[jt]sx?)$/;
const CONFIG_NAMES =
  /^(vite|vitest|webpack|rollup|babel|jest|eslint|prettier|tailwind|postcss|next|nuxt|svelte|astro|tsup|playwright|cypress|drizzle|commitlint|metro|quasar|vue|craco|karma|lint-staged|stylelint|uno|windi|electron-builder|electron\.vite|remix|react-router|wrangler|turbo|gatsby-(config|node|browser|ssr)|docusaurus|histoire|knip|release|semantic-release|svgo|esbuild|rspack|rsbuild|storybook|tsdown|unbuild|ladle|nodemon|pm2|ecosystem)([.-][\w-]+)?\.[cm]?[jt]s$/;

export function isTestFile(id: string): boolean {
  return TEST_DIR_RE.test(id) || TEST_FILE_RE.test(id);
}

/**
 * Tool configuration files (`vite.config.ts`, `jest.setup.js`, `.eslintrc.cjs`). A plain `config.ts`
 * is application code, not a tool config.
 */
export function isConfigFile(id: string): boolean {
  const base = id.split('/').pop() ?? id;
  return CONFIG_NAMES.test(base) || TOOL_CONFIG_VARIANT.test(base) || /^\.[\w-]+rc\.[cm]?[jt]s$/.test(base) || /^[\w.-]+\.config\.[cm]?[jt]s$/.test(base);
}

/** Per-environment variants of build / test tool configs: `webpack.config.prod.js`, `rollup.config.dev.mjs`. */
const TOOL_CONFIG_VARIANT =
  /^(webpack|rollup|vite|vitest|tsup|tsdown|esbuild|rspack|rsbuild|jest|babel|playwright|cypress|karma|electron\.vite|electron-builder|unbuild)\.config(\.[\w-]+)+\.[cm]?[jt]s$/;

/** A file defines a React-style context: it calls `createContext`. */
function createsContext(parsed: ParsedFile): boolean {
  for (const facts of parsed.facts.values()) {
    for (const callee of facts.calls.keys()) if (callee === 'createContext' || callee === 'React.createContext') return true;
  }
  return false;
}

function dirHas(id: string, re: RegExp): boolean {
  return re.test(`/${id}`);
}

export function classifyFile(id: string, parsed: ParsedFile, role: FileRole | undefined, isEntry: boolean): FileKind {
  const base = id.split('/').pop() ?? id;
  const ext = base.slice(base.lastIndexOf('.'));
  if (isTestFile(id)) return 'test';
  if (STORY_RE.test(base)) return 'story';
  if (role === 'page') return 'page';
  if (role === 'layout') return 'layout';
  if (role === 'route') return 'route';
  if (role === 'middleware') return 'middleware';
  if (id.endsWith('.d.ts')) return 'types';
  if (isConfigFile(id)) return 'config';

  const symbols = parsed.symbols;
  const tags = new Set(symbols.flatMap((s) => s.tags ?? []));
  const exported = symbols.filter((s) => s.exported);
  const main = exported.length ? exported : symbols;
  const countKind = (kind: string): number => main.filter((s) => s.kind === kind).length;
  const runtime = main.filter((s) => s.kind !== 'interface' && s.kind !== 'type');
  const serverRoutes = parsed.routes.filter((r) => r.type === 'api' || r.type === 'middleware');
  const clientRoutes = parsed.routes.filter((r) => r.type === 'page' || r.type === 'layout');

  // Only types exported and no runtime code of its own (a server exporting one type is not a type module).
  if (main.length > 0 && runtime.length === 0 && symbols.every((s) => s.kind === 'interface' || s.kind === 'type')) return 'types';
  // Context by name / folder only for UI code (`ThemeContext.tsx`), never for `commands/context.ts` or Nest providers.
  const ui = /\.[jt]sx$/.test(base) || parsed.usesJsx;
  if (tags.has('context') || createsContext(parsed) || (ui && (/context\.[jt]sx?$/i.test(base) || dirHas(id, /\/(contexts?|providers?)\//)))) return 'context';
  if (tags.has('store') || dirHas(id, /\/(store|stores|slices|redux|reducers|state|atoms|signals|pinia|vuex)\//) || /(store|slice|reducer)\.[jt]sx?$/i.test(base)) return 'store';
  if (tags.has('controller') || /\.controller\.[jt]s$/.test(base) || dirHas(id, /\/controllers?\//)) return 'controller';
  if (tags.has('resolver') || /\.resolver\.[jt]s$/.test(base)) return 'controller';
  if (tags.has('module') && /\.module\.[jt]s$/.test(base)) return 'module';
  if (tags.has('injectable') || /\.service\.[jt]s$/.test(base) || dirHas(id, /\/services?\//)) return 'service';
  if (/middlewares?\b/i.test(base) || dirHas(id, /\/middlewares?\//) || /\.guard\.[jt]s$/.test(base)) return 'middleware';
  if (tags.has('model') || /\.(model|entity|schema|dto)\.[jt]s$/.test(base) || dirHas(id, /\/(models?|entities|entity|schemas?|dto|dtos)\//)) return 'model';
  if (
    serverRoutes.length ||
    clientRoutes.length >= 2 ||
    /\.(routes?|router)\.[jt]sx?$/.test(base) ||
    (/^(routes?|router)\.[jt]sx?$/.test(base) && parsed.routes.length > 0) ||
    (dirHas(id, /\/(routes|routers?)\//) && !parsed.usesJsx && parsed.routes.length > 0)
  ) {
    return 'router';
  }
  if (/^use[A-Z-]/.test(base) || dirHas(id, /\/hooks\//) || (countKind('hook') > 0 && countKind('hook') >= countKind('component') && countKind('hook') >= runtime.length / 2)) {
    return dirHas(id, /\/composables\//) ? 'composable' : 'hook';
  }
  if (dirHas(id, /\/composables\//)) return 'composable';
  if (ext === '.vue' || ext === '.svelte' || ext === '.astro') return 'component';
  if (countKind('component') > 0 && countKind('component') >= runtime.length / 2) return 'component';
  if (dirHas(id, /\/(components?|ui|widgets|views|screens|containers)\//) && parsed.usesJsx) return 'component';
  const typeShare = main.length ? (main.length - runtime.length) / main.length : 0;
  if (main.length >= 3 && typeShare >= 0.8) return 'types';
  if (dirHas(id, /\/(api|apis|client|clients|http|requests|queries|graphql|gql|fetchers|endpoints)\//) || /(api|client)\.[jt]s$/i.test(base)) return 'api';
  if (/constants?\.[jt]s$/i.test(base) || dirHas(id, /\/constants?\//)) return 'constants';
  if (dirHas(id, /\/(utils?|utilities|helpers?|lib|libs|shared|common|core|tools)\//) || /(utils?|helpers?)\.[jt]s$/i.test(base)) return 'util';
  if (dirHas(id, /\/(scripts|bin)\//)) return 'script';
  if (dirHas(id, /\/(config|configs|configuration)\//)) return 'config';
  if (isEntry) return 'entry';
  if (countKind('component') > 0) return 'component';
  return 'module';
}
