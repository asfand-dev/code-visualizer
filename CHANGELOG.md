# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] — Unreleased

First public release.

### Added

- `code-visualizer report` (default command) that analyzes a JavaScript/TypeScript project and opens a single-file, offline HTML report.
- `--file` and `--directory` scopes, `--depth`, `--output`, `--exclude`, `--json`, `--no-open`, `--no-git`, `--no-source`, `--max-files`, `--quiet`.
- `npm create code-visualizer` support through the `create-code-visualizer` package.
- Analyzer for TS/JS/JSX/TSX, Vue, Svelte and Astro: imports, re-exports, components, hooks, classes, interfaces, enums, types, constants, routes, calls, renders and inheritance; tsconfig paths, bundler aliases and monorepo workspaces.
- Report views: Overview, Guided tour, Dependency graph (semantic zoom, focus, impact, path finder, exports), Architecture (matrix, chord, layers), Structure (treemap, sunburst, mind map, explorer), Components, Classes & types (UML), Routes & APIs, Call flow, Packages and Insights.
- Git insights: churn, authorship, hotspots, change coupling and activity.
- Command palette search, detail panel with source preview and open-in-editor links, deep links, dark and light themes, responsive layout.
- Programmatic API: `analyze`, `writeReport`, `renderReportHtml`, `runCli`.
