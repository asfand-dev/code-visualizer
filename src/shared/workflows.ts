/**
 * GitHub Actions workflows: reads a workflow file into triggers, jobs and steps, finds what is wrong with
 * it (security, missing pieces, outdated actions) and joins all workflows into one report. Pure — the
 * analyzer reads the files; the CLI and the report UI show what this module decides.
 */
import { cronIntervalMinutes } from './cron.js';
import { scriptClosure, scriptsInvoked } from './package-scripts.js';
import { CONNECTION_STRING_LABEL, findSecret, maskSecretsIn } from './risks.js';
import type {
  ActionPin,
  ActionUse,
  CiReport,
  LocalAction,
  ScriptUse,
  WorkflowFinding,
  WorkflowInfo,
  WorkflowJob,
  WorkflowMatrix,
  WorkflowSeverity,
  WorkflowStep,
  WorkflowTrigger,
} from './types.js';
import { findNeedsCycle } from './workflow-forecast.js';
import { isRecord, parseYaml, yamlLine, type YamlResult } from './yaml.js';

export interface WorkflowRuleInfo {
  severity: WorkflowSeverity;
  title: string;
  /** What to do about it. */
  advice: string;
}

export const WORKFLOW_RULES = {
  'invalid-yaml': { severity: 'error', title: 'Not valid YAML', advice: 'GitHub refuses to run a workflow it cannot parse. Fix the syntax at the reported line (indentation and quotes are the usual cause).' },
  'no-trigger': { severity: 'error', title: 'No trigger', advice: 'Add an `on:` key (for example `on: [push, pull_request]`); without one the workflow never runs.' },
  'no-jobs': { severity: 'error', title: 'No jobs', advice: 'A workflow needs a `jobs:` mapping with at least one job.' },
  'missing-runs-on': { severity: 'error', title: 'Job without runs-on', advice: 'Every job that is not a reusable workflow call needs `runs-on:` (for example `ubuntu-latest`).' },
  'no-steps': { severity: 'error', title: 'Job without steps', advice: 'Add `steps:` to the job, or call a reusable workflow with `uses:`.' },
  'unknown-needs': { severity: 'error', title: 'needs points at a missing job', advice: 'The job it waits for does not exist, so the workflow is rejected. Fix the name in `needs:`.' },
  'needs-cycle': { severity: 'error', title: 'Jobs wait for each other', advice: 'Jobs that need each other can never start. Remove one `needs:` entry from the chain.' },
  'unknown-local-action': { severity: 'error', title: 'Local action or workflow not found', advice: 'The path in `uses: ./…` has no action.yml (or workflow file) in the repository. Check the path, and that `actions/checkout` runs first.' },
  'missing-script': { severity: 'error', title: 'Runs a script package.json does not have', advice: 'The step runs a package.json script that does not exist, so it fails with "missing script". Add the script or fix the name.' },
  'script-injection': { severity: 'error', title: 'Untrusted text pasted into a script', advice: 'Anyone who controls this value (an issue title, a branch name…) can run commands in your workflow. Pass it through `env:` and read the variable (`"$TITLE"`) in the script instead.' },
  'pull-request-target-checkout': { severity: 'error', title: 'Runs pull request code with secrets', advice: '`pull_request_target` runs with write access and secrets; checking out the pull request\'s code there lets its author run anything. Use `pull_request`, or never run code from the checkout.' },
  'hardcoded-secret': { severity: 'error', title: 'Secret written in the workflow', advice: 'Anyone who can read the repository can read this value, and it stays in the history. Rotate it and store it in repository secrets (`${{ secrets.NAME }}`).' },
  'write-all-permissions': { severity: 'warning', title: 'Token has write access to everything', advice: '`write-all` gives the job\'s token every permission. List only what it needs (for example `contents: read`).' },
  'missing-permissions': { severity: 'warning', title: 'Token permissions not restricted', advice: 'Without `permissions:` the job\'s GITHUB_TOKEN gets the repository default, which is often read and write. Add `permissions: contents: read` at the top and widen it per job.' },
  'mutable-action-ref': { severity: 'warning', title: 'Action follows a branch', advice: 'A branch (or no version) changes under you, and a compromised action runs with your secrets. Pin to a release tag, better to a full commit SHA.' },
  'unpinned-action': { severity: 'info', title: 'Third-party action not pinned to a commit', advice: 'A tag can be moved to different code. Pin third-party actions to the full commit SHA (and let Dependabot update it).' },
  'outdated-action': { severity: 'warning', title: 'Action runs on a retired Node version', advice: 'Old major versions of GitHub\'s own actions run on Node versions GitHub has retired and are being shut down. Move to the newer major version.' },
  'deprecated-command': { severity: 'warning', title: 'Deprecated workflow command', advice: '`::set-output`, `::save-state`, `::set-env` and `::add-path` are deprecated or disabled. Write to the `$GITHUB_OUTPUT`, `$GITHUB_STATE`, `$GITHUB_ENV` and `$GITHUB_PATH` files instead.' },
  'node-eol': { severity: 'warning', title: 'Uses an end-of-life Node.js', advice: 'This Node.js version no longer gets security fixes. Move to a current LTS version (in a matrix, replace the old entry).' },
  'workflow-run-unknown': { severity: 'warning', title: 'Follows a workflow that does not exist', advice: '`workflow_run` waits for a workflow by its `name:`. No workflow has this name, so this one never starts.' },
  'missing-timeout': { severity: 'info', title: 'No timeout', advice: 'A stuck job runs for 6 hours by default and uses your minutes. Set `timeout-minutes:` to a little more than the job normally takes.' },
  'missing-concurrency': { severity: 'info', title: 'Outdated runs are not cancelled', advice: 'Add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` so a new push stops the older run.' },
  'duplicate-runs': { severity: 'info', title: 'Runs twice for pull request branches', advice: 'With `push` and `pull_request` both unfiltered, a push to a branch with an open pull request runs the workflow twice. Limit `push` to `branches: [main]`.' },
  'large-matrix': { severity: 'info', title: 'Large matrix', advice: 'Every combination is a separate job that uses minutes. Check that all of them add information.' },
  'frequent-schedule': { severity: 'info', title: 'Runs very often', advice: 'A schedule this frequent uses a lot of minutes. Check that the job really has to run that often.' },
  'pipe-to-shell': { severity: 'info', title: 'Downloads and runs a script', advice: 'Piping `curl` into a shell runs whatever the server sends. Download a pinned version, verify its checksum, then run it.' },
  'secrets-inherit': { severity: 'info', title: 'Passes every secret on', advice: '`secrets: inherit` gives the called workflow all of your secrets. Pass only the ones it needs.' },
  'script-not-in-ci': { severity: 'info', title: 'Script CI never runs', advice: 'package.json defines this script but no workflow runs it, so a regression in it is only found locally.' },
  'node-engines-gap': { severity: 'info', title: 'Oldest supported Node.js is not tested', advice: 'package.json says the project runs on older Node.js versions than CI tests. Add the oldest one to the matrix.' },
  'dependabot-no-actions': { severity: 'info', title: 'Actions are not kept up to date', advice: 'Dependabot is configured but not for `github-actions`, so action versions only change when somebody remembers. Add that ecosystem.' },
} as const satisfies Record<string, WorkflowRuleInfo>;

