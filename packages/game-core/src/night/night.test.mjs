import assert from "node:assert/strict";
import test from "node:test";
import { loadWorld, createMoveState } from "@deathwarriors/game-core";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDamageState } from "@deathwarriors/game-core/damage";
import { createSummoningState } from "@deathwarriors/game-core/summoning";
import { createSeededRng, restoreSeededRng } from "@deathwarriors/game-core/random";
import { createNight, stepNight, runNight, getNextNightUnit } from "@deathwarriors/game-core/night";
import {
  recordSimulation,
  replaySimulation,
  createJournalDamageQueue,
} from "@deathwarriors/game-core/journal";

const zeroMask = () => Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
const cross = [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
function fixture(enemy = true) {
  const unit = (id, side, x, agility) => ({
    id,
    kind: "unit",
    definitionId: id,
    side,
    alive: true,
    position: { x, y: 0 },
    stats: { hp: 30, maxHP: 30, strength: 1, agility, damage: 1, movement: 0, resistance: 0 },
    attackMask: zeroMask(),
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
        units: [
          unit("defender", "defender", 0, 10),
          ...(enemy ? [unit("enemy", "enemy", 6, 0)] : []),
        ],
        traps: [],
      }),
      effects: createEffectStore(),
      movement: createMoveState(),
      summoning: createSummoningState(),
    },
    damage: createDamageState(),
  };
}
const owner = { kind: "owner" };
const defender = (data) => data.runtime.world.units.find((unit) => unit.id === "defender");
const enemy = (data) => data.runtime.world.units.find((unit) => unit.id === "enemy");
const add = (data, ownerId, phase, operations, state = {}) =>
  addEffect(data.runtime.effects, {
    ownerId,
    definitionId: ownerId + "-" + phase,
    phase,
    operations,
    state,
  });
const kill = (target = owner) => ({ kind: "modify_hp", target, delta: -100 });
const reinforcement = (data) => {
  const unit = defender(data);
  return {
    definitionId: "new-defender",
    kind: "unit",
    side: "defender",
    stats: { ...unit.stats, hp: 30, agility: 100 },
    attackMask: zeroMask(),
    keywords: [],
    effects: [],
  };
};
const summon = (template) => ({ kind: "place_entity", target: { kind: "cell" }, template });

test("без врагов исполняются все 13 раундов, постоянные эффекты и их счётчики сохраняются", () => {
  const data = fixture(false);
  add(
    data,
    "defender",
    "TURN_START",
    [
      { kind: "modify_hp", target: owner, delta: -1 },
      { kind: "modify_counter", instance: { kind: "self" }, name: "ticks", delta: 1 },
    ],
    { ticks: 0 },
  );
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  const rounds = [];
  runNight(data.runtime, state, data.damage, rng, { onRoundEnd: (round) => rounds.push(round) });
  assert.equal(state.status, "completed");
  assert.equal(state.completedRounds, 13);
  assert.equal(state.turnsTaken, 13);
  assert.deepEqual(
    rounds,
    Array.from({ length: 13 }, (_, i) => i + 1),
  );
  assert.equal(defender(data).stats.hp, 17);
  assert.equal(data.runtime.effects.instances[0].state.ticks, 13);
});

test("гибель врага в первом раунде не сокращает оставшиеся раунды", () => {
  const data = fixture();
  add(data, "defender", "TURN_START", [kill({ kind: "unit", id: "enemy" })]);
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  runNight(data.runtime, state, data.damage, rng);
  assert.equal(state.status, "completed");
  assert.equal(state.turnsTaken, 13);
  assert.equal(enemy(data).alive, false);
  assert.deepEqual(state.departedEnemyIds, []);
});

test("последний защитник погиб в начале раунда: остальные ходы исполняются до проверки поражения", () => {
  const data = fixture();
  add(data, "defender", "TURN_START", [kill()]);
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  const first = stepNight(data.runtime, state, data.damage, rng);
  assert.equal(first.turn.result.status, "dead");
  assert.equal(state.status, "running");
  assert.equal(state.completedRounds, 0);
  assert.equal(getNextNightUnit(data.runtime, state), "enemy");
  const second = stepNight(data.runtime, state, data.damage, rng);
  assert.equal(second.turn.ownerId, "enemy");
  assert.equal(second.turn.result.actions.length, 2);
  assert.equal(state.status, "defeat");
  assert.equal(state.completedRounds, 1);
  assert.equal(enemy(data).alive, true);
});

