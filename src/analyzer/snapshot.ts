/**
 * Snapshots of other versions of the project — any git ref or the staged index — without checking
 * anything out (see src/analyzer/overlay.ts for how they are built and cached).
 */
import type { ReportSnapshot } from '../shared/types.js';
import { analyze } from './index.js';
import { takeSnapshot, type SnapshotOptions } from './overlay.js';

export { clearSnapshotCache, configAt, isSnapshotPath, overlayForIndex, overlayForRef, renamesSince, toSnapshot } from './overlay.js';
export type { Overlay, SnapshotOptions } from './overlay.js';

/**
 * Analyze the project as it is at `ref` — without a checkout and without touching the working tree.
 * Only files that differ from the working tree are read from git (and parsed); results are cached per
 * commit, in memory and in `.code-visualizer/snapshots/`. Throws an AnalyzeError for unknown refs or
 * outside a git repository.
 */
export function snapshotAt(root: string, ref: string, options: SnapshotOptions = {}): Promise<ReportSnapshot> {
  return takeSnapshot(analyze, root, ref, options);
}
