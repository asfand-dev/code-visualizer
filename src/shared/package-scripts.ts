/**
 * Which package.json scripts a shell command runs: `npm run build`, `pnpm -r test`, `yarn lint`,
 * `cd web && npm test`. Used to compare what CI runs with what the project defines. Pure.
 */

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Options of the package managers that take a value, so the value is not mistaken for a script name. */
const OPTIONS_WITH_VALUE = new Set(['-w', '--workspace', '--filter', '-F', '-C', '--prefix', '--cwd', '--dir']);

/** npm runs these scripts without `run`. */
const NPM_DIRECT_SCRIPTS: Record<string, string> = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };

/** Commands of pnpm and yarn that are not package scripts (`pnpm install` is not a script named install). */
const BUILT_IN_COMMANDS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'ci', 'init', 'publish', 'pack', 'link', 'unlink', 'exec', 'dlx',
  'create', 'x', 'audit', 'outdated', 'why', 'ls', 'list', 'config', 'cache', 'store', 'rebuild', 'prune', 'dedupe', 'import', 'set', 'get',
  'version', 'view', 'info', 'login', 'logout', 'whoami', 'pm', 'patch', 'patch-commit', 'fetch', 'deploy', 'env', 'completion', 'doctor',
  'workspaces', 'workspace', 'global', 'bin', 'help', 'node', 'explain', 'constraints', 'plugin', 'policies', 'releases', 'unplug', 'licenses',
  'root', 'server', 'setup',
]);

/** A prefix before the package manager that does not change what runs (`CI=1 npm test`, `sudo npm run x`). */
const HARMLESS_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|time|exec)$/;

function scriptOf(manager: string, args: string[]): string | undefined {
  const words: string[] = [];
  for (let i = 0; i < args.length && words.length < 2; i++) {
    if (!args[i].startsWith('-')) words.push(args[i]);
    else if (OPTIONS_WITH_VALUE.has(args[i])) i++;
  }
  const [command, target] = words;
  if (!command) return undefined;
  if (command === 'run' || command === 'run-script') return target;
  if (manager === 'bun') return undefined; // `bun test` is bun's own test runner
  if (manager === 'npm') return NPM_DIRECT_SCRIPTS[command];
  return BUILT_IN_COMMANDS.has(command) ? undefined : command;
}

/** Names of the scripts the command runs, in order. Names that come from variables or expressions are left out. */
export function scriptsInvoked(command: string): string[] {
  const names: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const at = words.findIndex((word) => PACKAGE_MANAGERS.has(word));
    if (at < 0 || !words.slice(0, at).every((word) => HARMLESS_PREFIX.test(word))) continue;
    const name = scriptOf(words[at], words.slice(at + 1));
    if (name && !/[$`{(]/.test(name)) names.push(name);
  }
  return names;
}

/** The scripts a script starts, directly or through other scripts (`check` → `lint` → `eslint`). Includes `start`. */
export function scriptClosure(start: string[], scripts: Record<string, string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...start];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const command = scripts[name];
    if (command) queue.push(...scriptsInvoked(command));
  }
  return seen;
}
