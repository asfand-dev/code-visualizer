import type {
  DeclaredAs,
  DevDependencyInProduction,
  FileInfo,
  FileKind,
  FolderSummary,
  Insights,
  PackageInfo,
  ProjectInfo,
  ReportData,
  RouteInfo,
  SymbolEdge,
  TourStep,
} from '../shared/types.js';

/* -------------------------------------------------------------------------- */
/*                               Folder summaries                             */
/* -------------------------------------------------------------------------- */

const FOLDER_PURPOSES: [RegExp, string][] = [
  [/^(components?|ui|widgets)$/, 'Reusable UI components'],
  [/^hooks$/, 'Custom hooks that share stateful logic'],
  [/^composables$/, 'Vue composables that share reactive logic'],
  [/^(pages|views|screens)$/, 'Screens / route-level pages'],
  [/^app$/, 'Application shell and routes'],
  [/^(routes|routers?)$/, 'Route definitions'],
  [/^(api|apis)$/, 'API layer (endpoints or HTTP clients)'],
  [/^(services?)$/, 'Business logic and integrations with external services'],
  [/^(utils?|utilities|helpers?)$/, 'Small shared helper functions'],
  [/^(lib|libs)$/, 'Shared libraries and building blocks'],
  [/^(shared|common|core)$/, 'Code shared across the application'],
  [/^(store|stores|state|redux|slices|atoms)$/, 'Application state management'],
  [/^(contexts?|providers?)$/, 'Context providers that expose shared state'],
  [/^(types|typings|interfaces|@types)$/, 'Type definitions'],
  [/^(models?|entities|schemas?|dto|dtos)$/, 'Data models and schemas'],
  [/^(controllers?)$/, 'Request handlers (controllers)'],
  [/^(middlewares?|guards)$/, 'Request middleware'],
  [/^(config|configs|configuration|settings)$/, 'Configuration'],
  [/^(constants?)$/, 'Constants and static values'],
  [/^(styles?|css|theme|themes)$/, 'Styling and theming'],
  [/^(assets|static|public|images|icons)$/, 'Static assets'],
  [/^(tests?|__tests__|spec|e2e|cypress|playwright)$/, 'Automated tests'],
  [/^(mocks?|__mocks__|fixtures|__fixtures__)$/, 'Test mocks and fixtures'],
  [/^(scripts|bin|tools|tasks)$/, 'Build, CLI and maintenance scripts'],
  [/^(server|backend)$/, 'Server-side code'],
  [/^(client|frontend|web)$/, 'Client-side code'],
  [/^(features|modules|domains)$/, 'Feature modules grouped by domain'],
  [/^(layouts?)$/, 'Page layouts'],
  [/^(plugins?)$/, 'Plugins and extensions'],
  [/^(i18n|locales?|translations|lang)$/, 'Translations / internationalization'],
  [/^(docs?|documentation)$/, 'Documentation'],
  [/^(examples?|demo|demos|playground|sandbox)$/, 'Examples and demos'],
  [/^(packages)$/, 'Workspace packages'],
  [/^(apps)$/, 'Applications in this monorepo'],
  [/^(db|database|prisma|migrations|drizzle)$/, 'Database access and migrations'],
  [/^(jobs|workers|queues|cron)$/, 'Background jobs and workers'],
  [/^(graphql|gql|resolvers)$/, 'GraphQL schema and resolvers'],
  [/^(directives)$/, 'Directives'],
  [/^(src|source)$/, 'Application source code'],
];

