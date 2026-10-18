import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { git } from '../../analyzer/git.js';
import {
  applyPlan,
  detectManagers,
  HOOK_MANAGERS,
  HOOK_NAMES,
  hookCommands,
  hooksState,
  isEmptyPlan,
  linkTarget,
  planInstall,
  planUninstall,
  shellWord,
  unifiedDiff,
  type HookManager,
  type HookName,
  type HookPlan,
  type HooksContext,
} from '../hooks-install.js';
import { safeText } from '../format.js';
import { banner, parseCommandArgs, type Command } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer hooks install|uninstall|status [root] [options]

  Run the quality gates on every commit and push — through the hook manager the
  repository already uses (husky, lefthook, simple-git-hooks) or plain git hooks
  (core.hooksPath is respected; an existing hook keeps running first).
    pre-commit   check --staged --quiet-pass   (new problems in what you commit, plus
                 focused tests, debugger statements and conflict markers you add)
    pre-push     check --changed --committed --quiet-pass  (what you push: uncommitted
                 edits are ignored; and the affected tests, when available)
  Only the lines between "# code-visualizer:start/end" markers are touched, so a
  second install changes nothing and uninstall restores your files exactly.
  Skip once: CODE_VISUALIZER_SKIP=1 git commit … (or git push …)

${pc.bold('Options')}
      --pre-commit         Only the pre-commit hook
      --pre-push           Only the pre-push hook   (default: both)
      --manager <m>        auto (default), husky, lefthook, simple-git-hooks or git
  -y, --yes, --write       Apply the changes (without it: print them as a diff, write nothing)
      --global-hooks       Also install into a global hooks folder (core.hooksPath set in your global
                           or system git configuration, or outside the repository): the hooks then run
                           in every repository that uses it
      --json               Machine-readable output
  -h, --help               Show this help

${pc.bold('Examples')}
  $ code-visualizer hooks install            ${pc.dim('(preview)')}
  $ code-visualizer hooks install --yes
  $ code-visualizer hooks status
  $ code-visualizer hooks uninstall --yes
