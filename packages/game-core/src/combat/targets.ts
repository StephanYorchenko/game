import type { LineOptions } from "../geometry";
import { canAttackOpening } from "../openings";
import type { SeededRng } from "../random";
import { getCell } from "../world";
import type { Position, WorldState } from "../world";
import { checkUnitAttack } from "./eligibility";

export interface ImmediateAttackTarget {
  readonly kind: "unit" | "opening";
  readonly id: string;
  readonly position: Readonly<Position>;
  readonly manhattan: number;
}

export interface ImmediateAttackOptions {
  /** Для защитника список обязателен по смыслу: без него враги не становятся известными. */
  readonly knownEnemyIds?: readonly string[];
  readonly line?: LineOptions;
}

/** Стабильный набор: юниты в порядке world.units, затем проёмы по строкам карты. */
export function getImmediateAttackTargets(
  world: WorldState,
  attackerId: string,
  options: ImmediateAttackOptions = {},
): ImmediateAttackTarget[] {
  const attacker = world.units.find((unit) => unit.id === attackerId);

  if (!attacker?.alive || !attacker.position || !getCell(world.map, attacker.position)) {
    return [];
  }

  const from = attacker.position;
  const known = new Set(options.knownEnemyIds ?? []);
  const target = (
    kind: "unit" | "opening",
    id: string,
    position: Position,
  ): ImmediateAttackTarget => ({
    kind,
    id,
    position: { ...position },
    manhattan: Math.abs(position.x - from.x) + Math.abs(position.y - from.y),
  });
  const candidates = world.units.flatMap((unit) => {
    if (
      (attacker.side === "defender" && !known.has(unit.id)) ||
      !checkUnitAttack(world, attackerId, unit.id, options.line).allowed
    ) {
      return [];
    }

    return [target("unit", unit.id, unit.position!)];
  });

  if (attacker.side === "enemy") {
    for (const [index, cell] of world.map.cells.entries()) {
      const opening = cell.structure;

      if (
        (opening?.kind === "door" || opening?.kind === "window") &&
        canAttackOpening(world, attackerId, opening.id, options.line)
      ) {
        candidates.push(
          target("opening", opening.id, {
            x: index % world.map.width,
            y: Math.floor(index / world.map.width),
          }),
        );
      }
    }
  }

  return candidates;
}

/** Только уже доступные атаки. Расстояние маршрута и тип следующего действия не определяются. */
export function selectImmediateAttackTarget(
  world: WorldState,
  attackerId: string,
  rng: Pick<SeededRng, "pick">,
  options: ImmediateAttackOptions = {},
): ImmediateAttackTarget | undefined {
  const candidates = getImmediateAttackTargets(world, attackerId, options);

  if (candidates.length === 0) {
    return undefined;
  }

  // Любой набор с укреплением выбирается целиком: смешанный по №116,
  // только укрепления — по уточнению ENG-20 от 05.11.
  let eligible = candidates;

  if (!candidates.some((candidate) => candidate.kind === "opening")) {
    const nearest = Math.min(...candidates.map((candidate) => candidate.manhattan));
    eligible = candidates.filter((candidate) => candidate.manhattan === nearest);
  }

  return eligible.length === 1 ? eligible[0] : rng.pick(eligible);
}
