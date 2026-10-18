/**
 * `check --format gitlab` / `--gitlab <file>`: a GitLab Code Quality report (Code Climate JSON subset),
 * shown in the merge request widget on every GitLab tier. GitLab compares the reports of the base and
 * the merge request itself, so every current finding is listed; fingerprints must be unique.
 */
import { ruleDescriptor } from '../../shared/rules-catalog.js';
import type { CheckResult, Finding } from '../../shared/types.js';

export type GitlabSeverity = 'info' | 'minor' | 'major' | 'critical' | 'blocker';

export interface GitlabIssue {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: GitlabSeverity;
  location: { path: string; lines: { begin: number } };
}

/** error → major (architecture errors: critical), warning → minor, note → info. */
export function gitlabSeverity(f: Pick<Finding, 'ruleId' | 'severity'>): GitlabSeverity {
  if (f.severity === 'note') return 'info';
  if (f.severity === 'warning') return 'minor';
  return ruleDescriptor(f.ruleId).category === 'architecture' ? 'critical' : 'major';
}

export function gitlabIssues(result: CheckResult, options: { prefix?: string } = {}): GitlabIssue[] {
  const seen = new Map<string, number>();
  const issues: GitlabIssue[] = [];
  for (const f of result.gates.flatMap((g) => g.findings)) {
    if (!f.file) continue;
    // The same finding twice (a multiset) gets its occurrence number, so fingerprints stay unique.
    const occurrence = seen.get(f.fingerprint) ?? 0;
    seen.set(f.fingerprint, occurrence + 1);
    issues.push({
      description: f.message,
      check_name: f.ruleId,
      fingerprint: `${f.fingerprint}-${occurrence}`,
      severity: gitlabSeverity(f),
      location: { path: `${options.prefix ?? ''}${f.file}`.replace(/^\.\//, ''), lines: { begin: Math.max(1, f.line ?? 1) } },
    });
  }
  return issues;
}

/** The report text: plain UTF-8 JSON (no BOM). */
export function gitlabReport(result: CheckResult, options: { prefix?: string } = {}): string {
  return `${JSON.stringify(gitlabIssues(result, options), null, 2)}\n`;
}