export type WorkflowRuleId = keyof typeof WORKFLOW_RULES;

const SEVERITY_RANK: Record<WorkflowSeverity, number> = { error: 0, warning: 1, info: 2 };

const MAX_RUN_LENGTH = 400;
const MAX_VALUE_LENGTH = 160;
const LARGE_MATRIX = 20;
const FREQUENT_SCHEDULE_MINUTES = 15;
const MAX_LISTED = 5;

/* -------------------------------- Utilities -------------------------------- */

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

function textList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    const t = text(item);
    return t === undefined ? [] : [t];
  });
}

const keysOf = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : []);
const nonEmpty = (items: string[]): string[] | undefined => (items.length ? items : undefined);

/** The object without the properties that are undefined. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const safe = (value: string, max: number): string => clip(maskSecretsIn(value), max);
const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

function finding(rule: WorkflowRuleId, file: string, message: string, where: { line?: number; job?: string } = {}): WorkflowFinding {
  return defined({ rule, severity: WORKFLOW_RULES[rule].severity, file, message, ...where });
}

/** Every string in the document (keys excluded), for finding `secrets.X` and `vars.X`. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (isRecord(value)) Object.values(value).forEach((item) => allStrings(item, out));
  return out;
}

function contextNames(strings: string[], context: 'secrets' | 'vars'): string[] {
  const names = new Set<string>();
  const pattern = new RegExp(`\\b${context}\\.([A-Za-z_][\\w-]*)`, 'g');
  for (const s of strings) for (const match of s.matchAll(pattern)) names.add(match[1]);
  return [...names].sort();
}

/* ------------------------------ Reading a file ----------------------------- */

interface StepSource {
  step: WorkflowStep;
  /** The whole command / `with:` values / env, unclipped, for the checks. */
  run?: string;
  withValues: Record<string, unknown>;
  env: Record<string, unknown>;
}

interface JobSource {
  job: WorkflowJob;
  steps: StepSource[];
  env: Record<string, unknown>;
  /** The job as written. */
  body: Record<string, unknown>;
}

function parseTriggers(on: unknown): WorkflowTrigger[] {
  if (typeof on === 'string') return [{ event: on }];
  if (Array.isArray(on)) return textList(on).map((event) => ({ event }));
  if (!isRecord(on)) return [];
  return Object.entries(on).map(([event, config]) => readTrigger(event, config));
}

function readTrigger(event: string, config: unknown): WorkflowTrigger {
  if (event === 'schedule' && Array.isArray(config)) {
    const cron = config.flatMap((entry) => (isRecord(entry) ? textList(entry.cron) : []));
    return cron.length ? { event, cron } : { event };
  }
  if (!isRecord(config)) return { event };
  return defined({
    event,
    branches: nonEmpty(textList(config.branches)),
    branchesIgnore: nonEmpty(textList(config['branches-ignore'])),
    tags: nonEmpty(textList(config.tags)),
    tagsIgnore: nonEmpty(textList(config['tags-ignore'])),
    paths: nonEmpty(textList(config.paths)),
    pathsIgnore: nonEmpty(textList(config['paths-ignore'])),
    types: nonEmpty(textList(config.types)),
    workflows: nonEmpty(textList(config.workflows)),
    inputs: nonEmpty(keysOf(config.inputs)),
  });
}

function permissionsText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).map(([scope, level]) => `${scope}: ${text(level) ?? '?'}`);
  return entries.length ? entries.join(', ') : 'none';
}

