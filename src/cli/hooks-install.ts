/**
 * Installing the quality gates as git hooks — next to whatever already runs them: husky, lefthook,
 * simple-git-hooks, or plain git hooks (respecting core.hooksPath).
 *
 * Every edit sits between `# code-visualizer:start <hook>` and `# code-visualizer:end <hook>` markers (in
 * shell and YAML files), or is one `CODE_VISUALIZER_HOOK=<hook> …` segment of a one-line command
 * (simple-git-hooks), so installing twice changes nothing and uninstalling restores the files exactly.
 * An existing plain git hook is kept: it is renamed to `<hook>.cv-chained` and runs first.
 *
 * Planning is pure (files in, edits out); `applyPlan` writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { realPathOf } from '../agent/setup.js';

export type HookName = 'pre-commit' | 'pre-push';
export const HOOK_NAMES: readonly HookName[] = ['pre-commit', 'pre-push'];
export type HookManager = 'husky' | 'lefthook' | 'simple-git-hooks' | 'git';
export const HOOK_MANAGERS: readonly HookManager[] = ['husky', 'lefthook', 'simple-git-hooks', 'git'];

export const MARK_START = '# code-visualizer:start';
export const MARK_END = '# code-visualizer:end';
/** On the start marker when the install added a final newline to the file (removed again on uninstall). */
const EOL_FLAG = '+eol';
export const CHAINED_SUFFIX = '.cv-chained';
const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'];
const SIMPLE_GIT_HOOKS_FILES = ['.simple-git-hooks.json', 'simple-git-hooks.json'];

export interface HooksContext {
  /** The analyzed project (absolute). */
  root: string;
  /** Top of the repository's working tree (absolute). */
  top: string;
  /** Where git runs hooks from (absolute; `git rev-parse --git-path hooks`, honours core.hooksPath). */
  hooksDir: string;
  /** `core.hooksPath` when set. */
  hooksPath?: string;
  /** Whether `code-visualizer test` exists (pre-push then runs the affected tests too). */
  testCommand?: boolean;
  /** The hooks folder is shared by every worktree of the repository (installed from a linked worktree). */
  sharedHooks?: boolean;
  /** The repository's git directory (the common one of linked worktrees): its hooks/ may be written too. */
  gitDir?: string;
  /**
   * Where core.hooksPath comes from when it makes the hooks folder global (`global`, `system`, or `outside`:
   * a folder outside the repository) — see `globalHooks` in src/cli/commands/hooks.ts.
   */
  globalHooks?: { scope: string; origin?: string };
  /** Write into a global hooks folder anyway (`--global-hooks`). */
  allowGlobalHooks?: boolean;
}

export interface FileEdit {
  file: string;
  /** null: the file does not exist (before) / is deleted (after). */
  before: string | null;
  after: string | null;
  /** Mode for new files (hook scripts are executable). */
  mode?: number;
}

