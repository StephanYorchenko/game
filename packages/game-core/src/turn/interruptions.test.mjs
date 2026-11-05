import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld, createMoveState, executeMove } from "@deathwarriors/game-core";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { commitUnitDeaths, isOwnerAlive } from "@deathwarriors/game-core/death";
import { createOperationQueue } from "@deathwarriors/game-core/operations";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { createTurnControl, runUnitTurn } from "@deathwarriors/game-core/turn";
import {
  recordSimulation,
  replaySimulation,
  runJournaledTurn,
} from "@deathwarriors/game-core/journal";

const owner = { kind: "owner" };
const interrupt = (kind, target = owner) => ({ kind, target });
const heal = { kind: "heal", target: owner, value: 1 };
function fixture() {
  const unit = (id, side, x) => ({
    id,
    kind: "unit",
    definitionId: "fighter",
    side,
    alive: true,
    position: { x, y: 0 },
    stats: { hp: 5, maxHP: 5, strength: 1, agility: 1, damage: 1, movement: 2, resistance: 0 },
    attackMask: [
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 1, 0, 1, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ],
    keywords: [],
  });
  return {
    runtime: {
      world: loadWorld({
        version: 1,
        map: {
          width: 7,
          height: 1,
          cells: Array.from({ length: 7 }, () => ({
            surface: "floor",
            area: "inside",
            structure: null,
          })),
        },
        units: [unit("actor", "enemy", 0), unit("target", "defender", 6)],
        traps: [],
      }),
      effects: createEffectStore(),
      movement: createMoveState(),
      turnControl: createTurnControl(),
    },
    damage: createDamageState(),
    order: ["actor", "target"],
  };
}
const atomic = (operations, id = "atomic", cell = { x: 0, y: 0 }) => ({
  ownerId: "actor",
  instanceId: id,
  definitionId: id,
  phase: "ACTION_START",
  source: "ordinary",
  state: {},
  context: { kind: "move_end", ownerId: "actor", cell },
  operations,
});
const add = (state, phase, operations, ownerId = "actor") =>
  addEffect(state.runtime.effects, {
    ownerId,
    definitionId: phase,
    phase,
    operations,
    state: {},
  });
function run(state, executeAction = function* () {}, extra = {}) {
  const phases = [];
  const chosen = [];
  const result = runUnitTurn(state.runtime, "actor", () => state.order, {
    chooseAction: ({ slot }) => {
      chosen.push(slot);
      return { kind: "MOVE" };
    },
    executeAction,
    onPhase: (phase, slot) => phases.push([phase, slot]),
    createQueue: (runtime) => createDamageQueue(runtime, state.damage, () => state.order),
    ...extra,
  });
  return { result, phases, chosen };
}
const normalPhases = [
  ["TURN_START", null],
  ["ACTION_START", 1],
  ["ACTION_END", 1],
  ["ACTION_START", 2],
  ["ACTION_END", 2],
  ["TURN_END", null],
];

test("прерывание действия не отменяет следующие операции атома, последствия и второй слот", () => {
  const state = fixture();
  let unwanted = 0;
  const { result, phases } = run(state, function* (_, { slot }) {
    if (slot === 1) {
      yield [
        atomic([
          interrupt("interrupt_action"),
          { kind: "create_damage_event", target: { kind: "cell" }, amount: 2 },
        ]),
      ];
      unwanted += 1;
      yield [atomic([heal], "unwanted")];
    } else {
      yield [atomic([heal], "second")];
    }
  });
  assert.equal(unwanted, 0);
  assert.deepEqual(phases, normalPhases);
  assert.equal(result.actions.length, 2);
  assert.equal(state.runtime.world.units[0].stats.hp, 4);
  assert.equal(state.runtime.turnControl.active, null);
});

test("прерывание хода завершает начатое действие и TURN_END, отменяя второй слот", () => {
  const state = fixture();
  const { result, phases, chosen } = run(state, function* () {
    yield [atomic([interrupt("interrupt_turn")])];
    assert.fail("Нельзя запрашивать остаток действия");
  });
  assert.deepEqual(chosen, [1]);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(
    phases,
    normalPhases.filter(([, slot]) => slot !== 2),
  );
});

test("interrupt_turn в TURN_START оставляет только завершающую фазу самого хода", () => {
  const state = fixture();
  add(state, "TURN_START", [interrupt("interrupt_turn")]);
  const { result, phases, chosen } = run(state);
  assert.deepEqual(chosen, []);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(phases, [
    ["TURN_START", null],
    ["TURN_END", null],
  ]);
});

