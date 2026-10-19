import fs from 'node:fs';
import pc from 'picocolors';
import { VERSION } from '../version.js';
import { didYouMean, type Command } from './shared.js';

/** The sections of the top-level help, in order. */
export const COMMAND_GROUPS = ['Explore', 'Ask', 'Everyday', 'Review & CI', 'AI agents', 'Setup'] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/**
 * Commands are loaded on demand: `--version`, help and light commands never pay for the
 * analyzer and the TypeScript compiler. Each command adds exactly one descriptor here.
 */
export interface CommandDescriptor {
  name: string;
  aliases?: string[];
  /** The command's own summary (`Command.summary`). */
  summary: string;
  /** Its section in `code-visualizer --help`. */
  group: CommandGroup;
  /** The line in `code-visualizer --help` (under 64 characters); the summary when it is short enough. */
  brief?: string;
  /** Runnable, but not listed in the help. */
  hidden?: boolean;
  load: () => Promise<Command>;
}

export const COMMANDS: CommandDescriptor[] = [
  { name: 'report', group: 'Explore', summary: 'Generate an interactive report for the project (default)', brief: 'Interactive report of the project (default)', load: () => import('./commands/report.js').then((m) => m.reportCommand) },
  { name: 'serve', aliases: ['live', 'watch', 'dev'], group: 'Explore', summary: 'Live companion: a local report that updates while you code', brief: 'Live report that updates while you code', load: () => import('./commands/serve.js').then((m) => m.serveCommand) },
  { name: 'check', group: 'Review & CI', summary: 'Quality gates for CI: rules, cycles, complexity, health, risk', brief: 'Quality gates: rules, cycles, complexity, health, risk', load: () => import('./commands/check.js').then((m) => m.checkCommand) },
  { name: 'pr', group: 'Review & CI', summary: 'Write a pull-request description for your current changes', brief: 'Pull-request description of your changes', load: () => import('./commands/context.js').then((m) => m.prCommand) },
  { name: 'diff', group: 'Review & CI', summary: 'Architecture changes between two refs, your branch or staged work', brief: 'Architecture changes between two refs or staged work', load: () => import('./commands/diff.js').then((m) => m.diffCommand) },
  { name: 'review', group: 'Review & CI', summary: 'Review any branch or PR in dependency order: start here, effort, split, viewed', brief: 'Review a branch or PR in dependency order', load: () => import('./commands/review.js').then((m) => m.reviewCommand) },
  { name: 'context', group: 'Explore', summary: 'Markdown context about a file or the project (for AI assistants & docs)', brief: 'Markdown context of a file or the project (AI, docs)', load: () => import('./commands/context.js').then((m) => m.contextCommand) },
  { name: 'who', group: 'Ask', summary: 'Who knows this code: owners, experts, last touch, bus factor', brief: 'Who knows this code: owners, experts, bus factor', load: () => import('./commands/query.js').then((m) => m.whoCommand) },
  { name: 'uses', aliases: ['refs'], group: 'Ask', summary: 'Where a symbol or file is used: imports, exact call sites, HTTP callers', brief: 'Where a symbol or file is used: imports, call sites', load: () => import('./commands/query.js').then((m) => m.usesCommand) },
  { name: 'impact', group: 'Ask', summary: 'What a change affects: users by depth, routes, tests to run, owners', brief: 'What a change affects: users, routes, tests, owners', load: () => import('./commands/query.js').then((m) => m.impactCommand) },
  { name: 'path', group: 'Ask', summary: 'Why A depends on B: the shortest import chain, line by line', brief: 'Why A depends on B: the shortest import chain', load: () => import('./commands/query.js').then((m) => m.pathCommand) },
  { name: 'route', group: 'Ask', summary: 'Which handler serves a URL: route, middleware, callers, tests', brief: 'Which handler serves a URL: middleware, callers, tests', load: () => import('./commands/query.js').then((m) => m.routeCommand) },
  { name: 'tests-for', group: 'Ask', summary: 'Tests to run for files, folders or symbols (with the command)', brief: 'Tests to run for files, folders or symbols', load: () => import('./commands/query.js').then((m) => m.testsForCommand) },
  { name: 'mcp', group: 'AI agents', summary: 'MCP server for AI agents: impact, tests to run, owners, rules, routes', brief: 'MCP server: the project map for AI agents', load: () => import('./commands/mcp.js').then((m) => m.mcpCommand) },
  { name: 'cache', group: 'Setup', summary: 'Show or clear the warm analysis cache', load: () => import('./commands/cache.js').then((m) => m.cacheCommand) },
  { name: 'test', group: 'Everyday', summary: 'Run exactly the tests your changes affect (unit, co-change, e2e via routes)', brief: 'Run exactly the tests your changes affect', load: () => import('./commands/test.js').then((m) => m.testCommand) },
  { name: 'coverage', group: 'Everyday', summary: 'Patch coverage of your changes from the local coverage report', brief: 'Patch coverage of your changes (local coverage report)', load: () => import('./commands/coverage.js').then((m) => m.coverageCommand) },
  { name: 'status', group: 'Everyday', summary: 'One-line status for shell prompts, tmux and agent status lines', brief: 'One-line status for prompts, tmux and agent status lines', load: () => import('./commands/status.js').then((m) => m.statusCommand) },
  { name: 'hooks', group: 'Setup', summary: 'Install the quality gates as git hooks (husky, lefthook, simple-git-hooks, git)', brief: 'Install the quality gates as git hooks', load: () => import('./commands/hooks.js').then((m) => m.hooksCommand) },
  { name: 'sync', group: 'Everyday', summary: 'What is coming from main and teammates: conflicts before you rebase', brief: 'What main and teammates bring: conflicts before a rebase', load: () => import('./commands/sync.js').then((m) => m.syncCommand) },
  { name: 'similar', group: 'Ask', summary: 'Does this already exist? Functions similar to a snippet or lines of a file', brief: 'Does this already exist? Similar functions and copies', load: () => import('./commands/similar.js').then((m) => m.similarCommand) },
  { name: 'env', group: 'Everyday', summary: 'Environment variables: what the code reads, what is undocumented, what leaks', brief: 'Env vars: undocumented, unused, secrets in the browser', load: () => import('./commands/env.js').then((m) => m.envCommand) },
  { name: 'release', group: 'Review & CI', summary: 'What the next release contains: commits, API changes, the version that fits, notes', brief: 'Next release: commits, API changes, version, notes', load: () => import('./commands/release.js').then((m) => m.releaseCommand) },
  { name: 'actions', group: 'Review & CI', summary: 'GitHub Actions: when workflows run, how jobs connect, what is wrong with them', brief: 'GitHub Actions: triggers, job graph, findings', load: () => import('./commands/actions.js').then((m) => m.actionsCommand) },
  { name: 'agents', group: 'AI agents', summary: 'Set up AI agents: MCP server, guardrail hooks, skill and AGENTS.md (init, doctor, remove)', brief: 'Set up agents: MCP server, guardrail hooks, AGENTS.md', load: () => import('./commands/agents.js').then((m) => m.agentsCommand) },
  { name: 'hook', group: 'AI agents', summary: 'Agent guardrail hooks: session brief, pre-edit guard, post-edit radar, stop gate', brief: 'Guardrail hooks: edit guard, stop gate (run by agents)', load: () => import('./commands/hook.js').then((m) => m.hookCommand) },
];
const DEFAULT_COMMAND = 'report';

