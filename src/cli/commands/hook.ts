import path from 'node:path';
import pc from 'picocolors';
import { DIALECTS, HOOK_EVENTS, parseHookInput, renderHookOutput, type Dialect, type HookEvent, type HookInput, type HookResult } from '../../agent/dialect.js';
import { SOURCE_FILE_RE } from '../../shared/source-files.js';
import { parseCommandArgs, type Command, type CommandContext } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer hook <session-start|pre-edit|post-edit|stop> [options]

  Guardrails for AI coding agents, run by the agent itself (Claude Code, Cursor,
  Codex): reads the hook's JSON on stdin and answers in the agent's format.
    session-start  A short project brief (branch, rules and layers, the most
                   depended-on files with their tests, the tools) for the agent
    pre-edit       Refuses an edit that adds a forbidden import, a layer break, a
                   circular dependency or an undeclared package — and names the
                   allowed alternative
    post-edit      Tells the agent what its edits left behind: call sites of a
                   changed signature, removed routes still called, complexity
                   jumps, new exports no test reaches (silent otherwise)
    stop           With --strict: the agent continues until a passing test run
                   covers its changes (code-visualizer test records one)
  Never blocks on its own failure: internal errors exit 0 with a note on stderr.
  Set up with "code-visualizer agents init"; turn off with CODE_VISUALIZER_HOOKS=off.

${pc.bold('Options')}
      --dialect <d>        auto (default), claude, cursor or codex
      --strict             stop: keep the agent working (otherwise only a note)
      --root <dir>         Project root (default: the agent's project folder)
  -h, --help               Show this help

${pc.bold('Examples')}
  $ echo '{"session_id":"s1","cwd":"."}' | npx code-visualizer hook session-start
  $ npx code-visualizer agents init --write    ${pc.dim('(installs the hooks)')}
`;

/** Hook reading must never hang: everything on stdin, or what arrived after `timeoutMs`. */
function readStdin(timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve('');
    let text = '';
    const onData = (chunk: Buffer | string): void => {
      text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    };
    const done = (): void => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', done);
      stdin.off('error', done);
      stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, timeoutMs);
    stdin.on('data', onData);
    stdin.once('end', done);
    stdin.once('error', done);
    stdin.resume();
  });
}

/** `CODE_VISUALIZER_HOOKS=off` (also 0, false, no) turns every hook into a no-op. */
export function hooksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CODE_VISUALIZER_HOOKS?.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

/**
 * Internal deadlines, inside the timeouts `agents init` installs (session start 30 s, edits 15 s, stop
 * 60 s): the hook answers "nothing checked" before the client gives up on it. The process then ends
 * (bin.ts exits after a hook), so unfinished work never holds the agent up.
 */
export const DEADLINE_MS: Record<HookEvent, number> = { 'session-start': 25_000, 'pre-edit': 12_000, 'post-edit': 12_000, stop: 50_000 };

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The project the agent works in: --root, else the agent's project folder (Claude Code's
 * CLAUDE_PROJECT_DIR, Cursor's workspace root), else the payload's folder, widened to its project.
 */
async function hookRoot(explicit: string | undefined, input: HookInput): Promise<string> {
  if (explicit) return path.resolve(explicit);
  const cwd = path.resolve(process.cwd(), input.cwd);
  const agentDir = input.dialect === 'claude' ? process.env.CLAUDE_PROJECT_DIR?.trim() : input.dialect === 'cursor' ? (input.roots?.[0] ?? process.env.CURSOR_PROJECT_DIR?.trim()) : undefined;
  const start = agentDir ? path.resolve(agentDir) : cwd;
  const { findProjectRoot } = await import('./query.js');
  return findProjectRoot(start)?.root ?? start;
}

export interface HookDeps {
  readStdin?: () => Promise<string>;
}

export function createHookCommand(deps: HookDeps = {}): Command {
  return {
    name: 'hook',
    summary: 'Agent guardrail hooks: session brief, pre-edit guard, post-edit radar, stop gate',
    async run({ argv, stdout, stderr }: CommandContext) {
      let parsed;
      try {
        parsed = parseCommandArgs('hook', argv, {
          dialect: { type: 'string' },
          strict: { type: 'boolean' },
          root: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        });
      } catch (error) {
        // Exit 1, not 2: for Claude Code a hook's exit code 2 blocks the tool call.
        stderr.write(`code-visualizer hook: ${(error as Error).message.split('\n')[0]}\n`);
        return 1;
      }
      const { values, positionals } = parsed;
      if (values.help) {
        stdout.write(HELP);
        return 0;
      }
      const event = positionals[0] as HookEvent | undefined;
      if (!event || !HOOK_EVENTS.includes(event) || positionals.length > 1) {
        stderr.write(`code-visualizer hook: expected one of ${HOOK_EVENTS.join(', ')}${event ? ` (got "${positionals.join(' ')}")` : ''}.\n`);
        return 1;
      }
      const dialectArg = (values.dialect ?? 'auto').trim().toLowerCase();
      if (dialectArg !== 'auto' && !(DIALECTS as readonly string[]).includes(dialectArg)) {
        stderr.write(`code-visualizer hook: --dialect must be auto, ${DIALECTS.join(', ')}.\n`);
        return 1;
      }
      if (hooksDisabled()) return 0;
      // From here on the hook fails open: whatever goes wrong, the agent carries on.
      try {
        const text = await (deps.readStdin ?? readStdin)();
        const input = parseHookInput(text, event, { dialect: dialectArg as Dialect | 'auto', env: process.env, cwd: process.cwd() });
        if ('error' in input) {
          stderr.write(`code-visualizer hook ${event}: ${input.error}; nothing checked.\n`);
          return 0;
        }
        // Edits of files the guard does not judge (docs, styles, configs) need no project at all.
        if ((event === 'pre-edit' || event === 'post-edit') && !(input.changes ?? []).some((c) => SOURCE_FILE_RE.test(c.file) || SOURCE_FILE_RE.test(c.movedFrom ?? ''))) return 0;
        const root = await hookRoot(values.root, input);
        const { runHook } = await import('../../agent/hooks.js');
        const result = await withDeadline(runHook({ root, input, strict: !!values.strict }), DEADLINE_MS[event]);
        const answer: HookResult = result === 'timeout' ? { note: `code-visualizer hook ${event}: took too long; nothing checked.` } : result;
        const out = renderHookOutput(input.dialect, event, answer);
        if (out.stdout) stdout.write(out.stdout);
        if (out.stderr) stderr.write(out.stderr);
        return out.exitCode;
      } catch (error) {
        stderr.write(`code-visualizer hook ${event}: ${(error as Error).message ?? String(error)}; nothing checked.\n`);
        return 0;
      }
    },
  };
}

export const hookCommand: Command = createHookCommand();
