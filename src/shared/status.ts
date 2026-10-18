/**
 * The ambient status line (`code-visualizer status`): a snapshot built from an analysis plus the small
 * state other commands leave behind (last check, last test run, last sync), and its renderings for shell
 * prompts, tmux, starship and agent status lines. Pure — shared by the CLI, the live server and the UI.
 */
import { terminalSafeDeep, terminalSafeLine } from './terminal-safe.js';
import type { LastCheckState, LastTestState, ReportData, StatusSnapshot as BaseSnapshot, SyncState } from './types.js';

/** What the status line also records about the tests your changes need and the coverage it shows (see StatusSnapshot). */
export type StatusDetails = Pick<BaseSnapshot, 'requiredTests' | 'testsCovered' | 'coverageKind' | 'coverageStale'>;

/** A status snapshot with the details above (kept for compatibility: every StatusSnapshot is one). */
export type DetailedStatus = BaseSnapshot;
type StatusSnapshot = DetailedStatus;

export type StatusFormat = 'short' | 'plain' | 'json' | 'tmux' | 'starship' | 'claude';
export const STATUS_FORMATS: readonly StatusFormat[] = ['short', 'plain', 'json', 'tmux', 'starship', 'claude'];

/** The parts of an analysis a status snapshot is built from. */
export type StatusData = Pick<ReportData, 'health' | 'changes' | 'git' | 'stats'> & Partial<Pick<ReportData, 'coverage'>>;

/** What the status line needs of the last test run: its outcome, the tree it tested and which tests ran. */
export type StatusLastTest = Pick<LastTestState, 'at' | 'passed' | 'treeId'> & Partial<Pick<LastTestState, 'files' | 'full' | 'fullPackages'>>;

/** What other commands recorded (`.code-visualizer/state.json`) and what the caller measured. */
export interface StatusContext {
  lastCheck?: Pick<LastCheckState, 'at' | 'ok'>;
  lastTest?: StatusLastTest;
  sync?: SyncState;
  /** The base of your work and how far apart you are (see `upstreamStatus` in src/analyzer/sync.ts). */
  upstream?: StatusSnapshot['upstream'];
  live?: StatusSnapshot['live'];
  /** When the analysis started (default: now). */
  generatedAt?: number;
  /** Full hash of HEAD and the index mtime when the analysis started (freshness of stored snapshots). */
  head?: string;
  indexMtime?: number;
  /** `workingTreeId` when the analysis started (a test run of the same tree counts as current). */
  treeId?: string;
}

/**
 * What `state.json → status` holds: a snapshot, or — after a refresh failed (not a JavaScript project, a
 * broken checkout) — only the freshness stamps, so the next prompt does not try again right away.
 */
export type StoredStatus = StatusSnapshot | { version: 1; generatedAt: number; head?: string; indexMtime?: number; error: string };

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Patch coverage of your changes (test-intelligence; a percentage) when they added executable lines, else
 * the project's line coverage (`Stats.lineCoverage`, a 0..1 ratio), in percent — with which one it is and
 * whether its report is older than the files it describes.
 */
function coverageOf(data: StatusData): { pct: number; kind: 'patch' | 'project'; stale: boolean } | undefined {
  const patch = data.changes?.coverage;
  if (patch?.coverable && isNumber(patch.pct)) return { pct: Math.round(patch.pct), kind: 'patch', stale: !!patch.stale };
  const line = data.stats.lineCoverage;
  return isNumber(line) ? { pct: Math.round(line * 100), kind: 'project', stale: !!data.coverage?.stale } : undefined;
}

/** Test ids kept in a snapshot; a longer selection keeps only its size and a hash. */
export const MAX_REQUIRED_TESTS = 500;

