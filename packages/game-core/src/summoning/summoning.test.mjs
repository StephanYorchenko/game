import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import { createDeathQueue } from "@deathwarriors/game-core/death";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { executeOperation } from "@deathwarriors/game-core/operations";
import { createSummoningState, placeEntity } from "@deathwarriors/game-core/summoning";
import { runUnitTurn } from "@deathwarriors/game-core/turn";

const byId = (id) => ({ kind: "unit", id });
const stats = () => ({
  hp: 5,
  maxHP: 5,
  strength: 1,
  agility: 1,
  damage: 1,
  movement: 0,
  resistance: 0,
});
const mask = () => Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
const template = (effects = []) => ({
  kind: "unit",
  definitionId: "minion",
  side: "enemy",
  stats: stats(),
  attackMask: mask(),
  keywords: [],
  effects,
});
const trap = () => ({ kind: "trap", definitionId: "snare", effects: [] });
const placement = (entity = template()) => ({
  kind: "place_entity",
  target: { kind: "cell" },
  template: entity,
});
const agility = { kind: "modify_stat", target: byId("actor"), stat: "agility", delta: 1 };

function fixture() {
  return {
    world: loadWorld({
      version: 1,
      map: {
        width: 4,
        height: 2,
        cells: Array.from({ length: 8 }, () => ({
          surface: "floor",
          area: "inside",
          structure: null,
        })),
      },
      units: [
        {
          id: "actor",
          kind: "unit",
          definitionId: "fighter",
          side: "defender",
          alive: true,
          position: { x: 0, y: 0 },
          stats: stats(),
          attackMask: mask(),
          keywords: [],
        },
      ],
      traps: [],
    }),
    effects: createEffectStore(),
    summoning: createSummoningState(),
  };
}

function atomic(operations, cell = { x: 1, y: 0 }) {
  return {
    ownerId: "actor",
    instanceId: "atomic",
    definitionId: "atomic",
    phase: "ATTACK_SUCCESS",
    source: "ordinary",
    state: {},
    operations,
    context: {
      kind: "attack",
      ownerId: "actor",
      attackerId: "actor",
      defenderId: "actor",
      cell,
    },
  };
}

test("новый юнит в конце текущего раунда получает два слота и сохраняет место дальше", () => {
  const runtime = fixture();
  const order = ["actor"];
  const turns = [];
  for (const ownerId of order) {
    turns.push(ownerId);
    runUnitTurn(runtime, ownerId, () => order, {
      chooseAction: () => ({ kind: "MOVE" }),
      executeAction: function* (_, { unit, slot }) {
        if (unit.id === "actor" && slot === 1) {
          yield [atomic([placement()])];
        }
      },
    });
  }
  assert.deepEqual(turns, ["actor", "entity:1"]);
  assert.deepEqual(order, turns);
  const nextRound = order.map((ownerId) =>
    runUnitTurn(runtime, ownerId, () => order, {
      chooseAction: () => ({ kind: "MOVE" }),
      executeAction: function* () {},
    }),
  );
  assert.deepEqual(
    nextRound.map((turn) => turn.ownerId),
    turns,
  );
  assert.ok(nextRound.every((turn) => turn.actions.length === 2));
});

test("ловушка ставится на контекстную клетку и не занимает очередь ходов", () => {
  const runtime = fixture();
  const order = ["actor"];
  const queue = createDeathQueue(runtime, () => order);
  const effect = atomic([placement(trap())]);
  queue.enqueue(effect);
  runtime.world.units[0].position = { x: 3, y: 1 };
  queue.drain();
  assert.deepEqual(runtime.world.traps[0].position, { x: 1, y: 0 });
  assert.deepEqual(order, ["actor"]);
});

test("занятая клетка не вытесняется, запасная не ищется, следующие операции работают", () => {
  const runtime = fixture();
  const order = ["actor"];
  const queue = createDeathQueue(runtime, () => order);
  queue.enqueue(atomic([placement(trap()), agility], { x: 0, y: 0 }));
  queue.drain();
  assert.equal(runtime.world.traps.length, 0);
  assert.equal(runtime.world.units.length, 1);
  assert.equal(runtime.world.units[0].stats.agility, 2);
  assert.equal(runtime.summoning.nextEntityId, 1);
});

test("две операции на одной клетке проверяют её занятость отдельно при исполнении", () => {
  const runtime = fixture();
  const order = ["actor"];
  const queue = createDamageQueue(runtime, createDamageState(), () => order);
  queue.enqueue(atomic([placement(), placement(), agility]));
  queue.drain();
  assert.deepEqual(order, ["actor", "entity:1"]);
  assert.equal(runtime.world.units.length, 2);
  assert.equal(runtime.summoning.nextEntityId, 2);
  assert.equal(runtime.world.units[0].stats.agility, 2);
});

