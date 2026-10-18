/**
 * Zero-config accuracy: nested fixture projects, the nearest package.json, devDependencies in production
 * code, entry / kind / orphan detection, per-function complexity and author identities.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyFile } from '../src/analyzer/classify.js';
import { normalizeConfig } from '../src/analyzer/config.js';
import { canonicalizeAuthors } from '../src/analyzer/git.js';
import { analyze, type AnalyzeOptions } from '../src/analyzer/index.js';
import { parseSource, type ParsedFile } from '../src/analyzer/parse.js';
import { isFixtureSubproject, loadProject } from '../src/analyzer/project.js';
import { runCli } from '../src/cli/run.js';
import { subprojectNotice } from '../src/cli/shared.js';
import type { ReportData, SymbolInfo } from '../src/shared/types.js';
import { commitAll, copyFixture, daysAgo, emailOf, git, hasGit, initRepo, isolateGit, makeTempDir, removeTempDirs, writeFile } from './companion-helpers.js';
import { analyzeFixture, fixturePath, getFile, getSymbol, hasSymbolEdge } from './helpers.js';

afterAll(removeTempDirs);

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Run the CLI in-process and capture stdout. */
async function cli(...argv: string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const capture = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
    return true;
  }) as typeof process.stdout.write;
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    const code = await runCli(argv);
    return { code, stdout: strip(stdout) };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

function analyzeDir(root: string, extra: Partial<AnalyzeOptions> = {}): Promise<ReportData> {
  return analyze({ root, git: false, includeSource: false, history: false, ...extra });
}

