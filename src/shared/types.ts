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
  /**
   * Nested packages (not workspaces) inside test / fixture / example folders that were left out of
   * the analysis. Set `includeSubprojects: true` in the configuration to analyze them.
   */
  subprojects?: string[];
  /** Test runners per workspace directory (`''` = the root), for ready-to-paste test commands (query-core). */
  testRunners?: Record<string, TestRunnerInfo>;
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
  /** Cyclomatic complexity of the symbol's own body (nested functions are counted on their own). */
  complexity?: number;
  /** Cognitive complexity (Sonar-style): branches weighted by how deeply they are nested. */
  cognitive?: number;
  /** The most complex function nested inside this one (an inline callback or helper), when it has branches. */
  nested?: NestedFunctionComplexity;
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
  /** `@deprecated` JSDoc message (empty string when the tag has no text). */
  deprecated?: string;
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

export interface CommitRef {
  hash: string;
  date: number;
  author: string;
  subject: string;
}

export interface FileGitInfo {
  commits: number;
  /** Authors ordered by commits; `last` is the time of their latest commit to the file. */
  authors: { name: string; commits: number; last: number; email?: string }[];
  lastModified: number;
  firstSeen: number;
  /** Most recent commits touching the file (newest first). */
  recent: CommitRef[];
  /** Share of commits by the top author (0..1). */
  ownership: number;
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
  /** Test files that (transitively) import this file. */
  tests?: string[];
  /** Owners from CODEOWNERS. */
  owners?: string[];
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
  /** Project-relative directories of package.json files ('' for the root) that declare it without using it. */
  unusedIn?: string[];
}

export type SymbolEdgeKind = 'calls' | 'renders' | 'extends' | 'implements' | 'uses' | 'instantiates';

export interface SymbolEdge {
  source: string;
  target: string;
  kind: SymbolEdgeKind;
  count: number;
  /** Lines of the call / render / `new` sites in the source symbol's file (sorted, at most 20). */
  lines?: number[];
  /** Argument count per call site, aligned with `lines` (calls and `new` only); -1 when a spread argument is used. */
  argc?: number[];
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
  missingDependencies: {
    name: string;
    files: string[];
    /** The package.json files that should declare it (nearest to the importing files; '' for the root). */
    manifests?: string[];
    /** Other package.json files that do declare it (a sibling workspace). */
    declaredBy?: string[];
  }[];
  complexFunctions: ComplexFunction[];
  hotspots: HotspotInfo[];
  changeCoupling: ChangeCoupling[];
  duplicateSymbols: { name: string; kind: SymbolKind; files: string[] }[];
  /** Important source files that no test file reaches, most important first. */
  untested: string[];
  /** `@deprecated` symbols that are still used. */
  deprecated: { symbol: string; file: string; name: string; line: number; note: string; usages: string[] }[];
  /** Imports that break the architecture rules from the config file. */
  ruleViolations: RuleViolation[];
  /** Important files where one person made most of the changes. */
  knowledgeSilos: { file: string; author: string; share: number; lastActive: number }[];
  /** Packages declared only in devDependencies but imported by production (non-test, non-config) code. */
  devDependenciesInProduction?: DevDependencyInProduction[];
  /** Declared runtime dependencies nobody imports, with the package.json that declares them. */
  unusedDeclarations?: { name: string; manifest: string }[];
}

export interface RuleViolation {
  rule: string;
  severity: 'error' | 'warn';
  source: string;
  target: string;
  line: number;
  message?: string;
}

export interface FolderSummary {
  path: string;
  files: number;
  loc: number;
  kinds: Partial<Record<FileKind, number>>;
  description: string;
  /** People who know this area best (git history, recency-weighted). */
  experts?: { name: string; share: number }[];
  /** Number of people that together made > 50% of the commits. */
  busFactor?: number;
  owners?: string[];
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  files?: string[];
  view?: string;
  icon?: string;
}

export interface CommitInfo extends CommitRef {
  files: number;
  additions: number;
  deletions: number;
  /** Project files touched by the commit (capped). */
  paths: string[];
}

export interface GitSummary {
  branch?: string;
  head?: string;
  /** The person running the analysis: their author name in the history (matched by `git config user.email`), else `user.name`. */
  user?: string;
  /** `git config user.email` of the person running the analysis. */
  userEmail?: string;
  upstream?: { name: string; ahead: number; behind: number };
  commitsAnalyzed: number;
  firstCommit?: number;
  lastCommit?: number;
  contributors: { name: string; commits: number; files: number; first: number; last: number; areas: { path: string; commits: number }[] }[];
  /** Commits per week for the last 52 weeks, oldest first. */
  weeklyActivity: number[];
  /** Commits per day for the last 371 days (53 weeks), oldest first; the last entry is today. */
  dailyActivity: number[];
  /** Most recent commits (newest first). */
  commits: CommitInfo[];
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  id: string;
  status: ChangeStatus;
  oldPath?: string;
  additions: number;
  deletions: number;
  /** Changed line numbers in the new version of the file. */
  lines: number[];
  /** Unified diff (trimmed for very large changes). */
  diff?: string;
  /** Whether the file is part of the analyzed source files. */
  analyzed: boolean;
}

export interface ChangedSymbol {
  id: string;
  file: string;
  name: string;
  kind: SymbolKind | 'method';
  exported: boolean;
  /** Symbols and files that use it. */
  usedBy: number;
}

export interface ChangeSet {
  /** `working` = uncommitted changes, `branch` = everything since the branch left its base. */
  mode: 'working' | 'branch';
  base?: string;
  baseCommit?: string;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  commits: CommitInfo[];
  symbols: ChangedSymbol[];
  /** Files affected through imports (excluding the changed files themselves). */
  impacted: string[];
  impactedRoutes: string[];
  /** Groups of changed files that depend on each other — review them together. */
  clusters: string[][];
  tests: { files: string[]; command?: string; runner?: string; changedTests: string[] };
  reviewers: { name: string; score: number; files: number; last: number }[];
  owners: { owner: string; files: string[] }[];
  risk: { score: number; level: 'low' | 'medium' | 'high'; factors: { label: string; points: number }[] };
}

