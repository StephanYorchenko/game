import { removeTrapAt } from "../traps";
import type { Position, TrapState, WorldState } from "../world";
import { canEnterCell, canStep } from "./eligibility";
import type { MoveState } from "./state";

export interface UnitMoveOutcome {
  readonly moved: boolean;
  readonly trap?: TrapState;
}

/** Вызывается только операцией общей очереди; повторное исполнение не удваивает шаг. */
export function applyMoveStep(
  world: WorldState,
  state: MoveState,
  moveId: string,
  stepNumber: number,
  ownerId: string,
  cell: Readonly<Position>,
): UnitMoveOutcome {
  const move = state.active.find((action) => action.id === moveId);
  const step = move?.pending;

  if (
    !move ||
    !step ||
    move.actorId !== ownerId ||
    step.number !== stepNumber ||
    step.status !== "pending" ||
    step.cell.x !== cell.x ||
    step.cell.y !== cell.y
  ) {
    return { moved: false };
  }

  const trap = removeTrapAt(world, step.cell);
  const unit = world.units.find((actor) => actor.id === ownerId);

  if (
    !unit?.position ||
    unit.position.x !== step.from.x ||
    unit.position.y !== step.from.y ||
    move.stepsTaken >= unit.stats.movement ||
    !canStep(world, unit, step.cell, step.rules)
  ) {
    step.status = "invalidated";
    return { moved: false, ...(trap ? { trap } : {}) };
  }

  unit.position = { ...step.cell };
  step.status = "applied";
  move.stepsTaken += 1;
  return { moved: true, ...(trap ? { trap } : {}) };
}

/** Принудительный перенос не использует бюджет, ортогональность и направления обычного MOVE. */
export function relocateUnit(
  world: WorldState,
  unitId: string,
  cell: Readonly<Position>,
): UnitMoveOutcome {
  const unit = world.units.find((actor) => actor.id === unitId);

  if (!unit?.alive || !unit.position) {
    return { moved: false };
  }

  const trap = removeTrapAt(world, cell);
  const moved = canEnterCell(world, unit, cell);

  if (moved) {
    unit.position = { ...cell };
  }

  return { moved, ...(trap ? { trap } : {}) };
}
