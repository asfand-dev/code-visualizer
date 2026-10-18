---
name: code-visualizer
description: Project map for JavaScript/TypeScript code — who uses a file or symbol, what a change affects, which tests cover it, whether an import is allowed by the architecture rules, whether similar code already exists, and what the current changes break. Use before changing an exported function, writing a new helper, moving code between folders, adding an import across areas, or finishing a task (to run exactly the affected tests).
---

# code-visualizer

code-visualizer analyzes the project's imports, call sites, routes, tests and git history. Its answers are
static analysis of the code as it is on disk, so they also see edits that are not committed yet.

## When it helps

- **Before changing an exported function, hook, component or route**: who calls it and with how many
  arguments, which routes and pages depend on it, which tests reach it.
- **Before adding an import between folders**: whether the architecture rules allow it, and which allowed
  module already wraps what you need.
- **Before writing a helper**: whether the project already has a function that does it (renamed variables
  and the other declaration style still match), so you import it instead of adding a copy.
- **Before saying a task is done**: the tests your changes affect, and what the change made worse
  (new cycles, rule breaks, call sites that still use an old signature).
- **When a name is unfamiliar**: where it is defined and used, and who knows that code.

## Tools

With the MCP server registered (`code-visualizer agents init --write`), use the tools: `impact`,
`find_symbol`, `tests_for`, `check_architecture`, `review_changes`, `route`, `who`, `project_overview`,
`find_similar`.

Without it, every answer is also a CLI command. `--json` gives machine-readable output; exit code 0 means
found / passed, 1 not found / failed, 2 a usage error.

| Question | Command |
| --- | --- |
| What does changing this affect (users with exact lines, routes, tests, owners)? | `npx code-visualizer impact <file or symbol> --json` |
| Where is this symbol or file used? | `npx code-visualizer uses <symbol> --json` |
| Which tests cover these files, and the command to run them? | `npx code-visualizer tests-for <paths...> --json` |
| Does this code already exist? | `npx code-visualizer similar --stdin --json < snippet.ts` (or `similar <file:start-end>`, `similar <file#Symbol>`) |
| Run exactly the tests my changes affect (records the result) | `npx code-visualizer test` (`--list` / `--json` only plans) |
| Did my change add problems (new cycles, rule violations, complexity, unused exports)? | `npx code-visualizer check --changed --format json` |
| What changed architecturally, including stale call sites? | `npx code-visualizer diff --format json` |
| Why does A depend on B? | `npx code-visualizer path <from> <to> --json` |
| Which handler serves this URL? | `npx code-visualizer route 'GET /api/users/42' --json` |
| Who knows this code? | `npx code-visualizer who <file> --json` |
| Project overview for a new area | `npx code-visualizer context --summary` |

Targets can be a file path (or a unique suffix such as `Cart.tsx`), a symbol (`useCart`,
`src/cart/index.ts#useCart`), a folder (`src/cart/`) or a route (`'GET /api/cart/:id'`).

## Guardrail hooks

When the hooks are installed, edits are checked as they happen:

- An edit that adds a forbidden import, a layer break, a circular dependency or an import of a package no
  package.json declares is refused before it is written. The reason names the rule and an allowed module
  that already provides the code; use that module (or `import type` when the rule allows type-only imports).
- After an edit, the context lists what it left behind: call sites that still pass the old arguments, a
  removed export or route that is still used, a large complexity jump, a new export no test reaches, a
  copy of code that already exists (import that instead), and a copy you changed while its clone
  elsewhere was not (apply the same fix there, or ask whether it should be shared).
- With strict hooks, finishing requires a passing run of the affected tests: `npx code-visualizer test`.

The rules live in `code-visualizer.config.json` (`rules`, `layers`). They are the project's decisions;
changing them is a question for the user, not a way around a refused edit.
