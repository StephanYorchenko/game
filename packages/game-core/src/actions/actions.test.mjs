import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld, createMoveState } from "@deathwarriors/game-core";
import {
  chooseAutomaticAction,
  executeAutomaticAction,
  runAutomaticTurn,
} from "@deathwarriors/game-core/actions";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { createSeededRng } from "@deathwarriors/game-core/random";
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
function fixture(side = "enemy", targetX = 6, movement = 2) {
  const unit = (id, faction, x) => ({
    id,
    kind: "unit",
    definitionId: "fighter",
    side: faction,
    alive: true,
    position: { x, y: 1 },
    stats: { hp: 10, maxHP: 10, strength: 10, agility: 0, damage: 2, movement, resistance: 0 },
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
        units: [
          unit("actor", side, 0),
          unit("target", side === "enemy" ? "defender" : "enemy", targetX),
        ],
        traps: [],
      }),
      effects: createEffectStore(),
      movement: createMoveState(),
    },
    damage: createDamageState(),
    order: ["actor", "target"],
  };
}
const cell = (state, x, y = 1) => state.runtime.world.map.cells[y * 7 + x];
const actor = (state) => state.runtime.world.units[0];
const door = (state, x, y = 1, kind = "door") => {
  cell(state, x, y).structure = {
    id: `opening-${x}-${y}`,
    kind,
    state: "closed",
    reinforcement: null,
    interactionMask: mask,
  };
  return cell(state, x, y).structure.id;
};
const getOptions = () => ({ knownEnemyIds: ["target"], movement: { directions: ["east"] } });
function run(state, options = {}) {
  const selected = [];
  const phases = [];
  const result = runAutomaticTurn(
    state.runtime,
    "actor",
    () => state.order,
    state.damage,
    createSeededRng(28),
    {
      getOptions,
      onAction: (action) => selected.push(action),
      onPhase: (phase) => phases.push(phase),
      ...options,
    },
  );
  return { result, selected, phases };
}

test("доступная атака приоритетнее соседнего обычного проёма", () => {
  const state = fixture("enemy", 1);
  door(state, 0, 0);
  const { selected } = run(state);
  assert.deepEqual(
    selected.map((action) => action.kind),
    ["ATTACK", "ATTACK"],
  );
  assert.equal(state.runtime.world.units[1].stats.hp, 6);
  assert.equal(cell(state, 0, 0).structure.state, "closed");
  assert.equal(state.damage.nextEventId, 3);
});

test("открытие первым слотом не завершает ход: второй слот движется через проём", () => {
  for (const kind of ["door", "window"]) {
    const state = fixture("enemy", 6);
    const id = door(state, 1, 1, kind);
    const { selected } = run(state);
    assert.deepEqual(selected, [
      { kind: "INTERACT", openingId: id },
      { kind: "MOVE", target: { kind: "unit", id: "target" } },
    ]);
    assert.equal(cell(state, 1).structure.state, "open");
    assert.deepEqual(actor(state).position, { x: 2, y: 1 });
    assert.equal(state.damage.nextEventId, 1);
  }
});

test("MOVE завершается перед атакой, затем второй слот отдельно атакует", () => {
  const state = fixture("enemy", 4, 4);
  const { selected } = run(state);
  assert.deepEqual(
    selected.map((action) => action.kind),
    ["MOVE", "ATTACK"],
  );
  assert.deepEqual(actor(state).position, { x: 3, y: 1 });
  assert.equal(state.runtime.world.units[1].stats.hp, 8);
});

test("после гибели цели второй слот заново выбирает INTERACT", () => {
  const state = fixture("enemy", 1);
  state.runtime.world.units[1].stats.hp = 2;
  const id = door(state, 0, 0);
  const { selected } = run(state);
  assert.deepEqual(selected, [
    { kind: "ATTACK", targetKind: "unit", targetId: "target" },
    { kind: "INTERACT", openingId: id },
  ]);
  assert.equal(state.runtime.world.units[1].alive, false);
  assert.equal(cell(state, 0, 0).structure.state, "open");
});

test("защитник с открытым путём движется, сохраняя соседнюю дверь закрытой", () => {
  const state = fixture("defender");
  door(state, 0, 0);
  const { selected } = run(state);
  assert.deepEqual(
    selected.map((action) => action.kind),
    ["MOVE", "MOVE"],
  );
  assert.deepEqual(actor(state).position, { x: 4, y: 1 });
  assert.equal(cell(state, 0, 0).structure.state, "closed");
});