/** `  serve      Live report that updates while you code (live, watch, dev)` */
function commandLine(c: CommandDescriptor, width: number): string {
  const aliases = c.aliases?.length ? pc.dim(` (${c.aliases.join(', ')})`) : '';
  return `  ${c.name.padEnd(width)} ${c.brief ?? c.summary}${aliases}`;
}

export function mainHelp(): string {
  const shown = COMMANDS.filter((c) => !c.hidden);
  const width = Math.max(...shown.map((c) => c.name.length)) + 2;
  const groups = COMMAND_GROUPS.map((group) => {
    const members = shown.filter((c) => c.group === group);
    return members.length ? `${pc.bold(group)}\n${members.map((c) => commandLine(c, width)).join('\n')}\n` : '';
  }).filter(Boolean);
  const example = (command: string, what: string): string => `  ${pc.cyan(`$ npx code-visualizer${command ? ` ${command}` : ''}`.padEnd(38))} ${pc.dim(what)}`;
  return `
  ${pc.bold(pc.magenta('◆'))} ${pc.bold('code-visualizer')} ${pc.dim(`v${VERSION}`)}
  Your codebase companion: see, search and understand JS / TS projects.

${pc.bold('Usage')}
  $ code-visualizer [command] [options]
  $ cviz [command] [options]   ${pc.dim('(once installed: npm i -g code-visualizer)')}

${pc.bold('Get started')}
${example('', 'Open the interactive report')}
${example('serve', 'Live report next to your editor')}
${example('check --changed', 'Fail only on new problems (CI)')}
${example('impact <file>', 'What a change to a file affects')}
${example('agents init', 'Set up Claude Code, Cursor & co.')}

${groups.join('\n')}
${pc.bold('Global options')}
  -h, --help       Show help (code-visualizer --help <command>: its options)
  -v, --version    Show version

Run ${pc.cyan('code-visualizer <command> --help')} for the options of a command.
`;
}

