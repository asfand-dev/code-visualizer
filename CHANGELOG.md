# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

The daily-companion release. code-visualizer now answers questions in the terminal, guards every save, plugs into AI coding agents, runs only the tests a change affects, helps review other people's branches and fails CI only on what a change makes worse.

### New commands

Grouped as in `code-visualizer --help`; `cviz` is a short alias of `code-visualizer`.

- **Ask**: `who`, `uses` (alias `refs`), `impact`, `path`, `route`, `tests-for` and `similar` — all with `--json`, fuzzy targets with “did you mean” and exit codes 0 / 1 not found / 2 usage.
- **Everyday**: `test` (run exactly the affected tests), `coverage` (patch coverage), `status` (shell prompt, tmux and agent status lines) and `sync` (what the base branch and teammates bring before a rebase).
- **Review & CI**: `diff [base] [head]` (architecture changes between refs, your branch or staged work, `--fail-on …`) and `review [ref|#123|!45]` (review any branch, PR or MR in dependency order without checking it out).
- **AI agents**: `mcp` (MCP server over stdio, `--print-config claude|cursor|vscode|codex|gemini`), `agents init|doctor|remove` and `hook <session-start|pre-edit|post-edit|stop>`.
- **Setup**: `cache [status|clear]` and `hooks install|uninstall|status`.
- `context --agents [--write] [--claude]` maintains a managed project-map block in AGENTS.md; `pr` gains `--format comment`, `--check` and `--coverage`; `serve` gains `--notify` and `--new`; analysis commands gain `--no-cache` and `--coverage <path>`.
- Every command finds the project around the current folder (the nearest `package.json` or config, widened to its workspace monorepo, else the git root), accepts `--root`, rejects unknown options with a suggestion and exit code 2, and keeps machine output on stdout free of ANSI codes.

### Live guard (`serve`)

- Every update is compared with the one before and announced in the terminal and the browser: `cycle-added`/`cycle-fixed`, `rule-violation`/`rule-fixed`, `complexity-up`/`complexity-down`, `signature-changed` (with call sites not updated, until they are), `route-removed`, `missing-dependency`, `untested-change`, `unused-export`, `clone-added`, `health` and `config`. Moved files that are still imported under the old path are reported, and so are fixes (“✔ all calls of formatDate() updated”).
- A problem is announced once and stays open until it is fixed. Problems that exist when `serve` starts are shown as open at once.
- Desktop notifications (`--notify`, `serve.notify`): osascript on macOS, notify-send on Linux, a PowerShell toast on Windows; at most one every 10 s, errors in that window are batched.

### Terminal answers

- The query core (`src/shared/query.ts`) is shared by the CLI, the report UI, the MCP server and the hooks, so every surface gives the same answer.
- Impact is **symbol-precise**: for a symbol only the files that import it by name (through barrels too), call it or use another export that uses it count; it widens to file level, with a reason, for `import * as`, `require` or module-level use.
- “Reached by a test” is one rule everywhere: a test imports the file, a test requests or visits a route whose handler reaches it, or the coverage report saw its lines run.
- `file:line` locations are terminal hyperlinks to your editor (`CODE_VISUALIZER_EDITOR`; `NO_HYPERLINKS=1` turns them off).

### AI agents

