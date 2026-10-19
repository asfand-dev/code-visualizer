import { describe, expect, it } from 'vitest';
import { cronIntervalMinutes, describeCron, nextCronRun } from '../src/shared/cron.js';
import { scriptClosure, scriptsInvoked } from '../src/shared/package-scripts.js';
import { findNeedsCycle, forecastRun, forecastRuns, jobLevels, matchesFilters, matchesGlob, workflowMermaid } from '../src/shared/workflow-forecast.js';
import { parseWorkflow } from '../src/shared/workflows.js';

describe('describeCron', () => {
  it.each([
    ['0 3 * * 1', 'Every Monday at 03:00 UTC'],
    ['30 5 * * *', 'Every day at 05:30 UTC'],
    ['0 9 * * 1-5', 'Weekdays at 09:00 UTC'],
    ['15 22 * * 0,6', 'Weekends at 22:15 UTC'],
    ['0 6 * * 1,3,5', 'Monday, Wednesday, Friday at 06:00 UTC'],
    ['0 0 1 * *', 'Day 1 of every month at 00:00 UTC'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'Every hour'],
    ['20 * * * *', 'Every hour at minute 20'],
    ['* * * * *', 'Every minute'],
    ['0 3 * * 7', 'Every Sunday at 03:00 UTC'],
  ])('%s → %s', (expression, expected) => {
    expect(describeCron(expression)).toBe(expected);
  });

  it('returns what it does not understand as written', () => {
    expect(describeCron('0 3 * 6 *')).toBe('0 3 * 6 *');
    expect(describeCron('@daily')).toBe('@daily');
    expect(describeCron('0 3 * *')).toBe('0 3 * *');
  });
});

describe('nextCronRun', () => {
  const at = (iso: string): number => Date.parse(iso);

  it('finds the next time a daily job fires, today or tomorrow', () => {
    expect(nextCronRun('30 5 * * *', at('2026-10-19T04:00:00Z'))).toBe(at('2026-10-19T05:30:00Z'));
    expect(nextCronRun('30 5 * * *', at('2026-10-19T06:00:00Z'))).toBe(at('2026-10-20T05:30:00Z'));
  });

  it('does not return the current minute', () => {
    expect(nextCronRun('30 5 * * *', at('2026-10-19T05:30:00Z'))).toBe(at('2026-10-20T05:30:00Z'));
    expect(nextCronRun('*/10 * * * *', at('2026-10-19T05:30:20Z'))).toBe(at('2026-10-19T05:40:00Z'));
  });

  it('finds a weekday', () => {
    // 2026-10-19 is a Monday.
    expect(nextCronRun('0 3 * * 3', at('2026-10-19T10:00:00Z'))).toBe(at('2026-10-21T03:00:00Z'));
    expect(nextCronRun('0 9 * * 1-5', at('2026-10-23T10:00:00Z'))).toBe(at('2026-10-26T09:00:00Z'));
  });

  it('runs on the day of the month or the weekday when both are set, like cron', () => {
    expect(nextCronRun('0 0 20 * 1', at('2026-10-19T10:00:00Z'))).toBe(at('2026-10-20T00:00:00Z'));
  });

  it('finds a job that fires once a year, and gives up on one that never does', () => {
    expect(nextCronRun('0 0 1 1 *', at('2026-10-19T00:00:00Z'))).toBe(at('2027-01-01T00:00:00Z'));
    expect(nextCronRun('0 0 31 2 *', at('2026-10-19T00:00:00Z'))).toBeUndefined();
  });

  it('rejects invalid expressions', () => {
    expect(nextCronRun('61 * * * *', 0)).toBeUndefined();
    expect(nextCronRun('* * * *', 0)).toBeUndefined();
    expect(nextCronRun('a b c d e', 0)).toBeUndefined();
    expect(nextCronRun('*/0 * * * *', 0)).toBeUndefined();
  });
});

