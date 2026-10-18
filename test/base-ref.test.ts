/**
 * An explicit base (`--base`, or `"base"` in the configuration) is never ignored silently: an unknown or
 * unfetched one fails pr, report and serve with a hint, and a stale configured one is reported once while
 * the report still gets written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { AnalyzeError } from '../src/analyzer/errors.js';
import { runCli } from '../src/cli/run.js';
import { commitAll, daysAgo, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

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

afterAll(removeTempDirs);

describe.skipIf(!hasGit)('explicit base refs', () => {
  let restoreGit: () => void;
  let repo: string;
  beforeAll(() => {
    restoreGit = isolateGit();
    repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(3), message: 'initial' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    fs.appendFileSync(path.join(repo, 'utils/object.js'), '\nexports.keys = (obj) => Object.keys(obj);\n');
    commitAll(repo, { author: 'Alice Archer', date: daysAgo(1), message: 'keys helper' });
  });
  afterAll(() => restoreGit());

  it('pr, report and serve fail on a misspelled --base with a suggestion (exit 1)', async () => {
    for (const argv of [
      ['pr', repo, '--base', 'mian'],
      ['report', repo, '--base', 'mian', '--no-open', '--no-cache'],
      // Fails before it listens: no server, no registration.
      ['serve', repo, '--base', 'mian', '--no-open', '--no-cache', '--port', '0'],
    ]) {
      const r = await cli(...argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.stderr, argv.join(' ')).toContain('Unknown git ref "mian". Did you mean "main"?');
    }
    expect(fs.existsSync(path.join(repo, '.code-visualizer/server.json'))).toBe(false);
    // The library says what kind of error it is.
    const error = await analyze({ root: repo, base: 'mian', includeSource: false, history: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnalyzeError);
    expect((error as AnalyzeError).code).toBe('unknown-ref');
    // A base that exists still works.
    const pr = await cli('pr', repo, '--base', 'main');
    expect(pr.code, pr.stderr).toBe(0);
    expect(pr.stdout).toContain('utils/object.js');
  });

  it('an unfetched origin/<branch> in a clone says how to fetch it', async () => {
    const clone = path.join(makeTempDir('cv-clone-'), 'clone');
    git(path.dirname(clone), ['clone', '-q', '--single-branch', '--branch', 'feature', `file://${repo}`, clone]);
    expect(() => git(clone, ['rev-parse', '--verify', '--quiet', 'origin/main'])).toThrow();
    const r = await cli('pr', clone, '--base', 'origin/main');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown git ref "origin/main".');
    expect(r.stderr).toContain('Fetch it first (actions/checkout fetch-depth: 0, or git fetch origin main)');
  });

  it('a stale "base" in the configuration is reported once and the report is still written', async () => {
    const copy = path.join(makeTempDir('cv-stale-'), 'app');
    git(path.dirname(copy), ['clone', '-q', `file://${repo}`, copy]);
    writeFile(copy, 'code-visualizer.config.json', JSON.stringify({ base: 'nope' }));
    const r = await cli('report', copy, '--no-open', '-q', '--no-cache');
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(copy, '.code-visualizer/report.html'))).toBe(true);
    expect(r.stderr.match(/Ignoring "base": "nope" in the configuration/g)).toHaveLength(1);
    expect(r.stderr).toContain('Unknown git ref "nope".');
    // Once per process: a later analysis (serve re-analyzes on every save) stays quiet about it.
    const again = await cli('report', copy, '--no-open', '-q', '--no-cache');
    expect(again.code).toBe(0);
    expect(again.stderr).not.toContain('Ignoring "base"');
  });
});
