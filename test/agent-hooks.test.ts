import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseApplyPatch, parseHookInput, renderHookOutput } from '../src/agent/dialect.js';
import { applyEdits, codeOnly, importsChanged, importStatements, lineChanges, overlayLineChanges, postEditFindings, preEditFindings, revertEdits } from '../src/agent/guard.js';
import { changedFiles, readSession, sessionFile } from '../src/agent/session.js';
import { lastTestCovers, shellSegments, testInvocation, transcriptCovers } from '../src/agent/stop-gate.js';
import { workingTreeId } from '../src/analyzer/git.js';
import { updateState } from '../src/analyzer/state.js';
import { runCli } from '../src/cli/run.js';
import { serve, type LiveServer } from '../src/server/index.js';
import type { GuardFinding } from '../src/shared/types.js';
import { commitAll, copyFixture, daysAgo, editFile, fixtureDir, hasGit, httpRequest, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Run the CLI in-process with `stdin` as the hook's input and capture what it writes. */
async function cli(argv: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sink: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    }) as typeof process.stdout.write;
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture((s) => (stdout += s)));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture((s) => (stderr += s)));
  const input = stdin === undefined ? undefined : vi.spyOn(process, 'stdin', 'get').mockReturnValue(Readable.from([stdin]) as unknown as typeof process.stdin);
  try {
    const code = await runCli(argv);
    return { code, stdout: strip(stdout), stderr: strip(stderr) };
  } finally {
    out.mockRestore();
    err.mockRestore();
    input?.mockRestore();
  }
}

/** A Claude Code hook payload for a tool call in `root`. */
function claude(root: string, event: string, tool?: string, toolInput?: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: 'sess-1', transcript_path: path.join(root, 'none.jsonl'), cwd: root, hook_event_name: event, ...(tool ? { tool_name: tool, tool_input: toolInput } : {}), ...extra });
}

const RULE = { name: 'components-no-api', from: 'src/components/**', to: 'src/api/**', message: 'Components get data through hooks' };

// integration (clone-radar): a helper and a copy of it with every name and literal changed.
const SLUGIFY = `export function slugify(text: string): string {
  const lower = text.toLowerCase().trim();
  const parts = lower.split(/[^a-z0-9]+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return 'item';
  }
  const joined = parts.join('-');
  return joined.length > 60 ? joined.slice(0, 60) : joined;
}
`;
const TO_SLUG = SLUGIFY.replace('slugify(text', 'toSlug(input').replace(/\btext\b/g, 'input').replace(/\blower\b/g, 'small').replace(/\bparts\b/g, 'pieces').replace("'item'", "'entry'").replace(/\bjoined\b/g, 'result').replace(/60/g, '80');
const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

let restoreGit: () => void = () => undefined;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  restoreGit = isolateGit();
  // The hooks look for the agent's project in these; the test runner may itself run inside an agent.
  for (const key of ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'CODE_VISUALIZER_HOOKS', 'CLAUDECODE']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterAll(() => {
  restoreGit();
  for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  removeTempDirs();
});

/** react-vite-ts with the rule components ↛ api, committed. */
function project(): string {
  const root = initRepo('react-vite-ts');
  writeFile(root, 'code-visualizer.config.json', `${JSON.stringify({ rules: [RULE] }, null, 2)}\n`);
  commitAll(root, { author: 'Ada', date: daysAgo(3), message: 'init' });
  return root;
}

