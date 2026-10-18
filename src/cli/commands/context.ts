import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import { fileContextMarkdown, projectSummaryMarkdown } from '../../shared/markdown.js';
import type { CheckResult, ReportData } from '../../shared/types.js';
import { getReport } from '../engine.js';
import { emitOutput } from '../format.js';
import { coveragePaths, explicitRoot, parseCommandArgs, persistFrom, resolveProjectRoot, rootNotice, splitList, UsageError, type Command } from '../shared.js';
import { VERSION } from '../../version.js';

const CONTEXT_HELP = `
${pc.bold('Usage')}
  $ code-visualizer context [file] [options]

  Print Markdown context about a file — or the whole project — ready to paste into
  ChatGPT, Claude, Copilot Chat or your docs (AGENTS.md / CLAUDE.md / ONBOARDING.md).

  --agents keeps a short project map for coding agents in AGENTS.md, between
  <!-- code-visualizer:start --> and <!-- code-visualizer:end --> (each on a line of
  its own): script commands, the single-file test command, the architecture rules
  and layers, generated files, fragile files with their tests, CODEOWNERS boundaries
  and the tools. Text outside the markers is kept; an unchanged block is not
  rewritten (safe in pre-commit). It describes the project around the current
  folder unless --root says otherwise.

${pc.bold('Options')}
      --root <dir>         Project root (default: the project around the current folder)
      --source             Include the file's source code
      --summary            Project architecture overview instead of a single file
      --agents             The managed AGENTS.md block (printed, or with --write updated in place)
      --write [file.md]    With --agents: update the block in AGENTS.md (or the Markdown file given)
      --claude             With --agents --write: also import AGENTS.md from CLAUDE.md (@AGENTS.md)
  -o, --output <file>      Write to a file instead of stdout (--agents: update the block in it)
  -c, --copy               Copy to the clipboard
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-git             Skip git history
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -h, --help               Show this help

${pc.bold('Examples')}
  $ npx code-visualizer context src/cart/Cart.tsx --source | pbcopy
  $ npx code-visualizer context --summary -o ONBOARDING.md
  $ npx code-visualizer context --agents --write --claude
`;

const PR_HELP = `
${pc.bold('Usage')}
  $ code-visualizer pr [root] [options]

  Write a pull request description for your current work: what changed, which
  functions and routes are affected, which tests to run, risk and reviewers.

  On the main branch with commits you have not pushed yet, those commits are your work.

${pc.bold('Options')}
  -b, --base <ref>         Compare with this ref (default: the pull request's target branch in CI,
                           otherwise origin/HEAD, main or master)
      --root <dir>         Project root (default: the project around the current folder)
      --format <f>         markdown (default) or comment: a sticky PR comment (marker on the
                           first line, at most 60,000 characters, long sections folded)
      --check              Include the quality gates (new findings only, as in check --changed)
      --coverage <path>    Coverage report (file or folder) for the patch coverage line; default:
                           coverage/coverage-final.json or coverage/lcov.info when present
  -o, --output <file>      Write to a file instead of stdout
  -c, --copy               Copy to the clipboard
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -h, --help               Show this help

${pc.bold('Examples')}
  $ npx code-visualizer pr --copy
  $ npx code-visualizer pr --base origin/develop > pr.md
  $ npx code-visualizer pr --format comment --check -o pr-comment.md
    gh pr comment --edit-last --create-if-none --body-file pr-comment.md
`;

