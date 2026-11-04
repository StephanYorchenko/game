import assert from "node:assert/strict";
import test from "node:test";
import { createPhaseContext, resolveTargets } from "@deathwarriors/game-core/targets";

function world() {
  return {
    version: 1,
    map: {
      width: 3,
      height: 3,
      cells: Array.from({ length: 9 }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units: [
      {
        id: "owner",
        kind: "unit",
        side: "defender",
        alive: true,
        position: { x: 0, y: 0 },
        stats: { hp: 0 },
      },
      { id: "ally", kind: "unit", side: "defender", alive: true, position: { x: 1, y: 0 } },
      { id: "enemy", kind: "unit", side: "enemy", alive: true, position: { x: 2, y: 0 } },
      { id: "dead", kind: "unit", side: "enemy", alive: false, position: null },
    ],
    traps: [{ id: "trap", kind: "trap", position: { x: 1, y: 1 } }],
  };
}
const phase = () => createPhaseContext({ kind: "phase", ownerId: "owner" });
const ids = (result) => {
  assert.equal(result.kind, "entities");
  return result.entities.map((e) => e.id);
};

test("owner и unit по ID разрешаются в актуальные сущности", () => {
  const state = world();
  const result = resolveTargets(state, phase(), { kind: "owner" });
  assert.deepEqual(ids(result), ["owner"]);
  assert.equal(result.entities[0], state.units[0]);
  assert.deepEqual(ids(resolveTargets(state, phase(), { kind: "unit", id: "enemy" })), ["enemy"]);
  assert.deepEqual(resolveTargets(state, phase(), { kind: "unit", id: "missing" }), {
    kind: "unavailable",
    reason: "missing_entity",
  });
});

test("attacker и defender зависят от контекста атаки, defender может быть укреплением", () => {
  const state = world();
  state.map.cells[8].structure = { id: "door", kind: "door", state: "closed" };
  const context = createPhaseContext({
    kind: "attack",
    ownerId: "owner",
    attackerId: "enemy",
    defenderId: "door",
    cell: { x: 2, y: 2 },
  });
  assert.deepEqual(ids(resolveTargets(state, context, { kind: "attacker" })), ["enemy"]);
  assert.deepEqual(ids(resolveTargets(state, context, { kind: "defender" })), ["door"]);
  assert.deepEqual(resolveTargets(state, phase(), { kind: "attacker" }), {
    kind: "unavailable",
    reason: "missing_context",
  });
});

test("живая цель проверяется по alive, клетка не требует живого обитателя", () => {
  const state = world();
  assert.deepEqual(
    ids(resolveTargets(state, phase(), { kind: "owner" }, { livingUnitsOnly: true })),
    ["owner"],
  );
  assert.deepEqual(
    ids(resolveTargets(state, phase(), { kind: "unit", id: "dead" }, { livingUnitsOnly: true })),
    [],
  );
  assert.deepEqual(ids(resolveTargets(state, phase(), { kind: "unit", id: "dead" })), ["dead"]);
  const context = createPhaseContext({ kind: "death", ownerId: "dead", cell: { x: 2, y: 2 } });
  assert.deepEqual(resolveTargets(state, context, { kind: "cell" }, { livingUnitsOnly: true }), {
    kind: "cell",
    position: { x: 2, y: 2 },
  });
});

test("все семантические клетки фиксируются по значению и не следуют за участниками", () => {
  const state = world();

  for (const kind of ["attack", "death", "move_end"]) {
    const cell = { x: 1, y: 2 };
    const context = createPhaseContext({
      kind,
      ownerId: "owner",
      cell,
      ...(kind === "attack" ? { attackerId: "owner", defenderId: "enemy" } : {}),
    });
    cell.x = 2;
    state.units[0].position = { x: 2, y: 1 };
    const result = resolveTargets(state, context, { kind: "cell" });
    assert.deepEqual(result, { kind: "cell", position: { x: 1, y: 2 } });
    result.position.x = 0;
    assert.equal(context.cell.x, 1);
    assert.throws(() => {
      context.cell.x = 0;
    }, TypeError);
    assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
  }
});

test("исчезновение участника не меняет адрес уже зафиксированной атаки", () => {
  const state = world();
  const context = createPhaseContext({
    kind: "attack",
    ownerId: "owner",
    attackerId: "owner",
    defenderId: "enemy",
    cell: { x: 2, y: 0 },
  });
  state.units.splice(2, 1);
  assert.deepEqual(resolveTargets(state, context, { kind: "defender" }), {
    kind: "unavailable",
    reason: "missing_entity",
  });
  assert.deepEqual(resolveTargets(state, context, { kind: "cell" }), {
    kind: "cell",
    position: { x: 2, y: 0 },
  });
});

test("массовые селекторы сохраняют порядок, включают владельца и исключают отсутствующих на карте", () => {
  const state = world();
  assert.deepEqual(ids(resolveTargets(state, phase(), { kind: "allies" })), ["owner", "ally"]);
  assert.deepEqual(ids(resolveTargets(state, phase(), { kind: "enemies" })), ["enemy"]);
  state.units[1].side = "enemy";
  assert.deepEqual(ids(resolveTargets(state, phase(), { kind: "enemies" })), ["ally", "enemy"]);
  state.units[1].alive = false;
  state.units[1].position = null;
  assert.deepEqual(
    ids(resolveTargets(state, phase(), { kind: "enemies" }, { livingUnitsOnly: true })),
    ["enemy"],
  );
});

test("нейтральному объекту не приписывается сторона, но owner разрешается", () => {
  const state = world();
  const context = createPhaseContext({ kind: "phase", ownerId: "trap" });
  assert.deepEqual(ids(resolveTargets(state, context, { kind: "owner" })), ["trap"]);
  assert.deepEqual(resolveTargets(state, context, { kind: "allies" }), {
    kind: "unavailable",
    reason: "owner_has_no_side",
  });
  assert.deepEqual(
    ids(resolveTargets(state, context, { kind: "owner" }, { livingUnitsOnly: true })),
    [],
  );
  assert.deepEqual(resolveTargets(state, context, { kind: "unit", id: "trap" }), {
    kind: "unavailable",
    reason: "missing_entity",
  });
});

test("отсутствие контекстной клетки и выход за карту дают явную причину", () => {
  const state = world();
  assert.deepEqual(resolveTargets(state, phase(), { kind: "cell" }), {
    kind: "unavailable",
    reason: "missing_context",
  });
  const context = createPhaseContext({ kind: "move_end", ownerId: "owner", cell: { x: 5, y: 5 } });
  assert.deepEqual(resolveTargets(state, context, { kind: "cell" }), {
    kind: "unavailable",
    reason: "invalid_cell",
  });
  assert.throws(
    () => createPhaseContext({ kind: "death", ownerId: "owner", cell: { x: NaN, y: 0 } }),
    TypeError,
  );
});

test("разрешение селекторов не меняет мир и контекст", () => {
  const state = world();
  const context = phase();
  const before = structuredClone(state);
  const beforeContext = structuredClone(context);

  for (const kind of ["owner", "attacker", "defender", "cell", "allies", "enemies"]) {
    resolveTargets(state, context, { kind });
  }

  assert.deepEqual(state, before);
  assert.deepEqual(context, beforeContext);
  assert.throws(() => resolveTargets(state, context, { kind: "area" }), TypeError);
});
