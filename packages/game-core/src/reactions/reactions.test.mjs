import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { resolveUnitAttack } from "@deathwarriors/game-core/combat";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { createDeathQueue } from "@deathwarriors/game-core/death";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import {
  createJournalDamageQueue,
  EventJournal,
  recordSimulation,
  replaySimulation,
} from "@deathwarriors/game-core/journal";
import { schedulePhase } from "@deathwarriors/game-core/operations";
import { copyReactionCause, enterReaction } from "@deathwarriors/game-core/reactions";
import { createSummoningState } from "@deathwarriors/game-core/summoning";

const byId = (id) => ({ kind: "unit", id });
const count = { kind: "modify_counter", instance: { kind: "self" }, name: "calls", delta: 1 };
const trigger = (id, phase) => ({ kind: "trigger_reaction", target: byId(id), phase });
function fixture() {
  return {
    world: loadWorld({
      version: 1,
      map: {
        width: 2,
        height: 2,
        cells: Array.from({ length: 4 }, () => ({
          surface: "floor",
          area: "inside",
          structure: null,
        })),
      },
      units: ["left", "right"].map((id, index) => ({
        id,
        kind: "unit",
        definitionId: "fighter",
        side: index === 0 ? "defender" : "enemy",
        alive: true,
        position: { x: index, y: 0 },
        stats: {
          hp: 10,
          maxHP: 10,
          strength: 1,
          agility: 1,
          damage: 0,
          movement: 0,
          resistance: 0,
        },
        attackMask: Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]),
        keywords: [],
      })),
      traps: [],
    }),
    effects: createEffectStore(),
    summoning: createSummoningState(),
  };
}
function add(runtime, ownerId, phase, definitionId, operations) {
  return addEffect(runtime.effects, {
    ownerId,
    phase,
    definitionId,
    state: { calls: 0 },
    operations: [count, ...operations],
  });
}
function root(runtime, cell = { x: 1, y: 0 }) {
  return schedulePhase(runtime.effects, "left", "ATTACK_SUCCESS", {
    kind: "attack",
    ownerId: "left",
    attackerId: "left",
    defenderId: "right",
    cell,
  });
}
const calls = (runtime) => runtime.effects.instances.map((effect) => effect.state.calls);

test("одинаковый definitionId другого владельца блокируется в обеих очередях", () => {
  for (const factory of [
    (runtime, order) => createDeathQueue(runtime, () => order),
    (runtime, order) => createDamageQueue(runtime, createDamageState(), () => order),
  ]) {
    const runtime = fixture();
    add(runtime, "left", "ATTACK_SUCCESS", "reflect", [trigger("right", "DEFENSE_FAILURE")]);
    add(runtime, "right", "DEFENSE_FAILURE", "reflect", [trigger("left", "ATTACK_SUCCESS")]);
    const queue = factory(runtime, ["left", "right"]);
    queue.enqueue(...root(runtime));
    queue.drain();
    assert.deepEqual(calls(runtime), [1, 0]);
  }
});

test("косвенный цикл A → B → A обрывается, соседняя другая способность C работает", () => {
  const runtime = fixture();
  add(runtime, "left", "ATTACK_SUCCESS", "A", [trigger("right", "DEFENSE_FAILURE")]);
  add(runtime, "right", "DEFENSE_FAILURE", "C", []);
  add(runtime, "right", "DEFENSE_FAILURE", "B", [trigger("left", "ATTACK_SUCCESS")]);
  const journal = new EventJournal();
  const queue = createJournalDamageQueue(journal, runtime, createDamageState(), () => [
    "left",
    "right",
  ]);
  queue.enqueue(...root(runtime));
  queue.drain();
  assert.deepEqual(calls(runtime), [1, 1, 1]);
  const skipped = journal.snapshot().find((entry) => entry.kind === "skipped");
  assert.equal(skipped.data.reason, "reaction_cycle");
  assert.equal(skipped.data.entry.definitionId, "A");
  assert.deepEqual(skipped.data.entry.cause.definitionIds, ["A", "B"]);
});

test("соседние экземпляры одного ID не блокируют друг друга и не загрязняют хранилище", () => {
  const runtime = fixture();
  add(runtime, "left", "ATTACK_SUCCESS", "starter", [trigger("right", "DEFENSE_FAILURE")]);
  add(runtime, "right", "DEFENSE_FAILURE", "same", []);
  add(runtime, "right", "DEFENSE_FAILURE", "same", []);
  const queue = createDeathQueue(runtime, () => ["left", "right"]);
  queue.enqueue(...root(runtime), ...root(runtime));
  queue.drain();
  assert.deepEqual(calls(runtime), [2, 2, 2]);
  assert.ok(runtime.effects.instances.every((effect) => !Object.hasOwn(effect, "cause")));
});

