import assert from "node:assert/strict";
import test from "node:test";
import { getOccupant, loadWorld } from "@deathwarriors/game-core";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import { commitUnitDeaths, createDeathQueue, isOwnerAlive } from "@deathwarriors/game-core/death";
import { schedulePhase } from "@deathwarriors/game-core/operations";

const owner = { kind: "owner" };
const byId = (id) => ({ kind: "unit", id });

function fixture() {
  const world = loadWorld({
    version: 1,
    map: {
      width: 4,
      height: 3,
      cells: Array.from({ length: 12 }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units: ["a", "b", "c", "observer"].map((id, x) => ({
      id,
      kind: "unit",
      definitionId: "fighter",
      side: "defender",
      alive: true,
      position: { x, y: 0 },
      stats: { hp: 5, maxHP: 10, strength: 0, agility: 1, damage: 1, movement: 1, resistance: 0 },
      attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
      keywords: [],
    })),
    traps: [],
  });
  const runtime = { world, effects: createEffectStore() };
  const order = ["a", "b", "c", "observer"];
  return { runtime, order };
}

const add = (runtime, id, ownerId, phase, operations) =>
  addEffect(runtime.effects, {
    definitionId: id,
    ownerId,
    phase,
    operations,
    state: {},
  });
const phase = (runtime, id, name = "TURN_START") =>
  schedulePhase(runtime.effects, id, name, { kind: "phase", ownerId: id });

// Записывает цифры в характеристику наблюдателя, чтобы порядок был виден через реальные операции.
const record = (digit) => ({
  kind: "modify_stat",
  target: byId("observer"),
  stat: "strength",
  delta: {
    kind: "add",
    left: {
      kind: "multiply",
      left: {
        kind: "stat",
        target: byId("observer"),
        stat: "strength",
      },
      right: 9,
    },
    right: digit,
  },
});

test("HP 0 и лечение в одном эффекте не фиксируют смерть", () => {
  const { runtime, order } = fixture();
  add(runtime, "survive", "a", "TURN_START", [
    { kind: "modify_hp", target: owner, delta: -100 },
    { kind: "heal", target: owner, value: 1 },
  ]);
  add(runtime, "death", "a", "DEATH", [record(9)]);
  const queue = createDeathQueue(runtime, () => order);
  queue.enqueue(...phase(runtime, "a"));
  queue.drain();
  assert.equal(runtime.world.units[0].alive, true);
  assert.equal(runtime.world.units[0].stats.hp, 1);
  assert.equal(runtime.world.units[3].stats.strength, 0);
  assert.deepEqual(order, ["a", "b", "c", "observer"]);
});

test("разные эффекты разделены смертью: DEATH раньше прежней очереди, обычные фазы погибшего пропущены", () => {
  const { runtime, order } = fixture();
  add(runtime, "regen", "a", "TURN_START", [{ kind: "heal", target: owner, value: 5 }, record(9)]);
  add(runtime, "bleeding", "a", "TURN_START", [{ kind: "modify_hp", target: owner, delta: -100 }]);
  add(runtime, "old-death", "a", "DEATH", [record(2)]);
  add(runtime, "new-death", "a", "DEATH", [record(1)]);
  add(runtime, "end", "a", "TURN_END", [record(8)]);
  add(runtime, "other", "b", "TURN_START", [record(3)]);
  const queue = createDeathQueue(runtime, () => order);
  queue.enqueue(...phase(runtime, "a"), ...phase(runtime, "a", "TURN_END"), ...phase(runtime, "b"));
  queue.drain();
  assert.equal(runtime.world.units[0].alive, false);
  assert.equal(runtime.world.units[0].stats.hp, 0);
  assert.equal(runtime.world.units[0].position, null);
  assert.equal(getOccupant(runtime.world, { x: 0, y: 0 }), undefined);
  assert.equal(runtime.world.units[3].stats.strength, 123);
  assert.deepEqual(order, ["b", "c", "observer"]);
  assert.equal(isOwnerAlive(runtime.world, "a"), false);
});

test("одновременные смерти сортируются по текущей очереди, а не по операциям или world.units", () => {
  const { runtime } = fixture();
  const order = ["c", "observer", "b", "a"];

  for (const id of ["a", "b", "c"]) {
    add(runtime, `death-${id}`, id, "DEATH", []);
  }

  runtime.world.units[0].stats.hp = 0;
  runtime.world.units[1].stats.hp = 0;
  runtime.world.units[2].stats.hp = 0;
  const batch = commitUnitDeaths(runtime, order);
  assert.deepEqual(
    batch.deaths.map((d) => d.unitId),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    batch.effects.map((e) => e.ownerId),
    ["c", "b", "a"],
  );
  assert.deepEqual(
    batch.deaths.map((d) => d.cell),
    [
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 0 },
    ],
  );
  assert.deepEqual(order, ["observer"]);
  assert(runtime.world.units.slice(0, 3).every((unit) => !unit.alive && unit.position === null));
  assert.deepEqual(commitUnitDeaths(runtime, order), { deaths: [], effects: [] });
});

test("getter использует заменённую очередь, учитывая перестановки после создания исполнителя", () => {
  const { runtime } = fixture();
  let order = ["a", "b", "c", "observer"];
  add(runtime, "a-death", "a", "DEATH", [record(1)]);
  add(runtime, "b-death", "b", "DEATH", [record(2)]);
  add(runtime, "kill", "c", "TURN_START", [
    { kind: "modify_hp", target: byId("a"), delta: -100 },
    { kind: "modify_hp", target: byId("b"), delta: -100 },
  ]);
  const queue = createDeathQueue(runtime, () => order);
  order = ["b", "c", "a", "observer"];
  queue.enqueue(...phase(runtime, "c"));
  queue.drain();
  assert.equal(runtime.world.units[3].stats.strength, 21);
  assert.deepEqual(order, ["c", "observer"]);
});

test("смерть из DEATH создаёт следующую вложенную партию без повторной смерти владельца", () => {
  const { runtime, order } = fixture();
  add(runtime, "kill-a", "c", "TURN_START", [
    { kind: "modify_hp", target: byId("a"), delta: -100 },
  ]);
  add(runtime, "a-death", "a", "DEATH", [
    record(1),
    { kind: "modify_hp", target: byId("b"), delta: -100 },
  ]);
  add(runtime, "b-death", "b", "DEATH", [record(2)]);
  add(runtime, "old", "observer", "TURN_START", [record(3)]);
  const queue = createDeathQueue(runtime, () => order);
  queue.enqueue(...phase(runtime, "c"), ...phase(runtime, "observer"));
  queue.drain();
  assert.equal(runtime.world.units[3].stats.strength, 123);
  assert.deepEqual(order, ["c", "observer"]);
  assert.equal(runtime.world.units.filter((unit) => !unit.alive).length, 2);
});

test("клетка смерти зафиксирована, характеристики и постоянные экземпляры не очищаются", () => {
  const { runtime, order } = fixture();
  add(runtime, "death", "a", "DEATH", []);
  const actor = runtime.world.units[0];
  actor.stats.hp = 0;
  actor.stats.strength = 7;
  const originalCell = actor.position;
  const batch = commitUnitDeaths(runtime, order);
  originalCell.x = 3;
  runtime.world.units[1].position = { x: 0, y: 0 };
  assert.deepEqual(batch.effects[0].context.cell, { x: 0, y: 0 });
  assert.equal(actor.stats.strength, 7);
  assert.equal(runtime.effects.instances.length, 1);
  assert.equal(batch.effects[0].source, "death");
  assert.equal(getOccupant(runtime.world, { x: 0, y: 0 }).id, "b");
});

test("повреждённая очередь или отсутствие клетки обнаруживаются до фиксации смертей", () => {
  for (const order of [
    ["b", "c", "observer"],
    ["a", "a", "b", "c", "observer"],
  ]) {
    const { runtime } = fixture();
    runtime.world.units[0].stats.hp = 0;
    const before = structuredClone(runtime);
    assert.throws(() => commitUnitDeaths(runtime, order), /очереди ходов/);
    assert.deepEqual(runtime, before);
  }

  const { runtime, order } = fixture();
  runtime.world.units[0].stats.hp = 0;
  runtime.world.units[0].position = null;
  assert.throws(() => commitUnitDeaths(runtime, order), /клетки смерти/);
  assert.equal(runtime.world.units[0].alive, true);
});

test("проверка владельца различает промежуточный HP, исчезнувшую ловушку и разрушенный проём", () => {
  const { runtime } = fixture();
  runtime.world.units[0].stats.hp = 0;
  assert.equal(isOwnerAlive(runtime.world, "a"), true);
  runtime.world.traps.push({
    id: "trap",
    kind: "trap",
    definitionId: "trap",
    position: { x: 0, y: 1 },
  });
  assert.equal(isOwnerAlive(runtime.world, "trap"), true);
  runtime.world.traps = [];
  assert.equal(isOwnerAlive(runtime.world, "trap"), false);
  const door = {
    id: "door",
    kind: "door",
    state: "closed",
    reinforcement: null,
    interactionMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
  };
  runtime.world.map.cells[4].structure = door;
  assert.equal(isOwnerAlive(runtime.world, "door"), true);
  door.state = "destroyed";
  assert.equal(isOwnerAlive(runtime.world, "door"), false);
  assert.equal(isOwnerAlive(runtime.world, "missing"), false);
});