export interface HealthCategory {
  id: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface Improvement {
  id: string;
  title: string;
  detail: string;
  gain: number;
  files?: string[];
  view?: string;
}

export interface HealthReport {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  categories: HealthCategory[];
  improvements: Improvement[];
}

export interface HistoryPoint {
  date: number;
  commit?: string;
  branch?: string;
  dirty?: boolean;
  score: number;
  files: number;
  loc: number;
  cycles: number;
  unusedExports: number;
  avgComplexity: number;
  testReach: number;
  todos: number;
}

export interface ApiCall {
  id: string;
  file: string;
  /** Enclosing symbol id, when known. */
  symbol?: string;
  line: number;
  method: string;
  url: string;
  client: string;
  /** Matched route id (same codebase). */
  route?: string;
  /** Host for absolute URLs to external services. */
  external?: string;
}

export interface CustomTour {
  title: string;
  description?: string;
  /** Project-relative path of the `.tour` file. */
  source: string;
  steps: { title?: string; description: string; file?: string; line?: number; directory?: string }[];
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
  /** Share of source files reached by at least one test (0..1). */
  testReach: number;
  durationMs: number;
  /** How much of the analysis was reused (warm-engine): parse results from the cache, or a running server. */
  cache?: AnalysisCacheStats;
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
  /** Your current work: uncommitted changes or the branch compared to its base. */
  changes?: ChangeSet;
  health: HealthReport;
  /** Previous runs (oldest first), for trends. */
  history: HistoryPoint[];
  apiCalls: ApiCall[];
  /** Tours from `.tours/*.tour` (VS Code CodeTour format). */
  tours: CustomTour[];
  /** The configuration file in use; `error` is set when it could not be read. */
  config?: { file?: string; rules: number; layers?: string[]; error?: string; includeSubprojects?: boolean | string[]; ruleList?: RuleListEntry[] };
  warnings: string[];
}

// --- compare-engine ---

/** A place in the code that uses a symbol (an import, a call, a JSX render, `new`, or an HTTP request). */
export interface CallSite {
  file: string;
  line: number;
  /** Number of arguments passed (-1 when a spread argument is used). */
  argc?: number;
  kind: 'call' | 'render' | 'new' | 'import' | 'reexport' | 'http';
  /** Enclosing symbol id of the call site. */
  symbol?: string;
}

/** A change to an exported declaration between two analyses. */
export interface ExportChange {
  file: string;
  /** Export name (`default` for default exports). */
  name: string;
  change: 'removed' | 'added' | 'signature' | 'kind';
  /** Declaration before / after (see `signature()` in src/shared/signature.ts). */
  before?: string;
  after?: string;
  /** Removed, a different kind of declaration, more required parameters or fewer allowed ones. */
  breaking: boolean;
  /** Files that (still) import the export, directly or through re-exports. */
  importers: string[];
  /** Calls whose argument count no longer fits the new signature (needs call-site data from query-core). */
  staleCallSites: CallSite[];
  /** Line of the declaration in the newer version (or the older one when it was removed). */
  line?: number;
  /** The file is published by package.json (main / exports / bin…), so outside code may use it too. */
  entry?: boolean;
}

/** What changed architecturally between two analyses (see `compareReports`). */
export interface ArchitectureDelta {
  /** Name of the base (a ref such as `origin/main`, or a short commit). */
  base: string;
  baseCommit: string;
  /** Name of the head (`working tree`, `index` or a ref). */
  head: string;
  newEdges: { source: string; target: string; names: string[]; line?: number; typeOnly?: boolean }[];
  removedEdges: { source: string; target: string }[];
  /**
   * Import counts between areas (folders at the default architecture depth) that changed; `via` names
   * up to 3 of the new file-level imports behind an increase.
   */
  areaEdges: { from: string; to: string; before: number; after: number; isNew: boolean; via?: { source: string; target: string; line?: number }[] }[];
  newCycles: string[][];
  fixedCycles: string[][];
  newViolations: RuleViolation[];
  fixedViolations: RuleViolation[];
  newMissingDependencies: string[];
  /** devDependencies that production code started to import (`insights.devDependenciesInProduction`). */
  newDevDependenciesInProduction?: { name: string; manifest?: string; files: string[] }[];
  addedPackages: string[];
  removedPackages: string[];
  /** Functions whose complexity increased, and new functions above 10. */
  complexity: { symbol: string; file: string; name: string; line: number; before: number; after: number }[];
  exports: ExportChange[];
  routes: { added: string[]; removed: { id: string; label: string; stillCalledFrom: { file: string; line: number }[] }[] };
  newUnusedExports: { file: string; name: string; line: number }[];
  health: { before: number; after: number; categories: { id: string; before: number; after: number }[] };
  /**
   * Finding fingerprints (src/shared/fingerprint.ts) that appeared / disappeared. `worsened`: findings
   * the base already had that got worse (a function above the complexity threshold that grew).
   */
  fingerprints: { new: string[]; fixed: string[]; worsened?: string[] };
  /** Files that were renamed or moved (from git, or the same declarations under a new path); their findings are not new. */
  renamed?: { from: string; to: string }[];
  /** `baseCommit` is where the head left `base` (their merge-base), not the current tip of `base`. */
  mergeBase?: boolean;
  /** Lists that were cut to keep the report small: list name → number of omitted entries. */
  truncated?: Record<string, number>;
}

/** The parts of an analysis that `compareReports` needs; a stored snapshot of a commit. */
export interface ReportSnapshot extends Pick<ReportData, 'files' | 'edges' | 'symbolEdges' | 'routes' | 'apiCalls' | 'packages' | 'insights' | 'health' | 'config'> {
  /** Full hash of the commit the snapshot shows. */
  commit?: string;
}

export interface ChangeSet {
  /** Architecture changes compared to the base commit (when the analysis ran with `compare`). */
  delta?: ArchitectureDelta;
}

// --- warm-engine ---

/** Where an analysis came from: parsed from scratch, the disk cache, an in-process cache or a running `serve`. */
export type AnalysisSource = 'cold' | 'disk' | 'memory' | 'server';

export interface AnalysisCacheStats {
  /** Files whose parse result was reused (unchanged mtime/size, or the same content hash). */
  reused: number;
  /** Files parsed in this run. */
  parsed: number;
  source: AnalysisSource;
}

/**
 * `.code-visualizer/server.json`: written by a running `code-visualizer serve` so other commands
 * (CLI, hooks, MCP, status lines) can reuse its warm analysis instead of starting from scratch.
 */
export interface ServerInfo {
  pid: number;
  port: number;
  host: string;
  /** API token (the file is created with mode 0600). */
  token: string;
  /** Absolute project root the server analyzes. */
  root: string;
  /** Tool version of the server. */
  version: string;
  startedAt: number;
  /** The page URL (includes `?token=` when the server is reachable from other machines). */
  url?: string;
  /** Fingerprint of the analysis options (scope, excludes, git, base…): clients only reuse matching data. */
  fingerprint?: string;
  /** Whether the server embeds sources / detects changes (clients that need them check these). */
  includeSource?: boolean;
  changes?: boolean;
  /**
   * Whether the server reads and records `.code-visualizer/history.json`. A server without history
   * only holds the current point, so clients that keep the trend never take its data.
   */
  history?: boolean;
  /** Whether the server's analyses carry `changes.delta` (compare-engine), for clients that need it. */
  compare?: boolean;
}

// --- accuracy-pass ---

/** A devDependency that production code imports (it is missing when installed with `--omit=dev`). */
export interface DevDependencyInProduction {
  name: string;
  /** Production files importing it (capped). */
  files: string[];
  /** Project-relative directory of the package.json that declares it ('' for the root). */
  manifest?: string;
  /** The package.json the importing code belongs to, when that is not `manifest` (it should declare it). */
  declareIn?: string;
}

/** A function nested inside a symbol (inline callback, inner helper), measured on its own. */
export interface NestedFunctionComplexity {
  /** Its name, or what it is passed to (`app.get callback`). */
  name: string;
  line: number;
  complexity: number;
  loc: number;
}

// --- query-core ---

/** The test runners of one package: unit and e2e runner ids (`vitest`, `jest`, `playwright`…) and its package manager. */
export interface TestRunnerInfo {
  unit?: string;
  e2e?: string;
  pm?: string;
}

export interface SymbolInfo {
  /**
   * Other top-level symbols of the same file this one uses without a call, render or `new` edge: values
   * it reads (`columns.map(…)`, `{ date: formatDate }`) and types it mentions. Impact follows them, so an
   * edit to a constant reaches the exported functions that read it.
   */
  localRefs?: string[];
  /** Module-level code of its file (outside any declaration, e.g. `init();`) uses it. */
  moduleRef?: boolean;
}

export interface ChangeSet {
  /**
   * `symbol`: `impacted` holds only importers and callers of the changed declarations (edits inside
   * functions); `file`: some change is outside a declaration, so every importer of that file counts.
   */
  impactPrecision?: 'symbol' | 'file';
  /** Changed files whose edits are only comments or blank lines (they affect nothing). */
  commentOnly?: string[];
}

// --- new-only-gates ---

export type FindingSeverity = 'error' | 'warning' | 'note';

/** Compared to the base (or the baseline file): `new` problems fail gates, `existing` ones are old debt. */
export type FindingStatus = 'new' | 'existing' | 'fixed';

/**
 * One problem a quality gate reports, with a stable identity (`fingerprint`, see src/shared/fingerprint.ts:
 * no line numbers) so a later run, a base commit or a committed baseline can tell new problems from old.
 */
export interface Finding {
  /** `cv/cycle`, `cv/architecture-rule`, `cv/layer-violation`, `cv/missing-dependency`, `cv/complexity`… (src/shared/rules-catalog.ts). */
  ruleId: string;
  /** Id of the gate that reported it (`cycles`, `rules`, `dependencies`…). */
  gate: string;
  /** Project-relative file the finding points at. */
  file: string;
  line?: number;
  message: string;
  severity: FindingSeverity;
  /** What the finding is about: the cycle, `rule|source|target`, a package name, a symbol id… */
  subject: string;
  fingerprint: string;
  /** Set when the run compares with a base or a baseline. */
  status?: FindingStatus;
  /** The line (or, without a line, the file) is part of your change. */
  onChangedLine?: boolean;
  /** An old finding that your change made worse (status `new`): e.g. a function above the limit that grew. */
  worsened?: boolean;
  /** How bad it is (complexity, number of files in a cycle…): rankings sort equal findings by it, highest first. */
  weight?: number;
}

export interface GateResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  findings: Finding[];
  /** Compared with a base or a baseline: how many findings are new, were already there, or went away. */
  counts?: { new: number; existing: number; fixed: number };
}

/**
 * What `check` judged: `all` the whole project, `changed` / `new-since` / `staged` only what is new
 * compared to a base commit, `baseline` only what is not in the committed baseline file.
 */
export type CheckMode = 'all' | 'changed' | 'new-since' | 'baseline' | 'staged';

