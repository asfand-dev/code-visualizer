/**
 * Git insights from the output of plain git commands: branches and how far they are from the base, stashes,
 * worktrees, commits only the reflog remembers, commit style, what is tracked that should not be, git
 * settings, and a prioritised "needs attention" list. The analyzer runs the commands; everything here only
 * reads their text, so it is pure and testable with fixtures.
 */
import { plural } from './plural.js';
import { isConventional, parseCommit } from './release.js';
import type {
  BranchInfo,
  CommitStyle,
  CommitType,
  ConfigAdvice,
  GitHygiene,
  RepoAttention,
  RepoInsights,
  RescueCommit,
  StashInfo,
  UnwantedKind,
  WorktreeInfo,
} from './types.js';

/** Separates the fields of a line and the records of a log in the formats below. */
export const FIELD_SEPARATOR = '\x1f';
export const RECORD_SEPARATOR = '\x1e';

const MS_PER_DAY = 86_400_000;
/** A branch nobody touched for this long is stale; a stash is old after this long. */
export const STALE_BRANCH_DAYS = 90;
export const OLD_STASH_DAYS = 30;
const MANY_MERGED_BRANCHES = 5;
const LARGE_FILE_BYTES = 1024 * 1024;
const MAX_LARGE_FILES = 10;
const MAX_LOCAL_BRANCHES = 200;
const MAX_REMOTE_BRANCHES = 100;
const MAX_STASH_FILES = 20;
const MAX_RESCUE_COMMITS = 20;
const MAX_UNWANTED = 50;
const MAX_COMMANDS_LISTED = 10;
/** `git gc --auto` packs loose objects once there are about this many. */
const GC_LOOSE_OBJECTS = 6700;
const LONG_SUBJECT = 72;
const SAFE_REF = /^[\w./-]+$/;

/** Branches nobody should delete by accident, whatever their state. */
const PROTECTED_BRANCH = /^(?:main|master|develop|development|dev|trunk|staging|production|prod|release\/.+)$/;

/* --------------------------------- Branches -------------------------------- */

/** The `--format` of `git for-each-ref`; the base is compared with `ahead-behind` (git 2.41+) when it is a plain ref name. */
export function branchFormat(base: string | undefined, aheadBehind = true): string {
  const fields = ['%(refname)', '%(objectname:short)', '%(committerdate:unix)', '%(authorname)', '%(upstream:short)', '%(upstream:track)', '%(HEAD)', '%(worktreepath)', '%(subject)'];
  if (aheadBehind && base && SAFE_REF.test(base)) fields.push(`%(ahead-behind:${base})`);
  return fields.join('%1f');
}

export interface BranchParseOptions {
  base: string;
  /** The output carries `ahead-behind` as its last field. */
  aheadBehind: boolean;
  /** Branches `git branch --merged <base>` lists, used when `ahead-behind` is not available. */
  mergedNames?: Set<string>;
}

function trackOf(track: string): { gone: boolean; unpushed: number } {
  return { gone: track.includes('gone'), unpushed: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0) };
}

/** `git for-each-ref` output → branches, local ones first and the most recently used first; capped. */
export function parseBranches(output: string, options: BranchParseOptions): { branches: BranchInfo[]; totals: RepoInsights['branchTotals'] } {
  const all: BranchInfo[] = [];
  for (const line of output.split('\n')) {
    const f = line.split(FIELD_SEPARATOR);
    const ref = f[0] ?? '';
    const local = ref.startsWith('refs/heads/');
    if (!local && !ref.startsWith('refs/remotes/')) continue;
    const name = ref.slice(local ? 'refs/heads/'.length : 'refs/remotes/'.length);
    if (!local && name.endsWith('/HEAD')) continue;
    const counts = options.aheadBehind ? /^(\d+) (\d+)$/.exec(f[9] ?? '') : null;
    const ahead = counts ? Number(counts[1]) : 0;
    const behind = counts ? Number(counts[2]) : 0;
    const { gone, unpushed } = trackOf(f[5] ?? '');
    const current = f[6] === '*';
    const worktree = f[7] || undefined;
    const merged = counts ? ahead === 0 : (options.mergedNames?.has(name) ?? false);
    all.push({
      name,
      remote: !local,
      hash: f[1] ?? '',
      date: Number(f[2]) * 1000,
      author: f[3] ?? '',
      subject: f[8] ?? '',
      ahead,
      behind,
      merged,
      ...(f[4] ? { upstream: f[4] } : {}),
      ...(current ? { current } : {}),
      ...(gone ? { gone } : {}),
      ...(unpushed ? { unpushed } : {}),
      ...(worktree && !current ? { worktree } : {}),
      ...(local && (name === options.base || current || worktree || PROTECTED_BRANCH.test(name)) ? { protected: true } : {}),
    });
  }
  const byDate = (a: BranchInfo, b: BranchInfo): number => b.date - a.date;
  const locals = all.filter((b) => !b.remote).sort(byDate);
  const remotes = all.filter((b) => b.remote && b.name !== options.base).sort(byDate);
  return {
    branches: [...locals.slice(0, MAX_LOCAL_BRANCHES), ...remotes.slice(0, MAX_REMOTE_BRANCHES)],
    totals: {
      local: locals.length,
      remote: remotes.length,
      merged: locals.filter((b) => b.merged && !b.protected).length,
      gone: locals.filter((b) => b.gone).length,
    },
  };
}

