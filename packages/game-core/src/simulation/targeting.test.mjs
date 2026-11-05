import assert from "node:assert/strict";
import test from "node:test";
import { createSimulation } from "@deathwarriors/game-core/simulation";
import { fixture, addUnit, addOpening, cell, actions, unit } from "./fixtures.mjs";

test("115: открытый путь к врагу приоритетнее соседней двери к другому врагу", () => {
  const input = fixture(8);
  addUnit(input, { id: "guard", x: 2, stats: { movement: 1, strength: 100, damage: 1 } });
  addUnit(input, { id: "open-enemy", side: "enemy", x: 0 });
  addUnit(input, { id: "hidden-enemy", side: "enemy", x: 7 });
  addOpening(input, { id: "door", x: 3 });
  const { snapshot, events } = createSimulation(input).step();
  assert.deepEqual(actions(events, "guard"), [
    { kind: "MOVE", target: { kind: "unit", id: "open-enemy" } },
    { kind: "ATTACK", targetKind: "unit", targetId: "open-enemy" },
  ]);
  assert.deepEqual(unit(snapshot, "guard").position, { x: 1, y: 0 });
  assert.equal(snapshot.world.map.cells[3].structure.state, "closed");
  assert.equal(unit(snapshot, "open-enemy").stats.hp, 19);
});

test("115: последовательные TRUE-двери открываются по мере продвижения к известному врагу", () => {
  const input = fixture(9);
  addUnit(input, { id: "guard", x: 0, stats: { movement: 3 } });
  addUnit(input, { id: "enemy", side: "enemy", x: 8 });
  addOpening(input, { id: "first", x: 2 });
  addOpening(input, { id: "second", x: 4 });
  const simulation = createSimulation(input);
  const first = simulation.step();
  assert.deepEqual(actions(first.events, "guard"), [
    { kind: "MOVE", target: { kind: "opening", id: "first" } },
    { kind: "INTERACT", openingId: "first" },
  ]);
  assert.equal(first.snapshot.world.map.cells[4].structure.state, "closed");
  simulation.step();
  const next = simulation.step();
  assert.deepEqual(actions(next.events, "guard"), [
    { kind: "MOVE", target: { kind: "opening", id: "second" } },
    { kind: "INTERACT", openingId: "second" },
  ]);
  assert.deepEqual(unit(next.snapshot, "guard").position, { x: 3, y: 0 });
  assert.equal(next.snapshot.world.map.cells[2].structure.state, "open");
  assert.equal(next.snapshot.world.map.cells[4].structure.state, "open");
});

test("113–115: непосредственный выбор TRUE-двери не ранжирует путь за ней", () => {
  const chosen = new Set();
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const input = fixture(12, 1, seed);
    addUnit(input, { id: "guard", x: 4 });
    addUnit(input, { id: "near", side: "enemy", x: 0 });
    addUnit(input, { id: "far", side: "enemy", x: 11 });
    addOpening(input, { id: "left", x: 3 });
    addOpening(input, { id: "right", x: 5 });
    const result = createSimulation(input).step();
    assert.deepEqual(createSimulation(input).step(), result);
    const interactions = actions(result.events, "guard").filter(
      (action) => action.kind === "INTERACT",
    );
    assert.equal(interactions.length, 1);
    chosen.add(interactions[0].openingId);
  }
  assert.deepEqual([...chosen].sort(), ["left", "right"]);
});

test("114: защитник не открывает тупиковую дверь или окно даже при известном враге", () => {
  const input = fixture(5);
  addUnit(input, { id: "guard", x: 1, stats: { movement: 2 } });
  addUnit(input, { id: "enemy", side: "enemy", x: 4 });
  addOpening(input, { id: "dead-end", x: 0 });
  addOpening(input, { id: "window", x: 2, kind: "window" });
  const result = createSimulation(input).step();
  assert.deepEqual(actions(result.events, "guard"), [
    { kind: "MOVE", target: null },
    { kind: "MOVE", target: null },
  ]);
  assert.equal(result.snapshot.world.map.cells[0].structure.state, "closed");
  assert.equal(result.snapshot.world.map.cells[2].structure.state, "closed");
});

