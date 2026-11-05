import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { checkUnitAttack, resolveUnitAttack } from "@deathwarriors/game-core/combat";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import {
  createJournalDamageQueue,
  EventJournal,
  journalRng,
} from "@deathwarriors/game-core/journal";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { runUnitTurn } from "@deathwarriors/game-core/turn";

const byId = (id) => ({ kind: "unit", id });
const owner = { kind: "owner" };
const modifier = (value) => ({
  kind: "add_damage_modifier",
  event: { kind: "context_damage" },
  modifier: { type: "relative", value },
});

function fixture() {
  const runtime = {
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
      units: ["actor", "target", "other"].map((id, index) => ({
        id,
        kind: "unit",
        definitionId: "fighter",
        side: index === 0 ? "defender" : "enemy",
        alive: true,
        position: { x: index === 2 ? 3 : index, y: index === 2 ? 1 : 0 },
        stats: {
          hp: 10,
          maxHP: 10,
          strength: 1,
          agility: 1,
          damage: 3,
          movement: 0,
          resistance: 0,
        },
        attackMask: Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]),
        keywords: [],
      })),
      traps: [],
    }),
    effects: createEffectStore(),
  };
  const damage = createDamageState();
  const order = ["actor", "target", "other"];
  const outcomes = [];
  const queue = createDamageQueue(
    runtime,
    damage,
    () => order,
    (o) => outcomes.push(o),
  );
  return { runtime, damage, order, outcomes, queue };
}

function dice(...values) {
  let index = 0;
  return {
    d6: () => {
      assert.ok(index < values.length, "лишний бросок");
      return values[index++];
    },
  };
}

const add = (runtime, ownerId, phase, operations, name = phase) =>
  addEffect(runtime.effects, {
    ownerId,
    phase,
    operations,
    definitionId: name,
    state: {},
  });

test("строгий успех создаёт урон, ничья и промах исполняют только неуспешные фазы", () => {
  for (const [rolls, success] of [
    [[6, 1], true],
    [[3, 3], false],
    [[1, 6], false],
  ]) {
    const { runtime, queue, damage, outcomes } = fixture();
    const seen = [];
    for (const [id, phase] of [
      ["actor", "ATTACK_SUCCESS"],
      ["actor", "ATTACK_FAILURE"],
      ["target", "DEFENSE_SUCCESS"],
      ["target", "DEFENSE_FAILURE"],
    ]) {
      add(runtime, id, phase, []);
    }
    queue.observe({ before: (entry) => seen.push(entry.phase ?? entry.kind) });
    const result = resolveUnitAttack(runtime, queue, "actor", "target", dice(...rolls));
    assert.equal(result.success, success);
    assert.deepEqual(
      seen,
      success
        ? ["ATTACK_SUCCESS", "DEFENSE_FAILURE", "CELL_DAMAGE"]
        : ["ATTACK_FAILURE", "DEFENSE_SUCCESS"],
    );
    assert.equal(runtime.world.units[1].stats.hp, success ? 7 : 10);
    assert.equal(damage.nextEventId, success ? 2 : 1);
    assert.equal(outcomes.length, success ? 1 : 0);
    assert.equal(result.damageEventId, success ? "damage:1" : null);
  }
});

test("нулевой урон успешной атаки получает модификаторы обеих фаз до сопротивления", () => {
  const { runtime, queue, outcomes } = fixture();
  runtime.world.units[0].stats.damage = 0;
  runtime.world.units[1].stats.resistance = 1;
  add(runtime, "actor", "ATTACK_SUCCESS", [modifier(2)]);
  add(runtime, "target", "DEFENSE_FAILURE", [modifier(3)]);
  const result = resolveUnitAttack(runtime, queue, "actor", "target", dice(6, 1));
  assert.equal(result.success, true);
  assert.equal(outcomes[0].amount, 0);
  assert.equal(outcomes[0].resolvedAmount, 5);
  assert.equal(outcomes[0].hpLoss, 4);
  assert.equal(runtime.world.units[1].stats.hp, 6);
});

test("LIFO атаки завершается до снимка защиты; новые защитные эффекты входят в её фазу", () => {
  const { runtime, queue, outcomes } = fixture();
  const seen = [];
  add(runtime, "actor", "ATTACK_SUCCESS", [modifier(1)], "old");
  add(
    runtime,
    "actor",
    "ATTACK_SUCCESS",
    [
      {
        kind: "add_effect",
        target: byId("target"),
        effect: {
          definitionId: "new-defense",
          phase: "DEFENSE_FAILURE",
          state: {},
          operations: [modifier(2)],
        },
      },
    ],
    "new",
  );
  queue.observe({ before: (entry) => seen.push(entry.definitionId ?? entry.kind) });
  resolveUnitAttack(runtime, queue, "actor", "target", dice(6, 1));
  assert.deepEqual(seen, ["new", "old", "new-defense", "CELL_DAMAGE"]);
  assert.equal(outcomes[0].resolvedAmount, 6);
});

test("базовый damage фиксируется до эффектов; новое событие не меняет исходный ID", () => {
  const { runtime, queue, outcomes } = fixture();
  add(runtime, "actor", "ATTACK_SUCCESS", [
    { kind: "modify_stat", target: owner, stat: "damage", delta: 20 },
    { kind: "create_damage_event", target: { kind: "cell" }, amount: 1 },
    modifier(2),
  ]);
  resolveUnitAttack(runtime, queue, "actor", "target", dice(6, 1));
  assert.deepEqual(
    outcomes.map((o) => [o.eventId, o.amount, o.resolvedAmount]),
    [
      ["damage:2", 1, 1],
      ["damage:1", 3, 5],
    ],
  );
  assert.equal(runtime.world.units[1].stats.hp, 4);
});

