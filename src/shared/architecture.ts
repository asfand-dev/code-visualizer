/**
 * Areas of a codebase: files grouped by their folder at a given depth. Used by the Architecture view
 * and by `compareReports` (new dependencies between areas). Pure — shared by the CLI and the report UI.
 */
import type { FileInfo } from './types.js';

/** Folder at a given depth for a file's directory (`src/components/ui`, 2 → `src/components`). */
export function folderAtDepth(fileDir: string, depth: number): string {
  if (!fileDir) return '';
  const parts = fileDir.split('/');
  return parts.slice(0, depth).join('/');
}

/** The area a file belongs to; files at the top level form the `(root)` area. */
export function areaName(fileDir: string, depth: number): string {
  return folderAtDepth(fileDir, depth) || '(root)';
}

/** Deepest folder level among the files (`src/a/b/x.ts` → 3). */
function maxFolderDepth(files: Pick<FileInfo, 'dir'>[]): number {
  let max = 0;
  for (const f of files) if (f.dir) max = Math.max(max, f.dir.split('/').length);
  return max;
}

/** Folder depth whose number of areas is closest to a readable ~12 (tests are not counted). */
export function defaultAreaDepth(files: Pick<FileInfo, 'dir' | 'kind'>[], maxDepth = maxFolderDepth(files)): number {
  const sources = files.filter((f) => f.kind !== 'test');
  let best = 1;
  let bestScore = Infinity;
  for (let d = 1; d <= Math.max(1, maxDepth); d++) {
    const count = new Set(sources.map((f) => areaName(f.dir, d))).size;
    const score = Math.abs(Math.log(Math.max(count, 1) / 12));
    if (score < bestScore - 0.05) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}
