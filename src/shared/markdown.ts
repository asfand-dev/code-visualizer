/**
 * Markdown generators shared by the CLI (`code-visualizer context`) and the report UI
 * ("Copy PR description", "Copy context for AI"). Pure functions over ReportData — no Node APIs.
 */
import type { ArchitectureDelta, FileInfo, ReportData, ReviewGroup, ReviewPlan, ReviewStep, RouteInfo, RuleListEntry } from './types.js';
import { breakingExports, exportChangeLabel, exportImpactLabel, healthDrop, isEmptyDelta, shortNames } from './delta.js';
import { checklistItem, effortLabel, independentChanges, reviewEffort, suggestsSplit } from './review.js';
import { signature } from './signature.js';
import { formatPct, formatRanges, reportAge } from './coverage.js';
import { untestedChanges } from './query.js';
import { fragmentLocation, newCloneMessage } from './clones.js';
import { buildTestCommand, isTestableSource } from './testcmd.js';

const n = (v: number): string => v.toLocaleString('en-US');
const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${n(count)} ${count === 1 ? word : pluralWord}`;
const code = (v: string): string => `\`${v.replace(/`/g, "'")}\``;
const base = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

function routeLabel(r: RouteInfo): string {
  return `${r.method} ${r.path}`;
}

function stack(data: ReportData): string {
  const main = data.project.frameworks.filter((f) => ['fullstack', 'frontend', 'backend', 'mobile', 'desktop'].includes(f.category)).map((f) => f.name);
  const lang = data.project.typescript ? 'TypeScript' : 'JavaScript';
  return [...main.slice(0, 4), lang].join(', ');
}

function mermaidId(id: string, index: Map<string, string>): string {
  let v = index.get(id);
  if (!v) {
    v = `f${index.size}`;
    index.set(id, v);
  }
  return v;
}

/* -------------------------------------------------------------------------- */
/*                               PR description                               */
/* -------------------------------------------------------------------------- */

export function prSummaryMarkdown(data: ReportData): string {
  const c = data.changes;
  if (!c) return '_No changes detected._';
  const byId = new Map(data.files.map((f) => [f.id, f]));
  const routes = new Map(data.routes.map((r) => [r.id, r]));
  const areas = [...new Set(c.files.map((f) => f.id.split('/').slice(0, f.id.startsWith('src/') ? 2 : 1).join('/')))];
  const lines: string[] = [];
  lines.push('## Summary', '');
  lines.push(
    `This change touches **${plural(c.files.length, 'file')}** (+${n(c.additions)} / −${n(c.deletions)})${areas.length ? ` in ${areas.slice(0, 5).map(code).join(', ')}${areas.length > 5 ? ` and ${areas.length - 5} more areas` : ''}` : ''}.`,
  );
  if (c.commits.length) lines.push('', `Commits (${c.commits.length}):`, ...c.commits.slice(0, 15).map((m) => `- ${m.subject}`));
  lines.push('', '### Files', '', '| File | Change | Lines |', '| --- | --- | --- |');
  for (const f of c.files.slice(0, 40)) lines.push(`| ${code(f.id)} | ${f.status} | +${f.additions} −${f.deletions} |`);
  if (c.files.length > 40) lines.push(`| … ${c.files.length - 40} more | | |`);

  if (c.symbols.length) {
    lines.push('', '### Changed functions, components & classes', '');
    for (const s of c.symbols.slice(0, 20)) lines.push(`- ${code(s.name)} in ${code(s.file)}${s.usedBy ? ` — used by ${plural(s.usedBy, 'place')}` : ''}${s.exported ? '' : ' (internal)'}`);
    if (c.symbols.length > 20) lines.push(`- … and ${c.symbols.length - 20} more`);
  }

  lines.push('', '### Impact', '');
  lines.push(`- ${c.impacted.length ? `**${plural(c.impacted.length, 'other file')}** ${c.impacted.length === 1 ? 'depends' : 'depend'} on these changes` : 'No other files depend on these changes'}`);
  const seenRoutes = new Set<string>();
  const affectedRoutes = c.impactedRoutes
    .map((id) => routes.get(id))
    .filter((r): r is RouteInfo => !!r)
    .filter((r) => {
      const label = routeLabel(r);
      if (seenRoutes.has(label)) return false;
      seenRoutes.add(label);
      return true;
    });
  if (affectedRoutes.length) {
    lines.push(`- Routes affected (${affectedRoutes.length}): ${affectedRoutes.slice(0, 12).map((r) => code(routeLabel(r))).join(', ')}${affectedRoutes.length > 12 ? ', …' : ''}`);
  }
  const entries = c.impacted.filter((id) => byId.get(id)?.isEntry);
  if (entries.length) lines.push(`- Entry points affected: ${entries.slice(0, 6).map(code).join(', ')}`);
  if (c.delta) lines.push('', architectureDeltaMarkdown(c.delta, { drift: false }));

  lines.push('', '### Tests', '');
  if (c.tests.files.length) {
    lines.push(`- ${plural(c.tests.files.length, 'related test file')}: ${c.tests.files.slice(0, 10).map((t) => code(base(t))).join(', ')}${c.tests.files.length > 10 ? ', …' : ''}`);
    if (c.tests.command) lines.push(`- Run them: ${code(c.tests.command.length > 300 ? `${c.tests.command.slice(0, 300)}…` : c.tests.command)}`);
  } else {
    lines.push('- No test reaches the changed files.');
  }
  for (const line of untestedLines(data)) lines.push(line);

  lines.push('', '### Review notes', '');
  lines.push(`- Risk: **${c.risk.level}** (${c.risk.score}/100)${c.risk.factors.length ? ` — ${c.risk.factors.slice(0, 4).map((f) => f.label).join('; ')}` : ''}`);
  if (c.reviewers.length) lines.push(`- Suggested reviewers (know these files best): ${c.reviewers.slice(0, 3).map((r) => r.name).join(', ')}`);
  if (c.owners.length) lines.push(`- Code owners: ${c.owners.map((o) => o.owner).join(', ')}`);
  // --- clone-radar: a copy changed, its clones not (fix the bug everywhere) ---
  for (const d of (c.cloneDrift ?? []).slice(0, 5)) {
    const others = d.untouched.slice(0, 3).map((f) => code(fragmentLocation(f))).join(', ');
    const together = d.coChanges ? ` — they were changed together ${plural(d.coChanges, 'time')} before` : '';
    lines.push(`- ⚠️ Clone drift: ${code(fragmentLocation(d.changed))} changed, its ${d.untouched.length === 1 ? 'clone' : 'clones'} ${others}${more(d.untouched.length, 3)} did not${together}: apply the same change there?`);
  }
  if ((c.cloneDrift?.length ?? 0) > 5) lines.push(`- … ${c.cloneDrift!.length - 5} more clones changed in one copy only`);
  const related = c.clusters.filter((g) => g.length > 1);
  // review-mode: the Review path below names the parts; the cluster count would contradict it.
  if (related.length && !c.readingOrder?.length) lines.push(`- Review in ${related.length} group${related.length === 1 ? '' : 's'} of related files (see diagram).`);

  // Diagram of changed files and how they import each other.
  const changedIds = new Set(c.files.filter((f) => f.analyzed).map((f) => f.id));
  const edges = data.edges.filter((e) => changedIds.has(e.source) && changedIds.has(e.target));
  if (edges.length && changedIds.size <= 30) {
    const index = new Map<string, string>();
    lines.push('', '```mermaid', 'flowchart LR');
    for (const id of changedIds) lines.push(`  ${mermaidId(id, index)}["${base(id)}"]`);
    for (const e of edges) lines.push(`  ${mermaidId(e.source, index)} --> ${mermaidId(e.target, index)}`);
    lines.push('```');
  }
  // --- review-mode: the order in which to read this change ---
  if (c.readingOrder?.length) lines.push('', reviewPathMarkdown(c.readingOrder, { groups: c.readingGroups }));
  // --- /review-mode ---
  lines.push('', '<sub>Generated with [code-visualizer](https://www.npmjs.com/package/code-visualizer)</sub>');
  return lines.join('\n');
}

