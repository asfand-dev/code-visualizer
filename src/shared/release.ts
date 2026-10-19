/**
 * Release planning: Conventional Commits, semantic versions, the bump a set of changes deserves and
 * the release notes. Pure — the analyzer fills in the git and API facts, the CLI and the report UI
 * show what this module decides.
 */
import type { CommitType, ExportChange, ReleaseBump, ReleaseCommit, ReleasePlan } from './types.js';

const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const PR_SUFFIX_RE = /\s*\(#(\d+)\)\s*$/;

const TYPE_ALIASES: Record<string, CommitType> = {
  feat: 'feat', feature: 'feat', fix: 'fix', bugfix: 'fix', hotfix: 'fix', perf: 'perf', refactor: 'refactor', docs: 'docs', doc: 'docs',
  test: 'test', tests: 'test', build: 'build', ci: 'ci', chore: 'chore', style: 'style', revert: 'revert',
};

/** For commits that do not follow the convention: the leading verb says what kind of change it was. */
function typeFromVerb(subject: string): CommitType {
  const verb = /^\s*([A-Za-z]+)/.exec(subject)?.[1]?.toLowerCase();
  if (!verb) return 'other';
  if (/^(fix|fixes|fixed|fixing|hotfix|bugfix|resolve|resolves|resolved|patch)$/.test(verb)) return 'fix';
  if (/^(add|adds|added|adding|implement|implements|implemented|introduce|introduces|support|supports|new|create|creates|created)$/.test(verb)) return 'feat';
  if (verb === 'revert') return 'revert';
  if (/^(refactor|refactors|refactored|cleanup|clean|simplify|simplified|rename|renamed|move|moved)$/.test(verb)) return 'refactor';
  if (/^(doc|docs|document|documented|readme)$/.test(verb)) return 'docs';
  if (/^(bump|chore|release|merge)$/.test(verb)) return 'chore';
  return 'other';
}

const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGES?:/m;

/** The subject follows Conventional Commits with a type this module knows (`feat(cart): add currency`). */
export function isConventional(subject: string): boolean {
  const match = CONVENTIONAL_RE.exec(subject.replace(PR_SUFFIX_RE, '').trim());
  return !!match && Object.hasOwn(TYPE_ALIASES, match[1].toLowerCase());
}

/** `feat(cart)!: add currency (#12)` → type, scope, breaking, description and pull request number. */
export function parseCommit(subject: string, body = ''): Pick<ReleaseCommit, 'type' | 'scope' | 'breaking' | 'description' | 'pr'> {
  let text = subject.trim();
  let pr: number | undefined;
  const merge = /^Merge pull request #(\d+)\b/i.exec(text);
  if (merge) {
    // GitHub merge commits carry the real title in the body.
    pr = Number(merge[1]);
    text = body.split('\n').find((l) => l.trim())?.trim() ?? text;
  } else {
    const suffix = PR_SUFFIX_RE.exec(text);
    if (suffix) {
      pr = Number(suffix[1]);
      text = text.slice(0, suffix.index);
    }
  }
  const breakingFooter = BREAKING_FOOTER_RE.test(body);
  const match = CONVENTIONAL_RE.exec(text);
  const alias = match ? TYPE_ALIASES[match[1].toLowerCase()] : undefined;
  if (match && alias) {
    const breaking = !!match[3] || breakingFooter;
    return { type: alias, scope: match[2]?.trim() || undefined, ...(breaking ? { breaking } : {}), description: match[4].trim(), ...(pr ? { pr } : {}) };
  }
  return { type: typeFromVerb(text), ...(breakingFooter ? { breaking: true } : {}), description: text, ...(pr ? { pr } : {}) };
}

/* ------------------------------- Versions ---------------------------------- */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre?: string;
}

export function parseSemver(version: string | undefined): Semver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec((version ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(m[4] ? { pre: m[4] } : {}) } : undefined;
}

