/**
 * The stop-time test gate: did a passing test run cover the tests the session's changes need? Two kinds
 * of evidence count — the `lastTest` state `code-visualizer test` records for the working tree it tested,
 * and (best effort) test commands in the agent's transcript that ran after its last edit and succeeded.
 * Pure: the caller reads the files and the tree id.
 */
import { testsCovered } from '../shared/status.js';
import type { LastTestState, TestCommand } from '../shared/types.js';

/**
 * Whether `lastTest` passed on exactly this tree and ran every required test (by path, or its package in
 * full) — the same rule as the status line's ✔ (`testsCovered` in src/shared/status.ts).
 */
export function lastTestCovers(lastTest: Partial<LastTestState> | undefined, required: string[], treeId: string | undefined): boolean {
  if (!lastTest || lastTest.passed !== true || !treeId || lastTest.treeId !== treeId) return false;
  return testsCovered(lastTest, required) === required.length;
}

/** Tools that write files: a test run before the last of them does not test the final code. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'str_replace_based_edit_tool']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell']);

interface ToolUse {
  index: number;
  name: string;
  command?: string;
  ok?: boolean;
  /** The end of what the command printed (a piped run's own outcome is only in its output). */
  output?: string;
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : '')).join('\n') : '');

/** Tool calls of a Claude Code transcript (JSON lines), in order, with whether each one succeeded. */
export function transcriptToolUses(jsonl: string): ToolUse[] {
  const uses = new Map<string, ToolUse>();
  const order: ToolUse[] = [];
  let index = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: { message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // a truncated first line (the tail of a long transcript)
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : undefined;
        const use: ToolUse = { index: index++, name: block.name, command };
        if (typeof block.id === 'string') uses.set(block.id, use);
        order.push(use);
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const use = uses.get(block.tool_use_id);
        if (!use) continue;
        // Claude marks failed commands (non-zero exit) as errors; some runners only say so in the text.
        const text = asText(block.content);
        use.ok = block.is_error !== true && !/^Error: Exit code [1-9]/m.test(text);
        use.output = text.slice(-4000);
      }
    }
  }
  return order;
}

/* -------------------------------------------------------------------------- */
/*                               Shell commands                               */
/* -------------------------------------------------------------------------- */

/** One simple command of a command line and the operator after it (`&&`, `||`, `;`, `|`, `&`). */
export interface ShellSegment {
  words: string[];
  next?: string;
}

/**
 * A shell command line split into simple commands, with quotes and escapes resolved, redirections
 * (`2>&1`, `> out.txt`) and comments dropped, and parentheses ignored. Enough to tell what a command ran.
 */
export function shellSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let dropNext = false;
  const endWord = (): void => {
    if (inWord) {
      if (dropNext) dropNext = false;
      else words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = (op?: string): void => {
    endWord();
    if (words.length) segments.push({ words, next: op });
    else if (op && segments.length) segments[segments.length - 1].next = op;
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\') {
      if (command[i + 1] === '\n') i++;
      else if (i + 1 < command.length) {
        word += command[++i];
        inWord = true;
      }
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(i + 1, stop);
      i = stop;
      inWord = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length && '"\\$`'.includes(command[j + 1])) j++;
        word += command[j++];
      }
      i = j;
      inWord = true;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      i = (end === -1 ? command.length : end) - 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      // `2>&1`, `>> log`, `< input`: the file descriptor before it and the target after it are not arguments.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else endWord();
      while (command[i + 1] === '>' || command[i + 1] === '<') i++;
      if (command[i + 1] === '&') {
        i++;
        while (/[\d-]/.test(command[i + 1] ?? '')) i++;
      } else dropNext = true;
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') {
      const two = command.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&') {
        endSegment(two === '|&' ? '|' : two);
        i++;
      } else endSegment(ch === '\n' ? ';' : ch);
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '(' || ch === ')') {
      endWord();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endSegment();
  return segments;
}