- **MCP server** with nine read-only tools: `project_overview`, `impact`, `find_symbol`, `tests_for`, `review_changes`, `check_architecture`, `route`, `who` and `find_similar`; resources `cv://project/summary`, `cv://changes`, `cv://health`, `cv://file/{path}`; prompts `review-changes` and `plan-change`. Supports `initialize`-based clients (protocol 2024-11-05 … 2025-11-25) and stateless 2026-07-28 requests, progress and cancellation. Answers come from a running `serve` or a warm engine; paths are kept inside the project, repository text is fenced and author emails are left out.
- **Guardrail hooks** for Claude Code, Cursor and Codex: a session brief; a pre-edit guard that refuses forbidden imports, layer breaks, new cycles and undeclared packages and names an allowed alternative; a post-edit radar for stale call sites, removed exports or routes still used, complexity jumps, untested new exports, new clones and clone drift; and an optional stop-time test gate. Hooks fail open, answer within the client's timeout and can be turned off with `CODE_VISUALIZER_HOOKS=off`.
- **`agents init`** writes `.mcp.json`, `.claude/settings.json`, `.cursor/mcp.json`, `.cursor/hooks.json`, `.vscode/mcp.json`, `.codex/config.toml` and `.gemini/settings.json` as a previewed diff, touches only entries named `code-visualizer`, is idempotent and is undone byte for byte by `agents remove`. It says which agents it detected. `agents doctor` checks the MCP handshake, one hook round-trip, the configuration and the analysis speed.
- **Managed AGENTS.md block** (`context --agents`, `agents init --agents-md`): commands, the single-file test command, rules and layers, generated files, fragile files with their tests, CODEOWNERS boundaries (including single files with other owners) and the tools, at most 60 lines between markers.
- A **skill** (`skills/code-visualizer/SKILL.md`) that tells agents when to use the tools; `agents init --skill` copies it to `.claude/skills/`.

### Tests & coverage

- Test selection by changed tests, imports (also through helpers), e2e and API tests that visit or request an affected route (`page.goto`, `cy.visit`, `cy.request`, `browser.url`, `request(app).get(…)`, Playwright `request`), and optionally co-change history. Manifest, lockfile, tsconfig, runner-config and setup changes run the owning package's whole suite.
- One command per workspace package and runner (vitest, jest, mocha, ava, bun, node --test, playwright, cypress), run from the package folder without a shell; runners are never downloaded. On Windows, long test lists are split under the cmd.exe limit. The outcome is recorded as `lastTest`.
- Patch coverage from `coverage/coverage-final.json` and `coverage/lcov.info` at the root and in each workspace package, counting only added code lines; per-file uncovered ranges; “not measured” for packages without a report; stale-report detection.

### CI gates (`check`)

- **New-only by default with a base**: findings have line-free fingerprints, and `--changed`, `--new-since <ref>` and `--staged` fail only on findings that are new compared with the merge-base (or HEAD for `--staged`). Old debt is counted as existing; an old function that got worse is marked `(worse)`. `--committed` judges only what you committed (pre-push). `check.changedMode: "files"` keeps the touched-files behaviour.
- **Committed baseline** (`code-visualizer.baseline.json`): `--update-baseline` creates it and ratchets it down; new findings are added only with `--force`; `--baseline [file]` / `--no-baseline`.
- New gates: `--max-health-drop`, `--no-worse`, `--min-patch-coverage`, `--max-new-clones`, and the **hygiene** gate for focused tests, `debugger` statements and merge-conflict markers in added lines.
- **CI outputs** from one analysis: `--format text|json|github|sarif|gitlab|markdown`, `--sarif <file>`, `--gitlab <file>`, `--json [file]`; capped, best-first GitHub annotations; a job summary appended to `$GITHUB_STEP_SUMMARY` (`--no-summary`); `--quiet` and `--quiet-pass` for git hooks.
- `pr --format comment` writes a sticky PR comment (marker line, at most 60,000 characters, folded sections) for `gh pr comment --edit-last --create-if-none`; `pr --check` adds the gate table.
- In CI the base is read from GitHub Actions, GitLab, Bitbucket, Azure Pipelines or Jenkins. An unknown `--base` fails with “Did you mean …?” and a fetch hint; in a shallow clone where no merge-base exists, `check --changed` checks everything and warns instead of passing silently.

### Code review

- `review` and Reviewer mode: start here (with the reason and what it builds on), a dependency-ordered reading path with a role and reason per file, tests right after (or before) their code, a skim list, effort (meaningful lines at 400 an hour, level 1–5), split suggestions for independent changes, API changes with call sites not updated, new cycles and rule violations, code health, clone drift and changed functions without test changes.
- `pr` gains **Architecture changes** (with a mermaid diagram of new area dependencies), a patch-coverage line and a **Review path** checklist; the UI's “Copy PR description” includes the same sections.
- `diff` and `pr` keep findings across renames and moves, and list the exact call sites a breaking signature change did not update.

