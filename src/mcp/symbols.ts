/**
 * `find_symbol`: where a function, component, class, method or type is declared and where it is used.
 */
import { buildIndex, resolveTarget, suggest, symbolRef, usesOf } from '../shared/query.js';
import { signature } from '../shared/signature.js';
import type { MemberInfo, ReportData, SymbolInfo, SymbolKind } from '../shared/types.js';
import { formatOf, indent, limitOf, siteData, siteWhat, withFreshFiles } from './format.js';
import { isPathLike, projectPath } from './paths.js';
import { answer, capList, code, COMMON_PROPERTIES, fence, loc, plural, READ_ONLY, toolError, type ToolDef } from './protocol.js';

const SYMBOL_KINDS: (SymbolKind | 'method')[] = ['function', 'component', 'hook', 'class', 'method', 'interface', 'type', 'enum', 'constant', 'variable', 'namespace'];

export interface Definition {
  id: string;
  name: string;
  kind: SymbolKind | MemberInfo['kind'];
  file: string;
  line: number;
  endLine?: number;
  exported: boolean;
  signature: string;
  doc?: string;
  deprecated?: string;
  complexity?: number;
  score: number;
}

function memberSignature(owner: SymbolInfo, m: MemberInfo): string {
  if (m.kind === 'method' || m.kind === 'constructor' || m.params) {
    const params = (m.params ?? []).map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional || p.defaultValue !== undefined ? '?' : ''}${p.type ? `: ${p.type}` : ''}`).join(', ');
    return `${m.async ? 'async ' : ''}${owner.name}.${m.name}(${params})${m.type ? `: ${m.type}` : ''}`;
  }
  return `${owner.name}.${m.name}${m.type ? `: ${m.type}` : ''}`;
}

/** How well a name matches the query: 0 exact … 4 a close typo; -1 no match. */
function nameScore(name: string, query: string): number {
  if (name === query) return 0;
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 1;
  if (n.startsWith(q)) return 2;
  if (q.length >= 3 && n.includes(q)) return 3;
  if (q.length >= 4 && Math.abs(n.length - q.length) <= 2 && levenshtein(n, q) <= Math.max(1, Math.floor(q.length / 4))) return 4;
  return -1;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length];
}

const definitionOf = (s: SymbolInfo, file: string, score: number): Definition => ({
  id: s.id,
  name: s.name,
  kind: s.kind,
  file,
  line: s.line,
  endLine: s.endLine,
  exported: s.exported,
  signature: signature(s),
  doc: s.doc,
  deprecated: s.deprecated,
  complexity: s.complexity,
  score,
});

const memberDefinition = (owner: SymbolInfo, m: MemberInfo, file: string, score: number): Definition => ({
  id: `${owner.id}.${m.name}`,
  name: `${owner.name}.${m.name}`,
  kind: m.kind,
  file,
  line: m.line,
  exported: owner.exported,
  signature: memberSignature(owner, m),
  score,
});

/** `path#Name` (one declaration) or a file path (its declarations, exported first). */
function definitionsAt(data: ReportData, query: string): Definition[] {
  const r = resolveTarget(data, query);
  if (r.target?.type === 'symbol') {
    const ref = symbolRef(data, r.target.id);
    if (!ref) return [];
    return [ref.member ? memberDefinition(ref.symbol, ref.member, ref.file.id, 0) : definitionOf(ref.symbol, ref.file.id, 0)];
  }
  if (r.target?.type !== 'file') return [];
  const file = buildIndex(data).fileById.get(r.target.id)!;
  return file.symbols.map((s, i) => definitionOf(s, file.id, s.exported ? 0 : 1 + i / 1000));
}

const METHOD_KINDS = new Set(['method', 'getter', 'setter']);

/** Declarations by name: exact, case-insensitive, prefix, substring or a close typo; `Class.member`; methods by name. */
function definitionsNamed(data: ReportData, query: string): Definition[] {
  const defs: Definition[] = [];
  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$#][\w$]*)$/.exec(query);
  for (const file of data.files) {
    for (const s of file.symbols) {
      if (member) {
        if (s.name !== member[1]) continue;
        for (const m of s.members ?? []) {
          const score = nameScore(m.name, member[2]);
          if (score >= 0) defs.push(memberDefinition(s, m, file.id, score));
        }
        continue;
      }
      const score = nameScore(s.name, query);
      if (score >= 0) defs.push(definitionOf(s, file.id, score));
      if (s.kind !== 'class' || query.length < 3) continue;
      // Methods by name (`checkout` finds CartService.checkout), a little behind top-level matches.
      for (const m of s.members ?? []) {
        const ms = METHOD_KINDS.has(m.kind) ? nameScore(m.name, query) : -1;
        if (ms >= 0 && ms <= 2) defs.push(memberDefinition(s, m, file.id, ms + 0.5));
      }
    }
  }
  return defs;
}

/** Declarations matching a name (or `Class.member`, or `path#Name`), best first: closest name, not in tests, exported, most used. */
export function findDefinitions(data: ReportData, query: string, opts: { kind?: string; exportedOnly?: boolean } = {}): Definition[] {
  const idx = buildIndex(data);
  const q = query.trim();
  const defs = q.includes('#') || isPathLike(q) ? definitionsAt(data, q) : definitionsNamed(data, q);
  const kind = opts.kind;
  const wanted = (d: Definition): boolean => !kind || d.kind === kind || (kind === 'method' && (METHOD_KINDS.has(d.kind) || d.kind === 'constructor' || d.kind === 'property'));
  const inTest = (d: Definition): number => (idx.fileById.get(d.file)?.kind === 'test' ? 1 : 0);
  const fanIn = (d: Definition): number => idx.fileById.get(d.file)?.metrics.fanIn ?? 0;
  return defs
    .filter((d) => wanted(d) && (!opts.exportedOnly || d.exported))
    .sort((a, b) => a.score - b.score || inTest(a) - inTest(b) || Number(b.exported) - Number(a.exported) || fanIn(b) - fanIn(a) || a.id.localeCompare(b.id));
}

export const findSymbolTool: ToolDef = {
  name: 'find_symbol',
  title: 'Find a symbol',
  description:
    'Where a function, component, hook, class, method, type or constant is defined (file:line, signature, doc, deprecation) and where it is used (imports and exact call / render / new sites, through barrels). Accepts a name, a prefix, Class.method or path#Name. More precise than grep: it tells definitions from uses.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'A symbol name (formatDate), prefix (useCa), Class.method, or path#Name.' },
      kind: { type: 'string', enum: SYMBOL_KINDS, description: 'Only symbols of this kind.' },
      exported_only: { type: 'boolean', default: false, description: 'Only exported symbols.' },
      ...COMMON_PROPERTIES,
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    let data = await ctx.report();
    const query = String(args.query);
    const checked = projectPath(ctx.root, query);
    if ('error' in checked) return toolError(checked.error);
    const format = formatOf(args);
    const limit = limitOf(args);
    const options = { kind: args.kind as string | undefined, exportedOnly: args.exported_only === true };
    let defs = findDefinitions(data, checked.id, options);
    if (!defs.length) {
      // `src/new.ts#name` of a file created a moment ago.
      const fresh = await withFreshFiles(ctx, data, [checked.id]);
      if (fresh !== data) defs = findDefinitions((data = fresh), checked.id, options);
    }
    if (!defs.length) {
      const suggestions = suggest(data, query);
      const filter = [args.kind ? `kind ${args.kind}` : '', args.exported_only ? 'exported' : ''].filter(Boolean).join(', ');
      return toolError(`No symbol matches "${query}"${filter ? ` (${filter})` : ''}${suggestions.length ? `; did you mean ${suggestions.join(', ')}?` : '.'}`, { error: 'not-found', input: query, suggestions });
    }
    const shown = defs.slice(0, limit);
    // Use sites for the best few (all of them in detailed answers); the rest get their use count.
    const withSites = format === 'detailed' ? shown.length : Math.min(3, shown.length);
    const sitesPer = format === 'detailed' ? 20 : 8;
    const lines = [`## ${plural(defs.length, 'definition')} for ${code(query)}`, ''];
    const items = shown.map((d, i) => {
      const described = describeDefinition(data, d, i < withSites ? sitesPer : 0, i < withSites || format === 'detailed');
      lines.push(`${i + 1}. ${described.lines.join('\n')}`);
      return described.item;
    });
    if (defs.length > shown.length) lines.push(`… ${plural(defs.length - shown.length, 'more definition')} — narrow with kind, exported_only or path#Name`);
    return answer(lines.join('\n'), format, { items, total: defs.length }, 'narrow with kind, exported_only or path#Name, or lower limit');
  },
};

