import path from 'node:path';
import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import { writeHistory } from '../../analyzer/health.js';
import { writeReport } from '../../report/html.js';
import { getReport } from '../engine.js';
import {
  ANALYSIS_OPTIONS,
  analysisOptions,
  banner,
  explicitRoot,
  cacheNote,
  changesLine,
  coveragePaths,
  formatBytes,
  formatMs,
  healthLine,
  isTTY,
  parseCommandArgs,
  Progress,
  rootNotice,
  slug,
  STAGE_LABELS,
  subprojectNotice,
  UsageError,
  type Command,
} from '../shared.js';

/** The analysis options every analyzing command takes, without `-q` (check describes its own). */
export const ANALYSIS_HELP_BASE = `
${pc.bold('Analysis options')}
      --root <dir>         Project root (default: the project around the current folder —
                           the nearest package.json, or its workspace monorepo)
  -f, --file <path>        Focus on one file: its dependencies and the files that depend on it
  -d, --directory <path>   Focus on one directory (alias: --dir)
      --depth <n>          Levels of dependents/dependencies to include with --file
  -e, --exclude <glob>     Exclude files (gitignore syntax). Repeat or comma-separate
  -b, --base <ref>         Compare your branch with this ref (default: origin/HEAD, main or master)
      --no-git             Skip git history and change detection
      --no-changes         Skip uncommitted / branch change detection
      --no-source          Don't embed source code
      --no-history         Don't read or record history (.code-visualizer/history.json)
      --max-files <n>      Maximum number of files to analyze (default: 20000)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
      --coverage <path>    Coverage report (file or folder) to read instead of the detected
                           coverage/coverage-final.json or coverage/lcov.info; repeatable`;

export const ANALYSIS_HELP = `${ANALYSIS_HELP_BASE}
  -q, --quiet              Only print errors`;

/** Errors of writing a file the user can act on (a read-only or missing folder, a full disk). */
const WRITE_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EEXIST', 'ENAMETOOLONG']);

/** `Cannot write /System/x.html: read-only file system` for a write error, else undefined (a bug: let it throw). */
export function writeErrorMessage(error: unknown, file: string): string | undefined {
  const e = error as NodeJS.ErrnoException;
  if (!e?.code || !WRITE_ERRORS.has(e.code)) return undefined;
  const reason = e.message.replace(/^[A-Z]+: /, '').replace(/, \w+ '.*'$/, '');
  return `Cannot write ${file}: ${reason}`;
}

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer report [root] [options]

  Analyze a JavaScript / TypeScript project and open an interactive report.
${ANALYSIS_HELP}

${pc.bold('Report options')}
  -o, --output <path>      Where to write the report (file.html or a directory)
                           (default: <root>/.code-visualizer/report.html)
      --json               Also write the raw analysis as JSON next to the report
      --no-open            Don't open the report in the browser
  -h, --help               Show this help

${pc.bold('Examples')}
  $ npx code-visualizer
  $ npx code-visualizer report ./apps/web
  $ npx code-visualizer report --file=src/libs/index.ts
  $ npx code-visualizer report --directory=src/components/area-chart
  $ npx code-visualizer report --base=origin/develop --no-open
