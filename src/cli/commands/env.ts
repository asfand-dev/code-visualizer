import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import { envExampleText, envStatus } from '../../shared/env.js';
import type { EnvReport, EnvVar } from '../../shared/types.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { createLinker, emitOutput, plural, safeText, type Linker } from '../format.js';
import { explicitRoot, isTTY, parseCommandArgs, persistFrom, Progress, resolveProjectRoot, splitList, STAGE_LABELS, UsageError, type Command } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer env [root] [options]

  The environment variables your code reads (process.env, import.meta.env,
  Deno.env, Bun.env) compared with your .env files: which ones nobody documented,
  which ones are declared but never read, and which secrets reach the browser.
  Only variable names are read, never their values.

${pc.bold('Options')}
      --missing            Only the variables that need attention
      --example            Print a .env.example written from the code (values empty)
  -o, --output <path>      Write the --example text to a file
      --copy               Copy the --example text to the clipboard
      --check              Exit with code 1 when a variable is undocumented or a
                           secret is exposed to the browser (for CI)
      --json               Machine-readable output
      --root <dir>         Project root (default: the project around the current folder)
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -q, --quiet              Only print the summary line
  -h, --help               Show this help

  A variable counts as documented when a template declares it: .env.example,
  .env.sample, .env.template… or any dotenv file that git tracks. Variables the
  code has a default for, and ones the platform provides (NODE_ENV, CI…), are
  not asked for.

${pc.bold('Examples')}
  $ npx code-visualizer env
  $ npx code-visualizer env --missing
  $ npx code-visualizer env --example --output .env.example
  $ npx code-visualizer env --check
`;

const MAX_ROWS = 40;
const MAX_SITES = 2;

interface Row {
  variable: EnvVar;
  ok: boolean;
  note: string;
}

function printRow({ variable, ok, note }: Row, width: number, link: Linker, out: (line?: string) => void): void {
  const mark = ok ? pc.green('✔') : pc.red('✖');
  const sites = variable.uses.slice(0, MAX_SITES).map((u) => link(u.file, u.line, `${u.file}:${u.line}`));
  const more = variable.fileCount > MAX_SITES ? pc.dim(` +${variable.fileCount - MAX_SITES} more`) : '';
  const name = safeText(variable.name).padEnd(width);
  out(`  ${mark} ${ok ? name : pc.bold(name)}  ${pc.dim(plural(variable.useCount, 'use').padEnd(8))} ${ok ? pc.dim(note) : note}`);
  if (!ok) out(`      ${pc.dim(sites.join(', '))}${more}`);
}

const list = (names: string[], max = 6): string => safeText(`${names.slice(0, max).join(', ')}${names.length > max ? `, +${names.length - max} more` : ''}`);

export const envCommand: Command = {
  name: 'env',
  summary: 'Environment variables: what the code reads, what is undocumented, what leaks',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('env', argv, {
        missing: { type: 'boolean' },
        example: { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        copy: { type: 'boolean' },
        check: { type: 'boolean' },
        json: { type: 'boolean' },
        root: { type: 'string' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'no-cache': { type: 'boolean' },
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
    const usage = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 2;
    };
    if ((values.output || values.copy) && !values.example) return usage('--output and --copy write the .env.example text: add --example.');
    if (values.example && values.json) return usage('Use either --example or --json.');
    if (positionals.length > 1) return usage(`env takes one project root (got ${positionals.join(' ')}).`);
    let root: string;
    try {
      root = resolveProjectRoot(process.cwd(), explicitRoot(values, positionals)).root;
    } catch (error) {
      if (error instanceof UsageError) return usage(error.message);
      throw error;
    }

    const progress = new Progress(stderr, isTTY(stderr) && !values.quiet && !values.json && !values.example);
    let env: EnvReport | undefined;
    try {
      const data = await getReport({
        root,
        exclude: splitList(values.exclude),
        includeSource: false,
        history: false,
        changes: false,
        persist: persistFrom(values['no-cache']),
        toolVersion: VERSION,
        onProgress: (stage) => progress.update(STAGE_LABELS[stage]),
      });
      env = data.env;
    } catch (error) {
      progress.stop();
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    progress.stop();

    const report: EnvReport = env ?? { vars: [], files: [], undocumented: [], unused: [], exposedSecrets: [] };
    const attention = report.undocumented.length + report.exposedSecrets.length;
    const failed = values.check && attention > 0 ? 1 : 0;
    const out = (line = ''): void => void stdout.write(`${line}\n`);

    if (values.json) {
      out(JSON.stringify({ ok: attention === 0, ...report }, null, 2));
      return failed;
    }
    if (values.example) {
      const text = envExampleText(report, { onlyMissing: values.missing });
      if (!report.vars.some((v) => v.useCount > 0 && !v.platform)) {
        stderr.write(`${pc.yellow('!')} The code reads no environment variables that a .env.example would document.\n`);
        return failed;
      }
      return (await emitOutput(text, values, { stdout, stderr }, { quiet: values.quiet })) ? failed : 1;
    }

    const used = report.vars.filter((v) => v.useCount > 0);
    if (!used.length && !report.files.length) {
      out(`  ${pc.dim('No environment variables read by the code, and no .env files found.')}`);
      return 0;
    }
    const rows: Row[] = used.map((variable) => ({ variable, ...envStatus(variable, report) })).sort((a, b) => Number(a.ok) - Number(b.ok));
    const shown = values.missing ? rows.filter((r) => !r.ok) : rows;
    const summary = [
      `${plural(used.length, 'variable')} read by the code`,
      report.files.length ? `${plural(report.files.length, 'dotenv file')} (${list(report.files.map((f) => f.path), 3)})` : 'no dotenv files',
    ];

    out();
    out(`  ${pc.bold('Environment variables')} ${pc.dim(`· ${summary.join(' · ')}`)}`);
    if (!values.quiet) {
      out();
      const link = createLinker({ root, stream: stdout });
      const width = Math.min(40, Math.max(8, ...shown.map((r) => r.variable.name.length)));
      for (const row of shown.slice(0, MAX_ROWS)) printRow(row, width, link, out);
      if (shown.length > MAX_ROWS) out(`  ${pc.dim(`+${shown.length - MAX_ROWS} more (use --json for all)`)}`);
      if (!shown.length) out(`  ${pc.green('✔')} Every variable is documented.`);
    }
    out();
    if (report.undocumented.length) out(`  ${pc.red('✖')} ${plural(report.undocumented.length, 'variable')} no template documents: ${list(report.undocumented)}`);
    if (report.exposedSecrets.length) out(`  ${pc.red('✖')} ${plural(report.exposedSecrets.length, 'secret')} exposed to the browser: ${list(report.exposedSecrets)} ${pc.dim('(rename without the public prefix, or move the secret to the server)')}`);
    if (report.unused.length) out(`  ${pc.yellow('!')} ${plural(report.unused.length, 'variable')} declared in a template but never read: ${list(report.unused)}`);
    if (!attention) out(`  ${pc.green('✔')} Nothing undocumented, nothing leaking.`);
    else if (!values.quiet) out(`  ${pc.dim('Write the missing ones down:')} ${pc.cyan('code-visualizer env --missing --example')}`);
    out();
    return failed;
  },
};
