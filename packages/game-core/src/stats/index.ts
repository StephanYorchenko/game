import type { UnitState, UnitStats } from "../world/index.js";

const CHARACTERISTICS = [
  "maxHP",
  "strength",
  "agility",
  "damage",
  "movement",
  "resistance",
] as const;

export type Characteristic = Exclude<keyof UnitStats, "hp">;

/** Прямое изменение текущей характеристики; не создаёт обратных модификаторов. */
export function modifyStat(unit: UnitState, stat: Characteristic, delta: number): boolean {
  if (!CHARACTERISTICS.includes(stat)) {
    throw new TypeError("Неизвестная характеристика");
  }

  if (!Number.isInteger(delta)) {
    throw new RangeError("Изменение характеристики должно быть конечным целым числом");
  }

  if (!unit.alive) {
    return false;
  }

  const value = unit.stats[stat] + delta;

  if (!Number.isFinite(value)) {
    throw new RangeError("Переполнение характеристики");
  }

  unit.stats[stat] = Math.max(stat === "maxHP" ? 1 : 0, value);

  if (stat === "maxHP") {
    unit.stats.hp = Math.min(unit.stats.hp, unit.stats.maxHP);
  }

  return true;
}

/** Синхронное изменение HP без CELL_DAMAGE, сопротивления и фиксации смерти. */
export function modifyHP(unit: UnitState, delta: number): boolean {
  if (!Number.isInteger(delta)) {
    throw new RangeError("Изменение HP должно быть конечным целым числом");
  }

  if (!unit.alive) {
    return false;
  }

  unit.stats.hp = Math.max(0, Math.min(unit.stats.maxHP, unit.stats.hp + delta));
  return true;
}

/** Лечение живого юнита. Нулевой HP до границы эффекта не равен смерти. */
export function heal(unit: UnitState, value: number): boolean {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Лечение должно быть неотрицательным конечным целым числом");
  }

  return modifyHP(unit, value);
}
