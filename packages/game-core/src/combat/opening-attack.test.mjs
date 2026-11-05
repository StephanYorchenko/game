import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { resolveOpeningAttack } from "@deathwarriors/game-core/combat";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import { createJournalDamageQueue, EventJournal } from "@deathwarriors/game-core/journal";

const modifier = (value) => ({
  kind: "add_damage_modifier",
  event: { kind: "context_damage" },
  modifier: { type: "relative", value },
});

function fixture(kind = "door") {
  const world = loadWorld({
    version: 1,
    map: {
      width: 3,
      height: 1,
      cells: [
        { surface: "ground", area: "outside", structure: null },
        { surface: "ground", area: "outside", structure: null },
        {
          surface: "floor",
          area: "inside",
          structure: {
            id: "gate",
            kind,
            state: "closed",
            reinforcement: { hp: 10, maxHP: 10, resistance: 1 },
            interactionMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
          },
        },
      ],
    },
    units: [
      {
        id: "attacker",
        kind: "unit",
        definitionId: "raider",
        side: "enemy",
        alive: true,
        position: { x: 0, y: 0 },
        stats: {
          hp: 10,
          maxHP: 10,
          strength: 0,
          agility: 0,
          damage: 3,
          movement: 1,
          resistance: 0,
        },
        attackMask: Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]),
        keywords: [],
      },
    ],
    traps: [],
  });
  const runtime = { world, effects: createEffectStore() };
  const damage = createDamageState();
  const order = ["attacker"];
  const outcomes = [];
  const queue = createDamageQueue(
    runtime,
    damage,
    () => order,
    (outcome) => outcomes.push(outcome),
  );
  const gate = world.map.cells[2].structure;
  return { runtime, damage, order, outcomes, queue, gate };
}

function add(runtime, ownerId, phase, operations, definitionId = phase) {
  addEffect(runtime.effects, { ownerId, phase, operations, definitionId, state: {} });
}

test("дверь и окно используют маску атаки снаружи, а не пустую матрицу взаимодействия", () => {
  for (const kind of ["door", "window"]) {
    const { runtime, queue, gate } = fixture(kind);
    const result = resolveOpeningAttack(runtime, queue, "attacker", "gate");
    assert.equal(result.success, true);
    assert.equal(result.damageEventId, "damage:1");
    assert.equal(Object.hasOwn(result, "attackRoll"), false);
    assert.equal(gate.reinforcement.hp, 8);
  }
});

test("общие фазы идут перед уроном, обе добавляют модификаторы до сопротивления", () => {
  const { runtime, queue, outcomes, gate } = fixture();
  const phases = [];
  add(runtime, "attacker", "ATTACK_SUCCESS", [modifier(2)]);
  add(runtime, "gate", "DEFENSE_FAILURE", [modifier(3)]);
  add(runtime, "gate", "DEFENSE_SUCCESS", [modifier(100)]);
  queue.observe({ before: (entry) => phases.push(entry.phase ?? entry.kind) });
  resolveOpeningAttack(runtime, queue, "attacker", "gate");
  assert.deepEqual(phases, ["ATTACK_SUCCESS", "DEFENSE_FAILURE", "CELL_DAMAGE"]);
  assert.equal(outcomes[0].resolvedAmount, 8);
  assert.equal(outcomes[0].hpLoss, 7);
  assert.equal(gate.reinforcement.hp, 3);
});

test("разрушение запускает DEATH и сохраняет улучшения укрепления", () => {
  const { runtime, queue, gate } = fixture();
  const reinforcement = gate.reinforcement;
  runtime.world.units[0].stats.damage = 20;
  add(runtime, "gate", "DEATH", [
    {
      kind: "modify_hp",
      target: { kind: "unit", id: "attacker" },
      delta: -1,
    },
  ]);
  const saved = JSON.stringify(runtime.effects);
  resolveOpeningAttack(runtime, queue, "attacker", "gate");
  assert.equal(gate.state, "destroyed");
  assert.equal(gate.reinforcement, reinforcement);
  assert.equal(reinforcement.hp, 0);
  assert.equal(JSON.stringify(runtime.effects), saved);
  assert.equal(runtime.world.units[0].stats.hp, 9);
});

test("смерть атакующего в фазе не отменяет защиту укрепления и созданный урон", () => {
  const { runtime, queue, gate, order } = fixture();
  add(runtime, "attacker", "ATTACK_SUCCESS", [
    {
      kind: "modify_hp",
      target: { kind: "owner" },
      delta: -10,
    },
  ]);
  add(runtime, "gate", "DEFENSE_FAILURE", [modifier(2)]);
  resolveOpeningAttack(runtime, queue, "attacker", "gate");
  assert.equal(runtime.world.units[0].alive, false);
  assert.deepEqual(order, []);
  assert.equal(gate.reinforcement.hp, 6);
});

test("разрушенный вложенным событием проём пропускает обычную защиту", () => {
  const { runtime, queue, outcomes, gate } = fixture();
  add(runtime, "attacker", "ATTACK_SUCCESS", [
    {
      kind: "create_damage_event",
      target: { kind: "cell" },
      amount: 20,
    },
  ]);
  add(runtime, "gate", "DEFENSE_FAILURE", [
    {
      kind: "modify_hp",
      target: { kind: "attacker" },
      delta: -9,
    },
  ]);
  resolveOpeningAttack(runtime, queue, "attacker", "gate");
  assert.equal(gate.state, "destroyed");
  assert.equal(runtime.world.units[0].stats.hp, 10);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.eventId, outcome.targetId]),
    [
      ["damage:2", "gate"],
      ["damage:1", null],
    ],
  );
});

test("недопустимые состояния и геометрия не создают события", () => {
  for (const change of [
    ({ gate }) => {
      gate.reinforcement = null;
    },
    ({ gate }) => {
      gate.state = "open";
    },
    ({ gate }) => {
      gate.state = "destroyed";
    },
    ({ runtime }) => {
      runtime.world.units[0].side = "defender";
    },
    ({ runtime }) => {
      runtime.world.units[0].attackMask[2][4] = 0;
    },
    ({ runtime }) => {
      runtime.world.map.cells[1].structure = { id: "wall", kind: "wall" };
    },
  ]) {
    const state = fixture();
    change(state);
    assert.equal(
      resolveOpeningAttack(state.runtime, state.queue, "attacker", "gate").status,
      "unavailable",
    );
    assert.equal(state.damage.nextEventId, 1);
  }
});

test("журнал получает обычные операции и урон укрепления без решений RNG", () => {
  const { runtime, damage, order } = fixture();
  const journal = new EventJournal();
  const queue = createJournalDamageQueue(journal, runtime, damage, () => order);
  add(runtime, "gate", "DEFENSE_FAILURE", [modifier(-1)]);
  resolveOpeningAttack(runtime, queue, "attacker", "gate", {
    onOutcome: (outcome) => journal.append("opening_attack", outcome),
  });
  const entries = journal.snapshot();
  assert.equal(entries.filter((entry) => entry.kind === "rng").length, 0);
  assert.equal(entries.find((entry) => entry.kind === "operation").data.ownerId, "gate");
  assert.equal(entries.find((entry) => entry.kind === "damage").data.hpLoss, 1);
});