function project(files: Record<string, string | object>): string {
  const root = makeTempDir('cv-accuracy-');
  for (const [file, content] of Object.entries(files)) writeFile(root, file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return root;
}

/* -------------------------------------------------------------------------- */

describe('nested sub-projects', () => {
  let data: ReportData;
  beforeAll(async () => {
    data = await analyzeFixture('nested-subprojects');
  });

  it('leaves fixture projects inside test folders out and lists them', () => {
    expect(data.project.subprojects).toEqual(['test/fixtures/app']);
    expect(data.files.some((f) => f.id.startsWith('test/fixtures/'))).toBe(false);
    expect(data.insights.missingDependencies).toEqual([]);
    expect(data.packages.some((p) => p.name === 'next')).toBe(false);
    // The project's own tests are kept.
    expect(getFile(data, 'test/server.test.ts').kind).toBe('test');
  });

  it('prints a one-line notice that says where the setting goes, unless you already decided', () => {
    expect(subprojectNotice(data)).toBe('excluded 1 sub-project (test/fixtures/app) — set "includeSubprojects": true in code-visualizer.config.json to analyze it');
    const many = { ...data, project: { ...data.project, subprojects: ['test/fixtures/a', 'test/fixtures/b', 'examples/demo'] } };
    expect(subprojectNotice(many)).toBe(
      'excluded 3 sub-projects (test/fixtures/*, examples/demo) — set "includeSubprojects": true in code-visualizer.config.json to analyze them',
    );
    expect(subprojectNotice({ ...data, project: { ...data.project, subprojects: undefined } })).toBeUndefined();
    // An explicit `false` is a decision: no reminder on every run.
    expect(subprojectNotice({ ...data, config: { rules: 0, includeSubprojects: false } })).toBeUndefined();
    expect(subprojectNotice({ ...data, config: { rules: 0, includeSubprojects: ['examples/*'] } })).toBe(
      'excluded 1 sub-project (test/fixtures/app) — not matched by "includeSubprojects"',
    );
  });

  it('warns about includeSubprojects globs that match nothing', async () => {
    const typo = await analyzeDir(fixturePath('nested-subprojects'), { config: { config: { includeSubprojects: ['tset/fixtures/*'] } } });
    expect(typo.project.subprojects).toEqual(['test/fixtures/app']);
    expect(typo.warnings).toContain('"includeSubprojects": "tset/fixtures/*" matches no nested package.json folder.');
  });

  it('analyzes an excluded sub-project you point at with --directory / --file', async () => {
    const root = fixturePath('nested-subprojects');
    for (const extra of [{ directory: path.join(root, 'test/fixtures/app') }, { file: path.join(root, 'test/fixtures/app/page.tsx') }]) {
      const scoped = await analyzeDir(root, extra);
      expect(scoped.files.map((f) => f.id)).toContain('test/fixtures/app/page.tsx');
      expect(scoped.project.subprojects).toBeUndefined();
      expect(scoped.insights.missingDependencies).toEqual([]);
    }
  });

  it('analyzes them with includeSubprojects (true or globs), resolving imports against their own package.json', async () => {
    for (const includeSubprojects of [true, ['test/fixtures/*']]) {
      const all = await analyzeDir(fixturePath('nested-subprojects'), { config: { config: { includeSubprojects } } });
      expect(all.project.subprojects).toBeUndefined();
      expect(getFile(all, 'test/fixtures/app/page.tsx')).toBeDefined();
      expect(all.insights.missingDependencies).toEqual([]);
      expect(all.packages.find((p) => p.name === 'next')).toMatchObject({ declaredAs: 'dependencies', importedBy: ['test/fixtures/app/page.tsx'] });
    }
  });

  it('treats sample / fixture / example packages as sub-projects, but keeps test harness packages', () => {
    expect(isFixtureSubproject('test/fixtures/app')).toBe(true);
    expect(isFixtureSubproject('examples/basic')).toBe(true);
    expect(isFixtureSubproject('packages/core/__fixtures__/demo')).toBe(true);
    expect(isFixtureSubproject('test/app')).toBe(true);
    // A React Native library's example app, or an examples folder that is a package itself.
    expect(isFixtureSubproject('example')).toBe(true);
    expect(isFixtureSubproject('examples')).toBe(true);
    // Playwright / Cypress suites with their own package.json, wherever they live.
    expect(isFixtureSubproject('e2e')).toBe(false);
    expect(isFixtureSubproject('tests')).toBe(false);
    expect(isFixtureSubproject('tests/e2e')).toBe(false);
    expect(isFixtureSubproject('test/playwright')).toBe(false);
    expect(isFixtureSubproject('test/fixtures/e2e')).toBe(true);
    expect(isFixtureSubproject('packages/tool')).toBe(false);
  });

  it('ignores marker package.json files and workspaces, and stays quiet about folders the user excluded', async () => {
    const root = project({
      'package.json': { name: 'mono', private: true, workspaces: ['examples/*'], dependencies: { zod: '^3.0.0' } },
      'src/index.ts': "import { z } from 'zod';\nexport const schema = z.string();\n",
      'test/esm/package.json': { type: 'module' },
      'test/esm/util.test.ts': "import { schema } from '../../src/index';\nschema.parse('x');\n",
      'examples/site/package.json': { name: 'site', dependencies: { zod: '^3.0.0' } },
      'examples/site/main.ts': "import { z } from 'zod';\nz.number();\n",
      'test/fixtures/legacy/package.json': { name: 'legacy', dependencies: { moment: '^2.0.0' } },
      'test/fixtures/legacy/index.js': "import moment from 'moment';\nmoment();\n",
    });
    const data = await analyzeDir(root);
    expect(data.files.map((f) => f.id).sort()).toEqual(['examples/site/main.ts', 'src/index.ts', 'test/esm/util.test.ts']);
    expect(data.project.subprojects).toEqual(['test/fixtures/legacy']);
    const excluded = await analyzeDir(root, { exclude: ['test/fixtures/**'] });
    expect(excluded.project.subprojects).toBeUndefined();
  });
});

describe('dependencies against the nearest package.json', () => {
  let data: ReportData;
  beforeAll(async () => {
    data = await analyzeFixture('nested-subprojects');
  });

  it('resolves a nested package against its own package.json', () => {
    expect(data.packages.find((p) => p.name === 'lodash')).toMatchObject({ declaredAs: 'dependencies', importedBy: ['packages/tool/index.js'] });
    expect(data.packages.find((p) => p.name === 'lodash')!.missing).toBeUndefined();
    // Its main file is an entry, not an orphan.
    expect(getFile(data, 'packages/tool/index.js')).toMatchObject({ isEntry: true, entryReason: 'package.json "main"' });
    expect(data.insights.unusedDependencies).toEqual([]);
  });

  it('flags a devDependency imported by production code, but not by tests, configs, type imports or browser bundles', () => {
    expect(data.insights.devDependenciesInProduction).toEqual([{ name: 'chalk', files: ['src/server.ts'], manifest: '' }]);
    const names = data.insights.devDependenciesInProduction!.map((d) => d.name);
    expect(names).not.toContain('vite'); // type-only import in src/server.ts, value import in vite.config.ts
    expect(names).not.toContain('vitest'); // tests
    expect(names).not.toContain('clsx'); // web/src/App.tsx is bundled from web/index.html
    const deps = data.health.categories.find((c) => c.id === 'dependencies')!;
    expect(deps.detail).toBe('0 unused, 0 missing from package.json, 1 devDependency used in production code');
    expect(deps.score).toBeLessThan(100);
    expect(data.health.improvements.find((i) => i.id === 'dependencies')!.detail).toContain('move chalk to dependencies');
  });

  it('names the package and file of allowed findings, and hints at the setting when the gate fails', async () => {
    const strict = await cli('check', fixturePath('nested-subprojects'), '--no-git');
    expect(strict.stdout).toContain('Intentional (a runtime-provided or bundled package)? Set "check": { "allowDevDependenciesInProduction": ["<name>"] }');
    const copy = copyFixture('nested-subprojects', 'cv-accuracy-');
    fs.writeFileSync(path.join(copy, 'code-visualizer.config.json'), JSON.stringify({ check: { allowDevDependenciesInProduction: ['chalk'] } }));
    const listed = await cli('check', copy, '--no-git');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('✔ Declared dependencies 1 devDependency used in production code');
    expect(listed.stdout).toContain('• src/server.ts "chalk" is only a devDependency but production code imports it');
    const help = await cli('check', '--help');
    expect(help.stdout).toContain('allowDevDependenciesInProduction');
  });

  it('keeps allowed missing dependencies as warnings when a devDependency fails the gate', async () => {
    const copy = copyFixture('nested-subprojects', 'cv-accuracy-');
    fs.writeFileSync(path.join(copy, 'src/extra.ts'), "import ms from 'ms';\nexport const t = ms('1s');\n");
    fs.writeFileSync(path.join(copy, 'code-visualizer.config.json'), JSON.stringify({ check: { allowMissingDependencies: true } }));
    const res = await cli('check', copy, '--no-git', '--format', 'github');
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('::warning file=src/extra.ts,title=code-visualizer%3A Declared dependencies::"ms" is imported but not declared in package.json');
    expect(res.stdout).toContain('::error file=src/server.ts,title=code-visualizer%3A Declared dependencies::"chalk" is only a devDependency');
  });

  it('fails the dependency gate of `check` unless allowDevDependenciesInProduction is set', async () => {
    const strict = await cli('check', fixturePath('nested-subprojects'), '--no-git', '--format', 'json');
    expect(strict.code).toBe(1);
    const gate = (JSON.parse(strict.stdout) as { gates: { id: string; ok: boolean; detail: string; findings: { file: string; message: string; severity: string }[] }[] }).gates.find((g) => g.id === 'dependencies')!;
    expect(gate).toMatchObject({ ok: false, detail: '1 devDependency used in production code' });
    expect(gate.findings).toEqual([
      expect.objectContaining({ file: 'src/server.ts', message: '"chalk" is only a devDependency but production code imports it (move it to "dependencies")', severity: 'error', ruleId: 'cv/dev-dependency-in-production' }),
    ]);

    const copy = copyFixture('nested-subprojects', 'cv-accuracy-');
    fs.writeFileSync(path.join(copy, 'code-visualizer.config.json'), JSON.stringify({ check: { allowDevDependenciesInProduction: true } }));
    const lenient = await cli('check', copy, '--no-git');
    expect(lenient.code).toBe(0);
    expect(lenient.stdout).toContain('✔ Declared dependencies 1 devDependency used in production code');
    expect(lenient.stdout).toContain('ℹ excluded 1 sub-project (test/fixtures/app) — set "includeSubprojects": true in code-visualizer.config.json to analyze it');
  });

  it('flags a workspace that uses a dependency only a sibling declares; root dependencies are shared', async () => {
    const root = project({
      'package.json': { name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { vitest: '^2.0.0' } },
      'packages/a/package.json': { name: '@mono/a', dependencies: { zod: '^3.0.0', nanoid: '^5.0.0' } },
      'packages/a/src/index.ts': "import { nanoid } from 'nanoid';\nexport const id = nanoid();\n",
      'packages/b/package.json': { name: '@mono/b', dependencies: {} },
      'packages/b/src/index.ts': "import { z } from 'zod';\nexport const name = z.string();\n",
      'packages/b/src/index.test.ts': "import { it } from 'vitest';\nimport { name } from './index';\nit('works', () => name.parse('x'));\n",
    });
    const data = await analyzeDir(root);
    expect(data.insights.missingDependencies).toEqual([{ name: 'zod', files: ['packages/b/src/index.ts'], manifests: ['packages/b'], declaredBy: ['packages/a'] }]);
    expect(data.insights.unusedDependencies).toEqual(['zod']); // declared by a, used only by b
    expect(data.insights.unusedDeclarations).toEqual([{ name: 'zod', manifest: 'packages/a' }]);
    expect(data.insights.devDependenciesInProduction ?? []).toEqual([]);
    // One Packages entry per name: imported (but undeclared) by b, declared without use by a.
    expect(data.packages.filter((p) => p.name === 'zod')).toHaveLength(1);
    expect(data.packages.find((p) => p.name === 'zod')).toMatchObject({ missing: true, declaredAs: undefined, unusedIn: ['packages/a'] });
    expect(data.health.improvements.find((i) => i.id === 'dependencies')!.detail).toBe(
      'remove zod from packages/a/package.json; declare zod in packages/b/package.json',
    );

    const check = await cli('check', root, '--no-git', '--format', 'json');
    const gate = (JSON.parse(check.stdout) as { gates: { id: string; findings: { message: string }[] }[] }).gates.find((g) => g.id === 'dependencies')!;
    expect(gate.findings.map((f) => f.message)).toEqual([
      '"zod" is imported but not declared in packages/b/package.json (only packages/a/package.json declares it)',
    ]);
  });

  it('keeps one Packages entry when a package is used in one workspace and unused in another', async () => {
    const root = project({
      'package.json': { name: 'mono', private: true, workspaces: ['packages/*'] },
      'packages/a/package.json': { name: '@mono/a', dependencies: { lodash: '^4.0.0', '@mono/b': '*' } },
      'packages/a/src/index.ts': "import { b } from '@mono/b';\nexport const a = b;\n",
      'packages/b/package.json': { name: '@mono/b', dependencies: { lodash: '^4.0.0' } },
      'packages/b/src/index.ts': "import { chunk } from 'lodash';\nexport const b = chunk([1], 1);\n",
    });
    const data = await analyzeDir(root);
    expect(data.packages.filter((p) => p.name === 'lodash')).toEqual([expect.objectContaining({ declaredAs: 'dependencies', unusedIn: ['packages/a'] })]);
    expect(data.packages.find((p) => p.name === 'lodash')!.unused).toBeUndefined();
    // A workspace imported by name resolves to its source files, and still counts as used.
    expect(data.insights.unusedDeclarations).toEqual([{ name: 'lodash', manifest: 'packages/a' }]);
  });

  it('sees the monorepo root package.json when you analyze one workspace', async () => {
    const root = project({
      'package.json': { name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { vitest: '^2.0.0' } },
      'packages/a/package.json': { name: '@mono/a', dependencies: { zod: '^3.0.0' } },
      'packages/a/src/index.ts': "import { z } from 'zod';\nexport const a = z.string();\n",
      'packages/a/test/a.test.ts': "import { it } from 'vitest';\nimport { a } from '../src/index';\nit('works', () => a.parse('x'));\n",
    });
    const data = await analyzeDir(path.join(root, 'packages/a'));
    expect(data.insights.missingDependencies).toEqual([]);
    expect(data.packages.find((p) => p.name === 'vitest')).toMatchObject({ declaredAs: 'devDependencies' });
    // The root's own dependencies are not judged from one workspace.
    expect(data.insights.unusedDependencies).toEqual([]);
  });

  it('does not judge package.json files whose code is excluded or git-ignored', async () => {
    const root = project({
      'package.json': { name: 'app', dependencies: { express: '^4.0.0' } },
      'code-visualizer.config.json': { exclude: ['legacy/**'] },
      '.gitignore': 'gen/\n',
      'src/index.ts': "import express from 'express';\nexpress();\n",
      'legacy/package.json': { name: 'legacy', dependencies: { moment: '^2.0.0', jquery: '^3.0.0' } },
      'legacy/index.js': "import moment from 'moment';\nmoment();\n",
      'gen/client/package.json': { name: 'client', dependencies: { axios: '^1.0.0' } },
      'gen/client/index.ts': "import axios from 'axios';\naxios.get('/');\n",
    });
    const data = await analyze({ root, git: false, includeSource: false, history: false });
    expect(data.files.map((f) => f.id)).toEqual(['src/index.ts']);
    expect(data.insights.unusedDependencies).toEqual([]);
    expect(data.health.categories.find((c) => c.id === 'dependencies')!.score).toBe(100);
  });

  it('does not report JSX-only react, packages run from scripts, or packages named in tool configs as unused', async () => {
    const root = project({
      'package.json': { name: 'site', scripts: { start: 'docusaurus start' }, dependencies: { react: '^18.0.0', '@docusaurus/core': '^3.0.0', '@mdx-js/react': '^3.0.0', 'my-preset': '^1.0.0' } },
      'site.config.js': "export default { presets: [['my-preset', {}]] };\n",
      'src/pages/index.jsx': 'export default function Home() { return <main>Hi</main>; }\n',
    });
    const data = await analyzeDir(root);
    expect(data.insights.unusedDependencies).toEqual([]);
  });
});

describe('devDependencies in production code: only what ships', () => {
  const devNames = (data: ReportData): string[] => (data.insights.devDependenciesInProduction ?? []).map((d) => d.name).sort();

  it('ignores test support of a Vite + Vitest + Testing Library + MSW app (setup files, test-utils, mocks)', async () => {
    const root = project({
      'package.json': {
        name: 'rtl-app',
        scripts: { dev: 'vite', test: 'vitest' },
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        devDependencies: { vite: '^5.0.0', vitest: '^2.0.0', msw: '^2.0.0', '@testing-library/react': '^16.0.0', '@testing-library/jest-dom': '^6.0.0', '@testing-library/user-event': '^14.0.0' },
      },
      'index.html': '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      'vite.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'jsdom', setupFiles: './src/setupTests.ts' } });\n",
      'src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport { App } from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n",
      'src/App.tsx': 'export function App() { return <h1>Hi</h1>; }\n',
      'src/setupTests.ts': "import '@testing-library/jest-dom/vitest';\nimport { afterAll, beforeAll } from 'vitest';\nimport { server } from './mocks/server';\nbeforeAll(() => server.listen());\nafterAll(() => server.close());\n",
      'src/mocks/server.ts': "import { setupServer } from 'msw/node';\nimport { handlers } from './handlers';\nexport const server = setupServer(...handlers);\n",
      'src/mocks/handlers.ts': "import { http, HttpResponse } from 'msw';\nexport const handlers = [http.get('/api', () => HttpResponse.json({}))];\n",
      'src/test-utils.tsx': "import { render } from '@testing-library/react';\nimport userEvent from '@testing-library/user-event';\nexport function setup(ui: JSX.Element) { return { user: userEvent.setup(), ...render(ui) }; }\n",
      'src/support/fakes.ts': "import { http } from 'msw';\nexport const fake = http.get('/x', () => undefined);\n",
      'src/App.test.tsx': "import { it } from 'vitest';\nimport { setup } from './test-utils';\nimport { fake } from './support/fakes';\nimport { App } from './App';\nit('renders', () => { setup(<App />); void fake; });\n",
    });
    const data = await analyzeDir(root);
    expect(devNames(data)).toEqual([]);
    expect((await cli('check', root, '--no-git')).code).toBe(0);
  });

  it('does not flag packages the runtime provides (Electron, VS Code)', async () => {
    const root = project({
      'package.json': { name: 'desk', main: 'src/main.js', devDependencies: { electron: '^30.0.0', 'electron-builder': '^24.0.0', 'electron-store': '^8.0.0' } },
      'src/main.js': "const { app, BrowserWindow } = require('electron');\nconst Store = require('electron-store');\napp.whenReady().then(() => new BrowserWindow(new Store()));\n",
    });
    const data = await analyzeDir(root);
    // electron-builder refuses "electron" in dependencies; electron-store really must move.
    expect(devNames(data)).toEqual(['electron-store']);
  });

  it('does not count a guarded dynamic import (the Vite SSR template), but does count static ones', async () => {
    const root = project({
      'package.json': { name: 'ssr', type: 'module', scripts: { dev: 'node server', start: 'NODE_ENV=production node server' }, dependencies: { express: '^4.0.0' }, devDependencies: { vite: '^5.0.0', morgan: '^1.0.0' } },
      'index.html': '<!doctype html><html><body><script type="module" src="/src/entry-client.tsx"></script></body></html>',
      'server.js': "import express from 'express';\nimport morgan from 'morgan';\nconst app = express();\napp.use(morgan('dev'));\nif (process.env.NODE_ENV !== 'production') {\n  const { createServer } = await import('vite');\n  app.use((await createServer()).middlewares);\n}\napp.listen(5173);\n",
      'src/entry-client.tsx': "console.log('client');\n",
    });
    const data = await analyzeDir(root);
    expect(devNames(data)).toEqual(['morgan']);
  });

  it("checks a package's bin entry even though it lives in bin/", async () => {
    const root = project({
      'package.json': { name: 'my-cli', bin: { 'my-cli': 'bin/cli.js' }, main: 'lib/index.js', devDependencies: { commander: '^12.0.0', chalk: '^5.0.0' } },
      'bin/cli.js': "#!/usr/bin/env node\nimport { program } from 'commander';\nimport { run } from '../lib/index.js';\nprogram.action(run).parse();\n",
      'lib/index.js': "import chalk from 'chalk';\nexport function run() { console.log(chalk.green('ok')); }\n",
    });
    const data = await analyzeDir(root);
    expect(devNames(data)).toEqual(['chalk', 'commander']);
  });

  it('tells a workspace to declare a root devDependency it uses in production', async () => {
    const root = project({
      'package.json': { name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { chalk: '^5.0.0' } },
      'packages/a/package.json': { name: '@mono/a', main: 'src/index.ts' },
      'packages/a/src/index.ts': "import chalk from 'chalk';\nexport const a = chalk.red('a');\n",
    });
    const data = await analyzeDir(root);
    expect(data.insights.devDependenciesInProduction).toEqual([{ name: 'chalk', files: ['packages/a/src/index.ts'], manifest: '', declareIn: 'packages/a' }]);
    const check = await cli('check', root, '--no-git', '--format', 'json');
    const gate = (JSON.parse(check.stdout) as { gates: { id: string; findings: { message: string }[] }[] }).gates.find((g) => g.id === 'dependencies')!;
    expect(gate.findings.map((f) => f.message)).toEqual([
      '"chalk" is only a devDependency of package.json but production code in packages/a imports it (declare it in "dependencies" of packages/a/package.json)',
    ]);
  });
});

