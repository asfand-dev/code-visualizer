/**
 * Shared pieces of the MCP tool answers: argument reading, actionable "not found" errors with
 * suggestions, and how targets and use sites are written (`file:line`, repo-relative).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileOfSymbol, resolveTarget, symbolRef, targetLabel, targetLocation, type QueryTarget, type UseSite } from '../shared/query.js';
import { SOURCE_FILE_RE } from '../shared/source-files.js';
import type { ReportData } from '../shared/types.js';
import { isPathLike, projectPath } from './paths.js';
import { code, loc, plural, toolError, type McpContext, type ResponseFormat, type ToolResult } from './protocol.js';

export const formatOf = (args: Record<string, unknown>): ResponseFormat => (args.response_format === 'detailed' ? 'detailed' : 'concise');
export const limitOf = (args: Record<string, unknown>): number => (typeof args.limit === 'number' ? args.limit : 30);
export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** `formatDate`, `CartService.checkout`, or the file for a file id. */
export function symbolLabel(data: ReportData, id: string): string {
  return symbolRef(data, id)?.label ?? id.slice(id.indexOf('#') + 1);
}


/** A project-relative file that exists on disk (the id was checked to stay inside the project). */
function onDisk(root: string, id: string): boolean {
  try {
    return fs.statSync(path.join(root, id)).isFile();
  } catch {
    return false;
  }
}

/**
 * The analysis again when some inputs name source files that exist on disk but not in the analysis yet
 * (created a moment ago, or with `--no-watch`); otherwise `data` as it is.
 */
export async function withFreshFiles(ctx: McpContext, data: ReportData, inputs: string[]): Promise<ReportData> {
  if (!ctx.refresh) return data;
  const known = new Set(data.files.map((f) => f.id));
  const fresh = inputs
    .map((input) => projectPath(ctx.root, input))
    .flatMap((checked) => ('id' in checked ? [checked.id.split('#')[0]] : []))
    .filter((id) => SOURCE_FILE_RE.test(id) && !known.has(id) && onDisk(ctx.root, id));
  return fresh.length ? ctx.refresh([...new Set(fresh)]) : data;
}

/** A target that names nothing in the analysis, as an actionable error. */
export function notFoundText(data: ReportData, input: string, suggestions: string[], root?: string): string {
  if (root && SOURCE_FILE_RE.test(input) && onDisk(root, input)) {
    return `${input} exists but is not part of the analysis (excluded with -e or the configuration, git-ignored, or in a nested project).`;
  }
  const extra = indexSuggestions(data, input);
  const all = [...new Set([...extra, ...suggestions])].slice(0, 5);
  const what = /\/$/.test(input)
    ? `No folder ${input}`
    : /\.[A-Za-z0-9]{1,6}$/.test(input) && (isPathLike(input) || !input.includes(' '))
      ? `No file ${input}`
      : isPathLike(input)
        ? `No file or folder ${input}`
        : `Nothing named "${input}" in ${data.project.name} (files, symbols, folders and routes were searched)`;
  return `${what}${all.length ? `; did you mean ${all.join(', ')}?` : '. Try find_symbol, or project_overview for the structure.'}`;
}

/** `src/cart.ts` asked, but the module is the folder `src/cart/` with its index file. */
function indexSuggestions(data: ReportData, input: string): string[] {
  const stem = input.replace(/\.[A-Za-z0-9]{1,6}$/, '').replace(/\/+$/, '');
  if (!stem || stem === input.replace(/\/+$/, '')) return [];
  return data.files.filter((f) => f.dir === stem && /^index\.[cm]?[jt]sx?$/.test(f.name)).map((f) => f.id);
}

export type Resolved = { data: ReportData } & ({ target: QueryTarget; alternatives?: string[] } | { error: ToolResult });

/**
 * A tool's target argument: kept inside the project, resolved like the CLI queries do, with the analysis
 * it was resolved in (analyzed again first when it names a file created since the last analysis).
 */
