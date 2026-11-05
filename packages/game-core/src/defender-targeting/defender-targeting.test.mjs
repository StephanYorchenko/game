import assert from "node:assert/strict";
import test from "node:test";
import { getStepDestinations, loadWorld } from "@deathwarriors/game-core";
import {
  assessDefenderTargets,
  isDefenderDoorEligible,
  selectDefenderDestination,
} from "@deathwarriors/game-core/defender-targeting";
import { canReachMaskedCell } from "@deathwarriors/game-core/geometry";
import { openOpening } from "@deathwarriors/game-core/openings";
import { getActionDistance } from "@deathwarriors/game-core/pathfinding";
import { createSeededRng } from "@deathwarriors/game-core/random";

const cross = () => [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
const idAt = (kind, x, y) => `${kind}:${x},${y}`;

function fixture(rows) {
  const width = rows[0].length;
  assert.ok(rows.every((row) => row.length === width));
  const units = [];
  const traps = [];
  const cells = rows.flatMap((row, y) =>
    [...row].map((char, x) => {
      const position = { x, y };
      let structure = null;
      if (char === "#") {
        structure = { id: idAt("wall", x, y), kind: "wall" };
      } else if (["d", "R", "W"].includes(char)) {
        structure = {
          id: idAt("door", x, y),
          kind: char === "W" ? "window" : "door",
          state: "closed",
          reinforcement: char === "R" ? { hp: 5, maxHP: 5, resistance: 0 } : null,
          interactionMask: cross(),
        };
      }
      if (["D", "e", "a"].includes(char)) {
        units.push({
          id: char === "D" ? "defender" : idAt(char === "e" ? "enemy" : "ally", x, y),
          kind: "unit",
          definitionId: "fighter",
          side: char === "e" ? "enemy" : "defender",
          alive: true,
          position,
          attackMask: cross(),
          keywords: [],
          stats: {
            hp: 5,
            maxHP: 5,
            strength: 1,
            agility: 1,
            damage: 1,
            movement: 2,
            resistance: 0,
          },
        });
      } else if (char === "T") {
        traps.push({ id: idAt("trap", x, y), kind: "trap", definitionId: "snare", position });
      }
      return { surface: "floor", area: "inside", structure };
    }),
  );
  const world = loadWorld({ version: 1, map: { width, height: rows.length, cells }, units, traps });
  const known = units.filter((unit) => unit.side === "enemy").map((unit) => unit.id);
  return { world, known };
}

test("любой открытый путь запрещает открытие дверей, даже к геометрически близкому врагу", () => {
  const { world, known } = fixture([
    "#########",
    "#Dde#...#",
    "#.###.e.#",
    "#.......#",
    "#########",
  ]);
  const result = assessDefenderTargets(world, "defender", known);
  assert.deepEqual(
    result.openEnemies.map((enemy) => enemy.targetId),
    ["enemy:6,2"],
  );
  assert.ok(result.doors.every((door) => !door.leadsToEnemy));
  assert.equal(
    selectDefenderDestination(world, "defender", known, createSeededRng(1)).targetId,
    "enemy:6,2",
  );
  assert.equal(isDefenderDoorEligible(world, "defender", "door:2,1", known), false);
});

test("открытые цели сравниваются по пути до атакующей позиции, равенства воспроизводимы", () => {
  const { world, known } = fixture(["#######", "#e.D.e#", "#######"]);
  const seed = createSeededRng(21);
  const first = selectDefenderDestination(world, "defender", known, seed);
  assert.deepEqual(
    first,
    selectDefenderDestination(world, "defender", [...known].reverse(), createSeededRng(21)),
  );
  assert.equal(first.kind, "enemy");
  assert.equal(first.path.distance, 1);
});

test("потенциальная дорога через две закрытые двери даёт TRUE первой и второй", () => {
  const { world, known } = fixture(["D.d.d.e"]);
  const before = JSON.stringify(world);
  const result = assessDefenderTargets(world, "defender", known);
  assert.deepEqual(result.doors, [
    { doorId: "door:2,0", leadsToEnemy: true, distance: 1 },
    { doorId: "door:4,0", leadsToEnemy: true, distance: null },
  ]);
  assert.equal(
    selectDefenderDestination(world, "defender", known, createSeededRng(1)).targetId,
    "door:2,0",
  );
  assert.equal(JSON.stringify(world), before);
});

test("расстояние за уже доступными дверями не ранжирует их при случайном выборе", () => {
  const { world, known } = fixture(["#####", "#Dde#", "#d###", "#.###", "#.###", "#e###", "#####"]);
  const calls = [];
  const rng = {
    pick: (candidates) => {
      calls.push(candidates);
      return candidates.at(-1);
    },
  };
  const result = selectDefenderDestination(world, "defender", known, rng);
  assert.equal(result.targetId, "door:1,2");
  assert.equal(result.path.distance, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].map((candidate) => candidate.distance),
    [0, 0],
  );
});

