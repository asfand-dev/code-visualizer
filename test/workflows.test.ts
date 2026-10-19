import { describe, expect, it } from 'vitest';
import { buildCiReport, isNodeEndOfLife, nodeMajor, oldestEngineMajor, parseActionManifest, parseDependabot, parseUses, parseWorkflow, pinOf, WORKFLOW_RULES, type CiInput } from '../src/shared/workflows.js';
import type { WorkflowFinding } from '../src/shared/types.js';

const NOW = Date.parse('2026-10-19T00:00:00Z');
// Not a real credential: the shape of a GitHub token, so the secret scanner recognises it.
const FAKE_TOKEN = `ghp_${'Xk3pQ9sLm2Vb7TnR4wYd8FhJc5ZaE1uGo6Ni'}`;

const rules = (findings: WorkflowFinding[]): string[] => findings.map((f) => f.rule);
const lint = (source: string): WorkflowFinding[] => parseWorkflow('.github/workflows/w.yml', source).findings;

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
  test:
    needs: [lint]
    runs-on: \${{ matrix.os }}
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [20, 22]
        include:
          - os: macos-latest
            node: 24
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - name: Test
        run: npm test
        env:
          API_KEY: \${{ secrets.API_KEY }}
          URL: \${{ vars.BASE_URL }}
`;

describe('parseWorkflow', () => {
  const { workflow, findings } = parseWorkflow('.github/workflows/ci.yml', CI);

  it('reads triggers with their filters', () => {
    expect(workflow.name).toBe('CI');
    expect(workflow.triggers).toEqual([{ event: 'push', branches: ['main'] }, { event: 'pull_request' }]);
  });

  it('reads jobs, dependencies, matrices and the lines of jobs and steps', () => {
    expect(workflow.jobs.map((j) => j.id)).toEqual(['lint', 'test']);
    const test = workflow.jobs[1];
    expect(test.needs).toEqual(['lint']);
    expect(test.runsOn).toEqual(['${{ matrix.os }}']);
    expect(test.matrix).toMatchObject({ combos: 5, includes: 1, excludes: 0, failFast: false });
    expect(test.matrix?.dims).toEqual([
      { name: 'os', values: ['ubuntu-latest', 'windows-latest'] },
      { name: 'node', values: ['20', '22'] },
    ]);
    expect(test.steps[2]).toMatchObject({ name: 'Test', run: 'npm test', line: 36 });
    expect(workflow.jobs[0].line).toBe(12);
  });

  it('collects the secrets and variables it reads, and the Node versions through the matrix', () => {
    expect(workflow.secrets).toEqual(['API_KEY']);
    expect(workflow.variables).toEqual(['BASE_URL']);
    expect(workflow.nodeVersions).toEqual(['20', '22', '24']);
  });

  it('finds nothing wrong with a careful workflow', () => {
    expect(findings).toEqual([]);
  });

  it('reads `on` as a string and as a list', () => {
    expect(parseWorkflow('w.yml', 'on: push\njobs: {}').workflow.triggers).toEqual([{ event: 'push' }]);
    expect(parseWorkflow('w.yml', 'on: [push, pull_request]\njobs: {}').workflow.triggers.map((t) => t.event)).toEqual(['push', 'pull_request']);
  });

  it('reads schedules, dispatch inputs and followed workflows', () => {
    const on = `on:
  schedule:
    - cron: '0 3 * * 1'
    - cron: '30 5 * * *'
  workflow_dispatch:
    inputs:
      dry-run:
        type: boolean
  workflow_run:
    workflows: [CI]
    types: [completed]
