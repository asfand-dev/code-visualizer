import { describe, expect, it } from 'vitest';
import {
  buildAdjacency,
  pageRank,
  reachable,
  reverse,
  sampleCycle,
  stronglyConnectedComponents,
  type Adjacency,
} from '../src/analyzer/graph.js';

function graph(nodes: string[], edges: [string, string][]): Adjacency {
  return buildAdjacency(
    nodes,
    edges.map(([source, target]) => ({ source, target })),
  );
}

describe('buildAdjacency', () => {
  it('creates an entry for every node, including isolated ones', () => {
    const adj = graph(['a', 'b', 'c'], [['a', 'b']]);
    expect([...adj.keys()]).toEqual(['a', 'b', 'c']);
    expect([...adj.get('a')!]).toEqual(['b']);
    expect(adj.get('c')!.size).toBe(0);
  });

  it('ignores edges that point at unknown nodes and de-duplicates parallel edges', () => {
    const adj = graph(['a', 'b'], [
      ['a', 'b'],
      ['a', 'b'],
      ['a', 'zzz'],
      ['zzz', 'a'],
    ]);
    expect([...adj.get('a')!]).toEqual(['b']);
    expect(adj.has('zzz')).toBe(false);
  });
});

describe('reverse', () => {
  it('flips every edge and keeps all nodes', () => {
    const rev = reverse(graph(['a', 'b', 'c'], [['a', 'b'], ['a', 'c'], ['b', 'c']]));
    expect([...rev.get('c')!].sort()).toEqual(['a', 'b']);
    expect([...rev.get('b')!]).toEqual(['a']);
    expect(rev.get('a')!.size).toBe(0);
  });
});

describe('stronglyConnectedComponents', () => {
  it('returns nothing for a DAG', () => {
    const adj = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['a', 'c'], ['c', 'd']]);
    expect(stronglyConnectedComponents(adj)).toEqual([]);
  });

  it('finds a simple cycle and leaves acyclic nodes out', () => {
    const adj = graph(['a', 'b', 'c', 'd', 'e'], [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['c', 'd'],
      ['d', 'e'],
    ]);
    expect(stronglyConnectedComponents(adj)).toEqual([['a', 'b', 'c']]);
  });

  it('reports self-loops as single-node components', () => {
    const adj = graph(['x', 'y'], [['x', 'x'], ['x', 'y']]);
    expect(stronglyConnectedComponents(adj)).toEqual([['x']]);
  });

  it('separates independent cycles and sorts them largest first with sorted members', () => {
    const adj = graph(['p', 'q', 'm', 'n', 'o', 'z'], [
      ['p', 'q'],
      ['q', 'p'],
      ['o', 'n'],
      ['n', 'm'],
      ['m', 'o'],
      ['q', 'm'], // bridge between the two components: does not merge them
      ['z', 'p'],
    ]);
    expect(stronglyConnectedComponents(adj)).toEqual([
      ['m', 'n', 'o'],
      ['p', 'q'],
    ]);
  });

  it('merges overlapping cycles into one component', () => {
    const adj = graph(['a', 'b', 'c', 'd'], [
      ['a', 'b'],
      ['b', 'a'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'b'],
    ]);
    expect(stronglyConnectedComponents(adj)).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('handles very deep graphs without overflowing the call stack', () => {
    const n = 50_000;
    const nodes = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges: [string, string][] = nodes.slice(1).map((node, i) => [nodes[i], node]);
    edges.push([nodes[n - 1], nodes[0]]); // close one giant ring
    const sccs = stronglyConnectedComponents(graph(nodes, edges));
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toHaveLength(n);
  });
});

describe('sampleCycle', () => {
  it('returns a concrete cycle path starting at the first member, in edge order', () => {
    const adj = graph(['a', 'b', 'c', 'd'], [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['b', 'd'],
    ]);
    const cycle = sampleCycle(adj, ['a', 'b', 'c']);
    expect(cycle).toEqual(['a', 'b', 'c']);
    // every consecutive pair (and the wrap-around) is a real edge
    for (let i = 0; i < cycle.length; i++) {
      expect(adj.get(cycle[i])!.has(cycle[(i + 1) % cycle.length])).toBe(true);
    }
  });

  it('finds the shortest cycle back to the start inside a larger component', () => {
    const adj = graph(['a', 'b', 'c', 'd'], [
      ['a', 'b'],
      ['b', 'a'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'b'],
    ]);
    expect(sampleCycle(adj, ['a', 'b', 'c', 'd'])).toEqual(['a', 'b']);
  });
});

describe('pageRank', () => {
  it('returns an empty map for an empty graph', () => {
    expect(pageRank(new Map()).size).toBe(0);
  });

  it('gives the most-imported module the top score (normalized to 1)', () => {
    // app, pageA, pageB all import utils; app imports both pages.
    const adj = graph(['app', 'pageA', 'pageB', 'utils'], [
      ['app', 'pageA'],
      ['app', 'pageB'],
      ['app', 'utils'],
      ['pageA', 'utils'],
      ['pageB', 'utils'],
    ]);
    const rank = pageRank(adj);
    expect(rank.get('utils')).toBe(1);
    expect(rank.get('app')!).toBeLessThan(rank.get('pageA')!);
    expect(rank.get('pageA')).toBeCloseTo(rank.get('pageB')!, 6);
    for (const v of rank.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('treats all members of a symmetric cycle equally', () => {
    const rank = pageRank(graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]));
    expect([...rank.values()]).toEqual([1, 1, 1]);
  });

  it('distributes rank of dangling nodes instead of losing it', () => {
    const rank = pageRank(graph(['a', 'b', 'lonely'], [['a', 'b']]));
    expect(rank.get('b')).toBe(1);
    expect(rank.get('lonely')!).toBeGreaterThan(0);
    expect(rank.get('lonely')).toBeCloseTo(rank.get('a')!, 6);
  });
});

describe('reachable', () => {
  const adj = graph(['a', 'b', 'c', 'd', 'e', 'x'], [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['d', 'b'], // cycle
    ['a', 'e'],
    ['x', 'a'],
  ]);

  it('returns BFS depths from the start node', () => {
    expect(Object.fromEntries(reachable(adj, 'a'))).toEqual({ a: 0, b: 1, e: 1, c: 2, d: 3 });
  });

  it('respects the depth limit', () => {
    expect([...reachable(adj, 'a', 1).keys()].sort()).toEqual(['a', 'b', 'e']);
    expect([...reachable(adj, 'a', 0).keys()]).toEqual(['a']);
  });

  it('terminates on cycles and does not walk backwards', () => {
    const result = reachable(adj, 'c');
    expect(Object.fromEntries(result)).toEqual({ c: 0, d: 1, b: 2 });
    expect(result.has('a')).toBe(false);
  });

  it('works on the reversed graph to find dependents', () => {
    expect([...reachable(reverse(adj), 'b').keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
  });
});