export interface CheckResult {
  ok: boolean;
  mode: CheckMode;
  /** What new findings were compared with: a ref, `HEAD` or the baseline file. */
  base?: string;
  health: number;
  /** Health change compared with the base (negative = worse); only when a base was analyzed. */
  healthDelta?: number;
  gates: GateResult[];
  /** Findings the base (or baseline) had that are gone now. */
  fixed: Finding[];
  /** Remarks about how the check ran (e.g. the comparison with the base failed). */
  notes?: string[];
  /** Only new findings fail: the check compared with a base commit or a baseline. */
  newOnly?: boolean;
  /** Rule ids of the gates that ran (a baseline update keeps the entries of all other rules). */
  ruleIds?: string[];
}

/**
 * `code-visualizer.baseline.json`: known findings that `check` tolerates, as fingerprints per rule
 * (a multiset: a fingerprint is listed once per occurrence). No line numbers, so edits elsewhere in a
 * file never invalidate it.
 */
export interface Baseline {
  version: 1;
  tool: string;
  findings: Record<string, string[]>;
  /**
   * The files of each known import cycle (by fingerprint), so a cycle that lost files or split is still
   * known: its fingerprint is a hash of its member set, which changes whenever the set does.
   */
  cycles?: Record<string, string[]>;
}

/** `.code-visualizer/state.json` → `lastCheck`: the outcome of the latest `check` (status lines, hooks). */
export interface LastCheckState {
  at: number;
  ok: boolean;
  mode: CheckMode;
  /** Number of failed gates. */
  failures: number;
  /** Ids of the failed gates. */
  failed: string[];
  /** New findings (compared with the base or baseline; all findings in `all` mode). */
  newFindings: number;
}

export interface ArchitectureDelta {
  /** Missing dependencies (package names) the base had that are gone. */
  fixedMissingDependencies?: string[];
  /** devDependencies the base's production code imported that it no longer does. */
  fixedDevDependenciesInProduction?: { name: string; manifest?: string }[];
  /** Functions that were above the complexity threshold in the base and no longer are (or are gone). */
  fixedComplexity?: { symbol: string; file: string; name: string; line: number; complexity: number }[];
  /** Unused exports of the base that are used (or gone) now. */
  fixedUnusedExports?: { file: string; name: string; line: number }[];
  /** The complexity threshold the delta's complexity findings were judged with (default 10). */
  complexityThreshold?: number;
}

// --- live-guard ---

/**
 * The kinds of live events (see src/analyzer/live-events.ts). Later features add kinds by declaring
 * more keys in their own block (interface merging) and listing them in LIVE_EVENT_KINDS.
 */
export interface LiveEventKinds {
  'cycle-added': true;
  'cycle-fixed': true;
  'rule-violation': true;
  'rule-fixed': true;
  'complexity-up': true;
  'complexity-down': true;
  'signature-changed': true;
  'route-removed': true;
  'unused-export': true;
  'missing-dependency': true;
  'untested-change': true;
  health: true;
  /** The configuration cannot be read (rules and layers are off), or is valid again. */
  config: true;
}

/** What a live event is about. */
export type LiveEventKind = keyof LiveEventKinds;

/** `error`: something broke; `warning`: got worse; `info`: worth knowing; `success`: fixed or better. */
export type LiveSeverity = 'error' | 'warning' | 'info' | 'success';

/** One thing that got worse (or better) between two analyses of a running `serve`. */
export interface LiveEvent {
  /** Unique within the server session. */
  id: string;
  /** When it was detected (ms since the epoch). */
  at: number;
  kind: LiveEventKind;
  severity: LiveSeverity;
  /** One line, plain text: `new cycle: src/a.ts → src/b.ts → src/a.ts`. */
  message: string;
  /** Optional second line, e.g. the signature before → after. */
  detail?: string;
  /** Files involved, most relevant first (cycle members, the importing file, the changed file…). */
  files: string[];
  /** Line in `files[0]`. */
  line?: number;
  /** Symbol id (`file#name`) for function-level events. */
  symbol?: string;
  /** Identity of the finding (src/shared/fingerprint.ts); a fix carries the fingerprint of what it fixed. */
  fingerprint: string;
  /** Numbers behind complexity and health events (before → after). */
  before?: number;
  after?: number;
  /** Analysis version (EngineUpdate.version) that produced it. */
  version?: number;
}

/** The SSE `update` payload of `serve` (also the shape of a live update in the report UI). */
export interface LiveUpdate {
  version: number;
  /** Project-relative paths reported since the previous analysis (capped). */
  changed: string[];
  durationMs: number;
  /** Number of analyzed files. */
  files: number;
  /** What got worse or better with this analysis (empty without changes worth announcing). */
  events: LiveEvent[];
  /** Problems announced in this session that are still there (drives the tab title count). */
  open: number;
  /** The open problems themselves, oldest first (at most 50), so the feed's "Still open" list stays current. */
  openProblems?: LiveEvent[];
}

/** `GET /api/events/history`: this session's feed (oldest first, at most 200) and the problems still open. */
export interface LiveFeed {
  version: number;
  events: LiveEvent[];
  open: LiveEvent[];
}

// --- test-intelligence ---

/** Line (and, when the report has them, function and branch) coverage of one file from a local lcov / istanbul report. */
export interface FileCoverage {
  lines: { total: number; covered: number };
  functions?: { total: number; covered: number };
  branches?: { total: number; covered: number };
  /** Lines with code that no test executed (sorted, at most 2000). */
  uncovered: number[];
  source: 'lcov' | 'istanbul';
  /** The file changed after the report was written: line numbers may be off. */
  stale?: boolean;
}

/** A coverage report the analysis read (`coverage/coverage-final.json`, `coverage/lcov.info`, or `--coverage <path>`). */
export interface CoverageReportInfo {
  /** Project-relative path of the report. */
  file: string;
  source: 'lcov' | 'istanbul';
  /** When it was written (mtime, ms since the epoch). */
  date: number;
  /** Analyzed files it has data for. */
  files: number;
}

/** What the analysis knows about test coverage (`ReportData.coverage`; absent without a report). */
export interface CoverageSummary {
  reports: CoverageReportInfo[];
  /** Executable lines of the analyzed source files the reports cover. */
  lines: { total: number; covered: number };
  /** `lines.covered / lines.total` as a ratio (0..1, not a percentage; `PatchCoverage.pct` is 0..100). */
  pct: number;
  /** Analyzed source files with coverage data. */
  files: number;
  /** Some covered file changed after its report was written. */
  stale?: boolean;
  /**
   * The newest report came from `code-visualizer test --coverage` running only the affected tests: good for
   * patch coverage, not for project coverage (health then falls back to test reach).
   */
  partial?: boolean;
  /**
   * Package folders with (unit) tests that no report describes ('' = the project root): the numbers cover
   * only the other packages, so `Stats.lineCoverage` and health leave coverage out.
   */
  unmeasured?: string[];
}

/** Coverage of the changed lines of one file (see `PatchCoverage`). */
export interface PatchCoverageFile {
  file: string;
  /** Added lines that are executable (the report has data for them). */
  coverable: number;
  covered: number;
  /** Added executable lines no test ran, merged into ranges (`[40, 55]`). */
  uncovered: [number, number][];
  /** The report has no data for this file (no test loaded it): its added code lines count as uncovered. */
  missing?: boolean;
  /** The file changed after the report was written. */
  stale?: boolean;
}

/** Coverage of the lines your change added ("patch coverage"), from the local coverage report. */
export interface PatchCoverage {
  coverable: number;
  covered: number;
  /** A percentage, 0..100 (100 when nothing coverable changed) — unlike the 0..1 ratios of `CoverageSummary.pct` and `Stats.lineCoverage`. */
  pct: number;
  files: PatchCoverageFile[];
  /** Changed source files in folders no coverage report describes (e.g. a workspace package without a report): not measured. */
  unmeasured?: string[];
  /** Project-relative path of the report used (the newest when there are several). */
  report: string;
  /** When that report was written (ms since the epoch). */
  reportDate: number;
  /** A changed file is newer than its report: rerun the tests with coverage. */
  stale: boolean;
}

/** A URL a test visits or requests (`page.goto('/users/1')`, `cy.visit`, `cy.request`, `request(app).get(…)`). */
export interface UrlVisit {
  url: string;
  line: number;
  /** HTTP method of a request; visits are `GET`. */
  method?: string;
}

export type TestSelectionReason = 'changed-test' | 'imports-changed' | 'co-change' | 'route-e2e';

export interface SelectedTest {
  file: string;
  reason: TestSelectionReason;
  /** The changed file it imports or changes with, or the route it visits (`GET /users/:id`). */
  via?: string;
  /** Workspace package directory whose runner runs it ('' = the project root). */
  package: string;
  runner?: string;
}

