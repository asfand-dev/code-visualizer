/**
 * `check --format markdown` and the GitHub job summary (`$GITHUB_STEP_SUMMARY`): a gate table with new /
 * existing / fixed counts, the health change and the most important new findings, linked to the code.
 * Pure string building; at most SUMMARY_MAX_BYTES (GitHub allows 1 MiB per step).
 */
import { deltaBaseLabel } from '../../shared/markdown.js';
import type { CheckResult, Finding, ReportData } from '../../shared/types.js';

export const SUMMARY_MAX_BYTES = 900 * 1024;
const TOP_FINDINGS = 15;
const MAX_MESSAGE = 400;

export interface SummaryOptions {
  /** Path of the analyzed root inside the repository (`git rev-parse --show-prefix`). */
  prefix?: string;
  /** Environment with GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_SHA for links to the code. */
  env?: Record<string, string | undefined>;
  /** Shown in the footer, e.g. `code-visualizer check --changed`. */
  command?: string;
  version?: string;
}

const code = (v: string): string => `\`${v.replace(/`/g, "'")}\``;
const cell = (v: string): string => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (v: string, max = MAX_MESSAGE): string => (v.length > max ? `${v.slice(0, max - 1)}…` : v);
const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;

/** `https://github.com/o/r/blob/<sha>/<path>#L12` when the GitHub environment is known. */
function blobLink(f: Finding, options: SummaryOptions): string | undefined {
  const env = options.env ?? {};
  const server = env.GITHUB_SERVER_URL?.replace(/\/+$/, '');
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  if (!server || !repo || !sha || !f.file) return undefined;
  const filePath = `${options.prefix ?? ''}${f.file}`.split('/').map(encodeURIComponent).join('/');
  return `${server}/${repo}/blob/${sha}/${filePath}${f.line ? `#L${f.line}` : ''}`;
}

export function findingLocation(f: Finding, options: SummaryOptions = {}): string {
  if (!f.file) return '';
  const label = code(f.line ? `${f.file}:${f.line}` : f.file);
  const link = blobLink(f, options);
  return link ? `[${label}](${link})` : label;
}

function scope(result: CheckResult, data: ReportData): string {
  const delta = data.changes?.delta;
  const compared = result.newOnly ?? result.gates.some((g) => g.counts);
  switch (result.mode) {
    case 'baseline':
      return `New findings compared with the baseline ${code(result.base ?? 'code-visualizer.baseline.json')}`;
    case 'staged':
      if (!compared && result.gates.length) return 'Findings in the staged files';
      return 'New findings in the staged changes (compared with `HEAD`)';
    case 'changed':
    case 'new-since':
      if (!compared) return `Findings in the files changed since ${code(result.base ?? 'the base')}`;
      return `New findings compared with ${delta ? deltaBaseLabel(delta) : code(result.base ?? 'the base')}`;
    default:
      return 'All findings in the project';
  }
}