/**
 * How much a definition is used. Calls on instances (`service.method()`) and values passed around are
 * not tracked, so "no use" is never stated as a fact: methods and members say so, and a symbol that other
 * exports of its file reach is not unused.
 */
function useStatus(d: Definition, files: number, through: number): string {
  if (files) return `Used in ${plural(files, 'file')}`;
  const untracked = 'no direct use found (calls on instances and values passed around are not tracked)';
  if (through) return `${untracked}; reached through other exports from ${plural(through, 'file')}`;
  return d.id.indexOf('.', d.id.indexOf('#')) > 0 ? untracked : 'Not used by other analyzed code (a value passed around, e.g. in a table or array, is not tracked)';
}

/** One definition: its line, deprecation, doc (fenced) and up to `sites` use sites. */
function describeDefinition(data: ReportData, d: Definition, sites: number, withDoc: boolean): { lines: string[]; item: Record<string, unknown> } {
  const uses = usesOf(data, { type: 'symbol', id: d.id });
  const all = [...uses.sites, ...uses.http, ...uses.imports].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const throughFiles = new Set(uses.through.map((s) => s.file)).size;
  const lines = [`${code(d.signature)} — ${loc(d.file, d.line)} · ${d.exported ? 'exported ' : ''}${d.kind}${d.complexity && d.complexity > 1 ? ` · complexity ${d.complexity}` : ''}`];
  if (d.deprecated !== undefined) lines.push(`   Deprecated${d.deprecated ? ':' : ''}`, ...(d.deprecated ? [indent(fence(d.deprecated), 3)] : []));
  if (d.doc && withDoc) lines.push(indent(fence(d.doc), 3));
  lines.push(`   ${useStatus(d, uses.files, throughFiles)}${sites && all.length ? ':' : ''}`);
  if (sites) lines.push(...capList(all, sites, (s) => `   - ${loc(s.file, s.line)} ${siteWhat(data, s, d.id)}`, 'site', 'call impact or use response_format detailed'));
  if (sites && !uses.files && uses.through.length) {
    lines.push(...capList(uses.through, Math.min(sites, 5), (s) => `   - ${loc(s.file, s.line)} ${siteWhat(data, s, d.id)}`, 'site', 'call impact for all of them'));
  }
  const { score: _score, doc, ...rest } = d;
  const item = {
    ...rest,
    // Doc comments are repo text: only for the definitions whose doc the answer shows.
    ...(doc && withDoc ? { doc } : {}),
    usedInFiles: uses.files,
    ...(throughFiles ? { reachedThroughFiles: throughFiles } : {}),
    sites: all.slice(0, sites).map(siteData),
  };
  return { lines, item };
}
