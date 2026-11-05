/** Состояние симуляции содержит только JSON-данные, без объектов интерфейса. */
export interface Position {
  x: number;
  y: number;
}
export type MaskRow = [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1];
export type Mask5x5 = [MaskRow, MaskRow, MaskRow, MaskRow, MaskRow];

export interface Durability {
  hp: number;
  maxHP: number;
  resistance: number;
}
export interface UnitStats extends Durability {
  strength: number;
  agility: number;
  damage: number;
  movement: number;
}

export type Structure =
  | { readonly id: string; readonly kind: "wall" }
  | {
      readonly id: string;
      readonly kind: "obstacle";
      blocksMovement: boolean;
      blocksAttack: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "door" | "window";
      state: "open" | "closed" | "destroyed";
      reinforcement: Durability | null;
      interactionMask: Mask5x5;
    };

export interface Cell {
  surface: "floor" | "ground";
  area: "inside" | "outside";
  /** Проём сохраняется в слое карты даже тогда, когда по его клетке идёт юнит. */
  structure: Structure | null;
}

export interface GridMap {
  width: number;
  height: number;
  /** Плотный массив по строкам: cells[y * width + x]. */
  cells: Cell[];
}

export interface UnitState {
  readonly id: string;
  readonly kind: "unit";
  readonly definitionId: string;
  side: "defender" | "enemy";
  alive: boolean;
  /** Клетка погибшего освобождена; визуальный след смерти не занимает карту. */
  position: Position | null;
  stats: UnitStats;
  attackMask: Mask5x5;
  keywords: string[];
  /** Индивидуальное знание текущей ночи; не переносится другим владельцам. */
  knownTrapIds?: string[];
}

export interface TrapState {
  readonly id: string;
  readonly kind: "trap";
  readonly definitionId: string;
  position: Position;
}

export interface WorldState {
  readonly version: 1;
  map: GridMap;
  units: UnitState[];
  traps: TrapState[];
}

export function getCell(map: GridMap, position: Position): Cell | undefined {
  if (
    !Number.isInteger(position.x) ||
    !Number.isInteger(position.y) ||
    position.x < 0 ||
    position.y < 0 ||
    position.x >= map.width ||
    position.y >= map.height
  ) {
    return undefined;
  }

  return map.cells[position.y * map.width + position.x];
}

export function getOccupant(
  world: WorldState,
  position: Position,
): UnitState | TrapState | undefined {
  if (!getCell(world.map, position)) {
    return undefined;
  }

  return (
    world.units.find((unit) => unit.position?.x === position.x && unit.position.y === position.y) ??
    world.traps.find((trap) => trap.position.x === position.x && trap.position.y === position.y)
  );
}
