/**
 * `find_similar` (clone-radar): before an agent writes a helper — or right after — the existing functions
 * that already do the same thing, so it imports one instead of adding another copy.
 */
import { CloneTokenStore, similarTo, symbolLines, type SimilarAnswer } from '../analyzer/clones.js';
import { fragmentLocation, fragmentName, reuseAdvice, similarityLabel } from '../shared/clones.js';
import { resolveTarget } from '../shared/query.js';
import type { SimilarMatch } from '../shared/types.js';
import { formatOf, limitOf, notFoundText, withFreshFiles } from './format.js';
import { projectPath } from './paths.js';
import { answer, capList, code, COMMON_PROPERTIES, loc, plural, READ_ONLY, toolError, type ToolDef } from './protocol.js';

/** One token store per project for the life of the server: files are re-tokenized only when they change. */
const stores = new Map<string, CloneTokenStore>();
const storeFor = (root: string): CloneTokenStore => {
  let store = stores.get(root);
  if (!store) stores.set(root, (store = new CloneTokenStore(root)));
  return store;
};

function matchLine(m: SimilarMatch, i: number): string {
  const pct = similarityLabel(Math.max(m.similarity, m.contained ?? 0));
  const used = m.exported ? `exported${m.importers ? `, used in ${plural(m.importers, 'file')}` : ''}` : 'not exported';
  const inside = m.contained ? ` (the snippet is a block inside it: ${similarityLabel(m.similarity)} of the function)` : '';
  return `${i + 1}. **${pct}** ${code(m.signature)} — ${loc(m.file, m.line)} · ${used}${inside}`;
}

/** Which copy to keep, when the answer has whole copies (the code asked about can be the one to keep). */
function adviceText(result: SimilarAnswer): string | undefined {
  const q = result.query;
  const advice = reuseAdvice(q, result.matches);
  if (!advice) return undefined;
  if (advice.kind === 'keep-query') {
    const used = q.importers ? `exported, used in ${plural(q.importers, 'file')}` : 'exported';
    return `Keep ${code(q.name!)} (${used}): replace ${advice.copies.slice(0, 3).map((m) => `${code(m.name)} in ${m.file}`).join(', ')} with ${advice.copies.length === 1 ? 'an import' : 'imports'} of it.`;
  }
  const keep = advice.keep!;
  const instead = q.file ? 'instead of keeping this copy' : 'instead of writing another copy';
  return advice.kind === 'import' ? `Reuse it: import ${code(keep.name)} from ${keep.file} ${instead}.` : `Reuse it: ${code(keep.name)} in ${keep.file} is not exported yet — export it and import it ${instead}.`;
}

