import { getCell } from "./state.js";
import type {
  Cell,
  Durability,
  GridMap,
  Mask5x5,
  Position,
  Structure,
  TrapState,
  UnitState,
  UnitStats,
  WorldState,
} from "./state.js";

export class ScenarioValidationError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ScenarioValidationError";
  }
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new ScenarioValidationError(path, "ожидается обычный объект");
  }

  const object = value as Record<string, unknown>;

  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) {
      throw new ScenarioValidationError(`${path}.${key}`, "неизвестное поле");
    }
  }

  return object;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ScenarioValidationError(path, "ожидается массив");
  }

  // Array.map пропускает дыры; разреженные массивы нельзя принимать как плотные данные карты.
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) {
      throw new ScenarioValidationError(`${path}[${i}]`, "отсутствует элемент");
    }
  }

  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScenarioValidationError(path, "ожидается непустая строка");
  }

  return value;
}

function integer(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ScenarioValidationError(path, `ожидается целое число не меньше ${min}`);
  }

  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ScenarioValidationError(path, "ожидается boolean");
  }

  return value;
}

function choice<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new ScenarioValidationError(path, `ожидается одно из: ${choices.join(", ")}`);
  }

  return value as T;
}

function mask(value: unknown, path: string): Mask5x5 {
  const rows = array(value, path);

  if (rows.length !== 5) {
    throw new ScenarioValidationError(path, "матрица должна содержать 5 строк");
  }

  return rows.map((value, y) => {
    const row = array(value, `${path}[${y}]`);

    if (row.length !== 5) {
      throw new ScenarioValidationError(`${path}[${y}]`, "строка должна содержать 5 клеток");
    }

    return row.map((bit, x) => {
      if (bit !== 0 && bit !== 1) {
        throw new ScenarioValidationError(`${path}[${y}][${x}]`, "ожидается 0 или 1");
      }

      return bit;
    });
  }) as Mask5x5;
}

function durability(value: unknown, path: string, unit = false): Durability | UnitStats {
  const keys = [
    "hp",
    "maxHP",
    "resistance",
    ...(unit ? ["strength", "agility", "damage", "movement"] : []),
  ];
  const object = record(value, path, keys);
  const hp = integer(object.hp, `${path}.hp`);
  const maxHP = integer(object.maxHP, `${path}.maxHP`, 1);

  if (hp > maxHP) {
    throw new ScenarioValidationError(`${path}.hp`, "HP превышает maxHP");
  }

  const result = { hp, maxHP, resistance: integer(object.resistance, `${path}.resistance`) };

  if (!unit) {
    return result;
  }

  return {
    ...result,
    strength: integer(object.strength, `${path}.strength`),
    agility: integer(object.agility, `${path}.agility`),
    damage: integer(object.damage, `${path}.damage`),
    movement: integer(object.movement, `${path}.movement`),
  };
}

