import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { createEffectStore } from "@deathwarriors/game-core/effects";
import {
  addDamageModifier,
  consumeDamageModifiers,
  createCellDamage,
  createDamageModifiers,
  createDamageQueue,
  createDamageState,
  registerDamageEvent,
} from "@deathwarriors/game-core/damage";

const relative = (value) => ({ type: "relative", value });
const absolute = (value) => ({ type: "absolute", value });

test("pop-порядок absolute/relative меняет результат, обрезание происходит после каждой записи", () => {
  const mods = createDamageModifiers();
  registerDamageEvent(mods, "E101");
  addDamageModifier(mods, "E101", relative(2));
  addDamageModifier(mods, "E101", absolute(4));
  const stack = mods.stacks.E101;
  assert.equal(consumeDamageModifiers(mods, "E101", 3), 6);
  assert.equal(stack.length, 0);
  assert.equal(Object.hasOwn(mods.stacks, "E101"), false);
  registerDamageEvent(mods, "E102");
  addDamageModifier(mods, "E102", absolute(4));
  addDamageModifier(mods, "E102", relative(2));
  assert.equal(consumeDamageModifiers(mods, "E102", 3), 4);
  registerDamageEvent(mods, "clamp");
  addDamageModifier(mods, "clamp", relative(5));
  addDamageModifier(mods, "clamp", relative(-100));
  assert.equal(consumeDamageModifiers(mods, "clamp", 3), 5);
});

test("неверные записи не меняют стек, модификатор не содержит операций или обработчиков", () => {
  const mods = createDamageModifiers();
  registerDamageEvent(mods, "E101");

  for (const modifier of [
    relative(0.5),
    relative(Infinity),
    absolute(-1),
    { type: "multiply", value: 2 },
    { ...relative(1), operations: [] },
  ]) {
    assert.throws(() => addDamageModifier(mods, "E101", modifier), TypeError);
  }

  assert.deepEqual(mods.stacks.E101, []);
  const entry = relative(2);
  addDamageModifier(mods, "E101", entry);
  entry.value = 100;
  assert.equal(consumeDamageModifiers(mods, "E101", 3), 5);
});

test("неизвестное и уже разрешённое событие не создаются при добавлении модификатора", () => {
  const mods = createDamageModifiers();
  assert.equal(addDamageModifier(mods, "missing", relative(1)), false);
  registerDamageEvent(mods, "E101");
  consumeDamageModifiers(mods, "E101", 3);
  assert.equal(addDamageModifier(mods, "E101", relative(1)), false);
  assert.deepEqual(mods.stacks, {});
});

test("JSON сохраняет независимые стеки и их порядок", () => {
  const mods = createDamageModifiers();
  registerDamageEvent(mods, "E101");
  registerDamageEvent(mods, "E102");
  addDamageModifier(mods, "E101", relative(2));
  addDamageModifier(mods, "E101", absolute(4));
  const restored = JSON.parse(JSON.stringify(mods));
  assert.equal(consumeDamageModifiers(restored, "E101", 3), 6);
  assert.equal(consumeDamageModifiers(restored, "E102", 2), 2);
  assert.equal(mods.stacks.E101.length, 2);
});

function fixture() {
  const runtime = {
    world: loadWorld({
      version: 1,
      map: {
        width: 3,
        height: 2,
        cells: Array.from({ length: 6 }, () => ({
          surface: "floor",
          area: "inside",
          structure: null,
        })),
      },
      units: ["actor", "first", "second"].map((id, x) => ({
        id,
        kind: "unit",
        definitionId: "fighter",
        side: x === 0 ? "defender" : "enemy",
        alive: true,
        position: { x, y: 0 },
        stats: {
          hp: 20,
          maxHP: 20,
          strength: 1,
          agility: 1,
          damage: 1,
          movement: 1,
          resistance: x === 1 ? 2 : 0,
        },
        attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
        keywords: [],
      })),
      traps: [],
    }),
    effects: createEffectStore(),
  };
  const state = createDamageState();
  const modifiers = createDamageModifiers();
  const outcomes = [];
  const queue = createDamageQueue(
    runtime,
    state,
    () => ["actor", "first", "second"],
    (outcome) => outcomes.push(outcome),
    modifiers,
  );
  return { runtime, state, modifiers, outcomes, queue };
}