/**
 * test-intelligence: changed files no test reaches (by import, or by an HTTP request to a route they
 * handle; comment-only edits need no test), and patch coverage from the local coverage report.
 */
function untestedLines(data: ReportData): string[] {
  const c = data.changes!;
  const out: string[] = [];
  const untested = untestedChanges(data);
  if (untested.length) out.push(`- ⚠️ Not covered by any test: ${untested.slice(0, 8).map(code).join(', ')}`);
  const patch = c.coverage;
  if (patch && patch.coverable) {
    const missed = patch.files.filter((f) => f.uncovered.length);
    const where = missed.slice(0, 3).map((f) => `${code(f.file)} ${formatRanges(f.uncovered, 3)}`);
    out.push(
      `- Patch coverage **${formatPct(patch.pct)}** (${patch.covered}/${patch.coverable} changed lines)${where.length ? ` — uncovered ${where.join(', ')}${missed.length > 3 ? ', …' : ''}` : ''}` +
        `${patch.stale ? ` _(report from ${reportAge(patch.reportDate)}, older than the changes)_` : ''}`,
    );
  }
  if (patch?.unmeasured?.length) out.push(`- Patch coverage not measured (no coverage report for their package): ${patch.unmeasured.slice(0, 5).map(code).join(', ')}${patch.unmeasured.length > 5 ? ', …' : ''}`);
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                 Review mode                                */
/* -------------------------------------------------------------------------- */

const REVIEW_PATH_LIMIT = 25;

/**
 * The "### Review path" checklist of a PR description: the files in reading order (review-mode).
 * `groups` (ChangeSet.readingGroups) names the parts; without it the trailing configuration part is
 * recognised by its roles.
 */
export function reviewPathMarkdown(steps: ReviewStep[], options: { heading?: string; limit?: number; groups?: Omit<ReviewGroup, 'files'>[] } = {}): string {
  const limit = options.limit ?? REVIEW_PATH_LIMIT;
  const lines = steps.reduce((sum, s) => sum + s.meaningfulLines, 0);
  const indexes = [...new Set(steps.map((s) => s.group))];
  const last = indexes[indexes.length - 1];
  // The last part may hold configuration, docs and styles (see reviewPlan): it is not an independent change.
  const isOther = (group: number): boolean => {
    const known = options.groups?.find((g) => g.index === group);
    if (known) return known.kind === 'other';
    return group === last && group > 1 && steps.filter((s) => s.group === group).every((s) => s.role === 'config' || s.role === 'other');
  };
  const parts = indexes.filter((g) => !isOther(g)).length;
  const out = [`### ${options.heading ?? 'Review path'}`, '', `Read in this order — dependencies first, each test after the code it covers (${effortLabel(reviewEffort(lines))}${parts > 1 ? `, ${plural(parts, 'independent part')}` : ''}):`, ''];
  let group = 0;
  for (const step of steps.slice(0, limit)) {
    if (indexes.length > 1 && step.group !== group) {
      group = step.group;
      if (out[out.length - 1] !== '') out.push('');
      out.push(isOther(group) ? '**Configuration and other files**' : `**Part ${group}**`, '');
    }
    out.push(`- [${step.viewed ? 'x' : ' '}] ${checklistItem(step)}`);
  }
  if (steps.length > limit) out.push(`- … ${plural(steps.length - limit, 'more file')}`);
  return out.join('\n');
}

/** `code-visualizer review --format md`: how to read a branch or pull request, as Markdown. */
export function reviewPlanMarkdown(plan: ReviewPlan): string {
  const out: string[] = [`## Review: ${code(plan.ref)} → ${code(plan.base)}`, ''];
  const files = plan.steps.length + plan.skim.length;
  const facts = [
    `**${effortLabel(plan.effort)}**`,
    `${plural(plan.steps.length, 'file')} to read${plan.skim.length ? `, ${plural(plan.skim.length, 'to skim', 'to skim')}` : ''}${plan.additions !== undefined ? ` (+${n(plan.additions)} / −${n(plan.deletions ?? 0)})` : ''}`,
    plan.commits?.length ? plural(plan.commits.length, 'commit') : '',
    plan.mergeBase ? `since ${code(plan.mergeBase.slice(0, 10))}` : '',
  ].filter(Boolean);
  out.push(facts.join(' · '));
  if (!files) {
    out.push('', `No changes: ${code(plan.ref)} has nothing that ${code(plan.base)} does not have.`);
    return out.join('\n');
  }
  if (plan.startHere) out.push('', `**Start here:** ${code(plan.startHere.file)} — ${plan.startHere.reason}`);
  const parts = independentChanges(plan);
  // A split is only worth asking for when at least two parts are substantial on their own.
  if (suggestsSplit(plan)) {
    out.push('', `> **This is ${plural(parts.length, 'independent change')}** — review them one at a time, or split the pull request:`);
    for (const g of parts.slice(0, 8)) out.push(`> ${g.index}. ${code(g.title)} — ${plural(g.files.length, 'file')}, ${plural(g.lines, 'line')}`);
    if (parts.length > 8) out.push(`> … ${parts.length - 8} more`);
  } else if (parts.length > 1) out.push('', `${plural(parts.length, 'independent part')}, small enough to review together.`);
  if (plan.steps.length) out.push('', '### Review path', '');
  let group = 0;
  for (const step of plan.steps) {
    if (plan.groups.length > 1 && step.group !== group) {
      group = step.group;
      const g = plan.groups.find((x) => x.index === group);
      if (out[out.length - 1] !== '') out.push('');
      out.push(`**${g?.kind === 'other' ? g.title : `Part ${group}: ${g?.title ?? ''}`}**`, '');
    }
    out.push(`- [${step.viewed ? 'x' : ' '}] ${plan.checklist[step.order - 1] ?? checklistItem(step)}`);
  }
  if (plan.skim.length) {
    out.push('', '### Skim', '');
    for (const s of plan.skim.slice(0, 40)) out.push(`- ${code(s.file)} — ${s.reason}`);
    if (plan.skim.length > 40) out.push(`- … ${plan.skim.length - 40} more`);
  }
  if (plan.delta && !isEmptyDelta(plan.delta)) out.push('', architectureDeltaMarkdown(plan.delta));
  if (plan.untestedChanges.length) {
    out.push('', '### Changed functions without test changes', '');
    for (const id of plan.untestedChanges.slice(0, 20)) {
      const hash = id.indexOf('#');
      out.push(`- ${code(`${id.slice(hash + 1)}()`)} in ${code(id.slice(0, hash))}`);
    }
    if (plan.untestedChanges.length > 20) out.push(`- … ${plan.untestedChanges.length - 20} more`);
  }
  for (const w of plan.warnings ?? []) out.push('', `> ${w}`);
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                           Architecture changes                             */
/* -------------------------------------------------------------------------- */

const at = (file: string, line?: number): string => code(line ? `${file}:${line}` : file);
const more = (total: number, shown: number): string => (total > shown ? `, … ${total - shown} more` : '');
const codes = (items: string[], max: number): string => `${items.slice(0, max).map(code).join(', ')}${more(items.length, max)}`;

/** Bullets of the architecture section, most important first. */
const DELTA_BULLETS: ((delta: ArchitectureDelta) => string[])[] = [
  (d) => {
    if (!d.newCycles.length) return [];
    const path = (c: string[]): string => {
      const names = shortNames(c);
      return [...c, c[0]].map((id) => code(names.get(id) ?? id)).join(' → ');
    };
    return [`- ⚠️ **${plural(d.newCycles.length, 'new circular dependency', 'new circular dependencies')}**:`, ...d.newCycles.slice(0, 5).map((c) => `  - ${path(c)}`)];
  },
  (d) => (d.fixedCycles.length ? [`- ✅ ${plural(d.fixedCycles.length, 'circular dependency', 'circular dependencies')} fixed`] : []),
  (d) => {
    if (!d.newViolations.length) return [];
    const rows = d.newViolations.slice(0, 8).map((v) => `  - ${at(v.source, v.line)} → ${code(v.target)}${v.message ? ` — ${v.message}` : ` (${v.rule})`}`);
    return [`- ⚠️ **${plural(d.newViolations.length, 'new rule violation')}**:`, ...rows, ...(d.newViolations.length > 8 ? [`  - … ${d.newViolations.length - 8} more`] : [])];
  },
  (d) => (d.fixedViolations.length ? [`- ✅ ${plural(d.fixedViolations.length, 'rule violation')} fixed`] : []),
  (d) => {
    const breaking = breakingExports(d);
    if (!breaking.length) return [];
    const rows = breaking.slice(0, 8).map((e) => {
      const impact = e.staleCallSites.length
        ? `${plural(e.staleCallSites.length, 'call')} not updated: ${e.staleCallSites.slice(0, 4).map((s) => at(s.file, s.line)).join(', ')}${more(e.staleCallSites.length, 4)}`
        : e.importers.length
          ? `${e.change === 'removed' ? 'still imported by' : 'imported by'} ${codes(e.importers, 3)}`
          : exportImpactLabel(e);
      return `  - ${code(exportChangeLabel(e))} in ${code(e.file)} — ${impact}`;
    });
    return [`- ⚠️ **${plural(breaking.length, 'breaking API change')}**:`, ...rows, ...(breaking.length > 8 ? [`  - … ${breaking.length - 8} more`] : [])];
  },
  (d) => {
    const breaking = new Set(breakingExports(d));
    // Removed exports nobody used are clean-ups, not API changes worth a reviewer's time.
    const other = d.exports.filter((e) => !breaking.has(e) && e.change !== 'added' && !(e.change === 'removed' && !e.importers.length));
    return other.length ? [`- API changes: ${codes(other.map((e) => exportChangeLabel(e, true)), 6)}`] : [];
  },
  (d) => (d.routes.added.length ? [`- New routes: ${codes(d.routes.added, 8)}`] : []),
  (d) => {
    if (!d.routes.removed.length) return [];
    const rows = d.routes.removed.slice(0, 8).map((r) => {
      const callers = r.stillCalledFrom.slice(0, 3).map((c) => at(c.file, c.line)).join(', ');
      return `  - ${code(r.label)}${r.stillCalledFrom.length ? ` — ⚠️ still called from ${callers}${more(r.stillCalledFrom.length, 3)}` : ''}`;
    });
    return ['- Removed routes:', ...rows];
  },
  (d) => {
    const parts = [
      d.addedPackages.length ? `added ${codes(d.addedPackages, 6)}` : '',
      d.removedPackages.length ? `no longer imported ${codes(d.removedPackages, 6)}` : '',
      d.newMissingDependencies.length ? `⚠️ imported but not in package.json: ${codes(d.newMissingDependencies, 6)}` : '',
      d.newDevDependenciesInProduction?.length ? `⚠️ devDependencies used in production code: ${codes(d.newDevDependenciesInProduction.map((p) => p.name), 6)}` : '',
    ].filter(Boolean);
    return parts.length ? [`- Packages: ${parts.join('; ')}`] : [];
  },
  (d) => {
    const complex = d.complexity.filter((c) => c.after > 10);
    const label = (c: ArchitectureDelta['complexity'][number]): string => `${code(c.name)} ${c.before ? `${c.before} → ${c.after}` : `(new, ${c.after})`}`;
    return complex.length ? [`- More complex: ${complex.slice(0, 6).map(label).join(', ')}${more(complex.length, 6)}`] : [];
  },
  (d) => (d.newUnusedExports.length ? [`- New unused exports: ${d.newUnusedExports.slice(0, 6).map((u) => `${code(u.name)} in ${code(base(u.file))}`).join(', ')}${more(d.newUnusedExports.length, 6)}`] : []),
  // --- clone-radar: "this already exists" ---
  (d) => {
    if (!d.newClones?.length) return [];
    const rows = d.newClones.slice(0, 6).map((fam) => `  - ${newCloneMessage(fam, code)} (${fam.fragments.map((f) => code(fragmentLocation(f))).slice(0, 3).join(' ≈ ')})`);
    return [`- ⚠️ **${plural(d.newClones.length, 'new copy-paste clone')}**:`, ...rows, ...(d.newClones.length > 6 ? [`  - … ${d.newClones.length - 6} more`] : [])];
  },
  (d) =>
    (d.driftedClones ?? []).slice(0, 5).map((x) => `- ⚠️ Clone drift: ${code(fragmentLocation(x.changed))} changed, its ${x.untouched.length === 1 ? 'clone' : 'clones'} ${x.untouched.slice(0, 3).map((f) => code(fragmentLocation(f))).join(', ')}${more(x.untouched.length, 3)} did not — they no longer match: apply the same change there?`),
  (d) => (d.fixedClones?.length ? [`- ✅ ${plural(d.fixedClones.length, 'copy-paste clone')} merged or removed`] : []),
  (d) => (d.health.categories.length ? [`- Health by category: ${d.health.categories.map((c) => `${c.id} ${c.before} → ${c.after}`).join(', ')}`] : []),
];

/** Mermaid diagram of the new dependencies between areas (empty when there are none or too many). */
function newAreasDiagram(delta: ArchitectureDelta): string[] {
  const added = delta.areaEdges.filter((a) => a.isNew);
  if (!added.length || added.length > 30) return [];
  const index = new Map<string, string>();
  const out = ['', `New dependencies between areas (${added.length}):`, '', '```mermaid', 'flowchart LR'];
  for (const area of new Set(added.flatMap((a) => [a.from, a.to]))) out.push(`  ${mermaidId(area, index)}["${area.replace(/"/g, "'")}"]`);
  for (const a of added) out.push(`  ${mermaidId(a.from, index)} -->|${a.after}| ${mermaidId(a.to, index)}`);
  out.push('```');
  return out;
}

/** What the delta was compared to: `` `main` (`abc1234567`) `` or `` the merge-base with `main` (`abc1234567`) ``. */
export function deltaBaseLabel(delta: Pick<ArchitectureDelta, 'base' | 'baseCommit' | 'mergeBase'>, format: (s: string) => string = code): string {
  const short = delta.baseCommit.slice(0, 10);
  const commit = short && !delta.base.startsWith(short) && !short.startsWith(delta.base) ? ` (${format(short)})` : '';
  return `${delta.mergeBase ? 'the merge-base with ' : ''}${format(delta.base)}${commit}`;
}

/** "What changed architecturally" for a PR description or `diff --format md` (heading level 3). */
export function architectureDeltaMarkdown(delta: ArchitectureDelta, options: { heading?: string; drift?: boolean } = {}): string {
  // clone-radar: the PR summary lists clone drift in its review notes (with the drift of My changes).
  if (options.drift === false) delta = { ...delta, driftedClones: undefined };
  const out: string[] = [`### ${options.heading ?? 'Architecture changes'}`, ''];
  if (isEmptyDelta(delta)) {
    out.push(`No architectural changes compared to ${deltaBaseLabel(delta)}: no new dependencies between areas, cycles, rule violations or API changes.`);
    return out.join('\n');
  }
  const drop = healthDrop(delta);
  const added = delta.newEdges.length + (delta.truncated?.newEdges ?? 0);
  const removed = delta.removedEdges.length + (delta.truncated?.removedEdges ?? 0);
  const parts = [added ? `+${plural(added, 'import')}` : '', removed ? `−${plural(removed, 'import')}` : '', delta.health.before !== delta.health.after ? `health ${delta.health.before} → ${delta.health.after} (${drop > 0 ? `−${drop}` : `+${-drop}`})` : ''].filter(Boolean);
  out.push(`Compared to ${deltaBaseLabel(delta)}${parts.length ? `: ${parts.join(', ')}` : ''}.`, '');
  for (const bullets of DELTA_BULLETS) out.push(...bullets(delta));
  out.push(...newAreasDiagram(delta));
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                              Context for AI                                */
/* -------------------------------------------------------------------------- */

// --- mcp-server ---
/** Free text in a fenced block that its content cannot close (the fence is longer than any backtick run inside). */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}text\n${text.replace(/\r\n?/g, '\n').trimEnd()}\n${marks}`;
}

export interface FileContextOptions {
  /** Include the file's source code. */
  source?: boolean;
  /**
   * Put text that comes from the repository rather than the code structure — the file comment, doc
   * comments, commit subjects, TODO notes — in fenced blocks, so an AI agent reads it as data, never as
   * instructions (the MCP server sets this).
   */
  fenceRepoText?: boolean;
}

export function fileContextMarkdown(data: ReportData, fileId: string, options: FileContextOptions = {}): string {
  const byId = new Map(data.files.map((f) => [f.id, f]));
  const file = byId.get(fileId);
  if (!file) return `File ${code(fileId)} is not part of this analysis.`;
  const fence = !!options.fenceRepoText;
  const out: string[] = [];
  out.push(`# Context: ${file.id}`, '');
  out.push(`Project **${data.project.name}** (${stack(data)}).`, '');
  out.push(`- Kind: ${file.kind}${file.isEntry ? ` (entry point: ${file.entryReason})` : ''}`);
  out.push(`- Size: ${plural(file.loc, 'line')}, cyclomatic complexity ${file.complexity}`);
  out.push(`- Imports ${plural(file.metrics.fanOut, 'project file')}, used by ${plural(file.metrics.fanIn, 'file')}`);
  if (file.description && !fence) out.push(`- Description: ${file.description}`);
  if (file.inCycle) out.push('- ⚠️ Part of a circular dependency');
  if (file.owners?.length) out.push(`- Owners: ${file.owners.join(', ')}`);
  if (file.git?.authors.length) out.push(`- Main authors: ${file.git.authors.slice(0, 3).map((a) => a.name).join(', ')}`);

  if (file.description && fence) out.push('', '## File comment', '', fenced(file.description));

  const exported = file.symbols.filter((s) => s.exported);
  const internal = file.symbols.filter((s) => !s.exported);
  if (file.symbols.length) {
    out.push('', '## Declarations', '');
    for (const s of [...exported, ...internal].slice(0, 60)) {
      const extra: string[] = [];
      if (s.component?.props.length) extra.push(`props: ${s.component.props.join(', ')}`);
      if (s.component?.hooks.length) extra.push(`hooks: ${s.component.hooks.join(', ')}`);
      if (s.deprecated !== undefined) extra.push('deprecated');
      out.push(`- ${s.exported ? '**export** ' : ''}${code(signature(s))}${s.doc && !fence ? ` — ${s.doc}` : ''}${extra.length ? ` (${extra.join('; ')})` : ''}`);
      for (const m of (s.members ?? []).slice(0, 15)) out.push(`  - ${code(`${m.name}${m.type ? `: ${m.type}` : ''}`)}`);
    }
    const docs = [...exported, ...internal].slice(0, 60).filter((s) => s.doc);
    if (fence && docs.length) out.push('', '## Doc comments', '', fenced(docs.map((s) => `${s.name}: ${s.doc}`).join('\n')));
  }

  const imports = data.edges.filter((e) => e.source === file.id);
  const usedBy = data.edges.filter((e) => e.target === file.id);
  const packages = data.packages.filter((p) => p.importedBy.includes(file.id));
  if (imports.length || packages.length) {
    out.push('', '## Depends on', '');
    for (const e of imports.slice(0, 40)) {
      const names = e.names.filter((x) => x !== '*').slice(0, 8);
      out.push(`- ${code(e.target)}${names.length ? ` → ${names.join(', ')}` : ''}`);
    }
    if (packages.length) out.push(`- Packages: ${packages.map((p) => p.name).join(', ')}`);
  }
  if (usedBy.length) {
    out.push('', '## Used by', '');
    for (const e of usedBy.slice(0, 40)) {
      const names = e.names.filter((x) => x !== '*').slice(0, 6);
      out.push(`- ${code(e.source)}${names.length ? ` (uses ${names.join(', ')})` : e.kind === 'reexport' ? ' (re-exports it)' : ''}`);
    }
  }
  const routes = data.routes.filter((r) => r.file === file.id || r.handlerSymbol?.startsWith(`${file.id}#`));
  if (routes.length) out.push('', '## Routes', '', ...routes.map((r) => `- ${code(routeLabel(r))}${r.handler ? ` → ${r.handler}` : ''}`));
  const calls = data.apiCalls.filter((c) => c.file === file.id);
  if (calls.length) {
    const routeById = new Map(data.routes.map((r) => [r.id, r]));
    out.push('', '## HTTP calls', '', ...calls.map((c) => `- ${code(`${c.method} ${c.url}`)}${c.route ? ` → served by ${code(routeById.get(c.route)?.file ?? '')}` : c.external ? ` (external: ${c.external})` : ''}`));
  }
  if (file.tests?.length) out.push('', '## Tests', '', ...file.tests.slice(0, 15).map((t) => `- ${code(t)}`));
  const recent = (file.git?.recent ?? []).slice(0, 6).map((c) => `${new Date(c.date).toISOString().slice(0, 10)} ${c.author}: ${c.subject}`);
  if (recent.length) out.push('', '## Recent changes', '', ...(fence ? [fenced(recent.join('\n'))] : recent.map((r) => `- ${r}`)));
  const notes = file.todos.slice(0, 10).map((t) => `L${t.line} ${t.tag}: ${t.text}`);
  if (notes.length) out.push('', '## Open notes', '', ...(fence ? [fenced(notes.join('\n'))] : notes.map((n) => `- ${n}`)));
  if (options.source && file.source !== undefined) {
    const lang = file.ext.replace(/^\./, '').replace(/^m?([jt]sx?)$/, '$1');
    out.push('', '## Source', '', `\`\`\`${lang}`, file.source.trimEnd(), '```');
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                              Project summary                               */
/* -------------------------------------------------------------------------- */

/** A compact architecture overview — handy as onboarding notes or as context for AI assistants (AGENTS.md / CLAUDE.md). */
export function projectSummaryMarkdown(data: ReportData, options: Pick<FileContextOptions, 'fenceRepoText'> = {}): string {
  const { project, stats } = data;
  const fence = !!options.fenceRepoText;
  const out: string[] = [];
  out.push(`# ${project.name} — architecture overview`, '');
  if (project.description) out.push(fence ? fenced(project.description) : project.description, '');
  out.push(`- Stack: ${stack(data)}`);
  out.push(`- Size: ${plural(stats.files, 'file')}, ${plural(stats.loc, 'line')}, ${plural(stats.components, 'component')}, ${plural(stats.routes, 'route')}`);
  out.push(`- Health: ${data.health.score}/100 (${data.health.grade})`);
  const scripts = project.scripts ?? {};
  const important = ['dev', 'start', 'build', 'test', 'lint', 'typecheck'].filter((s) => scripts[s]);
  if (important.length) {
    const pm = project.packageManager ?? 'npm';
    out.push('', '## Commands', '', ...important.map((s) => `- ${code(pm === 'npm' && s !== 'start' && s !== 'test' ? `npm run ${s}` : `${pm} ${s}`)} — ${code(scripts[s])}`));
  }
  const entries = data.files.filter((f) => f.isEntry);
  if (entries.length) out.push('', '## Entry points', '', ...entries.slice(0, 10).map((f) => `- ${code(f.id)} (${f.entryReason})`));
  const areas = data.folders.filter((f) => f.path && f.files >= 2 && f.path.split('/').length <= 2).sort((a, b) => b.loc - a.loc).slice(0, 12);
  if (areas.length) out.push('', '## Structure', '', ...areas.map((a) => `- ${code(`${a.path}/`)} — ${a.description || plural(a.files, 'file')}`));
  const core = [...data.files]
    .filter((f) => f.kind !== 'test' && f.kind !== 'config' && f.metrics.fanIn >= 2)
    .sort((a, b) => b.metrics.importance - a.metrics.importance)
    .slice(0, 10);
  if (core.length) out.push('', '## Core modules', '', ...core.map((f: FileInfo) => `- ${code(f.id)} — used by ${plural(f.metrics.fanIn, 'file')}${f.description && !fence ? `. ${f.description}` : ''}`));
  const comments = core.filter((f) => f.description);
  if (fence && comments.length) out.push('', '### File comments of the core modules', '', fenced(comments.map((f) => `${f.id}: ${f.description}`).join('\n')));
  if (data.routes.length) {
    out.push('', '## Routes', '', ...data.routes.filter((r) => r.type !== 'middleware').slice(0, 30).map((r) => `- ${code(routeLabel(r))} → ${code(r.file)}`));
    if (data.routes.length > 30) out.push(`- … ${data.routes.length - 30} more`);
  }
  if (data.config?.layers?.length) out.push('', '## Architecture rules', '', ...data.config.layers.map((l, i) => `${i + 1}. ${code(l)}`), '', 'Lower layers must not import higher ones.');
  if (data.insights.cycles.length || data.insights.hotspots.length) {
    out.push('', '## Watch out', '');
    if (data.insights.cycles.length) out.push(`- ${plural(data.insights.cycles.length, 'circular dependency', 'circular dependencies')}`);
    for (const h of data.insights.hotspots.slice(0, 5)) out.push(`- Hotspot: ${code(h.file)} (complexity ${h.complexity}, ${h.commits} commits)`);
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                     Agent guardrails: brief and AGENTS.md                   */
/* -------------------------------------------------------------------------- */

// --- agent-guardrails ---

const globList = (globs: string[]): string => globs.join(', ');

/** `ui/src/** does not import src/** (except src/shared/**)` — a rule as a statement. */
function ruleStatement(r: RuleListEntry, withMessage: boolean): string {
  const except = r.allow?.length ? ` (except ${globList(r.allow)})` : '';
  const types = r.includeTypes === false ? '; type-only imports are fine' : '';
  const warn = r.severity === 'warn' ? ' [warning]' : '';
  return `\`${r.name}\`: ${globList(r.from)} does not import ${globList(r.to)}${except}${types}${warn}${withMessage && r.message ? ` — ${r.message}` : ''}`;
}

/** Layers from the configuration, top to bottom. */
function layerLine(layers: string[]): string {
  return `Layers, top to bottom (a lower layer does not import a higher one): ${layers.map((l) => `\`${l}\``).join(' → ')}.`;
}

/** The test command for a file's tests when it is short, else how many there are. */
function testsNote(data: ReportData, f: FileInfo, maxCommand = 110): string {
  const tests = f.tests ?? [];
  if (!tests.length) return 'no test reaches it';
  const command = tests.length <= 3 ? buildTestCommand(tests, data.project.testRunners).command : undefined;
  // Bucketed (FileInfo.tests is capped at 20 anyway), so a new test does not rewrite the AGENTS.md block.
  const count = tests.length >= 5 ? `${bucket(tests.length)} test files` : plural(tests.length, 'test file');
  return command && command.length <= maxCommand ? `tests: \`${command}\`` : `${count}: \`npx code-visualizer tests-for ${f.id}\``;
}

export interface SessionBriefOptions {
  branch?: string;
  /** The branch the work is compared with (`origin/main`). */
  base?: string;
  /** Commits on the branch that the base does not have. */
  ahead?: number;
  /** Files that differ from HEAD. */
  uncommitted?: string[];
  /** Tools of the code-visualizer MCP server, when the project registers it… */
  mcpTools?: string[];
  /** …in this file (`.mcp.json`). */
  mcpConfig?: string;
  /** The pre-edit guard checks edits (hooks are installed). */
  guarded?: boolean;
  /** Default 1,500 characters. */
  maxChars?: number;
}

/**
 * The context an agent gets when its session starts: facts it cannot easily discover, written as
 * statements — branch and base, uncommitted files, the architecture rules and layers, the most
 * depended-on files with their tests, and the tools. At most `maxChars` (1,500) characters.
 */
export function sessionBriefMarkdown(data: ReportData, options: SessionBriefOptions = {}): string {
  const max = options.maxChars ?? 1500;
  const rules = data.config?.ruleList ?? [];
  const layers = data.config?.layers ?? [];
  const hubs = data.files
    .filter((f) => f.kind !== 'test' && f.kind !== 'config' && f.metrics.fanIn >= 2)
    .sort((a, b) => b.metrics.fanIn - a.metrics.fanIn || a.id.localeCompare(b.id))
    .slice(0, 5);
  const uncommitted = options.uncommitted ?? [];
  const configError = data.config?.error;
  const render = (caps: { rules: number; hubs: number; files: number; messages: boolean; tools: boolean }): string => {
    const lines = [`code-visualizer brief: ${data.project.name} (${stack(data)}), ${plural(data.stats.files, 'file')}.`];
    if (options.branch || uncommitted.length) {
      const where = options.branch ? `Branch \`${options.branch}\`${options.base ? ` (base \`${options.base}\`${options.ahead ? `, ${plural(options.ahead, 'commit')} ahead` : ''})` : ''}.` : '';
      const shown = uncommitted.slice(0, caps.files).map((f) => `\`${f}\``);
      const dirty = uncommitted.length ? ` ${plural(uncommitted.length, 'uncommitted file')}: ${shown.join(', ')}${uncommitted.length > shown.length ? `, +${uncommitted.length - shown.length} more` : ''}.` : ' No uncommitted changes.';
      lines.push(`- ${where}${dirty}`.replace('-  ', '- '));
    }
    if (configError) lines.push(`- ${data.config?.file ?? 'The configuration'} is invalid (${configError.slice(0, caps.messages ? 200 : 80)}): its architecture rules and layers are not enforced.`);
    else if (rules.length) {
      const shown = rules.slice(0, caps.rules).map((r) => ruleStatement(r, caps.messages));
      lines.push(`- Architecture rules (${data.config?.file ?? 'configuration'}): ${shown.join('; ')}${rules.length > shown.length ? `; +${rules.length - shown.length} more` : ''}.`);
    } else if (!layers.length) lines.push('- No architecture rules are configured.');
    if (layers.length && !configError) lines.push(`- ${layerLine(layers)}`);
    if (hubs.length && caps.hubs) lines.push(`- Most depended-on files: ${hubs.slice(0, caps.hubs).map((f) => `\`${f.id}\` (${plural(f.metrics.fanIn, 'importer')}; ${testsNote(data, f)})`).join('; ')}.`);
    if (options.guarded) lines.push(`- Edits that add ${configError ? '' : 'a forbidden import, a layer break, '}a circular dependency or an undeclared package are refused before they are written.`);
    if (caps.tools) {
      if (options.mcpTools?.length) lines.push(`- MCP server \`code-visualizer\`${options.mcpConfig ? ` (${options.mcpConfig})` : ''}: ${options.mcpTools.join(', ')}.`);
      else lines.push('- CLI with --json: `npx code-visualizer impact <file>`, `tests-for <paths>`, `similar --stdin` (does this code exist already?), `check --changed --format json`.');
    }
    return lines.join('\n');
  };
  // Drop detail until it fits: rule messages, then list lengths, then the tools line.
  const steps = [
    { rules: 8, hubs: 5, files: 5, messages: true, tools: true },
    { rules: 8, hubs: 5, files: 5, messages: false, tools: true },
    { rules: 5, hubs: 3, files: 3, messages: false, tools: true },
    { rules: 3, hubs: 2, files: 2, messages: false, tools: true },
    { rules: 2, hubs: 1, files: 1, messages: false, tools: false },
  ];
  let text = '';
  for (const caps of steps) {
    text = render(caps);
    if (text.length <= max) return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

export const AGENTS_BLOCK_START = '<!-- code-visualizer:start -->';
export const AGENTS_BLOCK_END = '<!-- code-visualizer:end -->';
/** At most this many lines between (and including) the markers. */
export const AGENTS_BLOCK_MAX_LINES = 60;

const GENERATED_PATH_RE = /(^|\/)(generated|__generated__)\/|\.generated\.|\.gen\.[cm]?[jt]sx?$|\.pb\.[cm]?[jt]s$|_pb2?(_grpc)?\.[cm]?[jt]s$/;

/** Rounded down to 5+, 10+, 20+, 50+, 100+ so the block does not change with every new import. */
function bucket(n: number): string {
  for (const b of [100, 50, 20, 10, 5]) if (n >= b) return `${b}+`;
  return String(n);
}

export interface AgentsBlockOptions {
  /** Script commands (`build`, `test`, `lint`, `typecheck`, `dev`, `testFile`…) as the package manager runs them. */
  commands?: Record<string, string>;
  /** Tools of the code-visualizer MCP server. */
  mcpTools?: string[];
}

/**
 * The managed AGENTS.md block (markers included, at most 60 lines): commands, the single-file test
 * command, the named rules and layers, generated files, the most fragile files with their tests,
 * CODEOWNERS boundaries and the tools. Only facts an agent cannot cheaply discover, and nothing that
 * changes with every commit (no scores), so regenerating it is a no-op until something real changes.
 */
export function agentsBlockMarkdown(data: ReportData, options: AgentsBlockOptions = {}): string {
  const out: string[] = [AGENTS_BLOCK_START, '## Project map (code-visualizer)', '', '_Generated by `code-visualizer context --agents --write`; edit outside the markers._'];
  const commands = options.commands ?? {};
  const order: [string, string][] = [
    ['build', 'Build'],
    ['typecheck', 'Typecheck'],
    ['lint', 'Lint'],
    ['test', 'All tests'],
    ['testFile', 'One test file'],
    ['affectedTests', 'Tests your change affects'],
    ['dev', 'Dev server'],
  ];
  const commandLines = order.filter(([k]) => commands[k]).map(([k, label]) => `- ${label}: \`${commands[k]}\``);
  if (commandLines.length) out.push('', '### Commands', ...commandLines);

  const rules = data.config?.ruleList ?? [];
  const layers = data.config?.layers ?? [];
  if (rules.length || layers.length) {
    out.push('', `### Architecture rules (${data.config?.file ?? 'code-visualizer.config.json'})`);
    for (const r of rules.slice(0, 12)) out.push(`- ${ruleStatement(r, true)}`);
    if (rules.length > 12) out.push(`- … ${rules.length - 12} more in ${data.config?.file ?? 'the configuration'}`);
    if (layers.length) out.push(`- ${layerLine(layers)}`);
    out.push('- `npx code-visualizer check --changed` judges only what your change adds.');
  }

  const generated = data.files.filter((f) => f.isGenerated || GENERATED_PATH_RE.test(f.id)).map((f) => f.id).sort();
  if (generated.length) {
    const byDir = new Map<string, number>();
    for (const id of generated) {
      const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.';
      byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    }
    const lines = generated.length <= 6 ? generated.map((id) => `- \`${id}\``) : [...byDir].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([dir, n]) => `- \`${dir}/\` (${plural(n, 'generated file')})`);
    out.push('', '### Generated files (do not edit by hand)', ...lines);
  }

  const fragile = data.files
    .filter((f) => isTestableSource(f) && f.metrics.fanIn >= 3)
    .map((f) => ({ f, score: f.metrics.fanIn * (1 + f.maxComplexity / 10) * (f.tests?.length ? 1 : 2) * (f.inCycle ? 1.5 : 1) }))
    .sort((a, b) => b.score - a.score || a.f.id.localeCompare(b.f.id))
    .slice(0, 5);
  if (fragile.length) {
    out.push('', '### Fragile files (many dependents: run their tests after changing them)');
    for (const { f } of fragile) out.push(`- \`${f.id}\` — used by ${bucket(f.metrics.fanIn)} files; ${testsNote(data, f, 120)}`);
  }

  const owners = ownerBoundaries(data);
  if (owners.length) out.push('', '### Code owners (CODEOWNERS)', ...owners);

  out.push('', '### Tools');
  if (options.mcpTools?.length) out.push(`- MCP server \`code-visualizer\` (registered by \`npx code-visualizer agents init\`): ${options.mcpTools.join(', ')}.`);
  out.push('- CLI (add `--json` for machine output): `npx code-visualizer impact <file>`, `uses <symbol>`, `who <file>`, `tests-for <paths>`, `similar <file#Symbol>` (or a snippet on `--stdin`), `test`, `check --changed`, `review <branch>`, `sync`, `status`.');

  // Keep the block within its line budget: drop whole optional sections from the end of the middle.
  while (out.length + 1 > AGENTS_BLOCK_MAX_LINES) {
    const sections = out.map((l, i) => (l.startsWith('### ') && !l.startsWith('### Tools') && !l.startsWith('### Commands') ? i : -1)).filter((i) => i >= 0);
    const last = sections[sections.length - 1];
    if (last === undefined) break;
    const next = out.findIndex((l, i) => i > last && l.startsWith('### '));
    // The blank line before the section, its heading and its lines.
    out.splice(last - 1, (next === -1 ? out.length + 1 : next) - last);
  }
  out.push(AGENTS_BLOCK_END);
  return out.join('\n');
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The markers count only on lines of their own (a sentence that mentions them is not the block). */
const START_LINE = `^${escapeRe(AGENTS_BLOCK_START)}[ \\t\\r]*$`;
const END_LINE = `^${escapeRe(AGENTS_BLOCK_END)}[ \\t\\r]*$`;
const BLOCK_RE = new RegExp(`${START_LINE}[\\s\\S]*?${END_LINE}`, 'm');

/**
 * What is wrong with the managed block's markers in `text`, if anything: a start without an end (or
 * the other way round), an end before its start, or two blocks. Writing then would replace or keep the
 * wrong text, so callers refuse and name the line.
 */
export function managedBlockProblem(text: string): string | undefined {
  const lines = text.split('\n');
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (new RegExp(START_LINE).test(line)) starts.push(i + 1);
    else if (new RegExp(END_LINE).test(line)) ends.push(i + 1);
  });
  if (!starts.length && !ends.length) return undefined;
  if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) return undefined;
  if (starts.length > 1 || ends.length > 1) return `the code-visualizer block markers appear more than once (start on line ${starts.join(', ') || '–'}, end on line ${ends.join(', ') || '–'}); keep one block`;
  if (!ends.length) return `line ${starts[0]} has ${AGENTS_BLOCK_START} without a matching ${AGENTS_BLOCK_END}`;
  if (!starts.length) return `line ${ends[0]} has ${AGENTS_BLOCK_END} without a ${AGENTS_BLOCK_START} before it`;
  return `${AGENTS_BLOCK_END} (line ${ends[0]}) comes before ${AGENTS_BLOCK_START} (line ${starts[0]})`;
}

