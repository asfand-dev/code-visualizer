/**
 * Commit messages and what you committed lately: checking a message the way reviewers do, writing a
 * Conventional Commit from the files and symbols a change touches, and the text of a standup. Pure.
 */
import { isPlaceholderSubject, shellWord } from './git-insights.js';
import { isConventional } from './release.js';
import type { ChangedFile, ChangedSymbol, CommitRef, CommitType } from './types.js';

/* ---------------------------------- Linting --------------------------------- */

export interface CommitProblem {
  level: 'error' | 'warning' | 'info';
  text: string;
}

const SUBJECT_LIMIT = 72;
const SUBJECT_TARGET = 50;
const BODY_LIMIT = 100;
const MIN_VERB_LENGTH = 5;
const TYPES_HINT = 'feat, fix, docs, refactor, perf, test, build, ci, chore';

/** Words that end like a past tense or a gerund but are not one. */
const NOT_INFLECTED = new Set(['need', 'feed', 'speed', 'embed', 'proceed', 'exceed', 'succeed', 'bleed', 'breed', 'bring', 'string', 'spring', 'swing', 'sting', 'cling', 'fling', 'during', 'nothing', 'something', 'anything', 'everything', 'thing']);

/** The first word of the description, after `type(scope):`. */
function firstWord(subject: string): string {
  return /^(?:\w+(?:\([^)]*\))?!?:\s*)?([A-Za-z]+)/.exec(subject)?.[1]?.toLowerCase() ?? '';
}

function isNotImperative(word: string): boolean {
  return word.length >= MIN_VERB_LENGTH && !NOT_INFLECTED.has(word) && /(?:ed|ing)$/.test(word);
}

/** What a reviewer would say about a commit message. Nothing in the result means it is fine. */
export function lintCommitMessage(message: string, options: { conventional?: boolean } = {}): CommitProblem[] {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  const subject = lines[0]?.trim() ?? '';
  if (!subject) return [{ level: 'error', text: 'Write a subject line: one sentence about what the commit changes.' }];
  const problems: CommitProblem[] = [];
  if (subject.length > SUBJECT_LIMIT) problems.push({ level: 'warning', text: `The subject is ${subject.length} characters; tools cut it off at about ${SUBJECT_LIMIT}.` });
  else if (subject.length > SUBJECT_TARGET) problems.push({ level: 'info', text: `The subject is ${subject.length} characters; ${SUBJECT_TARGET} or fewer reads best in \`git log --oneline\`.` });
  if (isPlaceholderSubject(subject)) problems.push({ level: 'warning', text: 'This subject says nothing about the change (or marks a commit to squash). Describe what changed and why.' });
  if (options.conventional && !isConventional(subject)) problems.push({ level: 'warning', text: `Recent commits start with a type: \`type(scope): description\` (${TYPES_HINT}).` });
  if (subject.endsWith('.')) problems.push({ level: 'info', text: 'No full stop at the end of the subject.' });
  const word = firstWord(subject);
  if (isNotImperative(word)) problems.push({ level: 'info', text: `Write the subject as a command (“add”, “fix”), not “${word}”: it completes “If applied, this commit will …”.` });
  if (lines.length > 1 && lines[1].trim()) problems.push({ level: 'warning', text: 'Leave a blank line between the subject and the body, or git treats it all as the subject.' });
  const wide = lines.slice(2).filter((line) => line.length > BODY_LIMIT && !/https?:\/\//.test(line) && !line.startsWith('    '));
  if (wide.length) problems.push({ level: 'info', text: `${wide.length} body ${wide.length === 1 ? 'line is' : 'lines are'} longer than ${BODY_LIMIT} characters; wrap them.` });
  return problems;
}

/* --------------------------------- Writing --------------------------------- */

export interface CommitParts {
  type: CommitType | string;
  scope?: string;
  description: string;
  breaking?: boolean;
  body?: string[];
}

/** `type(scope)!: description`, then a blank line and the body when there is one. */
export function formatCommit(parts: CommitParts): string {
  const scope = parts.scope ? `(${parts.scope})` : '';
  const subject = `${parts.type}${scope}${parts.breaking ? '!' : ''}: ${parts.description}`;
  return parts.body?.length ? `${subject}\n\n${parts.body.join('\n')}` : subject;
}

const TYPE_PREFIX = /^(\w+)(\([^)]*\))?(!)?:\s*/;