const fx = (id, operations, eventId) => ({
  ownerId: "actor",
  instanceId: id,
  definitionId: id,
  phase: "ATTACK_SUCCESS",
  source: "ordinary",
  operations,
  state: {},
  context: {
    kind: "attack",
    ownerId: "actor",
    attackerId: "actor",
    defenderId: "first",
    cell: { x: 2, y: 0 },
    damageEventId: eventId,
  },
});

test("E101/E102: создание дополнительного события не меняет исходный ID контекста", () => {
  const { runtime, state, modifiers, outcomes, queue } = fixture();
  const first = createCellDamage(state, { x: 1, y: 0 }, 3, modifiers);
  queue.enqueue(
    fx(
      "outcomes",
      [
        { kind: "add_damage_modifier", event: { kind: "context_damage" }, modifier: relative(2) },
        { kind: "create_damage_event", target: { kind: "cell" }, amount: 2 },
        { kind: "add_damage_modifier", event: { kind: "context_damage" }, modifier: absolute(4) },
      ],
      first.id,
    ),
    first,
  );
  queue.drain();
  assert.deepEqual(
    outcomes.map((o) => o.amount),
    [2, 3],
  );
  const original = outcomes.find((o) => o.eventId === first.id);
  assert.equal(original.resolvedAmount, 6);
  assert.equal(original.hpLoss, 4);
  assert.equal(runtime.world.units[1].stats.hp, 16);
  assert.equal(runtime.world.units[2].stats.hp, 18);
  assert.deepEqual(modifiers.stacks, {});
});

test("нулевой исходный урон может стать положительным; отрицательный relative не лечит", () => {
  const { runtime, state, modifiers, outcomes, queue } = fixture();
  const first = createCellDamage(state, { x: 1, y: 0 }, 0, modifiers);
  const second = createCellDamage(state, { x: 2, y: 0 }, 5, modifiers);
  addDamageModifier(modifiers, first.id, relative(5));
  addDamageModifier(modifiers, second.id, relative(-100));
  queue.enqueue(first, second);
  queue.drain();
  assert.deepEqual(
    outcomes.map((o) => o.hpLoss),
    [3, 0],
  );
  assert.equal(runtime.world.units[1].stats.hp, 17);
  assert.equal(runtime.world.units[2].stats.hp, 20);
});

test("адресный модификатор использует текущий параметр, отсутствие события не мешает остальным операциям", () => {
  const { runtime, state, modifiers, outcomes, queue } = fixture();
  const event = createCellDamage(state, { x: 1, y: 0 }, 3, modifiers);
  queue.enqueue(
    fx(
      "address",
      [
        {
          kind: "add_damage_modifier",
          event: { kind: "event", id: "missing" },
          modifier: relative(1),
        },
        {
          kind: "add_damage_modifier",
          event: { kind: "event", id: event.id },
          modifier: {
            type: "relative",
            value: { kind: "stat", target: { kind: "owner" }, stat: "strength" },
          },
        },
        { kind: "modify_stat", target: { kind: "owner" }, stat: "strength", delta: 1 },
      ],
      event.id,
    ),
    event,
  );
  queue.drain();
  assert.equal(outcomes[0].hpLoss, 2);
  assert.equal(runtime.world.units[0].stats.strength, 2);
});

test("пустая клетка всё равно потребляет свой стек и не меняет другое событие", () => {
  const { state, modifiers, queue, outcomes } = fixture();
  const event = createCellDamage(state, { x: 0, y: 1 }, 3, modifiers);
  addDamageModifier(modifiers, event.id, absolute(0));
  queue.enqueue(event);
  queue.drain();
  assert.equal(outcomes[0].targetId, null);
  assert.equal(outcomes[0].resolvedAmount, 0);
  assert.deepEqual(modifiers.stacks, {});
});
