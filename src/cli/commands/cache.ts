import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { cacheDir, clearDiskCache, diskCacheStatus, snapshotDir } from '../../analyzer/disk-cache.js';
import { readAllState } from '../../analyzer/state.js';
import { cacheDisabledByEnv, probeServer } from '../engine.js';
import { banner, formatBytes, parseCommandArgs, resolveProjectRoot, type Command } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer cache [status|clear] [root] [options]

  Repeated runs start warm: parse results and git history are kept in
  .code-visualizer/cache/ and reused while files are unchanged, analyses of other
  commits (diff, pr) in .code-visualizer/snapshots/, and a running
  "code-visualizer serve" answers other commands directly. Use --no-cache on any
  command (or CODE_VISUALIZER_NO_CACHE=1) for a cold run. Caches are signed with a
  per-user key, so a cache that comes with the repository is never trusted.

${pc.bold('Actions')}
  status                   What is cached, and whether a server is running (default)
  clear                    Delete the cache and snapshots (history, notes and state are kept)

${pc.bold('Options')}
      --json               Print machine-readable JSON
  -h, --help               Show this help

${pc.bold('Examples')}
  $ npx code-visualizer cache
  $ npx code-visualizer cache clear ./apps/web
`;

const ACTIONS = ['status', 'clear'];

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export const cacheCommand: Command = {
  name: 'cache',
  summary: 'Show or clear the warm analysis cache',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('cache', argv, { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    const [first, ...more] = positionals;
    const action = first && ACTIONS.includes(first) ? first : 'status';
    const rootArg = action === first ? more.shift() : first;
    // A bare word that is neither an action nor an existing folder is most likely a typo ("cache stats").
    const typo = rootArg === first && first !== undefined && !/[\\/.~]/.test(first) && !fs.existsSync(first);
    if (more.length || typo) {
      stderr.write(`${pc.red('✖')} Unknown cache action "${typo ? first : more[0]}" (use ${ACTIONS.join(' or ')}).\n`);
      return 2;
    }
    // Run from a sub-folder: the project around it (its .code-visualizer/), as every command finds it.
    const root = rootArg !== undefined ? path.resolve(rootArg) : resolveProjectRoot(process.cwd()).root;
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      stderr.write(`${pc.red('✖')} Project root "${root}" is not a directory.\n`);
      return 1;
    }
    const rel = (p: string): string => path.relative(process.cwd(), p) || '.';
    const log = (line = ''): void => void stdout.write(`${line}\n`);

    if (action === 'clear') {
      let cleared;
      try {
        cleared = clearDiskCache(root);
      } catch (error) {
        const reason = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
        if (values.json) stdout.write(`${JSON.stringify({ root, error: `Could not clear ${rel(cacheDir(root))}: ${reason}` }, null, 2)}\n`);
        else stderr.write(`${pc.red('✖')} Could not clear ${rel(cacheDir(root))}: ${reason}\n`);
        return 1;
      }
      if (values.json) {
        stdout.write(`${JSON.stringify({ root, cleared }, null, 2)}\n`);
        return 0;
      }
      banner(log);
      log(
        cleared.files
          ? `  ${pc.green('✔')} Cleared the cache ${pc.dim(`(${cleared.files} file${cleared.files === 1 ? '' : 's'}, ${formatBytes(cleared.bytes)})`)}`
          : `  ${pc.dim('Nothing to clear — there is no cache yet.')}`,
      );
      log();
      return 0;
    }

    const status = diskCacheStatus(root);
    const probe = await probeServer(root);
    const server = probe.status === 'running' ? probe.connection : undefined;
    const state = Object.keys(readAllState(root));
    const disabled = cacheDisabledByEnv();
    if (values.json) {
      const info = server
        ? { status: 'running', url: server.url, pid: server.info.pid, port: server.info.port, version: server.info.version, startedAt: server.info.startedAt }
        : probe.status === 'busy'
          ? { status: 'busy', pid: probe.info.pid, port: probe.info.port, version: probe.info.version, startedAt: probe.info.startedAt }
          : null;
      stdout.write(`${JSON.stringify({ root, ...status, server: info, state, disabled }, null, 2)}\n`);
      return 0;
    }
    banner(log);
    // Stored snapshots of other commits (diff, pr) live next to the cache folder: one summary line.
    const snapshots = status.files.filter((f) => f.kind === 'snapshot');
    const cached = status.files.filter((f) => f.kind !== 'snapshot');
    if (!status.files.length) log(`  ${pc.bold('Cache')}   ${pc.dim(`empty — the next analysis fills ${rel(status.dir)}`)}`);
    else log(`  ${pc.bold('Cache')}   ${rel(status.dir)} ${pc.dim(`· ${cached.length} file${cached.length === 1 ? '' : 's'} · ${formatBytes(cached.reduce((n, f) => n + f.bytes, 0))}`)}`);
    for (const f of status.files) {
      if (f.kind === 'snapshot') continue;
      if (f.kind === 'parse') {
        const what = f.entries !== undefined ? `${f.entries.toLocaleString('en-US')} files` : 'parse results';
        const note = f.current ? '' : pc.yellow(' (outdated: written by another version or build, replaced on the next run)');
        log(`    ${'parse'.padEnd(7)} ${what} ${pc.dim(`· ${formatBytes(f.bytes)} · saved ${ago(f.savedAt ?? f.modified)}`)}${note}`);
      } else if (f.kind === 'git') {
        log(`    ${'git'.padEnd(7)} ${(f.head ?? '').slice(0, 7)} ${pc.dim(`· ${formatBytes(f.bytes)} · saved ${ago(f.modified)}`)}`);
      } else {
        log(`    ${'other'.padEnd(7)} ${f.name} ${pc.dim(`· ${formatBytes(f.bytes)}`)}`);
      }
    }
    if (snapshots.length) {
      const bytes = snapshots.reduce((n, f) => n + f.bytes, 0);
      const newest = Math.max(...snapshots.map((f) => f.modified));
      log(`    ${'commits'.padEnd(7)} ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'} ${pc.dim(`· ${formatBytes(bytes)} · used ${ago(newest)} · ${rel(snapshotDir(root))}`)}`);
    }
    log(
      server
        ? `  ${pc.bold('Server')}  ${pc.underline(server.url)} ${pc.dim(`(pid ${server.info.pid}, started ${ago(server.info.startedAt)})`)}`
        : probe.status === 'busy'
          ? `  ${pc.bold('Server')}  ${pc.yellow(`registered (pid ${probe.info.pid}) but not responding`)} ${pc.dim('— busy re-analyzing, or stopped')}`
          : `  ${pc.bold('Server')}  ${pc.dim('not running — start one with')} ${pc.cyan('code-visualizer serve')}`,
    );
    if (state.length) log(`  ${pc.bold('State')}   ${state.join(', ')}`);
    if (disabled) log(`  ${pc.yellow('!')} ${pc.yellow('CODE_VISUALIZER_NO_CACHE is set: commands run cold and ignore the cache.')}`);
    log();
    return 0;
  },
};
