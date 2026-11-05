import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  loadWorld,
  parseWorld,
  serializeWorld,
  canStep,
  canEnterCell,
} from "@deathwarriors/game-core";
import { tryDiscoverTrap, clearTrapKnowledge } from "@deathwarriors/game-core/trap-discovery";
import { getEnemyRouteTargets } from "@deathwarriors/game-core/enemy-targeting";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { runUnitTurn } from "@deathwarriors/game-core/turn";
import {
  createJournalDamageQueue,
  recordSimulation,
  replaySimulation,
} from "@deathwarriors/game-core/journal";

const example = JSON.parse(await readFile(new URL("./example.json", import.meta.url), "utf8"));
const mask = [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
function fixture() {
  const unit = (id, side, x) => ({
    id,
    kind: "unit",
    definitionId: "fighter",
    side,
    alive: true,
    position: { x, y: 0 },
    stats: { hp: 5, maxHP: 5, strength: 1, agility: 5, damage: 1, movement: 2, resistance: 0 },
    attackMask: mask,
    keywords: [],
  });
  return {
    runtime: {
      world: loadWorld({
        version: 1,
        map: {
          width: 7,
          height: 2,
          cells: Array.from({ length: 14 }, (_, i) => ({
            surface: "floor",
            area: "inside",
            structure: i < 7 ? null : { id: `wall-${i}`, kind: "wall" },
          })),
        },
        units: [unit("actor", "enemy", 0), unit("target", "defender", 6)],
        traps: [{ id: "snare-1", kind: "trap", definitionId: "snare", position: { x: 1, y: 0 } }],
      }),
      effects: createEffectStore(),
    },
    damage: createDamageState(),
    order: ["actor", "target"],
  };
}
const actor = (state) => state.runtime.world.units[0];
const forbiddenRng = {
  nextFloat() {
    assert.fail("Не должно быть случайного броска");
  },
};
const attempt = (state, probability = 1, rng = forbiddenRng, options = {}) =>
  tryDiscoverTrap(state.runtime.world, "actor", "snare-1", probability, rng, options);
const install = (state, effect = example) =>
  addEffect(state.runtime.effects, { ...structuredClone(effect), ownerId: "actor" });
function turn(state) {
  return runUnitTurn(state.runtime, "actor", () => state.order, {
    chooseAction: () => ({ kind: "MOVE" }),
    executeAction: function* () {},
    createQueue: (runtime) => createDamageQueue(runtime, state.damage, () => state.order),
  });
}

test("успех блокирует клетку и путь только обнаружившему врагу, запирание допустимо", () => {
  const state = fixture();
  state.runtime.world.map.cells[7].structure = null;
  const ally = structuredClone(actor(state));
  ally.id = "ally";
  ally.position = { x: 0, y: 1 };
  state.runtime.world.units.push(ally);
  assert.equal(attempt(state).status, "discovered");
  assert.deepEqual(actor(state).knownTrapIds, ["snare-1"]);
  assert.equal(ally.knownTrapIds, undefined);
  assert.equal(canStep(state.runtime.world, actor(state), { x: 1, y: 0 }), false);
  assert.equal(canEnterCell(state.runtime.world, ally, { x: 1, y: 0 }), true);
  assert.equal(
    getEnemyRouteTargets(state.runtime.world, "actor").some((goal) => goal.kind === "unit"),
    false,
  );
});

test("доступная атака защитника исключает проверку без RNG", () => {
  const state = fixture();
  state.runtime.world.traps[0].position.x = 2;
  state.runtime.world.units[1].position.x = 1;
  assert.deepEqual(attempt(state, 0.5), { status: "unavailable", reason: "attack_available" });
});

test("доступное укрепление не подменяет условие отсутствия атакуемого защитника", () => {
  const state = fixture();
  state.runtime.world.map.cells[7].structure = {
    id: "fort",
    kind: "door",
    state: "closed",
    interactionMask: mask,
    reinforcement: { hp: 5, maxHP: 5, resistance: 0 },
  };
  assert.equal(attempt(state).status, "discovered");
});

test("маршрут только к закрытому проёму не считается маршрутом к защитнику", () => {
  const state = fixture();
  state.runtime.world.map.cells[2].structure = {
    id: "door",
    kind: "door",
    state: "closed",
    interactionMask: mask,
    reinforcement: null,
  };
  assert.deepEqual(attempt(state, 0.5), { status: "unavailable", reason: "no_defender_route" });
});

test("текущие знания и ограничения ключевых слов учитываются до броска", () => {
  const state = fixture();
  assert.equal(
    attempt(state, 0.5, forbiddenRng, { movement: { directions: [] } }).reason,
    "no_defender_route",
  );
  state.runtime.world.traps.push({
    id: "known",
    kind: "trap",
    definitionId: "snare",
    position: { x: 2, y: 0 },
  });
  actor(state).knownTrapIds = ["known"];
  assert.equal(attempt(state, 0.5).reason, "no_defender_route");
});

test("отсутствующие, мёртвые и чужие владельцы, удалённая и известная ловушка не требуют RNG", () => {
  const state = fixture();
  assert.equal(
    tryDiscoverTrap(state.runtime.world, "target", "snare-1", 0.5, forbiddenRng).reason,
    "actor_unavailable",
  );
  assert.equal(
    tryDiscoverTrap(state.runtime.world, "missing", "snare-1", 0.5, forbiddenRng).reason,
    "actor_unavailable",
  );
  assert.equal(
    tryDiscoverTrap(state.runtime.world, "actor", "missing", 0.5, forbiddenRng).reason,
    "trap_unavailable",
  );
  attempt(state);
  assert.equal(attempt(state, 0.5).reason, "known");
  actor(state).alive = false;
  actor(state).position = null;
  actor(state).stats.hp = 0;
  assert.equal(attempt(state, 0.5).reason, "actor_unavailable");
});

test("вероятности 0 и 1 определены без броска; неуспех не раскрывает ловушку", () => {
  const state = fixture();
  assert.deepEqual(attempt(state, 0), {
    status: "failed",
    enemyId: "actor",
    trapId: "snare-1",
    probability: 0,
    roll: null,
  });
  assert.equal(actor(state).knownTrapIds, undefined);
  assert.equal(attempt(state).status, "discovered");
});

test("промежуточная вероятность использует один seeded nextFloat и воспроизводится", () => {
  const run = () => {
    const state = fixture();
    const rng = createSeededRng(26);
    let calls = 0;
    const result = attempt(state, 0.5, {
      nextFloat: () => {
        calls += 1;
        return rng.nextFloat();
      },
    });
    assert.equal(calls, 1);
    return { result, world: state.runtime.world, rng: rng.snapshot() };
  };
  assert.deepEqual(run(), run());
  const state = fixture();
  assert.equal(attempt(state, 0.5, { nextFloat: () => 0.5 }).status, "failed");
});

test("пример: одна явная ловушка, clamp(agility*0.1), новая попытка при следующем TURN_START", () => {
  const state = fixture();
  const rolls = [0.9, 0.2];
  const outcomes = [];
  state.runtime.trapDiscovery = {
    rng: {
      nextFloat: () => {
        assert(rolls.length > 0);
        return rolls.shift();
      },
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  };
  install(state);
  assert.equal(turn(state).actions.length, 2);
  assert.equal(actor(state).knownTrapIds, undefined);
  assert.equal(turn(state).actions.length, 2);
  assert.deepEqual(actor(state).knownTrapIds, ["snare-1"]);
  assert.equal(turn(state).actions.length, 2);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["failed", "discovered"],
  );
  assert(outcomes.every((outcome) => outcome.probability === 0.5));
  assert.equal(rolls.length, 0);
});

test("формула читает характеристики после предыдущей операции того же эффекта", () => {
  const state = fixture();
  actor(state).stats.agility = 0;
  const effect = structuredClone(example);
  effect.operations.unshift({
    kind: "modify_stat",
    target: { kind: "owner" },
    stat: "agility",
    delta: 5,
  });
  state.runtime.trapDiscovery = { rng: { nextFloat: () => 0.4 } };
  install(state, effect);
  turn(state);
  assert.deepEqual(actor(state).knownTrapIds, ["snare-1"]);
});

test("операция обнаружения в другой фазе не выполняет попытку", () => {
  const state = fixture();
  state.runtime.trapDiscovery = { rng: forbiddenRng };
  install(state, { ...example, phase: "ACTION_START" });
  turn(state);
  assert.equal(actor(state).knownTrapIds, undefined);
});

test("некорректная вероятность и RNG не записывают ложного знания", () => {
  for (const probability of [-1, 1.1, NaN, Infinity]) {
    const state = fixture();
    assert.throws(() => attempt(state, probability), RangeError);
    assert.equal(actor(state).knownTrapIds, undefined);
  }
  for (const roll of [-0.1, 1, NaN, Infinity]) {
    const state = fixture();
    assert.throws(() => attempt(state, 0.5, { nextFloat: () => roll }), RangeError);
    assert.equal(actor(state).knownTrapIds, undefined);
  }
  const state = fixture();
  install(state);
  assert.throws(() => turn(state), /trapDiscovery/);
});

test("знание переживает JSON, удаление ловушки и очищается на границе ночи", () => {
  const state = fixture();
  attempt(state);
  const copy = parseWorld(serializeWorld(state.runtime.world));
  copy.units[0].knownTrapIds.push("other");
  assert.deepEqual(actor(state).knownTrapIds, ["snare-1"]);
  state.runtime.world.traps = [];
  const loaded = loadWorld(state.runtime.world);
  assert.deepEqual(loaded.units[0].knownTrapIds, ["snare-1"]);
  clearTrapKnowledge(loaded);
  assert.equal(Object.hasOwn(loaded.units[0], "knownTrapIds"), false);
  clearTrapKnowledge(state.runtime.world);
  assert.equal(actor(state).knownTrapIds, undefined);
});

test("загрузчик проверяет индивидуальные знания и сохраняет старые сценарии без нового поля", () => {
  const state = fixture();
  assert.equal(Object.hasOwn(actor(state), "knownTrapIds"), false);
  actor(state).knownTrapIds = [""];
  assert.throws(
    () => loadWorld(state.runtime.world),
    (error) => error.path === "$.units[0].knownTrapIds[0]",
  );
});

test("принудительное попадание срабатывает независимо от индивидуального знания", () => {
  const state = fixture();
  attempt(state);
  const queue = createDamageQueue(state.runtime, state.damage, () => state.order);
  queue.enqueue({
    ownerId: "actor",
    instanceId: "push",
    definitionId: "push",
    source: "ordinary",
    phase: "ACTION_START",
    state: {},
    context: { kind: "move_end", ownerId: "actor", cell: { x: 1, y: 0 } },
    operations: [{ kind: "move_unit", target: { kind: "owner" } }],
  });
  queue.drain();
  assert.deepEqual(actor(state).position, { x: 1, y: 0 });
  assert.equal(state.runtime.world.traps.length, 0);
});

test("журнал, формула и индивидуальное знание воспроизводятся через JSON", () => {
  const initial = fixture();
  install(initial);
  const runner = (state, journal, rng) => {
    state.runtime.trapDiscovery = {
      rng,
      onOutcome: (outcome) => journal.append("trap_discovery", outcome),
    };
    const result = runUnitTurn(state.runtime, "actor", () => state.order, {
      chooseAction: () => ({ kind: "MOVE" }),
      executeAction: function* () {},
      createQueue: (runtime) =>
        createJournalDamageQueue(journal, runtime, state.damage, () => state.order),
    });
    return {
      world: state.runtime.world,
      effects: state.runtime.effects,
      damage: state.damage,
      order: state.order,
      result,
    };
  };
  const recording = recordSimulation(initial, 26, runner);
  assert.equal(replaySimulation(JSON.parse(JSON.stringify(recording)), runner).matches, true);
  assert.equal(recording.entries.filter((entry) => entry.kind === "trap_discovery").length, 1);
  assert.equal(initial.runtime.world.units[0].knownTrapIds, undefined);
});
