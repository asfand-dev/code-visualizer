# Contributing to code-visualizer

Thanks for helping! This guide gets you from a fresh clone to a working change in a few minutes.

## Setup

```bash
git clone https://github.com/asfand-ionos/code-visualizer.git
cd code-visualizer
npm install
npm run build        # builds the report UI and the CLI into dist/ (some tests read dist/report/index.html)
npm test             # runs the test suite (Vitest)
```

Requirements: Node.js 22 or newer for development (the published CLI supports Node.js 20+). git ≥ 2.38 runs every `sync` test path.

Try your build on any project:

```bash
node dist/cli.js report ../some-project
node dist/cli.js report test/fixtures/react-vite-ts --no-git
node dist/cli.js serve ../some-project --port 0 --no-open   # live companion on a free port
node dist/cli.js check ../some-project --changed
node dist/cli.js impact formatDate --root ../some-project
node dist/cli.js pr ../some-project
node dist/cli.js mcp --print-config cursor
node dist/cli.js --help                                     # every command, grouped
```

The repository checks itself in CI with `node dist/cli.js check` (see `code-visualizer.config.json`): `ui/src` and `src/shared` may only import `src/shared`, and there must be no import cycles.

## Project layout

```text
src/
  analyzer/            Static analysis and everything that needs Node.js
    files.ts           File discovery (git ls-files / glob, ignores)
    project.ts         package.json, frameworks, workspaces, tsconfig paths, aliases, sub-projects
    config.ts          code-visualizer.config.json: one block of keys per feature, normalizeConfig
    readtext.ts        File access with a snapshot override (another ref, the index, an edit)
    parse.ts           Per-file parsing with the TypeScript parser (+ Vue/Svelte/Astro), call sites, tokens
    resolve.ts         Module resolution (relative, paths, aliases, workspaces, packages)
    routes.ts          File-system routes (Next.js, Nuxt, SvelteKit, Remix, Astro)
    apimap.ts          Links HTTP calls in client code to the routes that serve them
    classify.ts        File kinds (component, hook, service, …)
    graph.ts           Graph algorithms (cycles, PageRank, reachability)
    git.ts             History, authors, activity, change coupling, diffs, blame, ref validation
    repo-state.ts      HEAD, refs, index mtime and last fetch read straight from .git (no git process)
    changes.ts         Your changes: changed symbols, impact, tests, reviewers, risk, reading order
    tests.ts           Test map (which tests reach which files), runners per workspace
    test-select.ts     Affected-test selection and runner commands (`test`)
    coverage.ts        istanbul / lcov reports, line and patch coverage, the patch-coverage gate
    clones.ts          Token index, clone families, find-similar, the clones gate and live detector
    owners.ts          CODEOWNERS
    health.ts          Health score, improvements, history.json
    insights.ts        Folder summaries, onboarding tour, package health
    tours.ts           CodeTour files in .tours/
    overlay.ts         Overlays of a ref / the index, the snapshot store
    snapshot.ts        snapshotAt, overlayForRef, overlayForIndex, configAt, renamesSince
    compare.ts         compareReports → ArchitectureDelta (pure)
    gates.ts           Quality gates: GATE_PROVIDERS, evaluateGates (pure)
    baseline.ts        code-visualizer.baseline.json (read, write, ratchet)
    hygiene.ts         Focused tests, debugger, conflict markers in added lines (a gate provider)
    live-events.ts     Live guard: LIVE_DETECTORS, diffLive, LiveGuard
    review.ts          Review mode: analyze a ref, resolve #123 / !45, viewed state
    sync.ts            Sync forecast: trial merge, overlap, semantic breaks
    disk-cache.ts      The signed parse / git cache in .code-visualizer/cache
    state.ts           .code-visualizer/state.json sections, server.json, atomic writes
    errors.ts          AnalyzeError
    repo.ts            Git insights: branches, stashes, worktrees, lost commits, hygiene, settings (`data.repo`)
    workflows.ts       GitHub Actions: reads .github/ and builds `data.ci` (rules live in shared/workflows.ts)
    ai.ts              Claude Code tools: skills, commands, agents, MCP, hooks, plugins (`data.ai`)
    index.ts           analyze(): orchestrates everything and produces ReportData
  server/              The live companion (`serve`)
    engine.ts          The warm engine: cache, re-analysis queue, listeners, whatIf
    watch.ts           File and folder watching (recursive or per folder on Linux)
    client.ts          A light client for a running serve (server.json discovery, ping, data)
    index.ts           HTTP + SSE, endpoints, token, editor launch
    daily-loop.ts      GET /api/status and /api/sync
    review.ts          GET /api/review, /api/review-state, /api/review-refs
    git-tools.ts       /api/git/*: history search, commit details, standup, delete merged branches
  mcp/                 The MCP server (`mcp`)
    protocol.ts        JSON-RPC, tool/resource/prompt shapes, argument validation, output budgets
    server.ts          The stdio server (sessions, stateless requests, progress, cancellation)
    source.ts          Where answers come from: a running serve or a lazy engine
    tools.ts           The TOOLS registry and most tools
    symbols.ts · changes.ts · architecture.ts · similar.ts   Larger tools
    resources.ts       Resources and prompts
    paths.ts           Keeps path arguments inside the project
    specifier.ts       Import specifiers (`@/lib/db`) → project paths without the analyzer
    clients.ts         Registration snippets per client (`--print-config`)
    format.ts          Shared answer helpers
  agent/               AI-agent guardrails (`hook`, `agents`)
    dialect.ts         Claude Code / Cursor / Codex hook input and output (pure)
    hooks.ts           session-start, pre-edit, post-edit, stop
    guard.ts           Pre-edit and post-edit findings, POST_EDIT_DETECTORS (pure)
    session.ts         .code-visualizer/sessions/<id>.json
    stop-gate.ts       Does a passing test run cover the session's changes? (pure)
    setup.ts           agents init / remove / doctor planning
  report/
    html.ts            Embeds ReportData (gzip + base64) into the UI template
    formats/           sarif.ts, gitlab.ts, github.ts, summary.ts, pr-comment.ts
  cli/
    run.ts             The lazy command registry, grouped help, "did you mean"
    shared.ts          Command interface, analysis options, project root, argument parsing
    engine.ts          getReport(): running serve → disk cache → cold
    format.ts          Terminal output: editor links, trees, terminal-safe text
    hooks-install.ts   Git hook planning (husky, lefthook, simple-git-hooks, git)
    text-diff.ts       Unified diffs for previews
    notify.ts          Desktop notifications without a shell
    commands/          One file per command (query.ts holds who/uses/impact/path/route/tests-for)
  shared/              Pure modules (no Node APIs): also imported by the browser UI
    types.ts           The data contract between analyzer, CLI, server, MCP and UI
    query.ts           Query core: impact, uses, who, path, route, tests, test evidence
    markdown.ts        PR description, file context, project summary, delta, review, agent brief, AGENTS.md
    delta.ts · fingerprint.ts · rules-catalog.ts · new-findings.ts   Reading deltas and findings
    review.ts          Reading order, effort, split suggestions
    status.ts          Status snapshots and their formats
    clones.ts          Clone messages, delta and drift
    live.ts            Live event kinds and severity
    route-match.ts · testcmd.ts · coverage.ts · signature.ts · architecture.ts · scc.ts
    source-files.ts · terminal-safe.ts   Import-free helpers for hot paths
    git-insights.ts · git-commit.ts · git-recipes.ts   Git: branch and hygiene rules, commit lint and standup, the recipe catalog
    workflows.ts · workflow-forecast.ts · yaml.ts · cron.ts · package-scripts.ts   Workflow parsing and rules, job graph and run forecast, the small YAML reader
    ai.ts · ai-guide.ts   Claude Code items, readiness checks, the usage guide and templates
  index.ts             The public API
ui/                    The UI (React + Vite), built into ONE html file
  src/views/           One component per view (TodayView, ChangesView, GraphView, InsightsView, …)
  src/components/      Shared UI: detail panel, command palette, LiveFeed, IncomingCard, ReviewMode,
                       ArchitectureDelta, Clones, cytoscape canvas, companion widgets…
  src/state/           URL-synced store and personal state (pins, notes, tours)
  src/data/            Data loading, indices (model.ts) and the live connection (live.ts)
skills/code-visualizer/SKILL.md   The agent skill (`agents init --skill`), shipped in the package
test/                  Vitest suites and realistic fixture projects (test/fixtures/*)
packages/create-code-visualizer/   Thin wrapper that enables `npm create code-visualizer`
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the pipeline, the shared engines and the design decisions in more depth.

### Tests

Each area has its own suite in `test/`:

| Area | Suites |
| --- | --- |
| Parsing, resolution, frameworks | `parse`, `apimap`, `graph`, `owners`, `tours`, and one per fixture (`react-vite-ts`, `next-app`, `fullstack-next`, `express-api`, `nest-api`, `vue-app`, `sveltekit-app`) |
| Accuracy and health | `accuracy`, `health`, `rules` |
| Git and changes | `git-integration`, `git-diff`, `changes`, `base-ref`, `root-resolution` |
| Warm engine | `disk-cache`, `engine`, `engine-release`, `server` |
| Compare engine | `compare`, `snapshot`, `ui-diff` |
| Queries | `query`, `test-map` |
| Gates and CI | `gates`, `check-new`, `formats`, `markdown` |
| Live guard | `live-events` |
| Tests and coverage | `test-select`, `test-command`, `coverage` |
| Review | `review` |
| Daily loop | `status`, `sync`, `hooks-install` |
| Clones | `clones`, `similar-min` |
| MCP and agents | `mcp`, `agent-hooks`, `agents-setup` |
| CLI and output | `cli`, `report`, `release-fix-output`, `terminal-safe` |

`test/companion-helpers.ts` has the helpers for throwaway repositories: `makeTempDir`, `copyFixture`, `initRepo`, `commitAll`, `editFile`, `isolateGit`, `removeTempDirs`.

## Developing the UI

```bash
npm run dev
```

This analyzes this repository into `ui/dev-data.json` and starts Vite with hot reload at <http://localhost:5175>. To develop against another project:

```bash
node scripts/dev-data.mjs ../some-project && npx vite --config ui/vite.config.ts
```

Live-only features (live feed, Incoming, Reviewer mode, New only, blame, saving notes and tours, open in editor, updates) need the real server: run `npm run build` and `node dist/cli.js serve ../some-project`. The server keeps the UI template in memory, so restart it after rebuilding the UI. Check new cards in both themes and at phone width.

## Developing the analyzer

- Add or extend a fixture under `test/fixtures/<name>/` (fixtures are never installed or executed, only analyzed). Fixtures are separate sub-projects, so the repository's own analysis leaves them out.
- Add expectations in `test/<name>.test.ts` or unit tests in `test/parse.test.ts`.
- Features that need git history (changes, reviewers, risk, history, review, sync, gates) are tested against throwaway repositories in the OS temp directory, never against this repository's own history. Tests never touch the network or real agent configuration (`~/.claude`, `~/.cursor`, …): use a temp `HOME` when a test needs one.
- Run `npm run test:watch` while you work.
- Keep the analyzer fast: parse once per file, avoid type-checking, prefer maps over repeated scans. Measure with `node dist/cli.js report --no-open -q` or `stats.durationMs`; a warm re-analysis after a one-line edit should stay in the low hundreds of milliseconds on this repository.

### Conventions that keep features independent

- **`src/shared/` is pure.** No Node APIs and no imports from `src/analyzer` (the report UI imports it, and `code-visualizer check` enforces it). Put reusable logic there so the CLI, server, MCP, hooks and UI agree.
- **Types**: add new interfaces to `src/shared/types.ts`; only add *optional* fields to existing ones.
- **Configuration**: new keys go in `src/analyzer/config.ts` in their own block. `normalizeConfig` should accept the shorthand forms (string, list, object, `true`/`false`). New `check.*` keys go in `KNOWN_CHECK_KEYS` so a typo gets a warning.
- **State**: use `readState(root, '<section>')` / `updateState(root, '<section>', value)` from `src/analyzer/state.ts` with a section of your own; never write `.code-visualizer/state.json` directly.
- **Analysis options** that change what a running server holds must be added to `analysisFingerprint()` in `src/server/client.ts`, so `getReport()` never reuses data computed with other options. Overlay runs (`--staged`, another ref) bypass the server.
- **Git refs** from users go through `resolveCommit` in `src/analyzer/git.ts` (or `verifyCommit` in `src/analyzer/sync.ts`, its `GitRunner` twin); both reject option-like refs. Spawn processes with argument arrays, never a shell string.
- **Repository text in terminal output** goes through `src/cli/format.ts` (terminal-safe); JSON and Markdown stay exact.
- **No network** except explicit opt-in flags (`--fetch`), and **no new runtime dependencies**.

## Adding a command

1. Create `src/cli/commands/<name>.ts` and export a `Command`: `{ name, aliases?, summary, run(ctx) }`. `run` returns the exit code: 0 ok, 1 failure or nothing found, 2 usage error.
2. Parse flags with `parseCommandArgs(name, argv, options)` from `src/cli/shared.ts`. It refuses unknown options with a “Did you mean --…?” hint; catch its error, print it to stderr and return 2. Analyzing commands reuse `ANALYSIS_OPTIONS` / `analysisOptions()`, and find the project with `resolveProjectRoot()`, so every command accepts the same scoping options and `--root`.
3. Get the analysis with `getReport({ ...options, includeSource: false })` from `src/cli/engine.ts` (running serve → disk cache → cold run). Import the analyzer lazily (`await import(...)`) if the command can answer without it.
4. Support `--json` (one JSON value on stdout, no ANSI codes) and write diagnostics and progress to stderr.
5. Register it with **one line** in `COMMANDS` in `src/cli/run.ts`:

   ```ts
   { name: 'standup', group: 'Everyday', summary: 'What you did since yesterday', load: () => import('./commands/standup.js').then((m) => m.standupCommand) },
   ```

   `group` places it in `code-visualizer --help` (`Explore`, `Ask`, `Everyday`, `Review & CI`, `AI agents`, `Setup`); `brief` is an optional shorter help line (under 64 characters); `hidden: true` keeps it out of the list. The registry is lazy: `--help` and `--version` never load your module.
6. Write the help text in the style of the existing commands (Usage, a short description, Options, Examples; at most 80 columns) and add the command to the help-list test in `test/cli.test.ts`. The registry test checks that the descriptor's `name`, `aliases` and `summary` match the command.

## Adding a gate

Gates are providers in `src/analyzer/gates.ts`. A provider turns an analysis into findings with stable, line-free fingerprints; `evaluateGates` decides what is new, existing or fixed.

```ts
// src/analyzer/todos.ts
import type { GateProvider } from './gates.js';
import { fingerprint } from '../shared/fingerprint.js';

