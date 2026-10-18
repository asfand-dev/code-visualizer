/**
 * Reading copy-paste clones (clone-radar): where a copy is, what to say about it ("this already exists:
 * import it instead"), which clone families a change added (`cloneDelta`) and where a change edited one
 * copy but not the others (`cloneDrift`). Pure — shared by the analyzer, the CLI, the MCP server and the
 * report UI.
 */
import { fingerprint, RULE_IDS } from './fingerprint.js';
import type { ChangedFile, CloneDrift, CloneFamily, CloneFragment, ClonePair, SimilarMatch } from './types.js';

const plural = (count: number, word: string, pluralWord = `${word}s`): string => `${count.toLocaleString('en-US')} ${count === 1 ? word : pluralWord}`;

/** `src/a.ts:40-58` (or `src/a.ts:40` for one line). */
export function fragmentLocation(f: Pick<CloneFragment, 'file' | 'start' | 'end'>): string {
  return f.start === f.end ? `${f.file}:${f.start}` : `${f.file}:${f.start}-${f.end}`;
}

/** Identity of a copy without line numbers: its file and declaration (`src/a.ts#slugify`, `src/a.ts#` for module-level code). */
export function fragmentKey(f: Pick<CloneFragment, 'file' | 'name'>): string {
  return `${f.file}#${f.name ?? ''}`;
}

/** `slugify` / `CartService.checkout` / `code` — what a copy is called in messages. */
export function fragmentName(f: Pick<CloneFragment, 'name'>): string {
  return f.name ?? 'code';
}

/** A copy is a whole declaration copied (most of it), rather than a block inside larger ones. */
export const WHOLE_COPY = 0.8;
/**
 * Copies that make up at least this share of their declaration count (`clones.minSimilarity`): new clones
 * for the gate, `pr` and `serve`, clone drift and the Duplication health score. Smaller shared blocks (JSX
 * markup, argument parsing, error handling written the same way) are listed in Insights only.
 */
export const DEFAULT_MIN_SIMILARITY = 0.5;
/** Copies in files that are committed together count from this similarity on (CodeScene's co-change filter). */
export const CO_CHANGE_SIMILARITY = 0.3;

/** `94%` */
export function similarityLabel(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}

/** `40–100%` when the pairs of a family differ, else `100%`. */
export function similarityRange(family: Pick<CloneFamily, 'fragments' | 'similarity' | 'pairs'>): string {
  const all = familyPairs(family).map((p) => Math.round(p.similarity * 100));
  const low = Math.min(...all);
  const high = Math.max(...all);
  return low === high || !all.length ? similarityLabel(family.similarity) : `${low}–${high}%`;
}

const TEST_PATH_RE = /(^|\/)(__tests__|__mocks__|tests?|e2e|specs?)\/|\.(test|spec|e2e|cy|stories)\.[cm]?[jt]sx?$/;
/** A test (or story) file by its path. */
export const isTestPath = (file: string): boolean => TEST_PATH_RE.test(file);

/* -------------------------------------------------------------------------- */
/*                                Pairs of copies                             */
/* -------------------------------------------------------------------------- */

/** The pairs of copies of a family (every pair at the family's similarity for families without `pairs`). */
export function familyPairs(family: Pick<CloneFamily, 'fragments' | 'similarity' | 'pairs'>): ClonePair[] {
  if (family.pairs?.length) return family.pairs;
  const pairs: ClonePair[] = [];
  for (let a = 0; a < family.fragments.length; a++) for (let b = a + 1; b < family.fragments.length; b++) pairs.push({ a, b, similarity: family.similarity });
  return pairs;
}

/** The copies a copy (by index) is a clone of, with the similarity of each pair. */
export function partnersOf(family: Pick<CloneFamily, 'fragments' | 'similarity' | 'pairs'>, index: number): { index: number; similarity: number }[] {
  const best = new Map<number, number>();
  for (const p of familyPairs(family)) {
    const other = p.a === index ? p.b : p.b === index ? p.a : -1;
    if (other >= 0) best.set(other, Math.max(best.get(other) ?? 0, p.similarity));
  }
  return [...best].map(([i, similarity]) => ({ index: i, similarity }));
}

