import { afterAll, describe, expect, it } from 'vitest';
import { loadCodeOwners } from '../src/analyzer/owners.js';
import { makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const CODEOWNERS = `# Global fallback
*                         @org/all

/docs/                    @org/docs   # trailing comments are ignored
*.md                      @org/writers
/src/                     @org/dev not-an-owner
/src/payments/            @org/payments pay-team@example.com
/src/payments/legacy/

[Frontend] @org/frontend-default
^[Optional section]
/src/ui/                  @org/ui
`;

describe('loadCodeOwners', () => {
  const root = makeTempDir('cv-owners-');
  writeFile(root, 'CODEOWNERS', CODEOWNERS);
  const owners = loadCodeOwners([root])!;

  it('reports which file it read', () => {
    expect(owners.file).toBe('CODEOWNERS');
  });

  it('lets the last matching rule win', () => {
    expect(owners.ownersOf('package.json')).toEqual(['@org/all']);
    expect(owners.ownersOf('docs/setup.ts')).toEqual(['@org/docs']);
    expect(owners.ownersOf('docs/guide.md')).toEqual(['@org/writers']); // *.md comes after /docs/
    expect(owners.ownersOf('README.md')).toEqual(['@org/writers']);
    expect(owners.ownersOf('src/index.ts')).toEqual(['@org/dev']);
    expect(owners.ownersOf('src/payments/charge.ts')).toEqual(['@org/payments', 'pay-team@example.com']);
    expect(owners.ownersOf('src/ui/Button.tsx')).toEqual(['@org/ui']);
  });

  it('treats a matching rule without owners as "no owners"', () => {
    expect(owners.ownersOf('src/payments/legacy/old.ts')).toBeUndefined();
  });

  it('only keeps @handles and e-mail addresses as owners and skips GitLab section headers', () => {
    expect(owners.ownersOf('src/app.ts')).toEqual(['@org/dev']);
    const all = ['package.json', 'docs/a.ts', 'src/a.ts', 'src/ui/a.ts', 'src/payments/a.ts'].flatMap((id) => owners.ownersOf(id) ?? []);
    expect(all).not.toContain('@org/frontend-default');
    expect(all).not.toContain('not-an-owner');
  });

  it('returns the same answer for repeated lookups', () => {
    expect(owners.ownersOf('src/index.ts')).toBe(owners.ownersOf('src/index.ts'));
  });

  it('finds CODEOWNERS in .github/, docs/ and .gitlab/', () => {
    for (const location of ['.github/CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']) {
      const dir = makeTempDir('cv-owners-');
      writeFile(dir, location, '* @org/team\n');
      const found = loadCodeOwners([dir]);
      expect(found?.file, location).toBe(location);
      expect(found?.ownersOf('src/x.ts'), location).toEqual(['@org/team']);
    }
  });

  it('searches the given roots in order', () => {
    const first = makeTempDir('cv-owners-');
    const second = makeTempDir('cv-owners-');
    writeFile(second, 'CODEOWNERS', '* @org/second\n');
    expect(loadCodeOwners([first, second])?.ownersOf('a.ts')).toEqual(['@org/second']);
    writeFile(first, '.github/CODEOWNERS', '* @org/first\n');
    expect(loadCodeOwners([first, second])?.ownersOf('a.ts')).toEqual(['@org/first']);
  });

  it('matches paths relative to the repository root when analyzing a sub-folder', () => {
    const repo = makeTempDir('cv-owners-');
    writeFile(repo, 'CODEOWNERS', '* @org/all\n/apps/web/src/ @org/web\n/apps/api/ @org/api\n');
    const sub = loadCodeOwners([repo], 'apps/web/')!;
    expect(sub.ownersOf('src/App.tsx')).toEqual(['@org/web']);
    expect(sub.ownersOf('vite.config.ts')).toEqual(['@org/all']);
    expect(loadCodeOwners([repo])!.ownersOf('src/App.tsx')).toEqual(['@org/all']);
  });

  it('returns undefined without a CODEOWNERS file or without rules', () => {
    expect(loadCodeOwners([makeTempDir('cv-owners-')])).toBeUndefined();
    const onlyComments = makeTempDir('cv-owners-');
    writeFile(onlyComments, 'CODEOWNERS', '# nobody owns anything\n\n');
    expect(loadCodeOwners([onlyComments])).toBeUndefined();
  });
});