describe('agent dialects', () => {
  it('normalizes Claude Code Write, Edit and MultiEdit calls', () => {
    const write = parseHookInput(JSON.stringify({ session_id: 's', cwd: '/p', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/p/a.ts', content: 'x' } }), 'pre-edit');
    expect(write).toMatchObject({ dialect: 'claude', sessionId: 's', cwd: '/p', tool: 'Write', file: '/p/a.ts', fullText: 'x' });
    const edit = parseHookInput(JSON.stringify({ session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: true } }), 'pre-edit', { cwd: '/w' });
    expect(edit).toMatchObject({ cwd: '/w', edits: [{ oldText: 'a', newText: 'b', replaceAll: true }] });
    const multi = parseHookInput(JSON.stringify({ session_id: 's', tool_name: 'MultiEdit', tool_input: { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }] } }), 'pre-edit');
    expect(multi).toMatchObject({ edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'b', newText: 'c' }] });
    expect(parseHookInput(JSON.stringify({ session_id: 's', stop_hook_active: true }), 'stop')).toMatchObject({ stopHookActive: true });
  });

  it('recognizes Cursor payloads (afterFileEdit, stop) and Codex apply_patch calls', () => {
    const cursor = parseHookInput(JSON.stringify({ conversation_id: 'c1', generation_id: 'g', hook_event_name: 'afterFileEdit', workspace_roots: ['/ws'], file_path: '/ws/a.ts', edits: [{ old_string: 'x', new_string: 'y' }] }), 'post-edit');
    expect(cursor).toMatchObject({ dialect: 'cursor', sessionId: 'c1', cwd: '/ws', roots: ['/ws'], file: '/ws/a.ts', edits: [{ oldText: 'x', newText: 'y' }] });
    expect(parseHookInput(JSON.stringify({ conversation_id: 'c1', hook_event_name: 'stop', status: 'completed', loop_count: 1 }), 'stop')).toMatchObject({ dialect: 'cursor', loopCount: 1 });
    const patch = ['*** Begin Patch', '*** Add File: src/new.ts', '+export const a = 1;', '*** Update File: src/old.ts', '@@', ' keep', '-gone', '+added', '*** Delete File: src/dead.ts', '*** End Patch'].join('\n');
    const codex = parseHookInput(JSON.stringify({ session_id: 'x', cwd: '/r', tool_name: 'apply_patch', tool_input: { command: ['apply_patch', patch] } }), 'pre-edit');
    expect(codex).toMatchObject({ dialect: 'codex', file: 'src/new.ts', fullText: 'export const a = 1;\n' });
    expect(parseApplyPatch(patch)).toEqual([
      { file: 'src/new.ts', fullText: 'export const a = 1;\n' },
      { file: 'src/old.ts', edits: [{ oldText: 'keep\ngone', newText: 'keep\nadded' }] },
      { file: 'src/dead.ts', deleted: true },
    ]);
  });

  it('answers in each client format, with exit code 2 for Codex refusals', () => {
    expect(JSON.parse(renderHookOutput('claude', 'pre-edit', { deny: 'no' }).stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
    expect(JSON.parse(renderHookOutput('claude', 'post-edit', { context: 'c' }).stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'c' } });
    expect(JSON.parse(renderHookOutput('claude', 'stop', { block: 'run' }).stdout)).toEqual({ decision: 'block', reason: 'run' });
    expect(renderHookOutput('codex', 'pre-edit', { deny: 'no' })).toEqual({ stdout: '', stderr: 'no\n', exitCode: 2 });
    expect(JSON.parse(renderHookOutput('cursor', 'stop', { block: 'run', context: 'radar' }).stdout)).toEqual({ followup_message: 'run\n\nradar' });
    expect(renderHookOutput('cursor', 'post-edit', { context: 'radar' }).stdout).toBe('');
    expect(renderHookOutput('claude', 'stop', { note: 'n' })).toEqual({ stdout: '', stderr: 'n\n', exitCode: 0 });
  });

  it('applies edits exactly and fails open when an old text is missing', () => {
    expect(applyEdits('a b a', [{ oldText: 'a', newText: 'x' }])).toBe('x b a');
    expect(applyEdits('a b a', [{ oldText: 'a', newText: '$&$1', replaceAll: true }])).toBe('$&$1 b $&$1');
    expect(applyEdits('a', [{ oldText: 'a', newText: 'b' }, { oldText: 'b', newText: 'c' }])).toBe('c');
    expect(applyEdits('a', [{ oldText: 'zzz', newText: 'b' }])).toBeUndefined();
    expect(revertEdits('c', [{ oldText: 'a', newText: 'b' }, { oldText: 'b', newText: 'c' }])).toBe('a');
    // Only module specifiers matter for rules, cycles and packages.
    expect(importsChanged("import a from './a';\nconst x = 1;", "import a from './a';\nconst x = 2;")).toBe(false);
    expect(importsChanged("import a from './a';", "import a from './a';\nimport b from './b';")).toBe(true);
    expect(importsChanged(null, 'export const a = 1;')).toBe(false);
    // A type-only import that becomes a value import can break a rule or close a cycle.
    expect(importsChanged("import type { A } from './a';", "import { A } from './a';")).toBe(true);
    expect(importsChanged("import {\n  a,\n} from './a';", "import { a } from './a';")).toBe(false);
  });

  it('does not take commented-out imports or import text in strings for imports', () => {
    // Uncommenting a forbidden import, or turning a string into code, is a real change.
    expect(importsChanged("// import { api } from '../api/client';\nexport const x = 1;", "import { api } from '../api/client';\nexport const x = 1;")).toBe(true);
    expect(importsChanged("/* import { api } from '../api/client'; */", "import { api } from '../api/client';")).toBe(true);
    expect(importsChanged("const doc = \"import { api } from '../api/client'\";", "import { api } from '../api/client';")).toBe(true);
    expect(importsChanged('const doc = `see ${"import(\'./x\')"}`;', "const lazy = import('./x');")).toBe(true);
    // Comments next to imports and quotes in regular expressions change nothing.
    expect(importsChanged("import a from './a'; // old", "import a from './a'; // new note: don't")).toBe(false);
    expect(importsChanged("const q = /'/g;\nimport a from './a';", "const q = /'/g;\nimport a from './a';\nconst s = 'x';")).toBe(false);
    expect(importStatements("export * from './all';\nconst r = require('./r');\nimport('./lazy');")).toEqual(["export * from './all'", "import('./lazy'", "require('./r'"]);
    expect(codeOnly("const s = 'import x from \"y\"'; // import z from 'z'")).toBe("const s = ''; ");
  });

  it('scans a long file without semicolons or quotes in linear time', () => {
    const text = Array.from({ length: 6000 }, (_, i) => `export type T${i} = number`).join('\n');
    const started = Date.now();
    expect(importStatements(text)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('post-edit findings (what an edit left behind)', () => {
  it('reports removed routes still called, removed exports still imported, complexity jumps and untested new exports', async () => {
    const { analyze } = await import('../src/analyzer/index.js');
    const root = fixtureDir('fullstack-next');
    const lean = { root, git: false, changes: false, history: false, includeSource: false, persist: false, coverage: false as const };
    const before = await analyze(lean);
    const route = 'app/api/users/[id]/route.ts';
    const routeText = fs.readFileSync(path.join(root, route), 'utf8');
    const format = [
      "import type { User } from './types';",
      '',
      "export function displayName(user: Pick<User, 'name' | 'email'>, style = 0): string {",
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => `  if (style === ${n}) return user.name.slice(${n});`),
      '  return user.name.trim() || user.email;',
      '}',
      '',
      "export function initials(user: Pick<User, 'name'>): string {",
      "  return user.name.split(' ').map((p) => p[0]).join('');",
      '}',
      '',
    ].join('\n');
    const after = await analyze({ ...lean, overlay: { [route]: routeText.slice(0, routeText.indexOf('export async function DELETE')), 'lib/format.ts': format } });
    const findings = postEditFindings(before, after, { files: [route, 'lib/format.ts'] });
    const lines = findings.map((f) => `${f.kind}: ${f.message}`);
    expect(lines).toContain('removed-route: DELETE /api/users/[id] no longer exists, but components/UserTable.tsx:18, test/users.test.ts:20 still request it.');
    expect(lines).toContain('breaking-export: formatUserName was removed from lib/format.ts, but components/UserTable.tsx still imports it.');
    expect(lines).toContain('complexity-jump: displayName() in lib/format.ts:3 went from complexity 2 to 9.');
    expect(lines).toContain('untested-export: New export initials() in lib/format.ts: no test reaches this file.');
    expect(findings.find((f) => f.kind === 'untested-export')?.fix).toBe('A test would go in test/format.test.ts.');
    expect(findings.every((f) => f.severity === 'inform' && f.key)).toBe(true);
    // Nothing changed: nothing to say.
    expect(postEditFindings(before, before, { files: [route] })).toEqual([]);
  });

  it('integration (clone-radar): tells a copy of existing code, and an edit to one copy of a clone', async () => {
    const { analyze } = await import('../src/analyzer/index.js');
    const root = copyFixture('react-vite-ts', 'cv-guard-clones-');
    writeFile(root, 'src/lib/strings.ts', SLUGIFY);
    writeFile(root, 'src/ui/utils.ts', TO_SLUG);
    const lean = { root, git: false, changes: false, history: false, includeSource: false, persist: false, coverage: false as const };
    const now = await analyze(lean);
    expect(now.insights.clones?.length).toBe(1);
    // A new file that copies slugify: "this already exists", in the words check, pr and serve use.
    const copy = SLUGIFY.replace('slugify', 'slugAgain');
    const pasted = await analyze({ ...lean, overlay: { 'src/pages/slug.ts': copy } });
    const added = postEditFindings(now, pasted, { files: ['src/pages/slug.ts'], changedLines: { 'src/pages/slug.ts': lineChanges(null, copy) } }).filter((f) => f.kind === 'clone');
    expect(added).toEqual([
      {
        kind: 'clone',
        severity: 'inform',
        file: 'src/pages/slug.ts',
        line: 1,
        message: 'slugAgain in src/pages/slug.ts is 100% similar to exported slugify in src/lib/strings.ts and 1 more copy: import it instead.',
        fix: 'The existing one is at src/lib/strings.ts:1-9.',
        key: 'clone|src/pages/slug.ts#slugAgain|src/lib/strings.ts#slugify',
      },
    ]);
    // Fixing one copy while its clone stays as it was: drift (the copies still match, so only the changed lines tell).
    const fixed = SLUGIFY.replace("return 'item';", "return 'untitled';");
    const edited = await analyze({ ...lean, overlay: { 'src/lib/strings.ts': fixed } });
    const options = { files: ['src/lib/strings.ts'], changedLines: overlayLineChanges({ 'src/lib/strings.ts': SLUGIFY }, () => fixed) };
    const drift = postEditFindings(now, edited, options).filter((f) => f.kind === 'clone');
    expect(drift.map((f) => [f.message, f.fix])).toEqual([['You changed src/lib/strings.ts:1-9; its clone src/ui/utils.ts:1-9 was not changed.', 'If the edit fixed something, the copy probably needs it too.']]);
    expect(postEditFindings(now, edited, { files: options.files }).filter((f) => f.kind === 'clone')).toEqual([]);
    // With clone detection turned off nothing is said.
    expect(postEditFindings(now, edited, { ...options, config: { clones: { enabled: false } } }).filter((f) => f.kind === 'clone')).toEqual([]);
  });

  it('numbers changed lines the way git diff does', () => {
    expect(lineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ lines: [2], added: [2] });
    expect(lineChanges('a\nb\nc\n', 'a\nc\n')).toEqual({ lines: [2], added: [] });
    expect(lineChanges('a\nc\n', 'a\nb1\nb2\nc\n')).toEqual({ lines: [2, 3], added: [2, 3] });
    expect(lineChanges(null, 'x\ny')).toEqual({ lines: [1, 2], added: [1, 2] });
    expect(overlayLineChanges({ 'a.ts': 'x', 'b.md': 'x', 'gone.ts': 'x', 'same.ts': 'x' }, (f) => (f === 'gone.ts' ? null : f === 'same.ts' ? 'x' : 'y'))).toEqual({ 'a.ts': { lines: [1], added: [1] } });
  });

  it('pre-edit lets warn-level rules through with a note', async () => {
    const { analyze } = await import('../src/analyzer/index.js');
    const root = fixtureDir('react-vite-ts');
    const lean = { root, git: false, changes: false, history: false, includeSource: false, persist: false, coverage: false as const };
    const config = { rules: [{ ...RULE, severity: 'warn' as const }] };
    const now = await analyze({ ...lean, config: { config } });
    const card = fs.readFileSync(path.join(root, 'src/components/Card.tsx'), 'utf8');
    const proposed = await analyze({ ...lean, config: { config }, overlay: { 'src/components/Card.tsx': `${card}\nimport { fetchUsers } from '../api/client';\nexport const _f = fetchUsers;\n` } });
    const findings = preEditFindings(now, proposed, { files: ['src/components/Card.tsx'], config });
    expect(findings.map((f) => [f.kind, f.severity])).toEqual([['forbidden-import', 'inform']]);
    // A warning advises: it does not say "must".
    expect(findings[0].message).toContain('src/components/Card.tsx should not import src/api/client.ts (rule components-no-api)');
  });
});

describe('agent stop gate (pure)', () => {
  it('accepts a passing lastTest of the same tree that ran every required test', () => {
    const last = { passed: true, treeId: 't1', files: ['a.test.ts', 'b.test.ts'], full: false };
    expect(lastTestCovers(last, ['a.test.ts'], 't1')).toBe(true);
    expect(lastTestCovers(last, ['a.test.ts'], 't2')).toBe(false);
    expect(lastTestCovers({ ...last, passed: false }, ['a.test.ts'], 't1')).toBe(false);
    expect(lastTestCovers(last, ['c.test.ts'], 't1')).toBe(false);
    expect(lastTestCovers({ ...last, full: true, fullPackages: ['packages/web'] }, ['packages/web/x.test.ts'], 't1')).toBe(true);
  });

  it('finds a successful test command after the last edit in a Claude transcript', () => {
    const entry = (role: string, content: unknown[]) => JSON.stringify({ type: role, message: { role, content } });
    const run = (id: string, command: string) => entry('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
    const result = (id: string, error = false) => entry('user', [{ type: 'tool_result', tool_use_id: id, is_error: error, content: error ? 'Error: Exit code 1' : 'ok' }]);
    const edit = (id: string) => entry('assistant', [{ type: 'tool_use', id, name: 'Edit', input: { file_path: 'a.ts' } }]);
    const commands = [{ runner: 'vitest' }];
    const required = ['src/a.test.ts', 'src/b.test.ts'];
    expect(transcriptCovers([edit('e1'), run('r1', 'npx vitest run src/a.test.ts src/b.test.ts'), result('r1')].join('\n'), required, commands)).toBe(true);
    // A failing run, a run before the last edit, a run missing a file: not evidence.
    expect(transcriptCovers([edit('e1'), run('r1', 'npx vitest run src/a.test.ts src/b.test.ts'), result('r1', true)].join('\n'), required, commands)).toBe(false);
    expect(transcriptCovers([run('r1', 'npx vitest run src/a.test.ts src/b.test.ts'), result('r1'), edit('e2')].join('\n'), required, commands)).toBe(false);
    expect(transcriptCovers([edit('e1'), run('r1', 'npx vitest run src/a.test.ts'), result('r1')].join('\n'), required, commands)).toBe(false);
    // Whole-suite runs count.
    expect(transcriptCovers([edit('e1'), run('r1', 'npm test'), result('r1')].join('\n'), required, commands)).toBe(true);
    expect(transcriptCovers([edit('e1'), run('r1', 'npx vitest run'), result('r1')].join('\n'), required, commands)).toBe(true);
  });

  it('counts only commands that ran the test runner on the required files', () => {
    const entry = (role: string, content: unknown[]) => JSON.stringify({ type: role, message: { role, content } });
    const run = (id: string, command: string) => entry('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
    const result = (id: string, output = 'ok') => entry('user', [{ type: 'tool_result', tool_use_id: id, is_error: false, content: output }]);
    const edit = entry('assistant', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.ts' } }]);
    const required = ['src/components/Button.test.tsx'];
    const covers = (command: string, output?: string): boolean => transcriptCovers([edit, run('r1', command), result('r1', output)].join('\n'), required, [{ runner: 'vitest' }]);
    // Commands that merely mention the runner, print something else, or run other tests.
    for (const command of [
      'cat package.json | grep vitest',
      'grep -rn vitest package.json',
      'npm ls vitest',
      'npx vitest --version',
      'echo vitest',
      'npx vitest run src/hooks',
      'npx vitest run -t nothing-matches',
      'npx vitest run src/components/Button.test.tsx -t "renders"',
      'npm test -- src/other.test.ts',
      'pnpm test src/unrelated.test.ts',
      'npx vitest related src/components/Button.tsx',
      'npx jest src/components/Button.test.tsx',
    ]) expect([command, covers(command)]).toEqual([command, false]);
    // The runner itself, through any launcher, on the file, a folder that holds it or its name.
    for (const command of [
      'npx vitest run src/components/Button.test.tsx',
      'CI=1 pnpm exec vitest run ./src/components/Button.test.tsx --reporter=verbose',
      'cd app && npx vitest run src/components && echo done',
      'yarn vitest run Button',
      'node_modules/.bin/vitest run src/components/Button.test.tsx',
      'npm test -- --coverage',
      'npx code-visualizer test',
    ]) expect([command, covers(command)]).toEqual([command, true]);
    // When the exit code is not the runner's (| tail, ; echo, || true), its output must say it passed.
    expect(covers('npx vitest run src/components/Button.test.tsx 2>&1 | tail -20', ' Test Files  1 passed (1)\n      Tests  3 passed (3)')).toBe(true);
    expect(covers('npx vitest run src/components/Button.test.tsx 2>&1 | tail -20', ' FAIL  src/components/Button.test.tsx > renders\n Test Files  1 failed (1)')).toBe(false);
    expect(covers('npx vitest run src/components/Button.test.tsx || true', '')).toBe(false);
    // Runs of different files after the last edit add up.
    const two = ['src/a.test.ts', 'src/b.test.ts'];
    expect(transcriptCovers([edit, run('r1', 'npx vitest run src/a.test.ts'), result('r1'), run('r2', 'npx vitest run src/b.test.ts'), result('r2')].join('\n'), two, [{ runner: 'vitest' }])).toBe(true);
  });

  it('splits shell command lines into what they run', () => {
    expect(shellSegments(`FOO=1 npx vitest run 'a b.test.ts' 2>&1 | tail -5 && echo "x;y" # done`)).toEqual([
      { words: ['FOO=1', 'npx', 'vitest', 'run', 'a b.test.ts'], next: '|' },
      { words: ['tail', '-5'], next: '&&' },
      { words: ['echo', 'x;y'] },
    ]);
    expect(shellSegments('(cd web && npm test) > out.log; ls')).toEqual([{ words: ['cd', 'web'], next: '&&' }, { words: ['npm', 'test'], next: ';' }, { words: ['ls'] }]);
    expect(testInvocation(['pnpm', 'run', 'test', '--', 'a.test.ts'])).toEqual({ runner: 'script', args: ['--', 'a.test.ts'] });
    expect(testInvocation(['bunx', 'vitest@2', 'run'])).toEqual({ runner: 'vitest', args: ['run'] });
    expect(testInvocation(['grep', 'vitest'])).toEqual({ runner: 'grep', args: ['vitest'] });
  });
});

describe.skipIf(!hasGit)('code-visualizer hook (Claude Code, Cursor)', () => {
  let root: string;
  beforeEach(() => {
    root = project();
  });

  it('pre-edit refuses a forbidden import with the rule name and an allowed alternative', async () => {
    const first = read(root, 'src/components/Card.tsx').split('\n')[0];
    const { code, stdout } = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Edit', { file_path: path.join(root, 'src/components/Card.tsx'), old_string: first, new_string: `${first}\nimport { api } from '../api/client';` }));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('src/components/Card.tsx must not import src/api/client.ts (rule components-no-api): Components get data through hooks.');
    expect(reason).toContain('src/hooks/useUsers.ts exports useUsers(), which already uses src/api/client.ts');
    // Nothing was written.
    expect(read(root, 'src/components/Card.tsx')).not.toContain('api/client');
  });

  it('pre-edit allows other edits silently, and skips files it does not judge', async () => {
    const first = read(root, 'src/components/Card.tsx').split('\n')[0];
    const allowed = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Edit', { file_path: 'src/components/Card.tsx', old_string: first, new_string: `${first}\nimport { formatDate } from '../utils/format';` }));
    expect(allowed).toEqual({ code: 0, stdout: '', stderr: '' });
    const docs = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Write', { file_path: path.join(root, 'README.md'), content: "import x from '../api/client'" }));
    expect(docs).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('pre-edit applies MultiEdit edits in sequence', async () => {
    const first = read(root, 'src/components/Card.tsx').split('\n')[0];
    const { stdout } = await cli(
      ['hook', 'pre-edit'],
      claude(root, 'PreToolUse', 'MultiEdit', {
        file_path: 'src/components/Card.tsx',
        edits: [
          { old_string: first, new_string: `${first}\n// cv-marker` },
          // Only exists after the first edit.
          { old_string: '// cv-marker', new_string: "import { fetchUsers } from '@/api/client';" },
        ],
      }),
    );
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('pre-edit refuses a new circular dependency and an undeclared package', async () => {
    // UserCard.tsx imports Button.tsx; Button importing UserCard closes a loop (utils/format ↔ utils/math already is one).
    const button = read(root, 'src/components/Button.tsx');
    const cycle = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Write', { file_path: 'src/components/Button.tsx', content: `import { UserCard } from './UserCard';\n${button}\nexport const _u = UserCard;\n` }));
    const why = JSON.parse(cycle.stdout).hookSpecificOutput.permissionDecisionReason as string;
    expect(why).toContain('This creates a circular dependency: Button.tsx → UserCard.tsx → Button.tsx.');
    expect(why).toContain('src/components/UserCard.tsx already depends on src/components/Button.tsx (src/components/UserCard.tsx → src/components/Button.tsx).');
    expect(why).not.toContain('utils/math');
    const pkg = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Write', { file_path: 'src/utils/dates.ts', content: "import dayjs from 'dayjs';\nexport const now = () => dayjs();\n" }));
    const reason = JSON.parse(pkg.stdout).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain('src/utils/dates.ts imports "dayjs", which package.json does not declare.');
    expect(reason).toContain('npm install dayjs');
  });

  it('post-edit lists the exact call sites of a changed signature, once', async () => {
    expect((await cli(['hook', 'session-start'], claude(root, 'SessionStart', undefined, undefined, { source: 'startup' }))).code).toBe(0);
    const edit = { file_path: 'src/utils/format.ts', old_string: 'export function formatDate(iso: string): string {', new_string: 'export function formatDate(iso: string, locale: string): string {' };
    expect((await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Edit', edit))).stdout).toBe('');
    editFile(root, 'src/utils/format.ts', edit.old_string, edit.new_string);
    const post = await cli(['hook', 'post-edit'], claude(root, 'PostToolUse', 'Edit', edit));
    const context = JSON.parse(post.stdout).hookSpecificOutput as { hookEventName: string; additionalContext: string };
    expect(context.hookEventName).toBe('PostToolUse');
    expect(context.additionalContext).toContain('formatDate(iso, locale) changed its parameters: 1 call site still passes 1 argument: src/components/UserCard.tsx:16.');
    // Told once: the same state after another edit stays quiet.
    expect((await cli(['hook', 'post-edit'], claude(root, 'PostToolUse', 'Edit', edit))).stdout).toBe('');
    // The pre-edit hook kept the file as the session found it.
    expect(readSession(root, 'sess-1')?.originals?.['src/utils/format.ts']).toContain('formatDate(iso: string): string');
    // Fixing the caller ends the finding; nothing new to say.
    editFile(root, 'src/components/UserCard.tsx', 'formatDate(joinedAt)', "formatDate(joinedAt, 'en-US')");
    expect((await cli(['hook', 'post-edit'], claude(root, 'PostToolUse', 'Edit', { file_path: 'src/components/UserCard.tsx', old_string: 'formatDate(joinedAt)', new_string: "formatDate(joinedAt, 'en-US')" }))).stdout).toBe('');
  });

  it('post-edit is silent for an edit that changes nothing', async () => {
    const text = read(root, 'src/utils/format.ts');
    const write = { file_path: 'src/utils/format.ts', content: text };
    expect(await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Write', write))).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await cli(['hook', 'post-edit'], claude(root, 'PostToolUse', 'Write', write))).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('recognizes Cursor afterFileEdit and relays its findings when Cursor stops', async () => {
    const edit = { old_string: 'export function formatDate(iso: string): string {', new_string: 'export function formatDate(iso: string, locale: string): string {' };
    editFile(root, 'src/utils/format.ts', edit.old_string, edit.new_string);
    const payload = JSON.stringify({ conversation_id: 'conv-1', generation_id: 'g1', hook_event_name: 'afterFileEdit', workspace_roots: [root], file_path: path.join(root, 'src/utils/format.ts'), edits: [edit] });
    const after = await cli(['hook', 'post-edit', '--dialect', 'cursor'], payload);
    expect(after).toEqual({ code: 0, stdout: '', stderr: '' }); // Cursor takes no answer after an edit
    expect(readSession(root, 'conv-1')?.pending?.[0]).toContain('src/components/UserCard.tsx:16');
    const stop = await cli(['hook', 'stop'], JSON.stringify({ conversation_id: 'conv-1', hook_event_name: 'stop', status: 'completed', loop_count: 0, workspace_roots: [root] }));
    expect(JSON.parse(stop.stdout).followup_message).toContain('src/components/UserCard.tsx:16');
    expect(readSession(root, 'conv-1')?.pending).toEqual([]);
  });

  it('integration (clone-radar): post-edit tells clone drift and a pasted copy once each', async () => {
    writeFile(root, 'src/lib/strings.ts', SLUGIFY);
    writeFile(root, 'src/ui/utils.ts', TO_SLUG);
    commitAll(root, { author: 'Ada', date: daysAgo(2), message: 'helpers' });
    expect((await cli(['hook', 'session-start'], claude(root, 'SessionStart', undefined, undefined, { source: 'startup' }))).code).toBe(0);
    const edit = { file_path: 'src/lib/strings.ts', old_string: "return 'item';", new_string: "return 'untitled';" };
    expect((await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Edit', edit))).stdout).toBe('');
    editFile(root, 'src/lib/strings.ts', edit.old_string, edit.new_string);
    const drift = JSON.parse((await cli(['hook', 'post-edit'], claude(root, 'PostToolUse', 'Edit', edit))).stdout).hookSpecificOutput.additionalContext as string;
    expect(drift).toContain('- You changed src/lib/strings.ts:1-9; its clone src/ui/utils.ts:1-9 was not changed. If the edit fixed something, the copy probably needs it too.');
    // A Write of a copy into a new file: "this already exists". The drift was told already.
    const write = { file_path: path.join(root, 'src/pages/slug.ts'), content: SLUGIFY.replace('slugify', 'slugAgain') };
    expect((await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Write', write))).stdout).toBe('');
    writeFile(root, 'src/pages/slug.ts', write.content);
    const pasted = JSON.parse((await cli(['hook', 'post-edit'], claude(root, 'PostToolUse', 'Write', write))).stdout).hookSpecificOutput.additionalContext as string;
    expect(pasted).toMatch(/- slugAgain in src\/pages\/slug\.ts is \d+% similar to exported (slugify in src\/lib\/strings\.ts|toSlug in src\/ui\/utils\.ts) and 1 more copy: import it instead\. The existing one is at /);
    expect(pasted).not.toContain('You changed');
  });

  it('stop blocks (with --strict) until a passing test run covers the changes; stop_hook_active never blocks', async () => {
    await cli(['hook', 'session-start'], claude(root, 'SessionStart'));
    fs.appendFileSync(path.join(root, 'src/components/Button.tsx'), '\n// tweak\n');
    const blocked = await cli(['hook', 'stop', '--strict'], claude(root, 'Stop', undefined, undefined, { stop_hook_active: false }));
    const out = JSON.parse(blocked.stdout) as { decision: string; reason: string };
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Run: npx vitest run src/components/Button.test.tsx (it covers the file you changed)');
    // Without --strict: a note for the person, nothing for the agent.
    const soft = await cli(['hook', 'stop'], claude(root, 'Stop'));
    expect(soft.stdout).toBe('');
    expect(soft.stderr).toContain('npx vitest run src/components/Button.test.tsx');
    expect((await cli(['hook', 'stop', '--strict'], claude(root, 'Stop', undefined, undefined, { stop_hook_active: true }))).stdout).toBe('');
    // A passing `code-visualizer test` of this very tree satisfies the gate.
    updateState(root, 'lastTest', { at: Date.now(), passed: true, exitCode: 0, mode: 'working', files: ['src/components/Button.test.tsx'], full: false, durationMs: 10, treeId: await workingTreeId(root), command: 'npx vitest run src/components/Button.test.tsx' });
    expect(await cli(['hook', 'stop', '--strict'], claude(root, 'Stop'))).toEqual({ code: 0, stdout: '', stderr: '' });
    // …until the tree changes again.
    fs.appendFileSync(path.join(root, 'src/components/Button.tsx'), '// again\n');
    expect(JSON.parse((await cli(['hook', 'stop', '--strict'], claude(root, 'Stop'))).stdout).decision).toBe('block');
  });

  it('a session head that is not a commit hash never reaches git as an option (release fix)', async () => {
    await cli(['hook', 'session-start'], claude(root, 'SessionStart'));
    const file = sessionFile(root, 'sess-1');
    const marker = path.join(makeTempDir('cv-session-'), 'x');
    const session = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...session, head: `--output=${marker}` }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readSession(root, 'sess-1')?.head).toBeUndefined();
    fs.appendFileSync(path.join(root, 'src/components/Button.tsx'), '\n// tweak\n');
    await cli(['hook', 'stop', '--strict'], claude(root, 'Stop'));
    await cli(['hook', 'post-edit'], claude(root, 'PostToolUse', 'Edit', { file_path: path.join(root, 'src/components/Button.tsx'), old_string: 'x', new_string: 'y' }));
    expect(fs.existsSync(marker)).toBe(false);
    expect(await changedFiles(root, `--output=${marker}`)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    // A session file anyone else could have written (not 0600) is not read at all.
    fs.chmodSync(file, 0o644);
    expect(readSession(root, 'sess-1')).toBeUndefined();
    fs.chmodSync(file, 0o600);
    expect(readSession(root, 'sess-1')).toBeDefined();
  });

  it('session-start gives a short brief with the rules and records the session', async () => {
    const { code, stdout } = await cli(['hook', 'session-start'], claude(root, 'SessionStart', undefined, undefined, { source: 'startup' }));
    expect(code).toBe(0);
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext as string;
    expect(context.length).toBeLessThanOrEqual(1500);
    expect(context).toContain('components-no-api');
    expect(context).toContain('Branch `main`');
    expect(context).toMatch(/Most depended-on files: `src\/types\.ts`/);
    const session = readSession(root, 'sess-1');
    expect(session).toMatchObject({ id: 'sess-1', branch: 'main', dirty: {} });
    expect(Object.keys(session!.exports)).toContain('src/utils/format.ts#formatDate');
  });

  it('stop never gates work the agent did not do, nor a Cursor turn the person aborted', async () => {
    // The person's own uncommitted edit, and conversations that edited nothing through the hooks.
    fs.appendFileSync(path.join(root, 'src/components/Button.tsx'), '\n// mine\n');
    const fresh = JSON.stringify({ conversation_id: 'c9', hook_event_name: 'stop', status: 'completed', loop_count: 0, workspace_roots: [root] });
    expect(await cli(['hook', 'stop', '--dialect', 'cursor', '--strict'], fresh)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await cli(['hook', 'stop', '--strict'], claude(root, 'Stop'))).toEqual({ code: 0, stdout: '', stderr: '' });
    // A conversation with findings to relay: an aborted turn keeps them for the next stop instead of restarting the agent.
    const edit = { old_string: 'export function formatDate(iso: string): string {', new_string: 'export function formatDate(iso: string, locale: string): string {' };
    editFile(root, 'src/utils/format.ts', edit.old_string, edit.new_string);
    await cli(['hook', 'post-edit', '--dialect', 'cursor'], JSON.stringify({ conversation_id: 'c10', hook_event_name: 'afterFileEdit', workspace_roots: [root], file_path: path.join(root, 'src/utils/format.ts'), edits: [edit] }));
    const stopped = (status: string) => JSON.stringify({ conversation_id: 'c10', hook_event_name: 'stop', status, loop_count: 0, workspace_roots: [root] });
    expect((await cli(['hook', 'stop', '--dialect', 'cursor', '--strict'], stopped('aborted'))).stdout).toBe('');
    expect((await cli(['hook', 'stop', '--dialect', 'cursor', '--strict'], stopped('error'))).stdout).toBe('');
    expect(readSession(root, 'c10')?.pending?.join('\n')).toContain('src/components/UserCard.tsx:16');
    const completed = await cli(['hook', 'stop', '--dialect', 'cursor'], stopped('completed'));
    expect(JSON.parse(completed.stdout).followup_message).toContain('src/components/UserCard.tsx:16');
  });

  it("Cursor: a conversation's first edit that deletes an export is still reported (and old sessions are pruned)", async () => {
    const old = sessionFile(root, 'old-conversation');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, JSON.stringify({ id: 'old-conversation', startedAt: 0, fingerprints: [], exports: {} }));
    const past = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);
    const text = read(root, 'src/utils/format.ts');
    const start = text.indexOf('export function formatDate');
    const fn = text.slice(start, text.indexOf('\n}\n', start) + 3);
    fs.writeFileSync(path.join(root, 'src/utils/format.ts'), text.replace(fn, ''));
    // Deleting text cannot be reverted from the edit itself: the committed text stands in for the original.
    const payload = JSON.stringify({ conversation_id: 'del-1', hook_event_name: 'afterFileEdit', workspace_roots: [root], file_path: path.join(root, 'src/utils/format.ts'), edits: [{ old_string: fn, new_string: '' }] });
    expect(await cli(['hook', 'post-edit', '--dialect', 'cursor'], payload)).toEqual({ code: 0, stdout: '', stderr: '' });
    const pending = readSession(root, 'del-1')?.pending?.join('\n') ?? '';
    expect(pending).toContain('formatDate was removed from src/utils/format.ts');
    expect(pending).toContain('src/components/UserCard.tsx');
    expect(readSession(root, 'del-1')?.originals?.['src/utils/format.ts']).toBe(text);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('pre-edit offers a function that already uses the target, never a page, and dev installs for tests', async () => {
    const page = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Write', { file_path: 'src/components/NewThing.tsx', content: "import { fetchUser } from '@/api/client';\nexport const load = (id: string) => fetchUser(id);\n" }));
    const reason = JSON.parse(page.stdout).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain('src/components/NewThing.tsx must not import src/api/client.ts (rule components-no-api)');
    expect(reason).not.toContain('src/pages/');
    expect(reason).toContain('src/hooks/useUsers.ts exports useUsers(), which already uses src/api/client.ts');
    const dev = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Write', { file_path: 'src/components/Card.test.tsx', content: "import userEvent from '@testing-library/user-event';\nexport const u = userEvent;\n" }));
    expect(JSON.parse(dev.stdout).hookSpecificOutput.permissionDecisionReason).toContain('npm install -D @testing-library/user-event');
  });

  it('pre-edit refuses an import that was commented out before', async () => {
    writeFile(root, 'src/components/Card.tsx', `// import { fetchUsers } from '../api/client';\n${read(root, 'src/components/Card.tsx')}`);
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'note' });
    const { stdout } = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Edit', { file_path: 'src/components/Card.tsx', old_string: "// import { fetchUsers } from '../api/client';", new_string: "import { fetchUsers } from '../api/client';" }));
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('says so when the configuration is invalid instead of silently allowing everything', async () => {
    writeFile(root, 'code-visualizer.config.json', '{ "rules": [ { "from": ');
    const first = read(root, 'src/components/Card.tsx').split('\n')[0];
    const payload = claude(root, 'PreToolUse', 'Edit', { file_path: 'src/components/Card.tsx', old_string: first, new_string: `${first}\nimport { fetchUsers } from '../api/client';` });
    const pre = await cli(['hook', 'pre-edit'], payload);
    expect(pre.code).toBe(0);
    expect(pre.stderr).toContain('code-visualizer.config.json is invalid');
    expect(JSON.parse(pre.stdout).hookSpecificOutput.additionalContext).toContain('its architecture rules and layers are not checked until it is fixed');
    // The agent hears it once per session; the person sees it every time.
    const again = await cli(['hook', 'pre-edit'], payload);
    expect(again.stdout).toBe('');
    expect(again.stderr).toContain('is invalid');
    const brief = JSON.parse((await cli(['hook', 'session-start'], claude(root, 'SessionStart', undefined, undefined, { source: 'startup' }))).stdout).hookSpecificOutput.additionalContext as string;
    expect(brief).toContain('code-visualizer.config.json is invalid');
    expect(brief).not.toContain('No architecture rules are configured');
  });

  it('fails open: malformed stdin, an unknown event and CODE_VISUALIZER_HOOKS=off', async () => {
    const bad = await cli(['hook', 'pre-edit'], '{not json');
    expect(bad.code).toBe(0);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('stdin is not JSON');
    expect((await cli(['hook', 'pre-edit'], '')).code).toBe(0);
    const unknown = await cli(['hook', 'on-save'], '{}');
    expect(unknown.code).toBe(1); // never 2: Claude Code reads exit code 2 as "block"
    process.env.CODE_VISUALIZER_HOOKS = 'off';
    try {
      const first = read(root, 'src/components/Card.tsx').split('\n')[0];
      expect(await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Edit', { file_path: 'src/components/Card.tsx', old_string: first, new_string: `${first}\nimport { api } from '../api/client';` }))).toEqual({ code: 0, stdout: '', stderr: '' });
    } finally {
      delete process.env.CODE_VISUALIZER_HOOKS;
    }
  });
});

describe.skipIf(!hasGit)('POST /api/whatif and hooks through a running serve', () => {
  let root: string;
  let live: LiveServer | undefined;
  let saved: string | undefined;
  beforeEach(() => {
    root = project();
    saved = process.env.CODE_VISUALIZER_NO_CACHE;
    delete process.env.CODE_VISUALIZER_NO_CACHE;
  });
  afterEach(async () => {
    await live?.close();
    live = undefined;
    if (saved === undefined) delete process.env.CODE_VISUALIZER_NO_CACHE;
    else process.env.CODE_VISUALIZER_NO_CACHE = saved;
  });

  it('answers what-ifs with the token only, keeps paths inside the project, and serves the hooks', async () => {
    live = await serve({ root, port: 0, git: false, includeSource: false, writeHistory: false });
    const url = new URL('/api/whatif', live.url).toString();
    const card = read(root, 'src/components/Card.tsx');
    const body = JSON.stringify({ guard: 'pre-edit', overlay: { 'src/components/Card.tsx': `${card}\nimport { fetchUsers } from '../api/client';\n` } });
    expect((await httpRequest(url, { method: 'POST', body })).status).toBe(401);
    const headers = { 'X-CV-Token': live.info.token, 'Content-Type': 'application/json' };
    const answer = await httpRequest(url, { method: 'POST', body, headers });
    expect(answer.status).toBe(200);
    const findings = (JSON.parse(answer.text) as { findings: GuardFinding[] }).findings;
    expect(findings.map((f) => [f.kind, f.severity, f.file])).toEqual([['forbidden-import', 'block', 'src/components/Card.tsx']]);
    const escape = await httpRequest(url, { method: 'POST', body: JSON.stringify({ file: '../outside.ts', text: '' }), headers });
    expect(escape.status).toBe(400);
    // An absolute path inside the project is the same file.
    const absolute = await httpRequest(url, { method: 'POST', body: JSON.stringify({ guard: 'pre-edit', overlay: { [path.join(root, 'src/components/Card.tsx')]: `${card}\nimport { fetchUsers } from '../api/client';\n` } }), headers });
    expect((JSON.parse(absolute.text) as { findings: GuardFinding[] }).findings.map((f) => [f.kind, f.file])).toEqual([['forbidden-import', 'src/components/Card.tsx']]);
    // A plain what-if answers with the architecture delta.
    const delta = JSON.parse((await httpRequest(url, { method: 'POST', body: JSON.stringify({ file: 'src/components/Card.tsx', text: `${card}\nimport { fetchUsers } from '../api/client';\n` }), headers })).text) as { delta: { newViolations: { rule: string }[] } };
    expect(delta.delta.newViolations.map((v) => v.rule)).toEqual(['components-no-api']);
    // The hook takes the server's answer.
    const first = card.split('\n')[0];
    const hook = await cli(['hook', 'pre-edit'], claude(root, 'PreToolUse', 'Edit', { file_path: 'src/components/Card.tsx', old_string: first, new_string: `${first}\nimport { fetchUsers } from '../api/client';` }));
    expect(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    // …without analyzing here (a local run would have written the warm parse cache).
    expect(fs.existsSync(path.join(root, '.code-visualizer', 'cache'))).toBe(false);
  });

  it('integration (clone-radar): post-edit what-ifs tell clone drift from the lines changed on disk', async () => {
    writeFile(root, 'src/lib/strings.ts', SLUGIFY);
    writeFile(root, 'src/ui/utils.ts', TO_SLUG);
    live = await serve({ root, port: 0, git: false, includeSource: false, writeHistory: false });
    editFile(root, 'src/lib/strings.ts', "return 'item';", "return 'untitled';");
    const headers = { 'X-CV-Token': live.info.token, 'Content-Type': 'application/json' };
    // The overlay is the file as the session found it; the server reads the edited one from disk.
    const body = JSON.stringify({ guard: 'post-edit', overlay: { 'src/lib/strings.ts': SLUGIFY }, files: ['src/lib/strings.ts'] });
    const answer = await httpRequest(new URL('/api/whatif', live.url).toString(), { method: 'POST', body, headers });
    expect(answer.status).toBe(200);
    const findings = (JSON.parse(answer.text) as { findings: GuardFinding[] }).findings;
    expect(findings.filter((f) => f.kind === 'clone').map((f) => f.message)).toEqual(['You changed src/lib/strings.ts:1-9; its clone src/ui/utils.ts:1-9 was not changed.']);
  });
});

describe.skipIf(!hasGit)('context --agents', () => {
  it('maintains the managed block: unchanged runs leave the file alone, text outside the markers stays', async () => {
    const root = project();
    writeFile(root, 'AGENTS.md', '# Team notes\n\nUse pnpm.\n');
    const first = await cli(['context', '--agents', '--write', '--claude', '--root', root, '--no-git']);
    expect(first.code).toBe(0);
    const text = read(root, 'AGENTS.md');
    expect(text.startsWith('# Team notes\n\nUse pnpm.\n\n<!-- code-visualizer:start -->\n')).toBe(true);
    expect(text).toContain('`components-no-api`: src/components/** does not import src/api/**');
    expect(text).toContain('- One test file: `npx vitest run <file>`');
    const block = text.slice(text.indexOf('<!-- code-visualizer:start -->'), text.indexOf('<!-- code-visualizer:end -->'));
    expect(block.split('\n').length).toBeLessThanOrEqual(60);
    expect(read(root, 'CLAUDE.md')).toContain('@AGENTS.md');
    const mtime = fs.statSync(path.join(root, 'AGENTS.md')).mtimeMs;
    // Someone edits outside the markers; a second run keeps that and changes nothing else.
    fs.writeFileSync(path.join(root, 'AGENTS.md'), text.replace('Use pnpm.', 'Use pnpm, always.'));
    const edited = fs.statSync(path.join(root, 'AGENTS.md')).mtimeMs;
    const second = await cli(['context', '--agents', '--write', '--claude', '--root', root, '--no-git']);
    expect(second.stderr).toContain('is up to date');
    expect(fs.statSync(path.join(root, 'AGENTS.md')).mtimeMs).toBe(edited);
    expect(read(root, 'AGENTS.md')).toContain('Use pnpm, always.');
    expect(mtime).toBeGreaterThan(0);
    // Printed without --write.
    expect((await cli(['context', '--agents', '--root', root, '--no-git'])).stdout).toMatch(/^<!-- code-visualizer:start -->/);
  });

  it('only treats markers on lines of their own as the block, and refuses unbalanced markers', async () => {
    const root = project();
    const mention = '# Notes\n\nThe map sits between `<!-- code-visualizer:start -->` and `<!-- code-visualizer:end -->`; do not edit it.\n';
    writeFile(root, 'AGENTS.md', mention);
    expect((await cli(['context', '--agents', '--write', '--root', root, '--no-git'])).code).toBe(0);
    expect(read(root, 'AGENTS.md').startsWith(`${mention}\n<!-- code-visualizer:start -->\n`)).toBe(true);
    // The end marker was deleted by hand: a run must not append a second block or eat the text after it.
    const orphan = '# Team notes\n\n<!-- code-visualizer:start -->\nhalf-deleted old block\n\n## Deployment\n\nNever deploy on Fridays.\n';
    writeFile(root, 'AGENTS.md', orphan);
    for (let i = 0; i < 2; i++) {
      const run = await cli(['context', '--agents', '--write', '--root', root, '--no-git']);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('line 3 has <!-- code-visualizer:start --> without a matching <!-- code-visualizer:end -->');
      expect(read(root, 'AGENTS.md')).toBe(orphan);
    }
  });

  it('never writes the block into a source file, and names misplaced options', async () => {
    const root = project();
    const before = read(root, 'src/utils/math.ts');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const run = await cli(['context', 'src/utils/math.ts', '--agents', '--write']);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain('The block goes into a Markdown file (AGENTS.md, CLAUDE.md, …), not src/utils/math.ts.');
      expect(read(root, 'src/utils/math.ts')).toBe(before);
      expect((await cli(['context', 'src/utils/math.ts', '--agents'])).stderr).toContain('takes no file');
      const misplaced = await cli(['context', '--write']);
      expect(misplaced).toMatchObject({ code: 2 });
      expect(misplaced.stderr).toContain('--write and --claude belong to --agents.');
      // A Markdown target given to --write is fine.
      expect((await cli(['context', 'docs/AGENTS.md', '--agents', '--write', '--no-git'])).code).toBe(0);
      expect(read(root, 'docs/AGENTS.md')).toContain('<!-- code-visualizer:start -->');
    } finally {
      cwd.mockRestore();
    }
  });

  it('lists CODEOWNERS boundaries, not every folder the catch-all owner has', async () => {
    const root = project();
    writeFile(root, '.github/CODEOWNERS', '* @org/everyone\n/src/components/ @org/ui-team\n/src/api/ @org/backend\nsrc/utils/*.ts @alice\n');
    const block = (await cli(['context', '--agents', '--root', root, '--no-git'])).stdout;
    const owners = block.slice(block.indexOf('### Code owners'), block.indexOf('### Tools'));
    expect(owners).toContain('- `src/components/` → @org/ui-team');
    expect(owners).toContain('- `src/api/` → @org/backend');
    expect(owners).toContain('- `src/utils/` → @alice');
    // (release fix) the analysis knows each file's owners, not which rule is `*`: "most files", not "everything else".
    expect(owners).toContain('- most files → @org/everyone');
    expect(owners).not.toContain('`src/` →');
    expect(owners).not.toContain('`src/hooks/` →');
  });
});
