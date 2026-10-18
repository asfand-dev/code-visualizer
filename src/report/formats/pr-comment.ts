/**
 * `pr --format comment`: the PR description as a sticky pull-request comment. The first line is a marker
 * so a workflow can find and replace its previous comment (`gh pr comment --edit-last`), and the body
 * stays within GitHub's comment limit: less important sections are folded into <details> first, then
 * long lists are cut with "… N more". Never posted by the tool itself. Pure.
 */
import { prSummaryMarkdown } from '../../shared/markdown.js';
import type { CheckResult, ReportData } from '../../shared/types.js';
import { gateTableMarkdown, topFindings, findingLocation } from './summary.js';

export const PR_COMMENT_MARKER = '<!-- code-visualizer:pr-report -->';
/** GitHub rejects comments above 65,536 characters; this leaves room for whatever a workflow adds. */
export const PR_COMMENT_MAX_CHARS = 60_000;
/** Above this, the less important sections are folded so the comment stays readable. */
const OPEN_CHARS = 8_000;
/** Long lists of details (files, functions, impact) are always folded in a comment: the PR shows them already. */
const LONG_SECTION_LINES = 12;
const FOLD_LONG_FROM_PRIORITY = 5;

interface Section {
  title: string;
  /** Heading line ('' for text before the first heading). */
  heading: string;
  body: string[];
  /** Lower is more important: kept open and untouched the longest. */
  priority: number;
  collapsed?: boolean;
}

const PRIORITY: [RegExp, number][] = [
  [/^Summary$/, 0],
  [/^Quality gates$/, 1],
  [/^Architecture changes/, 2],
  [/^Review notes$/, 3],
  [/^Tests$/, 4],
  [/^Impact$/, 5],
  // review-mode: long reading orders are folded like the other detail lists.
  [/^Review path$/, 5],
  [/^Changed /, 6],
  [/^Files$/, 7],
];

function priorityOf(title: string): number {
  return PRIORITY.find(([re]) => re.test(title))?.[1] ?? 8;
}

/** Split Markdown into sections at `##` / `###` headings. */
function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: '', heading: '', body: [], priority: 0 };
  for (const line of markdown.split('\n')) {
    const m = line.match(/^#{2,3} (.+)$/);
    if (m) {
      if (current.heading || current.body.some((l) => l.trim())) sections.push(current);
      current = { title: m[1].trim(), heading: line, body: [], priority: priorityOf(m[1].trim()) };
    } else current.body.push(line);
  }
  sections.push(current);
  return sections;
}

/** The "Quality gates" section of `pr --check`: the gate table and the new findings that fail it. */
export function gateSectionMarkdown(result: CheckResult): string {
  const failed = result.gates.filter((g) => !g.ok).length;
  const lines = ['### Quality gates', '', failed ? `❌ **${failed} gate${failed === 1 ? '' : 's'} failed**` : '✅ **All gates passed**', '', ...gateTableMarkdown(result)];
  const compared = result.gates.some((g) => g.counts);
  const top = topFindings(result).slice(0, 10);
  if (top.length) {
    lines.push('', compared ? 'New findings:' : 'Findings:', '');
    for (const f of top) lines.push(`- ${f.severity === 'error' ? '❌' : '⚠️'} ${findingLocation(f)} ${f.message.length > 300 ? `${f.message.slice(0, 299)}…` : f.message}`);
  }
  return lines.join('\n');
}

const isRow = (line: string): boolean => /^\s*(- |\* |\d+\. |\| )/.test(line);

/**
 * The section body cut to about `budget` characters: whole lines, code fences kept or dropped as a whole,
 * and a closing "… N more" that says how many list items or table rows were left out.
 */
function truncateBody(body: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  let dropped = 0;
  let droppedRows = 0;
  let table = false;
  for (let i = 0; i < body.length; i++) {
    // A fenced block (```mermaid…) is one unit.
    let unit = [body[i]];
    if (/^\s*```/.test(body[i])) {
      const end = body.findIndex((l, j) => j > i && /^\s*```\s*$/.test(l));
      unit = body.slice(i, end === -1 ? body.length : end + 1);
      i += unit.length - 1;
    }
    const size = unit.reduce((n, l) => n + l.length + 1, 0);
    if (!dropped && used + size <= budget) {
      out.push(...unit);
      used += size;
      table = /^\s*\|/.test(unit[0]);
      continue;
    }
    dropped += unit.length;
    if (unit.length === 1 && isRow(unit[0])) droppedRows++;
  }
  if (dropped) {
    const what = droppedRows ? `… ${droppedRows.toLocaleString('en-US')} more` : '… (shortened)';
    out.push(table && droppedRows ? `| ${what} |` : `- ${what}`);
  }
  return out;
}