describe('entries, kinds and orphans', () => {
  let data: ReportData;
  beforeAll(async () => {
    data = await analyzeFixture('nested-subprojects');
  });

  it('does not treat an app config.ts as a build config', () => {
    const config = getFile(data, 'src/config.ts');
    expect(config.isEntry).toBe(false);
    expect(config.kind).not.toBe('config');
    // './legacy.ts' is just a string in config.ts: not an entry point, so the unused file is an orphan.
    expect(getFile(data, 'src/legacy.ts')).toMatchObject({ isEntry: false, orphan: true });
    expect(data.insights.orphans).toEqual(['src/legacy.ts']);
    // Exports of config.ts are judged like any module's.
    expect(config.exports.find((e) => e.name === 'config')!.unused).toBeUndefined();
  });

  it('still reads entry files from real tool configs, but not their own imports', async () => {
    const root = project({
      'package.json': { name: 'lib', devDependencies: { tsup: '^8.0.0' } },
      'tsup.config.ts': "import { banner } from './tools/banner.js';\nexport default { entry: ['src/launch.ts'], banner };\n",
      'tools/banner.ts': "export const banner = { js: '' };\n",
      'src/launch.ts': "console.log('cli');\n",
    });
    const data = await analyzeDir(root);
    expect(getFile(data, 'src/launch.ts')).toMatchObject({ isEntry: true, entryReason: 'referenced in tsup.config.ts' });
    expect(getFile(data, 'tools/banner.ts').isEntry).toBe(false);
  });

  it('classifies context.ts by what it is, not by its name', () => {
    expect(getFile(data, 'src/cli/context.ts').kind).not.toBe('context');
    const parsed = (id: string, text: string): ParsedFile => parseSource(id, text, id.slice(id.lastIndexOf('.')));
    const ui = "export function ThemeContext() { return <div />; }\n";
    expect(classifyFile('src/ThemeContext.tsx', parsed('src/ThemeContext.tsx', ui), undefined, false)).toBe('context');
    const created = "import { createContext } from 'react';\nexport const Theme = createContext('light');\n";
    expect(classifyFile('src/theme.ts', parsed('src/theme.ts', created), undefined, false)).toBe('context');
    const provider = '@Injectable()\nexport class DatabaseProvider { connect() { return 1; } }\n';
    expect(classifyFile('src/providers/database.provider.ts', parsed('src/providers/database.provider.ts', provider), undefined, false)).not.toBe('context');
  });

  it('finds index.html of vite apps in sub folders (vite root, --root / --config in scripts)', async () => {
    expect(getFile(data, 'web/src/main.tsx')).toMatchObject({ isEntry: true, entryReason: 'referenced by a script / index.html' });
    expect(getFile(data, 'web/src/main.tsx').orphan).toBeUndefined();

    // Every index.html below is four folders deep, out of reach of the generic three-level search, and the
    // --config file has a custom name: each is found only through its own vite setting.
    const html = (src: string): string => `<!doctype html><html><body><script type="module" src="${src}"></script></body></html>`;
    const files = {
      'package.json': { name: 'apps', scripts: { dev: 'vite --config tools/bundler/vite/conf/app.vite.mjs', admin: 'vite build --root clients/admin/app/web' } },
      'vite.config.ts': "export default { root: 'clients/site/app/web' };\n",
      'clients/site/app/web/index.html': html('/src/main.ts'),
      'clients/site/app/web/src/main.ts': "console.log('site');\n",
      'clients/admin/app/web/index.html': html('./boot.ts'),
      'clients/admin/app/web/boot.ts': "console.log('admin');\n",
      'tools/bundler/vite/conf/app.vite.mjs': 'export default {};\n',
      'tools/bundler/vite/conf/index.html': html('/entry.ts'),
      'tools/bundler/vite/conf/entry.ts': "console.log('tools');\n",
    };
    const ids = ['clients/site/app/web/src/main.ts', 'clients/admin/app/web/boot.ts', 'tools/bundler/vite/conf/entry.ts'];
    const root = project(files);
    const ctx = await loadProject(root);
    expect([...ctx.htmlEntries].sort()).toEqual(expect.arrayContaining(ids));
    const report = await analyzeDir(root);
    for (const id of ids) {
      expect(getFile(report, id)).toMatchObject({ isEntry: true });
      expect(getFile(report, id).orphan).toBeUndefined();
    }
    // Without the vite settings none of them is found.
    const bare = project({ ...files, 'package.json': { name: 'apps' }, 'vite.config.ts': 'export default {};\n' });
    const none = await loadProject(bare);
    for (const id of ids) expect(none.htmlEntries.has(id)).toBe(false);
  });

  it('reads entry files from per-environment tool configs (webpack.config.prod.js)', async () => {
    const root = project({
      'package.json': { name: 'wp', devDependencies: { webpack: '^5.0.0' } },
      'webpack.config.prod.js': "module.exports = { entry: './client/boot.js' };\n",
      'client/boot.js': "console.log('boot');\n",
    });
    const data = await analyzeDir(root);
    expect(getFile(data, 'client/boot.js')).toMatchObject({ isEntry: true, entryReason: 'referenced in webpack.config.prod.js' });
    expect(getFile(data, 'client/boot.js').orphan).toBeUndefined();
    expect(getFile(data, 'webpack.config.prod.js').kind).toBe('config');
  });
});

