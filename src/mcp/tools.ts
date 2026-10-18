/**
 * The MCP tools: thin wrappers over the query core (src/shared/query.ts), the markdown generators and
 * the rule engine, answering in compact Markdown with repo-relative `file:line` references plus the same
 * facts as structured data. Every tool is read-only and accepts `limit` and `response_format`.
 *
 * `TOOLS` is the registry; later features append their tool to it (clone-radar added `find_similar`).
 */
import { loadConfig, type LoadedConfig } from '../analyzer/config.js';
import { closest } from '../shared/delta.js';
import { projectSummaryMarkdown } from '../shared/markdown.js';
import { fileOfSymbol, impactOf, resolveTarget, routeFor, suggest, targetLabel, targetLocation, testsFor, whoOf, type ImpactResult, type QueryTarget, type RouteMatch, type UseSite } from '../shared/query.js';
import { buildTestCommand } from '../shared/testcmd.js';
import type { ReportData } from '../shared/types.js';
import { checkArchitectureTool, ruleLines } from './architecture.js';
import { reviewChangesTool } from './changes.js';
import { alternativesLine, formatOf, heading, isoDay, limitOf, notFoundText, person, resolveArg, siteData, siteRef, siteWhat, symbolLabel, usesTarget, withFreshFiles } from './format.js';
import { projectPath } from './paths.js';
import { answer, capList, code, COMMON_PROPERTIES, fence, loc, plural, READ_ONLY, toolError, type RenderedAnswer, type ResponseFormat, type ToolDef } from './protocol.js';
import { findSimilarTool } from './similar.js';
import { findSymbolTool } from './symbols.js';

/* -------------------------------------------------------------------------- */
/*                              project_overview                              */
/* -------------------------------------------------------------------------- */

const SCRIPT_KINDS: [key: 'test' | 'lint' | 'typecheck' | 'build' | 'dev', names: string[]][] = [
  ['test', ['test', 'test:unit', 'unit', 'vitest', 'jest']],
  ['lint', ['lint', 'eslint', 'lint:js', 'biome']],
  ['typecheck', ['typecheck', 'type-check', 'types', 'check-types', 'tsc', 'check:types', 'typecheck:all']],
  ['build', ['build']],
  ['dev', ['dev', 'start', 'serve']],
];

/** test / lint / typecheck / build / dev commands from package.json scripts, plus the single-test-file command. */
export function projectCommands(data: ReportData): Record<string, string> {
  const scripts = data.project.scripts ?? {};
  const pm = data.project.packageManager;
  const out: Record<string, string> = {};
  for (const [key, names] of SCRIPT_KINDS) {
    const name = names.find((n) => scripts[n]);
    if (name) out[key] = scriptCommand(pm, name);
  }
  // The runner's own command for one file, with a placeholder (vitest / jest only run test-named files).
  const one = buildTestCommand(['__cv_file__.test.ts'], data.project.testRunners).command;
  if (one && one.includes('__cv_file__.test.ts')) out.testFile = one.replace('__cv_file__.test.ts', '<file>');
  // test-intelligence: only the tests the current changes affect (and the outcome recorded for status lines and hooks).
  if (Object.values(data.project.testRunners ?? {}).some((r) => r.unit || r.e2e)) out.affectedTests = 'npx code-visualizer test';
  return out;
}

