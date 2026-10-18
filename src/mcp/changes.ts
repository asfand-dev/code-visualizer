/**
 * `review_changes` and the cv://changes resource: your current work with its impact, the tests to run,
 * what no test reaches and what got worse architecturally.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, resolveCommit } from '../analyzer/git.js';
import { findRepo, readHead } from '../analyzer/repo-state.js';
import { driftMessage, newCloneMessage } from '../shared/clones.js';
import { breakingExports, closest, deltaHighlights } from '../shared/delta.js';
import { formatRanges, patchCoverageLine, reportAge } from '../shared/coverage.js';
import { architectureDeltaMarkdown, reviewPathMarkdown } from '../shared/markdown.js';
import { untestedChanges } from '../shared/query.js';
import type { CloneFragment, ReportData } from '../shared/types.js';
import { formatOf, isoDay, limitOf, person, siteRef } from './format.js';
import { answer, capList, code, COMMON_PROPERTIES, fence, plural, READ_ONLY, toolError, type McpContext, type RenderedAnswer, type ResponseFormat, type ToolDef } from './protocol.js';

const STATUS_MARK: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: '?' };
/** Files that did not exist before: their exports are new, not changed APIs. */
const NEW_FILE = new Set(['added', 'untracked']);

type Changes = NonNullable<ReportData['changes']>;
interface ChangesView {
  c: Changes;
  limit: number;
  detailed: boolean;
  untested: string[];
  commentOnly: Set<string>;
  routeLabels: string[];
  newFiles: Set<string>;
}

/** Changed files with their changed declarations. */
function changedFilesSection({ c, limit, commentOnly }: ChangesView): string[] {
  const symbolsByFile = new Map<string, string[]>();
  for (const s of c.symbols) symbolsByFile.set(s.file, [...(symbolsByFile.get(s.file) ?? []), s.name]);
  const fileLine = (f: Changes['files'][number]): string => {
    const names = symbolsByFile.get(f.id) ?? [];
    const what = commentOnly.has(f.id) ? ' — comments only' : names.length ? ` — ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}` : '';
    return `- ${STATUS_MARK[f.status] ?? f.status} ${f.oldPath ? `${f.oldPath} → ` : ''}${f.id} (+${f.additions} −${f.deletions})${what}`;
  };
  return ['', `### Changed files (${c.files.length})`, ...capList(c.files, limit, fileLine, 'file')];
}

/** Changed exports of existing files that others use (new files' exports change no API: only counted). */
function changedExportsSection({ c, limit, newFiles }: ChangesView): string[] {
  const used = c.symbols.filter((s) => s.exported && s.usedBy > 0);
  const changed = used.filter((s) => !newFiles.has(s.file)).sort((a, b) => b.usedBy - a.usedBy);
  const added = used.length - changed.length;
  const lines: string[] = [];
  if (changed.length) lines.push('', `### Changed exports in use (${changed.length})`, ...capList(changed, limit, (s) => `- ${code(s.name)} (${s.file}) — used by ${plural(s.usedBy, 'place')}`, 'export'));
  if (added) lines.push('', `New files add ${plural(added, 'export')} already in use.`);
  return lines;
}

/** The tests to run, the changed files no test reaches and the changed lines no test ran (patch coverage). */
function testsSection({ c, limit, detailed, untested }: ChangesView): string[] {
  const short = detailed ? limit : Math.min(limit, 15);
  const lines = ['', `### Tests to run (${c.tests.files.length})`];
  if (!c.tests.files.length) lines.push('No test reaches the changed files.');
  lines.push(...capList(c.tests.files, short, (f) => `- ${f}`, 'test'));
  if (c.tests.command) lines.push(`Run: ${code(c.tests.command)} — or ${code('npx code-visualizer test')}, which runs them and records the result.`);
  if (untested.length) lines.push('', `### Not covered by any test (${untested.length})`, ...capList(untested, limit, (f) => `- ${f}`, 'file'));
  // --- test-intelligence: patch coverage from the local coverage report ---
  const patch = c.coverage;
  if (patch?.coverable) {
    const missed = patch.files.filter((f) => f.uncovered.length);
    lines.push('', `### ${patchCoverageLine(patch)}`);
    if (patch.stale) lines.push(`The report (${patch.report}, ${reportAge(patch.reportDate)}) is older than the changes: rerun the tests with coverage.`);
    if (missed.length) lines.push('Changed lines no test ran:', ...capList(missed, short, (f) => `- ${f.file} ${formatRanges(f.uncovered, detailed ? 8 : 4)}${f.missing ? ' (no test loaded the file)' : ''}`, 'file'));
  }
  if (patch?.unmeasured?.length) lines.push(`Not measured (no coverage report for their package): ${patch.unmeasured.slice(0, 5).join(', ')}${patch.unmeasured.length > 5 ? ', …' : ''}`);
  return lines;
}

