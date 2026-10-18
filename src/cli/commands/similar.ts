import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { CloneTokenStore, similarTo, SNIPPET_EXTS, symbolLines, type SimilarAnswer } from '../../analyzer/clones.js';
import { AnalyzeError } from '../../analyzer/errors.js';
import { fragmentLocation, fragmentName, reuseAdvice, similarityLabel } from '../../shared/clones.js';
import { resolveTarget } from '../../shared/query.js';
import { SOURCE_FILE_RE } from '../../shared/source-files.js';
import type { CloneFamily, ReportData, SimilarMatch } from '../../shared/types.js';
import { getReport } from '../engine.js';
import { createLinker, plural, type Linker } from '../format.js';
import { ANALYSIS_OPTIONS, analysisOptions, explicitRoot, isTTY, parseCommandArgs, Progress, resolveProjectRoot, STAGE_LABELS, UsageError, type AnalysisValues, type Command, type ProjectLocation } from '../shared.js';
import { exitOnBrokenPipe, toProjectPath } from './query.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer similar <file[:start-end]|symbol> [options]
  $ code-visualizer similar --stdin [options] < snippet.ts

  Does this already exist? Lists the existing functions that look like a snippet or
  like lines of a file, most similar first, with their signature and how many files
  use them — reuse one instead of writing another copy. Renamed variables and changed
  literals still match, and so does the other declaration style (function or arrow).
  For a file or range, also lists the copy-paste clones it is already part of, and
  which copy to keep.

${pc.bold('Options')}
      --stdin              Read the snippet from standard input
      --lang <ext>         Language of the --stdin snippet: ts, tsx (default), js, jsx, vue…
      --min <pct>          Minimum similarity, 0–100 (default: 80; 0.8 means 80)
      --limit <n>          Matches to list (default: 5)
      --root <dir>         Project root (default: the project around the current folder)
      --json               Machine-readable output
  -e, --exclude <glob>     Exclude files (gitignore syntax)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -q, --quiet              No progress output
  -h, --help               Show this help

  ${pc.dim('src/a.ts:40 stands for the function around line 40; src/a.ts#slugify or slugify for that function.')}
  ${pc.dim('Tune clone detection in code-visualizer.config.json:')}
  ${pc.dim('"clones": { "minTokens": 50, "minLines": 6, "minSimilarity": 0.5, "ignore": [...] }')}

${pc.bold('Examples')}
  $ npx code-visualizer similar src/ui/utils.ts:12-30
  $ npx code-visualizer similar slugify
  $ pbpaste | npx code-visualizer similar --stdin --min 60
`;

type Values = AnalysisValues & { root?: string; json?: boolean; stdin?: boolean; lang?: string; min?: string; limit?: string; help?: boolean };

/** `src/a.ts:12-30` / `src/a.ts:12` / `src/a.ts` → file and lines. */
export function parseLocation(input: string): { file: string; start?: number; end?: number } {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(input);
  if (!m) return { file: input };
  const start = Number(m[2]);
  const end = m[3] !== undefined ? Number(m[3]) : undefined;
  return { file: m[1], start: Math.min(start, end ?? start), end: end === undefined ? undefined : Math.max(start, end) };
}

function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => (text += chunk));
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

/** A file, `file:lines`, `file#Symbol` or a symbol name as a file and its lines (or an error message). */
function locate(data: ReportData, location: ProjectLocation, input: string): { file: string; start?: number; end?: number } | { error: string; suggestions: string[] } {
  const parsed = parseLocation(input);
  const file = toProjectPath(location, parsed.file);
  // A file of the analysis, or a source file on disk (written after it).
  if (data.files.some((f) => f.id === file) || (SOURCE_FILE_RE.test(file) && fs.existsSync(path.join(location.root, file)))) return { ...parsed, file };
  const r = resolveTarget(data, toProjectPath(location, parsed.start === undefined ? input : parsed.file));
  const lines = r.target?.type === 'symbol' ? symbolLines(data, r.target.id) : undefined;
  if (lines) return lines;
  if (r.target?.type === 'file') return { ...parsed, file: r.target.id };
  return { error: `Nothing in ${path.basename(location.root)} matches "${input}" (files and symbols were searched).`, suggestions: r.suggestions };
}

/** The language of a --stdin snippet as an extension (`ts` → `.ts`), or undefined when it is not one. */
export function snippetExt(lang: string): string | undefined {
  const ext = `.${lang.trim().toLowerCase().replace(/^\./, '')}`;
  return SNIPPET_EXTS.includes(ext) ? ext : undefined;
}