test("DEATH-призыв нового защитника спасает раунд и получает первый ход в текущем хвосте", () => {
  const data = fixture();
  add(data, "defender", "TURN_START", [kill()]);
  add(data, "defender", "DEATH", [summon(reinforcement(data))]);
  const seeded = createSeededRng(30);
  let rolls = 0;
  const rng = {
    ...seeded,
    d6: () => {
      rolls += 1;
      return seeded.d6();
    },
  };
  const state = createNight(data.runtime, rng);
  stepNight(data.runtime, state, data.damage, rng);
  const replacement = data.runtime.world.units.find((unit) => unit.definitionId === "new-defender");
  assert(replacement);
  assert.deepEqual(state.order, ["enemy", replacement.id]);
  assert.equal(getNextNightUnit(data.runtime, state), "enemy");
  stepNight(data.runtime, state, data.damage, rng);
  assert.equal(getNextNightUnit(data.runtime, state), replacement.id);
  const tail = stepNight(data.runtime, state, data.damage, rng);
  assert.equal(tail.turn.ownerId, replacement.id);
  assert.equal(tail.turn.round, 1);
  assert.equal(state.round, 2);
  assert.equal(state.status, "running");
  assert.equal(getNextNightUnit(data.runtime, state), "enemy");
  assert.equal(rolls, 2);
});

test("защитников нет между ходами, но более поздний DEATH/SUMMON того же раунда предотвращает поражение", () => {
  const data = fixture();
  add(data, "defender", "TURN_START", [kill()]);
  add(data, "enemy", "TURN_START", [kill()]);
  add(data, "enemy", "DEATH", [summon(reinforcement(data))]);
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  stepNight(data.runtime, state, data.damage, rng);
  assert.equal(
    data.runtime.world.units.some((unit) => unit.side === "defender" && unit.alive),
    false,
  );
  assert.equal(state.status, "running");
  runNight(data.runtime, state, data.damage, rng);
  assert.equal(state.status, "completed");
  assert.equal(state.completedRounds, 13);
  assert.equal(state.turnsTaken, 15);
});

test("удаление текущего ID не пропускает следующего участника из-за смещения индексов", () => {
  const data = fixture();
  const second = structuredClone(defender(data));
  second.id = "second";
  second.position.x = 2;
  second.stats.agility = 5;
  data.runtime.world.units.push(second);
  add(data, "defender", "TURN_START", [kill()]);
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  const taken = [];
  for (let i = 0; i < 3; i += 1) {
    taken.push(stepNight(data.runtime, state, data.damage, rng).turn.ownerId);
  }
  assert.deepEqual(taken, ["defender", "second", "enemy"]);
  assert.equal(state.round, 2);
  assert.equal(getNextNightUnit(data.runtime, state), "second");
});

test("поражение в конце 13-го раунда проверяется перед исчезновением врагов", () => {
  const data = fixture();
  defender(data).stats.hp = 13;
  add(data, "defender", "TURN_START", [{ kind: "modify_hp", target: owner, delta: -1 }]);
  add(
    data,
    "enemy",
    "TURN_START",
    [{ kind: "modify_counter", instance: { kind: "self" }, name: "turns", delta: 1 }],
    { turns: 0 },
  );
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  runNight(data.runtime, state, data.damage, rng);
  assert.equal(state.status, "defeat");
  assert.equal(state.completedRounds, 13);
  assert.equal(enemy(data), undefined);
  assert.deepEqual(state.departedEnemyIds, ["enemy"]);
  assert.equal(
    data.runtime.effects.instances.find((effect) => effect.ownerId === "enemy").state.turns,
    13,
  );
});

test("после 13-го раунда выжившие враги исчезают без DEATH, HP и локальные стеки не очищаются", () => {
  const data = fixture();
  add(data, "defender", "TURN_START", [{ kind: "modify_hp", target: owner, delta: -1 }]);
  add(data, "enemy", "DEATH", [kill({ kind: "unit", id: "defender" })]);
  const departing = enemy(data);
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  runNight(data.runtime, state, data.damage, rng);
  assert.equal(state.status, "completed");
  assert.deepEqual(state.departedEnemyIds, ["enemy"]);
  assert.equal(enemy(data), undefined);
  assert.equal(defender(data).stats.hp, 17);
  assert.equal(departing.alive, true);
  assert.equal(departing.stats.hp, 30);
  assert.equal(data.runtime.effects.instances.length, 2);
  assert.deepEqual(state.order, ["defender"]);
});