/** What a simple command runs: a test runner (`vitest`, `jest`…) with its arguments, a package's `test` script, or `code-visualizer test`. */
export function testInvocation(words: string[]): { runner: string; args: string[] } | undefined {
  const bin = (s: string): string => s.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|ps1|js|mjs|cjs)$/i, '');
  let w = [...words];
  // Environment assignments and wrappers in front: `CI=1 time npx vitest run`.
  while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || ['env', 'time', 'command', 'exec', 'nice', 'nohup'].includes(w[0]))) w = w.slice(1);
  if (!w.length) return undefined;
  let head = bin(w[0]);
  let rest = w.slice(1);
  // Launchers: npx, bunx, pnpm exec|dlx, npm exec, yarn exec|dlx, bun x.
  const launcher = head === 'npx' || head === 'bunx' || (['pnpm', 'yarn'].includes(head) && ['exec', 'dlx'].includes(rest[0])) || (head === 'npm' && rest[0] === 'exec') || (head === 'bun' && rest[0] === 'x');
  if (launcher) {
    if (head !== 'npx' && head !== 'bunx') rest = rest.slice(1);
    while (rest.length && rest[0].startsWith('-') && rest[0] !== '--') {
      const flag = rest.shift()!;
      if ((flag === '-p' || flag === '--package') && rest.length) rest.shift();
    }
    if (rest[0] === '--') rest = rest.slice(1);
    if (!rest.length) return undefined;
    head = bin(rest[0]).replace(/(.)@[^/@]*$/, '$1'); // vitest@2, code-visualizer@0
    rest = rest.slice(1);
  }
  // The package's test script: npm test, npm run test, pnpm test, yarn test, bun run test.
  if (head === 'npm' && ['test', 't', 'tst'].includes(rest[0])) return { runner: 'script', args: rest.slice(1) };
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(head) && ['run', 'run-script'].includes(rest[0]) && rest[1] === 'test') return { runner: 'script', args: rest.slice(2) };
  if ((head === 'pnpm' || head === 'yarn') && rest[0] === 'test') return { runner: 'script', args: rest.slice(1) };
  // `yarn vitest`, `pnpm vitest`: the package's own binary.
  if ((head === 'yarn' || head === 'pnpm') && rest.length && !rest[0].startsWith('-')) {
    head = bin(rest[0]);
    rest = rest.slice(1);
  }
  if (head === 'bun') return rest[0] === 'test' ? { runner: 'bun', args: rest.slice(1) } : undefined;
  if (head === 'node') return rest.includes('--test') ? { runner: 'node', args: rest.filter((a) => a !== '--test') } : undefined;
  if (head === 'code-visualizer' || head === 'cviz') return rest[0] === 'test' ? { runner: 'code-visualizer', args: rest.slice(1) } : undefined;
  return { runner: head, args: rest };
}

/** Flags that print something else, or run only part of the selected files (by name, by shard, by project…). */
const NOT_A_FULL_RUN = new Set([
  '--version', '-v', '-V', '--help', '-h', '--list', '--listTests', '--showConfig', '--clearCache', '--init',
  '--changed', '--related', '--findRelatedTests', '--onlyChanged', '-o', '--lastCommit', '--shard',
  '-t', '--testNamePattern', '--test-name-pattern', '--grep', '-g', '--fgrep', '--match', '-m',
  '--project', '--selectProjects', '--dir', '--root', '-r', '--rootDir', '--exclude', '--testPathIgnorePatterns', '--test-skip-pattern',
  '--dry-run',
]);
/** Flags whose value is the next word (not a test file filter). */
const VALUE_FLAGS = new Set([
  '--reporter', '--reporters', '--config', '-c', '--environment', '--pool', '--outputFile', '--testTimeout', '--maxWorkers', '--minWorkers',
  '--maxConcurrency', '--retry', '--mode', '--workers', '-j', '--timeout', '--require', '--reporter-option', '--env-file',
  '--test-reporter', '--test-reporter-destination', '--browser', '--testEnvironment', '--coverageDirectory', '--seed', '--logLevel',
]);
const FILTER_FLAGS = new Set(['--spec', '--testPathPattern', '--testPathPatterns']);
/** Mocha's short flags differ: `-t` is its timeout and `-r` its require, both with a value. */
const MOCHA_VALUE_FLAGS = new Set(['-t', '-r', '--timeout', '--require', '--reporter', '-R', '--ui', '-u', '--spec']);