/** The message with another Conventional Commit type (`fix(auth): x` → `feat(auth): x`); a message without a type gets one. */
export function setCommitType(message: string, type: string): string {
  const [subject = '', ...rest] = message.split('\n');
  const typed = TYPE_PREFIX.test(subject) ? subject.replace(TYPE_PREFIX, (_, __, scope = '', bang = '') => `${type}${scope}${bang}: `) : `${type}: ${subject}`;
  return [typed, ...rest].join('\n');
}

/** `git commit -m "subject" -m "body"` for a message, quoted for a POSIX shell: paragraphs become separate `-m` options. */
export function commitCommand(message: string): string {
  const paragraphs = message.trim().split(/\n{2,}/).filter(Boolean);
  return ['git commit', ...paragraphs.map((paragraph) => `-m ${shellWord(paragraph)}`)].join(' ');
}

type FileKind = 'test' | 'docs' | 'ci' | 'build' | 'source';

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|e2e|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DOC_FILE = /(?:^|\/)(?:docs?)\/|\.(?:md|mdx|rst|txt)$|(?:^|\/)(?:LICENSE|CHANGELOG)/i;
const CI_FILE = /^\.github\/|^\.gitlab-ci|^\.circleci\/|(?:^|\/)Jenkinsfile$|^azure-pipelines/;
const BUILD_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig[\w.-]*\.json|Dockerfile|docker-compose[\w.-]*\.ya?ml|(?:vite|webpack|rollup|tsup|esbuild|babel)\.config\.\w+)$/;
const LOCK_FILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;

function kindOf(path: string): FileKind {
  if (TEST_FILE.test(path)) return 'test';
  if (CI_FILE.test(path)) return 'ci';
  if (DOC_FILE.test(path)) return 'docs';
  return BUILD_FILE.test(path) ? 'build' : 'source';
}

const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/** Folders that only hold other folders: the scope is the one below them. */
const CONTAINER_FOLDERS = new Set(['src', 'packages', 'apps', 'libs', 'services']);

/** The folder a change lives in (`src/auth/login.ts` → `auth`, `packages/api/src/x.ts` → `api`), when it is one folder. */
export function scopeOf(paths: string[]): string | undefined {
  const scopes = new Set(
    paths.map((path) => {
      const parts = path.split('/');
      const at = CONTAINER_FOLDERS.has(parts[0]) ? 1 : 0;
      return parts.length - 1 > at ? parts[at] : '';
    }),
  );
  const [only] = [...scopes];
  return scopes.size === 1 && only ? only : undefined;
}

const BODY_VERB: Record<ChangedFile['status'], string> = { added: 'add', untracked: 'add', modified: 'update', deleted: 'remove', renamed: 'rename' };
const MAX_NAMED = 2;
const MAX_BODY_FILES = 8;

function describeChange(files: Pick<ChangedFile, 'id' | 'status'>[], symbols: Pick<ChangedSymbol, 'name' | 'exported' | 'usedBy'>[], scope: string | undefined): string {
  const verb = files.every((f) => f.status === 'added' || f.status === 'untracked') ? 'add' : files.every((f) => f.status === 'deleted') ? 'remove' : 'update';
  const names = [...new Map(symbols.map((s) => [s.name, s])).values()].sort((a, b) => Number(b.exported) - Number(a.exported) || b.usedBy - a.usedBy).map((s) => s.name);
  if (names.length === 1) return `${verb} ${names[0]}`;
  if (names.length === MAX_NAMED) return `${verb} ${names[0]} and ${names[1]}`;
  if (names.length > MAX_NAMED) return `${verb} ${names.slice(0, MAX_NAMED).join(', ')} and ${names.length - MAX_NAMED} more`;
  if (files.length === 1) return `${verb} ${basenameOf(files[0].id)}`;
  return `${verb} ${files.length} files${scope ? ` in ${scope}` : ''}`;
}

