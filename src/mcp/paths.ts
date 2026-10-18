import fs from 'node:fs';
import path from 'node:path';

/**
 * Path arguments of MCP tools and resources stay inside the project: `..` segments, absolute paths
 * outside the root and symlinks that lead out of it are refused before anything is looked up.
 */

const ROUTE_ARG = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL|PAGE)\s/i;

/** The real path of `p`, or of its nearest existing ancestor plus the rest (for files that do not exist yet). */
function realish(p: string): string {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `p` is `root` or inside it. `path.relative` compares case-insensitively on Windows, where an
 * editor may expand the workspace folder as `c:\work` while the agent passes `C:\work\src\a.ts`.
 */
export function inside(root: string, p: string, pathApi: typeof path = path): boolean {
  const rel = pathApi.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel));
}

/** Whether the input names something on disk (a path) rather than a symbol, a folder name or a route. */
export function isPathLike(input: string): boolean {
  return /[\\/]/.test(input) || input.startsWith('.') || input.startsWith('~') || path.isAbsolute(input);
}

/**
 * A tool's path argument as a project-relative id (`src/a.ts`, `src/api/`, `src/a.ts#Name`), or an
 * error when it would leave the project. Symbol names, file names without a folder and routes pass
 * through unchanged.
 */
export function projectPath(root: string, input: string): { id: string } | { error: string } {
  const raw = input.trim();
  if (!raw || ROUTE_ARG.test(raw)) return { id: raw };
  const hash = raw.indexOf('#');
  const pathPart = hash > 0 ? raw.slice(0, hash) : raw;
  const symbol = hash > 0 ? raw.slice(hash) : '';
  if (!isPathLike(pathPart) && pathPart !== '..') return { id: raw };
  const posix = pathPart.replace(/\\/g, '/');
  const outside = { error: `${pathPart} is outside the project root; pass a path relative to the project root.` };
  if (posix.startsWith('~')) return outside;
  const realRoot = realish(path.resolve(root));
  const trailing = /\/$/.test(posix) && posix.length > 1 ? '/' : '';
  if (path.isAbsolute(pathPart) || /^[A-Za-z]:\//.test(posix)) {
    const real = realish(path.resolve(pathPart));
    if (!inside(realRoot, real)) return outside;
    const rel = path.relative(realRoot, real).split(path.sep).join('/');
    return { id: `${rel}${rel && trailing}${symbol}` };
  }
  if (posix.split('/').includes('..')) return { error: `${pathPart} contains "..": pass a path inside the project, relative to its root.` };
  // A symlink inside the project that points outside of it.
  if (!inside(realRoot, realish(path.resolve(root, posix)))) return { error: `${pathPart} leads outside the project root (symlink).` };
  // `src/./a.ts`, `./src//a.ts` → `src/a.ts` (a trailing `/` still names a folder).
  const rel = path.posix.normalize(posix);
  return { id: `${rel === '.' || rel === './' ? '' : rel.replace(/^\.\//, '')}${symbol}` };
}
