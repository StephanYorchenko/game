import assert from "node:assert/strict";
import test from "node:test";
import { findActionPath, getActionDistance } from "@deathwarriors/game-core/pathfinding";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { canStep } from "@deathwarriors/game-core";

const mask = (...offsets) => {
  const value = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);

  for (const [x, y] of offsets) {
    value[y + 2][x + 2] = 1;
  }

  return value;
};
const cross = () => mask([1, 0], [-1, 0], [0, 1], [0, -1]);
function world(width = 7, height = 5) {
  const actor = {
    id: "actor",
    kind: "unit",
    alive: true,
    side: "defender",
    position: { x: 0, y: 2 },
    attackMask: cross(),
    stats: { movement: 0 },
  };
  const target = {
    id: "target",
    kind: "unit",
    alive: true,
    side: "enemy",
    position: { x: 6, y: 2 },
  };
  return {
    version: 1,
    map: {
      width,
      height,
      cells: Array.from({ length: width * height }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units: [actor, target],
    traps: [],
  };
}
const attack = (state) => ({ kind: "attack", position: state.units[1].position });
const setStructure = (state, x, y, structure) => {
  state.map.cells[y * state.map.width + x].structure = structure;
};

test("путь заканчивается у позиции атаки, не в занятой клетке цели и не зависит от скорости", () => {
  const state = world();
  const path = findActionPath(state, state.units[0], attack(state), createSeededRng(1));
  assert.equal(path.distance, 5);
  assert.deepEqual(path.destination, { x: 5, y: 2 });
  assert.equal(path.steps.length, 5);
  assert(!path.steps.some((p) => p.x === 6 && p.y === 2));
});

test("лучник останавливается в своей доступной дальности без обязательного сближения", () => {
  const state = world();
  state.units[0].attackMask = mask([2, 0]);
  assert.equal(getActionDistance(state, state.units[0], attack(state)), 4);
  const path = findActionPath(state, state.units[0], attack(state), createSeededRng(1));
  assert.deepEqual(path.destination, { x: 4, y: 2 });
  state.units[0].position = { x: 4, y: 2 };
  const rng = createSeededRng(2);
  const before = rng.snapshot();
  assert.deepEqual(findActionPath(state, state.units[0], attack(state), rng), {
    distance: 0,
    destination: { x: 4, y: 2 },
    steps: [],
  });
  assert.deepEqual(rng.snapshot(), before);
});

test("стена удлиняет доступный путь, геометрическое расстояние его не подменяет", () => {
  const state = world();

  for (let y = 1; y < 5; y += 1) {
    setStructure(state, 2, y, { id: `wall-${y}`, kind: "wall" });
  }

  const path = findActionPath(state, state.units[0], attack(state), createSeededRng(4));
  assert.equal(path.distance, 9);
  const actor = { ...state.units[0], position: { ...state.units[0].position } };

  for (const position of path.steps) {
    assert.equal(canStep(state, actor, position), true);
    actor.position = position;
  }
});

test("непроходимая стена и недопустимые направления дают отсутствие пути без RNG", () => {
  const state = world();

  for (let y = 0; y < 5; y += 1) {
    setStructure(state, 2, y, { id: `wall-${y}`, kind: "wall" });
  }

  const rng = createSeededRng(4);
  const before = rng.snapshot();
  assert.equal(findActionPath(state, state.units[0], attack(state), rng), undefined);
  assert.equal(getActionDistance(state, state.units[0], attack(state)), undefined);
  assert.deepEqual(rng.snapshot(), before);
  assert.equal(
    getActionDistance(world(), world().units[0], attack(world()), {
      movement: { directions: ["north", "south"] },
    }),
    undefined,
  );
});

test("взаимодействие использует матрицу объекта, а не маску атаки юнита", () => {
  const state = world();
  const object = { x: 6, y: 2 };
  state.units.pop();
  state.units[0].attackMask = mask();
  setStructure(state, 6, 2, {
    id: "door",
    kind: "door",
    state: "closed",
    reinforcement: null,
    interactionMask: mask([-2, 0]),
  });
  const target = { kind: "interact", position: object, interactionMask: mask([-2, 0]) };
  const path = findActionPath(state, state.units[0], target, createSeededRng(1));
  assert.deepEqual(path.destination, { x: 4, y: 2 });
  assert.equal(path.distance, 4);
});

test("собственное тело на старой позиции не перекрывает будущую линию атаки", () => {
  const state = world();
  state.units[0].position = { x: 2, y: 2 };
  state.units[0].attackMask = mask([2, 0]);
  state.units[1].position = { x: 3, y: 2 };
  const path = findActionPath(state, state.units[0], attack(state), createSeededRng(1));
  assert.equal(path.distance, 1);
  assert.deepEqual(path.steps, [{ x: 1, y: 2 }]);
});

test("равные кратчайшие маршруты воспроизводятся и могут отличаться при другом seed", () => {
  const state = world();
  state.units[0].position = { x: 0, y: 0 };
  state.units[0].attackMask = mask([1, 0]);
  state.units[1].position = { x: 3, y: 2 };
  const first = createSeededRng(42);
  const second = createSeededRng(42);
  const path = findActionPath(state, state.units[0], attack(state), first);
  assert.equal(path.distance, 4);
  assert.deepEqual(path, findActionPath(state, state.units[0], attack(state), second));
  assert.deepEqual(first.snapshot(), second.snapshot());
  const variants = new Set();

  for (let seed = 0; seed < 20; seed += 1) {
    const alternative = findActionPath(state, state.units[0], attack(state), createSeededRng(seed));
    assert.equal(alternative.distance, 4);
    variants.add(JSON.stringify(alternative.steps));
  }

  assert(variants.size > 1);
});

test("выбор между равноудалёнными конечными позициями тоже использует seeded RNG", () => {
  const state = world();
  state.units[0].position = { x: 0, y: 0 };
  state.units[1].position = { x: 2, y: 2 };
  const destinations = new Set();

  for (let seed = 0; seed < 20; seed += 1) {
    const path = findActionPath(state, state.units[0], attack(state), createSeededRng(seed));
    assert.equal(path.distance, 3);
    destinations.add(`${path.destination.x},${path.destination.y}`);
  }

  assert.deepEqual(destinations, new Set(["1,2", "2,1"]));
});

test("индивидуальные знания ловушек и запрет наружных клеток применяются в BFS", () => {
  const state = world(7, 1);
  state.units[0].position = { x: 0, y: 0 };
  state.units[0].side = "enemy";
  state.units[1].position = { x: 6, y: 0 };
  state.traps.push({ id: "trap", kind: "trap", position: { x: 2, y: 0 } });
  assert.equal(getActionDistance(state, state.units[0], attack(state)), 5);
  assert.equal(
    getActionDistance(state, state.units[0], attack(state), {
      movement: { knownTrapIds: ["trap"] },
    }),
    undefined,
  );
  state.traps = [];
  state.units[0].side = "defender";
  state.map.cells[2].area = "outside";
  assert.equal(getActionDistance(state, state.units[0], attack(state)), undefined);
});

test("дистанция и единственный маршрут не расходуют RNG, поиск не меняет мир", () => {
  const state = world();
  const beforeWorld = structuredClone(state);
  const rng = createSeededRng(3);
  const beforeRng = rng.snapshot();
  assert.equal(getActionDistance(state, state.units[0], attack(state)), 5);
  const path = findActionPath(state, state.units[0], attack(state), rng);
  assert.deepEqual(rng.snapshot(), beforeRng);
  assert.deepEqual(state, beforeWorld);
  path.destination.x = -1;
  path.steps[0].x = -2;
  assert.deepEqual(state, beforeWorld);
});

test("погибший актёр и цель за картой не имеют пути", () => {
  const state = world();
  assert.equal(
    getActionDistance(state, state.units[0], { kind: "attack", position: { x: 10, y: 2 } }),
    undefined,
  );
  state.units[0].alive = false;
  state.units[0].position = null;
  assert.equal(getActionDistance(state, state.units[0], attack(state)), undefined);
});
