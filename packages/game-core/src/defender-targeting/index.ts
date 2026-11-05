import { findActionPath, getActionDistance } from "../pathfinding";
import type { ActionPath, ActionTarget, PathOptions } from "../pathfinding";
import type { SeededRng } from "../random";
import { getCell } from "../world";
import type { UnitState, WorldState } from "../world";
import { cellPosition, potentialDoors } from "./potential";

export interface EnemyRoute {
  readonly targetId: string;
  readonly distance: number;
}

export interface DefenderDoor {
  readonly doorId: string;
  readonly leadsToEnemy: boolean;
  /** Открытый путь только до позиции взаимодействия, без оценки дороги за дверью. */
  readonly distance: number | null;
}

export interface DefenderAssessment {
  readonly status: "ready" | "actor_unavailable" | "no_known_enemies";
  readonly openEnemies: readonly EnemyRoute[];
  readonly doors: readonly DefenderDoor[];
}

function knownEnemies(world: WorldState, ids: readonly string[]): UnitState[] {
  const known = new Set(ids);
  return world.units.filter(
    (unit) =>
      unit.side === "enemy" &&
      unit.alive &&
      unit.position &&
      known.has(unit.id) &&
      getCell(world.map, unit.position)?.area === "inside",
  );
}

/** Чистый анализ: известные ID передаёт сценарий/AI; порядок списка ID не ранжирует цели. */
export function assessDefenderTargets(
  world: WorldState,
  defenderId: string,
  knownEnemyIds: readonly string[],
  options: PathOptions = {},
): DefenderAssessment {
  const unit = world.units.find((candidate) => candidate.id === defenderId);

  if (
    !unit?.alive ||
    unit.side !== "defender" ||
    !unit.position ||
    getCell(world.map, unit.position)?.area !== "inside"
  ) {
    return { status: "actor_unavailable", openEnemies: [], doors: [] };
  }

  const enemies = knownEnemies(world, knownEnemyIds);

  if (enemies.length === 0) {
    return { status: "no_known_enemies", openEnemies: [], doors: [] };
  }

  const openEnemies = enemies.flatMap((enemy) => {
    const distance = getActionDistance(
      world,
      unit,
      { kind: "attack", position: enemy.position! },
      options,
    );
    return distance === undefined ? [] : [{ targetId: enemy.id, distance }];
  });
  const useful =
    openEnemies.length === 0 ? potentialDoors(world, unit, enemies, options) : new Set<string>();
  const doors = world.map.cells.flatMap((cell, index) => {
    const door = cell.structure;

    if (
      cell.area !== "inside" ||
      door?.kind !== "door" ||
      door.state !== "closed" ||
      door.reinforcement !== null
    ) {
      return [];
    }

    const distance = useful.has(door.id)
      ? getActionDistance(
          world,
          unit,
          {
            kind: "interact",
            position: cellPosition(world, index),
            interactionMask: door.interactionMask,
          },
          options,
        )
      : undefined;
    return [{ doorId: door.id, leadsToEnemy: useful.has(door.id), distance: distance ?? null }];
  });

  return { status: "ready", openEnemies, doors };
}

/** Подходит как defenderCanOpen для домена openings; геометрию текущего INTERACT проверяет он. */
export function isDefenderDoorEligible(
  world: WorldState,
  defenderId: string,
  doorId: string,
  knownEnemyIds: readonly string[],
  options: PathOptions = {},
): boolean {
  return assessDefenderTargets(world, defenderId, knownEnemyIds, options).doors.some(
    (door) => door.doorId === doorId && door.leadsToEnemy,
  );
}

export type DefenderDestination =
  | { readonly kind: "enemy" | "door"; readonly targetId: string; readonly path: ActionPath }
  | {
      readonly kind: "none";
      readonly reason: "actor_unavailable" | "no_known_enemies" | "blocked";
    };

/** Случайность расходуется только на равные ближайшие цели и кратчайшие пути к выбранной. */
export function selectDefenderDestination(
  world: WorldState,
  defenderId: string,
  knownEnemyIds: readonly string[],
  rng: Pick<SeededRng, "pick">,
  options: PathOptions = {},
): DefenderDestination {
  const assessment = assessDefenderTargets(world, defenderId, knownEnemyIds, options);

  if (assessment.status !== "ready") {
    return { kind: "none", reason: assessment.status };
  }

  const kind = assessment.openEnemies.length > 0 ? "enemy" : "door";
  const candidates =
    kind === "enemy"
      ? assessment.openEnemies
      : assessment.doors.flatMap((door) =>
          door.leadsToEnemy && door.distance !== null
            ? [{ targetId: door.doorId, distance: door.distance }]
            : [],
        );
  const nearest = Math.min(...candidates.map((candidate) => candidate.distance));
  const tied = candidates.filter((candidate) => candidate.distance === nearest);

  if (tied.length === 0) {
    return { kind: "none", reason: "blocked" };
  }

  const selected = tied.length === 1 ? tied[0]! : rng.pick(tied)!;
  const unit = world.units.find((candidate) => candidate.id === defenderId)!;
  let target: ActionTarget;

  if (kind === "enemy") {
    target = {
      kind: "attack",
      position: world.units.find((enemy) => enemy.id === selected.targetId)!.position!,
    };
  } else {
    const index = world.map.cells.findIndex((cell) => cell.structure?.id === selected.targetId);
    const door = world.map.cells[index]!.structure!;

    if (door.kind !== "door") {
      throw new Error("Выбранная дверь отсутствует в текущей карте");
    }

    target = {
      kind: "interact",
      position: cellPosition(world, index),
      interactionMask: door.interactionMask,
    };
  }

  const path = findActionPath(world, unit, target, rng, options);
  return path ? { kind, targetId: selected.targetId, path } : { kind: "none", reason: "blocked" };
}
