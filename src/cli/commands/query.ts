import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import {
  fileOfSymbol,
  filesOfTarget,
  impactOf,
  importPath,
  resolveTarget,
  routeFor,
  symbolRef,
  targetLabel,
  targetLocation,
  testsFor,
  usesOf,
  whoOf,
  type ImpactResult,
  type QueryTarget,
  type ResolveResult,
  type RouteMatch,
  type UseSite,
} from '../../shared/query.js';
import type { ReportData } from '../../shared/types.js';
import { getReport } from '../engine.js';
import { ago, capped, createLinker, plural, renderTree, type Linker, type TreeNode } from '../format.js';
import {
  ANALYSIS_OPTIONS,
  analysisOptions,
  explicitRoot,
  isTTY,
  parseCommandArgs,
  Progress,
  resolveProjectRoot,
  STAGE_LABELS,
  UsageError,
  type AnalysisValues,
  type Command,
  type CommandContext,
  type ProjectLocation,
} from '../shared.js';

/*
 * Terminal answers to everyday reachability questions: `who`, `uses`, `impact`, `path`, `route` and
 * `tests-for`. All of them read one analysis (a running `serve`, the warm cache, or a cold run) and
 * answer through src/shared/query.ts, the same functions the MCP server and the report UI use.
 */

const COMMON_HELP = `${pc.bold('Common options')}
      --root <dir>         Project root (default: the nearest folder with a package.json, or
                           the root of the workspace monorepo it belongs to)
      --json               Machine-readable output
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-git             Skip git history
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -q, --quiet              No progress output
  -h, --help               Show this help

${pc.bold('Targets')}
  A file (src/cart/Cart.tsx, or a unique suffix such as Cart.tsx), a symbol (useCart,
  CartService.checkout, src/cart/index.ts#useCart), a folder (src/cart/) or a route
  ('GET /api/cart/:id', or a concrete URL like 'GET /api/cart/42'). Paths may be relative to
  the current folder or to the git root. Typos get suggestions.
  file:line links open your editor (set CODE_VISUALIZER_EDITOR=cursor|zed|webstorm|none
  or a URL template; NO_HYPERLINKS=1 prints plain text).`;

const WHO_HELP = `
${pc.bold('Usage')}
  $ code-visualizer who <target> [options]

  Who knows this code: CODEOWNERS owners, the people who changed it (recent work
  counts more), when they last touched it, and the bus factor.

${pc.bold('Options')}
      --limit <n>          Number of people to list (default: 5)

${COMMON_HELP}

${pc.bold('Examples')}
  $ npx code-visualizer who src/billing/
  $ npx code-visualizer who useCart
  $ npx code-visualizer who 'GET /api/orders/:id'
`;

const USES_HELP = `
${pc.bold('Usage')}
  $ code-visualizer uses <symbol|file[#Symbol]> [options]

  Every place that uses a symbol or file: imports (with the imported names and
  line), exact call / render / new sites with the calling function, type references,
  and HTTP requests when the target handles a route. Alias: refs.

${pc.bold('Options')}
      --limit <n>          Files to list in text output (default: 50)

${COMMON_HELP}

${pc.bold('Examples')}
  $ npx code-visualizer uses formatPrice
  $ npx code-visualizer refs src/cart/CartService.ts#CartService.checkout --json
`;

const IMPACT_HELP = `
${pc.bold('Usage')}
  $ code-visualizer impact <target...> [options]

  What a change to these files, symbols, folders or routes affects: the direct users
  (with exact lines), everything that depends on them by distance, routes and pages,
  the tests to run (with the command) and the code owners to notify. For a symbol
  only its importers and callers count, not the importers of its neighbours.

${pc.bold('Options')}
      --depth <n>          Import levels to list (default: 3; the rest is counted)

${COMMON_HELP}

${pc.bold('Examples')}
  $ npx code-visualizer impact formatDate
  $ npx code-visualizer impact src/lib/auth.ts src/lib/session.ts --depth 5
`;

const PATH_HELP = `
${pc.bold('Usage')}
  $ code-visualizer path <from> <to> [options]

  Why does <from> depend on <to>? The shortest import chain, with the line and the
  imported names of every hop. Symbols stand for their files.

${COMMON_HELP}

${pc.bold('Examples')}
  $ npx code-visualizer path src/pages/Checkout.tsx src/db/client.ts
  $ npx code-visualizer path CheckoutPage prisma
`;

const ROUTE_HELP = `
${pc.bold('Usage')}
  $ code-visualizer route [METHOD] <url> [options]

  Which code serves a URL: the matching route, its handler (file:line), middleware,
  the code in the project that calls it, and the tests that reach it. Without a
  method, every method (and pages) match.

${COMMON_HELP}

${pc.bold('Examples')}
  $ npx code-visualizer route GET /api/users/42
  $ npx code-visualizer route /checkout
`;

