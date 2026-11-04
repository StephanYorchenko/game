import assert from "node:assert/strict";
import test from "node:test";
import { canEnterCell, canStep, getStepDestinations, loadWorld } from "@deathwarriors/game-core";

function world(side = "defender") {
  return loadWorld({
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
        id: "actor",
        kind: "unit",
        definitionId: "fighter",
        side,
        alive: true,
        position: { x: 1, y: 1 },
        stats: {
          hp: 5,
          maxHP: 5,
          strength: 1,
          agility: 1,
          damage: 1,
          movement: 3,
          resistance: 0,
        },
        attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
        keywords: [],
      },
    ],
    traps: [],
  });
}

const east = { x: 2, y: 1 };
const mask = () => Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);

test("соседи ортогональны и имеют стабильный порядок", () => {
  const state = world();

  assert.deepEqual(getStepDestinations(state, state.units[0]), [
    { x: 1, y: 0 },
    east,
    { x: 1, y: 2 },
    { x: 0, y: 1 },
  ]);

  for (const position of [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 3, y: 1 },
  ]) {
    assert.equal(canStep(state, state.units[0], position), false);
  }
});

test("проверка клетки не подменяет проверку одного шага", () => {
  const state = world();
  const actor = state.units[0];

  assert.equal(canEnterCell(state, actor, { x: 0, y: 0 }), true);
  assert.equal(canStep(state, actor, { x: 0, y: 0 }), false);
  assert.equal(canEnterCell(state, actor, { x: 0.5, y: 0 }), false);
});

test("границы карты исключаются и при перечислении соседей", () => {
  const state = world();
  const actor = state.units[0];
  actor.position = { x: 0, y: 0 };

  assert.deepEqual(getStepDestinations(state, actor), [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ]);
});

test("стена и блокирующее препятствие непроходимы независимо от блока атаки", () => {
  const state = world();
  const actor = state.units[0];
  const cell = state.map.cells[5];
  cell.structure = { id: "wall", kind: "wall" };
  assert.equal(canStep(state, actor, east), false);

  cell.structure = { id: "box", kind: "obstacle", blocksMovement: true, blocksAttack: false };
  assert.equal(canStep(state, actor, east), false);

  cell.structure.blocksMovement = false;
  cell.structure.blocksAttack = true;
  assert.equal(canStep(state, actor, east), true);
});

test("закрытые проёмы блокируют движение обеих сторон независимо от укрепления", () => {
  for (const side of ["defender", "enemy"]) {
    for (const kind of ["door", "window"]) {
      const state = world(side);
      const structure = {
        id: "opening",
        kind,
        state: "closed",
        reinforcement: null,
        interactionMask: mask(),
      };
      state.map.cells[5].structure = structure;
      assert.equal(canStep(state, state.units[0], east), false);

      structure.reinforcement = { hp: 5, maxHP: 5, resistance: 0 };
      assert.equal(canStep(state, state.units[0], east), false);

      for (const status of ["open", "destroyed"]) {
        structure.state = status;
        assert.equal(canStep(state, state.units[0], east), true);
      }
    }
  }
});

test("защитник не выходит наружу через открытый или разрушенный проём", () => {
  for (const side of ["defender", "enemy"]) {
    for (const status of ["open", "destroyed"]) {
      const state = world(side);
      state.map.cells[5].area = "outside";
      state.map.cells[5].structure = {
        id: "door",
        kind: "door",
        state: status,
        reinforcement: null,
        interactionMask: mask(),
      };
      assert.equal(canStep(state, state.units[0], east), side === "enemy");
    }
  }
});

test("союзник и противник одинаково блокируют шаг и маршрут через свою клетку", () => {
  const state = world();

  for (const side of ["defender", "enemy"]) {
    const other = structuredClone(state.units[0]);
    other.id = "other";
    other.side = side;
    other.position = east;
    state.units[1] = other;

    assert.equal(canStep(state, state.units[0], east), false);
    assert(!getStepDestinations(state, state.units[0]).some((p) => p.x === 2 && p.y === 1));
  }
});

test("ловушки известны всем защитникам, а врагам — индивидуально", () => {
  for (const side of ["defender", "enemy"]) {
    const state = world(side);
    const actor = state.units[0];
    state.traps.push({ id: "trap", kind: "trap", definitionId: "snare", position: east });

    assert.equal(canStep(state, actor, east), side === "enemy");
    assert.equal(canStep(state, actor, east, { knownTrapIds: ["trap"] }), false);
    assert.equal(canStep(state, actor, east, { knownTrapIds: ["different"] }), side === "enemy");
  }
});

test("ограничение направлений действует и на шаг, и на набор соседей", () => {
  const state = world();
  const actor = state.units[0];
  const vertical = { directions: ["north", "south"] };

  assert.equal(canStep(state, actor, east, vertical), false);
  assert.deepEqual(getStepDestinations(state, actor, vertical), [
    { x: 1, y: 0 },
    { x: 1, y: 2 },
  ]);
  assert.deepEqual(getStepDestinations(state, actor, { directions: [] }), []);
});

test("запрет окон у Гиганта не закрывает двери и учитывается до построения пути", () => {
  const state = world("enemy");
  const actor = state.units[0];
  const opening = {
    id: "opening",
    kind: "window",
    state: "open",
    reinforcement: null,
    interactionMask: mask(),
  };
  state.map.cells[5].structure = opening;

  for (const status of ["open", "destroyed"]) {
    opening.state = status;
    assert.equal(canStep(state, actor, east, { allowWindows: false }), false);
    assert.equal(canStep(state, actor, east), true);
  }

  opening.kind = "door";
  assert.equal(canStep(state, actor, east, { allowWindows: false }), true);
});

test("следующий шаг заново проверяет актуальную карту, не сохраняя старую проходимость", () => {
  const state = world();
  const actor = state.units[0];
  assert.equal(canStep(state, actor, east), true);

  state.map.cells[5].structure = { id: "wall", kind: "wall" };
  assert.equal(canStep(state, actor, east), false);
});

test("погибший юнит не перемещается, проверки не меняют мир и знания", () => {
  const state = world("enemy");
  const actor = state.units[0];
  const options = { knownTrapIds: ["trap"] };
  const before = structuredClone(state);
  const beforeOptions = structuredClone(options);
  getStepDestinations(state, actor, options);
  assert.deepEqual(state, before);
  assert.deepEqual(options, beforeOptions);

  actor.alive = false;
  actor.position = null;
  actor.stats.hp = 0;
  assert.equal(canStep(state, actor, east), false);
  assert.deepEqual(getStepDestinations(state, actor), []);
});