const KIND_LABELS: Record<FileKind, [string, string]> = {
  entry: ['entry point', 'entry points'],
  page: ['page', 'pages'],
  layout: ['layout', 'layouts'],
  route: ['API route', 'API routes'],
  component: ['component', 'components'],
  hook: ['hook', 'hooks'],
  composable: ['composable', 'composables'],
  context: ['context', 'contexts'],
  store: ['store', 'stores'],
  service: ['service', 'services'],
  api: ['API module', 'API modules'],
  controller: ['controller', 'controllers'],
  middleware: ['middleware', 'middleware'],
  model: ['model', 'models'],
  router: ['router', 'routers'],
  util: ['utility module', 'utility modules'],
  constants: ['constants file', 'constants files'],
  types: ['type module', 'type modules'],
  config: ['config file', 'config files'],
  test: ['test', 'tests'],
  story: ['story', 'stories'],
  script: ['script', 'scripts'],
  module: ['module', 'modules'],
};

export function kindLabel(kind: FileKind, count: number): string {
  const [one, many] = KIND_LABELS[kind];
  return `${count} ${count === 1 ? one : many}`;
}

export function folderPurpose(folderPath: string): string | undefined {
  const name = folderPath.split('/').pop() ?? folderPath;
  for (const [re, text] of FOLDER_PURPOSES) if (re.test(name.toLowerCase())) return text;
  return undefined;
}

