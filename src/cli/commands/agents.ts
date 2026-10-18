import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { HOOK_EVENTS } from '../../agent/dialect.js';
import {
  AGENT_CLIENTS,
  applyWrites,
  cliCommand,
  detectAgentsWithReasons,
  HOOK_MODES,
  hookCommandLine,
  installedHooks,
  majorVersion,
  mcpConfigFile,
  nextAgentsState,
  parseLaunch,
  planInit,
  planRemove,
  registeredHooks,
  registeredMcp,
  removeScope,
  type AgentClient,
  type AgentsState,
  type HooksMode,
  type Launch,
  type PlannedWrite,
} from '../../agent/setup.js';
import { shellSegments } from '../../agent/stop-gate.js';
import { readState, updateState } from '../../analyzer/state.js';
import { closest } from '../../shared/delta.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { banner, formatMs, parseCommandArgs, persistFrom, splitList, type Command, type CommandContext } from '../shared.js';
import { safeText } from '../format.js';
import { unifiedDiff } from '../text-diff.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer agents init [root] [options]
  $ code-visualizer agents doctor [root] [--run-registered]
  $ code-visualizer agents remove [root] [options]

  Sets up AI coding agents in this project: registers the code-visualizer MCP
  server and the guardrail hooks (session brief, pre-edit architecture guard,
  post-edit radar, and with --hooks strict a stop-time test gate) in each
  client's project configuration:
    claude   .mcp.json, .claude/settings.json      cursor  .cursor/mcp.json, .cursor/hooks.json
    vscode   .vscode/mcp.json                      codex   .codex/config.toml
    gemini   .gemini/settings.json
  Hooks are set up for Claude Code and Cursor; the others get the MCP server.
  Shows the changes as a diff first; --write applies them. Only entries named
  code-visualizer are added or removed — everything else in those files stays.
  The project is the folder given, else the project around the current folder.
  doctor checks the setup: starts the registered MCP and hook commands that run
  code-visualizer (MCP handshake, one hook round-trip), the configuration and the
  analysis speed. Other commands registered under the code-visualizer name come with
  the repository and are not run unless you pass --run-registered.

