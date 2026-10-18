# Contributing to code-visualizer

Thanks for helping! This guide gets you from a fresh clone to a working change in a few minutes.

## Setup

```bash
git clone https://github.com/asfand-ionos/code-visualizer.git
cd code-visualizer
npm install
npm run build        # builds the report UI and the CLI into dist/
npm test             # runs the analyzer test-suite (Vitest)
```

Requirements: Node.js 22 or newer for development (the published CLI supports Node.js 20+).

Try your build on any project:

```bash
node dist/cli.js report ../some-project
node dist/cli.js report test/fixtures/react-vite-ts --no-git
```

## Project layout

```text
src/
  analyzer/        Static analysis (Node.js)
    files.ts       File discovery (git ls-files / glob, ignores)
    project.ts     package.json, frameworks, workspaces, tsconfig paths, bundler aliases
    parse.ts       Per-file parsing with the TypeScript compiler API (+ Vue/Svelte/Astro)
    resolve.ts     Module resolution (relative, paths, aliases, workspaces, packages)
    routes.ts      File-system routes (Next.js, Nuxt, SvelteKit, Remix, Astro)
    classify.ts    File kinds (component, hook, service, …)
    graph.ts       Graph algorithms (SCC/cycles, PageRank, reachability)
    git.ts         Churn, authors, change coupling
    insights.ts    Folder summaries, onboarding tour, package health
    index.ts       Orchestrates everything and produces ReportData
  report/html.ts   Embeds ReportData (gzip + base64) into the UI template
  cli/             Argument parsing and commands
  shared/types.ts  The data contract between analyzer and UI
ui/                The report UI (React + Vite), built into ONE html file
  src/views/       One component per view (GraphView, ClassesView, …)
  src/components/  Shared UI (detail panel, command palette, cytoscape canvas…)
test/              Vitest suites and realistic fixture projects
packages/create-code-visualizer/   Thin wrapper that enables `npm create code-visualizer`
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the pipeline and design decisions in more depth.

## Developing the UI

```bash
npm run dev
```

This analyzes this repository into `ui/dev-data.json` and starts Vite with hot reload at <http://localhost:5175>. To develop against another project:

```bash
node scripts/dev-data.mjs ../some-project && npx vite --config ui/vite.config.ts
```

## Developing the analyzer

- Add or extend a fixture under `test/fixtures/<name>/` (fixtures are never installed or executed — only analyzed).
- Add expectations in `test/<name>.test.ts` or unit tests in `test/parse.test.ts`.
- Run `npm run test:watch` while you work.
- Keep the analyzer fast: parse once per file, avoid type-checking, prefer maps over repeated scans.

## Adding a new command

Commands live in `src/cli/run.ts`. Each command is an object with `name`, `summary` and `run(ctx)`; add it to the `COMMANDS` array. `report` stays the default command.

## Pull requests

1. Create a branch, keep changes focused.
2. `npm run typecheck && npm test && npm run build` must pass.
3. Describe what changed and, for UI changes, add a screenshot.
4. Update `CHANGELOG.md` under *Unreleased*.

## Releasing (maintainers)

```bash
npm version <patch|minor|major>        # bumps the root package
npm publish                             # publishes code-visualizer (runs typecheck, build and tests first)

cd packages/create-code-visualizer
npm version <same version>              # keep both packages in sync
# make sure "code-visualizer" in its dependencies points at the new version
npm publish                             # publishes create-code-visualizer
```

Both packages publish to the public npm registry (`publishConfig` is set), even if your machine uses a private registry by default.

## Code of conduct

Be kind and constructive. Harassment or discrimination of any kind is not tolerated.