test("прерывание в ACTION_START не вычисляет отменённое действие заранее", () => {
  for (const kind of ["interrupt_action", "interrupt_turn"]) {
    const state = fixture();
    add(state, "ACTION_START", [
      interrupt(kind),
      { kind: "remove_effect", instance: { kind: "self" } },
    ]);
    const { result, phases, chosen } = run(state);
    assert.deepEqual(chosen, kind === "interrupt_action" ? [2] : []);
    assert.equal(result.actions.length, kind === "interrupt_action" ? 1 : 0);
    assert.deepEqual(
      phases,
      kind === "interrupt_action" ? normalPhases : normalPhases.filter(([, slot]) => slot !== 2),
    );
  }
});

test("interrupt_turn в ACTION_END отменяет следующий слот, interrupt_action там не действует", () => {
  for (const kind of ["interrupt_action", "interrupt_turn"]) {
    const state = fixture();
    add(state, "ACTION_END", [interrupt(kind)]);
    const { result } = run(state);
    assert.equal(result.actions.length, kind === "interrupt_action" ? 2 : 1);
  }
});

test("interrupt_action вне начатого действия не сохраняется на будущий слот или другого юнита", () => {
  const state = fixture();
  const applied = [];
  state.runtime.observer = {
    after: (_, operation, success) => {
      if (operation.kind.startsWith("interrupt")) {
        applied.push(success);
      }
    },
  };
  add(state, "TURN_START", [
    interrupt("interrupt_action"),
    interrupt("interrupt_turn", { kind: "unit", id: "target" }),
  ]);
  assert.equal(run(state).result.actions.length, 2);
  assert.deepEqual(applied, [false, false]);
});

test("прерывание в TURN_END не переходит в следующий ход", () => {
  const state = fixture();
  add(state, "TURN_END", [interrupt("interrupt_turn")]);
  assert.equal(run(state).result.actions.length, 2);
  assert.equal(run(state).result.actions.length, 2);
  assert.equal(state.runtime.turnControl.active, null);
});

test("смерть остаётся смертью: прерывание не запускает ACTION_END и TURN_END погибшего", () => {
  const state = fixture();
  const { result, phases } = run(state, function* () {
    yield [atomic([interrupt("interrupt_turn"), { kind: "modify_hp", target: owner, delta: -5 }])];
  });
  assert.equal(result.status, "dead");
  assert.deepEqual(phases, [
    ["TURN_START", null],
    ["ACTION_START", 1],
  ]);
  assert.deepEqual(state.order, ["target"]);
  assert.equal(state.runtime.turnControl.active, null);
});

test("HP 0 и лечение внутри прерываемого атома полностью разрешаются до границы смерти", () => {
  const state = fixture();
  const { result, phases } = run(state, function* () {
    yield [
      atomic([interrupt("interrupt_turn"), { kind: "modify_hp", target: owner, delta: -5 }, heal]),
    ];
  });
  assert.equal(result.status, "completed");
  assert.equal(state.runtime.world.units[0].stats.hp, 1);
  assert.deepEqual(
    phases,
    normalPhases.filter(([, slot]) => slot !== 2),
  );
});

test("вложенная боевая реакция может прервать действие через ту же очередь", () => {
  const state = fixture();
  add(state, "DEFENSE_SUCCESS", [interrupt("interrupt_action")]);
  const { result } = run(state, function* (_, { slot }) {
    if (slot === 1) {
      yield [atomic([{ kind: "trigger_reaction", target: owner, phase: "DEFENSE_SUCCESS" }])];
      assert.fail("Реакция должна остановить оставшуюся часть действия");
    }
  });
  assert.equal(result.actions.length, 2);
});

test("DEATH другого владельца может прервать текущий ход", () => {
  const state = fixture();
  add(state, "DEATH", [interrupt("interrupt_turn", { kind: "unit", id: "actor" })], "target");
  const { result, chosen } = run(state, function* () {
    yield [
      atomic(
        [{ kind: "create_damage_event", target: { kind: "cell" }, amount: 5 }],
        "kill-target",
        { x: 6, y: 0 },
      ),
    ];
    assert.fail("DEATH должен прервать ход");
  });
  assert.deepEqual(chosen, [1]);
  assert.equal(result.status, "completed");
  assert.equal(state.runtime.world.units[1].alive, false);
});