test("SUMMON ждёт остальных операций, но новая сущность видна им сразу", () => {
  const runtime = fixture();
  const order = ["actor"];
  const summoned = template([
    {
      definitionId: "arrival",
      phase: "SUMMON",
      state: {},
      operations: [
        {
          kind: "modify_stat",
          target: { kind: "owner" },
          stat: "damage",
          delta: { kind: "stat", target: byId("actor"), stat: "agility" },
        },
      ],
    },
  ]);
  const queue = createDamageQueue(runtime, createDamageState(), () => order);
  queue.enqueue(
    atomic([
      placement(summoned),
      { kind: "modify_stat", target: byId("entity:1"), stat: "damage", delta: 3 },
      { ...agility, delta: 5 },
    ]),
  );
  queue.drain();
  assert.equal(runtime.world.units[1].stats.damage, 10);
  assert.equal(runtime.effects.instances[0].ownerId, "entity:1");
  summoned.stats.damage = 100;
  summoned.effects[0].state.changed = true;
  assert.equal(runtime.world.units[1].stats.damage, 10);
  assert.deepEqual(runtime.effects.instances[0].state, {});
});

test("призыв из DEATH занимает освобождённую клетку новым ID без воскрешения", () => {
  const runtime = fixture();
  const order = ["actor"];
  addEffect(runtime.effects, {
    ownerId: "actor",
    definitionId: "replacement",
    phase: "DEATH",
    state: {},
    operations: [placement(), { kind: "heal", target: byId("actor"), value: 5 }],
  });
  const queue = createDeathQueue(runtime, () => order);
  queue.enqueue(atomic([{ kind: "modify_hp", target: byId("actor"), delta: -5 }]));
  queue.drain();
  assert.equal(runtime.world.units[0].alive, false);
  assert.equal(runtime.world.units[0].position, null);
  assert.equal(runtime.world.units[0].stats.hp, 0);
  assert.deepEqual(runtime.world.units[1].position, { x: 0, y: 0 });
  assert.deepEqual(order, ["entity:1"]);
});

test("стены/закрытые проёмы/ловушки/внешняя область защитника блокируют размещение", () => {
  const runtime = fixture();
  const order = ["actor"];
  const at = { x: 1, y: 0 };
  const place = (entity = template()) => placeEntity(runtime, runtime.summoning, order, at, entity);
  assert.equal(
    placeEntity(runtime, runtime.summoning, order, { x: 9, y: 0 }, template()).reason,
    "invalid_cell",
  );
  runtime.world.map.cells[1].structure = { id: "wall", kind: "wall" };
  assert.equal(place().reason, "blocked");
  runtime.world.map.cells[1].structure = {
    id: "door",
    kind: "door",
    state: "closed",
    reinforcement: null,
    interactionMask: mask(),
  };
  assert.equal(place().reason, "blocked");
  runtime.world.map.cells[1].structure = null;
  runtime.world.map.cells[1].area = "outside";
  assert.equal(place({ ...template(), side: "defender" }).reason, "outside");
  runtime.world.traps.push({ id: "existing", kind: "trap", definitionId: "snare", position: at });
  assert.equal(place().reason, "occupied");
  assert.equal(runtime.summoning.nextEntityId, 1);
});

test("счётчик переживает JSON, пропускает конфликты с погибшими и структурами", () => {
  const runtime = fixture();
  const order = ["actor"];
  runtime.world.map.cells[7].structure = { id: "entity:1", kind: "wall" };
  runtime.world.units.push({
    ...runtime.world.units[0],
    id: "entity:2",
    alive: false,
    position: null,
    stats: { ...stats(), hp: 0 },
  });
  const first = placeEntity(runtime, runtime.summoning, order, { x: 1, y: 0 }, template());
  assert.equal(first.entity.id, "entity:3");
  const restored = JSON.parse(JSON.stringify({ runtime, order }));
  const second = placeEntity(
    restored.runtime,
    restored.runtime.summoning,
    restored.order,
    { x: 2, y: 0 },
    template(),
  );
  assert.equal(second.entity.id, "entity:4");
  assert.deepEqual(restored.order, ["actor", "entity:3", "entity:4"]);
});

test("неверный шаблон/эффект не оставляет половину призыва и не расходует ID", () => {
  const runtime = fixture();
  const order = ["actor"];
  const before = JSON.stringify({ runtime, order });
  const bad = template();
  bad.stats.hp = -1;
  assert.throws(() => placeEntity(runtime, runtime.summoning, order, { x: 1, y: 0 }, bad));
  const badEffects = template([
    { definitionId: "valid", phase: "TURN_START", operations: [], state: {} },
    { definitionId: "invalid", phase: "BAD_PHASE", operations: [], state: {} },
  ]);
  assert.throws(() => placeEntity(runtime, runtime.summoning, order, { x: 1, y: 0 }, badEffects));
  assert.equal(JSON.stringify({ runtime, order }), before);
});

test("отсутствующая семантическая клетка пропускается, отсутствующий сервис — ошибка", () => {
  const runtime = fixture();
  const effect = {
    ...atomic([placement(), agility]),
    context: { kind: "phase", ownerId: "actor" },
  };
  const queue = createDeathQueue(runtime, () => ["actor"]);
  queue.enqueue(effect);
  queue.drain();
  assert.equal(runtime.world.units.length, 1);
  assert.equal(runtime.world.units[0].stats.agility, 2);
  assert.throws(() => executeOperation(runtime, atomic([]), placement()), /поддержкой призыва/);
});