describe('complexity of functions with callbacks', () => {
  it('counts a function without its callbacks, while cognitive complexity sees them and their calls still link', async () => {
    const data = await analyzeFixture('nested-subprojects');
    const summarize = getSymbol(data, 'src/complex.ts#summarize');
    expect(summarize.complexity).toBe(1);
    expect(summarize.cognitive).toBe(6); // three `if`s, each nested one level inside a callback
    expect(hasSymbolEdge(data, 'calls', 'src/complex.ts#summarize', 'src/complex.ts#check')).toBe(true);
    expect(hasSymbolEdge(data, 'calls', 'src/complex.ts#summarize', 'src/complex.ts#report')).toBe(true);
    expect(data.insights.complexFunctions.find((c) => c.name === 'summarize')).toBeUndefined();
  });

  const sym = (text: string, name: string): SymbolInfo => {
    const parsed = parseSource('src/x.ts', text, '.ts');
    expect(parsed.parseError).toBeUndefined();
    return parsed.symbols.find((s) => s.name === name)!;
  };

  it('follows the SonarSource examples for cognitive complexity', () => {
    const sumOfPrimes = sym(
      `function sumOfPrimes(max: number) {
        let total = 0;
        OUT: for (let i = 1; i <= max; ++i) {
          for (let j = 2; j < i; ++j) {
            if (i % j === 0) continue OUT;
          }
          total += i;
        }
        return total;
      }`,
      'sumOfPrimes',
    );
    expect(sumOfPrimes).toMatchObject({ complexity: 4, cognitive: 7 });
    const getWords = sym(
      `function getWords(n: number) {
        switch (n) {
          case 1: return 'one';
          case 2: return 'a couple';
          default: return 'lots';
        }
      }`,
      'getWords',
    );
    expect(getWords).toMatchObject({ complexity: 3, cognitive: 1 });
    // if + else if + else, then one sequence of && and one of ||
    const branches = sym('function f(a, b, c, d) { if (a) x(); else if (b) y(); else z(); return a && b && c || d; }', 'f');
    expect(branches).toMatchObject({ complexity: 6, cognitive: 5 });
  });

  it("measures curried functions and class property arrows as the symbol's own body", () => {
    const thunk = sym('export const load = (id) => async (dispatch) => { try { if (id) dispatch(1); } catch { dispatch(2); } };', 'load');
    expect(thunk).toMatchObject({ complexity: 3, cognitive: 2 });
    const cls = sym('class A { handle = () => { if (this.x) return 1; return [1].map((v) => (v ? 1 : 2)); }; m() { if (this.a) this.b(); } }', 'A');
    // handle's `if` and m's `if` count; the ternary lives in a nested callback.
    expect(cls).toMatchObject({ complexity: 3, cognitive: 4 });
  });

  it('keeps the file total (every decision in the file)', () => {
    const parsed = parseSource('src/x.ts', 'export function f(xs: number[]) { return xs.map((x) => (x > 1 ? 1 : 2)); }', '.ts');
    expect(parsed.symbols[0]).toMatchObject({ complexity: 1, cognitive: 2 });
    expect(parsed.complexity).toBe(2);
  });

  it('measures a returned function (factory, middleware) like a curried one', async () => {
    const body = '{ try { if (id) dispatch(1); else if (dispatch) dispatch(2); } catch { dispatch(3); } }';
    const curried = sym(`export const loadA = (id) => async (dispatch) => ${body};`, 'loadA');
    const factory = sym(`export function loadB(id) { const tag = 'b'; return async (dispatch) => ${body}; }`, 'loadB');
    expect(curried.complexity).toBe(4);
    expect(factory).toMatchObject({ complexity: curried.complexity, cognitive: curried.cognitive });
    const data = await analyzeFixture('express-api');
    expect(getSymbol(data, 'middleware/auth.js#requireRole').complexity).toBe(3);
    expect(data.insights.complexFunctions.find((c) => c.name === 'requireRole')).toMatchObject({ complexity: 3 });
  });

  it('still measures inline callbacks (route handlers) and gates them', async () => {
    const handler = `(req, res) => {
      if (!req.user) return res.sendStatus(401);
      for (const item of req.body.items) {
        if (item.qty > 10 && item.price) res.write('bulk');
        else if (item.qty < 0) return res.sendStatus(400);
      }
      return res.end();
    }`;
    const root = project({
      'package.json': { name: 'api', dependencies: { express: '^4.0.0' } },
      'src/server.ts': `import express from 'express';\nexport function registerRoutes(app: express.Express) {\n  app.get('/health', (_req, res) => res.send('ok'));\n  app.post('/orders', ${handler});\n}\nregisterRoutes(express());\n`,
    });
    const data = await analyzeDir(root);
    const registerRoutes = getSymbol(data, 'src/server.ts#registerRoutes');
    expect(registerRoutes.complexity).toBe(1);
    expect(registerRoutes.nested).toMatchObject({ name: 'app.post callback', complexity: 6, line: 4 });
    expect(data.insights.complexFunctions[0]).toMatchObject({ symbol: 'src/server.ts#registerRoutes', name: 'registerRoutes › app.post callback', complexity: 6, line: 4 });
    const res = await cli('check', root, '--no-git', '--max-complexity', '5', '--format', 'json');
    expect(res.code).toBe(1);
    const gate = (JSON.parse(res.stdout) as { gates: { id: string; findings: { message: string }[] }[] }).gates.find((g) => g.id === 'complexity')!;
    expect(gate.findings.map((f) => f.message)).toEqual(['registerRoutes › app.post callback has cyclomatic complexity 6 (max 5)']);
  });

  it('stores a cognitive complexity of 0 for straight-line functions (the panel shows – only without data)', () => {
    expect(sym('export function plain(a: number) { return a + 1; }', 'plain').cognitive).toBe(0);
  });
});