/** FNV-1a of the sorted, de-duplicated list (no crypto: this module also runs in the browser). */
function hashList(list: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const ch of [...new Set(list)].sort().join('\n')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function requiredTestsOf(files: readonly string[]): NonNullable<StatusSnapshot['requiredTests']> {
  const sorted = [...new Set(files)].sort();
  return { count: sorted.length, hash: hashList(sorted), ...(sorted.length <= MAX_REQUIRED_TESTS ? { files: sorted } : {}) };
}

/**
 * How many of `required` (test ids) a test run covered: the ones it ran by path, and those in a package it
 * ran in full ('' = the project root, every package). Shared with the agents' stop gate.
 */
export function testsCovered(lastTest: Partial<Pick<LastTestState, 'files' | 'full' | 'fullPackages'>> | undefined, required: readonly string[]): number {
  if (!lastTest) return 0;
  const ran = new Set(lastTest.files ?? []);
  const full = lastTest.full ? (lastTest.fullPackages ?? ['']) : [];
  return required.filter((file) => ran.has(file) || full.some((dir) => dir === '' || file.startsWith(`${dir}/`))).length;
}

/** How many of a snapshot's required tests the run covered (its ids; else a whole-suite run, or exactly the same selection). */
function coveredOf(s: StatusSnapshot, t: StatusLastTest): number | undefined {
  const req = s.requiredTests;
  const wholeProject = !!t.full && (t.fullPackages ?? ['']).includes('');
  if (!req) return wholeProject && s.changes?.tests ? s.changes.tests : undefined;
  if (req.files) return testsCovered(t, req.files);
  if (wholeProject) return req.count;
  return t.files && hashList(t.files) === req.hash ? req.count : 0;
}

export function buildStatus(data: StatusData, ctx: StatusContext = {}): StatusSnapshot {
  const c = data.changes;
  const delta = c?.delta;
  const snapshot: StatusSnapshot = {
    version: 1,
    generatedAt: ctx.generatedAt ?? Date.now(),
    health: { score: data.health.score, delta: delta ? delta.health.after - delta.health.before : 0 },
    problems: {
      newCycles: delta?.newCycles.length ?? 0,
      newViolations: delta?.newViolations.length ?? 0,
    },
  };
  if (ctx.head) snapshot.head = ctx.head;
  if (data.git?.branch && data.git.branch !== 'HEAD') snapshot.branch = data.git.branch;
  if (c && c.files.length) {
    snapshot.changes = { files: c.files.length, impacted: c.impacted.length, tests: c.tests.files.length, risk: c.risk.score, level: c.risk.level };
    // Which tests: a run of only some of them (`test --staged`, one file) must not turn them all green.
    if (c.tests.files.length) snapshot.requiredTests = requiredTestsOf(c.tests.files);
  }
  if (ctx.upstream) snapshot.upstream = { ...ctx.upstream };
  const coverage = coverageOf(data);
  if (coverage !== undefined) {
    snapshot.coverage = coverage.pct;
    snapshot.coverageKind = coverage.kind;
    if (coverage.stale) snapshot.coverageStale = true;
  }
  if (ctx.live) snapshot.live = { ...ctx.live };
  if (ctx.indexMtime !== undefined) snapshot.indexMtime = ctx.indexMtime;
  if (ctx.treeId) snapshot.treeId = ctx.treeId;
  // clone-radar: copies your work adds, and copies it changed while their clone stayed as it was.
  const clones = { new: delta?.newClones?.length ?? 0, drift: c?.cloneDrift?.length ?? 0 };
  if (clones.new || clones.drift) snapshot.clones = clones;
  return withState(snapshot, ctx);
}

/**
 * The snapshot with what other commands recorded since it was built: the last check and test run (and how
 * many of the required tests it covered), and the conflicts, overlap and semantic breaks of a `sync` made
 * for the same HEAD and base — all of a sync made after the snapshot (it saw a newer base).
 */
export function withState(s: StatusSnapshot, ctx: Pick<StatusContext, 'lastCheck' | 'lastTest' | 'sync' | 'live'>): StatusSnapshot {
  const out: StatusSnapshot = { ...s, health: { ...s.health }, problems: { ...s.problems } };
  if (ctx.lastCheck) out.lastCheck = { at: ctx.lastCheck.at, ok: ctx.lastCheck.ok };
  if (ctx.lastTest) {
    out.lastTest = { at: ctx.lastTest.at, passed: ctx.lastTest.passed, ...(ctx.lastTest.treeId ? { treeId: ctx.lastTest.treeId } : {}) };
    const covered = coveredOf(s, ctx.lastTest);
    if (covered === undefined) delete out.testsCovered;
    else out.testsCovered = covered;
  }
  if (ctx.live) out.live = { ...ctx.live };
  const sync = ctx.sync;
  // A sync for another HEAD (you committed or switched branches since) says nothing about now.
  if (sync && (!s.head || !sync.head || sync.head === s.head)) {
    const up = out.upstream;
    const semantic = sync.semantic ? { semantic: sync.semantic } : {};
    const fromSync = { name: sync.base, ahead: sync.ahead, behind: sync.behind, conflicts: sync.conflicts, overlap: sync.overlap, ...semantic };
    // Made after the snapshot for the same HEAD: it saw the base as it is now (a fetch since moved it).
    const newer = !!s.head && sync.head === s.head && sync.at > s.generatedAt;
    if (!up) out.upstream = fromSync;
    else if (up.name === sync.base && newer) out.upstream = fromSync;
    else if (up.name === sync.base && up.behind === sync.behind) out.upstream = { ...up, conflicts: up.conflicts ?? sync.conflicts, overlap: up.overlap ?? sync.overlap, ...(up.semantic === undefined ? semantic : {}) };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                         Reading state written by others                     */
/* -------------------------------------------------------------------------- */

/**
 * A stored snapshot, or undefined when the value has another shape (an older or damaged state file). The
 * live server's link is never taken from it: a state file can come with the repository, and the link would
 * point anywhere (see `trustedLive` for a live server's own answer).
 */
export function asStoredStatus(v: unknown): StoredStatus | undefined {
  if (!isObject(v) || v.version !== 1 || !isNumber(v.generatedAt)) return undefined;
  const { live: _live, ...rest } = v;
  if (typeof v.error === 'string' && !isObject(v.health)) return rest as StoredStatus;
  const health = v.health as Record<string, unknown> | undefined;
  const problems = v.problems as Record<string, unknown> | undefined;
  if (!isObject(health) || !isNumber(health.score) || !isNumber(health.delta)) return undefined;
  if (!isObject(problems) || !isNumber(problems.newCycles) || !isNumber(problems.newViolations)) return undefined;
  // The required tests are compared with what ran: only a well-formed list counts.
  const req = rest.requiredTests;
  if (req !== undefined && !(isObject(req) && isNumber(req.count) && typeof req.hash === 'string' && (req.files === undefined || (Array.isArray(req.files) && req.files.every((f) => typeof f === 'string'))))) delete rest.requiredTests;
  return rest as unknown as StatusSnapshot;
}

/** An http(s) URL of this machine (127.0.0.1, localhost or [::1]), without credentials. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** The `live` part of a running server's `/api/status` answer, when it is a page on this machine. */
export function trustedLive(answer: unknown): StatusSnapshot['live'] | undefined {
  const live = isObject(answer) ? answer.live : undefined;
  if (!isObject(live) || typeof live.url !== 'string' || !isLoopbackUrl(live.url)) return undefined;
  return { url: live.url, ...(isNumber(live.open) && live.open > 0 ? { open: live.open } : {}) };
}

export function isSnapshot(s: StoredStatus | undefined): s is StatusSnapshot {
  return !!s && 'health' in s;
}

/** The status-relevant parts of `.code-visualizer/state.json` (sections of check, test and sync). */
export function statusContextFromState(state: Record<string, unknown>): Pick<StatusContext, 'lastCheck' | 'lastTest' | 'sync'> {
  const ctx: Pick<StatusContext, 'lastCheck' | 'lastTest' | 'sync'> = {};
  const check = state.lastCheck;
  if (isObject(check) && isNumber(check.at) && typeof check.ok === 'boolean') ctx.lastCheck = { at: check.at, ok: check.ok };
  const test = state.lastTest;
  if (isObject(test) && isNumber(test.at) && typeof test.passed === 'boolean') {
    const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);
    const files = strings(test.files);
    const fullPackages = strings(test.fullPackages);
    ctx.lastTest = {
      at: test.at,
      passed: test.passed,
      ...(typeof test.treeId === 'string' ? { treeId: test.treeId } : {}),
      ...(files ? { files } : {}),
      ...(typeof test.full === 'boolean' ? { full: test.full } : {}),
      ...(fullPackages ? { fullPackages } : {}),
    };
  }
  const sync = state.sync;
  if (isObject(sync) && isNumber(sync.at) && typeof sync.base === 'string' && isNumber(sync.behind) && isNumber(sync.ahead)) {
    ctx.sync = {
      at: sync.at,
      head: typeof sync.head === 'string' ? sync.head : undefined,
      base: sync.base,
      baseCommit: typeof sync.baseCommit === 'string' ? sync.baseCommit : undefined,
      ahead: sync.ahead,
      behind: sync.behind,
      conflicts: isNumber(sync.conflicts) ? sync.conflicts : 0,
      overlap: isNumber(sync.overlap) ? sync.overlap : 0,
      semantic: isNumber(sync.semantic) ? sync.semantic : 0,
    };
  }
  return ctx;
}

/* -------------------------------------------------------------------------- */
/*                                  Formatting                                 */
/* -------------------------------------------------------------------------- */

type Tone = 'good' | 'warn' | 'bad' | 'dim' | 'accent' | undefined;

interface Part {
  text: string;
  tone?: Tone;
}

const ANSI: Record<Exclude<Tone, undefined>, [string, string]> = {
  good: ['\x1b[32m', '\x1b[39m'],
  warn: ['\x1b[33m', '\x1b[39m'],
  bad: ['\x1b[31m', '\x1b[39m'],
  dim: ['\x1b[2m', '\x1b[22m'],
  accent: ['\x1b[35m', '\x1b[39m'],
};
const TMUX: Record<Exclude<Tone, undefined>, string> = { good: 'green', warn: 'yellow', bad: 'red', dim: 'colour244', accent: 'magenta' };

/** `origin/main` → `main` (the remote is implied in a status line). */
export function shortRef(name: string): string {
  return name.replace(/^(?:refs\/(?:remotes|heads)\/)?(?:origin|upstream)\//, '');
}

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

/** The segments of the compact line: `◆ 82▼3 · 5Δ→23 · 3 tests · ✖1 new cycle · ⧉1 new copy · ↓7 main (1 conflict) · cov 72%`. */
function compactParts(s: StatusSnapshot): Part[][] {
  const segments: Part[][] = [];
  const d = s.health.delta;
  const healthTone: Tone = s.health.score >= 80 ? 'good' : s.health.score >= 60 ? 'warn' : 'bad';
  segments.push([{ text: '◆', tone: 'accent' }, { text: ` ${s.health.score}`, tone: healthTone }, ...(d ? [{ text: d < 0 ? `▼${-d}` : `▲${d}`, tone: (d < 0 ? 'bad' : 'good') as Tone }] : [])]);
  if (s.changes) {
    const tone: Tone = s.changes.level === 'high' ? 'bad' : s.changes.level === 'medium' ? 'warn' : undefined;
    segments.push([{ text: `${s.changes.files}Δ${s.changes.impacted ? `→${s.changes.impacted}` : ''}`, tone }]);
    if (s.changes.tests) segments.push([{ text: plural(s.changes.tests, 'test') }, ...testMark(s)]);
  }
  if (!s.changes?.tests && s.lastTest && !s.lastTest.passed) segments.push([{ text: '✖ tests', tone: 'bad' }]);
  if (s.problems.newCycles) segments.push([{ text: `✖${s.problems.newCycles} new ${s.problems.newCycles === 1 ? 'cycle' : 'cycles'}`, tone: 'bad' }]);
  if (s.problems.newViolations) segments.push([{ text: `✖${s.problems.newViolations} rule ${s.problems.newViolations === 1 ? 'break' : 'breaks'}`, tone: 'bad' }]);
  if (s.clones?.new) segments.push([{ text: `⧉${plural(s.clones.new, 'new copy', 'new copies')}`, tone: 'warn' }]);
  if (s.clones?.drift) segments.push([{ text: `⧉${plural(s.clones.drift, 'drifted copy', 'drifted copies')}`, tone: 'warn' }]);
  if (s.lastCheck && !s.lastCheck.ok) segments.push([{ text: '✖ check', tone: 'bad' }]);
  const up = s.upstream;
  if (up && up.behind > 0) {
    const what = upstreamTrouble(up);
    const trouble = what ? [{ text: ` (${what})`, tone: 'bad' as Tone }] : [];
    segments.push([{ text: `↓${up.behind} ${shortRef(up.name)}`, tone: what ? 'warn' : undefined }, ...trouble]);
  }
  if (s.coverage !== undefined) segments.push(coverageParts(s));
  return segments;
}

/**
 * `patch 64%` (the lines your changes added) or `cov 72%` (the project), with a dim `?` when the coverage
 * report is older than files it describes.
 */
function coverageParts(s: StatusSnapshot): Part[] {
  const pct = s.coverage ?? 0;
  const parts: Part[] = [{ text: `${s.coverageKind === 'patch' ? 'patch' : 'cov'} ${pct}%`, tone: pct >= 80 ? undefined : pct >= 50 ? 'warn' : 'bad' }];
  if (s.coverageStale) parts.push({ text: '?', tone: 'dim' });
  return parts;
}

/** `1 conflict, 2 breaks`: what a rebase on the upstream would do (conflicts, and code it breaks that git merges cleanly). */
function upstreamTrouble(up: NonNullable<StatusSnapshot['upstream']>): string {
  return [up.conflicts ? plural(up.conflicts, 'conflict') : '', up.semantic ? plural(up.semantic, 'break') : ''].filter(Boolean).join(', ');
}

/**
 * The last test run passed on what the snapshot describes: it ran after the analysis behind it (so after
 * your latest edit), or — test-intelligence records the tree it tested — on the very same working tree.
 */
function passedNow(s: StatusSnapshot): boolean {
  const t = s.lastTest;
  return !!t?.passed && (t.at >= s.generatedAt || (!!t.treeId && t.treeId === s.treeId));
}

/**
 * How the last passing run on the current work relates to the tests your changes need: 'all' (every one
 * ran — by path, or its package in full), 'some' (`1/2`), or undefined (none of them, or not current).
 */
function testCoverage(s: StatusSnapshot): { covered: number; of: number; all: boolean } | undefined {
  if (!passedNow(s) || !s.changes?.tests) return undefined;
  const of = s.requiredTests?.count ?? s.changes.tests;
  const covered = Math.min(s.testsCovered ?? 0, of);
  return covered > 0 ? { covered, of, all: covered >= of } : undefined;
}

/**
 * `✔` when the last test run passed on the current work (see `passedNow`) and ran every test it needs;
 * `1/2` when it ran only some of them; `✖` when it failed.
 */
function testMark(s: StatusSnapshot): Part[] {
  if (!s.lastTest) return [];
  if (!s.lastTest.passed) return [{ text: ' ✖', tone: 'bad' }];
  const run = testCoverage(s);
  if (!run) return [];
  return run.all ? [{ text: ' ✔', tone: 'good' }] : [{ text: ` ${run.covered}/${run.of}`, tone: 'warn' }];
}

/** The words version: `health 82 (−3) · 5 changed → 23 affected · 3 tests to run · …`. */
function plainParts(s: StatusSnapshot): string[] {
  const out: string[] = [];
  const d = s.health.delta;
  out.push(`health ${s.health.score}${d ? ` (${d > 0 ? '+' : '−'}${Math.abs(d)})` : ''}`);
  if (s.changes) {
    out.push(`${s.changes.files} changed${s.changes.impacted ? ` → ${s.changes.impacted} affected` : ''}`);
    if (s.changes.tests) {
      const run = testCoverage(s);
      const note = s.lastTest && !s.lastTest.passed ? ' (last run failed)' : run?.all ? ' (passed)' : run ? ` (${run.covered} of ${run.of} passed)` : '';
      out.push(`${plural(s.changes.tests, 'test')} to run${note}`);
    }
    out.push(`risk ${s.changes.level}`);
  } else if (s.lastTest && !s.lastTest.passed) out.push('last test run failed');
  if (s.problems.newCycles) out.push(`${plural(s.problems.newCycles, 'new cycle')}`);
  if (s.problems.newViolations) out.push(`${plural(s.problems.newViolations, 'new rule violation')}`);
  if (s.clones?.new) out.push(plural(s.clones.new, 'new copy-paste clone'));
  if (s.clones?.drift) out.push(plural(s.clones.drift, 'copy changed without its clone', 'copies changed without their clones'));
  if (s.lastCheck && !s.lastCheck.ok) out.push('last check failed');
  const up = s.upstream;
  if (up && up.behind > 0) {
    const trouble = [up.conflicts ? plural(up.conflicts, 'conflict') : '', up.semantic ? `${plural(up.semantic, 'incoming change')} that ${up.semantic === 1 ? 'breaks' : 'break'} your code` : ''].filter(Boolean).join(', ');
    out.push(`${up.behind} behind ${shortRef(up.name)}${trouble ? ` (${trouble})` : ''}`);
  }
  if (s.coverage !== undefined) out.push(`${s.coverageKind === 'patch' ? 'patch coverage' : 'coverage'} ${s.coverage}%${s.coverageStale ? ' (report older than the code)' : ''}`);
  return out;
}

export interface FormatStatusOptions {
  /** ANSI colours (short and claude); tmux always uses its own colour codes, plain and starship none. */
  color?: boolean;
  /** The snapshot is outdated: marked with `↻` (claude and plain say whether it is being updated). */
  stale?: boolean;
  /** A refresh is running (claude: `updating…`, plain: `(updating)`; otherwise `outdated`). */
  updating?: boolean;
  /** The latest refresh failed (the numbers are older): marked with `!` (claude and plain: the message). */
  error?: string;
  /** OSC 8 links (claude: the live server's My changes page). Default: true. */
  hyperlinks?: boolean;
}

function ansi(parts: Part[], color: boolean): string {
  return parts.map((p) => (color && p.tone ? `${ANSI[p.tone][0]}${p.text}${ANSI[p.tone][1]}` : p.text)).join('');
}

/** tmux format strings treat `#` specially. */
const tmuxEscape = (text: string): string => text.replace(/#/g, '##');

function tmux(parts: Part[]): string {
  return parts.map((p) => (p.tone ? `#[fg=${TMUX[p.tone]}]${tmuxEscape(p.text)}#[fg=default]` : tmuxEscape(p.text))).join('');
}

/** An OSC 8 terminal hyperlink. */
export function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Two lines for agent status lines (Claude Code): the project and your work, then branch, base and checks. */
function claudeLines(s: StatusSnapshot, o: Required<FormatStatusOptions>): string {
  const c = (text: string, tone: Tone): string => ansi([{ text, tone }], o.color);
  const sep = c(' · ', 'dim');
  const first: string[] = [];
  const d = s.health.delta;
  first.push(`${c('◆', 'accent')} ${c(`health ${s.health.score}`, s.health.score >= 80 ? 'good' : s.health.score >= 60 ? 'warn' : 'bad')}${d ? c(d < 0 ? ` ▼${-d}` : ` ▲${d}`, d < 0 ? 'bad' : 'good') : ''}`);
  if (s.changes) {
    first.push(`${s.changes.files} changed${s.changes.impacted ? ` → ${s.changes.impacted} affected` : ''}`);
    if (s.changes.tests) first.push(`${plural(s.changes.tests, 'test')} to run${ansi(testMark(s), o.color)}`);
    first.push(c(`risk ${s.changes.level}`, s.changes.level === 'high' ? 'bad' : s.changes.level === 'medium' ? 'warn' : 'good'));
  } else first.push(c('no changes', 'dim'));
  const second: string[] = [];
  if (s.branch) second.push(`⎇ ${s.branch}`);
  const up = s.upstream;
  const trouble = up ? upstreamTrouble(up) : '';
  if (up) second.push(up.behind ? `${c(`↓${up.behind} ${shortRef(up.name)}`, trouble ? 'warn' : undefined)}${trouble ? c(` (${trouble})`, 'bad') : ''}` : c(`up to date with ${shortRef(up.name)}`, 'dim'));
  if (s.problems.newCycles) second.push(c(`✖ ${plural(s.problems.newCycles, 'new cycle')}`, 'bad'));
  if (s.problems.newViolations) second.push(c(`✖ ${plural(s.problems.newViolations, 'rule break')}`, 'bad'));
  if (s.clones?.new) second.push(c(`⧉ ${plural(s.clones.new, 'new copy', 'new copies')}`, 'warn'));
  if (s.clones?.drift) second.push(c(`⧉ ${plural(s.clones.drift, 'drifted copy', 'drifted copies')}`, 'warn'));
  if (s.lastCheck) second.push(s.lastCheck.ok ? c('✔ check', 'good') : c('✖ check', 'bad'));
  if (s.lastTest && !s.lastTest.passed && !s.changes?.tests) second.push(c('✖ tests', 'bad'));
  if (s.coverage !== undefined) second.push(ansi(coverageParts(s), o.color));
  // Only a page on this machine is linked (and only one a live server named: stored snapshots drop it).
  const live = s.live && isLoopbackUrl(s.live.url) ? s.live : undefined;
  if (live?.open) second.push(c(`${plural(live.open, 'open problem')}`, 'warn'));
  if (live) {
    const url = `${live.url.replace(/#.*$/, '')}#/changes`;
    second.push(o.hyperlinks ? osc8(url, c('My changes ↗', 'accent')) : c(url, 'dim'));
  }
  if (!second.length) second.push(c('code-visualizer', 'dim'));
  const stale = o.stale ? c(o.updating ? ' · updating…' : ' · outdated', 'dim') : o.error ? `${sep}${c(`! refresh failed: ${o.error}`, 'warn')}` : '';
  return `${first.join(sep)}${stale}\n${second.join(sep)}`;
}

/** The trailing mark of the compact formats: `↻` outdated, `!` the latest refresh failed. */
function mark(o: Required<FormatStatusOptions>): Part[] {
  if (o.stale) return [{ text: ' ↻', tone: 'dim' }];
  return o.error ? [{ text: ' !', tone: 'warn' }] : [];
}

/**
 * Render a snapshot (no trailing newline). Every string in it — branch and base names, the error, anything
 * a state file may hold — is printed with its control characters made visible: a status line must never
 * carry someone else's escape sequences (window titles, screen clears, links) into the terminal.
 */
export function formatStatus(snapshot: StatusSnapshot, format: StatusFormat, options: FormatStatusOptions = {}): string {
  const s = terminalSafeDeep(snapshot, terminalSafeLine);
  const o: Required<FormatStatusOptions> = { color: options.color ?? false, stale: options.stale ?? false, updating: options.updating ?? false, error: terminalSafeLine(options.error ?? ''), hyperlinks: options.hyperlinks ?? true };
  switch (format) {
    case 'json':
      return JSON.stringify({ ...s, ...(o.stale ? { stale: true } : {}), ...(o.stale && o.updating ? { updating: true } : {}) });
    case 'plain':
      return `${plainParts(s).join(' · ')}${o.stale ? (o.updating ? ' (updating)' : ' (outdated)') : o.error ? ` (refresh failed: ${o.error})` : ''}`;
    case 'claude':
      return claudeLines(s, o);
    case 'tmux':
      return `${compactParts(s).map(tmux).join(tmux([{ text: ' · ', tone: 'dim' }]))}${tmux(mark(o))}`;
    case 'starship':
      return `${compactParts(s).map((p) => ansi(p, false)).join(' · ')}${ansi(mark(o), false)}`;
    default: {
      const segments = compactParts(s).map((p) => ansi(p, o.color)).join(ansi([{ text: ' · ', tone: 'dim' }], o.color));
      return `${segments}${ansi(mark(o), o.color)}`;
    }
  }
}
