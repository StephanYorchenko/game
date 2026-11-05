export type RouteGraph = ReadonlyMap<number, readonly number[]>;

export function reachable(
  graph: RouteGraph,
  starts: Iterable<number>,
  excluded: ReadonlySet<number> = new Set(),
): Set<number> {
  const seen = new Set<number>();
  const pending: number[] = [];

  for (const start of starts) {
    if (graph.has(start) && !excluded.has(start) && !seen.has(start)) {
      seen.add(start);
      pending.push(start);
    }
  }

  for (let index = 0; index < pending.length; index += 1) {
    for (const next of graph.get(pending[index]!)!) {
      if (!seen.has(next) && !excluded.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }

  return seen;
}

function reverseGraph(graph: RouteGraph): Map<number, number[]> {
  const result = new Map([...graph.keys()].map((key) => [key, [] as number[]]));

  for (const [from, destinations] of graph) {
    for (const to of destinations) {
      result.get(to)!.push(from);
    }
  }

  return result;
}

interface Edge {
  to: number;
  reverse: number;
  capacity: number;
}

/** Две непересекающиеся ветви от двери: к входу компоненты и к выходу/цели. */
function hasTwoBranches(
  graph: RouteGraph,
  component: ReadonlySet<number>,
  door: number,
  entries: ReadonlySet<number>,
  exits: ReadonlySet<number>,
): boolean {
  const ids = new Map([...component].map((key, index) => [key, index]));
  const entrySink = ids.size * 2;
  const exitSink = entrySink + 1;
  const sink = exitSink + 1;
  const network: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const add = (from: number, to: number, capacity: number): void => {
    const reverse = network[to]!.length;
    network[to]!.push({ to: from, reverse: network[from]!.length, capacity: 0 });
    network[from]!.push({ to, reverse, capacity });
  };

  for (const [key, index] of ids) {
    const input = index * 2;
    const output = input + 1;
    add(input, output, key === door ? 2 : 1);

    for (const next of graph.get(key)!) {
      if (ids.has(next)) {
        add(output, ids.get(next)! * 2, 2);
      }
    }

    if (entries.has(key)) {
      add(output, entrySink, 1);
    }

    if (exits.has(key)) {
      add(output, exitSink, 1);
    }
  }

  add(entrySink, sink, 1);
  add(exitSink, sink, 1);
  const source = ids.get(door)! * 2 + 1;

  for (let flow = 0; flow < 2; flow += 1) {
    const parents = new Map<number, { from: number; edge: number }>();
    const pending = [source];
    const seen = new Set([source]);

    for (let index = 0; index < pending.length && !seen.has(sink); index += 1) {
      const from = pending[index]!;

      for (const [edgeIndex, edge] of network[from]!.entries()) {
        if (edge.capacity > 0 && !seen.has(edge.to)) {
          seen.add(edge.to);
          parents.set(edge.to, { from, edge: edgeIndex });
          pending.push(edge.to);
        }
      }
    }

    if (!seen.has(sink)) {
      return false;
    }

    let current = sink;

    while (current !== source) {
      const parent = parents.get(current)!;
      const edge = network[parent.from]![parent.edge]!;
      edge.capacity -= 1;
      network[current]![edge.reverse]!.capacity += 1;
      current = parent.from;
    }
  }

  return true;
}

/** Не допускает обход в тупик через дверь с возвратом по уже пройденной части пути. */
export function liesOnSimpleRoute(
  graph: RouteGraph,
  start: number,
  door: number,
  goals: ReadonlySet<number>,
): boolean {
  if (!graph.has(door) || goals.size === 0) {
    return false;
  }

  const reversed = reverseGraph(graph);
  const forward = reachable(graph, [door]);
  const backward = reachable(reversed, [door]);
  const component = new Set([...forward].filter((key) => backward.has(key)));
  const before = reachable(graph, [start], component);
  const after = reachable(
    reversed,
    [...goals].filter((key) => !component.has(key)),
    component,
  );
  const entries = new Set<number>();
  const exits = new Set<number>();

  for (const key of component) {
    if (key === start || reversed.get(key)!.some((previous) => before.has(previous))) {
      entries.add(key);
    }

    if (goals.has(key) || graph.get(key)!.some((next) => after.has(next))) {
      exits.add(key);
    }
  }

  // При глобальных ограничениях NESW внутри компоненты все рёбра обратимы;
  // односторонние направления ведут только между компонентами.
  return (
    entries.size > 0 && exits.size > 0 && hasTwoBranches(graph, component, door, entries, exits)
  );
}