/**
 * Copies (indexes) that are clones of another copy at least `min` similar: the ones that count for the
 * gate, drift and health.
 */
export function significantCopies(family: Pick<CloneFamily, 'fragments' | 'similarity' | 'pairs'>, min = DEFAULT_MIN_SIMILARITY): Set<number> {
  const copies = new Set<number>();
  for (const p of familyPairs(family)) {
    if (p.similarity < min) continue;
    copies.add(p.a);
    copies.add(p.b);
  }
  return copies;
}

/** Whether two copies of the family are at least `min` similar. */
export function isSignificant(family: Pick<CloneFamily, 'fragments' | 'similarity' | 'pairs'>, min = DEFAULT_MIN_SIMILARITY): boolean {
  return familyPairs(family).some((p) => p.similarity >= min);
}

/** The finding identity of a clone family: its copies by file and declaration (no lines). */
export function cloneFingerprint(family: Pick<CloneFamily, 'fragments'>): string {
  const keys = family.fragments.map(fragmentKey).sort();
  return fingerprint(RULE_IDS.duplicateCode, (family.fragments.find((f) => f.isNew) ?? family.fragments[0])?.file ?? '', keys.join('|'));
}

/**
 * The copy a message is about (the new one, else the first) and the copy to reuse instead: of the copies it
 * is most similar to, an old one, outside tests, exported and the most used first. `similarity` is that
 * pair's.
 */
export function cloneSides(family: Pick<CloneFamily, 'fragments' | 'similarity' | 'pairs'>): { copy: CloneFragment; original: CloneFragment | undefined; similarity: number } {
  const index = Math.max(0, family.fragments.findIndex((f) => f.isNew));
  const copy = family.fragments[index];
  const partners = partnersOf(family, index);
  if (!partners.length) return { copy, original: undefined, similarity: 0 };
  const top = Math.max(...partners.map((p) => p.similarity));
  const rank = (i: number): number[] => {
    const f = family.fragments[i];
    return [f.isNew ? 0 : 1, isTestPath(f.file) ? 0 : 1, f.exported ? 1 : 0, f.importers ?? 0];
  };
  const order = (x: number[], y: number[]): number => x.reduce((d, v, k) => d || y[k] - v, 0);
  const best = partners
    .filter((p) => p.similarity >= top - 0.05)
    .sort((x, y) => order(rank(x.index), rank(y.index)) || y.similarity - x.similarity || family.fragments[x.index].file.localeCompare(family.fragments[y.index].file))[0];
  return { copy, original: family.fragments[best.index], similarity: best.similarity };
}

/**
 * "This already exists": `slugify in src/ui/utils.ts is 94% similar to exported slugify in
 * src/lib/strings.ts (used in 6 files): import it instead`; for a block copied inside larger
 * declarations: `render in src/ui/a.ts (lines 40-58) duplicates draw in src/ui/b.ts (lines 12-30): extract
 * a shared helper`. The similarity is the one of these two copies. `name` formats names (Markdown code).
 */
export function newCloneMessage(family: Pick<CloneFamily, 'fragments' | 'similarity' | 'pairs'>, name: (text: string) => string = (s) => s): string {
  const { copy, original, similarity } = cloneSides(family);
  if (!original) return `${fragmentLocation(copy)} duplicates other code`;
  const others = family.fragments.length > 2 ? ` and ${plural(family.fragments.length - 2, 'more copy', 'more copies')}` : '';
  if (similarity < WHOLE_COPY || !copy.name || !original.name) {
    const where = (f: CloneFragment): string => `${f.name ? `${name(f.name)} in ` : ''}${f.file} (lines ${f.start}-${f.end})`;
    return `${where(copy)} duplicates ${where(original)}${others}: extract a shared helper`;
  }
  const used = original.importers ? ` (used in ${plural(original.importers, 'file')})` : '';
  const advice = original.file === copy.file ? 'call it instead' : original.exported ? 'import it instead' : 'export it and import it instead';
  return `${name(fragmentName(copy))} in ${copy.file} is ${similarityLabel(similarity)} similar to ${original.exported ? 'exported ' : ''}${name(fragmentName(original))} in ${original.file}${used}${others}: ${advice}`;
}

