import { createRequire } from 'node:module';
import path from 'node:path';
import ignore from 'ignore';
import type TypeScript from 'typescript';
import { closest, editDistance } from '../shared/delta.js';
import { isLiveEventKind, LIVE_EVENT_KINDS } from '../shared/live.js';
import type { DependencyEdge, LiveEventKind, RuleViolation } from '../shared/types.js';
import { projectFiles, type ReadText } from './readtext.js';

/** A forbidden dependency: files matching `from` must not import files matching `to`. */
export interface RuleConfig {
  name?: string;
  from: string | string[];
  to: string | string[];
  /** Targets that are allowed even though they match `to`. */
  allow?: string | string[];
  severity?: 'error' | 'warn';
  message?: string;
  /** Also flag type-only imports (default: true). */
  includeTypes?: boolean;
}

export interface CheckConfig {
  maxCycles?: number;
  maxComplexity?: number;
  minHealth?: number;
  maxUnusedExports?: number;
  allowMissingDependencies?: boolean;
  /**
   * Don't fail the dependency gate when production code imports a devDependency: `true` for all of them,
   * or the names of the packages that may (e.g. `["electron"]`). Allowed findings are reported as warnings.
   */
  allowDevDependenciesInProduction?: boolean | string[];
  allowRuleViolations?: boolean;
  maxRisk?: number;
  // --- new-only-gates ---
  /** Fail when health drops by more than this many points compared to the base. */
  maxHealthDrop?: number;
  /** Fail when a function you changed got more complex (any increase). */
  noWorse?: boolean;
  /**
   * Committed baseline of known findings (default `code-visualizer.baseline.json`, used when it exists):
   * a path, `true` for the default file, or `false` to never use one.
   */
  baseline?: string | boolean;
  /**
   * What `check --changed` judges: `new` (default) fails only on findings that are new compared to the
   * base; `files` judges every finding in the files you touched (the behaviour before 0.2).
   */
  changedMode?: 'new' | 'files';
  // --- test-intelligence ---
  /** Fail when less than this share (0–100) of the lines your change added is covered by tests (needs a coverage report). */
  minPatchCoverage?: number;
  /** `{ "allowMissingReport": true }`: skip the patch-coverage gate when there is no report (it fails by default). */
  patchCoverage?: { allowMissingReport?: boolean };
  // --- daily-loop ---
  /**
   * Hygiene of the lines a change adds (`check --staged`, `--changed`, `--new-since`): focused tests,
   * `debugger` statements and merge conflict markers. `false` turns it off; a list (or an object
   * `{ "debugger": false }`) picks the kinds; `{ "exclude": ["fixtures/**"] }` leaves paths out.
   * Default: all kinds.
   */
  hygiene?: HygieneSetting;
  // --- clone-radar ---
  /** Fail when the change adds more than this many copy-paste clone families (compared with its base). */
  maxNewClones?: number;
}

// --- daily-loop ---
export type HygieneKind = 'focused-test' | 'debugger' | 'conflict-marker';
export const HYGIENE_KINDS: readonly HygieneKind[] = ['focused-test', 'debugger', 'conflict-marker'];
/** `check.hygiene` normalized: on / off, the kinds to check, or kinds plus paths to leave out (gitignore-style). */
export type HygieneSetting = boolean | HygieneKind[] | { kinds: HygieneKind[]; exclude: string[] };

export interface CodeVisualizerConfig {
  exclude?: string[];
  base?: string;
  rules?: RuleConfig[];
  /** Ordered from top (e.g. `src/app/**`) to bottom (e.g. `src/shared/**`); lower layers must not import higher ones. */
  layers?: (string | string[])[];
  check?: CheckConfig;
  // --- accuracy-pass ---
  /**
   * Nested packages inside test / fixture / example folders are left out by default.
   * `true` analyzes all of them; globs (`"examples/*"`) analyze only the matching ones.
   */
  includeSubprojects?: boolean | string[];
  // --- live-guard ---
  /** The live companion (`serve`). */
  serve?: ServeConfig;
  // --- test-intelligence ---
  /**
   * Coverage reports: by default the newest `coverage/coverage-final.json` or `coverage/lcov.info` of the
   * root and of each workspace package. `paths` names report files or folders instead; `enabled: false`
   * ignores coverage.
   */
  coverage?: CoverageConfig;
  // --- clone-radar ---
  /**
   * Copy-paste clone detection: `{ "minTokens": 50, "minLines": 6, "ignore": ["src/generated/**"] }`;
   * `false` turns it off; globs alone (a string or a list) are short for `ignore`.
   */
  clones?: CloneConfig;
}

