import { createOperationQueue, schedulePhase } from "../operations";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import { getCell } from "../world";
import type { Position, WorldState } from "../world";

export interface CommittedDeath {
  readonly unitId: string;
  readonly cell: Readonly<Position>;
}

export interface DeathBatch {
  readonly deaths: readonly CommittedDeath[];
  readonly effects: readonly ExecutableEffect[];
}

/** Зафиксированная жизнь владельца, без подмены alive промежуточным HP. */
export function isOwnerAlive(world: WorldState, ownerId: string): boolean {
  const unit = world.units.find((candidate) => candidate.id === ownerId);

  if (unit) {
    return unit.alive;
  }

  if (world.traps.some((trap) => trap.id === ownerId)) {
    return true;
  }

  const structure = world.map.cells.find((cell) => cell.structure?.id === ownerId)?.structure;

  if (!structure) {
    return false;
  }

  return structure.kind !== "door" && structure.kind !== "window"
    ? true
    : structure.state !== "destroyed";
}

/** Вызывать только после целого эффекта либо отдельного независимого события. */
export function commitUnitDeaths(runtime: OperationRuntime, turnOrder: string[]): DeathBatch {
  const dying = runtime.world.units.filter((unit) => unit.alive && unit.stats.hp === 0);

  if (dying.length === 0) {
    return { deaths: [], effects: [] };
  }

  const ranks = new Map<string, number>();

  for (let index = 0; index < turnOrder.length; index += 1) {
    const id = turnOrder[index]!;

    if (ranks.has(id)) {
      throw new Error("Повторный ID в текущей очереди ходов");
    }

    ranks.set(id, index);
  }

  for (const unit of dying) {
    if (!ranks.has(unit.id)) {
      throw new Error(`Погибающий юнит ${unit.id} отсутствует в текущей очереди ходов`);
    }

    if (unit.position === null || !getCell(runtime.world.map, unit.position)) {
      throw new Error(`У погибающего юнита ${unit.id} нет допустимой клетки смерти`);
    }
  }

  dying.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
  const deaths = dying.map(
    (unit): CommittedDeath => ({
      unitId: unit.id,
      cell: { ...unit.position! },
    }),
  );

  // Сначала освобождаем все клетки этой партии; стеки не исполняются между смертями.
  for (const unit of dying) {
    unit.alive = false;
    unit.position = null;
  }

  const deadIds = new Set(deaths.map((death) => death.unitId));

  for (let index = turnOrder.length - 1; index >= 0; index -= 1) {
    if (deadIds.has(turnOrder[index]!)) {
      turnOrder.splice(index, 1);
    }
  }

  const effects = deaths.flatMap((death) =>
    schedulePhase(runtime.effects, death.unitId, "DEATH", {
      kind: "death",
      ownerId: death.unitId,
      cell: death.cell,
    }),
  );

  return { deaths, effects };
}

/** Getter читает актуальную очередь, включая перестановки и вставки призыва. */
export function createDeathQueue(runtime: OperationRuntime, getTurnOrder: () => string[]) {
  return createOperationQueue(runtime, {
    isOwnerAlive: (ownerId) => isOwnerAlive(runtime.world, ownerId),
    afterEffect: (context) => {
      context.emit(...commitUnitDeaths(runtime, getTurnOrder()).effects);
    },
  });
}
