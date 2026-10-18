/**
 * Programmatic API of code-visualizer.
 *
 * @example
 * import { analyze, writeReport } from 'code-visualizer';
 * const data = await analyze({ root: process.cwd() });
 * writeReport(data, '.code-visualizer/report.html');
 */
export { analyze, AnalyzeError } from './analyzer/index.js';
export type { AnalyzeOptions, AnalyzeStage } from './analyzer/index.js';
export { renderReportHtml, writeReport } from './report/html.js';
export { runCli } from './cli/run.js';
export { VERSION } from './version.js';
export * from './shared/types.js';
