/**
 * The data contract between the analyzer (Node.js) and the report UI (browser).
 * Everything the report shows is derived from a single `ReportData` object that
 * is embedded into the generated HTML file.
 */

export const SCHEMA_VERSION = 1;

export type Language = 'typescript' | 'javascript' | 'vue' | 'svelte' | 'astro';

export type FileKind =
  | 'entry'
  | 'page'
  | 'layout'
  | 'route'
  | 'component'
  | 'hook'
  | 'composable'
  | 'context'
  | 'store'
  | 'service'
  | 'api'
  | 'controller'
  | 'middleware'
  | 'model'
  | 'router'
  | 'util'
  | 'constants'
  | 'types'
  | 'config'
  | 'test'
  | 'story'
  | 'script'
  | 'module';

export type SymbolKind =
  | 'component'
  | 'hook'
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'namespace';

export type FrameworkCategory =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'desktop'
  | 'state'
  | 'data'
  | 'styling'
  | 'testing'
  | 'build'
  | 'language';

export interface FrameworkInfo {
  id: string;
  name: string;
  version?: string;
  category: FrameworkCategory;
}

export interface LanguageStat {
  language: Language;
  files: number;
  loc: number;
}

export interface ProjectInfo {
  name: string;
  version?: string;
  description?: string;
  /** Folder name of the analyzed root. */
  rootName: string;
  /** Absolute path of the analyzed root (used for "open in editor" links). */
  rootPath: string;
  frameworks: FrameworkInfo[];
  languages: LanguageStat[];
  packageManager?: string;
  typescript: boolean;
  workspaces?: string[];
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
  git?: { branch?: string; commit?: string; remote?: string };
}

export type ScopeType = 'project' | 'file' | 'directory';

export interface Scope {
  type: ScopeType;
  /** Project-relative path for `file` and `directory` scopes. */
  path?: string;
}

/** Role of a file inside a scoped (`--file` / `--directory`) report. */
export type ScopeRole = 'focus' | 'member' | 'dependency' | 'dependent' | 'context';

export interface ParamInfo {
  name: string;
  type?: string;
  optional?: boolean;
  defaultValue?: string;
  rest?: boolean;
}

export type MemberKind =
  | 'property'
  | 'method'
  | 'getter'
  | 'setter'
  | 'constructor'
  | 'enumMember'
  | 'index'
  | 'call';

export interface MemberInfo {
  name: string;
  kind: MemberKind;
  type?: string;
  visibility?: 'public' | 'private' | 'protected';
  static?: boolean;
  optional?: boolean;
  readonly?: boolean;
  abstract?: boolean;
  async?: boolean;
  params?: ParamInfo[];
  value?: string;
  decorators?: string[];
  line: number;
}

export interface ComponentInfo {
  framework: 'react' | 'vue' | 'svelte' | 'angular' | 'solid' | 'astro' | 'preact';
  props: string[];
  hooks: string[];
  /** Raw names of the components rendered in this component's markup. */
  renders: string[];
  emits?: string[];
  contexts?: string[];
  state?: number;
}

export interface SymbolInfo {
  /** `<fileId>#<name>`; unique within the report. */
  id: string;
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  exported: boolean;
  isDefault?: boolean;
  async?: boolean;
  generator?: boolean;
  params?: ParamInfo[];
  returnType?: string;
  /** Type annotation / alias body / initializer preview (truncated). */
  typeText?: string;
  complexity?: number;
  loc: number;
  /** First sentence of the JSDoc comment, if any. */
  doc?: string;
  members?: MemberInfo[];
  extends?: string[];
  implements?: string[];
  decorators?: string[];
  abstract?: boolean;
  /** Free-form tags such as `context`, `store`, `memo`, `styled`, `server-action`. */
  tags?: string[];
  component?: ComponentInfo;
}

export interface ExportInfo {
  name: string;
  line: number;
  isDefault?: boolean;
  typeOnly?: boolean;
  /** For re-exports: the specifier it is re-exported from. */
  from?: string;
  /** Possibly unused: no file in the project imports it. */
  unused?: boolean;
}

export interface TodoItem {
  line: number;
  tag: string;
  text: string;
}

export interface FileGitInfo {
  commits: number;
  authors: { name: string; commits: number }[];
  lastModified: number;
  firstSeen: number;
}

export interface FileMetrics {
  fanIn: number;
  fanOut: number;
  /** PageRank-style importance, normalized to 0..1 within the report. */
  importance: number;
  /** Martin's instability: fanOut / (fanIn + fanOut). */
  instability: number;
  externalImports: number;
}

export interface AssetImport {
  specifier: string;
  line: number;
  /** Project-relative path if it exists on disk. */
  path?: string;
}