### Copy-paste radar

- A normalized token index of every declaration finds copy-paste clones, including renamed copies and copies with a small edit; boilerplate fingerprints are skipped. Clone families are ranked by how often their files change together.
- A **Duplication** health category (10% of the score), **clone drift** (“you changed a.ts:40-58; its clone b.ts:12-30 was not changed”), “import it instead” messages for new copies in `pr`, `diff`, `review`, `serve` and the agent hooks, and a no-new-duplication gate. Edits next to an existing copy never produce a new clone.

### Status line, git hooks & sync

- `status` never analyzes inline: it asks a running `serve` or prints the stored snapshot and refreshes it in the background (about 40 ms, exit 0; 2 only for a mistyped option). It notices a fetched base and newer `sync` results, shows `tests ✔` only when the last passing run covered every required test, and labels `patch` vs. `cov` coverage and stale reports.
- `hooks install` edits only marked blocks, chains an existing hook, restores files byte for byte on uninstall, and refuses a global `core.hooksPath` unless `--global-hooks`. `CODE_VISUALIZER_SKIP=1` skips the checks once.
- `sync` uses `git merge-tree` (git ≥ 2.38, a file comparison on older git) and `git merge-file` for uncommitted edits; nothing in the repository is touched, and only `--fetch` uses the network.

### In the browser

- **Today**: a **Live feed** and an **Incoming** card (what the base branch brings, with conflicts and broken call sites; live server).
- **My changes**: files in **reading order** with a role and reason each, symbol-precise impact (comment-only edits ignored), a **patch-coverage** chip with uncovered lines, an **Architecture changes** card (new cycles, rule breaks, breaking APIs with call sites not updated, removed routes still called, dependency problems, new area dependencies, new clones, health change) and **Clone drift**.
- **Reviewer mode** (live server): an Author / Reviewer toggle with a ref picker (recent branches and fetched PRs, agent branches first), the review path with roles, reasons and diffs, “Start here” and split callouts, and viewed checkboxes stored per file version (<kbd>j</kbd>/<kbd>k</kbd>, <kbd>v</kbd>, <kbd>Enter</kbd>). Deep link `#/changes?review=<ref>&base=<ref>&tf=1`.
- **Live guard**: a toast with a **Show** button that opens the cycle, symbol or file, the open problem count in the tab title, and an optional browser notification toggle.
- **Health & insights**: a **Duplication** category, **Tests & coverage** when a coverage report exists, **copy-paste clones**, devDependencies used in production code, the worst inline callback of complex functions, and a **New only** toggle.
- **Detail panel**: **Used by** with exact call sites, **Similar code**, how tests reach the file, line coverage, cognitive complexity, and uncovered changed lines in red in the source.

### Analyzer

- Dependencies are checked against the nearest `package.json`; devDependencies imported by production code are reported. Nested packages inside test, fixture and example folders are left out by default (`includeSubprojects`).
- Cyclomatic complexity excludes nested callbacks (measured on their own); SonarSource-style cognitive complexity is added.
- Calls, renders and `new` are recorded with their lines and argument counts.
- Git: `.mailmap` is applied and names sharing an email are merged; unpushed commits on the base branch count as your work; comment-only edits are recognised; in CI the base is read from GitHub Actions, GitLab, Bitbucket, Azure Pipelines or Jenkins.
- Any git ref, the index or a proposed edit can be analyzed through an **overlay**, without a checkout; `compareReports` turns two analyses into an `ArchitectureDelta`.
- New configuration keys: `includeSubprojects`, `check.maxHealthDrop`, `check.noWorse`, `check.allowDevDependenciesInProduction`, `check.baseline`, `check.changedMode`, `check.minPatchCoverage`, `check.patchCoverage`, `check.hygiene`, `check.maxNewClones`, `serve.notify`, `serve.events.exclude`, `coverage` and `clones`; unknown `check.*` keys get a suggestion.

### Performance

