import { commitUnitDeaths, isOwnerAlive } from "../death";
import { EntryQueue } from "../execution";
import { executeOperation, schedulePhase } from "../operations";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import { createPlacementHandler } from "../summoning";
import { getCell, getOccupant } from "../world";
import type { Position } from "../world";
import {
  addDamageModifier,
  consumeDamageModifiers,
  createDamageModifiers,
  registerDamageEvent,
} from "./modifiers";
import type { DamageModifiers } from "./modifiers";
export * from "./modifiers";

export interface CellDamageEvent {
  readonly kind: "CELL_DAMAGE";
  readonly id: string;
  readonly cell: Readonly<Position>;
  readonly amount: number;
}

export interface DamageState {
  readonly version: 1;
  nextEventId: number;
}

export interface DamageOutcome {
  readonly eventId: string;
  readonly cell: Readonly<Position>;
  readonly amount: number;
  readonly resolvedAmount: number;
  readonly targetId: string | null;
  readonly hpLoss: number;
  readonly hpBefore: number | null;
  readonly hpAfter: number | null;
}

export type DamageEntry = ExecutableEffect | CellDamageEvent;

export function createDamageState(): DamageState {
  return { version: 1, nextEventId: 1 };
}

function validateEvent(event: CellDamageEvent): void {
  if (
    event.kind !== "CELL_DAMAGE" ||
    typeof event.id !== "string" ||
    event.id.length === 0 ||
    !Number.isInteger(event.cell.x) ||
    !Number.isInteger(event.cell.y) ||
    !Number.isInteger(event.amount) ||
    event.amount < 0
  ) {
    throw new TypeError("CELL_DAMAGE требует ID, целую клетку и неотрицательный целый урон");
  }
}

export function createCellDamage(
  state: DamageState,
  cell: Readonly<Position>,
  amount: number,
  modifiers?: DamageModifiers,
): CellDamageEvent {
  if (state.version !== 1 || !Number.isSafeInteger(state.nextEventId) || state.nextEventId < 1) {
    throw new RangeError("Исчерпан или повреждён счётчик событий урона");
  }

  const event: CellDamageEvent = {
    kind: "CELL_DAMAGE",
    id: `damage:${state.nextEventId}`,
    cell: { ...cell },
    amount,
  };
  validateEvent(event);
  if (modifiers) {
    registerDamageEvent(modifiers, event.id);
  }
  state.nextEventId += 1;
  return event;
}

/** Полное разрешение независимого события, включая границу смерти. */
export function resolveCellDamage(
  runtime: OperationRuntime,
  event: CellDamageEvent,
  turnOrder: string[],
  modifiers?: DamageModifiers,
): { outcome: DamageOutcome; effects: readonly ExecutableEffect[] } {
  validateEvent(event);
  const amount = modifiers
    ? consumeDamageModifiers(modifiers, event.id, event.amount)
    : event.amount;
  const cell = getCell(runtime.world.map, event.cell);
  const occupant = getOccupant(runtime.world, event.cell);
  const opening = cell?.structure;
  const unit = occupant?.kind === "unit" && occupant.alive ? occupant : undefined;
  const reinforcement =
    !occupant &&
    (opening?.kind === "door" || opening?.kind === "window") &&
    opening.state === "closed"
      ? opening.reinforcement
      : null;
  const target = unit?.stats ?? reinforcement;
  let outcome: DamageOutcome = {
    eventId: event.id,
    cell: { ...event.cell },
    amount: event.amount,
    resolvedAmount: amount,
    targetId: null,
    hpLoss: 0,
    hpBefore: null,
    hpAfter: null,
  };
  const effects: ExecutableEffect[] = [];

  if (target) {
    const hpBefore = target.hp;
    const hpLoss = Math.max(0, amount - target.resistance);
    target.hp = Math.max(0, hpBefore - hpLoss);
    outcome = {
      ...outcome,
      targetId: unit ? unit.id : opening!.id,
      hpLoss,
      hpBefore,
      hpAfter: target.hp,
    };

    if (!unit && (opening?.kind === "door" || opening?.kind === "window") && target.hp === 0) {
      opening.state = "destroyed";
      effects.push(
        ...schedulePhase(runtime.effects, opening.id, "DEATH", {
          kind: "death",
          ownerId: opening.id,
          cell: event.cell,
        }),
      );
    }
  }

  effects.push(...commitUnitDeaths(runtime, turnOrder).effects);
  return { outcome, effects };
}

function isDamage(entry: DamageEntry): entry is CellDamageEvent {
  return "kind" in entry && entry.kind === "CELL_DAMAGE";
}

/** Одна очередь для способностей и CELL_DAMAGE; событие не имеет владельца. */
export function createDamageQueue(
  runtime: OperationRuntime,
  state: DamageState,
  getTurnOrder: () => string[],
  onDamage?: (outcome: DamageOutcome) => void,
  modifiers: DamageModifiers = createDamageModifiers(),
): EntryQueue<DamageEntry> {
  return new EntryQueue<DamageEntry>({
    copy: (entry) => {
      if (isDamage(entry)) {
        validateEvent(entry);
        registerDamageEvent(modifiers, entry.id);
        return { kind: "CELL_DAMAGE", id: entry.id, cell: { ...entry.cell }, amount: entry.amount };
      }

      return { ...entry, operations: [...entry.operations] };
    },
    canExecute: (entry) =>
      isDamage(entry) || entry.source === "death" || isOwnerAlive(runtime.world, entry.ownerId),
    execute: (entry, context) => {
      if (isDamage(entry)) {
        const resolution = resolveCellDamage(runtime, entry, getTurnOrder(), modifiers);
        context.emit(...resolution.effects);
        onDamage?.(resolution.outcome);
        return;
      }

      for (const operation of entry.operations) {
        executeOperation(runtime, entry, operation, {
          createDamageEvent: (cell, amount) =>
            context.emit(createCellDamage(state, cell, amount, modifiers)),
          placeEntity: createPlacementHandler(runtime, getTurnOrder, (...effects) =>
            context.emit(...effects),
          ),
          addDamageModifier: (eventId, modifier) => addDamageModifier(modifiers, eventId, modifier),
        });
      }

      context.emit(...commitUnitDeaths(runtime, getTurnOrder()).effects);
    },
  });
}
