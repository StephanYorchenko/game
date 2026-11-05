import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld, createMoveState, executeMove } from "@deathwarriors/game-core";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { createDeathQueue } from "@deathwarriors/game-core/death";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { runUnitTurn } from "@deathwarriors/game-core/turn";
import { resolveTargets } from "@deathwarriors/game-core/targets";
import {
  createJournalDamageQueue,
  recordSimulation,
  replaySimulation,
} from "@deathwarriors/game-core/journal";

const mask = [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
function fixture(side = "enemy", movement = 3) {
  const unit = (id, faction, x) => ({
    id,
    kind: "unit",
    definitionId: "fighter",
    side: faction,
    alive: true,
    position: { x, y: 1 },
    stats: { hp: 5, maxHP: 5, strength: 1, agility: 1, damage: 1, movement, resistance: 0 },
    attackMask: mask,
    keywords: [],
  });
  return {
    runtime: {
      world: loadWorld({
        version: 1,
        map: {
          width: 7,
          height: 3,
          cells: Array.from({ length: 21 }, () => ({
            surface: "floor",
            area: "inside",
            structure: null,
          })),
        },
        units: [unit("actor", side, 0), unit("target", side === "enemy" ? "defender" : "enemy", 6)],
        traps: [{ id: "trap", kind: "trap", definitionId: "snare", position: { x: 1, y: 1 } }],
      }),
      effects: createEffectStore(),
      movement: createMoveState(),
    },
    damage: createDamageState(),
    order: ["actor", "target"],
  };
}
const owner = (state) => state.runtime.world.units[0];
const occupant = { kind: "occupant" };
const options = () => ({ knownEnemyIds: ["target"], movement: { directions: ["east"] } });
const damage = (amount) => ({ kind: "create_damage_event", target: { kind: "cell" }, amount });
const speed = (delta) => ({ kind: "modify_stat", target: occupant, stat: "movement", delta });
const add = (state, operations, id = "trap-ability", trapId = "trap") =>
  addEffect(state.runtime.effects, {
    ownerId: trapId,
    definitionId: id,
    phase: "DEATH",
    operations,
    state: {},
  });
const forced = (cell, operations = [{ kind: "move_unit", target: { kind: "owner" } }]) => ({
  ownerId: "actor",
  instanceId: "push",
  definitionId: "push",
  source: "ordinary",
  phase: "ACTION_START",
  context: { kind: "move_end", ownerId: "actor", cell },
  state: {},
  operations,
});
const makeQueue = (state) => createDamageQueue(state.runtime, state.damage, () => state.order);
const move = (state, queue = makeQueue(state)) => {
  const iterator = executeMove(
    state.runtime,
    "actor",
    { kind: "unit", id: "target" },
    createSeededRng(25),
    options,
  );
  let next = iterator.next();
  while (!next.done) {
    queue.enqueue(...next.value);
    queue.drain();
    next = iterator.next();
  }
  return next.value;
};

test("ловушка удаляется до переноса, DEATH начинается после целого эффекта, CELL_DAMAGE бьёт вошедшего", () => {
  const state = fixture();
  add(state, [damage(2)]);
  const snapshots = [];
  const queue = makeQueue(state).observe({
    before: (entry) => {
      if (entry.definitionId === "trap-ability") {
        snapshots.push({
          position: { ...owner(state).position },
          traps: state.runtime.world.traps.length,
          hp: owner(state).stats.hp,
          source: entry.source,
        });
      }
    },
  });
  const result = move(state, queue);
  assert.deepEqual(snapshots, [{ position: { x: 1, y: 1 }, traps: 0, hp: 5, source: "death" }]);
  assert.deepEqual(result, { stepsTaken: 3, reason: "budget_exhausted" });
  assert.equal(owner(state).stats.hp, 3);
  assert.deepEqual(owner(state).position, { x: 3, y: 1 });
  loadWorld(state.runtime.world);
});

test("ловушка без последствий не наносит обязательного урона или травмы", () => {
  const state = fixture();
  move(state);
  assert.equal(owner(state).stats.hp, 5);
  assert.equal(state.runtime.world.traps.length, 0);
  assert.equal(state.runtime.effects.instances.length, 0);
});

test("DEATH ловушки может менять скорость и добавлять эффект текущему обитателю клетки", () => {
  for (const [initial, delta, expected] of [
    [3, -2, 1],
    [1, 2, 3],
  ]) {
    const state = fixture("enemy", initial);
    add(state, [
      speed(delta),
      {
        kind: "add_effect",
        target: occupant,
        effect: {
          definitionId: "wound",
          phase: "TURN_START",
          state: {},
          operations: [{ kind: "modify_hp", target: { kind: "owner" }, delta: -1 }],
        },
      },
    ]);
    assert.equal(move(state).stepsTaken, expected);
    assert(
      state.runtime.effects.instances.some(
        (effect) => effect.ownerId === "actor" && effect.definitionId === "wound",
      ),
    );
  }
});

test("смертельные последствия шага останавливают MOVE и завершающие фазы погибшего", () => {
  const state = fixture();
  add(state, [damage(5)]);
  const phases = [];
  const queue = makeQueue(state);
  const result = runUnitTurn(state.runtime, "actor", () => state.order, {
    chooseAction: () => ({ kind: "MOVE" }),
    executeAction: () =>
      executeMove(
        state.runtime,
        "actor",
        { kind: "unit", id: "target" },
        createSeededRng(25),
        options,
      ),
    createQueue: () => queue,
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(result.status, "dead");
  assert.equal(result.actions.length, 1);
  assert.deepEqual(phases, ["TURN_START", "ACTION_START"]);
  assert.equal(owner(state).position, null);
  assert.deepEqual(state.order, ["target"]);
  assert.deepEqual(state.runtime.movement.active, []);
});

test("принудительный перенос защитника срабатывает даже на известной ловушке", () => {
  const state = fixture("defender", 0);
  add(state, [{ kind: "modify_hp", target: occupant, delta: -1 }]);
  const queue = createDeathQueue(state.runtime, () => state.order);
  queue.enqueue(forced({ x: 1, y: 1 }));
  queue.drain();
  assert.deepEqual(owner(state).position, { x: 1, y: 1 });
  assert.equal(owner(state).stats.hp, 4);
  assert.equal(state.runtime.world.traps.length, 0);
  assert.equal(state.runtime.movement.nextMoveId, 1);
});

test("обычное движение не наступает на известную врагу ловушку", () => {
  const state = fixture();
  const iterator = executeMove(
    state.runtime,
    "actor",
    { kind: "unit", id: "target" },
    createSeededRng(25),
    () => ({
      movement: { directions: ["east"], knownTrapIds: ["trap"] },
    }),
  );
  assert.deepEqual(iterator.next(), { done: true, value: { stepsTaken: 0, reason: "no_route" } });
  assert.equal(state.runtime.world.traps.length, 1);
});

test("последующие операции родителя исполняются до снимка DEATH ловушки", () => {
  const state = fixture();
  const original = add(state, [damage(5)]);
  const queue = makeQueue(state);
  queue.enqueue(
    forced({ x: 1, y: 1 }, [
      { kind: "move_unit", target: { kind: "owner" } },
      { kind: "remove_effect", instance: { kind: "instance", id: original } },
    ]),
  );
  queue.drain();
  assert.equal(owner(state).stats.hp, 5);
  assert.equal(state.runtime.effects.instances.length, 0);
});

test("невозможность переноса не отменяет уже выполненное удаление ловушки", () => {
  const state = fixture();
  state.runtime.world.map.cells[8].structure = { id: "wall", kind: "wall" };
  add(state, [{ kind: "modify_counter", instance: { kind: "self" }, name: "fired", delta: 1 }]);
  state.runtime.effects.instances[0].state.fired = 0;
  const queue = makeQueue(state);
  queue.enqueue(forced({ x: 1, y: 1 }));
  queue.drain();
  assert.equal(state.runtime.world.traps.length, 0);
  assert.deepEqual(owner(state).position, { x: 0, y: 1 });
  assert.equal(state.runtime.effects.instances[0].state.fired, 1);
});

test("два входа в разные ловушки разрешаются полностью между шагами без общего запрета способности", () => {
  const state = fixture();
  state.runtime.world.traps.push({
    id: "trap-2",
    kind: "trap",
    definitionId: "snare",
    position: { x: 2, y: 1 },
  });
  add(state, [damage(1)]);
  add(state, [damage(1)], "trap-ability", "trap-2");
  const entries = [];
  move(
    state,
    makeQueue(state).observe({
      before: (entry) => entries.push(entry.definitionId ?? entry.kind),
    }),
  );
  assert.deepEqual(entries, [
    "engine:move_step",
    "trap-ability",
    "CELL_DAMAGE",
    "engine:move_step",
    "trap-ability",
    "CELL_DAMAGE",
    "engine:move_step",
  ]);
  assert.equal(owner(state).stats.hp, 3);
  assert.equal(state.runtime.world.traps.length, 0);
});

test("DEATH ловушки наследует причинную цепочку и блокирует повтор definitionId родителя", () => {
  const state = fixture();
  add(state, [damage(5)], "push");
  const skipped = [];
  const queue = makeQueue(state).observe({ skipped: (entry) => skipped.push(entry) });
  queue.enqueue(forced({ x: 1, y: 1 }));
  queue.drain();
  assert.equal(owner(state).stats.hp, 5);
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0].cause, { definitionIds: ["push"] });
});

test("occupant разрешается по текущей клетке контекста и явно недоступен без неё", () => {
  const state = fixture();
  const phase = { kind: "phase", ownerId: "actor" };
  assert.equal(resolveTargets(state.runtime.world, phase, occupant).reason, "missing_context");
  assert.deepEqual(
    resolveTargets(
      state.runtime.world,
      { kind: "death", ownerId: "trap", cell: { x: 2, y: 1 } },
      occupant,
    ),
    { kind: "entities", entities: [] },
  );
  const resolved = resolveTargets(
    state.runtime.world,
    { kind: "death", ownerId: "trap", cell: { x: 0, y: 1 } },
    occupant,
  );
  assert.equal(resolved.entities[0].id, "actor");
});

test("журнал и JSON replay сохраняют шаги, удаление ловушки и независимые последствия", () => {
  const initial = fixture();
  add(initial, [damage(2), speed(-1)]);
  const runner = (state, journal, rng) => {
    const queue = createJournalDamageQueue(journal, state.runtime, state.damage, () => state.order);
    const iterator = executeMove(
      state.runtime,
      "actor",
      { kind: "unit", id: "target" },
      rng,
      options,
    );
    let next = iterator.next();
    while (!next.done) {
      queue.enqueue(...next.value);
      queue.drain();
      next = iterator.next();
    }
    return { ...state, result: next.value };
  };
  const recording = recordSimulation(initial, 25, runner);
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), runner).matches, true);
  assert.equal(recording.final.runtime.world.traps.length, 0);
  assert.equal(recording.final.runtime.world.units[0].stats.hp, 3);
  assert(!recording.entries.some((entry) => entry.kind === "trap_triggered"));
  assert.equal(initial.runtime.world.traps.length, 1);
});
