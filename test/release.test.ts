import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { apiBump, bumpVersion, commitBump, compareUrl, parseCommit, parseSemver, releaseBump, releaseNotesMarkdown } from '../src/shared/release.js';
import type { ExportChange, ReleaseCommit, ReleasePlan } from '../src/shared/types.js';
import { commitAll, daysAgo, git, hasGit, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const commit = (subject: string, body = '', author = 'Ada'): ReleaseCommit => ({ hash: 'abcdef1234567', author, date: 0, subject, ...parseCommit(subject, body) });
const exportChange = (extra: Partial<ExportChange>): ExportChange => ({ file: 'src/index.ts', name: 'x', change: 'added', breaking: false, importers: [], staleCallSites: [], entry: true, ...extra });

describe('parseCommit', () => {
  it('reads Conventional Commits', () => {
    expect(parseCommit('feat(cart): add currency support')).toEqual({ type: 'feat', scope: 'cart', description: 'add currency support' });
    expect(parseCommit('fix: handle empty cart')).toMatchObject({ type: 'fix', scope: undefined, description: 'handle empty cart' });
    expect(parseCommit('perf(db): batch the writes')).toMatchObject({ type: 'perf', scope: 'db' });
  });

  it('marks breaking changes by "!" and by a footer', () => {
    expect(parseCommit('feat(api)!: drop v1').breaking).toBe(true);
    expect(parseCommit('refactor: rename things', 'Some words.\n\nBREAKING CHANGE: the name changed').breaking).toBe(true);
    expect(parseCommit('feat: small').breaking).toBeUndefined();
  });

  it('takes the pull request number from the subject', () => {
    expect(parseCommit('fix: race in the queue (#123)')).toMatchObject({ pr: 123, description: 'race in the queue' });
  });

  it('uses the title of a GitHub merge commit from its body', () => {
    expect(parseCommit('Merge pull request #7 from acme/branch', '\nfeat: add dark mode')).toMatchObject({ type: 'feat', pr: 7, description: 'add dark mode' });
  });

  it('accepts common aliases and any casing', () => {
    expect(parseCommit('Feature: x').type).toBe('feat');
    expect(parseCommit('FIX(auth): x').type).toBe('fix');
    expect(parseCommit('hotfix: x').type).toBe('fix');
  });

  it('infers the type of a commit that does not follow the convention from its verb', () => {
    expect(parseCommit('Fix the login redirect').type).toBe('fix');
    expect(parseCommit('Add retry to the uploader').type).toBe('feat');
    expect(parseCommit('Refactor the parser').type).toBe('refactor');
    expect(parseCommit('Bump lodash from 4.17.20 to 4.17.21').type).toBe('chore');
    expect(parseCommit('Tweak things').type).toBe('other');
    expect(parseCommit('Note: this is not a type').type).toBe('other');
    expect(parseCommit('').type).toBe('other');
  });
});

describe('versions', () => {
  it('parses semver strictly', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2.3-rc.1+build5')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'rc.1' });
    for (const bad of ['1.2', 'v1', 'release-1', '1.2.3.4', '', undefined]) expect(parseSemver(bad)).toBeUndefined();
  });

  it('bumps by level', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('v0.9.9', 'major')).toBe('1.0.0');
    expect(bumpVersion('1.2.3', 'none')).toBeUndefined();
    expect(bumpVersion('nightly', 'minor')).toBeUndefined();
  });

  it('releases a pre-release as itself', () => {
    expect(bumpVersion('2.0.0-beta.3', 'minor')).toBe('2.0.0');
  });
});

describe('bump from commits and API', () => {
  it('takes the highest level the commits ask for', () => {
    expect(commitBump([commit('fix: a')])).toBe('patch');
    expect(commitBump([commit('fix: a'), commit('feat: b')])).toBe('minor');
    expect(commitBump([commit('feat: b'), commit('fix!: c')])).toBe('major');
    expect(commitBump([commit('docs: a'), commit('chore: b'), commit('test: c')])).toBe('none');
    expect(commitBump([])).toBe('none');
  });

  it('counts only changes to what package.json publishes', () => {
    expect(apiBump([exportChange({ change: 'removed', breaking: true })])).toBe('major');
    expect(apiBump([exportChange({ change: 'added' })])).toBe('minor');
    expect(apiBump([exportChange({ change: 'removed', breaking: true, entry: false })])).toBe('none');
    expect(apiBump([])).toBe('none');
  });

  it('lets a breaking API change outrank commits that look harmless, and explains why', () => {
    const bump = releaseBump({ lastVersion: '1.4.0', commits: [commit('fix: tidy up')], apiChanges: [exportChange({ name: 'parse', change: 'removed', breaking: true })] });
    expect(bump).toMatchObject({ level: 'major', next: '2.0.0', fromCommits: 'patch', fromApi: 'major' });
    expect(bump.reasons.join(' ')).toContain('breaking change to the published API (parse)');
  });

  it('says nothing needs releasing for documentation-only changes', () => {
    const bump = releaseBump({ lastVersion: '1.0.0', commits: [commit('docs: readme')] });
    expect(bump.level).toBe('none');
    expect(bump.next).toBeUndefined();
    expect(bump.reasons.join(' ')).toContain('nothing needs releasing');
  });

  it('says so when there are no commits', () => {
    expect(releaseBump({ lastVersion: '1.0.0', commits: [] }).reasons).toEqual(['No commits since the last release.']);
  });

  it('notes that 0.x versions may release breaking changes as a minor bump', () => {
    const bump = releaseBump({ lastVersion: '0.3.1', commits: [commit('feat!: new api')] });
    expect(bump.level).toBe('major');
    expect(bump.reasons.join(' ')).toContain('0.x');
  });

  it('has no next version when the last one is not semver', () => {
    expect(releaseBump({ lastVersion: undefined, commits: [commit('feat: a')] }).next).toBeUndefined();
  });
});

