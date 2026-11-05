import { canReachMaskedCell } from "../geometry";
import type { LineOptions } from "../geometry";
import { getCell } from "../world";
import type { WorldState } from "../world";

export type AttackCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "attacker_unavailable"
        | "defender_unavailable"
        | "same_side"
        | "outside_attack"
        | "outside_target"
        | "unreachable";
    };

/** Допустимость одной обычной атаки; выбор цели и известность задаёт вызывающий AI. */
export function checkUnitAttack(
  world: WorldState,
  attackerId: string,
  defenderId: string,
  line: LineOptions = {},
): AttackCheck {
  const attacker = world.units.find((unit) => unit.id === attackerId);
  const defender = world.units.find((unit) => unit.id === defenderId);

  if (!attacker?.alive || !attacker.position || !getCell(world.map, attacker.position)) {
    return { allowed: false, reason: "attacker_unavailable" };
  }

  if (!defender?.alive || !defender.position || !getCell(world.map, defender.position)) {
    return { allowed: false, reason: "defender_unavailable" };
  }

  if (attacker.side === defender.side) {
    return { allowed: false, reason: "same_side" };
  }

  if (getCell(world.map, attacker.position)!.area !== "inside") {
    return { allowed: false, reason: "outside_attack" };
  }

  if (attacker.side === "defender" && getCell(world.map, defender.position)!.area !== "inside") {
    return { allowed: false, reason: "outside_target" };
  }

  if (!canReachMaskedCell(world, attacker.position, defender.position, attacker.attackMask, line)) {
    return { allowed: false, reason: "unreachable" };
  }

  return { allowed: true };
}