/** "→ Import slugify from src/lib/strings.ts instead …" — which copy to keep, when there are whole copies. */
function adviceLine(answer: SimilarAnswer): string | undefined {
  const q = answer.query;
  const advice = reuseAdvice(q, answer.matches);
  if (!advice) return undefined;
  const used = (x: { exported?: boolean; importers?: number }): string => (x.exported ? (x.importers ? `exported · used in ${plural(x.importers, 'file')}` : 'exported') : 'not exported');
  if (advice.kind === 'keep-query') {
    const copies = advice.copies.slice(0, 3).map((m) => `${pc.bold(m.name)} in ${m.file}`).join(', ');
    return `Keep ${pc.bold(q.name!)} (${used(q)}): replace ${copies}${advice.copies.length > 3 ? ` and ${advice.copies.length - 3} more` : ''} with ${advice.copies.length === 1 ? 'an import' : 'imports'} of it.`;
  }
  const keep = advice.keep!;
  const instead = q.file ? 'instead of keeping this copy' : 'instead of writing another copy';
  return advice.kind === 'import' ? `Import ${pc.bold(keep.name)} from ${keep.file} ${instead}.` : `Reuse ${pc.bold(keep.name)} from ${keep.file} (export it) ${instead}.`;
}

/** The similarity of a match as it is printed (`80%`), the same number `--min` is compared with. */
export function shownPercent(m: Pick<SimilarMatch, 'similarity' | 'contained'>): number {
  return Math.round(Math.max(m.similarity, m.contained ?? 0) * 100);
}

function matchLine(m: SimilarMatch, link: Linker, width: number): string {
  const pct = similarityLabel(Math.max(m.similarity, m.contained ?? 0));
  const color = m.similarity >= 0.9 || (m.contained ?? 0) >= 0.9 ? pc.green : m.similarity >= 0.7 ? pc.yellow : pc.dim;
  const used = m.exported ? (m.importers ? `exported · used in ${plural(m.importers, 'file')}` : 'exported') : 'not exported';
  const contained = m.contained ? pc.dim(` (the snippet is inside it; ${similarityLabel(m.similarity)} of it)`) : '';
  return `  ${color(pct.padStart(4))}  ${m.signature.length > width ? `${m.signature.slice(0, width - 1)}…` : m.signature.padEnd(width)}  ${link(m.file, m.line)}  ${pc.dim(used)}${contained}`;
}

function copiesLines(copies: CloneFamily[], file: string | undefined, link: Linker): string[] {
  const lines: string[] = [];
  for (const fam of copies.slice(0, 5)) {
    const others = fam.fragments.filter((f) => f.file !== file);
    const shown = (others.length ? others : fam.fragments).slice(0, 4);
    // The share of the declarations copied (another measure than the matches' similarity above).
    lines.push(`  ${pc.yellow('≈')} ${shown.map((f) => `${fragmentName(f)} ${link(f.file, f.start, fragmentLocation(f))}`).join(pc.dim(' · '))}  ${pc.dim(`${plural(fam.tokens, 'shared token')}${fam.coChanges ? ` · changed together ${plural(fam.coChanges, 'time')}` : ''}`)}`);
  }
  if (copies.length > 5) lines.push(pc.dim(`  … ${copies.length - 5} more clone families`));
  return lines;
}

