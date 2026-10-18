import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeCoupling, FileGitInfo, GitSummary } from '../shared/types.js';

const execFileAsync = promisify(execFile);

export interface GitAnalysis {
  summary: GitSummary;
  files: Map<string, FileGitInfo>;
  coupling: ChangeCoupling[];
  info: { branch?: string; commit?: string; remote?: string };
}

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Remove credentials from remote URLs (https://user:token@host/…). */
export function sanitizeRemote(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  try {
    if (/^https?:\/\//.test(trimmed)) {
      const u = new URL(trimmed);
      u.username = '';
      u.password = '';
      return u.toString().replace(/\.git$/, '');
    }
  } catch {
    return undefined;
  }
  // git@github.com:owner/repo.git → https://github.com/owner/repo
  const ssh = trimmed.match(/^[\w.-]+@([\w.-]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return undefined;
}

const WEEK = 7 * 24 * 3600 * 1000;

export async function analyzeGit(root: string, fileIds: Set<string>, maxCommits = 4000): Promise<GitAnalysis | undefined> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return undefined;
  const [branch, commit, remote] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['rev-parse', '--short', 'HEAD']),
    git(root, ['config', '--get', 'remote.origin.url']),
  ]);
  const log = await git(root, [
    'log',
    '--no-merges',
    '--relative',
    '--name-only',
    `-n${maxCommits}`,
    '--format=%x1e%an%x1f%at',
    '--',
    '.',
  ]);
  if (log === undefined) return undefined;

  const files = new Map<string, FileGitInfo & { authorMap: Map<string, number> }>();
  const contributors = new Map<string, { commits: number; files: Set<string> }>();
  const pairCounts = new Map<string, number>();
  const now = Date.now();
  const weekly = new Array<number>(52).fill(0);
  let commitsAnalyzed = 0;
  let firstCommit = Infinity;
  let lastCommit = 0;

  for (const chunk of log.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [header, ...rest] = chunk.split('\n');
    const [author, ts] = header.split('\x1f');
    const time = Number(ts) * 1000;
    if (!author || !Number.isFinite(time)) continue;
    commitsAnalyzed++;
    firstCommit = Math.min(firstCommit, time);
    lastCommit = Math.max(lastCommit, time);
    const week = Math.floor((now - time) / WEEK);
    if (week >= 0 && week < 52) weekly[51 - week]++;
    const contributor = contributors.get(author) ?? { commits: 0, files: new Set<string>() };
    contributor.commits++;
    contributors.set(author, contributor);
    const touched = rest.map((l) => l.trim()).filter((l) => l && fileIds.has(l));
    for (const id of touched) {
      contributor.files.add(id);
      let info = files.get(id);
      if (!info) {
        info = { commits: 0, authors: [], lastModified: time, firstSeen: time, authorMap: new Map() };
        files.set(id, info);
      }
      info.commits++;
      info.lastModified = Math.max(info.lastModified, time);
      info.firstSeen = Math.min(info.firstSeen, time);
      info.authorMap.set(author, (info.authorMap.get(author) ?? 0) + 1);
    }
    // Change coupling: files that are committed together (ignore huge refactor commits).
    if (touched.length >= 2 && touched.length <= 25) {
      const sorted = [...touched].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}\0${sorted[j]}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const result = new Map<string, FileGitInfo>();
  for (const [id, info] of files) {
    const authors = [...info.authorMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, commits]) => ({ name, commits }));
    result.set(id, { commits: info.commits, authors, lastModified: info.lastModified, firstSeen: info.firstSeen });
  }

  const coupling: ChangeCoupling[] = [];
  for (const [key, count] of pairCounts) {
    if (count < 3) continue;
    const [a, b] = key.split('\0');
    const min = Math.min(result.get(a)?.commits ?? count, result.get(b)?.commits ?? count);
    coupling.push({ a, b, count, ratio: Math.round((count / Math.max(min, 1)) * 100) / 100 });
  }
  coupling.sort((x, y) => y.count * y.ratio - x.count * x.ratio || y.count - x.count);

  return {
    summary: {
      branch: branch?.trim(),
      commitsAnalyzed,
      firstCommit: Number.isFinite(firstCommit) ? firstCommit : undefined,
      lastCommit: lastCommit || undefined,
      contributors: [...contributors.entries()]
        .sort((a, b) => b[1].commits - a[1].commits)
        .slice(0, 30)
        .map(([name, c]) => ({ name, commits: c.commits, files: c.files.size })),
      weeklyActivity: weekly,
    },
    files: result,
    coupling: coupling.slice(0, 100),
    info: { branch: branch?.trim(), commit: commit?.trim(), remote: sanitizeRemote(remote) },
  };
}
