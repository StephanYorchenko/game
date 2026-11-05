import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import {
  getAvailableInteractions,
  selectImmediateInteraction,
} from "@deathwarriors/game-core/openings";
import { createSeededRng } from "@deathwarriors/game-core/random";

const cross = () => [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
const full = () => Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]);
function fixture(rows) {
  const units = [];
  const width = rows[0].length;
  assert.ok(rows.every((row) => row.length === width));
  const cells = rows.flatMap((row, y) =>
    [...row].map((char, x) => {
      let structure = null;
      if (char === "#") {
        structure = { id: `wall:${x},${y}`, kind: "wall" };
      } else if (["d", "W", "R"].includes(char)) {
        structure = {
          id: `opening:${x},${y}`,
          kind: char === "W" ? "window" : "door",
          state: "closed",
          interactionMask: cross(),
          reinforcement: char === "R" ? { hp: 5, maxHP: 5, resistance: 0 } : null,
        };
      }
      if (["D", "E", "e"].includes(char)) {
        units.push({
          id: char === "e" ? `enemy:${x},${y}` : "actor",
          kind: "unit",
          definitionId: "fighter",
          side: char === "D" ? "defender" : "enemy",
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
      }
      return { surface: "floor", area: "inside", structure };
    }),
  );
  const world = loadWorld({
    version: 1,
    map: { width, height: rows.length, cells },
    units,
    traps: [],
  });
  const knownEnemyIds = units.filter((unit) => unit.id !== "actor").map((unit) => unit.id);
  return { world, options: { knownEnemyIds } };
}
const noRandom = {
  pick: () => {
    throw new Error("Лишний RNG");
  },
};

test("враг без защитников за проёмами выбирает из всех уже доступных дверей и окон", () => {
  const { world } = fixture(["W....", ".....", "..Ed.", ".....", "....."]);
  world.map.cells[0].structure.interactionMask = full();
  const seen = [];
  const selected = selectImmediateInteraction(world, "actor", {
    pick: (values) => {
      seen.push(...values);
      return values[0];
    },
  });
  assert.equal(selected.id, "opening:0,0");
  assert.deepEqual(
    seen.map((target) => target.kind),
    ["window", "door"],
  );
  assert.deepEqual(
    selectImmediateInteraction(world, "actor", createSeededRng(23)),
    selectImmediateInteraction(world, "actor", createSeededRng(23)),
  );
});

test("при открытом пути защитника к известному врагу INTERACT недоступен", () => {
  const { world, options } = fixture(["#####", "#Dd.#", "#e..#", "#####"]);
  assert.deepEqual(getAvailableInteractions(world, "actor", options), []);
  assert.equal(selectImmediateInteraction(world, "actor", noRandom, options), undefined);
  assert.equal(world.map.cells[7].structure.state, "closed");
});

test("защитник выбирает только TRUE-дверь; тупик и отсутствие известного врага исключены", () => {
  const { world, options } = fixture(["#####", "#Dde#", "#d###", "#.###", "#####"]);
  assert.deepEqual(
    getAvailableInteractions(world, "actor", options).map((target) => target.id),
    ["opening:2,1"],
  );
  assert.equal(selectImmediateInteraction(world, "actor", noRandom, options).id, "opening:2,1");
  assert.equal(selectImmediateInteraction(world, "actor", noRandom), undefined);
});

test("две TRUE-двери имеют равные шансы без расстояния до дальнейшего противника", () => {
  const { world, options } = fixture([
    "#####",
    "#Dde#",
    "#d###",
    "#.###",
    "#.###",
    "#e###",
    "#####",
  ]);
  const calls = [];
  const selected = selectImmediateInteraction(
    world,
    "actor",
    {
      pick: (values) => {
        calls.push(values);
        return values.at(-1);
      },
    },
    options,
  );
  assert.equal(selected.id, "opening:1,2");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].map((target) => target.id),
    ["opening:2,1", "opening:1,2"],
  );
  assert.ok(calls[0].every((target) => !Object.hasOwn(target, "distance")));
});

test("supercover отсекает стену и тело между юнитом и объектом до выбора", () => {
  const { world } = fixture(["E#d", "...", "W.."]);
  world.map.cells[2].structure.interactionMask = full();
  world.map.cells[6].structure.interactionMask = full();
  assert.deepEqual(
    getAvailableInteractions(world, "actor").map((target) => target.id),
    ["opening:0,2"],
  );
  world.units.push({ ...world.units[0], id: "blocker", position: { x: 0, y: 1 } });
  assert.equal(selectImmediateInteraction(world, "actor", noRandom), undefined);
});

test("матрица взаимодействия, укрепление, открытое и разрушенное состояние исключают цель", () => {
  const { world } = fixture([".....", "..W..", ".dER.", "..d..", "....."]);
  world.map.cells[11].structure.interactionMask = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  world.map.cells[7].structure.state = "open";
  world.map.cells[17].structure.state = "destroyed";
  assert.equal(selectImmediateInteraction(world, "actor", noRandom), undefined);
});

test("исключения перекрытия линии передаются той же проверке геометрии", () => {
  const { world } = fixture(["E#d"]);
  world.map.cells[2].structure.interactionMask = full();
  const selected = selectImmediateInteraction(world, "actor", noRandom, {
    line: {
      ignoresBlocker: (blocker) =>
        blocker.kind === "structure" && blocker.structure.id === "wall:1,0",
    },
  });
  assert.equal(selected.id, "opening:2,0");
});

test("кандидаты независимы от мира, недоступный актор не расходует RNG", () => {
  const { world } = fixture(["Ed"]);
  const before = JSON.stringify(world);
  const candidates = getAvailableInteractions(world, "actor");
  candidates[0].position.x = 99;
  assert.equal(JSON.stringify(world), before);
  assert.equal(selectImmediateInteraction(world, "missing", noRandom), undefined);
  world.units[0].alive = false;
  world.units[0].position = null;
  world.units[0].stats.hp = 0;
  assert.equal(selectImmediateInteraction(world, "actor", noRandom), undefined);
});

test("защитник не открывает окно даже при известном противнике за ним", () => {
  const { world, options } = fixture(["DWe"]);
  assert.equal(selectImmediateInteraction(world, "actor", noRandom, options), undefined);
});