/** `you changed src/a.ts:40-58; its clone src/b.ts:12-30 was not changed`. */
export function driftMessage(d: Pick<CloneDrift, 'changed' | 'untouched'>): string {
  const first = d.untouched[0];
  if (!first) return `you changed ${fragmentLocation(d.changed)}`;
  const more = d.untouched.length > 1 ? ` (and ${plural(d.untouched.length - 1, 'more copy', 'more copies')})` : '';
  return `you changed ${fragmentLocation(d.changed)}; its clone ${fragmentLocation(first)}${more} was not changed`;
}

/** `changed together 9 times: drift risk` (nothing without co-changes, or for a small shared block). */
export function coChangeLabel(family: Pick<CloneFamily, 'coChanges' | 'similarity'>): string | undefined {
  return family.coChanges && family.similarity >= CO_CHANGE_SIMILARITY ? `changed together ${plural(family.coChanges, 'time')}: drift risk` : undefined;
}

/** Clone families with a copy in `file` (and, with `line`, a copy around that line). */
export function familiesOf(families: readonly CloneFamily[] | undefined, file: string, range?: { start: number; end: number }): CloneFamily[] {
  return (families ?? []).filter((fam) => fam.fragments.some((f) => f.file === file && (!range || (f.start <= range.end && f.end >= range.start))));
}

/* -------------------------------------------------------------------------- */
/*                         New clones (base → head)                           */
/* -------------------------------------------------------------------------- */

const pairKey = (x: string, y: string): string => (x < y ? `${x}\0${y}` : `${y}\0${x}`);

/** Every combination of the declarations two copies of a family overlap (`keys[i]` for copy i). */
function declarationPairs(keys: string[][], into: Set<string>): void {
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) for (const x of keys[i]) for (const y of keys[j]) if (x !== y) into.add(pairKey(x, y));
  }
}

/** Files of a family as a sorted multiset (`a.ts|a.ts|b.ts`). */
const fileSet = (family: Pick<CloneFamily, 'fragments'>, moved: (file: string) => string = (f) => f): string => family.fragments.map((f) => moved(f.file)).sort().join('|');

export interface CloneDeltaOptions {
  /** Base file id → head file id (renamed or moved files keep their clones). */
  moved?: (file: string) => string;
  /** Files that changed (head ids): a family none of whose copies is in one is not new, nor fixed. */
  changedFiles?: ReadonlySet<string>;
  /**
   * Whether the base had the copy's declaration (by file and name), even outside any clone family: a copy of
   * an old function is new, the old function is not. Default: it was part of a base clone family.
   */
  existed?: (fragment: CloneFragment) => boolean;
  /**
   * The declarations (as `fragmentKey`s, in head file ids) a copy's lines overlap, on either side: a small
   * edit can move a copy's majority from one declaration to its neighbour, which is not a new clone.
   * A head copy of a declaration that moved to another file also names its old place. Default: its own key.
   */
  baseKeys?: (fragment: CloneFragment) => string[];
  headKeys?: (fragment: CloneFragment) => string[];
  /** The lines of a declaration (key in head file ids) in the base and in the head; undefined when it is not there. */
  baseDeclaration?: (key: string) => { start: number; end: number } | undefined;
  headDeclaration?: (key: string) => { start: number; end: number } | undefined;
  /** Copies need this similarity to count (default DEFAULT_MIN_SIMILARITY). */
  minSimilarity?: number;
  /**
   * Whether the change edited a copy: its lines changed, its declaration's tokens differ, or the declaration
   * is new (`head`) or gone (`base`; fragments in base file ids). Two copies are a new clone only when the
   * change edited one of them, and a base family is fixed (or drifted) only when it edited one of its copies:
   * code added next to a copy never makes it new. Default: every copy in a changed file (any copy without
   * `changedFiles`).
   */
  edited?: (fragment: CloneFragment, side: 'base' | 'head') => boolean;
}