${pc.bold('Options')}
      --agents <list>      claude, cursor, vscode, codex, gemini, or all (default for init:
                           the agents this project or machine uses: .claude/, .cursor/…,
                           claude/cursor/codex/gemini on PATH, Claude Code's environment or
                           ~/.claude — init says what it detected; for remove: all)
      --hooks <mode>       guard (default): session brief, pre-edit guard, post-edit radar;
                           strict: also keep the agent working until tests cover its changes;
                           none: only the MCP server (removes hooks an earlier init installed)
      --skill              init: also copy the code-visualizer skill to .claude/skills/;
                           remove: also remove it (implied when every agent is removed)
      --agents-md          init: also write the managed project map block in AGENTS.md (and
                           @AGENTS.md in CLAUDE.md for Claude Code); remove: also remove them
      --write, --yes       Apply the changes (without it: print them as a diff, write nothing)
      --run-registered     doctor: also run registered commands that are not code-visualizer
                           itself (custom MCP or hook commands from the project's files)
      --json               Machine-readable output
  -h, --help               Show this help

${pc.bold('Examples')}
  $ npx code-visualizer agents init                       ${pc.dim('(preview)')}
  $ npx code-visualizer agents init --write --agents-md
  $ npx code-visualizer agents init --agents cursor,codex --hooks strict --write
  $ npx code-visualizer agents doctor
  $ npx code-visualizer agents remove --agents cursor --write
`;

const ACTIONS = ['init', 'doctor', 'remove'] as const;
type Action = (typeof ACTIONS)[number];

/** Clients whose hooks `agents init` installs. */
const HOOKED: AgentClient[] = ['claude', 'cursor'];

/** The agents named on the command line ('all' for every one), or an error message. */
function agentList(values: string[] | undefined): AgentClient[] | string | undefined {
  const names = splitList(values).map((n) => n.toLowerCase());
  if (!names.length) return undefined;
  if (names.includes('all')) return [...AGENT_CLIENTS];
  const aliases: Record<string, AgentClient> = { 'claude-code': 'claude', code: 'vscode', 'vs-code': 'vscode', copilot: 'vscode' };
  const out: AgentClient[] = [];
  for (const raw of names) {
    const name = aliases[raw] ?? raw;
    if (!(AGENT_CLIENTS as readonly string[]).includes(name)) {
      const hint = closest(raw, AGENT_CLIENTS);
      return `Unknown agent "${raw}"${hint ? ` — did you mean "${hint}"?` : ''} (use ${AGENT_CLIENTS.join(', ')}).`;
    }
    if (!out.includes(name as AgentClient)) out.push(name as AgentClient);
  }
  return out;
}

const action = (w: PlannedWrite): 'create' | 'update' | 'delete' | 'skipped' => (w.skipped ? 'skipped' : w.remove ? 'delete' : w.before === undefined ? 'create' : 'update');

function colorDiff(diff: string, color: boolean): string {
  if (!color) return diff;
  return diff
    .split('\n')
    .map((l) => (l.startsWith('+++') || l.startsWith('---') ? pc.bold(l) : l.startsWith('@@') ? pc.cyan(l) : l.startsWith('+') ? pc.green(l) : l.startsWith('-') ? pc.red(l) : l))
    .join('\n');
}

function printWrites(writes: PlannedWrite[], stdout: NodeJS.WriteStream): void {
  const color = !!stdout.isTTY && !process.env.NO_COLOR;
  for (const w of writes) {
    // A copied file (the skill) is the package's own text: name it instead of printing it.
    // A symlink: the header names the file that really changes.
    const name = w.link ? `${w.path} -> ${w.link}` : w.path;
    if (w.kind === 'copy' && !w.remove) stdout.write(`${color ? pc.bold(`+++ b/${name}`) : `+++ b/${name}`}\n${pc.dim(`(${w.before === undefined ? 'new' : 'updated'} copy of the code-visualizer skill, ${w.after.split('\n').length - 1} lines)`)}\n`);
    // The files come with the repository: their text is shown with control characters visible.
    else stdout.write(`${colorDiff(safeText(unifiedDiff(name, w.before ?? null, w.remove ? null : w.after)), color)}\n`);
    for (const note of w.notes ?? []) stdout.write(`${pc.yellow('!')} ${safeText(note)}\n`);
    stdout.write('\n');
  }
}

/** The managed AGENTS.md block from an analysis (commands, rules, fragile files, owners, tools). */
async function agentsBlock(root: string, noCache: boolean | undefined): Promise<string> {
  const data = await getReport({ root, includeSource: false, git: false, changes: false, history: false, persist: persistFrom(noCache), toolVersion: VERSION });
  const [{ agentsBlockMarkdown }, { projectCommands, TOOLS }] = await Promise.all([import('../../shared/markdown.js'), import('../../mcp/tools.js')]);
  return agentsBlockMarkdown(data, { commands: projectCommands(data), mcpTools: TOOLS.map((t) => t.name) });
}

/** The project a command without an explicit root works on: the one around the current folder (as the hooks do). */
async function defaultRoot(cwd: string): Promise<string> {
  const { findProjectRoot } = await import('./query.js');
  return findProjectRoot(cwd)?.root ?? cwd;
}

/* -------------------------------------------------------------------------- */
/*                                   Doctor                                   */
/* -------------------------------------------------------------------------- */

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  ms?: number;
}

const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;

/** This installation's CLI (dist/cli.js), when running from the build; undefined from source (tests). */
function ownCli(): string | undefined {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
  return fs.existsSync(cli) ? cli : undefined;
}

/**
 * A process to start: a program with arguments, or this CLI in this process (from source, without a
 * build). `standsIn`: this installation runs in place of the registered registry copy.
 */
type Runnable = ({ command: string; args: string[] } | { inProcess: true; args: string[] }) & { shown: string; standsIn?: string };

/** A registered command doctor does not start: why (a check of its own, `warn`, or `fail` when it cannot start at all). */
interface NotRun {
  notRun: string;
  status: 'warn' | 'fail';
  shown: string;
}

type Target = Runnable | NotRun;

const NOT_RUN = 'custom command, not run (pass --run-registered to execute it)';

const realpath = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/** Whether git tracks a file below `root` (a fresh clone could bring a made-up "installed" package with it). */
function trackedByGit(root: string, file: string): boolean {
  const realRoot = realpath(root) ?? root;
  const rel = path.relative(realRoot, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', rel.split(path.sep).join('/')], { cwd: realRoot, stdio: 'ignore', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).status === 0;
}

/** The folder of the package `file` belongs to, when that package is code-visualizer (its package.json says so). */
function codeVisualizerPackage(file: string): string | undefined {
  for (let dir = path.dirname(file), i = 0; i < 6; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      return pkg.name === 'code-visualizer' ? dir : undefined;
    } catch {
      /* no package.json here: one folder up */
    }
    if (path.dirname(dir) === dir) break;
  }
  return undefined;
}

/**
 * A script file that is code-visualizer's CLI: this installation's dist/cli.js, or a file of an installed
 * code-visualizer package (by its realpath) that the repository did not bring along.
 */
function trustedCliFile(root: string, file: string): string | undefined {
  const real = realpath(file);
  if (!real || !fs.statSync(real).isFile()) return undefined;
  const own = ownCli();
  if (own && realpath(own) === real) return real;
  return codeVisualizerPackage(real) && !trackedByGit(root, real) ? real : undefined;
}

/** The CLI script of the project's installed code-visualizer (node_modules/code-visualizer, by its package.json). */
function localCli(root: string): string | undefined {
  const dir = path.join(root, 'node_modules', 'code-visualizer');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; bin?: unknown };
    if (pkg.name !== 'code-visualizer') return undefined;
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && typeof pkg.bin === 'object' ? (pkg.bin as Record<string, unknown>)['code-visualizer'] : undefined;
    return typeof bin === 'string' ? trustedCliFile(root, path.join(dir, bin)) : undefined;
  } catch {
    return undefined;
  }
}

/** Where a program name resolves: a path (relative to the project), else the PATH. Undefined when it is nowhere. */
function findProgram(root: string, program: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (/[\\/]/.test(program)) {
    const abs = path.resolve(root, program);
    return fs.existsSync(abs) ? abs : undefined;
  }
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${program}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** `node <file> …` (or the file itself) where the file is code-visualizer's CLI: this tool, run as registered. */
function ownCommand(root: string, command: string, args: string[], shown: string): Runnable | undefined {
  const isNode = command === process.execPath || /^node(\.exe)?$/i.test(path.basename(command));
  if (isNode && args[0] && !args[0].startsWith('-')) {
    const cli = trustedCliFile(root, path.resolve(root, args[0]));
    if (cli) return { command: process.execPath, args: [cli, ...args.slice(1)], shown };
  }
  if (/(^|[\\/])(code-visualizer|cviz)(\.cmd|\.exe)?$/i.test(command)) {
    const found = findProgram(root, command);
    const cli = found ? trustedCliFile(root, found) : undefined;
    if (cli) return /\.[cm]?js$/.test(cli) ? { command: process.execPath, args: [cli, ...args], shown } : { command: cli, args, shown };
  }
  return undefined;
}

/**
 * What doctor runs for a registered command. Only code-visualizer itself: for `npx -y code-visualizer@N`,
 * this installation (the registry copy is downloaded on first use, and doctor stays offline); for `npx
 * --no-install code-visualizer`, the project's installed package (what npx would find), when it really is
 * code-visualizer; `node …/cli.js` of this or an installed code-visualizer. Anything else comes from the
 * repository's files and is not started unless `runRegistered` says so.
 */
function targetFor(root: string, command: string, args: string[], launch: Launch, runRegistered = false): Target | string {
  const shown = [command, ...args].join(' ');
  const expand = (list: string[]): string[] => list.map((a) => a.replaceAll('${workspaceFolder}', root));
  if (launch.via === 'command') {
    const own = ownCommand(root, command, expand(args), shown);
    if (own) return own;
    if (!findProgram(root, command)) return { notRun: `could not be started (${command}: command not found)`, status: 'fail', shown };
    return runRegistered ? { command, args: expand(args), shown } : { notRun: NOT_RUN, status: 'warn', shown };
  }
  const cliArgs = expand(launch.cliArgs);
  if (launch.via === 'local') {
    const bin = path.join(root, 'node_modules', '.bin', 'code-visualizer');
    if (!fs.existsSync(bin) && !fs.existsSync(`${bin}.cmd`)) return MISSING_LOCAL;
    const cli = localCli(root);
    // npx runs the .bin entry: a link there must lead to that same package's CLI (shims are the package manager's own).
    const linked = fs.lstatSync(bin, { throwIfNoEntry: false })?.isSymbolicLink() ? realpath(bin) : cli;
    if (cli && linked === cli) return { command: process.execPath, args: [cli, ...cliArgs], shown };
    if (!runRegistered) return { notRun: `node_modules/.bin/code-visualizer is not an installed code-visualizer package: ${NOT_RUN}`, status: 'warn', shown };
    const real = realpath(bin) ?? bin;
    return /\.[cm]?js$/.test(real) ? { command: process.execPath, args: [real, ...cliArgs], shown } : { command: bin, args: cliArgs, shown };
  }
  const cli = ownCli();
  const standsIn = `checked with this installation, ${VERSION}: npx fetches code-visualizer${launch.pin ? `@${launch.pin}` : ''} from npm on first use`;
  return cli ? { command: process.execPath, args: [cli, ...cliArgs], shown, standsIn } : { inProcess: true, args: cliArgs, shown, standsIn };
}

const MISSING_LOCAL = 'registered as "npx --no-install code-visualizer", but node_modules/.bin/code-visualizer is missing (npm i -D code-visualizer, or re-run "code-visualizer agents init --write")';

const INIT_REQUEST = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'code-visualizer-doctor', version: VERSION } } };

/** Environment for a command run on the project's behalf: the agent's project is this one, hooks are on. */
function childEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
  delete env.CODE_VISUALIZER_HOOKS;
  delete env.CURSOR_PROJECT_DIR;
  return env;
}

/** initialize + tools/list against an MCP server command. */
async function mcpHandshake(root: string, target: Runnable, timeoutMs = 20_000): Promise<{ tools: string[]; ms: number }> {
  const started = Date.now();
  const messages = [INIT_REQUEST, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }];
  const input = new PassThrough();
  const output = new PassThrough();
  let stop: () => void;
  let stderr = '';
  if ('inProcess' in target) {
    const { startMcpServer } = await import('../../mcp/server.js');
    const server = startMcpServer({ root, input, output, watch: false, log: () => undefined, warmDelayMs: 60_000 });
    stop = () => {
      input.end();
      void server.close();
    };
  } else {
    const child = spawn(target.command, target.args, { cwd: root, env: childEnv(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    input.pipe(child.stdin);
    child.stdin.on('error', () => undefined);
    child.stdout.pipe(output);
    child.stderr.on('data', (chunk: Buffer) => (stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000)));
    child.once('error', (error) => output.destroy(error));
    child.once('close', (code) => output.destroy(new Error(`it exited${code !== null ? ` with code ${code}` : ''} before answering${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`)));
    stop = () => {
      input.end();
      setTimeout(() => child.kill(), 2000).unref();
    };
  }
  try {
    const answer = await new Promise<{ tools: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
      let buffer = '';
      let initialized = false;
      output.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let msg: { id?: number; result?: { tools?: { name: string }[] }; error?: { message: string } };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch {
            clearTimeout(timer);
            return reject(new Error(`it printed something other than MCP messages: ${line.slice(0, 120)}`));
          }
          if (msg.error) {
            clearTimeout(timer);
            return reject(new Error(msg.error.message));
          }
          if (msg.id === 1) initialized = true;
          if (msg.id === 2 && initialized) {
            clearTimeout(timer);
            resolve({ tools: (msg.result?.tools ?? []).map((t) => t.name) });
          }
        }
      });
      output.once('error', (error) => {
        clearTimeout(timer);
        reject(error.message.startsWith('spawn') || (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`it could not be started (${error.message})`) : error);
      });
      for (const m of messages) input.write(`${JSON.stringify(m)}\n`);
    });
    return { ...answer, ms: Date.now() - started };
  } finally {
    stop();
  }
}

/** Run a hook command with `payload` on stdin: exit code, output and how long the whole round-trip took. */
async function runHookTarget(root: string, target: Runnable, payload: string, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string; ms: number; error?: string }> {
  const started = Date.now();
  if ('inProcess' in target) {
    const { createHookCommand } = await import('./hook.js');
    let stdout = '';
    let stderr = '';
    const sink = (append: (s: string) => void) =>
      new Writable({
        write(chunk: Buffer | string, _encoding, callback) {
          append(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          callback();
        },
      }) as unknown as NodeJS.WriteStream;
    const saved = { project: process.env.CLAUDE_PROJECT_DIR, hooks: process.env.CODE_VISUALIZER_HOOKS };
    process.env.CLAUDE_PROJECT_DIR = root;
    delete process.env.CODE_VISUALIZER_HOOKS;
    try {
      const code = await createHookCommand({ readStdin: async () => payload }).run({ argv: target.args.slice(1), stdout: sink((s) => (stdout += s)), stderr: sink((s) => (stderr += s)) });
      return { code, stdout, stderr, ms: Date.now() - started };
    } finally {
      if (saved.project === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = saved.project;
      if (saved.hooks !== undefined) process.env.CODE_VISUALIZER_HOOKS = saved.hooks;
    }
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(target.command, target.args, { cwd: root, env: childEnv(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr, ms: Date.now() - started, error: `no answer within ${timeoutMs / 1000} s` });
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, ms: Date.now() - started, error: `it could not be started (${error.message})` });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(payload);
  });
}

/** What is wrong with the arguments of a registered hook command (`hook pre-edt`), if anything. */
function hookArgsProblem(cliArgs: string[]): string | undefined {
  if (cliArgs[0] !== 'hook') return `it does not run "code-visualizer hook" (${cliArgs.join(' ') || 'no arguments'})`;
  if (!(HOOK_EVENTS as readonly string[]).includes(cliArgs[1] ?? '')) return `"${cliArgs[1] ?? ''}" is not a hook event (${HOOK_EVENTS.join(', ')})`;
  for (let i = 2; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a === '--strict') continue;
    if (a === '--dialect' || a === '--root') {
      i++;
      continue;
    }
    if (/^--(dialect|root)=/.test(a)) continue;
    return `unknown option ${a}`;
  }
  return undefined;
}

/** A registry pin of another major version than this installation. */
const pinNote = (launch: Launch): string => (launch.via === 'registry' && launch.pin && launch.pin !== majorVersion() && launch.pin !== 'latest' ? ` (pins code-visualizer@${launch.pin}; this is ${VERSION})` : '');

async function doctor(root: string, noCache: boolean | undefined, runRegistered = false): Promise<Check[]> {
  const checks: Check[] = [];
  const cli = cliCommand(root);
  checks.push(
    cli.local
      ? { name: 'CLI', status: 'ok', detail: `node_modules/.bin/code-visualizer (clients run "npx --no-install code-visualizer")` }
      : { name: 'CLI', status: 'warn', detail: `not installed in the project: clients run "npx -y code-visualizer@${majorVersion()}" (downloads on first use; npm i -D code-visualizer makes hooks start faster and work offline)` },
  );
  if (process.env.CODE_VISUALIZER_HOOKS && /^(off|0|false|no)$/i.test(process.env.CODE_VISUALIZER_HOOKS.trim())) checks.push({ name: 'hooks env', status: 'warn', detail: 'CODE_VISUALIZER_HOOKS is off in this shell: hooks started from it do nothing' });

  // The configuration: an invalid one turns every architecture rule off.
  try {
    const { loadConfig } = await import('../../analyzer/config.js');
    const loaded = loadConfig(root);
    if (loaded.error) checks.push({ name: 'configuration', status: 'fail', detail: `${loaded.file ? path.basename(loaded.file) : 'configuration'} is invalid: ${loaded.error} — architecture rules and layers are not enforced` });
    else if (loaded.file) checks.push({ name: 'configuration', status: 'ok', detail: `${path.basename(loaded.file)}: ${plural(loaded.config.rules?.length ?? 0, 'rule')}, ${plural(loaded.config.layers?.length ?? 0, 'layer')}` });
  } catch (error) {
    checks.push({ name: 'configuration', status: 'fail', detail: (error as Error).message });
  }

  // Registrations, and what each registered command runs.
  const mcpTargets = new Map<string, { target: Target; clients: AgentClient[] }>();
  const hookCommands: { client: AgentClient; event: string; line: string; launch: Launch }[] = [];
  for (const agent of AGENT_CLIENTS) {
    const file = mcpConfigFile(root, agent);
    const hooks = agent === 'claude' || agent === 'cursor' ? installedHooks(root, agent) : [];
    if (!file && !hooks.length) continue;
    const problems: string[] = [];
    const notes: string[] = [];
    const mcp = registeredMcp(root, agent);
    if (mcp) {
      const launch = parseLaunch(mcp.command, mcp.args);
      const target = targetFor(root, mcp.command, mcp.args, launch, runRegistered);
      if (typeof target === 'string') problems.push(target === MISSING_LOCAL ? target : `MCP server: ${target}`);
      else {
        const key = 'notRun' in target ? `not run ${target.shown}` : 'inProcess' in target ? `in-process ${target.args.join(' ')}` : `${target.command} ${target.args.join(' ')}`;
        const entry = mcpTargets.get(key) ?? { target, clients: [] };
        entry.clients.push(agent);
        mcpTargets.set(key, entry);
      }
      notes.push(pinNote(launch));
    }
    if (agent === 'claude' || agent === 'cursor') {
      for (const { event, command } of registeredHooks(root, agent)) {
        const words = shellSegments(command)[0]?.words ?? [];
        const launch = parseLaunch(words[0] ?? '', words.slice(1));
        const wrong = hookArgsProblem(launch.cliArgs);
        if (wrong) problems.push(`${event} hook "${command}": ${wrong}`);
        else {
          const target = targetFor(root, words[0], words.slice(1), launch, runRegistered);
          if (typeof target === 'string') problems.push(target === MISSING_LOCAL ? target : `${event} hook: ${target}`);
          else if ('notRun' in target && target.status === 'fail') problems.push(`${event} hook "${command}": ${target.notRun}`);
          else {
            if ('notRun' in target) notes.push(`; ${event} hook "${command}" is a ${NOT_RUN}`);
            hookCommands.push({ client: agent, event, line: command, launch });
          }
        }
      }
    }
    const detail = `${file ? `MCP server in ${file}` : 'no MCP server registered'}${hooks.length ? `; hooks: ${hooks.join(', ')}` : HOOKED.includes(agent) ? '; no guardrail hooks' : ''}${notes.join('')}`;
    checks.push({ name: agent, status: problems.length ? 'fail' : file ? 'ok' : 'warn', detail: problems.length ? `${detail} — ${[...new Set(problems)].join('; ')}` : detail });
  }
  if (!checks.some((c) => (AGENT_CLIENTS as readonly string[]).includes(c.name))) checks.push({ name: 'agents', status: 'warn', detail: 'no agent is set up in this project (code-visualizer agents init --write)' });

  // The MCP handshake through every registered command (or this installation when none is registered).
  if (!mcpTargets.size) {
    const cliPath = ownCli();
    mcpTargets.set('own', { target: cliPath ? { command: process.execPath, args: [cliPath, 'mcp', '--root', root, '--no-watch'], shown: 'code-visualizer mcp' } : { inProcess: true, args: ['mcp'], shown: 'code-visualizer mcp' }, clients: [] });
  }
  for (const { target, clients } of mcpTargets.values()) {
    const name = clients.length ? `MCP (${clients.join(', ')})` : 'MCP';
    if ('notRun' in target) {
      checks.push({ name, status: target.status, detail: `"${target.shown}": ${target.notRun}` });
      continue;
    }
    try {
      const { tools, ms } = await mcpHandshake(root, target);
      checks.push({ name, status: tools.length ? 'ok' : 'fail', detail: `"${target.shown}": initialize + tools/list, ${plural(tools.length, 'tool')}${target.standsIn ? ` (${target.standsIn})` : ''}`, ms });
    } catch (error) {
      checks.push({ name, status: 'fail', detail: `"${target.shown}": ${(error as Error).message}` });
    }
  }

  // The analysis: an empty or broken project must not end the report.
  const { analyze } = await import('../../analyzer/index.js');
  const lean = { root, includeSource: false, git: false, changes: false, history: false, coverage: false as const, toolVersion: VERSION };
  let hub: string | undefined;
  try {
    let started = Date.now();
    const data = await analyze({ ...lean, persist: false });
    checks.push({ name: 'cold analysis', status: 'ok', detail: `${plural(data.stats.files, 'file')} from scratch`, ms: Date.now() - started });
    started = Date.now();
    const warm = await getReport({ ...lean, persist: persistFrom(noCache) });
    checks.push({ name: 'warm analysis', status: 'ok', detail: warm.stats.cache?.source === 'server' ? 'from the running serve' : `warm cache (${warm.stats.cache?.parsed ?? 0} re-parsed)`, ms: Date.now() - started });
    hub = [...data.files].filter((f) => f.kind !== 'test' && /\.[cm]?[jt]sx?$/.test(f.id)).sort((a, b) => b.metrics.fanIn - a.metrics.fanIn)[0]?.id;
  } catch (error) {
    checks.push({ name: 'analysis', status: 'fail', detail: (error as Error).message });
  }

  // One hook round-trip through a registered hook command: an import added to the most depended-on file, as Claude Code sends it.
  if (hub) {
    const registered = hookCommands.find((h) => h.client === 'claude' && h.launch.cliArgs[1] === 'pre-edit') ?? hookCommands[0];
    const words = registered ? (shellSegments(registered.line)[0]?.words ?? []) : [];
    // Through the registered launcher, always as Claude Code's pre-edit (Cursor has none): the hook a real edit waits for.
    const launch: Launch = registered ? { ...registered.launch, cliArgs: ['hook', 'pre-edit', '--dialect', 'claude'] } : { via: 'registry', cliArgs: ['hook', 'pre-edit', '--dialect', 'claude'] };
    // A custom launcher (`sh -c '…' code-visualizer hook …`) gets the pre-edit arguments in place of its own.
    const args = registered && launch.via === 'command' ? [...words.slice(1, words.lastIndexOf('hook')), ...launch.cliArgs] : words.slice(1);
    const target = targetFor(root, words[0] ?? 'npx', args, launch, runRegistered);
    const name = `pre-edit hook${registered ? ` (${registered.client})` : ''}`;
    if (typeof target !== 'string' && 'notRun' in target) checks.push({ name, status: target.status, detail: `"${registered?.line ?? target.shown}": ${target.notRun}` });
    else if (typeof target !== 'string') {
      const abs = path.join(root, hub);
      const text = fs.readFileSync(abs, 'utf8');
      const payload = JSON.stringify({ session_id: 'code-visualizer-doctor', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: abs, content: `${text}\nimport './__code_visualizer_doctor__';\n` } });
      const run = await runHookTarget(root, target, payload);
      fs.rmSync(path.join(root, '.code-visualizer', 'sessions', 'code-visualizer-doctor.json'), { force: true });
      const shown = registered ? `"${registered.line.replace(/hook \S+.*$/, 'hook pre-edit')}"` : 'code-visualizer hook pre-edit';
      const lastErr = run.stderr.trim().split('\n').pop() ?? '';
      let answer = true;
      try {
        if (run.stdout.trim()) JSON.parse(run.stdout);
      } catch {
        answer = false;
      }
      if (run.error || run.code !== 0 || !answer) checks.push({ name, status: 'fail', detail: `${shown}: ${run.error ?? (run.code !== 0 ? `exit code ${run.code}${lastErr ? ` — ${lastErr}` : ''}` : `printed something other than a hook answer: ${run.stdout.slice(0, 120)}`)}`, ms: run.ms });
      else if (/nothing checked|took too long/.test(run.stderr)) checks.push({ name, status: 'warn', detail: `${shown}: ${lastErr}`, ms: run.ms });
      else checks.push({ name, status: run.ms > 10_000 ? 'warn' : 'ok', detail: `${shown}: an import added to ${hub} judged in a full round-trip${run.ms > 10_000 ? ' — close to the 15 s hook timeout: keep "code-visualizer serve" running' : ''}`, ms: run.ms });
    }
  }
  return checks;
}

/* -------------------------------------------------------------------------- */
/*                                   Command                                  */
/* -------------------------------------------------------------------------- */

export const agentsCommand: Command = {
  name: 'agents',
  summary: 'Set up AI agents: MCP server, guardrail hooks, skill and AGENTS.md (init, doctor, remove)',
  async run({ argv, stdout, stderr }: CommandContext) {
    let parsed;
    try {
      parsed = parseCommandArgs('agents', argv, {
        agents: { type: 'string', multiple: true },
        hooks: { type: 'string' },
        skill: { type: 'boolean' },
        'agents-md': { type: 'boolean' },
        write: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'run-registered': { type: 'boolean' },
        json: { type: 'boolean' },
        'no-cache': { type: 'boolean' },
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
      stderr.write(`${pc.red('✖')} ${message}\n${pc.dim('Run "code-visualizer agents --help" for usage.')}\n`);
      return 2;
    };
    const verb = positionals[0] as Action | undefined;
    if (!verb || !ACTIONS.includes(verb)) {
      if (!verb) {
        stderr.write(HELP);
        return 2;
      }
      const hint = closest(verb, ACTIONS);
      return usage(`Unknown action "${verb}"${hint ? ` — did you mean "${hint}"?` : ''} (use ${ACTIONS.join(', ')}).`);
    }
    if (positionals.length > 2) return usage(`agents ${verb} takes one project root (got ${positionals.slice(1).join(' ')}).`);
    const root = positionals[1] ? path.resolve(positionals[1]) : await defaultRoot(process.cwd());
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      stderr.write(`${pc.red('✖')} ${root} is not a folder.\n`);
      return 1;
    }
    const agents = agentList(values.agents);
    if (typeof agents === 'string') return usage(agents);
    const mode = (values.hooks ?? 'guard').trim().toLowerCase();
    if (!(HOOK_MODES as readonly string[]).includes(mode)) return usage(`--hooks must be ${HOOK_MODES.join(', ')}.`);
    if (verb !== 'init' && values.hooks !== undefined) return usage('--hooks belongs to "agents init".');
    if (verb === 'doctor' && (values.skill || values['agents-md'] || values.agents)) return usage('--agents, --skill and --agents-md belong to "agents init" and "agents remove".');
    if (verb !== 'doctor' && values['run-registered']) return usage('--run-registered belongs to "agents doctor".');
    if (verb === 'doctor' && (values.write || values.yes)) return usage('agents doctor changes nothing: --write belongs to "agents init" and "agents remove".');
    // --yes is accepted as --write (like `hooks install --yes`).
    const writeFlag = !!(values.write || values.yes);
    const write = (line = ''): void => void stdout.write(`${line}\n`);

    if (verb === 'doctor') {
      const checks = await doctor(root, values['no-cache'], !!values['run-registered']);
      if (values.json) write(JSON.stringify({ root, version: VERSION, checks }, null, 2));
      else {
        banner(write);
        write(`  ${pc.dim(`Project: ${root}`)}`);
        const width = Math.max(...checks.map((c) => c.name.length));
        for (const c of checks) {
          const mark = c.status === 'ok' ? pc.green('✔') : c.status === 'warn' ? pc.yellow('!') : pc.red('✖');
          // Details quote registered commands and their output: repository text, shown safely.
          write(`  ${mark} ${pc.bold(c.name.padEnd(width))}  ${safeText(c.detail)}${c.ms !== undefined ? pc.dim(` · ${formatMs(c.ms)}`) : ''}`);
        }
        write();
      }
      return checks.some((c) => c.status === 'fail') ? 1 : 0;
    }

    let writes: PlannedWrite[];
    let targets: AgentClient[] = [];
    const notes: string[] = [];
    const state = readState<AgentsState>(root, 'agents');
    if (verb === 'init') {
      const detected = agents ? [] : detectAgentsWithReasons(root);
      targets = agents ?? detected.map((d) => d.agent);
      if (!targets.length) {
        targets = ['claude'];
        notes.push('No agent detected in this project or on PATH: setting up Claude Code (pick others with --agents).');
      } else if (!agents) {
        const others = AGENT_CLIENTS.filter((a) => !targets.includes(a));
        notes.push(`Detected: ${detected.map((d) => `${d.agent} (${d.reasons.join(', ')})`).join(', ')}${others.length ? ` — set up others with --agents ${[...targets, ...others.slice(0, 1)].join(',')}…` : ''}`);
      }
      let block: string | undefined;
      if (values['agents-md']) {
        try {
          block = await agentsBlock(root, values['no-cache']);
        } catch (error) {
          stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
          return 1;
        }
      }
      writes = planInit(root, { agents: targets, hooks: mode as HooksMode, skill: values.skill, agentsBlock: block });
      const hooked = targets.filter((t) => HOOKED.includes(t));
      const mcpOnly = targets.filter((t) => !HOOKED.includes(t));
      if (mode !== 'none' && mcpOnly.length) notes.push(`${mcpOnly.join(', ')}: MCP server only — agents init sets up guardrail hooks for Claude Code and Cursor.${mcpOnly.includes('codex') ? ` Codex can run them by hand: "${hookCommandLine(root, '<session-start|pre-edit|post-edit|stop>', ['--dialect', 'codex'])}".` : ''}`);
      if (!cliCommand(root).local) notes.push(`The project has no local install, so clients run "npx -y code-visualizer@${majorVersion()}" (downloaded on first use).${mode !== 'none' && hooked.length ? ' npm i -D code-visualizer makes hooks start faster and work offline.' : ''}`);
      if (targets.includes('claude') && writes.some((w) => w.path === '.mcp.json' && !w.skipped)) notes.push('Claude Code asks once before it starts a server from .mcp.json.');
    } else {
      const scope = removeScope({ agents, skill: values.skill, agentsMd: values['agents-md'] });
      targets = scope.clients;
      writes = planRemove(root, { agents, skill: values.skill, agentsMd: values['agents-md'], state });
    }
    const skipped = writes.filter((w) => w.skipped);
    const changes = writes.filter((w) => !w.skipped);

    const apply = writeFlag && changes.length > 0;
    if (apply) {
      // Backups first (they read the files as they are before this run).
      let nextState: AgentsState;
      if (verb === 'init') {
        nextState = nextAgentsState(root, changes, state);
        applyWrites(root, changes);
      } else {
        applyWrites(root, changes, state?.dirs);
        const dirs = (state?.dirs ?? []).filter((d) => fs.existsSync(path.join(root, d)));
        nextState = { files: Object.fromEntries(Object.entries(state?.files ?? {}).filter(([file]) => !changes.some((w) => w.path === file))), ...(dirs.length ? { dirs } : {}) };
      }
      try {
        updateState<AgentsState>(root, 'agents', Object.keys(nextState.files).length || nextState.dirs?.length ? nextState : undefined);
      } catch {
        /* without a backup, remove takes our entries out instead of restoring exact bytes */
      }
    }
    // A file that cannot be changed safely is a failure of what --write was asked to do.
    const exitCode = writeFlag && skipped.length ? 1 : 0;
    if (values.json) {
      write(JSON.stringify({ root, action: verb, agents: targets, hooks: verb === 'init' ? mode : undefined, written: !!apply, changes: writes.map((w) => ({ path: w.path, kind: w.kind, owner: w.owner, action: action(w), ...(w.link ? { link: w.link } : {}), ...(w.notes ? { notes: w.notes } : {}) })), notes }, null, 2));
      return exitCode;
    }
    for (const note of notes) stderr.write(`${pc.dim('ℹ')} ${note}\n`);
    if (root !== process.cwd()) write(pc.dim(`Project: ${root}`));
    if (!writes.length) {
      write(verb === 'init' ? `${pc.green('✔')} Already set up for ${targets.join(', ')}: nothing to change.` : `${pc.green('✔')} Nothing of code-visualizer's to remove.`);
      return 0;
    }
    printWrites(changes, stdout);
    for (const w of skipped) for (const note of w.notes ?? []) write(`${pc.red('✖')} ${safeText(note)}`);
    if (changes.length) {
      const summary = changes.map((w) => `${w.path} (${action(w)})`).join(', ');
      if (apply) write(`${pc.green('✔')} ${verb === 'init' ? 'Set up' : 'Removed'}: ${summary}`);
      else write(`${pc.dim('Preview only — nothing was written.')} Apply with: code-visualizer agents ${verb}${positionals[1] ? ` ${positionals[1]}` : ''} ${argv.filter((a) => a !== verb && a !== positionals[1]).join(' ')} --write`.replace(/ {2,}/g, ' '));
    }
    if (skipped.length) write(`${pc.yellow('!')} Not changed (fix by hand, then run again): ${skipped.map((w) => w.path).join(', ')}`);
    return exitCode;
  },
};