describe('cronIntervalMinutes', () => {
  it('is the shortest gap between two runs', () => {
    expect(cronIntervalMinutes('*/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('0 * * * *')).toBe(60);
    expect(cronIntervalMinutes('0 3 * * *')).toBe(1440);
    expect(cronIntervalMinutes('0,10 * * * *')).toBe(10);
    expect(cronIntervalMinutes('*/5 9-17 * * 1-5')).toBe(5);
    expect(cronIntervalMinutes('nonsense')).toBeUndefined();
  });
});

describe('scriptsInvoked', () => {
  it.each([
    ['npm run build', ['build']],
    ['npm run-script test:unit -- --coverage', ['test:unit']],
    ['npm test', ['test']],
    ['npm t', ['test']],
    ['npm ci && npm run lint && npm test', ['lint', 'test']],
    ['pnpm test', ['test']],
    ['pnpm -r run build', ['build']],
    ['pnpm --filter web build', ['build']],
    ['yarn lint', ['lint']],
    ['yarn run typecheck', ['typecheck']],
    ['bun run dev', ['dev']],
    ['CI=1 npm run test', ['test']],
    ['npm run build --if-present', ['build']],
    ['npm --prefix web run build', ['build']],
    ['npm run lint | tee out.txt', ['lint']],
  ])('%s', (command, expected) => {
    expect(scriptsInvoked(command)).toEqual(expected);
  });

  it('ignores package manager commands that are not scripts', () => {
    expect(scriptsInvoked('npm ci')).toEqual([]);
    expect(scriptsInvoked('npm install --global pnpm')).toEqual([]);
    expect(scriptsInvoked('pnpm install --frozen-lockfile')).toEqual([]);
    expect(scriptsInvoked('pnpm exec vitest')).toEqual([]);
    expect(scriptsInvoked('yarn')).toEqual([]);
    expect(scriptsInvoked('yarn workspace web build')).toEqual([]);
    expect(scriptsInvoked('bun test')).toEqual([]);
    expect(scriptsInvoked('npx vitest')).toEqual([]);
  });

  it('ignores names that come from variables and expressions, and other tools', () => {
    expect(scriptsInvoked('npm run ${{ matrix.script }}')).toEqual([]);
    expect(scriptsInvoked('npm run $SCRIPT')).toEqual([]);
    expect(scriptsInvoked('echo "npm run build"')).toEqual([]);
    expect(scriptsInvoked('make test')).toEqual([]);
  });
});

describe('scriptClosure', () => {
  it('follows scripts that start other scripts, and survives cycles', () => {
    const scripts = { check: 'npm run lint && npm test', lint: 'eslint . && npm run format', format: 'prettier', test: 'vitest', loop: 'npm run loop' };
    expect([...scriptClosure(['check'], scripts)].sort()).toEqual(['check', 'format', 'lint', 'test']);
    expect([...scriptClosure(['loop'], scripts)]).toEqual(['loop']);
    expect([...scriptClosure(['unknown'], scripts)]).toEqual(['unknown']);
  });
});

describe('matchesGlob', () => {
  it.each([
    ['main', 'main', true],
    ['main', 'main2', false],
    ['feature/*', 'feature/login', true],
    ['feature/*', 'feature/login/ui', false],
    ['feature/**', 'feature/login/ui', true],
    ['**', 'anything/at/all', true],
    ['*', 'a/b', false],
    ['releases/v[12]', 'releases/v1', true],
    ['releases/v[12]', 'releases/v3', false],
    ['v[0-9]+.[0-9]+.[0-9]+', 'v1.22.3', true],
    ['**.md', 'docs/guide/intro.md', true],
    ['**.md', 'README.md', true],
    ['**/*.ts', 'src/a/b.ts', true],
    ['**/*.ts', 'b.ts', true],
    ['src/**', 'src/a/b.ts', true],
    ['src/**', 'other/src/a.ts', false],
    ['colo?r', 'color', true],
    ['colo?r', 'colr', true],
    ['a.b', 'axb', false],
    ['(x)', '(x)', true],
  ])('%s vs %s → %s', (pattern, text, expected) => {
    expect(matchesGlob(pattern, text)).toBe(expected);
  });

  it('matches nothing for a pattern that is not a valid expression', () => {
    expect(matchesGlob('a[', 'a[')).toBe(true); // an unclosed bracket is literal
    expect(matchesGlob('x+++', 'x')).toBe(false);
  });
});

describe('matchesFilters', () => {
  it('applies patterns in order, a ! pattern removing earlier matches', () => {
    expect(matchesFilters(['src/**', '!src/legacy/**'], 'src/app.ts')).toBe(true);
    expect(matchesFilters(['src/**', '!src/legacy/**'], 'src/legacy/old.ts')).toBe(false);
    expect(matchesFilters(['src/**', '!src/legacy/**', 'src/legacy/keep.ts'], 'src/legacy/keep.ts')).toBe(true);
    expect(matchesFilters(['!src/**'], 'src/app.ts')).toBe(false);
    expect(matchesFilters([], 'x')).toBe(false);
  });
});

describe('forecastRun', () => {
  const workflow = parseWorkflow(
    '.github/workflows/ci.yml',
    `name: CI
on:
  push:
    branches: [main, 'release/**']
    paths-ignore: ['**.md']
  pull_request:
    branches: [main]
    paths: ['src/**', '!src/legacy/**']
jobs: {}
`,
  ).workflow;

  it('runs for a push to a matching branch', () => {
    expect(forecastRun(workflow, { name: 'push', branch: 'release/1.2', files: ['src/a.ts'] })).toMatchObject({ runs: true });
  });

  it('skips a push to another branch', () => {
    const forecast = forecastRun(workflow, { name: 'push', branch: 'feature/x', files: ['src/a.ts'] });
    expect(forecast.runs).toBe(false);
    expect(forecast.reason).toContain('not in `branches`');
  });

  it('skips a push that changes only ignored paths', () => {
    const forecast = forecastRun(workflow, { name: 'push', branch: 'main', files: ['README.md', 'docs/a.md'] });
    expect(forecast).toMatchObject({ runs: false, reason: 'every changed file is in `paths-ignore`' });
    expect(forecastRun(workflow, { name: 'push', branch: 'main', files: ['README.md', 'src/a.ts'] }).runs).toBe(true);
  });

  it('uses the target branch for pull requests and applies path filters in order', () => {
    expect(forecastRun(workflow, { name: 'pull_request', branch: 'main', files: ['src/app.ts'] }).runs).toBe(true);
    expect(forecastRun(workflow, { name: 'pull_request', branch: 'develop', files: ['src/app.ts'] }).runs).toBe(false);
    expect(forecastRun(workflow, { name: 'pull_request', branch: 'main', files: ['src/legacy/old.ts'] }).reason).toContain('no changed file matches `paths`');
  });

  it('assumes it runs when the changed files are not known', () => {
    expect(forecastRun(workflow, { name: 'pull_request', branch: 'main', files: [] }).runs).toBe(true);
  });

  it('does not run for an event it is not triggered by', () => {
    const scheduled = parseWorkflow('w.yml', 'on:\n  schedule:\n    - cron: "0 0 * * *"\njobs: {}\n').workflow;
    expect(forecastRun(scheduled, { name: 'push', branch: 'main', files: [] }).reason).toContain('not triggered by `push`');
  });

  it('treats `tags` without `branches` as tags only', () => {
    const tagged = parseWorkflow('w.yml', 'on:\n  push:\n    tags: ["v*"]\njobs: {}\n').workflow;
    expect(forecastRun(tagged, { name: 'push', branch: 'main', files: [] }).runs).toBe(false);
  });

  it('honours branches-ignore and forecasts every workflow', () => {
    const ignoring = parseWorkflow('w.yml', 'on:\n  push:\n    branches-ignore: [wip/**]\njobs: {}\n').workflow;
    expect(forecastRun(ignoring, { name: 'push', branch: 'wip/x', files: [] }).runs).toBe(false);
    expect(forecastRun(ignoring, { name: 'push', branch: 'main', files: [] }).runs).toBe(true);
    expect(forecastRuns([workflow, ignoring], { name: 'push', branch: 'main', files: [] }).map((f) => f.runs)).toEqual([true, true]);
  });
});

describe('job graph', () => {
  const jobs = [
    { id: 'build', needs: [] },
    { id: 'lint', needs: [] },
    { id: 'test', needs: ['build'] },
    { id: 'e2e', needs: ['test', 'lint'] },
    { id: 'deploy', needs: ['e2e', 'ghost'] },
  ];

  it('puts each job after the jobs it needs', () => {
    expect(jobLevels(jobs)).toEqual([['build', 'lint'], ['test'], ['e2e'], ['deploy']]);
  });

  it('does not loop on circular or self needs', () => {
    expect(jobLevels([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['a'] }, { id: 'c', needs: ['c'] }]).flat().sort()).toEqual(['a', 'b', 'c']);
  });

  it('finds a cycle and reports none for a tree', () => {
    expect(findNeedsCycle(jobs)).toBeUndefined();
    expect(findNeedsCycle([{ id: 'a', needs: ['b'] }, { id: 'b', needs: ['c'] }, { id: 'c', needs: ['a'] }])).toEqual(['a', 'b', 'c', 'a']);
    expect(findNeedsCycle([{ id: 'a', needs: ['a'] }])).toEqual(['a', 'a']);
  });

  it('exports a Mermaid flowchart with matrix sizes and without unknown jobs', () => {
    const workflow = parseWorkflow(
      'w.yml',
      'name: W\non: push\njobs:\n  build:\n    name: Build "it"\n    runs-on: x\n    steps: [{run: a}]\n  test:\n    needs: [build, ghost]\n    runs-on: x\n    strategy:\n      matrix:\n        n: [1, 2, 3]\n    steps: [{run: a}]\n',
    ).workflow;
    expect(workflowMermaid(workflow)).toBe(['flowchart LR', '  j0["Build \'it\'"]', '  j1["test ×3"]', '  j0 --> j1'].join('\n'));
  });
});