function readMatrix(strategy: unknown): WorkflowMatrix | undefined {
  if (!isRecord(strategy)) return undefined;
  const failFast = typeof strategy['fail-fast'] === 'boolean' ? strategy['fail-fast'] : undefined;
  const matrix = strategy.matrix;
  if (typeof matrix === 'string') return defined({ dims: [], combos: 1, dynamic: true, includes: 0, excludes: 0, failFast });
  if (!isRecord(matrix)) return undefined;
  const dims = Object.entries(matrix)
    .filter(([name]) => name !== 'include' && name !== 'exclude')
    .map(([name, values]) => ({ name, values: Array.isArray(values) ? values.map((v) => text(v) ?? JSON.stringify(v)) : [] }));
  // A dimension (or `include`) given as an expression, such as `${{ fromJSON(needs.x.outputs.list) }}`.
  const dynamic = Object.values(matrix).some((value) => typeof value === 'string');
  const includes = Array.isArray(matrix.include) ? matrix.include.length : 0;
  const excludes = Array.isArray(matrix.exclude) ? matrix.exclude.length : 0;
  const product = dims.reduce((count, dim) => count * Math.max(dim.values.length, 1), 1);
  const combos = Math.max(1, (dims.length ? product - excludes : 0) + includes);
  return defined({ dims, combos, dynamic: dynamic || undefined, includes, excludes, failFast });
}

function runsOn(value: unknown): string[] {
  return isRecord(value) ? [...textList(value.group), ...textList(value.labels)] : textList(value);
}

function readStep(raw: unknown, line: number): StepSource | undefined {
  if (!isRecord(raw)) return undefined;
  const run = text(raw.run);
  const withValues = isRecord(raw.with) ? raw.with : {};
  const shownWith = Object.entries(withValues).flatMap(([key, value]) => {
    const t = text(value);
    return t === undefined ? [] : [[key, safe(t.trim(), MAX_VALUE_LENGTH)] as const];
  });
  const step: WorkflowStep = defined({
    line,
    name: text(raw.name),
    id: text(raw.id),
    uses: text(raw.uses),
    run: run === undefined ? undefined : safe(run.trim(), MAX_RUN_LENGTH),
    shell: text(raw.shell),
    if: text(raw.if),
    with: shownWith.length ? Object.fromEntries(shownWith) : undefined,
    workingDirectory: text(raw['working-directory']),
    continueOnError: raw['continue-on-error'] === true ? true : undefined,
  });
  return { step, run, withValues, env: isRecord(raw.env) ? raw.env : {} };
}

function readJob(id: string, raw: unknown, yaml: YamlResult): JobSource {
  const body = isRecord(raw) ? raw : {};
  const line = yamlLine(yaml, 'jobs', id) ?? 1;
  const rawSteps = Array.isArray(body.steps) ? body.steps : [];
  const steps = rawSteps.flatMap((step, index) => readStep(step, yamlLine(yaml, 'jobs', id, 'steps', index) ?? line) ?? []);
  const environment = isRecord(body.environment) ? text(body.environment.name) : text(body.environment);
  const container = isRecord(body.container) ? text(body.container.image) : text(body.container);
  const job: WorkflowJob = defined({
    id,
    name: text(body.name),
    line,
    runsOn: runsOn(body['runs-on']),
    needs: textList(body.needs),
    uses: text(body.uses),
    if: text(body.if),
    matrix: readMatrix(body.strategy),
    permissions: permissionsText(body.permissions),
    timeoutMinutes: typeof body['timeout-minutes'] === 'number' ? body['timeout-minutes'] : undefined,
    environment,
    container,
    services: keysOf(body.services),
    outputs: keysOf(body.outputs),
    steps: steps.map((s) => s.step),
    continueOnError: body['continue-on-error'] === true ? true : undefined,
    concurrency: body.concurrency === undefined ? undefined : true,
  });
  return { job, steps, env: isRecord(body.env) ? body.env : {}, body };
}

/** The values of `matrix.<key>`, including those that only an `include:` entry adds. */
function matrixValues(strategy: unknown, key: string): string[] {
  const matrix = isRecord(strategy) && isRecord(strategy.matrix) ? strategy.matrix : undefined;
  if (!matrix) return [];
  const fromDimension = textList(matrix[key]);
  const fromInclude = Array.isArray(matrix.include) ? matrix.include.flatMap((entry) => (isRecord(entry) ? textList(entry[key]) : [])) : [];
  return [...new Set([...fromDimension, ...fromInclude])];
}

/** Node versions of a job's `actions/setup-node` steps; `${{ matrix.node }}` is resolved through the job's matrix. */
function nodeVersionsOf(source: JobSource): string[] {
  const versions = source.steps
    .filter((s) => s.step.uses?.startsWith('actions/setup-node@'))
    .flatMap((s) => textList(s.withValues['node-version']));
  return versions.flatMap((version) => {
    const expression = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(version.trim());
    if (expression) return matrixValues(source.body.strategy, expression[1]);
    return version.includes('${{') ? [] : [version];
  });
}

/* --------------------------------- Actions --------------------------------- */

export interface ActionRef {
  /** `actions/checkout`, `github/codeql-action/init`, `./.github/actions/setup`, `docker://alpine`. */
  name: string;
  ref?: string;
  kind: ActionUse['kind'];
  official: boolean;
}