describe('configuration: includeSubprojects', () => {
  it('accepts booleans, "true"/"false" and globs; rejects anything else', () => {
    expect(normalizeConfig({ includeSubprojects: true }).config.includeSubprojects).toBe(true);
    expect(normalizeConfig({ includeSubprojects: 'false' }).config.includeSubprojects).toBe(false);
    expect(normalizeConfig({ includeSubprojects: 'examples/*' }).config.includeSubprojects).toEqual(['examples/*']);
    expect(normalizeConfig({ includeSubprojects: ['a/*', 'b'] }).config.includeSubprojects).toEqual(['a/*', 'b']);
    expect(normalizeConfig({ includeSubprojects: 'Yes' }).config.includeSubprojects).toBe(true);
    expect(normalizeConfig({ includeSubprojects: { 'examples/*': true, 'test/fixtures/*': false } }).config.includeSubprojects).toEqual(['examples/*']);
    expect(normalizeConfig({ includeSubprojects: 3 }).error).toMatch(/"includeSubprojects" must be/);
    expect(normalizeConfig({ includeSubprojects: { 'examples/*': 'yes' } }).error).toMatch(/"includeSubprojects" must be/);
    expect(normalizeConfig({ check: { allowDevDependenciesInProduction: 'yes' } }).config.check).toEqual({ allowDevDependenciesInProduction: true });
    expect(normalizeConfig({ check: { allowDevDependenciesInProduction: 'electron' } }).config.check).toEqual({ allowDevDependenciesInProduction: ['electron'] });
    expect(normalizeConfig({ check: { allowDevDependenciesInProduction: { electron: true } } }).config.check).toEqual({ allowDevDependenciesInProduction: ['electron'] });
    expect(normalizeConfig({ check: { allowDevDependenciesInProduction: 1 } }).error).toMatch(/check.allowDevDependenciesInProduction must be true, false or the names/);
    expect(normalizeConfig({ check: { allowMissingDependencies: 'yes' } }).error).toBe('check.allowMissingDependencies must be true or false.');
  });
});