/** review-mode: the order in which to read the change (dependencies first, each test after its code). */
function readingSection({ c, limit, detailed }: ChangesView): string[] {
  if (!c.readingOrder?.length) return [];
  return ['', reviewPathMarkdown(c.readingOrder, { groups: c.readingGroups, limit: detailed ? limit : Math.min(limit, 15) })];
}

/** Impacted files and routes. */
function impactSection({ c, limit, detailed, routeLabels }: ChangesView): string[] {
  if (!c.impacted.length && !routeLabels.length) return [];
  const short = detailed ? limit : Math.min(limit, 15);
  const lines = ['', `### Impacted (${plural(c.impacted.length, 'file')})`, ...capList(c.impacted, short, (f) => `- ${f}`, 'file', 'call impact on a changed file for detail')];
  if (routeLabels.length) lines.push(`Routes: ${routeLabels.slice(0, limit).map(code).join(', ')}${routeLabels.length > limit ? `, … ${routeLabels.length - limit} more` : ''}`);
  return lines;
}

/** Risk, reviewers and owners (names are repo text: one line each, without Markdown). */
function reviewSection({ c }: ChangesView): string[] {
  const lines = ['', '### Review'];
  // clone-radar: a copy the change edited while its clone stayed as it was — the same fix may be missing there.
  for (const d of (c.cloneDrift ?? []).slice(0, 5)) lines.push(`- Clone drift: ${driftMessage(d)}.`);
  if (c.risk.factors.length) lines.push(`- Risk factors: ${c.risk.factors.slice(0, 5).map((f) => f.label).join('; ')}`);
  if (c.reviewers.length) lines.push(`- Suggested reviewers: ${c.reviewers.slice(0, 3).map((r) => person(r.name)).join(', ')}`);
  if (c.owners.length) lines.push(`- Code owners: ${c.owners.slice(0, 8).map((o) => o.owner).join(', ')}`);
  return lines.length > 2 ? lines : [];
}

/** The commits, their subjects fenced: repo text, not instructions. */
function commitsSection({ c, limit, detailed }: ChangesView): string[] {
  if (!c.commits.length) return [];
  return ['', `### Commits (${c.commits.length})`, fence(c.commits.slice(0, detailed ? limit : 10).map((m) => `${m.hash.slice(0, 7)} ${m.subject}`).join('\n'))];
}

/** A copy of duplicated code as structured data (clone-radar). */
const copyRef = (f: CloneFragment): Record<string, unknown> => ({ file: f.file, start: f.start, end: f.end, ...(f.name ? { name: f.name } : {}), ...(f.isNew ? { isNew: true } : {}) });

/** The architecture delta's facts an agent acts on: what got worse, with the places to fix. */
function deltaFacts(delta: NonNullable<Changes['delta']>, limit: number): Record<string, unknown> {
  return {
    base: delta.base,
    highlights: deltaHighlights(delta),
    newCycles: delta.newCycles.slice(0, limit),
    newViolations: delta.newViolations.slice(0, limit),
    breakingExports: breakingExports(delta)
      .slice(0, limit)
      .map((e) => ({ file: e.file, name: e.name, change: e.change, before: e.before, after: e.after, line: e.line, importers: e.importers.slice(0, limit), staleCallSites: e.staleCallSites.slice(0, limit).map(siteRef) })),
    removedRoutesStillCalled: delta.routes.removed.filter((r) => r.stillCalledFrom.length).slice(0, limit),
    newMissingDependencies: delta.newMissingDependencies.slice(0, limit),
    newDevDependenciesInProduction: (delta.newDevDependenciesInProduction ?? []).slice(0, limit),
    complexity: delta.complexity.filter((x) => x.after > (delta.complexityThreshold ?? 10)).slice(0, limit),
    // clone-radar: copies of existing code the change adds ("import it instead").
    ...(delta.newClones?.length ? { newClones: delta.newClones.slice(0, limit).map((fam) => ({ message: newCloneMessage(fam), copies: fam.fragments.slice(0, limit).map(copyRef) })) } : {}),
    health: { before: delta.health.before, after: delta.health.after },
  };
}