/** One runner invocation of a test plan, run from `cwd` without a shell. */
export interface TestCommand {
  /** Project-relative directory to run in ('' = the project root). */
  cwd: string;
  runner: string;
  /** Program and arguments (`['npx', 'vitest', 'run', 'src/a.test.ts']`); test paths are relative to `cwd`. */
  argv: string[];
  /** The same as a shell command line (`(cd packages/api && npx jest --runTestsByPath a.test.ts)`). */
  display: string;
  /** Project-relative test files it runs (empty for a full run of the package). */
  files: string[];
  /** Runs the package's whole suite. */
  full?: boolean;
}

/** Which tests a change needs (`code-visualizer test`): the plan, and how to run it. */
export interface TestSelection {
  /** What the changes were compared with (a ref) — for `branch` and `push`. */
  base?: string;
  /** `working`: uncommitted (and branch) work; `staged`: the index; `branch`: since `--since <ref>`; `push`: commits not pushed yet. */
  mode: 'staged' | 'working' | 'branch' | 'push';
  /** Some package runs its whole suite (a manifest, lockfile, tsconfig or test setup changed). */
  full: boolean;
  fullReason?: string;
  /** Packages that run in full ('' = the root, which means every package). */
  fullPackages?: string[];
  selected: SelectedTest[];
  commands: TestCommand[];
  /** Test files the runners know in the whole project. */
  totalTests: number;
  /** Changed files the selection started from. */
  changed: string[];
  /** Changed files whose edits are only comments or blank lines (they need no tests). */
  skipped?: string[];
}

/** `.code-visualizer/state.json` → `lastTest`: the outcome of the latest `code-visualizer test` run (status lines, agent hooks). */
export interface LastTestState {
  at: number;
  passed: boolean;
  /** Worst exit code of the runners (0 = passed). */
  exitCode: number;
  mode: TestSelection['mode'];
  /** Test files that ran by path (project-relative). */
  files: string[];
  /** Whole suites ran (see `fullPackages`). */
  full: boolean;
  fullPackages?: string[];
  durationMs: number;
  /**
   * The tree that was tested: `workingTreeId(root)` (src/analyzer/git.ts) — the hash of the working tree
   * with tracked edits, staged changes and untracked files; the same content always gives the same id.
   */
  treeId?: string;
  /** The commands as shell lines, joined with ` && `. */
  command: string;
  /** Ran with the runners' coverage flag. */
  coverage?: boolean;
}

export interface FileInfo {
  /** Line coverage from a local lcov / istanbul report (test-intelligence). */
  coverage?: FileCoverage;
  /** Test files only: URLs the test visits or requests (e2e specs reach routes this way, not through imports). */
  urlVisits?: UrlVisit[];
}

export interface ChangedFile {
  /** Lines added or replaced in the new version (the `+` lines of the diff; every line of a new file). */
  added?: number[];
}

export interface ChangeSet {
  /** Coverage of the added lines, when a coverage report exists. */
  coverage?: PatchCoverage;
}

export interface Stats {
  /**
   * Line coverage of the analyzed source files from the local coverage reports, as a ratio (0..1). Unset
   * when a package with tests has no report or the report came from a run of only the affected tests.
   */
  lineCoverage?: number;
}

export interface HistoryPoint {
  /** `Stats.lineCoverage` at that time (ratio, 0..1). */
  lineCoverage?: number;
}

export interface TestRunnerInfo {
  /**
   * Project-relative folder of the e2e runner's specs (`testDir` of playwright.config): files below it run
   * with the e2e runner even when their names look like unit tests (`tests/example.spec.ts`).
   */
  e2eDir?: string;
  /** The package's runner config sets coverage thresholds (vitest `coverage.thresholds`, jest `coverageThreshold`). */
  coverageThresholds?: boolean;
}

export interface ReportData {
  /** The coverage reports that were read and the project's line coverage (test-intelligence). */
  coverage?: CoverageSummary;
}

// --- review-mode ---

/**
 * What a changed file is for a reviewer: `contract` (types, schemas, .d.ts), `core` (logic other changed
 * files build on), `consumer` (uses the other changes: pages, controllers…), `test`, `config`,
 * `mechanical` (lockfiles, snapshots, generated files, pure renames: skim them) and `other` (docs, styles,
 * assets).
 */
export type ReviewRole = 'contract' | 'core' | 'consumer' | 'test' | 'config' | 'mechanical' | 'other';

/** One file in a review's reading order. */
export interface ReviewStep {
  file: string;
  /** 1-based position in the reading order. */
  order: number;
  /** 1-based index into `ReviewPlan.groups` (the independent change it belongs to). */
  group: number;
  role: ReviewRole;
  /** Why it matters, most important first: `changes signature of createOrder() used in 14 places`, `untested`… */
  reasons: string[];
  /** 0..100: how much attention it needs compared to the other steps (churn × complexity × users × untested). */
  risk: number;
  /** Added and removed lines that are not blank and not only a comment. */
  meaningfulLines: number;
  /** Changed functions, components, classes and types (names). */
  symbols: string[];
  /** Changed test files that cover it (placed right after it, or before it with `testFirst`). */
  tests?: string[];
  /** Blob id of the file at the reviewed head (the viewed state resets when it changes). */
  blob?: string;
  status?: ChangeStatus;
  oldPath?: string;
  additions?: number;
  deletions?: number;
  /** Marked as viewed for this head blob (`.code-visualizer/reviews/`). */
  viewed?: boolean;
}

/** `code-visualizer review <ref>`: how to read a branch or pull request, in dependency order. */
export interface ReviewPlan {
  /** The reviewed ref as given (`feature`, `pr/123`…). */
  ref: string;
  /** The ref it is compared to (`origin/main`). */
  base: string;
  /** Where the reviewed ref left `base` (full commit; '' when there is no common history). */
  mergeBase: string;
  /** Full commit of the reviewed head. */
  head?: string;
  /** The first file to read, and why. */
  startHere?: { file: string; reason: string };
  steps: ReviewStep[];
  /** Files to glance at only: lockfiles, snapshots, generated files, pure renames, comment-only edits. */
  skim: { file: string; reason: string; blob?: string; viewed?: boolean }[];
  /** Independent changes (connected components of the changed files), riskiest first. */
  groups: ReviewGroup[];
  /** Reading time at 400 meaningful lines per hour, and a level from 1 (≤ 50 lines) to 5 (> 800). */
  effort: { minutes: number; level: 1 | 2 | 3 | 4 | 5; meaningfulLines: number };
  /** Export (API) changes, breaking ones with the importers and call sites that were not updated. */
  apiChanges: ExportChange[];
  delta?: ArchitectureDelta;
  /** Changed functions (symbol ids) whose files no changed test covers. */
  untestedChanges: string[];
  /** Markdown checklist items, one per step (without the `- [ ]` prefix). */
  checklist: string[];
  /** Tests are placed before the code they cover. */
  testFirst?: boolean;
  /** Commits between the merge-base and the head (newest first). */
  commits?: CommitInfo[];
  /** The changed files with their diffs (live server only). */
  files?: ChangedFile[];
  additions?: number;
  deletions?: number;
  /** Notes about how the plan was made (e.g. the comparison with the base failed). */
  warnings?: string[];
}

/** One independent change of a review (or the trailing configuration and other files). */
export interface ReviewGroup {
  index: number;
  title: string;
  files: string[];
  /** Meaningful lines. */
  lines: number;
  risk?: number;
  kind?: 'change' | 'other';
}

export interface ChangeSet {
  /** The suggested reading order of the change (review-mode; at most 300 steps). */
  readingOrder?: ReviewStep[];
  /** Changed files that only need a glance (lockfiles, snapshots, generated files, renames…), with the reason. */
  readingSkim?: { file: string; reason: string }[];
  /** The parts of the reading order (`ReviewStep.group` is an index into these), without their files. */
  readingGroups?: Omit<ReviewGroup, 'files'>[];
}

export interface ChangedFile {
  /** Blob id of the file in the compared head commit (review-mode; not set for working-tree changes). */
  blob?: string;
}

/** `.code-visualizer/reviews/<sha1(ref)>.json`: files marked as viewed, with the blob they were viewed at. */
export interface ReviewState {
  ref: string;
  /** File → blob id at the time it was marked viewed ('' for a deleted file). */
  viewed: Record<string, string>;
  updatedAt?: number;
}