// --- clone-radar ---
export interface CloneConfig {
  /** Shared tokens (identifiers and literals normalized) a clone needs (default 50). */
  minTokens?: number;
  /** Lines each copy needs (default 6). */
  minLines?: number;
  /** Files left out of clone detection (gitignore-style globs). */
  ignore?: string[];
  /**
   * 0..1 (or a percentage): the share of its declaration a copy needs to count for `check --max-new-clones`,
   * `pr`, `serve`, clone drift and the Duplication health score (default 0.5). Smaller shared blocks are
   * listed in Insights only.
   */
  minSimilarity?: number;
  /** `false` turns clone detection (and the Duplication health category) off. */
  enabled?: boolean;
}

// --- test-intelligence ---
export interface CoverageConfig {
  /** Report files or folders (relative to the project root). */
  paths?: string[];
  /** `false` ignores coverage reports (default: true). */
  enabled?: boolean;
}

// --- live-guard ---
/** Desktop notifications of `serve`: errors only, errors + warnings + fixes, or none. */
export type NotifyMode = 'errors' | 'all' | 'off';

export interface ServeConfig {
  /** OS notifications for live events (default: off; `serve --notify` turns them on for errors). */
  notify?: NotifyMode;
  events?: {
    /** Event kinds `serve` should not announce (e.g. `["unused-export", "health"]`). */
    exclude?: LiveEventKind[];
  };
}

export interface LoadedConfig {
  file?: string;
  config: CodeVisualizerConfig;
  /** Set when a configuration file exists but cannot be used; `config` is then empty. */
  error?: string;
}

const CONFIG_FILES = ['code-visualizer.config.json', '.code-visualizerrc.json', '.code-visualizerrc'];

const isStringList = (v: unknown): v is string | string[] => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
const asList = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

// --- accuracy-pass ---
const BOOLEAN_WORDS: Record<string, boolean> = { true: true, yes: true, on: true, false: false, no: false, off: false };

/**
 * A switch that can also name what it applies to: `true` / `false` (also "true", "yes", "no"…), a name or
 * glob, a list of them, or an object `{ "<name or glob>": true }`. Undefined when the value has another shape.
 */
function switchOrList(v: unknown): boolean | string[] | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const word = BOOLEAN_WORDS[v.trim().toLowerCase()];
    return word ?? [v.trim()];
  }
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? (v as string[]).map((x) => x.trim()).filter(Boolean) : undefined;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.every(([, on]) => typeof on === 'boolean')) return undefined;
    return entries.filter(([, on]) => on).map(([k]) => k.trim());
  }
  return undefined;
}

// --- new-only-gates ---
/** `check` keys whose value is a number; other features' keys are passed through as they are. */
const CHECK_NUMBERS = new Set(['maxCycles', 'maxComplexity', 'minHealth', 'maxUnusedExports', 'maxRisk', 'maxHealthDrop', /* test-intelligence */ 'minPatchCoverage', /* clone-radar */ 'maxNewClones']);
const CHECK_SWITCHES = new Set(['allowMissingDependencies', 'allowRuleViolations']);

function asSwitch(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' ? BOOLEAN_WORDS[v.trim().toLowerCase()] : undefined;
}

/**
 * Every `check` key some gate reads. Features that add gates add their keys here (in their block), so a
 * misspelled key — a gate that is silently off — gets a warning with a suggestion.
 */
export const KNOWN_CHECK_KEYS = new Set<string>([
  'maxCycles',
  'maxComplexity',
  'minHealth',
  'maxUnusedExports',
  'allowMissingDependencies',
  'allowDevDependenciesInProduction',
  'allowRuleViolations',
  'maxRisk',
  'maxHealthDrop',
  'noWorse',
  'baseline',
  'changedMode',
  // --- test-intelligence ---
  'minPatchCoverage',
  'patchCoverage',
  // --- daily-loop ---
  'hygiene',
  // --- clone-radar ---
  'maxNewClones',
]);

const looseKey = (key: string): string => key.replace(/[-_\s]/g, '').toLowerCase();

