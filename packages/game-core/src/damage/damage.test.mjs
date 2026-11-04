import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import {
  createDamageState,
  createCellDamage,
  createDamageQueue,
  resolveCellDamage,
} from "@deathwarriors/game-core/damage";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import { runUnitTurn } from "@deathwarriors/game-core/turn";

const owner = { kind: "owner" };
const byId = (id) => ({ kind: "unit", id });
const targetCell = { x: 1, y: 1 };

function fixture() {
  const runtime = {
    world: loadWorld({
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
      units: ["actor", "target", "replacement"].map((id, index) => ({
        id,
        kind: "unit",
        definitionId: "fighter",
        side: index === 0 ? "defender" : "enemy",
        alive: true,
        position: { x: index, y: index },
        stats: { hp: 5, maxHP: 10, strength: 0, agility: 1, damage: 1, movement: 1, resistance: 0 },
        attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
        keywords: [],
      })),
      traps: [],
    }),
    effects: createEffectStore(),
  };
  const state = createDamageState();
  const order = ["actor", "target", "replacement"];
  const outcomes = [];
  const queue = createDamageQueue(
    runtime,
    state,
    () => order,
    (outcome) => outcomes.push(outcome),
  );
  return { runtime, state, order, outcomes, queue };
}

function effect(id, operations, ownerId = "actor") {
  return {
    ownerId,
    instanceId: id,
    definitionId: id,
    phase: "ATTACK_SUCCESS",
    source: "ordinary",
    state: {},
    operations,
    context: {
      kind: "attack",
      ownerId,
      attackerId: "actor",
      defenderId: "target",
      cell: targetCell,
    },
  };
}

test("ID и клетка проходят через JSON, счётчик сохраняется, sourceId не требуется", () => {
  const state = createDamageState();
  const cell = { ...targetCell };
  const first = createCellDamage(state, cell, 0);
  cell.x = 2;
  assert.deepEqual(first.cell, targetCell);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(Object.hasOwn(first, "ownerId"), false);
  assert.equal(Object.hasOwn(first, "sourceId"), false);
  const restored = JSON.parse(JSON.stringify(state));
  assert.notEqual(createCellDamage(restored, targetCell, 1).id, first.id);
});

test("урон получает нынешний обитатель клетки, а не исходная цель", () => {
  const { runtime, state, queue, outcomes } = fixture();
  const event = createCellDamage(state, targetCell, 2);
  runtime.world.units[1].position = { x: 0, y: 1 };
  runtime.world.units[2].position = { ...targetCell };
  queue.enqueue(event);
  queue.drain();
  assert.equal(runtime.world.units[1].stats.hp, 5);
  assert.equal(runtime.world.units[2].stats.hp, 3);
  assert.equal(outcomes[0].targetId, "replacement");
});

test("пустая клетка, внешняя координата и ловушка без HP не получают урон", () => {
  const { runtime, state, queue, outcomes } = fixture();
  runtime.world.traps.push({
    id: "trap",
    kind: "trap",
    definitionId: "trap",
    position: { x: 0, y: 1 },
  });
  queue.enqueue(
    ...[
      { x: 2, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 1 },
    ].map((cell) => createCellDamage(state, cell, 10)),
  );
  queue.drain();
  assert(outcomes.every((outcome) => outcome.targetId === null && outcome.hpLoss === 0));
  assert.equal(runtime.world.traps.length, 1);
});

test("сопротивление читается при исполнении, hpLoss сохраняет превышение, HP обрезается", () => {
  const { runtime, state, queue, outcomes } = fixture();
  queue.enqueue(
    effect("armor", [
      { kind: "modify_stat", target: byId("target"), stat: "resistance", delta: 3 },
    ]),
    createCellDamage(state, targetCell, 100),
  );
  queue.drain();
  assert.equal(outcomes[0].hpLoss, 97);
  assert.equal(outcomes[0].hpAfter, 0);
  assert.equal(runtime.world.units[1].alive, false);
  assert.equal(runtime.world.units[1].position, null);
});

test("нулевой и поглощённый сопротивлением урон не меняют HP", () => {
  const { runtime, state, queue, outcomes } = fixture();
  runtime.world.units[1].stats.resistance = 5;
  const before = structuredClone(runtime.world);
  queue.enqueue(createCellDamage(state, targetCell, 0), createCellDamage(state, targetCell, 3));
  queue.drain();
  assert.deepEqual(runtime.world, before);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.hpLoss),
    [0, 0],
  );
});

test("смерть атакующего не отменяет уже созданный CELL_DAMAGE", () => {
  const { runtime, state, order, queue, outcomes } = fixture();
  queue.enqueue(
    effect("die", [{ kind: "modify_hp", target: owner, delta: -100 }]),
    createCellDamage(state, targetCell, 2),
    effect("regen", [{ kind: "heal", target: owner, value: 10 }]),
  );
  queue.drain();
  assert.equal(runtime.world.units[0].alive, false);
  assert.equal(runtime.world.units[0].stats.hp, 0);
  assert.equal(runtime.world.units[1].stats.hp, 3);
  assert.deepEqual(order, ["target", "replacement"]);
  assert.equal(outcomes.length, 1);
});

