import type { SeededRng } from "./random.js";
import type { UnitState } from "./state.js";

export interface InitiativeEntry {
  readonly unitId: string;
  readonly roll: number;
  readonly agility: number;
  readonly initiative: number;
  readonly tieRolls: readonly number[];
}

function rollD6(rng: Pick<SeededRng, "d6">): number {
  const roll = rng.d6();

  if (!Number.isInteger(roll) || roll < 1 || roll > 6) {
    throw new RangeError("Источник инициативы должен возвращать d6 от 1 до 6");
  }

  return roll;
}

/** Снимок начала ночи. Последующие изменения ловкости не перестраивают результат. */
export function createInitiativeOrder(
  units: readonly UnitState[],
  rng: Pick<SeededRng, "d6">,
): InitiativeEntry[] {
  const participants = units.filter((unit) => unit.alive && unit.position !== null);
  const ids = new Set<string>();

  for (const unit of participants) {
    if (ids.has(unit.id)) {
      throw new TypeError("Повторный ID участника инициативы");
    }

    if (!Number.isInteger(unit.stats.agility) || unit.stats.agility < 0) {
      throw new RangeError("Ловкость участника должна быть неотрицательным целым числом");
    }

    ids.add(unit.id);
  }

  const entries = participants.map((unit): InitiativeEntry => {
    const roll = rollD6(rng);

    return {
      unitId: unit.id,
      roll,
      agility: unit.stats.agility,
      initiative: roll + unit.stats.agility,
      tieRolls: [],
    };
  });
  entries.sort((a, b) => b.initiative - a.initiative || b.agility - a.agility);

  const groups: InitiativeEntry[][] = [];

  for (const entry of entries) {
    const group = groups.at(-1);
    const first = group?.[0];

    if (first && first.initiative === entry.initiative && first.agility === entry.agility) {
      group!.push(entry);
    } else {
      groups.push([entry]);
    }
  }

  const pending = groups.reverse();
  const result: InitiativeEntry[] = [];

  while (pending.length > 0) {
    const group = pending.pop()!;

    if (group.length === 1) {
      result.push(group[0]!);
      continue;
    }

    const rerolled = group.map((entry) => ({
      ...entry,
      tieRolls: [...entry.tieRolls, rollD6(rng)],
    }));
    rerolled.sort((a, b) => b.tieRolls.at(-1)! - a.tieRolls.at(-1)!);
    const subgroups: InitiativeEntry[][] = [];

    for (const entry of rerolled) {
      const subgroup = subgroups.at(-1);
      const first = subgroup?.[0];

      if (first && first.tieRolls.at(-1) === entry.tieRolls.at(-1)) {
        subgroup!.push(entry);
      } else {
        subgroups.push([entry]);
      }
    }

    pending.push(...subgroups.reverse());
  }

  return result;
}