test("характеристики и эффекты продолжают действовать между двумя ночами без автоматического отката", () => {
  const data = fixture(false);
  add(data, "defender", "TURN_START", [
    { kind: "modify_stat", target: owner, stat: "strength", delta: 1 },
  ]);
  for (let i = 0; i < 2; i += 1) {
    const rng = createSeededRng(30 + i);
    const state = createNight(data.runtime, rng);
    runNight(data.runtime, state, data.damage, rng);
  }
  assert.equal(defender(data).stats.strength, 27);
  assert.equal(data.runtime.effects.instances.length, 1);
});

test("ночь очищает индивидуальные знания на старте и на завершении", () => {
  const data = fixture(false);
  defender(data).knownTrapIds = ["old"];
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  assert.equal(defender(data).knownTrapIds, undefined);
  defender(data).knownTrapIds = ["during"];
  runNight(data.runtime, state, data.damage, rng);
  assert.equal(defender(data).knownTrapIds, undefined);
});

test("неразрешённые смерти и активное действие отклоняются до расхода инициативы", () => {
  for (const mode of ["hp", "move"]) {
    const data = fixture();
    if (mode === "hp") {
      defender(data).stats.hp = 0;
    } else {
      data.runtime.movement.active.push({ id: "active" });
    }
    assert.throws(() =>
      createNight(data.runtime, {
        d6() {
          assert.fail("Инициатива не должна разыгрываться");
        },
      }),
    );
  }
});

test("JSON-снимок между ходами и восстановленный RNG продолжают ту же ночь", () => {
  const data = fixture();
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  stepNight(data.runtime, state, data.damage, rng);
  stepNight(data.runtime, state, data.damage, rng);
  const saved = JSON.parse(JSON.stringify({ data, state, rng: rng.snapshot() }));
  runNight(data.runtime, state, data.damage, rng);
  const restored = restoreSeededRng(saved.rng);
  runNight(saved.data.runtime, saved.state, saved.data.damage, restored);
  assert.deepEqual(saved.data, data);
  assert.deepEqual(saved.state, state);
  assert.deepEqual(restored.snapshot(), rng.snapshot());
});