/** Проверяет входные данные и создаёт собственные копии всех массивов и объектов. */
export function loadWorld(input: unknown): WorldState {
  const root = record(input, "$", ["version", "map", "units", "traps"]);

  if (root.version !== 1) {
    throw new ScenarioValidationError("$.version", "поддерживается версия 1");
  }

  const ids = new Set<string>();
  const id = (value: unknown, path: string): string => {
    const result = text(value, path);

    if (ids.has(result)) {
      throw new ScenarioValidationError(path, `повторный ID: ${result}`);
    }

    ids.add(result);

    return result;
  };
  const structure = (value: unknown, path: string): Structure | null => {
    if (value === null) {
      return null;
    }

    const base = record(value, path, [
      "id",
      "kind",
      "blocksMovement",
      "blocksAttack",
      "state",
      "reinforcement",
      "interactionMask",
    ]);
    const entityId = id(base.id, `${path}.id`);
    const kind = choice(base.kind, `${path}.kind`, ["wall", "obstacle", "door", "window"]);

    if (kind === "wall") {
      record(value, path, ["id", "kind"]);

      return { id: entityId, kind };
    }

    if (kind === "obstacle") {
      record(value, path, ["id", "kind", "blocksMovement", "blocksAttack"]);

      return {
        id: entityId,
        kind,
        blocksMovement: boolean(base.blocksMovement, `${path}.blocksMovement`),
        blocksAttack: boolean(base.blocksAttack, `${path}.blocksAttack`),
      };
    }

    record(value, path, ["id", "kind", "state", "reinforcement", "interactionMask"]);

    return {
      id: entityId,
      kind,
      state: choice(base.state, `${path}.state`, ["open", "closed", "destroyed"]),
      reinforcement:
        base.reinforcement === null
          ? null
          : durability(base.reinforcement, `${path}.reinforcement`),
      interactionMask: mask(base.interactionMask, `${path}.interactionMask`),
    };
  };
  const mapInput = record(root.map, "$.map", ["width", "height", "cells"]);
  const width = integer(mapInput.width, "$.map.width", 1);
  const height = integer(mapInput.height, "$.map.height", 1);
  const cellsInput = array(mapInput.cells, "$.map.cells");

  if (cellsInput.length !== width * height) {
    throw new ScenarioValidationError("$.map.cells", "число клеток не равно width * height");
  }

  const map: GridMap = {
    width,
    height,
    cells: cellsInput.map((value, i): Cell => {
      const path = `$.map.cells[${i}]`;
      const cell = record(value, path, ["surface", "area", "structure"]);

      return {
        surface: choice(cell.surface, `${path}.surface`, ["floor", "ground"]),
        area: choice(cell.area, `${path}.area`, ["inside", "outside"]),
        structure: structure(cell.structure, `${path}.structure`),
      };
    }),
  };
  const occupied = new Set<number>();
  const position = (value: unknown, path: string): Position => {
    const object = record(value, path, ["x", "y"]);
    const result = { x: integer(object.x, `${path}.x`), y: integer(object.y, `${path}.y`) };
    const cell = getCell(map, result);

    if (!cell) {
      throw new ScenarioValidationError(path, "клетка за пределами карты");
    }

    const key = result.y * width + result.x;

    if (occupied.has(key)) {
      throw new ScenarioValidationError(path, "клетка уже занята");
    }

    const s = cell.structure;

    if (
      s?.kind === "wall" ||
      (s?.kind === "obstacle" && s.blocksMovement) ||
      ((s?.kind === "door" || s?.kind === "window") && s.state === "closed")
    ) {
      throw new ScenarioValidationError(path, "клетка занята блокирующей структурой");
    }

    occupied.add(key);

    return result;
  };
  const units = array(root.units, "$.units").map((value, i): UnitState => {
    const path = `$.units[${i}]`;
    const unit = record(value, path, [
      "id",
      "kind",
      "definitionId",
      "side",
      "alive",
      "position",
      "stats",
      "attackMask",
      "keywords",
    ]);

    if (unit.kind !== "unit") {
      throw new ScenarioValidationError(`${path}.kind`, "ожидается unit");
    }

    const entityId = id(unit.id, `${path}.id`);
    const side = choice(unit.side, `${path}.side`, ["defender", "enemy"]);
    const alive = boolean(unit.alive, `${path}.alive`);
    const stats = durability(unit.stats, `${path}.stats`, true) as UnitStats;
    let at: Position | null = null;

    if (alive) {
      at = position(unit.position, `${path}.position`);

      if (side === "defender" && getCell(map, at)?.area !== "inside") {
        throw new ScenarioValidationError(
          `${path}.position`,
          "защитник должен находиться внутри здания",
        );
      }
    } else if (unit.position !== null || stats.hp !== 0) {
      throw new ScenarioValidationError(path, "у погибшего юнита position = null и hp = 0");
    }

    return {
      id: entityId,
      kind: "unit",
      definitionId: text(unit.definitionId, `${path}.definitionId`),
      side,
      alive,
      position: at,
      stats,
      attackMask: mask(unit.attackMask, `${path}.attackMask`),
      keywords: array(unit.keywords, `${path}.keywords`).map((value, k) =>
        text(value, `${path}.keywords[${k}]`),
      ),
    };
  });
  const traps = array(root.traps, "$.traps").map((value, i): TrapState => {
    const path = `$.traps[${i}]`;
    const trap = record(value, path, ["id", "kind", "definitionId", "position"]);

    if (trap.kind !== "trap") {
      throw new ScenarioValidationError(`${path}.kind`, "ожидается trap");
    }

    return {
      id: id(trap.id, `${path}.id`),
      kind: "trap",
      definitionId: text(trap.definitionId, `${path}.definitionId`),
      position: position(trap.position, `${path}.position`),
    };
  });

  return { version: 1, map, units, traps };
}

export function serializeWorld(world: WorldState): string {
  return JSON.stringify(world);
}
export function parseWorld(json: string): WorldState {
  let input: unknown;

  try {
    input = JSON.parse(json);
  } catch {
    throw new ScenarioValidationError("$", "некорректный JSON");
  }

  return loadWorld(input);
}
