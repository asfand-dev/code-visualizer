/**
 * Unified diffs for previews of planned file edits (`hooks install`, `agents init`): an LCS line diff
 * with 3 lines of context. Configuration files are small, so the O(n·m) table is fine (and capped).
 */
import path from 'node:path';

type Op = ' ' | '-' | '+';

/** Line-level edit script (LCS) between two texts: ' ' kept, '-' removed, '+' added. */
export function diffLines(a: string[], b: string[]): { op: Op; line: string }[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { op: Op; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', line: a[i++] });
    else out.push({ op: '+', line: b[j++] });
  }
  while (i < n) out.push({ op: '-', line: a[i++] });
  while (j < m) out.push({ op: '+', line: b[j++] });
  return out;
}

/** A unified diff of one edit (3 lines of context), labelled with `name` (an absolute path is shown as is). */
export function unifiedDiff(name: string, before: string | null, after: string | null): string {
  const split = (t: string | null): string[] => (t === null || t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const a = split(before);
  const b = split(after);
  const label = (side: 'a' | 'b'): string => (path.isAbsolute(name) ? name : `${side}/${name}`);
  const header = [`--- ${before === null ? '/dev/null' : label('a')}`, `+++ ${after === null ? '/dev/null' : label('b')}`];
  if (a.length * b.length > 4_000_000) return [...header, '@@ (too large to show) @@'].join('\n');
  const script = diffLines(a, b);
  const hunks: string[] = [];
  const changed = script.map((s, i) => (s.op !== ' ' ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return header.join('\n');
  let k = 0;
  while (k < changed.length) {
    let first = changed[k];
    let last = first;
    while (k + 1 < changed.length && changed[k + 1] - last <= 7) last = changed[++k];
    k++;
    first = Math.max(0, first - 3);
    last = Math.min(script.length - 1, last + 3);
    const slice = script.slice(first, last + 1);
    const oldStart = script.slice(0, first).filter((s) => s.op !== '+').length + 1;
    const newStart = script.slice(0, first).filter((s) => s.op !== '-').length + 1;
    const oldLen = slice.filter((s) => s.op !== '+').length;
    const newLen = slice.filter((s) => s.op !== '-').length;
    hunks.push(`@@ -${oldLen ? oldStart : oldStart - 1},${oldLen} +${newLen ? newStart : newStart - 1},${newLen} @@`, ...slice.map((s) => `${s.op}${s.line}`));
  }
  return [...header, ...hunks].join('\n');
}