/**
 * `text` with the managed block replaced (or appended, or a new file with a heading when `text` is null).
 * Text outside the markers is kept byte for byte. Throws when the markers are unbalanced (see
 * `managedBlockProblem`): appending or replacing then could duplicate the block or eat the user's text.
 */
export function upsertManagedBlock(text: string | null, block: string, heading = '# AGENTS.md'): string {
  if (text === null || !text.trim()) return `${heading}\n\n${block}\n`;
  const problem = managedBlockProblem(text);
  if (problem) throw new Error(problem);
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, () => block);
  return `${text.replace(/\n*$/, '')}\n\n${block}\n`;
}

/**
 * `text` without the managed block (and the blank line before it); null when only the generated heading
 * would remain. Unbalanced markers leave the text as it is.
 */
export function removeManagedBlock(text: string, heading = '# AGENTS.md'): string | null {
  if (managedBlockProblem(text) || !BLOCK_RE.test(text)) return text;
  const next = text.replace(new RegExp(`\\n?\\n?${BLOCK_RE.source}\\n?`, 'm'), '\n');
  const trimmed = next.replace(/^\n+/, '');
  if (!trimmed.trim() || trimmed.trim() === heading) return null;
  return trimmed.endsWith('\n\n') ? trimmed.replace(/\n+$/, '\n') : trimmed;
}

