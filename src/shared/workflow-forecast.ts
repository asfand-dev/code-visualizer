/**
 * What GitHub would do with a workflow: which of them a push or a pull request starts (branch and path
 * filters follow GitHub's glob rules), and how the jobs of a workflow depend on each other. Pure.
 */
import { describeCron } from './cron.js';
import { plural } from './plural.js';
import type { WorkflowInfo, WorkflowJob, WorkflowTrigger } from './types.js';

/* --------------------------------- Filters --------------------------------- */

/** The filters of a trigger in words (`branches main`, `2 path filters`, `Weekdays at 03:00 UTC`). */
export function triggerFilters(trigger: WorkflowTrigger): string[] {
  const parts: string[] = [];
  if (trigger.branches?.length) parts.push(`branches ${trigger.branches.join(', ')}`);
  if (trigger.branchesIgnore?.length) parts.push(`not ${trigger.branchesIgnore.join(', ')}`);
  if (trigger.tags?.length) parts.push(`tags ${trigger.tags.join(', ')}`);
  if (trigger.paths?.length) parts.push(plural(trigger.paths.length, 'path filter'));
  if (trigger.pathsIgnore?.length) parts.push(`ignores ${plural(trigger.pathsIgnore.length, 'path')}`);
  if (trigger.types?.length) parts.push(trigger.types.join(', '));
  if (trigger.cron?.length) parts.push(...trigger.cron.map(describeCron));
  if (trigger.workflows?.length) parts.push(`after ${trigger.workflows.join(', ')}`);
  if (trigger.inputs?.length) parts.push(`inputs ${trigger.inputs.join(', ')}`);
  return parts;
}

const REGEX_SPECIAL = /[.()|{}^$\\]/;
const globCache = new Map<string, RegExp>();

/**
 * GitHub's filter patterns: `*` matches anything but `/`, `**` anything, `?` and `+` apply to the character
 * before them (zero or one, one or more), `[a-z]` is a character class.
 */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      const withSlash = pattern[i + 2] === '/';
      source += withSlash ? '(?:.*/)?' : '.*';
      i += withSlash ? 2 : 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?' || ch === '+') {
      source += ch;
    } else if (ch === '[' && pattern.indexOf(']', i + 1) > 0) {
      const close = pattern.indexOf(']', i + 1);
      source += pattern.slice(i, close + 1);
      i = close;
    } else {
      source += REGEX_SPECIAL.test(ch) || ch === '[' || ch === ']' ? `\\${ch}` : ch;
    }
  }
  const regex = new RegExp(`^${source}$`);
  globCache.set(pattern, regex);
  return regex;
}

export function matchesGlob(pattern: string, text: string): boolean {
  try {
    return globToRegExp(pattern).test(text);
  } catch {
    return false; // a pattern that is not a valid expression matches nothing
  }
}

/** Patterns are applied in order; a `!` pattern removes what the ones before it matched. */
export function matchesFilters(patterns: string[], text: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) matched = matched && !matchesGlob(pattern.slice(1), text);
    else matched = matched || matchesGlob(pattern, text);
  }
  return matched;
}

/* -------------------------------- Forecast --------------------------------- */

/** `push` to `branch`, or a pull request that targets `branch`, changing `files` (paths from the repository root). */
export interface RunEvent {
  name: 'push' | 'pull_request';
  branch: string;
  files: string[];
}

export interface RunForecast {
  file: string;
  name: string;
  runs: boolean;
  /** Why it does or does not run. */
  reason: string;
}

const list = (items: string[]): string => items.map((item) => `\`${item}\``).join(', ');