test("прерывание после шага останавливает ленивый MOVE и освобождает его запись", () => {
  for (const kind of ["interrupt_action", "interrupt_turn"]) {
    const state = fixture();
    const { result } = run(
      state,
      (_, context) =>
        executeMove(context.runtime, "actor", { kind: "unit", id: "target" }, createSeededRng(27)),
      {
        createQueue: (runtime) =>
          createOperationQueue(runtime, {
            isOwnerAlive: (id) => isOwnerAlive(runtime.world, id),
            afterEffect: (context) => {
              context.emit(...commitUnitDeaths(runtime, state.order).effects);
              if (
                runtime.turnControl.active.slot === 1 &&
                context.effect.operations[0]?.kind === "move_step"
              ) {
                context.emit(atomic([interrupt(kind)], "stop"));
              }
            },
          }),
      },
    );
    assert.equal(result.actions.length, kind === "interrupt_action" ? 2 : 1);
    assert.deepEqual(state.runtime.world.units[0].position, {
      x: kind === "interrupt_action" ? 3 : 1,
      y: 0,
    });
    assert.deepEqual(state.runtime.movement.active, []);
  }
});

test("сам итератор MOVE видит прерывание после очереди и возвращает причину", () => {
  const state = fixture();
  state.runtime.turnControl.active = {
    ownerId: "actor",
    stage: "action",
    slot: 1,
    actionInterrupted: false,
    turnInterrupted: false,
  };
  const iterator = executeMove(
    state.runtime,
    "actor",
    { kind: "unit", id: "target" },
    createSeededRng(27),
  );
  const queue = createDamageQueue(state.runtime, state.damage, () => state.order);
  queue.enqueue(...iterator.next().value);
  queue.drain();
  queue.enqueue(atomic([interrupt("interrupt_action")]));
  queue.drain();
  assert.deepEqual(iterator.next(), {
    done: true,
    value: { stepsTaken: 1, reason: "interrupted" },
  });
  assert.deepEqual(state.runtime.movement.active, []);
});

test("фабрика очереди получает runtime с локальным control, исходный runtime не меняется", () => {
  const state = fixture();
  delete state.runtime.turnControl;
  const { result } = run(state, function* () {
    yield [atomic([interrupt("interrupt_turn")])];
  });
  assert.equal(result.actions.length, 1);
  assert.equal(state.runtime.turnControl, undefined);
});

test("ошибка обработчика и попытка вложенного хода очищают control перед следующим запуском", () => {
  const state = fixture();
  assert.throws(
    () =>
      run(state, function* (_, context) {
        yield* [];
        runUnitTurn(context.runtime, "target", () => state.order, {
          chooseAction: () => ({ kind: "MOVE" }),
          executeAction: function* () {},
        });
      }),
    /вложенный/,
  );
  assert.equal(state.runtime.turnControl.active, null);
  assert.equal(run(state).result.actions.length, 2);
});

test("журнал сохраняет операции прерывания и повторяет фазовые границы через JSON", () => {
  const initial = fixture();
  const runner = (state, journal) => {
    const result = runJournaledTurn(
      journal,
      state.runtime,
      state.damage,
      "actor",
      () => state.order,
      {
        chooseAction: () => ({ kind: "MOVE" }),
        executeAction: function* () {
          yield [atomic([interrupt("interrupt_turn")])];
        },
      },
      { round: 1, turn: 1 },
    );
    return { state, result };
  };
  const recording = recordSimulation(initial, 27, runner);
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), runner).matches, true);
  assert.equal(recording.entries.filter((entry) => entry.kind === "operation").length, 1);
  const operation = recording.entries.find((entry) => entry.kind === "operation");
  assert.equal(operation.data.operation.kind, "interrupt_turn");
  assert.equal(operation.data.applied, true);
  assert.equal(recording.final.result.actions.length, 1);
  assert.equal(recording.final.state.runtime.turnControl.active, null);
});

test("DEATH настоящей ловушки прерывает MOVE, сохраняя её урон и нужные завершающие фазы", () => {
  for (const kind of ["interrupt_action", "interrupt_turn"]) {
    const state = fixture();
    state.runtime.world.traps.push({
      id: "trap",
      kind: "trap",
      definitionId: "snare",
      position: { x: 1, y: 0 },
    });
    add(
      state,
      "DEATH",
      [
        interrupt(kind, { kind: "occupant" }),
        { kind: "create_damage_event", target: { kind: "cell" }, amount: 1 },
      ],
      "trap",
    );
    const { result, phases } = run(state, (_, context) =>
      executeMove(context.runtime, "actor", { kind: "unit", id: "target" }, createSeededRng(27)),
    );
    assert.equal(result.actions.length, kind === "interrupt_action" ? 2 : 1);
    assert.equal(state.runtime.world.units[0].stats.hp, 4);
    assert.deepEqual(state.runtime.world.units[0].position, {
      x: kind === "interrupt_action" ? 3 : 1,
      y: 0,
    });
    assert.equal(state.runtime.world.traps.length, 0);
    assert.deepEqual(state.runtime.movement.active, []);
    assert.deepEqual(
      phases,
      kind === "interrupt_action" ? normalPhases : normalPhases.filter(([, slot]) => slot !== 2),
    );
  }
});