/** Markdown sections (`## Title` up to the next `## `) left out of a generated document (headings inside fenced repo text do not count). */
function withoutSections(markdown: string, titles: string[]): string {
  const out: string[] = [];
  let skipping = false;
  let fenceMarks: string | undefined;
  for (const line of markdown.split('\n')) {
    const marks = /^\s*(`{3,})/.exec(line)?.[1];
    if (marks && !fenceMarks) fenceMarks = marks;
    else if (fenceMarks && line.trim() === fenceMarks) fenceMarks = undefined;
    else if (!fenceMarks && /^## /.test(line)) skipping = titles.includes(line.slice(3).trim());
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

const COMMAND_LABELS: Record<string, string> = { test: 'Run all tests', testFile: 'Run one test file', affectedTests: 'Run only the tests your changes affect', lint: 'Lint', typecheck: 'Typecheck', build: 'Build', dev: 'Dev server' };

/**
 * The project overview for agents (the project_overview tool and cv://project/summary): the summary
 * with the commands to run (one test file included) and the architecture rules in full.
 */
export function renderOverview(data: ReportData, loaded: LoadedConfig, limit = 30): RenderedAnswer {
  const commands = projectCommands(data);
  // The summary's own command and layer sections are replaced by the fuller ones below.
  const lines = [withoutSections(projectSummaryMarkdown(data, { fenceRepoText: true }), ['Commands', 'Architecture rules']).trimEnd(), '', '## For agents', ''];
  for (const key of Object.keys(COMMAND_LABELS)) if (commands[key]) lines.push(`- ${COMMAND_LABELS[key]}: ${code(commands[key])}`);
  const rules = ruleLines(loaded.config);
  if (loaded.error) lines.push(`- The configuration is invalid and ignored: ${loaded.error}`);
  else if (rules.length) lines.push(`- Architecture rules (${loaded.file ?? 'configuration'}):`, ...rules.map((l) => `  ${l}`));
  else lines.push('- No architecture rules are configured (code-visualizer.config.json `rules` / `layers`).');
  lines.push('- Before changing an exported function or a widely used file, call `impact`; before adding an import across folders, call `check_architecture`; after editing, run the tests `impact` lists.');
  return {
    text: lines.join('\n'),
    structured: {
      name: data.project.name,
      frameworks: data.project.frameworks.map((f) => f.name),
      typescript: data.project.typescript,
      packageManager: data.project.packageManager,
      files: data.stats.files,
      loc: data.stats.loc,
      health: { score: data.health.score, grade: data.health.grade },
      // test-intelligence: line coverage from the local coverage report (ratio 0..1), when there is one.
      ...(data.stats.lineCoverage !== undefined ? { lineCoverage: data.stats.lineCoverage } : {}),
      commands,
      rules: loaded.config.rules ?? [],
      layers: loaded.config.layers ?? [],
      entries: data.files.filter((f) => f.isEntry).slice(0, limit).map((f) => f.id),
      routes: data.routes.filter((r) => r.type === 'api' || r.type === 'page').slice(0, limit).map((r) => ({ label: `${r.method} ${r.path}`, file: r.file, line: r.line })),
    },
  };
}

const projectOverview: ToolDef = {
  name: 'project_overview',
  title: 'Project overview',
  description:
    'Start here in an unfamiliar repo: stack, size, health, entry points, main folders, core modules, routes, the test / lint / typecheck commands (and how to run a single test file) and the architecture rules that imports must follow.',
  inputSchema: { type: 'object', properties: { ...COMMON_PROPERTIES }, additionalProperties: false },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const data = await ctx.report();
    const { text, structured } = renderOverview(data, loadConfig(ctx.root), limitOf(args));
    return answer(text, formatOf(args), structured, 'read cv://file/{path} or call find_symbol for details');
  },
};

/** The run command of package.json scripts for the project's package manager. */
function scriptCommand(pm: string | undefined, script: string): string {
  if (pm === 'yarn' || pm === 'pnpm') return `${pm} ${script}`;
  if (pm === 'bun') return `bun run ${script}`;
  return script === 'test' || script === 'start' ? `npm ${script}` : `npm run ${script}`;
}

/* -------------------------------------------------------------------------- */
/*                                   impact                                   */
/* -------------------------------------------------------------------------- */

export interface ImpactRisk {
  level: 'low' | 'medium' | 'high';
  score: number;
  reasons: string[];
}

/**
 * A rough risk of changing the targets: how far the change reaches (in files and as a share of the
 * project), routes, tests, owners. Reaching 50 files or a quarter of the project is high on its own.
 */
export function impactRisk(r: ImpactResult, projectFiles = 0, label: (id: string) => string = (id) => id): ImpactRisk {
  const reasons: string[] = [];
  let score = 0;
  const affected = r.total + (r.truncated ?? 0);
  if (affected) {
    const share = projectFiles > 0 ? Math.min(1, affected / projectFiles) : 0;
    score += Math.min(45, 7 * Math.log2(1 + affected)) + Math.min(25, 100 * share);
    if (affected >= 50 || (share >= 0.25 && affected >= 5)) score = Math.max(score, 60);
    reasons.push(`${plural(affected, 'file')} depend${affected === 1 ? 's' : ''} on it${share >= 0.01 ? ` (${Math.round(share * 100)}% of the project)` : ''}`);
  }
  if (r.routes.length) {
    score += Math.min(20, 4 * r.routes.length);
    reasons.push(`${plural(r.routes.length, 'route or page', 'routes and pages')} affected`);
  }
  if (r.tests.untested.length) {
    score += 15;
    reasons.push(`no test reaches ${r.tests.untested.length === 1 ? label(r.tests.untested[0]) : plural(r.tests.untested.length, 'target')}`);
  } else if (!r.tests.files.length && affected) {
    score += 10;
    reasons.push('no test covers it or its users');
  }
  if (r.owners.length > 1) {
    score += 5;
    reasons.push(`${plural(r.owners.length, 'code owner')} involved`);
  }
  const rounded = Math.min(100, Math.round(score));
  return { level: rounded < 30 ? 'low' : rounded < 60 ? 'medium' : 'high', score: rounded, reasons };
}

/** The impact of targets as Markdown and structured data (also used by the plan-change prompt). */
export function renderImpact(data: ReportData, targets: QueryTarget[], opts: { depth: number; limit: number; format: ResponseFormat; alternatives?: string[] }): RenderedAnswer {
  const result = impactOf(data, targets, { depth: opts.depth });
  const untestedLabel = (u: string): string => (u.includes('#') ? `${symbolLabel(data, u)} (${fileOfSymbol(u)})` : u);
  const risk = impactRisk(result, data.files.filter((f) => f.kind !== 'test').length, untestedLabel);
  const { limit } = opts;
  const detailed = opts.format === 'detailed';
  const sitesPerFile = detailed ? 20 : 5;
  const affected = result.total + (result.truncated ?? 0);
  const lines: string[] = [];
  lines.push(`## Impact of ${targets.map((t) => heading(data, t)).join(', ')}`, '');
  const precision = result.precision === 'symbol' ? 'symbol-precise' : `file-level${result.precisionNote ? ` (${result.precisionNote})` : ''}`;
  lines.push(
    `${plural(affected, 'affected file')} · ${plural(result.routes.length, 'route')} · ${plural(result.tests.files.length, 'test')} · risk **${risk.level}** · ${precision}`,
  );
  lines.push(...alternativesLine(data, opts.alternatives));
  lines.push('');
  if (!result.byDepth.length) lines.push('Nothing else in the project depends on it.', '');
  const directLine = directUserLine(data, result, targets, sitesPerFile);
  for (const level of result.byDepth) {
    lines.push(`### ${level.depth === 1 ? 'Direct users' : `Depth ${level.depth}`} (${level.files.length})`);
    lines.push(...capList(level.files, limit, level.depth === 1 ? directLine : (f) => `- ${f}`, 'file'), '');
  }
  if (result.truncated) lines.push(`… ${plural(result.truncated, 'more file')} beyond depth ${opts.depth} — raise depth to list them`, '');
  if (result.routes.length) {
    lines.push(`### Routes and pages (${result.routes.length})`, ...capList(result.routes, limit, (r) => `- ${r.label} — ${loc(r.file, r.line)}`, 'route'), '');
  }
  lines.push(`### Tests (${result.tests.files.length})`);
  if (!result.tests.files.length) lines.push('No test reaches this code or its users.');
  lines.push(...capList(result.tests.files, limit, (f) => `- ${f}`, 'test'));
  if (result.tests.command) lines.push(`Run: ${code(result.tests.command)}`);
  if (result.tests.untested.length) lines.push(`No test reaches: ${result.tests.untested.slice(0, limit).map((u) => code(untestedLabel(u))).join(', ')}`);
  if (result.owners.length) {
    lines.push('', '### Owners to notify', ...capList(result.owners, Math.min(limit, 10), (o) => `- ${o.owner} (${plural(o.files.length, 'file')})`, 'owner'));
  }
  lines.push('', `Risk ${risk.level} (${risk.score}/100)${risk.reasons.length ? `: ${risk.reasons.join('; ')}` : ''}.`);

  return { text: lines.join('\n').trimEnd(), structured: impactStructured(data, targets, result, risk, { ...opts, sitesPerFile }) };
}

/** The sites of a direct user that use the targets, and how many use other exports of their files (a file-level answer). */
function targetSites(d: ImpactResult['direct'][number] | undefined, targetIds: string[]): { own: UseSite[]; other: UseSite[] } {
  const sites = (d?.sites ?? []).filter((s) => s.kind !== 'import' && s.kind !== 'reexport');
  return { own: sites.filter((s) => usesTarget(s, targetIds)), other: sites.filter((s) => !usesTarget(s, targetIds)) };
}

/**
 * A direct user with what it takes from the targets and its call / render / new sites. For a symbol,
 * only the sites that use it are listed; calls of other exports of its file are only counted.
 */
function directUserLine(data: ReportData, result: ImpactResult, targets: QueryTarget[], sitesPerFile: number): (file: string) => string {
  const direct = new Map(result.direct.map((d) => [d.file, d]));
  const ids = targets.map((t) => t.id);
  const single = targets.length === 1 ? targets[0].id : undefined;
  return (f) => {
    const d = direct.get(f);
    const via = d?.via.length ? ` — ${d.via.slice(0, 4).join(', ')}${d.via.length > 4 ? ', …' : ''}` : '';
    const { own, other } = targetSites(d, ids);
    const shown = own.slice(0, sitesPerFile).map((s) => `\n  - ${loc(s.file, s.line)} ${siteWhat(data, s, single)}`);
    const more = own.length > sitesPerFile ? `\n  - … ${plural(own.length - sitesPerFile, 'more site')}` : '';
    const names = [...new Set(other.map((s) => symbolLabel(data, s.target!)))];
    const others = other.length ? `\n  - (${plural(other.length, 'other site')} in this file use${other.length === 1 ? 's' : ''} ${names.slice(0, 3).map(code).join(', ')}${names.length > 3 ? ', …' : ''}, not the target)` : '';
    return `- ${f}${via}${shown.join('')}${more}${others}`;
  };
}

function impactStructured(data: ReportData, targets: QueryTarget[], result: ImpactResult, risk: ImpactRisk, opts: { limit: number; sitesPerFile: number; alternatives?: string[] }): Record<string, unknown> {
  const { limit, sitesPerFile } = opts;
  const ids = targets.map((t) => t.id);
  const direct = result.direct.slice(0, limit).map((d) => {
    const { own, other } = targetSites(d, ids);
    return { file: d.file, via: d.via, sites: own.slice(0, sitesPerFile * 2).map(siteData), ...(other.length ? { otherSites: other.length } : {}) };
  });
  return {
    targets: targets.map((t) => ({ ...t, label: targetLabel(data, t), ...targetLocation(data, t) })),
    ...(opts.alternatives?.length ? { alternatives: opts.alternatives } : {}),
    precision: result.precision,
    ...(result.precisionNote ? { precisionNote: result.precisionNote } : {}),
    risk,
    total: result.total,
    ...(result.truncated ? { truncated: result.truncated } : {}),
    direct,
    byDepth: result.byDepth.map((l) => ({ depth: l.depth, count: l.files.length, files: l.files.slice(0, limit) })),
    routes: result.routes.slice(0, limit),
    tests: { files: result.tests.files.slice(0, limit), count: result.tests.files.length, command: result.tests.command, untested: result.tests.untested.slice(0, limit) },
    testCommand: result.tests.command,
    dependents: result.byDepth.flatMap((l) => l.files).slice(0, limit),
    owners: result.owners.slice(0, limit).map((o) => ({ owner: o.owner, files: o.files.slice(0, limit), count: o.files.length })),
  };
}

const impactTool: ToolDef = {
  name: 'impact',
  title: 'Impact of a change',
  description:
    'Before editing: what a change to a file, symbol, folder or route affects. Returns dependents by depth with exact call sites (file:line), impacted routes and pages, the tests to run with the exact command, untested code, code owners and a risk level. Symbol-precise (only files that import or call the symbol count) and follows barrels and HTTP calls, which grep misses.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        minLength: 1,
        description: 'A file (src/cart/Cart.tsx), symbol (useCart, CartService.checkout, src/cart/index.ts#useCart), folder (src/cart/) or route (GET /api/cart/:id).',
      },
      depth: { type: 'integer', minimum: 1, maximum: 10, default: 2, description: 'Import levels to list (default 2); deeper dependents are only counted.' },
      ...COMMON_PROPERTIES,
    },
    required: ['target'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const resolved = await resolveArg(ctx, String(args.target));
    if ('error' in resolved) return resolved.error;
    const format = formatOf(args);
    const { text, structured } = renderImpact(resolved.data, [resolved.target], { depth: Number(args.depth ?? 2), limit: limitOf(args), format, alternatives: resolved.alternatives });
    return answer(text, format, structured, 'lower depth or limit, or pass a symbol instead of a file');
  },
};