/** Warnings for `check` keys no gate reads, with the known key they most likely meant. */
export function checkKeyWarnings(check: object | undefined): string[] {
  const warnings: string[] = [];
  const known = [...KNOWN_CHECK_KEYS];
  for (const key of Object.keys(check ?? {})) {
    if (KNOWN_CHECK_KEYS.has(key)) continue;
    // `noworse`, `max-health-drop`, `max_cycles`: the same key written another way; otherwise a typo.
    const same = known.find((k) => looseKey(k) === looseKey(key));
    let best: string | undefined = same;
    if (!best) {
      let bestDistance = Infinity;
      for (const k of known) {
        const d = editDistance(looseKey(key), looseKey(k));
        if (d < bestDistance) [best, bestDistance] = [k, d];
      }
      if (bestDistance > Math.min(3, Math.max(1, Math.floor(key.length / 4)))) best = undefined;
    }
    warnings.push(`Unknown key check.${key} in the configuration is ignored${best ? ` — did you mean "${best}"?` : '.'}`);
  }
  return warnings;
}

/** Validate one `check` key: the normalized value, or an error that names the key. Unknown keys pass. */
function checkValue(key: string, value: unknown): { value: unknown } | { error: string } {
  if (key === 'allowDevDependenciesInProduction') {
    const allowed = switchOrList(value);
    return allowed === undefined ? { error: 'check.allowDevDependenciesInProduction must be true, false or the names of the packages that may be devDependencies (e.g. ["electron"]).' } : { value: allowed };
  }
  if (key === 'baseline') {
    const on = asSwitch(value);
    if (on !== undefined) return { value: on };
    return typeof value === 'string' && value.trim() ? { value: value.trim() } : { error: 'check.baseline must be the path of the baseline file, true or false.' };
  }
  if (key === 'changedMode') {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
    return mode === 'new' || mode === 'files' ? { value: mode } : { error: 'check.changedMode must be "new" (fail only on new findings) or "files" (every finding in the files you touched).' };
  }
  // --- daily-loop ---
  if (key === 'hygiene') return hygieneValue(value);
  if (key === 'noWorse') {
    const on = asSwitch(value);
    return on === undefined ? { error: 'check.noWorse must be true or false.' } : { value: on };
  }
  if (CHECK_SWITCHES.has(key)) {
    return typeof value === 'boolean' ? { value } : { error: `check.${key} must be true or false.` };
  }
  if (CHECK_NUMBERS.has(key)) {
    const n = typeof value === 'string' && value.trim() ? Number(value) : value;
    // --- clone-radar: a count of new clones cannot be negative ---
    if (key === 'maxNewClones' && typeof n === 'number' && n < 0) return { error: 'check.maxNewClones must be 0 or more.' };
    return typeof n === 'number' && Number.isFinite(n) ? { value: n } : { error: `check.${key} must be a number.` };
  }
  // Keys of other features (strings, lists, objects) are theirs to read.
  return { value };
}

// --- daily-loop ---
/**
 * `check.hygiene`: a switch (`true`, `"off"`…), kinds to check (`"focused-test"`, a comma-separated string or a
 * list) or an object that turns single kinds on or off (`{ "debugger": false }`; the others stay on) and
 * may leave paths out (`{ "exclude": ["test/fixtures/**"] }`).
 */
function hygieneValue(value: unknown): { value: HygieneSetting } | { error: string } {
  const on = asSwitch(value);
  if (on !== undefined) return { value: on };
  const usage = `check.hygiene must be true, false, kinds to check (${HYGIENE_KINDS.join(', ')}) or an object such as { "debugger": false, "exclude": ["fixtures/**"] }.`;
  const kind = (name: string): HygieneKind | { error: string } => {
    const k = name.trim().toLowerCase();
    if ((HYGIENE_KINDS as readonly string[]).includes(k)) return k as HygieneKind;
    const hint = closest(k, [...HYGIENE_KINDS, 'exclude']);
    return { error: `check.hygiene has an unknown kind "${name.trim()}"${hint ? ` — did you mean "${hint}"?` : ''} (use ${HYGIENE_KINDS.join(', ')}).` };
  };
  let enabled: HygieneKind[];
  let exclude: string[] = [];
  if (typeof value === 'string' || Array.isArray(value)) {
    const names = typeof value === 'string' ? value.split(',') : value;
    if (!names.every((n) => typeof n === 'string')) return { error: usage };
    enabled = [];
    for (const name of (names as string[]).filter((n) => n.trim())) {
      const k = kind(name);
      if (typeof k !== 'string') return k;
      if (!enabled.includes(k)) enabled.push(k);
    }
  } else if (value && typeof value === 'object') {
    enabled = [...HYGIENE_KINDS];
    for (const [name, flag] of Object.entries(value)) {
      if (name.trim().toLowerCase() === 'exclude') {
        const list = typeof flag === 'string' ? [flag] : flag;
        if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) return { error: 'check.hygiene.exclude must be a path pattern or a list of them, e.g. ["test/fixtures/**"].' };
        exclude = (list as string[]).map((p) => p.trim()).filter(Boolean);
        continue;
      }
      const k = kind(name);
      if (typeof k !== 'string') return k;
      const switched = asSwitch(flag);
      if (switched === undefined) return { error: `check.hygiene.${name} must be true or false.` };
      if (!switched) enabled = enabled.filter((x) => x !== k);
    }
  } else return { error: usage };
  if (exclude.length && enabled.length) return { value: { kinds: enabled, exclude } };
  return { value: enabled.length === HYGIENE_KINDS.length ? true : enabled.length ? enabled : false };
}

