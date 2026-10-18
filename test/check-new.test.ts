/**
 * "Don't make it worse" end to end: `check --changed`, `--staged`, trunk mode, the committed baseline and
 * `--max-health-drop`, on throw-away git repositories with the react-vite-ts fixture. That fixture already
 * has a format.ts ↔ math.ts cycle, and the committed config sets `maxCycles: 0`: old debt that a full
 * `check` fails on.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { createEngine } from '../src/server/engine.js';
import { watchRemoteRefs } from '../src/server/watch.js';
import type { Baseline, LastCheckState } from '../src/shared/types.js';
import { appendFile, commitAll, copyFixture, daysAgo, editFile, fixtureDir, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const capture = (sink: (s: string) => void) =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
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

interface CheckJson {
  ok: boolean;
  mode: string;
  base?: string;
  healthDelta?: number;
  notes?: string[];
  gates: { id: string; ok: boolean; detail: string; counts?: { new: number; existing: number; fixed: number }; findings: { subject: string; status?: string; file: string }[] }[];
  fixed: { ruleId: string; status: string }[];
}

const json = (stdout: string): CheckJson => JSON.parse(stdout) as CheckJson;
const ALICE = 'Alice Archer';
const MATH = 'src/utils/math.ts';
/** A new cycle between two new files. */
function addCycle(repo: string): void {
  writeFile(repo, 'src/a.ts', "import { b } from './b';\nexport const a = (): number => b();\n");
  writeFile(repo, 'src/b.ts', "import { a } from './a';\nexport const b = (): number => (a ? 1 : 0);\n");
}
/** Break the old format.ts ↔ math.ts cycle. */
function fixOldCycle(repo: string): void {
  editFile(repo, MATH, "import { formatNumber } from './format';\n", '');
  editFile(repo, MATH, 'formatNumber(', 'String(');
}

/** react-vite-ts with one commit and `{ "check": { "maxCycles": 0 } }` (or another `check` block). */
function repoWithDebt(check: Record<string, unknown> = { maxCycles: 0 }): string {
  const repo = initRepo('react-vite-ts');
  writeFile(repo, 'code-visualizer.config.json', `${JSON.stringify({ check }, null, 2)}\n`);
  commitAll(repo, { author: ALICE, date: daysAgo(5), message: 'Initial import' });
  return repo;
}

/** Run with some environment variables set (restored afterwards). */
async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** percent() in math.ts gets one more branch (complexity 2 → 3). */
function growPercent(repo: string): void {
  editFile(repo, MATH, "if (total === 0) return '0%';", "if (total === 0) return '0%';\n  if (total < 0) return '-';");
}