export function buildFolders(files: FileInfo[]): FolderSummary[] {
  const map = new Map<string, FolderSummary>();
  for (const file of files) {
    const parts = file.dir ? file.dir.split('/') : [];
    for (let i = 0; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      let folder = map.get(p);
      if (!folder) {
        folder = { path: p, files: 0, loc: 0, kinds: {}, description: '' };
        map.set(p, folder);
      }
      folder.files++;
      folder.loc += file.loc;
      folder.kinds[file.kind] = (folder.kinds[file.kind] ?? 0) + 1;
    }
  }
  for (const folder of map.values()) {
    const top = (Object.entries(folder.kinds) as [FileKind, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kind, n]) => kindLabel(kind, n));
    const purpose = folderPurpose(folder.path);
    folder.description = [purpose, top.join(', ')].filter(Boolean).join(' — ');
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/* -------------------------------------------------------------------------- */
/*                                Onboarding tour                             */
/* -------------------------------------------------------------------------- */

function list(items: string[], max = 5): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return shown.map((i) => `\`${i}\``).join(', ') + (rest > 0 ? ` and ${rest} more` : '');
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`;
}

function runCommand(pm: string | undefined, script: string): string {
  const manager = pm ?? 'npm';
  if (manager === 'npm') return script === 'start' || script === 'test' ? `npm ${script}` : `npm run ${script}`;
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  return `${manager} ${script}`;
}

function primaryStack(project: ProjectInfo): string {
  const order = ['fullstack', 'frontend', 'backend', 'mobile', 'desktop'];
  const main = project.frameworks
    .filter((f) => order.includes(f.category))
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
    .slice(0, 3)
    .map((f) => f.name);
  return main.length ? main.join(' + ') : project.typescript ? 'TypeScript' : 'JavaScript';
}

export function buildTour(data: Omit<ReportData, 'tour'>): TourStep[] {
  const steps: TourStep[] = [];
  const { project, stats, files, routes } = data;
  const byId = new Map(files.map((f) => [f.id, f]));
  const sourceFiles = files.filter((f) => f.kind !== 'test' && f.kind !== 'story' && f.scope !== 'context');
  const languages = [...project.languages].sort((a, b) => b.loc - a.loc);
  const mainLanguage = languages[0]?.language;

  steps.push({
    id: 'welcome',
    title: `Welcome to ${project.name}`,
    icon: 'sparkles',
    view: 'overview',
    body: [
      project.description ? `${project.description}\n\n` : '',
      `This is a **${primaryStack(project)}** codebase`,
      mainLanguage ? ` written mostly in **${mainLanguage === 'typescript' ? 'TypeScript' : mainLanguage === 'javascript' ? 'JavaScript' : mainLanguage}**` : '',
      `. It contains ${plural(stats.files, 'file')} with ${plural(stats.loc, 'line')} of code`,
      stats.components ? `, ${plural(stats.components, 'component')}` : '',
      stats.functions ? `, ${plural(stats.functions, 'function')}` : '',
      stats.classes ? ` and ${plural(stats.classes, 'class', 'classes')}` : '',
      '.',
    ].join(''),
  });

  const scripts = project.scripts ?? {};
  const important = ['dev', 'start', 'serve', 'build', 'test', 'lint', 'typecheck', 'storybook'].filter((s) => scripts[s]);
  if (important.length) {
    steps.push({
      id: 'run',
      title: 'Run it locally',
      icon: 'terminal',
      body: [
        `Install dependencies with \`${project.packageManager ?? 'npm'} install\`, then:`,
        ...important.map((s) => `- \`${runCommand(project.packageManager, s)}\` → \`${scripts[s]}\``),
      ].join('\n'),
    });
  }

  const entries = sourceFiles.filter((f) => f.isEntry).sort((a, b) => b.metrics.importance - a.metrics.importance);
  if (entries.length) {
    steps.push({
      id: 'entries',
      title: 'Where execution starts',
      icon: 'play',
      view: 'graph',
      files: entries.slice(0, 6).map((f) => f.id),
      body: `Start reading at the entry ${entries.length === 1 ? 'point' : 'points'}: ${entries
        .slice(0, 4)
        .map((f) => `\`${f.id}\`${f.entryReason ? ` (${f.entryReason})` : ''}`)
        .join(', ')}. Everything else is pulled in from there.`,
    });
  }

  const areas = data.folders
    .filter((f) => f.path && f.files >= 2 && f.path.split('/').length <= (data.folders.some((x) => x.path === 'src') ? 2 : 1))
    .filter((f) => f.path !== 'src')
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 7);
  if (areas.length) {
    steps.push({
      id: 'structure',
      title: 'How the code is organized',
      icon: 'folder-tree',
      view: 'structure',
      body: areas.map((a) => `- **${a.path}/** — ${a.description || plural(a.files, 'file')}`).join('\n'),
    });
  }

  if (routes.length) {
    const pages = routes.filter((r) => r.type === 'page');
    const apis = routes.filter((r) => r.type === 'api');
    const parts: string[] = [];
    if (pages.length) parts.push(plural(pages.length, 'page'));
    if (apis.length) parts.push(plural(apis.length, 'API endpoint'));
    const sample = [...apis, ...pages].slice(0, 5).map((r: RouteInfo) => `\`${r.method} ${r.path}\``);
    steps.push({
      id: 'routes',
      title: 'Routes & endpoints',
      icon: 'route',
      view: 'routes',
      files: [...new Set([...apis, ...pages].map((r) => r.file))].slice(0, 6),
      body: `The app exposes ${parts.join(' and ')}. For example ${sample.join(', ')}. Open the Routes view to see the full map with handlers.`,
    });
  }

  const core = sourceFiles
    .filter((f) => !f.isEntry && f.kind !== 'types' && f.kind !== 'config' && f.metrics.fanIn >= 2)
    .sort((a, b) => b.metrics.importance - a.metrics.importance || b.metrics.fanIn - a.metrics.fanIn)
    .slice(0, 6);
  if (core.length) {
    steps.push({
      id: 'core',
      title: 'The core building blocks',
      icon: 'boxes',
      view: 'graph',
      files: core.map((f) => f.id),
      body: `These modules are the most depended-upon parts of the codebase — understand them and the rest gets easier:\n${core
        .map((f) => `- \`${f.id}\` — used by ${plural(f.metrics.fanIn, 'file')}${f.description ? `. ${f.description}` : ''}`)
        .join('\n')}`,
    });
  }

  const renderCounts = new Map<string, number>();
  for (const e of data.symbolEdges) if (e.kind === 'renders') renderCounts.set(e.target, (renderCounts.get(e.target) ?? 0) + 1);
  const topComponents = [...renderCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (topComponents.length) {
    steps.push({
      id: 'components',
      title: 'Most reused UI components',
      icon: 'component',
      view: 'components',
      files: [...new Set(topComponents.map(([id]) => id.split('#')[0]))],
      body: topComponents
        .map(([id, n]) => `- **${id.split('#')[1]}** — rendered by ${plural(n, 'component')} (\`${id.split('#')[0]}\`)`)
        .join('\n'),
    });
  }

  const dataKinds: FileKind[] = ['store', 'context', 'service', 'api', 'model', 'controller'];
  const dataFiles = sourceFiles
    .filter((f) => dataKinds.includes(f.kind))
    .sort((a, b) => b.metrics.importance - a.metrics.importance)
    .slice(0, 6);
  if (dataFiles.length) {
    steps.push({
      id: 'data',
      title: 'State, data & services',
      icon: 'database',
      files: dataFiles.map((f) => f.id),
      body: `Data flows through these ${dataFiles.map((f) => f.kind).filter((k, i, a) => a.indexOf(k) === i).join(', ')} modules:\n${dataFiles
        .map((f) => `- \`${f.id}\` (${f.kind})`)
        .join('\n')}`,
    });
  }

  const typeFiles = sourceFiles
    .filter((f) => f.kind === 'types' || f.symbols.some((s) => s.kind === 'interface' || s.kind === 'class'))
    .sort((a, b) => b.metrics.fanIn - a.metrics.fanIn)
    .slice(0, 5);
  if (typeFiles.length && (stats.interfaces + stats.classes + stats.types) > 0) {
    steps.push({
      id: 'types',
      title: 'The domain model',
      icon: 'shapes',
      view: 'classes',
      files: typeFiles.map((f) => f.id),
      body: `The codebase defines ${[
        stats.classes && plural(stats.classes, 'class', 'classes'),
        stats.interfaces && plural(stats.interfaces, 'interface'),
        stats.types && plural(stats.types, 'type alias', 'type aliases'),
        stats.enums && plural(stats.enums, 'enum'),
      ]
        .filter(Boolean)
        .join(', ')}. The most shared definitions live in ${list(typeFiles.map((f) => f.id), 4)}.`,
    });
  }

  const careful: string[] = [];
  const { insights } = data;
  if (insights.hotspots.length) {
    careful.push(`**Hotspots** (complex *and* frequently changed): ${list(insights.hotspots.slice(0, 3).map((h) => h.file), 3)}`);
  }
  if (insights.complexFunctions.length && insights.complexFunctions[0].complexity >= 10) {
    const top = insights.complexFunctions.slice(0, 3).map((f) => `${f.name} (${f.complexity})`);
    careful.push(`**Most complex functions**: ${top.join(', ')}`);
  }
  if (insights.cycles.length) careful.push(`**${plural(insights.cycles.length, 'circular dependency', 'circular dependencies')}** that can cause subtle initialization bugs`);
  if (stats.todos) careful.push(`**${plural(stats.todos, 'TODO/FIXME note')}** left in the code`);
  if (careful.length) {
    steps.push({
      id: 'careful',
      title: 'Handle with care',
      icon: 'alert-triangle',
      view: 'insights',
      files: insights.hotspots.slice(0, 5).map((h) => h.file),
      body: careful.map((c) => `- ${c}`).join('\n'),
    });
  }

  // Suggested reading order: entry points first, then their most important dependencies (breadth-first).
  const deps = new Map<string, string[]>();
  for (const e of data.edges) {
    if (e.typeOnly) continue;
    const list = deps.get(e.source) ?? [];
    list.push(e.target);
    deps.set(e.source, list);
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = (entries.length ? entries : core).map((f) => f.id);
  while (queue.length && order.length < 12) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const file = byId.get(id);
    if (!file || file.kind === 'test' || file.kind === 'config' || file.kind === 'story') continue;
    order.push(id);
    const next = (deps.get(id) ?? [])
      .map((t) => byId.get(t))
      .filter((f): f is FileInfo => !!f && !seen.has(f.id))
      .sort((a, b) => b.metrics.importance - a.metrics.importance);
    queue.push(...next.map((f) => f.id));
  }
  if (order.length >= 3) {
    steps.push({
      id: 'reading-order',
      title: 'Suggested reading order',
      icon: 'list-ordered',
      files: order,
      body: 'Follow the flow of the program from its entry point into its most important dependencies:',
    });
  }
  return steps;
}

/* -------------------------------------------------------------------------- */
/*                              Duplicate symbol names                        */
/* -------------------------------------------------------------------------- */

const DUPLICATE_STOPLIST = new Set([
  'default',
  'Page',
  'Layout',
  'RootLayout',
  'Home',
  'Props',
  'State',
  'Options',
  'Config',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'metadata',
  'handler',
  'loader',
  'action',
  'meta',
  'links',
  'generateMetadata',
  'generateStaticParams',
  'getServerSideProps',
  'getStaticProps',
  'getStaticPaths',
  'config',
  'Default',
  'Primary',
  'Secondary',
  'Template',
  'Index',
  'App',
  'main',
  'setup',
  'routes',
  'router',
  'styles',
]);

export function findDuplicates(files: FileInfo[]): ReportData['insights']['duplicateSymbols'] {
  const map = new Map<string, { kind: FileInfo['symbols'][number]['kind']; files: Set<string> }>();
  for (const f of files) {
    if (f.kind === 'test' || f.kind === 'story' || f.kind === 'page' || f.kind === 'layout' || f.kind === 'route' || f.scope === 'context') continue;
    for (const s of f.symbols) {
      if (!s.exported || DUPLICATE_STOPLIST.has(s.name)) continue;
      if (!['component', 'hook', 'function', 'class', 'interface', 'type', 'enum'].includes(s.kind)) continue;
      const key = `${s.kind}:${s.name}`;
      const entry = map.get(key) ?? { kind: s.kind, files: new Set<string>() };
      entry.files.add(f.id);
      map.set(key, entry);
    }
  }
  return [...map.entries()]
    .filter(([, v]) => v.files.size > 1)
    .map(([key, v]) => ({ name: key.slice(key.indexOf(':') + 1), kind: v.kind, files: [...v.files] }))
    .sort((a, b) => b.files.length - a.files.length)
    .slice(0, 60);
}

/* -------------------------------------------------------------------------- */
/*                                     Misc                                   */
/* -------------------------------------------------------------------------- */

/** Packages that are typically used without being imported from source files. */
export const IMPLICIT_PACKAGES = new Set([
  'react-dom',
  'next',
  'nuxt',
  'vite',
  'typescript',
  'tslib',
  'core-js',
  'regenerator-runtime',
  '@babel/runtime',
  'tailwindcss',
  'postcss',
  'autoprefixer',
  'sass',
  'less',
  'husky',
  'lint-staged',
  'pm2',
  'nodemon',
  'ts-node',
  'tsx',
  'cross-env',
  'concurrently',
  'rimraf',
  'sharp',
  'prisma',
  'server-only',
  'client-only',
  'react-scripts',
  'expo',
  'electron',
  '@angular/core',
  '@angular/platform-browser-dynamic',
  'zone.js',
  'reflect-metadata',
  'pg',
  'mysql2',
  'sqlite3',
  'better-sqlite3',
  'serve',
  'http-server',
  'npm-run-all',
  'dotenv-cli',
  'patch-package',
  'web-vitals',
  '@nestjs/platform-express',
  '@nestjs/platform-fastify',
  '@nestjs/cli',
  'class-transformer',
  '@vercel/analytics',
  'eslint-config-next',
]);

/** One package.json as seen by `markPackageHealth` (deepest directory first in the list). */
export interface ManifestDeclarations {
  /** Project-relative directory ('' for the root). */
  dir: string;
  /** Package name (importing your own package by name is not a dependency). */
  name?: string;
  declared: Map<string, { version?: string; declaredAs: DeclaredAs }>;
  /** Text of the scripts that can use its packages (packages used only from scripts are not unused). */
  scripts: string;
  /** Text of the tool configs that belong to it (`presets: ['@babel/preset-env']` uses the package). */
  configText?: string;
  /** Unused dependencies are only judged when all code that can use them was analyzed. */
  checkUnused: boolean;
}

export interface PackageHealthOptions {
  /** Production code (not a test, story, config, script or browser bundle). */
  isProduction?: (file: string) => boolean;
  /** Whether `file` loads `pkg` when it runs (a value import or require — not `import type`, not `import()`). */
  loads?: (pkg: string, file: string) => boolean;
  /** Command names (package.json "bin") a declared package provides, to recognise packages run from scripts. */
  binsOf?: (manifestDir: string, pkg: string) => string[];
  /** Packages files use without importing them as packages (a workspace imported by name, `react` for JSX). */
  implicitUse?: Map<string, Set<string>>;
}

export interface PackageHealth {
  unused: string[];
  /** Each unused declaration with the package.json that declares it. */
  unusedDeclarations: { name: string; manifest: string }[];
  missing: NonNullable<Insights['missingDependencies']>;
  devDependenciesInProduction: DevDependencyInProduction[];
  /** How each imported package is declared for the files that import it (first declaration found). */
  declaredAs: Map<string, { version?: string; declaredAs: DeclaredAs }>;
}

/**
 * Packages the runtime host provides, so they are devDependencies on purpose: Electron (electron-builder
 * refuses it in "dependencies"), the VS Code and Obsidian extension APIs, and the AWS SDK v2 on Lambda.
 */
const RUNTIME_PROVIDED = new Set(['electron', 'vscode', 'obsidian', 'aws-sdk']);

/** Packages consumed by tools and frameworks by convention rather than imported (never "unused"). */
const CONVENTION_PACKAGES_RE =
  /^(eslint|prettier|@eslint|stylelint|babel-|@babel\/|webpack|rollup|@vitejs|vite-plugin|@nuxt|@nuxtjs|@sveltejs|@tailwindcss|@fontsource|@capacitor|@docusaurus\/|@mdx-js\/)/;

/** Whether `text` mentions `name` as a quoted string (`'@babel/preset-env'`, `"pkg/sub"`). */
function quotes(text: string | undefined, name: string): boolean {
  if (!text || !text.includes(name)) return false;
  return text.includes(`'${name}`) || text.includes(`"${name}`) || text.includes(`\`${name}`);
}

/** Whether a package is run from the scripts: by a command it provides, or by its scope (`docusaurus start`). */
function usedByScripts(m: ManifestDeclarations, name: string, binsOf: PackageHealthOptions['binsOf']): boolean {
  if (m.scripts.includes(name)) return true;
  const words = new Set(m.scripts.split(/[^\w@./:-]+/));
  const scope = name.startsWith('@') ? name.slice(1, name.indexOf('/')) : undefined;
  if (scope && words.has(scope)) return true;
  return (binsOf?.(m.dir, name) ?? []).some((bin) => words.has(bin));
}

/**
 * Unused, missing and misplaced dependencies. Every import is checked against the package.json files
 * that can provide it: the nearest one and those above it (a sibling workspace's declaration doesn't count).
 */
export function markPackageHealth(packages: PackageInfo[], manifests: ManifestDeclarations[], options: PackageHealthOptions = {}): PackageHealth {
  const chains = new Map<string, ManifestDeclarations[]>();
  const chainOf = (file: string): ManifestDeclarations[] => {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    let chain = chains.get(dir);
    if (!chain) {
      chain = manifests.filter((m) => !m.dir || dir === m.dir || dir.startsWith(`${m.dir}/`));
      chains.set(dir, chain);
    }
    return chain;
  };
  const used = new Map<ManifestDeclarations, Set<string>>();
  const missing = new Map<string, { files: string[]; manifests: Set<string> }>();
  const dev = new Map<string, DevDependencyInProduction>();
  const declaredAs: PackageHealth['declaredAs'] = new Map();
  for (const pkg of packages) {
    if (pkg.builtin) continue;
    for (const file of pkg.importedBy) {
      const chain = chainOf(file);
      if (!chain.length) continue;
      for (const m of chain) {
        const set = used.get(m) ?? new Set<string>();
        set.add(pkg.name);
        used.set(m, set);
      }
      if (chain[0].name === pkg.name) continue; // self-reference to the nearest package
      const found = chain.map((m) => ({ m, d: m.declared.get(pkg.name) })).filter((x) => x.d);
      if (!found.length) {
        const entry = missing.get(pkg.name) ?? { files: [], manifests: new Set<string>() };
        entry.files.push(file);
        entry.manifests.add(chain[0].dir);
        missing.set(pkg.name, entry);
        continue;
      }
      if (!declaredAs.has(pkg.name)) declaredAs.set(pkg.name, found[0].d!);
      const devOnly = found.every((x) => x.d!.declaredAs === 'devDependencies');
      if (!devOnly || pkg.name.startsWith('@types/') || RUNTIME_PROVIDED.has(pkg.name)) continue;
      if (!options.isProduction?.(file) || (options.loads && !options.loads(pkg.name, file))) continue;
      const entry = dev.get(pkg.name) ?? { name: pkg.name, files: [], manifest: found[0].m.dir };
      // The package.json of the importing code should declare it (a root devDependency used by a workspace).
      if (chain[0].dir !== entry.manifest && entry.declareIn === undefined) entry.declareIn = chain[0].dir;
      entry.files.push(file);
      dev.set(pkg.name, entry);
    }
  }
  for (const [name, files] of options.implicitUse ?? []) {
    for (const file of files) {
      for (const m of chainOf(file)) {
        const set = used.get(m) ?? new Set<string>();
        set.add(name);
        used.set(m, set);
      }
    }
  }
  const unused = new Set<string>();
  const unusedDeclarations: PackageHealth['unusedDeclarations'] = [];
  for (const m of manifests) {
    if (!m.checkUnused) continue;
    const imported = used.get(m);
    for (const [name, info] of m.declared) {
      if (info.declaredAs !== 'dependencies') continue;
      if (imported?.has(name) || name.startsWith('@types/') || IMPLICIT_PACKAGES.has(name) || CONVENTION_PACKAGES_RE.test(name)) continue;
      if (quotes(m.configText, name) || usedByScripts(m, name, options.binsOf)) continue;
      unused.add(name);
      unusedDeclarations.push({ name, manifest: m.dir });
    }
  }
  const declarers = (name: string, except: Set<string>): string[] => manifests.filter((m) => !except.has(m.dir) && m.declared.has(name)).map((m) => m.dir);
  return {
    unused: [...unused].sort(),
    unusedDeclarations: unusedDeclarations.sort((a, b) => a.name.localeCompare(b.name) || a.manifest.localeCompare(b.manifest)),
    missing: [...missing.entries()]
      .map(([name, { files, manifests: dirs }]) => {
        const declaredBy = declarers(name, dirs);
        // Only worth saying in monorepos / nested packages (the root package.json goes without saying).
        const nested = dirs.size > 1 || !dirs.has('');
        return { name, files: files.sort().slice(0, 10), ...(nested ? { manifests: [...dirs].sort() } : {}), ...(declaredBy.length ? { declaredBy } : {}) };
      })
      .sort((a, b) => b.files.length - a.files.length),
    devDependenciesInProduction: [...dev.values()]
      .map((d) => ({ ...d, files: d.files.sort().slice(0, 10) }))
      .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name)),
    declaredAs,
  };
}

export function symbolEdgeKey(e: Pick<SymbolEdge, 'source' | 'target' | 'kind'>): string {
  return `${e.source}\0${e.target}\0${e.kind}`;
}