function changesStructured({ c, limit, untested, commentOnly, routeLabels, newFiles }: ChangesView): Record<string, unknown> {
  return {
    available: true,
    mode: c.mode,
    base: c.base,
    baseCommit: c.baseCommit,
    files: c.files.slice(0, limit).map((f) => ({ id: f.id, status: f.status, ...(f.oldPath ? { oldPath: f.oldPath } : {}), additions: f.additions, deletions: f.deletions, ...(commentOnly.has(f.id) ? { commentOnly: true } : {}) })),
    fileCount: c.files.length,
    symbols: c.symbols.slice(0, limit).map((s) => ({ id: s.id, name: s.name, file: s.file, kind: s.kind, exported: s.exported, usedBy: s.usedBy, ...(newFiles.has(s.file) ? { new: true } : {}) })),
    impacted: c.impacted.slice(0, limit),
    impactedCount: c.impacted.length,
    impactedRoutes: routeLabels.slice(0, limit),
    tests: { files: c.tests.files.slice(0, limit), count: c.tests.files.length, command: c.tests.command },
    untested: untested.slice(0, limit),
    ...(c.coverage
      ? {
          coverage: {
            pct: c.coverage.pct,
            covered: c.coverage.covered,
            coverable: c.coverage.coverable,
            report: c.coverage.report,
            stale: c.coverage.stale,
            uncovered: c.coverage.files.filter((f) => f.uncovered.length).slice(0, limit).map((f) => ({ file: f.file, lines: f.uncovered, ...(f.missing ? { missing: true } : {}) })),
            ...(c.coverage.unmeasured?.length ? { unmeasured: c.coverage.unmeasured.slice(0, limit) } : {}),
          },
        }
      : {}),
    ...(c.readingOrder?.length ? { readingOrder: c.readingOrder.slice(0, limit).map((st) => ({ file: st.file, order: st.order, group: st.group, role: st.role, reasons: st.reasons })) } : {}),
    risk: c.risk,
    reviewers: c.reviewers.slice(0, limit).map((r) => ({ name: r.name, files: r.files })),
    owners: c.owners.slice(0, limit).map((o) => ({ owner: o.owner, files: o.files.slice(0, limit), count: o.files.length })),
    impactPrecision: c.impactPrecision,
    commits: c.commits.slice(0, limit).map((m) => ({ hash: m.hash, subject: m.subject, author: m.author, date: isoDay(m.date) })),
    ...(c.delta ? { delta: deltaFacts(c.delta, limit) } : {}),
    ...(c.cloneDrift?.length ? { cloneDrift: c.cloneDrift.slice(0, limit).map((d) => ({ changed: copyRef(d.changed), untouched: d.untouched.slice(0, limit).map(copyRef), ...(d.similarity !== undefined ? { similarity: d.similarity } : {}) })) } : {}),
  };
}

export interface ChangesOptions {
  limit: number;
  format: ResponseFormat;
  /** The project root (tells a repository without commits from no repository). */
  root?: string;
  /** What the server analyzes: git off (`--no-git`) or change detection off. */
  analysis?: McpContext['analysis'];
}