const SHA_REF = /^[0-9a-f]{40}$/i;
const VERSION_REF = /^v?\d+(?:[.\-+]\w+)*$/;

/** `owner/repo/path@ref` → what it is and which version. Reusable workflows are told apart by their path. */
export function parseUses(uses: string): ActionRef {
  const value = uses.trim();
  if (value.startsWith('./') || value.startsWith('../')) {
    const isWorkflow = /\.ya?ml$/.test(value);
    return { name: value.replace(/\/$/, ''), kind: isWorkflow ? 'reusable' : 'local', official: false };
  }
  if (value.startsWith('docker://')) {
    const image = value.slice('docker://'.length);
    const tag = /^(.*?)(?::([^/:]+))?$/.exec(image);
    return { name: `docker://${tag?.[1] ?? image}`, ref: tag?.[2], kind: 'docker', official: false };
  }
  const at = value.indexOf('@');
  const name = at < 0 ? value : value.slice(0, at);
  const ref = at < 0 ? undefined : value.slice(at + 1);
  const owner = name.split('/')[0];
  const kind = /\.github\/workflows\/.+\.ya?ml$/.test(name) ? 'reusable' : 'marketplace';
  return { name, ref, kind, official: owner === 'actions' || owner === 'github' };
}

export function pinOf(ref: string | undefined): ActionPin {
  if (!ref) return 'none';
  if (SHA_REF.test(ref)) return 'sha';
  return VERSION_REF.test(ref) ? 'tag' : 'branch';
}

/** First major version of GitHub's own actions that runs on a supported Node.js; older ones use retired runtimes. */
const FIRST_CURRENT_MAJOR: Record<string, number> = {
  'actions/checkout': 4,
  'actions/setup-node': 4,
  'actions/cache': 4,
  'actions/upload-artifact': 4,
  'actions/download-artifact': 4,
  'actions/setup-python': 5,
  'actions/setup-java': 4,
  'actions/setup-go': 5,
  'actions/github-script': 7,
};

function majorOf(ref: string | undefined): number | undefined {
  const match = ref ? /^v?(\d+)/.exec(ref) : undefined;
  return match ? Number(match[1]) : undefined;
}

/* ---------------------------------- Checks --------------------------------- */

interface LintContext {
  file: string;
  yaml: YamlResult;
  doc: Record<string, unknown>;
  workflow: WorkflowInfo;
  jobs: JobSource[];
}

/** Context properties whose value an outsider controls (`github.event.issue.title`, `github.head_ref`…). */
const UNTRUSTED_CONTEXTS = [
  'github\\.head_ref',
  'github\\.event\\.issue\\.(?:title|body)',
  'github\\.event\\.pull_request\\.(?:title|body|head\\.ref|head\\.label|head\\.repo\\.default_branch)',
  'github\\.event\\.(?:comment|review|review_comment)\\.body',
  'github\\.event\\.discussion\\.(?:title|body)',
  'github\\.event\\.pages\\.[^}\\s]*\\.page_name',
  'github\\.event\\.commits\\.[^}\\s]*\\.(?:message|author\\.(?:email|name))',
  'github\\.event\\.head_commit\\.(?:message|author\\.(?:email|name))',
  'github\\.event\\.workflow_run\\.(?:head_branch|head_commit\\.(?:message|author\\.(?:email|name)))',
];
const UNTRUSTED_EXPRESSION = new RegExp(`\\$\\{\\{[^}]*?\\b(${UNTRUSTED_CONTEXTS.join('|')})\\b[^}]*\\}\\}`);
const PULL_REQUEST_CODE = /github\.event\.pull_request\.head\.|github\.head_ref|refs\/pull\//;
const DEPRECATED_COMMAND = /::(set-output|save-state|set-env|add-path)\b/;
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/;

/** Code a step runs: its `run` script and the script of `actions/github-script`. */
function scriptOf(source: StepSource): string[] {
  const script = source.step.uses?.startsWith('actions/github-script@') ? text(source.withValues.script) : undefined;
  return [source.run, script].flatMap((code) => (code ? [code] : []));
}

const where = (job: WorkflowJob, source: StepSource): { line: number; job: string } => ({ line: source.step.line, job: job.id });

function structureFindings({ file, workflow, yaml }: LintContext): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  if (!workflow.triggers.length) out.push(finding('no-trigger', file, 'The workflow has no `on:` trigger, so it never runs', { line: yamlLine(yaml, 'on') ?? 1 }));
  if (!workflow.jobs.length) return [...out, finding('no-jobs', file, 'The workflow has no jobs', { line: yamlLine(yaml, 'jobs') ?? 1 })];
  const ids = new Set(workflow.jobs.map((j) => j.id));
  for (const job of workflow.jobs) {
    if (!job.uses && !job.runsOn.length) out.push(finding('missing-runs-on', file, `Job \`${job.id}\` has no \`runs-on\``, { line: job.line, job: job.id }));
    if (!job.uses && !job.steps.length) out.push(finding('no-steps', file, `Job \`${job.id}\` has no steps`, { line: job.line, job: job.id }));
    for (const need of job.needs.filter((n) => !ids.has(n))) out.push(finding('unknown-needs', file, `Job \`${job.id}\` needs \`${need}\`, which is not a job of this workflow`, { line: yamlLine(yaml, 'jobs', job.id, 'needs') ?? job.line, job: job.id }));
  }
  const cycle = findNeedsCycle(workflow.jobs);
  if (cycle) out.push(finding('needs-cycle', file, `Jobs wait for each other: ${cycle.join(' → ')}`, { line: workflow.jobs.find((j) => j.id === cycle[0])?.line }));
  return out;
}