/** The required test files a test invocation ran: all of them, the ones its file filters match, or none. */
function covered(invocation: { runner: string; args: string[] }, required: string[], runners: string[]): string[] {
  let args = invocation.args;
  if (invocation.runner === 'code-visualizer') return args.some((a) => ['--list', '--dry-run', '-h', '--help'].includes(a)) ? [] : required;
  if (invocation.runner !== 'script') {
    if (!runners.includes(invocation.runner)) return [];
    const sub = args[0];
    if (invocation.runner === 'vitest') {
      if (['run', 'watch', 'dev'].includes(sub)) args = args.slice(1);
      else if (['related', 'bench', 'init', 'list', 'typecheck'].includes(sub)) return [];
    } else if (invocation.runner === 'playwright') {
      if (sub !== 'test') return [];
      args = args.slice(1);
    } else if (invocation.runner === 'cypress') {
      if (sub !== 'run') return [];
      args = args.slice(1);
    }
  }
  const filters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (!arg.startsWith('-')) {
      filters.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (invocation.runner === 'mocha' && MOCHA_VALUE_FLAGS.has(flag)) {
      if (flag === '--spec') filters.push(...(value ?? args[++i] ?? '').split(',').filter(Boolean));
      else if (value === undefined) i++;
      continue;
    }
    if (NOT_A_FULL_RUN.has(flag)) return [];
    if (FILTER_FLAGS.has(flag)) filters.push(...(value ?? args[++i] ?? '').split(',').filter(Boolean));
    else if (VALUE_FLAGS.has(flag) && value === undefined) i++;
  }
  // No file filter: the whole suite.
  if (!filters.length) return required;
  // Runners filter test files by path (vitest: a substring of the path): `src/hooks`, `Button`, `./src/a.test.ts`, an absolute path.
  const matches = (file: string, filter: string): boolean => {
    const f = filter.replace(/^\.\//, '');
    return !!f && (file === f || file.includes(f) || f.endsWith(`/${file}`));
  };
  return required.filter((file) => filters.some((f) => matches(file, f)));
}

/** A run's output says it passed (needed when the exit code is not the runner's: `npx vitest run | tail`). */
function outputPassed(output: string | undefined): boolean {
  if (!output) return false;
  const failed = /\b[1-9]\d* (failed|failing|fail)\b|^\s*FAIL\s|^# fail [1-9]/im.test(output);
  return !failed && /\b\d+ (passed|passing|pass)\b|^# pass [1-9]/im.test(output);
}

/**
 * Whether the transcript shows successful test runs after the last edit that together cover
 * `required`. A run counts when a test runner of the project is the command that ran (not a `grep`,
 * `echo` or `npm ls` that mentions it), with no name filter or partial-run flag, and either without file
 * filters (the whole suite) or with filters matching the required files. When the runner's exit code
 * does not reach the result (`| tail`, `; echo`, `|| true`), its own output must say it passed.
 */
export function transcriptCovers(jsonl: string, required: string[], commands: Pick<TestCommand, 'runner'>[]): boolean {
  const uses = transcriptToolUses(jsonl);
  const lastEdit = uses.reduce((last, u) => (EDIT_TOOLS.has(u.name) ? u.index : last), -1);
  const runners = [...new Set(commands.map((c) => c.runner))];
  const done = new Set<string>();
  for (const u of uses) {
    if (u.index < lastEdit || !SHELL_TOOLS.has(u.name) || !u.command || u.ok !== true) continue;
    const segments = shellSegments(u.command);
    const pipefail = /\bpipefail\b/.test(u.command);
    segments.forEach((segment, i) => {
      const invocation = testInvocation(segment.words);
      if (!invocation) return;
      // The command's exit code is the runner's only when everything after it is chained with `&&`
      // (and it does not run in the background).
      const after = segments.slice(i, -1).map((s) => s.next ?? ';');
      const trusted = segment.next !== '&' && after.every((op) => op === '&&' || (op === '|' && pipefail));
      if (!trusted && !outputPassed(u.output)) return;
      for (const file of covered(invocation, required, runners)) done.add(file);
    });
    if (required.every((file) => done.has(file))) return true;
  }
  return false;
}