/**
 * Clone families the head has that the base did not, the ones that are gone, and the ones that stopped
 * matching because one copy was edited (drift — not a fix).
 *
 * A family is new when two of its copies that are at least `minSimilarity` similar were not clones of each
 * other in the base — judged by every declaration their lines overlap, so an edit inside an old copy, a
 * rename or a move is not a new clone — and the change edited one of them (`edited`: code added next to a
 * copy is no edit of it). Its copies whose declaration the base did not have, or had outside any family,
 * are marked `isNew`, else the edited ones. A base family whose copies are all still there, one of them
 * edited (about as long as before) and another not, drifted apart; one the change edited otherwise is fixed.
 * Without clone data on either side (an older snapshot, clones turned off) nothing is new.
 */
export function cloneDelta(
  base: readonly CloneFamily[] | undefined,
  head: readonly CloneFamily[] | undefined,
  options: CloneDeltaOptions = {},
): { added: CloneFamily[]; fixed: CloneFamily[]; drifted: CloneDrift[] } {
  if (!base || !head) return { added: [], fixed: [], drifted: [] };
  const min = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const moved = options.moved ?? ((f: string) => f);
  const ownBaseKey = (f: CloneFragment): string => fragmentKey({ file: moved(f.file), name: f.name });
  const baseKeysOf = (f: CloneFragment): string[] => options.baseKeys?.(f) ?? [ownBaseKey(f)];
  const headKeysOf = (f: CloneFragment): string[] => options.headKeys?.(f) ?? [fragmentKey(f)];
  const touched = (fam: CloneFamily, file: (f: string) => string = (f) => f): boolean => !options.changedFiles || fam.fragments.some((f) => options.changedFiles!.has(file(f.file)));
  const edited = (f: CloneFragment, side: 'base' | 'head'): boolean =>
    options.edited ? options.edited(f, side) : !options.changedFiles || options.changedFiles.has(side === 'base' ? moved(f.file) : f.file);

  const baseKeys = new Set<string>();
  const basePairs = new Set<string>();
  for (const fam of base) {
    const keys = fam.fragments.map(baseKeysOf);
    for (const list of keys) for (const k of list) baseKeys.add(k);
    declarationPairs(keys, basePairs);
  }
  const headPairs = new Set<string>();
  for (const fam of head) declarationPairs(fam.fragments.map(headKeysOf), headPairs);
  const wasPair = (x: string[], y: string[]): boolean => x.some((a) => y.some((b) => basePairs.has(pairKey(a, b))));
  const isPair = (x: string[], y: string[]): boolean => x.some((a) => y.some((b) => headPairs.has(pairKey(a, b))));
  // The same normalized code in the same files: the copies were renamed, not added.
  const baseShapes = new Set(base.map((fam) => `${fam.id}\0${fileSet(fam, moved)}`));

  const added: CloneFamily[] = [];
  for (const fam of head) {
    if (baseShapes.has(`${fam.id}\0${fileSet(fam)}`) || !touched(fam)) continue;
    const keys = fam.fragments.map(headKeysOf);
    const changedCopy = fam.fragments.map((f) => edited(f, 'head'));
    // Copies that were no clones before, one of them edited by the change.
    const fresh = familyPairs(fam).filter((p) => p.similarity >= min && !wasPair(keys[p.a], keys[p.b]) && (changedCopy[p.a] || changedCopy[p.b]));
    if (!fresh.length) continue;
    const involved = [...new Set(fresh.flatMap((p) => [p.a, p.b]))];
    const unknown = involved.filter((i) => !keys[i].some((k) => baseKeys.has(k)) && !options.existed?.(fam.fragments[i]));
    const marked = new Set(unknown.length ? unknown : involved.filter((i) => changedCopy[i]));
    added.push({ ...fam, fragments: fam.fragments.map((f, i) => (marked.has(i) ? { ...f, isNew: true } : f)) });
  }

  const fixed: CloneFamily[] = [];
  const drifted: CloneDrift[] = [];
  for (const fam of base) {
    if (!isSignificant(fam, min) || !touched(fam, moved)) continue;
    const keys = fam.fragments.map(baseKeysOf);
    if (familyPairs(fam).some((p) => isPair(keys[p.a], keys[p.b]))) continue;
    // Copies that stopped matching while the change left all of them alone (a limit or a neighbour moved): no news.
    if (!fam.fragments.some((f) => edited(f, 'base'))) continue;
    const drift = driftedApart(fam, options, moved, min, edited);
    if (drift) drifted.push(drift);
    else fixed.push(fam);
  }
  return { added, fixed, drifted };
}