test("смерть атакующего не отменяет защиту и исходный независимый урон", () => {
  const { runtime, queue, order, outcomes } = fixture();
  add(runtime, "actor", "ATTACK_SUCCESS", [
    modifier(2),
    { kind: "modify_hp", target: owner, delta: -10 },
  ]);
  add(runtime, "target", "DEFENSE_FAILURE", [modifier(1)]);
  resolveUnitAttack(runtime, queue, "actor", "target", dice(6, 1));
  assert.equal(runtime.world.units[0].alive, false);
  assert.deepEqual(order, ["target", "other"]);
  assert.equal(outcomes[0].resolvedAmount, 6);
  assert.equal(runtime.world.units[1].stats.hp, 4);
});

test("смерть защитника в фазе атаки пропускает его фазу, но не базовое событие", () => {
  const { runtime, queue, outcomes } = fixture();
  add(runtime, "actor", "ATTACK_SUCCESS", [
    { kind: "modify_hp", target: byId("target"), delta: -10 },
  ]);
  add(runtime, "target", "DEFENSE_FAILURE", [
    { kind: "modify_hp", target: byId("actor"), delta: -9 },
  ]);
  resolveUnitAttack(runtime, queue, "actor", "target", dice(6, 1));
  assert.equal(runtime.world.units[0].stats.hp, 10);
  assert.equal(runtime.world.units[1].alive, false);
  assert.equal(outcomes[0].targetId, null);
});

test("при смене обитателя между фазами событие бьёт исходную клетку, включая союзника", () => {
  const { runtime, queue, outcomes } = fixture();
  const adapter = {
    get size() {
      return queue.size;
    },
    enqueue: (...entries) => queue.enqueue(...entries),
    createDamageEvent: (cell, amount) => queue.createDamageEvent(cell, amount),
    drain: (() => {
      let phases = 0;
      return () => {
        queue.drain();
        if (++phases === 1) {
          runtime.world.units[1].position = { x: 2, y: 0 };
          runtime.world.units[2].side = "defender";
          runtime.world.units[2].position = { x: 1, y: 0 };
        }
      };
    })(),
  };
  const result = resolveUnitAttack(runtime, adapter, "actor", "target", dice(6, 1));
  assert.deepEqual(result.cell, { x: 1, y: 0 });
  assert.equal(outcomes[0].targetId, "other");
  assert.equal(runtime.world.units[1].stats.hp, 10);
  assert.equal(runtime.world.units[2].stats.hp, 7);
});

test("неосуществимая атака не расходует RNG, ID и не запускает фазы", () => {
  const { runtime, queue, damage } = fixture();
  const empty = dice();
  assert.equal(resolveUnitAttack(runtime, queue, "missing", "target", empty).status, "unavailable");
  assert.equal(checkUnitAttack(runtime.world, "actor", "actor").reason, "same_side");
  runtime.world.units[1].alive = false;
  assert.equal(
    resolveUnitAttack(runtime, queue, "actor", "target", empty).reason,
    "defender_unavailable",
  );
  runtime.world.units[1].alive = true;
  runtime.world.units[0].attackMask[2][3] = 0;
  assert.equal(resolveUnitAttack(runtime, queue, "actor", "target", empty).reason, "unreachable");
  runtime.world.map.cells[1].area = "outside";
  assert.equal(
    resolveUnitAttack(runtime, queue, "actor", "target", empty).reason,
    "outside_target",
  );
  assert.equal(damage.nextEventId, 1);
});

test("сравнение больших характеристик сохраняет преимущество одного очка броска", () => {
  const { runtime, queue } = fixture();
  runtime.world.units[0].stats.strength = 2 ** 54;
  runtime.world.units[1].stats.agility = 2 ** 54;
  assert.equal(resolveUnitAttack(runtime, queue, "actor", "target", dice(6, 5)).success, true);
});

test("атака подключается к слоту хода и журналу с двумя бросками на один исход", () => {
  const { runtime, damage, order } = fixture();
  const journal = new EventJournal();
  const rng = journalRng(journal, createSeededRng(17));
  const queue = createJournalDamageQueue(journal, runtime, damage, () => order);
  const result = runUnitTurn(runtime, "actor", () => order, {
    createQueue: () => queue,
    chooseAction: ({ slot }) => ({ kind: slot === 1 ? "ATTACK" : "MOVE" }),
    executeAction: function* (action) {
      yield* [];
      if (action.kind === "ATTACK") {
        resolveUnitAttack(runtime, queue, "actor", "target", rng, {
          onOutcome: (outcome) => journal.append("attack", outcome),
        });
      }
    },
  });
  assert.deepEqual(
    result.actions.map((action) => action.kind),
    ["ATTACK", "MOVE"],
  );
  assert.equal(journal.snapshot().filter((e) => e.kind === "rng").length, 2);
  assert.equal(journal.snapshot().filter((e) => e.kind === "attack").length, 1);
});

test("повреждённый RNG и незавершённый предыдущий пакет обнаруживаются явно", () => {
  const { runtime, queue } = fixture();
  assert.throws(() => resolveUnitAttack(runtime, queue, "actor", "target", dice(7)), /бросок/);
  queue.enqueue(queue.createDamageEvent({ x: 3, y: 0 }, 0));
  assert.throws(() => resolveUnitAttack(runtime, queue, "actor", "target", dice()), /пакет/);
});