const TESTS_FOR_HELP = `
${pc.bold('Usage')}
  $ code-visualizer tests-for <paths...> [options]

  The test files that exercise these files, folders or symbols (through imports, or
  HTTP requests for routes), a command that runs exactly those, and the given files
  that no test reaches. A symbol stands for its file here; "impact <symbol>" lists
  only the tests that reach the symbol's users.

${COMMON_HELP}

${pc.bold('Examples')}
  $ npx code-visualizer tests-for src/cart/
  $ npx code-visualizer tests-for $(git diff --name-only) --json
`;

type Values = AnalysisValues & { root?: string; json?: boolean; limit?: string; help?: boolean };

interface QuerySpec {
  name: string;
  help: string;
  minArgs: number;
  maxArgs?: number;
  /** Command-specific flags. */
  options?: Record<string, { type: 'string' | 'boolean'; short?: string }>;
  /** A usage problem with the arguments, found before the (slower) analysis. */
  validate?(args: string[]): string | undefined;
  answer(ctx: QueryContext): number;
}

interface QueryContext {
  data: ReportData;
  root: string;
  values: Values;
  args: string[];
  out: (line?: string) => void;
  err: (line?: string) => void;
  json: (value: unknown) => void;
  link: Linker;
}

export type { ProjectLocation };

/**
 * The project a query run from `cwd` (which may be a sub-folder) is about — the same rule every command
 * uses (`resolveProjectRoot` in src/cli/shared.ts): the nearest package.json (or code-visualizer
 * configuration), widened to the workspace monorepo it belongs to, else the git root. Undefined outside
 * any project.
 */
export function findProjectRoot(cwd: string, home = os.homedir()): ProjectLocation | undefined {
  const resolved = resolveProjectRoot(cwd, undefined, home);
  return resolved.fallback ? undefined : { root: resolved.root, gitRoot: resolved.gitRoot };
}

const ROUTE_ARG = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL|PAGE)\s/i;

/**
 * Turn a filesystem path argument into a project-relative id. Paths are tried relative to the working
 * directory, then to the git root (`$(git diff --name-only)` from a sub-folder), then to the project
 * root. A trailing `/` (a folder) is kept.
 */
export function toProjectPath(location: ProjectLocation, raw: string, cwd = process.cwd()): string {
  if (ROUTE_ARG.test(raw)) return raw;
  const hash = raw.indexOf('#');
  const pathPart = hash > 0 ? raw.slice(0, hash) : raw;
  const rest = hash > 0 ? raw.slice(hash) : '';
  if (!(pathPart.includes('/') || pathPart.includes(path.sep) || pathPart.includes('.'))) return raw;
  const slash = /[\\/]$/.test(pathPart) && pathPart.length > 1 ? '/' : '';
  const bases = [cwd, location.gitRoot, location.root].filter((b): b is string => !!b);
  for (const base of path.isAbsolute(pathPart) ? [cwd] : bases) {
    const abs = path.resolve(base, pathPart);
    if (!fs.existsSync(abs)) continue;
    const rel = path.relative(location.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    return `${rel.split(path.sep).join('/')}${rel && slash}${rest}`;
  }
  return raw;
}

/** `cviz impact … | head`: stop quietly when the reader of the output goes away. */
const PIPE_GUARDED = new WeakSet<object>();
export function exitOnBrokenPipe(stream: NodeJS.WriteStream): void {
  if (PIPE_GUARDED.has(stream) || typeof stream.on !== 'function') return;
  PIPE_GUARDED.add(stream);
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    process.exit(process.exitCode ?? 0);
  });
}