/** The gate table: with new / existing / fixed columns when the check compared with a base or baseline. */
export function gateTableMarkdown(result: CheckResult): string[] {
  const compared = result.gates.some((g) => g.counts);
  // Gates without counts (health, risk) explain themselves in a details column.
  const details = !compared || result.gates.some((g) => !g.counts);
  const head = ['Gate', 'Result', ...(compared ? ['New', 'Existing', 'Fixed'] : []), ...(details ? ['Details'] : [])];
  const align = ['---', '---', ...(compared ? ['---:', '---:', '---:'] : []), ...(details ? ['---'] : [])];
  const lines = [`| ${head.join(' | ')} |`, `| ${align.join(' | ')} |`];
  for (const g of result.gates) {
    const row = [cell(g.label), g.ok ? '✅ passed' : '❌ failed'];
    if (compared) row.push(String(g.counts?.new ?? ''), String(g.counts?.existing ?? ''), String(g.counts?.fixed ?? ''));
    if (details) row.push(cell(g.counts ? '' : g.detail));
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines;
}

/** The findings worth a reviewer's attention first: failing, new, on changed lines, errors. */
export function topFindings(result: CheckResult): Finding[] {
  const compared = result.gates.some((g) => g.counts);
  const failing = new Set(result.gates.filter((g) => !g.ok).map((g) => g.id));
  const rank = (f: Finding): number[] => [failing.has(f.gate) ? 0 : 1, f.status === 'new' ? 0 : 1, f.onChangedLine ? 0 : 1, f.severity === 'error' ? 0 : f.severity === 'warning' ? 1 : 2];
  return result.gates
    .flatMap((g) => g.findings)
    .filter((f) => !compared || f.status === 'new')
    .map((f) => ({ f, r: rank(f) }))
    .sort((a, b) => {
      for (let i = 0; i < a.r.length; i++) if (a.r[i] !== b.r[i]) return a.r[i] - b.r[i];
      // Within a tier the worse finding first (higher complexity, larger cycle), then by place.
      return (b.f.weight ?? 0) - (a.f.weight ?? 0) || a.f.file.localeCompare(b.f.file) || (a.f.line ?? 0) - (b.f.line ?? 0);
    })
    .map(({ f }) => f);
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export function checkSummaryMarkdown(result: CheckResult, data: ReportData, options: SummaryOptions = {}): string {
  const failed = result.gates.filter((g) => !g.ok);
  const compared = result.gates.some((g) => g.counts);
  const lines: string[] = [];
  lines.push(failed.length ? `## ❌ code-visualizer check: ${plural(failed.length, 'gate')} failed` : '## ✅ code-visualizer check: all gates passed', '');
  const health = `Health **${result.health}/100** (${data.health.grade})${result.healthDelta !== undefined ? `, ${result.healthDelta > 0 ? `+${result.healthDelta}` : result.healthDelta < 0 ? `−${-result.healthDelta}` : '±0'} vs base` : ''}`;
  const changed = data.changes?.files.length ? ` · ${plural(data.changes.files.length, 'changed file')}` : '';
  lines.push(`${scope(result, data)} · ${health}${changed}`, '');
  for (const note of result.notes ?? []) lines.push(`> ${note}`, '');

  if (result.gates.length) lines.push(...gateTableMarkdown(result), '');

  const top = topFindings(result);
  if (top.length) {
    lines.push(`### ${compared ? 'New findings' : 'Findings'} (${top.length.toLocaleString('en-US')})`, '');
    for (const f of top.slice(0, TOP_FINDINGS)) {
      const mark = f.severity === 'error' ? (failed.some((g) => g.id === f.gate) ? '❌' : '⚠️') : f.severity === 'warning' ? '⚠️' : 'ℹ️';
      const gate = result.gates.find((g) => g.id === f.gate)?.label ?? f.gate;
      lines.push(`- ${mark} ${findingLocation(f, options)} ${clip(f.message)} · _${gate}_${f.worsened ? ' · got worse' : ''}${f.onChangedLine ? ' · on a changed line' : ''}`);
    }
    if (top.length > TOP_FINDINGS) lines.push(`- … ${(top.length - TOP_FINDINGS).toLocaleString('en-US')} more (see the SARIF report or run the check locally)`);
    lines.push('');
  } else if (compared) {
    lines.push('No new findings. 🎉', '');
  }
  if (result.fixed.length) {
    const named = result.fixed.filter((f) => f.file);
    lines.push(`✅ ${plural(result.fixed.length, 'finding')} fixed${named.length ? `: ${named.slice(0, 5).map((f) => clip(f.message, 120)).join('; ')}${named.length > 5 ? '; …' : ''}` : ''}`, '');
  }
  lines.push(`<sub>code-visualizer${options.version ? ` v${options.version}` : ''}${options.command ? ` · reproduce with ${code(options.command)}` : ''}</sub>`);
  let text = `${lines.join('\n')}\n`;
  if (byteLength(text) > SUMMARY_MAX_BYTES) {
    // Only very long messages can get here: cut on a line boundary and say so.
    while (byteLength(text) > SUMMARY_MAX_BYTES - 64) {
      const cut = text.lastIndexOf('\n', Math.floor(text.length * 0.9));
      text = text.slice(0, cut > 0 ? cut : Math.floor(text.length * 0.9));
    }
    text += '\n\n… summary truncated\n';
  }
  return text;
}