/** A branch (or fetched pull / merge request) worth reviewing, for the reviewer's ref picker. */
export interface ReviewRef {
  /** What to pass to `review` (`feature`, `origin/feature`, `#123`, `!45`). */
  ref: string;
  /** Full ref name (`refs/remotes/origin/feature`). */
  name: string;
  commit: string;
  /** Committer date of the tip (ms). */
  date: number;
  author: string;
  subject: string;
  /** Pushed by a coding agent (copilot/*, codex/*, claude/* …). */
  agent: boolean;
  remote: boolean;
  /** The branch you have checked out. */
  current?: boolean;
}

// --- daily-loop ---

/**
 * One line of ambient status for shell prompts, tmux and agent status lines (`code-visualizer status`).
 * Stored in `.code-visualizer/state.json` → `status` (written by `status --refresh` and by `serve`), and
 * returned by `GET /api/status` of a running server.
 */
export interface StatusSnapshot {
  version: 1;
  /** When the analysis behind it started (ms since the epoch). */
  generatedAt: number;
  /** Full hash of HEAD when the analysis ran (a different HEAD makes a stored snapshot stale). */
  head?: string;
  branch?: string;
  /** `delta`: compared with the base of your work (negative = worse); 0 without a base. */
  health: { score: number; delta: number };
  /** Your work: changed files, files they affect, tests to run, risk. Absent when nothing changed. */
  changes?: { files: number; impacted: number; tests: number; risk: number; level: 'low' | 'medium' | 'high' };
  /** Problems your work adds compared with its base. */
  problems: { newCycles: number; newViolations: number };
  /**
   * The branch your work goes into (`origin/main`), how far you are apart and what a rebase would do;
   * `semantic`: incoming changes that merge cleanly but break code you changed (from the latest `sync`).
   */
  upstream?: { name: string; ahead: number; behind: number; conflicts?: number; overlap?: number; semantic?: number };
  /** From `.code-visualizer/state.json` → `lastTest` (written by `code-visualizer test`). */
  lastTest?: Pick<LastTestState, 'at' | 'passed' | 'treeId'>;
  lastCheck?: { at: number; ok: boolean };
  /** Patch coverage of your changes (or line coverage of the project), percent. */
  coverage?: number;
  /** A running `serve`: its page and the number of problems its live guard still has open. */
  live?: { url: string; open?: number };
  /** mtime of the git index when the snapshot was taken (staging something makes it stale). */
  indexMtime?: number;
  /** The latest refresh failed (the numbers are from an earlier one). */
  error?: string;
  /**
   * The working tree the snapshot describes (`workingTreeId`; set by `status --refresh`): a passing test run
   * of the same tree is current although it ran before the snapshot was taken.
   */
  treeId?: string;
}

/** A focused test, a `debugger` statement or a merge conflict marker on a line your change adds (hygiene gate). */
export interface HygieneFinding {
  file: string;
  line: number;
  kind: 'focused-test' | 'debugger' | 'conflict-marker';
  /** The added line (trimmed, capped). */
  text: string;
}

/** An incoming change on the base branch that breaks code you changed, although git merges it cleanly. */
export interface SyncSemanticChange {
  kind: 'signature-changed' | 'export-removed' | 'route-removed';
  /** The file on the base branch that changed. */
  file: string;
  /** Export name, or the route (`GET /api/users/:id`). */
  symbol?: string;
  /**
   * Short hash and author of the incoming commit that changed it: the newest whose diff declares (else
   * mentions) the symbol, else the newest that touched the file.
   */
  commit?: string;
  author?: string;
  /** `formatPrice(value) → formatPrice(value, currency)`. */
  message: string;
  /**
   * Where your changed files use it, by file and line (for a changed signature: the calls whose argument
   * count no longer fits, when there are any). `kind`: a call (or render), an import, or an HTTP request.
   */
  yourSites: { file: string; line: number; kind?: 'call' | 'import' | 'http' }[];
}

/** A teammate's branch that touches files you changed (`sync --branches`). */
export interface SyncBranch {
  ref: string;
  author: string;
  /** Last commit time (ms since the epoch). */
  updated: number;
  /** Files it changes that you changed too. */
  files: string[];
  /** A trial merge of HEAD and the branch (`clean` when git is too old to tell and files only overlap). */
  result: 'clean' | 'conflict';
  /**
   * Files the branch itself changes that conflict with your work (committed, or uncommitted edits that
   * would not re-apply), also when the base conflicts in the same file; conflicts that only the base
   * brings are reported once, on the report.
   */
  conflictFiles: string[];
  /** `clean` was checked by a trial merge (false: git older than 2.38, or uncommitted edits it could not merge). */
  verified?: boolean;
}

/** `code-visualizer sync`: what is coming from the base branch, and what a rebase would do to your work. */
export interface SyncReport {
  base: string;
  /** Full hash of the merge-base of HEAD and the base ('' when they share no history). */
  mergeBase: string;
  /** Commits on the base that you do not have / commits you have that the base does not. */
  behind: number;
  ahead: number;
  /** How long ago the remote was last fetched (ms; absent when it was never fetched). */
  fetchedAgo?: number;
  /** Incoming commits on the base, newest first (capped). */
  incoming: CommitInfo[];
  /**
   * Files a rebase or merge would conflict in: your commits (trial merge with `git merge-tree`), your
   * uncommitted edits that would not re-apply after it (`local: 'uncommitted'`, a 3-way merge on the side),
   * or untracked files incoming commits add (`local: 'untracked'`: the rebase stops before it).
   */
  conflicts: { file: string; local?: 'uncommitted' | 'untracked' }[];
  /**
   * Files you changed (committed or not) that incoming commits change too, without a conflict. `clean`:
   * a trial merge showed they merge; `local: 'uncommitted'`: your changes to it are not committed.
   */
  overlap: { file: string; commits: string[]; local?: 'uncommitted'; clean?: boolean }[];
  semantic: SyncSemanticChange[];
  branches?: SyncBranch[];
  /** The next step, e.g. `git rebase origin/main`. */
  recommendation?: string;
  // Optional extras (daily-loop).
  /** Full hash the base pointed to. */
  baseCommit?: string;
  /** HEAD when the report was made. */
  head?: string;
  /** Authors of the incoming commits with their commit counts, most first. */
  authors?: { name: string; commits: number }[];
  /** `merge-tree`: a real trial merge (git ≥ 2.38); `files`: only files changed on both sides were compared. */
  method?: 'merge-tree' | 'files';
  /** Remarks: fetch hints, semantic analysis that could not run… */
  notes?: string[];
  generatedAt?: number;
}

/** `.code-visualizer/state.json` → `sync`: the latest `sync` in short, for status lines. */
export interface SyncState {
  at: number;
  head?: string;
  base: string;
  baseCommit?: string;
  ahead: number;
  behind: number;
  conflicts: number;
  overlap: number;
  semantic: number;
}


// --- clone-radar ---

/** One copy of duplicated code: a line range and the declaration it sits in. */
export interface CloneFragment {
  file: string;
  /** First and last line of the copy (1-based, inclusive). */
  start: number;
  end: number;
  /** Id of the enclosing symbol (`src/a.ts#slugify`), when the copy is inside a declaration. */
  symbol?: string;
  /** The enclosing declaration as people name it: `slugify`, `CartService.checkout` (a class member). */
  name?: string;
  /** The enclosing symbol is exported. */
  exported?: boolean;
  /** Files that import the enclosing symbol (exported symbols only). */
  importers?: number;
  /** In `ArchitectureDelta.newClones`: this copy is new since the base (its declaration was in no clone family there). */
  isNew?: boolean;
}

/**
 * Code that exists more than once ("copy-paste clones"): token sequences that are equal once identifiers
 * and literals are normalized, possibly with small edits in between (near-miss clones).
 */
export interface CloneFamily {
  /** Fingerprint of the normalized token sequence the copies share (no lines, no paths). */
  id: string;
  /** Tokens the copies share (the largest match between two of them). */
  tokens: number;
  /** Lines of the longest copy. */
  lines: number;
  /**
   * 0..1: shared tokens / tokens of the larger enclosing declaration (1: the whole declaration is a copy) —
   * of the most similar pair of copies (`pairs` has each pair's own).
   */
  similarity: number;
  fragments: CloneFragment[];
  /** How often files of the family were committed together (change coupling): edited in lockstep, so drift risk. */
  coChanges?: number;
  /**
   * The copies that were found to be clones of each other (indexes into `fragments`) and their similarity:
   * a family can join a whole-function copy and a block shared with a third declaration.
   */
  pairs?: ClonePair[];
}

/** Two copies of a clone family (indexes into `CloneFamily.fragments`) and how similar they are (0..1). */
export interface ClonePair {
  a: number;
  b: number;
  similarity: number;
}

