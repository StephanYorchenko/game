import { createDeathQueue } from "../death";
import { schedulePhase } from "../operations";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import type { PhaseContext } from "../targets";
import type { UnitState } from "../world";

export type ActionKind = "ATTACK" | "INTERACT" | "MOVE";
export interface TurnAction {
  readonly kind: ActionKind;
}

export interface PhaseQueue {
  enqueue(...effects: readonly ExecutableEffect[]): void;
  drain(): void;
}

export interface ActionContext {
  readonly runtime: OperationRuntime;
  readonly unit: UnitState;
  readonly slot: 1 | 2;
}

export interface TurnHandlers<Action extends TurnAction> {
  chooseAction(context: ActionContext): Action;
  /** Каждый пакет разрешается полностью до запроса следующего пакета итератора. */
  executeAction(action: Action, context: ActionContext): Iterable<readonly ExecutableEffect[]>;
  /** Для подключения очереди с дополнительными независимыми событиями. */
  createQueue?(): PhaseQueue;
}

export interface TurnResult {
  readonly ownerId: string;
  readonly status: "completed" | "dead" | "missing";
  readonly actions: readonly { readonly slot: 1 | 2; readonly kind: ActionKind }[];
}

/** Один ход: фазовые эффекты не занимают два стандартных слота действия. */
export function runUnitTurn<Action extends TurnAction>(
  runtime: OperationRuntime,
  ownerId: string,
  getTurnOrder: () => string[],
  handlers: TurnHandlers<Action>,
): TurnResult {
  const unit = runtime.world.units.find((candidate) => candidate.id === ownerId);
  const actions: { slot: 1 | 2; kind: ActionKind }[] = [];
  const result = (): TurnResult => ({
    ownerId,
    status: !unit ? "missing" : unit.alive ? "completed" : "dead",
    actions,
  });

  if (!unit || !unit.alive) {
    return result();
  }

  const queue = handlers.createQueue?.() ?? createDeathQueue(runtime, getTurnOrder);
  const ordinary: PhaseContext = { kind: "phase", ownerId };
  const resolvePhase = (
    phase: "TURN_START" | "ACTION_START" | "ACTION_END" | "TURN_END",
    context: PhaseContext = ordinary,
  ): void => {
    queue.enqueue(...schedulePhase(runtime.effects, ownerId, phase, context));
    queue.drain();
  };

  resolvePhase("TURN_START");

  for (const slot of [1, 2] as const) {
    if (!unit.alive) {
      return result();
    }

    resolvePhase("ACTION_START");

    if (!unit.alive) {
      return result();
    }

    const context: ActionContext = { runtime, unit, slot };
    const action = handlers.chooseAction(context);
    const movementStart =
      action.kind === "MOVE" && unit.position ? { ...unit.position } : undefined;
    actions.push({ slot, kind: action.kind });

    for (const effects of handlers.executeAction(action, context)) {
      queue.enqueue(...effects);
      queue.drain();

      if (!unit.alive) {
        break;
      }
    }

    if (!unit.alive) {
      return result();
    }

    resolvePhase(
      "ACTION_END",
      movementStart ? { kind: "move_end", ownerId, cell: movementStart } : ordinary,
    );
  }

  if (unit.alive) {
    resolvePhase("TURN_END");
  }

  return result();
}
