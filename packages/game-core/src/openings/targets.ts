import { assessDefenderTargets } from "../defender-targeting";
import type { PathOptions } from "../pathfinding";
import type { SeededRng } from "../random";
import type { Position, WorldState } from "../world";
import { checkOpeningInteraction } from "./eligibility";

export interface InteractionTarget {
  readonly id: string;
  readonly kind: "door" | "window";
  readonly position: Readonly<Position>;
}

export interface InteractionOptions extends PathOptions {
  readonly knownEnemyIds?: readonly string[];
}

/** Из текущей клетки: без выбора дальнейшего противника или оценки расстояния за проёмом. */
export function getAvailableInteractions(
  world: WorldState,
  actorId: string,
  options: InteractionOptions = {},
): InteractionTarget[] {
  const actor = world.units.find((unit) => unit.id === actorId);

  if (!actor?.alive || !actor.position) {
    return [];
  }

  const trueDoors = new Set<string>();

  if (actor.side === "defender") {
    const assessment = assessDefenderTargets(world, actorId, options.knownEnemyIds ?? [], options);

    if (assessment.openEnemies.length > 0) {
      return [];
    }

    for (const door of assessment.doors) {
      if (door.leadsToEnemy) {
        trueDoors.add(door.doorId);
      }
    }
  }

  const targets: InteractionTarget[] = [];

  for (const [index, cell] of world.map.cells.entries()) {
    const opening = cell.structure;

    if (opening?.kind !== "door" && opening?.kind !== "window") {
      continue;
    }

    const check = checkOpeningInteraction(world, actorId, opening.id, {
      ...options,
      defenderCanOpen: (_world, _unit, target) => trueDoors.has(target.opening.id),
    });

    if (check.allowed) {
      targets.push({
        id: opening.id,
        kind: opening.kind,
        position: {
          x: index % world.map.width,
          y: Math.floor(index / world.map.width),
        },
      });
    }
  }

  return targets;
}

/** Все уже доступные кандидаты имеют равные шансы; единственный не расходует RNG. */
export function selectImmediateInteraction(
  world: WorldState,
  actorId: string,
  rng: Pick<SeededRng, "pick">,
  options: InteractionOptions = {},
): InteractionTarget | undefined {
  const candidates = getAvailableInteractions(world, actorId, options);

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates.length === 1 ? candidates[0] : rng.pick(candidates);
}
