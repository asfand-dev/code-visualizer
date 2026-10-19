import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { NotifyMode } from '../../analyzer/config.js';
import type { AnalyzeOptions } from '../../analyzer/index.js';
import { AnalyzeError } from '../../analyzer/errors.js';
import { analysisFingerprint } from '../../server/client.js';
import { liveLocation, liveMarker } from '../../shared/live.js';
import type { LiveEvent } from '../../shared/types.js';
import { probeServer, type ServerProbe } from '../engine.js';
import { ANALYSIS_OPTIONS, analysisOptions, banner, cacheNote, changesLine, coveragePaths, explicitRoot, healthLine, parseCommandArgs, rootNotice, subprojectNotice, UsageError, type Command } from '../shared.js';
import { ANALYSIS_HELP } from './report.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer serve [root] [options]

  Start a live companion on localhost. The report updates by itself while you
  edit files, stage, commit or switch branches — keep it open next to your editor.
  Other commands (check, context, pr…) reuse its warm analysis while it runs.
  When a server for the project is already running, its address is printed instead.
${ANALYSIS_HELP}

${pc.bold('Server options')}
  -p, --port <n>           Port to listen on (default: 4747, next free port if taken;
                           0: any free port, recorded in .code-visualizer/server.json)
      --host <host>        Interface to bind (default: 127.0.0.1). Other hosts need the printed link
      --no-open            Don't open the browser
      --new                Start another server even if one is running for this project
      --notify[=<mode>]    Desktop notifications for new problems: errors (default) or all
                           (errors, warnings and fixes); at most one every 10 s
      --no-notify          No desktop notifications, whatever the configuration says
      --no-personal-ai     The AI tools view lists only the project's own Claude Code tools,
                           not those of ~/.claude (your skills, MCP servers, plugins)
  -h, --help               Show this help

  A running server is reused only when it was started with the same analysis
  options (and --port / --host, when given). Otherwise, with --new or --no-cache,
  a separate server starts and the running one stays the one other commands use.

${pc.bold('Live guard')}
  Every update is compared with the one before, and what got worse (or better)
  is printed under it — whether you or an AI agent made the edit:
    ✖ new cycle: src/cart/a.ts → src/cart/b.ts → src/cart/a.ts
    ✖ rule no-db-in-ui broken in src/ui/Cart.tsx:3
    ▲ checkout() complexity 12 → 19 · src/cart/checkout.ts:40
    ! formatPrice() signature changed (14 importers)
    ✔ cycle fixed: src/cart/a.ts → src/cart/b.ts → src/cart/a.ts
  The browser shows the same feed. In code-visualizer.config.json:
    "serve": { "notify": "errors" | "all" | "off",
               "events": { "exclude": ["unused-export", "health"] } }

${pc.bold('Examples')}
  $ npx code-visualizer serve
  $ npx code-visualizer serve ./apps/web --port 5000
  $ npx code-visualizer serve --notify
  $ npx code-visualizer serve --notify=all