export async function resolveArg(ctx: McpContext, input: string): Promise<Resolved> {
  let data = await ctx.report();
  const checked = projectPath(ctx.root, input);
  if ('error' in checked) return { data, error: toolError(checked.error) };
  let r = resolveTarget(data, checked.id);
  if (!r.target) {
    const fresh = await withFreshFiles(ctx, data, [checked.id]);
    if (fresh !== data) r = resolveTarget((data = fresh), checked.id);
  }
  if (!r.target) return { data, error: toolError(notFoundText(data, checked.id, r.suggestions, ctx.root), { error: 'not-found', input, suggestions: r.suggestions }) };
  return { data, target: r.target, alternatives: r.alternatives };
}

/** `formatDate (src/utils/format.ts:11)`, `src/cart/`, `GET /api/x (routes/x.js:4)` */
export function heading(data: ReportData, target: QueryTarget): string {
  const label = targetLabel(data, target);
  const at = targetLocation(data, target);
  if (target.type === 'file' || target.type === 'dir' || !at.file) return code(label);
  return `${code(label)} (${loc(at.file, at.line)})`;
}

export function alternativesLine(data: ReportData, alternatives: string[] | undefined): string[] {
  if (!alternatives?.length) return [];
  const list = alternatives.slice(0, 4).map((id) => `${code(id)} (${loc(fileOfSymbol(id), symbolRef(data, id)?.line)})`);
  return [`Also named so: ${list.join(', ')} — pass path#Name to pick one.`];
}

/**
 * What happens at a use site: `call in Checkout (2 args)`, `import { a, b }`, `GET /api/x in load`. A
 * site that uses another symbol than the asked one (a file or class target, a file-level answer) names
 * it: `call in update (2 args) → UserService.update`.
 */
export function siteWhat(data: ReportData, s: UseSite, targetId?: string): string {
  const where = s.symbol ? ` in ${symbolLabel(data, s.symbol)}` : '';
  if (s.kind === 'import' || s.kind === 'reexport') {
    const names = (s.names ?? []).filter((n) => n !== '*');
    const what = names.length ? `{ ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''} }` : '* (whole module)';
    return `${s.kind === 'reexport' ? 're-export' : 'import'} ${what}${s.typeOnly ? ' (type)' : ''}${s.via ? ` via ${s.via}` : ''}`;
  }
  if (s.kind === 'http') return `${s.method ?? ''} ${s.url ?? ''}${where}`.trim();
  const args = s.argc !== undefined && s.kind !== 'render' ? (s.argc < 0 ? ' (spread args)' : ` (${plural(s.argc, 'arg')})`) : '';
  const which = s.target && s.target !== targetId && s.target.includes('#') ? ` → ${symbolLabel(data, s.target)}` : '';
  return `${s.kind}${where}${args}${which}`;
}

/**
 * Whether a site uses one of the symbol targets (a class: also its members). Sites of file targets,
 * HTTP requests (their target is the route) and sites without a known callee all count.
 */
export function usesTarget(s: UseSite, targetIds: string[]): boolean {
  const symbols = targetIds.filter((id) => id.includes('#'));
  if (symbols.length < targetIds.length || s.kind === 'http' || !s.target?.includes('#')) return true;
  return symbols.some((id) => s.target === id || s.target!.startsWith(`${id}.`));
}

export const siteRef = (s: { file: string; line: number }): { file: string; line: number } => ({ file: s.file, line: s.line });

/** A use site as structured data: where, how, in which symbol, and which symbol it uses. */
export const siteData = (s: UseSite): Record<string, unknown> => ({
  file: s.file,
  line: s.line,
  kind: s.kind,
  ...(s.symbol ? { symbol: s.symbol } : {}),
  ...(s.target ? { target: s.target } : {}),
  ...(s.argc !== undefined ? { argc: s.argc } : {}),
  ...(s.names?.length ? { names: s.names } : {}),
  ...(s.via ? { via: s.via } : {}),
  ...(s.method ? { method: s.method, url: s.url } : {}),
});

/**
 * A person's name from git history in Markdown: on one line, without characters that would format or
 * link (it is repo-controlled text, like a commit subject).
 */
export const person = (name: string): string =>
  name
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_<>[\]|#\\]/g, '')
    .trim()
    .slice(0, 80) || 'unknown';

export const indent = (text: string, n: number): string =>
  text
    .split('\n')
    .map((l) => `${' '.repeat(n)}${l}`)
    .join('\n');
