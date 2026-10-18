/**
 * Strongly connected components (Tarjan's algorithm, iterative, so deep graphs cannot overflow the
 * stack), shared by the analyzer's cycle detection and review-mode's reading order. Pure: the report UI
 * imports src/shared/, so nothing here may import the analyzer or Node APIs.
 */

/**
 * Every component of a graph — cyclic ones have more than one member (or a self-loop) — in the order
 * Tarjan's algorithm completes them: a component comes after every component it reaches. `nodes` sets
 * the order in which roots are tried, `next(node)` gives a node's successors; members are listed in the
 * order they leave the stack.
 */
export function tarjan(nodes: Iterable<string>, next: (node: string) => Iterable<string>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  for (const start of nodes) {
    if (indices.has(start)) continue;
    const work: { node: string; successors: Iterator<string> }[] = [];
    const push = (node: string): void => {
      indices.set(node, index);
      low.set(node, index++);
      stack.push(node);
      onStack.add(node);
      work.push({ node, successors: next(node)[Symbol.iterator]() });
    };
    push(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const step = frame.successors.next();
      if (!step.done) {
        const w = step.value;
        if (!indices.has(w)) push(w);
        else if (onStack.has(w)) low.set(frame.node, Math.min(low.get(frame.node)!, indices.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === indices.get(frame.node)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.node);
        result.push(component);
      }
    }
  }
  return result;
}