/** Local branches `git branch -d` may delete: fully merged into the base, not the base, not checked out anywhere. */
export function deletableBranches(branches: BranchInfo[]): BranchInfo[] {
  return branches.filter((b) => !b.remote && b.merged && !b.protected);
}

/* ---------------------- Stashes, worktrees and lost commits ---------------------- */

/** `--format` of `git stash list --name-only`: records start with the separator, file names follow the line. */
export const STASH_FORMAT = `${RECORD_SEPARATOR}%gd${FIELD_SEPARATOR}%ct${FIELD_SEPARATOR}%gs`;

export function parseStashes(output: string): StashInfo[] {
  return output
    .split(RECORD_SEPARATOR)
    .slice(1)
    .map((record) => {
      const [head, ...rest] = record.split('\n');
      const [ref, seconds, ...message] = head.split(FIELD_SEPARATOR);
      const files = rest.map((l) => l.trim()).filter(Boolean);
      return { ref, message: message.join(FIELD_SEPARATOR).replace(/^(?:WIP )?[Oo]n [^:]+: /, ''), date: Number(seconds) * 1000, files: files.slice(0, MAX_STASH_FILES), fileCount: files.length };
    })
    .filter((stash) => stash.ref);
}

/** `git worktree list --porcelain`; the first record is the main working tree. */
export function parseWorktrees(output: string): WorktreeInfo[] {
  return output
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const info: WorktreeInfo = { path: '' };
      for (const line of block.split('\n')) {
        const [key, ...value] = line.split(' ');
        const text = value.join(' ');
        if (key === 'worktree') info.path = text;
        else if (key === 'HEAD') info.head = text.slice(0, 7);
        else if (key === 'branch') info.branch = text.replace(/^refs\/heads\//, '');
        else if (key === 'detached') info.detached = true;
        else if (key === 'locked') info.locked = true;
        else if (key === 'prunable') info.prunable = true;
      }
      return index === 0 ? { ...info, main: true } : info;
    })
    .filter((w) => w.path);
}

/** `--format` of `git reflog` for the commits the reflog remembers. */
export const REFLOG_FORMAT = ['%H', '%ct', '%an', '%s'].join('%x1f');

/**
 * Commits that only the reflog reaches (`orphaned`: no branch, tag or remote has them), newest first. A commit
 * whose subject is still in the history was only rewritten (amend, rebase), not lost, so it is left out.
 */
export function parseRescue(reflog: string, orphaned: Set<string>, knownSubjects: Set<string>): RescueCommit[] {
  const seen = new Set<string>();
  const out: RescueCommit[] = [];
  for (const line of reflog.split('\n')) {
    const [hash, seconds, author, ...subject] = line.split(FIELD_SEPARATOR);
    const text = subject.join(FIELD_SEPARATOR);
    if (!hash || seen.has(hash) || !orphaned.has(hash) || knownSubjects.has(text)) continue;
    seen.add(hash);
    out.push({ hash, date: Number(seconds) * 1000, author: author ?? '', subject: text });
  }
  return out.sort((a, b) => b.date - a.date).slice(0, MAX_RESCUE_COMMITS);
}

/* ------------------------------- Commit style ------------------------------- */

export interface LogCommit {
  parents: number;
  subject: string;
  body: string;
}