export const similarCommand: Command = {
  name: 'similar',
  summary: 'Does this already exist? Functions similar to a snippet or lines of a file',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('similar', argv, { ...ANALYSIS_OPTIONS, json: { type: 'boolean' }, stdin: { type: 'boolean' }, lang: { type: 'string' }, min: { type: 'string' }, limit: { type: 'string' } });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const values = parsed.values as Values;
    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    const usage = (reason: string): number => {
      stderr.write(`${pc.red('✖')} ${reason}\n${HELP}`);
      return 2;
    };
    const args = parsed.positionals;
    if (values.stdin ? args.length > 0 : args.length !== 1) return usage(values.stdin ? 'similar --stdin reads the snippet from standard input: pass no file.' : 'similar needs one file, file:lines or symbol (or --stdin).');
    const given = values.min === undefined ? 80 : values.min.trim() ? Number(values.min) : NaN;
    if (!Number.isFinite(given) || given < 0 || given > 100) return usage('--min must be a percentage between 0 and 100.');
    // `--min 0.8` (the MCP tool's scale) means 80%.
    const min = given > 0 && given < 1 ? Math.round(given * 100) : given;
    const limit = values.limit === undefined ? 5 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) return usage('--limit must be a positive whole number.');
    if (values.lang && !values.stdin) return usage('--lang applies to --stdin snippets.');
    const lang = values.lang === undefined ? undefined : snippetExt(values.lang);
    if (values.lang !== undefined && !lang) return usage(`--lang must be one of ${SNIPPET_EXTS.map((e) => e.slice(1)).join(', ')}.`);

    // The positional is the file or symbol: the root comes from --root or the folder it runs in.
    const resolved = resolveProjectRoot(process.cwd(), explicitRoot(values, []));
    if (resolved.fallback) {
      stderr.write(`${pc.red('✖')} Not inside a project (no package.json or git repository here or above). cd into one, or pass --root <dir>.\n`);
      return 2;
    }
    const location: ProjectLocation = { root: resolved.root, gitRoot: resolved.gitRoot };
    exitOnBrokenPipe(stdout);
    let options;
    try {
      options = analysisOptions({ ...values, root: location.root, depth: undefined }, []);
    } catch (error) {
      if (error instanceof UsageError) return usage(error.message);
      throw error;
    }
    if (values.stdin && process.stdin.isTTY) stderr.write(pc.dim('Reading the snippet from standard input — paste it, then press Ctrl-D.\n'));
    const snippet = values.stdin ? await readStdin() : undefined;
    const progress = new Progress(stderr, isTTY(stderr) && !values.quiet && !values.json);
    let data: ReportData;
    try {
      data = await getReport({ ...options, includeSource: false, history: false, changes: false, onProgress: (stage) => progress.update(STAGE_LABELS[stage]) });
    } catch (error) {
      progress.stop();
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      throw error;
    } finally {
      progress.stop();
    }
    const where = snippet === undefined ? locate(data, location, args[0]) : undefined;
    if (where && 'error' in where) {
      if (values.json) stdout.write(`${JSON.stringify({ error: 'not-found', input: args[0], suggestions: where.suggestions }, null, 2)}\n`);
      stderr.write(`${pc.red('✖')} ${where.error}\n`);
      if (where.suggestions.length) stderr.write(`  Did you mean: ${where.suggestions.map((s) => pc.cyan(s)).join(', ')}?\n`);
      return 1;
    }
    const found = await similarTo(data, new CloneTokenStore(location.root, options.persist !== false), {
      snippet,
      lang,
      ...(where && !('error' in where) ? where : {}),
      // Judged like it is shown: a match listed as 80% passes --min 80 (0.796 rounds to 80%).
      minSimilarity: Math.max(0, (min - 0.5) / 100),
      limit,
    });
    const answer = { ...found, matches: found.matches.filter((m) => shownPercent(m) >= min) };
    if (answer.error === 'not-found') {
      if (values.json) stdout.write(`${JSON.stringify({ error: 'not-found', input: args[0] }, null, 2)}\n`);
      stderr.write(`${pc.red('✖')} Cannot read ${answer.query.file}.\n`);
      return 1;
    }
    if (answer.error === 'out-of-range') {
      if (values.json) stdout.write(`${JSON.stringify({ error: 'out-of-range', input: args[0], lines: answer.query.lines }, null, 2)}\n`);
      stderr.write(`${pc.red('✖')} ${answer.query.file} has ${plural(answer.query.lines ?? 0, 'line')}: line ${answer.query.start} is not in it.\n`);
      return 2;
    }
    if (values.json) {
      stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
      return answer.matches.length || answer.copies.length ? 0 : 1;
    }
    const link = createLinker({ root: location.root, stream: stdout });
    const out = (line = ''): void => void stdout.write(`${line}\n`);
    const q = answer.query;
    const what = q.file ? `${q.name ? `${pc.bold(q.name)} ` : ''}${link(q.file, q.start, q.start ? `${q.file}:${q.start}-${q.end}` : q.file)}` : pc.bold('the snippet');
    out();
    if (answer.error === 'too-short') {
      if (!q.tokens) out(`  ${pc.yellow('!')} ${q.file ? 'These lines have' : 'The snippet has'} no code to compare (imports and comments are left out): pass a function.`);
      else out(`  ${pc.yellow('!')} ${q.file ? 'These lines are' : 'The snippet is'} too short to compare (${plural(q.tokens, 'token')}): pass a whole function.`);
      out();
      return 1;
    }
    out(`  Similar to ${what} ${pc.dim(`(${plural(q.tokens, 'token')}, at least ${min}% similar)`)}`);
    out();
    const width = Math.min(60, Math.max(20, ...answer.matches.map((m) => m.signature.length)));
    if (answer.matches.length) for (const m of answer.matches) out(matchLine(m, link, width));
    else out(`  ${pc.dim(`No existing function is ${min}% similar${min > 40 ? ` — try --min ${Math.max(30, min - 20)}` : ''}.`)}`);
    if (answer.copies.length) {
      out();
      out(`  ${pc.bold('Already copied')} ${pc.dim(`(${plural(answer.copies.length, 'clone family', 'clone families')} with ${q.start ? 'these lines' : 'this file'})`)}`);
      for (const line of copiesLines(answer.copies, q.file, link)) out(line);
    }
    const advice = adviceLine(answer);
    if (advice) {
      out();
      out(`  ${pc.green('→')} ${advice}`);
    }
    out();
    return answer.matches.length || answer.copies.length ? 0 : 1;
  },
};
