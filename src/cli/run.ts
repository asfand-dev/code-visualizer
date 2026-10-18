import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pc from 'picocolors';
import { analyze, AnalyzeError, type AnalyzeStage } from '../analyzer/index.js';
import { writeReport } from '../report/html.js';
import { VERSION } from '../version.js';

interface CommandContext {
  argv: string[];
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

interface Command {
  name: string;
  summary: string;
  run(ctx: CommandContext): Promise<number>;
}

const isTTY = (): boolean => !!process.stdout.isTTY && !process.env.CI;

/* -------------------------------------------------------------------------- */
/*                                   report                                   */
/* -------------------------------------------------------------------------- */

const REPORT_HELP = `
${pc.bold('Usage')}
  $ code-visualizer report [root] [options]

  Analyze a JavaScript / TypeScript project and open an interactive report.

${pc.bold('Options')}
  -f, --file <path>        Focus on one file: its dependencies and the files that depend on it
  -d, --directory <path>   Focus on one directory (alias: --dir)
      --depth <n>          Levels of dependents/dependencies to include with --file (default: deps ∞, dependents 2)
  -o, --output <path>      Where to write the report (file.html or a directory)
                           (default: <root>/.code-visualizer/report.html)
  -e, --exclude <glob>     Exclude files (gitignore syntax). Repeat or comma-separate
      --json               Also write the raw analysis as JSON next to the report
      --no-open            Don't open the report in the browser
      --no-git             Skip git history (churn, ownership, change coupling)
      --no-source          Don't embed source code in the report
      --max-files <n>      Maximum number of files to analyze (default: 20000)
  -q, --quiet              Only print errors
  -h, --help               Show this help

${pc.bold('Examples')}
  $ npx code-visualizer
  $ npx code-visualizer report ./apps/web
  $ npx code-visualizer report --file=src/libs/index.ts
  $ npx code-visualizer report --directory=src/components/area-chart
  $ npx code-visualizer report --exclude "**/*.generated.ts" --no-git
`;

function slug(value: string): string {
  return value.replace(/\.[^./]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'root';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const STAGE_LABELS: Record<AnalyzeStage, string> = {
  project: 'Reading project configuration',
  discover: 'Discovering source files',
  parse: 'Parsing files',
  link: 'Linking modules, components and symbols',
  git: 'Reading git history',
  insights: 'Computing insights',
  done: 'Done',
};

class Progress {
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private text = '';
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(
    private readonly stream: NodeJS.WriteStream,
    private readonly enabled: boolean,
  ) {}

  update(text: string): void {
    this.text = text;
    if (!this.enabled) return;
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), 80);
      this.timer.unref();
    }
    this.render();
  }

