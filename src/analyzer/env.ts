/**
 * Finds the dotenv files of a project and reads the variable NAMES they declare. Values are never
 * read into memory beyond the line that is being parsed, and never stored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isEnvTemplateName, parseEnvNames } from '../shared/env.js';
import type { EnvFile } from '../shared/types.js';
import { git } from './git.js';

/** `.env`, `.env.local`, `.env.production`, `env.example`, `example.env`…; never `env.d.ts` or `.env.json`. */
const ENV_FILE_RE = /^(?:\.env(?:\.[\w.-]+)?|env\.(?:example|sample|template|defaults?|local|development|production|test)|(?:example|sample)\.env)$/;
const NOT_DOTENV_RE = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|d\.ts)$/;
/** A dotenv file larger than this is not a dotenv file. */
const MAX_BYTES = 256 * 1024;

export const isEnvFileName = (name: string): boolean => ENV_FILE_RE.test(name) && !NOT_DOTENV_RE.test(name);

/** Project-relative paths of the dotenv files in `dirs`. */
function list(root: string, dirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isEnvFileName(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      try {
        if (fs.statSync(path.join(root, rel)).size <= MAX_BYTES) found.push(rel);
      } catch {
        /* removed while listing */
      }
    }
  }
  return found.sort();
}

/** Project files git tracks, among `paths` (empty when git is missing or says nothing). */
async function trackedAmong(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const out = await git(root, ['ls-files', '-z', '--', ...paths]);
  return new Set((out ?? '').split('\0').filter(Boolean));
}

/**
 * The dotenv files in the project root and its workspaces with their variable names. A file counts as
 * a template (documentation for the team) when its name says so, or when git tracks it: a committed
 * `.env.production` documents its variables as well as `.env.example` does.
 */
export async function readEnvFiles(root: string, dirs: string[], useGit: boolean): Promise<EnvFile[]> {
  const found = list(root, [...new Set(['', ...dirs])]);
  const tracked = useGit ? await trackedAmong(root, found) : new Set<string>();
  const files: EnvFile[] = [];
  for (const rel of found) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    files.push({ path: rel, template: isEnvTemplateName(path.posix.basename(rel)) || tracked.has(rel), names: parseEnvNames(text) });
  }
  return files;
}
