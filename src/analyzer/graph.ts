/** Small graph toolkit: strongly connected components, PageRank, traversal. */
import { tarjan } from '../shared/scc.js';

export type Adjacency = Map<string, Set<string>>;

export function buildAdjacency(nodes: Iterable<string>, edges: Iterable<{ source: string; target: string }>): Adjacency {
  const adj: Adjacency = new Map();
  for (const n of nodes) adj.set(n, new Set());
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)!.add(e.target);
  }
  return adj;
}

export function reverse(adj: Adjacency): Adjacency {
  const rev: Adjacency = new Map();
  for (const n of adj.keys()) rev.set(n, new Set());
  for (const [s, targets] of adj) for (const t of targets) rev.get(t)?.add(s);
  return rev;
}

/** Tarjan's algorithm (iterative, safe for deep graphs). Returns components with > 1 node or self-loops. */
export function stronglyConnectedComponents(adj: Adjacency): string[][] {
  return tarjan(adj.keys(), (node) => adj.get(node) ?? [])
    .filter((c) => c.length > 1 || adj.get(c[0])?.has(c[0]))
    .map((c) => c.sort())
    .sort((a, b) => b.length - a.length);
}

/** Find one concrete cycle path inside a strongly connected component (for readable output). */
export function sampleCycle(adj: Adjacency, component: string[]): string[] {
  const members = new Set(component);
  const start = component[0];
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const node = queue.shift()!;
    for (const next of adj.get(node) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) {
        const path = [node];
        let cur = node;
        while (cur !== start) {
          cur = prev.get(cur)!;
          path.push(cur);
        }
        return path.reverse();
      }
      if (!seen.has(next)) {
        seen.add(next);
        prev.set(next, node);
        queue.push(next);
      }
    }
  }
  return component;
}

/** PageRank where importing a module passes importance to it. Returns values normalized to 0..1. */
export function pageRank(adj: Adjacency, iterations = 40, damping = 0.85): Map<string, number> {
  const nodes = [...adj.keys()];
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (!n) return rank;
  for (const node of nodes) rank.set(node, 1 / n);
  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    for (const node of nodes) next.set(node, (1 - damping) / n);
    let dangling = 0;
    for (const node of nodes) {
      const out = adj.get(node)!;
      const r = rank.get(node)!;
      if (!out.size) {
        dangling += r;
        continue;
      }
      const share = (damping * r) / out.size;
      for (const t of out) next.set(t, next.get(t)! + share);
    }
    const spread = (damping * dangling) / n;
    for (const node of nodes) next.set(node, next.get(node)! + spread);
    for (const [k, v] of next) rank.set(k, v);
  }
  let max = 0;
  for (const v of rank.values()) max = Math.max(max, v);
  for (const [k, v] of rank) rank.set(k, max ? Math.round((v / max) * 1000) / 1000 : 0);
  return rank;
}

/** Breadth-first reachability with optional depth limit. */
export function reachable(adj: Adjacency, start: string, maxDepth = Infinity): Map<string, number> {
  const depth = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift()!;
    const d = depth.get(node)!;
    if (d >= maxDepth) continue;
    for (const next of adj.get(node) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  return depth;
}
