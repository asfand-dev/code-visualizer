/**
 * What the next release contains: the commits since the last version tag, the changes to the
 * published API since then (the tag is analyzed like any other ref) and the version that fits.
 */
import type { CodeVisualizerConfig } from './config.js';
import { compareReports } from './compare.js';
import { git, resolveCommit } from './git.js';
import { compareUrl, parseCommit, parseSemver, releaseBump } from '../shared/release.js';
import type { ExportChange, ReleaseCheck, ReleaseCommit, ReleasePlan, ReportSnapshot } from '../shared/types.js';

/** Commits kept in the plan; `commitCount` has the real number. */
const MAX_COMMITS = 300;
/** Tags looked at when searching for the latest version tag. */
const MAX_TAGS = 100;
const FIELD = '\x1f';
const RECORD = '\x1e';

export interface ReleaseInput {
  /** The analysis of the project as it is now. */
  head: ReportSnapshot;
  /** Analyzes another ref (`snapshotAt`). */
  snapshot: (ref: string) => Promise<ReportSnapshot>;
  config?: CodeVisualizerConfig;
  packageVersion?: string;
  remote?: string;
  /** Commits `origin/main` has that this branch lacks. */
  behind?: number;
  /** Start from this tag or commit instead of the latest version tag. */
  since?: string;
}

/** The latest version tag (`v1.2.3`, `1.2.3`) reachable from HEAD, stable releases first. */
export async function latestVersionTag(root: string): Promise<string | undefined> {
  const out = await git(root, ['tag', '--merged', 'HEAD', '--sort=-creatordate']);
  const tags = (out ?? '').split('\n').map((t) => t.trim()).filter(Boolean).slice(0, MAX_TAGS);
  const versions = tags.filter((t) => parseSemver(t));
  const stable = versions.find((t) => !parseSemver(t)!.pre);
  if (stable ?? versions[0]) return stable ?? versions[0];
  return (await git(root, ['describe', '--tags', '--abbrev=0']))?.trim() || undefined;
}

/**
 * Files with uncommitted work (edited, staged or untracked, not ignored) in the project folder, asked of
 * git directly: the change set depends on the branch (on `main` with unpushed commits it is the branch).
 * Undefined when git cannot say.
 */
async function uncommittedFiles(root: string): Promise<number | undefined> {
  const out = await git(root, ['status', '--porcelain', '--untracked-files=all', '--', '.']);
  return out === undefined ? undefined : out.split('\n').filter(Boolean).length;
}

async function commitsSince(root: string, ref: string): Promise<{ commits: ReleaseCommit[]; count: number }> {
  const [log, count] = await Promise.all([
    git(root, ['log', `${ref}..HEAD`, '--no-merges', `--max-count=${MAX_COMMITS}`, `--format=%H${FIELD}%an${FIELD}%ct${FIELD}%s${FIELD}%b${RECORD}`]),
    git(root, ['rev-list', '--count', '--no-merges', `${ref}..HEAD`]),
  ]);
  const commits = (log ?? '')
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record): ReleaseCommit => {
      const [hash, author, date, subject, body = ''] = record.split(FIELD);
      return { hash, author, date: Number(date) * 1000, subject, ...parseCommit(subject, body) };
    });
  return { commits, count: Number(count?.trim()) || commits.length };
}

/** Breaking API changes first, then by file. */
const orderApi = (changes: ExportChange[]): ExportChange[] =>
  [...changes].sort((a, b) => Number(!!b.entry) - Number(!!a.entry) || Number(b.breaking) - Number(a.breaking) || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

export async function buildReleasePlan(root: string, input: ReleaseInput): Promise<ReleasePlan> {
  const warnings: string[] = [];
  const tag = input.since ? ((await resolveCommit(root, input.since)) ? input.since : undefined) : await latestVersionTag(root);
  if (input.since && !tag) warnings.push(`"${input.since}" is not a tag or commit of this repository.`);
  const empty: ReleasePlan = {
    commits: [],
    commitCount: 0,
    bump: { level: 'none', fromCommits: 'none', reasons: [tag ? 'No commits since the last release.' : 'This project has no version tag yet: tag a release (`git tag v0.1.0`) to start tracking what ships.'] },
    apiChanges: [],
    checks: [],
    packageVersion: input.packageVersion,
    ...(warnings.length ? { warnings } : {}),
  };
  if (!tag) return empty;

  const tagTime = (await git(root, ['log', '-1', '--format=%ct', `${tag}^{commit}`]))?.trim();
  const [{ commits, count }, dirty] = await Promise.all([commitsSince(root, tag), uncommittedFiles(root)]);
  const lastVersion = parseSemver(tag) ? tag.replace(/^v/, '') : undefined;

  let apiChanges: ExportChange[] | undefined;
  let delta: ReturnType<typeof compareReports> | undefined;
  try {
    const base = await input.snapshot(tag);
    delta = compareReports(base, input.head, { config: input.config, base: tag, head: 'working tree', areas: false, complexityThreshold: input.config?.check?.maxComplexity });
    apiChanges = orderApi(delta.exports);
  } catch (error) {
    warnings.push(`Could not compare with ${tag}: ${(error as Error).message}`);
  }

  const bump = releaseBump({ lastVersion, commits, apiChanges });
  const checks: ReleaseCheck[] = [
    ...(dirty !== undefined ? [{ id: 'clean', ok: dirty === 0, label: dirty === 0 ? 'Working tree is clean' : `${dirty} uncommitted ${dirty === 1 ? 'file' : 'files'}`, detail: dirty ? 'Commit or stash them: a release is made from commits.' : undefined }] : []),
    ...(input.behind !== undefined ? [{ id: 'upstream', ok: input.behind === 0, label: input.behind === 0 ? 'Up to date with the upstream branch' : `${input.behind} commits behind the upstream branch`, detail: input.behind ? 'Pull before releasing, so the release has what the team has.' : undefined }] : []),
  ];
  if (delta) {
    const cycles = delta.newCycles.length;
    const rules = delta.newViolations.length;
    checks.push(
      { id: 'cycles', ok: cycles === 0, label: cycles === 0 ? `No new import cycles since ${tag}` : `${cycles} new import ${cycles === 1 ? 'cycle' : 'cycles'} since ${tag}` },
      { id: 'rules', ok: rules === 0, label: rules === 0 ? `No new architecture rule violations since ${tag}` : `${rules} new architecture rule ${rules === 1 ? 'violation' : 'violations'} since ${tag}` },
      { id: 'health', ok: delta.health.after >= delta.health.before, label: `Health score ${delta.health.before} → ${delta.health.after}`, detail: delta.health.after < delta.health.before ? 'The codebase is harder to maintain than it was at the last release.' : undefined },
    );
  }

  const compare = compareUrl(input.remote, tag);
  return {
    tag,
    ...(tagTime ? { tagDate: Number(tagTime) * 1000 } : {}),
    ...(lastVersion ? { lastVersion } : {}),
    packageVersion: input.packageVersion,
    commits,
    commitCount: count,
    bump,
    apiChanges: apiChanges ?? [],
    checks,
    ...(compare ? { compareUrl: compare } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