/** Text inside HTML (a <summary>): `&`, `<` and `>` escaped, not dropped ("components &amp; classes"). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(sections: Section[]): string {
  const parts: string[] = [];
  for (const s of sections) {
    const body = s.body.join('\n').replace(/^\n+|\n+$/g, '');
    if (!s.heading) {
      if (body) parts.push(body);
      continue;
    }
    if (s.collapsed) parts.push(`<details><summary><b>${escapeHtml(s.title)}</b></summary>\n\n${body}\n\n</details>`);
    else parts.push(body ? `${s.heading}\n\n${body}` : s.heading);
  }
  return parts.join('\n\n');
}

export interface PrCommentOptions {
  /** Gate results to embed (`pr --check`). */
  check?: CheckResult;
  /** Hard limit of the comment (default PR_COMMENT_MAX_CHARS). */
  maxChars?: number;
  /** Fold less important sections above this many characters (default 8,000). */
  openChars?: number;
}

/** The PR description as a comment body: marker on the first line, at most `maxChars` characters. */
export function prCommentMarkdown(data: ReportData, options: PrCommentOptions = {}): string {
  const maxChars = options.maxChars ?? PR_COMMENT_MAX_CHARS;
  const openChars = options.openChars ?? OPEN_CHARS;
  const sections = splitSections(prMarkdownWithGates(data, options.check));
  const head = `${PR_COMMENT_MARKER}\n`;
  const size = (): number => head.length + render(sections).length + 1;
  const byLeastImportant = [...sections].filter((s) => s.heading).sort((a, b) => b.priority - a.priority);

  // 1. Readability: fold long detail lists, then the least important sections until the open part is short.
  for (const s of sections) if (s.heading && s.priority >= FOLD_LONG_FROM_PRIORITY && s.body.filter((l) => l.trim()).length > LONG_SECTION_LINES) s.collapsed = true;
  const openSize = (): number => sections.filter((s) => !s.collapsed).reduce((n, s) => n + s.heading.length + s.body.join('\n').length + 2, 0);
  for (const s of byLeastImportant) {
    if (openSize() <= openChars || s.priority <= 1) break;
    s.collapsed = true;
  }
  // 2. Size: shorten the least important sections until the comment fits.
  for (const s of byLeastImportant) {
    const excess = size() - maxChars;
    if (excess <= 0) break;
    const current = s.body.join('\n').length;
    s.body = truncateBody(s.body, Math.max(200, current - excess - 64));
  }
  let text = `${head}${render(sections)}\n`;
  // 3. Last resort (a huge summary paragraph): cut at a line boundary.
  if (text.length > maxChars) {
    const cut = text.lastIndexOf('\n', maxChars - 80);
    text = text.slice(0, cut > head.length ? cut : maxChars - 80);
    // Close what the cut left open, so the rest of the PR page renders normally.
    const fence = (text.match(/^\s*```/gm) ?? []).length % 2 ? '\n```' : '';
    const open = (text.match(/<details>/g) ?? []).length - (text.match(/<\/details>/g) ?? []).length;
    text = `${text}${fence}\n\n… (shortened)${'\n\n</details>'.repeat(Math.max(0, open))}\n`;
  }
  return text;
}

/** The PR description with the "Quality gates" section after the summary (`pr --check`). */
export function prMarkdownWithGates(data: ReportData, check?: CheckResult): string {
  const markdown = prSummaryMarkdown(data);
  if (!check) return markdown;
  const sections = splitSections(markdown);
  const gates = splitSections(gateSectionMarkdown(check)).filter((s) => s.heading);
  const at = sections.findIndex((s) => s.title === 'Summary');
  sections.splice(at === -1 ? 0 : at + 1, 0, ...gates);
  return render(sections);
}