/** Run from a git hook (`CODE_VISUALIZER_HOOK`, set by `hooks install`) with `CODE_VISUALIZER_SKIP=1`. */
function hookSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const skip = env.CODE_VISUALIZER_SKIP?.trim().toLowerCase();
  return !!env.CODE_VISUALIZER_HOOK && !!skip && skip !== '0' && skip !== 'false' && skip !== 'no';
}

function findCommand(name: string | undefined): CommandDescriptor | undefined {
  if (!name) return undefined;
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/** `✖ Unknown command "chek". Did you mean "check"?` and where to find the list (stderr; exit code 2). */
function unknownCommand(name: string, stderr: NodeJS.WriteStream): number {
  const hint = didYouMean(
    name,
    COMMANDS.filter((c) => !c.hidden).flatMap((c) => [c.name, ...(c.aliases ?? [])]),
  );
  stderr.write(`${pc.red('✖')} Unknown command "${name}".${hint ? ` Did you mean "${hint}"?` : ''}\n`);
  stderr.write(`${pc.dim('Run code-visualizer --help for the list of commands.')}\n`);
  return 2;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const ctx = { stdout: process.stdout, stderr: process.stderr, commands: COMMANDS.map((c) => c.name) };
  const [first, ...rest] = argv;
  if (first === '-v' || first === '--version' || first === 'version') {
    ctx.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // `help`, `--help`, `help check`, `--help check`, `-h check`.
  if (first === 'help' || first === '-h' || first === '--help') {
    const topic = rest[0];
    if (topic === undefined || (first !== 'help' && topic.startsWith('-'))) {
      ctx.stdout.write(mainHelp());
      return 0;
    }
    const command = findCommand(topic);
    if (command) return (await command.load()).run({ ...ctx, argv: ['--help'] });
    // `code-visualizer --help ./app`: the default command's help (its argument is a folder).
    if (first !== 'help' && fs.existsSync(topic)) return (await findCommand(DEFAULT_COMMAND)!.load()).run({ ...ctx, argv: ['--help'] });
    return unknownCommand(topic, ctx.stderr);
  }
  const command = findCommand(first);
  // --- daily-loop: `CODE_VISUALIZER_SKIP=1 git commit` skips the commands the git hooks run ---
  if (command && hookSkipped()) {
    ctx.stderr.write(`${pc.dim(`code-visualizer: ${process.env.CODE_VISUALIZER_HOOK} checks skipped (CODE_VISUALIZER_SKIP=1)`)}\n`);
    return 0;
  }
  if (command) return (await command.load()).run({ ...ctx, argv: rest });
  // Unknown first word: treat it as a path for the default command when it exists on disk.
  if (first && !first.startsWith('-') && !fs.existsSync(first)) return unknownCommand(first, ctx.stderr);
  return (await findCommand(DEFAULT_COMMAND)!.load()).run({ ...ctx, argv });
}