export const todoGate: GateProvider = (data, ctx) => {
  const max = (ctx.thresholds as { maxTodos?: number }).maxTodos;
  if (max === undefined) return undefined; // the gate is off
  const findings = data.files.flatMap((f) =>
    f.todos
      .filter(() => ctx.inScope(f.id))
      .map((t) => ({
        ruleId: 'cv/todo',
        gate: 'todos',
        file: f.id,
        line: t.line,
        message: `${t.tag}: ${t.text}`,
        severity: 'error' as const,
        subject: t.text,
        fingerprint: fingerprint('cv/todo', f.id, t.text), // never a line number
      })),
  );
  return { id: 'todos', label: 'TODOs', ok: findings.length <= max, detail: `${findings.length} (max ${max})`, findings };
};
```

1. Append it on its own line after the array: `GATE_PROVIDERS.push(todoGate);`.
2. Add a descriptor for the rule id to `RULES_CATALOG` in `src/shared/rules-catalog.ts` (name, description, help); SARIF, GitLab and the job summary read it.
3. Add the config key to `CheckConfig` and `KNOWN_CHECK_KEYS` in `src/analyzer/config.ts`, and a flag in `src/cli/commands/check.ts` if it needs one.
4. If “new” means something other than “not in the base's fingerprints”, answer `isNew` in the `GateOutcome`, or set `status: 'new'` on findings that are new by construction (like hygiene on added lines). Gates that judge themselves in every mode (health, risk) return `newOnly: false`.
5. Test it with `evaluateGates` on a fixture and on a temp repository with `check --changed`, and check the SARIF and GitLab output in `test/formats.test.ts`.

The fields of `Finding` and `GateResult` are in `src/shared/types.ts`; the built-in gates in `gates.ts`, `coverage.ts` (`patchCoverageGate`), `clones.ts` (`clonesGate`) and `hygiene.ts` (`hygieneGate`) are good templates.

## Adding an MCP tool

Tools are `ToolDef`s in the `TOOLS` array of `src/mcp/tools.ts`:

```ts
const ownersTool: ToolDef = {
  name: 'owners',
  title: 'Code owners',
  description: 'The CODEOWNERS owners of a file or folder. Use before asking for a review.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' }, ...COMMON_PROPERTIES }, required: ['path'], additionalProperties: false },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const data = await ctx.report();
    const where = projectPath(ctx.root, String(args.path)); // refuses paths that leave the project
    if ('error' in where) return toolError(where.error);
    // … answer with the query core (query.whoOf, query.resolveTarget …)
    return answer(markdown, formatOf(args), structured);
  },
};
TOOLS.push(ownersTool);
```

- Keep it read-only (`READ_ONLY` annotations) and a thin wrapper over the query core or the Markdown generators, so the CLI, the UI and the agent get the same answer.
- Accept `limit` and `response_format` (`COMMON_PROPERTIES`, `limitOf` / `formatOf` from `src/mcp/format.ts`), and stay within the concise / detailed budgets with `answer()` from `src/mcp/protocol.ts`.
- Pass every path argument through `projectPath(root, input)` from `src/mcp/paths.ts` (it refuses paths that leave the project), and return actionable errors with `toolError` and `notFoundText` (with “did you mean” suggestions).
- Fence repository text with `fence()` so the model reads it as data, and never include author emails.
- The server holds at most 9 tools today (the session brief, the AGENTS.md block and `agents doctor` list them); a new tool replaces one or raises the cap in `test/mcp.test.ts`. Add tests that run the tool through the server in `test/mcp.test.ts`.

## Adding a live event detector

The live guard in `serve` runs every function in `LIVE_DETECTORS` (`src/analyzer/live-events.ts`) on each update:

```ts
import type { LiveDetector } from './live-events.js';

