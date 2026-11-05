import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import { createCellDamage, createDamageState } from "@deathwarriors/game-core/damage";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { createSummoningState } from "@deathwarriors/game-core/summoning";
import {
  EventJournal,
  createJournalDamageQueue,
  journalRng,
  recordSimulation,
  replaySimulation,
  runJournaledTurn,
} from "@deathwarriors/game-core/journal";

const byId = (id) => ({ kind: "unit", id });

function fixture() {
  const world = loadWorld({
    version: 1,
    map: {
      width: 3,
      height: 1,
      cells: Array.from({ length: 3 }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units: ["actor", "target"].map((id, index) => ({
      id,
      kind: "unit",
      definitionId: "fighter",
      side: index === 0 ? "defender" : "enemy",
      alive: true,
      position: { x: index, y: 0 },
      stats: { hp: 5, maxHP: 5, strength: 1, agility: 1, damage: 1, movement: 0, resistance: 0 },
      attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
      keywords: [],
    })),
    traps: [],
  });
  const effects = createEffectStore();
  addEffect(effects, {
    ownerId: "target",
    definitionId: "echo",
    phase: "DEATH",
    state: {},
    operations: [
      { kind: "modify_hp", target: byId("actor"), delta: -1 },
      { kind: "create_damage_event", target: { kind: "cell" }, amount: 1 },
    ],
  });
  return { world, effects, order: ["actor", "target"], damage: createDamageState() };
}

function atomic(id, ownerId, operations) {
  return {
    ownerId,
    instanceId: id,
    definitionId: id,
    phase: "ATTACK_SUCCESS",
    source: "ordinary",
    operations,
    state: {},
    context: {
      kind: "attack",
      ownerId,
      attackerId: "actor",
      defenderId: "target",
      cell: { x: 1, y: 0 },
    },
  };
}

function runner(initial, journal, rng) {
  const runtime = { world: initial.world, effects: initial.effects };
  runJournaledTurn(
    journal,
    runtime,
    initial.damage,
    "actor",
    () => initial.order,
    {
      chooseAction: ({ slot }) => ({
        kind: slot === 1 ? "ATTACK" : "MOVE",
        targetId: rng.pick(["target"]),
      }),
      executeAction: function* (action) {
        if (action.kind === "ATTACK") {
          rng.d6();
          yield [
            atomic("strike", "actor", [
              { kind: "heal", target: byId("missing"), value: 1 },
              { kind: "create_damage_event", target: { kind: "cell" }, amount: 5 },
            ]),
            atomic("stale", "target", [{ kind: "heal", target: byId("target"), value: 1 }]),
          ];
        }
      },
    },
    { round: 2, turn: 3 },
  );
  return initial;
}

test("тот же сценарий/seed повторяет журнал, события, смерти и полный итог через JSON", () => {
  const initial = fixture();
  const saved = JSON.stringify(initial);
  const recording = recordSimulation(initial, 112, runner);
  assert.deepEqual(recordSimulation(initial, 112, runner), recording);
  assert.equal(JSON.stringify(initial), saved);
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), runner).matches, true);
  assert.deepEqual(recording.final.order, ["actor"]);
  assert.equal(recording.final.world.units[0].stats.hp, 4);
  assert.equal(recording.final.world.units[1].alive, false);

  const entries = recording.entries;
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    entries.map((_, index) => index + 1),
  );
  assert.ok(entries.every((entry) => entry.scope.round === 2 && entry.scope.turn === 3));
  const phases = entries.filter((entry) => entry.kind === "phase");
  assert.deepEqual(
    phases.map((entry) => [entry.data.phase, entry.scope.slot]),
    [
      ["TURN_START", null],
      ["ACTION_START", 1],
      ["ACTION_END", 1],
      ["ACTION_START", 2],
      ["ACTION_END", 2],
      ["TURN_END", null],
    ],
  );
  assert.deepEqual(
    entries.filter((entry) => entry.kind === "action").map((entry) => entry.data),
    [
      { kind: "ATTACK", targetId: "target" },
      { kind: "MOVE", targetId: "target" },
    ],
  );
  const damages = entries.filter((entry) => entry.kind === "damage");
  assert.deepEqual(
    damages.map((entry) => [entry.data.eventId, entry.data.targetId]),
    [
      ["damage:1", "target"],
      ["damage:2", null],
    ],
  );
  assert.deepEqual(damages[0].data.hpBefore, 5);
  assert.deepEqual(damages[0].data.hpAfter, 0);
  const failed = entries.find((entry) => entry.kind === "operation" && !entry.data.applied);
  assert.equal(failed.data.reason, "operation_unavailable");
  assert.equal(failed.data.operation.target.id, "missing");
  const skipped = entries.find((entry) => entry.kind === "skipped");
  assert.equal(skipped.data.reason, "owner_unavailable");
  assert.equal(skipped.data.entry.instanceId, "stale");
  assert.ok(
    entries.findIndex((entry) => entry.kind === "damage" && entry.data.eventId === "damage:2") <
      entries.indexOf(skipped),
  );
  const echo = entries.find(
    (entry) => entry.kind === "operation" && entry.data.definitionId === "echo",
  );
  assert.deepEqual(echo.data.hp, [{ id: "actor", before: 5, after: 4 }]);
});

