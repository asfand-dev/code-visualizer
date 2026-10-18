/**
 * MCP resources (Markdown documents a client can attach to a conversation) and prompts (ready-made
 * requests a user can pick, e.g. "/review-changes"). Both reuse the tool renderers.
 */
import { loadConfig } from '../analyzer/config.js';
import { fileContextMarkdown } from '../shared/markdown.js';
import { resolveTarget, suggest } from '../shared/query.js';
import type { ReportData } from '../shared/types.js';
import { changesData, renderChanges } from './changes.js';
import { withFreshFiles } from './format.js';
import { projectPath } from './paths.js';
import { code, ERROR, plural, RpcError, type McpContext, type PromptDef, type ResourceDef } from './protocol.js';
import { renderImpact, renderOverview } from './tools.js';

const FILE_PREFIX = 'cv://file/';

/** The health report as Markdown: score, categories and the improvements worth the most points. */
export function healthMarkdown(data: ReportData): string {
  const h = data.health;
  const out = [`# Health of ${data.project.name}: ${h.score}/100 (${h.grade})`, ''];
  const prev = data.history.length > 1 ? data.history[data.history.length - 2] : undefined;
  if (prev && prev.score !== h.score) out.push(`Previous run: ${prev.score}/100.`, '');
  out.push('| Category | Score | Detail |', '| --- | --- | --- |');
  for (const c of h.categories) out.push(`| ${c.label} | ${c.score} | ${c.detail.replace(/\|/g, '\\|')} |`);
  if (h.improvements.length) {
    out.push('', '## Best improvements', '');
    for (const i of h.improvements.slice(0, 8)) {
      const files = i.files?.length ? ` (${i.files.slice(0, 4).map(code).join(', ')}${i.files.length > 4 ? ', …' : ''})` : '';
      out.push(`- **${i.title}** (+${i.gain}): ${i.detail}${files}`);
    }
  }
  const ins = data.insights;
  // Counted like the health score counts them: complex is cyclomatic > 15, unused exports without types.
  const complex = ins.complexFunctions.filter((f) => f.complexity > 15).length;
  const unused = ins.unusedExports.filter((u) => !u.typeOnly).length;
  const watch = [
    ins.cycles.length ? plural(ins.cycles.length, 'circular dependency', 'circular dependencies') : '',
    ins.ruleViolations.length ? plural(ins.ruleViolations.length, 'rule violation') : '',
    complex ? `${plural(complex, 'complex function')} (cyclomatic > 15)` : '',
    unused ? plural(unused, 'unused export') : '',
    ins.missingDependencies.length ? `${plural(ins.missingDependencies.length, 'package')} imported but not declared` : '',
  ].filter(Boolean);
  if (watch.length) out.push('', `Findings: ${watch.join(', ')}.`);
  return out.join('\n');
}

/** The project-relative file a `cv://file/{path}` URI names; refuses paths that leave the project. */
function fileFromUri(uri: string, root: string): string {
  let raw: string;
  try {
    raw = uri
      .slice(FILE_PREFIX.length)
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
  } catch {
    throw new RpcError(ERROR.invalidParams, `Invalid resource URI ${uri}.`);
  }
  const checked = projectPath(root, raw.includes('/') || raw.startsWith('.') ? raw : `./${raw}`);
  if ('error' in checked) throw new RpcError(ERROR.invalidParams, `Invalid resource URI ${uri}: ${checked.error}`);
  return checked.id;
}