/** A declaration similar to a snippet or a range of a file (`code-visualizer similar`, MCP `find_similar`). */
export interface SimilarMatch {
  /** Symbol id (`src/lib/strings.ts#slugify`). */
  symbol: string;
  file: string;
  line: number;
  /** Display name: `slugify`, `CartService.checkout`. */
  name: string;
  /** 0..1: shared tokens / tokens of the larger of the snippet and the declaration. */
  similarity: number;
  signature: string;
  /** Files that import it (0 for symbols that are not exported). */
  importers: number;
  // Optional extras (clone-radar).
  endLine?: number;
  exported?: boolean;
  /** 0..1: how much of the snippet is found in this declaration (high for a block copied out of a larger function). */
  contained?: number;
}

/** A clone family your change touched in one copy while another copy stayed as it was (`ChangeSet.cloneDrift`). */
export interface CloneDrift {
  changed: CloneFragment;
  untouched: CloneFragment[];
  // Optional extras (clone-radar).
  /** `CloneFamily.id`. */
  family?: string;
  similarity?: number;
  coChanges?: number;
}

export interface Insights {
  /** Copy-paste clone families, most worth fixing first (changed together most often, then the largest); capped. */
  clones?: CloneFamily[];
}

export interface Stats {
  /** Lines of source files (tests left out) that are part of a clone family. */
  duplicatedLines?: number;
}

export interface HistoryPoint {
  /** Share of the source lines (tests left out) that are copies (0..1). */
  duplication?: number;
}

export interface ChangeSet {
  /** Clone families where your change edited one copy and not the others: fix the bug in every copy. */
  cloneDrift?: CloneDrift[];
}

export interface ArchitectureDelta {
  /** Clone families the head has that the base did not (copied code; `isNew` marks the new copies). */
  newClones?: CloneFamily[];
  /** Clone families of the base that are gone (the copies were merged or removed). */
  fixedClones?: CloneFamily[];
  /**
   * Clone families of the base that stopped matching because the change edited one copy and left the
   * others as they were (clone drift; they are not counted as fixed).
   */
  driftedClones?: CloneDrift[];
}

export interface LiveEventKinds {
  /** New copy-paste code: a declaration that duplicates existing code (import that instead). */
  'clone-added': true;
}

// --- agent-guardrails ---

/** One architecture rule as the configuration states it (`ReportData.config.ruleList`), for briefs and AGENTS.md. */
export interface RuleListEntry {
  name: string;
  from: string[];
  to: string[];
  allow?: string[];
  severity: 'error' | 'warn';
  message?: string;
  /** `false`: type-only imports are allowed (`includeTypes: false` in the rule). */
  includeTypes?: boolean;
}

/**
 * What an agent guardrail hook found about an edit: `block` findings refuse the edit before it is written
 * (pre-edit), `inform` findings are told to the agent as context.
 */
export interface GuardFinding {
  kind: 'forbidden-import' | 'layer' | 'new-cycle' | 'undeclared-package' | 'breaking-export' | 'removed-route' | 'complexity-jump' | 'untested-export' | 'clone';
  severity: 'block' | 'inform';
  file: string;
  line?: number;
  /** One statement, e.g. `src/ui/Cart.tsx must not import src/db/client.ts (rule no-db-in-ui).` */
  message: string;
  /** The allowed alternative or the next step, e.g. `src/services/cart.ts exports getCart(), which already uses src/db/client.ts.` */
  fix?: string;
  /** Identity of the finding (src/shared/fingerprint.ts) when it is one `check` knows: problems the session started with are not reported. */
  fingerprint?: string;
  /** Identity within an agent session: a finding is told once (until its details change). */
  key?: string;
}

/**
 * `.code-visualizer/sessions/<id>.json`: the state of the project when an agent session started, so the
 * post-edit radar and the stop gate report only what the session changed.
 */
export interface AgentSession {
  id: string;
  startedAt: number;
  /** HEAD when the session started. */
  head?: string;
  branch?: string;
  /** Finding fingerprints at the start (cycles, rule violations, missing packages, complex functions). */
  fingerprints: string[];
  /** Signatures of exported functions at the start (symbol id → signature). */
  exports: Record<string, string>;
  /** Files that differed from HEAD at the start → `mtimeMs:size`, so unchanged ones are not the session's work. */
  dirty?: Record<string, string>;
  /** Texts of the files the session edited, as they were before its first edit (`null`: did not exist). */
  originals?: Record<string, string | null>;
  /** Keys of the post-edit findings already told (each is told once). */
  reported?: string[];
  /** Post-edit findings for clients that cannot take context after an edit (Cursor): relayed when the agent stops. */
  pending?: string[];
}

// --- integration (wave 4): clone-radar × daily-loop ---

export interface StatusSnapshot {
  /**
   * Copy-paste your work adds compared with its base (`changes.delta.newClones`) and copies it changed while
   * their clone stayed as it was (`changes.cloneDrift`). Absent when there is neither.
   */
  clones?: { new: number; drift: number };
}

export interface ReviewPlan {
  /**
   * Clone families the reviewed change edited in one copy only (`ChangeSet.cloneDrift`, which includes the
   * copies that no longer match): the same fix may be missing in the other copy.
   */
  cloneDrift?: CloneDrift[];
}

// --- release fixes: clone accuracy ---

export interface Insights {
  /**
   * Fingerprints too common to find copy-paste clones with in this analysis (found in more than 50
   * declarations), ascending. A delta judges its head with the base's, so a copy that tips one over the
   * limit does not hide itself.
   */
  cloneBoilerplate?: number[];
}

// --- release fixes: status line details ---

export interface StatusSnapshot {
  /**
   * The tests `changes.tests` counts (what `code-visualizer test` runs): their ids — up to
   * MAX_REQUIRED_TESTS (src/shared/status.ts), beyond that only how many and a hash of the sorted list.
   */
  requiredTests?: { count: number; hash: string; files?: string[] };
  /** How many of `requiredTests` the last test run covered (by path, or its package in full); set by `withState`. */
  testsCovered?: number;
  /** `coverage` is the patch coverage of your changes, or the project's line coverage. */
  coverageKind?: 'patch' | 'project';
  /** The coverage report is older than files it describes (rerun the tests with coverage). */
  coverageStale?: boolean;
}

// --- dev-tools: environment variables, security and type-safety scan, release plan, licenses ---

/** How a variable is read: `process.env.X`, `import.meta.env.X`, `Deno.env.get('X')`, `Bun.env.X`. */
export type EnvAccess = 'process.env' | 'import.meta.env' | 'Deno.env' | 'Bun.env';

/** One read of an environment variable in a file (`ParsedFile.env`). */
export interface EnvRead {
  name: string;
  line: number;
  access: EnvAccess;
  /** The read has a default (`process.env.X || 'a'`, `?? 'a'`, `const { X = 'a' } = process.env`). */
  fallback?: boolean;
}

/** Where a variable is read, and how. */
export interface EnvUse {
  file: string;
  line: number;
  access: EnvAccess;
  fallback?: boolean;
}

/** An environment variable the code reads, or a template declares. Only names are kept, never values. */
export interface EnvVar {
  name: string;
  /** Reads in the code (capped; see `useCount`). */
  uses: EnvUse[];
  useCount: number;
  fileCount: number;
  /** The `.env*` files that declare it (project-relative). */
  declaredIn: string[];
  /** A committed template (`.env.example`, `.env.sample`…) declares it. */
  documented: boolean;
  /** Some read has no default: the code needs the variable. */
  required: boolean;
  /** Provided by the runtime or the platform (`NODE_ENV`, `CI`, `GITHUB_*`…): nothing to document. */
  platform?: boolean;
  /** Reaches the browser bundle (a framework's public prefix, or read through `import.meta.env`). */
  exposed?: boolean;
  /** The name looks like a secret (`*_SECRET`, `*_TOKEN`, `*_PASSWORD`…). */
  secretLike?: boolean;
}

/** A dotenv file (`.env`, `.env.example`…): its variable names. */
export interface EnvFile {
  path: string;
  /** A committed template (`.env.example`, `.env.sample`, `.env.template`, `.env.defaults`). */
  template: boolean;
  names: string[];
}

export interface EnvReport {
  /** Variables read by code first (most used first), then declared-only ones. */
  vars: EnvVar[];
  files: EnvFile[];
  /** Read without a default, and declared by no template (what a new teammate has to guess). */
  undocumented: string[];
  /** Declared by a template and never read by the code. */
  unused: string[];
  /** Exposed to the browser and named like a secret. */
  exposedSecrets: string[];
}

