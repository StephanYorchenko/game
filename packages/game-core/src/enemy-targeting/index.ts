import { findOpening } from "../openings";
import { findActionPath, getActionDistance } from "../pathfinding";
import type { ActionPath, ActionTarget, PathOptions } from "../pathfinding";
import type { SeededRng } from "../random";
import { getCell } from "../world";
import type { Position, WorldState } from "../world";

export interface EnemyRouteTarget {
  readonly kind: "unit" | "opening";
  readonly id: string;
  readonly action: "ATTACK" | "INTERACT";
  readonly position: Readonly<Position>;
  readonly distance: number;
}

export interface EnemyDestination {
  readonly target: EnemyRouteTarget;
  readonly path: ActionPath;
}

type Candidate = Omit<EnemyRouteTarget, "distance">;

function actionTarget(world: WorldState, candidate: Candidate): ActionTarget {
  if (candidate.action === "ATTACK") {
    return {
      kind: "attack",
      position: { ...candidate.position },
      ...(candidate.kind === "unit" ? { actorArea: "inside" as const } : {}),
    };
  }

  const opening = findOpening(world, candidate.id);

  if (!opening) {
    throw new Error("Проём выбранной цели маршрута отсутствует");
  }

  return {
    kind: "interact",
    position: { ...candidate.position },
    interactionMask: opening.opening.interactionMask,
  };
}

/** Все достижимые цели: юниты в порядке мира, затем закрытые проёмы по строкам. */
export function getEnemyRouteTargets(
  world: WorldState,
  enemyId: string,
  options: PathOptions = {},
): EnemyRouteTarget[] {
  const actor = world.units.find((unit) => unit.id === enemyId);

  if (
    !actor?.alive ||
    actor.side !== "enemy" ||
    !actor.position ||
    !getCell(world.map, actor.position)
  ) {
    return [];
  }

  const candidates: Candidate[] = world.units.flatMap((unit) =>
    unit.alive &&
    unit.side === "defender" &&
    unit.position &&
    getCell(world.map, unit.position)?.area === "inside"
      ? [
          {
            kind: "unit",
            id: unit.id,
            action: "ATTACK",
            position: { ...unit.position },
          },
        ]
      : [],
  );

  for (const [index, cell] of world.map.cells.entries()) {
    const opening = cell.structure;

    if ((opening?.kind === "door" || opening?.kind === "window") && opening.state === "closed") {
      candidates.push({
        kind: "opening",
        id: opening.id,
        action: opening.reinforcement ? "ATTACK" : "INTERACT",
        position: { x: index % world.map.width, y: Math.floor(index / world.map.width) },
      });
    }
  }

  return candidates.flatMap((candidate) => {
    const distance = getActionDistance(world, actor, actionTarget(world, candidate), options);
    return distance === undefined ? [] : [{ ...candidate, distance }];
  });
}

/** Минимум шагов до действия; равные ближайшие цели всех типов имеют равные шансы. */
export function selectEnemyDestination(
  world: WorldState,
  enemyId: string,
  rng: Pick<SeededRng, "pick">,
  options: PathOptions = {},
): EnemyDestination | undefined {
  const candidates = getEnemyRouteTargets(world, enemyId, options);

  if (candidates.length === 0) {
    return undefined;
  }

  const nearest = Math.min(...candidates.map((candidate) => candidate.distance));
  const tied = candidates.filter((candidate) => candidate.distance === nearest);
  const target = tied.length === 1 ? tied[0]! : rng.pick(tied)!;
  const actor = world.units.find((unit) => unit.id === enemyId)!;
  const path = findActionPath(world, actor, actionTarget(world, target), rng, options);
  return path ? { target, path } : undefined;
}
