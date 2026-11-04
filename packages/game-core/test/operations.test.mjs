import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import {
  createOperationQueue,
  evaluateNumeric,
  executeOperation,
  schedulePhase,
} from "@deathwarriors/game-core/operations";

const owner = { kind: "owner" };
const self = { kind: "self" };
const context = () => ({ kind: "phase", ownerId: "actor" });

function runtime() {
  const units = ["actor", "ally", "enemy"].map((id, index) => ({
    id,
    kind: "unit",
    definitionId: "fighter",
    side: index === 2 ? "enemy" : "defender",
    alive: true,
    position: { x: index, y: 0 },
    stats: {
      hp: 5,
      maxHP: 10,
      strength: 2,
      agility: 1,
      damage: 1,
      movement: 2,
      resistance: 100,
    },
    attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
    keywords: [],
  }));
  const world = loadWorld({
    version: 1,
    map: {
      width: 3,
      height: 3,
      cells: Array.from({ length: 9 }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units,
    traps: [],
  });

  return { world, effects: createEffectStore() };
}

function prepare(state, operations, overrides = {}) {
  return addEffect(state.effects, {
    definitionId: "test",
    ownerId: "actor",
    phase: "TURN_START",
    state: { remaining: 3 },
    operations,
    ...overrides,
  });
}

function queue(state, boundaries = {}) {
  return createOperationQueue(state, {
    isOwnerAlive: (id) => state.world.units.find((unit) => unit.id === id)?.alive === true,
    ...boundaries,
  });
}

function run(state) {
  const execution = queue(state);
  execution.enqueue(...schedulePhase(state.effects, "actor", "TURN_START", context()));
  execution.drain();
}

test("один эффект уменьшает HP до нуля и лечит без преждевременной фиксации смерти", () => {
  const state = runtime();
  prepare(state, [
    { kind: "modify_hp", target: owner, delta: -100 },
    { kind: "heal", target: owner, value: 1 },
  ]);
  run(state);
  assert.equal(state.world.units[0].stats.hp, 1);
  assert.equal(state.world.units[0].alive, true);
  assert.deepEqual(state.world.units[0].position, { x: 0, y: 0 });
});

test("параметры читают текущие характеристики после предыдущей операции", () => {
  const state = runtime();
  prepare(state, [
    { kind: "modify_stat", target: owner, stat: "strength", delta: 2 },
    {
      kind: "modify_stat",
      target: owner,
      stat: "damage",
      delta: {
        kind: "multiply",
        left: { kind: "stat", target: owner, stat: "strength" },
        right: 2,
      },
    },
    { kind: "modify_stat", target: owner, stat: "maxHP", delta: 5 },
  ]);
  run(state);
  assert.equal(state.world.units[0].stats.strength, 4);
  assert.equal(state.world.units[0].stats.damage, 9);
  assert.equal(state.world.units[0].stats.maxHP, 15);
  assert.equal(state.world.units[0].stats.hp, 5);
});

test("добавление не запускает новую фазу применения, одинаковые эффекты независимы", () => {
  const state = runtime();
  const child = {
    definitionId: "child",
    phase: "TURN_START",
    state: {},
    operations: [{ kind: "modify_stat", target: owner, stat: "damage", delta: 3 }],
  };
  const parent = prepare(state, [
    { kind: "add_effect", target: owner, effect: child },
    { kind: "add_effect", target: owner, effect: child },
  ]);
  run(state);
  assert.equal(state.world.units[0].stats.damage, 1);
  assert.equal(state.effects.instances.length, 3);
  const [copy] = schedulePhase(state.effects, "actor", "TURN_START", context());
  executeOperation(state, copy, {
    kind: "remove_effect",
    instance: { kind: "instance", id: parent },
  });
  run(state);
  assert.equal(state.world.units[0].stats.damage, 7);
  assert.equal(state.effects.instances.length, 2);
});

test("снятие себя не отменяет текущую копию и не откатывает уже изменённую характеристику", () => {
  const state = runtime();
  prepare(state, [
    { kind: "modify_stat", target: owner, stat: "strength", delta: 2 },
    { kind: "remove_effect", instance: self },
    { kind: "modify_stat", target: owner, stat: "agility", delta: 1 },
  ]);
  run(state);
  assert.equal(state.effects.instances.length, 0);
  assert.equal(state.world.units[0].stats.strength, 4);
  assert.equal(state.world.units[0].stats.agility, 2);
});

test("явный счётчик меняет оригинал, state читает копию, counter читает оригинал", () => {
  const state = runtime();
  prepare(state, [
    { kind: "modify_counter", instance: self, name: "remaining", delta: -1 },
    {
      kind: "modify_stat",
      target: owner,
      stat: "strength",
      delta: { kind: "state", name: "remaining" },
    },
    {
      kind: "modify_stat",
      target: owner,
      stat: "agility",
      delta: {
        kind: "counter",
        instance: self,
        name: "remaining",
      },
    },
  ]);
  run(state);
  assert.equal(state.effects.instances[0].state.remaining, 2);
  assert.equal(state.world.units[0].stats.strength, 5);
  assert.equal(state.world.units[0].stats.agility, 3);
});

test("неосуществимые адресаты и выражения пропускаются без отмены последующих операций", () => {
  const state = runtime();
  prepare(state, [
    { kind: "heal", target: { kind: "attacker" }, value: 5 },
    {
      kind: "modify_stat",
      target: owner,
      stat: "strength",
      delta: { kind: "state", name: "missing" },
    },
    {
      kind: "modify_counter",
      instance: { kind: "instance", id: "missing" },
      name: "remaining",
      delta: -1,
    },
    { kind: "modify_stat", target: { kind: "cell" }, stat: "strength", delta: 100 },
    { kind: "modify_stat", target: owner, stat: "strength", delta: 1 },
  ]);
  run(state);
  assert.equal(state.world.units[0].stats.strength, 3);
});

test("массовое лечение пропускает погибших по отдельности и не превышает maxHP", () => {
  const state = runtime();
  state.world.units[1].alive = false;
  state.world.units[1].stats.hp = 0;
  state.world.units[1].position = null;
  prepare(state, [
    { kind: "heal", target: { kind: "allies" }, value: 100 },
    { kind: "heal", target: { kind: "unit", id: "ally" }, value: 100 },
  ]);
  run(state);
  assert.equal(state.world.units[0].stats.hp, 10);
  assert.equal(state.world.units[1].stats.hp, 0);
  assert.equal(state.world.units[2].stats.hp, 5);
});

test("арифметика ограничена декларативным набором без исполнения JS", () => {
  const state = runtime();
  prepare(state, []);
  const [effect] = schedulePhase(state.effects, "actor", "TURN_START", context());
  const expression = {
    kind: "max",
    left: 0,
    right: {
      kind: "subtract",
      left: { kind: "min", left: 8, right: 5 },
      right: 2,
    },
  };
  assert.equal(evaluateNumeric(state, effect, expression), 3);
  assert.equal(
    evaluateNumeric(state, effect, { kind: "stat", target: { kind: "allies" }, stat: "hp" }),
    undefined,
  );
  assert.throws(() => evaluateNumeric(state, effect, Infinity), RangeError);
  assert.throws(
    () =>
      evaluateNumeric(state, effect, {
        kind: "multiply",
        left: Number.MAX_VALUE,
        right: Number.MAX_VALUE,
      }),
    RangeError,
  );
  assert.throws(
    () => evaluateNumeric(state, effect, { kind: "js", code: "globalThis.injected = true" }),
    TypeError,
  );
  assert.equal(globalThis.injected, undefined);
});

test("копия контекста переживает перемещение, владелец контекста должен совпадать", () => {
  const state = runtime();
  prepare(state, []);
  const cell = { x: 1, y: 1 };
  const input = { kind: "move_end", ownerId: "actor", cell };
  const [effect] = schedulePhase(state.effects, "actor", "TURN_START", input);
  cell.x = 2;
  assert.deepEqual(effect.context.cell, { x: 1, y: 1 });
  assert.throws(
    () =>
      schedulePhase(state.effects, "actor", "TURN_START", {
        kind: "phase",
        ownerId: "other",
      }),
    TypeError,
  );
});

test("эффект смерти может менять другого живого юнита, а лечение погибшего не действует", () => {
  const state = runtime();
  prepare(
    state,
    [
      { kind: "heal", target: owner, value: 5 },
      { kind: "modify_stat", target: { kind: "unit", id: "ally" }, stat: "strength", delta: 1 },
    ],
    { phase: "DEATH" },
  );
  state.world.units[0].alive = false;
  state.world.units[0].stats.hp = 0;
  state.world.units[0].position = null;
  const execution = queue(state);
  execution.enqueue(
    ...schedulePhase(state.effects, "actor", "DEATH", {
      kind: "death",
      ownerId: "actor",
      cell: { x: 0, y: 0 },
    }),
  );
  execution.drain();
  assert.equal(state.world.units[0].stats.hp, 0);
  assert.equal(state.world.units[1].stats.strength, 3);
});