/**
 * Check the shape of a parsed configuration. Single values are accepted where a list is expected
 * (`"exclude": "dist/**"`, one rule object, one layer); anything else is an error that names the key.
 */
export function normalizeConfig(raw: Record<string, unknown>): { config: CodeVisualizerConfig; error?: string } {
  const config: CodeVisualizerConfig = {};
  const fail = (error: string): { config: CodeVisualizerConfig; error: string } => ({ config: {}, error });
  if (raw.exclude !== undefined) {
    if (!isStringList(raw.exclude)) return fail('"exclude" must be a glob or a list of globs.');
    config.exclude = asList(raw.exclude);
  }
  if (raw.base !== undefined) {
    if (typeof raw.base !== 'string') return fail('"base" must be a git ref such as "origin/main".');
    config.base = raw.base;
  }
  if (raw.rules !== undefined) {
    const rules = asList(raw.rules as unknown);
    for (const [i, rule] of rules.entries()) {
      const r = rule as Partial<RuleConfig> | null;
      if (!r || typeof r !== 'object' || Array.isArray(r)) return fail(`"rules" must be a list of rule objects (rules[${i}] is not an object).`);
      if (!isStringList(r.from) || !isStringList(r.to)) return fail(`rules[${i}] needs "from" and "to" globs.`);
      if (r.allow !== undefined && !isStringList(r.allow)) return fail(`rules[${i}].allow must be a glob or a list of globs.`);
      if (r.severity !== undefined && r.severity !== 'error' && r.severity !== 'warn') return fail(`rules[${i}].severity must be "error" or "warn".`);
    }
    config.rules = rules as RuleConfig[];
  }
  if (raw.layers !== undefined) {
    const layers = asList(raw.layers as unknown);
    if (!layers.every(isStringList)) return fail('"layers" must be a list of globs (a layer can also be a list of globs).');
    config.layers = layers;
  }
  if (raw.check !== undefined) {
    if (!raw.check || typeof raw.check !== 'object' || Array.isArray(raw.check)) return fail('"check" must be an object, e.g. { "maxCycles": 0 }.');
    const check: Record<string, unknown> = { ...(raw.check as Record<string, unknown>) };
    for (const [key, value] of Object.entries(check)) {
      const checked = checkValue(key, value);
      if ('error' in checked) return fail(checked.error);
      check[key] = checked.value;
    }
    config.check = check as CheckConfig;
  }
  // --- accuracy-pass ---
  if (raw.includeSubprojects !== undefined) {
    const included = switchOrList(raw.includeSubprojects);
    if (included === undefined) return fail('"includeSubprojects" must be true, false or globs of the sub-projects to analyze (e.g. "examples/*").');
    config.includeSubprojects = included;
  }
  // --- live-guard ---
  if (raw.serve !== undefined) {
    const serve = normalizeServe(raw.serve);
    if (typeof serve === 'string') return fail(serve);
    config.serve = serve;
  }
  // --- test-intelligence ---
  if (raw.coverage !== undefined) {
    const coverage = normalizeCoverage(raw.coverage);
    if (typeof coverage === 'string') return fail(coverage);
    config.coverage = coverage;
  }
  // --- clone-radar ---
  if (raw.clones !== undefined) {
    const clones = normalizeClones(raw.clones);
    if (typeof clones === 'string') return fail(clones);
    config.clones = clones;
  }
  return { config };
}