/* -------------------------------------------------------------------------- */
/*                                  tests_for                                 */
/* -------------------------------------------------------------------------- */

const testsForTool: ToolDef = {
  name: 'tests_for',
  title: 'Tests to run',
  description:
    'Which tests exercise these files, folders or symbols (through imports, and through HTTP requests for route handlers), the exact command that runs only those tests, and which of the given files no test reaches. Use after editing to run the right tests instead of the whole suite.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Files, folders (src/cart/), symbols or routes, relative to the project root.' },
      ...COMMON_PROPERTIES,
    },
    required: ['paths'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    let data = await ctx.report();
    const format = formatOf(args);
    const limit = limitOf(args);
    const inputs: string[] = [];
    for (const p of args.paths as string[]) {
      const checked = projectPath(ctx.root, p);
      if ('error' in checked) return toolError(checked.error);
      inputs.push(checked.id);
    }
    let result = testsFor(data, inputs);
    if (result.unknown.length) {
      const fresh = await withFreshFiles(ctx, data, result.unknown);
      if (fresh !== data) result = testsFor((data = fresh), inputs);
    }
    const unknown = result.unknown.map((input) => ({ input, suggestions: resolveTarget(data, input).suggestions }));
    if (!result.byPath.length) {
      return toolError(unknown.map((u) => notFoundText(data, u.input, u.suggestions, ctx.root)).join('\n'), { error: 'not-found', unknown });
    }
    const lines = [`## ${plural(result.files.length, 'test')} for ${plural(result.byPath.length, 'path')}`, ''];
    lines.push(...capList(result.files, limit, (f) => `- ${f}`, 'test'));
    if (result.command) lines.push('', `Run: ${code(result.command)}`);
    else if (result.files.length) lines.push('', 'No test runner was detected in package.json; run these files with the project’s runner.');
    else lines.push('No test reaches these files.');
    if (result.untested.length) lines.push('', `### No test reaches (${result.untested.length})`, ...capList(result.untested, limit, (f) => `- ${f}`, 'file'));
    for (const u of unknown) lines.push('', notFoundText(data, u.input, u.suggestions, ctx.root));
    if (format === 'detailed' && result.byPath.length > 1) {
      lines.push('', '### By path', ...result.byPath.slice(0, limit).map((b) => `- ${b.path}: ${b.tests.length ? b.tests.join(', ') : 'no tests'}`));
    }
    return answer(lines.join('\n'), format, {
      tests: result.files.slice(0, limit),
      count: result.files.length,
      command: result.command,
      runner: result.runner,
      untested: result.untested.slice(0, limit),
      unknown,
      byPath: result.byPath.slice(0, limit).map((b) => ({ ...b, tests: b.tests.slice(0, limit) })),
    }, 'pass fewer paths, or lower limit');
  },
};