`;

export const reportCommand: Command = {
  name: 'report',
  summary: 'Generate an interactive report for the project (default)',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('report', argv, {
        ...ANALYSIS_OPTIONS,
        output: { type: 'string', short: 'o' },
        json: { type: 'boolean' },
        open: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        coverage: { type: 'string', multiple: true },
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
    const quiet = !!values.quiet;
    const log = (line = ''): void => {
      if (!quiet) stdout.write(`${line}\n`);
    };
    let options;
    let explicit: boolean;
    try {
      options = { ...analysisOptions(values, positionals), coverage: coveragePaths(values.coverage) };
      explicit = explicitRoot(values, positionals) !== undefined;
    } catch (error) {
      if (error instanceof UsageError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 2;
      }
      throw error;
    }

    banner(log);
    // Run from a sub-folder: the whole project is analyzed (and its report written at its root).
    const where = rootNotice(options.root, explicit);
    if (where) log(`  ${pc.dim(`ℹ ${where}`)}`);
    const progress = new Progress(stdout, isTTY() && !quiet);
    let data;
    let liveUrl: string | undefined;
    try {
      data = await getReport({
        ...options,
        release: true,
        onServer: (connection) => (liveUrl = connection.url),
        onProgress: (stage, detail) => {
          const count = detail?.total ? pc.dim(` ${detail.done ?? 0}/${detail.total}`) : '';
          progress.update(`${STAGE_LABELS[stage]}${count}`);
        },
      });
    } catch (error) {
      progress.stop();
      if (error instanceof AnalyzeError) {
        stderr.write(`  ${pc.red('✖')} ${error.message}\n\n`);
        return 1;
      }
      throw error;
    }
    progress.stop();

    let outFile: string;
    const defaultName = data.scope.path ? `report-${slug(data.scope.path)}.html` : 'report.html';
    if (values.output) {
      const out = path.resolve(values.output);
      outFile = /\.html?$/i.test(out) ? out : path.join(out, defaultName);
    } else {
      outFile = path.join(options.root, '.code-visualizer', defaultName);
    }
    let written;
    try {
      written = writeReport(data, outFile, { json: values.json });
    } catch (error) {
      const message = writeErrorMessage(error, outFile);
      if (!message) throw error;
      stderr.write(`  ${pc.red('✖')} ${message}\n\n`);
      return 2;
    }
    // A running server records history after each analysis itself (and only lends its data when it does).
    if (options.history !== false && data.scope.type === 'project' && data.stats.cache?.source !== 'server') {
      try {
        writeHistory(options.root, data.history);
      } catch {
        /* history is best effort */
      }
    }

    const s = data.stats;
    const stack = data.project.frameworks
      .filter((f) => ['fullstack', 'frontend', 'backend', 'mobile', 'desktop', 'language'].includes(f.category))
      .map((f) => f.name)
      .slice(0, 6);
    const scopeLabel = data.scope.type === 'project' ? '' : pc.dim(` (${data.scope.type}: ${data.scope.path || '.'})`);
    log(`  ${pc.green('✔')} Analyzed ${pc.bold(s.files.toLocaleString('en-US'))} files ${pc.dim(`(${s.loc.toLocaleString('en-US')} lines)`)} in ${formatMs(s.durationMs)}${cacheNote(s)}${scopeLabel}`);
    if (stack.length) log(`    ${pc.dim(stack.join(' · '))}`);
    const facts = [
      `${s.symbols.toLocaleString('en-US')} symbols`,
      s.components && `${s.components} components`,
      s.classes && `${s.classes} classes`,
      s.routes && `${s.routes} routes`,
      `${s.packages} packages`,
      data.insights.cycles.length && pc.yellow(`${data.insights.cycles.length} circular deps`),
    ].filter(Boolean);
    log(`    ${facts.join(pc.dim(' · '))}`);
    log(`    ${healthLine(data)}`);
    const work = changesLine(data);
    if (work) log(`    ${work}`);
    const notice = subprojectNotice(data);
    if (notice) log(`    ${pc.dim(`ℹ ${notice}`)}`);
    for (const w of data.warnings.slice(0, 5)) log(`    ${pc.yellow('!')} ${pc.dim(w)}`);
    if (data.warnings.length > 5) log(`    ${pc.dim(`… and ${data.warnings.length - 5} more warnings`)}`);
    log();
    const relative = path.relative(process.cwd(), written.htmlPath);
    const rel = !relative || relative.startsWith('../..') ? written.htmlPath : relative;
    log(`  ${pc.cyan('➜')} Report  ${pc.bold(pc.underline(rel))} ${pc.dim(formatBytes(written.bytes))}`);
    if (written.jsonPath) log(`  ${pc.cyan('➜')} JSON    ${path.relative(process.cwd(), written.jsonPath)}`);

    const shouldOpen = values['no-open'] ? false : values.open ? true : !process.env.CI;
    if (shouldOpen) {
      try {
        const { default: open } = await import('open');
        await open(written.htmlPath, { wait: false });
        log(`  ${pc.dim('Opened in your default browser.')}`);
      } catch {
        log(`  ${pc.dim('Could not open the browser automatically — open the file above.')}`);
      }
    }
    if (liveUrl) log(`  ${pc.cyan('➜')} Live    ${pc.underline(liveUrl)} ${pc.dim('(the running server; it updates while you code)')}`);
    else log(`  ${pc.dim('Tip: run')} ${pc.cyan('npx code-visualizer serve')} ${pc.dim('for a live view that updates while you code.')}`);
    log();
    return 0;
  },
};
