import path from 'node:path';
import pc from 'picocolors';
import { AnalyzeError } from '../../analyzer/errors.js';
import type { CiReport, WorkflowFinding, WorkflowInfo, WorkflowSeverity } from '../../shared/types.js';
import { jobLevels, triggerFilters, workflowMermaid } from '../../shared/workflow-forecast.js';
import { VERSION } from '../../version.js';
import { getReport } from '../engine.js';
import { createLinker, emitOutput, plural, safeText, type Linker } from '../format.js';
import { explicitRoot, isTTY, parseCommandArgs, persistFrom, Progress, resolveProjectRoot, STAGE_LABELS, UsageError, type Command } from '../shared.js';

const HELP = `
${pc.bold('Usage')}
  $ code-visualizer actions [root] [options]

  The GitHub Actions workflows in .github/workflows: when each one runs, how its
  jobs depend on each other, and what is wrong with them (text a stranger can
  inject into a script, third-party actions that are not pinned, missing
  permissions, scripts that do not exist, Node.js versions past end of life).
  The files are read on this machine; nothing is sent to GitHub.

${pc.bold('Options')}
      --workflow <name>    Only this workflow (its file name or its name)
      --mermaid            Print the job graph of one workflow as a Mermaid
                           flowchart, to paste into a README or an issue
  -o, --output <path>      Write the --mermaid text to a file
      --copy               Copy the --mermaid text to the clipboard
      --check              Exit with code 1 when a workflow has an error (for CI)
      --json               Machine-readable output
      --root <dir>         Project root (default: the project around the current folder)
      --no-cache           Analyze from scratch: skip the warm cache and a running server
  -q, --quiet              Only print the summary line
  -h, --help               Show this help

  The rules are the common ones (the ones actionlint and zizmor also find), so
  they are hints, not a replacement for those tools.

${pc.bold('Examples')}
  $ npx code-visualizer actions
  $ npx code-visualizer actions --workflow ci --mermaid --copy
  $ npx code-visualizer actions --check
`;

/** Findings listed per workflow before "+N more". */
const MAX_FINDINGS_PER_WORKFLOW = 8;

const EMPTY_REPORT: CiReport = { base: '', workflows: [], actions: [], localActions: [], scripts: [], findings: [], nodeVersions: [] };
const SEVERITY_ORDER: Record<WorkflowSeverity, number> = { error: 0, warning: 1, info: 2 };
const SEVERITY_MARK: Record<WorkflowSeverity, string> = { error: pc.red('✖'), warning: pc.yellow('!'), info: pc.dim('·') };

const count = (findings: WorkflowFinding[], severity: WorkflowSeverity): number => findings.filter((f) => f.severity === severity).length;

/** A workflow by file name (`ci.yml`, `ci`) or by its name (`CI`). */
function findWorkflows(workflows: WorkflowInfo[], query: string): WorkflowInfo[] {
  const wanted = query.toLowerCase();
  return workflows.filter((w) => [w.file, path.basename(w.file), path.basename(w.file, path.extname(w.file)), w.name].some((candidate) => candidate.toLowerCase() === wanted));
}

/** `push (branches main), pull_request (2 path filters)` */
function triggersText(workflow: WorkflowInfo): string {
  if (!workflow.triggers.length) return 'never (no trigger)';
  return workflow.triggers
    .map((trigger) => {
      const filters = triggerFilters(trigger);
      return filters.length ? `${trigger.event} (${filters.join('; ')})` : trigger.event;
    })
    .join(', ');
}

/** `lint, test → build → deploy`: the jobs in the order they start. */
const jobsText = (workflow: WorkflowInfo): string => jobLevels(workflow.jobs).map((level) => level.join(', ')).join(' → ');

function printFinding(finding: WorkflowFinding, link: Linker, out: (line?: string) => void): void {
  const where = link(finding.file, finding.line, `${path.basename(finding.file)}${finding.line ? `:${finding.line}` : ''}`);
  const job = finding.job ? `${finding.job}: ` : '';
  out(`    ${SEVERITY_MARK[finding.severity]} ${pc.dim(where)}  ${safeText(`${job}${finding.message}`)}`);
}

function printFindings(findings: WorkflowFinding[], link: Linker, out: (line?: string) => void): void {
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  for (const finding of sorted.slice(0, MAX_FINDINGS_PER_WORKFLOW)) printFinding(finding, link, out);
  if (sorted.length > MAX_FINDINGS_PER_WORKFLOW) out(`    ${pc.dim(`+${sorted.length - MAX_FINDINGS_PER_WORKFLOW} more (use --json for all)`)}`);
}

