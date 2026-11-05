import assert from "node:assert/strict";
import test from "node:test";
import { createSimulation } from "@deathwarriors/game-core/simulation";
import {
  fixture,
  addUnit,
  addTrap,
  ability,
  owner,
  byId,
  hp,
  speed,
  unit,
  actions,
  operations,
  moves,
} from "./fixtures.mjs";

function pair() {
  const input = fixture(9);
  addUnit(input, { id: "guard", x: 0 });
  addUnit(input, { id: "enemy", side: "enemy", x: 8 });
  return input;
}

function nextOwnTurn(simulation) {
  simulation.step();
  return simulation.step();
}

test("HP 0 → heal внутри одного эффекта не создаёт смерть или поражение", () => {
  const input = pair();
  input.scenario.world.units[0].stats.hp = 1;
  ability(input, "guard", "atomic-heal", "TURN_START", [
    hp(owner, -1),
    { kind: "heal", target: owner, value: 5 },
  ]);
  const result = createSimulation(input).step();
  assert.equal(unit(result.snapshot, "guard").alive, true);
  assert.equal(unit(result.snapshot, "guard").stats.hp, 5);
  assert.equal(actions(result.events, "guard").length, 2);
  const changes = operations(result.events, "atomic-heal").flatMap((entry) => entry.hp);
  assert.deepEqual(changes, [
    { id: "guard", before: 1, after: 0 },
    { id: "guard", before: 0, after: 5 },
  ]);
  assert(
    result.events
      .filter((entry) => entry.kind === "entry_end")
      .every((entry) => entry.data.deaths.length === 0),
  );
});

test("копия фазы не читает изменённый постоянный счётчик до следующего снимка", () => {
  const input = pair();
  input.scenario.world.units[0].stats.hp = 5;
  ability(
    input,
    "guard",
    "snapshot-counter",
    "TURN_START",
    [
      { kind: "modify_counter", instance: { kind: "self" }, name: "n", delta: 1 },
      hp(owner, { kind: "state", name: "n" }),
    ],
    { n: 0 },
  );
  const simulation = createSimulation(input);
  const first = simulation.step();
  assert.equal(unit(first.snapshot, "guard").stats.hp, 5);
  const second = nextOwnTurn(simulation);
  assert.equal(unit(second.snapshot, "guard").stats.hp, 6);
  const third = nextOwnTurn(simulation);
  assert.equal(unit(third.snapshot, "guard").stats.hp, 8);
});

test("удаление оригинала не отменяет оставшиеся операции копии и не срабатывает снова", () => {
  const input = pair();
  ability(input, "guard", "one-shot", "TURN_START", [
    { kind: "remove_effect", instance: { kind: "self" } },
    hp(owner, -2),
  ]);
  const simulation = createSimulation(input);
  assert.equal(unit(simulation.step().snapshot, "guard").stats.hp, 18);
  const second = nextOwnTurn(simulation);
  assert.equal(unit(second.snapshot, "guard").stats.hp, 18);
  assert.equal(operations(second.events, "one-shot").length, 0);
});

test("добавленный эффект той же фазы ждёт следующего входа, копии не объединяются", () => {
  const input = pair();
  input.content.effects.push({
    definitionId: "new-wound",
    phase: "TURN_START",
    state: {},
    operations: [hp(owner, -3)],
  });
  ability(input, "guard", "seed-wound", "TURN_START", [
    { kind: "add_effect", target: owner, effectId: "new-wound" },
  ]);
  const simulation = createSimulation(input);
  assert.equal(unit(simulation.step().snapshot, "guard").stats.hp, 20);
  assert.equal(unit(nextOwnTurn(simulation).snapshot, "guard").stats.hp, 17);
  const third = nextOwnTurn(simulation);
  assert.equal(unit(third.snapshot, "guard").stats.hp, 11);
  const hits = operations(third.events, "new-wound");
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0].instanceId, hits[1].instanceId);
});

test("E101/E102: модификаторы LIFO изолированы, смерть атакующего не отменяет исходный урон", () => {
  const input = fixture(6, 5);
  addUnit(input, { id: "attacker", x: 3, y: 3, stats: { strength: 100, damage: 3 } });
  addUnit(input, { id: "target", side: "enemy", x: 4, y: 3, stats: { resistance: 2 } });
  ability(input, "attacker", "attack-modifiers", "ATTACK_SUCCESS", [
    {
      kind: "add_damage_modifier",
      event: { kind: "context_damage" },
      modifier: { type: "relative", value: 2 },
    },
    hp(owner, -20),
    {
      kind: "add_damage_modifier",
      event: { kind: "context_damage" },
      modifier: { type: "absolute", value: 4 },
    },
  ]);
  ability(input, "attacker", "death-burst", "DEATH", [
    { kind: "place_entity", target: { kind: "cell" }, definitionId: "warrior" },
    { kind: "create_damage_event", target: { kind: "cell" }, amount: 2 },
  ]);
  const result = createSimulation(input).step();
  const hits = result.events.filter((entry) => entry.kind === "damage").map((entry) => entry.data);
  assert.deepEqual(
    hits.map(({ cell, amount, resolvedAmount, hpLoss }) => ({
      cell,
      amount,
      resolvedAmount,
      hpLoss,
    })),
    [
      { cell: { x: 3, y: 3 }, amount: 2, resolvedAmount: 2, hpLoss: 2 },
      { cell: { x: 4, y: 3 }, amount: 3, resolvedAmount: 6, hpLoss: 4 },
    ],
  );
  assert.notEqual(hits[0].eventId, hits[1].eventId);
  assert.equal(unit(result.snapshot, "attacker").alive, false);
  assert.equal(unit(result.snapshot, "target").stats.hp, 16);
  assert.equal(unit(result.snapshot, hits[0].targetId).stats.hp, 8);
  assert.equal(result.snapshot.status, "running");
  assert.equal(actions(result.events, "attacker").length, 1);
});