jobs: {}
`;
    expect(parseWorkflow('w.yml', on).workflow.triggers).toEqual([
      { event: 'schedule', cron: ['0 3 * * 1', '30 5 * * *'] },
      { event: 'workflow_dispatch', inputs: ['dry-run'] },
      { event: 'workflow_run', workflows: ['CI'], types: ['completed'] },
    ]);
  });

  it('describes permissions', () => {
    const source = 'on: push\npermissions:\n  contents: read\n  id-token: write\njobs:\n  a:\n    runs-on: x\n    permissions: read-all\n    steps: [{run: a}]\n  b:\n    runs-on: x\n    permissions: {}\n    steps: [{run: a}]';
    const { workflow: w } = parseWorkflow('w.yml', source);
    expect(w.permissions).toBe('contents: read, id-token: write');
    expect(w.jobs.map((j) => j.permissions)).toEqual(['read-all', 'none']);
  });

  it('estimates matrices built from expressions and from exclude entries', () => {
    const source = `on: push
jobs:
  dyn:
    runs-on: x
    strategy:
      matrix: \${{ fromJSON(needs.a.outputs.list) }}
    steps: [{run: a}]
  ex:
    runs-on: x
    strategy:
      matrix:
        a: [1, 2, 3]
        b: [x, y]
        exclude:
          - a: 1
            b: x
    steps: [{run: a}]
`;
    const [dyn, ex] = parseWorkflow('w.yml', source).workflow.jobs;
    expect(dyn.matrix).toMatchObject({ dynamic: true });
    expect(ex.matrix?.combos).toBe(5);
  });

  it('masks secrets in commands and inputs it keeps', () => {
    const source = `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: curl -H "Authorization: ${FAKE_TOKEN}" https://x\n      - uses: some/action@v1\n        with:\n          token: ${FAKE_TOKEN}\n`;
    const { workflow: w } = parseWorkflow('w.yml', source);
    expect(JSON.stringify(w)).not.toContain(FAKE_TOKEN);
  });

  it('reports a file that is not YAML with the line', () => {
    const { workflow: w, findings } = parseWorkflow('w.yml', 'on: push\njobs:\n\tbuild: {}\n');
    expect(w.error).toMatchObject({ line: 3 });
    expect(findings).toEqual([expect.objectContaining({ rule: 'invalid-yaml', severity: 'error', line: 3 })]);
  });

  it('reports a file that is not a mapping', () => {
    expect(parseWorkflow('w.yml', '- a\n- b\n').workflow.error).toBeDefined();
  });
});

describe('workflow findings: structure', () => {
  it('requires a trigger, jobs, runs-on and steps', () => {
    expect(rules(lint('jobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n'))).toContain('no-trigger');
    expect(rules(lint('on: push\n'))).toContain('no-jobs');
    expect(rules(lint('on: push\njobs:\n  a:\n    steps: [{run: a}]\n'))).toContain('missing-runs-on');
    expect(rules(lint('on: push\njobs:\n  a:\n    runs-on: x\n'))).toContain('no-steps');
  });

  it('does not require runs-on or steps from a job that calls a reusable workflow', () => {
    const found = rules(lint('on: push\njobs:\n  call:\n    uses: ./.github/workflows/build.yml\n'));
    expect(found).not.toContain('missing-runs-on');
    expect(found).not.toContain('no-steps');
  });

  it('reports needs of unknown jobs and circular needs', () => {
    const unknown = lint('on: push\njobs:\n  a:\n    runs-on: x\n    needs: ghost\n    steps: [{run: a}]\n');
    expect(unknown).toContainEqual(expect.objectContaining({ rule: 'unknown-needs', job: 'a', line: 5 }));
    const cycle = lint('on: push\njobs:\n  a:\n    runs-on: x\n    needs: b\n    steps: [{run: a}]\n  b:\n    runs-on: x\n    needs: a\n    steps: [{run: a}]\n');
    expect(cycle).toContainEqual(expect.objectContaining({ rule: 'needs-cycle', message: expect.stringContaining('a → b → a') }));
  });
});

