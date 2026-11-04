import { addEffect } from "../effects";
import { schedulePhase } from "../operations";
import type { EffectTemplate, ExecutableEffect, OperationRuntime } from "../operations";
import { getCell, getOccupant, loadWorld } from "../world";
import type { Mask5x5, Position, TrapState, UnitState, UnitStats } from "../world";

export type EntityTemplate = {
  readonly definitionId: string;
  readonly effects: EffectTemplate[];
} & (
  | {
      readonly kind: "unit";
      readonly side: "defender" | "enemy";
      readonly stats: { [Key in keyof UnitStats]: UnitStats[Key] };
      readonly attackMask: Mask5x5;
      readonly keywords: string[];
    }
  | { readonly kind: "trap" }
);

export interface SummoningState {
  readonly version: 1;
  nextEntityId: number;
}

export type PlacementResult =
  | {
      readonly placed: true;
      readonly entity: UnitState | TrapState;
      readonly effects: readonly ExecutableEffect[];
    }
  | {
      readonly placed: false;
      readonly reason: "invalid_cell" | "occupied" | "blocked" | "outside";
    };

export function createSummoningState(): SummoningState {
  return { version: 1, nextEntityId: 1 };
}

/** Размещение происходит сейчас; SUMMON-эффекты возвращаются в очередь как последствия. */
export function placeEntity(
  runtime: OperationRuntime,
  state: SummoningState,
  turnOrder: string[],
  position: Readonly<Position>,
  template: EntityTemplate,
): PlacementResult {
  const { world } = runtime;
  const cell = getCell(world.map, position);

  if (!cell) {
    return { placed: false, reason: "invalid_cell" };
  }

  if (getOccupant(world, position)) {
    return { placed: false, reason: "occupied" };
  }

  const structure = cell.structure;

  if (
    structure?.kind === "wall" ||
    (structure?.kind === "obstacle" && structure.blocksMovement) ||
    ((structure?.kind === "door" || structure?.kind === "window") && structure.state === "closed")
  ) {
    return { placed: false, reason: "blocked" };
  }

  if (template.kind === "unit" && template.side === "defender" && cell.area !== "inside") {
    return { placed: false, reason: "outside" };
  }

  if (state.version !== 1 || !Number.isSafeInteger(state.nextEntityId) || state.nextEntityId < 1) {
    throw new RangeError("Исчерпан или повреждён счётчик призыва");
  }

  const ids = new Set([
    ...world.units.map((unit) => unit.id),
    ...world.traps.map((trap) => trap.id),
    ...world.map.cells.flatMap((entry) => (entry.structure ? [entry.structure.id] : [])),
    ...turnOrder,
    ...runtime.effects.instances.map((effect) => effect.ownerId),
  ]);
  let next = state.nextEntityId;

  while (ids.has(`entity:${next}`)) {
    next += 1;
  }

  if (!Number.isSafeInteger(next + 1)) {
    throw new RangeError("Исчерпан счётчик призыва");
  }

  const id = `entity:${next}`;
  const at = { ...position };
  const candidate =
    template.kind === "unit"
      ? {
          id,
          kind: "unit",
          definitionId: template.definitionId,
          side: template.side,
          alive: true,
          position: at,
          stats: template.stats,
          attackMask: template.attackMask,
          keywords: template.keywords,
        }
      : { id, kind: "trap", definitionId: template.definitionId, position: at };
  const validated = loadWorld({
    ...world,
    units: template.kind === "unit" ? [...world.units, candidate] : world.units,
    traps: template.kind === "trap" ? [...world.traps, candidate] : world.traps,
  });
  const entity = template.kind === "unit" ? validated.units.at(-1)! : validated.traps.at(-1)!;
  const effects = { ...runtime.effects, instances: [...runtime.effects.instances] };

  for (const effect of template.effects) {
    addEffect(effects, { ...effect, ownerId: id });
  }

  const scheduled = schedulePhase(effects, id, "SUMMON", { kind: "phase", ownerId: id });

  if (entity.kind === "unit") {
    world.units.push(entity);
    turnOrder.push(id);
  } else {
    world.traps.push(entity);
  }

  state.nextEntityId = next + 1;
  runtime.effects.nextInstanceId = effects.nextInstanceId;
  runtime.effects.instances.push(...effects.instances.slice(runtime.effects.instances.length));
  return { placed: true, entity, effects: scheduled };
}

/** Общая привязка операции к очередям эффектов и CELL_DAMAGE. */
export function createPlacementHandler(
  runtime: OperationRuntime,
  getTurnOrder: () => string[],
  emit: (...effects: readonly ExecutableEffect[]) => void,
): (cell: Readonly<Position>, template: EntityTemplate) => boolean {
  return (cell, template) => {
    if (!runtime.summoning) {
      throw new Error("Для призыва нужен сохраняемый SummoningState в runtime");
    }

    const result = placeEntity(runtime, runtime.summoning, getTurnOrder(), cell, template);

    if (result.placed) {
      emit(...result.effects);
    }

    return result.placed;
  };
}
