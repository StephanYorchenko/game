import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld } from "@deathwarriors/game-core";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDeathQueue } from "@deathwarriors/game-core/death";
import { runUnitTurn } from "@deathwarriors/game-core/turn";

const owner = { kind: "owner" };

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
      units: [
        {
          id: "actor",
          kind: "unit",
          definitionId: "fighter",
          side: "defender",
          alive: true,
          position: { x: 0, y: 0 },
          stats: {
            hp: 5,
            maxHP: 10,
            strength: 1,
            agility: 1,
            damage: 1,
            movement: 0,
            resistance: 0,
          },
          attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
          keywords: [],
        },
      ],
      traps: [],
    }),
    effects: createEffectStore(),
  };
}

const add = (runtime, phase, operations, definitionId = phase) =>
  addEffect(runtime.effects, {
    definitionId,
    ownerId: "actor",
    phase,
    operations,
    state: {},
  });
const atomic = (id, operations) => ({
  ownerId: "actor",
  instanceId: id,
  definitionId: id,
  phase: "ACTION_START",
  source: "ordinary",
  operations,
  state: {},
  context: { kind: "phase", ownerId: "actor" },
});

test("два слота исполняются последовательно, каждая стадия ждёт предыдущую", () => {
  const runtime = fixture();
  const order = ["actor"];
  const log = [];

  for (const phase of ["TURN_START", "ACTION_START", "ACTION_END", "TURN_END"]) {
    add(runtime, phase, []);
  }

  const result = runUnitTurn(runtime, "actor", () => order, {
    createQueue: () => {
      const queue = createDeathQueue(runtime, () => order);
      return {
        enqueue: (...effects) => {
          log.push(...effects.map((effect) => effect.definitionId));
          queue.enqueue(...effects);
        },
        drain: () => queue.drain(),
      };
    },
    chooseAction: ({ slot }) => {
      log.push(`choose-${slot}`);
      return { kind: "MOVE" };
    },
    executeAction: function* (_, { slot }) {
      log.push(`execute-${slot}`);
      yield [atomic(`atomic-${slot}`, [])];
    },
  });

  assert.deepEqual(log, [
    "TURN_START",
    "ACTION_START",
    "choose-1",
    "execute-1",
    "atomic-1",
    "ACTION_END",
    "ACTION_START",
    "choose-2",
    "execute-2",
    "atomic-2",
    "ACTION_END",
    "TURN_END",
  ]);
  assert.deepEqual(result.actions, [
    { slot: 1, kind: "MOVE" },
    { slot: 2, kind: "MOVE" },
  ]);
  assert.equal(result.status, "completed");
});

test("тип и параметры выбираются после ACTION_START заново для каждого слота", () => {
  const runtime = fixture();
  add(runtime, "ACTION_START", [{ kind: "modify_stat", target: owner, stat: "damage", delta: 2 }]);
  const observed = [];
  runUnitTurn(runtime, "actor", () => ["actor"], {
    chooseAction: ({ unit }) => ({
      kind: unit.stats.hp < 5 ? "INTERACT" : "ATTACK",
      damage: unit.stats.damage,
    }),
    executeAction: function* (action) {
      observed.push(action);
      yield [atomic("hurt", [{ kind: "modify_hp", target: owner, delta: -1 }])];
    },
  });
  assert.deepEqual(observed, [
    { kind: "ATTACK", damage: 3 },
    { kind: "INTERACT", damage: 5 },
  ]);
});

test("нулевой MOVE сохраняет завершающие фазы и расходует оба слота", () => {
  const runtime = fixture();
  add(runtime, "ACTION_END", [{ kind: "modify_stat", target: owner, stat: "strength", delta: 1 }]);
  const result = runUnitTurn(runtime, "actor", () => ["actor"], {
    chooseAction: () => ({ kind: "MOVE" }),
    executeAction: function* () {},
  });
  assert.equal(result.actions.length, 2);
  assert.equal(runtime.world.units[0].stats.strength, 3);
});

test("смерть в TURN_START или ACTION_START отменяет выбор и завершающие фазы", () => {
  for (const trigger of ["TURN_START", "ACTION_START"]) {
    const runtime = fixture();
    const order = ["actor"];
    let choices = 0;
    add(runtime, trigger, [{ kind: "modify_hp", target: owner, delta: -100 }]);
    add(runtime, "TURN_END", [
      { kind: "modify_counter", instance: { kind: "self" }, name: "x", delta: 1 },
    ]);
    const result = runUnitTurn(runtime, "actor", () => order, {
      chooseAction: () => {
        choices += 1;
        return { kind: "MOVE" };
      },
      executeAction: function* () {
        yield* [];
        assert.fail("погибший не исполняет действие");
      },
    });
    assert.equal(choices, 0);
    assert.equal(result.status, "dead");
    assert.deepEqual(result.actions, []);
    assert.deepEqual(order, []);
  }
});