/** The version after a release of the given level (a pre-release version is released as itself). */
export function bumpVersion(version: string | undefined, level: ReleaseBump): string | undefined {
  const v = parseSemver(version);
  if (!v || level === 'none') return undefined;
  if (v.pre) return `${v.major}.${v.minor}.${v.patch}`;
  if (level === 'major') return `${v.major + 1}.0.0`;
  if (level === 'minor') return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

const LEVELS: ReleaseBump[] = ['none', 'patch', 'minor', 'major'];
const maxLevel = (a: ReleaseBump, b: ReleaseBump): ReleaseBump => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

/** What the commits ask for: breaking → major, feat → minor, fixes and other changes → patch. */
export function commitBump(commits: Pick<ReleaseCommit, 'type' | 'breaking'>[]): ReleaseBump {
  let level: ReleaseBump = 'none';
  for (const c of commits) {
    if (c.breaking) return 'major';
    if (c.type === 'feat') level = maxLevel(level, 'minor');
    else if (c.type === 'fix' || c.type === 'perf' || c.type === 'refactor' || c.type === 'revert' || c.type === 'other') level = maxLevel(level, 'patch');
  }
  return level;
}

/**
 * What the changes of the published API ask for. Only declarations the package publishes (`entry`)
 * count: removing or changing one is major, adding or widening one is minor.
 */
export function apiBump(changes: Pick<ExportChange, 'entry' | 'breaking' | 'change'>[]): ReleaseBump {
  const published = changes.filter((c) => c.entry);
  if (published.some((c) => c.breaking)) return 'major';
  return published.length ? 'minor' : 'none';
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const list = (names: string[], max = 4): string => `${names.slice(0, max).join(', ')}${names.length > max ? `, +${names.length - max} more` : ''}`;

/** The bump the commits and the API changes call for together, with the reasons in plain words. */
export function releaseBump(input: { lastVersion?: string; commits: ReleaseCommit[]; apiChanges?: ExportChange[] }): ReleasePlan['bump'] {
  const { commits, apiChanges } = input;
  const fromCommits = commitBump(commits);
  const fromApi = apiChanges ? apiBump(apiChanges) : undefined;
  const level = commits.length || apiChanges?.length ? maxLevel(fromCommits, fromApi ?? 'none') : 'none';
  const reasons: string[] = [];

  const breakingCommits = commits.filter((c) => c.breaking);
  if (breakingCommits.length) reasons.push(`${plural(breakingCommits.length, 'commit')} marked as breaking (${list(breakingCommits.map((c) => c.description), 2)})`);
  const publishedBreaking = (apiChanges ?? []).filter((c) => c.entry && c.breaking);
  if (publishedBreaking.length) reasons.push(`${plural(publishedBreaking.length, 'breaking change')} to the published API (${list(publishedBreaking.map((c) => c.name))})`);
  const publishedAdded = (apiChanges ?? []).filter((c) => c.entry && !c.breaking);
  if (publishedAdded.length) reasons.push(`${plural(publishedAdded.length, 'new or widened export')} in the published API (${list(publishedAdded.map((c) => c.name))})`);
  const features = commits.filter((c) => c.type === 'feat').length;
  if (features) reasons.push(plural(features, 'new feature'));
  const fixes = commits.filter((c) => c.type === 'fix').length;
  if (fixes) reasons.push(plural(fixes, 'bug fix', 'bug fixes'));
  const other = commits.filter((c) => ['perf', 'refactor', 'revert', 'other'].includes(c.type)).length;
  if (other) reasons.push(plural(other, 'other change'));
  if (!commits.length) reasons.push('No commits since the last release.');
  else if (level === 'none') reasons.push('Only documentation, tests, CI or chores changed: nothing needs releasing.');
  if (level === 'major' && parseSemver(input.lastVersion)?.major === 0) reasons.push('The version is 0.x: SemVer allows releasing breaking changes as a minor bump (0.x → 0.(x+1)).');

  return { level, next: bumpVersion(input.lastVersion, level), fromCommits, ...(fromApi ? { fromApi } : {}), reasons };
}

/* ---------------------------- Release notes -------------------------------- */

const SECTIONS: { title: string; types: CommitType[] }[] = [
  { title: 'Features', types: ['feat'] },
  { title: 'Bug fixes', types: ['fix'] },
  { title: 'Performance', types: ['perf'] },
  { title: 'Reverts', types: ['revert'] },
  { title: 'Refactoring', types: ['refactor'] },
  { title: 'Other changes', types: ['other'] },
  { title: 'Maintenance', types: ['docs', 'test', 'build', 'ci', 'chore', 'style'] },
];

const short = (hash: string): string => hash.slice(0, 7);
const commitLine = (c: ReleaseCommit): string => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.description}${c.pr ? ` (#${c.pr})` : ''} (${short(c.hash)})`;

export interface ReleaseNotesOptions {
  /** Heading date; omitted for an unreleased version. */
  date?: Date;
  /** Without it the heading reads "Unreleased". */
  version?: string;
}

/** The changelog entry for the plan, ready to paste into CHANGELOG.md or a GitHub release. */
export function releaseNotesMarkdown(plan: ReleasePlan, options: ReleaseNotesOptions = {}): string {
  const version = options.version ?? plan.bump.next;
  const date = options.date ? ` (${options.date.toISOString().slice(0, 10)})` : '';
  const out: string[] = [`## ${version ? `v${version}` : 'Unreleased'}${date}`, ''];

  const breaking = plan.commits.filter((c) => c.breaking);
  const publishedBreaking = plan.apiChanges.filter((c) => c.entry && c.breaking);
  if (breaking.length || publishedBreaking.length) {
    out.push('### ⚠ Breaking changes', '');
    for (const c of breaking) out.push(commitLine(c));
    for (const c of publishedBreaking) {
      const what = c.change === 'removed' ? `removed \`${c.name}\`` : c.change === 'kind' ? `\`${c.name}\` is now a different kind of declaration` : `changed the signature of \`${c.name}\``;
      out.push(`- **api:** ${what} (${c.file}${c.importers.length ? `, ${plural(c.importers.length, 'importer')}` : ''})`);
    }
    out.push('');
  }
  for (const section of SECTIONS) {
    const commits = plan.commits.filter((c) => section.types.includes(c.type) && !c.breaking);
    if (!commits.length) continue;
    out.push(`### ${section.title}`, '', ...commits.map(commitLine), '');
  }
  const authors = [...new Set(plan.commits.map((c) => c.author))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (authors.length) out.push(`Thanks to ${authors.join(', ')}.`, '');
  if (plan.compareUrl) out.push(`Full changes: ${plan.compareUrl}`, '');
  return `${out.join('\n').trimEnd()}\n`;
}

/** `https://github.com/org/repo/compare/v1.0.0...HEAD` for a GitHub, GitLab or Bitbucket remote. */
export function compareUrl(remote: string | undefined, tag: string, head = 'HEAD'): string | undefined {
  const m = /^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec((remote ?? '').trim());
  if (!m) return undefined;
  const [, host, repo] = m;
  if (host.includes('gitlab')) return `https://${host}/${repo}/-/compare/${tag}...${head}`;
  if (host.includes('bitbucket')) return `https://${host}/${repo}/branches/compare/${head}%0D${tag}`;
  return `https://${host}/${repo}/compare/${tag}...${head}`;
}