test("A → B → A обрывается по definitionId, независимая атака запускает новую цепочку", () => {
  const input = fixture(2);
  addUnit(input, { id: "attacker", x: 0, stats: { strength: 100 } });
  addUnit(input, { id: "target", side: "enemy", x: 1 });
  ability(input, "attacker", "A", "ATTACK_SUCCESS", [
    { kind: "trigger_reaction", target: byId("target"), phase: "DEFENSE_FAILURE" },
  ]);
  ability(input, "target", "B", "DEFENSE_FAILURE", [
    { kind: "trigger_reaction", target: byId("attacker"), phase: "ATTACK_SUCCESS" },
  ]);
  const result = createSimulation(input).step();
  assert.equal(actions(result.events, "attacker").length, 2);
  assert.equal(operations(result.events, "A").length, 4);
  assert.equal(operations(result.events, "B").length, 4);
  const skipped = result.events.filter((entry) => entry.kind === "skipped");
  assert.equal(skipped.length, 4);
  assert(skipped.every((entry) => entry.data.reason === "reaction_cycle"));
  assert.deepEqual(skipped[0].data.entry.cause.definitionIds, ["A", "B"]);
  assert.equal(result.events.filter((entry) => entry.kind === "damage").length, 2);
  assert.equal(result.snapshot.status, "running");
});

for (const [initial, delta, expected] of [
  [3, -2, 2],
  [1, 2, 6],
]) {
  test("ловушка меняет бюджет текущего MOVE: " + initial + " → " + (initial + delta), () => {
    const input = pair();
    const enemy = input.scenario.world.units[1];
    enemy.position.x = 0;
    enemy.stats.agility = 200;
    enemy.stats.movement = initial;
    input.scenario.world.units[0].position.x = 8;
    addTrap(input, "snare", 1);
    ability(input, "snare", "trap-speed", "DEATH", [speed({ kind: "occupant" }, delta)]);
    const result = createSimulation(input).step();
    assert.deepEqual(
      moves(result.events, "enemy"),
      Array.from({ length: expected }, (_, index) => ({ x: index + 1, y: 0 })),
    );
    assert.deepEqual(unit(result.snapshot, "enemy").position, { x: expected, y: 0 });
    assert.equal(unit(result.snapshot, "enemy").stats.movement, initial + delta);
    assert.equal(result.snapshot.world.traps.length, 0);
  });
}

for (const [kind, expectedX, slots] of [
  ["interrupt_action", 4, 2],
  ["interrupt_turn", 1, 1],
]) {
  test("ловушка: " + kind + " сохраняет атом и урон, но прекращает дальнейшие шаги", () => {
    const input = pair();
    input.scenario.world.units[0].position.x = 8;
    const enemy = input.scenario.world.units[1];
    enemy.position.x = 0;
    enemy.stats.agility = 200;
    enemy.stats.movement = 3;
    addTrap(input, "snare", 1);
    ability(input, "snare", "trap-interrupt", "DEATH", [
      { kind, target: { kind: "occupant" } },
      hp({ kind: "occupant" }, -1),
      { kind: "create_damage_event", target: { kind: "cell" }, amount: 2 },
    ]);
    const simulation = createSimulation(input);
    const result = simulation.step();
    assert.equal(unit(result.snapshot, "enemy").stats.hp, 17);
    assert.deepEqual(unit(result.snapshot, "enemy").position, { x: expectedX, y: 0 });
    assert.equal(actions(result.events, "enemy").length, slots);
    const end = result.events.filter(
      (entry) => entry.kind === "phase" && entry.data.phase === "ACTION_END",
    );
    assert.equal(end.length, slots);
    assert(
      result.events.some((entry) => entry.kind === "phase" && entry.data.phase === "TURN_END"),
    );
    const damageIndex = result.events.findIndex((entry) => entry.kind === "damage");
    const endIndex = result.events.findIndex(
      (entry) => entry.kind === "phase" && entry.data.phase === "ACTION_END",
    );
    assert(damageIndex >= 0 && damageIndex < endIndex);
    simulation.step();
    const next = simulation.step();
    assert(actions(next.events, "enemy").length > 0);
  });
}

test("DEATH ловушки передаёт CELL_DAMAGE и кровотечение вошедшему, а не владельцу ловушки", () => {
  const input = pair();
  input.scenario.world.units[0].position.x = 8;
  const enemy = input.scenario.world.units[1];
  enemy.position.x = 0;
  enemy.stats.agility = 200;
  enemy.stats.movement = 2;
  addTrap(input, "snare", 1);
  ability(input, "snare", "injure", "DEATH", [
    { kind: "create_damage_event", target: { kind: "cell" }, amount: 2 },
    { kind: "add_effect", target: { kind: "occupant" }, effectId: "bleeding" },
  ]);
  const simulation = createSimulation(input);
  const first = simulation.step();
  assert.equal(unit(first.snapshot, "enemy").stats.hp, 18);
  assert.equal(first.snapshot.world.traps.length, 0);
  const next = nextOwnTurn(simulation);
  assert.equal(unit(next.snapshot, "enemy").stats.hp, 17);
  const bleeding = operations(next.events, "bleeding");
  assert.equal(bleeding.length, 1);
  assert.equal(bleeding[0].ownerId, "enemy");
  assert.equal(bleeding[0].phase, "TURN_START");
  assert.equal(unit(next.snapshot, "guard").stats.hp, 20);
});