/* -------------------------------------------------------------------------- */
/*                                    route                                   */
/* -------------------------------------------------------------------------- */

function routeText(data: ReportData, m: RouteMatch, limit: number): string[] {
  const lines = [`### ${m.label}${m.exact ? '' : ' (base-URL match)'} — ${m.route.framework}`];
  const h = m.handler;
  if (h) lines.push(`- Handler: ${loc(h.file, h.line)}${h.symbol ? ` ${code(symbolLabel(data, h.symbol))}` : ''}`);
  if (m.route.file !== h?.file || (m.route.line && m.route.line !== h?.line)) lines.push(`- Registered: ${loc(m.route.file, m.route.line)}`);
  const app = (a: RouteMatch['appMiddlewares'][number]): string => `${a.label} (${loc(a.file, a.line)})`;
  const chain = [...m.appMiddlewares.filter((a) => !a.onError).map(app), ...m.middlewares];
  if (chain.length) lines.push(`- Middleware: ${chain.join(' → ')}`);
  const onError = m.appMiddlewares.filter((a) => a.onError);
  if (onError.length) lines.push(`- On error: ${onError.map(app).join(', ')}`);
  lines.push(`- Callers (${m.callers.length})${m.callers.length ? ':' : ': none in this project'}`);
  lines.push(...capList(m.callers, limit, (s) => `  - ${loc(s.file, s.line)} ${siteWhat(data, s)}`, 'caller'));
  lines.push(`- Tests: ${m.tests.length ? m.tests.join(', ') : 'none reach the handler'}`);
  return lines;
}

