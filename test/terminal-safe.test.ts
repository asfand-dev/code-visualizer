import { describe, expect, it } from 'vitest';
import { hyperlink, safeData, safeText } from '../src/cli/format.js';
import { hasControlChars, terminalSafe, terminalSafeDeep, terminalSafeLine } from '../src/shared/terminal-safe.js';

const TITLE = '\u001b]0;OWNED\u0007';
const CLEAR = '\u001b[2J';

describe('terminal-safe text', () => {
  it('shows control characters instead of sending them', () => {
    expect(terminalSafe(`src/x${TITLE}.ts`)).toBe('src/x\\e]0;OWNED\\x07.ts');
    expect(terminalSafe(`a${CLEAR}b`)).toBe('a\\e[2Jb');
    // DEL and the C1 controls (U+009B is an 8-bit CSI on some terminals).
    expect(terminalSafe('a\u007fb\u009bc\u0085')).toBe('a\\x7fb\\x9bc\\x85');
    // Tabs and newlines stay in multi-line text; carriage returns (overwrite a line) do not.
    expect(terminalSafe('a\tb\nc\rd')).toBe('a\tb\nc\\x0dd');
    expect(terminalSafe('plain — ünïcödé ✔ 🙂')).toBe('plain — ünïcödé ✔ 🙂');
  });

  it('keeps one-line text on one line', () => {
    expect(terminalSafeLine('main\nfake line\t!')).toBe('main\\nfake line\\t!');
    expect(terminalSafeLine(`b${TITLE}`)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('tells whether text has control characters', () => {
    expect(hasControlChars(`x${TITLE}`)).toBe(true);
    expect(hasControlChars('x\ty\nz')).toBe(false);
  });

  it('cleans every string of a structure (keys too), and leaves the original alone', () => {
    const data = { file: `src/${TITLE}.ts`, line: 3, ok: true, none: null, list: [`a${CLEAR}`, 2], nested: { [`k${TITLE}`]: 'v' }, set: new Set([CLEAR]), map: new Map([[CLEAR, CLEAR]]) };
    const safe = terminalSafeDeep(data);
    expect(JSON.stringify(safe)).not.toContain('\u001b');
    expect(safe.line).toBe(3);
    expect(safe.ok).toBe(true);
    expect(safe.none).toBeNull();
    expect(Object.keys(safe.nested)).toEqual(['k\\e]0;OWNED\\x07']);
    expect([...safe.set][0]).toBe('\\e[2J');
    expect([...safe.map.keys()][0]).toBe('\\e[2J');
    expect(data.file).toContain('\u001b');
    expect(safeData({ a: [TITLE] }).a[0]).toBe(safeText(TITLE));
  });

  it('a hyperlink cannot be ended or extended by its own url or text', () => {
    const link = hyperlink(`x${TITLE}`, `vscode://file/x${TITLE} y`);
    // Exactly the four ESCs of the OSC 8 sequence itself.
    expect(link.match(/\u001b/g)).toHaveLength(4);
    expect(link).not.toContain('\u0007');
    expect(link).toContain('%20y');
  });
});
