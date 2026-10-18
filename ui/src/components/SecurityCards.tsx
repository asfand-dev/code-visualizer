import { useMemo, useState } from 'react';
import { RISK_RULES, SEVERITY_ORDER } from '../../../src/shared/risks';
import { basename, fmtNum } from '../lib/format';
import { selectFile } from '../state/store';
import type { FileInfo, RiskFinding, RiskRule, RiskSeverity, TypeEscapes } from '../types';
import { Segmented, Toggle } from './ui';

type SeverityFilter = 'all' | RiskSeverity;

const SEVERITY_TONE: Record<RiskSeverity, string> = { high: 'danger', medium: 'warn', low: 'info' };
/** Findings shown per rule before "+N more"; the list in the report is capped anyway. */
const FINDINGS_PER_RULE = 12;
const FILES_LISTED = 20;

function FindingRow({ finding }: { finding: RiskFinding }) {
  return (
    <button className="list-item" onClick={() => selectFile(finding.file, finding.line)} title={`${finding.file}:${finding.line}`}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="row nowrap small" style={{ gap: 6 }}>
          <span className="mono" style={{ fontWeight: 600 }}>
            {basename(finding.file)}:{finding.line}
          </span>
          {finding.test && <span className="badge">test</span>}
          {finding.detail && <span className="tiny muted truncate">{finding.detail}</span>}
        </div>
        <div className="tiny faint mono truncate">{finding.snippet}</div>
      </div>
    </button>
  );
}

function RuleGroup({ rule, findings }: { rule: RiskRule; findings: RiskFinding[] }) {
  const info = RISK_RULES[rule];
  return (
    <div style={{ padding: '6px 4px 10px' }}>
      <div className="row nowrap" style={{ gap: 8, padding: '0 8px' }}>
        <span className={`badge ${SEVERITY_TONE[info.severity]}`}>{info.severity}</span>
        <b className="small">{info.title}</b>
        <span className="faint num small">({findings.length})</span>
      </div>
      <div className="tiny muted" style={{ padding: '2px 8px 4px' }}>
        {info.advice}
      </div>
      {findings.slice(0, FINDINGS_PER_RULE).map((f) => (
        <FindingRow key={`${f.file}:${f.line}:${f.rule}`} finding={f} />
      ))}
      {findings.length > FINDINGS_PER_RULE && <div className="tiny faint" style={{ padding: '4px 12px' }}>+{findings.length - FINDINGS_PER_RULE} more</div>}
    </div>
  );
}

/** Hardcoded secrets, injection sinks and the like, grouped by rule with the advice. Snippets are already masked. */
export function SecurityFindings({ risks, omitted }: { risks: RiskFinding[]; omitted?: number }) {
  const [severity, setSeverity] = useState<SeverityFilter>('all');
  const [withTests, setWithTests] = useState(false);
  const testCount = risks.filter((r) => r.test).length;
  const groups = useMemo(() => {
    const byRule = new Map<RiskRule, RiskFinding[]>();
    for (const risk of risks) {
      if ((!withTests && risk.test) || (severity !== 'all' && risk.severity !== severity)) continue;
      byRule.set(risk.rule, [...(byRule.get(risk.rule) ?? []), risk]);
    }
    return [...byRule.entries()].sort((a, b) => SEVERITY_ORDER[RISK_RULES[a[0]].severity] - SEVERITY_ORDER[RISK_RULES[b[0]].severity] || b[1].length - a[1].length);
  }, [risks, severity, withTests]);

  return (
    <>
      <div className="row" style={{ gap: 12, padding: '4px 8px 8px', flexWrap: 'wrap' }}>
        <Segmented
          value={severity}
          onChange={setSeverity}
          options={[
            { value: 'all', label: 'All' },
            { value: 'high', label: `High (${risks.filter((r) => r.severity === 'high' && (withTests || !r.test)).length})` },
            { value: 'medium', label: `Medium (${risks.filter((r) => r.severity === 'medium' && (withTests || !r.test)).length})` },
          ]}
        />
        {testCount > 0 && <Toggle checked={withTests} onChange={setWithTests} label={`Tests and fixtures (${testCount})`} title="Fake credentials and unsafe snippets are normal in tests; they are hidden unless you ask" />}
      </div>
      {groups.map(([rule, findings]) => (
        <RuleGroup key={rule} rule={rule} findings={findings} />
      ))}
      {!groups.length && <div className="muted small" style={{ padding: '14px 12px' }}>No findings here{testCount && !withTests ? `; ${testCount} in tests are hidden` : ''}.</div>}
      {!!omitted && <div className="tiny faint" style={{ padding: '4px 12px' }}>+{fmtNum(omitted)} more findings are not listed.</div>}
      <div className="tiny faint" style={{ padding: '8px 12px' }}>A pattern scan of the syntax tree, not a security audit: it finds the obvious mistakes. Secrets are shown masked.</div>
    </>
  );
}

const ESCAPE_LABELS: [keyof TypeEscapes, string, string][] = [
  ['any', 'any', 'Explicit "any": the compiler stops checking'],
  ['nonNull', '!', 'Non-null assertions: "trust me, it is not undefined"'],
  ['tsIgnore', '@ts-ignore', 'Hides every error on the next line; prefer @ts-expect-error'],
  ['tsExpectError', '@ts-expect-error', 'Fails when the error goes away, so it cannot rot'],
  ['lintDisable', 'eslint-disable', 'Lint rules switched off'],
];

const totalOf = (e: TypeEscapes): number => e.any + e.nonNull + e.tsIgnore + e.tsExpectError + e.lintDisable;

/** Where the code gives up on the type checker and the linter, per file. */
export function TypeEscapesTable({ files }: { files: FileInfo[] }) {
  const { rows, totals } = useMemo(() => {
    const totals: TypeEscapes = { any: 0, nonNull: 0, tsIgnore: 0, tsExpectError: 0, lintDisable: 0 };
    const rows: { file: FileInfo; escapes: TypeEscapes; total: number }[] = [];
    for (const file of files) {
      if (!file.escapes) continue;
      for (const [key] of ESCAPE_LABELS) totals[key] += file.escapes[key];
      rows.push({ file, escapes: file.escapes, total: totalOf(file.escapes) });
    }
    return { rows: rows.sort((a, b) => b.total - a.total || a.file.id.localeCompare(b.file.id)), totals };
  }, [files]);

  return (
    <>
      <div className="row" style={{ gap: 6, padding: '4px 8px 8px', flexWrap: 'wrap' }}>
        {ESCAPE_LABELS.map(([key, label, hint]) => (
          <span key={key} className="chip" title={hint} style={{ cursor: 'default' }}>
            <span className="mono">{label}</span> <b className="num">{fmtNum(totals[key])}</b>
          </span>
        ))}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>File</th>
            {ESCAPE_LABELS.map(([key, label]) => (
              <th key={key} className="num mono">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, FILES_LISTED).map(({ file, escapes }) => (
            <tr key={file.id} onClick={() => selectFile(file.id)} title={file.id}>
              <td>
                <span className="mono small" style={{ fontWeight: 600 }}>
                  {file.name}
                </span>
                <div className="tiny faint mono truncate">{file.dir}</div>
              </td>
              {ESCAPE_LABELS.map(([key]) => (
                <td key={key} className="num muted">
                  {escapes[key] || ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > FILES_LISTED && <div className="tiny faint" style={{ padding: '8px 12px' }}>+{rows.length - FILES_LISTED} more files</div>}
    </>
  );
}

export const hasTypeEscapes = (files: FileInfo[]): boolean => files.some((f) => f.escapes && totalOf(f.escapes) > 0);
