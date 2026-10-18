import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { MCP_CLIENTS, mcpRegistration, type McpClient } from '../../mcp/clients.js';
import { closest } from '../../shared/delta.js';
import { VERSION } from '../../version.js';
import { parseCommandArgs, persistFrom, splitList, type Command } from '../shared.js';
import { findProjectRoot } from './query.js';

const MCP_HELP = `
${pc.bold('Usage')}
  $ code-visualizer mcp [root] [options]

  An MCP server (stdio) that gives AI agents — Claude Code, Cursor, VS Code Copilot,
  Codex, Gemini — the project map: impact of a change with exact call sites, tests to
  run, symbols, owners, architecture rules, routes and your current changes. It keeps a
  warm analysis (or uses a running "serve") and re-analyzes only what changed.
  Tool answers are sent to the agent's model provider like any other tool output.

${pc.bold('Options')}
      --root <dir>         Project root (default: CLAUDE_PROJECT_DIR / CURSOR_PROJECT_DIR, else the
                           project around the current folder)
      --tools <list>       Offer only these tools (e.g. impact,tests_for,who)
      --no-watch           Do not watch files; every call still checks analyzed files for edits
  -b, --base <ref>         Base branch for review_changes (default: origin/HEAD, main or master)
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-git             Skip git history (no owners' experts, no changes)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
      --print-config <c>   Print how to register the server with claude, cursor, vscode,
                           codex or gemini, with the root and options given (writes nothing)
      --json               With --print-config: the registration as JSON
  -h, --help               Show this help

${pc.bold('Tools')}
  project_overview, impact, find_symbol, tests_for, review_changes, check_architecture,
  route, who, find_similar — plus resources cv://project/summary, cv://changes,
  cv://health, cv://file/{path} and the prompts review-changes and plan-change.

${pc.bold('Examples')}
  $ claude mcp add --scope project code-visualizer -- npx -y code-visualizer@0 mcp
  $ npx code-visualizer mcp --print-config cursor
  $ npx code-visualizer mcp --tools impact,tests_for,check_architecture
`;

/** The project to serve: the argument, the agent's project variable, else the project around the cwd. */
export function mcpRoot(arg: string | undefined, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): { root: string; note?: string } {
  // An editor that does not expand `${workspaceFolder}` passes it literally.
  const unexpanded = arg !== undefined && /\$\{[^}]*\}/.test(arg);
  if (arg && !unexpanded) return { root: path.resolve(cwd, arg) };
  const note = unexpanded ? `ignored the unexpanded root "${arg}"` : undefined;
  for (const name of ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR']) {
    const dir = env[name]?.trim();
    if (dir) return { root: path.resolve(cwd, dir), note };
  }
  return { root: findProjectRoot(cwd)?.root ?? path.resolve(cwd), note };
}

/**
 * `--print-config <client>`: the registration snippet (or JSON), and where it goes. `root` is the root given
 * on the command line, as given; `launch` how the client starts the CLI (default `npx -y code-visualizer`).
 */
export function printConfig(name: string, extraArgs: string[], json: boolean, platform: NodeJS.Platform = process.platform, root?: string, launch?: { command: string; args: string[] }): { text: string; note?: string } | { error: string } {
  const client = name.trim().toLowerCase();
  if (!(MCP_CLIENTS as readonly string[]).includes(client)) {
    const hint = closest(client, MCP_CLIENTS);
    return { error: `Unknown client "${name}"${hint ? ` — did you mean "${hint}"?` : ''} (use ${MCP_CLIENTS.join(', ')}).` };
  }
  const registration = mcpRegistration(client as McpClient, { extraArgs, platform, root, launch });
  if (json) return { text: JSON.stringify(registration, null, 2) };
  const note = registration.file ? `# Add this to ${registration.file} in your project (merge it with the servers already there):` : '# Run this in your project folder:';
  return { text: registration.snippet, note };
}

export const mcpCommand: Command = {
  name: 'mcp',
  summary: 'MCP server for AI agents: impact, tests to run, owners, rules, routes',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('mcp', argv, {
        root: { type: 'string' },
        tools: { type: 'string', multiple: true },
        'no-watch': { type: 'boolean' },
        base: { type: 'string', short: 'b' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'no-git': { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        'print-config': { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(MCP_HELP);
      return 0;
    }
    const usage = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n${pc.dim('Run "code-visualizer mcp --help" for usage.')}\n`);
      return 2;
    };
    if (positionals.length > 1) return usage(`mcp takes one project root (got ${positionals.length}: ${positionals.join(' ')}).`);
    if (positionals[0] && values.root) return usage('Pass the root either as an argument or with --root, not both.');
    const toolNames = splitList(values.tools);
    const exclude = splitList(values.exclude);
    if (values.json && values['print-config'] === undefined) return usage('--json only applies to --print-config (the server itself always speaks JSON-RPC).');

    // Lazy: the tool registry pulls in the query core, which --print-config does not need.
    const { selectTools } = await import('../../mcp/tools.js');
    const selected = selectTools(toolNames);
    if ('error' in selected) return usage(selected.error);

    if (values['print-config'] !== undefined) {
      const extraArgs = [
        ...(toolNames.length ? ['--tools', toolNames.join(',')] : []),
        ...exclude.flatMap((g) => ['-e', g]),
        ...(values.base ? ['--base', values.base] : []),
        ...(values['no-watch'] ? ['--no-watch'] : []),
        ...(values['no-git'] ? ['--no-git'] : []),
      ];
      // The same command `agents init` registers: the project's own install, else this major version.
      const { cliCommand } = await import('../../agent/setup.js');
      const launch = cliCommand(findProjectRoot(process.cwd())?.root ?? process.cwd(), process.platform);
      const printed = printConfig(values['print-config'], extraArgs, !!values.json, process.platform, positionals[0] ?? values.root, { command: launch.command, args: launch.args });
      if ('error' in printed) return usage(printed.error);
      if (printed.note) stderr.write(pc.dim(`${printed.note}\n`));
      stdout.write(`${printed.text}\n`);
      return 0;
    }

    const { root, note } = mcpRoot(positionals[0] ?? values.root);
    if (note) stderr.write(`${pc.yellow('!')} ${note}; serving ${root}\n`);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      stderr.write(`${pc.red('✖')} ${root} is not a folder.\n`);
      return 2;
    }
    const { startMcpServer, mcpAnalysisOptions } = await import('../../mcp/server.js');
    const warm = persistFrom(values['no-cache']);
    const server = startMcpServer({
      root,
      tools: selected.tools,
      watch: !values['no-watch'],
      // --no-cache: analyze here, from scratch (no disk cache, no running serve).
      useServer: warm,
      analysis: mcpAnalysisOptions({ exclude, base: values.base, git: !values['no-git'], persist: warm, toolVersion: VERSION }),
    });
    stderr.write(`code-visualizer ${VERSION} MCP server for ${root} (${selected.tools.length} tools, stdio)\n`);
    if (process.stdin.isTTY) stderr.write(pc.dim('Waiting for an MCP client on stdin (Ctrl+C to stop). To register it: code-visualizer mcp --print-config claude|cursor|vscode|codex|gemini\n'));
    const stop = (): void => {
      void server.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await server.closed;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    return 0;
  },
};