function injectionFindings({ file, jobs }: LintContext): WorkflowFinding[] {
  return jobs.flatMap(({ job, steps }) =>
    steps.flatMap((source) =>
      scriptOf(source).flatMap((code) => {
        const match = UNTRUSTED_EXPRESSION.exec(code);
        return match ? [finding('script-injection', file, `The script uses \`\${{ ${match[1]} }}\`, which whoever opens the issue, branch or pull request controls`, where(job, source))] : [];
      }),
    ),
  );
}

function pullRequestTargetFindings({ file, workflow, jobs }: LintContext): WorkflowFinding[] {
  if (!workflow.triggers.some((t) => t.event === 'pull_request_target')) return [];
  return jobs.flatMap(({ job, steps }) =>
    steps
      .filter((s) => s.step.uses?.startsWith('actions/checkout@'))
      .filter((s) => PULL_REQUEST_CODE.test(`${text(s.withValues.ref) ?? ''} ${text(s.withValues.repository) ?? ''}`))
      .map((s) => finding('pull-request-target-checkout', file, `Job \`${job.id}\` checks out the pull request's code in a \`pull_request_target\` workflow`, where(job, s))),
  );
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/** `postgres://user:pass@localhost/db` for a service container of the job: a throwaway, not a credential. */
function isThrowawayConnection(value: string, services: string[]): boolean {
  const host = /@([^\s:/'"`?]+)/.exec(value)?.[1]?.toLowerCase();
  return host !== undefined && (LOCAL_HOSTS.has(host) || services.includes(host));
}

function secretFindings({ file, doc, jobs }: LintContext): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  const check = (values: Record<string, unknown>, location: { line?: number; job?: string }, services: string[]): void => {
    for (const [name, value] of Object.entries(values)) {
      const found = typeof value === 'string' ? findSecret(value) : undefined;
      if (!found || (found.label === CONNECTION_STRING_LABEL && isThrowawayConnection(String(value), services))) continue;
      out.push(finding('hardcoded-secret', file, `\`${name}\` holds what looks like a ${found.label}`, location));
    }
  };
  if (isRecord(doc.env)) check(doc.env, {}, []);
  for (const { job, env, steps } of jobs) {
    check(env, { line: job.line, job: job.id }, job.services);
    for (const source of steps) {
      check(source.env, where(job, source), job.services);
      check(source.withValues, where(job, source), job.services);
    }
  }
  return out;
}

function permissionFindings({ file, workflow, yaml }: LintContext): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  if (workflow.permissions === 'write-all') out.push(finding('write-all-permissions', file, 'The workflow gives the token `write-all` permissions', { line: yamlLine(yaml, 'permissions') }));
  for (const job of workflow.jobs.filter((j) => j.permissions === 'write-all')) out.push(finding('write-all-permissions', file, `Job \`${job.id}\` gives the token \`write-all\` permissions`, { line: job.line, job: job.id }));
  const lacking = workflow.jobs.filter((j) => !j.permissions);
  if (!workflow.permissions && lacking.length) {
    const names = lacking.slice(0, MAX_LISTED).map((j) => `\`${j.id}\``).join(', ');
    out.push(finding('missing-permissions', file, `No \`permissions:\` for ${lacking.length === 1 ? 'job' : 'jobs'} ${names}${lacking.length > MAX_LISTED ? ', …' : ''}`, { line: yamlLine(yaml, 'jobs') }));
  }
  return out;
}

function actionFindings({ file, jobs }: LintContext): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  for (const { job, steps } of jobs) {
    const uses = [...(job.uses ? [{ value: job.uses, line: job.line }] : []), ...steps.flatMap((s) => (s.step.uses ? [{ value: s.step.uses, line: s.step.line }] : []))];
    for (const { value, line } of uses) {
      const action = parseUses(value);
      if (action.kind === 'docker' || action.name.startsWith('.')) continue;
      const pin = pinOf(action.ref);
      const location = { line, job: job.id };
      if (!action.official && pin === 'tag') out.push(finding('unpinned-action', file, `\`${action.name}@${action.ref}\` is a tag, not a commit`, location));
      if (pin === 'branch' || pin === 'none') out.push(finding('mutable-action-ref', file, `\`${action.name}\` is used ${action.ref ? `at the branch \`${action.ref}\`` : 'without a version'}`, location));
      const current = FIRST_CURRENT_MAJOR[action.name];
      const major = majorOf(action.ref);
      if (current !== undefined && major !== undefined && major < current) out.push(finding('outdated-action', file, `\`${action.name}@${action.ref}\` is too old; v${current} or newer runs on a supported Node.js`, location));
    }
  }
  return out;
}

function commandFindings({ file, jobs }: LintContext): WorkflowFinding[] {
  return jobs.flatMap(({ job, steps }) =>
    steps.flatMap((source) =>
      scriptOf(source).flatMap((code) => {
        const found: WorkflowFinding[] = [];
        const deprecated = DEPRECATED_COMMAND.exec(code);
        if (deprecated) found.push(finding('deprecated-command', file, `\`::${deprecated[1]}\` is ${deprecated[1] === 'set-env' || deprecated[1] === 'add-path' ? 'disabled' : 'deprecated'}`, where(job, source)));
        if (PIPE_TO_SHELL.test(code)) found.push(finding('pipe-to-shell', file, 'A downloaded script is piped straight into a shell', where(job, source)));
        return found;
      }),
    ),
  );
}

