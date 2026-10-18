import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import pc from 'picocolors';
import type { AnalyzeOptions, AnalyzeStage } from '../analyzer/index.js';
import type { ReportData, Stats } from '../shared/types.js';
import { VERSION } from '../version.js';

/*
 * Kept light on purpose: the help, `--version` and the agent hooks' no-op path load this module, so it
 * imports Node built-ins, picocolors and the version only (no server client, no analyzer).
 */

export interface CommandContext {
  argv: string[];
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  /** Names of all registered commands (daily-loop: `hooks` adds `test --push` to pre-push when `test` exists). */
  commands?: string[];
}

export interface Command {
  name: string;
  aliases?: string[];
  summary: string;
  run(ctx: CommandContext): Promise<number>;
}

export const isTTY = (stream: NodeJS.WriteStream = process.stdout): boolean => !!stream.isTTY && !process.env.CI;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function slug(value: string): string {
  return value.replace(/\.[^./]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
}

export const STAGE_LABELS: Record<AnalyzeStage, string> = {
  project: 'Reading project configuration',
  discover: 'Discovering source files',
  parse: 'Parsing files',
  link: 'Linking modules, components and symbols',
  git: 'Reading git history',
  changes: 'Looking at your changes',
  compare: 'Comparing with the base commit',
  insights: 'Computing insights',
  done: 'Done',
};

export class Progress {
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private text = '';
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly enabled: boolean,
  ) {}

  update(text: string): void {
    this.text = text;
    if (!this.enabled) return;
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), 80);
      this.timer.unref();
    }
    this.render();
  }

  private render(): void {
    this.frame = (this.frame + 1) % this.frames.length;
    this.stream.write(`\r\x1b[2K  ${pc.cyan(this.frames[this.frame])} ${this.text}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.enabled) this.stream.write('\r\x1b[2K');
  }
}

export function splitList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

/** parseArgs option specs shared by every command that analyzes a project. */
export const ANALYSIS_OPTIONS = {
  file: { type: 'string', short: 'f' },
  directory: { type: 'string', short: 'd' },
  dir: { type: 'string' },
  depth: { type: 'string' },
  exclude: { type: 'string', short: 'e', multiple: true },
  base: { type: 'string', short: 'b' },
  'no-git': { type: 'boolean' },
  'no-source': { type: 'boolean' },
  'no-changes': { type: 'boolean' },
  'no-history': { type: 'boolean' },
  'max-files': { type: 'string' },
  'no-cache': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  root: { type: 'string' },
} as const;

export type AnalysisValues = {
  file?: string;
  directory?: string;
  dir?: string;
  depth?: string;
  exclude?: string[];
  base?: string;
  'no-git'?: boolean;
  'no-source'?: boolean;
  'no-changes'?: boolean;
  'no-history'?: boolean;
  'max-files'?: string;
  'no-cache'?: boolean;
  quiet?: boolean;
  root?: string;
};

/** `CODE_VISUALIZER_NO_CACHE=1` turns the warm cache and server reuse off (like `--no-cache`). */
export function cacheDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CODE_VISUALIZER_NO_CACHE?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false' && v !== 'no';
}

/** Use the warm cache (and a running server) unless `--no-cache` or CODE_VISUALIZER_NO_CACHE says otherwise. */
export function persistFrom(noCache: boolean | undefined): boolean {
  return !noCache && !cacheDisabledByEnv();
}

export class UsageError extends Error {}

/**
 * test-intelligence: `--coverage <path>` values as absolute paths (undefined: auto-detect the reports). A
 * path that does not exist is a usage error: a typo or a missing CI artifact must not turn a patch-coverage
 * gate into "skipped".
 */
export function coveragePaths(values: string[] | undefined): string[] | undefined {
  const list = splitList(values);
  if (!list.length) return undefined;
  const paths = list.map((p) => path.resolve(p));
  const missing = paths.find((p) => !fs.existsSync(p));
  if (missing) throw new UsageError(`No coverage report at ${missing}.`);
  return paths;
}

export function analysisOptions(values: AnalysisValues, positionals: string[]): AnalyzeOptions & { root: string } {
  const root = resolveProjectRoot(process.cwd(), explicitRoot(values, positionals)).root;
  const file = values.file;
  const directory = values.directory ?? values.dir;
  if (file && directory) throw new UsageError('Use either --file or --directory, not both.');
  const depth = values.depth !== undefined ? Number(values.depth) : undefined;
  if (depth !== undefined && (!Number.isFinite(depth) || depth < 0)) throw new UsageError('--depth must be a positive number.');
  const maxFiles = values['max-files'] !== undefined ? Number(values['max-files']) : undefined;
  if (maxFiles !== undefined && (!Number.isFinite(maxFiles) || maxFiles < 1)) throw new UsageError('--max-files must be a positive number.');
  return {
    root,
    file,
    directory,
    depth,
    exclude: splitList(values.exclude),
    base: values.base,
    includeSource: !values['no-source'],
    git: !values['no-git'],
    changes: !values['no-changes'],
    history: !values['no-history'],
    maxFiles,
    persist: persistFrom(values['no-cache']),
    toolVersion: VERSION,
  };
}

/* -------------------------------------------------------------------------- */
/*                                Project root                                */
/* -------------------------------------------------------------------------- */

export interface ProjectLocation {
  /** The folder to analyze. */
  root: string;
  /** The enclosing git repository's root, if any (`git diff --name-only` prints paths relative to it). */
  gitRoot?: string;
}

export interface ResolvedRoot extends ProjectLocation {
  /** Given on the command line (positional root or `--root`): used as it is. */
  explicit: boolean;
  /** No explicit root and no project around the folder: the folder itself. */
  fallback?: boolean;
}

/**
 * The root the command line names: the positional root or `--root` (an absolute path). Both given and
 * different is a usage error — which one was meant?
 */
export function explicitRoot(values: { root?: string }, positionals: string[]): string | undefined {
  const positional = positionals[0];
  if (positional !== undefined && values.root !== undefined && path.resolve(positional) !== path.resolve(values.root)) {
    throw new UsageError(`Two project roots: "${positional}" and --root "${values.root}". Pass one of them.`);
  }
  const given = values.root ?? positional;
  return given === undefined ? undefined : path.resolve(given);
}

/**
 * The project a command run from `cwd` is about. An explicit root (positional or `--root`) always wins.
 * Otherwise the project around `cwd` (see `findProjectLocation`), so every command — report, check, test,
 * the queries — answers about the same project from any of its folders; outside any project, `cwd` itself.
 */
export function resolveProjectRoot(cwd: string, explicit?: string, home = os.homedir()): ResolvedRoot {
  if (explicit !== undefined) {
    const root = path.resolve(cwd, explicit);
    return { root, gitRoot: findProjectLocation(root, home)?.gitRoot, explicit: true };
  }
  const found = findProjectLocation(cwd, home);
  return found ? { ...found, explicit: false } : { root: path.resolve(cwd), explicit: false, fallback: true };
}

/**
 * `Analyzing the project in app/ — you are in app/src/utils/ (--root . analyzes only this folder)`: one line
 * when a command found the project above the current folder (undefined when it runs at the root, the root
 * was given, or the folder is not inside the project).
 */
export function rootNotice(root: string, explicit: boolean, cwd = process.cwd()): string | undefined {
  if (explicit) return undefined;
  const rel = path.relative(root, path.resolve(cwd));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const name = path.basename(root) || root;
  return `Analyzing the project in ${name}/ — you are in ${name}/${rel.split(path.sep).join('/')}/ (--root . analyzes only this folder)`;
}

/** Files that make a folder a project root: a package.json or a code-visualizer configuration. */
const ROOT_MARKERS = ['package.json', 'code-visualizer.config.json', '.code-visualizerrc.json', '.code-visualizerrc'];
/** Configurations next to which a `.code-visualizer/` folder also marks a root (projects without package.json). */
const STATE_DIR_PEERS = ['tsconfig.json', 'jsconfig.json', 'deno.json', 'deno.jsonc'];

/**
 * Whether `dir` is a project root. A `.code-visualizer/` folder alone is not: older versions wrote one into
 * whatever sub-folder a report ran in, and such a leftover must not cut later answers down to that folder.
 */
function isProjectRoot(dir: string): boolean {
  const has = (name: string): boolean => fs.existsSync(path.join(dir, name));
  return ROOT_MARKERS.some(has) || (has('.code-visualizer') && STATE_DIR_PEERS.some(has));
}

/**
 * The package globs of a workspace root (package.json `workspaces`, pnpm-workspace.yaml, lerna.json
 * `packages`); `[]` for roots that do not list them (nx.json, turbo.json, rush.json); undefined when
 * `dir` is no workspace root.
 */
function workspaceGlobs(dir: string): string[] | undefined {
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  const json = (file: string): Record<string, unknown> | undefined => {
    const text = read(file);
    try {
      return text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      return undefined;
    }
  };
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const ws = json('package.json')?.workspaces;
  if (ws) return strings(Array.isArray(ws) ? ws : (ws as { packages?: unknown }).packages);
  const pnpm = read('pnpm-workspace.yaml');
  if (pnpm !== undefined) return [...pnpm.matchAll(/^\s*-\s*['"]?([^'"#\s]+)/gm)].map((m) => m[1]);
  const lerna = json('lerna.json');
  if (lerna) return strings(lerna.packages).length ? strings(lerna.packages) : ['packages/*'];
  return ['nx.json', 'turbo.json', 'rush.json'].some((f) => fs.existsSync(path.join(dir, f))) ? [] : undefined;
}

/** Whether a workspace glob (`packages/*`, `apps/**`) covers the relative folder `rel`. */
function globCovers(glob: string, rel: string): boolean {
  if (glob.startsWith('!')) return false;
  const source = glob
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((part) => (part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')))
    .join('/');
  return new RegExp(`^${source}(/.*)?$`).test(rel);
}

/**
 * The project around `cwd` (which may be a sub-folder): the nearest folder with a package.json or a
 * code-visualizer configuration (a `.code-visualizer/` folder counts only next to a tsconfig, jsconfig or
 * deno config); but when that folder is a package of a workspace monorepo (package.json `workspaces`,
 * pnpm-workspace.yaml, lerna.json, nx.json, turbo.json) the outermost such workspace root up to the git
 * root, so code in the other packages that uses it is found. Else the git root. Undefined outside any project.
 */
export function findProjectLocation(cwd: string, home = os.homedir()): ProjectLocation | undefined {
  const start = path.resolve(cwd);
  const stop = path.resolve(home);
  let nearest: string | undefined;
  let outer: string | undefined;
  let gitRoot: string | undefined;
  for (let dir = start; ; ) {
    // Never the home folder or above (unless the walk starts there): a stray ~/package.json or
    // ~/.code-visualizer must not turn every project below it into one.
    if (dir === start || (dir !== stop && !stop.startsWith(`${dir}${path.sep}`))) {
      if (!nearest && isProjectRoot(dir)) nearest = dir;
      const globs = workspaceGlobs(dir);
      if (globs && nearest) {
        const rel = path.relative(dir, nearest).split(path.sep).join('/');
        if (!rel || !globs.length || globs.some((g) => globCovers(g, rel))) outer = dir;
      }
    }
    if (fs.existsSync(path.join(dir, '.git'))) {
      gitRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const root = outer ?? nearest ?? gitRoot;
  return root ? { root, gitRoot } : undefined;
}

/* -------------------------------------------------------------------------- */
/*                          Arguments and suggestions                         */
/* -------------------------------------------------------------------------- */

/** Edit distance with adjacent transpositions (Damerau-Levenshtein, optimal string alignment): `jsno` → `json` is 1. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[rows - 1][cols - 1];
}

/**
 * The candidate `value` was most likely meant as: at most 2 edits away (1 for words of up to 3 letters,
 * so `ls` does not become `who`); undefined when nothing is that close.
 */
export function didYouMean(value: string, candidates: Iterable<string>): string | undefined {
  const max = value.length <= 3 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(value.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return bestDistance <= max ? best : undefined;
}

type OptionSpecs = NonNullable<ParseArgsConfig['options']>;

/** `Unknown option --jsno. Did you mean --json?` for a parseArgs error (its own message otherwise). */
export function argsErrorMessage(error: unknown, options: OptionSpecs): string {
  const e = error as NodeJS.ErrnoException;
  if (e?.code !== 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return e?.message ?? String(error);
  const given = /option '([^']+)'/.exec(e.message)?.[1] ?? '';
  const name = given.replace(/=.*$/, '');
  // `--no-git` style switches are declared as options of their own; `-x` short flags compare with shorts.
  const candidates = name.startsWith('--')
    ? Object.keys(options).map((k) => `--${k}`)
    : Object.values(options)
        .map((o) => o.short)
        .filter((s): s is string => !!s)
        .map((s) => `-${s}`);
  const hint = name.startsWith('--') ? didYouMean(name.slice(2), candidates.map((c) => c.slice(2))) : undefined;
  return `Unknown option ${name || given}.${hint ? ` Did you mean --${hint}?` : ''}`;
}

/**
 * parseArgs with the conventions of every command (positionals allowed, unknown options refused). A bad
 * argument throws a UsageError that names the closest option: `Unknown option --jsno. Did you mean --json?`.
 */
export function parseCommandArgs<O extends OptionSpecs>(name: string, argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true as const, strict: true as const });
  } catch (error) {
    throw new UsageError(`${argsErrorMessage(error, options)}\n${pc.dim(`Run "code-visualizer ${name} --help" for usage.`)}`);
  }
}

export function banner(write: (line?: string) => void): void {
  write();
  write(`  ${pc.bold(pc.magenta('◆'))} ${pc.bold('code-visualizer')} ${pc.dim(`v${VERSION}`)}`);
  write();
}

export function healthLine(data: ReportData): string {
  const h = data.health;
  const color = h.score >= 80 ? pc.green : h.score >= 60 ? pc.yellow : pc.red;
  const prev = data.history.length > 1 ? data.history[data.history.length - 2] : undefined;
  let delta = '';
  if (prev) {
    const d = h.score - prev.score;
    delta = d > 0 ? pc.green(` ▲ ${d}`) : d < 0 ? pc.red(` ▼ ${-d}`) : pc.dim(' ±0');
    delta += pc.dim(' since last run');
  }
  return `Health ${color(pc.bold(`${h.score}/100`))} ${pc.dim(`(${h.grade})`)}${delta}`;
}

/** ' · warm (3 re-parsed)' / ' · from the running server' — how much of the analysis was reused. */
export function cacheNote(stats: Stats): string {
  const c = stats.cache;
  if (!c || c.source === 'cold') return '';
  if (c.source === 'server') return pc.dim(' · from the running server');
  return pc.dim(` · warm${c.parsed ? ` (${c.parsed} re-parsed)` : ''}`);
}

/**
 * One line about nested fixture / example projects that were left out, e.g. "excluded 6 sub-projects
 * (test/fixtures/*) — set "includeSubprojects": true in code-visualizer.config.json to analyze them".
 * Silent when the configuration already says `"includeSubprojects": false`.
 */
export function subprojectNotice(data: ReportData): string | undefined {
  const dirs = data.project.subprojects ?? [];
  const setting = data.config?.includeSubprojects;
  if (!dirs.length || setting === false) return undefined;
  const groups = new Map<string, string[]>();
  for (const dir of dirs) {
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    groups.set(parent, [...(groups.get(parent) ?? []), dir]);
  }
  const labels = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([parent, members]) => (members.length > 1 && parent ? `${parent}/*` : members.join(', ')));
  const shown = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ', …' : '');
  const what = `excluded ${dirs.length} sub-project${dirs.length === 1 ? '' : 's'} (${shown})`;
  if (Array.isArray(setting)) return `${what} — not matched by "includeSubprojects"`;
  const file = data.config?.file && !data.config.file.startsWith('package.json') ? data.config.file : 'code-visualizer.config.json';
  return `${what} — set "includeSubprojects": true in ${file} to analyze ${dirs.length === 1 ? 'it' : 'them'}`;
}

export function changesLine(data: ReportData): string | undefined {
  const c = data.changes;
  if (!c || !c.files.length) return undefined;
  const parts = [
    `${c.files.length} changed file${c.files.length === 1 ? '' : 's'}`,
    c.impacted.length ? `affects ${c.impacted.length} more` : undefined,
    c.tests.files.length ? `${c.tests.files.length} test${c.tests.files.length === 1 ? '' : 's'} to run` : undefined,
    // test-intelligence: how much of the added code a test ran (local coverage report).
    c.coverage?.coverable ? `patch coverage ${Math.round(c.coverage.pct * 10) / 10}%${c.coverage.stale ? ' (outdated report)' : ''}` : undefined,
    `risk ${c.risk.level === 'high' ? pc.red(c.risk.level) : c.risk.level === 'medium' ? pc.yellow(c.risk.level) : pc.green(c.risk.level)}`,
  ].filter(Boolean);
  const where = c.mode === 'branch' && c.base ? pc.dim(` (vs ${c.base})`) : pc.dim(' (uncommitted)');
  return `Your work: ${parts.join(pc.dim(' · '))}${where}`;
}

/** Copy text to the system clipboard (pbcopy / clip / wl-copy / xclip / xsel). */
export function copyToClipboard(text: string): Promise<boolean> {
  const candidates: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  const attempt = (i: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (i >= candidates.length) return resolve(false);
      const [cmd, args] = candidates[i];
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.once('error', () => resolve(attempt(i + 1)));
      child.once('close', (code) => resolve(code === 0 ? true : attempt(i + 1)));
      child.stdin.end(text);
    });
  return attempt(0);
}
