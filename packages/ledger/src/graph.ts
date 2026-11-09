// Dependency graph of ledger rows: unknown dependencies and cycles (Tarjan's strongly connected
// components; every component with more than one row, or a row that depends on itself, is a cycle).

export interface GraphReport {
  rows: number;
  edges: number;
  acyclic: boolean;
  /** Each cycle as its row codes, sorted; cycles sorted by their first code. */
  cycles: string[][];
  unknown: { code: string; missing: string }[];
}

/** deps maps a row code to the codes it depends on. */
export function analyzeGraph(deps: ReadonlyMap<string, readonly string[]>): GraphReport {
  let edges = 0;
  const unknown: { code: string; missing: string }[] = [];
  for (const [code, ds] of deps) {
    for (const d of ds) {
      edges++;
      if (!deps.has(d)) unknown.push({ code, missing: d });
    }
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let next = 0;

  // Iterative Tarjan, so a long dependency chain cannot overflow the call stack.
  for (const root of [...deps.keys()].sort()) {
    if (index.has(root)) continue;
    const work: { node: string; i: number }[] = [{ node: root, i: 0 }];
    index.set(root, next);
    low.set(root, next++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const succ = (deps.get(frame.node) ?? []).filter((d) => deps.has(d));
      if (frame.i < succ.length) {
        const w = succ[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, next);
          low.set(w, next++);
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.node);
        const selfLoop = comp.length === 1 && (deps.get(comp[0]!) ?? []).includes(comp[0]!);
        if (comp.length > 1 || selfLoop) cycles.push(comp.sort());
      }
    }
  }
  cycles.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
  return { rows: deps.size, edges, acyclic: cycles.length === 0, cycles, unknown };
}
