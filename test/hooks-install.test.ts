import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../src/analyzer/config.js';
import type { GateContext } from '../src/analyzer/gates.js';
import { addedLines, codeOf, hygieneFindings, hygieneGate } from '../src/analyzer/hygiene.js';
import { applyPlan, detectManagers, hookCommandLine, hooksState, isEmptyPlan, lefthookInsert, planInstall, planUninstall, simpleHookValue, unifiedDiff, type HooksContext } from '../src/cli/hooks-install.js';
import { runCli } from '../src/cli/run.js';
import type { ChangedFile, ReportData } from '../src/shared/types.js';
import { commitAll, daysAgo, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
/** Built at runtime so this file itself never contains a focused test or a conflict marker. */
const ONLY = ['it', 'only('].join('.');
const FIT = ['f', 'it'].join('');
const MARK = (c: string): string => c.repeat(7);
const REPO = fileURLToPath(new URL('..', import.meta.url));

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sinkFn: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sinkFn(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
      return true;
    }) as typeof process.stdout.write;
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture((s) => (stdout += s)));
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture((s) => (stderr += s)));
  try {
    const code = await runCli(argv);
    return { code, stdout: strip(stdout), stderr: strip(stderr) };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

/** A repository-less context for planning (files only). */
function context(top: string, extra: Partial<HooksContext> = {}): HooksContext {
  return { root: top, top, hooksDir: path.join(top, '.git', 'hooks'), ...extra };
}

/** Every file below `dir` with its content (to prove a dry run wrote nothing). */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'objects' && e.name !== 'node_modules') walk(abs);
      } else out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe('hygiene of added lines', () => {
  const diff = (lines: string[], start = 1): string => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +${start},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
  const changed = (id: string, lines: string[], status: ChangedFile['status'] = 'added'): ChangedFile => ({ id, status, additions: lines.length, deletions: 0, lines: [], diff: diff(lines), analyzed: true });

  it('reads added lines with their new line numbers', () => {
    const text = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,4 @@', ' keep', '-gone', '+new one', '+new two', ' tail', '@@ -10,2 +11,2 @@', ' ctx', '+late', '\\ No newline at end of file'].join('\n');
    expect(addedLines(text)).toEqual([
      { line: 2, text: 'new one' },
      { line: 3, text: 'new two' },
      { line: 12, text: 'late' },
    ]);
  });

  it('finds focused tests, debugger statements and conflict markers', () => {
    const found = hygieneFindings([
      changed('src/cart.test.ts', ["import { it } from 'vitest';", `${ONLY}'adds', () => {});`, `  // never ${ONLY}`, `f${'it'}('x', () => {});`]),
      changed('src/cart.ts', ['export function add() {', '  debugger;', '}', `const ${FIT} = (a) => a; ${FIT}(1);`]),
      changed('src/merge.ts', [`${MARK('<')} HEAD`, 'a', MARK('='), 'b', `${MARK('>')} feature`]),
      changed('README.md', ['Title', MARK('='), `${ONLY}`]),
      changed('src/gone.test.ts', [`${ONLY}'x')`], 'deleted'),
    ]);
    expect(found.map((f) => `${f.kind} ${f.file}:${f.line}`)).toEqual([
      'focused-test src/cart.test.ts:2',
      'focused-test src/cart.test.ts:4',
      'debugger src/cart.ts:2',
      'conflict-marker src/merge.ts:1',
      'conflict-marker src/merge.ts:3',
      'conflict-marker src/merge.ts:5',
    ]);
    expect(found[0].text).toBe(`${ONLY}'adds', () => {});`);
    expect(hygieneFindings([changed('a.test.ts', [`${ONLY}'x')`, 'debugger;'])], { kinds: ['debugger'] }).map((f) => f.kind)).toEqual(['debugger']);
  });

  it('ignores member calls, methods, strings and git prose; finds the focused forms test runners have', () => {
    const only = (name: string): string => `${name}.${'only'}`;
    const found = hygieneFindings([
      changed('test/model.test.ts', [
        `await model.${FIT}(xs, ys);`,
        `cy.${FIT}();`,
        `class FitAddon { ${FIT}() { this.fitted = true; } }`,
        `expect(lint('${ONLY}x)')).toBe(1);`,
        `const s = \`${only('describe')}(\`;`,
        `${FIT}(1);`,
        `foo.${ONLY}'x');`,
        'debugger; // remove before merging',
        `  ${only('test.describe')}('suite', () => {});`,
        `${only('describe')}.each([1])('row %d', () => {});`,
        `/* ${ONLY}'x') */ run();`,
      ]),
      changed('docs/git.md', [`${MARK('<')} HEAD is what git writes before your side`, 'and then', MARK('=')]),
    ]);
    expect(found.map((f) => `${f.kind} ${f.file}:${f.line}`)).toEqual(['debugger test/model.test.ts:8', 'focused-test test/model.test.ts:9', 'focused-test test/model.test.ts:10']);
    expect(codeOf(`a('x // y', "z") // c`)).toBe(`a('      ', " ") `);
  });

  it('this repository is clean: its own sources and tests, read as added lines, have no findings', () => {
    const files: ChangedFile[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== 'fixtures' && e.name !== 'node_modules') walk(rel);
        } else if (/\.(?:[cm]?[jt]sx?|md|json|ya?ml)$/.test(e.name)) {
          const text = fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\n$/, '').split('\n');
          files.push({ id: rel, status: 'added', additions: text.length, deletions: 0, lines: [], analyzed: true, diff: `@@ -0,0 +1,${text.length} @@\n${text.map((l) => `+${l}`).join('\n')}\n` });
        }
      }
    };
    for (const dir of ['src', 'test', 'ui/src', 'docs', '.github']) if (fs.existsSync(path.join(REPO, dir))) walk(dir);
    expect(files.length).toBeGreaterThan(50);
    expect(hygieneFindings(files, { isTest: (f) => f.startsWith('test/') }).map((f) => `${f.file}:${f.line} ${f.text}`)).toEqual([]);
  });

  it('the gate judges the files the analysis covers: exclude, --directory and check.hygiene.exclude apply', () => {
    const block = [`${MARK('<')} ours`, 'a', MARK('='), 'b', `${MARK('>')} theirs`];
    const data = {
      files: [{ id: 'src/a.ts', kind: 'source' }],
      scope: { type: 'project' },
      changes: {
        files: [
          changed('src/a.ts', ['debugger;']),
          // Excluded from the analysis (config "exclude": ["vendor/**"]).
          { ...changed('vendor/lib.js', ['debugger;']), analyzed: false },
          changed('test/fixtures/conflict.txt', block),
          changed('notes/conflict.txt', block),
        ],
      },
    } as unknown as ReportData;
    const ctx = (hygiene?: unknown): GateContext => ({ mode: 'staged', newOnly: true, thresholds: { hygiene } as GateContext['thresholds'], inScope: () => true });
    const where = (d: ReportData, c: GateContext): string[] => (hygieneGate(d, c)?.findings ?? []).map((f) => `${f.file}:${f.line}`);
    expect(where(data, ctx())).toEqual(['src/a.ts:1', 'test/fixtures/conflict.txt:1', 'test/fixtures/conflict.txt:3', 'test/fixtures/conflict.txt:5', 'notes/conflict.txt:1', 'notes/conflict.txt:3', 'notes/conflict.txt:5']);
    const excluded = normalizeConfig({ check: { hygiene: { exclude: ['test/fixtures/**'] } } }).config.check?.hygiene;
    expect(excluded).toEqual({ kinds: ['focused-test', 'debugger', 'conflict-marker'], exclude: ['test/fixtures/**'] });
    expect(where(data, ctx(excluded))).toEqual(['src/a.ts:1', 'notes/conflict.txt:1', 'notes/conflict.txt:3', 'notes/conflict.txt:5']);
    expect(where({ ...data, scope: { type: 'directory', path: 'src' } } as ReportData, ctx())).toEqual(['src/a.ts:1']);
    expect(where({ ...data, files: [] } as unknown as ReportData, ctx({ kinds: ['debugger'], exclude: [] }))).toEqual([]);
  });

  it('check.hygiene accepts a switch, kinds or an object', () => {
    expect(normalizeConfig({ check: { hygiene: 'off' } }).config.check?.hygiene).toBe(false);
    expect(normalizeConfig({ check: { hygiene: 'debugger, conflict-marker' } }).config.check?.hygiene).toEqual(['debugger', 'conflict-marker']);
    expect(normalizeConfig({ check: { hygiene: { debugger: false } } }).config.check?.hygiene).toEqual(['focused-test', 'conflict-marker']);
    expect(normalizeConfig({ check: { hygiene: ['focused-test', 'debugger', 'conflict-marker'] } }).config.check?.hygiene).toBe(true);
    expect(normalizeConfig({ check: { hygiene: ['debuger'] } }).error).toContain('did you mean "debugger"');
    expect(normalizeConfig({ check: { hygiene: { debugger: false, exclude: 'fixtures/**' } } }).config.check?.hygiene).toEqual({ kinds: ['focused-test', 'conflict-marker'], exclude: ['fixtures/**'] });
    expect(normalizeConfig({ check: { hygiene: { exclude: [1] } } }).error).toContain('check.hygiene.exclude');
  });
});