/** A git work tree around `root` (also one without commits yet, which the analysis has no history for). */
function inGitRepository(root: string): boolean {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/** A git repository whose branch has no commit yet: its analysis counts every file as new. */
function noCommitsYet(root: string): boolean {
  const repo = findRepo(root);
  return !!repo && !!readHead(repo)?.startsWith('ref:');
}

/** Why there is nothing to review: git off, no repository, no commits yet, or simply a clean working tree. */
function noChanges(data: ReportData, opts: ChangesOptions): RenderedAnswer {
  if (opts.analysis?.git === false) return { text: 'Git is off for this server (started with --no-git), so changes are not detected. Start it without --no-git to review your changes.', structured: { available: false, reason: 'git-off' } };
  if (opts.analysis?.changes === false) return { text: 'Change detection is off for this analysis.', structured: { available: false, reason: 'changes-off' } };
  if (!data.git) {
    return opts.root && inGitRepository(opts.root)
      ? { text: 'This git repository has no commits yet, so there is nothing to compare with. Commit once; after that, review_changes shows your uncommitted work.', structured: { available: false, reason: 'no-commits' } }
      : { text: 'This project is not a git repository (or git is not available), so there are no changes to review.', structured: { available: false, reason: 'not-git' } };
  }
  const branch = data.git.branch && data.git.branch !== 'HEAD' ? ` on ${code(data.git.branch)}` : '';
  return {
    text: `No changes: the working tree is clean${branch}, and there are no commits to compare with a base branch. Edit or commit something, or pass base to compare with another ref.`,
    structured: { available: true, mode: 'working', ...(data.git.branch ? { branch: data.git.branch } : {}), files: [], fileCount: 0 },
  };
}

/**
 * "My changes" as Markdown and structured data (the tool, the cv://changes resource and the review
 * prompt). What to act on comes first — architecture changes, tests to run, review notes — so a cut
 * answer loses the long lists of files, not the breaking changes.
 */
export function renderChanges(data: ReportData, opts: ChangesOptions): RenderedAnswer {
  const c = data.changes;
  if (!c) return noChanges(data, opts);
  const vs = c.mode === 'branch' && c.base ? `${code(c.base)}${c.baseCommit ? ` (${c.baseCommit.slice(0, 10)})` : ''}` : 'the last commit (uncommitted work)';
  // Before the first commit there is no last commit: every file is new (as check, test and pr see it).
  const fresh = c.mode === 'working' && !data.git && !!opts.root && noCommitsYet(opts.root);
  if (!c.files.length) return { text: `No changes compared to ${vs}.`, structured: { available: true, mode: c.mode, base: c.base, files: [], fileCount: 0 } };
  const routes = new Map(data.routes.map((r) => [r.id, r]));
  const routeLabels = [...new Set(c.impactedRoutes.flatMap((id) => (routes.has(id) ? [`${routes.get(id)!.method} ${routes.get(id)!.path}`] : [])))];
  const view: ChangesView = {
    c,
    limit: opts.limit,
    detailed: opts.format === 'detailed',
    untested: untestedChanges(data),
    commentOnly: new Set(c.commentOnly ?? []),
    routeLabels,
    newFiles: new Set(c.files.filter((f) => NEW_FILE.has(f.status)).map((f) => f.id)),
  };
  const summary = `${plural(c.files.length, 'file')} (+${c.additions} −${c.deletions})${c.commits.length ? ` · ${plural(c.commits.length, 'commit')}` : ''} · ${plural(c.impacted.length, 'impacted file')} · risk **${c.risk.level}** (${c.risk.score}/100)${c.impactPrecision === 'symbol' ? ' · impact by symbol' : ''}`;
  const highlights = c.delta ? deltaHighlights(c.delta) : [];
  const lines = [
    fresh ? '## Your changes (no commits yet: every file is new)' : `## Your changes vs ${vs}`,
    '',
    summary,
    ...(highlights.length ? [`Architecture: ${highlights.join('; ')}`] : []),
    ...(c.delta ? ['', architectureDeltaMarkdown(c.delta)] : []),
    ...testsSection(view),
    ...reviewSection(view),
    ...readingSection(view),
    ...impactSection(view),
    ...changedFilesSection(view),
    ...changedExportsSection(view),
    ...commitsSection(view),
  ];
  return { text: lines.join('\n').trimEnd(), structured: changesStructured(view) };
}

/** Branches and tags close to a mistyped ref. */
async function refSuggestions(root: string, ref: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']);
  const refs = (out ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const hit = closest(ref, refs);
  return hit ? [hit] : refs.filter((r) => r.toLowerCase().includes(ref.toLowerCase())).slice(0, 3);
}

/**
 * The analysis whose changes to review: the server's, or a one-off one against `base`. An unknown ref is
 * an error with suggestions — it must not quietly compare with something else.
 */
export async function changesData(ctx: McpContext, rawBase: string | undefined): Promise<{ data: ReportData } | { error: string; suggestions: string[] }> {
  const data = await ctx.report();
  const base = rawBase?.trim() || undefined;
  if (!base || base === data.changes?.base || ctx.analysis?.git === false || !ctx.reportFor) return { data };
  if (/^-/.test(base) || /\s/.test(base)) return { error: `"${base}" is not a git ref.`, suggestions: [] };
  if (!(await resolveCommit(ctx.root, base))) {
    const suggestions = await refSuggestions(ctx.root, base);
    return { error: `Unknown git ref "${base}"${suggestions.length ? `; did you mean ${suggestions.join(', ')}?` : '.'}`, suggestions };
  }
  return { data: await ctx.reportFor({ base }) };
}

export const reviewChangesTool: ToolDef = {
  name: 'review_changes',
  title: 'Review my changes',
  description:
    'Your current work (uncommitted changes, or the branch compared to its base): changed files and symbols, impacted files and routes, the tests to run with the command, changed files no test reaches, risk, suggested reviewers, and architecture changes — new cycles, rule violations, breaking exports with call sites not yet updated. Use before committing or opening a PR.',
  inputSchema: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'Compare with this git ref (default: the configured base, origin/HEAD, main or master; uncommitted work on the base branch).' },
      ...COMMON_PROPERTIES,
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const found = await changesData(ctx, typeof args.base === 'string' ? args.base : undefined);
    if ('error' in found) return toolError(found.error, { error: 'unknown-ref', base: args.base, suggestions: found.suggestions });
    const { data } = found;
    const format = formatOf(args);
    const { text, structured } = renderChanges(data, { limit: limitOf(args), format, root: ctx.root, analysis: ctx.analysis });
    return answer(text, format, structured, 'lower limit, or call impact / tests_for on single files');
  },
};