describe('releaseNotesMarkdown', () => {
  const plan: ReleasePlan = {
    commits: [
      commit('feat(cart): add currency (#12)', '', 'Grace'),
      commit('fix: empty cart crash', '', 'Ada'),
      commit('refactor!: drop legacy totals', '', 'Ada'),
      commit('chore: bump deps', '', 'Ada'),
    ],
    commitCount: 4,
    bump: { level: 'major', next: '2.0.0', fromCommits: 'major', reasons: [] },
    apiChanges: [exportChange({ name: 'oldTotal', change: 'removed', breaking: true, importers: ['a.ts', 'b.ts'] })],
    checks: [],
    compareUrl: 'https://github.com/acme/shop/compare/v1.0.0...HEAD',
  };

  it('groups commits by kind, puts breaking changes first and lists the people', () => {
    const notes = releaseNotesMarkdown(plan, { date: new Date('2026-03-04T00:00:00Z') });
    expect(notes.startsWith('## v2.0.0 (2026-03-04)\n')).toBe(true);
    expect(notes.indexOf('Breaking changes')).toBeLessThan(notes.indexOf('### Features'));
    expect(notes).toContain('- **cart:** add currency (#12) (abcdef1)');
    expect(notes).toContain('- **api:** removed `oldTotal` (src/index.ts, 2 importers)');
    expect(notes).toContain('### Maintenance');
    expect(notes).toContain('Thanks to Ada, Grace.');
    expect(notes).toContain('Full changes: https://github.com/acme/shop/compare/v1.0.0...HEAD');
    // A breaking commit is listed once.
    expect(notes.match(/drop legacy totals/g)).toHaveLength(1);
  });

  it('is headed "Unreleased" when there is no next version', () => {
    const notes = releaseNotesMarkdown({ ...plan, bump: { level: 'none', fromCommits: 'none', reasons: [] } });
    expect(notes.startsWith('## Unreleased\n')).toBe(true);
  });
});

describe('compareUrl', () => {
  it('builds the link for GitHub, GitLab and Bitbucket remotes', () => {
    expect(compareUrl('https://github.com/acme/shop.git', 'v1.0.0')).toBe('https://github.com/acme/shop/compare/v1.0.0...HEAD');
    expect(compareUrl('git@github.com:acme/shop.git', 'v1.0.0')).toBe('https://github.com/acme/shop/compare/v1.0.0...HEAD');
    expect(compareUrl('https://gitlab.com/acme/shop', 'v1.0.0')).toBe('https://gitlab.com/acme/shop/-/compare/v1.0.0...HEAD');
    expect(compareUrl('git@bitbucket.org:acme/shop.git', 'v1.0.0')).toBe('https://bitbucket.org/acme/shop/branches/compare/HEAD%0Dv1.0.0');
  });

  it('has no link without a remote it understands', () => {
    expect(compareUrl(undefined, 'v1')).toBeUndefined();
    expect(compareUrl('/local/path/repo', 'v1')).toBeUndefined();
  });
});