test("журнал видит временное HP=0 до лечения внутри одного эффекта без ложной смерти", () => {
  const initial = fixture();
  addEffect(initial.effects, {
    ownerId: "actor",
    definitionId: "recover",
    phase: "TURN_START",
    state: {},
    operations: [
      { kind: "modify_hp", target: byId("actor"), delta: -5 },
      { kind: "heal", target: byId("actor"), value: 5 },
    ],
  });
  const recording = recordSimulation(initial, 3, runner);
  const hp = recording.entries
    .filter((entry) => entry.kind === "operation" && entry.data.definitionId === "recover")
    .map((entry) => entry.data.hp);
  assert.deepEqual(hp, [
    [{ id: "actor", before: 5, after: 0 }],
    [{ id: "actor", before: 0, after: 5 }],
  ]);
  assert.equal(recording.final.world.units[0].alive, true);
});

test("обёртка RNG сохраняет поток и возвращает исходные объекты без лишних бросков", () => {
  const journal = new EventJournal();
  const original = createSeededRng(61);
  const observed = journalRng(journal, createSeededRng(61));
  assert.equal(observed.nextUint32(), original.nextUint32());
  assert.equal(observed.nextFloat(), original.nextFloat());
  assert.equal(observed.nextInt(7), original.nextInt(7));
  assert.equal(observed.d6(), original.d6());
  const candidates = [{ id: "b" }, { id: "a" }];
  assert.equal(observed.pick(candidates), original.pick(candidates));
  assert.equal(observed.pick([]), undefined);
  assert.equal(original.pick([]), undefined);
  assert.deepEqual(observed.snapshot(), original.snapshot());
  assert.equal(journal.snapshot().length, 6);
  assert.deepEqual(journal.snapshot()[4].data.candidates, candidates);
  const before = observed.snapshot();
  assert.throws(() => observed.pick([() => {}]), /JSON/);
  assert.deepEqual(observed.snapshot(), before);
  assert.equal(journal.snapshot().length, 6);
});

test("первое расхождение журнала, итогового состояния и RNG диагностируется отдельно", () => {
  const recording = recordSimulation(fixture(), 44, runner);
  const changed = structuredClone(recording);
  changed.entries[0].kind = "changed";
  assert.equal(replaySimulation(changed, runner).firstMismatch, "entries[0]");
  const final = structuredClone(recording);
  final.final.world.units[0].stats.hp = 1;
  assert.equal(replaySimulation(final, runner).firstMismatch, "final");
  const rng = structuredClone(recording);
  rng.rng.state = "0000000000000000";
  assert.equal(replaySimulation(rng, runner).firstMismatch, "rng");
  assert.throws(() => replaySimulation({ ...recording, version: 2 }, runner), /версия/);
});

test("снимки независимы, public-проекция не раскрывает внутренние записи и их количество", () => {
  const journal = new EventJournal();
  const data = { cell: { x: 1, y: 2 } };
  journal.append("hidden", data);
  journal.append("message", { text: "Шум за окном" }, "public");
  journal.append("secret", { targetId: "outside" });
  journal.append("message", { text: "Дверь открыта" }, "public");
  data.cell.x = 100;
  const snapshot = journal.snapshot();
  snapshot[0].data.cell.x = 200;
  assert.equal(journal.snapshot()[0].data.cell.x, 1);
  assert.deepEqual(
    journal.publicSnapshot().map((entry) => [entry.sequence, entry.kind]),
    [
      [1, "message"],
      [2, "message"],
    ],
  );
  assert.equal(JSON.stringify(journal.publicSnapshot()).includes("outside"), false);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const invalid of [undefined, NaN, Infinity, new Date(), cyclic, { field: undefined }]) {
    assert.throws(() => journal.append("invalid", invalid), /JSON/);
  }
  assert.equal(journal.snapshot().length, 4);
});

