import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, sanitizeRemote, unquoteGitPath } from '../src/analyzer/git.js';

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

describe('parseUnifiedDiff', () => {
  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('collects changed line numbers of the new file version', () => {
    const diff = lines(
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,5 +1,6 @@',
      ' line1',
      '-line2',
      '+line2 changed',
      '+line2b',
      ' line3',
      ' line4',
      ' line5',
    );
    const [chunk, ...rest] = parseUnifiedDiff(diff);
    expect(rest).toEqual([]);
    expect(chunk).toMatchObject({ path: 'src/a.ts', binary: false, lines: [2, 3] });
    expect(chunk.oldPath).toBeUndefined();
    expect(chunk.text.startsWith('diff --git a/src/a.ts b/src/a.ts')).toBe(true);
  });

  it('handles several hunks, pure deletions and "no newline" markers', () => {
    const diff = lines(
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -2,3 +2,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -10,3 +10,2 @@ function x() {',
      ' keep',
      '-removed',
      ' keep2',
      '@@ -20,2 +19,3 @@',
      ' y',
      '+z',
      ' w',
      '@@ -30 +30 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    );
    // 3: replaced line, 11: where a line was removed, 20: added line, 30: single-line hunk without counts
    expect(parseUnifiedDiff(diff)[0].lines).toEqual([3, 11, 20, 30]);
  });

  it('does not mistake added lines that look like headers for file names', () => {
    const diff = lines(
      'diff --git a/src/c.ts b/src/c.ts',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -1,2 +1,4 @@',
      ' a',
      '+++ b/evil.ts',
      '+--- a/evil.ts',
      ' b',
    );
    const [chunk] = parseUnifiedDiff(diff);
    expect(chunk.path).toBe('src/c.ts');
    expect(chunk.lines).toEqual([2, 3]);
  });

  it('marks every line of a new file as changed', () => {
    const diff = lines(
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+one',
      '+two',
      '+three',
    );
    const [chunk] = parseUnifiedDiff(diff);
    expect(chunk).toMatchObject({ path: 'src/new.ts', lines: [1, 2, 3] });
    expect(chunk.oldPath).toBeUndefined();
  });

  it('keeps the old path for deleted files', () => {
    const diff = lines(
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index 4444444..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    );
    const [chunk] = parseUnifiedDiff(diff);
    expect(chunk.path).toBe('src/gone.ts');
    expect(chunk.oldPath).toBeUndefined();
    expect(chunk.lines).toEqual([1]);
  });

  it('reports renames (with and without content changes)', () => {
    const diff = lines(
      'diff --git a/src/old.ts b/src/renamed.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/renamed.ts',
      'index 5555555..6666666 100644',
      '--- a/src/old.ts',
      '+++ b/src/renamed.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+c',
      ' d',
      'diff --git a/src/x.ts b/src/y.ts',
      'similarity index 100%',
      'rename from src/x.ts',
      'rename to src/y.ts',
    );
    const [edited, moved] = parseUnifiedDiff(diff);
    expect(edited).toMatchObject({ path: 'src/renamed.ts', oldPath: 'src/old.ts', lines: [2] });
    expect(moved).toMatchObject({ path: 'src/y.ts', oldPath: 'src/x.ts', lines: [] });
  });

  it('flags binary files and takes the path from the diff header', () => {
    const diff = lines('diff --git a/assets/logo.png b/assets/logo.png', 'index 7777777..8888888 100644', 'Binary files a/assets/logo.png and b/assets/logo.png differ');
    expect(parseUnifiedDiff(diff)).toEqual([expect.objectContaining({ path: 'assets/logo.png', binary: true, lines: [] })]);
  });

  it('splits a multi-file diff and keeps each file’s text separate', () => {
    const diff = lines(
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,2 +5,3 @@',
      ' p',
      '+q',
      ' r',
    );
    const chunks = parseUnifiedDiff(diff);
    expect(chunks.map((c) => [c.path, c.lines])).toEqual([
      ['a.ts', [1]],
      ['b.ts', [6]],
    ]);
    expect(chunks[0].text).not.toContain('b.ts');
    expect(chunks[1].text).toContain('+q');
  });

  it('strips the trailing tab git appends to ---/+++ lines of paths that contain spaces', () => {
    // Verbatim `git diff` output: for file names with whitespace git ends the ---/+++ lines with "\t".
    const diff = lines(
      'diff --git a/src/my file.ts b/src/my file.ts',
      'index 72ab60e..3b53fd2 100644',
      '--- a/src/my file.ts\t',
      '+++ b/src/my file.ts\t',
      '@@ -1,2 +1,2 @@',
      ' export const a = 1;',
      '-export const b = 2;',
      '+export const b = 3;',
    );
    const [chunk] = parseUnifiedDiff(diff);
    expect(chunk.path).toBe('src/my file.ts');
    expect(chunk.lines).toEqual([2]);
  });
});

describe('unquoteGitPath', () => {
  it('decodes C-quoted paths with escapes and octal UTF-8 bytes', () => {
    expect(unquoteGitPath('"src/say \\"hi\\".ts"')).toBe('src/say "hi".ts');
    expect(unquoteGitPath('"src/caf\\303\\251.ts"')).toBe('src/café.ts');
    expect(unquoteGitPath('"a\\tb\\\\c.ts"')).toBe('a\tb\\c.ts');
  });

  it('leaves unquoted paths alone', () => {
    expect(unquoteGitPath('src/my file.ts')).toBe('src/my file.ts');
    expect(unquoteGitPath('src/café.ts')).toBe('src/café.ts');
  });

  it('is applied to quoted ---/+++ headers', () => {
    const diff = ['diff --git "a/src/say \\"hi\\".ts" "b/src/say \\"hi\\".ts"', '--- "a/src/say \\"hi\\".ts"', '+++ "b/src/say \\"hi\\".ts"', '@@ -1 +1 @@', '-a', '+b', ''].join('\n');
    expect(parseUnifiedDiff(diff)[0].path).toBe('src/say "hi".ts');
  });
});

describe('sanitizeRemote', () => {
  it('removes credentials and normalizes ssh remotes', () => {
    expect(sanitizeRemote('https://user:secret@github.com/acme/app.git')).toBe('https://github.com/acme/app');
    expect(sanitizeRemote('git@github.com:acme/app.git')).toBe('https://github.com/acme/app');
    expect(sanitizeRemote('/srv/git/app.git')).toBeUndefined();
    expect(sanitizeRemote(undefined)).toBeUndefined();
  });
});
