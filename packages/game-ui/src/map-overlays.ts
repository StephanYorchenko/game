import { canEnterCell, getOccupant } from "@deathwarriors/game-core";
import { canReachMaskedCell, isInMask } from "@deathwarriors/game-core/geometry";
import type {
  Position,
  UnitState,
  WorldState,
} from "@deathwarriors/game-core";

export type OverlayMode = "none" | "attack" | "movement";
export interface OverlayState {
  mode: OverlayMode;
  available: boolean;
}
export interface OverlayCell {
  position: Position;
  kind: "attack-clear" | "attack-blocked" | "move-open" | "move-blocked" | "move-occupied";
  label: string;
}

/** Диагностика базовых API core, без выбора цели, стоимости маршрута и модификаторов контента. */
export function getOverlayCells(
  world: WorldState,
  unit: UnitState,
  mode: OverlayMode,
): OverlayCell[] {
  if (mode === "none" || !unit.alive || !unit.position) {
    return [];
  }

  const cells: OverlayCell[] = [];

  for (let y = 0; y < world.map.height; y++) {
    for (let x = 0; x < world.map.width; x++) {
      const position = { x, y };

      if (mode === "attack") {
        if (!isInMask(unit.attackMask, unit.position, position)) {
          continue;
        }

        const clear = canReachMaskedCell(world, unit.position, position, unit.attackMask);
        cells.push({
          position,
          kind: clear ? "attack-clear" : "attack-blocked",
          label: clear ? "Маска атаки: линия свободна" : "Маска атаки: линия перекрыта",
        });
      } else {
        const enterable = canEnterCell(world, unit, position);
        const occupant = getOccupant(world, position);
        let kind: OverlayCell["kind"] = enterable ? "move-open" : "move-blocked";
        let label = enterable ? "Проходимость: клетка доступна" : "Проходимость: клетка недоступна";

        if (occupant) {
          label += occupant.kind === "trap" ? "; есть ловушка" : "; занято юнитом";

          if (!enterable) {
            kind = "move-occupied";
          }
        }

        cells.push({ position, kind, label });
      }
    }
  }

  return cells;
}