test("боковая тупиковая дверь FALSE, несмотря на дорогу к врагу через другую дверь", () => {
  const { world, known } = fixture(["#######", "###.###", "###d###", "#D...de", "#######"]);
  const result = assessDefenderTargets(world, "defender", known);
  assert.deepEqual(
    result.doors.map((door) => [door.doorId, door.leadsToEnemy]),
    [
      ["door:3,2", false],
      ["door:5,3", true],
    ],
  );
});

test("стены, укрепления, окна, ловушки и тела юнитов сохраняются в потенциальном пути", () => {
  for (const blocker of ["#", "R", "W", "T", "a"]) {
    const { world, known } = fixture([`D.d.${blocker}.e`]);
    assert.equal(isDefenderDoorEligible(world, "defender", "door:2,0", known), false, blocker);
  }
});

test("дверь, которую нельзя открыть по её матрице, не открывает потенциальный маршрут", () => {
  const { world, known } = fixture(["D.d.d.e"]);
  world.map.cells[4].structure.interactionMask = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  assert.ok(
    assessDefenderTargets(world, "defender", known).doors.every((door) => !door.leadsToEnemy),
  );
});

test("наружная клетка не становится обходом; неизвестные, наружные и мёртвые враги исключены", () => {
  const { world, known } = fixture(["D.d...e"]);
  world.map.cells[3].area = "outside";
  assert.equal(isDefenderDoorEligible(world, "defender", "door:2,0", known), false);
  world.map.cells[3].area = "inside";
  assert.equal(assessDefenderTargets(world, "defender", []).status, "no_known_enemies");
  world.map.cells[6].area = "outside";
  assert.equal(assessDefenderTargets(world, "defender", known).status, "no_known_enemies");
  world.map.cells[6].area = "inside";
  world.units[1].alive = false;
  world.units[1].position = null;
  world.units[1].stats.hp = 0;
  assert.equal(assessDefenderTargets(world, "defender", known).status, "no_known_enemies");
});

test("открытие линии выстрела даёт TRUE без обязательного шага в сам проём", () => {
  const { world, known } = fixture(["Dde"]);
  world.units[0].attackMask = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  world.units[0].attackMask[2][4] = 1;
  const options = { movement: { directions: ["west"] } };
  assert.equal(isDefenderDoorEligible(world, "defender", "door:1,0", known, options), true);
  assert.equal(
    openOpening(world, "defender", "door:1,0", {
      defenderCanOpen: (current, unit, target) =>
        isDefenderDoorEligible(current, unit.id, target.opening.id, known, options),
    }).allowed,
    true,
  );
  assert.equal(assessDefenderTargets(world, "defender", known, options).openEnemies[0].distance, 0);
});

test("недоступный актор и полностью заблокированный маршрут не создают решение или RNG", () => {
  const { world, known } = fixture(["D.d.#.e"]);
  const rng = {
    pick: () => {
      throw new Error("Лишний выбор");
    },
  };
  assert.deepEqual(selectDefenderDestination(world, "defender", known, rng), {
    kind: "none",
    reason: "blocked",
  });
  assert.deepEqual(selectDefenderDestination(world, "missing", known, rng), {
    kind: "none",
    reason: "actor_unavailable",
  });
});

test("булев результат совпадает с независимым перебором простых путей на 1024 малых картах", () => {
  const directions = ["north", "east", "south", "west"];
  const possibleWalls = [1, 2, 3, 5, 6, 7];
  for (let walls = 0; walls < 64; walls += 1) {
    for (let moves = 0; moves < 16; moves += 1) {
      const { world, known } = fixture(["D..", ".d.", "..e"]);
      for (const [bit, index] of possibleWalls.entries()) {
        if (walls & (1 << bit)) {
          world.map.cells[index].structure = { id: `wall:${index}`, kind: "wall" };
        }
      }
      const unit = world.units[0];
      const enemy = world.units[1];
      const options = {
        movement: { directions: directions.filter((_, bit) => moves & (1 << bit)) },
      };
      let expected = false;
      if (
        getActionDistance(world, unit, { kind: "attack", position: enemy.position }, options) ===
        undefined
      ) {
        const projected = structuredClone(world);
        projected.units = projected.units.filter((candidate) => candidate.id !== unit.id);
        projected.map.cells[4].structure.state = "open";
        const visit = (position, seen, crossed) => {
          const key = position.y * 3 + position.x;
          const through = crossed || key === 4;
          if (through && canReachMaskedCell(projected, position, enemy.position, unit.attackMask)) {
            return true;
          }
          for (const next of getStepDestinations(
            projected,
            { ...unit, position },
            options.movement,
          )) {
            const nextKey = next.y * 3 + next.x;
            if (!seen.has(nextKey) && visit(next, new Set([...seen, nextKey]), through)) {
              return true;
            }
          }
          return false;
        };
        expected = visit(unit.position, new Set([0]), false);
      }
      assert.equal(
        isDefenderDoorEligible(world, "defender", "door:1,1", known, options),
        expected,
        `walls=${walls}, directions=${moves}`,
      );
    }
  }
});