function reusableFindings({ file, jobs }: LintContext): WorkflowFinding[] {
  return jobs
    // A workflow of the same repository is as trusted as the caller; the secrets go to someone else's code otherwise.
    .filter(({ job, body }) => job.uses && !job.uses.startsWith('./') && body.secrets === 'inherit')
    .map(({ job }) => finding('secrets-inherit', file, `Job \`${job.id}\` passes every secret to \`${job.uses}\``, { line: job.line, job: job.id }));
}

function efficiencyFindings({ file, workflow, yaml }: LintContext): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  const events = new Set(workflow.triggers.map((t) => t.event));
  const runnable = workflow.jobs.filter((j) => !j.uses);
  const untimed = runnable.filter((j) => j.timeoutMinutes === undefined);
  if (untimed.length) {
    const names = untimed.slice(0, MAX_LISTED).map((j) => `\`${j.id}\``).join(', ');
    out.push(finding('missing-timeout', file, `No \`timeout-minutes\` for ${untimed.length === 1 ? 'job' : 'jobs'} ${names}${untimed.length > MAX_LISTED ? ', …' : ''}`, { line: yamlLine(yaml, 'jobs') }));
  }
  const reacts = events.has('pull_request') || events.has('push');
  if (reacts && runnable.length && !workflow.concurrency && !workflow.jobs.some((j) => j.concurrency)) out.push(finding('missing-concurrency', file, 'No `concurrency:`, so every push runs to the end even when a newer one has started', { line: yamlLine(yaml, 'on') }));
  const push = workflow.triggers.find((t) => t.event === 'push');
  const pullRequest = workflow.triggers.find((t) => t.event === 'pull_request');
  if (push && pullRequest && !push.branches && !push.tags && !push.paths && !pullRequest.branches) out.push(finding('duplicate-runs', file, 'Runs for `push` and for `pull_request` without filters: a branch with an open pull request runs it twice', { line: yamlLine(yaml, 'on') }));
  for (const job of workflow.jobs.filter((j) => j.matrix && j.matrix.combos > LARGE_MATRIX)) out.push(finding('large-matrix', file, `Job \`${job.id}\` expands to ${job.matrix?.combos}${job.matrix?.dynamic ? '+' : ''} jobs`, { line: job.line, job: job.id }));
  for (const cron of workflow.triggers.flatMap((t) => t.cron ?? [])) {
    const interval = cronIntervalMinutes(cron);
    if (interval !== undefined && interval < FREQUENT_SCHEDULE_MINUTES) out.push(finding('frequent-schedule', file, `\`${cron}\` runs every ${interval} minutes`, { line: yamlLine(yaml, 'on', 'schedule') }));
  }
  return out;
}

const LINTS = [structureFindings, injectionFindings, pullRequestTargetFindings, secretFindings, permissionFindings, actionFindings, commandFindings, reusableFindings, efficiencyFindings];

/* --------------------------------- Parsing --------------------------------- */

/** One workflow file as the model and the problems found in the file alone. */
export function parseWorkflow(file: string, source: string): { workflow: WorkflowInfo; findings: WorkflowFinding[] } {
  const empty: WorkflowInfo = { file, name: baseName(file), triggers: [], jobs: [], env: [], secrets: [], variables: [], lines: source.split('\n').length };
  const yaml = parseYaml(source);
  const fail = (message: string, line: number): { workflow: WorkflowInfo; findings: WorkflowFinding[] } => ({
    workflow: { ...empty, error: { message, line } },
    findings: [finding('invalid-yaml', file, message, { line })],
  });
  if (yaml.error) return fail(yaml.error.message, yaml.error.line);
  if (!isRecord(yaml.value)) return fail('A workflow is a mapping with `on` and `jobs`', 1);
  const doc = yaml.value;
  const rawJobs = isRecord(doc.jobs) ? doc.jobs : {};
  const jobs = Object.entries(rawJobs).map(([id, raw]) => readJob(id, raw, yaml));
  for (const source of jobs) {
    const versions = [...new Set(nodeVersionsOf(source))];
    if (versions.length) source.job.nodeVersions = versions;
  }
  const strings = allStrings(doc);
  const nodeVersions = [...new Set(jobs.flatMap((j) => j.job.nodeVersions ?? []))];
  const workflow: WorkflowInfo = defined({
    ...empty,
    name: text(doc.name) ?? empty.name,
    triggers: parseTriggers(doc.on),
    jobs: jobs.map((j) => j.job),
    permissions: permissionsText(doc.permissions),
    concurrency: doc.concurrency === undefined ? undefined : true,
    env: keysOf(doc.env),
    secrets: contextNames(strings, 'secrets'),
    variables: contextNames(strings, 'vars'),
    nodeVersions: nodeVersions.length ? nodeVersions : undefined,
  });
  const context: LintContext = { file, yaml, doc, workflow, jobs };
  return { workflow, findings: LINTS.flatMap((lint) => lint(context)) };
}

