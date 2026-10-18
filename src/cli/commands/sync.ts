import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../../analyzer/config.js';
import { AnalyzeError } from '../../analyzer/errors.js';
import { updateState } from '../../analyzer/state.js';
import { analyzeSync, SyncError, syncState, type SyncOptions } from '../../analyzer/sync.js';
import type { SyncReport } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { safeData } from '../format.js';
import { banner, parseCommandArgs, persistFrom, Progress, resolveProjectRoot, type Command } from '../shared.js';
import { parseDuration } from './status.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer sync [root] [options]

  Before you rebase: what the base branch brings and what it does to your work.
  Commits you don't have (and who wrote them), files a rebase would conflict in (a
  real trial merge with git merge-tree, nothing is touched), and changes that merge
  cleanly but break your code — an export you call got another signature or was
  removed, a route you request is gone — with your call sites.
  Works from refs you already fetched; only --fetch uses the network.

${pc.bold('Options')}
  -b, --base <ref>         The branch to compare with (default: "base" of the configuration,
                           origin/HEAD, main or master; on that branch itself, its upstream)
      --branches           Also check other branches (yours and teammates') that touch your files
      --since <time>       With --branches: only branches with commits in this period (default: 14d;
                           e.g. 2w, 48h)
      --fetch              Run "git fetch --prune <remote>" first (the only network access)
      --json               Print the forecast as JSON
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -q, --quiet              No progress output
  -h, --help               Show this help

${pc.bold('Examples')}
  $ code-visualizer sync
  $ code-visualizer sync --fetch --branches
  $ code-visualizer sync --base origin/develop --json
`;

const ago = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

function list(items: string[], max = 4): string {
  return items.slice(0, max).join(', ') + (items.length > max ? `, … ${items.length - max} more` : '');
}

/**
 * The forecast in a few lines: incoming, conflicts, semantic breaks, overlaps, branches, next step. Author
 * names, branch names and paths come from the repository: shown with their control characters visible.
 */
export function syncText(forecast: SyncReport): string[] {
  const report = safeData(forecast);
  const out: string[] = [];
  const authors = report.authors?.length ? ` (${report.authors.slice(0, 4).map((a) => `${a.name} ${a.commits}`).join(', ')}${report.authors.length > 4 ? ', …' : ''})` : '';
  const fetched = report.fetchedAgo !== undefined ? pc.dim(` · fetched ${ago(report.fetchedAgo)}`) : '';
  const committed = report.conflicts.filter((c) => !c.local).map((c) => c.file);
  const uncommitted = report.conflicts.filter((c) => c.local === 'uncommitted').map((c) => c.file);
  const untracked = report.conflicts.filter((c) => c.local === 'untracked').map((c) => c.file);
  if (!report.behind) {
    out.push(`${pc.green('✔')} Up to date with ${pc.bold(report.base)}${report.ahead ? pc.dim(` (you are ${plural(report.ahead, 'commit')} ahead)`) : ''}${fetched}`);
  } else {
    out.push(`${pc.bold(report.base)} is ${plural(report.behind, 'commit')} ahead${authors}${fetched}`);
    if (report.method === 'files') out.push(`${pc.yellow('!')} ${pc.dim('git is older than 2.38: no trial merge, only files changed on both sides are compared')}`);
    else if (committed.length) out.push(`${pc.red('✖')} conflict if you rebase now: ${list(committed)}`);
    else if (report.ahead) out.push(`${pc.green('✔')} your commits merge cleanly ${pc.dim('(trial merge)')}`);
    else out.push(`${pc.green('✔')} no commits of yours to merge ${pc.dim('(a fast-forward)')}`);
  }
  if (uncommitted.length) out.push(`${pc.red('✖')} your uncommitted edits to ${list(uncommitted)} conflict with incoming changes ${pc.dim('(when they are re-applied after the rebase)')}`);
  if (untracked.length) out.push(`${pc.red('✖')} ${list(untracked)} ${untracked.length === 1 ? 'is' : 'are'} untracked here but added by incoming commits: move ${untracked.length === 1 ? 'it' : 'them'} aside before you rebase`);
  for (const s of report.semantic) {
    const by = s.commit ? ` in ${s.commit}${s.author ? ` (${s.author})` : ''}` : '';
    const verb = s.kind === 'route-removed' ? 'you request it' : s.kind === 'export-removed' ? 'you use it' : 'you call it';
    const sites = s.yourSites.map((x) => `${x.file}:${x.line}`);
    out.push(`${pc.yellow('!')} ${s.message}${by}; ${verb} at ${list(sites, 3)}`);
  }
  for (const o of report.overlap) {
    const what = o.local === 'uncommitted' ? `${o.file} (uncommitted)` : o.file;
    const clean = o.clean ? pc.dim(o.local === 'uncommitted' ? ' (your edits still apply cleanly)' : ' (merges cleanly)') : o.local === 'uncommitted' ? pc.dim(' (not checked: commit it to include it in the trial merge)') : '';
    out.push(`${pc.cyan('~')} ${what} also changes in ${plural(o.commits.length || 1, 'incoming commit')}${clean}`);
  }
  const baseConflicts = new Set(report.conflicts.map((c) => c.file));
  for (const b of report.branches ?? []) {
    if (b.result === 'conflict') {
      const files = b.conflictFiles.length ? b.conflictFiles : b.files;
      // The same lines may conflict with the base too: rebasing first does not make this one go away.
      const withBase = files.some((f) => baseConflicts.has(f)) ? pc.dim(` (also conflicts with ${report.base})`) : '';
      out.push(`${pc.red('✖')} ${b.ref} ${pc.dim(`(${b.author})`)} conflicts with your work in ${list(files, 3)}${withBase}`);
    } else out.push(`${pc.cyan('~')} ${b.ref} ${pc.dim(`(${b.author})`)} also edits ${list(b.files, 3)}${b.verified ?? report.method === 'merge-tree' ? pc.dim(' (merges cleanly)') : ''}`);
  }
  for (const note of report.notes ?? []) out.push(`${pc.yellow('!')} ${note}`);
  if (report.recommendation) out.push(`${pc.magenta('→')} ${pc.bold(report.recommendation)}${followUp(report)}`);
  return out;
}

/** `, then update 2 call sites` (imports of a removed or changed export count separately). */
function followUp(report: SyncReport): string {
  const sites = report.semantic.flatMap((s) => s.yourSites);
  if (!sites.length) return '';
  const imports = sites.filter((x) => x.kind === 'import').length;
  const calls = sites.length - imports;
  const what = [calls ? plural(calls, 'call site') : '', imports ? plural(imports, 'import') : ''].filter(Boolean).join(' and ');
  return pc.dim(`, then update ${what}`);
}

export const syncCommand: Command = {
  name: 'sync',
  summary: 'What is coming from main and teammates: conflicts before you rebase',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('sync', argv, {
        base: { type: 'string', short: 'b' },
        branches: { type: 'boolean' },
        since: { type: 'string' },
        fetch: { type: 'boolean' },
        json: { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    const usage = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 2;
    };
    if (positionals.length > 1) return usage(`Unexpected argument "${positionals[1]}".`);
    const since = values.since === undefined ? undefined : parseDuration(values.since.replace(/^(\d+)$/, '$1d'));
    if (values.since !== undefined && !since) return usage('--since must be a period such as 14d, 2w or 48h.');
    if (values.since !== undefined && !values.branches) return usage('--since applies to --branches.');
    if (values.base !== undefined && (!values.base.trim() || values.base.startsWith('-'))) return usage('--base needs a git ref, e.g. --base origin/main.');

    // Run from a sub-folder: the project around it, as every command finds it.
    const root = positionals[0] !== undefined ? path.resolve(positionals[0]) : resolveProjectRoot(process.cwd()).root;
    const persist = persistFrom(values['no-cache']);
    const progress = new Progress(stderr, !values.quiet && !values.json && !!stderr.isTTY && !process.env.CI);
    const options: SyncOptions = {
      base: values.base?.trim() ?? loadConfig(root).config.base,
      branches: !!values.branches,
      since,
      fetch: !!values.fetch,
      persist,
      onProgress: (message) => progress.update(message),
      // Only analyzed when the base brings changes you could depend on.
      data: () => getReport({ root, includeSource: false, history: false, changes: false, persist, toolVersion: VERSION }),
    };
    let report: SyncReport;
    try {
      report = await analyzeSync(root, options);
    } catch (error) {
      progress.stop();
      if (error instanceof SyncError || error instanceof AnalyzeError) {
        // An unknown --base: the branch it was probably meant to be, as check, diff and review say.
        let message = error.message;
        if (error instanceof SyncError && error.ref && values.base !== undefined) {
          const { refHint } = await import('./diff.js');
          message += await refHint(root, error.ref);
        }
        if (values.json) stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
        else stderr.write(`${pc.red('✖')} ${message}\n`);
        return 1;
      }
      throw error;
    }
    progress.stop();
    if (persist) {
      try {
        updateState(root, 'sync', syncState(report));
      } catch {
        /* read-only checkout: the forecast is still printed */
      }
    }
    if (values.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const write = (line = ''): void => void stdout.write(`${line}\n`);
    if (!values.quiet) banner(write);
    for (const line of syncText(report)) write(`  ${line}`);
    write();
    return 0;
  },
};