export interface ReportData {
  /** Environment variables the code reads and the dotenv files that declare them. */
  env?: EnvReport;
}

export type RiskRule = 'hardcoded-secret' | 'hardcoded-credential' | 'eval' | 'html-injection' | 'shell-injection' | 'sql-injection' | 'tls-disabled';

export type RiskSeverity = 'high' | 'medium' | 'low';

/** A risky pattern as the parser found it (`ParsedFile.risks`). */
export interface RawRisk {
  rule: RiskRule;
  line: number;
  /** The line of code with secrets masked. */
  snippet: string;
  /** Rule-specific detail, e.g. which kind of secret. */
  detail?: string;
}

export interface RiskFinding extends RawRisk {
  severity: RiskSeverity;
  file: string;
  /** In a test, fixture, mock or example: usually harmless, so the UI hides it by default. */
  test?: boolean;
}

/** Ways a file switches the type checker or the linter off. */
export interface TypeEscapes {
  /** Explicit `any` (`: any`, `as any`, `<any>`, `any[]`). */
  any: number;
  /** Non-null assertions (`value!`). */
  nonNull: number;
  /** `@ts-ignore` and `@ts-nocheck`. */
  tsIgnore: number;
  /** `@ts-expect-error`. */
  tsExpectError: number;
  /** `eslint-disable` comments. */
  lintDisable: number;
}

export interface FileInfo {
  /** Set when the file has at least one escape hatch. */
  escapes?: TypeEscapes;
}

export interface Insights {
  /** Risky patterns (secrets, injection, disabled TLS…), most severe first; capped at MAX_RISKS. */
  risks?: RiskFinding[];
  /** How many findings were left out of `risks` by the cap. */
  risksOmitted?: number;
}

export type LicenseRisk = 'permissive' | 'weak-copyleft' | 'copyleft' | 'proprietary' | 'unknown';

export interface PackageInfo {
  /** The version found in node_modules (when installed), which can differ from the declared range. */
  installed?: string;
  /** SPDX expression from the installed package.json. */
  license?: string;
  licenseRisk?: LicenseRisk;
  /** `preinstall` / `install` / `postinstall` scripts the package runs when installed. */
  installScripts?: string[];
}

export type ReleaseBump = 'major' | 'minor' | 'patch' | 'none';

export type CommitType = 'feat' | 'fix' | 'perf' | 'refactor' | 'docs' | 'test' | 'build' | 'ci' | 'chore' | 'style' | 'revert' | 'other';

/** A commit since the last release, read as a Conventional Commit when it is one. */
export interface ReleaseCommit {
  hash: string;
  author: string;
  date: number;
  /** The subject as written. */
  subject: string;
  /** The subject without `type(scope):`, `!` and the trailing `(#123)`. */
  description: string;
  type: CommitType;
  scope?: string;
  /** `type!:` or a `BREAKING CHANGE:` footer. */
  breaking?: boolean;
  /** Pull or merge request number from `(#123)`. */
  pr?: number;
}

export interface ReleaseCheck {
  id: string;
  ok: boolean;
  label: string;
  detail?: string;
}

/** What the next release contains and which version number it deserves. */
export interface ReleasePlan {
  /** The latest version tag reachable from HEAD; undefined when the project has none. */
  tag?: string;
  tagDate?: number;
  /** The tag's version without the `v`. */
  lastVersion?: string;
  /** `version` in package.json. */
  packageVersion?: string;
  /** Commits since the tag, newest first (capped; `commitCount` is the real number). */
  commits: ReleaseCommit[];
  commitCount: number;
  bump: {
    level: ReleaseBump;
    /** The next version, when the last one is known. */
    next?: string;
    /** From the commit types (breaking, feat, fix). */
    fromCommits: ReleaseBump;
    /** From the changes of the published API, when the tag could be analyzed. */
    fromApi?: ReleaseBump;
    reasons: string[];
  };
  /** Changes to exported declarations since the tag, breaking ones first. */
  apiChanges: ExportChange[];
  /** New or fixed problems since the tag (cycles, rule breaks) and the state of the working tree. */
  checks: ReleaseCheck[];
  /** `https://github.com/org/repo/compare/v1.2.0...HEAD`-style link when the remote is known. */
  compareUrl?: string;
  warnings?: string[];
}

export interface ReportData {
  /** What the next release contains (only with the `release` analysis option: `serve` and `report`). */
  release?: ReleasePlan;
}

// --- dev-companion: git insights, GitHub Actions workflows, AI assistant tools ---

/** A local or remote-tracking branch with its distance from the base branch (`RepoInsights.branches`). */
export interface BranchInfo {
  /** `feature/login`, or `origin/feature/login` for a remote-tracking branch. */
  name: string;
  remote: boolean;
  current?: boolean;
  /** Short hash of the tip. */
  hash: string;
  /** Committer date of the tip (ms). */
  date: number;
  author: string;
  subject: string;
  upstream?: string;
  /** Commits the branch has that the base branch does not. */
  ahead: number;
  /** Commits the base branch has that the branch does not. */
  behind: number;
  /** Every commit of the branch is already in the base branch: deleting it loses nothing. */
  merged: boolean;
  /** The remote branch this one tracked was deleted. */
  gone?: boolean;
  /** Commits not yet pushed to its upstream. */
  unpushed?: number;
  /** Checked out in another worktree (absolute path). */
  worktree?: string;
  /** The base branch, the current branch or one checked out in a worktree: never offered for deletion. */
  protected?: boolean;
}

export interface StashInfo {
  /** `stash@{0}`. */
  ref: string;
  message: string;
  /** Date of the stash (ms). */
  date: number;
  /** Files in the stash (capped; see `fileCount`). */
  files: string[];
  fileCount: number;
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
  detached?: boolean;
  locked?: boolean;
  /** The folder is gone: `git worktree prune` removes the record. */
  prunable?: boolean;
  /** The main working tree. */
  main?: boolean;
}

/** A commit no branch, tag or remote reaches any more; only the reflog remembers it (lost work). */
export interface RescueCommit {
  hash: string;
  date: number;
  author: string;
  subject: string;
}

/** How the team writes commit messages (`RepoInsights.style`, from the latest commits). */
export interface CommitStyle {
  analyzed: number;
  merges: number;
  /** Subjects that follow Conventional Commits (`type(scope): text`). */
  conventional: number;
  types: Partial<Record<CommitType, number>>;
  withBody: number;
  /** Subjects longer than 72 characters. */
  longSubjects: number;
  /** `wip`, `fixup!`, `squash!`, `tmp`… commits that probably should not be in the history. */
  wip: number;
  reverts: number;
  /** Subjects that end in a pull request number (`(#123)`). */
  prRefs: number;
  coAuthored: number;
  /** Average subject length in characters. */
  avgSubject: number;
}

export type UnwantedKind = 'secret' | 'dependency' | 'build' | 'junk';

/** What is tracked in the repository that should not be, and how heavy it is. */
export interface GitHygiene {
  trackedFiles: number;
  /** A file, or a whole folder (`node_modules/`, with the number of files in it as `count`). */
  unwanted: { path: string; kind: UnwantedKind; count?: number }[];
  /** The biggest tracked files over the size limit, biggest first. */
  large: { path: string; size: number }[];
  /** `git count-objects -v`: size of the packs, and loose objects that `git gc` would pack. */
  objects: { packKiB: number; looseKiB: number; loose: number; packs: number };
  gitignore: boolean;
}

/** A recommended git setting and what it is now. Only whitelisted keys are ever read; no values of other keys are kept. */
export interface ConfigAdvice {
  key: string;
  label: string;
  /** `ok`: set as recommended (or to something equivalent); `missing`: not set; `differs`: set to another value. */
  status: 'ok' | 'missing' | 'differs';
  /** The current value (never kept for the e-mail address: `set` says whether it exists). */
  value?: string;
  recommended?: string;
  why: string;
  /** Ready-to-paste command that applies the recommendation. */
  command?: string;
  /** Without it git cannot work properly (user.name, user.email). */
  essential?: boolean;
}

export interface RepoInsights {
  /** The branch the others are compared with (`main`, `master`, or the remote's default). */
  base: string;
  /** Local branches first (newest first), then remote ones; capped (see `branchTotals` for real numbers). */
  branches: BranchInfo[];
  /** `false` with git older than 2.41: the branches carry no ahead / behind counts (merged or not is still known). */
  aheadBehind: boolean;
  branchTotals: { local: number; remote: number; merged: number; gone: number };
  stashes: StashInfo[];
  worktrees: WorktreeInfo[];
  /** Commits only the reflog still has, newest first (capped). */
  rescue: RescueCommit[];
  style: CommitStyle;
  hygiene: GitHygiene;
  config: ConfigAdvice[];
}

