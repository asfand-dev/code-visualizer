/**
 * `check --format sarif` / `--sarif <file>`: SARIF 2.1.0 for GitHub code scanning and other viewers.
 * Deterministic (no timestamps), so the same analysis always gives the same bytes. Every result carries
 * `partialFingerprints` (no line numbers) and, when compared with a base, its `baselineState`.
 */
import { ruleDescriptor, RULES_CATALOG, type RuleDescriptor } from '../../shared/rules-catalog.js';
import type { CheckResult, Finding } from '../../shared/types.js';

export const SARIF_MAX_RESULTS = 25_000;
export const SARIF_MAX_LOCATIONS = 1_000;
const FINGERPRINT_KEY = 'codeVisualizer/v1';

export interface SarifOptions {
  /** Tool version for `driver.version`. */
  version: string;
  /** Path of the analyzed root inside the repository (`git rev-parse --show-prefix`), e.g. `packages/app/`. */
  prefix?: string;
}

/** A relative URI reference for a project path: each segment percent-encoded, `/` kept. */
export function sarifUri(file: string, prefix = ''): string {
  return `${prefix}${file}`
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function level(f: Finding): 'error' | 'warning' | 'note' {
  return f.severity;
}

function reportingDescriptor(r: RuleDescriptor) {
  return {
    id: r.id,
    name: r.name,
    shortDescription: { text: r.shortDescription },
    fullDescription: { text: r.fullDescription },
    help: { text: r.help.replace(/`/g, ''), markdown: r.help },
    defaultConfiguration: { level: r.level },
    properties: { tags: [...new Set(['maintainability', r.category])], precision: r.precision ?? 'very-high' },
  };
}

function location(file: string, line: number | undefined, prefix: string, id?: number) {
  return {
    ...(id !== undefined ? { id } : {}),
    physicalLocation: {
      artifactLocation: { uri: sarifUri(file, prefix), uriBaseId: '%SRCROOT%' },
      region: { startLine: Math.max(1, Math.floor(line ?? 1)) },
    },
  };
}

/** The files a finding is about besides its own (the other members of a cycle). */
function relatedFiles(f: Finding): string[] {
  if (f.ruleId !== 'cv/cycle') return [];
  return f.subject.split(' → ').filter((m) => m && m !== f.file);
}

/** The SARIF log as an object (see `sarifReport` for the text). */
export function sarifLog(result: CheckResult, options: SarifOptions) {
  const prefix = options.prefix ?? '';
  const findings = result.gates.flatMap((g) => g.findings).filter((f) => f.file);
  // Every catalog rule (stable indexes), then rules other gates reported, sorted.
  const rules = [...RULES_CATALOG];
  const known = new Set(rules.map((r) => r.id));
  for (const id of [...new Set(findings.map((f) => f.ruleId))].sort()) if (!known.has(id)) rules.push(ruleDescriptor(id));
  const index = new Map(rules.map((r, i) => [r.id, i]));
  const compared = result.mode !== 'all';
  const results = findings.slice(0, SARIF_MAX_RESULTS).map((f) => {
    const related = relatedFiles(f).slice(0, SARIF_MAX_LOCATIONS);
    return {
      ruleId: f.ruleId,
      ruleIndex: index.get(f.ruleId)!,
      level: level(f),
      message: { text: f.message },
      locations: [location(f.file, f.line, prefix)],
      ...(related.length ? { relatedLocations: related.map((file, i) => location(file, undefined, prefix, i + 1)) } : {}),
      partialFingerprints: { [FINGERPRINT_KEY]: f.fingerprint },
      // An old finding your change made worse is `updated`: code scanning keeps its alert, not a new one.
      ...(compared && f.status ? { baselineState: f.worsened ? 'updated' : f.status === 'new' ? 'new' : 'unchanged' } : {}),
      properties: { gate: f.gate, ...(f.onChangedLine ? { onChangedLine: true } : {}) },
    };
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'code-visualizer',
            version: options.version,
            semanticVersion: options.version,
            informationUri: 'https://www.npmjs.com/package/code-visualizer',
            rules: rules.map(reportingDescriptor),
          },
        },
        automationDetails: { id: 'code-visualizer/' },
        columnKind: 'utf16CodeUnits',
        results,
        ...(findings.length > SARIF_MAX_RESULTS ? { properties: { truncated: findings.length - SARIF_MAX_RESULTS } } : {}),
      },
    ],
  };
}

export function sarifReport(result: CheckResult, options: SarifOptions): string {
  return `${JSON.stringify(sarifLog(result, options), null, 2)}\n`;
}