const routeTool: ToolDef = {
  name: 'route',
  title: 'Which code serves a URL',
  description:
    'Which handler serves an HTTP request or page URL: the matching route, handler file:line, middleware (including app-level and error handlers), the code in the project that calls it (client → route), and the tests that reach it. Accepts concrete URLs like /api/users/42.',
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL', 'PAGE'], description: 'HTTP method (omit to match every method and pages).' },
      url: { type: 'string', minLength: 1, description: 'The request path or URL, e.g. /api/users/42.' },
      ...COMMON_PROPERTIES,
    },
    required: ['url'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const data = await ctx.report();
    const format = formatOf(args);
    const limit = limitOf(args);
    // `GET /api/users/7` in url (models often write it so): the method in it counts unless one is passed.
    const inline = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL|PAGE)\s+(\S.*)$/i.exec(String(args.url).trim());
    const method = typeof args.method === 'string' ? args.method : inline?.[1].toUpperCase();
    const url = (inline ? inline[2] : String(args.url)).trim();
    const matches = routeFor(data, method, url);
    if (!matches.length) {
      const other = method ? routeFor(data, undefined, url).map((m) => m.label) : [];
      const near = suggest(data, url).filter((s) => /^[A-Z]+ \//.test(s));
      const hint = other.length ? `; other methods match: ${other.slice(0, 5).join(', ')}` : near.length ? `; did you mean ${near.join(', ')}?` : data.routes.length ? `. ${plural(data.routes.length, 'route')} are known — project_overview lists them.` : '. No routes were found in this project.';
      return toolError(`No route serves ${method ? `${method} ` : ''}${url}${hint}`, { error: 'not-found', method, url, otherMethods: other, suggestions: near });
    }
    const shown = matches.slice(0, format === 'detailed' ? limit : Math.min(limit, 5));
    const lines = shown.flatMap((m) => [...routeText(data, m, format === 'detailed' ? limit : Math.min(limit, 10)), '']);
    if (matches.length > shown.length) lines.push(`… ${matches.length - shown.length} more matching routes — pass the method or a more specific URL`);
    const items = shown.map((m) => ({
      label: m.label,
      method: m.route.method,
      path: m.route.path,
      framework: m.route.framework,
      type: m.route.type,
      exact: m.exact,
      handler: m.handler,
      registered: { file: m.route.file, line: m.route.line },
      middlewares: m.middlewares.slice(0, limit),
      appMiddlewares: m.appMiddlewares.slice(0, limit),
      callers: m.callers.slice(0, limit).map((s) => ({ ...siteRef(s), ...(s.symbol ? { symbol: s.symbol } : {}), method: s.method, url: s.url })),
      callerCount: m.callers.length,
      tests: m.tests.slice(0, limit),
    }));
    return answer(lines.join('\n').trimEnd(), format, { items, total: matches.length }, 'pass the method or a more specific URL');
  },
};