describe.runIf(hasGit)('the release plan of a repository', () => {
  let restoreGit: () => void;
  beforeAll(() => {
    restoreGit = isolateGit();
  });
  afterAll(() => restoreGit());

  const ANALYSIS = { history: false, includeSource: false } as const;

  /** A published library with one commit, tagged v1.0.0. */
  function library(): string {
    const root = makeTempDir('cv-release-');
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['remote', 'add', 'origin', 'https://github.com/acme/lib.git']);
    writeFile(root, 'package.json', JSON.stringify({ name: 'lib', version: '1.0.0', main: 'src/index.ts' }));
    writeFile(root, 'src/index.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n');
    commitAll(root, { author: 'Ada', date: daysAgo(10), message: 'feat: initial release' });
    git(root, ['tag', 'v1.0.0']);
    return root;
  }

  it('suggests a major version when a commit removes a published export, though it is called a fix', async () => {
    const root = library();
    writeFile(root, 'src/index.ts', 'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n');
    commitAll(root, { author: 'Grace', date: daysAgo(2), message: 'fix: tidy the math module (#4)' });
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'docs: explain mul' });

    const { release } = await analyze({ root, ...ANALYSIS, release: true });
    expect(release).toBeDefined();
    expect(release).toMatchObject({ tag: 'v1.0.0', lastVersion: '1.0.0', packageVersion: '1.0.0', commitCount: 2, compareUrl: 'https://github.com/acme/lib/compare/v1.0.0...HEAD' });
    expect(release!.bump).toMatchObject({ level: 'major', next: '2.0.0', fromCommits: 'patch', fromApi: 'major' });
    expect(release!.commits.map((c) => [c.type, c.author])).toEqual([
      ['docs', 'Ada'],
      ['fix', 'Grace'],
    ]);
    const removed = release!.apiChanges.find((c) => c.name === 'sub');
    expect(removed).toMatchObject({ change: 'removed', breaking: true, entry: true });
    expect(release!.apiChanges.find((c) => c.name === 'mul')).toMatchObject({ change: 'added', breaking: false });
    expect(release!.checks.find((c) => c.id === 'clean')?.ok).toBe(true);
  });

  it('suggests a minor version for a new feature that only adds to the API', async () => {
    const root = library();
    writeFile(root, 'src/index.ts', `${'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n'}export const PI = 3.14;\n`);
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'feat: export PI' });
    const { release } = await analyze({ root, ...ANALYSIS, release: true });
    expect(release!.bump).toMatchObject({ level: 'minor', next: '1.1.0' });
  });

  it('is not asked for, so analysis does not pay for it', async () => {
    const root = library();
    expect((await analyze({ root, ...ANALYSIS })).release).toBeUndefined();
  });

  it('has nothing to release right after a release', async () => {
    const { release } = await analyze({ root: library(), ...ANALYSIS, release: true });
    expect(release).toMatchObject({ tag: 'v1.0.0', commitCount: 0, commits: [] });
    expect(release!.bump).toMatchObject({ level: 'none', reasons: ['No commits since the last release.'] });
  });

  it('flags uncommitted work in the readiness checks', async () => {
    const root = library();
    writeFile(root, 'src/extra.ts', 'export const extra = 1;\n');
    const { release } = await analyze({ root, ...ANALYSIS, release: true });
    expect(release!.checks.find((c) => c.id === 'clean')).toMatchObject({ ok: false, label: '1 uncommitted file' });
  });

  it('counts uncommitted work on a feature branch, where the change set is the whole branch', async () => {
    const root = library();
    git(root, ['checkout', '-q', '-b', 'feature/a']);
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'feat: a' });
    writeFile(root, 'src/b.ts', 'export const b = 1;\n');
    writeFile(root, 'src/a.ts', 'export const a = 2;\n');
    const data = await analyze({ root, ...ANALYSIS, release: true });
    expect(data.changes?.mode).toBe('branch');
    expect(data.release!.checks.find((c) => c.id === 'clean')).toMatchObject({ ok: false, label: '2 uncommitted files' });
  });

  it('does not count ignored files as uncommitted work', async () => {
    const root = library();
    writeFile(root, '.gitignore', 'dist/\n');
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'chore: ignore dist' });
    writeFile(root, 'dist/bundle.js', 'console.log(1);\n');
    const { release } = await analyze({ root, ...ANALYSIS, release: true });
    expect(release!.checks.find((c) => c.id === 'clean')).toMatchObject({ ok: true, label: 'Working tree is clean' });
  });

  it('explains how to start when the project has no version tag', async () => {
    const root = makeTempDir('cv-release-untagged-');
    git(root, ['init', '-q', '-b', 'main']);
    writeFile(root, 'package.json', JSON.stringify({ name: 'lib', version: '0.1.0' }));
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'init' });
    const { release } = await analyze({ root, ...ANALYSIS, release: true });
    expect(release!.tag).toBeUndefined();
    expect(release!.bump.level).toBe('none');
    expect(release!.bump.reasons[0]).toContain('no version tag');
  });

  it('ignores tags that are not versions and prefers a stable release to a pre-release', async () => {
    const root = library();
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(5), message: 'feat: a' });
    git(root, ['tag', 'v1.1.0-rc.1']);
    git(root, ['tag', 'nightly']);
    const { release } = await analyze({ root, ...ANALYSIS, release: true });
    expect(release!.tag).toBe('v1.0.0');
    expect(release!.commitCount).toBe(1);
  });

  it('starts from a tag or commit of your choice, and says when it does not exist', async () => {
    const root = library();
    writeFile(root, 'src/a.ts', 'export const a = 1;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(3), message: 'feat: a' });
    git(root, ['tag', 'v1.1.0']);
    writeFile(root, 'src/b.ts', 'export const b = 1;\n');
    commitAll(root, { author: 'Ada', date: daysAgo(1), message: 'fix: b' });

    const since = await analyze({ root, ...ANALYSIS, release: { since: 'v1.0.0' } });
    expect(since.release).toMatchObject({ tag: 'v1.0.0', commitCount: 2 });

    const unknown = await analyze({ root, ...ANALYSIS, release: { since: 'no-such-tag' } });
    expect(unknown.release!.warnings?.[0]).toContain('no-such-tag');
  });
});
