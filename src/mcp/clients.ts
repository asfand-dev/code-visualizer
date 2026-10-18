/**
 * How each AI client registers the code-visualizer MCP server. `mcp --print-config <client>` prints
 * these snippets, starting the CLI the way `agents init` (agent-guardrails) writes it into a project.
 */

export const MCP_CLIENTS = ['claude', 'cursor', 'vscode', 'codex', 'gemini'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export interface McpRegistration {
  client: McpClient;
  /** Where the snippet goes (a project-relative config file), or undefined for a shell command. */
  file?: string;
  format: 'shell' | 'json' | 'toml';
  /** The process the client starts. */
  command: string;
  args: string[];
  /** Ready to paste: the shell command or the config file content. */
  snippet: string;
}

export interface RegistrationOptions {
  /** Extra arguments after `mcp` (e.g. `--tools impact,tests_for`). */
  extraArgs?: string[];
  /** Windows needs `cmd /c npx …` because npx is a .cmd script there. */
  platform?: NodeJS.Platform;
  /** The package to run (default `code-visualizer`). */
  pkg?: string;
  /**
   * The project root to serve, as given (a relative root stays relative). Claude Code, Codex and Gemini
   * start the server in the project, so it is relative to it; Cursor and VS Code get it under
   * `${workspaceFolder}`.
   */
  root?: string;
  /**
   * How the client starts the CLI, without `mcp` (default `npx -y <pkg>`): `agents init` and `mcp
   * --print-config` pass `cliCommand()` (src/agent/setup.ts) — the project's own install, or the published
   * package pinned to this major version.
   */
  launch?: { command: string; args: string[] };
}

/** POSIX shell quoting for the printed `claude mcp add` command. */
const sh = (arg: string): string => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

/** The command and arguments that start the server (through npx unless `launch` says otherwise; the same on every client). */
export function serverCommand(opts: RegistrationOptions = {}, root = opts.root): { command: string; args: string[] } {
  const serve = ['mcp', ...(root ? ['--root', root] : []), ...(opts.extraArgs ?? [])];
  if (opts.launch) return { command: opts.launch.command, args: [...opts.launch.args, ...serve] };
  const args = ['-y', opts.pkg ?? 'code-visualizer', ...serve];
  return opts.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...args] } : { command: 'npx', args };
}

/** `${workspaceFolder}`, or the given root inside it (an absolute root as it is). */
function workspaceRoot(root: string | undefined): string {
  if (!root || root === '.' || root === './') return '${workspaceFolder}';
  if (/^([A-Za-z]:)?[\\/]/.test(root)) return root;
  return `\${workspaceFolder}/${root.replace(/^\.\//, '').replace(/[\\/]+$/, '')}`;
}

export function mcpRegistration(client: McpClient, opts: RegistrationOptions = {}): McpRegistration {
  switch (client) {
    case 'claude': {
      // Claude Code starts project servers in the project and sets CLAUDE_PROJECT_DIR.
      const { command, args } = serverCommand(opts);
      return { client, format: 'shell', command, args, snippet: ['claude', 'mcp', 'add', '--scope', 'project', 'code-visualizer', '--', command, ...args].map(sh).join(' ') };
    }
    case 'cursor': {
      const { command, args } = serverCommand(opts, workspaceRoot(opts.root));
      return { client, file: '.cursor/mcp.json', format: 'json', command, args, snippet: json({ mcpServers: { 'code-visualizer': { command, args } } }) };
    }
    case 'vscode': {
      const { command, args } = serverCommand(opts, workspaceRoot(opts.root));
      return { client, file: '.vscode/mcp.json', format: 'json', command, args, snippet: json({ servers: { 'code-visualizer': { type: 'stdio', command, args } } }) };
    }
    case 'codex': {
      const { command, args } = serverCommand(opts);
      const toml = [
        '[mcp_servers.code-visualizer]',
        `command = ${JSON.stringify(command)}`,
        `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
        // The first run analyzes the whole project; later ones start warm.
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 120',
      ].join('\n');
      return { client, file: '.codex/config.toml', format: 'toml', command, args, snippet: toml };
    }
    case 'gemini': {
      const { command, args } = serverCommand(opts);
      return { client, file: '.gemini/settings.json', format: 'json', command, args, snippet: json({ mcpServers: { 'code-visualizer': { command, args, timeout: 120000 } } }) };
    }
  }
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);