export interface HookPlan {
  manager: HookManager;
  hooks: HookName[];
  /** The hooks this plan actually changes (installed where they were not, refreshed, or removed). */
  changed: HookName[];
  edits: FileEdit[];
  /** Existing hooks moved aside — before the edits (install). */
  renames: { from: string; to: string }[];
  /** Chained hooks moved back — after the edits (uninstall). */
  restores?: { from: string; to: string }[];
  /** What the user still has to do or know (e.g. run `npx simple-git-hooks`). */
  notes: string[];
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const exists = (file: string): boolean => fs.existsSync(file);
const posix = (p: string): string => p.split(path.sep).join('/');

/** The project folder relative to the repository top ('' when it is the top). */
function projectDir(ctx: HooksContext): string {
  const rel = posix(path.relative(ctx.top, ctx.root));
  return rel.startsWith('..') ? '' : rel;
}

/** POSIX shell quoting for a word that is not plain. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/* -------------------------------------------------------------------------- */
/*                                  Detection                                 */
/* -------------------------------------------------------------------------- */

function lefthookFile(ctx: HooksContext): string | undefined {
  for (const dir of [ctx.top, ctx.root]) for (const name of LEFTHOOK_FILES) if (exists(path.join(dir, name))) return path.join(dir, name);
  return undefined;
}

function huskyDir(ctx: HooksContext): string | undefined {
  // husky ≥ 9 points core.hooksPath at `.husky/_`; its hook scripts live one folder up.
  if (ctx.hooksPath && /(^|[\\/])\.husky([\\/]_)?[\\/]?$/.test(ctx.hooksPath)) {
    const abs = path.resolve(ctx.top, ctx.hooksPath);
    return path.basename(abs) === '_' ? path.dirname(abs) : abs;
  }
  for (const dir of [ctx.root, ctx.top]) if (exists(path.join(dir, '.husky'))) return path.join(dir, '.husky');
  return undefined;
}

/** Where simple-git-hooks is configured: a package.json with the key, or its own JSON file. */
function simpleGitHooksFile(ctx: HooksContext): string | undefined {
  for (const dir of [ctx.root, ctx.top]) {
    for (const name of SIMPLE_GIT_HOOKS_FILES) if (exists(path.join(dir, name))) return path.join(dir, name);
    const pkg = path.join(dir, 'package.json');
    const text = read(pkg);
    if (text && /"simple-git-hooks"\s*:/.test(text)) return pkg;
  }
  return undefined;
}

/** Hook managers set up in this repository, most specific first ('git' is always possible). */
export function detectManagers(ctx: HooksContext): HookManager[] {
  const found: HookManager[] = [];
  if (huskyDir(ctx)) found.push('husky');
  if (lefthookFile(ctx)) found.push('lefthook');
  if (simpleGitHooksFile(ctx)) found.push('simple-git-hooks');
  found.push('git');
  return found;
}

/* -------------------------------------------------------------------------- */
/*                                  Commands                                  */
/* -------------------------------------------------------------------------- */

/** The code-visualizer commands a hook runs (arguments after the binary). */
export function hookCommands(hook: HookName, ctx: HooksContext): string[][] {
  const dir = projectDir(ctx);
  const rootArg = dir ? [dir] : [];
  if (hook === 'pre-commit') return [['check', '--staged', '--quiet-pass', ...rootArg]];
  // What is pushed is committed: uncommitted edits (a local it.only while debugging) never block a push.
  const commands = [['check', '--changed', '--committed', '--quiet-pass', ...rootArg]];
  if (ctx.testCommand) commands.push(['test', '--push', ...rootArg]);
  return commands;
}

/** Local installs of the CLI, relative to the repository top (the cwd of git hooks). */
function localBins(ctx: HooksContext): string[] {
  const dir = projectDir(ctx);
  return [...new Set([dir && `./${dir}/node_modules/.bin/code-visualizer`, './node_modules/.bin/code-visualizer'].filter(Boolean) as string[])];
}

/** One shell command line for managers that take a single command (lefthook `run:`, simple-git-hooks). */
export function hookCommandLine(hook: HookName, ctx: HooksContext): string {
  const local = localBins(ctx).find((bin) => exists(path.resolve(ctx.top, bin)));
  const bin = local ? shellWord(local) : 'npx --no-install code-visualizer';
  return hookCommands(hook, ctx)
    .map((args) => `CODE_VISUALIZER_HOOK=${hook} ${bin} ${args.map(shellWord).join(' ')}`)
    .join(' && ');
}

/** The shell lines inside the markers (husky and plain git hooks): find the CLI, run the gates. */
function shellBody(hook: HookName, ctx: HooksContext, chained?: string): string[] {
  const action = hook === 'pre-commit' ? 'commit' : 'push';
  const push = hook === 'pre-push';
  const lines = [`# Quality gates before every ${action} (code-visualizer hooks). Skip once: CODE_VISUALIZER_SKIP=1 git ${action} …`];
  // git lists the refs being pushed on stdin: kept for the hook that runs first; deleting branches is not judged.
  if (push) lines.push('cv_refs=; [ -t 0 ] || cv_refs=$(cat)');
  if (chained) {
    lines.push(`cv_chained="$(dirname -- "$0")/${chained}"`);
    if (push) lines.push('if [ -x "$cv_chained" ]; then { [ -z "$cv_refs" ] || printf \'%s\\n\' "$cv_refs"; } | "$cv_chained" "$@" || exit $?; fi');
    else lines.push('if [ -x "$cv_chained" ]; then "$cv_chained" "$@" || exit $?; fi');
  }
  const bins = localBins(ctx);
  lines.push(`cv_bin=${shellWord(bins[0])}`);
  for (const bin of bins.slice(1)) lines.push(`[ -x "$cv_bin" ] || cv_bin=${shellWord(bin)}`);
  lines.push('[ -x "$cv_bin" ] || cv_bin=$(command -v code-visualizer || true)');
  if (push) {
    lines.push('if [ -n "$cv_refs" ] && ! printf \'%s\\n\' "$cv_refs" | grep -qv \'^(delete) \'; then');
    lines.push('  : # only deletes branches: nothing to check');
    lines.push('elif [ -n "$cv_bin" ]; then');
  } else lines.push('if [ -n "$cv_bin" ]; then');
  for (const args of hookCommands(hook, ctx)) lines.push(`  CODE_VISUALIZER_HOOK=${hook} "$cv_bin" ${args.map(shellWord).join(' ')} || exit $?`);
  lines.push('else');
  lines.push(`  echo "code-visualizer is not installed: its ${hook} checks were skipped" >&2`);
  lines.push('fi');
  return lines;
}

/* -------------------------------------------------------------------------- */
/*                               Marked blocks                                */
/* -------------------------------------------------------------------------- */

interface Block {
  /** Line indexes of the start and end markers. */
  start: number;
  end: number;
  eol: boolean;
}

const startRe = (hook: HookName): RegExp => new RegExp(`^\\s*${MARK_START} ${hook}(\\s+\\${EOL_FLAG})?\\s*$`);
const endRe = (hook: HookName): RegExp => new RegExp(`^\\s*${MARK_END} ${hook}\\s*$`);

/** The marked block of `hook` in a file's lines. */
function findBlock(lines: string[], hook: HookName): Block | undefined {
  const sRe = startRe(hook);
  const start = lines.findIndex((l) => sRe.test(l));
  if (start < 0) return undefined;
  const eRe = endRe(hook);
  const end = lines.findIndex((l, i) => i > start && eRe.test(l));
  if (end < 0) return undefined;
  return { start, end, eol: !!sRe.exec(lines[start])?.[1] };
}

export function hasBlock(text: string | null, hook: HookName): boolean {
  return !!text && !!findBlock(text.split('\n'), hook);
}

/** A script's last command ends it (`exit 0`, `exec npx lint-staged`): a block after it would never run. */
const ENDS_SCRIPT = /^\s*(?:exit(?:\s|;|$)|exec\s)/;

/**
 * `text` with the block of `hook` replaced by `body` (indented), or appended at the end — before a final
 * `exit` / `exec` line of a shell script (`script`), which would end the script before the block runs.
 */
function upsertBlock(text: string, hook: HookName, body: string[], indent = '', script = false): string {
  const lines = text.split('\n');
  const found = findBlock(lines, hook);
  if (found) {
    const flag = found.eol ? ` ${EOL_FLAG}` : '';
    const block = [`${indent}${MARK_START} ${hook}${flag}`, ...body.map((l) => (l ? `${indent}${l}` : l)), `${indent}${MARK_END} ${hook}`];
    return [...lines.slice(0, found.start), ...block, ...lines.slice(found.end + 1)].join('\n');
  }
  if (script) {
    let last = lines.length - 1;
    while (last >= 0 && !isContent(lines[last])) last--;
    if (last >= 0 && ENDS_SCRIPT.test(lines[last])) {
      const block = [`${indent}${MARK_START} ${hook}`, ...body.map((l) => (l ? `${indent}${l}` : l)), `${indent}${MARK_END} ${hook}`];
      return [...lines.slice(0, last), ...block, ...lines.slice(last)].join('\n');
    }
  }
  const addEol = text.length > 0 && !text.endsWith('\n');
  const block = [`${indent}${MARK_START} ${hook}${addEol ? ` ${EOL_FLAG}` : ''}`, ...body.map((l) => (l ? `${indent}${l}` : l)), `${indent}${MARK_END} ${hook}`];
  return `${text}${addEol ? '\n' : ''}${block.join('\n')}\n`;
}

/** `text` without the block of `hook` — byte for byte what it was before the install. */
function removeBlock(text: string, hook: HookName): string {
  const lines = text.split('\n');
  const found = findBlock(lines, hook);
  if (!found) return text;
  const rest = [...lines.slice(0, found.start), ...lines.slice(found.end + 1)].join('\n');
  return found.eol && rest.endsWith('\n') ? rest.slice(0, -1) : rest;
}

/* -------------------------------------------------------------------------- */
/*                                  Managers                                  */
/* -------------------------------------------------------------------------- */

const SHEBANG = '#!/bin/sh\n';

function huskyEdits(ctx: HooksContext, hooks: HookName[], install: boolean): Omit<HookPlan, 'manager' | 'hooks'> {
  const dir = huskyDir(ctx) ?? path.join(ctx.top, '.husky');
  const edits: FileEdit[] = [];
  const changed: HookName[] = [];
  for (const hook of hooks) {
    const file = path.join(dir, hook);
    const before = read(file);
    if (install) {
      // husky ≤ 8 runs the files directly: a new one needs a shebang.
      const fresh = before ?? (exists(path.join(dir, '_', 'husky.sh')) ? SHEBANG : '');
      const after = upsertBlock(fresh, hook, shellBody(hook, ctx), '', true);
      // An existing file keeps its mode (husky ≥ 9 runs them with sh): uninstall leaves no mode change behind.
      if (after !== before) {
        edits.push({ file, before, after, ...(before === null ? { mode: 0o755 } : {}) });
        changed.push(hook);
      }
    } else if (before !== null && hasBlock(before, hook)) {
      const after = removeBlock(before, hook);
      // A file that held nothing but the block was created by the install.
      edits.push({ file, before, after: after.trim() && after !== SHEBANG ? after : null });
      changed.push(hook);
    }
  }
  const notes: string[] = [];
  // husky runs `.husky/*` only once it set core.hooksPath (its `prepare` script does that on install).
  if (install && edits.length && !(ctx.hooksPath && /(^|[\\/])\.husky([\\/]_)?[\\/]?$/.test(ctx.hooksPath))) notes.push('husky is not active in this clone (core.hooksPath is not set): run `npx husky` (or npm install) so git runs .husky/ hooks.');
  return { edits, renames: [], notes, changed };
}

/**
 * A hook that cannot run under another name: husky v4 and yorkie generate hooks that look up their
 * configuration by the file name (`basename "$0"`), so chaining by renaming would silently disable them.
 */
function needsItsName(text: string): boolean {
  return /\bhusky\b|\byorkie\b/i.test(text) || /basename\s+(?:--\s+)?"?\$\{?0\}?/.test(text);
}

/** husky v4 and yorkie keep their hooks in package.json ("husky": { "hooks": … }, "gitHooks"). */
function packageHookConfig(ctx: HooksContext): string | undefined {
  for (const dir of [ctx.root, ctx.top]) {
    try {
      const pkg = JSON.parse(read(path.join(dir, 'package.json')) ?? '') as { husky?: { hooks?: unknown }; gitHooks?: unknown };
      if (pkg.husky && typeof pkg.husky === 'object' && pkg.husky.hooks) return '"husky": { "hooks": … }';
      if (pkg.gitHooks && typeof pkg.gitHooks === 'object') return '"gitHooks"';
    } catch {
      /* no or invalid package.json */
    }
  }
  return undefined;
}

function gitEdits(ctx: HooksContext, hooks: HookName[], install: boolean): Omit<HookPlan, 'manager' | 'hooks'> {
  const edits: FileEdit[] = [];
  const renames: HookPlan['renames'] = [];
  const restores: HookPlan['renames'] = [];
  const notes: string[] = [];
  const changed: HookName[] = [];
  const shown = (file: string): string => {
    const r = posix(path.relative(ctx.top, file));
    return r.startsWith('..') || path.isAbsolute(r) ? file : r;
  };
  const configured = install ? packageHookConfig(ctx) : undefined;
  for (const hook of hooks) {
    const file = path.join(ctx.hooksDir, hook);
    const chained = path.join(ctx.hooksDir, `${hook}${CHAINED_SUFFIX}`);
    const before = read(file);
    if (install) {
      if (before !== null && hasBlock(before, hook)) {
        // Installed before: refresh the block in place (chaining stays as it is).
        const after = upsertBlock(before, hook, shellBody(hook, ctx, exists(chained) ? path.basename(chained) : undefined));
        if (after !== before) {
          edits.push({ file, before, after });
          changed.push(hook);
        }
        continue;
      }
      if (before !== null && exists(chained)) {
        notes.push(`${shown(chained)} already exists: ${hook} was left alone.`);
        continue;
      }
      // Generated hooks that find their configuration by their file name stop working when renamed.
      if ((before !== null && needsItsName(before)) || configured) {
        const run = hookCommands(hook, ctx).map((args) => `code-visualizer ${args.map(shellWord).join(' ')}`).join(' && ');
        notes.push(`${before !== null && needsItsName(before) ? `${shown(file)} is generated by a hook manager (husky v4 or yorkie)` : `package.json configures hooks (${configured})`}: ${hook} was left alone — add \`${run}\` to that configuration yourself.`);
        continue;
      }
      // An existing hook keeps running first, under another name.
      if (before !== null) renames.push({ from: file, to: chained });
      edits.push({ file, before: null, after: upsertBlock(SHEBANG, hook, shellBody(hook, ctx, before !== null ? path.basename(chained) : undefined)), mode: 0o755 });
      changed.push(hook);
    } else if (before !== null && hasBlock(before, hook)) {
      const after = removeBlock(before, hook);
      const ours = !after.trim() || after === SHEBANG;
      edits.push({ file, before, after: ours ? null : after });
      if (ours && exists(chained)) restores.push({ from: chained, to: file });
      changed.push(hook);
    }
  }
  if (install && changed.length && ctx.sharedHooks) notes.push(`${shown(ctx.hooksDir)} is shared by every worktree of this repository: the hooks run in all of them.`);
  return { edits, renames, restores, notes, changed };
}

/* --------------------------------- lefthook -------------------------------- */

const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;
const isContent = (line: string): boolean => !!line.trim() && !line.trim().startsWith('#');

/** A YAML single-quoted scalar. */
const yamlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * lefthook.yml with our command under `<hook>: commands:` — by plain line edits (no YAML library): into
 * an existing `commands:` map, as a `commands:` map of an existing hook, or as a new hook at the end.
 */
export function lefthookInsert(text: string, hook: HookName, run: string): string | undefined {
  const lines = text.split('\n');
  const existing = findBlock(lines, hook);
  // The hook's top-level key, block style (`pre-commit:` or `"pre-commit":`).
  const hookLine = lines.findIndex((l) => new RegExp(`^(['"]?)${hook}\\1:\\s*(#.*)?$`).test(l));
  // A key with an inline value (`pre-commit: {}`): a second key would be a duplicate, which lefthook rejects.
  if (!existing && hookLine < 0 && lines.some((l) => new RegExp(`^(['"]?)${hook}\\1\\s*:`).test(l))) return undefined;
  const step = (() => {
    const first = lines.find((l, i) => i > 0 && isContent(l) && indentOf(l) > 0);
    return first ? indentOf(first) : 2;
  })();
  const pad = (n: number): string => ' '.repeat(n);
  if (existing) {
    // Re-install: keep the block where it is, refresh the command.
    const inner = lines.slice(existing.start + 1, existing.end);
    const runLine = inner.findIndex((l) => /^\s*run:/.test(l));
    if (runLine < 0) return undefined;
    inner[runLine] = `${pad(indentOf(inner[runLine]))}run: ${yamlString(run)}`;
    return [...lines.slice(0, existing.start + 1), ...inner, ...lines.slice(existing.end)].join('\n');
  }
  if (hookLine < 0) {
    const block = [`${MARK_START} ${hook}`, `${hook}:`, `${pad(step)}commands:`, `${pad(step * 2)}code-visualizer:`, `${pad(step * 3)}run: ${yamlString(run)}`, `${MARK_END} ${hook}`];
    const addEol = text.length > 0 && !text.endsWith('\n');
    if (addEol) block[0] += ` ${EOL_FLAG}`;
    return `${text}${addEol ? '\n' : ''}${block.join('\n')}\n`;
  }
  // The hook's own lines: everything indented below its key.
  let end = hookLine + 1;
  while (end < lines.length && (!isContent(lines[end]) || indentOf(lines[end]) > 0)) end++;
  const child = lines.slice(hookLine + 1, end).find((l) => isContent(l));
  const childIndent = child ? indentOf(child) : step;
  const commandsLine = lines.findIndex((l, i) => i > hookLine && i < end && indentOf(l) === childIndent && /^\s*commands:\s*(#.*)?$/.test(l));
  if (commandsLine < 0) {
    if (lines.slice(hookLine + 1, end).some((l) => indentOf(l) === childIndent && /^\s*commands:/.test(l))) return undefined; // `commands: {…}` inline
    const block = [`${pad(childIndent)}${MARK_START} ${hook}`, `${pad(childIndent)}commands:`, `${pad(childIndent + step)}code-visualizer:`, `${pad(childIndent + step * 2)}run: ${yamlString(run)}`, `${pad(childIndent)}${MARK_END} ${hook}`];
    return [...lines.slice(0, hookLine + 1), ...block, ...lines.slice(hookLine + 1)].join('\n');
  }
  const command = lines.slice(commandsLine + 1, end).find((l) => isContent(l));
  const commandIndent = command && indentOf(command) > childIndent ? indentOf(command) : childIndent + step;
  const block = [`${pad(commandIndent)}${MARK_START} ${hook}`, `${pad(commandIndent)}code-visualizer:`, `${pad(commandIndent + step)}run: ${yamlString(run)}`, `${pad(commandIndent)}${MARK_END} ${hook}`];
  return [...lines.slice(0, commandsLine + 1), ...block, ...lines.slice(commandsLine + 1)].join('\n');
}

function lefthookEdits(ctx: HooksContext, hooks: HookName[], install: boolean): Omit<HookPlan, 'manager' | 'hooks'> {
  const file = lefthookFile(ctx) ?? path.join(ctx.top, 'lefthook.yml');
  const before = read(file);
  const notes: string[] = [];
  const changed: HookName[] = [];
  let text = before ?? '';
  for (const hook of hooks) {
    const next = install ? lefthookInsert(text, hook, hookCommandLine(hook, ctx)) : removeBlock(text, hook);
    if (next === undefined) notes.push(`Could not place the ${hook} command in ${path.basename(file)} (inline YAML): add a "code-visualizer" command running \`${hookCommandLine(hook, ctx)}\` yourself.`);
    else if (next !== text) {
      text = next;
      changed.push(hook);
    }
  }
  if (install && changed.length) notes.push('lefthook reads its configuration on every run; if its hooks are not installed yet, run `npx lefthook install`.');
  const edits: FileEdit[] = text === (before ?? '') ? [] : [{ file, before, after: text }];
  return { edits, renames: [], notes, changed };
}

/* ----------------------------- simple-git-hooks ---------------------------- */

const SEGMENT_SEP = ' && ';
const isOurSegment = (segment: string): boolean => /^CODE_VISUALIZER_HOOK=(pre-commit|pre-push) /.test(segment.trim());

/** A simple-git-hooks command with ours appended (or without it, for uninstall). */
export function simpleHookValue(current: string | undefined, ours: string | undefined): string | undefined {
  const kept = (current ?? '').split(SEGMENT_SEP).filter((s) => s && !isOurSegment(s));
  const segments = [...kept, ...(ours ? [ours] : [])];
  return segments.length ? segments.join(SEGMENT_SEP) : undefined;
}

function detectIndent(text: string): string | number {
  const m = /^[ \t]+(?=")/m.exec(text);
  return m ? (m[0].includes('\t') ? '\t' : m[0].length) : 2;
}

function simpleGitHooksEdits(ctx: HooksContext, hooks: HookName[], install: boolean): Omit<HookPlan, 'manager' | 'hooks'> {
  const file = simpleGitHooksFile(ctx) ?? path.join(ctx.root, 'package.json');
  const before = read(file);
  const notes: string[] = [];
  if (before === null) return { edits: [], renames: [], notes: [`${path.basename(file)} not found.`], changed: [] };
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(before) as Record<string, unknown>;
  } catch {
    return { edits: [], renames: [], notes: [`${path.basename(file)} is not valid JSON: nothing changed.`], changed: [] };
  }
  const isPackage = path.basename(file) === 'package.json';
  const config = (isPackage ? json['simple-git-hooks'] : json) as Record<string, unknown> | undefined;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { edits: [], renames: [], notes: [`No "simple-git-hooks" configuration in ${path.basename(file)}.`], changed: [] };
  const eol = before.endsWith('\n') ? '\n' : '';
  const indent = detectIndent(before);
  // Re-serializing is exact only for files written the way JSON.stringify writes them (npm does).
  const canonical = `${JSON.stringify(json, null, indent)}${eol}` === before;
  let text = before;
  const changed: HookName[] = [];
  for (const hook of hooks) {
    const current = typeof config[hook] === 'string' ? (config[hook] as string) : undefined;
    const next = simpleHookValue(current, install ? hookCommandLine(hook, ctx) : undefined);
    if (next === current) continue;
    if (canonical) {
      if (next === undefined) delete config[hook];
      else config[hook] = next;
      text = `${JSON.stringify(json, null, indent)}${eol}`;
      changed.push(hook);
      continue;
    }
    // Hand-formatted: replace the existing value in place (any spacing around the colon). A function
    // replacement keeps `$$`, `$&`… in commands literal.
    const replaced = current !== undefined && next !== undefined ? text.replace(new RegExp(`("${hook}"\\s*:\\s*)${escapeRegExp(JSON.stringify(current))}`), (_m, key: string) => `${key}${JSON.stringify(next)}`) : text;
    if (replaced !== text) {
      text = replaced;
      config[hook] = next;
      changed.push(hook);
    } else if (next === undefined) notes.push(`${path.basename(file)} is formatted by hand: remove "${hook}" from "simple-git-hooks" yourself.`);
    else notes.push(`${path.basename(file)} is formatted by hand: set "${hook}" in "simple-git-hooks" to \`${next}\` yourself.`);
  }
  if (text !== before) notes.push('Apply it to .git/hooks with `npx simple-git-hooks`.');
  return { edits: text === before ? [] : [{ file, before, after: text }], renames: [], notes, changed };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* -------------------------------------------------------------------------- */
/*                                Plan & apply                                */
/* -------------------------------------------------------------------------- */

function plan(ctx: HooksContext, manager: HookManager, hooks: HookName[], install: boolean): HookPlan {
  const parts =
    manager === 'husky' ? huskyEdits(ctx, hooks, install) : manager === 'lefthook' ? lefthookEdits(ctx, hooks, install) : manager === 'simple-git-hooks' ? simpleGitHooksEdits(ctx, hooks, install) : gitEdits(ctx, hooks, install);
  return guardLinks(ctx, { manager, hooks, ...parts });
}

const within = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The plan without edits that would write through a symlink out of the repository (a hook file linked to a
 * shared script, a settings file of someone else): those files are named in a note and left alone. Two
 * names of one file are edited once.
 */
function guardLinks(ctx: HooksContext, p: HookPlan): HookPlan {
  const roots = [ctx.top, ...(ctx.gitDir ? [ctx.gitDir] : []), ...(ctx.globalHooks && ctx.allowGlobalHooks ? [ctx.hooksDir] : [])].map(realPathOf);
  const shown = (file: string): string => {
    const r = posix(path.relative(ctx.top, file));
    return r.startsWith('..') || path.isAbsolute(r) ? file : r;
  };
  const seen = new Set<string>();
  const dropped = new Set<string>();
  const notes = [...p.notes];
  const edits = p.edits.filter((e) => {
    const real = realPathOf(e.file);
    if (!roots.some((root) => within(root, real))) {
      notes.push(`${shown(e.file)} is a symlink to ${real} (outside the project), not changed`);
      dropped.add(e.file);
      return false;
    }
    if (seen.has(real)) {
      notes.push(`${shown(e.file)} is the same file as another hook (a link): changed once`);
      dropped.add(e.file);
      return false;
    }
    seen.add(real);
    return true;
  });
  if (!dropped.size) return p;
  // A hook whose file was left alone is not changed (a file named after its hook holds only that one;
  // lefthook.yml or package.json holds all of them); its rename aside is dropped with it.
  const changed = p.changed.filter((hook) => edits.some((e) => path.basename(e.file) === hook || !(HOOK_NAMES as readonly string[]).includes(path.basename(e.file))));
  return { ...p, edits, changed, renames: p.renames.filter((r) => !dropped.has(r.from)), restores: p.restores?.filter((r) => !dropped.has(r.to)), notes };
}

export function planInstall(ctx: HooksContext, manager: HookManager, hooks: HookName[]): HookPlan {
  return plan(ctx, manager, hooks, true);
}

export function planUninstall(ctx: HooksContext, manager: HookManager, hooks: HookName[]): HookPlan {
  return plan(ctx, manager, hooks, false);
}

export function isEmptyPlan(p: HookPlan): boolean {
  return !p.edits.length && !p.renames.length && !p.restores?.length;
}

/**
 * Write a plan: an existing hook moves aside before ours takes its name; the files; then a chained hook
 * moves back into the place ours left.
 */
export function applyPlan(p: HookPlan): void {
  for (const r of p.renames) fs.renameSync(r.from, r.to);
  for (const e of p.edits) {
    // Through a link (inside the repository, see guardLinks): the file it points to is the one that changes.
    const real = realPathOf(e.file);
    if (e.after === null) {
      if (real !== path.resolve(e.file) && isLink(e.file)) fs.rmSync(real, { force: true });
      fs.rmSync(e.file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, e.after);
    if (e.mode !== undefined && process.platform !== 'win32') fs.chmodSync(real, e.mode);
  }
  for (const r of p.restores ?? []) fs.renameSync(r.from, r.to);
}

/** Where a hook file that is a symlink points (relative to the repository top when inside it); undefined for a plain file. */
export function linkTarget(ctx: HooksContext, file: string): string | undefined {
  if (!isLink(file)) return undefined;
  const real = realPathOf(file);
  const r = posix(path.relative(realPathOf(ctx.top), real));
  return r.startsWith('..') || path.isAbsolute(r) ? real : r;
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface HookState {
  hook: HookName;
  installed: boolean;
  /** Where it is configured (project-relative). */
  where?: string;
  /** An earlier plain git hook that runs first. */
  chained?: boolean;
}

/** Which hooks code-visualizer is installed in, for each manager found. */
export function hooksState(ctx: HooksContext, manager: HookManager): HookState[] {
  const rel = (file: string): string => {
    const r = path.relative(ctx.top, file);
    return r.startsWith('..') || path.isAbsolute(r) ? file : posix(r);
  };
  return HOOK_NAMES.map((hook): HookState => {
    if (manager === 'husky') {
      const file = path.join(huskyDir(ctx) ?? path.join(ctx.top, '.husky'), hook);
      return { hook, installed: hasBlock(read(file), hook), where: rel(file) };
    }
    if (manager === 'lefthook') {
      const file = lefthookFile(ctx);
      return { hook, installed: !!file && hasBlock(read(file), hook), where: file && rel(file) };
    }
    if (manager === 'simple-git-hooks') {
      const file = simpleGitHooksFile(ctx);
      const text = file ? read(file) : null;
      let installed = false;
      try {
        const json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
        const config = (file && path.basename(file) === 'package.json' ? json?.['simple-git-hooks'] : json) as Record<string, unknown> | undefined;
        const value = config?.[hook];
        installed = typeof value === 'string' && value.split(SEGMENT_SEP).some(isOurSegment);
      } catch {
        installed = false;
      }
      return { hook, installed, where: file && rel(file) };
    }
    const file = path.join(ctx.hooksDir, hook);
    return { hook, installed: hasBlock(read(file), hook), where: rel(file), chained: exists(`${file}${CHAINED_SUFFIX}`) };
  });
}

/* -------------------------------------------------------------------------- */
/*                                  Preview                                   */
/* -------------------------------------------------------------------------- */

// The preview diff is shared with `agents init` (agent-guardrails).
export { unifiedDiff } from './text-diff.js';