test("97/114: враг случайно открывает доступные дверь/окно без пути к защитнику за ними", () => {
  const chosen = new Set();
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const input = fixture(7, 1, seed);
    addUnit(input, { id: "enemy", side: "enemy", x: 1, stats: { agility: 200 } });
    addUnit(input, { id: "guard", x: 6 });
    cell(input, 4).structure = { id: "wall", kind: "wall" };
    addOpening(input, { id: "door", x: 0 });
    addOpening(input, { id: "window", x: 2, kind: "window" });
    const result = createSimulation(input).step();
    assert.deepEqual(createSimulation(input).step(), result);
    const selected = actions(result.events, "enemy");
    assert(selected.every((action) => action.kind === "INTERACT"));
    assert.equal(selected.length, 2);
    chosen.add(selected[0].openingId);
    assert.equal(result.snapshot.world.map.cells[0].structure.state, "open");
    assert.equal(result.snapshot.world.map.cells[2].structure.state, "open");
  }
  assert.deepEqual([...chosen].sort(), ["door", "window"]);
});

test("97: для маршрута враг выбирает ближайший проём, даже если за ним тупик", () => {
  const input = fixture(7);
  addUnit(input, { id: "enemy", side: "enemy", x: 2, stats: { agility: 200, movement: 1 } });
  addUnit(input, { id: "guard", x: 6 });
  addOpening(input, { id: "near-window", x: 0, kind: "window" });
  const result = createSimulation(input).step();
  assert.deepEqual(actions(result.events, "enemy"), [
    { kind: "MOVE", target: { kind: "opening", id: "near-window" } },
    { kind: "INTERACT", openingId: "near-window" },
  ]);
  assert.deepEqual(unit(result.snapshot, "enemy").position, { x: 1, y: 0 });
});

test("116: равные ближайшие цели маршрута разных типов выбираются seeded RNG", () => {
  const chosen = new Set();
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const input = fixture(5, 1, seed);
    addUnit(input, { id: "enemy", side: "enemy", x: 2, stats: { agility: 200, movement: 1 } });
    addUnit(input, { id: "guard", x: 0 });
    addOpening(input, { id: "window", x: 4, kind: "window" });
    const result = createSimulation(input).step();
    assert.deepEqual(createSimulation(input).step(), result);
    const first = actions(result.events, "enemy")[0];
    assert.equal(first.kind, "MOVE");
    chosen.add(first.target.kind);
  }
  assert.deepEqual([...chosen].sort(), ["opening", "unit"]);
});

test("116: доступные защитник и укрепление участвуют в одном случайном выборе атаки", () => {
  const chosen = new Set();
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const input = fixture(4, 1, seed);
    const enemy = addUnit(input, {
      id: "enemy",
      side: "enemy",
      x: 1,
      stats: { agility: 200, strength: 200 },
    });
    enemy.attackMask[2][4] = 1;
    addUnit(input, { id: "guard", x: 0 });
    addOpening(input, { id: "fort", x: 3, reinforcement: { hp: 5, maxHP: 5, resistance: 0 } });
    const result = createSimulation(input).step();
    assert.deepEqual(createSimulation(input).step(), result);
    const selected = actions(result.events, "enemy");
    assert.equal(selected.length, 2);
    assert(selected.every((action) => action.kind === "ATTACK"));
    chosen.add(selected[0].targetKind);
    assert.equal(result.snapshot.world.map.cells[3].structure.reinforcement.hp, 5);
  }
  assert.deepEqual([...chosen].sort(), ["opening", "unit"]);
});

test("без доступного защитника атака выбирает случайное доступное укрепление", () => {
  const chosen = new Set();
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const input = fixture(7, 1, seed);
    const enemy = addUnit(input, {
      id: "enemy",
      side: "enemy",
      x: 1,
      stats: { agility: 200, damage: 1 },
    });
    enemy.attackMask[2][4] = 1;
    addUnit(input, { id: "guard", x: 6 });
    cell(input, 4).structure = { id: "wall", kind: "wall" };
    for (const [id, x] of [
      ["left", 0],
      ["right", 3],
    ]) {
      addOpening(input, { id, x, reinforcement: { hp: 5, maxHP: 5, resistance: 0 } });
    }
    const result = createSimulation(input).step();
    chosen.add(actions(result.events, "enemy")[0].targetId);
    assert(actions(result.events, "enemy").every((action) => action.targetKind === "opening"));
    const damage = result.events.filter((entry) => entry.kind === "damage");
    assert.equal(damage.length, 2);
    assert(damage.every((entry) => entry.data.hpLoss === 1));
    assert(
      result.events
        .filter((entry) => entry.kind === "rng")
        .every((entry) => entry.data.method !== "d6"),
    );
  }
  assert.deepEqual([...chosen].sort(), ["left", "right"]);
});