export const findSimilarTool: ToolDef = {
  name: 'find_similar',
  title: 'Find existing similar code',
  description:
    'Before writing a helper (or right after): existing functions that already do the same thing. Pass a code snippet, or a file with start_line/end_line (start_line alone means the function around it). Renamed variables, different literals and the other declaration style (function or arrow) still match. Returns each match with similarity %, file:line, signature and how many files import it, plus copy-paste clones the lines are already part of, and which copy to keep — import it instead of adding another copy.',
  inputSchema: {
    type: 'object',
    properties: {
      snippet: { type: 'string', minLength: 1, description: 'The code to compare: a function or block you plan to write or just wrote.' },
      path: { type: 'string', minLength: 1, description: 'Instead of a snippet: a project file (relative to the project root), or file#Symbol for one function.' },
      start_line: { type: 'integer', minimum: 1, description: 'First line of the code in path (alone: the function around this line).' },
      end_line: { type: 'integer', minimum: 1, description: 'Last line of the code in path.' },
      min_similarity: { type: 'number', minimum: 0, maximum: 1, default: 0.8, description: 'Minimum similarity, 0–1 (default 0.8).' },
      ...COMMON_PROPERTIES,
      limit: { ...COMMON_PROPERTIES.limit, default: 5 },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const format = formatOf(args);
    const limit = limitOf(args);
    const snippet = typeof args.snippet === 'string' ? args.snippet : undefined;
    const rawPath = typeof args.path === 'string' ? args.path : undefined;
    if (!snippet === !rawPath) return toolError('Pass either "snippet" (code) or "path" (a project file, with start_line/end_line), not both.', { error: 'bad-arguments' });
    const start = typeof args.start_line === 'number' ? args.start_line : undefined;
    const end = typeof args.end_line === 'number' ? args.end_line : undefined;
    if ((start !== undefined || end !== undefined) && !rawPath) return toolError('start_line and end_line need "path".', { error: 'bad-arguments' });
    if (end !== undefined && start === undefined) return toolError('end_line needs start_line.', { error: 'bad-arguments' });
    if (start !== undefined && end !== undefined && end < start) return toolError(`end_line (${end}) is before start_line (${start}).`, { error: 'bad-arguments' });
    let data = await ctx.report();
    let request: { file?: string; start?: number; end?: number } = {};
    if (rawPath) {
      const checked = projectPath(ctx.root, rawPath);
      if ('error' in checked) return toolError(checked.error);
      let id = checked.id;
      if (id.includes('#') || !data.files.some((f) => f.id === id)) {
        data = await withFreshFiles(ctx, data, [id.split('#')[0]]);
        const r = resolveTarget(data, id);
        if (r.target?.type === 'symbol' && start === undefined) {
          const lines = symbolLines(data, r.target.id);
          if (lines) request = lines;
        } else if (r.target?.type === 'file') id = r.target.id;
        // `file#Name` that names no declaration: say so (comparing the whole file would answer another question).
        else if (id.includes('#') && r.target?.type !== 'symbol') {
          const [file, name] = [id.slice(0, id.indexOf('#')), id.slice(id.indexOf('#') + 1)];
          const text = data.files.some((f) => f.id === file)
            ? `No declaration "${name}" in ${file}${r.suggestions.length ? `; did you mean ${r.suggestions.join(', ')}?` : ' — find_symbol lists what is there.'}`
            : notFoundText(data, id, r.suggestions, ctx.root);
          return toolError(text, { error: 'not-found', input: id });
        }
      }
      if (!request.file) request = { file: id.split('#')[0], start, end };
    }
    const result = await similarTo(data, storeFor(ctx.root), { snippet, ...request, minSimilarity: typeof args.min_similarity === 'number' ? args.min_similarity : 0.8, limit });
    if (result.error === 'not-found') {
      const input = request.file ?? rawPath ?? '';
      return toolError(notFoundText(data, input, resolveTarget(data, input).suggestions, ctx.root), { error: 'not-found', input });
    }
    const q = result.query;
    const what = q.file ? `${q.name ? `${code(q.name)} (${q.start ? `${q.file}:${q.start}-${q.end}` : q.file})` : code(q.start ? `${q.file}:${q.start}-${q.end}` : q.file)}` : 'the snippet';
    if (result.error === 'out-of-range') return toolError(`${q.file} has ${plural(q.lines ?? 0, 'line')}: start_line ${q.start} is not in it.`, { error: 'out-of-range', lines: q.lines });
    if (result.error === 'too-short') {
      if (!q.tokens) return toolError(`${q.file ? 'These lines have' : 'The snippet has'} no code to compare (imports and comments are left out); pass a function.`, { error: 'too-short', tokens: 0 });
      return toolError(`${q.file ? 'These lines are' : 'The snippet is'} too short to compare (${plural(q.tokens, 'token')}); pass a whole function.`, { error: 'too-short', tokens: q.tokens });
    }
    const min = typeof args.min_similarity === 'number' ? args.min_similarity : 0.8;
    const lines = [`## Code similar to ${what}`, '', `${plural(result.matches.length, 'match', 'matches')} at least ${similarityLabel(min)} similar (identifiers and literals may differ) · ${plural(q.tokens, 'token')} compared`, ''];
    if (result.matches.length) lines.push(...result.matches.map(matchLine));
    else lines.push(`No existing function is ${similarityLabel(min)} similar${min > 0.6 ? ' — lower min_similarity to see weaker matches' : ''}.`);
    const advice = adviceText(result);
    if (advice) lines.push('', advice);
    if (result.copies.length) {
      lines.push('', `### Already copied (${plural(result.copies.length, 'clone family', 'clone families')} with ${q.start ? 'these lines' : 'this file'})`);
      lines.push(
        // Shared tokens rather than a percentage: the family's similarity is another measure than the matches'.
        ...capList(result.copies, Math.min(limit, format === 'detailed' ? limit : 5), (fam) => `- ${fam.fragments.map((f) => `${code(fragmentName(f))} ${fragmentLocation(f)}`).slice(0, 4).join(' ≈ ')} · ${plural(fam.tokens, 'shared token')}${fam.coChanges ? ` · changed together ${plural(fam.coChanges, 'time')}` : ''}`, 'clone family'),
      );
    }
    return answer(lines.join('\n'), format, {
      query: q,
      matches: result.matches,
      copies: result.copies.slice(0, limit).map((f) => ({ id: f.id, similarity: f.similarity, tokens: f.tokens, lines: f.lines, ...(f.coChanges ? { coChanges: f.coChanges } : {}), fragments: f.fragments, ...(f.pairs ? { pairs: f.pairs } : {}) })),
    }, 'lower limit or raise min_similarity');
  },
};