function branchVerdict(trigger: WorkflowTrigger, branch: string, event: RunEvent['name']): string | undefined {
  if (trigger.branches?.length && !matchesFilters(trigger.branches, branch)) return `branch \`${branch}\` is not in \`branches\` (${list(trigger.branches)})`;
  if (trigger.branchesIgnore?.length && matchesFilters(trigger.branchesIgnore, branch)) return `branch \`${branch}\` is in \`branches-ignore\``;
  if (event === 'push' && !trigger.branches?.length && !trigger.branchesIgnore?.length && trigger.tags?.length) return 'it only runs for tags (`tags` is set and `branches` is not)';
  return undefined;
}

function pathVerdict(trigger: WorkflowTrigger, files: string[]): string | undefined {
  if (!files.length) return undefined;
  if (trigger.paths?.length && !files.some((file) => matchesFilters(trigger.paths ?? [], file))) return `no changed file matches \`paths\` (${list(trigger.paths)})`;
  if (trigger.pathsIgnore?.length && files.every((file) => matchesFilters(trigger.pathsIgnore ?? [], file))) return 'every changed file is in `paths-ignore`';
  return undefined;
}

export function forecastRun(workflow: WorkflowInfo, event: RunEvent): RunForecast {
  const base = { file: workflow.file, name: workflow.name };
  const trigger = workflow.triggers.find((t) => t.event === event.name);
  if (!trigger) return { ...base, runs: false, reason: `it is not triggered by \`${event.name}\`` };
  const blocked = branchVerdict(trigger, event.branch, event.name) ?? pathVerdict(trigger, event.files);
  if (blocked) return { ...base, runs: false, reason: blocked };
  return { ...base, runs: true, reason: `\`${event.name}\` on \`${event.branch}\` matches its filters` };
}

export function forecastRuns(workflows: WorkflowInfo[], event: RunEvent): RunForecast[] {
  return workflows.map((workflow) => forecastRun(workflow, event));
}

/* --------------------------------- Job graph -------------------------------- */

/** The jobs in columns: a job comes after every job it `needs`. Unknown names and cycles are ignored. */
export function jobLevels(jobs: Pick<WorkflowJob, 'id' | 'needs'>[]): string[][] {
  const needs = new Map(jobs.map((job) => [job.id, job.needs.filter((n) => n !== job.id)]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = (needs.get(id) ?? []).filter((n) => needs.has(n));
    const level = parents.length ? 1 + Math.max(...parents.map(levelOf)) : 0;
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  const columns: string[][] = [];
  for (const job of jobs) (columns[levelOf(job.id)] ??= []).push(job.id);
  return columns.filter((column) => column?.length);
}

/** A circular `needs` chain (`a → b → a`), or undefined. */
export function findNeedsCycle(jobs: Pick<WorkflowJob, 'id' | 'needs'>[]): string[] | undefined {
  const needs = new Map(jobs.map((job) => [job.id, job.needs]));
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    if (done.has(id) || !needs.has(id)) return undefined;
    path.push(id);
    for (const next of needs.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(id);
    return undefined;
  };
  for (const job of jobs) {
    const cycle = visit(job.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/** The job graph as a Mermaid flowchart (paste it into a README or an issue). */
export function workflowMermaid(workflow: Pick<WorkflowInfo, 'name' | 'jobs'>): string {
  const ids = new Map<string, string>();
  const nodeId = (job: string): string => {
    const existing = ids.get(job);
    if (existing) return existing;
    const id = `j${ids.size}`;
    ids.set(job, id);
    return id;
  };
  const label = (text: string): string => text.replace(/["\\]/g, "'");
  const lines = ['flowchart LR'];
  for (const job of workflow.jobs) {
    const suffix = job.matrix && job.matrix.combos > 1 ? ` ×${job.matrix.combos}` : '';
    lines.push(`  ${nodeId(job.id)}["${label(job.name ?? job.id)}${suffix}"]`);
  }
  for (const job of workflow.jobs) {
    for (const need of job.needs) if (workflow.jobs.some((j) => j.id === need)) lines.push(`  ${nodeId(need)} --> ${nodeId(job.id)}`);
  }
  return lines.join('\n');
}