export interface ReportData {
  /** Branches, stashes, lost commits, commit style and git settings (only with the `repo` analysis option). */
  repo?: RepoInsights;
}

/** One entry of the git "needs attention" list (`repoAttention` in src/shared/git-insights.ts). */
export interface RepoAttention {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail?: string;
  /** Command that fixes it (copyable). */
  command?: string;
}

/** A GitHub Actions event that starts a workflow, with its filters. */
export interface WorkflowTrigger {
  event: string;
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
  /** Activity types (`opened`, `synchronize`, `published`…). */
  types?: string[];
  /** `schedule`: cron expressions (UTC). */
  cron?: string[];
  /** `workflow_dispatch` / `workflow_call`: input names. */
  inputs?: string[];
  /** `workflow_run`: the workflows it follows. */
  workflows?: string[];
}

export interface WorkflowStep {
  line: number;
  name?: string;
  id?: string;
  uses?: string;
  /** The command (secrets masked, cut at 400 characters). */
  run?: string;
  shell?: string;
  if?: string;
  /** `with:` inputs of an action (only plain values; secrets masked, cut at 160 characters). */
  with?: Record<string, string>;
  workingDirectory?: string;
  continueOnError?: boolean;
}

export interface WorkflowMatrix {
  dims: { name: string; values: string[] }[];
  /** Jobs the matrix creates (an estimate when `dynamic`). */
  combos: number;
  /** A dimension comes from an expression (`fromJSON(...)`), so its size is unknown. */
  dynamic?: boolean;
  includes: number;
  excludes: number;
  failFast?: boolean;
}

export interface WorkflowJob {
  id: string;
  name?: string;
  line: number;
  runsOn: string[];
  needs: string[];
  /** A reusable workflow this job calls (`uses: org/repo/.github/workflows/x.yml@v1` or `./.github/workflows/x.yml`). */
  uses?: string;
  if?: string;
  matrix?: WorkflowMatrix;
  /** `read-all`, `write-all`, or `contents: write, id-token: write`. */
  permissions?: string;
  timeoutMinutes?: number;
  environment?: string;
  container?: string;
  services: string[];
  outputs: string[];
  steps: WorkflowStep[];
  /** Node.js versions its `actions/setup-node` steps install, resolved through the matrix. */
  nodeVersions?: string[];
  continueOnError?: boolean;
  concurrency?: boolean;
}

export interface WorkflowInfo {
  /** Path from the repository root (`.github/workflows/ci.yml`). */
  file: string;
  name: string;
  triggers: WorkflowTrigger[];
  jobs: WorkflowJob[];
  permissions?: string;
  concurrency?: boolean;
  /** Names of the variables the workflow sets (values are never kept). */
  env: string[];
  /** `secrets.X` and `vars.X` it reads. */
  secrets: string[];
  variables: string[];
  /** Node versions its `actions/setup-node` steps install, resolved through matrices (`20`, `22.x`). */
  nodeVersions?: string[];
  lines: number;
  /** The file is not valid YAML. */
  error?: { message: string; line: number };
}

export type WorkflowSeverity = 'error' | 'warning' | 'info';

export interface WorkflowFinding {
  /** `script-injection`, `unpinned-action`, `missing-script`… (WORKFLOW_RULES in src/shared/workflows.ts). */
  rule: string;
  severity: WorkflowSeverity;
  file: string;
  line?: number;
  job?: string;
  message: string;
}

export type ActionPin = 'sha' | 'tag' | 'branch' | 'none';

/** An action (or reusable workflow) the workflows use, with the versions in use. */
export interface ActionUse {
  /** `actions/checkout`, `./.github/actions/setup`, `docker://alpine`. */
  name: string;
  kind: 'marketplace' | 'local' | 'docker' | 'reusable';
  /** First-party: `actions/*` and `github/*`. */
  official: boolean;
  versions: { ref: string; pin: ActionPin; count: number }[];
  count: number;
  workflows: string[];
}

export interface LocalAction {
  /** Folder from the repository root (`.github/actions/setup`). */
  path: string;
  name?: string;
  description?: string;
  inputs: string[];
  usedBy: number;
}

/** A package.json script and where CI runs it. */
export interface ScriptUse {
  name: string;
  command?: string;
  runs: { file: string; job: string; line?: number }[];
}

export interface CiReport {
  /** The analyzed root relative to the repository root (`''` when they are the same folder). */
  base: string;
  workflows: WorkflowInfo[];
  actions: ActionUse[];
  localActions: LocalAction[];
  scripts: ScriptUse[];
  findings: WorkflowFinding[];
  dependabot?: { file: string; ecosystems: { name: string; directory: string; interval?: string }[] };
  /** Node versions the workflows test, resolved through matrices when possible. */
  nodeVersions: string[];
}

export interface ReportData {
  /** GitHub Actions workflows, how they connect and what is wrong with them (only with the `ci` analysis option). */
  ci?: CiReport;
}

export type AiItemKind = 'memory' | 'skill' | 'command' | 'agent' | 'mcp' | 'hook' | 'plugin';

/** `project`: committed with the repository; `local`: your own, git-ignored files in it; `user`: from `~/.claude`; `plugin`: from an installed plugin. */
export type AiScope = 'project' | 'local' | 'user' | 'plugin';

export interface AiItem {
  kind: AiItemKind;
  scope: AiScope;
  name: string;
  description?: string;
  /** Where it is defined: project-relative, or starting with `~/`. */
  path: string;
  /** What to type to use it: `/review-pr [number]`, `@code-reviewer`. */
  invoke?: string;
  /** When and how to use it, in a sentence or two. */
  usage: string;
  plugin?: string;
  /** Tools it is allowed to use. */
  tools?: string[];
  model?: string;
  /** Claude may start it on its own (skills, agents). */
  auto?: boolean;
  lines?: number;
  /** Rough size when loaded into the context window (characters / 4). */
  tokens?: number;
  /** How often Claude Code recorded using it (from `~/.claude.json`). */
  uses?: { count: number; last: number };
  /** Type of a server (`stdio`, `http`), hook event, matcher… */
  detail?: string;
  warning?: string;
}

/** Instructions written for another assistant (`AGENTS.md`, `.cursor/rules`, Copilot, Gemini…). */
export interface AiInstructionFile {
  tool: string;
  path: string;
  lines: number;
  tokens: number;
}

export interface ToolCheck {
  id: string;
  ok: boolean;
  label: string;
  detail?: string;
  /** A command or a short instruction that fixes it. */
  fix?: string;
}

export interface AiCatalog {
  items: AiItem[];
  instructions: AiInstructionFile[];
  /** Counts of the allow / deny / ask permission rules, and the default mode, from the project's Claude settings. */
  permissions?: { allow: number; deny: number; ask: number; mode?: string };
  checks: ToolCheck[];
  /** Items of `~/.claude` and installed plugins are included (opt out with `--no-personal-ai`). */
  personal: boolean;
  /** Rough tokens Claude loads at the start of every session (memory files and skill descriptions). */
  startupTokens: number;
}

export interface ReportData {
  /** Claude Code skills, commands, agents, MCP servers and hooks available here, and how to use them (only with the `ai` analysis option). */
  ai?: AiCatalog;
}

/** How `GET /api/git/search` looks through the history. */
export type GitSearchMode = 'text' | 'regex' | 'message' | 'author' | 'file';

export interface GitSearchCommit {
  hash: string;
  date: number;
  author: string;
  subject: string;
  /** The files it changed (the first few). */
  files: string[];
  fileCount: number;
}

export interface GitSearchResult {
  mode: GitSearchMode;
  query: string;
  commits: GitSearchCommit[];
  /** More commits match than were returned. */
  truncated: boolean;
}

/** `GET /api/git/commit`: one commit, with what it changed. */
export interface GitCommitDetail {
  hash: string;
  parents: string[];
  date: number;
  author: string;
  subject: string;
  body: string;
  files: { path: string; additions: number; deletions: number; binary?: boolean }[];
  fileCount: number;
  additions: number;
  deletions: number;
  /** Branches that contain it (the first few). */
  containedIn: string[];
}

/** `GET /api/git/standup`: your commits of the last days, from every branch. */
export interface GitStandupCommits {
  user?: string;
  commits: { hash: string; date: number; author: string; subject: string }[];
}

/** `POST /api/git/delete-branches`: what was deleted (with the commit, so it can be restored) and what was refused. */
export interface BranchDeleteResult {
  deleted: { name: string; hash: string }[];
  refused: { name: string; reason: string }[];
}
