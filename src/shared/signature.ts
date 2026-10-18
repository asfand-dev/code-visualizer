/** Human-readable declarations and call arity of symbols. Pure — shared by the CLI and the report UI. */
import type { ParamInfo, SymbolInfo } from './types.js';

const CALLABLE = new Set(['function', 'hook', 'component']);

export function isCallable(s: Pick<SymbolInfo, 'kind'>): boolean {
  return CALLABLE.has(s.kind);
}

/** One-line declaration such as `async formatDate(iso: string, locale?): string` (`?`: optional or with a default value). */
export function signature(s: SymbolInfo): string {
  if (isCallable(s)) {
    const params = (s.params ?? []).map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional || p.defaultValue !== undefined ? '?' : ''}${p.type ? `: ${p.type}` : ''}`).join(', ');
    return `${s.async ? 'async ' : ''}${s.name}(${params})${s.returnType ? `: ${s.returnType}` : ''}`;
  }
  if (s.kind === 'type' && s.typeText) return `type ${s.name} = ${s.typeText}`;
  if ((s.kind === 'constant' || s.kind === 'variable') && s.typeText) return `${s.name}: ${s.typeText}`;
  return `${s.kind} ${s.name}${s.extends?.length ? ` extends ${s.extends.join(', ')}` : ''}${s.implements?.length ? ` implements ${s.implements.join(', ')}` : ''}`;
}

/**
 * How many arguments a call must pass (`required`) and may pass (`max`, Infinity with a rest parameter).
 * A parameter is optional when it has `?` or a default value; a required parameter after optional
 * ones still has to be passed positionally, so it counts.
 */
export function paramRange(params: ParamInfo[] | undefined): { required: number; max: number } {
  const list = params ?? [];
  let required = 0;
  list.forEach((p, i) => {
    if (!p.optional && !p.rest) required = i + 1;
  });
  return { required, max: list.some((p) => p.rest) ? Infinity : list.length };
}

const MAX_COMPACT = 60;

/** `async formatDate(iso: string, locale?: string): string` → `formatDate(iso, locale?)`: names only, for one-line summaries. */
export function compactSignature(sig: string): string {
  const open = sig.indexOf('(');
  if (open <= 0 || /^(type|interface|class|enum|namespace) /.test(sig)) return sig.length > MAX_COMPACT ? `${sig.slice(0, MAX_COMPACT - 1)}…` : sig;
  let out = sig.slice(0, open + 1).replace(/^async /, '');
  let depth = 0;
  let skipping = false; // inside a parameter's type annotation
  for (let i = open + 1; i < sig.length; i++) {
    const ch = sig[i];
    if (depth === 0 && ch === ')') return `${out.trimEnd()})`;
    if ('([{<'.includes(ch)) depth++;
    else if (')]}'.includes(ch) || (ch === '>' && sig[i - 1] !== '=')) depth--;
    else if (depth === 0 && ch === ':') {
      skipping = true;
      continue;
    } else if (depth === 0 && ch === ',') {
      skipping = false;
      out = `${out.trimEnd()}, `;
      continue;
    }
    if (!skipping && !(ch === ' ' && out.endsWith(' '))) out += ch;
  }
  return sig;
}

/**
 * Compact forms of a declaration before and after a change. When they would read the same (a long
 * type whose change is cut off, a changed parameter type), both show the part around the change:
 * `type Stage = …'changes' | 'insights'…` → `type Stage = …'changes' | 'compare' | 'insights'…`.
 */
export function compactPair(before: string, after: string): [string, string] {
  const a = compactSignature(before);
  const b = compactSignature(after);
  if (a !== b || before === after) return [a, b];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // Keep the declaration's name (`type Stage = `, `formatDate(`) in front of the window.
  const head = before.match(/^(?:type|interface|class|enum|namespace) [\w$]+(?:<[^=]*>)? ?=? ?|^(?:async )?[\w$]+\(/)?.[0].replace(/^async /, '') ?? '';
  const context = 12;
  const clip = (sig: string): string => {
    const from = Math.max(head.length, start - context);
    const changeEnd = Math.max(sig.length - end, start);
    const to = Math.min(sig.length, changeEnd + context, from + MAX_COMPACT);
    return `${head}${from > head.length ? '…' : ''}${sig.slice(from, to)}${to < sig.length ? '…' : ''}`;
  };
  return [clip(before), clip(after)];
}
