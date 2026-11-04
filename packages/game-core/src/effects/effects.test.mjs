import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionQueue } from "@deathwarriors/game-core/execution";
import {
  EFFECT_PHASES,
  addEffect,
  createEffectStore,
  modifyEffectCounter,
  removeEffect,
  snapshotPhase,
} from "@deathwarriors/game-core/effects";

const definition = (overrides = {}) => ({
  definitionId: "bleeding",
  ownerId: "actor",
  phase: "TURN_START",
  operations: [{ type: "record", value: { amount: 1 } }],
  state: { remaining: 3, data: { history: [1, 2] } },
  ...overrides,
});

test("одинаковые определения дают независимые экземпляры с разными ID", () => {
  const store = createEffectStore();
  const input = definition();
  const first = addEffect(store, input);
  const second = addEffect(store, input);
  assert.notEqual(first, second);
  assert.equal(store.instances.length, 2);

  input.state.data.history.push(100);
  input.operations[0].value.amount = 100;
  store.instances[0].state.remaining = 1;
  assert.equal(store.instances[1].state.remaining, 3);
  assert.deepEqual(store.instances[0].state.data.history, [1, 2]);
  assert.equal(store.instances[0].operations[0].value.amount, 1);
});

test("каждый экземпляр принадлежит одной фазе и владельцу, снимок сохраняет LIFO", () => {
  const store = createEffectStore();
  const old = addEffect(store, definition());
  addEffect(store, definition({ ownerId: "other" }));
  addEffect(store, definition({ phase: "TURN_END" }));
  const recent = addEffect(store, definition());
  assert.deepEqual(
    snapshotPhase(store, "actor", "TURN_START").map((e) => e.instanceId),
    [recent, old],
  );
  assert.equal(snapshotPhase(store, "actor", "TURN_END").length, 1);
  assert.equal(snapshotPhase(store, "other", "TURN_START").length, 1);
  assert.equal(snapshotPhase(store, "missing", "TURN_START").length, 0);
  assert.equal(store.instances.length, 4);
});

test("добавление после входа в фазу ждёт следующего снимка", () => {
  const store = createEffectStore();
  const original = addEffect(store, definition());
  const scheduled = snapshotPhase(store, "actor", "TURN_START");
  const recent = addEffect(store, definition());
  assert.deepEqual(
    scheduled.map((e) => e.instanceId),
    [original],
  );
  assert.deepEqual(
    snapshotPhase(store, "actor", "TURN_START").map((e) => e.instanceId),
    [recent, original],
  );
});

test("удаление оригинала не отменяет копию в очереди и не удаляет одинаковый эффект", () => {
  const store = createEffectStore();
  const first = addEffect(store, definition());
  const second = addEffect(store, definition());
  const executed = [];
  const queue = new ExecutionQueue({
    isOwnerAlive: () => true,
    canExecute: () => true,
    execute: (_, context) => {
      executed.push(context.effect.instanceId);
    },
  });
  queue.enqueue(...snapshotPhase(store, "actor", "TURN_START"));
  assert.equal(removeEffect(store, first), true);
  assert.equal(removeEffect(store, first), false);
  queue.drain();
  assert.deepEqual(executed, [second, first]);
  assert.deepEqual(
    store.instances.map((e) => e.instanceId),
    [second],
  );
});

test("состояние и вложенные операции копии полностью отделены от локального экземпляра", () => {
  const store = createEffectStore();
  const id = addEffect(store, definition());
  const [copy] = snapshotPhase(store, "actor", "TURN_START");
  modifyEffectCounter(store, id, "remaining", -1);
  store.instances[0].operations[0].value.amount = 5;
  assert.equal(copy.state.remaining, 3);
  assert.equal(copy.operations[0].value.amount, 1);

  copy.state.data.history.push(3);
  copy.state.remaining = 0;
  copy.operations[0].value.amount = 10;
  assert.equal(store.instances[0].state.remaining, 2);
  assert.deepEqual(store.instances[0].state.data.history, [1, 2]);
  assert.equal(store.instances[0].operations[0].value.amount, 5);
});