  private render(): void {
    this.frame = (this.frame + 1) % this.frames.length;
    this.stream.write(`\r\x1b[2K  ${pc.cyan(this.frames[this.frame])} ${this.text}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.enabled) this.stream.write('\r\x1b[2K');
  }
}

function splitList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

const reportCommand: Command = {
  name: 'report',
  summary: 'Generate an interactive report for the project (default)',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          file: { type: 'string', short: 'f' },
          directory: { type: 'string', short: 'd' },
          dir: { type: 'string' },
          depth: { type: 'string' },
          output: { type: 'string', short: 'o' },
          exclude: { type: 'string', short: 'e', multiple: true },
          json: { type: 'boolean' },
          open: { type: 'boolean' },
          'no-open': { type: 'boolean' },
          'no-git': { type: 'boolean' },
          'no-source': { type: 'boolean' },
          'max-files': { type: 'string' },
          quiet: { type: 'boolean', short: 'q' },
          help: { type: 'boolean', short: 'h' },
        },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n${pc.dim('Run "code-visualizer report --help" for usage.')}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(REPORT_HELP);
      return 0;
    }
    const quiet = !!values.quiet;
    const log = (line = ''): void => {
      if (!quiet) stdout.write(`${line}\n`);
    };
    const root = path.resolve(positionals[0] ?? process.cwd());
    const file = values.file;
    const directory = values.directory ?? values.dir;
    if (file && directory) {
      stderr.write(`${pc.red('✖')} Use either --file or --directory, not both.\n`);
      return 2;
    }
    const depth = values.depth !== undefined ? Number(values.depth) : undefined;
    if (depth !== undefined && (!Number.isFinite(depth) || depth < 0)) {
      stderr.write(`${pc.red('✖')} --depth must be a positive number.\n`);
      return 2;
    }
    const maxFiles = values['max-files'] !== undefined ? Number(values['max-files']) : undefined;

    log();
    log(`  ${pc.bold(pc.magenta('◆'))} ${pc.bold('code-visualizer')} ${pc.dim(`v${VERSION}`)}`);
    log();
    const progress = new Progress(stdout, isTTY() && !quiet);
    let data;
    try {
      data = await analyze({
        root,
        file,
        directory,
        depth,
        exclude: splitList(values.exclude),
        includeSource: !values['no-source'],
        git: !values['no-git'],
        maxFiles,
        toolVersion: VERSION,
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

    // Output path
    let outFile: string;
    const defaultName = data.scope.path ? `report-${slug(data.scope.path)}.html` : 'report.html';
    if (values.output) {
      const out = path.resolve(values.output);
      outFile = /\.html?$/i.test(out) ? out : path.join(out, defaultName);
    } else {
      outFile = path.join(root, '.code-visualizer', defaultName);
    }
    const written = writeReport(data, outFile, { json: values.json });

    const s = data.stats;
    const stack = data.project.frameworks
      .filter((f) => ['fullstack', 'frontend', 'backend', 'mobile', 'desktop', 'language'].includes(f.category))
      .map((f) => f.name)
      .slice(0, 6);
    const scopeLabel = data.scope.type === 'project' ? '' : pc.dim(` (${data.scope.type}: ${data.scope.path || '.'})`);
    log(`  ${pc.green('✔')} Analyzed ${pc.bold(s.files.toLocaleString('en-US'))} files ${pc.dim(`(${s.loc.toLocaleString('en-US')} lines)`)} in ${formatMs(s.durationMs)}${scopeLabel}`);
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
    log();
    return 0;
  },
};

/* -------------------------------------------------------------------------- */
/*                                  dispatcher                                */
/* -------------------------------------------------------------------------- */

const COMMANDS: Command[] = [reportCommand];
const DEFAULT_COMMAND = 'report';

function mainHelp(): string {
  return `
  ${pc.bold(pc.magenta('◆'))} ${pc.bold('code-visualizer')} ${pc.dim(`v${VERSION}`)}
  Visualize any JavaScript / TypeScript codebase in your browser.

${pc.bold('Usage')}
  $ code-visualizer [command] [options]

${pc.bold('Commands')}
${COMMANDS.map((c) => `  ${c.name.padEnd(12)} ${c.summary}`).join('\n')}

${pc.bold('Global options')}
  -h, --help       Show help
  -v, --version    Show version

Run ${pc.cyan('code-visualizer report --help')} for all report options.
`;
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const ctx = { stdout: process.stdout, stderr: process.stderr };
  const [first, ...rest] = argv;
  if (first === '-v' || first === '--version' || first === 'version') {
    ctx.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (first === 'help' || ((first === '-h' || first === '--help') && rest.length === 0)) {
    ctx.stdout.write(mainHelp());
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === first);
  if (command) return command.run({ ...ctx, argv: rest });
  // Unknown first word: treat it as a path for the default command when it exists on disk.
  if (first && !first.startsWith('-') && !fs.existsSync(first)) {
    ctx.stderr.write(`${pc.red('✖')} Unknown command "${first}".\n`);
    ctx.stdout.write(mainHelp());
    return 2;
  }
  const fallback = COMMANDS.find((c) => c.name === DEFAULT_COMMAND)!;
  return fallback.run({ ...ctx, argv });
}