- **Warm by default**: parse results and git history are cached in `.code-visualizer/cache/` (reused by modification time, size or content hash), and analyses of other commits in `.code-visualizer/snapshots/`. Repeated runs are 2–3× faster; `--no-cache` or `CODE_VISUALIZER_NO_CACHE=1` gives a cold run.
- A running `serve` registers itself in `.code-visualizer/server.json`, and `report`, `check`, `pr`, `context`, the terminal answers, `status`, the MCP server and the agent hooks reuse its analysis when the options match.
- A lazy command registry: `--help`, `--version` and `status` never load the analyzer or TypeScript.
- Clone pairs and change classification are incremental, so saves in `serve` and agent what-if checks stay fast on large repositories.

### Security

- The live server binds to `127.0.0.1`, requires a per-session token for every API call and rejects foreign `Host` headers. `POST /api/whatif` is loopback-only; review state is stored at mode 0600.
- `server.json`, caches, snapshots, `state.json` and agent session files are trusted only when they are private to the current user; caches are signed with a per-user key, so a cache that comes with a repository is never used.
- `agents doctor` runs only code-visualizer itself unless `--run-registered` is passed. Setup commands preview their changes, never write through symlinks that lead out of the project, and git refs are validated before they reach git. Repository strings printed to the terminal have control characters made visible.

### Programmatic API

New exports:

- Analysis: `getReport`, `createEngine`, `connectToServer`, `probeServer`, `loadDiskCache`, `saveDiskCache`, `clearDiskCache`, `readState`, `updateState`.
- Compare: `snapshotAt`, `overlayForRef`, `overlayForIndex`, `renamesSince`, `configAt`, `compareReports`, `architectureDeltaMarkdown`, `deltaHighlights`, `breakingExports`, `deltaFailures`, `parseFailOn`, `fingerprint`, `RULE_IDS`.
- Queries: `query` (`resolveTarget`, `impactOf`, `usesOf`, `whoOf`, `routeFor`, `testsFor`, `importPath`, `callersOf`, `calleesOf`, `httpTestedFiles`, `untestedChanges`, `routeTestReach`, `testEvidence`, …) and `buildTestCommand`.
- Gates and CI: `evaluateGates`, `GATE_PROVIDERS`, baseline helpers, `RULES_CATALOG`, `sarifReport`, `gitlabReport`, `githubAnnotations`, `checkSummaryMarkdown`, `prCommentMarkdown`.
- Live guard (`diffLive`, `LiveGuard`, `LIVE_DETECTORS`), tests and coverage (`selectTests`, `planSummary`, `loadCoverage`, `patchCoverage`, …), review (`buildReviewPlan`, `reviewPlan`, `reviewPlanMarkdown`, …), daily loop (`analyzeSync`, `buildStatus`, `formatStatus`, `hygieneGate`), clones (`detectClones`, `findSimilar`, `similarTo`, `clonesGate`, …), MCP (`startMcpServer`, `MCP_TOOLS`, `mcpRegistration`, …) and agents (`preEditFindings`, `postEditFindings`, `runHook`, `planInit`, `planRemove`, …).

## [0.1.0] — 2026-10-16

First public release.

### Commands

- `report` (default): analyzes a JavaScript/TypeScript project and opens a single-file, offline HTML report. Options: `--file`, `--directory`, `--depth`, `--output`, `--exclude`, `--base`, `--json`, `--no-open`, `--no-git`, `--no-changes`, `--no-source`, `--no-history`, `--max-files`, `--quiet`.
- `serve` (aliases `live`, `watch`, `dev`): a live companion on `http://127.0.0.1:4747` that re-analyzes incrementally on every save, stage, commit or branch switch and updates open tabs through server-sent events. Adds git blame, open-in-editor without prompts, and saving notes and tours into the project.
- `check`: quality gates for CI and pre-commit hooks — architecture rules, missing dependencies, cycles, complexity, unused exports, health and change risk; `--changed` judges only what the branch touches; `--format text|json|github` (GitHub Actions annotations).
- `pr`: a Markdown pull-request description for the current work (`--base`, `--output`, `--copy`).
- `context`: Markdown context about a file (`--source`) or the whole project (`--summary`) for AI assistants and docs.
- `npm create code-visualizer` support through the `create-code-visualizer` package.