test("обнаружение в ночи использует общий RNG, сохраняя наблюдение исходов", () => {
  const data = fixture();
  enemy(data).attackMask = cross;
  enemy(data).stats.agility = 20;
  data.runtime.world.traps.push({
    id: "snare",
    kind: "trap",
    definitionId: "snare",
    position: { x: 5, y: 0 },
  });
  add(data, "enemy", "TURN_START", [{ kind: "discover_trap", trapId: "snare", probability: 0.5 }]);
  const outcomes = [];
  data.runtime.trapDiscovery = {
    rng: {
      nextFloat() {
        assert.fail("Нельзя использовать отдельный RNG");
      },
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  };
  const seeded = createSeededRng(30);
  let draws = 0;
  const rng = {
    ...seeded,
    nextFloat: () => {
      draws += 1;
      return seeded.nextFloat();
    },
  };
  const state = createNight(data.runtime, rng);
  runNight(data.runtime, state, data.damage, rng);
  assert(draws > 0);
  assert.equal(draws, outcomes.length);
  assert.equal(state.status, "completed");
});

test("по умолчанию защитник знает внутренних врагов, явная политика может ограничить знание", () => {
  const data = fixture();
  defender(data).attackMask = cross;
  enemy(data).position.x = 1;
  defender(data).stats.strength = 20;
  defender(data).stats.damage = 30;
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  stepNight(data.runtime, state, data.damage, rng);
  assert.equal(enemy(data).alive, false);

  const hidden = fixture();
  defender(hidden).attackMask = cross;
  enemy(hidden).position.x = 1;
  const rng2 = createSeededRng(30);
  const state2 = createNight(hidden.runtime, rng2);
  const first = stepNight(hidden.runtime, state2, hidden.damage, rng2, {
    getOptions: () => ({ knownEnemyIds: [] }),
  });
  assert(first.turn.result.actions.every((action) => action.kind === "MOVE"));
  assert.equal(enemy(hidden).stats.hp, 30);
});

test("изменение ловкости в ходе ночи не пересортировывает исходную очередь", () => {
  const data = fixture();
  enemy(data).stats.agility = 20;
  defender(data).stats.agility = 0;
  add(data, "defender", "TURN_START", [
    { kind: "modify_stat", target: owner, stat: "agility", delta: 20 },
  ]);
  const seeded = createSeededRng(30);
  let rolls = 0;
  const rng = {
    ...seeded,
    d6: () => {
      rolls += 1;
      return seeded.d6();
    },
  };
  const state = createNight(data.runtime, rng);
  const actors = [];
  runNight(data.runtime, state, data.damage, rng, { onTurn: (turn) => actors.push(turn.ownerId) });
  assert.deepEqual(actors, Array.from({ length: 13 }, () => ["enemy", "defender"]).flat());
  assert.equal(rolls, 2);
});

test("ошибка исполнения помечает ночь неисправимой и не допускает продолжения частичной очереди", () => {
  const data = fixture();
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  assert.throws(
    () =>
      stepNight(data.runtime, state, data.damage, rng, {
        createTurnOptions: () => ({
          createQueue() {
            throw new Error("broken");
          },
        }),
      }),
    /broken/,
  );
  assert.equal(state.failed, true);
  assert.throws(() => stepNight(data.runtime, state, data.damage, rng), /после ошибки/);
  assert.throws(() => runNight(data.runtime, state, data.damage, rng), /после ошибки/);
});

test("завершённая ночь идемпотентна, пустой состав проверяет поражение на границе первого раунда", () => {
  const data = fixture(false);
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  runNight(data.runtime, state, data.damage, rng);
  const before = JSON.stringify({ data, state, rng: rng.snapshot() });
  const result = stepNight(data.runtime, state, data.damage, rng, {
    onRoundEnd() {
      assert.fail("Ночь уже завершена");
    },
  });
  assert.deepEqual(result, { kind: "finished", round: 13, status: "completed" });
  assert.equal(JSON.stringify({ data, state, rng: rng.snapshot() }), before);

  const empty = fixture(false);
  empty.runtime.world.units = [];
  const noRng = {
    d6() {
      assert.fail("Нет участников инициативы");
    },
  };
  const state2 = createNight(empty.runtime, noRng);
  assert.equal(state2.status, "running");
  assert.equal(stepNight(empty.runtime, state2, empty.damage, rng).status, "defeat");
  assert.equal(state2.completedRounds, 1);
});

test("полная ночь и журнал воспроизводятся через JSON с общим seeded RNG", () => {
  const initial = fixture();
  const runner = (data, journal, rng) => {
    const state = createNight(data.runtime, rng);
    journal.append("initiative", state.initiative);
    runNight(data.runtime, state, data.damage, rng, {
      onRoundStart: (round) => journal.append("round_start", { round }),
      onRoundEnd: (round) => journal.append("round_end", { round }),
      onTurn: (turn) => journal.append("turn_result", turn),
      onFinish: (status) => journal.append("night_end", { status }),
      createTurnOptions: (location) => ({
        createQueue: (runtime) =>
          createJournalDamageQueue(journal, runtime, data.damage, () => state.order),
        onPhase: (phase, slot) => {
          journal.setScope({ ...location, slot, phase });
          journal.append("phase", { phase });
        },
        onAction: (action) => journal.append("action", action),
      }),
    });
    return { data, state };
  };
  const recording = recordSimulation(initial, 30, runner);
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), runner).matches, true);
  assert.equal(recording.entries.filter((entry) => entry.kind === "round_end").length, 13);
  assert.equal(recording.entries.filter((entry) => entry.kind === "turn_result").length, 26);
  assert.equal(recording.final.state.status, "completed");
  assert.equal(initial.runtime.world.units.length, 2);
});

test("призыв в конце 13-го раунда успевает получить ход и спасти ночь до исчезновения врагов", () => {
  const data = fixture();
  defender(data).stats.hp = 13;
  add(data, "defender", "TURN_START", [{ kind: "modify_hp", target: owner, delta: -1 }]);
  add(data, "defender", "DEATH", [summon(reinforcement(data))]);
  const rng = createSeededRng(30);
  const state = createNight(data.runtime, rng);
  const lastRound = [];
  runNight(data.runtime, state, data.damage, rng, {
    onTurn: (turn) => {
      if (turn.round === 13) {
        lastRound.push(turn.ownerId);
      }
    },
  });
  const replacement = data.runtime.world.units.find((unit) => unit.definitionId === "new-defender");
  assert.equal(state.status, "completed");
  assert.deepEqual(lastRound, ["defender", "enemy", replacement.id]);
  assert.deepEqual(state.departedEnemyIds, ["enemy"]);
  assert.equal(state.completedRounds, 13);
  assert.equal(state.turnsTaken, 27);
});
