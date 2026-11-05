import { schedulePhase } from "../operations";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import type { Position, TrapState, WorldState } from "../world";

/** Удаление — часть атомарного шага; DEATH исполняет очередь после всего эффекта. */
export function removeTrapAt(world: WorldState, cell: Readonly<Position>): TrapState | undefined {
  const index = world.traps.findIndex(
    (trap) => trap.position.x === cell.x && trap.position.y === cell.y,
  );

  return index === -1 ? undefined : world.traps.splice(index, 1)[0];
}
/** Снимки DEATH берутся после всех операций родителя, включая снятие эффектов. */
export function scheduleTrapDeaths(
  runtime: OperationRuntime,
  traps: readonly TrapState[],
): ExecutableEffect[] {
  return traps.flatMap((trap) =>
    schedulePhase(runtime.effects, trap.id, "DEATH", {
      kind: "death",
      ownerId: trap.id,
      cell: trap.position,
    }),
  );
}
