import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { readInstalled } from '../src/analyzer/licenses.js';
import { licenseRisk, needsReview } from '../src/shared/licenses.js';
import { makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

describe('licenseRisk', () => {
  it('knows permissive licenses, in any casing', () => {
    for (const license of ['MIT', 'mit', 'ISC', 'Apache-2.0', 'BSD-3-Clause', '0BSD', 'Unlicense', 'CC0-1.0']) expect(licenseRisk(license)).toBe('permissive');
  });

  it('separates weak copyleft from copyleft', () => {
    expect(licenseRisk('LGPL-3.0-or-later')).toBe('weak-copyleft');
    expect(licenseRisk('MPL-2.0')).toBe('weak-copyleft');
    expect(licenseRisk('GPL-3.0-only')).toBe('copyleft');
    expect(licenseRisk('AGPL-3.0')).toBe('copyleft');
    expect(licenseRisk('SSPL-1.0')).toBe('copyleft');
  });

  it('takes the loosest side of OR and the strictest of AND', () => {
    expect(licenseRisk('(MIT OR Apache-2.0)')).toBe('permissive');
    expect(licenseRisk('(GPL-3.0-only OR MIT)')).toBe('permissive');
    expect(licenseRisk('(MIT AND GPL-3.0-only)')).toBe('copyleft');
    expect(licenseRisk('(MIT AND (LGPL-2.1 OR GPL-2.0))')).toBe('weak-copyleft');
  });

  it('looks past exceptions and the "or later" plus', () => {
    expect(licenseRisk('GPL-2.0 WITH Classpath-exception-2.0')).toBe('copyleft');
    expect(licenseRisk('Apache-2.0+')).toBe('permissive');
  });

  it('flags proprietary and unlicensed packages, and unknown licenses', () => {
    expect(licenseRisk('UNLICENSED')).toBe('proprietary');
    expect(licenseRisk('SEE LICENSE IN LICENSE.md')).toBe('proprietary');
    expect(licenseRisk('Totally-Made-Up-1.0')).toBe('unknown');
    expect(licenseRisk(undefined)).toBe('unknown');
    expect(licenseRisk('  ')).toBe('unknown');
  });

  it('asks for a review of everything but permissive licenses', () => {
    expect(needsReview('permissive')).toBe(false);
    expect(needsReview('unknown')).toBe(true);
    expect(needsReview('copyleft')).toBe(true);
    expect(needsReview(undefined)).toBe(false);
  });
});

function manifest(root: string, where: string, name: string, pkg: Record<string, unknown>): void {
  writeFile(root, `${where}node_modules/${name}/package.json`, JSON.stringify({ name, ...pkg }));
}

describe('readInstalled', () => {
  it('reads the version, the license and the install scripts of installed packages', () => {
    const root = makeTempDir('cv-licenses-');
    manifest(root, '', 'plain', { version: '1.2.3', license: 'MIT' });
    manifest(root, '', 'old-object', { version: '0.1.0', license: { type: 'ISC', url: 'x' } });
    manifest(root, '', 'old-array', { version: '0.2.0', licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] });
    manifest(root, '', '@scope/native', { version: '2.0.0', license: 'Apache-2.0', gypfile: true });
    manifest(root, '', 'scripted', { version: '3.0.0', license: 'GPL-3.0-only', scripts: { postinstall: 'node setup.js', test: 'jest' } });
    manifest(root, '', 'no-license', { version: '4.0.0' });

    const found = readInstalled(root, [], ['plain', 'old-object', 'old-array', '@scope/native', 'scripted', 'no-license', 'not-installed']);
    expect(found.get('plain')).toEqual({ version: '1.2.3', license: 'MIT', licenseRisk: 'permissive' });
    expect(found.get('old-object')).toMatchObject({ license: 'ISC', licenseRisk: 'permissive' });
    expect(found.get('old-array')).toMatchObject({ license: 'MIT OR Apache-2.0', licenseRisk: 'permissive' });
    expect(found.get('@scope/native')).toMatchObject({ installScripts: ['install'] });
    expect(found.get('scripted')).toMatchObject({ licenseRisk: 'copyleft', installScripts: ['postinstall'] });
    expect(found.get('no-license')).toMatchObject({ version: '4.0.0', licenseRisk: 'unknown' });
    expect(found.has('not-installed')).toBe(false);
  });

  it('looks in the root first, then in workspaces', () => {
    const root = makeTempDir('cv-licenses-ws-');
    manifest(root, '', 'shared', { version: '1.0.0', license: 'MIT' });
    manifest(root, 'apps/web/', 'shared', { version: '9.9.9', license: 'ISC' });
    manifest(root, 'apps/web/', 'local-only', { version: '2.0.0', license: 'MIT' });
    const found = readInstalled(root, ['apps/web'], ['shared', 'local-only']);
    expect(found.get('shared')?.version).toBe('1.0.0');
    expect(found.get('local-only')?.version).toBe('2.0.0');
  });

  it('skips a manifest that is not valid JSON', () => {
    const root = makeTempDir('cv-licenses-bad-');
    writeFile(root, 'node_modules/broken/package.json', '{ not json');
    expect(readInstalled(root, [], ['broken']).size).toBe(0);
  });

  it('notices when an installed package changes', () => {
    const root = makeTempDir('cv-licenses-change-');
    manifest(root, '', 'lib', { version: '1.0.0', license: 'MIT' });
    expect(readInstalled(root, [], ['lib']).get('lib')?.licenseRisk).toBe('permissive');
    const file = 'node_modules/lib/package.json';
    writeFile(root, file, JSON.stringify({ name: 'lib', version: '2.0.0', license: 'GPL-3.0-only' }));
    // The memo is keyed by modification time: make sure the rewrite counts as a change.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(`${root}/${file}`, later, later);
    expect(readInstalled(root, [], ['lib']).get('lib')).toMatchObject({ version: '2.0.0', licenseRisk: 'copyleft' });
  });
});

describe('licenses in an analysis', () => {
  it('adds what is installed to the packages, imported or not', async () => {
    const root = makeTempDir('cv-licenses-analysis-');
    writeFile(root, 'package.json', JSON.stringify({ name: 'app', dependencies: { 'friendly-lib': '^1.0.0', 'viral-lib': '^2.0.0', 'absent-lib': '^1.0.0' } }));
    writeFile(root, 'src/a.ts', "import { x } from 'friendly-lib';\nexport const y = x;\n");
    manifest(root, '', 'friendly-lib', { version: '1.4.2', license: 'MIT' });
    manifest(root, '', 'viral-lib', { version: '2.0.1', license: 'AGPL-3.0-only', scripts: { install: 'node build.js' } });

    const { packages } = await analyze({ root, git: false, history: false, includeSource: false });
    const byName = Object.fromEntries(packages.map((p) => [p.name, p]));
    expect(byName['friendly-lib']).toMatchObject({ installed: '1.4.2', license: 'MIT', licenseRisk: 'permissive' });
    expect(byName['friendly-lib'].installScripts).toBeUndefined();
    expect(byName['viral-lib']).toMatchObject({ installed: '2.0.1', licenseRisk: 'copyleft', installScripts: ['install'] });
    expect(byName['absent-lib'].installed).toBeUndefined();
    expect(byName['absent-lib'].licenseRisk).toBeUndefined();
  });
});
