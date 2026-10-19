import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyzer/index.js';
import { analyzeCi } from '../src/analyzer/workflows.js';
import { makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';

afterAll(removeTempDirs);

const NOW = Date.parse('2026-06-01T00:00:00Z');

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - run: npm run lint
      - run: npm run missing-script
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;

const SETUP_ACTION = `name: Setup
description: Install dependencies
inputs:
  node-version:
    description: Node version
runs:
  using: composite
  steps:
    - run: npm ci
      shell: bash
`;

/** A project with workflows, a local action, Dependabot, and a script CI does not run. */
function projectWithCi(): string {
  const root = makeTempDir('cv-ci-');
  writeFile(root, '.github/workflows/ci.yml', CI);
  writeFile(root, '.github/actions/setup/action.yml', SETUP_ACTION);
  writeFile(root, '.github/dependabot.yml', 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n');
  writeFile(root, 'package.json', JSON.stringify({ name: 'shop', scripts: { lint: 'eslint .', test: 'vitest' } }));
  return root;
}

describe('analyzeCi', () => {
  it('has nothing for a project without GitHub files', () => {
    const root = makeTempDir('cv-no-ci-');
    writeFile(root, 'package.json', '{}');
    expect(analyzeCi(root, { pkg: {} })).toBeUndefined();
  });

  it('reads workflows, local actions and Dependabot', () => {
    const root = projectWithCi();
    const ci = analyzeCi(root, { pkg: { scripts: { lint: 'eslint .', test: 'vitest' } }, now: NOW })!;
    expect(ci.base).toBe('');
    expect(ci.workflows.map((w) => [w.file, w.name])).toEqual([['.github/workflows/ci.yml', 'CI']]);
    expect(ci.workflows[0].jobs.map((j) => j.id)).toEqual(['test', 'deploy']);
    expect(ci.localActions).toEqual([expect.objectContaining({ path: '.github/actions/setup', name: 'Setup', inputs: ['node-version'], usedBy: 1 })]);
    expect(ci.dependabot?.ecosystems).toEqual([expect.objectContaining({ name: 'npm', interval: 'weekly' })]);
    expect(ci.actions.map((a) => a.name)).toContain('actions/checkout');
  });

  it('compares the scripts CI runs with those package.json has', () => {
    const root = projectWithCi();
    const ci = analyzeCi(root, { pkg: { scripts: { lint: 'eslint .', test: 'vitest' } }, now: NOW })!;
    const ids = ci.findings.map((f) => f.rule);
    expect(ids).toContain('missing-script');
    expect(ids).toContain('script-not-in-ci');
    expect(ci.scripts.find((s) => s.name === 'lint')?.runs).toHaveLength(1);
  });

  it('accepts a script that lives in a workspace package', () => {
    const root = projectWithCi();
    const ci = analyzeCi(root, { pkg: { scripts: { lint: 'x', test: 'y' } }, workspaces: [{ scripts: { 'missing-script': 'z' } }], now: NOW })!;
    expect(ci.findings.map((f) => f.rule)).not.toContain('missing-script');
  });

  it('follows local actions wherever the workflow points, and reports the ones that do not exist', () => {
    const root = makeTempDir('cv-ci-local-');
    writeFile(root, '.github/workflows/a.yml', 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: ./tools/build-action\n      - uses: ./tools/ghost\n      - uses: ./.github/workflows/reusable.yml\n');
    writeFile(root, 'tools/build-action/action.yaml', 'name: Build\nruns:\n  using: node20\n  main: index.js\n');
    const ci = analyzeCi(root, { pkg: {}, now: NOW })!;
    expect(ci.localActions.map((a) => a.path)).toEqual(['tools/build-action']);
    const missing = ci.findings.filter((f) => f.rule === 'unknown-local-action');
    expect(missing.map((f) => f.message)).toEqual([expect.stringContaining('ghost'), expect.stringContaining('reusable.yml')]);
  });

  it('reads the workflows of the whole repository from a package inside it', () => {
    const repo = makeTempDir('cv-ci-mono-');
    fs.mkdirSync(path.join(repo, '.git'));
    writeFile(repo, '.github/workflows/ci.yml', CI);
    writeFile(repo, 'packages/web/package.json', JSON.stringify({ name: 'web', scripts: { lint: 'x' } }));
    const ci = analyzeCi(path.join(repo, 'packages', 'web'), { pkg: { scripts: { lint: 'x' } }, now: NOW })!;
    expect(ci.base).toBe('packages/web');
    expect(ci.workflows).toHaveLength(1);
  });

  it('does not probe outside the repository for local actions', () => {
    const outside = makeTempDir('cv-outside-');
    writeFile(outside, 'secret/action.yml', 'name: Outside\nruns:\n  using: composite\n  steps: []\n');
    const repo = makeTempDir('cv-ci-escape-');
    fs.mkdirSync(path.join(repo, '.git'));
    const relative = path.relative(repo, path.join(outside, 'secret'));
    writeFile(repo, '.github/workflows/a.yml', `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./${relative}\n`);
    const ci = analyzeCi(repo, { pkg: {}, now: NOW })!;
    expect(ci.localActions).toEqual([]);
    expect(ci.findings.map((f) => f.rule)).toContain('unknown-local-action');
  });

  it('survives broken and huge files', () => {
    const root = makeTempDir('cv-ci-broken-');
    writeFile(root, '.github/workflows/broken.yml', 'on: [push\njobs: {');
    writeFile(root, '.github/workflows/huge.yml', `on: push\n# ${'x'.repeat(300 * 1024)}\n`);
    writeFile(root, '.github/workflows/readme.md', 'not a workflow');
    const ci = analyzeCi(root, { pkg: {}, now: NOW })!;
    expect(ci.workflows.map((w) => w.file)).toEqual(['.github/workflows/broken.yml']);
    expect(ci.findings.map((f) => f.rule)).toContain('invalid-yaml');
  });
});

describe('analyze with the ci option', () => {
  it('adds the CI report to the analysis only when asked for', async () => {
    const root = projectWithCi();
    writeFile(root, 'src/index.ts', 'export const a = 1;\n');
    expect((await analyze({ root, persist: false, history: false, git: false })).ci).toBeUndefined();
    const report = await analyze({ root, persist: false, history: false, git: false, ci: true });
    expect(report.ci?.workflows).toHaveLength(1);
    expect(report.ci?.findings.map((f) => f.rule)).toContain('missing-script');
    expect(report.warnings).toEqual([]);
  });

  it('adds nothing for a project without workflows', async () => {
    const root = makeTempDir('cv-ci-none-');
    writeFile(root, 'package.json', '{"name":"x"}');
    writeFile(root, 'src/index.ts', 'export const a = 1;\n');
    expect((await analyze({ root, persist: false, history: false, git: false, ci: true })).ci).toBeUndefined();
  });
});
