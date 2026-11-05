import assert from "node:assert/strict";
import test from "node:test";
import { createSimulation } from "@deathwarriors/game-core/simulation";
import {
  fixture,
  addUnit,
  addOpening,
  addTrap,
  ability,
  owner,
  byId,
  hp,
  speed,
  unit,
  actions,
  operations,
} from "./fixtures.mjs";

function pair() {
  const input = fixture(9);
  addUnit(input, { id: "guard", x: 0 });
  addUnit(input, { id: "enemy", side: "enemy", x: 8 });
  return input;
}

function roundEnds(events) {
  return events.filter((entry) => entry.kind === "round_end").map((entry) => entry.data.round);
}

test("смерть в TURN_START отменяет действия, но поражение ждёт оставшиеся ходы раунда", () => {
  const input = pair();
  ability(input, "guard", "fatal", "TURN_START", [hp(owner, -20)]);
  ability(input, "guard", "farewell", "DEATH", [hp(byId("enemy"), -1)]);
  const simulation = createSimulation(input);
  const first = simulation.step();
  assert.equal(unit(first.snapshot, "guard").alive, false);
  assert.equal(unit(first.snapshot, "enemy").stats.hp, 19);
  assert.equal(first.snapshot.status, "running");
  assert.equal(first.snapshot.completedRounds, 0);
  assert.equal(first.snapshot.nextUnitId, "enemy");
  assert.deepEqual(actions(first.events, "guard"), []);
  const phases = first.events
    .filter((entry) => entry.kind === "phase")
    .map((entry) => entry.data.phase);
  assert.deepEqual(phases, ["TURN_START"]);
  const last = simulation.step();
  assert.equal(last.snapshot.status, "defeat");
  assert.equal(last.snapshot.completedRounds, 1);
  assert.equal(last.snapshot.turnsTaken, 2);
  assert.equal(actions(last.events, "enemy").length, 2);
  assert.equal(unit(last.snapshot, "enemy").alive, true);
  assert.deepEqual(roundEnds(simulation.getEvents()), [1]);
});

test("более поздний ход может вернуть защитника: DEATH-призыв получает ход в конце текущего раунда", () => {
  const input = pair();
  ability(input, "guard", "fatal-guard", "TURN_START", [hp(owner, -20)]);
  ability(input, "enemy", "fatal-enemy", "TURN_START", [hp(owner, -20)]);
  ability(input, "enemy", "restore-guard", "DEATH", [
    { kind: "place_entity", target: { kind: "cell" }, definitionId: "warrior" },
  ]);
  const simulation = createSimulation(input);
  assert.equal(simulation.step().snapshot.status, "running");
  const restored = simulation.step();
  const replacement = restored.snapshot.world.units.find((entry) => entry.alive);
  assert.equal(replacement.side, "defender");
  assert.notEqual(replacement.id, "guard");
  assert.equal(restored.snapshot.round, 1);
  assert.equal(restored.snapshot.completedRounds, 0);
  assert.equal(restored.snapshot.nextUnitId, replacement.id);
  const ownTurn = simulation.step();
  assert.equal(ownTurn.snapshot.lastTurn.ownerId, replacement.id);
  assert.equal(ownTurn.snapshot.lastTurn.round, 1);
  assert.equal(ownTurn.snapshot.completedRounds, 1);
  assert.equal(ownTurn.snapshot.status, "running");
  assert.equal(simulation.runToEnd().snapshot.status, "completed");
});

test("после гибели всех врагов ночь идёт 13 раундов, постоянное кровотечение не пропускается", () => {
  const input = pair();
  input.scenario.world.units[0].stats.hp = 30;
  input.scenario.world.units[0].stats.maxHP = 30;
  ability(input, "guard", "kill-enemies", "TURN_START", [hp({ kind: "enemies" }, -20)]);
  ability(input, "guard", "bleed-each-round", "TURN_START", [hp(owner, -1)]);
  const simulation = createSimulation(input);
  const result = simulation.runToEnd();
  assert.equal(result.snapshot.status, "completed");
  assert.equal(result.snapshot.completedRounds, 13);
  assert.equal(result.snapshot.turnsTaken, 13);
  assert.equal(unit(result.snapshot, "enemy").alive, false);
  assert.equal(unit(result.snapshot, "guard").stats.hp, 17);
  assert.equal(operations(result.events, "bleed-each-round").length, 13);
  assert.deepEqual(
    roundEnds(result.events),
    Array.from({ length: 13 }, (_, i) => i + 1),
  );
  assert.equal(actions(result.events, "enemy").length, 0);
});

for (const [initialHP, expectedStatus] of [
  [14, "completed"],
  [13, "defeat"],
]) {
  test(
    "граница 13-го раунда: " + expectedStatus + ", враги исчезают без DEATH и не отменяют исход",
    () => {
      const input = pair();
      input.scenario.world.units[0].stats.hp = initialHP;
      ability(input, "guard", "bleed", "TURN_START", [hp(owner, -1)]);
      ability(input, "enemy", "should-not-die", "DEATH", [hp(byId("guard"), -20)]);
      const result = createSimulation(input).runToEnd();
      assert.equal(result.snapshot.status, expectedStatus);
      assert.equal(result.snapshot.completedRounds, 13);
      assert.equal(result.snapshot.turnsTaken, 26);
      assert.equal(unit(result.snapshot, "enemy"), undefined);
      assert.equal(unit(result.snapshot, "guard").stats.hp, initialHP - 13);
      assert.equal(operations(result.events, "should-not-die").length, 0);
      const end = result.events.at(-1);
      assert.equal(end.kind, "night_end");
      assert.equal(end.data.status, expectedStatus);
      assert.deepEqual(end.data.departedEnemyIds, ["enemy"]);
      const lastTurns = result.events.filter(
        (entry) => entry.kind === "turn_start" && entry.scope.round === 13,
      );
      assert.deepEqual(
        lastTurns.map((entry) => entry.data.ownerId),
        ["guard", "enemy"],
      );
    },
  );
}

