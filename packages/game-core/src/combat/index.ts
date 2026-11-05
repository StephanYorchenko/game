import type { DamageQueue } from "../damage";
import { canReachMaskedCell } from "../geometry";
import type { LineOptions } from "../geometry";
import { schedulePhase } from "../operations";
import type { OperationRuntime } from "../operations";
import type { SeededRng } from "../random";
import type { PhaseContext } from "../targets";
import { getCell } from "../world";
import type { Position, WorldState } from "../world";

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

export interface UnitAttackOutcome {
  readonly status: "resolved";
  readonly attackerId: string;
  readonly defenderId: string;
  readonly cell: Readonly<Position>;
  readonly attackRoll: number;
  readonly defenseRoll: number;
  readonly strength: number;
  readonly agility: number;
  readonly success: boolean;
  readonly damageEventId: string | null;
}

export type UnitAttackResult =
  | UnitAttackOutcome
  | {
      readonly status: "unavailable";
      readonly attackerId: string;
      readonly defenderId: string;
      readonly reason: Extract<AttackCheck, { allowed: false }>["reason"];
    };

export interface AttackOptions {
  readonly line?: LineOptions;
  /** Диагностика исхода до эффектов; наблюдатель не меняет симуляцию. */
  onOutcome?(outcome: UnitAttackOutcome): void;
}

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

function rollD6(rng: Pick<SeededRng, "d6">): number {
  const value = rng.d6();

  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new RangeError("Боевой бросок должен быть целым числом от 1 до 6");
  }

  return value;
}

/** Вызывать между разрешёнными пакетами текущей очереди, не внутри эффекта. */
export function resolveUnitAttack(
  runtime: OperationRuntime,
  queue: Pick<DamageQueue, "size" | "enqueue" | "drain" | "createDamageEvent">,
  attackerId: string,
  defenderId: string,
  rng: Pick<SeededRng, "d6">,
  options: AttackOptions = {},
): UnitAttackResult {
  if (queue.size !== 0) {
    throw new Error("До начала атаки предыдущий пакет очереди должен быть разрешён");
  }

  const check = checkUnitAttack(runtime.world, attackerId, defenderId, options.line);

  if (!check.allowed) {
    return { status: "unavailable", attackerId, defenderId, reason: check.reason };
  }

  const attacker = runtime.world.units.find((unit) => unit.id === attackerId)!;
  const defender = runtime.world.units.find((unit) => unit.id === defenderId)!;
  const cell = { ...defender.position! };
  const strength = attacker.stats.strength;
  const agility = defender.stats.agility;
  const damage = attacker.stats.damage;
  const attackRoll = rollD6(rng);
  const defenseRoll = rollD6(rng);
  const attackScore = BigInt(attackRoll) + BigInt(strength);
  const defenseScore = BigInt(defenseRoll) + BigInt(agility);
  const success = attackScore > defenseScore;
  const event = success ? queue.createDamageEvent(cell, damage) : null;
  const outcome: UnitAttackOutcome = {
    status: "resolved",
    attackerId,
    defenderId,
    cell: { ...cell },
    attackRoll,
    defenseRoll,
    strength,
    agility,
    success,
    damageEventId: event?.id ?? null,
  };
  const context = (ownerId: string): PhaseContext => ({
    kind: "attack",
    ownerId,
    attackerId,
    defenderId,
    cell,
    ...(event ? { damageEventId: event.id } : {}),
  });
  options.onOutcome?.(outcome);

  queue.enqueue(
    ...schedulePhase(
      runtime.effects,
      attackerId,
      success ? "ATTACK_SUCCESS" : "ATTACK_FAILURE",
      context(attackerId),
    ),
  );
  queue.drain();

  if (defender.alive) {
    queue.enqueue(
      ...schedulePhase(
        runtime.effects,
        defenderId,
        success ? "DEFENSE_FAILURE" : "DEFENSE_SUCCESS",
        context(defenderId),
      ),
    );
    queue.drain();
  }

  if (event) {
    queue.enqueue(event);
    queue.drain();
  }

  return outcome;
}