test("защитник открывает TRUE-дверь и продолжает движение следующим слотом", () => {
  const state = fixture("defender");
  for (let y = 0; y < 3; y += 1) {
    cell(state, 1, y).structure = { id: `wall-${y}`, kind: "wall" };
  }
  const id = door(state, 1);
  const { selected } = run(state);
  assert.deepEqual(selected[0], { kind: "INTERACT", openingId: id });
  assert.equal(selected[1].kind, "MOVE");
  assert.deepEqual(actor(state).position, { x: 2, y: 1 });
});

test("для врага ближайший проём остаётся самостоятельной целью маршрута", () => {
  const state = fixture();
  const id = door(state, 3);
  const chosen = chooseAutomaticAction(
    state.runtime.world,
    "actor",
    createSeededRng(28),
    getOptions(),
  );
  assert.deepEqual(chosen, { kind: "MOVE", target: { kind: "opening", id } });
});

test("равные ближайшие цели разных типов выбираются одним RNG без розыгрыша будущего пути", () => {
  const state = fixture("enemy", 3);
  const id = door(state, 2, 0);
  let calls = 0;
  const before = JSON.stringify(state);
  const chosen = chooseAutomaticAction(
    state.runtime.world,
    "actor",
    {
      pick: (candidates) => {
        calls += 1;
        assert.equal(candidates.length, 2);
        assert.deepEqual(
          candidates.map((candidate) => candidate.target.kind),
          ["unit", "opening"],
        );
        return candidates[1];
      },
    },
    getOptions(),
  );
  assert.equal(calls, 1);
  assert.deepEqual(chosen, { kind: "MOVE", target: { kind: "opening", id } });
  assert.equal(JSON.stringify(state), before);
});