`;

const ACTIONS = ['install', 'uninstall', 'status'] as const;
type Action = (typeof ACTIONS)[number];

/** The repository around `root`: its top, where git runs hooks from, and core.hooksPath. */
async function hooksContext(root: string, commands: string[]): Promise<HooksContext | undefined> {
  const top = (await git(root, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) return undefined;
  // git prints the real path (macOS: /private/var/… for /var/…): compare like with like.
  root = fs.realpathSync(root);
  const [hooks, hooksPath, gitDir, commonDir] = await Promise.all([
    git(top, ['rev-parse', '--git-path', 'hooks']),
    git(top, ['config', '--get', 'core.hooksPath']),
    git(top, ['rev-parse', '--absolute-git-dir']),
    git(top, ['rev-parse', '--git-common-dir']),
  ]);
  const hooksDir = path.resolve(top, hooks?.trim() || '.git/hooks');
  // From a linked worktree, hooks in the common git directory run in every worktree.
  const common = commonDir?.trim() ? path.resolve(top, commonDir.trim()) : undefined;
  const sharedHooks = !!common && !!gitDir?.trim() && path.resolve(gitDir.trim()) !== common && !path.relative(common, hooksDir).startsWith('..');
  // `code-visualizer test` (test-intelligence) is part of pre-push once it exists.
  const ctx: HooksContext = { root, top: path.resolve(top), hooksDir, hooksPath: hooksPath?.trim() || undefined, testCommand: commands.includes('test'), sharedHooks, ...(common ? { gitDir: common } : {}) };
  const global = ctx.hooksPath ? await globalHooks(ctx) : undefined;
  return global ? { ...ctx, globalHooks: global } : ctx;
}

/**
 * Whether the hooks folder is not this repository's own: core.hooksPath points outside the repository and
 * its git directory — set in the global or system git configuration (`git config --show-scope`; the file it
 * comes from on older git), or anywhere else. Hooks written there run in every repository that uses it.
 */
async function globalHooks(ctx: HooksContext): Promise<{ scope: string; origin?: string } | undefined> {
  const inside = (dir: string): boolean => {
    const r = path.relative(dir, ctx.hooksDir);
    return !r || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  // A folder of this repository (a relative core.hooksPath, even a global one: each repository's own) is fine.
  if (inside(ctx.top) || (ctx.gitDir && inside(ctx.gitDir))) return undefined;
  const [scoped, origin] = await Promise.all([git(ctx.top, ['config', '--show-scope', '--get', 'core.hooksPath']), git(ctx.top, ['config', '--show-origin', '--get', 'core.hooksPath'])]);
  const file = origin?.split('\t')[0]?.replace(/^file:/, '').trim();
  const scope = scoped?.split('\t')[0]?.trim();
  if (scope === 'global' || scope === 'system') return { scope, ...(file ? { origin: file } : {}) };
  if (!scope && file && ctx.gitDir) {
    // git < 2.26: the configuration file it comes from — the repository's own, or another one.
    const own = [path.join(ctx.gitDir, 'config'), path.join(ctx.gitDir, 'config.worktree')].map((f) => path.resolve(f));
    if (!own.includes(path.resolve(ctx.top, file))) return { scope: 'global', origin: file };
  }
  return { scope: 'outside' };
}

/** Why a global hooks folder is left alone, and how to write there anyway. */
function globalHooksMessage(ctx: HooksContext): string {
  const g = ctx.globalHooks!;
  const where = g.scope === 'outside' ? `core.hooksPath points outside this repository, to ${ctx.hooksDir} (a global hooks folder others may share)` : `core.hooksPath is set in your ${g.scope} git configuration${g.origin ? ` (${g.origin})` : ''}: ${ctx.hooksDir} is a global hooks folder`;
  return `${where} — hooks written there run in every repository that uses it. Nothing was written. Install there anyway with --global-hooks, or set up a hook manager of this repository (husky, lefthook, simple-git-hooks: --manager).`;
}

/** Where the hooks will find the CLI. */
function binaryNote(ctx: HooksContext, manager: HookManager): string {
  const rel = path.relative(ctx.top, ctx.root);
  for (const dir of [ctx.root, ctx.top]) {
    if (fs.existsSync(path.join(dir, 'node_modules', '.bin', 'code-visualizer'))) return `uses ${path.join(path.relative(ctx.top, dir) || '.', 'node_modules/.bin/code-visualizer')}`;
  }
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, process.platform === 'win32' ? 'code-visualizer.cmd' : 'code-visualizer')));
  if (onPath) return 'uses code-visualizer from your PATH';
  const install = `npm i -D code-visualizer${rel && !rel.startsWith('..') ? ` in ${rel}` : ''}`;
  // Shell hooks look for the CLI and skip without it; one-line commands go through npx, which fails.
  return manager === 'git' || manager === 'husky' ? `code-visualizer is not installed here: the hooks skip their checks until it is (${install})` : `code-visualizer is not installed here: install it (${install}) — the hook runs it through npx`;
}

/** A path for display: relative to the repository top, absolute outside it (hooks of a linked worktree). */
const rel = (ctx: HooksContext, file: string): string => {
  const r = path.relative(ctx.top, file);
  return r.startsWith('..') || path.isAbsolute(r) ? file : r.split(path.sep).join('/') || '.';
};

function managerLocation(ctx: HooksContext, manager: HookManager, plan?: HookPlan): string {
  if (manager === 'git') return `${rel(ctx, ctx.hooksDir)}/`;
  const files = [...new Set(plan?.edits.map((e) => e.file) ?? [])];
  // Several files (husky: one per hook): their folder.
  if (files.length > 1) return `${rel(ctx, path.dirname(files[0]))}/`;
  const file = files[0] ?? hooksState(ctx, manager).find((h) => h.where)?.where;
  return file ? (path.isAbsolute(file) ? rel(ctx, file) : file) : manager;
}

/** `git commit`, `git push` or both: what the skip hint names. */
function gitActions(hooks: readonly HookName[]): string {
  return hooks.map((h) => (h === 'pre-commit' ? 'git commit' : 'git push')).join(' / ');
}

export const hooksCommand: Command = {
  name: 'hooks',
  summary: 'Install the quality gates as git hooks (husky, lefthook, simple-git-hooks, git)',
  async run({ argv, stdout, stderr, commands = [] }) {
    let parsed;
    try {
      parsed = parseCommandArgs('hooks', argv, {
        'pre-commit': { type: 'boolean' },
        'pre-push': { type: 'boolean' },
        manager: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        write: { type: 'boolean' },
        'global-hooks': { type: 'boolean' },
        json: { type: 'boolean' },
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
      stderr.write(`${pc.red('✖')} ${message}\n${pc.dim('Run "code-visualizer hooks --help" for usage.')}\n`);
      return 2;
    };
    const action = (positionals[0] ?? 'status') as Action;
    if (!ACTIONS.includes(action)) return usage(`Unknown action "${positionals[0]}" — use install, uninstall or status.`);
    if (positionals.length > 2) return usage(`Unexpected argument "${positionals[2]}".`);
    const managerFlag = (values.manager ?? 'auto').trim().toLowerCase();
    if (managerFlag !== 'auto' && !HOOK_MANAGERS.includes(managerFlag as HookManager)) return usage(`--manager must be auto, ${HOOK_MANAGERS.join(', ')}.`);
    const hooks: HookName[] = values['pre-commit'] || values['pre-push'] ? HOOK_NAMES.filter((h) => values[h]) : [...HOOK_NAMES];

    const root = path.resolve(positionals[1] ?? process.cwd());
    if (!fs.existsSync(root)) return usage(`${root} does not exist.`);
    const located = await hooksContext(root, commands);
    if (!located) {
      stderr.write(`${pc.red('✖')} ${root} is not inside a git repository.\n`);
      return 1;
    }
    const ctx: HooksContext = { ...located, allowGlobalHooks: !!values['global-hooks'] };
    // --write is accepted as --yes (like `agents init --write`).
    const yes = !!(values.yes || values.write);
    const found = detectManagers(ctx);
    const manager = managerFlag === 'auto' ? found[0] : (managerFlag as HookManager);
    const log = (line = ''): void => {
      if (!values.json) stdout.write(`${line}\n`);
    };

    if (action === 'status') {
      const states = hooksState(ctx, manager);
      if (values.json) {
        stdout.write(`${JSON.stringify({ manager, managers: found.filter((m) => m !== 'git'), hooksDir: rel(ctx, ctx.hooksDir), ...(ctx.globalHooks ? { global: ctx.globalHooks } : {}), hooks: states, binary: binaryNote(ctx, manager) }, null, 2)}\n`);
        return 0;
      }
      banner(log);
      const others = found.filter((m) => m !== manager && m !== 'git');
      log(`  Hook manager ${pc.bold(manager)} ${pc.dim(`(${managerLocation(ctx, manager)})`)}${others.length ? pc.dim(` · also found: ${others.join(', ')}`) : ''}`);
      for (const s of states) {
        const runs = hookCommands(s.hook, ctx).map((a) => a.join(' ')).join(' && ');
        log(`  ${s.installed ? pc.green('✔') : pc.dim('·')} ${s.hook.padEnd(10)} ${s.installed ? `runs ${pc.cyan(runs)}${s.chained ? pc.dim(' (after your previous hook)') : ''}` : pc.dim('not installed')}`);
      }
      log(`  ${pc.dim(binaryNote(ctx, manager))}`);
      if (ctx.globalHooks) log(`  ${pc.yellow('!')} ${pc.dim(`git runs hooks from ${ctx.hooksDir} (core.hooksPath, ${ctx.globalHooks.scope === 'outside' ? 'outside this repository' : `${ctx.globalHooks.scope} configuration`})`)}`);
      if (!states.some((s) => s.installed)) log(`  ${pc.dim('Install with: code-visualizer hooks install --yes')}`);
      log();
      return 0;
    }

    // Plain git hooks in a global hooks folder would run in every repository: only on request.
    if (manager === 'git' && ctx.globalHooks && !ctx.allowGlobalHooks) {
      const message = globalHooksMessage(ctx);
      if (values.json) stdout.write(`${JSON.stringify({ action, manager, hooks, changed: [], applied: false, dryRun: !yes, error: message, global: ctx.globalHooks }, null, 2)}\n`);
      else stderr.write(`${pc.red('✖')} ${message}\n`);
      return 1;
    }
    const plan = action === 'install' ? planInstall(ctx, manager, hooks) : planUninstall(ctx, manager, hooks);
    if (manager !== 'git' && ctx.globalHooks && action === 'install') plan.notes.push(`core.hooksPath is ${ctx.globalHooks.scope === 'outside' ? `set to ${ctx.hooksDir}, outside this repository` : `set in your ${ctx.globalHooks.scope} git configuration`}: git runs the hooks from there, so ${manager} may not run them in this repository.`);
    const apply = yes && !isEmptyPlan(plan);
    if (apply) {
      try {
        applyPlan(plan);
      } catch (error) {
        stderr.write(`${pc.red('✖')} Could not write the hooks: ${(error as Error).message}\n`);
        return 1;
      }
    }
    if (values.json) {
      const edits = plan.edits.map((e) => ({ file: rel(ctx, e.file), change: e.before === null ? 'create' : e.after === null ? 'delete' : 'update', diff: unifiedDiff(rel(ctx, e.file), e.before, e.after) }));
      const moves = [...plan.renames, ...(plan.restores ?? [])].map((r) => ({ from: rel(ctx, r.from), to: rel(ctx, r.to) }));
      stdout.write(`${JSON.stringify({ action, manager, hooks, changed: plan.changed, applied: apply, dryRun: !yes, edits, renames: moves, notes: plan.notes }, null, 2)}\n`);
      return 0;
    }
    banner(log);
    const where = managerLocation(ctx, manager, plan);
    if (isEmptyPlan(plan)) {
      // Nothing to write: everything is in place — or the files need a manual edit (the notes say which).
      const states = hooksState(ctx, manager).filter((h) => hooks.includes(h.hook));
      const missing = action === 'install' ? states.filter((h) => !h.installed).map((h) => h.hook) : [];
      if (missing.length) log(`  ${pc.yellow('!')} Could not install ${missing.join(' and ')} in ${pc.bold(where)} ${pc.dim(`(${manager})`)} — nothing was written:`);
      else if (action === 'install') log(`  ${pc.green('✔')} Already installed in ${where} ${pc.dim(`(${manager})`)}.`);
      else log(`  ${pc.green('✔')} Nothing to remove: code-visualizer is not in ${where} ${pc.dim(`(${manager})`)}.`);
      for (const note of plan.notes) log(`  ${pc.yellow('!')} ${safeText(note)}`);
      log();
      return missing.length ? 1 : 0;
    }
    if (!apply) {
      log(`  ${action === 'install' ? 'Installing' : 'Removing'} ${plan.changed.join(' and ')} ${action === 'install' ? 'in' : 'from'} ${pc.bold(where)} ${pc.dim(`(${manager})`)} — preview, nothing is written yet:`);
      log();
      for (const r of plan.renames) log(`  ${pc.dim(`rename ${rel(ctx, r.from)} → ${rel(ctx, r.to)} (it keeps running first)`)}`);
      for (const e of plan.edits) {
        // Hook files come with the repository: their text is shown with control characters visible.
        const link = linkTarget(ctx, e.file);
        for (const line of safeText(unifiedDiff(link ? `${rel(ctx, e.file)} -> ${link}` : rel(ctx, e.file), e.before, e.after)).split('\n')) {
          log(`  ${line.startsWith('+') && !line.startsWith('+++') ? pc.green(line) : line.startsWith('-') && !line.startsWith('---') ? pc.red(line) : line.startsWith('@@') ? pc.cyan(line) : pc.dim(line)}`);
        }
        log();
      }
      for (const r of plan.restores ?? []) log(`  ${pc.dim(`rename ${rel(ctx, r.from)} → ${rel(ctx, r.to)} (your previous hook comes back)`)}`);
      for (const note of plan.notes) log(`  ${pc.yellow('!')} ${safeText(note)}`);
      log(`  Apply with: ${pc.cyan(`code-visualizer hooks ${action}${positionals[1] ? ` ${shellWord(positionals[1])}` : ''}${values['pre-commit'] && !values['pre-push'] ? ' --pre-commit' : ''}${values['pre-push'] && !values['pre-commit'] ? ' --pre-push' : ''}${values.manager ? ` --manager ${manager}` : ''}${values['global-hooks'] ? ' --global-hooks' : ''} --yes`)}`);
      log();
      return 0;
    }
    if (action === 'install') {
      log(`  ${pc.green('✔')} Installed ${plan.changed.join(' and ')} in ${pc.bold(where)} ${pc.dim(`(${manager})`)}`);
      for (const r of plan.renames) log(`  ${pc.dim(`Your previous ${path.basename(r.from)} hook now runs first (${rel(ctx, r.to)}).`)}`);
      log(`  ${pc.dim(binaryNote(ctx, manager))}`);
      log(`  ${pc.dim(`Skip once: CODE_VISUALIZER_SKIP=1 ${gitActions(plan.changed)} …  ·  remove: code-visualizer hooks uninstall --yes`)}`);
    } else {
      log(`  ${pc.green('✔')} Removed ${plan.changed.join(' and ')} from ${pc.bold(where)} ${pc.dim(`(${manager})`)}`);
      for (const r of plan.restores ?? []) log(`  ${pc.dim(`Restored your previous hook ${rel(ctx, r.to)}.`)}`);
    }
    for (const note of plan.notes) log(`  ${pc.yellow('!')} ${safeText(note)}`);
    log();
    return 0;
  },
};
