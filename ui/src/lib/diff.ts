/** Unified diffs as table rows for the diff views (My changes, Review, the detail panel). Pure: no DOM. */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = diff.split('\n');
  // A diff ends with a newline: the empty string after it is no context line.
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      inHunk = true;
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      out.push({ type: 'hunk', text: line });
      continue;
    }
    if (!inHunk) {
      if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) continue;
      if (line) out.push({ type: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-')) out.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith('\\')) out.push({ type: 'meta', text: line });
    else if (line.startsWith('diff --git')) inHunk = false;
    else out.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return out;
}
