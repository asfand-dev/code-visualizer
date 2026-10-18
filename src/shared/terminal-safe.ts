/**
 * Text from the repository (file names, branch names, commit subjects, author names, stored state) printed
 * to a terminal must not carry control characters: an ESC starts escape sequences that can retitle the
 * window, clear the screen, plant hyperlinks or rewrite what is on screen. These helpers make every
 * control character visible instead. No imports: the browser UI may use them too.
 */

/** C0 controls except tab and newline, DEL, and the C1 controls (U+0080–U+009F, e.g. U+009B, the 8-bit CSI). */
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const LINE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

const visible = (ch: string): string => (ch === '\x1b' ? '\\e' : `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** `s` with every control character but tab and newline shown as an escape (`\e`, `\x07`…). */
export function terminalSafe(s: string): string {
  return s.replace(CONTROL_RE, visible);
}

/** Like `terminalSafe`, for text that must stay on one line: tabs and newlines become escapes too. */
export function terminalSafeLine(s: string): string {
  return s.replace(LINE_CONTROL_RE, (ch) => (ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : visible(ch)));
}

/** Whether `s` holds a character `terminalSafe` would replace. */
export function hasControlChars(s: string): boolean {
  return /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(s);
}

/**
 * A copy of `value` with `safe` applied to every string inside it (object keys included); numbers, booleans
 * and null stay as they are. For data structures whose strings a text formatter prints.
 */
export function terminalSafeDeep<T>(value: T, safe: (s: string) => string = terminalSafe): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return safe(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (v instanceof Map) return new Map([...v].map(([k, x]) => [walk(k), walk(x)]));
      if (v instanceof Set) return new Set([...v].map(walk));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[safe(k)] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
