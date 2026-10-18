import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { ensureStateDir } from '../../analyzer/health.js';
import { findRepo, gitTracks, indexMtime, readHead, type RepoLocation } from '../../analyzer/repo-state.js';
import { readAllState, stateDir, untrustedState, updateState } from '../../analyzer/state.js';
import { probeServer } from '../../server/client.js';
import { asStoredStatus, buildStatus, formatStatus, isSnapshot, STATUS_FORMATS, statusContextFromState, trustedLive, withState, type FormatStatusOptions, type StatusFormat, type StoredStatus } from '../../shared/status.js';
import type { StatusSnapshot } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { cacheDisabledByEnv } from '../engine.js';
import { parseCommandArgs, type Command, type CommandContext } from '../shared.js';

/*
 * Deliberately light: this runs on every prompt render. It never analyzes inline and never loads the
 * analyzer (or TypeScript) — it prints the stored snapshot and, when that is outdated, starts one
 * detached `status --refresh` in the background.
 */

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer status [root] [options]

  One line about your work for shell prompts, tmux and agent status lines:
    ◆ 82▼3 · 5Δ→23 · 3 tests · ✖1 new cycle · ↓7 main (1 conflict) · cov 72%
  health (and its change on your branch) · changed → affected files · tests to run ·
  new problems · commits on the base you don't have (and the conflicts a rebase would hit).

  Fast (it never analyzes inline): it asks a running "serve", else prints the stored
  snapshot and refreshes it in the background when HEAD, the index or its age say it is
  outdated (marked with ↻). A refresh that failed is marked with !. Prints nothing outside a
  repository, or in one where code-visualizer was never used. Exits 0 (2 only for a mistyped option).