// --- clone-radar ---
/**
 * `"clones"`: a switch (`false` turns detection off), globs to leave out (a string or a list), or an
 * object `{ "minTokens": 50, "minLines": 6, "ignore": [...], "enabled": true }`; an error message otherwise.
 */
function normalizeClones(v: unknown): CloneConfig | string {
  const on = asSwitch(v);
  if (on !== undefined) return { enabled: on };
  if (isStringList(v)) return { ignore: asList(v).map((p) => p.trim()).filter(Boolean) };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '"clones" must be true / false, globs of files to leave out, or { "minTokens": 50, "minLines": 6, "ignore": [...] }.';
  const raw = v as Record<string, unknown>;
  const unknown = unknownKey('"clones"', raw, ['minTokens', 'minLines', 'ignore', 'minSimilarity', 'enabled']);
  if (unknown) return unknown;
  const result: CloneConfig = {};
  for (const key of ['minTokens', 'minLines'] as const) {
    if (raw[key] === undefined) continue;
    const n = typeof raw[key] === 'string' && (raw[key] as string).trim() ? Number(raw[key]) : raw[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return `clones.${key} must be a positive number.`;
    result[key] = n;
  }
  if (raw.minSimilarity !== undefined) {
    const v = raw.minSimilarity;
    const n = typeof v === 'string' && v.trim() ? Number(v.trim().replace(/%$/, '')) : v;
    // 0.6 and 60 (or "60%") mean the same.
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return 'clones.minSimilarity must be between 0 and 1 (or a percentage up to 100).';
    result.minSimilarity = n > 1 ? n / 100 : n;
  }
  if (raw.ignore !== undefined) {
    if (!isStringList(raw.ignore)) return 'clones.ignore must be a glob or a list of globs.';
    result.ignore = asList(raw.ignore).map((p) => p.trim()).filter(Boolean);
  }
  if (raw.enabled !== undefined) {
    const enabled = asSwitch(raw.enabled);
    if (enabled === undefined) return 'clones.enabled must be true or false.';
    result.enabled = enabled;
  }
  return result;
}

// --- test-intelligence ---
/**
 * `"coverage"`: a report path, a list of them, a switch (`false` ignores coverage), or an object
 * `{ "paths": …, "enabled": … }`; an error message otherwise.
 */
function normalizeCoverage(v: unknown): CoverageConfig | string {
  const on = asSwitch(v);
  if (on !== undefined) return { enabled: on };
  if (isStringList(v)) {
    const paths = asList(v).map((p) => p.trim()).filter(Boolean);
    return paths.length ? { paths } : '"coverage" must name report files or folders, e.g. "coverage/lcov.info".';
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '"coverage" must be a report path, a list of paths, true / false, or { "paths": [...], "enabled": true }.';
  const raw = v as Record<string, unknown>;
  const unknown = unknownKey('"coverage"', raw, ['paths', 'enabled']);
  if (unknown) return unknown;
  const result: CoverageConfig = {};
  if (raw.paths !== undefined) {
    if (!isStringList(raw.paths)) return 'coverage.paths must be a path or a list of paths.';
    result.paths = asList(raw.paths).map((p) => p.trim()).filter(Boolean);
  }
  if (raw.enabled !== undefined) {
    const enabled = asSwitch(raw.enabled);
    if (enabled === undefined) return 'coverage.enabled must be true or false.';
    result.enabled = enabled;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/*                     JSON with comments, without TypeScript                     */
/* -------------------------------------------------------------------------- */

const requireModule = createRequire(import.meta.url);

/** The TypeScript compiler, loaded only to explain a configuration file that is not valid JSON. */
function typescript(): typeof TypeScript {
  return requireModule('typescript') as typeof TypeScript;
}

/** Index after the string literal that starts at `start` (a `"`). */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

/**
 * Comments and trailing commas removed (tsconfig-style JSON), or undefined for an unterminated comment.
 * Strings are kept as they are.
 */
function stripJsonComments(text: string): string | undefined {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      out += ' ';
      i = end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  let result = '';
  for (let i = 0; i < out.length; ) {
    const ch = out[i];
    if (ch === '"') {
      const end = stringEnd(out, i);
      result += out.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') {
        i++;
        continue;
      }
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Parse tsconfig-style JSON (comments, trailing commas). Valid files never load the TypeScript compiler,
 * so `check` stays fast with a running server; anything else is parsed and explained by TypeScript,
 * exactly as before: `error` names the file, line and column.
 */
function parseJsonc(file: string, name: string, text: string): { value?: unknown; error?: string; notObject?: boolean } {
  const stripped = stripJsonComments(text);
  if (stripped !== undefined && stripped.trim()) {
    try {
      return { value: JSON.parse(stripped) as unknown };
    } catch {
      /* not plain JSON: let TypeScript explain it */
    }
  }
  const ts = typescript();
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  // TS 5092: "The root value of a 'tsconfig.json' file must be an object."
  if (error?.code === 5092) return { notObject: true };
  if (error) {
    const at = error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start) : undefined;
    const where = at ? `${name}:${at.line + 1}:${at.character + 1}` : name;
    return { value: config as unknown, error: `${where}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}` };
  }
  return { value: config as unknown };
}

// --- live-guard ---
const NOTIFY_WORDS: Record<string, NotifyMode> = { errors: 'errors', error: 'errors', all: 'all', off: 'off', none: 'off' };

/** `"errors"`, `"all"`, `"off"`, or a switch (`true` = errors). */
function notifyMode(v: unknown): NotifyMode | undefined {
  if (typeof v === 'boolean') return v ? 'errors' : 'off';
  if (typeof v !== 'string') return undefined;
  const word = v.trim().toLowerCase();
  if (NOTIFY_WORDS[word]) return NOTIFY_WORDS[word];
  const flag = BOOLEAN_WORDS[word];
  return flag === undefined ? undefined : flag ? 'errors' : 'off';
}

/** Event kinds as a name, a comma-separated string, a list or an object `{ "health": true }`; an error message for unknown kinds. */
function eventKinds(v: unknown, key: string): LiveEventKind[] | string {
  let names: string[] | undefined;
  if (typeof v === 'string') names = v.split(',');
  else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) names = v as string[];
  else if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((on) => typeof on === 'boolean')) {
    names = Object.entries(v).filter(([, on]) => on).map(([k]) => k);
  }
  if (!names) return `${key} must be a list of event kinds (${LIVE_EVENT_KINDS.join(', ')}).`;
  const kinds: LiveEventKind[] = [];
  for (const name of names.map((n) => n.trim().toLowerCase()).filter(Boolean)) {
    if (!isLiveEventKind(name)) {
      const hint = closest(name, LIVE_EVENT_KINDS);
      return `${key} has an unknown event kind "${name}"${hint ? ` — did you mean "${hint}"?` : ''} (use ${LIVE_EVENT_KINDS.join(', ')}).`;
    }
    if (!kinds.includes(name)) kinds.push(name);
  }
  return kinds;
}

/** An unknown key of a block, with the closest known one. */
function unknownKey(block: string, raw: Record<string, unknown>, known: readonly string[]): string | undefined {
  const key = Object.keys(raw).find((k) => !known.includes(k));
  if (key === undefined) return undefined;
  const hint = closest(key, known);
  return `${block} has an unknown key "${key}"${hint ? ` — did you mean "${hint}"?` : ''} (use ${known.join(', ')}).`;
}

/** The `serve` block (`"serve": "errors"` is short for its notify mode), or an error message naming the bad key. */
function normalizeServe(v: unknown): ServeConfig | string {
  if (typeof v === 'string' || typeof v === 'boolean') {
    const mode = notifyMode(v);
    return mode ? { notify: mode } : '"serve" must be an object such as { "notify": "errors" }, or a notify mode: "errors", "all" or "off".';
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '"serve" must be an object, e.g. { "notify": "errors" }.';
  const raw = v as Record<string, unknown>;
  const unknown = unknownKey('"serve"', raw, ['notify', 'events']);
  if (unknown) return unknown;
  const serve: ServeConfig = {};
  if (raw.notify !== undefined) {
    const mode = notifyMode(raw.notify);
    if (!mode) return 'serve.notify must be "errors", "all" or "off".';
    serve.notify = mode;
  }
  if (raw.events !== undefined) {
    const block = raw.events && typeof raw.events === 'object' && !Array.isArray(raw.events) ? (raw.events as Record<string, unknown>) : undefined;
    // `"events": ["health"]` and `"events": { "health": true }` are short for `"events": { "exclude": [...] }`.
    const shorthand = !block || (!('exclude' in block) && Object.keys(block).every((k) => isLiveEventKind(k.trim().toLowerCase())));
    if (block && !shorthand) {
      const bad = unknownKey('serve.events', block, ['exclude']);
      if (bad) return bad;
    }
    const exclude = eventKinds(shorthand ? raw.events : block!.exclude, 'serve.events.exclude');
    if (typeof exclude === 'string') return exclude;
    serve.events = { exclude };
  }
  return serve;
}

/** Read the configuration; `readText` reads it from a snapshot instead of the disk (see AnalyzeOptions.readText). */
export function loadConfig(root: string, readText?: ReadText): LoadedConfig {
  const files = projectFiles(root, readText);
  for (const name of CONFIG_FILES) {
    const file = path.join(root, name);
    const text = files.read(file);
    if (text === undefined) continue;
    // Comments and trailing commas are allowed (tsconfig-style JSON); anything else is reported, never ignored.
    const { value: config, error, notObject } = parseJsonc(file, name, text.replace(/^\uFEFF/, ''));
    if (notObject) return { file: name, config: {}, error: `${name} must contain a JSON object.` };
    if (error) return { file: name, config: {}, error };
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { file: name, config: {}, error: `${name} must contain a JSON object.` };
    const normalized = normalizeConfig(config as Record<string, unknown>);
    return { file: name, config: normalized.config, error: normalized.error && `${name}: ${normalized.error}` };
  }
  // package.json is read leniently, like everywhere else in the analyzer.
  const pkgFile = path.join(root, 'package.json');
  const pkgText = files.read(pkgFile);
  let pkg: { codeVisualizer?: unknown } | undefined;
  try {
    pkg = pkgText === undefined ? undefined : (parseJsonc(pkgFile, 'package.json', pkgText.replace(/^\uFEFF/, '')).value as typeof pkg);
  } catch {
    pkg = undefined;
  }
  if (pkg?.codeVisualizer !== undefined) {
    const file = 'package.json#codeVisualizer';
    if (!pkg.codeVisualizer || typeof pkg.codeVisualizer !== 'object' || Array.isArray(pkg.codeVisualizer)) return { file, config: {}, error: '"codeVisualizer" in package.json must be an object.' };
    const normalized = normalizeConfig(pkg.codeVisualizer as Record<string, unknown>);
    return { file, config: normalized.config, error: normalized.error && `${file}: ${normalized.error}` };
  }
  return { config: {} };
}

function matcher(patterns: string | string[] | undefined): ((id: string) => boolean) | undefined {
  const list = (Array.isArray(patterns) ? patterns : patterns ? [patterns] : []).filter(Boolean);
  if (!list.length) return undefined;
  const ig = ignore().add(list.map((p) => p.replace(/^\.\//, '')));
  return (id: string) => ig.ignores(id);
}

/** Evaluate `rules` and `layers` against the import graph. */
export function evaluateRules(config: CodeVisualizerConfig, edges: DependencyEdge[]): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const compiled = (config.rules ?? [])
    .map((rule, i) => ({
      name: rule.name ?? `rule-${i + 1}`,
      from: matcher(rule.from),
      to: matcher(rule.to),
      allow: matcher(rule.allow),
      severity: rule.severity ?? 'error',
      message: rule.message,
      includeTypes: rule.includeTypes !== false,
    }))
    .filter((r) => r.from && r.to);
  const layers = (config.layers ?? []).map((layer) => ({ label: Array.isArray(layer) ? layer.join(', ') : layer, match: matcher(layer)! })).filter((l) => l.match);
  const layerOf = (id: string): number => layers.findIndex((l) => l.match(id));

  for (const e of edges) {
    for (const rule of compiled) {
      if (e.typeOnly && !rule.includeTypes) continue;
      if (!rule.from!(e.source) || !rule.to!(e.target)) continue;
      if (rule.allow?.(e.target)) continue;
      violations.push({ rule: rule.name, severity: rule.severity, source: e.source, target: e.target, line: e.line, message: rule.message });
    }
    if (layers.length) {
      const a = layerOf(e.source);
      const b = layerOf(e.target);
      if (a !== -1 && b !== -1 && b < a) {
        violations.push({
          rule: 'layers',
          severity: 'error',
          source: e.source,
          target: e.target,
          line: e.line,
          message: `“${layers[a].label}” must not depend on the higher layer “${layers[b].label}”`,
        });
      }
    }
  }
  return violations.slice(0, 2000);
}