test("две независимые атаки не делят запрет повторной способности", () => {
  const runtime = fixture();
  add(runtime, "left", "ATTACK_SUCCESS", "reflect", [trigger("right", "DEFENSE_FAILURE")]);
  add(runtime, "right", "DEFENSE_FAILURE", "reflect", [trigger("left", "ATTACK_SUCCESS")]);
  const queue = createDamageQueue(runtime, createDamageState(), () => ["left", "right"]);
  for (let index = 0; index < 2; index += 1) {
    let roll = 0;
    resolveUnitAttack(runtime, queue, "left", "right", { d6: () => (++roll === 1 ? 6 : 1) });
  }
  assert.deepEqual(calls(runtime), [2, 2]);
});

test("CELL_DAMAGE и DEATH сохраняют предков, журнал повторяется через JSON", () => {
  const initial = fixture();
  add(initial, "left", "ATTACK_SUCCESS", "A", [
    {
      kind: "create_damage_event",
      target: { kind: "cell" },
      amount: 10,
    },
  ]);
  add(initial, "right", "DEATH", "B", [trigger("left", "ATTACK_SUCCESS")]);
  const runner = (runtime, journal) => {
    const order = ["left", "right"];
    const queue = createJournalDamageQueue(journal, runtime, createDamageState(), () => order);
    queue.enqueue(...root(runtime));
    queue.drain();
    return { ...runtime, order };
  };
  const recording = recordSimulation(initial, 35, runner);
  assert.deepEqual(calls(recording.final), [1, 1]);
  assert.equal(recording.final.world.units[1].alive, false);
  const skipped = recording.entries.find((entry) => entry.kind === "skipped");
  assert.deepEqual(skipped.data.entry.cause.definitionIds, ["A", "B"]);
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), runner).matches, true);
});

test("SUMMON наследует цепочку породившей способности", () => {
  const runtime = fixture();
  add(runtime, "left", "ATTACK_SUCCESS", "A", [
    {
      kind: "place_entity",
      target: { kind: "cell" },
      template: {
        kind: "trap",
        definitionId: "snare",
        effects: [
          {
            definitionId: "B",
            phase: "SUMMON",
            state: { calls: 0 },
            operations: [count, trigger("left", "ATTACK_SUCCESS")],
          },
        ],
      },
    },
  ]);
  const queue = createDamageQueue(runtime, createDamageState(), () => ["left", "right"]);
  queue.enqueue(...root(runtime, { x: 0, y: 1 }));
  queue.drain();
  assert.deepEqual(calls(runtime), [1, 1]);
  assert.equal(runtime.world.traps.length, 1);
});

test("цепочки копируются при ветвлении и постановке в очередь, неверные значения отклоняются", () => {
  const parent = enterReaction(undefined, "A");
  const first = enterReaction(parent, "B");
  const second = enterReaction(parent, "B");
  first.definitionIds.push("extra");
  assert.deepEqual(parent.definitionIds, ["A"]);
  assert.deepEqual(second.definitionIds, ["A", "B"]);
  assert.equal(enterReaction(parent, "A"), undefined);
  assert.throws(() => copyReactionCause({ definitionIds: [1] }), /definitionId/);
  assert.throws(() => copyReactionCause({ definitionIds: new Array(1) }), /definitionId/);
  const runtime = fixture();
  add(runtime, "left", "ATTACK_SUCCESS", "run", []);
  const effects = root(runtime);
  effects[0].cause = { definitionIds: ["original"] };
  const queue = createDeathQueue(runtime, () => ["left", "right"]);
  queue.enqueue(...effects);
  effects[0].cause.definitionIds.push("run");
  queue.drain();
  assert.deepEqual(calls(runtime), [1]);
});

test("операция реакции не позволяет подделать фазу смерти", () => {
  const runtime = fixture();
  add(runtime, "left", "ATTACK_SUCCESS", "bad", [trigger("right", "DEATH")]);
  const queue = createDeathQueue(runtime, () => ["left", "right"]);
  queue.enqueue(...root(runtime));
  assert.throws(() => queue.drain(), /боевую реакцию/);
  assert.ok(runtime.world.units.every((unit) => unit.alive));
});