describe('hooks: planning edits', () => {
  it('husky: adds a marked block and uninstall restores the file byte for byte', () => {
    const top = makeTempDir('cv-husky-');
    const original = 'npx lint-staged\n';
    writeFile(top, '.husky/pre-commit', original);
    const ctx = context(top);
    expect(detectManagers(ctx)[0]).toBe('husky');
    const plan = planInstall(ctx, 'husky', ['pre-commit']);
    applyPlan(plan);
    const installed = fs.readFileSync(path.join(top, '.husky/pre-commit'), 'utf8');
    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toContain('# code-visualizer:start pre-commit');
    expect(installed).toContain('CODE_VISUALIZER_HOOK=pre-commit "$cv_bin" check --staged --quiet-pass || exit $?');
    expect(installed.trimEnd().endsWith('# code-visualizer:end pre-commit')).toBe(true);
    expect(hooksState(ctx, 'husky').find((h) => h.hook === 'pre-commit')?.installed).toBe(true);
    // Idempotent.
    expect(isEmptyPlan(planInstall(ctx, 'husky', ['pre-commit']))).toBe(true);
    applyPlan(planUninstall(ctx, 'husky', ['pre-commit']));
    expect(fs.readFileSync(path.join(top, '.husky/pre-commit'), 'utf8')).toBe(original);
  });

  it('husky: exact even without a final newline; a created file is removed again', () => {
    const top = makeTempDir('cv-husky-eol-');
    writeFile(top, '.husky/pre-commit', 'npm test');
    const ctx = context(top);
    applyPlan(planInstall(ctx, 'husky', ['pre-commit', 'pre-push']));
    expect(fs.existsSync(path.join(top, '.husky/pre-push'))).toBe(true);
    expect(fs.readFileSync(path.join(top, '.husky/pre-push'), 'utf8')).toContain('check --changed --committed --quiet-pass');
    applyPlan(planUninstall(ctx, 'husky', ['pre-commit', 'pre-push']));
    expect(fs.readFileSync(path.join(top, '.husky/pre-commit'), 'utf8')).toBe('npm test');
    expect(fs.existsSync(path.join(top, '.husky/pre-push'))).toBe(false);
  });

  it('lefthook: into the existing commands, a second install is a no-op, uninstall is exact', () => {
    const top = makeTempDir('cv-lefthook-');
    const original = ['# lefthook config', 'pre-commit:', '  parallel: true', '  commands:', '    lint:', '      run: npx eslint {staged_files}', '', 'commit-msg:', '  scripts:', '    "check.sh":', '      runner: bash', ''].join('\n');
    writeFile(top, 'lefthook.yml', original);
    const ctx = context(top);
    expect(detectManagers(ctx)[0]).toBe('lefthook');
    const plan = planInstall(ctx, 'lefthook', ['pre-commit', 'pre-push']);
    applyPlan(plan);
    const text = fs.readFileSync(path.join(top, 'lefthook.yml'), 'utf8');
    expect(text).toContain(['  commands:', '    # code-visualizer:start pre-commit', '    code-visualizer:', "      run: 'CODE_VISUALIZER_HOOK=pre-commit npx --no-install code-visualizer check --staged --quiet-pass'", '    # code-visualizer:end pre-commit', '    lint:'].join('\n'));
    expect(text).toContain(['# code-visualizer:start pre-push', 'pre-push:', '  commands:', '    code-visualizer:', "      run: 'CODE_VISUALIZER_HOOK=pre-push npx --no-install code-visualizer check --changed --committed --quiet-pass'", '# code-visualizer:end pre-push'].join('\n'));
    expect(isEmptyPlan(planInstall(ctx, 'lefthook', ['pre-commit', 'pre-push']))).toBe(true);
    applyPlan(planUninstall(ctx, 'lefthook', ['pre-commit', 'pre-push']));
    expect(fs.readFileSync(path.join(top, 'lefthook.yml'), 'utf8')).toBe(original);
  });

  it('lefthook: a hook without commands gets its own commands map', () => {
    const text = ['pre-commit:', '  jobs:', '    - run: npm test', ''].join('\n');
    const next = lefthookInsert(text, 'pre-commit', 'cv check')!;
    expect(next).toBe(['pre-commit:', '  # code-visualizer:start pre-commit', '  commands:', '    code-visualizer:', "      run: 'cv check'", '  # code-visualizer:end pre-commit', '  jobs:', '    - run: npm test', ''].join('\n'));
  });

  it('lefthook: a quoted key is used; an inline value is left for a manual edit (never a duplicate key)', () => {
    const quoted = lefthookInsert(['"pre-commit":', '  commands:', '    lint:', '      run: x', ''].join('\n'), 'pre-commit', 'cv')!;
    expect(quoted.split('\n').filter((l) => /^\S/.test(l))).toEqual(['"pre-commit":']);
    expect(quoted).toContain("      run: 'cv'");
    expect(lefthookInsert('pre-commit: {}\n', 'pre-commit', 'cv')).toBeUndefined();
    expect(lefthookInsert("'pre-push': { commands: {} }\n", 'pre-push', 'cv')).toBeUndefined();
    const top = makeTempDir('cv-lefthook-inline-');
    writeFile(top, 'lefthook.yml', 'pre-commit: {}\n');
    const plan = planInstall(context(top), 'lefthook', ['pre-commit', 'pre-push']);
    expect(plan.changed).toEqual(['pre-push']);
    expect(plan.notes.join(' ')).toContain('Could not place the pre-commit command');
  });

  it('husky: an existing hook keeps its mode, and the block goes before a final exit / exec', () => {
    const top = makeTempDir('cv-husky-exit-');
    const original = '#!/bin/sh\necho "lint-staged ran"\nexit 0\n';
    writeFile(top, '.husky/pre-commit', original);
    fs.chmodSync(path.join(top, '.husky/pre-commit'), 0o644);
    const ctx = context(top);
    const plan = planInstall(ctx, 'husky', ['pre-commit']);
    expect(plan.edits[0].mode).toBeUndefined();
    applyPlan(plan);
    const installed = fs.readFileSync(path.join(top, '.husky/pre-commit'), 'utf8');
    expect(installed.indexOf('# code-visualizer:end pre-commit')).toBeLessThan(installed.indexOf('exit 0'));
    expect(installed.endsWith('exit 0\n')).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(top, '.husky/pre-commit')).mode & 0o777).toBe(0o644);
    applyPlan(planUninstall(ctx, 'husky', ['pre-commit']));
    expect(fs.readFileSync(path.join(top, '.husky/pre-commit'), 'utf8')).toBe(original);
    // `exec` ends a script too.
    writeFile(top, '.husky/pre-push', 'exec npx lint-staged');
    applyPlan(planInstall(ctx, 'husky', ['pre-push']));
    expect(fs.readFileSync(path.join(top, '.husky/pre-push'), 'utf8')).toMatch(/# code-visualizer:end pre-push\nexec npx lint-staged$/);
    applyPlan(planUninstall(ctx, 'husky', ['pre-push']));
    expect(fs.readFileSync(path.join(top, '.husky/pre-push'), 'utf8')).toBe('exec npx lint-staged');
  });

  it('simple-git-hooks: appends one segment and removes exactly that', () => {
    const top = makeTempDir('cv-sgh-');
    const original = `${JSON.stringify({ name: 'x', devDependencies: { 'simple-git-hooks': '^2' }, 'simple-git-hooks': { 'pre-commit': 'npx lint-staged' } }, null, 2)}\n`;
    writeFile(top, 'package.json', original);
    writeFile(top, 'node_modules/.bin/code-visualizer', '#!/bin/sh\n');
    const ctx = context(top);
    expect(detectManagers(ctx)[0]).toBe('simple-git-hooks');
    const plan = planInstall(ctx, 'simple-git-hooks', ['pre-commit', 'pre-push']);
    expect(plan.notes.join(' ')).toContain('npx simple-git-hooks');
    applyPlan(plan);
    const pkg = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8'));
    expect(pkg['simple-git-hooks']['pre-commit']).toBe('npx lint-staged && CODE_VISUALIZER_HOOK=pre-commit ./node_modules/.bin/code-visualizer check --staged --quiet-pass');
    expect(pkg['simple-git-hooks']['pre-push']).toBe('CODE_VISUALIZER_HOOK=pre-push ./node_modules/.bin/code-visualizer check --changed --committed --quiet-pass');
    expect(isEmptyPlan(planInstall(ctx, 'simple-git-hooks', ['pre-commit', 'pre-push']))).toBe(true);
    applyPlan(planUninstall(ctx, 'simple-git-hooks', ['pre-commit', 'pre-push']));
    expect(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).toBe(original);
    expect(simpleHookValue('a && CODE_VISUALIZER_HOOK=pre-push x check && b', undefined)).toBe('a && b');
  });

  it('simple-git-hooks in a hand-formatted package.json: replaced in place ($$ kept), a missing key is a note', () => {
    const top = makeTempDir('cv-sgh-compact-');
    const original = '{"name":"x","simple-git-hooks":{"pre-commit":"echo $$ > /tmp/pid && lint"}}';
    writeFile(top, 'package.json', original);
    const ctx = context(top);
    const plan = planInstall(ctx, 'simple-git-hooks', ['pre-commit', 'pre-push']);
    expect(plan.changed).toEqual(['pre-commit']);
    expect(plan.notes.join(' ')).toContain('formatted by hand: set "pre-push"');
    applyPlan(plan);
    const text = fs.readFileSync(path.join(top, 'package.json'), 'utf8');
    expect(JSON.parse(text)['simple-git-hooks']['pre-commit']).toBe('echo $$ > /tmp/pid && lint && CODE_VISUALIZER_HOOK=pre-commit npx --no-install code-visualizer check --staged --quiet-pass');
    expect(hooksState(ctx, 'simple-git-hooks').map((h) => h.installed)).toEqual([true, false]);
    applyPlan(planUninstall(ctx, 'simple-git-hooks', ['pre-commit', 'pre-push']));
    expect(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).toBe(original);
  });

  it('plain git: a hook generated by husky v4 (it needs its own file name) is left alone with a note', () => {
    const top = makeTempDir('cv-husky4-');
    writeFile(top, '.git/hooks/pre-commit', '#!/bin/sh\n# husky\n. "$(dirname "$0")/husky.sh"\n');
    const plan = planInstall(context(top), 'git', ['pre-commit', 'pre-push']);
    expect(plan.renames).toEqual([]);
    expect(plan.changed).toEqual(['pre-push']);
    expect(plan.notes.join(' ')).toContain('generated by a hook manager (husky v4 or yorkie)');
    // husky v4 configured in package.json (hooks not installed yet): no plain hooks at all.
    const v4 = makeTempDir('cv-husky4-pkg-');
    writeFile(v4, 'package.json', JSON.stringify({ husky: { hooks: { 'pre-commit': 'lint-staged' } } }));
    const none = planInstall(context(v4), 'git', ['pre-commit']);
    expect(none.edits).toEqual([]);
    expect(none.notes.join(' ')).toContain('package.json configures hooks');
  });

  it('pre-push also runs the affected tests once the test command exists, for a sub-folder project', () => {
    const top = makeTempDir('cv-sub-');
    const ctx = context(top, { root: path.join(top, 'packages', 'web'), testCommand: true });
    const plan = planInstall(ctx, 'git', ['pre-push']);
    const script = plan.edits[0].after!;
    expect(script).toContain('cv_bin=./packages/web/node_modules/.bin/code-visualizer');
    expect(script).toContain('[ -x "$cv_bin" ] || cv_bin=./node_modules/.bin/code-visualizer');
    expect(script).toContain('CODE_VISUALIZER_HOOK=pre-push "$cv_bin" check --changed --committed --quiet-pass packages/web || exit $?');
    expect(script).toContain('CODE_VISUALIZER_HOOK=pre-push "$cv_bin" test --push packages/web || exit $?');
  });

  it('unifiedDiff shows the planned change', () => {
    expect(unifiedDiff('f', 'a\nb\n', 'a\nx\nb\n')).toBe(['--- a/f', '+++ b/f', '@@ -1,2 +1,3 @@', ' a', '+x', ' b'].join('\n'));
    expect(unifiedDiff('g', null, 'new\n')).toBe(['--- /dev/null', '+++ b/g', '@@ -0,0 +1,1 @@', '+new'].join('\n'));
    // Outside the repository (the shared hooks of a linked worktree): the path as it is.
    expect(unifiedDiff('/repo/.git/hooks/pre-commit', null, 'x\n').split('\n')[1]).toBe('+++ /repo/.git/hooks/pre-commit');
  });
});