const LIMIT = 500;
const locOf = (report: { files: { id: string; loc: number }[] }, id: string): number => report.files.find((f) => f.id === id)?.loc ?? 0;

export const largeFileDetector: LiveDetector = ({ prev, next, touched }) =>
  [...touched]
    .filter((id) => locOf(next, id) > LIMIT && locOf(prev, id) <= LIMIT)
    .map((id) => ({
      event: { kind: 'large-file', severity: 'warning', message: `${id} is now ${locOf(next, id)} lines`, files: [id], fingerprint: `large-file|${id}` },
      // A problem stays open (and quiet) while this holds; the guard closes it when it no longer does.
      stillOpen: (report) => locOf(report, id) > LIMIT,
    }));
```

1. Declare the new kind by adding a key to `interface LiveEventKinds` in your block of `src/shared/types.ts`, and append it to `LIVE_EVENT_KINDS` in `src/shared/live.ts`, so `serve.events.exclude` accepts it.
2. Append the detector: `LIVE_DETECTORS.push(largeFileDetector);`.
3. Detectors get `{ prev, next, delta, touched, config, broken }`: `delta` is `compareReports` limited to the touched files. Keep them cheap (a few milliseconds on a large repository): they run on every save.
4. Use the fingerprints from `src/shared/fingerprint.ts` when your event matches a gate's finding, so the feed and `check` agree on identity. `resolved`, `repeat`, `track` and `hold` on the candidate control fix announcements and repeats (see `LiveCandidate`).
5. Test it with `diffLive(prev, next, changed)` or a `LiveGuard` in `test/live-events.test.ts`.

Post-edit findings for agents follow the same pattern with `POST_EDIT_DETECTORS` in `src/agent/guard.ts`.

## Pull requests

1. Create a branch, keep changes focused.
2. `npm run typecheck && npm run build && npm test` must pass, and `node dist/cli.js check --changed` should too.
3. Describe what changed and, for UI changes, add a screenshot (light and dark).
4. Update `CHANGELOG.md` under *Unreleased*, and the README when a command, flag or config key changes.

## Releasing (maintainers)

```bash
npm version <patch|minor|major>        # bumps the root package
npm publish                             # publishes code-visualizer (runs typecheck, build and tests first)

cd packages/create-code-visualizer
npm version <same version>              # keep both packages in sync
# make sure "code-visualizer" in its dependencies points at the new version
npm publish                             # publishes create-code-visualizer
```

Both packages publish to the public npm registry (`publishConfig` is set), even if your machine uses a private registry by default. `npm pack --dry-run` should list `dist/`, `skills/`, `README.md` and `LICENSE`, with both bins (`code-visualizer`, `cviz`).

## Code of conduct

Be kind and constructive. Harassment or discrimination of any kind is not tolerated.
