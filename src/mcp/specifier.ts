import path from 'node:path';
import { lookupModule as findModule } from '../analyzer/resolve.js';
import type { ReportData } from '../shared/types.js';

/**
 * Import specifiers as an agent writes them in an import statement — `@/lib/db`, `~/utils/format`,
 * `../lib/format.js` — mapped to project paths without loading the analyzer: through the specifiers the
 * project's own imports already use, the aliases those imports reveal, the usual alias conventions,
 * ESM `.js` suffixes and index files.
 */

/** Alias conventions the analyzer also knows (src/analyzer/resolve.ts), tried when no import reveals the alias. */
const CONVENTIONS: [prefix: string, targets: string[]][] = [
  ['@/', ['src/', 'app/', '']],
  ['~/', ['src/', 'app/', '']],
  ['~~/', ['']],
  ['@@/', ['']],
  ['#/', ['src/', '']],
  ['$lib/', ['src/lib/']],
];

/** `@/x`, `~/x`, `#x`, `$lib/x`: a bundler or tsconfig alias, never a path on disk. */
export const ALIAS_LIKE = /^(@\/|~~?\/|@@\/|#|\$)/;

const isRelative = (s: string): boolean => s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');

/** The analyzed file a project-relative module path names: exact, with an extension, its index file, or the TypeScript source of an ESM `.js` path. */
export function lookupModule(files: ReadonlySet<string>, base: string): string | undefined {
  if (!base || base === '..' || base.startsWith('../')) return undefined;
  return findModule(files, base);
}

interface SpecifierIndex {
  files: Set<string>;
  /** Non-relative specifier → the files it resolves to in this project, most used first. */
  bySpecifier: Map<string, string[]>;
  /** Alias prefix → the project folder it stands for, learned from the imports (`@/` → ``), longest first. */
  aliases: [prefix: string, dir: string][];
}

const indexes = new WeakMap<ReportData, SpecifierIndex>();

/** Strip the extension, and `/index` (a folder import): the part of a file id an import names. */
function importedStems(id: string): string[] {
  const stem = id.replace(/\.[^./]+$/, '');
  return /\/index$/.test(stem) ? [stem, stem.slice(0, -'/index'.length)] : [stem];
}

/**
 * `@/lib/db` → `lib/db.ts` shows that `@/` stands for the project root: the specifier and the file
 * share their trailing path segments, and what precedes them is the alias and its folder.
 */
function aliasOf(specifier: string, target: string): [string, string] | undefined {
  const spec = specifier.replace(/\.(m|c)?jsx?$/, '').split('/');
  for (const stem of importedStems(target)) {
    const file = stem.split('/');
    let shared = 0;
    while (shared < spec.length - 1 && shared < file.length && spec[spec.length - 1 - shared] === file[file.length - 1 - shared]) shared++;
    if (!shared) continue;
    const prefix = `${spec.slice(0, spec.length - shared).join('/')}/`;
    const rest = file.slice(0, file.length - shared);
    return [prefix, rest.length ? `${rest.join('/')}/` : ''];
  }
  return undefined;
}

function specifierIndex(data: ReportData): SpecifierIndex {
  const cached = indexes.get(data);
  if (cached) return cached;
  const files = new Set(data.files.map((f) => f.id));
  const counts = new Map<string, Map<string, number>>();
  const votes = new Map<string, Map<string, number>>();
  const bump = (map: Map<string, Map<string, number>>, key: string, value: string): void => {
    const inner = map.get(key) ?? new Map<string, number>();
    inner.set(value, (inner.get(value) ?? 0) + 1);
    map.set(key, inner);
  };
  for (const e of data.edges) {
    if (!e.specifier || isRelative(e.specifier) || e.specifier.startsWith('/') || !files.has(e.target)) continue;
    bump(counts, e.specifier, e.target);
    const alias = aliasOf(e.specifier, e.target);
    if (alias) bump(votes, alias[0], alias[1]);
  }
  const ranked = (m: Map<string, number>): string[] => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const index: SpecifierIndex = {
    files,
    bySpecifier: new Map([...counts.entries()].map(([s, m]) => [s, ranked(m)])),
    aliases: [...votes.entries()].map(([prefix, m]): [string, string] => [prefix, ranked(m)[0]]).sort((a, b) => b[0].length - a[0].length),
  };
  indexes.set(data, index);
  return index;
}

export type SpecifierMatch =
  /** The project path the specifier stands for (an analyzed file, a folder, or a module not written yet). */
  | { id: string; how: string }
  | { error: string };

/**
 * The project path an import specifier stands for, or undefined when the input is not one (a plain
 * project path, a symbol name). `importer` is the importing file, for relative specifiers.
 */
export function mapSpecifier(data: ReportData, input: string, importer?: string): SpecifierMatch | undefined {
  const raw = input.trim();
  const idx = specifierIndex(data);
  if (isRelative(raw)) {
    if (!importer) return undefined;
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), raw));
    if (joined === '..' || joined.startsWith('../')) return { error: `${raw} (relative to ${importer}) is outside the project root.` };
    // `./x` may also mean a path from the project root; only an existing file decides for the importer's folder.
    if (raw.startsWith('../') || lookupModule(idx.files, joined)) return { id: joined === '.' ? '' : joined, how: `relative to ${importer}` };
    return undefined;
  }
  // The project's own imports with exactly this specifier.
  const known = idx.bySpecifier.get(raw);
  if (known?.length) return { id: known[0], how: "as the project's own imports resolve it" };
  const segments = raw.split('/');
  for (const [prefix, dir] of idx.aliases) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    if (rest.split('/').includes('..')) return { error: `${raw} leaves the folder of the ${prefix} alias.` };
    return { id: `${dir}${rest}`, how: `through the ${prefix} alias for ${dir || 'the project root'}` };
  }
  for (const [prefix, dirs] of CONVENTIONS) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    if (rest.split('/').includes('..')) return { error: `${raw} leaves the folder of the ${prefix} alias.` };
    for (const dir of dirs) {
      const id = `${dir}${rest}`;
      if (lookupModule(idx.files, id) || [...idx.files].some((f) => f.startsWith(`${id.replace(/\/$/, '')}/`))) return { id, how: `through the usual ${prefix} alias for ${dir || 'the project root'}` };
    }
  }
  // An ESM path of a TypeScript source (`lib/format.js` → lib/format.ts).
  if (segments.length && !ALIAS_LIKE.test(raw) && /\.(m|c)?jsx?$/.test(raw)) {
    const hit = lookupModule(idx.files, raw.replace(/^\.\//, ''));
    if (hit && hit !== raw) return { id: hit, how: 'the TypeScript source of the ESM path' };
  }
  return undefined;
}

/** The package a bare specifier names (`react`, `@tanstack/query/core` → `@tanstack/query`), when the project uses or declares it. */
export function packageOf(data: ReportData, input: string): string | undefined {
  const raw = input.trim();
  if (isRelative(raw) || ALIAS_LIKE.test(raw) || raw.startsWith('/')) return undefined;
  const name = raw.startsWith('@') ? raw.split('/').slice(0, 2).join('/') : raw.split('/')[0];
  return data.packages.some((p) => p.name === name) ? name : undefined;
}
