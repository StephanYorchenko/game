import { getCell, getOccupant } from "./state.js";
import type { Position, UnitState, WorldState } from "./state.js";

const STEPS = [
  { direction: "north", x: 0, y: -1 },
  { direction: "east", x: 1, y: 0 },
  { direction: "south", x: 0, y: 1 },
  { direction: "west", x: -1, y: 0 },
] as const;

export type MovementDirection = (typeof STEPS)[number]["direction"];

/** Ограничения разрешает слой ключевых слов, а не имена классов внутри поиска пути. */
export interface MovementOptions {
  readonly knownTrapIds?: readonly string[];
  readonly directions?: readonly MovementDirection[];
  readonly allowWindows?: boolean;
}

/** Проходимость одной клетки; не определяет расстояние, бюджет или стоимость маршрута. */
export function canEnterCell(
  world: WorldState,
  unit: UnitState,
  destination: Position,
  options: MovementOptions = {},
): boolean {
  if (!unit.alive || unit.position === null) {
    return false;
  }

  const cell = getCell(world.map, destination);

  if (!cell || (unit.side === "defender" && cell.area !== "inside")) {
    return false;
  }

  const structure = cell.structure;

  if (structure?.kind === "wall") {
    return false;
  }

  if (structure?.kind === "obstacle" && structure.blocksMovement) {
    return false;
  }

  if (structure?.kind === "door" || structure?.kind === "window") {
    if (structure.state === "closed") {
      return false;
    }

    if (structure.kind === "window" && options.allowWindows === false) {
      return false;
    }
  }

  const occupant = getOccupant(world, destination);

  if (occupant?.kind === "unit") {
    return false;
  }

  if (occupant?.kind === "trap") {
    return unit.side === "enemy" && !options.knownTrapIds?.includes(occupant.id);
  }

  return true;
}

/** Та же проверка используется планировщиком и перед фактическим обычным шагом. */
export function canStep(
  world: WorldState,
  unit: UnitState,
  destination: Position,
  options: MovementOptions = {},
): boolean {
  const start = unit.position;

  if (start === null || !getCell(world.map, start)) {
    return false;
  }

  const step = STEPS.find(
    (candidate) =>
      candidate.x === destination.x - start.x && candidate.y === destination.y - start.y,
  );

  if (!step || (options.directions && !options.directions.includes(step.direction))) {
    return false;
  }

  return canEnterCell(world, unit, destination, options);
}

/** Стабильный порядок соседей: север, восток, юг, запад. Случайность здесь не расходуется. */
export function getStepDestinations(
  world: WorldState,
  unit: UnitState,
  options: MovementOptions = {},
): Position[] {
  const start = unit.position;

  if (start === null) {
    return [];
  }

  return STEPS.map((step) => ({ x: start.x + step.x, y: start.y + step.y })).filter((position) =>
    canStep(world, unit, position, options),
  );
}