describe('workflow findings: security', () => {
  const job = (steps: string, extra = ''): string => `on: ${extra || 'push'}\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${steps}`;

  it('flags untrusted text pasted into a script, and not text passed through env', () => {
    const bad = lint(job('      - run: echo "${{ github.event.issue.title }}"\n'));
    expect(bad).toContainEqual(expect.objectContaining({ rule: 'script-injection', severity: 'error', job: 'a', line: 8 }));
    expect(rules(lint(job('      - run: echo "$TITLE"\n        env:\n          TITLE: ${{ github.event.issue.title }}\n')))).not.toContain('script-injection');
    expect(rules(lint(job('      - run: echo ${{ github.head_ref }}\n')))).toContain('script-injection');
    expect(rules(lint(job('      - run: echo ${{ github.sha }}\n')))).not.toContain('script-injection');
  });

  it('flags injection in actions/github-script as well', () => {
    const found = lint(job('      - uses: actions/github-script@v7\n        with:\n          script: |\n            console.log("${{ github.event.pull_request.title }}")\n'));
    expect(rules(found)).toContain('script-injection');
  });

  it('flags pull_request_target that checks out the pull request code', () => {
    const risky = job('      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n', 'pull_request_target');
    expect(rules(lint(risky))).toContain('pull-request-target-checkout');
    expect(rules(lint(job('      - uses: actions/checkout@v4\n', 'pull_request_target')))).not.toContain('pull-request-target-checkout');
    expect(rules(lint(job('      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n')))).not.toContain('pull-request-target-checkout');
  });

  it('flags a secret written into the workflow without repeating it', () => {
    const found = lint(job(`      - run: deploy\n        env:\n          GH_TOKEN: ${FAKE_TOKEN}\n`));
    const hit = found.find((f) => f.rule === 'hardcoded-secret');
    expect(hit).toMatchObject({ severity: 'error', job: 'a' });
    expect(JSON.stringify(found)).not.toContain(FAKE_TOKEN);
    expect(rules(lint(job('      - run: deploy\n        env:\n          GH_TOKEN: ${{ secrets.GH_TOKEN }}\n')))).not.toContain('hardcoded-secret');
  });

  it('does not flag the throwaway database of a service container', () => {
    const url = (host: string): string => `on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    services:\n      db:\n        image: postgres\n    env:\n      DATABASE_URL: postgres://user:hunter2pw@${host}:5432/app\n    steps: [{run: a}]\n`;
    expect(rules(lint(url('localhost')))).not.toContain('hardcoded-secret');
    expect(rules(lint(url('db')))).not.toContain('hardcoded-secret');
    expect(rules(lint(url('prod-db.example.com')))).toContain('hardcoded-secret');
  });

  it('flags write-all and missing permissions', () => {
    expect(rules(lint('on: push\npermissions: write-all\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n'))).toContain('write-all-permissions');
    const none = lint('on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n');
    expect(none).toContainEqual(expect.objectContaining({ rule: 'missing-permissions', message: expect.stringContaining('`a`') }));
  });

  it('names only the jobs that lack permissions when others set them', () => {
    const partial = lint('on: push\njobs:\n  a:\n    runs-on: x\n    permissions: read-all\n    steps: [{run: a}]\n  b:\n    runs-on: x\n    steps: [{run: a}]\n');
    const [missing] = partial.filter((f) => f.rule === 'missing-permissions');
    expect(missing.message).toContain('`b`');
    expect(missing.message).not.toContain('`a`');
  });

  it('accepts permissions set at the top or on every job', () => {
    expect(rules(lint('on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n'))).not.toContain('missing-permissions');
    expect(rules(lint('on: push\njobs:\n  a:\n    runs-on: x\n    permissions: read-all\n    steps: [{run: a}]\n'))).not.toContain('missing-permissions');
  });

  it('flags secrets: inherit for a workflow of another repository, not for one of this repository', () => {
    const call = (uses: string): string => `on: push\npermissions: read-all\njobs:\n  call:\n    uses: ${uses}\n    secrets: inherit\n`;
    expect(rules(lint(call('org/repo/.github/workflows/x.yml@abcdefabcdefabcdefabcdefabcdefabcdefabcd')))).toContain('secrets-inherit');
    expect(rules(lint(call('./.github/workflows/x.yml')))).not.toContain('secrets-inherit');
  });
});

