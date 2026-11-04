import { getCell, getOccupant } from "../world/index.js";
import type { Mask5x5, Position, Structure, UnitState, WorldState } from "../world/index.js";

export type LineBlocker =
  | { kind: "structure"; position: Position; structure: Structure }
  | { kind: "unit"; position: Position; unit: UnitState };

export interface LineOptions {
  /** Исключения ключевых слов разрешает вызывающий слой контента. */
  ignoresBlocker?(blocker: LineBlocker): boolean;
}

export function isInMask(mask: Mask5x5, center: Position, position: Position): boolean {
  const x = position.x - center.x + 2;
  const y = position.y - center.y + 2;

  return Number.isInteger(x) && Number.isInteger(y) && mask[y]?.[x] === 1;
}

/** Supercover между центрами клеток в пределах маски 5×5, включая оба конца. */
export function getSupercoverCells(from: Position, to: Position): Position[] {
  if (
    !Number.isSafeInteger(from.x) ||
    !Number.isSafeInteger(from.y) ||
    !Number.isSafeInteger(to.x) ||
    !Number.isSafeInteger(to.y) ||
    Math.abs(to.x - from.x) > 2 ||
    Math.abs(to.y - from.y) > 2
  ) {
    throw new RangeError("Линия должна соединять целые клетки в пределах маски 5×5");
  }

  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sx = Math.sign(to.x - from.x);
  const sy = Math.sign(to.y - from.y);
  const cells: Position[] = [{ ...from }];
  let x = from.x;
  let y = from.y;
  let ix = 0;
  let iy = 0;

  while (ix < dx || iy < dy) {
    // Сравнение времени пересечения границ без float и epsilon.
    const crossing = (2 * ix + 1) * dy - (2 * iy + 1) * dx;

    if (crossing === 0) {
      // Точное касание угла учитывает обе боковые клетки, затем диагональную.
      cells.push({ x: x + sx, y }, { x, y: y + sy });
      x += sx;
      y += sy;
      ix += 1;
      iy += 1;
    } else if (crossing < 0) {
      x += sx;
      ix += 1;
    } else {
      y += sy;
      iy += 1;
    }

    cells.push({ x, y });
  }

  return cells;
}

/** Только геометрия: тип допустимой цели и правила сторон проверяются отдельно. */
export function hasClearLine(
  world: WorldState,
  from: Position,
  to: Position,
  options: LineOptions = {},
): boolean {
  if (!getCell(world.map, from) || !getCell(world.map, to)) {
    return false;
  }

  if (Math.abs(to.x - from.x) > 2 || Math.abs(to.y - from.y) > 2) {
    return false;
  }

  for (const position of getSupercoverCells(from, to)) {
    if (
      (position.x === from.x && position.y === from.y) ||
      (position.x === to.x && position.y === to.y)
    ) {
      continue;
    }

    const cell = getCell(world.map, position);

    if (!cell) {
      return false;
    }

    const structure = cell.structure;
    const blocks =
      structure?.kind === "wall" ||
      (structure?.kind === "obstacle" && structure.blocksAttack) ||
      ((structure?.kind === "door" || structure?.kind === "window") &&
        structure.state === "closed");

    if (
      blocks &&
      structure &&
      !options.ignoresBlocker?.({ kind: "structure", position, structure })
    ) {
      return false;
    }

    const occupant = getOccupant(world, position);

    if (
      occupant?.kind === "unit" &&
      !options.ignoresBlocker?.({ kind: "unit", position, unit: occupant })
    ) {
      return false;
    }
  }

  return true;
}

/** Маска атаки центрирована на атакующем и фиксирована относительно карты. */
export function canReachMaskedCell(
  world: WorldState,
  from: Position,
  to: Position,
  mask: Mask5x5,
  options: LineOptions = {},
): boolean {
  return isInMask(mask, from, to) && hasClearLine(world, from, to, options);
}

/** Маска взаимодействия объекта задаёт допустимые позиции юнита вокруг объекта. */
export function canReachInteraction(
  world: WorldState,
  actor: Position,
  object: Position,
  interactionMask: Mask5x5,
  options: LineOptions = {},
): boolean {
  return isInMask(interactionMask, object, actor) && hasClearLine(world, actor, object, options);
}
