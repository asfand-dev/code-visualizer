/**
 * CI-native outputs of `check` (SARIF, GitLab Code Quality, capped GitHub annotations, the job summary)
 * and `pr --format comment`, on a fixed CheckResult and through the CLI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AnalyzeOptions } from '../src/analyzer/index.js';
import { runCli } from '../src/cli/run.js';
import { githubAnnotations, escapeData } from '../src/report/formats/github.js';
import { gitlabIssues, gitlabReport } from '../src/report/formats/gitlab.js';
import { escapeHtml, PR_COMMENT_MARKER, prCommentMarkdown } from '../src/report/formats/pr-comment.js';
import { sarifLog, sarifReport, sarifUri } from '../src/report/formats/sarif.js';
import { checkSummaryMarkdown, SUMMARY_MAX_BYTES, topFindings } from '../src/report/formats/summary.js';
import { fingerprint } from '../src/shared/fingerprint.js';
import type { ChangeSet, CheckResult, Finding, GateResult, ReportData } from '../src/shared/types.js';
import { copyFixture, removeTempDirs, makeTempDir } from './companion-helpers.js';
import { analyzeFixture } from './helpers.js';

/** Count analyses: every `getReport` call reports one 'done'. */
const analyses = vi.hoisted(() => ({ done: 0 }));
vi.mock('../src/cli/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli/engine.js')>();
  return {
    ...actual,
    getReport: (options: AnalyzeOptions) =>
      actual.getReport({
        ...options,
        onProgress: (stage, detail) => {
          if (stage === 'done') analyses.done++;
          options.onProgress?.(stage, detail);
        },
      }),
  };
});

afterAll(removeTempDirs);

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

function makeFinding(gate: string, ruleId: string, file: string, i: number, extra: Partial<Finding> = {}): Finding {
  const subject = `${file}#fn${i}`;
  return { ruleId, gate, file, line: i + 1, message: `Finding ${i} in ${file}`, severity: 'error', subject, fingerprint: fingerprint(ruleId, file, subject), ...extra };
}

/** A fixed result: a failing architecture gate, a passing complexity gate, duplicates, a path with a space. */
function fixedResult(): CheckResult {
  const rules: GateResult = {
    id: 'rules',
    label: 'Architecture rules',
    ok: false,
    detail: '1 new · 1 existing · 0 fixed',
    counts: { new: 1, existing: 1, fixed: 0 },
    findings: [
      makeFinding('rules', 'cv/architecture-rule', 'src/ui/Button.tsx', 3, { status: 'new', onChangedLine: true }),
      makeFinding('rules', 'cv/layer-violation', 'src/lib/my file.ts', 0, { status: 'existing', line: 0 }),
    ],
  };
  const dupe = makeFinding('cycles', 'cv/cycle', 'src/a.ts', 1, { severity: 'warning', status: 'existing', subject: 'src/a.ts → src/b.ts', line: undefined });
  const cycles: GateResult = { id: 'cycles', label: 'Circular dependencies', ok: true, detail: '0 new · 2 existing · 1 fixed', counts: { new: 0, existing: 2, fixed: 1 }, findings: [dupe, { ...dupe }] };
  const health: GateResult = { id: 'health', label: 'Health score', ok: false, detail: '61/100 (min 70, −2 by this change)', findings: [] };
  return {
    ok: false,
    mode: 'changed',
    base: 'origin/main',
    health: 61,
    healthDelta: -2,
    gates: [rules, cycles, health],
    fixed: [{ ...makeFinding('cycles', 'cv/cycle', 'src/old.ts', 9), status: 'fixed', message: 'Circular dependency: src/old.ts → src/x.ts' }],
  };
}