describe('workflow findings: actions and commands', () => {
  const steps = (...uses: string[]): string => `on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${uses.map((u) => `      - uses: ${u}`).join('\n')}\n`;

  it('flags mutable references and unpinned third-party tags', () => {
    expect(rules(lint(steps('some/action@main')))).toContain('mutable-action-ref');
    expect(rules(lint(steps('some/action')))).toContain('mutable-action-ref');
    expect(rules(lint(steps('some/action@v2')))).toEqual(['unpinned-action', 'missing-concurrency']);
  });

  it('accepts commit SHAs, first-party tags, local and Docker actions', () => {
    const found = rules(lint(steps('some/action@' + 'a'.repeat(40), 'actions/cache@v4', './.github/actions/setup', 'docker://alpine:3.19', './.github/workflows/build.yml')));
    expect(found).not.toContain('mutable-action-ref');
    expect(found).not.toContain('unpinned-action');
  });

  it('flags first-party actions on retired Node runtimes', () => {
    const found = lint(steps('actions/checkout@v3', 'actions/setup-python@v4', 'actions/checkout@v4'));
    expect(found.filter((f) => f.rule === 'outdated-action').map((f) => f.line)).toEqual([8, 9]);
    expect(rules(lint(steps('actions/checkout@v4', 'actions/checkout@' + 'b'.repeat(40))))).not.toContain('outdated-action');
  });

  it('flags deprecated commands and piping a download into a shell', () => {
    const source = `on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - run: echo "::set-output name=v::1"\n      - run: curl -fsSL https://x.dev/install.sh | sudo bash\n      - run: echo "v=1" >> "$GITHUB_OUTPUT"\n`;
    const found = lint(source);
    expect(found.filter((f) => f.rule === 'deprecated-command')).toHaveLength(1);
    expect(found.filter((f) => f.rule === 'pipe-to-shell')).toHaveLength(1);
  });
});

describe('workflow findings: efficiency', () => {
  it('flags jobs without timeouts once per workflow, and ignores reusable calls', () => {
    const source = 'on: push\npermissions: read-all\nconcurrency: x\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n  b:\n    runs-on: x\n    steps: [{run: a}]\n  c:\n    uses: ./.github/workflows/x.yml\n';
    const found = lint(source).filter((f) => f.rule === 'missing-timeout');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('`a`, `b`');
    expect(found[0].message).not.toContain('`c`');
  });

  it('flags a missing concurrency group on push and pull_request workflows only', () => {
    const base = (on: string, extra = ''): string => `on: ${on}\npermissions: read-all\n${extra}jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n    steps: [{run: a}]\n`;
    expect(rules(lint(base('push')))).toContain('missing-concurrency');
    expect(rules(lint(base('push', 'concurrency: x\n')))).not.toContain('missing-concurrency');
    expect(rules(lint(base('workflow_dispatch')))).not.toContain('missing-concurrency');
  });

  it('flags unfiltered push + pull_request, but not a filtered push', () => {
    const base = (push: string): string => `on:\n  push:${push}\n  pull_request:\npermissions: read-all\nconcurrency: x\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n    steps: [{run: a}]\n`;
    expect(rules(lint(base('')))).toContain('duplicate-runs');
    expect(rules(lint(base('\n    branches: [main]')))).not.toContain('duplicate-runs');
  });

  it('flags large matrices and frequent schedules', () => {
    const source = `on:\n  schedule:\n    - cron: '*/5 * * * *'\n    - cron: '0 3 * * *'\npermissions: read-all\nconcurrency: x\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n    strategy:\n      matrix:\n        a: [1,2,3,4,5]\n        b: [1,2,3,4,5]\n    steps: [{run: a}]\n`;
    const found = lint(source);
    expect(found.filter((f) => f.rule === 'large-matrix')).toHaveLength(1);
    expect(found.filter((f) => f.rule === 'frequent-schedule')).toHaveLength(1);
  });
});

