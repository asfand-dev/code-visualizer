import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a project file by its root-relative POSIX path: the text, `null` when the file does not exist
 * in this snapshot, or `undefined` to read it from disk. Lets the analyzer see another git ref, the
 * index or a proposed edit without touching the working tree.
 */
export type ReadText = (rel: string) => string | null | undefined;

/** Project file access with an optional snapshot override (paths are absolute). */
export interface ProjectFiles {
  read(abs: string): string | undefined;
  exists(abs: string): boolean;
  /** Root-relative paths that exist only in the snapshot (deleted on disk), for code that globs the disk. */
  extra: string[];
  /** Absolute paths of `extra` files whose root-relative path matches. */
  extraMatching(test: (rel: string) => boolean): string[];
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

export function projectFiles(root: string, readText?: ReadText, extra: string[] = []): ProjectFiles {
  const override = (abs: string): string | null | undefined => {
    if (!readText) return undefined;
    const rel = toPosix(path.relative(root, abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    return readText(rel);
  };
  return {
    read(abs) {
      const text = override(abs);
      if (text !== undefined) return text ?? undefined;
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return undefined;
      }
    },
    exists(abs) {
      const text = override(abs);
      return text !== undefined ? text !== null : fs.existsSync(abs);
    },
    extra,
    extraMatching(test) {
      return extra.filter(test).map((rel) => path.join(root, rel));
    },
  };
}

/** A ReadText backed by an overlay map (missing keys fall back to the disk). */
export function readTextFromOverlay(overlay: Record<string, string | null> | undefined): ReadText | undefined {
  if (!overlay) return undefined;
  return (rel) => (Object.hasOwn(overlay, rel) ? overlay[rel] : undefined);
}
