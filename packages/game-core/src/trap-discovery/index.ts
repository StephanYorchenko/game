import { getImmediateAttackTargets } from "../combat";
import { getEnemyRouteTargets } from "../enemy-targeting";
import type { PathOptions } from "../pathfinding";
import type { SeededRng } from "../random";
import type { WorldState } from "../world";

export interface TrapDiscoveryOutcome {
  readonly status: "discovered" | "failed";
  readonly enemyId: string;
  readonly trapId: string;
  readonly probability: number;
  readonly roll: number | null;
}

export type TrapDiscoveryResult =
  | TrapDiscoveryOutcome
  | {
      readonly status: "unavailable";
      readonly reason:
        | "actor_unavailable"
        | "trap_unavailable"
        | "known"
        | "attack_available"
        | "no_defender_route";
    };

/** Runtime-сервисы не входят в JSON мира; rng должен быть тем же seeded RNG симуляции. */
export interface TrapDiscoveryService {
  readonly rng: Pick<SeededRng, "nextFloat">;
  getOptions?(enemyId: string): PathOptions;
  /** Наблюдатель читает результат, но не меняет симуляцию. */
  onOutcome?(outcome: TrapDiscoveryOutcome): void;
}

/** Одна явно адресованная попытка; выбор кандидата и число вызовов задаёт способность. */
export function tryDiscoverTrap(
  world: WorldState,
  enemyId: string,
  trapId: string,
  probability: number,
  rng: Pick<SeededRng, "nextFloat">,
  options: PathOptions = {},
): TrapDiscoveryResult {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("Вероятность обнаружения должна лежать в [0, 1]");
  }

  const enemy = world.units.find((unit) => unit.id === enemyId);

  if (!enemy?.alive || enemy.side !== "enemy" || !enemy.position) {
    return { status: "unavailable", reason: "actor_unavailable" };
  }

  if (!world.traps.some((trap) => trap.id === trapId)) {
    return { status: "unavailable", reason: "trap_unavailable" };
  }

  if (enemy.knownTrapIds?.includes(trapId) || options.movement?.knownTrapIds?.includes(trapId)) {
    return { status: "unavailable", reason: "known" };
  }

  if (getImmediateAttackTargets(world, enemyId, options).some((target) => target.kind === "unit")) {
    return { status: "unavailable", reason: "attack_available" };
  }

  if (!getEnemyRouteTargets(world, enemyId, options).some((target) => target.kind === "unit")) {
    return { status: "unavailable", reason: "no_defender_route" };
  }

  const roll = probability === 0 || probability === 1 ? null : rng.nextFloat();

  if (roll !== null && (!Number.isFinite(roll) || roll < 0 || roll >= 1)) {
    throw new RangeError("RNG обнаружения должен вернуть значение в [0, 1)");
  }

  const discovered = probability === 1 || (roll !== null && roll < probability);

  if (discovered) {
    enemy.knownTrapIds = [...(enemy.knownTrapIds ?? []), trapId];
  }

  return { status: discovered ? "discovered" : "failed", enemyId, trapId, probability, roll };
}

/** Вызывать на границе ночи; погибшие также не сохраняют знание в следующую ночь. */
export function clearTrapKnowledge(world: WorldState): void {
  for (const unit of world.units) {
    delete unit.knownTrapIds;
  }
}