describe('parseUses and pinOf', () => {
  it('classifies what a step uses', () => {
    expect(parseUses('actions/checkout@v4')).toEqual({ name: 'actions/checkout', ref: 'v4', kind: 'marketplace', official: true });
    expect(parseUses('github/codeql-action/init@v3')).toMatchObject({ name: 'github/codeql-action/init', official: true });
    expect(parseUses('someone/thing@main')).toMatchObject({ official: false, ref: 'main' });
    expect(parseUses('./.github/actions/setup')).toEqual({ name: './.github/actions/setup', kind: 'local', official: false });
    expect(parseUses('./.github/workflows/build.yml')).toMatchObject({ kind: 'reusable' });
    expect(parseUses('org/repo/.github/workflows/build.yml@v1')).toMatchObject({ kind: 'reusable', ref: 'v1' });
    expect(parseUses('docker://alpine:3.19')).toEqual({ name: 'docker://alpine', ref: '3.19', kind: 'docker', official: false });
  });

  it('tells commits, tags and branches apart', () => {
    expect(pinOf('a'.repeat(40))).toBe('sha');
    expect(pinOf('v4')).toBe('tag');
    expect(pinOf('1.2.3')).toBe('tag');
    expect(pinOf('v1.2.3-beta1')).toBe('tag');
    expect(pinOf('main')).toBe('branch');
    expect(pinOf('release/v2')).toBe('branch');
    expect(pinOf(undefined)).toBe('none');
  });
});

describe('Node.js helpers', () => {
  it('reads majors from versions', () => {
    expect(nodeMajor('20')).toBe(20);
    expect(nodeMajor('v22.1.0')).toBe(22);
    expect(nodeMajor('lts/*')).toBeUndefined();
  });

  it('knows which versions reached end of life at a given time', () => {
    expect(isNodeEndOfLife(18, NOW)).toBe(true);
    expect(isNodeEndOfLife(20, NOW)).toBe(true);
    expect(isNodeEndOfLife(22, NOW)).toBe(false);
    expect(isNodeEndOfLife(20, Date.parse('2026-04-29T00:00:00Z'))).toBe(false);
    expect(isNodeEndOfLife(99, NOW)).toBe(false);
  });

  it('finds the oldest Node.js an engines range allows', () => {
    expect(oldestEngineMajor('>=18')).toBe(18);
    expect(oldestEngineMajor('^18.17.0 || >=20')).toBe(18);
    expect(oldestEngineMajor('>=20.11 <23')).toBe(20);
    expect(oldestEngineMajor('<20')).toBeUndefined();
    expect(oldestEngineMajor('*')).toBeUndefined();
  });
});

describe('parseActionManifest and parseDependabot', () => {
  it('reads a composite action', () => {
    expect(parseActionManifest('name: Setup\ndescription: Install things\ninputs:\n  node:\n    default: 22\n  cache:\n    default: true\nruns:\n  using: composite\n  steps: []\n')).toEqual({ name: 'Setup', description: 'Install things', inputs: ['node', 'cache'] });
    expect(parseActionManifest('not: [valid')).toEqual({ inputs: [] });
  });

  it('reads the update ecosystems', () => {
    const text = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n  - package-ecosystem: github-actions\n    directory: /\n    schedule:\n      interval: monthly\n';
    expect(parseDependabot('.github/dependabot.yml', text).ecosystems).toEqual([
      { name: 'npm', directory: '/', interval: 'weekly' },
      { name: 'github-actions', directory: '/', interval: 'monthly' },
    ]);
  });
});