/* -------------------------------------------------------------------------- */
/*                                     who                                    */
/* -------------------------------------------------------------------------- */

const whoTool: ToolDef = {
  name: 'who',
  title: 'Who knows this code',
  description:
    'Who owns and knows a file, folder, symbol or route: CODEOWNERS owners, the people who changed it (recent work counts more) with their share and last commit, inactive flags, the bus factor and the last change. Use it to pick reviewers or someone to ask.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', minLength: 1, description: 'A file, folder (src/billing/), symbol or route.' },
      ...COMMON_PROPERTIES,
    },
    required: ['target'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const resolved = await resolveArg(ctx, String(args.target));
    if ('error' in resolved) return resolved.error;
    const { data } = resolved;
    const format = formatOf(args);
    const limit = limitOf(args);
    const result = whoOf(data, resolved.target, { limit: Math.min(limit, format === 'detailed' ? limit : 10) });
    const now = Date.now();
    const lines = [`## Who knows ${heading(data, resolved.target)}${result.files > 1 ? ` (${plural(result.files, 'file')})` : ''}`, ''];
    lines.push(...alternativesLine(data, resolved.alternatives));
    lines.push(`- Owners: ${result.owners.length ? result.owners.join(', ') : 'no CODEOWNERS entry'}`);
    if (!result.hasHistory) lines.push(`- Experts: ${data.git ? 'no commits touch these files yet' : 'no git history in this analysis'}`);
    else {
      lines.push('- Experts:');
      for (const e of result.experts) {
        const idle = e.inactive ? `, inactive ${Math.floor((now - e.last) / 86_400_000)}d` : '';
        lines.push(`  - ${person(e.name)}${e.me ? ' (you)' : ''}: ${Math.round(e.share * 100)}% · ${plural(e.commits, 'commit')} · last ${isoDay(e.last)}${idle}`);
      }
      if (result.busFactor !== undefined) lines.push(`- Bus factor: ${result.busFactor}${result.busFactor === 1 && result.experts[0] ? ` (${person(result.experts[0].name)} made most of the changes)` : ''}`);
    }
    const lc = result.lastCommit;
    if (lc) lines.push(`- Last change: ${isoDay(lc.date)} by ${person(lc.author)} (${lc.hash.slice(0, 7)}, ${lc.file})`, fence(lc.subject));
    return answer(lines.join('\n'), format, {
      target: { ...resolved.target, label: targetLabel(data, resolved.target) },
      files: result.files,
      owners: result.owners,
      // Names identify people well enough; emails stay out of what is sent to the model.
      experts: result.experts.map((e) => ({ name: e.name, share: e.share, commits: e.commits, last: isoDay(e.last), inactive: e.inactive, ...(e.me ? { me: true } : {}) })),
      busFactor: result.busFactor,
      lastCommit: lc ? { hash: lc.hash, date: isoDay(lc.date), author: lc.author, subject: lc.subject, file: lc.file } : undefined,
      hasHistory: result.hasHistory,
    }, 'lower limit');
  },
};

