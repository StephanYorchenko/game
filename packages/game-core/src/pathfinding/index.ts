import { canReachInteraction, canReachMaskedCell } from "../geometry/index.js";
import type { LineOptions } from "../geometry/index.js";
import { getStepDestinations } from "../movement/index.js";
import type { MovementOptions } from "../movement/index.js";
import type { SeededRng } from "../random/index.js";
import { getCell } from "../world/index.js";
import type { Mask5x5, Position, UnitState, WorldState } from "../world/index.js";

export type ActionTarget =
  | { readonly kind: "attack"; readonly position: Position }
  | {
      readonly kind: "interact";
      readonly position: Position;
      readonly interactionMask: Mask5x5;
    };

export interface PathOptions {
  readonly movement?: MovementOptions;
  readonly line?: LineOptions;
}

export interface ActionPath {
  readonly distance: number;
  /** Начальная клетка не входит в steps; каждый элемент — один обычный шаг. */
  readonly steps: readonly Position[];
  readonly destination: Position;
}

interface SearchNode {
  position: Position;
  distance: number;
  predecessors: number[];
}

function search(
  world: WorldState,
  unit: UnitState,
  target: ActionTarget,
  options: PathOptions,
): { nodes: Map<number, SearchNode>; goals: number[] } {
  const nodes = new Map<number, SearchNode>();
  const goals: number[] = [];
  const start = unit.position;

  if (
    !unit.alive ||
    start === null ||
    !getCell(world.map, start) ||
    !getCell(world.map, target.position)
  ) {
    return { nodes, goals };
  }

  // При оценке будущей атакующей позиции тело самого актёра уже покинуло старт.
  const line: LineOptions = {
    ignoresBlocker: (blocker) =>
      (blocker.kind === "unit" && blocker.unit.id === unit.id) ||
      options.line?.ignoresBlocker?.(blocker) === true,
  };
  const key = (position: Position): number => position.y * world.map.width + position.x;
  const frontier = [key(start)];
  nodes.set(key(start), { position: { ...start }, distance: 0, predecessors: [] });
  let nearest: number | undefined;

  for (let index = 0; index < frontier.length; index += 1) {
    const currentKey = frontier[index]!;
    const current = nodes.get(currentKey)!;

    if (nearest !== undefined && current.distance > nearest) {
      break;
    }

    const reachable =
      target.kind === "attack"
        ? canReachMaskedCell(world, current.position, target.position, unit.attackMask, line)
        : canReachInteraction(
            world,
            current.position,
            target.position,
            target.interactionMask,
            line,
          );

    if (reachable) {
      nearest = current.distance;
      goals.push(currentKey);
      continue;
    }

    if (nearest !== undefined) {
      continue;
    }

    const actor = { ...unit, position: current.position };

    for (const destination of getStepDestinations(world, actor, options.movement)) {
      const destinationKey = key(destination);
      const previous = nodes.get(destinationKey);
      const distance = current.distance + 1;

      if (!previous) {
        nodes.set(destinationKey, { position: destination, distance, predecessors: [currentKey] });
        frontier.push(destinationKey);
      } else if (previous.distance === distance) {
        previous.predecessors.push(currentKey);
      }
    }
  }

  return { nodes, goals };
}

/** Оценка удалённой цели без расхода случайности и построения выбранного маршрута. */
export function getActionDistance(
  world: WorldState,
  unit: UnitState,
  target: ActionTarget,
  options: PathOptions = {},
): number | undefined {
  const { nodes, goals } = search(world, unit, target, options);
  const goal = goals[0];

  return goal === undefined ? undefined : nodes.get(goal)!.distance;
}

/** Выбор только среди кратчайших путей до допустимой позиции нужного действия. */
export function findActionPath(
  world: WorldState,
  unit: UnitState,
  target: ActionTarget,
  rng: Pick<SeededRng, "pick">,
  options: PathOptions = {},
): ActionPath | undefined {
  const { nodes, goals } = search(world, unit, target, options);

  if (goals.length === 0) {
    return undefined;
  }

  const goalKey = goals.length === 1 ? goals[0]! : rng.pick(goals)!;
  const goal = nodes.get(goalKey)!;
  const reversed: Position[] = [];
  let current = goal;

  while (current.predecessors.length > 0) {
    reversed.push({ ...current.position });
    const parents = current.predecessors;
    const parentKey = parents.length === 1 ? parents[0]! : rng.pick(parents)!;
    current = nodes.get(parentKey)!;
  }

  return {
    distance: goal.distance,
    destination: { ...goal.position },
    steps: reversed.reverse(),
  };
}
