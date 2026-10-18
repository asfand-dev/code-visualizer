/**
 * End-to-end tests of the git-powered features on throw-away repositories in os.tmpdir().
 * Commits use explicit authors (`-c user.name/user.email`) and dates (GIT_AUTHOR_DATE / GIT_COMMITTER_DATE),
 * chosen relative to today because activity charts and reviewer recency are relative to "now".
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnalyzeError } from '../src/analyzer/errors.js';
import { analyzeChanges, blameFile, detectBaseBranch } from '../src/analyzer/git.js';
import { analyze, type AnalyzeOptions } from '../src/analyzer/index.js';
import { fileContextMarkdown } from '../src/shared/markdown.js';
import type { ReportData } from '../src/shared/types.js';
import {
  appendFile,
  commitAll,
  copyFixture,
  dayShift,
  daysAgo,
  editFile,
  emailOf,
  fixtureDir,
  git,
  hasGit,
  initRepo,
  isolateGit,
  makeTempDir,
  removeTempDirs,
  startOfToday,
  writeFile,
} from './companion-helpers.js';
import { getFile } from './helpers.js';

const ALICE = 'Alice Archer';
const BOB = 'Bob Builder';
const CAROL = 'Carol Coder';

/** Git stores seconds. */
const secs = (ms: number): number => Math.floor(ms / 1000) * 1000;

function analyzeRepo(root: string, extra: Partial<AnalyzeOptions> = {}): Promise<ReportData> {
  return analyze({ root, includeSource: false, history: false, ...extra });
}

const BUTTON = 'src/components/Button.tsx';
/** Changes line 12 — inside the `Button` component. */
const editButton = (repo: string): void => editFile(repo, BUTTON, "const classes = ['btn',", "const classes = ['button',");