/** `--format` of the log `parseLog` reads (one record per commit, starting with the record separator). */
export const LOG_FORMAT = [`${RECORD_SEPARATOR}%P`, '%s', '%b'].join(FIELD_SEPARATOR);

export function parseLog(output: string): LogCommit[] {
  return output
    .split(RECORD_SEPARATOR)
    .slice(1)
    .map((record) => {
      const [parents, subject, ...body] = record.split(FIELD_SEPARATOR);
      return { parents: parents.trim() ? parents.trim().split(' ').length : 0, subject: subject ?? '', body: body.join(FIELD_SEPARATOR).trim() };
    });
}

const WIP_SUBJECT = /^(?:wip\b|tmp\b|temp\b|fixup!|squash!|amend!|\.+$|(?:fix|update|changes|stuff|misc|minor|asdf)\.?$)/i;

/** A subject that says nothing (`wip`, `fix`, `.`) or marks a commit that should be squashed (`fixup!`). */
export function isPlaceholderSubject(subject: string): boolean {
  return WIP_SUBJECT.test(subject.trim());
}

export function commitStyle(commits: LogCommit[]): CommitStyle {
  const own = commits.filter((c) => c.parents <= 1);
  const types: Partial<Record<CommitType, number>> = {};
  let conventional = 0;
  for (const commit of own) {
    if (!isConventional(commit.subject)) continue;
    conventional++;
    const { type } = parseCommit(commit.subject, commit.body);
    types[type] = (types[type] ?? 0) + 1;
  }
  const subjectLength = own.reduce((sum, c) => sum + c.subject.length, 0);
  return {
    analyzed: commits.length,
    merges: commits.length - own.length,
    conventional,
    types,
    withBody: own.filter((c) => c.body).length,
    longSubjects: own.filter((c) => c.subject.length > LONG_SUBJECT).length,
    wip: own.filter((c) => isPlaceholderSubject(c.subject)).length,
    reverts: own.filter((c) => /^revert\b/i.test(c.subject)).length,
    prRefs: own.filter((c) => /\(#\d+\)\s*$/.test(c.subject)).length,
    coAuthored: own.filter((c) => /^co-authored-by:/im.test(c.body)).length,
    avgSubject: own.length ? Math.round(subjectLength / own.length) : 0,
  };
}

/** Most of the recent commits follow Conventional Commits: new messages should too. */
export function usesConventionalCommits(style: CommitStyle): boolean {
  const own = style.analyzed - style.merges;
  return own >= 5 && style.conventional / own >= 0.5;
}

/* --------------------------------- Hygiene --------------------------------- */

const SECRET_FILE = [
  /(?:^|\/)\.env(?:\.(?:local|production|prod|staging|development\.local|[\w-]+\.local))?$/,
  /(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/,
  /\.(?:key|p12|pfx|jks|keystore)$/,
  /(?:private|secret)[^/]*\.pem$/i,
  /(?:^|\/)(?:credentials\.json|\.htpasswd|\.pgpass|\.netrc)$/,
  /(?:^|\/)service-account[\w-]*\.json$/,
];
/** Test data and examples hold fake credentials on purpose. */
const EXAMPLE_PATH = /(?:^|\/)(?:test|tests|__tests__|fixtures?|__fixtures__|examples?|samples?|docs?|testdata)(?:\/|$)/i;
const DEPENDENCY_DIR = /^(?:.*\/)?(?:node_modules|bower_components|\.venv|__pycache__)\//;
const BUILD_DIR = /^(coverage|\.next|\.nuxt|\.turbo|\.parcel-cache|\.cache|dist|build)\//;
const JUNK_FILE = /(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(?:log|swp|orig|rej|pyc)$|~$/;

function classify(path: string): { kind: UnwantedKind; folder?: string } | undefined {
  const dependency = DEPENDENCY_DIR.exec(path);
  if (dependency) return { kind: 'dependency', folder: dependency[0] };
  if (!EXAMPLE_PATH.test(path) && SECRET_FILE.some((re) => re.test(path))) return { kind: 'secret' };
  const build = BUILD_DIR.exec(path);
  if (build) return { kind: 'build', folder: `${build[1]}/` };
  return JUNK_FILE.test(path) ? { kind: 'junk' } : undefined;
}

/** Folders are reported once, with the number of tracked files in them. */
export function analyzeTree(lsTree: string): Pick<GitHygiene, 'trackedFiles' | 'unwanted' | 'large'> {
  let trackedFiles = 0;
  const large: { path: string; size: number }[] = [];
  const folders = new Map<string, { kind: UnwantedKind; count: number }>();
  const files: { path: string; kind: UnwantedKind }[] = [];
  for (const record of lsTree.split('\0')) {
    const match = /^\d+ blob [0-9a-f]+ +(\d+)\t(.+)$/s.exec(record);
    if (!match) continue;
    trackedFiles++;
    const [, size, path] = match;
    if (Number(size) >= LARGE_FILE_BYTES) large.push({ path, size: Number(size) });
    const found = classify(path);
    if (!found) continue;
    if (!found.folder) {
      files.push({ path, kind: found.kind });
      continue;
    }
    const entry = folders.get(found.folder) ?? { kind: found.kind, count: 0 };
    entry.count++;
    folders.set(found.folder, entry);
  }
  const unwanted = [...files, ...[...folders].map(([path, { kind, count }]) => ({ path, kind, count }))];
  const rank: Record<UnwantedKind, number> = { secret: 0, dependency: 1, build: 2, junk: 3 };
  unwanted.sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
  return { trackedFiles, unwanted: unwanted.slice(0, MAX_UNWANTED), large: large.sort((a, b) => b.size - a.size).slice(0, MAX_LARGE_FILES) };
}

/** `git count-objects -v`. */
export function parseCountObjects(output: string): GitHygiene['objects'] {
  const values = new Map(output.split('\n').map((line) => line.split(': ') as [string, string]));
  const number = (key: string): number => Number(values.get(key)) || 0;
  return { packKiB: number('size-pack'), looseKiB: number('size'), loose: number('count'), packs: number('packs') };
}

/* ---------------------------------- Settings -------------------------------- */

interface ConfigRule {
  key: string;
  label: string;
  why: string;
  recommended: string;
  /** Values that count as set up properly; any value does when omitted. */
  accepts?: string[];
  essential?: boolean;
  /** The value is personal: only whether it exists is kept. */
  private?: boolean;
}

const CONFIG_RULES: ConfigRule[] = [
  { key: 'user.name', label: 'Your name', why: 'Every commit records it. Without it git guesses from your computer name.', recommended: 'Your Name', essential: true },
  { key: 'user.email', label: 'Your e-mail address', why: 'Every commit records it, and GitHub uses it to link commits to your account.', recommended: 'you@example.com', essential: true, private: true },
  { key: 'pull.rebase', label: 'How pull combines changes', why: 'Without a choice, `git pull` refuses to continue when your branch and the remote have both moved. `true` replays your commits on top instead of making merge commits.', recommended: 'true' },
  { key: 'fetch.prune', label: 'Forget deleted remote branches', why: 'Removes remote-tracking branches that were deleted on the server, so branch lists do not fill up with dead ones.', recommended: 'true', accepts: ['true'] },
  { key: 'push.autoSetupRemote', label: 'First push sets the upstream', why: 'The first `git push` of a new branch just works, without `--set-upstream origin <branch>`.', recommended: 'true', accepts: ['true'] },
  { key: 'rerere.enabled', label: 'Remember conflict resolutions', why: 'Git replays a resolution you made before, so rebasing the same branch again does not repeat the conflicts.', recommended: 'true', accepts: ['true'] },
  { key: 'merge.conflictstyle', label: 'Conflict markers with context', why: '`zdiff3` also shows the original text between the two sides, which makes most conflicts easy to resolve.', recommended: 'zdiff3', accepts: ['zdiff3', 'diff3'] },
  { key: 'diff.algorithm', label: 'Readable diffs', why: '`histogram` produces diffs that follow the structure of the code better than the default.', recommended: 'histogram', accepts: ['histogram', 'patience'] },
  { key: 'init.defaultBranch', label: 'Name of new repositories\' first branch', why: 'Avoids the hint (and the surprise) when `git init` creates `master`.', recommended: 'main' },
  { key: 'branch.sort', label: 'Newest branches first', why: '`git branch` lists the branches you used most recently first instead of alphabetically.', recommended: '-committerdate', accepts: ['-committerdate'] },
];

/** The settings `configAdvice` reads (lower case): only these are ever read from `git config`. */
export const CONFIG_KEYS: readonly string[] = CONFIG_RULES.map((rule) => rule.key.toLowerCase());

/** `git config --list` text → the values of the settings above. Other settings are never kept. */
export function pickConfig(listing: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of listing.split('\n')) {
    const at = line.indexOf('=');
    const key = (at < 0 ? line : line.slice(0, at)).trim().toLowerCase();
    if (CONFIG_KEYS.includes(key)) out[key] = at < 0 ? '' : line.slice(at + 1).trim();
  }
  return out;
}

export function configAdvice(values: Record<string, string>): ConfigAdvice[] {
  return CONFIG_RULES.map((rule): ConfigAdvice => {
    const value = values[rule.key.toLowerCase()];
    const set = value !== undefined && value !== '';
    const accepted = !set ? false : !rule.accepts || rule.accepts.includes(value);
    return {
      key: rule.key,
      label: rule.label,
      status: !set ? 'missing' : accepted ? 'ok' : 'differs',
      ...(set && !rule.private ? { value } : {}),
      recommended: rule.recommended,
      why: rule.why,
      command: `git config --global ${rule.key} ${/\s/.test(rule.recommended) || rule.private ? `"${rule.recommended}"` : rule.recommended}`,
      ...(rule.essential ? { essential: true } : {}),
    };
  });
}

/* --------------------------------- Attention -------------------------------- */

export interface AttentionOptions {
  now: number;
  /** The repository has a remote: a branch without an upstream was never pushed. */
  hasRemote?: boolean;
}

/** A branch or file name for a command line, quoted when a shell would need it. */
export const shellWord = (name: string): string => (/^[\w./@+-]+$/.test(name) ? name : `'${name.replace(/'/g, `'\\''`)}'`);

function branchAttention(repo: RepoInsights, options: AttentionOptions): RepoAttention[] {
  const out: RepoAttention[] = [];
  const locals = repo.branches.filter((b) => !b.remote);
  const deletable = deletableBranches(locals);
  if (deletable.length) {
    out.push({
      id: 'merged-branches',
      severity: deletable.length >= MANY_MERGED_BRANCHES ? 'medium' : 'low',
      title: `${plural(deletable.length, 'local branch', 'local branches')} already merged into ${repo.base}`,
      detail: 'Deleting them loses nothing: every commit is in the base branch.',
      command: `git branch -d ${deletable.slice(0, MAX_COMMANDS_LISTED).map((b) => shellWord(b.name)).join(' ')}`,
    });
  }
  const gone = locals.filter((b) => b.gone && !b.merged && !b.protected);
  if (gone.length) {
    out.push({
      id: 'gone-branches',
      severity: 'low',
      title: `${plural(gone.length, 'branch', 'branches')} ${gone.length === 1 ? 'tracks' : 'track'} a remote branch that was deleted`,
      detail: 'Usually the pull request was merged. Check that, then delete them with `git branch -D` (squash merges cannot be detected).',
      command: `git branch -vv | grep ': gone]'`,
    });
  }
  const stale = locals.filter((b) => !b.protected && !b.merged && !b.gone && options.now - b.date > STALE_BRANCH_DAYS * MS_PER_DAY);
  if (stale.length) out.push({ id: 'stale-branches', severity: 'low', title: `${plural(stale.length, 'local branch', 'local branches')} untouched for ${STALE_BRANCH_DAYS}+ days`, detail: stale.slice(0, 3).map((b) => b.name).join(', ') });
  const unpushed = locals.filter((b) => b.unpushed);
  if (unpushed.length) {
    const first = unpushed[0];
    out.push({ id: 'unpushed', severity: 'medium', title: `${plural(unpushed.length, 'branch', 'branches')} with commits that exist only on this computer`, detail: unpushed.slice(0, 3).map((b) => `${b.name} (${b.unpushed})`).join(', '), command: `git push origin ${shellWord(first.name)}` });
  }
  if (options.hasRemote) {
    const neverPushed = locals.filter((b) => !b.upstream && !b.protected && b.ahead > 0);
    if (neverPushed.length) out.push({ id: 'never-pushed', severity: 'medium', title: `${plural(neverPushed.length, 'branch', 'branches')} never pushed`, detail: `${neverPushed.slice(0, 3).map((b) => b.name).join(', ')}: a disk failure would lose the work.`, command: `git push -u origin ${shellWord(neverPushed[0].name)}` });
  }
  return out;
}

function hygieneAttention(repo: RepoInsights): RepoAttention[] {
  const out: RepoAttention[] = [];
  const secrets = repo.hygiene.unwanted.filter((u) => u.kind === 'secret');
  if (secrets.length) {
    out.push({ id: 'tracked-secrets', severity: 'high', title: `${plural(secrets.length, 'file')} that usually hold secrets ${secrets.length === 1 ? 'is' : 'are'} tracked by git`, detail: `${secrets.slice(0, 3).map((s) => s.path).join(', ')}. Rotate what they contain: it is in the history.`, command: `git rm --cached ${secrets.slice(0, MAX_COMMANDS_LISTED).map((s) => shellWord(s.path)).join(' ')}` });
  }
  const dependencies = repo.hygiene.unwanted.filter((u) => u.kind === 'dependency');
  if (dependencies.length) out.push({ id: 'tracked-dependencies', severity: 'medium', title: `Installed dependencies are tracked (${dependencies.map((d) => d.path).join(', ')})`, command: `git rm -r --cached ${dependencies.map((d) => d.path).join(' ')}` });
  const build = repo.hygiene.unwanted.filter((u) => u.kind === 'build');
  if (build.length) out.push({ id: 'tracked-build', severity: 'low', title: `Build output is tracked (${build.map((b) => b.path).join(', ')})`, detail: 'Fine when it is published on purpose (a GitHub Action\'s dist/); otherwise add it to .gitignore.' });
  if (repo.hygiene.large.length) out.push({ id: 'large-files', severity: 'low', title: `${plural(repo.hygiene.large.length, 'tracked file')} over 1 MB`, detail: repo.hygiene.large.slice(0, 3).map((l) => `${l.path} (${(l.size / LARGE_FILE_BYTES).toFixed(1)} MB)`).join(', ') });
  if (repo.hygiene.objects.loose >= GC_LOOSE_OBJECTS) out.push({ id: 'gc', severity: 'low', title: `${repo.hygiene.objects.loose} loose objects`, detail: 'Packing them makes the repository smaller and git faster.', command: 'git gc' });
  return out;
}

function stateAttention(repo: RepoInsights, options: AttentionOptions): RepoAttention[] {
  const out: RepoAttention[] = [];
  if (repo.rescue.length) out.push({ id: 'rescue', severity: 'medium', title: `${plural(repo.rescue.length, 'commit')} that no branch has any more`, detail: `Newest: "${repo.rescue[0].subject}". Only the reflog remembers them, and git deletes them after about a month.`, command: `git branch rescue/${repo.rescue[0].hash.slice(0, 7)} ${repo.rescue[0].hash.slice(0, 7)}` });
  const oldStashes = repo.stashes.filter((s) => options.now - s.date > OLD_STASH_DAYS * MS_PER_DAY);
  if (oldStashes.length) out.push({ id: 'old-stashes', severity: 'low', title: `${plural(oldStashes.length, 'stash', 'stashes')} older than ${OLD_STASH_DAYS} days`, detail: 'Apply or drop them before you forget what they hold.', command: 'git stash list' });
  if (repo.worktrees.some((w) => w.prunable)) out.push({ id: 'prunable-worktrees', severity: 'low', title: 'Worktrees whose folder was deleted', command: 'git worktree prune' });
  const missingEssential = repo.config.filter((c) => c.essential && c.status === 'missing');
  if (missingEssential.length) out.push({ id: 'identity', severity: 'high', title: `Git does not know ${missingEssential.map((c) => `your ${c.key.replace('user.', '')}`).join(' or ')}`, command: missingEssential.map((c) => c.command).join('\n') });
  const advice = repo.config.filter((c) => !c.essential && c.status === 'missing');
  if (advice.length >= 3) out.push({ id: 'config', severity: 'low', title: `${advice.length} recommended git settings are not set`, detail: advice.slice(0, 4).map((c) => c.key).join(', '), command: advice.map((c) => c.command).join('\n') });
  if (!repo.hygiene.gitignore) out.push({ id: 'gitignore', severity: 'low', title: 'The repository has no .gitignore' });
  return out;
}

const SEVERITY_RANK: Record<RepoAttention['severity'], number> = { high: 0, medium: 1, low: 2 };

/** What to do about the repository, most important first. */
export function repoAttention(repo: RepoInsights, options: AttentionOptions): RepoAttention[] {
  return [...stateAttention(repo, options), ...hygieneAttention(repo), ...branchAttention(repo, options)].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
