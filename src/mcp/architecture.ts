/**
 * `check_architecture`: may A import B under the configured rules and layers, what to use instead, and
 * the current violations — judged with the configuration as it is now.
 */
import { evaluateRules, loadConfig, type CodeVisualizerConfig, type RuleConfig } from '../analyzer/config.js';
import { shortNames } from '../shared/delta.js';
import { buildIndex, filesOfTarget, importPath, resolveTarget, type PathResult } from '../shared/query.js';
import type { DependencyEdge, ReportData, RuleViolation } from '../shared/types.js';
import { formatOf, limitOf, notFoundText, withFreshFiles } from './format.js';
import { isPathLike, projectPath } from './paths.js';
import { ALIAS_LIKE, lookupModule, mapSpecifier, packageOf } from './specifier.js';
import { answer, capList, code, COMMON_PROPERTIES, loc, plural, READ_ONLY, toolError, type ToolDef, type ToolResult } from './protocol.js';

const globs = (v: string | string[] | undefined): string => (Array.isArray(v) ? v : v ? [v] : []).map(code).join(', ');

/** One line per rule: `name`: from → to (except allow), severity, message. */
export function ruleLines(config: CodeVisualizerConfig): string[] {
  const lines = (config.rules ?? []).map((r: RuleConfig, i) => {
    const allow = r.allow ? ` except ${globs(r.allow)}` : '';
    const types = r.includeTypes === false ? ' (type-only imports allowed)' : '';
    return `- ${code(r.name ?? `rule-${i + 1}`)}: ${globs(r.from)} must not import ${globs(r.to)}${allow}${types} — ${r.severity ?? 'error'}${r.message ? `: ${r.message}` : ''}`;
  });
  if (config.layers?.length) {
    lines.push(`- Layers, top to bottom (a lower layer must not import a higher one): ${config.layers.map((l) => (Array.isArray(l) ? l.map(code).join(' + ') : code(l))).join(' → ')}`);
  }
  return lines;
}

const topFolder = (id: string): string => {
  const parts = id.split('/');
  return parts.length > 2 && (parts[0] === 'src' || parts[0] === 'packages' || parts[0] === 'apps') ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : '';
};

const edge = (source: string, target: string, typeOnly = false): DependencyEdge => ({ source, target, kind: 'import', typeOnly, names: [], line: 0, specifier: '' });

interface ArchEnd {
  input: string;
  files: string[];
  /** The path does not exist yet (a file the agent plans to create): judged by its path. */
  planned?: boolean;
  /** How an import specifier was mapped to a project path (`the @/ alias (the project root)`). */
  how?: string;
}

/** The files a project path stands for: a module (extensions, index files, `.js` → `.ts`), a symbol's file, a folder's files. */
function endFiles(data: ReportData, id: string): Pick<ArchEnd, 'files' | 'planned'> | undefined {
  const pathLike = !id.includes('#') && (isPathLike(id) || /\.[A-Za-z0-9]{1,6}$/.test(id));
  const module = pathLike ? lookupModule(new Set(data.files.map((f) => f.id)), id) : undefined;
  if (module) return { files: [module] };
  const r = resolveTarget(data, id);
  if (!r.target) return undefined;
  const files = filesOfTarget(data, r.target);
  if (r.target.type === 'dir' && !files.length) return { files: [`${r.target.id ? `${r.target.id}/` : ''}index.ts`], planned: true };
  return files.length ? { files: r.target.type === 'route' ? files.slice(-1) : files.slice(0, 400) } : undefined;
}

/**
 * The files `input` stands for: an analyzed file, a symbol's file, a folder's files, an import specifier
 * as written in an import statement (`@/lib/db`, `../lib/format.js`, relative to `importer`), or a planned
 * path. An alias nothing resolves is an error, never a verdict.
 */