describe.skipIf(!hasGit)('check: only new findings fail', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => {
    restoreEnv?.();
    removeTempDirs();
  });

  it('passes a comment-only edit next to an old cycle, which a full check fails on', async () => {
    const repo = repoWithDebt();
    appendFile(repo, MATH, '// a harmless comment\n');
    const res = await cli('check', repo, '--changed');
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/✔ Circular dependencies 0 new · 1 existing · 0 fixed/);
    expect(res.stdout).toContain('Only new findings fail (compared with HEAD');
    expect(res.stdout).toContain('All gates passed');
    expect((await cli('check', repo)).code).toBe(1);
  });

  it('fails on a new cycle and lists only that one', async () => {
    const repo = repoWithDebt();
    addCycle(repo);
    const res = await cli('check', repo, '--changed');
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/✖ Circular dependencies 1 new · 1 existing · 0 fixed/);
    expect(res.stdout).toContain('Circular dependency: src/a.ts → src/b.ts (new)');
    expect(res.stdout).not.toContain('src/utils/format.ts → src/utils/math.ts');
    const report = json((await cli('check', repo, '--changed', '--format', 'json')).stdout);
    expect(report).toMatchObject({ ok: false, mode: 'changed', base: 'HEAD' });
    expect(report.gates.find((g) => g.id === 'cycles')!.findings.map((f) => [f.subject, f.status])).toEqual([
      ['src/a.ts → src/b.ts', 'new'],
      ['src/utils/format.ts → src/utils/math.ts', 'existing'],
    ]);
  });

  it('has nothing to check on a clean tree', async () => {
    const repo = repoWithDebt();
    const res = await cli('check', repo, '--changed');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('No changes — nothing to check');
    expect(json((await cli('check', repo, '--changed', '--format', 'json')).stdout)).toMatchObject({ ok: true, gates: [] });
    // CI uploads still find their (empty) reports.
    const sarif = path.join(makeTempDir('cv-sarif-'), 'cv.sarif');
    expect((await cli('check', repo, '--changed', '--format', 'github', '--sarif', sarif)).code).toBe(0);
    expect((JSON.parse(fs.readFileSync(sarif, 'utf8')) as { runs: { results: unknown[] }[] }).runs[0].results).toEqual([]);
  });

  it('--staged judges the index: a staged cycle fails even with an unstaged fix, an unstaged cycle passes', async () => {
    const repo = repoWithDebt();
    addCycle(repo);
    git(repo, ['add', 'src/a.ts', 'src/b.ts']);
    // Unstaged: break the new cycle again in the working tree.
    writeFile(repo, 'src/b.ts', 'export const b = (): number => 1;\n');
    expect((await cli('check', repo, '--changed')).code).toBe(0); // the working tree is fine…
    const staged = await cli('check', repo, '--staged');
    expect(staged.code).toBe(1); // …but the commit would add the cycle
    expect(staged.stdout).toContain('Only new findings in your staged changes fail');
    expect(staged.stdout).toContain('src/a.ts → src/b.ts (new)');

    const other = repoWithDebt();
    addCycle(other); // untracked, nothing staged
    expect((await cli('check', other, '--staged')).stdout).toContain('No changes — nothing to check');
    appendFile(other, 'src/App.tsx', '// staged comment\n');
    git(other, ['add', 'src/App.tsx']);
    const res = await cli('check', other, '--staged', '--format', 'json');
    expect(res.code).toBe(0);
    expect(json(res.stdout).gates.find((g) => g.id === 'cycles')!.counts).toEqual({ new: 0, existing: 1, fixed: 0 });
  });

  it('trunk mode: commits on main that are not pushed yet are your change for pr and check --changed', async () => {
    const repo = repoWithDebt();
    const remote = path.join(makeTempDir('cv-remote-'), 'origin.git');
    git(repo, ['init', '-q', '--bare', '-b', 'main', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);
    expect((await cli('check', repo, '--changed')).stdout).toContain('nothing to check');
    addCycle(repo);
    commitAll(repo, { author: ALICE, date: daysAgo(1), message: 'Add a and b' });
    const pr = await cli('pr', repo);
    expect(pr.code).toBe(0);
    expect(pr.stdout).toContain('| `src/a.ts` | added |');
    expect(pr.stdout).toContain('- Add a and b');
    const check = await cli('check', repo, '--changed', '--format', 'json');
    expect(check.code).toBe(1);
    expect(json(check.stdout)).toMatchObject({ mode: 'changed', base: 'origin/main' });
    const comment = await cli('pr', repo, '--format', 'comment', '--check');
    expect(comment.code).toBe(0);
    expect(comment.stdout.split('\n')[0]).toBe('<!-- code-visualizer:pr-report -->');
    expect(comment.stdout).toContain('### Quality gates');
    expect(comment.stdout).toContain('| Circular dependencies | ❌ failed | 1 | 1 | 0 |');
    expect(comment.stdout).toContain('`src/a.ts:1` Circular dependency: src/a.ts → src/b.ts');
    // Pushed: nothing is ahead any more.
    git(repo, ['push', '-q']);
    expect((await cli('check', repo, '--changed')).stdout).toContain('nothing to check');
  });

  it('--update-baseline writes a sorted, committed ratchet: fixed findings leave it, new ones need --force', async () => {
    const repo = repoWithDebt();
    const file = path.join(repo, 'code-visualizer.baseline.json');
    const created = await cli('check', repo, '--update-baseline');
    expect(created.code).toBe(0);
    expect(created.stdout).toContain('Created code-visualizer.baseline.json with 1 known finding');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    const baseline = JSON.parse(text) as Baseline;
    expect(baseline).toMatchObject({ version: 1, tool: 'code-visualizer' });
    expect(Object.keys(baseline.findings)).toEqual([...Object.keys(baseline.findings)].sort());
    expect(baseline.findings['cv/cycle']).toHaveLength(1);
    commitAll(repo, { author: ALICE, date: daysAgo(4), message: 'Baseline' });

    // The default baseline is used automatically: old debt passes, a new cycle fails.
    const known = await cli('check', repo);
    expect(known.code).toBe(0);
    expect(known.stdout).toMatch(/Only findings that are not in .*code-visualizer\.baseline\.json.* fail/);
    addCycle(repo);
    const worse = await cli('check', repo, '--format', 'json');
    expect(worse.code).toBe(1);
    expect(json(worse.stdout)).toMatchObject({ mode: 'baseline', base: 'code-visualizer.baseline.json' });
    expect((await cli('check', repo, '--no-baseline')).code).toBe(1);

    // Fix the old cycle: reported as fixed, and the update removes it — but does not add the new one.
    fixOldCycle(repo);
    const fixed = await cli('check', repo, '--format', 'json');
    expect(json(fixed.stdout).gates.find((g) => g.id === 'cycles')!.counts).toEqual({ new: 1, existing: 0, fixed: 1 });
    const ratchet = await cli('check', repo, '--update-baseline');
    expect(ratchet.stdout).toContain('Updated code-visualizer.baseline.json: +0 −1');
    expect(ratchet.stdout).toContain('1 new finding was not added');
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline).findings).toEqual({});
    expect((await cli('check', repo)).code).toBe(1);
    const forced = await cli('check', repo, '--update-baseline', '--force', '--format', 'json');
    expect(JSON.parse(forced.stdout)).toEqual({ file: 'code-visualizer.baseline.json', created: false, added: 1, removed: 0, rejected: 0, findings: 1 });
    expect((await cli('check', repo)).code).toBe(0);

    // Explicit files and usage errors.
    expect((await cli('check', repo, '--baseline', path.join(repo, 'missing.json'))).code).toBe(2);
    expect((await cli('check', repo, '--changed', '--baseline')).code).toBe(2);
    expect((await cli('check', repo, '--force')).code).toBe(2);
  });

  it('--max-health-drop fails when health drops by more than the limit', async () => {
    const repo = repoWithDebt();
    addCycle(repo);
    const first = json((await cli('check', repo, '--changed', '--max-cycles', '10', '--max-health-drop', '100', '--format', 'json')).stdout);
    const drop = -first.healthDelta!;
    expect(drop).toBe(3);
    const strict = await cli('check', repo, '--changed', '--max-cycles', '10', '--max-health-drop', '2', '--format', 'json');
    expect(strict.code).toBe(1);
    expect(json(strict.stdout).gates.find((g) => g.id === 'health-drop')).toMatchObject({ ok: false, detail: expect.stringContaining('(−3, max drop 2)') });
    expect((await cli('check', repo, '--changed', '--max-cycles', '10', '--max-health-drop', '3')).code).toBe(0);
    // Without --changed the gate still compares with the base (and judges everything else in full).
    expect(json((await cli('check', repo, '--max-cycles', '10', '--max-health-drop', '2', '--format', 'json')).stdout).gates.find((g) => g.id === 'health-drop')!.ok).toBe(false);
  });

  it('--new-since <ref> compares with that ref and validates it', async () => {
    const repo = repoWithDebt();
    const first = git(repo, ['rev-parse', 'HEAD']).trim();
    addCycle(repo);
    commitAll(repo, { author: ALICE, date: daysAgo(2), message: 'Cycle' });
    const res = await cli('check', repo, '--new-since', first, '--format', 'json');
    expect(res.code).toBe(1);
    expect(json(res.stdout)).toMatchObject({ mode: 'new-since' });
    expect((await cli('check', repo, '--new-since', 'no-such-ref')).code).toBe(2);
    expect((await cli('check', repo, '--new-since', first, '--changed')).code).toBe(2);
  });

  it('records the outcome in .code-visualizer/state.json for status lines and hooks', async () => {
    const repo = repoWithDebt();
    addCycle(repo);
    const saved = process.env.CODE_VISUALIZER_NO_CACHE;
    delete process.env.CODE_VISUALIZER_NO_CACHE;
    try {
      expect((await cli('check', repo, '--changed', '-q')).code).toBe(1);
    } finally {
      process.env.CODE_VISUALIZER_NO_CACHE = saved;
    }
    const state = JSON.parse(fs.readFileSync(path.join(repo, '.code-visualizer', 'state.json'), 'utf8')) as { lastCheck: LastCheckState };
    expect(state.lastCheck).toMatchObject({ ok: false, mode: 'changed', failures: 1, failed: ['cycles'], newFindings: 1, at: expect.any(Number) });
  });

  it('refuses --update-baseline on part of the project; a partial check counts nothing outside it as fixed', async () => {
    const repo = repoWithDebt();
    const file = path.join(repo, 'code-visualizer.baseline.json');
    expect((await cli('check', repo, '--update-baseline')).code).toBe(0);
    const written = fs.readFileSync(file, 'utf8');
    const scopedUpdate = await cli('check', repo, '--directory', 'src/components', '--update-baseline');
    expect(scopedUpdate.code).toBe(2);
    expect(scopedUpdate.stderr).toContain('--update-baseline needs the whole project: remove --directory');
    expect(fs.readFileSync(file, 'utf8')).toBe(written);
    const scoped = json((await cli('check', repo, '--directory', path.join(repo, 'src/components'), '--format', 'json')).stdout);
    expect(scoped).toMatchObject({ ok: true, mode: 'baseline', fixed: [] });
    expect(scoped.gates.find((g) => g.id === 'cycles')!.counts).toEqual({ new: 0, existing: 0, fixed: 0 });
    expect(scoped.notes).toEqual([expect.stringContaining('Only part of the project was analyzed')]);
  });

  it('a baselined import cycle that loses a file is still old debt, and the baseline follows it', async () => {
    const repo = repoWithDebt();
    writeFile(repo, 'src/a.ts', "import { b } from './b';\nexport const a = (): number => b();\n");
    writeFile(repo, 'src/b.ts', "import { c } from './c';\nexport const b = (): number => c();\n");
    writeFile(repo, 'src/c.ts', "import { a } from './a';\nexport const c = (): number => (a ? 1 : 0);\n");
    commitAll(repo, { author: ALICE, date: daysAgo(4), message: 'a → b → c → a' });
    expect((await cli('check', repo, '--update-baseline')).stdout).toContain('with 2 known findings');
    const file = path.join(repo, 'code-visualizer.baseline.json');
    expect(Object.values((JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline).cycles ?? {})).toContainEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    // c.ts no longer imports a.ts, b.ts does: a ↔ b is left of the old cycle.
    writeFile(repo, 'src/c.ts', 'export const c = (): number => 1;\n');
    writeFile(repo, 'src/b.ts', "import { a } from './a';\nimport { c } from './c';\nexport const b = (): number => (a ? c() : 0);\n");
    const res = await cli('check', repo);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/✔ Circular dependencies 0 new · 2 existing · 0 fixed/);
    expect((await cli('check', repo, '--update-baseline')).stdout).toContain('+0 −0');
    expect(Object.values((JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline).cycles ?? {})).toContainEqual(['src/a.ts', 'src/b.ts']);
    expect((await cli('check', repo)).code).toBe(0);
  });

  it('keeps --no-worse findings (judged against git) out of the baseline', async () => {
    const repo = repoWithDebt({ maxCycles: 0, noWorse: true });
    growPercent(repo);
    expect((await cli('check', repo, '--update-baseline')).code).toBe(0);
    const baseline = JSON.parse(fs.readFileSync(path.join(repo, 'code-visualizer.baseline.json'), 'utf8')) as Baseline;
    expect(Object.keys(baseline.findings)).toEqual(['cv/cycle']);
    const res = await cli('check', repo);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/✖ Complexity growth 1 new · 0 existing · 0 fixed/);
    expect(res.stdout).toMatch(/✔ Circular dependencies 0 new · 1 existing · 0 fixed/);
  });

  it('--staged needs a git repository; without commits it checks everything that is staged', async () => {
    const plain = copyFixture('express-api', 'cv-nogit-');
    const res = await cli('check', plain, '--staged');
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--staged needs a git repository');
    expect(res.stderr).not.toContain('git cat-file');
    const fresh = initRepo('express-api');
    git(fresh, ['add', '-A']);
    const staged = json((await cli('check', fresh, '--staged', '--format', 'json')).stdout);
    expect(staged).toMatchObject({ mode: 'all', notes: [expect.stringContaining('No commits yet')] });
  });

  it('changedMode "files" says it judges the changed files, even with a health-drop gate that compares', async () => {
    const repo = repoWithDebt({ maxCycles: 0, changedMode: 'files', maxHealthDrop: 5 });
    appendFile(repo, MATH, '// a harmless comment\n');
    const res = await cli('check', repo, '--changed');
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Judging the files you changed');
    expect(res.stdout).not.toContain('Only new findings fail');
    expect(res.stdout).toContain('✖ Circular dependencies 1 (max 0)');
  });

  it('-q prints only the failing gates and their new findings (to stderr), so a quiet hook still says why', async () => {
    const repo = repoWithDebt();
    addCycle(repo);
    const res = await cli('check', repo, '--changed', '-q');
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('✖ Circular dependencies 1 new · 1 existing · 0 fixed');
    expect(res.stderr).toContain('src/a.ts:1 Circular dependency: src/a.ts → src/b.ts');
    expect(res.stderr).not.toContain('format.ts');
    const passing = repoWithDebt();
    appendFile(passing, MATH, '// comment\n');
    expect(await cli('check', passing, '--changed', '-q')).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('labels an old function that grew as worse, with its old complexity, and does not report it twice', async () => {
    const repo = repoWithDebt();
    growPercent(repo);
    const res = await cli('check', repo, '--changed', '--max-complexity', '1', '--no-worse');
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('percent has cyclomatic complexity 3 (max 1, was 2) (worse)');
    expect(res.stdout).toContain('✔ Complexity growth no other function got more complex (1 more under Function complexity)');
    const sarif = JSON.parse((await cli('check', repo, '--changed', '--max-complexity', '1', '--format', 'sarif')).stdout) as { runs: { results: { baselineState?: string; message: { text: string } }[] }[] };
    expect(sarif.runs[0].results.find((r) => r.message.text.startsWith('percent '))!.baselineState).toBe('updated');
  });

  it('a failing full check points at the baseline and at --changed', async () => {
    const res = await cli('check', repoWithDebt());
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('Old debt? Run `code-visualizer check --update-baseline` once and commit the file, or use `check --changed` in CI');
  });

  it('in CI compares with the pull request target (GITHUB_BASE_REF, GitLab), not with main', async () => {
    const repo = repoWithDebt();
    git(repo, ['checkout', '-q', '-b', 'develop']);
    addCycle(repo); // a teammate's cycle, already on develop
    commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Cycle on develop' });
    const developTip = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '-q', '-b', 'feat/z']);
    appendFile(repo, 'src/App.tsx', '// one line\n');
    commitAll(repo, { author: ALICE, date: daysAgo(2), message: 'One line' });
    git(repo, ['checkout', '-q', '--detach']); // like actions/checkout

    const local = await cli('check', repo, '--changed', '--format', 'json');
    expect(local.code).toBe(1); // compared with main, develop's cycle looks new
    expect(json(local.stdout).base).toBe('main');
    const github = await withEnv({ GITHUB_BASE_REF: 'develop' }, () => cli('check', repo, '--changed', '--format', 'json'));
    expect(github.code).toBe(0);
    expect(json(github.stdout)).toMatchObject({ ok: true, base: 'develop' });
    // GitLab merge request pipelines: the target branch, or the merge-base commit when it is not fetched.
    expect((await withEnv({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'develop' }, () => cli('check', repo, '--changed'))).code).toBe(0);
    const sha = await withEnv({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'not-fetched', CI_MERGE_REQUEST_DIFF_BASE_SHA: developTip }, () => cli('check', repo, '--changed', '--format', 'json'));
    expect(sha.code).toBe(0);
    expect(json(sha.stdout).base).toBe(developTip);
    // An unknown target falls back to the usual detection.
    expect((await withEnv({ GITHUB_BASE_REF: 'gone' }, () => cli('check', repo, '--changed'))).code).toBe(1);
  });

  it('checks everything when no base branch exists instead of silently passing', async () => {
    const repo = repoWithDebt();
    git(repo, ['branch', '-q', '-m', 'main', 'feature']);
    const res = await cli('check', repo, '--changed', '--format', 'json', '--no-summary');
    // Nothing to compare with: like without git history, every finding counts (the old cycle fails maxCycles 0).
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('No base branch found');
    expect(json(res.stdout)).toMatchObject({ ok: false, mode: 'all' });
    expect(json(res.stdout).notes).toEqual([expect.stringContaining('No base branch found')]);
    expect(json(res.stdout).notes![0]).toContain('checked everything instead');
    // A committed baseline still holds the old debt in that case.
    expect((await cli('check', repo, '--update-baseline', '--format', 'json')).code).toBe(0);
    commitAll(repo, { author: ALICE, date: daysAgo(1), message: 'Adopt a baseline' });
    const baselined = await cli('check', repo, '--changed', '--format', 'json', '--no-summary');
    expect(baselined.code).toBe(0);
    expect(json(baselined.stdout).mode).toBe('baseline');
  });

  describe('CI clones without the base branch (shallow, single branch)', () => {
    /** react-vite-ts with a utils → components rule; branch pr-bad adds such an import. The origin stays on main. */
    function origin(): string {
      const repo = initRepo('react-vite-ts');
      writeFile(repo, 'code-visualizer.config.json', `${JSON.stringify({ rules: [{ name: 'utils-are-standalone', from: 'src/utils/**', to: 'src/components/**' }] }, null, 2)}\n`);
      commitAll(repo, { author: ALICE, date: daysAgo(5), message: 'Initial import' });
      git(repo, ['checkout', '-q', '-b', 'pr-bad']);
      appendFile(repo, 'src/utils/legacyStorage.ts', "\nimport { Spinner } from '../components/Spinner';\nexport const loading = Spinner;\n");
      commitAll(repo, { author: ALICE, date: daysAgo(1), message: 'Show a spinner' });
      git(repo, ['checkout', '-q', 'main']);
      return repo;
    }
    const clone = (repo: string, ...args: string[]): string => {
      const dir = path.join(makeTempDir('cv-ci-'), 'checkout');
      git(path.dirname(dir), ['clone', '-q', ...args, '--branch', 'pr-bad', `file://${repo}`, dir]);
      return dir;
    };

    it('a shallow clone checks everything and warns how to fetch the base (::warning::, SARIF, summary)', async () => {
      const repo = origin();
      const shallow = clone(repo, '--depth', '1');
      expect(git(shallow, ['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
      const github = await cli('check', shallow, '--changed', '--format', 'github', '--no-summary');
      expect(github.code).toBe(1);
      const warning = github.stdout.split('\n').find((l) => l.startsWith('::warning'));
      expect(warning).toMatch(/^::warning title=code-visualizer::This is a shallow clone without the base branch: fetch it \(actions\/checkout with fetch-depth: 0/);
      expect(github.stdout).toMatch(/^::error file=src\/utils\/legacyStorage\.ts,line=\d+/m);

      const sarifFile = path.join(makeTempDir('cv-sarif-'), 'cv.sarif');
      const summary = path.join(makeTempDir('cv-summary-'), 'summary.md');
      fs.writeFileSync(summary, '');
      const sarif = await withEnv({ GITHUB_STEP_SUMMARY: summary }, () => cli('check', shallow, '--changed', '--format', 'json', '--sarif', sarifFile));
      expect(sarif.code).toBe(1);
      const log = JSON.parse(fs.readFileSync(sarifFile, 'utf8')) as { runs: { invocations?: { toolExecutionNotifications: { level: string; message: { text: string } }[] }[]; results: unknown[] }[] };
      expect(log.runs[0].invocations?.[0].toolExecutionNotifications).toEqual([{ level: 'warning', message: { text: expect.stringContaining('fetch-depth: 0') } }]);
      expect(log.runs[0].results.length).toBeGreaterThan(0);
      expect(fs.readFileSync(summary, 'utf8')).toContain('> This is a shallow clone without the base branch');
    });

    it('a base that exists without a merge-base (too shallow) is worded as such', async () => {
      const repo = origin();
      const shallow = clone(repo, '--depth', '1');
      git(shallow, ['fetch', '-q', '--depth', '1', 'origin', 'main:refs/remotes/origin/main']);
      const res = await cli('check', shallow, '--changed', '--base', 'origin/main', '--format', 'json', '--no-summary');
      expect(res.code).toBe(1);
      expect(json(res.stdout).mode).toBe('all');
      expect(res.stderr).toContain('origin/main exists but has no common history with HEAD (shallow clone): fetch the full history');
    });

    it('the full clone still judges only what the branch adds', async () => {
      const repo = origin();
      const full = clone(repo);
      const res = await cli('check', full, '--changed', '--no-summary');
      expect(res.code).toBe(1);
      expect(res.stdout).toMatch(/✖ Architecture rules 1 new · 0 existing · 0 fixed/);
      expect(res.stderr).not.toContain('checked everything instead');
    });
  });

  it('usage details: ref hints, optional-value flags, config typos, nothing-to-check annotations, the reproduce command', async () => {
    const repo = repoWithDebt();
    const typo = await cli('check', repo, '--new-since', 'mian');
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('Unknown git ref "mian". Did you mean "main"?');
    // --json / --baseline take a following file whatever its extension; a directory stays the root.
    const out = path.join(makeTempDir('cv-out-'), 'report-out');
    expect((await cli('check', '--json', out, repo)).code).toBe(1);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ ok: false, mode: 'all' });
    const missing = await cli('check', repo, '--baseline', path.join(repo, 'cv-baseline.txt'));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cv-baseline.txt not found');
    expect(json((await cli('check', '--json', repo)).stdout).mode).toBe('all');
    // Nothing staged: the annotation summary says so.
    expect((await cli('check', repo, '--staged', '--format', 'github')).stdout).toContain('code-visualizer check: No changes — nothing to check');
    // A misspelled gate key is reported (and the gate it meant is off).
    writeFile(repo, 'code-visualizer.config.json', '{ "check": { "maxCylces": 0 } }\n');
    const misspelled = await cli('check', repo, '--format', 'json');
    expect(misspelled.stderr).toContain('Unknown key check.maxCylces in the configuration is ignored — did you mean "maxCycles"?');
    expect(json(misspelled.stdout).notes).toEqual([expect.stringContaining('check.maxCylces')]);

    // A project in a subfolder: the summary's command checks the same project from the repository root.
    const mono = makeTempDir('cv-mono-');
    fs.cpSync(fixtureDir('react-vite-ts'), path.join(mono, 'my app'), { recursive: true });
    git(mono, ['init', '-q', '-b', 'main']);
    commitAll(mono, { author: ALICE, date: daysAgo(3), message: 'Initial' });
    appendFile(mono, 'my app/src/App.tsx', '// edit\n');
    const md = await cli('check', path.join(mono, 'my app'), '--changed', '--format', 'markdown');
    expect(md.stdout).toContain("reproduce with `code-visualizer check 'my app' --changed`");
  });

  it('serve notices a push in trunk mode: the pushed commits are no longer your change', async () => {
    const repo = repoWithDebt();
    const remote = path.join(makeTempDir('cv-remote-'), 'origin.git');
    git(repo, ['init', '-q', '--bare', '-b', 'main', remote]);
    git(repo, ['remote', 'add', 'origin', remote]);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);
    addCycle(repo);
    commitAll(repo, { author: ALICE, date: daysAgo(1), message: 'Add a and b' });
    // No watchers: only the freshness check of current({ verify }) can notice the push.
    const engine = createEngine({ root: repo, options: { includeSource: false, history: false, compare: true }, watch: false, mode: 'lazy' });
    try {
      const before = await engine.current({ verify: true });
      expect(before.changes).toMatchObject({ base: 'origin/main' });
      expect(before.changes!.files.map((f) => f.id).sort()).toEqual(['src/a.ts', 'src/b.ts']);
      expect(await engine.current({ verify: true })).toBe(before); // nothing moved: no new analysis
      git(repo, ['push', '-q']);
      const after = await engine.current({ verify: true });
      expect(after).not.toBe(before);
      expect(after.changes?.files ?? []).toEqual([]);
    } finally {
      engine.close();
    }
    // The watcher for pushes and fetches: refs/remotes in the (common) git directory, recursively.
    const calls: { target: string; options: unknown }[] = [];
    let fired = 0;
    const watchFn = ((target: fs.PathLike, options: unknown, cb: () => void) => {
      calls.push({ target: String(target), options });
      cb();
      return Object.assign(new EventEmitter(), { close: () => undefined }) as unknown as fs.FSWatcher;
    }) as unknown as typeof fs.watch;
    expect(watchRemoteRefs(path.join(repo, '.git'), () => fired++, watchFn)).toBeDefined();
    expect(calls).toEqual([{ target: path.join(repo, '.git', 'refs', 'remotes'), options: { recursive: true } }]);
    expect(fired).toBe(1);
  });
});
