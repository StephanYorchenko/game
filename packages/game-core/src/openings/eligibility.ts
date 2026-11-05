import { canReachInteraction, canReachMaskedCell } from "../geometry";
import type { LineOptions } from "../geometry";
import type { Position, Structure, UnitState, WorldState } from "../world";

export type Opening = Extract<Structure, { kind: "door" | "window" }>;

export interface OpeningTarget {
  readonly opening: Opening;
  readonly position: Position;
}

export interface OpeningOptions {
  readonly line?: LineOptions;
  /** AI проверяет открытые пути и leadsToEnemy по актуальному миру (§5.5). */
  defenderCanOpen?(world: WorldState, unit: UnitState, target: OpeningTarget): boolean;
}

export type OpeningCheck =
  | { readonly allowed: true; readonly target: OpeningTarget }
  | {
      readonly allowed: false;
      readonly reason:
        | "actor_unavailable"
        | "opening_missing"
        | "not_closed"
        | "reinforced"
        | "defender_window"
        | "unreachable"
        | "defender_policy";
    };

export function findOpening(world: WorldState, openingId: string): OpeningTarget | undefined {
  const index = world.map.cells.findIndex((cell) => cell.structure?.id === openingId);
  const opening = world.map.cells[index]?.structure;

  if (opening?.kind !== "door" && opening?.kind !== "window") {
    return undefined;
  }

  return {
    opening,
    position: { x: index % world.map.width, y: Math.floor(index / world.map.width) },
  };
}

/** Проверка не меняет карту и не выбирает цель вместо AI. */
export function checkOpeningInteraction(
  world: WorldState,
  actorId: string,
  openingId: string,
  options: OpeningOptions = {},
): OpeningCheck {
  const unit = world.units.find((candidate) => candidate.id === actorId);

  if (!unit?.alive || unit.position === null) {
    return { allowed: false, reason: "actor_unavailable" };
  }

  const target = findOpening(world, openingId);

  if (!target) {
    return { allowed: false, reason: "opening_missing" };
  }

  if (target.opening.state !== "closed") {
    return { allowed: false, reason: "not_closed" };
  }

  if (target.opening.reinforcement !== null) {
    return { allowed: false, reason: "reinforced" };
  }

  if (unit.side === "defender" && target.opening.kind === "window") {
    return { allowed: false, reason: "defender_window" };
  }

  if (
    !canReachInteraction(
      world,
      unit.position,
      target.position,
      target.opening.interactionMask,
      options.line,
    )
  ) {
    return { allowed: false, reason: "unreachable" };
  }

  if (unit.side === "defender" && !options.defenderCanOpen?.(world, unit, target)) {
    return { allowed: false, reason: "defender_policy" };
  }

  return { allowed: true, target };
}

/** Базовая атака проёма доступна только врагу и только по закрытому укреплению. */
export function canAttackOpening(
  world: WorldState,
  actorId: string,
  openingId: string,
  line: LineOptions = {},
): boolean {
  const unit = world.units.find((candidate) => candidate.id === actorId);
  const target = findOpening(world, openingId);

  return Boolean(
    unit?.alive &&
      unit.side === "enemy" &&
      unit.position &&
      target &&
      target.opening.state === "closed" &&
      target.opening.reinforcement &&
      canReachMaskedCell(world, unit.position, target.position, unit.attackMask, line),
  );
}