export interface FileInfo {
  /** POSIX path relative to the project root, e.g. `src/components/Button.tsx`. */
  id: string;
  name: string;
  dir: string;
  ext: string;
  language: Language;
  kind: FileKind;
  loc: number;
  sloc: number;
  bytes: number;
  complexity: number;
  maxComplexity: number;
  symbols: SymbolInfo[];
  exports: ExportInfo[];
  assets: AssetImport[];
  unresolved: { specifier: string; line: number }[];
  isEntry: boolean;
  entryReason?: string;
  isTest: boolean;
  isGenerated?: boolean;
  orphan?: boolean;
  inCycle?: boolean;
  /** 'use client' / 'use server' style directives. */
  directives?: string[];
  /** Leading file comment, if any. */
  description?: string;
  todos: TodoItem[];
  git?: FileGitInfo;
  metrics: FileMetrics;
  scope?: ScopeRole;
  source?: string;
  parseError?: string;
}

export type EdgeKind = 'import' | 'dynamic' | 'require' | 'reexport' | 'side-effect';

export interface DependencyEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  typeOnly: boolean;
  names: string[];
  line: number;
  specifier: string;
  inCycle?: boolean;
}

export type DeclaredAs =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

export interface PackageInfo {
  name: string;
  version?: string;
  declaredAs?: DeclaredAs;
  builtin: boolean;
  /** Files importing this package. */
  importedBy: string[];
  /** Names imported from the package across the codebase (top 30). */
  names: string[];
  importCount: number;
  typeOnly: boolean;
  unused?: boolean;
  missing?: boolean;
}

export type SymbolEdgeKind = 'calls' | 'renders' | 'extends' | 'implements' | 'uses' | 'instantiates';

export interface SymbolEdge {
  source: string;
  target: string;
  kind: SymbolEdgeKind;
  count: number;
}

export type RouteFramework =
  | 'express'
  | 'fastify'
  | 'koa'
  | 'hono'
  | 'nestjs'
  | 'next-app'
  | 'next-pages'
  | 'nuxt'
  | 'sveltekit'
  | 'remix'
  | 'astro'
  | 'react-router'
  | 'vue-router'
  | 'tanstack-router'
  | 'angular';

export type RouteType = 'page' | 'api' | 'layout' | 'middleware' | 'mount';

export interface RouteInfo {
  id: string;
  method: string;
  path: string;
  file: string;
  line?: number;
  handler?: string;
  /** Symbol id of the handler or page component if it could be resolved. */
  handlerSymbol?: string;
  middlewares?: string[];
  framework: RouteFramework;
  type: RouteType;
  params?: string[];
}

export interface HotspotInfo {
  file: string;
  score: number;
  commits: number;
  complexity: number;
  loc: number;
}

export interface ChangeCoupling {
  a: string;
  b: string;
  count: number;
  /** Shared commits / commits of the less-changed file. */
  ratio: number;
}

export interface ComplexFunction {
  symbol: string;
  file: string;
  name: string;
  complexity: number;
  line: number;
  loc: number;
}

export interface Insights {
  cycles: string[][];
  orphans: string[];
  unusedExports: { file: string; name: string; line: number; typeOnly?: boolean }[];
  unusedDependencies: string[];
  missingDependencies: { name: string; files: string[] }[];
  complexFunctions: ComplexFunction[];
  hotspots: HotspotInfo[];
  changeCoupling: ChangeCoupling[];
  duplicateSymbols: { name: string; kind: SymbolKind; files: string[] }[];
}

export interface FolderSummary {
  path: string;
  files: number;
  loc: number;
  kinds: Partial<Record<FileKind, number>>;
  description: string;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  files?: string[];
  view?: string;
  icon?: string;
}

export interface GitSummary {
  branch?: string;
  commitsAnalyzed: number;
  firstCommit?: number;
  lastCommit?: number;
  contributors: { name: string; commits: number; files: number }[];
  /** Commits per week for the last 52 weeks, oldest first. */
  weeklyActivity: number[];
}

export interface Stats {
  files: number;
  loc: number;
  sloc: number;
  symbols: number;
  components: number;
  hooks: number;
  functions: number;
  classes: number;
  interfaces: number;
  types: number;
  enums: number;
  constants: number;
  variables: number;
  routes: number;
  packages: number;
  internalEdges: number;
  testFiles: number;
  todos: number;
  avgComplexity: number;
  durationMs: number;
}

export interface ReportData {
  schemaVersion: number;
  tool: { name: string; version: string };
  generatedAt: string;
  scope: Scope;
  options: { includeSource: boolean; git: boolean };
  project: ProjectInfo;
  files: FileInfo[];
  edges: DependencyEdge[];
  packages: PackageInfo[];
  symbolEdges: SymbolEdge[];
  routes: RouteInfo[];
  insights: Insights;
  folders: FolderSummary[];
  tour: TourStep[];
  stats: Stats;
  git?: GitSummary;
  warnings: string[];
}