describe.skipIf(!hasGit)('git integration', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => {
    restoreEnv?.();
    removeTempDirs();
  });

  describe('changes', () => {
    it('treats uncommitted edits on main as "working" changes with symbols, impact and tests', async () => {
      const repo = initRepo('react-vite-ts');
      const head = commitAll(repo, { author: ALICE, date: daysAgo(30), message: 'Initial import' });
      editButton(repo);
      const data = await analyzeRepo(repo);
      const c = data.changes!;
      expect(c).toBeDefined();
      expect(c).toMatchObject({ mode: 'working', base: undefined, baseCommit: undefined, commits: [], additions: 1, deletions: 1 });
      expect(c.files).toEqual([
        { id: BUTTON, status: 'modified', oldPath: undefined, additions: 1, deletions: 1, lines: [12], added: [12], diff: expect.stringContaining("+    const classes = ['button',"), analyzed: true },
      ]);
      expect(c.symbols.map((s) => [s.id, s.kind])).toEqual([[`${BUTTON}#Button`, 'component']]);
      expect(c.impacted).toEqual(expect.arrayContaining(['src/components/UserCard.tsx', 'src/components/ThemeToggle.tsx', 'src/components/index.ts', 'src/pages/Settings.tsx', 'src/components/Button.test.tsx']));
      expect(c.impactedRoutes.length).toBeGreaterThan(0);
      expect(c.tests).toEqual({ files: ['src/components/Button.test.tsx'], command: 'npx vitest run src/components/Button.test.tsx', runner: 'vitest', changedTests: [] });
      expect(c.clusters).toEqual([[BUTTON]]);
      expect(c.reviewers.map((r) => r.name)).toEqual([ALICE]); // no git user configured → nobody is excluded
      expect(data.git).toMatchObject({ branch: 'main', head: head.slice(0, 10) });
      expect(data.project.git).toMatchObject({ branch: 'main', commit: head.slice(0, 7) });
      expect(data.history[0]).toMatchObject({ commit: head.slice(0, 10), branch: 'main', dirty: true });
    });

    it('compares a feature branch with main: its commits plus committed, uncommitted and untracked files', async () => {
      const repo = initRepo('react-vite-ts');
      const base = commitAll(repo, { author: ALICE, date: daysAgo(30), message: 'Initial import' });
      git(repo, ['checkout', '-q', '-b', 'feature/long-dates']);
      editFile(repo, 'src/utils/format.ts', "month: 'short'", "month: 'long'");
      commitAll(repo, { author: BOB, date: daysAgo(2), message: 'Use long month names' });
      editButton(repo);
      writeFile(repo, 'src/utils/stamp.ts', "import { formatDate } from './format';\n\nexport function stamp(iso: string): string {\n  return `[${formatDate(iso)}]`;\n}\n");

      for (const options of [{}, { base: 'main' }]) {
        const data = await analyzeRepo(repo, options);
        const c = data.changes!;
        expect(c).toMatchObject({ mode: 'branch', base: 'main', baseCommit: base.slice(0, 10) });
        expect(c.commits).toEqual([
          { hash: expect.stringMatching(/^[0-9a-f]{10}$/), date: secs(daysAgo(2)), author: BOB, subject: 'Use long month names', files: 1, additions: 1, deletions: 1, paths: ['src/utils/format.ts'] },
        ]);
        expect(c.files.map((f) => [f.id, f.status, f.additions, f.deletions])).toEqual([
          [BUTTON, 'modified', 1, 1],
          ['src/utils/format.ts', 'modified', 1, 1],
          ['src/utils/stamp.ts', 'untracked', 5, 0],
        ]);
        expect(c.files[2]).toMatchObject({ lines: [1, 2, 3, 4, 5], analyzed: true });
        expect(c.files[1].lines).toEqual([12]);
        expect(c.symbols.map((s) => s.id)).toEqual(expect.arrayContaining(['src/utils/format.ts#formatDate', `${BUTTON}#Button`, 'src/utils/stamp.ts#stamp']));
        expect(c.clusters).toEqual([['src/utils/format.ts', 'src/utils/stamp.ts'], [BUTTON]]);
        expect(data.git!.branch).toBe('feature/long-dates');
      }
    });

    it('suggests reviewers by knowledge of the changed file, never the current git user or bots', async () => {
      const repo = initRepo('react-vite-ts');
      git(repo, ['config', 'user.name', ALICE]); // the person running the analysis
      commitAll(repo, { author: ALICE, date: daysAgo(90), message: 'Initial import' });
      const tweak = (author: string, days: number, i: number): void => {
        appendFile(repo, BUTTON, `// tweak ${i}\n`);
        commitAll(repo, { author, date: daysAgo(days), message: `Button tweak ${i}` });
      };
      tweak(BOB, 40, 1);
      tweak(BOB, 35, 2);
      tweak(BOB, 30, 3);
      tweak(CAROL, 5, 4);
      tweak('dependabot[bot]', 3, 5);
      tweak(ALICE, 1, 6);
      editButton(repo);

      const data = await analyzeRepo(repo);
      expect(data.git!.user).toBe(ALICE);
      expect(getFile(data, BUTTON).git!.authors.map((a) => [a.name, a.commits])).toEqual([
        [BOB, 3],
        [ALICE, 2],
        ['dependabot[bot]', 1], // ties are broken by recency
        [CAROL, 1],
      ]);
      const reviewers = data.changes!.reviewers;
      expect(reviewers.map((r) => r.name)).toEqual([BOB, CAROL]);
      expect(reviewers[0]).toMatchObject({ files: 1, last: secs(daysAgo(30)) });
      expect(reviewers[0].score).toBeGreaterThan(reviewers[1].score);
    });
  });

  describe('history', () => {
    it('summarizes commits (subjects, numstat), daily / weekly activity, contributors and per-file history', async () => {
      const repo = initRepo('react-vite-ts');
      git(repo, ['config', 'user.name', 'Dana Dev']);
      commitAll(repo, { author: ALICE, date: daysAgo(20), message: 'Initial import' });
      editFile(repo, 'src/utils/format.ts', "month: 'short'", "month: 'long'");
      editFile(repo, 'src/utils/math.ts', 'digits = 0', 'digits = 1');
      commitAll(repo, { author: BOB, date: daysAgo(10), message: 'Round percentages' });
      editFile(repo, 'src/utils/format.ts', "year: 'numeric'", "year: '2-digit'");
      commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Short years' });
      writeFile(repo, 'NOTES.md', '# Notes\n\nNot a source file.\n');
      editFile(repo, 'src/utils/format.ts', "day: 'numeric'", "day: '2-digit'");
      commitAll(repo, { author: CAROL, date: daysAgo(1), message: 'Docs and two-digit days' });

      let data: ReportData;
      let today: number;
      do {
        today = startOfToday();
        data = await analyzeRepo(repo);
      } while (today !== startOfToday()); // re-run if the clock crossed midnight mid-analysis
      const shift = dayShift(today);
      const g = data.git!;

      expect(g).toMatchObject({ branch: 'main', user: 'Dana Dev', commitsAnalyzed: 4, firstCommit: secs(daysAgo(20)), lastCommit: secs(daysAgo(1)), upstream: undefined });
      expect(g.head).toMatch(/^[0-9a-f]{10}$/);
      expect(g.commits.map((c) => [c.subject, c.author])).toEqual([
        ['Docs and two-digit days', CAROL],
        ['Short years', ALICE],
        ['Round percentages', BOB],
        ['Initial import', ALICE],
      ]);
      expect(g.commits[0]).toMatchObject({ hash: g.head, date: secs(daysAgo(1)), files: 2, additions: 4, deletions: 1, paths: ['src/utils/format.ts'] });
      expect(g.commits[2]).toMatchObject({ files: 2, additions: 2, deletions: 2, paths: ['src/utils/format.ts', 'src/utils/math.ts'] });
      expect(g.commits[3].paths).toHaveLength(data.files.length);
      expect(g.commits[3].files).toBeGreaterThan(data.files.length); // + index.html, package.json, …

      expect(g.dailyActivity).toHaveLength(371);
      expect(g.dailyActivity.reduce((a, b) => a + b, 0)).toBe(4);
      for (const n of [1, 3, 10, 20]) expect(g.dailyActivity[370 - n - shift], `${n} days ago`).toBe(1);
      expect(g.weeklyActivity).toHaveLength(52);
      expect(g.weeklyActivity.slice(-3)).toEqual([1, 1, 2]);

      expect(g.contributors.map((c) => c.name).sort()).toEqual([ALICE, BOB, CAROL]);
      expect(g.contributors[0]).toMatchObject({ name: ALICE, commits: 2, files: data.files.length, first: secs(daysAgo(20)), last: secs(daysAgo(3)) });
      expect(g.contributors[0].areas[0]).toEqual({ path: 'src/utils', commits: 2 });

      const format = getFile(data, 'src/utils/format.ts').git!;
      expect(format).toMatchObject({ commits: 4, lastModified: secs(daysAgo(1)), firstSeen: secs(daysAgo(20)), ownership: 0.5 });
      expect(format.authors).toEqual([
        { name: ALICE, commits: 2, last: secs(daysAgo(3)), email: emailOf(ALICE) },
        { name: CAROL, commits: 1, last: secs(daysAgo(1)), email: emailOf(CAROL) },
        { name: BOB, commits: 1, last: secs(daysAgo(10)), email: emailOf(BOB) },
      ]);
      expect(format.recent).toEqual([
        { hash: g.commits[0].hash, date: secs(daysAgo(1)), author: CAROL, subject: 'Docs and two-digit days' },
        { hash: g.commits[1].hash, date: secs(daysAgo(3)), author: ALICE, subject: 'Short years' },
        { hash: g.commits[2].hash, date: secs(daysAgo(10)), author: BOB, subject: 'Round percentages' },
        { hash: g.commits[3].hash, date: secs(daysAgo(20)), author: ALICE, subject: 'Initial import' },
      ]);
      const math = getFile(data, 'src/utils/math.ts').git!;
      expect(math).toMatchObject({ commits: 2, ownership: 0.5 });
      expect(math.authors.map((a) => a.name)).toEqual([BOB, ALICE]);
      expect(getFile(data, 'src/App.tsx').git).toMatchObject({ commits: 1, ownership: 1, authors: [{ name: ALICE, commits: 1 }] });
      expect(data.history[0].dirty).toBeUndefined();

      const md = fileContextMarkdown(data, 'src/utils/format.ts');
      expect(md).toContain(`- Main authors: ${ALICE}, ${CAROL}, ${BOB}`);
      expect(md).toContain(`## Recent changes\n\n- ${new Date(secs(daysAgo(1))).toISOString().slice(0, 10)} ${CAROL}: Docs and two-digit days`);
    });

    it('reports how far the branch is ahead of and behind its upstream', async () => {
      const repo = initRepo('react-vite-ts');
      commitAll(repo, { author: ALICE, date: daysAgo(5), message: 'Initial import' });
      appendFile(repo, 'src/utils/math.ts', '// pushed\n');
      commitAll(repo, { author: ALICE, date: daysAgo(4), message: 'Pushed change' });
      const remote = path.join(makeTempDir('cv-remote-'), 'origin.git');
      git(repo, ['init', '-q', '--bare', '-b', 'main', remote]);
      git(repo, ['remote', 'add', 'origin', remote]);
      git(repo, ['push', '-q', '-u', 'origin', 'main']);
      git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
      appendFile(repo, 'src/utils/format.ts', '// local only\n');
      commitAll(repo, { author: ALICE, date: daysAgo(1), message: 'Local change' });
      const data = await analyzeRepo(repo);
      expect(data.git!.upstream).toEqual({ name: 'origin/main', ahead: 1, behind: 1 });
    });

    it('finds knowledge silos, folder experts and change coupling when one author dominates', async () => {
      const repo = initRepo('react-vite-ts');
      commitAll(repo, { author: ALICE, date: daysAgo(60), message: 'Initial import' });
      for (let i = 1; i <= 9; i++) {
        appendFile(repo, 'src/utils/format.ts', `// refine ${i}\n`);
        appendFile(repo, 'src/utils/math.ts', `// refine ${i}\n`);
        commitAll(repo, { author: ALICE, date: daysAgo(50 - i * 4), message: `Refine utils ${i}` });
      }
      for (let i = 1; i <= 8; i++) {
        appendFile(repo, BUTTON, `// bump ${i}\n`);
        commitAll(repo, { author: 'renovate[bot]', date: daysAgo(12 - i), message: `chore(deps): bump ${i}` });
      }
      appendFile(repo, BUTTON, '// bob\n');
      commitAll(repo, { author: BOB, date: daysAgo(2), message: 'Button tweak' });

      const data = await analyzeRepo(repo);
      // Button.tsx is 80% renovate[bot] — bots are never silos or experts.
      expect(getFile(data, BUTTON).git).toMatchObject({ commits: 10, ownership: 0.8 });
      expect(data.insights.knowledgeSilos).toEqual([
        { file: 'src/utils/format.ts', author: ALICE, share: 1, lastActive: secs(daysAgo(14)) },
        { file: 'src/utils/math.ts', author: ALICE, share: 1, lastActive: secs(daysAgo(14)) },
      ]);

      const folder = (p: string) => data.folders.find((f) => f.path === p)!;
      expect(folder('src/utils')).toMatchObject({ experts: [{ name: ALICE, share: 1 }], busFactor: 1 });
      expect(folder('src/components').experts!.map((e) => e.name)).toEqual([ALICE, BOB]);
      expect(folder('src/components').busFactor).toBe(1);
      expect(folder('').experts![0].name).toBe(ALICE);
      expect(data.folders.flatMap((f) => f.experts ?? []).some((e) => e.name.includes('[bot]'))).toBe(false);
      for (const f of data.folders.filter((x) => x.experts)) {
        const total = f.experts!.reduce((n, e) => n + e.share, 0);
        expect(total, f.path).toBeLessThanOrEqual(1.01);
      }

      // clone-radar: the other weights are scaled to make room for Duplication (10 of 100).
      expect(data.health.categories.find((c) => c.id === 'knowledge')).toMatchObject({ weight: 9, detail: '2 important files are known by only one person' });
      expect(data.health.improvements.map((i) => i.id)).toContain('knowledge');
      expect(data.insights.changeCoupling).toContainEqual({ a: 'src/utils/format.ts', b: 'src/utils/math.ts', count: 9, ratio: 0.9 });
      expect(data.insights.hotspots.map((h) => h.file)).toEqual(expect.arrayContaining(['src/utils/format.ts', 'src/utils/math.ts']));

      const format = getFile(data, 'src/utils/format.ts').git!;
      expect(format.recent).toHaveLength(8);
      expect(format.recent.map((r) => r.subject).slice(0, 2)).toEqual(['Refine utils 9', 'Refine utils 8']);
    });

    it('blames lines to commits and marks uncommitted lines', async () => {
      const repo = initRepo('react-vite-ts');
      const first = commitAll(repo, { author: ALICE, date: daysAgo(10), message: 'Initial import' });
      editFile(repo, 'src/utils/math.ts', 'return Math.min(max, Math.max(min, value));', 'return value < min ? min : value > max ? max : value;');
      const second = commitAll(repo, { author: BOB, date: daysAgo(2), message: 'Faster clamp' });
      editFile(repo, 'src/utils/math.ts', 'const factor = 10 ** digits;', 'const factor = Math.pow(10, digits);');
      const lines = fs.readFileSync(path.join(repo, 'src/utils/math.ts'), 'utf8').replace(/\n$/, '').split('\n').length;

      const alice = { author: ALICE, date: secs(daysAgo(10)), hash: first.slice(0, 10), subject: 'Initial import' };
      expect(await blameFile(repo, 'src/utils/math.ts')).toEqual([
        { start: 1, end: 3, ...alice },
        { start: 4, end: 4, author: BOB, date: secs(daysAgo(2)), hash: second.slice(0, 10), subject: 'Faster clamp' },
        { start: 5, end: 7, ...alice },
        { start: 8, end: 8, author: 'You (uncommitted)', date: expect.any(Number), hash: 'uncommitted', subject: expect.any(String) },
        { start: 9, end: lines, ...alice },
      ]);
      expect(await blameFile(repo, 'src/missing.ts')).toBeUndefined();
      writeFile(repo, 'src/untracked.ts', 'export const x = 1;\n');
      expect(await blameFile(repo, 'src/untracked.ts')).toBeUndefined();
    });

    it('reads CODEOWNERS from the repository root when the analyzed folder is a sub-folder', async () => {
      const repo = path.join(makeTempDir('cv-mono-'), 'mono');
      fs.cpSync(fixtureDir('react-vite-ts'), path.join(repo, 'apps', 'web'), { recursive: true });
      writeFile(repo, '.github/CODEOWNERS', '* @org/all\n/apps/web/src/components/ @org/ui\n');
      git(repo, ['init', '-q', '-b', 'main']);
      commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Monorepo' });
      const data = await analyzeRepo(path.join(repo, 'apps', 'web'));
      expect(getFile(data, BUTTON).owners).toEqual(['@org/ui']);
      expect(getFile(data, 'src/main.tsx').owners).toEqual(['@org/all']);
      expect(getFile(data, BUTTON).git).toMatchObject({ commits: 1, authors: [{ name: ALICE, commits: 1 }] });
    });
  });

  describe('analyzeChanges', () => {
    it('returns undefined outside of a git repository', async () => {
      expect(await analyzeChanges(copyFixture('react-vite-ts'), new Set())).toBeUndefined();
    });

    it('lists every file as untracked in a repository without commits, analyzed files first', async () => {
      const repo = initRepo('react-vite-ts');
      const raw = (await analyzeChanges(repo, new Set(['src/main.tsx', 'src/App.tsx'])))!;
      expect(raw).toMatchObject({ mode: 'working', base: undefined, commits: [] });
      expect(raw.files.every((f) => f.status === 'untracked')).toBe(true);
      expect(raw.files.slice(0, 2).map((f) => [f.id, f.analyzed])).toEqual([
        ['src/App.tsx', true],
        ['src/main.tsx', true],
      ]);
      const mainLines = fs.readFileSync(path.join(repo, 'src/main.tsx'), 'utf8').replace(/\n$/, '').split('\n').length;
      expect(raw.files[1]).toMatchObject({ additions: mainLines, deletions: 0, lines: Array.from({ length: mainLines }, (_, i) => i + 1) });
      expect(raw.files.find((f) => f.id === 'package.json')).toMatchObject({ analyzed: false });
    });

    it('reports added, deleted, renamed and binary files', async () => {
      const repo = initRepo('react-vite-ts');
      commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Initial import' });
      git(repo, ['mv', 'src/utils/legacyStorage.ts', 'src/utils/storage.ts']);
      fs.rmSync(path.join(repo, 'src/hooks/useDebounce.ts'));
      writeFile(repo, 'src/utils/added.ts', 'export const added = true;\n');
      fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]));
      git(repo, ['add', 'src/utils/added.ts', 'logo.png']);
      const raw = (await analyzeChanges(repo, new Set(['src/utils/storage.ts', 'src/utils/added.ts'])))!;
      const byId = Object.fromEntries(raw.files.map((f) => [f.id, f]));
      expect(Object.keys(byId).sort()).toEqual(['logo.png', 'src/hooks/useDebounce.ts', 'src/utils/added.ts', 'src/utils/storage.ts']);
      expect(byId['src/utils/storage.ts']).toMatchObject({ status: 'renamed', oldPath: 'src/utils/legacyStorage.ts', additions: 0, deletions: 0, lines: [], analyzed: true });
      expect(byId['src/utils/added.ts']).toMatchObject({ status: 'added', additions: 1, deletions: 0, lines: [1], analyzed: true });
      expect(byId['src/hooks/useDebounce.ts']).toMatchObject({ status: 'deleted', additions: 0, analyzed: false });
      expect(byId['src/hooks/useDebounce.ts'].deletions).toBeGreaterThan(0);
      expect(byId['logo.png']).toMatchObject({ status: 'added', additions: 0, deletions: 0, lines: [], analyzed: false });
      expect(byId['logo.png'].diff).toBeUndefined();
    });

    it('detects the base branch: origin/HEAD first, then main, master, develop or trunk', async () => {
      const repo = initRepo('react-vite-ts');
      commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Initial import' });
      expect(await detectBaseBranch(repo)).toBe('main');
      git(repo, ['branch', '-m', 'main', 'master']);
      expect(await detectBaseBranch(repo)).toBe('master');
      git(repo, ['branch', '-m', 'master', 'work']);
      expect(await detectBaseBranch(repo)).toBeUndefined();
      git(repo, ['branch', 'develop']);
      expect(await detectBaseBranch(repo)).toBe('develop');
      const remote = path.join(makeTempDir('cv-remote-'), 'origin.git');
      git(repo, ['init', '-q', '--bare', '-b', 'trunk', remote]);
      git(repo, ['remote', 'add', 'origin', remote]);
      git(repo, ['push', '-q', 'origin', 'work:trunk']);
      git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
      expect(await detectBaseBranch(repo)).toBe('origin/trunk');
    });

    it('refuses a requested base that does not exist; a stale configured one falls back to the working tree, said once', async () => {
      const repo = initRepo('react-vite-ts');
      commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Initial import' });
      git(repo, ['checkout', '-q', '-b', 'feature']);
      editButton(repo);
      // --base: never silently another comparison.
      const error = await analyzeChanges(repo, new Set([BUTTON]), { base: 'no-such-branch' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AnalyzeError);
      expect(error).toMatchObject({ code: 'unknown-ref', message: expect.stringContaining('Unknown git ref "no-such-branch".') });
      await expect(analyzeChanges(repo, new Set([BUTTON]), { base: '--output=x' })).rejects.toThrow('Unknown git ref "--output=x"');
      // "base" in the configuration: a warning on stderr (once), then the base is detected as usual.
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        for (let i = 0; i < 2; i++) {
          const raw = (await analyzeChanges(repo, new Set([BUTTON]), { base: 'no-such-branch', baseFromConfig: true }))!;
          expect(raw.mode).toBe('working'); // the detected main is where feature starts: uncommitted work
          expect(raw.files.map((f) => [f.id, f.lines])).toEqual([[BUTTON, [12]]]);
        }
        expect(warn.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('Ignoring "base": "no-such-branch"'))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('before the first commit, every tracked and untracked file is new', async () => {
      const repo = initRepo('react-vite-ts');
      git(repo, ['add', 'src/components/Button.tsx', 'package.json']);
      const raw = (await analyzeChanges(repo, new Set([BUTTON, 'src/App.tsx'])))!;
      expect(raw.mode).toBe('working');
      const byId = new Map(raw.files.map((f) => [f.id, f]));
      expect(byId.get(BUTTON)).toMatchObject({ status: 'added', analyzed: true });
      expect(byId.get(BUTTON)!.added!.length).toBeGreaterThan(5);
      expect(byId.get('package.json')).toMatchObject({ status: 'added', analyzed: false });
      expect(byId.get('src/App.tsx')).toMatchObject({ status: 'untracked', analyzed: true });
      // The staged view of the same repository lists only what is staged.
      const staged = (await analyzeChanges(repo, new Set([BUTTON, 'src/App.tsx']), { index: true }))!;
      expect(staged.files.map((f) => f.id).sort()).toEqual(['package.json', BUTTON]);
    });

    it('finds the changed lines of files whose names contain spaces', async () => {
      const repo = initRepo('react-vite-ts');
      writeFile(repo, 'src/utils/date helpers.ts', 'export const a = 1;\nexport const b = 2;\n');
      commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Initial import' });
      editFile(repo, 'src/utils/date helpers.ts', 'b = 2', 'b = 3');
      const raw = (await analyzeChanges(repo, new Set(['src/utils/date helpers.ts'])))!;
      expect(raw.files).toEqual([expect.objectContaining({ id: 'src/utils/date helpers.ts', status: 'modified', additions: 1, deletions: 1 })]);
      expect(raw.files[0].lines).toEqual([2]);
      expect(raw.files[0].diff).toContain('+export const b = 3;');
    });

    it.each([
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
    ])('finds changed lines regardless of the repository setting %s=%s', async (key, value) => {
      const repo = initRepo('react-vite-ts');
      commitAll(repo, { author: ALICE, date: daysAgo(3), message: 'Initial import' });
      git(repo, ['config', key, value]);
      editButton(repo);
      const raw = (await analyzeChanges(repo, new Set([BUTTON])))!;
      expect(raw.files.map((f) => f.id)).toEqual([BUTTON]);
      expect(raw.files[0].lines).toEqual([12]);
      expect(raw.files[0].diff).toContain("const classes = ['button',");
    });
  });
});
