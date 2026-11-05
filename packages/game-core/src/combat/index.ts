import { checkUnitAttack } from "./eligibility";
import type { AttackCheck } from "./eligibility";
import type { LineOptions } from "../geometry";
import { canAttackOpening, findOpening } from "../openings";
import type { OperationRuntime } from "../operations";
import type { SeededRng } from "../random";
import type { Position } from "../world";
import { resolveAttackPhases } from "./phases";
import type { AttackQueue } from "./phases";

export { checkUnitAttack } from "./eligibility";
export type { AttackCheck } from "./eligibility";
export { getImmediateAttackTargets, selectImmediateAttackTarget } from "./targets";
export type { ImmediateAttackTarget, ImmediateAttackOptions } from "./targets";
export type { AttackQueue } from "./phases";

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
  queue: AttackQueue,
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
  options.onOutcome?.(outcome);
  resolveAttackPhases(runtime, queue, { attackerId, defenderId, cell, success, event });

  return outcome;
}

export interface OpeningAttackOutcome {
  readonly status: "resolved";
  readonly attackerId: string;
  readonly defenderId: string;
  readonly cell: Readonly<Position>;
  readonly success: true;
  readonly damageEventId: string;
}

export type OpeningAttackResult =
  | OpeningAttackOutcome
  | {
      readonly status: "unavailable";
      readonly attackerId: string;
      readonly defenderId: string;
      readonly reason: "opening_unavailable";
    };

export interface OpeningAttackOptions {
  readonly line?: LineOptions;
  onOutcome?(outcome: OpeningAttackOutcome): void;
}

/** Гарантированная атака закрытого укрепления: обычная маска, без бросков попадания. */
export function resolveOpeningAttack(
  runtime: OperationRuntime,
  queue: AttackQueue,
  attackerId: string,
  openingId: string,
  options: OpeningAttackOptions = {},
): OpeningAttackResult {
  if (queue.size !== 0) {
    throw new Error("До начала атаки предыдущий пакет очереди должен быть разрешён");
  }

  if (!canAttackOpening(runtime.world, attackerId, openingId, options.line)) {
    return {
      status: "unavailable",
      attackerId,
      defenderId: openingId,
      reason: "opening_unavailable",
    };
  }

  const attacker = runtime.world.units.find((unit) => unit.id === attackerId)!;
  const { position } = findOpening(runtime.world, openingId)!;
  const event = queue.createDamageEvent(position, attacker.stats.damage);
  const outcome: OpeningAttackOutcome = {
    status: "resolved",
    attackerId,
    defenderId: openingId,
    cell: { ...position },
    success: true,
    damageEventId: event.id,
  };
  options.onOutcome?.(outcome);
  resolveAttackPhases(runtime, queue, {
    attackerId,
    defenderId: openingId,
    cell: position,
    success: true,
    event,
  });
  return outcome;
}