test("созданный урон ждёт конца эффекта и опережает прежнюю очередь", () => {
  const { runtime, queue, outcomes } = fixture();
  queue.enqueue(
    effect("create", [
      { kind: "create_damage_event", target: { kind: "cell" }, amount: 5 },
      { kind: "modify_stat", target: byId("target"), stat: "resistance", delta: 10 },
    ]),
    effect("old", [
      { kind: "modify_stat", target: byId("target"), stat: "resistance", delta: -10 },
    ]),
  );
  queue.drain();
  assert.equal(runtime.world.units[1].stats.hp, 5);
  assert.equal(outcomes[0].hpLoss, 0);
  assert.equal(runtime.world.units[1].stats.resistance, 0);
});

test("modify_hp не создаёт CELL_DAMAGE и игнорирует сопротивление", () => {
  const { runtime, state, queue, outcomes } = fixture();
  runtime.world.units[1].stats.resistance = 100;
  queue.enqueue(effect("direct", [{ kind: "modify_hp", target: byId("target"), delta: -2 }]));
  queue.drain();
  assert.equal(runtime.world.units[1].stats.hp, 3);
  assert.deepEqual(outcomes, []);
  assert.equal(state.nextEventId, 1);
});

test("DEATH после события может создать новый независимый урон", () => {
  const { runtime, state, queue, outcomes } = fixture();
  addEffect(runtime.effects, {
    definitionId: "death",
    ownerId: "target",
    phase: "DEATH",
    state: {},
    operations: [
      { kind: "modify_stat", target: byId("actor"), stat: "strength", delta: 1 },
      { kind: "create_damage_event", target: { kind: "cell" }, amount: 5 },
    ],
  });
  queue.enqueue(
    createCellDamage(state, targetCell, 10),
    effect("old", [{ kind: "heal", target: owner, value: 5 }], "target"),
  );
  queue.drain();
  assert.equal(runtime.world.units[0].stats.strength, 1);
  assert.equal(runtime.world.units[1].stats.hp, 0);
  assert.equal(outcomes.length, 2);
  assert.notEqual(outcomes[0].eventId, outcomes[1].eventId);
  assert.equal(outcomes[1].targetId, null);
});

test("закрытое укрепление сохраняет свойства и запускает DEATH один раз", () => {
  const { runtime, state, queue, outcomes } = fixture();
  const cell = { x: 1, y: 0 };
  const door = {
    id: "door",
    kind: "door",
    state: "closed",
    reinforcement: { hp: 3, maxHP: 8, resistance: 2 },
    interactionMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
  };
  runtime.world.map.cells[1].structure = door;
  addEffect(runtime.effects, {
    definitionId: "rune",
    ownerId: "door",
    phase: "DEATH",
    state: {},
    operations: [{ kind: "modify_stat", target: byId("actor"), stat: "strength", delta: 1 }],
  });
  queue.enqueue(createCellDamage(state, cell, 10), createCellDamage(state, cell, 10));
  queue.drain();
  assert.equal(door.state, "destroyed");
  assert.deepEqual(door.reinforcement, { hp: 0, maxHP: 8, resistance: 2 });
  assert.equal(runtime.effects.instances.length, 1);
  assert.equal(runtime.world.units[0].stats.strength, 1);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.targetId),
    ["door", null],
  );
});

test("открытый проём не повреждается, стоящий в нём юнит получает урон", () => {
  const { runtime, state, queue, outcomes } = fixture();
  const cell = { x: 1, y: 0 };
  const window = {
    id: "window",
    kind: "window",
    state: "open",
    reinforcement: { hp: 3, maxHP: 3, resistance: 0 },
    interactionMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
  };
  runtime.world.map.cells[1].structure = window;
  queue.enqueue(createCellDamage(state, cell, 2));
  queue.drain();
  runtime.world.units[1].position = { ...cell };
  queue.enqueue(createCellDamage(state, cell, 2));
  queue.drain();
  assert.equal(window.reinforcement.hp, 3);
  assert.equal(runtime.world.units[1].stats.hp, 3);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.targetId),
    [null, "target"],
  );
});

test("событие копируется при постановке, неверные числа не расходуют ID", () => {
  const { runtime, state, queue } = fixture();
  const event = createCellDamage(state, targetCell, 2);
  queue.enqueue(event);
  event.cell.x = 2;
  event.amount = 100;
  queue.drain();
  assert.equal(runtime.world.units[1].stats.hp, 3);
  const before = structuredClone(state);

  for (const amount of [-1, 0.5, NaN, Infinity, "1"]) {
    assert.throws(() => createCellDamage(state, targetCell, amount), TypeError);
  }

  assert.throws(() => createCellDamage(state, { x: 0.5, y: 0 }, 1), TypeError);
  assert.deepEqual(state, before);
  assert.throws(
    () => resolveCellDamage(runtime, { ...event, amount: -1 }, ["actor", "target", "replacement"]),
    TypeError,
  );
});

test("очередь CELL_DAMAGE подключается к двум ленивым слотам хода", () => {
  const { runtime, queue, order } = fixture();
  const observedHP = [];
  runUnitTurn(runtime, "actor", () => order, {
    createQueue: () => queue,
    chooseAction: () => {
      observedHP.push(runtime.world.units[1].stats.hp);
      return { kind: "ATTACK" };
    },
    executeAction: function* () {
      yield [
        effect("attack", [{ kind: "create_damage_event", target: { kind: "cell" }, amount: 2 }]),
      ];
    },
  });
  assert.deepEqual(observedHP, [5, 3]);
  assert.equal(runtime.world.units[1].stats.hp, 1);
});