describe.skipIf(!hasGit)('hooks: in a git repository', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  it.skipIf(process.platform === 'win32')('chains an existing plain git hook and runs the gates (sh)', () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    const hooks = path.join(repo, '.git', 'hooks');
    const ran = path.join(repo, 'ran.txt');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho previous >> "${ran}"\n`, { mode: 0o755 });
    // A stand-in for the installed CLI that records how it was called.
    writeFile(repo, 'node_modules/.bin/code-visualizer', `#!/bin/sh\necho "cv $CODE_VISUALIZER_HOOK $*" >> "${ran}"\nexit \${CV_EXIT:-0}\n`);
    fs.chmodSync(path.join(repo, 'node_modules/.bin/code-visualizer'), 0o755);
    const ctx: HooksContext = { root: repo, top: repo, hooksDir: hooks };
    applyPlan(planInstall(ctx, 'git', ['pre-commit']));
    expect(fs.readFileSync(path.join(hooks, 'pre-commit.cv-chained'), 'utf8')).toContain('echo previous');
    const run = (env: Record<string, string> = {}) => spawnSync('sh', [path.join(hooks, 'pre-commit')], { cwd: repo, env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });
    expect(run().status).toBe(0);
    expect(fs.readFileSync(ran, 'utf8')).toBe('previous\ncv pre-commit check --staged --quiet-pass\n');
    expect(run({ CV_EXIT: '1' }).status).toBe(1);
    // A second install changes nothing; uninstall puts the previous hook back.
    expect(isEmptyPlan(planInstall(ctx, 'git', ['pre-commit']))).toBe(true);
    applyPlan(planUninstall(ctx, 'git', ['pre-commit']));
    expect(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf8')).toBe(`#!/bin/sh\necho previous >> "${ran}"\n`);
    expect(fs.existsSync(path.join(hooks, 'pre-commit.cv-chained'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('works in a project folder with a space in its name (sh)', () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    const root = path.join(repo, 'packages', 'my web');
    const ran = path.join(repo, 'ran.txt');
    writeFile(repo, 'packages/my web/node_modules/.bin/code-visualizer', `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a" >> "${ran}"; done\necho >> "${ran}"\n`);
    fs.chmodSync(path.join(root, 'node_modules/.bin/code-visualizer'), 0o755);
    const hooks = path.join(repo, '.git', 'hooks');
    const ctx: HooksContext = { root, top: repo, hooksDir: hooks };
    applyPlan(planInstall(ctx, 'git', ['pre-commit']));
    const run = spawnSync('sh', [path.join(hooks, 'pre-commit')], { cwd: repo, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(fs.readFileSync(ran, 'utf8')).toBe('[check][--staged][--quiet-pass][packages/my web]\n');
    // One-line managers quote the binary too.
    expect(hookCommandLine('pre-commit', ctx)).toBe("CODE_VISUALIZER_HOOK=pre-commit './packages/my web/node_modules/.bin/code-visualizer' check --staged --quiet-pass 'packages/my web'");
  });

  it.skipIf(process.platform === 'win32')('pre-push hands the pushed refs to the previous hook and skips a push that only deletes branches (sh)', () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    const hooks = path.join(repo, '.git', 'hooks');
    const ran = path.join(repo, 'ran.txt');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\nwhile read -r l rest; do echo "previous $l" >> "${ran}"; done\n`, { mode: 0o755 });
    writeFile(repo, 'node_modules/.bin/code-visualizer', `#!/bin/sh\necho "cv $*" >> "${ran}"\n`);
    fs.chmodSync(path.join(repo, 'node_modules/.bin/code-visualizer'), 0o755);
    applyPlan(planInstall({ root: repo, top: repo, hooksDir: hooks }, 'git', ['pre-push']));
    const push = (input: string) => spawnSync('sh', [path.join(hooks, 'pre-push'), 'origin', 'url'], { cwd: repo, env: { PATH: '/usr/bin:/bin' }, input, encoding: 'utf8' });
    const zero = '0'.repeat(40);
    expect(push(`refs/heads/feat ${'a'.repeat(40)} refs/heads/feat ${zero}\n`).status).toBe(0);
    expect(fs.readFileSync(ran, 'utf8')).toBe('previous refs/heads/feat\ncv check --changed --committed --quiet-pass\n');
    fs.rmSync(ran);
    expect(push(`(delete) ${zero} refs/heads/old ${'b'.repeat(40)}\n`).status).toBe(0);
    expect(fs.readFileSync(ran, 'utf8')).toBe('previous (delete)\n');
  });

  it('pre-push judges what is committed: an uncommitted debugger statement does not block it', async () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(3), message: 'init' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'src/extra.js', 'export const extra = 1;\n');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'extra' });
    writeFile(repo, 'src/extra.js', 'export const extra = 1;\ndebugger;\n');
    const committed = await cli('check', repo, '--changed', '--committed', '--quiet-pass');
    expect(committed.stderr).toBe('');
    expect(committed.code).toBe(0);
    expect(committed.stdout).toMatch(/^✔ code-visualizer: \d+ gates? passed · committed, new vs main · health \d+\n$/);
    // The working tree has it (that is what --changed alone judges)…
    const working = await cli('check', repo, '--changed', '--quiet-pass');
    expect(working.code).toBe(1);
    expect(working.stderr).toContain('src/extra.js:2 `debugger` statement');
    // …and once committed, the push is blocked.
    commitAll(repo, { author: 'Alice', date: daysAgo(1), message: 'oops' });
    const blocked = await cli('check', repo, '--changed', '--committed', '--quiet-pass');
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain('src/extra.js:2 `debugger` statement');
    expect((await cli('check', repo, '--committed')).code).toBe(2);
  });

  it('respects core.hooksPath', async () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    git(repo, ['config', 'core.hooksPath', '.githooks']);
    const result = await cli('hooks', 'install', repo, '--pre-commit', '--yes');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Installed pre-commit in .githooks/');
    expect(fs.readFileSync(path.join(repo, '.githooks', 'pre-commit'), 'utf8')).toContain('# code-visualizer:start pre-commit');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    const status = await cli('hooks', 'status', repo, '--json');
    expect(JSON.parse(status.stdout).hooks).toEqual([
      { hook: 'pre-commit', installed: true, where: '.githooks/pre-commit', chained: false },
      { hook: 'pre-push', installed: false, where: '.githooks/pre-push', chained: false },
    ]);
    // Messages name what changed, and how to skip it.
    const push = await cli('hooks', 'install', repo, '--yes');
    expect(push.stdout).toContain('Installed pre-push in .githooks/');
    expect(push.stdout).toContain('Skip once: CODE_VISUALIZER_SKIP=1 git push');
    expect((await cli('hooks', 'install', repo, '--yes')).stdout).toContain('✔ Already installed in .githooks/');
    expect((await cli('hooks', 'uninstall', repo, '--pre-push', '--yes')).stdout).toContain('Removed pre-push from .githooks/');
    expect((await cli('hooks', 'uninstall', repo, '--pre-push', '--yes')).stdout).toContain('Nothing to remove: code-visualizer is not in .githooks/');
  });

  it('a manual edit that is still needed is not reported as installed', async () => {
    const repo = initRepo('express-api');
    const pkg = path.join(repo, 'package.json');
    fs.writeFileSync(pkg, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg, 'utf8')), 'simple-git-hooks': { 'pre-commit': 'npx lint-staged' } }));
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    const result = await cli('hooks', 'install', repo, '--pre-push', '--yes');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Could not install pre-push in package.json');
    expect(result.stdout).toContain('formatted by hand');
    expect(result.stdout).not.toContain('Already installed');
  });

  it('a dry run prints the diff and writes nothing', async () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    writeFile(repo, '.husky/pre-commit', 'npm test\n');
    const before = snapshotDir(repo);
    const result = await cli('hooks', 'install', repo);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('preview, nothing is written yet');
    expect(result.stdout).toContain('+# code-visualizer:start pre-commit');
    expect(result.stdout).toContain('Apply with: code-visualizer hooks install');
    expect(snapshotDir(repo)).toEqual(before);
    const json = JSON.parse((await cli('hooks', 'install', repo, '--json')).stdout);
    expect(json).toMatchObject({ action: 'install', manager: 'husky', applied: false, dryRun: true });
    expect(json.edits.map((e: { file: string; change: string }) => `${e.change} ${e.file}`)).toEqual(['update .husky/pre-commit', 'create .husky/pre-push']);
    expect(snapshotDir(repo)).toEqual(before);
    expect((await cli('hooks', 'install', repo, '--manager', 'svn')).code).toBe(2);
    expect((await cli('hooks', 'reinstall', repo)).code).toBe(2);
  });

  it('a staged focused test makes check --staged fail with file:line; --quiet-pass prints one line on success', async () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    writeFile(repo, 'test/cart.test.js', `// test runner globals\n\n${ONLY}'adds', () => {});\n`);
    git(repo, ['add', 'test/cart.test.js']);
    const failed = await cli('check', repo, '--staged', '--quiet-pass');
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('✖ Hygiene');
    expect(failed.stderr).toContain(`test/cart.test.js:3 Focused test: ${ONLY}'adds', () => {});`);
    expect(failed.stdout).toBe('');
    // Fixed (and staged): one line.
    writeFile(repo, 'test/cart.test.js', "// test runner globals\n\nit('adds', () => {});\n");
    git(repo, ['add', 'test/cart.test.js']);
    const passed = await cli('check', repo, '--staged', '--quiet-pass');
    expect(passed.stderr).toBe('');
    expect(passed.code).toBe(0);
    expect(passed.stdout).toMatch(/^✔ code-visualizer: \d+ gates? passed · staged vs HEAD · health \d+\n$/);
    expect(passed.stderr).toBe('');
    const json = JSON.parse((await cli('check', repo, '--staged', '--format', 'json')).stdout);
    expect(json.gates.find((g: { id: string }) => g.id === 'hygiene')).toMatchObject({ ok: true, findings: [] });
  });

  it('CODE_VISUALIZER_SKIP=1 skips the commands a hook runs', async () => {
    process.env.CODE_VISUALIZER_HOOK = 'pre-commit';
    process.env.CODE_VISUALIZER_SKIP = '1';
    try {
      const result = await cli('check', '--staged', '--this-flag-would-fail');
      expect(result.code).toBe(0);
      expect(result.stderr).toContain('pre-commit checks skipped (CODE_VISUALIZER_SKIP=1)');
    } finally {
      delete process.env.CODE_VISUALIZER_HOOK;
      delete process.env.CODE_VISUALIZER_SKIP;
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                               Release fixes                                */
/* -------------------------------------------------------------------------- */

describe.skipIf(!hasGit)('hooks: a global hooks folder and symlinks', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  it('refuses a core.hooksPath from the global configuration unless --global-hooks says so', async () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    const globalHooks = makeTempDir('cv-global-hooks-');
    const config = path.join(makeTempDir('cv-global-config-'), 'gitconfig');
    fs.writeFileSync(config, `[core]\n\thooksPath = ${globalHooks}\n`);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
      const refused = await cli('hooks', 'install', repo, '--yes');
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('global');
      expect(refused.stderr).toContain('--global-hooks');
      expect(fs.readdirSync(globalHooks)).toEqual([]);
      // A preview is refused the same way, and --json says why.
      const json = JSON.parse((await cli('hooks', 'install', repo, '--json')).stdout) as { error: string; global: { scope: string } };
      expect(json.global.scope).toBe('global');
      expect(fs.readdirSync(globalHooks)).toEqual([]);
      // Asked for: installed there.
      const forced = await cli('hooks', 'install', repo, '--pre-commit', '--yes', '--global-hooks');
      expect(forced.code).toBe(0);
      expect(fs.readFileSync(path.join(globalHooks, 'pre-commit'), 'utf8')).toContain('# code-visualizer:start pre-commit');
      expect((await cli('hooks', 'uninstall', repo, '--pre-commit', '--yes', '--global-hooks')).code).toBe(0);
      expect(fs.readdirSync(globalHooks)).toEqual([]);
      // A relative global hooksPath is each repository's own folder: installed there without asking.
      fs.writeFileSync(config, '[core]\n\thooksPath = .githooks\n');
      const relative = await cli('hooks', 'install', repo, '--pre-commit', '--yes');
      expect(relative.code).toBe(0);
      expect(fs.readFileSync(path.join(repo, '.githooks', 'pre-commit'), 'utf8')).toContain('# code-visualizer:start pre-commit');
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
    // A hooks folder outside the repository set locally is treated the same way.
    const outside = makeTempDir('cv-shared-hooks-');
    git(repo, ['config', 'core.hooksPath', outside]);
    const local = await cli('hooks', 'install', repo, '--yes');
    expect(local.code).toBe(1);
    expect(local.stderr).toContain('global hooks folder');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('the preview names the file a linked hook really is', async () => {
    const repo = initRepo('express-api');
    writeFile(repo, 'scripts/pre-commit', '#!/bin/sh\nnpx lint-staged\n');
    fs.mkdirSync(path.join(repo, '.husky'), { recursive: true });
    fs.symlinkSync('../scripts/pre-commit', path.join(repo, '.husky', 'pre-commit'));
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    const preview = await cli('hooks', 'install', repo, '--pre-commit', '--manager', 'husky');
    expect(preview.stdout).toContain('+++ b/.husky/pre-commit -> scripts/pre-commit');
  });

  it('accepts --write as --yes', async () => {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'init' });
    const run = await cli('hooks', 'install', repo, '--pre-commit', '--write');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Installed pre-commit in .git/hooks/');
    expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-commit'), 'utf8')).toContain('# code-visualizer:start pre-commit');
  });

  it('never edits a hook file that links out of the repository', () => {
    const top = makeTempDir('cv-husky-link-');
    const shared = path.join(makeTempDir('cv-dotfiles-'), 'pre-commit');
    fs.writeFileSync(shared, '#!/bin/sh\nnpx lint-staged\n');
    fs.mkdirSync(path.join(top, '.husky', '_'), { recursive: true });
    fs.symlinkSync(shared, path.join(top, '.husky', 'pre-commit'));
    const plan = planInstall(context(top, { hooksPath: '.husky/_' }), 'husky', ['pre-commit', 'pre-push']);
    expect(plan.edits.map((e) => path.basename(e.file))).toEqual(['pre-push']);
    expect(plan.changed).toEqual(['pre-push']);
    expect(plan.notes.join('\n')).toContain(`.husky/pre-commit is a symlink to ${fs.realpathSync(shared)} (outside the project), not changed`);
    applyPlan(plan);
    expect(fs.readFileSync(shared, 'utf8')).toBe('#!/bin/sh\nnpx lint-staged\n');
    // A link inside the repository is followed: its target gets the block, the link stays.
    fs.rmSync(path.join(top, '.husky', 'pre-commit'));
    writeFile(top, 'scripts/pre-commit', '#!/bin/sh\nnpx lint-staged\n');
    fs.symlinkSync('../scripts/pre-commit', path.join(top, '.husky', 'pre-commit'));
    applyPlan(planInstall(context(top, { hooksPath: '.husky/_' }), 'husky', ['pre-commit']));
    expect(fs.lstatSync(path.join(top, '.husky', 'pre-commit')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(top, 'scripts/pre-commit'), 'utf8')).toContain('# code-visualizer:start pre-commit');
  });
});