export interface CommitSuggestion extends CommitParts {
  type: CommitType;
  body: string[];
}

/**
 * A Conventional Commit for a set of changes. Which type it is cannot be known from the files, so the
 * type follows what they are (only tests → `test`, only docs → `docs`, a new file → `feat`, else `fix`) and the
 * person picks another in the UI.
 */
export function suggestCommit(files: Pick<ChangedFile, 'id' | 'status' | 'additions' | 'deletions'>[], symbols: Pick<ChangedSymbol, 'name' | 'exported' | 'usedBy' | 'file'>[]): CommitSuggestion | undefined {
  if (!files.length) return undefined;
  const kinds = new Set(files.map((f) => kindOf(f.id)));
  const only = kinds.size === 1 ? [...kinds][0] : undefined;
  const sourceFiles = files.filter((f) => kindOf(f.id) === 'source');
  const scope = scopeOf(sourceFiles.length ? sourceFiles.map((f) => f.id) : files.map((f) => f.id));
  const body = files.slice(0, MAX_BODY_FILES).map((f) => `- ${BODY_VERB[f.status]} ${f.id}`);
  if (files.length > MAX_BODY_FILES) body.push(`- … and ${files.length - MAX_BODY_FILES} more files`);
  if (only === 'build' && files.every((f) => LOCK_FILE.test(f.id) || f.id.endsWith('package.json'))) return { type: 'build', scope: 'deps', description: 'update dependencies', body };
  if (only && only !== 'source') return { type: only, ...(scope ? { scope } : {}), description: describeChange(files, symbols, scope), body };
  const addsSource = sourceFiles.some((f) => f.status === 'added' || f.status === 'untracked');
  const removesOnly = files.every((f) => f.status === 'deleted');
  const type: CommitType = removesOnly ? 'refactor' : addsSource ? 'feat' : 'fix';
  return { type, ...(scope ? { scope } : {}), description: describeChange(sourceFiles.length ? sourceFiles : files, symbols, scope), body };
}

/* --------------------------------- Standup --------------------------------- */

export interface StandupGroup {
  label: string;
  commits: Pick<CommitRef, 'hash' | 'date' | 'subject'>[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOOKBACK_DAYS = 7;
const MS_PER_DAY = 86_400_000;

function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * What `user` committed today and on the last day before that with commits (Friday, on a Monday). Everyone's
 * commits when `user` is not known. Commits with the same subject are listed once.
 */
export function standupGroups(commits: (Pick<CommitRef, 'hash' | 'date' | 'subject' | 'author'>)[], options: { user?: string; now: number }): StandupGroup[] {
  const today = startOfDay(options.now);
  const yesterday = startOfDay(today - 1);
  const mine = commits.filter((c) => (!options.user || c.author === options.user) && c.date <= options.now && c.date >= today - LOOKBACK_DAYS * MS_PER_DAY);
  const days = [...new Set(mine.map((c) => startOfDay(c.date)))].sort((a, b) => b - a);
  const shown = [...days.filter((day) => day === today), ...days.filter((day) => day < today).slice(0, 1)];
  const labelOf = (day: number): string => (day === today ? 'Today' : day === yesterday ? 'Yesterday' : WEEKDAYS[new Date(day).getDay()]);
  return shown.map((day) => ({ label: labelOf(day), commits: uniqueBySubject(mine.filter((c) => startOfDay(c.date) === day).sort((a, b) => a.date - b.date)) }));
}

function uniqueBySubject<T extends { subject: string }>(commits: T[]): T[] {
  const seen = new Set<string>();
  return commits.filter((commit) => {
    if (seen.has(commit.subject)) return false;
    seen.add(commit.subject);
    return true;
  });
}

/** The standup as Markdown for a chat message, oldest day first. */
export function standupMarkdown(groups: StandupGroup[]): string {
  return [...groups]
    .reverse()
    .map((group) => `**${group.label}**\n${group.commits.map((c) => `- ${c.subject}`).join('\n')}`)
    .join('\n\n');
}
