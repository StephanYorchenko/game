import { getOccupant } from "../world";
import type { Position, WorldState } from "../world";
import { canStep } from "./eligibility";
import type { MoveState } from "./state";

/** Вызывается только операцией общей очереди; повторное исполнение не удваивает шаг. */
export function applyMoveStep(
  world: WorldState,
  state: MoveState,
  moveId: string,
  stepNumber: number,
  ownerId: string,
  cell: Readonly<Position>,
): boolean {
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
    return false;
  }

  const unit = world.units.find((actor) => actor.id === ownerId);

  if (
    !unit?.position ||
    unit.position.x !== step.from.x ||
    unit.position.y !== step.from.y ||
    move.stepsTaken >= unit.stats.movement ||
    !canStep(world, unit, step.cell, step.rules)
  ) {
    step.status = "invalidated";
    return false;
  }

  // Удаление ловушки и её DEATH подключаются отдельной задачей ENG-25.
  if (getOccupant(world, step.cell)?.kind === "trap") {
    step.status = "blocked";
    return false;
  }

  unit.position = { ...step.cell };
  step.status = "applied";
  move.stepsTaken += 1;
  return true;
}
