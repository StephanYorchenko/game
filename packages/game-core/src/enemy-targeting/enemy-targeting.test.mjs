import assert from "node:assert/strict";
import test from "node:test";
import { canEnterCell, loadWorld } from "@deathwarriors/game-core";
import {
  getEnemyRouteTargets,
  selectEnemyDestination,
} from "@deathwarriors/game-core/enemy-targeting";
import { createSeededRng } from "@deathwarriors/game-core/random";

const cross = () => [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
const at = (x, y) => `${x},${y}`;
function fixture(rows) {
  const units = [];
  const traps = [];
  const width = rows[0].length;
  assert.ok(rows.every((row) => row.length === width));
  const cells = rows.flatMap((row, y) =>
    [...row].map((char, x) => {
      let structure = null;
      if (char === "#") {
        structure = { id: `wall:${at(x, y)}`, kind: "wall" };
      } else if (["d", "R", "W", "V"].includes(char)) {
        structure = {
          id: `opening:${at(x, y)}`,
          kind: ["W", "V"].includes(char) ? "window" : "door",
          state: "closed",
          interactionMask: cross(),
          reinforcement: ["R", "V"].includes(char) ? { hp: 5, maxHP: 5, resistance: 0 } : null,
        };
      }
      if (["E", "D"].includes(char)) {
        units.push({
          id: char === "E" ? "enemy" : `defender:${at(x, y)}`,
          kind: "unit",
          definitionId: "fighter",
          side: char === "E" ? "enemy" : "defender",
          alive: true,
          position: { x, y },
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
        traps.push({
          id: `trap:${at(x, y)}`,
          kind: "trap",
          definitionId: "snare",
          position: { x, y },
        });
      }
      return { surface: "floor", area: char === "E" ? "outside" : "inside", structure };
    }),
  );
  return loadWorld({ version: 1, map: { width, height: rows.length, cells }, units, traps });
}
const noRandom = {
  pick: () => {
    throw new Error("Лишний RNG");
  },
};

test("ближнее укрепление не уступает дальнему открытому подходу к обычной двери", () => {
  const world = fixture(["E.R...d...D", "..........."]);
  const candidates = getEnemyRouteTargets(world, "enemy");
  const fortified = candidates.find((candidate) => candidate.id === "opening:2,0");
  const ordinary = candidates.find((candidate) => candidate.id === "opening:6,0");
  assert.equal(fortified.distance, 1);
  assert.ok(ordinary.distance > fortified.distance);
  const selected = selectEnemyDestination(world, "enemy", noRandom);
  assert.equal(selected.target.id, fortified.id);
  assert.equal(selected.target.action, "ATTACK");
  assert.equal(selected.path.distance, 1);
});

test("равные ближайшие цели разных типов выбираются из общего набора seeded RNG", () => {
  const world = fixture([".....", ".E.d.", ".....", ".D...", "....."]);
  const calls = [];
  const result = selectEnemyDestination(world, "enemy", {
    pick: (values) => {
      calls.push(values);
      return values.at(-1);
    },
  });
  assert.equal(result.target.id, "opening:3,1");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].map((candidate) => [candidate.kind, candidate.distance]),
    [
      ["unit", 1],
      ["opening", 1],
    ],
  );
  assert.deepEqual(
    selectEnemyDestination(world, "enemy", createSeededRng(22)),
    selectEnemyDestination(world, "enemy", createSeededRng(22)),
  );
});

test("Гигант может выбрать открытие/атаку окна без права проходить через него", () => {
  const world = fixture([".....", "E.W..", "....."]);
  const options = { movement: { allowWindows: false } };
  const selected = selectEnemyDestination(world, "enemy", noRandom, options);
  assert.equal(selected.target.id, "opening:2,1");
  assert.equal(selected.target.action, "INTERACT");
  world.map.cells[7].structure.reinforcement = { hp: 5, maxHP: 5, resistance: 0 };
  assert.equal(selectEnemyDestination(world, "enemy", noRandom, options).target.action, "ATTACK");
  world.map.cells[7].structure.state = "open";
  assert.equal(canEnterCell(world, world.units[0], { x: 2, y: 1 }, options.movement), false);
  assert.deepEqual(getEnemyRouteTargets(world, "enemy", options), []);
});

test("обычная атака защитника требует внутренней позиции, но путь может идти снаружи", () => {
  const world = fixture(["E..D", "...."]);
  for (const key of [0, 1, 2, 4, 5, 6]) {
    world.map.cells[key].area = "outside";
  }
  const selected = selectEnemyDestination(world, "enemy", createSeededRng(22));
  assert.equal(selected.target.distance, 4);
  assert.deepEqual(selected.path.destination, { x: 3, y: 1 });
  assert.equal(world.map.cells[7].area, "inside");
});

test("индивидуально известная ловушка сохраняет непроходимость при выборе цели", () => {
  const world = fixture(["E.T.D"]);
  assert.equal(getEnemyRouteTargets(world, "enemy")[0].distance, 3);
  assert.deepEqual(
    getEnemyRouteTargets(world, "enemy", {
      movement: { knownTrapIds: ["trap:2,0"] },
    }),
    [],
  );
});

test("недостижимость, отсутствие целей и недопустимый актор не расходуют RNG", () => {
  const world = fixture(["E#d#D"]);
  assert.equal(selectEnemyDestination(world, "enemy", noRandom), undefined);
  assert.equal(selectEnemyDestination(world, "missing", noRandom), undefined);
  assert.equal(selectEnemyDestination(world, "defender:4,0", noRandom), undefined);
  const openings = fixture(["E.d.W"]);
  openings.map.cells[2].structure.state = "open";
  openings.map.cells[4].structure.state = "destroyed";
  assert.equal(selectEnemyDestination(openings, "enemy", noRandom), undefined);
});

test("кандидат-проём не требует защитника за ним; анализ не меняет мир", () => {
  const world = fixture(["E..d"]);
  const before = JSON.stringify(world);
  const candidates = getEnemyRouteTargets(world, "enemy");
  assert.equal(candidates[0].distance, 2);
  candidates[0].position.x = 99;
  selectEnemyDestination(world, "enemy", noRandom);
  assert.equal(JSON.stringify(world), before);
});
