/**
 * One project root for every command: run from a sub-folder, report, check, test and the queries all
 * analyze the project around it (an explicit positional root or `--root` wins), and a leftover
 * `.code-visualizer/` in a sub-folder no longer cuts later answers down to that folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findProjectRoot } from '../src/cli/commands/query.js';
import { runCli } from '../src/cli/run.js';
import { analysisOptions, explicitRoot, resolveProjectRoot, rootNotice, UsageError } from '../src/cli/shared.js';
import { commitAll, daysAgo, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Run the CLI in-process from `cwd` and capture what it writes. */
async function cliIn(cwd: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
  const dir = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    const code = await runCli(argv);
    return { code, stdout: strip(stdout), stderr: strip(stderr) };
  } finally {
    out.mockRestore();
    err.mockRestore();
    dir.mockRestore();
  }
}

afterAll(removeTempDirs);

describe('resolveProjectRoot', () => {
  it('an explicit root wins; otherwise the project around the folder; else the folder itself', () => {
    const root = makeTempDir('cv-root-');
    writeFile(root, 'package.json', '{"name":"app"}');
    writeFile(root, 'src/deep/a.ts', 'export const a = 1;\n');
    const deep = path.join(root, 'src/deep');
    expect(resolveProjectRoot(deep)).toMatchObject({ root, explicit: false });
    expect(resolveProjectRoot(deep, '.')).toMatchObject({ root: deep, explicit: true });
    expect(resolveProjectRoot(root, 'src')).toMatchObject({ root: path.join(root, 'src'), explicit: true });
    const outside = makeTempDir('cv-noproject-');
    if (!findProjectRoot(outside)) expect(resolveProjectRoot(outside)).toEqual({ root: outside, explicit: false, fallback: true });
  });

  it('counts .code-visualizer/ only next to a package.json or a configuration', () => {
    const root = makeTempDir('cv-root-');
    writeFile(root, 'package.json', '{"name":"app"}');
    // What `report` used to leave behind when it ran in a sub-folder.
    writeFile(root, 'utils/.code-visualizer/report.html', '<html></html>');
    writeFile(root, 'utils/object.js', 'exports.pick = () => ({});\n');
    expect(findProjectRoot(path.join(root, 'utils'))?.root).toBe(root);
    // Next to a tsconfig (a project without package.json) it does mark a root…
    writeFile(root, 'tools/gen/tsconfig.json', '{}');
    writeFile(root, 'tools/gen/.code-visualizer/cache/x', '');
    expect(findProjectRoot(path.join(root, 'tools/gen'))?.root).toBe(path.join(root, 'tools/gen'));
    // …and so does a code-visualizer configuration.
    writeFile(root, 'scripts/code-visualizer.config.json', '{}');
    expect(findProjectRoot(path.join(root, 'scripts'))?.root).toBe(path.join(root, 'scripts'));
  });

  it('two different roots are a usage error; the same one twice is not', () => {
    expect(() => explicitRoot({ root: 'a' }, ['b'])).toThrow(UsageError);
    expect(explicitRoot({ root: '.' }, [process.cwd()])).toBe(process.cwd());
    expect(() => analysisOptions({ root: 'a' }, ['b'])).toThrow(/Two project roots/);
  });

  it('says when a command analyzes the project above the current folder', () => {
    const root = makeTempDir('cv-root-');
    const name = path.basename(root);
    expect(rootNotice(root, false, path.join(root, 'controllers'))).toBe(`Analyzing the project in ${name}/ — you are in ${name}/controllers/ (--root . analyzes only this folder)`);
    expect(rootNotice(root, false, root)).toBeUndefined();
    expect(rootNotice(root, true, path.join(root, 'controllers'))).toBeUndefined();
    expect(rootNotice(root, false, makeTempDir('cv-other-'))).toBeUndefined();
  });
});