function archEnd(data: ReportData, root: string, input: string, importer?: string): ArchEnd | { error: ToolResult } {
  const raw = input.trim();
  const alias = ALIAS_LIKE.test(raw);
  const specifier = alias || (importer && /^\.\.?\//.test(raw)) ? mapSpecifier(data, raw, importer) : undefined;
  if (specifier && 'error' in specifier) return { error: toolError(specifier.error) };
  if (alias && !specifier) {
    const rest = raw.replace(ALIAS_LIKE, '');
    const suggestions = rest ? resolveTarget(data, rest).suggestions.slice(0, 3) : [];
    const hint = suggestions.length ? ` (did you mean ${suggestions.join(', ')}?)` : '';
    return { error: toolError(`${raw} looks like an import alias, but no import in the project resolves it; pass the file path relative to the project root${hint}.`, { error: 'not-found', input, suggestions }) };
  }
  let id: string;
  let how = specifier?.how;
  if (specifier) id = specifier.id;
  else {
    const checked = projectPath(root, raw);
    if ('error' in checked) return { error: toolError(checked.error) };
    id = checked.id;
  }
  const found = endFiles(data, id);
  if (found) return { input, how, ...found };
  if (!specifier) {
    // A specifier the project's imports reveal (`@acme/ui/button`, a tsconfig path) or an ESM `.js` path.
    const mapped = mapSpecifier(data, raw);
    if (mapped && 'error' in mapped) return { error: toolError(mapped.error) };
    if (mapped) {
      const hit = endFiles(data, mapped.id);
      if (hit) return { input, how: mapped.how, ...hit };
      id = mapped.id;
      how = mapped.how;
    }
  }
  const suggestions = resolveTarget(data, id).suggestions;
  if (how || isPathLike(id) || /\.[A-Za-z0-9]{1,6}$/.test(id)) {
    // Not analyzed (yet): rules are globs, so a planned file can be judged by its path.
    const planned = id.replace(/^\/+/, '');
    return { input, files: [planned.endsWith('/') || !planned ? `${planned}index.ts` : planned], planned: true, how };
  }
  return { error: toolError(notFoundText(data, id, suggestions), { error: 'not-found', input, suggestions }) };
}

/** What the answer says about an end that is not an analyzed file, or that was given as an import specifier. */
function endNote(end: ArchEnd): string | undefined {
  const file = end.files.length === 1 ? end.files[0] : undefined;
  if (end.planned) return `${code(end.input)} is not a file in the project yet${end.how ? ` (${code(file ?? end.input)}, ${end.how})` : ''}; judged by its path.`;
  if (end.how && file) return `${code(end.input)} is ${code(file)} (${end.how}).`;
  return undefined;
}

const violationLine = (v: RuleViolation): string => `- ${loc(v.source, v.line || undefined)} → ${v.target} — ${code(v.rule)} (${v.severity})${v.message ? `: ${v.message}` : ''}`;

function ruleSummary(config: CodeVisualizerConfig, file: string | undefined): string {
  const rules = config.rules?.length ?? 0;
  const layers = config.layers?.length ?? 0;
  if (!rules && !layers) return 'No architecture rules are configured (code-visualizer.config.json `rules` / `layers`).';
  return `${plural(rules, 'rule')}${layers ? ` and ${plural(layers, 'layer')}` : ''} from ${file ?? 'the configuration'}.`;
}

/** Files that only start or check the program: importing them is never the way to reuse their code. */
const NOT_A_MODULE = new Set(['test', 'story', 'script', 'config', 'entry']);

/**
 * Files that already import one of `targets`, that every `sources` file may import, and that are made
 * to be imported (used by other files; no entry points, scripts, configs or tests). A facade next to the
 * target comes first, then the importer's own top folder, then the most used.
 */
function allowedAlternatives(data: ReportData, config: CodeVisualizerConfig, sources: string[], targets: string[]): { file: string; fanIn: number; line: number }[] {
  const idx = buildIndex(data);
  const fromSet = new Set(sources);
  const candidates = new Map<string, DependencyEdge[]>();
  for (const t of targets) {
    for (const e of idx.in.get(t) ?? []) if (!fromSet.has(e.source) && !e.typeOnly) candidates.set(e.source, [...(candidates.get(e.source) ?? []), e]);
  }
  const fromTop = topFolder(sources[0]);
  const targetTop = topFolder(targets[0]);
  const reusable = (x: string): boolean => {
    const f = idx.fileById.get(x);
    return !!f && !f.isEntry && !NOT_A_MODULE.has(f.kind) && f.metrics.fanIn > 0;
  };
  return [...candidates.entries()]
    .filter(([x]) => reusable(x))
    .filter(([x, edges]) => !evaluateRules(config, [...sources.map((s) => edge(s, x)), ...edges]).length)
    .map(([file, edges]) => ({ file, line: edges[0].line, fanIn: idx.fileById.get(file)?.metrics.fanIn ?? 0, facade: topFolder(file) === targetTop, same: topFolder(file) === fromTop }))
    .sort((p, q) => Number(q.facade) - Number(p.facade) || Number(q.same) - Number(p.same) || q.fanIn - p.fanIn || p.file.localeCompare(q.file))
    .slice(0, 2)
    .map(({ file, fanIn, line }) => ({ file, fanIn, line }));
}

/** Between two single files: the cycle the import would close, and whether it already exists. */
function importNotes(data: ReportData, a: ArchEnd, b: ArchEnd): { loop?: PathResult; existing?: DependencyEdge; notes: string[] } {
  if (a.files.length !== 1 || b.files.length !== 1 || a.planned || b.planned) return { notes: [] };
  const [from, to] = [a.files[0], b.files[0]];
  const notes: string[] = [];
  const loop = importPath(data, to, from);
  if (loop) {
    const chain = [to, ...loop.hops.map((h) => h.target)];
    const names = shortNames(chain);
    notes.push('', `⚠ This import would create a circular dependency: ${code(to)} already depends on ${code(from)} (${chain.map((id) => names.get(id) ?? id).join(' → ')}).`);
  }
  const existing = data.edges.find((e) => e.source === from && e.target === to);
  if (existing) notes.push('', `(${from} already imports it at line ${existing.line}.)`);
  return { loop, existing, notes };
}

/** "May `from` import `to`?": the verdict, the rules that forbid it, alternatives and a cycle warning. */
function canImport(data: ReportData, config: CodeVisualizerConfig, a: ArchEnd, b: ArchEnd, opts: { limit: number; configFile?: string }): { text: string; structured: Record<string, unknown> } {
  const pairs = a.files.flatMap((s) => b.files.filter((t) => t !== s).map((t) => edge(s, t))).slice(0, 4000);
  const violations = evaluateRules(config, pairs);
  const verdict = violations.some((v) => v.severity === 'error') ? 'forbidden' : violations.length ? 'discouraged' : 'allowed';
  const typeOnlyAllowed = violations.length > 0 && !evaluateRules(config, pairs.map((e) => ({ ...e, typeOnly: true }))).length;
  const fromLabel = code(a.files.length === 1 ? a.files[0] : a.input);
  const toLabel = code(b.files.length === 1 ? b.files[0] : b.input);
  const lines: string[] =
    verdict === 'allowed'
      ? [`✔ ${fromLabel} may import ${toLabel}: no rule or layer forbids it.`]
      : [`${verdict === 'forbidden' ? '✖' : '⚠'} ${fromLabel} ${verdict === 'forbidden' ? 'must not' : 'should not'} import ${toLabel}:`, ...capList(violations, opts.limit, violationLine, 'violation')];
  if (typeOnlyAllowed) lines.push('A type-only import (`import type`) is allowed.');
  const alternatives = violations.length ? allowedAlternatives(data, config, a.files, b.files) : [];
  if (alternatives.length) lines.push('', 'Allowed alternatives (they already import it, and you may import them):', ...alternatives.map((x) => `- ${x.file} (imports it at line ${x.line}; used by ${plural(x.fanIn, 'file')})`));
  else if (violations.length) lines.push('', 'No allowed file in the project imports it yet; move the shared code to a layer both may use.');
  const { loop, existing, notes } = importNotes(data, a, b);
  const ends = [endNote(a), endNote(b)].filter((n): n is string => !!n);
  lines.push(...notes, ...(ends.length ? ['', ...ends] : []), '', ruleSummary(config, opts.configFile));
  const structured = {
    verdict,
    allowed: verdict !== 'forbidden',
    from: a.files.slice(0, opts.limit),
    to: b.files.slice(0, opts.limit),
    ...(a.planned || b.planned ? { planned: true } : {}),
    ...(a.how || b.how ? { resolved: Object.fromEntries([a, b].filter((e) => e.how).map((e) => [e.input, { files: e.files.slice(0, opts.limit), how: e.how }])) } : {}),
    violations: violations.slice(0, opts.limit),
    ...(typeOnlyAllowed ? { typeOnlyAllowed } : {}),
    alternatives,
    ...(loop ? { cycle: loop.hops.map((h) => ({ source: h.source, target: h.target, line: h.line })) } : {}),
    ...(existing ? { existing: { line: existing.line } } : {}),
  };
  return { text: lines.join('\n'), structured };
}

/** The violations of imports from or to `scopes` (all imports without scopes), judged with the configuration as it is now. */
function currentViolations(data: ReportData, config: CodeVisualizerConfig, scopes: string[], labels: string[], opts: { limit: number; configFile?: string }): { text: string; structured: Record<string, unknown> } {
  const inScope = new Set(scopes);
  const edges = scopes.length ? data.edges.filter((e) => inScope.has(e.source) || inScope.has(e.target)) : data.edges;
  const violations = evaluateRules(config, edges);
  const lines: string[] = [];
  if (!scopes.length) lines.push('## Architecture rules', '', ...(ruleLines(config).length ? ruleLines(config) : [ruleSummary(config, opts.configFile)]), '');
  lines.push(`### ${violations.length ? plural(violations.length, 'violation') : 'No violations'}${labels.length ? ` involving ${labels.map(code).join(', ')}` : ''}`);
  lines.push(...capList(violations, opts.limit, violationLine, 'violation'));
  if (scopes.length) lines.push('', ruleSummary(config, opts.configFile));
  return { text: lines.join('\n'), structured: { violations: violations.slice(0, opts.limit), total: violations.length, rules: config.rules ?? [], layers: config.layers ?? [] } };
}

const HINT = 'pass paths, or lower limit';

export const checkArchitectureTool: ToolDef = {
  name: 'check_architecture',
  title: 'Check architecture rules',
  description:
    "Before adding an import: may file A import B under the project's architecture rules and layers? Returns the verdict, the rule that forbids it, up to 2 allowed alternatives (files that already import B and that A may use), and whether the import would create a cycle. With paths: the current rule violations involving those files or folders. Without arguments: the rules and all violations.",
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'The importing file or folder (may be a file you are about to create).' },
      to: { type: 'string', description: 'The file, folder or symbol it would import, or the import specifier as you would write it (@/lib/db, ../lib/format.js).' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files or folders whose current violations to list.' },
      ...COMMON_PROPERTIES,
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    let data = await ctx.report();
    const format = formatOf(args);
    const opts = { limit: limitOf(args), configFile: undefined as string | undefined };
    // The configuration as it is now: an edited rule applies right away.
    const loaded = loadConfig(ctx.root);
    if (loaded.error) return toolError(`The architecture configuration cannot be used: ${loaded.error}`);
    opts.configFile = loaded.file;
    const from = typeof args.from === 'string' ? args.from.trim() : '';
    const to = typeof args.to === 'string' ? args.to.trim() : '';
    if (!!from !== !!to) return toolError('Pass both "from" and "to" to ask whether an import is allowed, or "paths" to list current violations.');
    // A file created a moment ago is judged as the file it is, not as a planned path.
    data = await withFreshFiles(ctx, data, [from, to, ...((args.paths as string[] | undefined) ?? [])].filter(Boolean));
    if (from && to) {
      const a = archEnd(data, ctx.root, from);
      if ('error' in a) return a.error;
      const pkg = packageOf(data, to);
      if (pkg && !endFiles(data, to) && !mapSpecifier(data, to)) {
        const text = `✔ ${code(a.files.length === 1 ? a.files[0] : from)} may import the package ${code(pkg)}: architecture rules govern imports between project files only.`;
        return answer(text, format, { verdict: 'allowed', allowed: true, from: a.files.slice(0, opts.limit), package: pkg, violations: [], alternatives: [] }, HINT);
      }
      const b = archEnd(data, ctx.root, to, a.files.length === 1 ? a.files[0] : undefined);
      if ('error' in b) return b.error;
      if (a.files.length === 1 && b.files.length === 1 && a.files[0] === b.files[0]) return toolError(`${code(a.files[0])} cannot import itself; "from" and "to" name the same file.`);
      const { text, structured } = canImport(data, loaded.config, a, b, opts);
      return answer(text, format, structured, HINT);
    }
    const paths = (args.paths as string[] | undefined) ?? [];
    const scopes: string[] = [];
    for (const p of paths) {
      const end = archEnd(data, ctx.root, p);
      if ('error' in end) return end.error;
      scopes.push(...end.files);
    }
    const { text, structured } = currentViolations(data, loaded.config, scopes, paths, opts);
    return answer(text, format, structured, HINT);
  },
};