export const RESOURCES: ResourceDef[] = [
  {
    uri: 'cv://project/summary',
    name: 'project-summary',
    title: 'Project architecture overview',
    description: 'Stack, size, health, commands (one test file too), entry points, folders, core modules, routes and architecture rules.',
    mimeType: 'text/markdown',
    matches: (uri) => uri === 'cv://project/summary',
    read: async (_uri, ctx) => renderOverview(await ctx.report(), loadConfig(ctx.root)).text,
  },
  {
    uri: 'cv://changes',
    name: 'changes',
    title: 'My changes',
    description: 'Your uncommitted work or branch: changed files, impact, tests to run, risk and architecture changes.',
    mimeType: 'text/markdown',
    matches: (uri) => uri === 'cv://changes',
    read: async (_uri, ctx) => renderChanges(await ctx.report(), { limit: 100, format: 'detailed', root: ctx.root, analysis: ctx.analysis }).text,
  },
  {
    uri: 'cv://health',
    name: 'health',
    title: 'Code health',
    description: 'Health score by category and the improvements worth the most points.',
    mimeType: 'text/markdown',
    matches: (uri) => uri === 'cv://health',
    read: async (_uri, ctx) => healthMarkdown(await ctx.report()),
  },
  {
    uri: 'cv://file/{path}',
    template: true,
    name: 'file-context',
    title: 'File context',
    description: 'What a file declares, what it imports, who uses it, its routes, tests, owners and recent changes (path relative to the project root).',
    mimeType: 'text/markdown',
    matches: (uri) => uri.startsWith(FILE_PREFIX),
    async read(uri, ctx) {
      const id = fileFromUri(uri, ctx.root);
      let data = await ctx.report();
      if (!data.files.some((f) => f.id === id)) data = await withFreshFiles(ctx, data, [id]);
      if (!data.files.some((f) => f.id === id)) {
        const r = resolveTarget(data, id);
        const suggestions = r.target?.type === 'file' ? [r.target.id] : r.suggestions.length ? r.suggestions : suggest(data, id);
        throw new RpcError(ERROR.resourceNotFound, `No analyzed file ${id}${suggestions.length ? `; did you mean ${suggestions.slice(0, 5).join(', ')}?` : '.'}`, { uri, suggestions });
      }
      return fileContextMarkdown(data, id, { fenceRepoText: true });
    },
  },
];

/* -------------------------------------------------------------------------- */
/*                                   Prompts                                  */
/* -------------------------------------------------------------------------- */

const userText = (text: string): { role: 'user'; content: { type: 'text'; text: string } } => ({ role: 'user', content: { type: 'text', text } });

export const PROMPTS: PromptDef[] = [
  {
    name: 'review-changes',
    title: 'Review my changes',
    description: 'Review the current changes with their impact: check each impacted file and run the listed tests.',
    arguments: [{ name: 'base', description: 'Git ref to compare with (default: the base branch, or uncommitted work).' }],
    async get(args, ctx: McpContext) {
      const found = await changesData(ctx, args.base);
      if ('error' in found) throw new RpcError(ERROR.invalidParams, found.error, { suggestions: found.suggestions });
      const { data } = found;
      const review = renderChanges(data, { limit: 50, format: 'detailed', root: ctx.root, analysis: ctx.analysis });
      const command = data.changes?.tests.command;
      const text = [
        'Review my current changes using the project map below (from code-visualizer).',
        '',
        '1. Look at the breaking API changes and the call sites not yet updated first, then any new cycles or rule violations.',
        '2. For each impacted file listed, open it and check that it still works with the change.',
        `3. Run the listed tests${command ? ` (${code(command)})` : ''} and fix what fails; add tests for changed files that no test reaches.`,
        '4. Summarize the risks, and anything a reviewer should look at closely.',
        '',
        review.text,
      ].join('\n');
      return { description: `Review of ${data.changes?.files.length ?? 0} changed files`, messages: [userText(text)] };
    },
  },
  {
    name: 'plan-change',
    title: 'Plan a change',
    description: 'Before editing a file, symbol, folder or route: its impact plus a checklist to follow.',
    arguments: [{ name: 'target', description: 'The file, symbol, folder or route you are about to change.', required: true }],
    async get(args, ctx: McpContext) {
      const checked = projectPath(ctx.root, args.target);
      if ('error' in checked) throw new RpcError(ERROR.invalidParams, checked.error);
      const data = await withFreshFiles(ctx, await ctx.report(), [checked.id]);
      const r = resolveTarget(data, checked.id);
      if (!r.target) throw new RpcError(ERROR.invalidParams, `Nothing matches "${args.target}"${r.suggestions.length ? `; did you mean ${r.suggestions.join(', ')}?` : '.'}`, { suggestions: r.suggestions });
      const impact = renderImpact(data, [r.target], { depth: 2, limit: 30, format: 'concise', alternatives: r.alternatives });
      const tests = impact.structured.tests as { command?: string; untested: string[] };
      const text = [
        `I am about to change ${code(args.target)}. Plan the change with the impact below (from code-visualizer), then follow this checklist:`,
        '',
        '- Read the direct users and their call sites before changing a signature; keep it compatible or update every call site listed.',
        '- Call check_architecture before adding an import from another folder.',
        `- After editing, run ${tests.command ? code(tests.command) : 'the tests listed below'}${tests.untested.length ? `, and add tests for ${tests.untested.slice(0, 3).map(code).join(', ')}` : ''}.`,
        '- Mention the affected routes and the owners to notify in the PR description.',
        '',
        impact.text,
      ].join('\n');
      return { description: `Plan for changing ${args.target}`, messages: [userText(text)] };
    },
  },
];