describe('author identities', () => {
  it('merges names that share an email, never through generic emails', () => {
    const commits = [
      { author: 'Ann Smith', email: 'ann@corp.example' },
      { author: 'asmith', email: 'ANN@corp.example' },
      { author: 'asmith', email: 'asmith@home.example' },
      { author: 'CI', email: 'root@localhost' },
      { author: 'Bot', email: 'root@localhost' },
    ];
    const ids = canonicalizeAuthors(commits);
    expect(commits.map((c) => c.author)).toEqual(['Ann Smith', 'Ann Smith', 'Ann Smith', 'CI', 'Bot']);
    expect(ids.nameOf('asmith@home.example')).toBe('Ann Smith');
    expect(ids.emailOf('Ann Smith')).toBe('ann@corp.example');
    expect(ids.emailOf('CI')).toBeUndefined();
  });
});

describe.skipIf(!hasGit)('author identities in git history', () => {
  let restoreEnv: () => void;
  beforeAll(() => {
    restoreEnv = isolateGit();
  });
  afterAll(() => restoreEnv?.());

  const commitAs = (repo: string, name: string, email: string, date: number, message: string): void => {
    const stamp = `@${Math.floor(date / 1000)} +0000`;
    git(repo, ['add', '-A']);
    git(repo, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', message], {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
  };

  it('applies .mailmap and recognises you by user.email', async () => {
    const repo = initRepo('nested-subprojects');
    commitAll(repo, { author: 'Ann Smith', date: daysAgo(20), message: 'Initial import' });
    fs.appendFileSync(path.join(repo, 'src/complex.ts'), '\nexport const one = 1;\n');
    commitAll(repo, { author: 'asmith', date: daysAgo(10), message: 'Add one' });
    fs.appendFileSync(path.join(repo, 'src/complex.ts'), '\nexport const two = 2;\n');
    commitAll(repo, { author: 'Bob Builder', date: daysAgo(5), message: 'Add two' });
    fs.writeFileSync(path.join(repo, '.mailmap'), `Ann Smith <${emailOf('Ann Smith')}> <${emailOf('asmith')}>\n`);
    commitAll(repo, { author: 'Ann Smith', date: daysAgo(4), message: 'Add mailmap' });
    // You run the analysis with your old identity: the email finds you, the name would not.
    git(repo, ['config', 'user.name', 'A. Smith (laptop)']);
    git(repo, ['config', 'user.email', emailOf('asmith')]);
    fs.appendFileSync(path.join(repo, 'src/complex.ts'), '\nexport const three = 3;\n');

    const data = await analyze({ root: repo, includeSource: false, history: false });
    const authors = getFile(data, 'src/complex.ts').git!.authors;
    expect(authors.map((a) => [a.name, a.commits])).toEqual([
      ['Ann Smith', 2],
      ['Bob Builder', 1],
    ]);
    expect(authors[0].email).toBe(emailOf('Ann Smith'));
    expect(data.git!.contributors.map((c) => c.name).sort()).toEqual(['Ann Smith', 'Bob Builder']);
    expect(data.git).toMatchObject({ user: 'Ann Smith', userEmail: emailOf('Ann Smith') });
    // You are never suggested as your own reviewer.
    expect(data.changes!.reviewers.map((r) => r.name)).toEqual(['Bob Builder']);
  });

  it('recognises you through a name-qualified .mailmap entry even with another user.name', async () => {
    const repo = initRepo('nested-subprojects');
    commitAs(repo, 'Ann Smith', 'ann@corp.example', daysAgo(20), 'Initial import');
    fs.appendFileSync(path.join(repo, 'src/complex.ts'), '\nexport const one = 1;\n');
    commitAs(repo, 'asmith', 'asmith@home.example', daysAgo(10), 'Add one');
    fs.appendFileSync(path.join(repo, 'src/complex.ts'), '\nexport const two = 2;\n');
    commitAs(repo, 'Bob Builder', 'bob@corp.example', daysAgo(5), 'Add two');
    fs.writeFileSync(path.join(repo, '.mailmap'), 'Ann Smith <ann@corp.example> asmith <asmith@home.example>\n');
    commitAs(repo, 'Ann Smith', 'ann@corp.example', daysAgo(4), 'Add mailmap');
    git(repo, ['config', 'user.name', 'Laptop Ann']);
    git(repo, ['config', 'user.email', 'asmith@home.example']);
    fs.appendFileSync(path.join(repo, 'src/complex.ts'), '\nexport const three = 3;\n');

    const data = await analyze({ root: repo, includeSource: false, history: false });
    expect(data.git).toMatchObject({ user: 'Ann Smith', userEmail: 'ann@corp.example' });
    expect(data.changes!.reviewers.map((r) => r.name)).toEqual(['Bob Builder']);
  });

  it('merges two names that share an email without a .mailmap', async () => {
    const repo = initRepo('nested-subprojects');
    commitAs(repo, 'Ann', 'ann@corp.example', daysAgo(9), 'Initial import');
    fs.appendFileSync(path.join(repo, 'src/complex.ts'), '\nexport const one = 1;\n');
    commitAs(repo, 'Ann Smith', 'ann@corp.example', daysAgo(2), 'Add one');
    git(repo, ['config', 'user.email', 'ann@corp.example']);
    const data = await analyze({ root: repo, includeSource: false, history: false, changes: false });
    expect(getFile(data, 'src/complex.ts').git!.authors.map((a) => [a.name, a.commits])).toEqual([['Ann Smith', 2]]);
    expect(data.git!.commits.map((c) => c.author)).toEqual(['Ann Smith', 'Ann Smith']);
    expect(data.git!.user).toBe('Ann Smith');
  });
});
