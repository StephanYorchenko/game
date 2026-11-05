import type { Position } from "../world";
import type { MovementOptions } from "./eligibility";

export interface MoveTarget {
  kind: "unit" | "opening";
  id: string;
}

export interface PendingMoveStep {
  readonly number: number;
  readonly from: Position;
  readonly cell: Position;
  readonly rules: MovementOptions;
  status: "pending" | "applied" | "invalidated";
}

export interface MoveProgress {
  readonly id: string;
  readonly actorId: string;
  /** Смену цели задаёт вызывающий слой явно; автоматический retarget пока OPEN. */
  target: MoveTarget | null;
  stepsTaken: number;
  stepsIssued: number;
  pending: PendingMoveStep | null;
}

/** JSON-состояние подтверждений шагов; не выводим их число из конечной позиции юнита. */
export interface MoveState {
  readonly version: 1;
  nextMoveId: number;
  active: MoveProgress[];
}

export function createMoveState(): MoveState {
  return { version: 1, nextMoveId: 1, active: [] };
}
