import { loadWorld } from "@deathwarriors/game-core";
import type {
  Cell,
  Mask5x5,
  Structure,
  UnitState,
  WorldState,
} from "@deathwarriors/game-core";

const mask: Mask5x5 = [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];

function unit(id: string, side: UnitState["side"], x: number, y: number): UnitState {
  return {
    id,
    kind: "unit",
    definitionId: `demo-${side}`,
    side,
    alive: true,
    position: { x, y },
    stats: {
      hp: 8,
      maxHP: 10,
      resistance: 1,
      strength: 3,
      agility: 2,
      damage: 2,
      movement: 3,
    },
    attackMask: mask,
    keywords: [],
  };
}

/** Ручной сценарий для просмотра, не генератор и не результат симуляции. */
export function createDemoWorld(): WorldState {
  const width = 14;
  const height = 10;
  const cells: Cell[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= 3 && x <= 10 && y >= 2 && y <= 7;
      const boundary = inside && (x === 3 || x === 10 || y === 2 || y === 7);

      cells.push({
        surface: inside ? "floor" : "ground",
        area: inside ? "inside" : "outside",
        structure: boundary ? { id: `wall-${x}-${y}`, kind: "wall" } : null,
      });
    }
  }

  function structure(x: number, y: number, value: Structure): void {
    const cell = cells[y * width + x];

    if (!cell) {
      throw new Error("Демонстрационная структура за границей карты");
    }

    cell.structure = value;
  }

  const openings = [
    { x: 6, y: 7, kind: "door", state: "closed" },
    { x: 3, y: 4, kind: "door", state: "open" },
    { x: 10, y: 5, kind: "door", state: "destroyed" },
    { x: 5, y: 2, kind: "window", state: "closed" },
    { x: 8, y: 2, kind: "window", state: "open" },
    { x: 10, y: 3, kind: "window", state: "destroyed" },
  ] as const;

  for (const opening of openings) {
    structure(opening.x, opening.y, {
      id: `${opening.kind}-${opening.state}`,
      kind: opening.kind,
      state: opening.state,
      interactionMask: mask,
      reinforcement: opening.state === "closed"
        ? { hp: 6, maxHP: 8, resistance: 1 }
        : null,
    });
  }

  structure(7, 4, {
    id: "crate",
    kind: "obstacle",
    blocksMovement: true,
    blocksAttack: false,
  });

  return loadWorld({
    version: 1,
    map: { width, height, cells },
    units: [
      unit("defender-1", "defender", 5, 4),
      unit("defender-2", "defender", 8, 5),
      unit("enemy-1", "enemy", 1, 6),
      unit("enemy-2", "enemy", 11, 8),
      unit("enemy-3", "enemy", 12, 3),
    ],
    traps: [{
      id: "trap-1",
      kind: "trap",
      definitionId: "demo-trap",
      position: { x: 6, y: 6 },
    }],
  });
}