/** A composite or Docker action of the repository (`action.yml`): its name, description and inputs. */
export function parseActionManifest(source: string): Pick<LocalAction, 'name' | 'description' | 'inputs'> {
  const doc = parseYaml(source).value;
  if (!isRecord(doc)) return { inputs: [] };
  return defined({ name: text(doc.name), description: text(doc.description)?.trim(), inputs: keysOf(doc.inputs) });
}

/** The update ecosystems of `.github/dependabot.yml`. */
export function parseDependabot(file: string, source: string): NonNullable<CiReport['dependabot']> {
  const doc = parseYaml(source).value;
  const updates = isRecord(doc) && Array.isArray(doc.updates) ? doc.updates : [];
  const ecosystems = updates.flatMap((update) => {
    if (!isRecord(update)) return [];
    const name = text(update['package-ecosystem']);
    if (!name) return [];
    const directory = text(update.directory) ?? textList(update.directories).join(', ');
    const interval = isRecord(update.schedule) ? text(update.schedule.interval) : undefined;
    return [defined({ name, directory: directory || '/', interval })];
  });
  return { file, ecosystems };
}

/* ---------------------------------- Report --------------------------------- */

export interface CiInput {
  /** The analyzed root relative to the repository root (`''` when they are the same folder). */
  base: string;
  /** `.github/workflows/*.yml` with their text (paths from the repository root). */
  workflows: { path: string; text: string }[];
  /** `action.yml` files of local actions: their folder (from the repository root) and text. */
  actionManifests: { dir: string; text: string }[];
  dependabot?: { file: string; text: string };
  /** Scripts of the root package.json; undefined when the project has none (then scripts are not compared). */
  scripts?: Record<string, string>;
  /** Script names of the root and every workspace package: a script run from a nested folder may live in any. */
  scriptNames?: string[];
  /** `engines.node` of package.json. */
  nodeEngine?: string;
  /** Whether a file exists in the repository (a path from the repository root). */
  fileExists: (path: string) => boolean;
  now: number;
}

/** End of life of the Node.js release lines (nodejs.org/en/about/previous-releases). Newer lines are not listed. */
const NODE_END_OF_LIFE: Record<number, string> = {
  10: '2021-04-30', 11: '2019-06-01', 12: '2022-04-30', 13: '2020-06-01', 14: '2023-04-30', 15: '2021-06-01', 16: '2023-09-11', 17: '2022-06-01',
  18: '2025-04-30', 19: '2023-06-01', 20: '2026-04-30', 21: '2024-06-01', 22: '2027-04-30', 23: '2025-06-01', 24: '2028-04-30',
};

export function nodeMajor(version: string): number | undefined {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

export function isNodeEndOfLife(major: number, now: number): boolean {
  const end = NODE_END_OF_LIFE[major];
  return end !== undefined && Date.parse(end) <= now;
}

/** The oldest Node.js major an `engines.node` range allows (`>=18`, `^18.17 || >=20` → 18). */
export function oldestEngineMajor(range: string): number | undefined {
  const majors = range
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('<'))
    .flatMap((part) => {
      const match = /(\d+)/.exec(part);
      return match ? [Number(match[1])] : [];
    });
  return majors.length ? Math.min(...majors) : undefined;
}