${pc.bold('Options')}
      --format <f>         short (default), plain, json, tmux, starship or claude (two lines,
                           with a link to the live server's My changes page)
      --json               Same as --format json (always one JSON value; null when there is no status)
      --stdin-json         Read the agent's status payload on stdin (Claude Code: workspace.current_dir)
      --max-age <time>     Refresh snapshots older than this (default: 10m; e.g. 30s, 2h)
      --no-refresh         Never start a background refresh
      --refresh            Analyze now and store a fresh snapshot (what the background refresh runs)
      --setup <tool>       Print the setup for starship, tmux, zsh, bash or claude (changes no file)
  -h, --help               Show this help

${pc.bold('Examples')}
  $ code-visualizer status
  $ code-visualizer status --setup starship
  $ code-visualizer status --format claude --stdin-json     ${pc.dim('(Claude Code statusLine)')}
`;

const SETUP: Record<string, string> = {
  starship: `# ~/.config/starship.toml — a custom module (needs code-visualizer on your PATH: npm i -g code-visualizer)
[custom.code_visualizer]
command = "code-visualizer status --format starship"
require_repo = true
when = true
format = "[$output]($style) "
style = "purple"
`,
  tmux: `# ~/.tmux.conf — the status of the active pane's project (needs code-visualizer on your PATH)
# -ag appends to your status-right instead of replacing it.
set -g status-interval 5
set -g status-right-length 160
set -ag status-right ' #(cd "#{pane_current_path}" && code-visualizer status --format tmux)'
`,
  zsh: `# ~/.zshrc — the status on the right of your prompt (needs code-visualizer on your PATH)
_code_visualizer_status() { CODE_VISUALIZER_STATUS="$(code-visualizer status --format starship 2>/dev/null)"; }
autoload -Uz add-zsh-hook && add-zsh-hook precmd _code_visualizer_status
setopt PROMPT_SUBST
RPROMPT='\${CODE_VISUALIZER_STATUS}'
`,
  bash: `# ~/.bashrc — the status before your prompt (needs code-visualizer on your PATH)
_code_visualizer_status() { CODE_VISUALIZER_STATUS="$(code-visualizer status --format starship 2>/dev/null)"; }
PROMPT_COMMAND="_code_visualizer_status\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
PS1='\${CODE_VISUALIZER_STATUS:+[\$CODE_VISUALIZER_STATUS] }'"\$PS1"
`,
  claude: `// ~/.claude/settings.json (or .claude/settings.json of a project) — Claude Code status line
{
  "statusLine": {
    "type": "command",
    "command": "code-visualizer status --format claude --stdin-json",
    "padding": 0
  }
}
`,
};

/** A refresh older than this is taken to have crashed: the next status call may start another one. */
export const LOCK_STALE_MS = 30_000;
const DEFAULT_MAX_AGE = 10 * 60_000;

/** `10m`, `30s`, `2h`, `1d`, `2w`, `500ms`; a plain number is seconds. */
export function parseDuration(value: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(value);
  if (!m) return undefined;
  const unit = (m[2] ?? 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000;
  return Number(m[1]) * factor;
}

const CONFIG_FILES = ['code-visualizer.config.json', '.code-visualizerrc.json', '.code-visualizerrc'];

/**
 * The project the status is about: the nearest folder between `start` and the repository top that is a
 * project code-visualizer has used (`.code-visualizer/` next to a package.json or a configuration file —
 * a stray `.code-visualizer/` from running a command in some sub-folder does not count), else the top.
 */
export function statusRoot(start: string, repo: RepoLocation): string {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (dir === repo.top || path.dirname(dir) === dir || !dir.startsWith(repo.top)) return repo.top;
    if (fs.existsSync(path.join(dir, '.code-visualizer')) && ['package.json', ...CONFIG_FILES].some((f) => fs.existsSync(path.join(dir, f)))) return dir;
  }
}

/** Whether the project uses code-visualizer at all: status lines stay silent (and idle) everywhere else. */
export function usesCodeVisualizer(root: string): boolean {
  if (fs.existsSync(stateDir(root))) return true;
  if (CONFIG_FILES.some((f) => fs.existsSync(path.join(root, f)))) return true;
  try {
    return /"code-visualizer"\s*:/.test(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * When the base of your work last moved here: its loose ref file (else packed-refs, where it is packed) or
 * FETCH_HEAD — a fetch updates the base without moving HEAD or the index.
 */
export function baseMoved(repo: RepoLocation, base: string | undefined): number | undefined {
  const times = [mtimeOf(path.join(repo.gitDir, 'FETCH_HEAD')), mtimeOf(path.join(repo.commonDir, 'FETCH_HEAD'))];
  if (base && !base.startsWith('-') && !base.includes('..')) {
    const refs = base.startsWith('refs/') ? [base] : [`refs/remotes/${base}`, `refs/heads/${base}`];
    const loose = refs.map((ref) => mtimeOf(path.join(repo.commonDir, ref))).filter((t): t is number => t !== undefined);
    times.push(...(loose.length ? loose : [mtimeOf(path.join(repo.commonDir, 'packed-refs'))]));
  }
  const known = times.filter((t): t is number => t !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

/** Why a stored snapshot is outdated (undefined when it is current). */
export function staleReason(stored: StoredStatus, repo: RepoLocation, maxAgeMs: number, now = Date.now()): string | undefined {
  const head = readHead(repo);
  if (head !== undefined && stored.head !== head) return 'HEAD moved';
  const index = indexMtime(repo);
  if (index !== undefined && index > (stored.indexMtime ?? stored.generatedAt)) return 'the index changed';
  const moved = baseMoved(repo, isSnapshot(stored) ? stored.upstream?.name : undefined);
  if (moved !== undefined && moved > stored.generatedAt) return 'base ref changed';
  if (now - stored.generatedAt > maxAgeMs) return 'too old';
  return undefined;
}

// Moved next to the readers they protect (serve's status snapshot uses them too); re-exported for callers.
export { gitTracks, untrustedState };

export function lockPath(root: string): string {
  return path.join(stateDir(root), 'status.lock');
}

/** The lock's token (what its owner wrote), or undefined without a lock. */
function lockOwner(root: string): string | undefined {
  try {
    return fs.readFileSync(lockPath(root), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Take the refresh lock (O_EXCL): a token for exactly one of several status calls at the same moment,
 * undefined for the others. A lock not touched for LOCK_STALE_MS belongs to a refresh that died: it is
 * moved aside first (a rename only one caller can win) and checked again, so two callers never both take
 * it over.
 */
export function acquireRefreshLock(root: string, now = Date.now()): string | undefined {
  const file = lockPath(root);
  try {
    ensureStateDir(stateDir(root));
  } catch {
    return undefined;
  }
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, `${token}\n`);
      fs.closeSync(fd);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined;
      const aside = `${file}.${token}`;
      try {
        if (now - fs.statSync(file).mtimeMs <= LOCK_STALE_MS) return undefined;
        fs.renameSync(file, aside);
      } catch {
        return undefined;
      }
      try {
        // Someone else took it over in between: that lock is fresh — put it back and stand down.
        if (now - fs.statSync(aside).mtimeMs <= LOCK_STALE_MS) {
          try {
            fs.linkSync(aside, file);
          } catch {
            /* a third lock exists: it wins */
          }
          return undefined;
        }
      } catch {
        return undefined;
      } finally {
        fs.rmSync(aside, { force: true });
      }
    }
  }
  return undefined;
}

/** Whether a refresh holds the lock right now (it touches the lock while it runs). */
export function refreshRunning(root: string, now = Date.now()): boolean {
  try {
    return now - fs.statSync(lockPath(root)).mtimeMs <= LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function touchLock(root: string, token: string): void {
  try {
    if (lockOwner(root) !== token) return;
    const t = new Date();
    fs.utimesSync(lockPath(root), t, t);
  } catch {
    /* released meanwhile */
  }
}

/** Release the lock — only the one `token` took (a manual refresh never removes a background refresh's lock). */
export function releaseRefreshLock(root: string, token?: string): void {
  try {
    if (token !== undefined && lockOwner(root) !== token) return;
    fs.rmSync(lockPath(root), { force: true });
  } catch {
    /* best effort */
  }
}

/** The CLI script to run for a background refresh (the running one, or dist/cli.js next to this chunk). */
function cliScript(): string | undefined {
  const argv1 = process.argv[1];
  if (argv1 && /(^|[\\/])(cli\.[cm]?js|bin\.ts|code-visualizer|cviz)$/.test(argv1) && fs.existsSync(argv1)) return argv1;
  try {
    const sibling = fileURLToPath(new URL('./cli.js', import.meta.url));
    if (fs.existsSync(sibling)) return sibling;
  } catch {
    /* not a file URL */
  }
  return undefined;
}

/** The background refresh learns the lock it owns through this variable. */
const LOCK_ENV = 'CODE_VISUALIZER_STATUS_LOCK';

/** Start `status --refresh <root>` detached (it outlives this process); false when it could not start. */
export function spawnRefresh(root: string, token: string): boolean {
  const script = cliScript();
  if (!script) return false;
  try {
    // Loader flags (tsx in development) are kept, debugger flags are not.
    const execArgv = process.execArgv.filter((a) => !/^--inspect/.test(a));
    const child = spawn(process.execPath, [...execArgv, script, 'status', '--refresh', '--quiet', root], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // Prompt helpers must not take git's optional locks (status would race the user's own git commands).
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', [LOCK_ENV]: token },
    });
    child.on('error', () => releaseRefreshLock(root, token));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export interface StatusDeps {
  /** Starts the background refresh that owns the lock `token` (injected in tests). */
  spawnRefresh?: (root: string, token: string) => boolean;
  now?: () => number;
  readStdin?: () => Promise<string>;
}

/** All of stdin, or '' after `timeoutMs` (a status line must never hang on a terminal). */
function readAllStdin(timeoutMs = 300): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve('');
    let text = '';
    const done = (): void => {
      clearTimeout(timer);
      stdin.pause();
      resolve(text);
    };
    const timer = setTimeout(done, timeoutMs);
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => (text += chunk));
    stdin.once('end', done);
    stdin.once('error', done);
  });
}

/** The folder of an agent's status payload (Claude Code: `workspace.current_dir`, else `cwd`). */
export function payloadDir(text: string): string | undefined {
  try {
    const payload = JSON.parse(text) as { workspace?: { current_dir?: unknown; project_dir?: unknown }; cwd?: unknown };
    const dir = payload.workspace?.current_dir ?? payload.cwd ?? payload.workspace?.project_dir;
    return typeof dir === 'string' && dir ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** ANSI colours: always for claude (it renders them), for short only on a terminal; NO_COLOR / FORCE_COLOR win. */
function wantsColor(format: StatusFormat, stdout: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (format === 'claude') return true;
  if (format !== 'short') return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== '0' && force !== 'false';
  return !!stdout.isTTY;
}

/**
 * `status --refresh`: analyze (warm cache, compared with the base of your work), measure how far the base
 * is, and store the snapshot. The stamps (HEAD, index) are read before the analysis, so an edit made while
 * it runs still makes the result outdated.
 */
export async function refreshStatus(root: string, repo: RepoLocation, now: () => number = Date.now): Promise<StoredStatus> {
  const started = now();
  const head = readHead(repo);
  const index = indexMtime(repo);
  // The analysis must not refresh the index behind the user's back (that would also make it look staged).
  const optionalLocks = process.env.GIT_OPTIONAL_LOCKS;
  process.env.GIT_OPTIONAL_LOCKS = '0';
  try {
    const [{ analyze }, { upstreamStatus }, { workingTreeId }] = await Promise.all([import('../../analyzer/index.js'), import('../../analyzer/sync.js'), import('../../analyzer/git.js')]);
    // The tree analyzed (read first, like the stamps): a passing `test` of the same tree stays ✔ (test-intelligence).
    const treeId = await workingTreeId(root).catch(() => undefined);
    const data = await analyze({ root, persist: !cacheDisabledByEnv(), includeSource: false, compare: true, history: false, toolVersion: VERSION });
    const base = data.changes?.base ?? data.git?.upstream?.name;
    const upstream = base ? await upstreamStatus(root, base).catch(() => undefined) : undefined;
    const state = untrustedState(root, repo) ? {} : readAllState(root);
    const snapshot = buildStatus(data, { ...statusContextFromState(state), upstream, generatedAt: started, head, indexMtime: index, treeId });
    // Only what other commands do not keep current themselves (they are re-read on every status call).
    delete snapshot.lastCheck;
    delete snapshot.lastTest;
    delete snapshot.testsCovered;
    updateState(root, 'status', snapshot);
    return snapshot;
  } catch (error) {
    // Remember the failure with its stamps: the next prompt does not try again until something changes.
    const failed: StoredStatus = { version: 1, generatedAt: started, head, indexMtime: index, error: (error as Error).message };
    try {
      updateState<StoredStatus>(root, 'status', (prev) => (isSnapshot(asStoredStatus(prev)) ? { ...(prev as StatusSnapshot), generatedAt: started, head, indexMtime: index, error: failed.error } : failed));
    } catch {
      /* read-only checkout */
    }
    return failed;
  } finally {
    if (optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = optionalLocks;
  }
}

export function createStatusCommand(deps: StatusDeps = {}): Command {
  const now = deps.now ?? Date.now;
  return {
    name: 'status',
    summary: 'One-line status for shell prompts, tmux and agent status lines',
    async run(ctx: CommandContext) {
      const { argv, stdout, stderr } = ctx;
      let parsed;
      try {
        parsed = parseCommandArgs('status', argv, {
          format: { type: 'string' },
          json: { type: 'boolean' },
          'stdin-json': { type: 'boolean' },
          'max-age': { type: 'string' },
          'no-refresh': { type: 'boolean' },
          refresh: { type: 'boolean' },
          setup: { type: 'string' },
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
      if (values.setup !== undefined) {
        const snippet = SETUP[values.setup.trim().toLowerCase()];
        if (!snippet) {
          stderr.write(`${pc.red('✖')} --setup takes ${Object.keys(SETUP).join(', ')}.\n`);
          return 2;
        }
        stdout.write(snippet);
        return 0;
      }
      if (values.json && values.format !== undefined && values.format !== 'json') {
        stderr.write(`${pc.red('✖')} --json is --format json: use one of them.\n`);
        return 2;
      }
      const format = (values.json ? 'json' : (values.format ?? 'short')) as StatusFormat;
      if (!STATUS_FORMATS.includes(format)) {
        stderr.write(`${pc.red('✖')} --format must be ${STATUS_FORMATS.join(', ')}.\n`);
        return 2;
      }
      const maxAge = values['max-age'] === undefined ? DEFAULT_MAX_AGE : parseDuration(values['max-age']);
      if (maxAge === undefined) {
        stderr.write(`${pc.red('✖')} --max-age must be a duration such as 30s, 10m or 2h.\n`);
        return 2;
      }
      let printed = false;
      const write = (text: string): void => {
        printed = true;
        stdout.write(`${text}\n`);
      };
      // From here on a status line never fails the prompt: anything unexpected prints nothing (JSON: null).
      try {
        let start = positionals[0] ?? process.cwd();
        if (values['stdin-json']) start = payloadDir(await (deps.readStdin ?? readAllStdin)()) ?? start;
        const repo = findRepo(start);
        if (!repo) return 0;
        const root = statusRoot(start, repo);
        const color = wantsColor(format, stdout);
        const print = (s: StatusSnapshot, flags: Pick<FormatStatusOptions, 'stale' | 'updating' | 'error'> = {}): void => write(formatStatus(s, format, { color, ...flags }));

        if (values.refresh) {
          if (!values.quiet) stderr.write(pc.dim('Analyzing…\n'));
          // A background refresh owns the lock its starter took: keep it fresh while a long (cold) analysis
          // runs, so no second refresh starts, and release it at the end. A manual refresh leaves it alone.
          const token = process.env[LOCK_ENV];
          const owned = !!token && lockOwner(root) === token;
          const keepAlive = owned ? setInterval(() => touchLock(root, token), LOCK_STALE_MS / 3) : undefined;
          keepAlive?.unref();
          let stored: StoredStatus;
          try {
            stored = await refreshStatus(root, repo, now);
          } finally {
            if (keepAlive) clearInterval(keepAlive);
            if (owned) releaseRefreshLock(root, token);
          }
          if (values.quiet) return 0;
          if (isSnapshot(stored)) print(withState(stored, statusContextFromState(untrustedState(root, repo) ? {} : readAllState(root))), stored.error ? { error: stored.error } : {});
          else {
            stderr.write(`${pc.yellow('!')} ${stored.error}\n`);
            if (format === 'json') write(JSON.stringify({ state: 'error', error: stored.error }));
          }
          return 0;
        }
        if (!usesCodeVisualizer(root)) return 0;

        // A state file that came with the repository (or from another user) is not read, and not refreshed.
        const untrusted = untrustedState(root, repo);
        const state = untrusted ? {} : readAllState(root);
        const fromState = statusContextFromState(state);
        // A running server knows best (and is current by construction).
        const probe = await probeServer(root, { timeoutMs: 200 });
        if (probe.status === 'running') {
          try {
            const answer = await probe.connection.request('/api/status', { timeoutMs: 200 });
            const live = asStoredStatus(answer);
            if (isSnapshot(live)) {
              const page = trustedLive(answer);
              print(withState(page ? { ...live, live: page } : live, fromState));
              return 0;
            }
          } catch {
            /* an older, busy or scoped server: use the stored snapshot */
          }
        }
        if (untrusted) {
          if (format === 'json') write(JSON.stringify({ state: 'ignored', reason: untrusted }));
          else if (format === 'claude') write(`${color ? pc.magenta('◆') : '◆'} code-visualizer ${color ? pc.dim(`· ${untrusted}: ignored`) : `· ${untrusted}: ignored`}`);
          return 0;
        }

        const stored = asStoredStatus(state.status);
        const stale = !stored || staleReason(stored, repo, maxAge, now()) !== undefined;
        let started = false;
        if (stale && !values['no-refresh']) {
          const token = acquireRefreshLock(root, now());
          if (token) {
            started = (deps.spawnRefresh ?? spawnRefresh)(root, token);
            if (!started) releaseRefreshLock(root, token);
          }
        }
        // Updating: this call started a refresh, or another one is running.
        const updating = started || refreshRunning(root, now());
        // A failed refresh is shown as such (until something changes and the next one starts).
        const error = !updating && stored?.error ? shortError(stored.error) : undefined;
        if (isSnapshot(stored)) print(withState(stored, fromState), { stale, updating, error });
        else if (format === 'json') write(JSON.stringify(updating ? { state: 'analyzing' } : error ? { state: 'error', error } : { state: 'none' }));
        else if (format === 'claude') {
          const what = updating ? 'analyzing…' : error ? `! ${error}` : 'no status yet (code-visualizer status --refresh)';
          write(`${color ? pc.magenta('◆') : '◆'} code-visualizer ${color ? pc.dim(`· ${what}`) : `· ${what}`}`);
        }
      } catch {
        /* never break a prompt */
      } finally {
        // JSON readers always get one value.
        if (format === 'json' && !printed) stdout.write('null\n');
      }
      return 0;
    },
  };
}

/** The first line of an error, short enough for a status line. */
function shortError(message: string): string {
  const line = message.split('\n')[0].trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export const statusCommand: Command = createStatusCommand();