describe.skipIf(!hasGit)('commands run from a sub-folder (express-api)', () => {
  let restoreGit: () => void;
  let repo: string;
  beforeAll(() => {
    restoreGit = isolateGit();
    repo = initRepo('express-api');
    writeFile(repo, 'test/object.test.js', "const { pick } = require('../utils/object');\n\ntest('pick', () => {\n  expect(pick({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 });\n});\n");
    // An import of a package that package.json does not declare: the dependency gate fails on it.
    const controller = path.join(repo, 'controllers/postsController.js');
    fs.writeFileSync(controller, `const slugify = require('slugify');\n${fs.readFileSync(controller, 'utf8')}`);
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'initial' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    fs.appendFileSync(path.join(repo, 'utils/object.js'), '\nexports.keys = (obj) => Object.keys(obj);\n');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(1), message: 'keys helper' });
  });
  afterAll(() => restoreGit());

  it('test --dry-run from utils/ selects the root test, before and after a report run there', async () => {
    const utils = path.join(repo, 'utils');
    const before = await cliIn(utils, 'test', '--dry-run', '--no-cache');
    expect(before.code, before.stderr).toBe(0);
    expect(before.stdout).toContain('test/object.test.js');

    const report = await cliIn(utils, 'report', '--no-open', '-q');
    expect(report.code, report.stderr).toBe(0);
    // The project's report, at the project's root — no stray .code-visualizer/ in the sub-folder.
    expect(fs.existsSync(path.join(repo, '.code-visualizer/report.html'))).toBe(true);
    expect(fs.existsSync(path.join(utils, '.code-visualizer'))).toBe(false);

    const after = await cliIn(utils, 'test', '--dry-run', '--no-cache');
    expect(after.code, after.stderr).toBe(0);
    expect(after.stdout).toContain('test/object.test.js');

    // A leftover from an older version is ignored too.
    writeFile(utils, '.code-visualizer/report.html', '<html></html>');
    const leftover = await cliIn(utils, 'test', '--dry-run', '--json', '--no-cache');
    expect(leftover.code, leftover.stderr).toBe(0);
    expect(JSON.parse(leftover.stdout).selected.map((s: { file: string }) => s.file)).toContain('test/object.test.js');
    fs.rmSync(path.join(utils, '.code-visualizer'), { recursive: true, force: true });
  });

  it('check from controllers/ fails on the same undeclared dependency as from the root, and says which project it checked', async () => {
    const findings = (out: string): string[] =>
      (JSON.parse(out) as { gates: { id: string; findings: { file: string; message: string }[] }[] }).gates
        .find((g) => g.id === 'dependencies')!
        .findings.map((f) => `${f.file}: ${f.message}`);
    const atRoot = await cliIn(repo, 'check', '--format', 'json', '--no-cache', '--no-summary');
    const inFolder = await cliIn(path.join(repo, 'controllers'), 'check', '--format', 'json', '--no-cache', '--no-summary');
    expect(atRoot.code).toBe(1);
    expect(inFolder.code).toBe(1);
    expect(findings(atRoot.stdout).join('\n')).toContain('slugify');
    expect(findings(inFolder.stdout)).toEqual(findings(atRoot.stdout));

    const text = await cliIn(path.join(repo, 'controllers'), 'check', '--no-cache', '--no-summary');
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('ℹ Analyzing the project in express-api/ — you are in express-api/controllers/ (--root . analyzes only this folder)');
    expect(text.stdout).toContain('slugify');
  });

  // integration (release fixes): pr, context, diff and cache find the same project as report and check.
  it('pr, context, diff and cache from utils/ work on the whole project', async () => {
    const utils = path.join(repo, 'utils');
    const pr = await cliIn(utils, 'pr', '--base', 'main', '--no-cache');
    expect(pr.code, pr.stderr).toBe(0);
    expect(pr.stdout).toContain('utils/object.js');
    expect(pr.stderr).toContain('ℹ Analyzing the project in express-api/ — you are in express-api/utils/ (--root . analyzes only this folder)');
    expect((await cliIn(utils, 'pr', '--root', 'a', 'b')).code).toBe(2);

    // A file named from its own folder; its importer outside utils/ is part of the context.
    const context = await cliIn(utils, 'context', 'object.js', '--no-cache');
    expect(context.code, context.stderr).toBe(0);
    expect(context.stdout).toContain('utils/object.js');
    expect(context.stdout).toContain('test/object.test.js');

    const diff = await cliIn(utils, 'diff', 'main', '--json', '--no-cache');
    expect(diff.code, diff.stderr).toBe(0);
    expect(JSON.parse(diff.stdout).delta).toBeDefined();
    expect(fs.existsSync(path.join(utils, '.code-visualizer'))).toBe(false);

    const cache = await cliIn(utils, 'cache', '--json');
    expect(cache.code, cache.stderr).toBe(0);
    expect(JSON.parse(cache.stdout).root).toBe(repo);
  });

  it('accepts --root on check and the queries, and refuses two different roots', async () => {
    const check = await cliIn(repo, 'check', '--root', '.', '--format', 'json', '--no-cache', '--no-summary');
    expect(check.code).toBe(1); // the undeclared dependency, not a usage error
    expect(JSON.parse(check.stdout).gates.length).toBeGreaterThan(0);
    const impact = await cliIn(repo, 'impact', '--root', '.', 'pick', '--no-cache');
    expect(impact.code, impact.stderr).toBe(0);
    expect(impact.stdout).toContain('utils/object.js');
    const both = await cliIn(repo, 'check', '--root', 'a', 'b');
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('Two project roots');
    // `--root .` from a sub-folder analyzes only that folder.
    const scoped = await cliIn(path.join(repo, 'utils'), 'check', '--root', '.', '--format', 'json', '--no-cache', '--no-summary', '--no-git');
    expect(scoped.code).toBe(0);
  });
});
