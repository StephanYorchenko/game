import { createDamageQueue } from "../damage";
import type { DamageEntry, DamageQueue, DamageState } from "../damage";
import type { OperationRuntime } from "../operations";
import { runUnitTurn } from "../turn";
import type { TurnAction, TurnHandlers, TurnResult } from "../turn";
import type { EventJournal } from "./index";

function hpSnapshot(runtime: OperationRuntime): Map<string, number> {
  const hp = new Map(runtime.world.units.map((unit) => [unit.id, unit.stats.hp]));

  for (const cell of runtime.world.map.cells) {
    const opening = cell.structure;

    if ((opening?.kind === "door" || opening?.kind === "window") && opening.reinforcement) {
      hp.set(opening.id, opening.reinforcement.hp);
    }
  }

  return hp;
}

function hpChanges(runtime: OperationRuntime, before: ReadonlyMap<string, number>) {
  return [...hpSnapshot(runtime)].flatMap(([id, after]) => {
    const previous = before.get(id);
    return previous !== undefined && previous !== after ? [{ id, before: previous, after }] : [];
  });
}

/** Наблюдение за каждой операцией, включая временное HP=0 внутри атомарного эффекта. */
export function createJournalRuntime(
  journal: EventJournal,
  runtime: OperationRuntime,
): OperationRuntime {
  let before = new Map<string, number>();

  return {
    ...runtime,
    observer: {
      before: (effect, operation) => {
        runtime.observer?.before?.(effect, operation);
        before = hpSnapshot(runtime);
      },
      after: (effect, operation, applied) => {
        journal.append("operation", {
          instanceId: effect.instanceId,
          definitionId: effect.definitionId,
          ownerId: effect.ownerId,
          phase: effect.phase,
          context: effect.context,
          operation,
          applied,
          reason: applied ? null : "operation_unavailable",
          hp: hpChanges(runtime, before),
        });
        runtime.observer?.after?.(effect, operation, applied);
      },
    },
  };
}

function describe(entry: DamageEntry) {
  if ("kind" in entry) {
    return entry;
  }

  return {
    kind: "effect",
    instanceId: entry.instanceId,
    definitionId: entry.definitionId,
    ownerId: entry.ownerId,
    phase: entry.phase,
    source: entry.source,
    context: entry.context,
  };
}

/** Та же очередь исполнения; запись исхода урона происходит до его последствий. */
export function createJournalDamageQueue(
  journal: EventJournal,
  runtime: OperationRuntime,
  damage: DamageState,
  getTurnOrder: () => string[],
): DamageQueue {
  let alive: string[] = [];
  const observed = createJournalRuntime(journal, runtime);
  return createDamageQueue(observed, damage, getTurnOrder, (outcome) => {
    journal.append("damage", outcome);
  }).observe({
    before: (entry) => {
      alive = runtime.world.units.filter((unit) => unit.alive).map((unit) => unit.id);
      journal.append("entry_start", describe(entry));
    },
    after: (entry) => {
      const deaths = runtime.world.units
        .filter((unit) => !unit.alive && alive.includes(unit.id))
        .map((unit) => unit.id);
      journal.append("entry_end", { entry: describe(entry), deaths });
    },
    skipped: (entry) => {
      journal.append("skipped", { entry: describe(entry), reason: "owner_unavailable" });
    },
  });
}

/** Фазовый/событийный журнал одного хода. Действие — JSON DTO с ID выбранных целей. */
export function runJournaledTurn<Action extends TurnAction>(
  journal: EventJournal,
  runtime: OperationRuntime,
  damage: DamageState,
  ownerId: string,
  getTurnOrder: () => string[],
  handlers: Omit<TurnHandlers<Action>, "createQueue">,
  location: { readonly round: number; readonly turn: number },
): TurnResult {
  const scope = { ...location, ownerId, slot: null, phase: null };
  journal.setScope(scope);
  const result = runUnitTurn(createJournalRuntime(journal, runtime), ownerId, getTurnOrder, {
    ...handlers,
    onPhase: (phase, slot) => {
      journal.setScope({ ...scope, slot, phase });
      journal.append("phase", { phase });
      handlers.onPhase?.(phase, slot);
    },
    chooseAction: (context) => {
      journal.setScope({ ...scope, slot: context.slot, phase: "action" });
      const action = handlers.chooseAction(context);
      journal.append("action", action);
      return action;
    },
    createQueue: () => createJournalDamageQueue(journal, runtime, damage, getTurnOrder),
  });

  if (result.actions.length === 0 && result.status !== "completed") {
    journal.append("skipped", { ownerId, reason: result.status });
  }

  journal.setScope({ ...scope, phase: "turn_result" });
  journal.append("turn_result", result);
  return result;
}