/* -------------------------------------------------------------------------- */
/*                                  Registry                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every MCP tool, in the order `tools/list` returns them. Keep at most 9 (agents pick tools better from
 * a short list).
 */
export const TOOLS: ToolDef[] = [projectOverview, impactTool, findSymbolTool, testsForTool, reviewChangesTool, checkArchitectureTool, routeTool, whoTool];
// --- clone-radar: "does this already exist?" ---
TOOLS.push(findSimilarTool);

/** The tools named in `--tools` (comma-separated or repeated), or an error naming the unknown ones. */
export function selectTools(names: string[], tools: ToolDef[] = TOOLS): { tools: ToolDef[] } | { error: string } {
  if (!names.length) return { tools };
  const wanted = names.map((n) => n.trim().replace(/-/g, '_')).filter(Boolean);
  const unknown = wanted.filter((n) => !tools.some((t) => t.name === n));
  if (unknown.length) {
    const hints = unknown.map((n) => closest(n, tools.map((t) => t.name))).filter((h): h is string => !!h);
    const hint = hints.length ? ` — did you mean ${hints.map((h) => `"${h}"`).join(', ')}?` : '';
    return { error: `Unknown tool${unknown.length === 1 ? '' : 's'} ${unknown.map((n) => `"${n}"`).join(', ')}${hint} (available: ${tools.map((t) => t.name).join(', ')}).` };
  }
  return { tools: tools.filter((t) => wanted.includes(t.name)) };
}