test("исполнение копии не уменьшает постоянный счётчик без явной адресной операции", () => {
  const store = createEffectStore();
  const id = addEffect(
    store,
    definition({ operations: [{ type: "local" }, { type: "explicit" }] }),
  );
  const queue = new ExecutionQueue({
    isOwnerAlive: () => true,
    canExecute: () => true,
    execute: (operation, context) => {
      if (operation.type === "local") {
        context.effect.state.remaining -= 1;
        assert.equal(store.instances[0].state.remaining, 3);
      } else {
        assert.equal(modifyEffectCounter(store, context.effect.instanceId, "remaining", -1), true);
      }
    },
  });
  queue.enqueue(...snapshotPhase(store, "actor", "TURN_START"));
  queue.drain();
  assert.equal(store.instances[0].state.remaining, 2);
  assert.equal(store.instances[0].instanceId, id);
});

test("два входа в фазу создают независимые копии без автоматического снятия", () => {
  const store = createEffectStore();
  addEffect(store, definition());
  const [first] = snapshotPhase(store, "actor", "TURN_START");
  const [second] = snapshotPhase(store, "actor", "TURN_START");
  first.state.data.history.push(3);
  assert.deepEqual(second.state.data.history, [1, 2]);
  assert.equal(store.instances.length, 1);
});

test("неосуществимое изменение счётчика пропускается, отрицательные значения не обрезаются", () => {
  const store = createEffectStore();
  const id = addEffect(store, definition());
  assert.equal(modifyEffectCounter(store, id, "missing", -1), false);
  assert.equal(modifyEffectCounter(store, id, "data", -1), false);
  assert.equal(modifyEffectCounter(store, "missing", "remaining", -1), false);
  assert.equal(modifyEffectCounter(store, id, "remaining", -5), true);
  assert.equal(store.instances[0].state.remaining, -2);
  assert.equal(store.instances.length, 1);
  removeEffect(store, id);
  assert.equal(modifyEffectCounter(store, id, "remaining", 1), false);
});

test("хранилище переживает JSON-снимок и не переиспользует удалённые ID", () => {
  const store = createEffectStore();
  const id = addEffect(store, definition());
  const removed = addEffect(store, definition());
  modifyEffectCounter(store, id, "remaining", -3);
  removeEffect(store, removed);
  const restored = JSON.parse(JSON.stringify(store));
  assert.deepEqual(restored, store);
  const next = addEffect(restored, definition());
  assert.notEqual(next, removed);
  assert.deepEqual(
    snapshotPhase(restored, "actor", "TURN_START").map((e) => e.state.remaining),
    [3, 0],
  );
});

test("все подтверждённые фазы поддержаны, исключение жизни есть только у снимка DEATH", () => {
  const store = createEffectStore();

  for (const phase of EFFECT_PHASES) {
    addEffect(store, definition({ phase }));
  }

  const executed = [];
  const queue = new ExecutionQueue({
    isOwnerAlive: () => false,
    canExecute: () => true,
    execute: (_, context) => {
      executed.push(context.effect.phase);
    },
  });

  for (const phase of EFFECT_PHASES) {
    const copies = snapshotPhase(store, "actor", phase);
    assert.equal(copies[0].source, phase === "DEATH" ? "death" : "ordinary");
    queue.enqueue(...copies);
  }

  queue.drain();
  assert.deepEqual(executed, ["DEATH"]);
  assert(!EFFECT_PHASES.includes("ON_DAMAGED"));
});

test("некорректные определения не добавляются и не расходуют ID", () => {
  const store = createEffectStore();
  const cyclic = {};
  cyclic.self = cyclic;
  const bad = [
    { ownerId: "" },
    { definitionId: "" },
    { phase: "ON_DAMAGED" },
    { phase: ["TURN_START", "TURN_END"] },
    { state: null },
    { state: [] },
    { state: new Date() },
    { state: { value: NaN } },
    { state: { value: undefined } },
    { state: { value: () => 1 } },
    { state: cyclic },
    { operations: new Array(1) },
    { operations: [{ value: Infinity }] },
  ];

  for (const patch of bad) {
    assert.throws(() => addEffect(store, definition(patch)), TypeError);
    assert.deepEqual(store, { nextInstanceId: 1, instances: [] });
  }
});

test("неверные изменения счётчика и повреждённый генератор ID не меняют состояние", () => {
  const store = createEffectStore();
  const id = addEffect(store, definition());
  const before = structuredClone(store);

  for (const delta of [NaN, Infinity, 0.5, "1"]) {
    assert.throws(() => modifyEffectCounter(store, id, "remaining", delta), RangeError);
  }

  assert.deepEqual(store, before);
  store.nextInstanceId = 1;
  assert.throws(() => addEffect(store, definition()), /Повторный instanceId/);
  assert.equal(store.instances.length, 1);
});