describe('SARIF 2.1.0', () => {
  it('has the required strings, correct rule indexes, relative uris and lines ≥ 1, byte for byte the same every run', () => {
    const result = fixedResult();
    const text = sarifReport(result, { version: '9.9.9', prefix: 'packages/app/' });
    expect(sarifReport(fixedResult(), { version: '9.9.9', prefix: 'packages/app/' })).toBe(text);
    const log = JSON.parse(text) as ReturnType<typeof sarifLog>;
    expect(log.version).toBe('2.1.0');
    const run = log.runs[0];
    expect(run.tool.driver).toMatchObject({ name: 'code-visualizer', version: '9.9.9' });
    expect(run.automationDetails.id).toBe('code-visualizer/');
    for (const rule of run.tool.driver.rules) {
      for (const value of [rule.id, rule.name, rule.shortDescription.text, rule.fullDescription.text, rule.help.text, rule.help.markdown]) expect(value.trim()).not.toBe('');
      expect(['error', 'warning', 'note']).toContain(rule.defaultConfiguration.level);
      expect(rule.properties.tags).toContain('maintainability');
    }
    expect(run.tool.driver.rules.find((r) => r.id === 'cv/cycle')!.properties.tags).toEqual(['maintainability', 'architecture']);
    expect(run.results).toHaveLength(4);
    for (const r of run.results) {
      expect(run.tool.driver.rules[r.ruleIndex].id).toBe(r.ruleId);
      expect(r.message.text.trim()).not.toBe('');
      const loc = r.locations[0].physicalLocation;
      expect(loc.artifactLocation.uriBaseId).toBe('%SRCROOT%');
      expect(loc.artifactLocation.uri).toMatch(/^packages\/app\/src\//);
      expect(loc.artifactLocation.uri).not.toMatch(/^(\/|\.\/|[a-z]+:)/);
      expect(loc.region.startLine).toBeGreaterThanOrEqual(1);
      expect(r.partialFingerprints['codeVisualizer/v1']).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(run.results[1].locations[0].physicalLocation.artifactLocation.uri).toBe('packages/app/src/lib/my%20file.ts');
    expect(run.results.map((r) => r.baselineState)).toEqual(['new', 'unchanged', 'unchanged', 'unchanged']);
    expect(run.results[2].relatedLocations).toEqual([expect.objectContaining({ id: 1, physicalLocation: expect.objectContaining({ artifactLocation: { uri: 'packages/app/src/b.ts', uriBaseId: '%SRCROOT%' } }) })]);
    expect(sarifUri('a b/c#d.ts')).toBe('a%20b/c%23d.ts');
  });

  it('marks an old finding your change made worse as updated, not new', () => {
    const result = fixedResult();
    result.gates[0].findings[0].worsened = true;
    expect(sarifLog(result, { version: '1.0.0' }).runs[0].results.map((r) => r.baselineState)).toEqual(['updated', 'unchanged', 'unchanged', 'unchanged']);
  });
});

describe('GitLab Code Quality', () => {
  it('has unique fingerprints, valid severities, plain repository paths and no BOM', () => {
    const issues = gitlabIssues(fixedResult(), { prefix: 'packages/app/' });
    expect(issues).toHaveLength(4);
    expect(new Set(issues.map((i) => i.fingerprint)).size).toBe(issues.length);
    expect(issues[2].fingerprint.endsWith('-0')).toBe(true);
    expect(issues[3].fingerprint.endsWith('-1')).toBe(true);
    for (const i of issues) {
      expect(['info', 'minor', 'major', 'critical', 'blocker']).toContain(i.severity);
      expect(i.location.path).toMatch(/^packages\/app\/src\//);
      expect(i.location.lines.begin).toBeGreaterThanOrEqual(1);
      expect(i.description && i.check_name).toBeTruthy();
    }
    expect(issues.map((i) => i.severity)).toEqual(['critical', 'critical', 'minor', 'minor']);
    const text = gitlabReport(fixedResult());
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).not.toContain('"./');
  });
});

describe('GitHub annotations', () => {
  it('show at most 10 per level, best first, then one notice for the rest', () => {
    const errors = Array.from({ length: 25 }, (_, i) => makeFinding('rules', 'cv/architecture-rule', `src/e${String(i).padStart(2, '0')}.ts`, i, { onChangedLine: i >= 20 }));
    const warnings = Array.from({ length: 25 }, (_, i) => makeFinding('rules', 'cv/architecture-rule', `src/w${String(i).padStart(2, '0')}.ts`, i, { severity: 'warning' }));
    const result: CheckResult = { ok: false, mode: 'all', health: 70, gates: [{ id: 'rules', label: 'Architecture rules', ok: false, detail: '25 errors, 25 warnings', findings: [...errors, ...warnings] }], fixed: [] };
    const lines = githubAnnotations(result).trim().split('\n');
    expect(lines.filter((l) => l.startsWith('::error '))).toHaveLength(10);
    expect(lines.filter((l) => l.startsWith('::warning '))).toHaveLength(10);
    expect(lines.filter((l) => l.startsWith('::notice'))).toEqual(['::notice::+30 more — see job summary or SARIF']);
    // Findings on changed lines come first.
    expect(lines[0]).toContain('file=src/e20.ts');
    expect(lines[lines.length - 1]).toBe('code-visualizer check: 1 gate(s) failed — health 70/100');
  });

  it('rank equally important findings by how bad they are (complexity, cycle size) before the path', () => {
    const complexity = [3, 77, 19, 368, 20].map((cx, i) => makeFinding('complexity', 'cv/complexity', `src/f${i}.ts`, i, { message: `fn has cyclomatic complexity ${cx} (max 15)`, weight: cx }));
    const result: CheckResult = { ok: false, mode: 'all', health: 70, gates: [{ id: 'complexity', label: 'Function complexity', ok: false, detail: '5 functions above 15', findings: complexity }], fixed: [] };
    const order = githubAnnotations(result, { max: 3 }).split('\n').filter((l) => l.startsWith('::error')).map((l) => Number(l.match(/complexity (\d+)/)![1]));
    expect(order).toEqual([368, 77, 20]);
    expect(topFindings(result).map((f) => f.weight)).toEqual([368, 77, 20, 19, 3]);
  });

  it('say "nothing to check" when no gate ran', () => {
    const nothing: CheckResult = { ok: true, mode: 'staged', health: 80, gates: [], fixed: [], notes: ['Unknown key check.x in the configuration is ignored.', 'No changes — nothing to check'] };
    expect(githubAnnotations(nothing)).toBe('code-visualizer check: No changes — nothing to check — health 80/100\n');
  });

  it('annotate only new findings when comparing, plus failing gates that have none', () => {
    const lines = githubAnnotations(fixedResult(), { prefix: 'packages/app/' }).trim().split('\n');
    expect(lines).toEqual([
      '::error title=code-visualizer%3A Health score::Health score: 61/100 (min 70, −2 by this change)',
      '::error file=packages/app/src/ui/Button.tsx,line=4,title=code-visualizer%3A Architecture rules::Finding 3 in src/ui/Button.tsx',
      'code-visualizer check: 2 gate(s) failed — health 61/100',
    ]);
    expect(escapeData('50%\r\nnext')).toBe('50%25%0D%0Anext');
  });
});

describe('job summary', () => {
  it('has the gate table, counts, health change and linked new findings within 900 KB', async () => {
    const data = await analyzeFixture('react-vite-ts');
    const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_SHA: 'abc123' };
    const md = checkSummaryMarkdown(fixedResult(), data, { prefix: 'packages/app/', env, version: '1.0.0', command: 'code-visualizer check --changed' });
    expect(md).toContain('## ❌ code-visualizer check: 2 gates failed');
    expect(md).toContain('Health **61/100**');
    expect(md).toContain('−2 vs base');
    expect(md).toContain('| Gate | Result | New | Existing | Fixed | Details |');
    expect(md).toContain('| Architecture rules | ❌ failed | 1 | 1 | 0 |  |');
    expect(md).toContain('| Health score | ❌ failed |  |  |  | 61/100 (min 70, −2 by this change) |');
    expect(md).toContain('### New findings (1)');
    expect(md).toContain('[`src/ui/Button.tsx:4`](https://github.com/acme/app/blob/abc123/packages/app/src/ui/Button.tsx#L4)');
    expect(md).toContain('✅ 1 finding fixed: Circular dependency: src/old.ts → src/x.ts');
    expect(new TextEncoder().encode(md).length).toBeLessThan(SUMMARY_MAX_BYTES);
    // Without the GitHub environment there are no links.
    expect(checkSummaryMarkdown(fixedResult(), data)).toContain('- ❌ `src/ui/Button.tsx:4` Finding 3');
  });

  it('is appended to $GITHUB_STEP_SUMMARY by check (not with --no-summary)', async () => {
    const copy = copyFixture('fullstack-next', 'cv-formats-');
    const file = path.join(makeTempDir('cv-summary-'), 'summary.md');
    fs.writeFileSync(file, '# earlier step\n');
    const saved = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = file;
    try {
      expect((await cli('check', copy, '--no-git', '-q')).code).toBe(1);
      const text = fs.readFileSync(file, 'utf8');
      expect(text.startsWith('# earlier step\n## ❌ code-visualizer check: 1 gate failed')).toBe(true);
      expect(text).toContain('| Architecture rules | ❌ failed | 2 errors, 0 warnings |');
      expect(text).toContain('### Findings (2)');
      await cli('check', copy, '--no-git', '-q', '--no-summary');
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    } finally {
      process.env.GITHUB_STEP_SUMMARY = saved;
    }
  });
});

describe('check: several outputs from one analysis', () => {
  it('writes SARIF, GitLab and JSON files next to the text output', async () => {
    const copy = copyFixture('fullstack-next', 'cv-formats-');
    const out = makeTempDir('cv-out-');
    const before = analyses.done;
    const res = await cli('check', copy, '--no-git', '--sarif', path.join(out, 'a.sarif'), '--gitlab', path.join(out, 'b.json'), '--json', path.join(out, 'c.json'));
    expect(analyses.done - before).toBe(1);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('✖ Architecture rules');
    const sarif = JSON.parse(fs.readFileSync(path.join(out, 'a.sarif'), 'utf8')) as ReturnType<typeof sarifLog>;
    expect(sarif.runs[0].results.map((r) => r.ruleId).sort()).toEqual(['cv/architecture-rule', 'cv/layer-violation']);
    expect((JSON.parse(fs.readFileSync(path.join(out, 'b.json'), 'utf8')) as unknown[]).length).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'c.json'), 'utf8'))).toMatchObject({ ok: false, mode: 'all' });

    const stdoutFormats = await cli('check', copy, '--no-git', '--format', 'sarif');
    expect((JSON.parse(stdoutFormats.stdout) as { version: string }).version).toBe('2.1.0');
    expect(JSON.parse((await cli('check', copy, '--no-git', '--format', 'gitlab')).stdout)).toHaveLength(2);
    expect((await cli('check', copy, '--no-git', '--format', 'markdown')).stdout).toContain('## ❌ code-visualizer check');
    expect(JSON.parse((await cli('check', copy, '--no-git', '--json')).stdout)).toMatchObject({ ok: false });
  });
});

