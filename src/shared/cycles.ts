/**
 * Plans to break an import cycle: which imports to cut, in which order, and how. Pure — the report UI
 * shows the plan next to each cycle.
 *
 * A cycle is cheapest to break where the import carries the least: an import of types only costs
 * nothing (`import type` is erased), one that names a few values can move them to a shared module,
 * and an import that points at a less stable file than its own breaks the "depend towards stability"
 * rule, so it is the natural one to invert.
 */
import { tarjan } from './scc.js';
import type { DependencyEdge, FileInfo } from './types.js';

export type CycleAction = 'import-type' | 'move-to-shared' | 'invert' | 'extract';

export interface CycleCut {
  source: string;
  target: string;
  line: number;
  /** Names the import brings in (`default`, `*` included). */
  names: string[];
  action: CycleAction;
  effort: 'trivial' | 'small' | 'moderate';
  /** What to do, in a sentence. */
  advice: string;
}

export interface CyclePlan {
  /** The cuts, in the order to make them. */
  cuts: CycleCut[];
  /** Making all of them leaves no cycle among the files. */
  complete: boolean;
}

/** Edges beyond this many cuts mean the files are tangled enough to need a redesign, not a patch. */
const MAX_CUTS = 4;
const NAMESPACE_IMPORT_COST = 6;
/** An import towards a less stable file is cheaper to remove: it is the one the design rule objects to. */
const UNSTABLE_DEPENDENCY_DISCOUNT = 1.5;
const TYPE_KINDS = new Set(['interface', 'type']);
const MOVABLE_KINDS = new Set(['interface', 'type', 'enum', 'constant', 'variable', 'function']);
const MAX_NAMES_TO_MOVE = 3;

type PlanFiles = Pick<FileInfo, 'id' | 'symbols' | 'metrics'>;

function base(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

function quote(names: string[]): string {
  return names.map((n) => `\`${n}\``).join(', ');
}

function cyclicEdges(members: Set<string>, edges: DependencyEdge[]): DependencyEdge[] {
  const next = new Map<string, string[]>();
  for (const e of edges) next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
  const components = tarjan(members, (n) => next.get(n) ?? []).filter((c) => c.length > 1 || next.get(c[0])?.includes(c[0]));
  const owner = new Map<string, number>();
  components.forEach((c, i) => c.forEach((id) => owner.set(id, i)));
  return edges.filter((e) => owner.has(e.source) && owner.get(e.source) === owner.get(e.target));
}

export function planCycleFix(data: { files: PlanFiles[]; edges: DependencyEdge[] }, cycle: string[], maxCuts = MAX_CUTS): CyclePlan {
  const members = new Set(cycle);
  const fileById = new Map(data.files.map((f) => [f.id, f]));
  const instability = (id: string): number => fileById.get(id)?.metrics.instability ?? 0.5;
  const kindsOf = (e: DependencyEdge): (string | undefined)[] => {
    const symbols = fileById.get(e.target)?.symbols ?? [];
    return e.names.map((n) => symbols.find((s) => s.name === n)?.kind);
  };
  const allTypes = (e: DependencyEdge): boolean => e.names.length > 0 && kindsOf(e).every((k) => k !== undefined && TYPE_KINDS.has(k));
  const cost = (e: DependencyEdge): number => {
    const carried = e.names.includes('*') ? NAMESPACE_IMPORT_COST : Math.max(1, e.names.length);
    const own = allTypes(e) ? 0 : carried;
    return instability(e.target) > instability(e.source) ? own - UNSTABLE_DEPENDENCY_DISCOUNT : own;
  };

  let remaining = data.edges.filter((e) => members.has(e.source) && members.has(e.target) && !e.typeOnly);
  const cuts: CycleCut[] = [];
  while (cuts.length < maxCuts) {
    const candidates = cyclicEdges(members, remaining);
    if (!candidates.length) break;
    const best = candidates.reduce((a, b) => (cost(b) < cost(a) || (cost(b) === cost(a) && (b.source + b.target).localeCompare(a.source + a.target) < 0) ? b : a));
    cuts.push(describe(best));
    remaining = remaining.filter((e) => e !== best);
  }
  return { cuts, complete: cyclicEdges(members, remaining).length === 0 };

  function describe(e: DependencyEdge): CycleCut {
    const names = e.names;
    const kinds = kindsOf(e);
    const where = `${base(e.source)} → ${base(e.target)}`;
    const shared = `a module that neither file imports from the other`;
    if (allTypes(e)) {
      return { source: e.source, target: e.target, line: e.line, names, action: 'import-type', effort: 'trivial', advice: `${where} only needs types (${quote(names)}): write \`import type { … }\` so it disappears at runtime.` };
    }
    const movable = names.length > 0 && names.length <= MAX_NAMES_TO_MOVE && !names.includes('*') && kinds.every((k) => k !== undefined && MOVABLE_KINDS.has(k));
    if (movable) {
      return { source: e.source, target: e.target, line: e.line, names, action: 'move-to-shared', effort: 'small', advice: `${where} uses ${quote(names)}: move ${names.length === 1 ? 'it' : 'them'} out of ${base(e.target)} into ${shared}.` };
    }
    if (instability(e.target) > instability(e.source)) {
      return { source: e.source, target: e.target, line: e.line, names, action: 'invert', effort: 'moderate', advice: `${base(e.source)} is more stable than ${base(e.target)} but depends on it: invert the dependency, so ${base(e.target)} passes in or registers what ${base(e.source)} needs (a parameter, callback or interface).` };
    }
    return { source: e.source, target: e.target, line: e.line, names, action: 'extract', effort: 'moderate', advice: `${where} imports ${names.includes('*') ? 'the whole module' : quote(names)}: extract the part of ${base(e.target)} that ${base(e.source)} uses into its own module.` };
  }
}
