const KEYWORDS = new Set(
  'abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace new null of package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined unique var void while with yield'.split(
    ' ',
  ),
);
const BUILTIN_TYPES = new Set('string number boolean any unknown never object symbol bigint void'.split(' '));

const TOKEN_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b0x[\da-fA-F_]+n?\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b)|(<\/?[A-Za-z][\w.:-]*)|(@?[A-Za-z_$][\w$]*)|([{}()[\];,.<>=+\-*/%!&|^~?:]+)/g;

function esc(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Tiny JS/TS/JSX/Vue highlighter. Returns one HTML string per line. */
export function highlightLines(source: string): string[] {
  const lines: string[] = [''];
  const emit = (cls: string | null, text: string): void => {
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push('');
      if (!part) return;
      lines[lines.length - 1] += cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part);
    });
  };
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(source))) {
    if (m.index > last) emit(null, source.slice(last, m.index));
    const [text, comment, str, num, tag, ident, punct] = m;
    if (comment) emit('tok-c', text);
    else if (str) emit('tok-s', text);
    else if (num) emit('tok-n', text);
    else if (tag) {
      emit('tok-p', tag.startsWith('</') ? '</' : '<');
      emit('tok-g', tag.replace(/^<\/?/, ''));
    } else if (ident) {
      const next = source.slice(TOKEN_RE.lastIndex, TOKEN_RE.lastIndex + 2);
      if (ident.startsWith('@')) emit('tok-a', ident);
      else if (KEYWORDS.has(ident)) emit('tok-k', ident);
      else if (BUILTIN_TYPES.has(ident)) emit('tok-t', ident);
      else if (/^\s*\(/.test(next) || next.startsWith('`')) emit('tok-f', ident);
      else if (/^[A-Z]/.test(ident)) emit('tok-t', ident);
      else if (next.startsWith('=') && !next.startsWith('==') && /^[a-z]/.test(ident) && /<[^>]*$/.test(source.slice(Math.max(0, m.index - 200), m.index))) emit('tok-a', ident);
      else emit(null, ident);
    } else if (punct) emit('tok-p', text);
    else emit(null, text);
    last = TOKEN_RE.lastIndex;
    if (m[0].length === 0) TOKEN_RE.lastIndex++;
  }
  if (last < source.length) emit(null, source.slice(last));
  return lines;
}
