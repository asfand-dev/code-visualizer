import { beforeAll, describe, expect, it } from 'vitest';
import { buildChangeSet } from '../src/analyzer/changes.js';
import type { RawChanges } from '../src/analyzer/git.js';
import { analyze } from '../src/analyzer/index.js';
import { loadCodeOwners } from '../src/analyzer/owners.js';
import { buildTestMap, detectTestRunners } from '../src/analyzer/tests.js';
import { agentsBlockMarkdown, fileContextMarkdown, prSummaryMarkdown, projectSummaryMarkdown } from '../src/shared/markdown.js';
import type { ReportData } from '../src/shared/types.js';
import { fixtureDir, proseOf } from './companion-helpers.js';
import { analyzeFixture, type FixtureName } from './helpers.js';

let data: ReportData;
beforeAll(async () => {
  data = await analyze({ root: fixtureDir('fullstack-next'), git: false, history: false });
});

/** Markdown must never leak `undefined` / `NaN` into prose (code spans may legitimately contain them). */
function expectClean(markdown: string): void {
  expect(proseOf(markdown)).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/);
}

function headings(markdown: string): string[] {
  return markdown.split('\n').filter((l) => /^#{1,3} /.test(l));
}

/** A branch that changed the users API and the in-memory database (plus files outside the analysis). */
function withChanges(report: ReportData): ReportData {
  const raw: RawChanges = {
    mode: 'branch',
    base: 'main',
    baseCommit: 'abc1234567',
    files: [
      { id: 'lib/db.ts', status: 'modified', additions: 4, deletions: 2, lines: [12, 13, 25], analyzed: true },
      { id: 'app/api/users/route.ts', status: 'modified', additions: 3, deletions: 1, lines: [9, 10], analyzed: true },
      { id: 'README.md', status: 'modified', additions: 1, deletions: 0, lines: [3], analyzed: false },
      { id: 'lib/legacy.ts', status: 'deleted', additions: 0, deletions: 12, lines: [], analyzed: false },
    ],
    commits: [{ hash: 'def4567890', date: Date.UTC(2026, 0, 2), author: 'Bob Builder', subject: 'Validate new users', files: 4, additions: 8, deletions: 15, paths: ['lib/db.ts', 'app/api/users/route.ts'] }],
  };
  const changes = buildChangeSet({
    raw,
    files: report.files,
    edges: report.edges,
    symbolEdges: report.symbolEdges,
    routes: report.routes,
    hotspots: report.insights.hotspots,
    testMap: buildTestMap(report.files, report.edges),
    runners: detectTestRunners([{ devDependencies: { vitest: '^2' } }], undefined),
    owners: loadCodeOwners([fixtureDir('fullstack-next')]),
  });
  return { ...report, changes };
}

describe('prSummaryMarkdown', () => {
  it('says so when there are no changes', () => {
    expect(prSummaryMarkdown({ ...data, changes: undefined })).toBe('_No changes detected._');
  });

  it('describes files, symbols, impact, tests and review notes', () => {
    const md = prSummaryMarkdown(withChanges(data));
    expectClean(md);
    expect(headings(md)).toEqual(['## Summary', '### Files', '### Changed functions, components & classes', '### Impact', '### Tests', '### Review notes']);
    expect(md).toContain('This change touches **4 files** (+8 / −15)');
    expect(md).toContain('Commits (1):\n- Validate new users');
    expect(md).toContain('| `lib/db.ts` | modified | +4 −2 |');
    expect(md).toContain('| `lib/legacy.ts` | deleted | +0 −12 |');
    expect(md).toMatch(/- `listUsers` in `lib\/db\.ts` — used by \d+ places?/);
    expect(md).toContain('- `POST` in `app/api/users/route.ts`');
    expect(md).toMatch(/\*\*\d+ other files?\*\* depend/);
    expect(md).toContain('`GET /api/users`');
    expect(md).toContain('`DELETE /api/users/[id]`');
    expect(md).toContain('- 1 related test file: `users.test.ts`');
    expect(md).toContain('- Run them: `npx vitest run test/users.test.ts`');
    expect(md).toMatch(/- Risk: \*\*(low|medium|high)\*\* \(\d+\/100\)/);
    expect(md).toContain('- Code owners: @acme/backend, @acme/platform');
    expect(md).toContain('```mermaid\nflowchart LR');
    expect(md).toMatch(/f\d+ --> f\d+/);
    expect(md.trimEnd().endsWith('</sub>')).toBe(true);
  });

  it('lists each affected route only once', () => {
    const md = prSummaryMarkdown(withChanges(data));
    const line = md.split('\n').find((l) => l.startsWith('- Routes affected'))!;
    const labels = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('fileContextMarkdown', () => {
  it('explains a client component: declarations, dependencies, HTTP calls and owners', () => {
    const md = fileContextMarkdown(data, 'components/UserTable.tsx');
    expectClean(md);
    expect(md.startsWith('# Context: components/UserTable.tsx\n')).toBe(true);
    expect(md).toContain('Project **fullstack-next** (Next.js, React, TypeScript).');
    expect(md).toContain('- Kind: component');
    expect(md).toContain('- Owners: @acme/web');
    expect(headings(md)).toEqual(['# Context: components/UserTable.tsx', '## Declarations', '## Depends on', '## Used by', '## HTTP calls']);
    expect(md).toContain('- `lib/format.ts` → formatUserName');
    expect(md).toContain('- `app/page.tsx` (uses default)');
    expect(md).toContain('- `GET /api/users` → served by `app/api/users/route.ts`');
    expect(md).toContain('- `DELETE /api/users/:param` → served by `app/api/users/[id]/route.ts`');
    expect(md).toMatch(/^- `POST \/api\/reports\/export`$/m); // no route, not external
  });

  it('lists routes and tests of a route handler and external calls of a client', () => {
    const route = fileContextMarkdown(data, 'app/api/users/route.ts');
    expect(route).toContain('## Routes\n\n- `GET /api/users` → GET\n- `POST /api/users` → POST');
    expect(route).toContain('## Tests\n\n- `test/users.test.ts`');
    expect(fileContextMarkdown(data, 'lib/billing.ts')).toContain('- `POST https://api.stripe.com/v1/charges` (external: api.stripe.com)');
  });

  it('marks deprecated declarations', () => {
    const md = fileContextMarkdown(data, 'lib/format.ts');
    expect(md).toMatch(/- \*\*export\*\* `formatUserName\(user: Pick<User, 'name'>\): string` — .*\(deprecated\)/);
  });

  it('embeds the source on request', () => {
    const md = fileContextMarkdown(data, 'lib/api.ts', { source: true });
    expect(md).toContain("## Source\n\n```ts\nimport axios from 'axios';");
    expect(md.trimEnd().endsWith('```')).toBe(true);
    expect(fileContextMarkdown(data, 'lib/api.ts')).not.toContain('## Source');
  });

  it('handles files that are not part of the analysis', () => {
    expect(fileContextMarkdown(data, 'nope.ts')).toBe('File `nope.ts` is not part of this analysis.');
  });
});

describe('projectSummaryMarkdown', () => {
  it('summarizes stack, commands, entry points, structure, core modules, routes and layers', () => {
    const md = projectSummaryMarkdown(data);
    expectClean(md);
    expect(md.startsWith('# fullstack-next — architecture overview\n')).toBe(true);
    expect(md).toContain('- Stack: Next.js, React, TypeScript');
    expect(md).toMatch(/- Size: 16 files, [\d,]+ lines, 5 components, 7 routes/);
    expect(md).toContain(`- Health: ${data.health.score}/100 (${data.health.grade})`);
    expect(headings(md)).toEqual([
      '# fullstack-next — architecture overview',
      '## Commands',
      '## Entry points',
      '## Structure',
      '## Core modules',
      '## Routes',
      '## Architecture rules',
    ]);
    expect(md).toContain('- `npm run dev` — `next dev`');
    expect(md).toContain('- `npm test` — `vitest run`');
    expect(md).toContain('- `app/layout.tsx` (root layout)');
    expect(md).toContain('- `lib/db.ts` — used by 3 files');
    expect(md).toContain('- `GET /api/users/[id]` → `app/api/users/[id]/route.ts`');
    expect(md).toContain('1. `app/**`\n2. `components/**`\n3. `lib/**`\n\nLower layers must not import higher ones.');
  });
});

describe('markdown generators on every fixture', () => {
  const fixtures: FixtureName[] = ['react-vite-ts', 'next-app', 'express-api', 'vue-app', 'nest-api', 'sveltekit-app'];

  it.each(fixtures)('%s: project summary and every file context are free of undefined/NaN', async (name) => {
    const report = await analyzeFixture(name);
    expectClean(projectSummaryMarkdown(report));
    for (const f of report.files) {
      const md = fileContextMarkdown(report, f.id);
      expect(md.startsWith(`# Context: ${f.id}`), f.id).toBe(true);
      expect(proseOf(md), f.id).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/);
    }
  });

  it('fullstack-next: every file context is free of undefined/NaN', () => {
    for (const f of data.files) expect(proseOf(fileContextMarkdown(data, f.id, { source: true })), f.id).not.toMatch(/\bundefined\b|\bNaN\b/);
  });
});

describe('AGENTS.md block: code owners (release fix)', () => {
  it('lists the files whose owners differ inside shared folders, and says "most files", not "everything else"', () => {
    // fullstack-next's CODEOWNERS: `*` @acme/platform, /app/ @acme/web, /app/api/ and /lib/ @acme/backend,
    // /lib/billing.ts @acme/payments billing-lead@acme.dev, *.test.ts @acme/qa.
    const block = agentsBlockMarkdown(data, {});
    const owners = block.slice(block.indexOf('### Code owners'), block.indexOf('### Tools'));
    expect(owners).toContain('- `lib/billing.ts` → @acme/payments, billing-lead@acme.dev');
    expect(owners).toContain('- `components/` → @acme/web');
    expect(owners).toContain('- `test/` → @acme/qa');
    // The analysis knows each file's owners, not the rules: the most common owners are not called the `*` rule.
    expect(owners).toMatch(/^- most files → @acme\/backend$/m);
    expect(owners).not.toContain('everything else');
    // Not every file of a mixed folder: lib/ is backend apart from billing.ts.
    expect(owners).not.toContain('`lib/db.ts`');
  });

  it('caps the single files at a few lines', () => {
    const many = { ...data, files: data.files.map((f, i) => ({ ...f, owners: i % 2 ? ['@a'] : [`@team${i}`] })) };
    const block = agentsBlockMarkdown(many, {});
    const owners = block.slice(block.indexOf('### Code owners'), block.indexOf('### Tools')).split('\n').filter((l) => l.startsWith('- `'));
    expect(owners.length).toBeLessThanOrEqual(15);
    expect(block).toMatch(/- … \d+ more files with other owners/);
  });
});
