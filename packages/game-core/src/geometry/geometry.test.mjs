import assert from "node:assert/strict";
import test from "node:test";
import {
  canReachInteraction,
  canReachMaskedCell,
  getSupercoverCells,
  hasClearLine,
  isInMask,
} from "@deathwarriors/game-core/geometry";

const center = { x: 2, y: 2 };
const east = { x: 4, y: 2 };
const fullMask = () => Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]);
const mask = (x, y) => {
  const result = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
  result[y][x] = 1;
  return result;
};
const world = () => ({
  version: 1,
  map: {
    width: 5,
    height: 5,
    cells: Array.from({ length: 25 }, () => ({
      surface: "floor",
      area: "inside",
      structure: null,
    })),
  },
  units: [],
  traps: [],
});
const putStructure = (state, x, y, structure) => {
  state.map.cells[y * 5 + x].structure = structure;
};
const opening = (status = "closed") => ({
  id: "opening",
  kind: "door",
  state: status,
  reinforcement: { hp: 5, maxHP: 5, resistance: 1 },
  interactionMask: fullMask(),
});

test("асимметричная маска остаётся привязанной к карте без вращения", () => {
  const state = world();
  const north = mask(2, 0);
  assert.equal(canReachMaskedCell(state, center, { x: 2, y: 0 }, north), true);
  assert.equal(canReachMaskedCell(state, center, east, north), false);
  assert.equal(isInMask(north, { x: 1, y: 3 }, { x: 1, y: 1 }), true);
  assert.equal(isInMask(north, center, { x: 2.5, y: 0 }), false);
});

test("отрезок по ортогонали включает начальную, промежуточную и целевую клетки", () => {
  assert.deepEqual(getSupercoverCells(center, east), [center, { x: 3, y: 2 }, east]);
  assert.deepEqual(getSupercoverCells(center, center), [center]);
  assert.deepEqual(getSupercoverCells(center, { x: 2, y: 0 }), [
    center,
    { x: 2, y: 1 },
    { x: 2, y: 0 },
  ]);
});

test("угол включает обе боковые клетки, любая из них закрывает диагональ", () => {
  assert.deepEqual(getSupercoverCells(center, { x: 3, y: 3 }), [
    center,
    { x: 3, y: 2 },
    { x: 2, y: 3 },
    { x: 3, y: 3 },
  ]);

  for (const [x, y] of [
    [3, 2],
    [2, 3],
  ]) {
    const state = world();
    putStructure(state, x, y, { id: "wall", kind: "wall" });
    assert.equal(canReachMaskedCell(state, center, { x: 3, y: 3 }, fullMask()), false);
  }
});

test("наклон 2:1 учитывает клетки с обеих сторон промежуточной границы", () => {
  const target = { x: 4, y: 3 };
  assert.deepEqual(getSupercoverCells(center, target), [
    center,
    { x: 3, y: 2 },
    { x: 3, y: 3 },
    target,
  ]);

  for (const [x, y] of [
    [3, 2],
    [3, 3],
  ]) {
    const state = world();
    putStructure(state, x, y, { id: "wall", kind: "wall" });
    assert.equal(hasClearLine(state, center, target), false);
  }
});

test("все направления симметричны по множеству клеток при обращении отрезка", () => {
  const keys = (cells) => cells.map(({ x, y }) => `${x},${y}`).sort();

  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      const target = { x, y };
      const forward = getSupercoverCells(center, target);
      assert.equal(new Set(keys(forward)).size, forward.length);
      assert.deepEqual(keys(forward), keys(getSupercoverCells(target, center)));
    }
  }
});

test("неподдерживаемые координаты и дальность явно отклоняются", () => {
  for (const target of [
    { x: 5, y: 2 },
    { x: 1.5, y: 2 },
    { x: NaN, y: 2 },
  ]) {
    assert.throws(() => getSupercoverCells(center, target), RangeError);
    assert.equal(hasClearLine(world(), center, target), false);
  }
  assert.equal(canReachMaskedCell(world(), { x: 0, y: 0 }, { x: -1, y: 0 }, fullMask()), false);
});

test("блокировка движения независима от атаки, ловушка не закрывает линию", () => {
  const state = world();
  const obstacle = { id: "box", kind: "obstacle", blocksMovement: true, blocksAttack: false };
  putStructure(state, 3, 2, obstacle);
  assert.equal(hasClearLine(state, center, east), true);
  obstacle.blocksAttack = true;
  obstacle.blocksMovement = false;
  assert.equal(hasClearLine(state, center, east), false);
  putStructure(state, 3, 2, null);
  state.traps.push({ id: "trap", kind: "trap", definitionId: "snare", position: { x: 3, y: 2 } });
  assert.equal(hasClearLine(state, center, east), true);
});

test("промежуточные закрытые двери и окна блокируют, открытые и разрушенные — нет", () => {
  for (const kind of ["door", "window"]) {
    for (const status of ["closed", "open", "destroyed"]) {
      const state = world();
      putStructure(state, 3, 2, { ...opening(status), kind });
      assert.equal(hasClearLine(state, center, east), status !== "closed");
    }
  }
});

test("любой промежуточный юнит блокирует, целевой юнит не блокирует линию к себе", () => {
  for (const side of ["defender", "enemy"]) {
    const state = world();
    const unit = { id: "unit", kind: "unit", alive: true, side, position: { x: 3, y: 2 } };
    state.units.push(unit);
    assert.equal(hasClearLine(state, center, east), false);
    unit.position = east;
    assert.equal(hasClearLine(state, center, east), true);
  }
});

test("целевая укреплённая дверь доступна по маске атаки, стена перед ней закрывает линию", () => {
  const state = world();
  putStructure(state, 4, 2, opening());
  assert.equal(canReachMaskedCell(state, center, east, mask(4, 2)), true);
  putStructure(state, 3, 2, { id: "wall", kind: "wall" });
  assert.equal(canReachMaskedCell(state, center, east, mask(4, 2)), false);
});

test("взаимодействие использует отдельную матрицу с центром на объекте", () => {
  const state = world();
  const object = { x: 3, y: 2 };
  const westOfObject = mask(1, 2);
  putStructure(state, 3, 2, opening());
  assert.equal(canReachInteraction(state, center, object, westOfObject), true);
  assert.equal(canReachInteraction(state, { x: 4, y: 2 }, object, westOfObject), false);
  assert.equal(canReachMaskedCell(state, center, object, westOfObject), false);
});

test("исключение ключевого слова адресует конкретный блокер и не меняет мир", () => {
  const state = world();
  putStructure(state, 3, 2, opening());
  state.units.push({ id: "unit", kind: "unit", position: { x: 3, y: 2 } });
  const before = structuredClone(state);
  assert.equal(
    hasClearLine(state, center, east, { ignoresBlocker: (b) => b.kind === "structure" }),
    false,
  );
  assert.equal(hasClearLine(state, center, east, { ignoresBlocker: () => true }), true);
  assert.deepEqual(state, before);
});