test("смерть внутри действия завершает DEATH, не запрашивает следующий шаг и второй слот", () => {
  const runtime = fixture();
  const order = ["actor"];
  let requested = 0;
  const deathId = addEffect(runtime.effects, {
    definitionId: "death",
    ownerId: "actor",
    phase: "DEATH",
    state: { seen: 0 },
    operations: [{ kind: "modify_counter", instance: { kind: "self" }, name: "seen", delta: 1 }],
  });
  const result = runUnitTurn(runtime, "actor", () => order, {
    chooseAction: () => ({ kind: "MOVE" }),
    executeAction: function* () {
      requested += 1;
      yield [atomic("kill", [{ kind: "modify_hp", target: owner, delta: -100 }])];
      requested += 1;
      yield [atomic("never", [])];
    },
  });
  assert.equal(result.status, "dead");
  assert.equal(result.actions.length, 1);
  assert.equal(requested, 1);
  assert.equal(runtime.effects.instances.find((e) => e.instanceId === deathId).state.seen, 1);
});

test("следующий пакет итератора читает состояние после разрешения предыдущего", () => {
  const runtime = fixture();
  const seen = [];
  runUnitTurn(runtime, "actor", () => ["actor"], {
    chooseAction: () => ({ kind: "ATTACK" }),
    executeAction: function* (_, { unit }) {
      yield [atomic("boost", [{ kind: "modify_stat", target: owner, stat: "damage", delta: 1 }])];
      seen.push(unit.stats.damage);
      yield [];
    },
  });
  assert.deepEqual(seen, [2, 3]);
});

test("смерть в ACTION_END не начинает второй слот и TURN_END", () => {
  const runtime = fixture();
  const order = ["actor"];
  let choices = 0;
  const planned = [];
  add(runtime, "ACTION_START", []);
  add(runtime, "ACTION_END", [{ kind: "modify_hp", target: owner, delta: -100 }]);
  add(runtime, "TURN_END", []);
  const result = runUnitTurn(runtime, "actor", () => order, {
    createQueue: () => {
      const queue = createDeathQueue(runtime, () => order);
      return {
        enqueue: (...effects) => {
          planned.push(...effects.map((effect) => effect.phase));
          queue.enqueue(...effects);
        },
        drain: () => queue.drain(),
      };
    },
    chooseAction: () => {
      choices += 1;
      return { kind: "MOVE" };
    },
    executeAction: function* () {},
  });
  assert.equal(result.status, "dead");
  assert.equal(choices, 1);
  assert.deepEqual(planned, ["ACTION_START", "ACTION_END"]);
});

test("ACTION_END движения получает копию клетки старта, остальные фазы — обычный контекст", () => {
  const runtime = fixture();
  add(runtime, "ACTION_END", []);
  const endings = [];
  runUnitTurn(runtime, "actor", () => ["actor"], {
    createQueue: () => {
      const queue = createDeathQueue(runtime, () => ["actor"]);
      return {
        enqueue: (...effects) => {
          endings.push(...effects.filter((e) => e.phase === "ACTION_END").map((e) => e.context));
          queue.enqueue(...effects);
        },
        drain: () => queue.drain(),
      };
    },
    chooseAction: ({ slot }) => ({ kind: slot === 1 ? "MOVE" : "ATTACK" }),
    executeAction: function* (_, { unit, slot }) {
      yield* [];
      if (slot === 1) {
        unit.position.x = 1;
      }
    },
  });
  assert.deepEqual(endings, [
    { kind: "move_end", ownerId: "actor", cell: { x: 0, y: 0 } },
    { kind: "phase", ownerId: "actor" },
  ]);
});

test("отсутствующий или погибший участник не создаёт очередь и не запускает обработчики", () => {
  const runtime = fixture();
  runtime.world.units[0].alive = false;
  runtime.world.units[0].position = null;
  const handlers = {
    createQueue: () => assert.fail("очередь не нужна"),
    chooseAction: () => assert.fail("выбор не нужен"),
    executeAction: function* () {
      yield* [];
      assert.fail("действие не нужно");
    },
  };
  assert.equal(runUnitTurn(runtime, "actor", () => [], handlers).status, "dead");
  assert.equal(runUnitTurn(runtime, "missing", () => [], handlers).status, "missing");
});
