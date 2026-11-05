import type { CellDamageEvent, DamageQueue } from "../damage";
import { isOwnerAlive } from "../death";
import { schedulePhase } from "../operations";
import type { OperationRuntime } from "../operations";
import type { PhaseContext } from "../targets";
import type { Position } from "../world";

export type AttackQueue = Pick<DamageQueue, "size" | "enqueue" | "drain" | "createDamageEvent">;

/** Общий порядок для юнита и укрепления; урон не принадлежит владельцу атаки. */
export function resolveAttackPhases(
  runtime: OperationRuntime,
  queue: AttackQueue,
  attack: {
    readonly attackerId: string;
    readonly defenderId: string;
    readonly cell: Readonly<Position>;
    readonly success: boolean;
    readonly event: CellDamageEvent | null;
  },
): void {
  const { attackerId, defenderId, cell, success, event } = attack;
  const context = (ownerId: string): PhaseContext => ({
    kind: "attack",
    ownerId,
    attackerId,
    defenderId,
    cell,
    ...(event ? { damageEventId: event.id } : {}),
  });

  queue.enqueue(
    ...schedulePhase(
      runtime.effects,
      attackerId,
      success ? "ATTACK_SUCCESS" : "ATTACK_FAILURE",
      context(attackerId),
    ),
  );
  queue.drain();

  if (isOwnerAlive(runtime.world, defenderId)) {
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
}