describe('pr --format comment', () => {
  /** A synthetic change of `n` files on top of a real analysis. */
  async function bigChange(n: number): Promise<ReportData> {
    const data = structuredClone(await analyzeFixture('react-vite-ts'));
    const files = Array.from({ length: n }, (_, i) => ({ id: `src/generated/area-${i % 50}/module-${i}.ts`, status: 'modified' as const, additions: 12, deletions: 3, lines: [1, 2, 3], analyzed: true }));
    const changes: ChangeSet = {
      mode: 'branch',
      base: 'origin/main',
      baseCommit: 'abc1234567',
      files,
      additions: n * 12,
      deletions: n * 3,
      commits: Array.from({ length: 200 }, (_, i) => ({ hash: `h${i}`, date: 0, author: 'A', subject: `Commit ${i} ${'with a long subject '.repeat(8)}`, files: 3, additions: 1, deletions: 1, paths: [] })),
      symbols: files.slice(0, 3000).map((f, i) => ({ id: `${f.id}#fn${i}`, file: f.id, name: `fn${i}`, kind: 'function', exported: true, usedBy: i })),
      impacted: files.slice(0, 2000).map((f) => `${f.id}.impacted.ts`),
      impactedRoutes: [],
      clusters: [files.slice(0, 40).map((f) => f.id)],
      tests: { files: files.slice(0, 500).map((f) => `${f.id}.test.ts`), command: `npx vitest run ${files.map((f) => f.id).join(' ')}`, changedTests: [] },
      reviewers: [{ name: 'Alice', score: 1, files: 3, last: 0 }],
      owners: [{ owner: '@acme/web', files: files.slice(0, 10).map((f) => f.id) }],
      risk: { score: 90, level: 'high', factors: [{ label: 'touches 5,000 files', points: 50 }] },
    };
    return { ...data, changes };
  }

  it('starts with the marker and stays within 60,000 characters for a 5,000-file change', async () => {
    const data = await bigChange(5000);
    const comment = prCommentMarkdown(data, { check: fixedResult() });
    expect(comment.split('\n')[0]).toBe(PR_COMMENT_MARKER);
    expect(comment.length).toBeLessThanOrEqual(60_000);
    expect(comment).toContain('### Quality gates');
    expect(comment).toContain('<details><summary><b>Files</b></summary>');
    // Folded titles keep their "&" (escaped), not "components  classes".
    expect(comment).toContain('<details><summary><b>Changed functions, components &amp; classes</b></summary>');
    expect(escapeHtml('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
    expect(comment).not.toMatch(/```mermaid[^`]*$/); // no cut-open code fence
  });

  it('folds and shortens sections to fit a smaller budget, keeping the summary and gates open', async () => {
    const data = await bigChange(5000);
    const comment = prCommentMarkdown(data, { check: fixedResult(), maxChars: 4_000, openChars: 1_500 });
    expect(comment.length).toBeLessThanOrEqual(4_000);
    expect(comment.startsWith(`${PR_COMMENT_MARKER}\n## Summary`)).toBe(true);
    expect(comment).toContain('### Quality gates');
    expect(comment).toMatch(/… [\d,]+ more/);
    expect((comment.match(/<details>/g) ?? []).length).toBe((comment.match(/<\/details>/g) ?? []).length);
  });

  it('cuts a huge summary as a last resort without leaving tags or code fences open', async () => {
    const data = await bigChange(10);
    data.changes!.commits = Array.from({ length: 15 }, (_, i) => ({ hash: `h${i}`, date: 0, author: 'A', subject: 'x'.repeat(190), files: 1, additions: 1, deletions: 1, paths: [] }));
    const comment = prCommentMarkdown(data, { maxChars: 1_000 });
    expect(comment.length).toBeLessThanOrEqual(1_000);
    expect(comment.split('\n')[0]).toBe(PR_COMMENT_MARKER);
    expect(comment).toContain('… (shortened)');
    expect((comment.match(/<details>/g) ?? []).length).toBe((comment.match(/<\/details>/g) ?? []).length);
    expect((comment.match(/^\s*```/gm) ?? []).length % 2).toBe(0);
  });

  it('is printed by `pr --format comment` (and rejected formats exit 2)', async () => {
    expect((await cli('pr', '--format', 'html')).code).toBe(2);
    const help = await cli('pr', '--help');
    expect(help.stdout).toContain('gh pr comment --edit-last --create-if-none --body-file');
  });
});
