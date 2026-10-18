/**
 * Programmatic API of code-visualizer.
 *
 * @example
 * import { analyze, writeReport } from 'code-visualizer';
 * const data = await analyze({ root: process.cwd() });
 * writeReport(data, '.code-visualizer/report.html');
 */
export { analyze, AnalyzeError, createAnalyzeCache } from './analyzer/index.js';
export type { AnalyzeCache, AnalyzeCacheEntry, AnalyzeOptions, AnalyzeStage } from './analyzer/index.js';
export { clearDiskCache, loadDiskCache, saveDiskCache } from './analyzer/disk-cache.js';
export { readState, updateState } from './analyzer/state.js';
export { loadConfig } from './analyzer/config.js';
export { compareReports } from './analyzer/compare.js';
export type { CompareOptions } from './analyzer/compare.js';
/** Developer tools: `.env.example` generator, release notes with the suggested version, cycle-cutting plans, license risk. */
export { envExampleText, envStatus } from './shared/env.js';
export { releaseNotesMarkdown } from './shared/release.js';
export { planCycleFix } from './shared/cycles.js';
export { licenseRisk } from './shared/licenses.js';
export { clearSnapshotCache, configAt, overlayForIndex, overlayForRef, renamesSince, snapshotAt, toSnapshot } from './analyzer/snapshot.js';
export type { Overlay, SnapshotOptions } from './analyzer/snapshot.js';
export type { ReadText } from './analyzer/readtext.js';
export type { CheckConfig, CodeVisualizerConfig, NotifyMode, RuleConfig, ServeConfig } from './analyzer/config.js';
export { diffLive, LIVE_DETECTORS, LiveGuard } from './analyzer/live-events.js';
export type { LiveCandidate, LiveContext, LiveDetector, LiveGuardOptions } from './analyzer/live-events.js';
export { renderReportHtml, writeReport } from './report/html.js';
export { serve } from './server/index.js';
export type { LiveServer, ServeOptions } from './server/index.js';
export { createEngine } from './server/engine.js';
export type { Engine, EngineOptions, EngineUpdate } from './server/engine.js';
export { connectToServer, getReport, probeServer } from './cli/engine.js';
export type { GetReportOptions, ServerConnection, ServerProbe } from './cli/engine.js';
export { architectureDeltaMarkdown, deltaBaseLabel, fileContextMarkdown, prSummaryMarkdown, projectSummaryMarkdown } from './shared/markdown.js';
export { breakingExports, deltaFailures, deltaHighlights, isEmptyDelta, parseFailOn } from './shared/delta.js';
export { cycleKey, fingerprint, RULE_IDS, violationKey } from './shared/fingerprint.js';
/** Query core: `query.resolveTarget`, `query.impactOf`, `query.usesOf`, `query.whoOf`, `query.routeFor`, `query.testsFor`… */
export * as query from './shared/query.js';
export type { CallLink, Expert, ImpactOptions, ImpactResult, PathHop, PathResult, QueryData, QueryTarget, ResolveResult, RouteMatch, TestsForResult, UseSite, UsesResult, WhoOptions, WhoResult } from './shared/query.js';
export { buildTestCommand } from './shared/testcmd.js';
export type { TestRunners } from './shared/testcmd.js';
// --- new-only-gates ---
export { allFindings, DELTA_RULE_IDS, evaluateGates, GATE_PROVIDERS } from './analyzer/gates.js';
export { checkKeyWarnings, KNOWN_CHECK_KEYS } from './analyzer/config.js';
export { newInsightsOf } from './shared/new-findings.js';
export type { EvaluateOptions, GateContext, GateOutcome, GateProvider, Thresholds } from './analyzer/gates.js';
export { baselineFromFindings, DEFAULT_BASELINE_FILE, parseBaseline, ratchetBaseline, readBaseline, serializeBaseline, writeBaseline } from './analyzer/baseline.js';
export { ruleDescriptor, RULES_CATALOG } from './shared/rules-catalog.js';
export type { RuleDescriptor } from './shared/rules-catalog.js';
export { sarifReport } from './report/formats/sarif.js';
export { gitlabReport } from './report/formats/gitlab.js';
export { githubAnnotations } from './report/formats/github.js';
export { checkSummaryMarkdown } from './report/formats/summary.js';
export { PR_COMMENT_MARKER, prCommentMarkdown } from './report/formats/pr-comment.js';
// --- mcp-server ---
export { INSTRUCTIONS as MCP_INSTRUCTIONS, mcpAnalysisOptions, startMcpServer } from './mcp/server.js';
export type { McpServer, McpServerOptions } from './mcp/server.js';
export { TOOLS as MCP_TOOLS, selectTools } from './mcp/tools.js';
export { PROMPTS as MCP_PROMPTS, RESOURCES as MCP_RESOURCES } from './mcp/resources.js';
export { MCP_CLIENTS, mcpRegistration } from './mcp/clients.js';
export type { McpClient, McpRegistration, RegistrationOptions } from './mcp/clients.js';
export type { JsonRpcMessage, McpContext, PromptDef, ResourceDef, ToolDef, ToolResult } from './mcp/protocol.js';
export type { FileContextOptions } from './shared/markdown.js';
// --- test-intelligence ---
export { FULL_RUN_RE, isFullRunTrigger, manifestAffectsTests, planFiles, planSummary, selectTests, visitMatchesRoute } from './analyzer/test-select.js';
export type { SelectionData, SelectTestsOptions } from './analyzer/test-select.js';
export { coverageCandidates, fileCoverage, findReports, loadCoverage, parseIstanbul, parseLcov, parseReport, patchCoverage, patchCoverageGate, PATCH_COVERAGE_RULE, unmeasuredPackages } from './analyzer/coverage.js';
export { hasCoverageThresholds, playwrightTestDir } from './analyzer/tests.js';
export type { CoverageOptions, LoadedCoverage, ParsedReport, PatchCoverageOptions, RawFileCoverage } from './analyzer/coverage.js';
export { workingTreeId } from './analyzer/git.js';
export { argvDisplay, coverageFlag, execArgv, runnerArgv, runnerDirFor } from './shared/testcmd.js';
export { formatRanges, patchCoverageLine } from './shared/coverage.js';
export type { CoverageConfig } from './analyzer/config.js';
// --- review-mode ---
export { blobsAt, buildReviewPlan, fetchPullRequest, isValidRemoteName, listReviewRefs, parsePullRequestRef, pullRequestCandidates, pullRequestFetch, readReviewState, resolveReviewRef, reviewMergeBase, reviewStatePath, updateReviewState } from './analyzer/review.js';
export type { PullRequestRef, ResolvedReviewRef, ReviewOptions, ReviewStateUpdate } from './analyzer/review.js';
export { applyViewed, effortLabel, effortTime, independentChanges, meaningfulLines, readingOrder, reviewEffort, reviewPlan, setReadingOrder, suggestsSplit } from './shared/review.js';
export type { ReviewChanges, ReviewData, ReviewPlanOptions } from './shared/review.js';
export { reviewPathMarkdown, reviewPlanMarkdown } from './shared/markdown.js';
// --- daily-loop ---
export { analyzeSync, syncState, upstreamStatus } from './analyzer/sync.js';
export type { GitRunner, SyncOptions, UpstreamStatus } from './analyzer/sync.js';
export { hygieneFindings, hygieneGate } from './analyzer/hygiene.js';
export { buildStatus, formatStatus, STATUS_FORMATS } from './shared/status.js';
export type { StatusContext, StatusFormat } from './shared/status.js';
// --- agent-guardrails ---
export { allowedAlternatives, applyEdits, findingFingerprints, POST_EDIT_DETECTORS, postEditFindings, preEditFindings } from './agent/guard.js';
export type { Alternative, GuardOptions, PostEditContext, PostEditDetector, PostEditOptions } from './agent/guard.js';
export { DIALECTS, HOOK_EVENTS, parseApplyPatch, parseHookInput, renderHookOutput } from './agent/dialect.js';
export type { Dialect, FileChange, HookEdit, HookEvent, HookInput, HookOutput, HookResult } from './agent/dialect.js';
export { runHook } from './agent/hooks.js';
export type { HookContext } from './agent/hooks.js';
export { AGENT_CLIENTS, applyWrites, cliCommand, detectAgents, parseLaunch, planInit, planRemove, registeredHooks, registeredMcp } from './agent/setup.js';
export type { AgentClient, AgentsState, HooksMode, InitOptions, Launch, PlannedWrite, RemoveOptions } from './agent/setup.js';
export { lastTestCovers, transcriptCovers } from './agent/stop-gate.js';
export { agentsBlockMarkdown, managedBlockProblem, removeManagedBlock, sessionBriefMarkdown, upsertManagedBlock } from './shared/markdown.js';
export type { AgentsBlockOptions, SessionBriefOptions } from './shared/markdown.js';
export { runCli } from './cli/run.js';
export { VERSION } from './version.js';
export * from './shared/types.js';
// --- clone-radar ---
export { canonicalCallable, cloneDetector, cloneSettings, cloneTokens, clonesGate, CloneTokenStore, DEFAULT_CLONE_SETTINGS, detectClones, findSimilar, projectClones, similarTo, sliceTokens, snippetTokens, symbolLines, unitsOf } from './analyzer/clones.js';
export type { CloneSettings, CloneSource, CloneTokens, CloneUnit, FindSimilarOptions, ProjectClones, SimilarAnswer, SimilarRequest } from './analyzer/clones.js';
export { cloneDelta, cloneDrift, cloneFingerprint, cloneSides, driftMessage, familiesOf, fragmentKey, fragmentLocation, isSignificant, newCloneMessage, pastedClones, reuseAdvice, significantCopies } from './shared/clones.js';
export type { CloneConfig } from './analyzer/config.js';