function aggregateActions(workflows: WorkflowInfo[]): ActionUse[] {
  const byName = new Map<string, ActionUse>();
  for (const workflow of workflows) {
    const uses = workflow.jobs.flatMap((job) => [...(job.uses ? [job.uses] : []), ...job.steps.flatMap((s) => (s.uses ? [s.uses] : []))]);
    for (const value of uses) {
      const action = parseUses(value);
      const entry = byName.get(action.name) ?? { name: action.name, kind: action.kind, official: action.official, versions: [], count: 0, workflows: [] };
      entry.count++;
      if (!entry.workflows.includes(workflow.file)) entry.workflows.push(workflow.file);
      const label = action.ref ?? '';
      const version = entry.versions.find((v) => v.ref === label);
      if (version) version.count++;
      else entry.versions.push({ ref: label, pin: pinOf(action.ref), count: 1 });
      byName.set(action.name, entry);
    }
  }
  return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function localActions(input: CiInput, actions: ActionUse[]): LocalAction[] {
  return input.actionManifests
    .map(({ dir, text: source }) => {
      const usedBy = actions.find((a) => a.kind === 'local' && a.name.replace(/^\.\//, '') === dir)?.count ?? 0;
      return { path: dir, ...parseActionManifest(source), usedBy };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function missingLocalFindings(workflows: WorkflowInfo[], fileExists: (path: string) => boolean): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const uses = [...(job.uses ? [{ value: job.uses, line: job.line }] : []), ...job.steps.flatMap((s) => (s.uses ? [{ value: s.uses, line: s.line }] : []))];
      for (const { value, line } of uses) {
        const action = parseUses(value);
        if (action.kind !== 'local' && !(action.kind === 'reusable' && action.name.startsWith('./'))) continue;
        const path = action.name.replace(/^\.\//, '');
        const found = action.kind === 'reusable' ? fileExists(path) : fileExists(`${path}/action.yml`) || fileExists(`${path}/action.yaml`);
        if (!found) out.push(finding('unknown-local-action', workflow.file, `\`${value}\` does not exist in the repository`, { line, job: job.id }));
      }
    }
  }
  return out;
}

function workflowRunFindings(workflows: WorkflowInfo[]): WorkflowFinding[] {
  const names = new Set(workflows.map((w) => w.name));
  return workflows.flatMap((workflow) =>
    workflow.triggers
      .filter((t) => t.event === 'workflow_run')
      .flatMap((t) => t.workflows ?? [])
      .filter((followed) => !names.has(followed))
      .map((followed) => finding('workflow-run-unknown', workflow.file, `Follows the workflow \`${followed}\`, but no workflow has that name`)),
  );
}

interface StepSite {
  file: string;
  job: string;
  line: number;
  commands: string[];
  nested: boolean;
}

function stepSites(workflows: WorkflowInfo[]): StepSite[] {
  return workflows.flatMap((workflow) =>
    workflow.jobs.flatMap((job) =>
      job.steps.flatMap((step) => (step.run ? [{ file: workflow.file, job: job.id, line: step.line, commands: scriptsInvoked(step.run), nested: !!step.workingDirectory || /\bcd\s/.test(step.run) }] : [])),
    ),
  );
}

const SCRIPTS_CI_SHOULD_RUN = ['test', 'lint', 'typecheck', 'build'];
const OPTIONAL_SCRIPTS = new Set(['start', 'stop', 'restart']);

function scriptReport(input: CiInput, workflows: WorkflowInfo[]): { scripts: ScriptUse[]; findings: WorkflowFinding[] } {
  const scripts = input.scripts;
  if (!scripts) return { scripts: [], findings: [] };
  const known = new Set([...Object.keys(scripts), ...(input.scriptNames ?? [])]);
  const sites = stepSites(workflows);
  const findings = sites
    .filter((site) => !site.nested)
    .flatMap((site) => site.commands.filter((name) => !known.has(name) && !OPTIONAL_SCRIPTS.has(name)).map((name) => finding('missing-script', site.file, `Runs the script \`${name}\`, which package.json does not define`, { line: site.line, job: site.job })));
  const uses: ScriptUse[] = Object.entries(scripts).map(([name, command]) => ({
    name,
    command: safe(command, MAX_VALUE_LENGTH),
    runs: sites.filter((site) => scriptClosure(site.commands, scripts).has(name)).map((site) => ({ file: site.file, job: site.job, line: site.line })),
  }));
  const ciExists = workflows.some((w) => w.triggers.some((t) => t.event === 'push' || t.event === 'pull_request'));
  if (ciExists) {
    for (const use of uses.filter((u) => SCRIPTS_CI_SHOULD_RUN.includes(u.name) && !u.runs.length)) findings.push(finding('script-not-in-ci', '.github/workflows', `\`${use.name}\` is defined in package.json but no workflow runs it`));
  }
  return { scripts: uses, findings };
}

function nodeFindings(input: CiInput, workflows: WorkflowInfo[]): { versions: string[]; findings: WorkflowFinding[] } {
  const findings: WorkflowFinding[] = [];
  const all = new Set<string>();
  for (const workflow of workflows) {
    for (const version of workflow.nodeVersions ?? []) all.add(version);
    for (const job of workflow.jobs) {
      const line = job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'))?.line;
      for (const version of job.nodeVersions ?? []) {
        const major = nodeMajor(version);
        if (major !== undefined && isNodeEndOfLife(major, input.now)) findings.push(finding('node-eol', workflow.file, `Uses Node.js ${version}, which has reached end of life`, { job: job.id, line }));
      }
    }
  }
  const tested = [...all].flatMap((v) => nodeMajor(v) ?? []);
  const oldest = input.nodeEngine ? oldestEngineMajor(input.nodeEngine) : undefined;
  if (oldest !== undefined && tested.length && Math.min(...tested) > oldest) {
    findings.push(finding('node-engines-gap', 'package.json', `\`engines.node\` allows Node.js ${oldest}+ but CI tests ${[...new Set(tested)].sort((a, b) => a - b).join(', ')}`));
  }
  return { versions: [...all].sort(), findings };
}

function dependabotFindings(dependabot: CiReport['dependabot'], actions: ActionUse[]): WorkflowFinding[] {
  const external = actions.some((a) => a.kind === 'marketplace');
  if (!dependabot || !external || dependabot.ecosystems.some((e) => e.name === 'github-actions')) return [];
  return [finding('dependabot-no-actions', dependabot.file, 'Dependabot does not update `github-actions`')];
}

/** All workflows of a repository: the model, how actions are used, script and runtime checks and every finding. */
export function buildCiReport(input: CiInput): CiReport {
  const parsed = input.workflows.map((w) => parseWorkflow(w.path, w.text));
  const workflows = parsed.map((p) => p.workflow).sort((a, b) => a.file.localeCompare(b.file));
  const actions = aggregateActions(workflows);
  const dependabot = input.dependabot ? parseDependabot(input.dependabot.file, input.dependabot.text) : undefined;
  const scripts = scriptReport(input, workflows);
  const node = nodeFindings(input, workflows);
  const findings = [
    ...parsed.flatMap((p) => p.findings),
    ...missingLocalFindings(workflows, input.fileExists),
    ...workflowRunFindings(workflows),
    ...scripts.findings,
    ...node.findings,
    ...dependabotFindings(dependabot, actions),
  ].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  return defined({ base: input.base, workflows, actions, localActions: localActions(input, actions), scripts: scripts.scripts, findings, dependabot, nodeVersions: node.versions });
}
