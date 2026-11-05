import { canReachInteraction, canReachMaskedCell, getSupercoverCells } from "../geometry";
import { getStepDestinations } from "../movement";
import type { PathOptions } from "../pathfinding";
import type { Position, UnitState, WorldState } from "../world";
import { liesOnSimpleRoute, reachable } from "./routes";
import type { RouteGraph } from "./routes";

export const cellKey = (world: WorldState, position: Readonly<Position>): number =>
  position.y * world.map.width + position.x;

export const cellPosition = (world: WorldState, key: number): Position => ({
  x: key % world.map.width,
  y: Math.floor(key / world.map.width),
});

function movementGraph(world: WorldState, unit: UnitState, options: PathOptions): RouteGraph {
  const start = cellKey(world, unit.position!);
  const graph = new Map<number, number[]>();
  const pending = [start];
  const seen = new Set([start]);

  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index]!;
    const actor = { ...unit, position: cellPosition(world, current) };
    const destinations = getStepDestinations(world, actor, options.movement).map((position) =>
      cellKey(world, position),
    );
    graph.set(current, destinations);

    for (const next of destinations) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }

  return graph;
}

/** Поисковая проекция: открываются только двери, до которых уже можно взаимодействовать. */
export function potentialDoors(
  world: WorldState,
  unit: UnitState,
  enemies: readonly UnitState[],
  options: PathOptions,
): ReadonlySet<string> {
  const projected: WorldState = {
    ...world,
    units: world.units.filter((candidate) => candidate.id !== unit.id),
    map: {
      ...world.map,
      cells: world.map.cells.map((cell) => ({
        ...cell,
        structure: cell.structure ? { ...cell.structure } : null,
      })),
    },
  };
  const candidates = projected.map.cells.flatMap((cell, index) => {
    const door = cell.structure;
    return cell.area === "inside" &&
      door?.kind === "door" &&
      door.state === "closed" &&
      door.reinforcement === null
      ? [{ door, key: index }]
      : [];
  });
  const opened = new Set<string>();
  let graph: RouteGraph;
  let changed: boolean;

  do {
    graph = movementGraph(projected, unit, options);
    changed = false;

    for (const { door, key } of candidates) {
      if (opened.has(door.id)) {
        continue;
      }

      const position = cellPosition(world, key);
      const canOpen = [...graph.keys()].some((at) =>
        canReachInteraction(
          projected,
          cellPosition(world, at),
          position,
          door.interactionMask,
          options.line,
        ),
      );

      if (canOpen) {
        door.state = "open";
        opened.add(door.id);
        changed = true;
      }
    }
  } while (changed);

  const goals = new Set<number>();
  const rayDoors = new Map<number, Set<number>>();
  const candidateKeys = new Set(
    candidates.filter(({ door }) => opened.has(door.id)).map(({ key }) => key),
  );

  for (const at of graph.keys()) {
    const from = cellPosition(world, at);

    for (const enemy of enemies) {
      if (!canReachMaskedCell(projected, from, enemy.position!, unit.attackMask, options.line)) {
        continue;
      }

      goals.add(at);

      for (const position of getSupercoverCells(from, enemy.position!)) {
        const key = cellKey(world, position);

        if (candidateKeys.has(key) && key !== at) {
          const rays = rayDoors.get(key) ?? new Set<number>();
          rays.add(at);
          rayDoors.set(key, rays);
        }
      }
    }
  }

  const start = cellKey(world, unit.position!);
  const useful = new Set<string>();

  for (const { door, key } of candidates) {
    if (!opened.has(door.id)) {
      continue;
    }

    const withoutDoor = reachable(graph, [start], new Set([key]));
    const opensAttackLine = [...(rayDoors.get(key) ?? [])].some((goal) => withoutDoor.has(goal));

    if (opensAttackLine || liesOnSimpleRoute(graph, start, key, goals)) {
      useful.add(door.id);
    }
  }

  return useful;
}
