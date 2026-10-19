/**
 * Reads the GitHub Actions setup of the repository (`.github/workflows`, local actions, Dependabot) and hands
 * it to the pure analysis in src/shared/workflows.ts. The workflows belong to the whole repository, so they
 * are read from its top folder, also when the analyzed folder is a package inside it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CiReport } from '../shared/types.js';
import { buildCiReport } from '../shared/workflows.js';
import { toPosix } from './project.js';
import { findRepo } from './repo-state.js';

/** A workflow, action or Dependabot file larger than this is not read. */
const MAX_BYTES = 256 * 1024;
const MAX_WORKFLOWS = 100;
const MAX_LOCAL_ACTIONS = 50;
const WORKFLOW_FILE = /\.ya?ml$/i;
/** `uses: ./path/to/action` (not a reusable workflow file, which ends in .yml). */
const LOCAL_USE = /^\s*(?:-\s*)?uses:\s*['"]?(\.\/[^\s'"#]+)/gm;

export interface CiProject {
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
}

export interface CiOptions {
  /** `package.json` of the analyzed folder. */
  pkg: CiProject;
  /** `package.json` of every workspace package. */
  workspaces?: CiProject[];
  now?: number;
}

function readSmall(file: string): string | undefined {
  try {
    return fs.statSync(file).size <= MAX_BYTES ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function listEntries(dir: string, kind: 'file' | 'directory', accept: (name: string) => boolean = () => true): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (kind === 'file' ? entry.isFile() : entry.isDirectory()) && accept(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The first of these files that exists in `dir`. */
const firstExisting = (dir: string, names: string[]): string | undefined => names.find((name) => fs.existsSync(path.join(dir, name)));

/** Undefined when the repository has no workflows, local actions or Dependabot configuration. */
export function analyzeCi(root: string, options: CiOptions): CiReport | undefined {
  const top = findRepo(root)?.top ?? root;
  const github = path.join(top, '.github');
  const read = (rel: string): string | undefined => readSmall(path.join(top, rel));

  const workflows = listEntries(path.join(github, 'workflows'), 'file', (name) => WORKFLOW_FILE.test(name))
    .slice(0, MAX_WORKFLOWS)
    .flatMap((name) => {
      const text = read(`.github/workflows/${name}`);
      return text === undefined ? [] : [{ path: `.github/workflows/${name}`, text }];
    });

  // Local actions are usually under .github/actions, but a workflow can point anywhere in the repository.
  const conventional = listEntries(path.join(github, 'actions'), 'directory').map((dir) => `.github/actions/${dir}`);
  const referenced = workflows.flatMap((w) => [...w.text.matchAll(LOCAL_USE)].map((m) => path.posix.normalize(m[1]).replace(/^\.\//, '').replace(/\/$/, '')));
  const actionDirs = [...new Set([...conventional, ...referenced])].filter((dir) => dir && dir !== '.' && !WORKFLOW_FILE.test(dir) && !dir.startsWith('..'));
  const actionManifests = actionDirs.slice(0, MAX_LOCAL_ACTIONS).flatMap((dir) => {
    const name = firstExisting(path.join(top, dir), ['action.yml', 'action.yaml']);
    const text = name && read(`${dir}/${name}`);
    return text ? [{ dir, text }] : [];
  });

  const dependabotName = firstExisting(github, ['dependabot.yml', 'dependabot.yaml']);
  const dependabotText = dependabotName ? read(`.github/${dependabotName}`) : undefined;
  if (!workflows.length && !actionManifests.length && dependabotText === undefined) return undefined;

  const packages = [options.pkg, ...(options.workspaces ?? [])];
  return buildCiReport({
    base: toPosix(path.relative(top, root)),
    workflows,
    actionManifests,
    ...(dependabotName && dependabotText !== undefined ? { dependabot: { file: `.github/${dependabotName}`, text: dependabotText } } : {}),
    scripts: options.pkg.scripts,
    scriptNames: packages.flatMap((p) => Object.keys(p.scripts ?? {})),
    nodeEngine: options.pkg.engines?.node,
    fileExists: (rel) => {
      const abs = path.resolve(top, rel);
      return (abs === top || abs.startsWith(top + path.sep)) && fs.existsSync(abs);
    },
    now: options.now ?? Date.now(),
  });
}
