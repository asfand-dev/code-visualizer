/** Report UI: the diff table of My changes, Review and the detail panel (ui/src/lib/diff.ts). */
import { describe, expect, it } from 'vitest';
import { parseDiff } from '../ui/src/lib/diff.js';

const DIFF = ['diff --git a/src/a.ts b/src/a.ts', 'index 1111111..2222222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,3 +1,3 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', ' export { a, b };', ''].join('\n');

describe('parseDiff', () => {
  it('has no phantom context row for the newline that ends a diff', () => {
    const lines = parseDiff(DIFF);
    expect(lines.map((l) => l.type)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx']);
    expect(lines.at(-1)).toEqual({ type: 'ctx', text: 'export { a, b };', oldNo: 3, newNo: 3 });
    // Without the final newline: the same rows.
    expect(parseDiff(DIFF.slice(0, -1))).toEqual(lines);
  });

  it('keeps a blank context line inside a hunk', () => {
    const lines = parseDiff(['@@ -1,3 +1,3 @@', ' a();', ' ', '-b();', '+c();', ''].join('\n'));
    expect(lines.map((l) => [l.type, l.text])).toEqual([
      ['hunk', '@@ -1,3 +1,3 @@'],
      ['ctx', 'a();'],
      ['ctx', ''],
      ['del', 'b();'],
      ['add', 'c();'],
    ]);
  });
});
