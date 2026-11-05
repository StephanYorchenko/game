import { createDeathQueue } from "../death";
import { schedulePhase } from "../operations";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import type { PhaseContext } from "../targets";
import type { Position, UnitState } from "../world";
import { createTurnControl } from "./control";
import type { ActiveTurnControl } from "./control";
export * from "./control";

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
  onPhase?(
    phase: "TURN_START" | "ACTION_START" | "ACTION_END" | "TURN_END",
    slot: 1 | 2 | null,
  ): void;
  chooseAction(context: ActionContext): Action;
  /** Каждый пакет разрешается полностью до запроса следующего пакета итератора. */
  executeAction(action: Action, context: ActionContext): Iterable<readonly ExecutableEffect[]>;
  /** Для подключения очереди с дополнительными независимыми событиями. */
  createQueue?(runtime: OperationRuntime): PhaseQueue;
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
  const result = (): TurnResult => {
    let status: TurnResult["status"] = "missing";

    if (unit) {
      status = unit.alive ? "completed" : "dead";
    }

    return { ownerId, status, actions };
  };

  if (!unit || !unit.alive) {
    return result();
  }

  const control = runtime.turnControl ?? createTurnControl();

  if (control.active) {
    throw new Error("Нельзя начать вложенный ход в том же runtime");
  }

  runtime = { ...runtime, turnControl: control };
  const active: ActiveTurnControl = {
    ownerId,
    stage: "TURN_START",
    slot: null,
    actionInterrupted: false,
    turnInterrupted: false,
  };
  control.active = active;

  try {
    const queue = handlers.createQueue?.(runtime) ?? createDeathQueue(runtime, getTurnOrder);
    const ordinary: PhaseContext = { kind: "phase", ownerId };
    const resolvePhase = (
      phase: "TURN_START" | "ACTION_START" | "ACTION_END" | "TURN_END",
      context: PhaseContext = ordinary,
    ): void => {
      active.stage = phase;
      handlers.onPhase?.(phase, active.slot);
      queue.enqueue(...schedulePhase(runtime.effects, ownerId, phase, context));
      queue.drain();
    };

    resolvePhase("TURN_START");

    for (const slot of [1, 2] as const) {
      if (!unit.alive) {
        return result();
      }

      if (active.turnInterrupted) {
        break;
      }

      active.slot = slot;
      active.actionInterrupted = false;
      resolvePhase("ACTION_START");

      if (!unit.alive) {
        return result();
      }

      let movementStart: Position | undefined;

      if (!active.actionInterrupted && !active.turnInterrupted) {
        const context: ActionContext = { runtime, unit, slot };
        const action = handlers.chooseAction(context);
        movementStart = action.kind === "MOVE" && unit.position ? { ...unit.position } : undefined;
        actions.push({ slot, kind: action.kind });
        active.stage = "action";

        for (const effects of handlers.executeAction(action, context)) {
          queue.enqueue(...effects);
          queue.drain();

          if (!unit.alive || active.actionInterrupted || active.turnInterrupted) {
            break;
          }
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
      active.slot = null;
      resolvePhase("TURN_END");
    }

    return result();
  } finally {
    control.active = null;
  }
}