### Daily companion

- **Today**: branch and upstream status, your work at a glance, health score and trend with quick wins, commits since your last visit, pinned items with notes, recently viewed items, your areas and areas you haven't explored yet.
- **My changes**: uncommitted work or the whole branch against its base (`origin/HEAD`, `main`, `master`, `develop`, `trunk` or `--base`): files grouped into related sets, changed functions/components/methods with their usages, impacted files and routes, tests to run with a ready-made command (Vitest, Jest, Mocha, AVA, Node, Bun, Playwright, Cypress), files without tests, suggested reviewers, CODEOWNERS, a risk score with its factors, diffs, and a copyable PR description.
- **Search code**: full-text and regex search over every file with case, whole-word and path filters; `#/search?q=` deep links; <kbd>⇧↵</kbd> in the command palette.
- **Activity & team**: commit timeline, calendar heatmap, working-hours chart, contributors and their areas, a knowledge map (who owns what), experts and bus factor per area, knowledge silos.
- **Health score** (0–100, grades A–E) from modularity, complexity, size, dead code, dependencies, test reach and knowledge spread, with history in `.code-visualizer/history.json` and the improvements with the biggest expected gain.
- Pins, notes, recently viewed items and a personal tour builder that persist per project; tours export as [CodeTour](https://marketplace.visualstudio.com/items?itemName=vsls-contrib.codetour) files and team tours in `.tours/` are shown in the Guided tour.
- Detail panel: owners and experts, related tests, file history with commit messages, blame (live mode), diff of your change, changed lines highlighted in the source, **Copy for AI**.
- “My changes” overlay and blast radius in the dependency graph; color by owner.

### Exploring code

- Views: Overview, Guided tour, Dependency graph (semantic zoom, focus, impact, path finder, cycles, PNG/Mermaid/DOT/JSON export), Architecture (matrix, chord, layers), Structure (treemap, sunburst, mind map, explorer), Components, Classes & types (UML), Routes & APIs, Call flow, Packages and Health & insights.
- **API map**: frontend HTTP calls (`fetch`, `$fetch`/`useFetch`, `useSWR`, axios and `axios.create()` clients, ky, ofetch, got, Angular `HttpClient`, supertest) are linked to the backend routes that serve them, including through call flow; absolute URLs are listed as external services.
- Insights: hotspots, cycles, complex functions, unused exports, orphans, large files, change coupling, duplicate names, TODOs, untested important files, `@deprecated` APIs still in use, architecture rule violations.
- Command palette across files, symbols, routes, packages and code text; deep links for every view and selection; keyboard shortcuts; dark and light themes; responsive layout.

### Analyzer

- TS/JS/JSX/TSX, Vue, Svelte and Astro: imports, re-exports through barrels, components, hooks, classes, interfaces, enums, types, constants, routes, calls, renders and inheritance; tsconfig paths, bundler aliases and monorepo workspaces.
- Git: churn, recency-weighted ownership, file history, weekly and daily activity, contributors, change coupling; change detection for uncommitted, staged and untracked files or a branch since its merge-base.
- Test reach: which test files reach which source files through imports.
- `CODEOWNERS` from the root, `.github/`, `docs/`, `.gitlab/` and `.bitbucket/`.
- Configuration in `code-visualizer.config.json`, `.code-visualizerrc(.json)` or `package.json#codeVisualizer` (comments allowed): `exclude`, `base`, forbidden-import `rules`, `layers` and `check` thresholds. Invalid files are reported with their position; `check` fails on them.
- Live mode caches parsed files (by modification time and size) and git history (by `HEAD`), so updates after a save take a few hundred milliseconds.

### Programmatic API

- `analyze`, `createAnalyzeCache`, `loadConfig`, `writeReport`, `renderReportHtml`, `serve`, `prSummaryMarkdown`, `fileContextMarkdown`, `projectSummaryMarkdown`, `runCli` and all data types.