test("нулевой MOVE расходует два слота и вызывает завершающие фазы без RNG", () => {
  const state = fixture("enemy", 6, 0);
  const selected = [];
  const phases = [];
  const rng = {
    pick() {
      assert.fail("Нулевой MOVE не выбирает ненужный маршрут");
    },
    d6() {
      assert.fail("Атака недоступна");
    },
  };
  const result = runAutomaticTurn(state.runtime, "actor", () => state.order, state.damage, rng, {
    onAction: (action) => selected.push(action),
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(result.actions.length, 2);
  assert.deepEqual(selected, [
    { kind: "MOVE", target: null },
    { kind: "MOVE", target: null },
  ]);
  assert.deepEqual(phases, [
    "TURN_START",
    "ACTION_START",
    "ACTION_END",
    "ACTION_START",
    "ACTION_END",
    "TURN_END",
  ]);
  assert.deepEqual(actor(state).position, { x: 0, y: 1 });
});

test("неизвестный враг не становится целью защитника", () => {
  const state = fixture("defender", 1);
  const { selected } = run(state, { getOptions: () => ({}) });
  assert.deepEqual(selected, [
    { kind: "MOVE", target: null },
    { kind: "MOVE", target: null },
  ]);
  assert.equal(state.runtime.world.units[1].stats.hp, 10);
});

test("тип действия вычисляется после гибели цели в ACTION_START", () => {
  const state = fixture("enemy", 1);
  const id = door(state, 0, 0);
  addEffect(state.runtime.effects, {
    ownerId: "actor",
    definitionId: "cleanup",
    phase: "ACTION_START",
    state: {},
    operations: [{ kind: "modify_hp", target: { kind: "unit", id: "target" }, delta: -10 }],
  });
  const { selected } = run(state);
  assert.deepEqual(selected[0], { kind: "INTERACT", openingId: id });
  assert.equal(state.runtime.world.units[1].alive, false);
  assert.equal(state.damage.nextEventId, 1);
});

test("бафф ACTION_START позволяет двигаться юниту с исходной скоростью 0", () => {
  const state = fixture("enemy", 3, 0);
  addEffect(state.runtime.effects, {
    ownerId: "actor",
    definitionId: "speed",
    phase: "ACTION_START",
    state: {},
    operations: [{ kind: "modify_stat", target: { kind: "owner" }, stat: "movement", delta: 2 }],
  });
  const { selected } = run(state);
  assert.deepEqual(
    selected.map((action) => action.kind),
    ["MOVE", "ATTACK"],
  );
  assert.deepEqual(actor(state).position, { x: 2, y: 1 });
  assert.equal(state.runtime.world.units[1].stats.hp, 8);
});

test("атака укрепления использует гарантированный исход и не требует d6", () => {
  const state = fixture();
  state.runtime.world.units.splice(1);
  state.order = ["actor"];
  const id = door(state, 1);
  cell(state, 1).structure.reinforcement = { hp: 2, maxHP: 2, resistance: 0 };
  const selected = [];
  runAutomaticTurn(
    state.runtime,
    "actor",
    () => state.order,
    state.damage,
    {
      pick() {
        assert.fail("Один кандидат не требует RNG");
      },
      d6() {
        assert.fail("Укрепление атакуется без бросков");
      },
    },
    { onAction: (action) => selected.push(action) },
  );
  assert.deepEqual(selected[0], { kind: "ATTACK", targetKind: "opening", targetId: id });
  assert.equal(cell(state, 1).structure.state, "destroyed");
  assert.deepEqual(selected[1], { kind: "MOVE", target: null });
});

test("прерывание хода ловушкой сохраняет ACTION_END/TURN_END и отменяет следующий выбор", () => {
  const state = fixture();
  state.runtime.world.traps.push({
    id: "trap",
    kind: "trap",
    definitionId: "snare",
    position: { x: 1, y: 1 },
  });
  addEffect(state.runtime.effects, {
    ownerId: "trap",
    definitionId: "stop",
    phase: "DEATH",
    state: {},
    operations: [
      { kind: "interrupt_turn", target: { kind: "occupant" } },
      { kind: "create_damage_event", target: { kind: "cell" }, amount: 1 },
    ],
  });
  const { selected, phases } = run(state);
  assert.equal(selected.length, 1);
  assert.deepEqual(actor(state).position, { x: 1, y: 1 });
  assert.equal(actor(state).stats.hp, 9);
  assert.deepEqual(phases, ["TURN_START", "ACTION_START", "ACTION_END", "TURN_END"]);
});

test("исполнитель повторно проверяет знания защитника и не создаёт замену выбранной атаке", () => {
  const state = fixture("defender", 1);
  const action = chooseAutomaticAction(
    state.runtime.world,
    "actor",
    createSeededRng(28),
    getOptions(),
  );
  const queue = createDamageQueue(state.runtime, state.damage, () => state.order);
  const iterator = executeAutomaticAction(
    state.runtime,
    "actor",
    action,
    queue,
    createSeededRng(28),
  );
  assert.equal(iterator.next().done, true);
  assert.equal(state.runtime.world.units[1].stats.hp, 10);
});

test("отсутствующий владелец не запускает выбор или создание очереди", () => {
  const state = fixture();
  const result = runAutomaticTurn(
    state.runtime,
    "missing",
    () => state.order,
    state.damage,
    createSeededRng(28),
    {
      createQueue() {
        assert.fail("Ход отсутствующего юнита не начинается");
      },
      onAction() {
        assert.fail("Нет владельца");
      },
    },
  );
  assert.equal(result.status, "missing");
});

test("автоматический ход, журнал и исходы воспроизводятся после JSON round-trip", () => {
  const initial = fixture("enemy", 1);
  const runner = (state, journal, rng) => {
    const result = runAutomaticTurn(state.runtime, "actor", () => state.order, state.damage, rng, {
      getOptions,
      createQueue: (runtime) =>
        createJournalDamageQueue(journal, runtime, state.damage, () => state.order),
      onAction: (action) => journal.append("action", action),
      onPhase: (phase, slot) => journal.append("phase", { phase, slot }),
    });
    return { state, result };
  };
  const recording = recordSimulation(initial, 28, runner);
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), runner).matches, true);
  assert.equal(recording.entries.filter((entry) => entry.kind === "action").length, 2);
  assert.equal(recording.final.state.runtime.world.units[1].stats.hp, 6);
});

test("новое действие не планируется поверх незавершённого пакета очереди", () => {
  const state = fixture();
  const queue = createDamageQueue(state.runtime, state.damage, () => state.order);
  queue.enqueue({
    ownerId: "actor",
    instanceId: "pending",
    definitionId: "pending",
    source: "ordinary",
    phase: "ACTION_START",
    state: {},
    context: { kind: "phase", ownerId: "actor" },
    operations: [],
  });
  const iterator = executeAutomaticAction(
    state.runtime,
    "actor",
    { kind: "MOVE", target: null },
    queue,
    createSeededRng(28),
  );
  assert.throws(() => iterator.next(), /предыдущий пакет/);
  assert.equal(state.runtime.movement.nextMoveId, 1);
});