export const actionsCommand: Command = {
  name: 'actions',
  summary: 'GitHub Actions: when workflows run, how jobs connect, what is wrong with them',
  async run({ argv, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseCommandArgs('actions', argv, {
        workflow: { type: 'string' },
        mermaid: { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        copy: { type: 'boolean' },
        check: { type: 'boolean' },
        json: { type: 'boolean' },
        root: { type: 'string' },
        'no-cache': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      });
    } catch (error) {
      stderr.write(`${pc.red('✖')} ${(error as Error).message}\n`);
      return 2;
    }
    const { values, positionals } = parsed;
    if (values.help) {
      stdout.write(HELP);
      return 0;
    }
    const usage = (message: string): number => {
      stderr.write(`${pc.red('✖')} ${message}\n`);
      return 2;
    };
    if ((values.output || values.copy) && !values.mermaid) return usage('--output and --copy write the Mermaid text: add --mermaid.');
    if (values.mermaid && values.json) return usage('Use either --mermaid or --json.');
    if (positionals.length > 1) return usage(`actions takes one project root (got ${positionals.join(' ')}).`);
    let root: string;
    try {
      root = resolveProjectRoot(process.cwd(), explicitRoot(values, positionals)).root;
    } catch (error) {
      if (error instanceof UsageError) return usage(error.message);
      throw error;
    }

    const progress = new Progress(stderr, isTTY(stderr) && !values.quiet && !values.json && !values.mermaid);
    let ci: CiReport | undefined;
    try {
      const data = await getReport({
        root,
        includeSource: false,
        history: false,
        changes: false,
        ci: true,
        persist: persistFrom(values['no-cache']),
        toolVersion: VERSION,
        onProgress: (stage) => progress.update(STAGE_LABELS[stage]),
      });
      ci = data.ci;
    } catch (error) {
      progress.stop();
      if (error instanceof AnalyzeError) {
        stderr.write(`${pc.red('✖')} ${error.message}\n`);
        return 1;
      }
      throw error;
    }
    progress.stop();

    const report = ci ?? EMPTY_REPORT;
    let workflows = report.workflows;
    if (values.workflow) {
      workflows = findWorkflows(report.workflows, values.workflow);
      if (!workflows.length) return usage(`No workflow "${safeText(values.workflow)}".${report.workflows.length ? ` Found: ${report.workflows.map((w) => path.basename(w.file)).join(', ')}.` : ' There are no workflows in .github/workflows.'}`);
    }
    const files = new Set(workflows.map((w) => w.file));
    // A selected workflow keeps its own findings; the ones about the whole setup (Dependabot, scripts no job runs) go with all of them.
    const findings = values.workflow ? report.findings.filter((f) => files.has(f.file)) : report.findings;
    const errors = count(findings, 'error');
    const failed = values.check && errors > 0 ? 1 : 0;
    const out = (line = ''): void => void stdout.write(`${line}\n`);

    if (values.json) {
      out(JSON.stringify({ ok: errors === 0, ...report, workflows, findings }, null, 2));
      return failed;
    }
    if (values.mermaid) {
      if (workflows.length !== 1) return usage(workflows.length ? `--mermaid draws one workflow: pick one with --workflow (${workflows.map((w) => path.basename(w.file)).join(', ')}).` : 'There are no workflows to draw.');
      return (await emitOutput(workflowMermaid(workflows[0]), values, { stdout, stderr }, { quiet: values.quiet })) ? failed : 1;
    }

    if (!workflows.length) {
      out(`  ${pc.dim('No GitHub Actions workflows found (.github/workflows).')}`);
      return 0;
    }
    const jobs = workflows.reduce((total, w) => total + w.jobs.length, 0);
    const warnings = count(findings, 'warning');
    const tips = count(findings, 'info');
    const verdict = findings.length ? `${plural(findings.length, 'finding')}: ${[plural(errors, 'error'), plural(warnings, 'warning'), plural(tips, 'tip')].filter((part) => !part.startsWith('0 ')).join(', ')}` : 'no findings';
    out();
    out(`  ${pc.bold('GitHub Actions')} ${pc.dim(`· ${plural(workflows.length, 'workflow')} · ${plural(jobs, 'job')} · ${verdict}`)}`);

    if (!values.quiet) {
      const link: Linker = report.base ? (file, _line, label) => safeText(label ?? file) : createLinker({ root, stream: stdout });
      for (const workflow of workflows) {
        out();
        out(`  ${pc.bold(safeText(workflow.name))} ${pc.dim(workflow.file)}`);
        if (workflow.error) {
          out(`    ${SEVERITY_MARK.error} ${pc.red(`Not valid YAML (line ${workflow.error.line}): ${safeText(workflow.error.message)}`)}`);
          continue;
        }
        out(`    ${pc.dim('runs on')} ${safeText(triggersText(workflow))}`);
        out(`    ${pc.dim('jobs   ')} ${safeText(jobsText(workflow))}`);
        printFindings(findings.filter((f) => f.file === workflow.file), link, out);
      }
      const general = findings.filter((f) => !workflows.some((w) => w.file === f.file));
      if (general.length) {
        out();
        out(`  ${pc.bold('Across workflows')}`);
        printFindings(general, link, out);
      }
      out();
      out(`  ${pc.dim('Draw one:')} ${pc.cyan('code-visualizer actions --workflow <name> --mermaid')}`);
    }
    out();
    return failed;
  },
};
