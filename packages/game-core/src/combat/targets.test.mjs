import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import {
  getImmediateAttackTargets,
  selectImmediateAttackTarget,
} from "@deathwarriors/game-core/combat";
import { createSeededRng } from "@deathwarriors/game-core/random";

const full = () => Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]);
function fixture(side = "enemy") {
  return loadWorld({
    version: 1,
    map: {
      width: 5,
      height: 5,
      cells: Array.from({ length: 25 }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units: ["actor", "near", "far"].map((id, index) => ({
      id,
      kind: "unit",
      definitionId: "fighter",
      alive: true,
      side: index === 0 ? side : side === "enemy" ? "defender" : "enemy",
      position: [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 0, y: 0 },
      ][index],
      stats: { hp: 5, maxHP: 5, strength: 1, agility: 1, damage: 1, movement: 1, resistance: 0 },
      attackMask: full(),
      keywords: [],
    })),
    traps: [],
  });
}
function opening(world, id, x, y, kind = "door", reinforced = true) {
  world.map.cells[y * 5 + x].structure = {
    id,
    kind,
    state: "closed",
    interactionMask: full(),
    reinforcement: reinforced ? { hp: 5, maxHP: 5, resistance: 0 } : null,
  };
}
const noRandom = {
  pick: () => {
    throw new Error("Лишний RNG");
  },
};

test("среди юнитов выбирается ближайший по Манхэттену без RNG", () => {
  const world = fixture();
  assert.equal(selectImmediateAttackTarget(world, "actor", noRandom).id, "near");
  assert.deepEqual(
    getImmediateAttackTargets(world, "actor").map((t) => t.manhattan),
    [1, 4],
  );
});

test("равные цели-юниты выбираются seeded RNG в стабильном порядке", () => {
  const world = fixture();
  world.units[2].position = { x: 1, y: 2 };
  const candidates = [];
  const selected = selectImmediateAttackTarget(world, "actor", {
    pick: (values) => {
      candidates.push(...values);
      return values[1];
    },
  });
  assert.equal(selected.id, "far");
  assert.deepEqual(
    candidates.map((t) => t.id),
    ["near", "far"],
  );
  assert.deepEqual(
    selectImmediateAttackTarget(world, "actor", createSeededRng(116)),
    selectImmediateAttackTarget(world, "actor", createSeededRng(116)),
  );
});

test("смешанный набор выбирается целиком: более далёкий защитник не уступает близкой двери", () => {
  const world = fixture();
  world.units = world.units.slice(0, 2);
  world.units[1].position = { x: 4, y: 2 };
  opening(world, "gate", 1, 2);
  const seen = [];
  const result = selectImmediateAttackTarget(world, "actor", {
    pick: (values) => {
      seen.push(...values);
      return values[0];
    },
  });
  assert.equal(result.id, "near");
  assert.deepEqual(
    seen.map((t) => [t.kind, t.manhattan]),
    [
      ["unit", 2],
      ["opening", 1],
    ],
  );
});

test("среди одних укреплений выбор случайный без сравнения расстояния", () => {
  const world = fixture();
  world.units = world.units.slice(0, 1);
  opening(world, "close-door", 1, 2);
  opening(world, "far-window", 4, 0, "window");
  const seen = [];
  const result = selectImmediateAttackTarget(world, "actor", {
    pick: (values) => {
      seen.push(...values);
      return values.at(-1);
    },
  });
  assert.equal(result.id, "close-door");
  assert.deepEqual(
    seen.map((t) => [t.id, t.manhattan]),
    [
      ["far-window", 4],
      ["close-door", 1],
    ],
  );
  const rng = createSeededRng(20);
  assert.deepEqual(
    selectImmediateAttackTarget(world, "actor", rng),
    selectImmediateAttackTarget(world, "actor", createSeededRng(20)),
  );
});

test("защитник видит только переданные известные внутренние цели и не атакует укрепления", () => {
  const world = fixture("defender");
  opening(world, "gate", 4, 0);
  assert.equal(selectImmediateAttackTarget(world, "actor", noRandom), undefined);
  assert.equal(
    selectImmediateAttackTarget(world, "actor", noRandom, { knownEnemyIds: ["far"] }).id,
    "far",
  );
  world.map.cells[0].area = "outside";
  assert.equal(
    selectImmediateAttackTarget(world, "actor", noRandom, { knownEnemyIds: ["far"] }),
    undefined,
  );
});

test("обычные и открытые проёмы, ловушки, погибшие, союзники и закрытая линия исключены", () => {
  const world = fixture();
  opening(world, "ordinary", 1, 1, "door", false);
  opening(world, "opened", 4, 0);
  world.map.cells[4].structure.state = "open";
  world.units[1].side = "enemy";
  world.units[2].alive = false;
  world.units[2].position = null;
  world.units[2].stats.hp = 0;
  world.traps.push({ id: "trap", kind: "trap", definitionId: "snare", position: { x: 1, y: 2 } });
  assert.equal(selectImmediateAttackTarget(world, "actor", noRandom), undefined);
  assert.deepEqual(getImmediateAttackTargets(world, "missing"), []);
  const blocked = fixture();
  blocked.map.cells[6].structure = { id: "wall", kind: "wall" };
  assert.deepEqual(
    getImmediateAttackTargets(blocked, "actor").map((t) => t.id),
    ["near"],
  );
});

test("наружный враг может выбирать укрепление, не получая неподтверждённой атаки по юниту", () => {
  const world = fixture();
  world.map.cells[12].area = "outside";
  opening(world, "gate", 1, 2);
  assert.deepEqual(
    getImmediateAttackTargets(world, "actor").map((t) => t.id),
    ["gate"],
  );
});

test("кандидаты не делят координаты с миром, выбор не меняет его состояние", () => {
  const world = fixture();
  const before = JSON.stringify(world);
  const candidates = getImmediateAttackTargets(world, "actor");
  candidates[0].position.x = 99;
  selectImmediateAttackTarget(world, "actor", noRandom);
  assert.equal(JSON.stringify(world), before);
});