/** Print, write or copy the Markdown; false when the file cannot be written (one line: `✖ Cannot write x.md: EACCES`). */
function emit(markdown: string, values: { output?: string; copy?: boolean }, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<boolean> {
  return emitOutput(markdown, values, { stdout, stderr }, { reason: errorCode });
}

/** `EACCES`, `EROFS`… (the message when there is no code). */
const errorCode = (error: NodeJS.ErrnoException): string => error.code ?? error.message;

/** A file system error (it has a code), not one of ours (unbalanced markers). */
const isFsError = (error: unknown): error is NodeJS.ErrnoException => typeof (error as NodeJS.ErrnoException | undefined)?.code === 'string';

/**
 * `context --agents`: the managed block, printed or written into AGENTS.md (or `file`) between its markers.
 * An unchanged file is not touched; `claude` also imports AGENTS.md from the CLAUDE.md next to it.
 */
async function agentsMarkdown(data: ReportData, root: string, options: { file?: string; write?: boolean; claude?: boolean; copy?: boolean }, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream): Promise<number> {
  const [{ agentsBlockMarkdown, upsertManagedBlock }, { projectCommands, TOOLS }] = await Promise.all([import('../../shared/markdown.js'), import('../../mcp/tools.js')]);
  const block = agentsBlockMarkdown(data, { commands: projectCommands(data), mcpTools: TOOLS.map((t) => t.name) });
  if (!options.write) {
    await emit(block, { copy: options.copy }, stdout, stderr);
    return 0;
  }
  const { outsideNote, withClaudeImport, writeTarget } = await import('../../agent/setup.js');
  const file = options.file ? path.resolve(options.file) : path.join(root, 'AGENTS.md');
  const shown = path.relative(process.cwd(), file) || path.basename(file);
  /** A file of the project that is a link out of it is not written (it may be anyone's file). */
  const linkedOut = (abs: string): string | undefined => {
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined; // a file outside the project, named on purpose
    const target = writeTarget(root, rel);
    return target.outside ? outsideNote(path.relative(process.cwd(), abs) || rel, target.link ?? target.real) : undefined;
  };
  const refused = linkedOut(file);
  if (refused) {
    stderr.write(`${pc.red('✖')} ${refused}.\n`);
    return 1;
  }
  let updated: boolean;
  try {
    updated = writeIfChanged(file, (before) => upsertManagedBlock(before, block));
  } catch (error) {
    if (isFsError(error)) {
      stderr.write(`${pc.red('✖')} Cannot write ${shown}: ${errorCode(error)}\n`);
      return 2;
    }
    // Unbalanced markers: replacing or appending could duplicate the block or delete the text after it.
    stderr.write(`${pc.red('✖')} ${shown}: ${(error as Error).message}. Fix the markers by hand; nothing was written.
`);
    return 1;
  }
  stderr.write(updated ? `${pc.green('✔')} Updated the code-visualizer block in ${shown}\n` : `${pc.dim(`${shown} is up to date`)}\n`);
  if (options.claude) {
    const claude = path.join(path.dirname(file), 'CLAUDE.md');
    const name = path.basename(file);
    // CLAUDE.md that is a link to the file just written already holds the block: importing it would make it import itself.
    if (writeTarget(root, path.relative(root, claude)).real === writeTarget(root, path.relative(root, file)).real) {
      stderr.write(`${pc.dim(`CLAUDE.md is ${name} (a link): no import needed`)}\n`);
      return 0;
    }
    const claudeRefused = linkedOut(claude);
    if (claudeRefused) {
      stderr.write(`${pc.red('✖')} ${claudeRefused}.\n`);
      return 1;
    }
    let imported: boolean;
    try {
      imported = writeIfChanged(claude, (before) => (name === 'AGENTS.md' ? withClaudeImport(before) : before !== null && before.includes(`@${name}`) ? before : `${before ? `${before.replace(/\n*$/, '')}\n\n` : ''}@${name}\n`));
    } catch (error) {
      stderr.write(`${pc.red('✖')} Cannot write ${path.relative(process.cwd(), claude) || 'CLAUDE.md'}: ${isFsError(error) ? errorCode(error) : (error as Error).message}\n`);
      return 2;
    }
    if (imported) stderr.write(`${pc.green('✔')} CLAUDE.md imports ${name}\n`);
  }
  return 0;
}

const MARKDOWN_RE = /\.(md|mdc|markdown|txt)$/i;


/** Write `file` only when `next` changes it (mtime stays when nothing changed); true when written. */
function writeIfChanged(file: string, next: (before: string | null) => string): boolean {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const after = next(before);
  if (after === before) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  return true;
}

export const contextCommand: Command = {
  name: 'context',
  summary: 'Markdown context about a file or the project (for AI assistants & docs)',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('context', argv, {
        root: { type: 'string' },
        source: { type: 'boolean' },
        summary: { type: 'boolean' },
        agents: { type: 'boolean' },
        write: { type: 'boolean' },
        claude: { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        copy: { type: 'boolean', short: 'c' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'no-git': { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(CONTEXT_HELP);
      return 0;
    }
    const usage = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 2;
    };
    if ((values.write || values.claude) && !values.agents) return usage('--write and --claude belong to --agents.');
    if (values.agents && values.summary) return usage('Use either --agents or --summary.');
    if (values.claude && !values.write && !values.output) return usage('--claude needs --write (it edits CLAUDE.md next to the AGENTS.md it writes).');
    // --- agent-guardrails: the block goes into a Markdown file, never into the source file `context` usually takes ---
    if (values.agents) {
      const target = values.output ?? positionals[0];
      if (positionals.length > 1 || (positionals[0] && values.output)) return usage(`context --agents takes one target file (got ${[...positionals, ...(values.output ? [values.output] : [])].join(', ')}).`);
      if (positionals[0] && !values.write) return usage(`context --agents describes the whole project and takes no file; to write the block into ${positionals[0]}: --write ${positionals[0]}.`);
      if (target && !MARKDOWN_RE.test(target)) return usage(`The block goes into a Markdown file (AGENTS.md, CLAUDE.md, …), not ${target}.`);
    }
    if (!positionals[0] && !values.summary && !values.agents) {
      stderr.write(CONTEXT_HELP);
      return 2;
    }
    // The project around the current folder (as every command finds it), so a file's importers elsewhere count.
    const root = resolveProjectRoot(process.cwd(), values.root).root;
    try {
      const data = await getReport({ root, exclude: splitList(values.exclude), git: !values['no-git'], changes: false, history: false, persist: persistFrom(values['no-cache']), toolVersion: VERSION });
      // --- agent-guardrails: the managed AGENTS.md block ---
      if (values.agents) return await agentsMarkdown(data, root, { file: values.output ?? positionals[0], write: values.write || !!values.output, claude: values.claude, copy: values.copy }, stdout, stderr);
      let markdown: string;
      if (values.summary) markdown = projectSummaryMarkdown(data);
      else {
        const id = path.relative(root, path.resolve(process.cwd(), positionals[0])).split(path.sep).join('/');
        if (!data.files.some((f) => f.id === id)) {
          stderr.write(`${pc.red('✖')} "${positionals[0]}" is not an analyzed source file in ${root}.\n`);
          return 1;
        }
        markdown = fileContextMarkdown(data, id, { source: values.source });
      }
      return (await emit(markdown, values, stdout, stderr)) ? 0 : 2;
    } catch (error) {
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
  },
};

export const prCommand: Command = {
  name: 'pr',
  summary: 'Write a pull-request description for your current changes',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('pr', argv, {
        base: { type: 'string', short: 'b' },
        root: { type: 'string' },
        format: { type: 'string' },
        check: { type: 'boolean' },
        coverage: { type: 'string', multiple: true },
        output: { type: 'string', short: 'o' },
        copy: { type: 'boolean', short: 'c' },
        exclude: { type: 'string', short: 'e', multiple: true },
        'no-cache': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(PR_HELP);
      return 0;
    }
    const format = values.format ?? 'markdown';
    if (!['markdown', 'md', 'comment'].includes(format)) {
      stderr.write(`${pc.red('✖')} --format must be markdown or comment.\n`);
      return 2;
    }
    // Run from a sub-folder: the whole project is described (one line on stderr says so; stdout is the Markdown).
    let resolved;
    try {
      resolved = resolveProjectRoot(process.cwd(), explicitRoot(values, positionals));
    } catch (error) {
      if (error instanceof UsageError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 2;
      }
      throw error;
    }
    const root = resolved.root;
    const where = rootNotice(root, resolved.explicit);
    if (where) stderr.write(`${pc.dim(`ℹ ${where}`)}\n`);
    try {
      const { loadConfig } = await import('../../analyzer/config.js');
      const config = loadConfig(root);
      const data = await getReport({ root, base: values.base, exclude: splitList(values.exclude), coverage: coveragePaths(values.coverage), includeSource: false, history: false, compare: true, persist: persistFrom(values['no-cache']), toolVersion: VERSION });
      if (!data.changes || !data.changes.files.length) {
        // With --base the comparison was the one asked for: suggesting --base again would not help.
        const base = data.changes?.base ?? values.base;
        stderr.write(`${pc.yellow('!')} No changes found${base ? ` compared to ${base}` : ''}. Commit or edit something first${values.base ? '' : ', or pass --base'}.\n`);
        return 1;
      }
      let check: CheckResult | undefined;
      if (values.check) {
        if (config.error) stderr.write(`${pc.yellow('!')} Ignored the configuration — ${config.error}\n`);
        const { evaluateGates } = await import('../../analyzer/gates.js');
        const thresholds = config.error ? {} : (config.config.check ?? {});
        check = evaluateGates(data, thresholds, { mode: 'changed', delta: data.changes.delta, changedMode: thresholds.changedMode });
      }
      const { prCommentMarkdown, prMarkdownWithGates } = await import('../../report/formats/pr-comment.js');
      return (await emit(format === 'comment' ? prCommentMarkdown(data, { check }).replace(/\n$/, '') : prMarkdownWithGates(data, check), values, stdout, stderr)) ? 0 : 2;
    } catch (error) {
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      if (error instanceof UsageError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  },
};