async function runQuery(spec: QuerySpec, { argv, stdout, stderr }: CommandContext): Promise<number> {
  let parsed;
  try {
    parsed = parseCommandArgs(spec.name, argv, { ...ANALYSIS_OPTIONS, json: { type: 'boolean' }, ...(spec.options ?? {}) });
  } catch (error) {
    stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
    return 2;
  }
  const values = parsed.values as Values;
  const args = spec.name === 'route' ? parsed.positionals : joinRouteArgs(parsed.positionals);
  if (values.help) {
    stdout.write(spec.help);
    return 0;
  }
  const usage = (reason: string): number => {
    stderr.write(`${pc.red('✖')} ${reason}\n${spec.help}`);
    return 2;
  };
  if (args.length < spec.minArgs) return usage(`${spec.name} needs ${spec.minArgs === 1 ? 'a target' : `${spec.minArgs} targets`}.`);
  if (spec.maxArgs !== undefined && args.length > spec.maxArgs) return usage(`${spec.name} takes at most ${plural(spec.maxArgs, 'argument')} (got ${args.length}: ${args.join(' ')}). Quote targets that contain spaces.`);
  if (values.depth !== undefined && !spec.options?.depth) return usage(`--depth is an option of impact only.`);
  const invalid = spec.validate?.(args);
  if (invalid) return usage(invalid);
  // The positionals are targets here: the root comes from --root or the folder the query runs in.
  const resolved = resolveProjectRoot(process.cwd(), explicitRoot(values, []));
  if (resolved.fallback) {
    stderr.write(`${pc.red('✖')} Not inside a project (no package.json or git repository here or above). cd into one, or pass --root <dir>.\n`);
    return 2;
  }
  const location: ProjectLocation = { root: resolved.root, gitRoot: resolved.gitRoot };
  const { root } = location;
  exitOnBrokenPipe(stdout);
  let options;
  try {
    // `--depth` is impact's own flag here (the analysis depth only applies to --file reports).
    options = analysisOptions({ ...values, root, depth: undefined }, []);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${pc.red('✖')} ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const progress = new Progress(stderr, isTTY(stderr) && !values.quiet && !values.json);
  let data: ReportData;
  try {
    data = await getReport({ ...options, includeSource: false, history: false, changes: false, onProgress: (stage) => progress.update(STAGE_LABELS[stage]) });
  } catch (error) {
    progress.stop();
    if (error instanceof AnalyzeError) {
      stderr.write(`${pc.red('✖')} ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    progress.stop();
  }
  const ctx: QueryContext = {
    data,
    root,
    values,
    // Route arguments are URLs, not paths (`/app/x` must not become a project file).
    args: spec.name === 'route' ? args : args.map((a) => toProjectPath(location, a)),
    out: (line = '') => stdout.write(`${line}\n`),
    err: (line = '') => stderr.write(`${line}\n`),
    json: (value) => stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    link: createLinker({ root, stream: stdout }),
  };
  try {
    return spec.answer(ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.err(`${pc.red('✖')} ${error.message}`);
      return 2;
    }
    throw error;
  }
}

/** A query command: its descriptor plus how it answers. */
function queryCommand(meta: Pick<Command, 'name' | 'aliases' | 'summary'>, spec: Omit<QuerySpec, 'name'>): Command {
  return { ...meta, run: (c) => runQuery({ name: meta.name, ...spec }, c) };
}

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL|PAGE)$/i;

/** `GET /api/users/42` typed without quotes arrives as two arguments: keep it one target. */
function joinRouteArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (METHOD_RE.test(args[i]) && next !== undefined && /^(\/|https?:\/\/)/.test(next)) {
      out.push(`${args[i].toUpperCase()} ${next}`);
      i++;
    } else out.push(args[i]);
  }
  return out;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive whole number.`);
  return n;
}

/** Resolve a target, or explain what was not found (and suggest alternatives) on stderr. */
function resolveQuiet(ctx: QueryContext, input: string): ResolveResult & { input: string } {
  const r = resolveTarget(ctx.data, input);
  if (r.target && r.alternatives?.length && !ctx.values.json && !ctx.values.quiet) {
    ctx.err(pc.dim(`  "${input}" also names ${r.alternatives.slice(0, 3).map((id) => id.replace('#', ' › ')).join(', ')}${r.alternatives.length > 3 ? ', …' : ''} — pass path#Name to pick one`));
  }
  return { ...r, input };
}

/** "Nothing matches" on stderr, with "did you mean" suggestions. */
function explainMissing(ctx: QueryContext, r: { input: string; suggestions: string[] }, warn = false): void {
  const mark = warn ? pc.yellow('!') : pc.red('✖');
  ctx.err(`${mark} Nothing in ${path.basename(ctx.root)} matches "${r.input}" (files, symbols, folders and routes were searched).`);
  if (r.suggestions.length) ctx.err(`  Did you mean: ${r.suggestions.map((s) => pc.cyan(s)).join(', ')}?`);
}

/** One JSON error for every input that matched nothing. */
function jsonMissing(ctx: QueryContext, missing: { input: string; suggestions: string[] }[]): void {
  if (missing.length === 1) ctx.json({ error: 'not-found', input: missing[0].input, suggestions: missing[0].suggestions });
  else ctx.json({ error: 'not-found', inputs: missing.map(({ input, suggestions }) => ({ input, suggestions })) });
}

/** Resolve the one target of a command, or explain (exit 1). */
function resolveOrExplain(ctx: QueryContext, input: string): { target: QueryTarget; alternatives?: string[] } | undefined {
  const r = resolveQuiet(ctx, input);
  if (r.target) return { target: r.target, alternatives: r.alternatives };
  if (ctx.values.json) jsonMissing(ctx, [r]);
  explainMissing(ctx, r);
  return undefined;
}

/** `formatDate  src/utils/format.ts:11` */
function heading(ctx: QueryContext, target: QueryTarget): string {
  const label = targetLabel(ctx.data, target);
  const loc = targetLocation(ctx.data, target);
  if (target.type === 'file' || target.type === 'dir' || !loc.file) return pc.bold(label);
  return `${pc.bold(label)}  ${pc.dim(ctx.link(loc.file, loc.line))}`;
}

/** `alternatives` (other symbols with the same name) for the JSON answer, when the name was ambiguous. */
const withAlternatives = (alternatives: string[] | undefined): { alternatives?: string[] } => (alternatives?.length ? { alternatives } : {});

/* ----------------------------------- who ----------------------------------- */

function answerWho(ctx: QueryContext): number {
  const limit = positiveInt(ctx.values.limit, 5, '--limit');
  const resolved = resolveOrExplain(ctx, ctx.args[0]);
  if (!resolved) return 1;
  const { target } = resolved;
  const result = whoOf(ctx.data, target, { limit });
  if (ctx.values.json) {
    ctx.json({ label: targetLabel(ctx.data, target), ...withAlternatives(resolved.alternatives), ...result });
    return 0;
  }
  ctx.out();
  ctx.out(`  Who knows ${heading(ctx, target)}${result.files > 1 ? pc.dim(`  (${plural(result.files, 'file')})`) : ''}`);
  ctx.out();
  ctx.out(`  ${pc.dim('Owners    ')}  ${result.owners.length ? result.owners.join(', ') : pc.dim('no CODEOWNERS entry')}`);
  if (!result.hasHistory) {
    ctx.out(`  ${pc.dim('Experts   ')}  ${pc.dim(ctx.data.git ? 'no commits touch these files yet' : 'no git history (run inside a git repository, without --no-git)')}`);
    ctx.out();
    return 0;
  }
  ctx.out(`  ${pc.dim('Experts')}`);
  const nameWidth = Math.min(28, Math.max(...result.experts.map((e) => e.name.length + (e.me ? 6 : 0))));
  const idleDays = (e: { last: number }): number => Math.floor((Date.now() - e.last) / 86_400_000);
  for (const e of result.experts) {
    const filled = Math.max(1, Math.round(e.share * 10));
    const bar = pc.magenta('█'.repeat(filled)) + pc.dim('░'.repeat(10 - filled));
    const name = `${e.name}${e.me ? ' (you)' : ''}`.padEnd(nameWidth);
    const idle = e.inactive ? `  ${pc.yellow(`inactive ${idleDays(e)}d`)}` : '';
    ctx.out(`    ${name}  ${bar} ${String(Math.round(e.share * 100)).padStart(3)}%  ${pc.dim(`${plural(e.commits, 'commit')} · last ${ago(e.last)}`)}${idle}`);
  }
  if (result.busFactor !== undefined) {
    const [top] = result.experts;
    let note: string;
    if (result.busFactor > 1) note = pc.dim(`${result.busFactor} people made most of the changes (recent work counts more)`);
    else if (result.experts.length === 1) note = pc.yellow(`only ${top.name} has changed this code${top.inactive ? ` (inactive ${idleDays(top)}d)` : ''}`);
    else note = pc.yellow(`${top.name} made most of the changes (recent work counts more)`);
    ctx.out(`  ${pc.dim('Bus factor')}  ${result.busFactor}  ${note}`);
  }
  const lc = result.lastCommit;
  if (lc) {
    const subject = lc.subject.length > 72 ? `${lc.subject.slice(0, 71)}…` : lc.subject;
    ctx.out(`  ${pc.dim('Last touch')}  ${ago(lc.date)} by ${lc.author} — ${subject} ${pc.dim(`(${lc.hash.slice(0, 7)}, ${ctx.link(lc.file)})`)}`);
  }
  ctx.out();
  return 0;
}

export const whoCommand = queryCommand(
  { name: 'who', summary: 'Who knows this code: owners, experts, last touch, bus factor' },
  { help: WHO_HELP, minArgs: 1, maxArgs: 1, options: { limit: { type: 'string' } }, answer: answerWho },
);

/* ----------------------------------- uses ---------------------------------- */

const SITE_WORDS: Record<UseSite['kind'], string> = { import: 'import', reexport: 're-export', call: 'call', render: 'render', new: 'new', http: 'HTTP' };

const symbolLabel = (ctx: QueryContext, id: string): string => symbolRef(ctx.data, id)?.label ?? id.slice(id.indexOf('#') + 1);

/** What happens at a use site: `call in Checkout (2 args)`, `import { a, b }`, `GET /api/x in load`. */
function siteWhat(ctx: QueryContext, s: UseSite, targetId?: string): string {
  const where = s.symbol ? ` in ${pc.cyan(symbolLabel(ctx, s.symbol))}` : '';
  if (s.kind === 'import' || s.kind === 'reexport') {
    const named = (s.names ?? []).filter((n) => n !== '*' && n !== 'default');
    const parts = [s.names?.includes('default') ? 'default' : '', named.length ? `{ ${named.join(', ')} }` : ''].filter(Boolean);
    const what = parts.length ? pc.cyan(parts.join(', ')) : pc.cyan('*') + pc.dim(' (the whole module)');
    return `${SITE_WORDS[s.kind]} ${what}${s.typeOnly ? pc.dim(' (type)') : ''}${s.via ? pc.dim(` via ${s.via}`) : ''}`;
  }
  if (s.kind === 'http') return `${pc.bold(s.method ?? '')} ${s.url ?? ''}${where}`;
  const args = s.argc !== undefined && s.kind !== 'render' ? pc.dim(s.argc < 0 ? ' (spread args)' : ` (${plural(s.argc, 'arg')})`) : '';
  // For a file or class target, name the symbol that is used.
  const which = s.target && s.target !== targetId && s.target.includes('#') ? pc.dim(` → ${symbolLabel(ctx, s.target)}`) : '';
  return `${SITE_WORDS[s.kind]}${where}${args}${which}`;
}

function siteText(ctx: QueryContext, s: UseSite, targetId?: string): string {
  return `${ctx.link(s.file, s.line, `:${s.line}`)}  ${siteWhat(ctx, s, targetId)}`;
}

function answerUses(ctx: QueryContext): number {
  const limit = positiveInt(ctx.values.limit, 50, '--limit');
  const resolved = resolveOrExplain(ctx, ctx.args[0]);
  if (!resolved) return 1;
  const { target } = resolved;
  const result = usesOf(ctx.data, target);
  if (ctx.values.json) {
    ctx.json({ label: targetLabel(ctx.data, target), ...withAlternatives(resolved.alternatives), ...result });
    return 0;
  }
  const status = result.files
    ? `used in ${plural(result.files, 'file')}`
    : result.through.length
      ? 'no direct use found (calls on instances or values passed around are not tracked)'
      : 'not used by other analyzed code';
  ctx.out();
  ctx.out(`  ${heading(ctx, target)}  ${pc.dim(status)}`);
  ctx.out();
  const byFile = new Map<string, TreeNode[]>();
  const add = (file: string, node: TreeNode): void => {
    const list = byFile.get(file);
    if (list) list.push(node);
    else byFile.set(file, [node]);
  };
  const all = [...result.imports, ...result.sites, ...result.http].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  for (const s of all) add(s.file, { label: siteText(ctx, s, target.id) });
  // Type and inheritance references: one row per referencing symbol, with what it references.
  const refRows = new Map<string, { file: string; kind: string; symbol: string; targets: Set<string> }>();
  for (const r of result.refs) {
    const kind = r.kind === 'uses' ? 'type reference' : r.kind;
    const key = `${r.symbol}\0${kind}`;
    const row = refRows.get(key) ?? { file: r.file, kind, symbol: r.symbol, targets: new Set<string>() };
    row.targets.add(symbolLabel(ctx, r.target));
    refRows.set(key, row);
  }
  for (const row of refRows.values()) {
    const what = target.type === 'symbol' && row.targets.size === 1 && row.targets.has(targetLabel(ctx.data, target)) ? '' : ` → ${[...row.targets].slice(0, 6).join(', ')}${row.targets.size > 6 ? ', …' : ''}`;
    add(row.file, { label: `${row.kind} in ${pc.cyan(symbolLabel(ctx, row.symbol))}${pc.dim(what)}` });
  }
  const files = [...byFile.keys()].sort();
  for (const line of capped(files, limit, (f) => [`  ${pc.bold(ctx.link(f))}`, ...renderTree(byFile.get(f)!, '  ')].join('\n'))) ctx.out(line);
  if (files.length) ctx.out();
  if (result.through.length) {
    ctx.out(`  ${pc.dim(`Reached through other exports (${plural(new Set(result.through.map((s) => s.file)).size, 'file')}):`)}`);
    for (const line of capped(result.through, 15, (s) => `    ${ctx.link(s.file, s.line)}  ${pc.dim(siteWhat(ctx, s))}`, '    ')) ctx.out(line);
    ctx.out();
  }
  return 0;
}

export const usesCommand = queryCommand(
  { name: 'uses', aliases: ['refs'], summary: 'Where a symbol or file is used: imports, exact call sites, HTTP callers' },
  { help: USES_HELP, minArgs: 1, maxArgs: 1, options: { limit: { type: 'string' } }, answer: answerUses },
);

/* ---------------------------------- impact --------------------------------- */

function printDirect(ctx: QueryContext, result: ImpactResult, files: string[], targetId: string | undefined): void {
  const byFile = new Map(result.direct.map((d) => [d.file, d]));
  const nodes = files.map((f) => {
    const d = byFile.get(f);
    const via = d?.via.length ? `  ${pc.cyan(d.via.slice(0, 4).join(', '))}${d.via.length > 4 ? pc.dim(` +${d.via.length - 4}`) : ''}` : '';
    const children = (d?.sites ?? [])
      .filter((s) => s.kind !== 'import' && s.kind !== 'reexport')
      .slice(0, 8)
      .map((s) => ({ label: siteText(ctx, s, targetId) }));
    return { label: `${ctx.link(f)}${via}`, children };
  });
  for (const line of capped(nodes, 40, (n) => [`    ${n.label}`, ...renderTree(n.children, '    ')].join('\n'), '    ')) ctx.out(line);
}

/** `src/a.ts`, or `formatDate (src/utils/format.ts)` for a symbol id. */
function untestedLabel(ctx: QueryContext, id: string): string {
  if (!id.includes('#')) return ctx.link(id);
  const ref = symbolRef(ctx.data, id);
  return `${ref?.label ?? id.slice(id.indexOf('#') + 1)} ${pc.dim(`(${ctx.link(fileOfSymbol(id), ref?.line)})`)}`;
}

function printImpactExtras(ctx: QueryContext, result: ImpactResult): void {
  if (result.routes.length) {
    ctx.out(`  ${pc.bold('Routes and pages')} ${pc.dim(`(${result.routes.length})`)}`);
    for (const line of capped(result.routes, 20, (r) => `    ${r.label}  ${pc.dim(ctx.link(r.file, r.line))}`, '    ')) ctx.out(line);
    ctx.out();
  }
  ctx.out(`  ${pc.bold('Tests')} ${pc.dim(`(${result.tests.files.length})`)}`);
  if (!result.tests.files.length) ctx.out(`    ${pc.dim('No test reaches this code or its users.')}`);
  for (const line of capped(result.tests.files, 15, (f) => `    ${ctx.link(f)}`, '    ')) ctx.out(line);
  if (result.tests.command) ctx.out(`    ${pc.dim('$')} ${result.tests.command}`);
  if (result.tests.untested.length) ctx.out(`    ${pc.yellow('no test reaches:')} ${result.tests.untested.map((u) => untestedLabel(ctx, u)).join(', ')}`);
  if (result.owners.length) {
    ctx.out();
    ctx.out(`  ${pc.bold('Owners to notify')}`);
    for (const o of result.owners.slice(0, 8)) ctx.out(`    ${o.owner}  ${pc.dim(plural(o.files.length, 'file'))}`);
  }
}

function answerImpact(ctx: QueryContext): number {
  const depth = positiveInt(ctx.values.depth, 3, '--depth');
  // Unknown inputs (a file deleted in the diff, a typo) are reported; the others are still answered.
  const resolved = ctx.args.map((input) => resolveQuiet(ctx, input));
  const targets = resolved.flatMap((r) => (r.target ? [r.target] : []));
  const missing = resolved.filter((r) => !r.target);
  if (!targets.length) {
    if (ctx.values.json) jsonMissing(ctx, missing);
    for (const m of missing) explainMissing(ctx, m);
    return 1;
  }
  const result = impactOf(ctx.data, targets, { depth });
  const alternatives = resolved.flatMap((r) => (r.target ? (r.alternatives ?? []) : []));
  if (ctx.values.json) {
    const unknown = missing.length ? { unknown: missing.map(({ input, suggestions }) => ({ input, suggestions })) } : {};
    ctx.json({ labels: targets.map((t) => targetLabel(ctx.data, t)), ...withAlternatives(alternatives), ...unknown, ...result });
    return 0;
  }
  for (const m of missing) explainMissing(ctx, m, true);
  const precision = result.precision === 'symbol' ? pc.green('symbol-precise') : pc.yellow(`file-level${result.precisionNote ? ` — ${result.precisionNote}` : ''}`);
  ctx.out();
  ctx.out(`  Impact of ${targets.map((t) => heading(ctx, t)).join(pc.dim(', '))}`);
  ctx.out(`  ${pc.dim(`${plural(result.total + (result.truncated ?? 0), 'affected file')} ·`)} ${precision}`);
  ctx.out();
  if (!result.byDepth.length) ctx.out(`  ${pc.dim('Nothing else in the project depends on it.')}`);
  for (const level of result.byDepth) {
    ctx.out(`  ${pc.bold(level.depth === 1 ? 'Direct' : `Depth ${level.depth}`)} ${pc.dim(`(${plural(level.files.length, 'file')})`)}`);
    if (level.depth === 1) printDirect(ctx, result, level.files, targets.length === 1 ? targets[0].id : undefined);
    else for (const line of capped(level.files, 30, (f) => `    ${ctx.link(f)}`, '    ')) ctx.out(line);
  }
  if (result.truncated) ctx.out(`  ${pc.dim(`+${plural(result.truncated, 'more file')} beyond depth ${depth} (--depth ${depth + 3} lists more)`)}`);
  ctx.out();
  printImpactExtras(ctx, result);
  ctx.out();
  return 0;
}

export const impactCommand = queryCommand(
  { name: 'impact', summary: 'What a change affects: users by depth, routes, tests to run, owners' },
  { help: IMPACT_HELP, minArgs: 1, options: { depth: { type: 'string' } }, answer: answerImpact },
);

/* ----------------------------------- path ---------------------------------- */

/** The file a target stands for in an import chain (a symbol's or route handler's file). */
function fileForPath(ctx: QueryContext, target: QueryTarget): string | undefined {
  if (target.type === 'file') return target.id;
  if (target.type === 'symbol') return fileOfSymbol(target.id);
  if (target.type === 'route') {
    const files = filesOfTarget(ctx.data, target);
    return files[files.length - 1];
  }
  return undefined;
}

function answerPath(ctx: QueryContext): number {
  const ends = ctx.args.slice(0, 2).map((input) => resolveQuiet(ctx, input));
  const missing = ends.filter((r) => !r.target);
  if (missing.length) {
    // One answer for both ends, so --json stays a single document.
    if (ctx.values.json) jsonMissing(ctx, missing);
    for (const m of missing) explainMissing(ctx, m);
    return 1;
  }
  const [fromT, toT] = ends.map((r) => r.target!);
  const from = fileForPath(ctx, fromT);
  const to = fileForPath(ctx, toT);
  if (!from || !to) throw new UsageError('path needs files, symbols or routes (a folder has no single import chain).');
  const forward = importPath(ctx.data, from, to);
  const back = forward ? undefined : importPath(ctx.data, to, from);
  const result = forward ?? (back ? { ...back, reversed: true } : undefined);
  if (ctx.values.json) {
    ctx.json({ from, to, found: !!result, ...withAlternatives(ends.flatMap((r) => r.alternatives ?? [])), ...(result ?? { hops: [] }) });
    return result ? 0 : 1;
  }
  if (!result) {
    ctx.err(`${pc.yellow('!')} No import chain connects ${from} and ${to} (in either direction).`);
    return 1;
  }
  const end = result.reversed ? from : to;
  ctx.out();
  if (result.reversed) ctx.out(`  ${pc.yellow('!')} ${from} does not import ${to} — but the other way round:`);
  ctx.out(`  ${pc.bold(result.reversed ? to : from)} → ${pc.bold(end)}  ${pc.dim(plural(result.hops.length, 'hop'))}`);
  ctx.out();
  for (const hop of result.hops) {
    const names = hop.names.length ? pc.cyan(hop.names.slice(0, 5).join(', ') + (hop.names.length > 5 ? ', …' : '')) : pc.dim(hop.kind ?? 'import');
    ctx.out(`    ${ctx.link(hop.source, hop.line)}  ${names}${hop.typeOnly ? pc.dim(' (type)') : ''}${hop.kind && hop.kind !== 'import' ? pc.dim(` ${hop.kind}`) : ''}`);
    ctx.out(`    ${pc.dim('↓')}`);
  }
  ctx.out(`    ${ctx.link(end)}`);
  ctx.out();
  return 0;
}

export const pathCommand = queryCommand(
  { name: 'path', summary: 'Why A depends on B: the shortest import chain, line by line' },
  { help: PATH_HELP, minArgs: 2, maxArgs: 2, answer: answerPath },
);

/* ---------------------------------- route ---------------------------------- */

function printRoute(ctx: QueryContext, m: RouteMatch): void {
  const handler = m.handler;
  const name = handler?.symbol ? ` ${pc.cyan(symbolRef(ctx.data, handler.symbol)?.label ?? '')}` : '';
  ctx.out(`  ${pc.bold(m.label)}${m.exact ? '' : pc.dim('  (base-URL match)')}  ${pc.dim(m.route.framework)}`);
  if (handler) ctx.out(`    ${pc.dim('Handler   ')}  ${ctx.link(handler.file, handler.line)}${name}`);
  if (m.route.file !== handler?.file || (m.route.line && m.route.line !== handler?.line)) ctx.out(`    ${pc.dim('Registered')}  ${ctx.link(m.route.file, m.route.line)}`);
  const app = (a: RouteMatch['appMiddlewares'][number]): string => `${a.label} ${pc.dim(`(${ctx.link(a.file, a.line)})`)}`;
  // App-level middleware first (it runs before the route's own), error handlers apart: they run only on failure.
  const chain = [...m.appMiddlewares.filter((a) => !a.onError).map(app), ...m.middlewares];
  if (chain.length) ctx.out(`    ${pc.dim('Middleware')}  ${chain.join(pc.dim(' → '))}`);
  const onError = m.appMiddlewares.filter((a) => a.onError);
  if (onError.length) ctx.out(`    ${pc.dim('On error  ')}  ${onError.map(app).join(pc.dim(', '))}`);
  ctx.out(`    ${pc.dim('Callers   ')}  ${m.callers.length ? pc.dim(`(${m.callers.length})`) : pc.dim('none in this project')}`);
  for (const line of capped(m.callers, 10, (s) => `      ${ctx.link(s.file, s.line)}  ${siteWhat(ctx, s)}`, '      ')) ctx.out(line);
  ctx.out(`    ${pc.dim('Tests     ')}  ${m.tests.length ? m.tests.map((t) => ctx.link(t)).join(', ') : pc.yellow('none reach the handler')}`);
  ctx.out();
}

/** `route GET /x`, `route 'GET /x'` or `route /x`: the method (if any) and the URL words. */
function routeWords(args: string[]): { method?: string; rest: string[] } {
  const words = args.join(' ').trim().split(/\s+/).filter(Boolean);
  const method = METHOD_RE.test(words[0] ?? '') ? words[0].toUpperCase() : undefined;
  return { method, rest: method ? words.slice(1) : words };
}

function validateRoute(args: string[]): string | undefined {
  const { method, rest } = routeWords(args);
  if (!rest.length) return `route needs a URL, e.g. "route ${method ?? 'GET'} /api/users/42".`;
  if (rest.length > 1) return `route takes one URL, got ${rest.length}: ${rest.join(' ')}.`;
  return undefined;
}

function answerRoute(ctx: QueryContext): number {
  const { method, rest } = routeWords(ctx.args);
  const url = rest[0];
  const matches = routeFor(ctx.data, method, url);
  if (ctx.values.json) {
    ctx.json({ method: method ?? null, url, matches });
    return matches.length ? 0 : 1;
  }
  if (!matches.length) {
    const other = method ? routeFor(ctx.data, undefined, url) : [];
    ctx.err(`${pc.red('✖')} No route serves ${method ? `${method} ` : ''}${url}.`);
    if (other.length) ctx.err(`  Other methods match: ${other.map((m) => pc.cyan(m.label)).join(', ')}`);
    else if (ctx.data.routes.length) ctx.err(pc.dim(`  ${plural(ctx.data.routes.length, 'route')} known — run "code-visualizer report" and open Routes to browse them.`));
    return 1;
  }
  ctx.out();
  for (const m of matches.slice(0, 5)) printRoute(ctx, m);
  if (matches.length > 5) ctx.out(pc.dim(`  +${matches.length - 5} more (use --json)`));
  return 0;
}

export const routeCommand = queryCommand(
  { name: 'route', summary: 'Which handler serves a URL: route, middleware, callers, tests' },
  { help: ROUTE_HELP, minArgs: 1, maxArgs: 2, validate: validateRoute, answer: answerRoute },
);

/* -------------------------------- tests-for -------------------------------- */

function answerTestsFor(ctx: QueryContext): number {
  const result = testsFor(ctx.data, ctx.args);
  const found = result.byPath.length > 0;
  if (ctx.values.json) {
    ctx.json(result);
    return found ? 0 : 1;
  }
  for (const u of result.unknown) {
    const s = resolveTarget(ctx.data, u).suggestions;
    ctx.err(`${pc.yellow('!')} "${u}" is not an analyzed file, folder or symbol${s.length ? ` — did you mean ${s.slice(0, 3).map((x) => pc.cyan(x)).join(', ')}?` : '.'}`);
  }
  if (!found) return 1;
  ctx.out();
  ctx.out(`  ${pc.bold(plural(result.files.length, 'test'))} ${pc.dim(`for ${plural(result.byPath.length, 'path')}`)}`);
  for (const line of capped(result.files, 40, (f) => `    ${ctx.link(f)}`, '    ')) ctx.out(line);
  if (result.command) ctx.out(`    ${pc.dim('$')} ${result.command}`);
  else if (result.files.length) ctx.out(`    ${pc.dim('(no test runner detected in package.json)')}`);
  if (result.untested.length) {
    ctx.out();
    ctx.out(`  ${pc.yellow('No test reaches')} ${pc.dim(`(${result.untested.length})`)}`);
    for (const line of capped(result.untested, 20, (f) => `    ${ctx.link(f)}`, '    ')) ctx.out(line);
  }
  if (ctx.args.some((a) => resolveTarget(ctx.data, a).target?.type === 'symbol')) {
    ctx.out();
    ctx.out(pc.dim('  Symbols stand for their files here; "impact <symbol>" lists the tests that reach its users.'));
  }
  ctx.out();
  return 0;
}

export const testsForCommand = queryCommand(
  { name: 'tests-for', summary: 'Tests to run for files, folders or symbols (with the command)' },
  { help: TESTS_FOR_HELP, minArgs: 1, answer: answerTestsFor },
);