/**
 * A base family that no longer matches because the change edited a copy (still about as long as it was:
 * not replaced by a call) while a copy it was similar to stayed as it was.
 */
function driftedApart(fam: CloneFamily, options: CloneDeltaOptions, moved: (file: string) => string, min: number, edited: (f: CloneFragment, side: 'base') => boolean): CloneDrift | undefined {
  if (!options.changedFiles || !options.headDeclaration) return undefined;
  const floor = fam.coChanges ? Math.min(min, CO_CHANGE_SIMILARITY) : min;
  const now = fam.fragments.map((f) => {
    if (!f.name) return undefined;
    const key = fragmentKey({ file: moved(f.file), name: f.name });
    const head = options.headDeclaration!(key);
    return head && { key, head, base: options.baseDeclaration?.(key) };
  });
  const changed = (i: number): boolean => edited(fam.fragments[i], 'base');
  for (let i = 0; i < fam.fragments.length; i++) {
    const at = now[i];
    if (!at || !changed(i)) continue;
    const f = fam.fragments[i];
    const copied = f.end - f.start + 1;
    const before = at.base ? at.base.end - at.base.start + 1 : copied;
    // Most of the copied lines are still there (a copy replaced by a call to the other one is a fix).
    if (at.head.end - at.head.start + 1 < before - copied / 2) continue;
    const partners = partnersOf(fam, i).filter((p) => p.similarity >= floor && now[p.index] && !changed(p.index));
    if (!partners.length) continue;
    return {
      changed: { ...f, file: moved(f.file), start: at.head.start, end: at.head.end },
      untouched: partners.map((p) => ({ ...fam.fragments[p.index], file: moved(fam.fragments[p.index].file) })),
      family: fam.id,
      similarity: Math.max(...partners.map((p) => p.similarity)),
      ...(fam.coChanges ? { coChanges: fam.coChanges } : {}),
    };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*                                 Clone drift                                */
/* -------------------------------------------------------------------------- */

const overlaps = (f: CloneFragment, lines: readonly number[]): boolean => lines.some((l) => l >= f.start && l <= f.end);

/** What a change did to each file, for telling pasted copies from edited ones. */
function changeIndex(files: readonly ChangedFile[], commentOnly: readonly string[] = []) {
  const skip = new Set(commentOnly);
  const added = new Set<string>();
  const edited = new Map<string, { lines: number[]; added: Set<number> }>();
  for (const f of files) {
    if (f.status === 'added' || f.status === 'untracked') added.add(f.id);
    else if (!skip.has(f.id) && f.status !== 'deleted' && f.lines.length) edited.set(f.id, { lines: f.lines, added: new Set(f.added ?? []) });
  }
  /** Pasted by this change: in a new file, or (all but a line or so of) its lines are added. */
  const fresh = (fr: CloneFragment): boolean => {
    if (added.has(fr.file)) return true;
    const e = edited.get(fr.file);
    if (!e) return false;
    let old = 0;
    for (let l = fr.start; l <= fr.end; l++) if (!e.added.has(l)) old++;
    return old <= Math.max(1, Math.floor((fr.end - fr.start + 1) / 10));
  };
  return { edited, fresh };
}

/**
 * New clones judged from the change alone (when there is no base analysis to compare with): families with
 * a copy the change pasted — in a new file, or on added lines — at least `min` similar to another copy.
 * The pasted copies are marked `isNew`.
 */
export function pastedClones(families: readonly CloneFamily[] | undefined, files: readonly ChangedFile[], min = DEFAULT_MIN_SIMILARITY): CloneFamily[] {
  if (!families?.length || !files.length) return [];
  const { fresh } = changeIndex(files);
  const out: CloneFamily[] = [];
  for (const fam of families) {
    const counted = significantCopies(fam, min);
    const pasted = new Set([...counted].filter((i) => fresh(fam.fragments[i])));
    if (pasted.size) out.push({ ...fam, fragments: fam.fragments.map((f, i) => (pasted.has(i) ? { ...f, isNew: true } : f)) });
  }
  return out;
}

/**
 * Clone families where your change edited a copy that existed before while a copy of it that existed
 * before stayed as it was: a bug fixed in one copy is probably still in the others. Only copies at least
 * `minSimilarity` similar to each other count (from CO_CHANGE_SIMILARITY on for files committed together).
 * Copies your change added (new files, pasted code — that is a new clone, not drift), comment-only edits
 * and deleted files do not count.
 */
export function cloneDrift(families: readonly CloneFamily[] | undefined, files: readonly ChangedFile[], commentOnly: readonly string[] = [], minSimilarity = DEFAULT_MIN_SIMILARITY): CloneDrift[] {
  if (!families?.length || !files.length) return [];
  const { edited, fresh } = changeIndex(files, commentOnly);
  if (!edited.size) return [];
  const drift: CloneDrift[] = [];
  for (const fam of families) {
    const floor = fam.coChanges ? Math.min(minSimilarity, CO_CHANGE_SIMILARITY) : minSimilarity;
    const old = fam.fragments.map((fr) => !fresh(fr));
    const touched = fam.fragments.map((fr, i) => {
      const e = old[i] ? edited.get(fr.file) : undefined;
      return !!e && overlaps(fr, e.lines);
    });
    for (let i = 0; i < fam.fragments.length; i++) {
      if (!touched[i]) continue;
      const partners = partnersOf(fam, i).filter((p) => p.similarity >= floor && old[p.index] && !touched[p.index]);
      if (!partners.length) continue;
      drift.push({
        changed: fam.fragments[i],
        untouched: partners.map((p) => fam.fragments[p.index]),
        family: fam.id,
        similarity: Math.max(...partners.map((p) => p.similarity)),
        ...(fam.coChanges ? { coChanges: fam.coChanges } : {}),
      });
      break;
    }
  }
  return drift.sort((a, b) => (b.coChanges ?? 0) - (a.coChanges ?? 0) || (b.similarity ?? 0) - (a.similarity ?? 0) || a.changed.file.localeCompare(b.changed.file)).slice(0, 50);
}

/* -------------------------------------------------------------------------- */
/*                         "Reuse it" (similar / find_similar)                 */
/* -------------------------------------------------------------------------- */

export interface ReuseAdvice {
  /**
   * `import`: use `keep` (exported) instead; `export`: export `keep` and import it; `keep-query`: the code
   * asked about is the copy to keep (exported and used more than its copies), the copies should use it.
   */
  kind: 'import' | 'export' | 'keep-query';
  keep?: SimilarMatch;
  /** The other whole copies (most similar first). */
  copies: SimilarMatch[];
}

/**
 * Which copy to keep when the answer of `similar` / `find_similar` has whole copies (≥ WHOLE_COPY): among
 * the most similar ones, the exported and most used — which can be the code asked about (a file, lines or
 * a symbol, with its own `exported` / `importers`), not only one of the matches.
 */
export function reuseAdvice(query: { name?: string; exported?: boolean; importers?: number }, matches: readonly SimilarMatch[]): ReuseAdvice | undefined {
  const strong = matches.filter((m) => Math.max(m.similarity, m.contained ?? 0) >= WHOLE_COPY);
  if (!strong.length) return undefined;
  const score = (x: { exported?: boolean; importers?: number }): number => (x.exported ? 1_000_000 : 0) + (x.importers ?? 0);
  const top = Math.max(...strong.map((m) => m.similarity));
  const keep = strong.filter((m) => m.similarity >= top - 0.1).sort((a, b) => score(b) - score(a) || b.similarity - a.similarity)[0];
  if (query.name && score(query) > score(keep)) return { kind: 'keep-query', copies: strong };
  return { kind: keep.exported ? 'import' : 'export', keep, copies: strong.filter((m) => m !== keep) };
}