describe('buildCiReport', () => {
  const input = (overrides: Partial<CiInput> = {}): CiInput => ({
    base: '',
    workflows: [{ path: '.github/workflows/ci.yml', text: CI }],
    actionManifests: [],
    scripts: { lint: 'eslint .', test: 'vitest run', build: 'tsc' },
    fileExists: () => true,
    now: NOW,
    ...overrides,
  });

  it('summarises how actions are used, most used first', () => {
    const report = buildCiReport(input());
    expect(report.actions[0]).toMatchObject({ name: 'actions/checkout', count: 2, official: true, workflows: ['.github/workflows/ci.yml'], versions: [{ ref: 'v4', pin: 'tag', count: 2 }] });
    expect(report.actions.map((a) => a.name)).toEqual(['actions/checkout', 'actions/setup-node']);
  });

  it('compares the scripts CI runs with the ones package.json defines', () => {
    const report = buildCiReport(input());
    expect(report.scripts.find((s) => s.name === 'lint')?.runs).toEqual([{ file: '.github/workflows/ci.yml', job: 'lint', line: 18 }]);
    expect(report.scripts.find((s) => s.name === 'test')?.runs).toHaveLength(1);
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: 'script-not-in-ci', message: expect.stringContaining('`build`') }));
    expect(report.findings.filter((f) => f.rule === 'script-not-in-ci')).toHaveLength(1);
  });

  it('counts the scripts a script starts as run', () => {
    const report = buildCiReport(input({ scripts: { check: 'npm run lint && npm test && npm run build', lint: 'x', test: 'y', build: 'z' }, workflows: [{ path: '.github/workflows/ci.yml', text: CI.replace('npm run lint', 'npm run check') }] }));
    expect(report.findings.map((f) => f.rule)).not.toContain('script-not-in-ci');
  });

  it('flags a script CI runs that does not exist, unless a nested package may have it', () => {
    const text = CI.replace('npm run lint', 'npm run linter');
    expect(buildCiReport(input({ workflows: [{ path: '.github/workflows/ci.yml', text }] })).findings).toContainEqual(expect.objectContaining({ rule: 'missing-script', severity: 'error', line: 18 }));
    expect(buildCiReport(input({ workflows: [{ path: '.github/workflows/ci.yml', text }], scriptNames: ['linter'] })).findings.map((f) => f.rule)).not.toContain('missing-script');
    const nested = text.replace('      - run: npm run linter', '      - run: npm run linter\n        working-directory: web');
    expect(buildCiReport(input({ workflows: [{ path: '.github/workflows/ci.yml', text: nested }] })).findings.map((f) => f.rule)).not.toContain('missing-script');
  });

  it('does not compare scripts when the project has no package.json', () => {
    const report = buildCiReport(input({ scripts: undefined }));
    expect(report.scripts).toEqual([]);
    expect(report.findings.map((f) => f.rule)).not.toContain('missing-script');
  });

  it('flags end-of-life Node.js versions and an untested engines minimum', () => {
    const old = buildCiReport(input({ workflows: [{ path: '.github/workflows/ci.yml', text: CI.replace('node: [20, 22]', 'node: [18, 22]') }], nodeEngine: '>=16' }));
    expect(old.findings).toContainEqual(expect.objectContaining({ rule: 'node-eol', message: expect.stringContaining('18') }));
    expect(old.findings).toContainEqual(expect.objectContaining({ rule: 'node-engines-gap', file: 'package.json' }));
    expect(old.nodeVersions).toEqual(['18', '22', '24']);
    expect(buildCiReport(input({ nodeEngine: '>=24' })).findings.map((f) => f.rule)).not.toContain('node-engines-gap');
  });

  it('points an end-of-life Node.js at the job and the step that installs it', () => {
    const text = [
      'on: push',
      'permissions: read-all',
      'jobs:',
      '  lint:',
      '    runs-on: x',
      '    timeout-minutes: 1',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with: { node-version: 24 }',
      '  legacy:',
      '    runs-on: x',
      '    timeout-minutes: 1',
      '    steps:',
      '      - run: echo hi',
      '      - uses: actions/setup-node@v4',
      '        with: { node-version: 16 }',
    ].join('\n');
    const report = buildCiReport(input({ workflows: [{ path: '.github/workflows/w.yml', text }] }));
    const eol = report.findings.filter((f) => f.rule === 'node-eol');
    expect(eol).toEqual([expect.objectContaining({ job: 'legacy', line: 15, message: expect.stringContaining('16') })]);
    expect(report.workflows[0].jobs.map((j) => j.nodeVersions)).toEqual([['24'], ['16']]);
  });

  it('flags local actions and workflows that do not exist', () => {
    const text = 'on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n    steps:\n      - uses: ./.github/actions/setup\n      - uses: ./.github/actions/other\n  b:\n    uses: ./.github/workflows/gone.yml\n';
    const exists = (path: string): boolean => path === '.github/actions/setup/action.yml';
    const findings = buildCiReport(input({ workflows: [{ path: '.github/workflows/w.yml', text }], fileExists: exists })).findings.filter((f) => f.rule === 'unknown-local-action');
    expect(findings.map((f) => f.message)).toEqual([expect.stringContaining('actions/other'), expect.stringContaining('gone.yml')]);
  });

  it('lists local actions with how often they are used', () => {
    const text = 'on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n    steps:\n      - uses: ./.github/actions/setup\n      - uses: ./.github/actions/setup\n';
    const report = buildCiReport(input({ workflows: [{ path: '.github/workflows/w.yml', text }], actionManifests: [{ dir: '.github/actions/setup', text: 'name: Setup\ninputs:\n  node: {}\n' }] }));
    expect(report.localActions).toEqual([{ path: '.github/actions/setup', name: 'Setup', inputs: ['node'], usedBy: 2 }]);
  });

  it('flags a workflow_run that follows a workflow that does not exist', () => {
    const text = 'on:\n  workflow_run:\n    workflows: [Ghost, CI]\njobs:\n  a:\n    runs-on: x\n    steps: [{run: a}]\n';
    const report = buildCiReport(input({ workflows: [{ path: '.github/workflows/ci.yml', text: CI }, { path: '.github/workflows/after.yml', text }] }));
    expect(report.findings.filter((f) => f.rule === 'workflow-run-unknown').map((f) => f.message)).toEqual([expect.stringContaining('Ghost')]);
  });

  it('flags a Dependabot configuration that skips github-actions', () => {
    const dependabot = (ecosystem: string) => ({ file: '.github/dependabot.yml', text: `version: 2\nupdates:\n  - package-ecosystem: ${ecosystem}\n    directory: /\n    schedule:\n      interval: weekly\n` });
    expect(buildCiReport(input({ dependabot: dependabot('npm') })).findings.map((f) => f.rule)).toContain('dependabot-no-actions');
    expect(buildCiReport(input({ dependabot: dependabot('github-actions') })).findings.map((f) => f.rule)).not.toContain('dependabot-no-actions');
    expect(buildCiReport(input()).findings.map((f) => f.rule)).not.toContain('dependabot-no-actions');
  });

  it('orders findings with errors first', () => {
    const text = 'on: push\njobs:\n  a:\n    steps: [{run: "echo ${{ github.head_ref }}"}]\n';
    const severities = buildCiReport(input({ workflows: [{ path: '.github/workflows/w.yml', text }] })).findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
    expect(severities[0]).toBe('error');
  });

  it('keeps a report for a repository with a broken workflow', () => {
    const report = buildCiReport(input({ workflows: [{ path: '.github/workflows/bad.yml', text: 'on: [\n' }, { path: '.github/workflows/ci.yml', text: CI }] }));
    expect(report.workflows.map((w) => w.file)).toEqual(['.github/workflows/bad.yml', '.github/workflows/ci.yml']);
    expect(report.workflows[0].error).toBeDefined();
    expect(report.findings[0].rule).toBe('invalid-yaml');
  });
});

describe('WORKFLOW_RULES', () => {
  it('gives every rule a title and advice', () => {
    for (const [id, info] of Object.entries(WORKFLOW_RULES)) {
      expect(info.title, id).toBeTruthy();
      expect(info.advice.length, id).toBeGreaterThan(20);
    }
  });
});
