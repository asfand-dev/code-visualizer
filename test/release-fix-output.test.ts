/**
 * Release fixes for the text output of review / diff / context / pr: repository text never reaches the
 * terminal as escape sequences, typo hints name remote-only branches, unwritable outputs fail in one line,
 * and context --agents never writes through a link out of the project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { refHint } from '../src/cli/commands/diff.js';
import { runCli } from '../src/cli/run.js';
import { commitAll, daysAgo, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

/** Like the other CLI tests, but keeps every escape sequence (the point of these tests). */
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
    return { code, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

const TITLE = '\u001b]0;OWNED\u0007';
/** An output path that cannot be created, even for root: its parent is a file. */
function unwritable(): string {
  const dir = makeTempDir('cv-unwritable-');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
  return path.join(dir, 'file.txt', 'x.md');
}

describe.skipIf(!hasGit)('release fixes: text output', () => {
  let restore: () => void;
  let repo: string;
  const hostile = `src/x${TITLE}.ts`;
  beforeAll(() => {
    restore = isolateGit();
    repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(3), message: 'initial' });
    git(repo, ['checkout', '-q', '-b', 'evil']);
    // A new file whose name carries an escape sequence, with an export nobody uses (so diff lists it).
    writeFile(repo, hostile, "import { app } from './app.js';\nexport const owned = app;\nexport function unusedHelper(): number {\n  return 1;\n}\n");
    commitAll(repo, { author: 'Mallory', date: daysAgo(2), message: `add file ${TITLE}` });
    git(repo, ['checkout', '-q', 'main']);
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  it('review <branch> prints the file name with its control characters shown', async () => {
    const run = await cli('review', 'evil', '--root', repo);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('src/x\\e]0;OWNED\\x07.ts');
    expect(run.stdout).not.toContain('\u001b]0');
    expect(run.stdout).not.toContain('\u0007');
    // JSON stays exact.
    const json = await cli('review', 'evil', '--root', repo, '--json');
    expect(JSON.parse(json.stdout).steps.map((s: { file: string }) => s.file)).toContain(hostile);
  }, 60_000);

  it('diff main <branch> prints the file name with its control characters shown', async () => {
    const run = await cli('diff', 'main', 'evil', repo);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('\\e]0;OWNED\\x07');
    expect(run.stdout).not.toContain('\u001b]0');
    expect(run.stdout).not.toContain('\u0007');
  }, 60_000);

  it('an output that cannot be written: one line and the same exit codes as before (diff 2, review 1)', async () => {
    const diff = await cli('diff', 'main', 'evil', repo, '-o', unwritable());
    expect(diff.code).toBe(2);
    expect(diff.stderr).toMatch(/^✖ Cannot write .*x\.md: /);
    const review = await cli('review', 'evil', '--root', repo, '-o', unwritable());
    expect(review.code).toBe(1);
    expect(review.stderr).toMatch(/✖ Cannot write .*x\.md: /);
  }, 60_000);

  it('a branch that only exists on origin: "Did you mean origin/<name>?"', async () => {
    const remote = path.join(makeTempDir('cv-origin-'), 'origin.git');
    git(path.dirname(remote), ['clone', '-q', '--bare', repo, remote]);
    const clone = path.join(makeTempDir('cv-clone-'), 'app');
    git(path.dirname(clone), ['clone', '-q', remote, clone]);
    expect(await refHint(clone, 'evil')).toContain('Did you mean "origin/evil"?');
    expect(await refHint(clone, 'evil')).toContain('git fetch');
    const run = await cli('diff', 'evil', clone);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Unknown git ref "evil". Did you mean "origin/evil"?');
    // Typos still get the closest name.
    expect(await refHint(clone, 'mian')).toBe(' Did you mean "main"?');
  }, 60_000);
});

describe.skipIf(!hasGit)('release fixes: context and pr', () => {
  let restore: () => void;
  beforeAll(() => {
    restore = isolateGit();
  });
  afterAll(() => {
    restore();
    removeTempDirs();
  });

  function repoWithChange(): string {
    const repo = initRepo('express-api');
    commitAll(repo, { author: 'Alice', date: daysAgo(3), message: 'initial' });
    git(repo, ['checkout', '-q', '-b', 'feature']);
    writeFile(repo, 'src/extra.js', 'export const extra = 1;\n');
    commitAll(repo, { author: 'Alice', date: daysAgo(2), message: 'extra' });
    return repo;
  }

  it('pr -o and context -o to a path that cannot be written: exit 2, one line, no stack trace', async () => {
    const repo = repoWithChange();
    const pr = await cli('pr', repo, '-o', unwritable());
    expect(pr.code).toBe(2);
    expect(pr.stderr.trim().split('\n')).toHaveLength(1);
    expect(pr.stderr).toMatch(/^✖ Cannot write .*x\.md: E[A-Z]+\n$/);
    expect(pr.stderr).not.toMatch(/\n\s+at /);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    try {
      const summary = await cli('context', '--summary', '--no-git', '-o', unwritable());
      expect(summary.code).toBe(2);
      expect(summary.stderr).toMatch(/^✖ Cannot write .*x\.md: E[A-Z]+\n$/);
      // The managed block: a file system error is not a marker problem.
      const agents = await cli('context', '--agents', '--no-git', '-o', unwritable());
      expect(agents.code).toBe(2);
      expect(agents.stderr).toMatch(/✖ Cannot write .*x\.md: E[A-Z]+\n$/);
      expect(agents.stderr).not.toContain('Fix the markers');
    } finally {
      cwd.mockRestore();
    }
  }, 60_000);

  it('pr with --base and no changes says what it compared with, without suggesting --base again', async () => {
    const repo = repoWithChange();
    const run = await cli('pr', repo, '--base', 'feature');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('No changes found compared to feature. Commit or edit something first.');
    expect(run.stderr).not.toContain('or pass --base');
  }, 60_000);

  it('context --agents --write never writes through a link out of the project; a CLAUDE.md that is AGENTS.md gets no import', async () => {
    const repo = repoWithChange();
    const outside = path.join(makeTempDir('cv-outside-'), 'AGENTS.md');
    fs.writeFileSync(outside, '# Someone else\n');
    fs.symlinkSync(outside, path.join(repo, 'AGENTS.md'));
    const refused = await cli('context', '--agents', '--write', '--root', repo, '--no-git');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`is a symlink to ${fs.realpathSync(outside)} (outside the project), not changed`);
    expect(fs.readFileSync(outside, 'utf8')).toBe('# Someone else\n');
    fs.rmSync(path.join(repo, 'AGENTS.md'));
    writeFile(repo, 'AGENTS.md', '# Notes\n');
    fs.symlinkSync('AGENTS.md', path.join(repo, 'CLAUDE.md'));
    const linked = await cli('context', '--agents', '--write', '--claude', '--root', repo, '--no-git');
    expect(linked.code).toBe(0);
    const text = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(text.match(/<!-- code-visualizer:start -->/g)).toHaveLength(1);
    expect(text).not.toMatch(/^@AGENTS\.md/m);
    expect(linked.stderr).toContain('no import needed');
  }, 60_000);
});