test("DEATH-призыв в 13-м раунде успевает получить ход и сохранить победное завершение", () => {
  const input = pair();
  input.scenario.world.units[0].stats.hp = 13;
  ability(input, "guard", "bleed", "TURN_START", [hp(owner, -1)]);
  ability(input, "guard", "last-round-replacement", "DEATH", [
    { kind: "place_entity", target: { kind: "cell" }, definitionId: "warrior" },
  ]);
  const result = createSimulation(input).runToEnd();
  assert.equal(result.snapshot.status, "completed");
  assert.equal(result.snapshot.completedRounds, 13);
  assert.equal(unit(result.snapshot, "guard").alive, false);
  const replacement = result.snapshot.world.units.find((entry) => entry.alive);
  assert.equal(replacement.side, "defender");
  const lastTurns = result.events.filter(
    (entry) => entry.kind === "turn_start" && entry.scope.round === 13,
  );
  assert.deepEqual(
    lastTurns.map((entry) => entry.data.ownerId),
    ["guard", "enemy", replacement.id],
  );
});

function combined(seed) {
  const input = fixture(9, 1, seed);
  addUnit(input, {
    id: "guard",
    x: 0,
    stats: { hp: 30, maxHP: 30, strength: 300, damage: 3, movement: 2 },
  });
  addUnit(input, { id: "enemy", side: "enemy", x: 8, stats: { agility: 200, movement: 3 } });
  addOpening(input, { id: "middle", x: 4 });
  addTrap(input, "snare", 6);
  ability(input, "snare", "trap-chain", "DEATH", [
    speed({ kind: "occupant" }, -1),
    { kind: "interrupt_action", target: { kind: "occupant" } },
    { kind: "create_damage_event", target: { kind: "cell" }, amount: 2 },
    { kind: "add_effect", target: { kind: "occupant" }, effectId: "bleeding" },
  ]);
  ability(input, "guard", "A", "ATTACK_SUCCESS", [
    {
      kind: "add_damage_modifier",
      event: { kind: "context_damage" },
      modifier: { type: "relative", value: 1 },
    },
    { kind: "trigger_reaction", target: byId("enemy"), phase: "DEFENSE_FAILURE" },
  ]);
  ability(input, "enemy", "B", "DEFENSE_FAILURE", [
    { kind: "trigger_reaction", target: byId("guard"), phase: "ATTACK_SUCCESS" },
  ]);
  return input;
}

function steppedRun(input) {
  const session = createSimulation(input);
  const events = [...session.getEvents()];
  let snapshot = session.getSnapshot();
  let steps = 0;
  while (snapshot.status === "running") {
    const update = session.step();
    snapshot = update.snapshot;
    events.push(...update.events);
    steps += 1;
    assert(steps < 100, "сценарий должен завершаться за конечное число ходов");
  }
  return { snapshot, events };
}

for (const seed of [0, 34, 4294967295]) {
  test(
    "полная ночь с дверью, ловушкой, скоростью и реакциями воспроизводится через JSON, seed=" +
      seed,
    () => {
      const input = combined(seed);
      const before = structuredClone(input);
      const session = createSimulation(input);
      const complete = session.runToEnd();
      const expected = { snapshot: complete.snapshot, events: session.getEvents() };
      assert.equal(expected.snapshot.status, "completed");
      assert.equal(expected.snapshot.completedRounds, 13);
      assert.equal(unit(expected.snapshot, "guard").stats.hp, 30);
      assert(
        expected.events.some((entry) => entry.kind === "action" && entry.data.kind === "INTERACT"),
      );
      assert(
        expected.events.some(
          (entry) => entry.kind === "skipped" && entry.data.reason === "reaction_cycle",
        ),
      );
      assert(operations(expected.events, "trap-chain").length > 0);
      assert(operations(expected.events, "bleeding").length > 0);
      assert.deepEqual(steppedRun(JSON.parse(JSON.stringify(input))), expected);
      const another = createSimulation(JSON.parse(JSON.stringify(input)));
      assert.deepEqual(another.runToEnd(), complete);
      assert.deepEqual(another.getEvents(), expected.events);
      session.reset();
      assert.deepEqual(session.runToEnd(), complete);
      assert.deepEqual(input, before);
    },
  );
}

test("смена seed меняет журнал RNG составного сценария, повтор прежнего seed точен", () => {
  const first = createSimulation(combined(0));
  first.runToEnd();
  const second = createSimulation(combined(34));
  second.runToEnd();
  const randomEntries = (session) => session.getEvents().filter((entry) => entry.kind === "rng");
  assert.notDeepEqual(randomEntries(first), randomEntries(second));
  const repeat = createSimulation(combined(0));
  repeat.runToEnd();
  assert.deepEqual(repeat.getEvents(), first.getEvents());
});