/**
 * CODEOWNERS boundaries: the top-most folders whose files all have the same owners, other than the
 * owners most files have; then single files whose owners differ inside folders shared with others
 * (`lib/billing.ts` in a backend folder); last, the owners of "most files". (The analysis knows each
 * file's owners, not the CODEOWNERS rules, so it does not claim which of them is the `*` rule.)
 */
function ownerBoundaries(data: ReportData, max = 10, maxFiles = 5): string[] {
  const owned = data.files.filter((f) => f.owners?.length);
  if (!owned.length) return [];
  const key = (f: FileInfo): string => (f.owners ?? []).join(', ');
  const counts = new Map<string, number>();
  for (const f of data.files) counts.set(key(f), (counts.get(key(f)) ?? 0) + 1);
  const fallback = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  // Folder → the owner sets of the files below it.
  const below = new Map<string, Set<string>>();
  for (const f of data.files) {
    const parts = f.id.split('/').slice(0, -1);
    for (let depth = 1; depth <= Math.min(parts.length, 3); depth++) {
      const dir = parts.slice(0, depth).join('/');
      const set = below.get(dir) ?? new Set<string>();
      set.add(key(f));
      below.set(dir, set);
    }
  }
  const lines: string[] = [];
  const shown: string[] = [];
  for (const dir of [...below.keys()].sort()) {
    const sets = below.get(dir)!;
    const owners = [...sets][0];
    if (sets.size !== 1 || !owners || owners === fallback) continue;
    if (shown.some((d) => dir.startsWith(`${d}/`))) continue;
    shown.push(dir);
    lines.push(`- \`${dir}/\` → ${owners}`);
  }
  // Files in mixed folders whose owners are not the usual ones (each file's own rule, e.g. `/lib/billing.ts`).
  const exceptions = data.files
    .filter((f) => f.owners?.length && key(f) !== fallback && !shown.some((d) => f.id.startsWith(`${d}/`)))
    .map((f) => f.id)
    .sort();
  if (!lines.length && !exceptions.length) return [];
  const out = lines.slice(0, max);
  if (lines.length > max) out.push(`- … ${lines.length - max} more folders`);
  const byId = new Map(data.files.map((f) => [f.id, f]));
  out.push(...exceptions.slice(0, maxFiles).map((id) => `- \`${id}\` → ${key(byId.get(id)!)}`));
  if (exceptions.length > maxFiles) out.push(`- … ${exceptions.length - maxFiles} more files with other owners`);
  if (fallback) out.push(`- most files → ${fallback}`);
  return out;
}