`;

const SEVERITY_COLOR: Record<LiveEvent['severity'], (text: string) => string> = { error: pc.red, warning: pc.yellow, success: pc.green, info: pc.dim };

/** One coloured terminal line per live event: `✖ new cycle: a.ts → b.ts → a.ts`, `health 82 → 80 (Modularity 90 → 80)`. */
export function formatLiveEvent(e: LiveEvent): string {
  const color = SEVERITY_COLOR[e.severity];
  const marker = liveMarker(e);
  const where = liveLocation(e);
  const location = where && e.kind !== 'health' && !e.message.includes(e.files[0]) ? pc.dim(` · ${where}`) : '';
  const detail = e.kind === 'health' && e.detail ? pc.dim(` (${e.detail})`) : '';
  return `${marker ? `${color(marker)} ` : ''}${e.severity === 'info' ? pc.dim(e.message) : color(e.message)}${location}${detail}`;
}

/**
 * The second line of an event, dimmed, where it says what changed: the signature before → after, the
 * import a rule forbids, the names a deleted file was used for (undefined for the others).
 */
export function formatLiveDetail(e: LiveEvent): string | undefined {
  if (!e.detail || e.kind === 'health' || e.kind === 'config' || e.severity === 'success') return undefined;
  return pc.dim(e.detail);
}

const NOTIFY_VALUES: Record<string, NotifyMode> = { errors: 'errors', error: 'errors', all: 'all', off: 'off', none: 'off' };

/**
 * `--notify=all` and `--notify all` (a mode, not a directory): the mode is taken out of the arguments
 * so that parseArgs sees a plain `--notify` switch. Throws a UsageError for an unknown mode.
 */
export function extractNotifyMode(argv: string[], isDirectory: (p: string) => boolean = (p) => fs.existsSync(path.resolve(p))): { argv: string[]; mode?: NotifyMode } {
  const rest: string[] = [];
  let mode: NotifyMode | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    const inline = /^--notify=(.*)$/.exec(arg);
    if (inline) {
      mode = NOTIFY_VALUES[inline[1].trim().toLowerCase()];
      if (!mode) throw new UsageError(`--notify must be errors, all or off (got "${inline[1]}").`);
      rest.push('--notify');
      continue;
    }
    rest.push(arg);
    const following = argv[i + 1];
    if (arg === '--notify' && following && NOTIFY_VALUES[following.toLowerCase()] && !isDirectory(following)) {
      mode = NOTIFY_VALUES[following.toLowerCase()];
      i++;
    }
  }
  return { argv: rest, mode };
}

/** `--no-notify` wins, then `--notify[=mode]` (errors, or "all" when the configuration says so), then `serve.notify`. */
export function notifyModeFrom(flags: { notify?: boolean; 'no-notify'?: boolean; mode?: NotifyMode }, configured: NotifyMode | undefined): NotifyMode {
  if (flags['no-notify']) return 'off';
  if (flags.mode) return flags.mode;
  if (flags.notify) return configured === 'all' ? 'all' : 'errors';
  return configured ?? 'off';
}

/** What `serve` does about a server already registered for the project. */
export type ServeDecision =
  | { action: 'reuse'; url: string; pid: number }
  | { action: 'start'; register: boolean; note?: string };

/**
 * One server per project: reuse the running one when it serves what was asked for. Otherwise start
 * another one that leaves the registration alone (a busy or differently configured server keeps it).
 */
export function decideServe(
  probe: ServerProbe,
  root: string,
  options: AnalyzeOptions,
  flags: { new?: boolean; port?: number; host?: string },
): ServeDecision {
  if (probe.status === 'none') return { action: 'start', register: true };
  if (probe.status === 'busy') {
    return { action: 'start', register: false, note: `A server for this project is registered (pid ${probe.info.pid}) but not responding; starting a separate one.` };
  }
  const { info, url } = probe.connection;
  if (flags.new) return { action: 'start', register: false, note: `Starting a separate server; the one at ${url} stays the one other commands use.` };
  if (options.persist === false) return { action: 'start', register: false, note: `Starting a separate server from scratch (--no-cache); the one at ${url} stays the one other commands use.` };
  const same =
    info.fingerprint === analysisFingerprint(root, options) &&
    info.includeSource === (options.includeSource !== false) &&
    info.changes === (options.git !== false && options.changes !== false) &&
    (flags.port === undefined || flags.port === info.port) &&
    (flags.host === undefined || flags.host === info.host);
  if (same) return { action: 'reuse', url, pid: info.pid };
  return { action: 'start', register: false, note: `A server for this project with other options runs at ${url} (pid ${info.pid}); starting another one with these options.` };
}

export const serveCommand: Command = {
  name: 'serve',
  aliases: ['live', 'watch', 'dev'],
  summary: 'Live companion: a local report that updates while you code',
  async run({ argv: rawArgv, stdout, stderr }) {
    let parsed;
    let notifyFlag: NotifyMode | undefined;
    try {
      const extracted = extractNotifyMode(rawArgv);
      notifyFlag = extracted.mode;
      parsed = parseCommandArgs('serve', extracted.argv, {
        ...ANALYSIS_OPTIONS,
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        open: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        new: { type: 'boolean' },
        notify: { type: 'boolean' },
        'no-notify': { type: 'boolean' },
        'no-personal-ai': { type: 'boolean' },
        coverage: { type: 'string', multiple: true },
        // review-mode: open My changes in reviewer mode on this ref (`review <ref> --open`).
        review: { type: 'string' },
        'review-base': { type: 'string' },
        'review-test-first': { type: 'boolean' },
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
    const log = (line = ''): void => void stdout.write(`${line}\n`);
    let options;
    let explicit: boolean;
    try {
      options = { ...analysisOptions(values, positionals), coverage: coveragePaths(values.coverage), ...(values['no-personal-ai'] ? { ai: { personal: false } } : {}) };
      explicit = explicitRoot(values, positionals) !== undefined;
    } catch (error) {
      if (error instanceof UsageError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 2;
      }
      throw error;
    }
    // `--port 0`: the system picks a free port; the URL printed and .code-visualizer/server.json carry it.
    const port = values.port !== undefined && values.port.trim() ? Number(values.port) : values.port !== undefined ? NaN : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      stderr.write(`${pc.red('✖')} --port must be a number between 0 (any free port) and 65535.\n`);
      return 2;
    }
    const shouldOpen = values['no-open'] ? false : values.open ? true : !process.env.CI;
    // review-mode: `review <ref> --open` lands on My changes → Reviewer with that ref.
    const reviewHash = values.review
      ? `#/changes?${new URLSearchParams({ review: values.review, ...(values['review-base'] ? { base: values['review-base'] } : {}), ...(values['review-test-first'] ? { tf: '1' } : {}) }).toString()}`
      : '';
    const openUrl = async (url: string): Promise<void> => {
      if (!shouldOpen) return;
      try {
        const { default: open } = await import('open');
        await open(`${url}${reviewHash}`, { wait: false });
      } catch {
        /* the URL is printed */
      }
    };
    banner(log);
    const where = rootNotice(options.root, explicit);
    if (where) log(`  ${pc.dim(`ℹ ${where}`)}`);
    let probe = await probeServer(options.root);
    // A registered server that is alive but silent may just be re-analyzing: give it longer.
    if (probe.status === 'busy') probe = await probeServer(options.root, { timeoutMs: 2_000 });
    // Any port will do with `--port 0`: a running server on whichever port is reused like without --port.
    const decision = decideServe(probe, options.root, options, { new: values.new, port: port || undefined, host: values.host });
    if (decision.action === 'reuse') {
      log(`  ${pc.green('✔')} Already running at ${pc.bold(pc.underline(decision.url))} ${pc.dim(`(pid ${decision.pid})`)}`);
      if (reviewHash) log(`  ${pc.cyan('➜')} Reviewing ${pc.bold(values.review!)} at ${pc.underline(`${decision.url}${reviewHash}`)}`);
      // Notifications are set up when a server starts: say so instead of ignoring the flag.
      if (values.notify || values['no-notify']) log(`  ${pc.yellow('!')} ${pc.yellow(`--${values['no-notify'] ? 'no-' : ''}notify applies to a server when it starts: stop the running one (pid ${decision.pid}) or use --new.`)}`);
      log(`  ${pc.dim('Use --new to start another server.')}`);
      log();
      await openUrl(decision.url);
      return 0;
    }
    if (decision.note) log(`  ${pc.yellow('!')} ${decision.note}`);
    log(`  ${pc.dim('Analyzing… (this happens once — later updates are incremental)')}`);
    let server;
    let notifyMode: NotifyMode = 'off';
    try {
      // Loaded here: answering "already running" does not need the analyzer.
      const [{ serve }, { loadConfig }] = await Promise.all([import('../../server/index.js'), import('../../analyzer/config.js')]);
      notifyMode = notifyModeFrom({ ...values, mode: notifyFlag }, loadConfig(options.root).config.serve?.notify);
      let indent = '';
      server = await serve({
        ...options,
        port,
        host: values.host,
        register: decision.register,
        writeHistory: options.history !== false,
        log: (message) => {
          const time = new Date().toLocaleTimeString();
          indent = ' '.repeat(time.length);
          log(`  ${pc.dim(time)} ${message}`);
        },
        // Under the update line, aligned with its text; what changed on a second line.
        onEvents: (events) => {
          for (const e of events) {
            log(`  ${indent} ${formatLiveEvent(e)}`);
            const detail = formatLiveDetail(e);
            if (detail) log(`  ${indent}   ${detail}`);
          }
        },
      });
    } catch (error) {
      if (error instanceof AnalyzeError) {
        stderr.write(`  ${pc.red('✖')} ${error.message}\n\n`);
        return 1;
      }
      stderr.write(`  ${pc.red('✖')} ${(error as Error).message}\n\n`);
      return 1;
    }
    const first = server.current();
    log(`  ${pc.green('✔')} Analyzed ${pc.bold(first.stats.files.toLocaleString('en-US'))} files in ${first.stats.durationMs}ms${cacheNote(first.stats)}`);
    log(`    ${healthLine(first)}`);
    if (first.config?.error) log(`    ${pc.yellow('!')} ${pc.yellow(`Ignored the configuration — ${first.config.error}`)}`);
    const work = changesLine(first);
    if (work) log(`    ${work}`);
    const notice = subprojectNotice(first);
    if (notice) log(`    ${pc.dim(`ℹ ${notice}`)}`);
    log(`  ${pc.cyan('➜')} Live at ${pc.bold(pc.underline(server.url))}`);
    if (reviewHash) log(`  ${pc.cyan('➜')} Reviewing ${pc.bold(values.review!)} at ${pc.underline(`${server.url}${reviewHash}`)}`);
    if (server.exposed) log(`  ${pc.yellow('!')} ${pc.yellow('Reachable from other machines — anyone with this link can read your code.')}`);
    let closeNotifier = (): void => undefined;
    if (notifyMode !== 'off') {
      const { createNotifier } = await import('../notify.js');
      const notifier = createNotifier({ mode: notifyMode, title: `code-visualizer · ${first.project.name}` });
      server.engine.onUpdate((u) => void (u.events?.length && notifier.notify(u.events)));
      closeNotifier = () => notifier.close();
      log(`  ${pc.dim(`Desktop notifications for ${notifyMode === 'all' ? 'errors, warnings and fixes' : 'new errors'} (at most one every 10 s).`)}`);
    }
    log(`  ${pc.dim('Watching for changes — what gets worse or better is printed here. Press Ctrl+C to stop.')}`);
    log();
    await openUrl(server.url);
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        log();
        log(`  ${pc.dim('Stopping…')}`);
        closeNotifier();
        void server.close().then(resolve);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return 0;
  },
};

