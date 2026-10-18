/**
 * What each finding rule means: names, descriptions and help for SARIF (code scanning), GitLab Code
 * Quality, job summaries and the docs. Pure. Features that add gates add their rules to RULES_CATALOG.
 */
import { RULE_IDS } from './fingerprint.js';
import type { FindingSeverity } from './types.js';

export interface RuleDescriptor {
  /** `cv/cycle`… (see RULE_IDS). */
  id: string;
  /** PascalCase name (SARIF `reportingDescriptor.name`). */
  name: string;
  shortDescription: string;
  fullDescription: string;
  /** Markdown: why it matters and how to fix it. */
  help: string;
  /** Severity when nothing in the configuration changes it. */
  level: FindingSeverity;
  /** Architecture problems are rated critical in GitLab Code Quality. */
  category: 'architecture' | 'dependencies' | 'maintainability';
  /** SARIF `precision` (default `very-high`): how often a finding is a true positive. */
  precision?: 'very-high' | 'high' | 'medium' | 'low';
}

const CONFIG_HINT = 'Thresholds and allowances live in the `"check"` block of `code-visualizer.config.json`.';

export const RULES_CATALOG: RuleDescriptor[] = [
  {
    id: RULE_IDS.cycle,
    name: 'CircularDependency',
    shortDescription: 'Circular dependency between modules',
    fullDescription: 'These modules import each other (directly or through other modules), so none of them can be loaded, tested or moved on its own.',
    help: 'Modules in a cycle cause initialization-order bugs (`undefined` imports at startup) and make the code hard to split. Move the shared part into a module that both import, invert one dependency (pass a callback or use an event), or merge the modules. ' + CONFIG_HINT + ' (`maxCycles`).',
    level: 'error',
    category: 'architecture',
  },
  {
    id: RULE_IDS.rule,
    name: 'ForbiddenImport',
    shortDescription: 'Import forbidden by an architecture rule',
    fullDescription: 'An import breaks one of the `rules` in the code-visualizer configuration.',
    help: 'The project forbids this dependency (see `rules` in `code-visualizer.config.json`). Import the public module the rule allows instead, or move the code to a layer that may depend on the target.',
    level: 'error',
    category: 'architecture',
  },
  {
    id: RULE_IDS.layer,
    name: 'LayerViolation',
    shortDescription: 'Lower layer depends on a higher layer',
    fullDescription: 'An import goes upwards through the `layers` of the code-visualizer configuration.',
    help: 'Layers are listed from top to bottom in `code-visualizer.config.json`; a lower layer must not import a higher one. Move the shared code down, or pass what the lower layer needs as a parameter.',
    level: 'error',
    category: 'architecture',
  },
  {
    id: RULE_IDS.missingDependency,
    name: 'UndeclaredDependency',
    shortDescription: 'Package imported but not declared in package.json',
    fullDescription: 'Code imports a package that the nearest package.json does not declare, so it only works by accident (hoisting, a transitive dependency).',
    help: 'Add the package to `dependencies` (or `devDependencies` for tests and tooling) of the nearest package.json. ' + CONFIG_HINT + ' (`allowMissingDependencies`).',
    level: 'error',
    category: 'dependencies',
  },
  {
    id: RULE_IDS.devDependencyInProduction,
    name: 'DevDependencyInProduction',
    shortDescription: 'devDependency imported by production code',
    fullDescription: 'Production code imports a package that is only a devDependency, so it is missing when installed with `--omit=dev`.',
    help: 'Move the package to `dependencies`. If it is provided at runtime or bundled on purpose, allow it with `"check": { "allowDevDependenciesInProduction": ["<name>"] }`.',
    level: 'error',
    category: 'dependencies',
  },
  {
    id: RULE_IDS.complexity,
    name: 'ComplexFunction',
    shortDescription: 'Function above the complexity limit',
    fullDescription: 'The cyclomatic complexity of the function (or of its most complex inline callback) is above the configured maximum.',
    help: 'Split the function into smaller, named steps, replace long `if`/`switch` chains with lookup tables, and return early. ' + CONFIG_HINT + ' (`maxComplexity`).',
    level: 'error',
    category: 'maintainability',
  },
  {
    id: RULE_IDS.complexityIncrease,
    name: 'ComplexityIncrease',
    shortDescription: 'Function became more complex',
    fullDescription: 'The change added branches to a function that already existed (`check --no-worse`).',
    help: 'Leave functions at least as simple as you found them: extract the new branch into a helper. ' + CONFIG_HINT + ' (`noWorse`).',
    level: 'error',
    category: 'maintainability',
  },
  {
    id: RULE_IDS.unusedExport,
    name: 'UnusedExport',
    shortDescription: 'Export that nothing imports',
    fullDescription: 'The export is never imported by another file and is not an entry point: it is probably dead code.',
    help: 'Delete it, or drop the `export` keyword when it is only used inside its file. ' + CONFIG_HINT + ' (`maxUnusedExports`).',
    level: 'warning',
    category: 'maintainability',
  },
  // --- test-intelligence ---
  {
    id: RULE_IDS.patchCoverage,
    name: 'UncoveredChangedLines',
    shortDescription: 'Changed lines that no test executes',
    fullDescription: 'Lines added by the change are not covered by the local coverage report (`check --min-patch-coverage`).',
    help: 'Add or extend a test that runs these lines, then rerun the tests with coverage (`code-visualizer test --coverage`). ' + CONFIG_HINT + ' (`minPatchCoverage`).',
    level: 'warning',
    category: 'maintainability',
  },
  // --- daily-loop: hygiene of added lines (check --staged / --changed) ---
  {
    id: RULE_IDS.focusedTest,
    name: 'FocusedTest',
    shortDescription: 'Focused test committed',
    fullDescription: 'An added line focuses a test or suite (`it.only`, `describe.only`, `fit`, `fdescribe`), so every other test in the file is skipped silently.',
    help: 'Remove `.only` (or the `f` prefix) before committing. Turn the check off with `"check": { "hygiene": false }`.',
    level: 'error',
    category: 'maintainability',
  },
  {
    id: RULE_IDS.debuggerStatement,
    name: 'DebuggerStatement',
    shortDescription: '`debugger` statement committed',
    fullDescription: 'An added line is a `debugger` statement, which pauses every run that has developer tools attached.',
    help: 'Remove the statement before committing. Turn the check off with `"check": { "hygiene": false }`.',
    level: 'error',
    category: 'maintainability',
  },
  {
    id: RULE_IDS.conflictMarker,
    name: 'ConflictMarker',
    shortDescription: 'Merge conflict marker committed',
    fullDescription: 'An added line is a merge conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`): a conflict was not resolved.',
    help: 'Resolve the conflict and remove the markers before committing.',
    level: 'error',
    category: 'maintainability',
  },
  // --- clone-radar ---
  {
    id: RULE_IDS.duplicateCode,
    name: 'DuplicateCode',
    shortDescription: 'New copy of existing code',
    fullDescription: 'The change adds code that duplicates existing code: the same token sequence once identifiers and literals are normalized (`check --max-new-clones`).',
    help:
      'Import or call the existing function instead of copying it; when the copies differ a little, extract a shared helper with a parameter for the difference. A bug fixed in one copy stays in the others. ' +
      CONFIG_HINT +
      ' The limit is `maxNewClones`; tune detection with `"clones": { "minTokens": 50, "minLines": 6, "minSimilarity": 0.5, "ignore": [] }`.',
    level: 'error',
    category: 'maintainability',
    // Code with the same structure but another meaning matches too (identifiers and literals are normalized).
    precision: 'medium',
  },
];

const BY_ID = new Map(RULES_CATALOG.map((r) => [r.id, r]));

/** The descriptor of a rule; a generic one for rules that no catalog entry describes (plugins). */
export function ruleDescriptor(id: string): RuleDescriptor {
  const known = BY_ID.get(id) ?? RULES_CATALOG.find((r) => r.id === id);
  if (known) return known;
  const words = id.replace(/^cv\//, '').split(/[-_/]+/).filter(Boolean);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Finding';
  const text = words.join(' ') || id;
  const sentence = text[0].toUpperCase() + text.slice(1);
  return { id, name, shortDescription: sentence, fullDescription: `${sentence} (reported by code-visualizer).`, help: CONFIG_HINT, level: 'warning', category: 'maintainability' };
}