test("запись и повтор не читают часы или Math.random", () => {
  const initial = fixture();
  const expected = recordSimulation(initial, 7, runner);
  const now = Date.now;
  const random = Math.random;

  try {
    Date.now = () => {
      throw new Error("Часы недоступны");
    };
    Math.random = () => {
      throw new Error("Только seeded RNG");
    };
    assert.deepEqual(recordSimulation(initial, 7, runner), expected);
    assert.equal(replaySimulation(expected, runner).matches, true);
  } finally {
    Date.now = now;
    Math.random = random;
  }
});

test("модификатор наблюдается, а журнал урона содержит сумму после модификации", () => {
  const runtime = fixture();
  const journal = new EventJournal();
  const event = createCellDamage(runtime.damage, { x: 1, y: 0 }, 1);
  const queue = createJournalDamageQueue(journal, runtime, runtime.damage, () => runtime.order);
  const effect = atomic("modify", "actor", [
    {
      kind: "add_damage_modifier",
      event: { kind: "context_damage" },
      modifier: { type: "relative", value: 2 },
    },
  ]);
  effect.context.damageEventId = event.id;
  queue.enqueue(effect, event);
  queue.drain();

  const operation = journal.snapshot().find((entry) => entry.kind === "operation");
  const damage = journal.snapshot().find((entry) => entry.kind === "damage");
  assert.equal(operation.data.applied, true);
  assert.equal(operation.data.context.damageEventId, event.id);
  assert.equal(damage.data.amount, 1);
  assert.equal(damage.data.resolvedAmount, 3);
  assert.equal(damage.data.hpAfter, 2);
  assert.equal(runtime.world.units[1].stats.hp, 2);
});

test("наблюдаемое размещение сохраняет счётчик призыва и выполняет SUMMON после эффекта", () => {
  const initial = { ...fixture(), summoning: createSummoningState() };
  const summonRunner = (runtime, journal) => {
    const queue = createJournalDamageQueue(journal, runtime, runtime.damage, () => runtime.order);
    const effect = atomic("summon", "actor", [
      {
        kind: "place_entity",
        target: { kind: "cell" },
        template: {
          kind: "trap",
          definitionId: "snare",
          effects: [
            {
              definitionId: "arrival",
              phase: "SUMMON",
              state: {},
              operations: [
                {
                  kind: "modify_hp",
                  target: byId("actor"),
                  delta: -1,
                },
              ],
            },
          ],
        },
      },
    ]);
    effect.context.cell = { x: 2, y: 0 };
    queue.enqueue(effect);
    queue.drain();
    return runtime;
  };
  const recording = recordSimulation(initial, 29, summonRunner);
  assert.equal(recording.final.summoning.nextEntityId, 2);
  assert.equal(recording.final.world.traps[0].id, "entity:1");
  assert.equal(recording.final.world.units[0].stats.hp, 4);
  const operations = recording.entries.filter((entry) => entry.kind === "operation");
  assert.equal(operations[0].data.operation.kind, "place_entity");
  assert.equal(operations[0].data.applied, true);
  assert.equal(operations[1].data.definitionId, "arrival");
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), summonRunner).matches, true);
});

test("недоступный владелец получает причину пропуска без вымышленных фаз", () => {
  const initial = fixture();
  const journal = new EventJournal();
  const result = runJournaledTurn(
    journal,
    initial,
    initial.damage,
    "missing",
    () => initial.order,
    {
      chooseAction: () => {
        throw new Error("Не должен вызываться");
      },
      executeAction: function* () {},
    },
    { round: 1, turn: 1 },
  );
  assert.equal(result.status, "missing");
  assert.deepEqual(
    journal.snapshot().map((entry) => entry.kind),
    ["skipped", "turn_result"],
  );
  assert.equal(journal.snapshot()[0].data.reason, "missing");
});
