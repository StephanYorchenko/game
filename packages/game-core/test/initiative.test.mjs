import assert from "node:assert/strict";
import test from "node:test";
import { createInitiativeOrder } from "@deathwarriors/game-core/initiative";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { modifyStat } from "@deathwarriors/game-core/stats";

const unit = (id, agility = 1) => ({
  id,
  alive: true,
  position: { x: 0, y: 0 },
  stats: { agility },
});
const rolls = (...values) => {
  let used = 0;
  return {
    d6: () => {
      assert(used < values.length, "лишний расход RNG");
      const value = values[used];
      used += 1;
      return value;
    },
    get used() {
      return used;
    },
  };
};

test("инициатива сортируется по сумме, затем по текущей ловкости без лишних бросков", () => {
  const rng = rolls(1, 2, 6);
  const result = createInitiativeOrder([unit("a", 3), unit("b", 2), unit("c", 0)], rng);
  assert.deepEqual(
    result.map((e) => e.unitId),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    result.map((e) => e.initiative),
    [6, 4, 4],
  );
  assert.equal(rng.used, 3);
});

test("дополнительный бросок разрешает ничью и сохраняется в записи", () => {
  const rng = rolls(2, 2, 1, 6);
  const result = createInitiativeOrder([unit("a"), unit("b")], rng);
  assert.deepEqual(
    result.map((e) => e.unitId),
    ["b", "a"],
  );
  assert.deepEqual(
    result.map((e) => e.tieRolls),
    [[6], [1]],
  );
  assert.equal(rng.used, 4);
});

test("повторная ничья перебрасывает только равную подгруппу", () => {
  const rng = rolls(2, 2, 2, 6, 3, 3, 1, 5);
  const result = createInitiativeOrder([unit("a"), unit("b"), unit("c")], rng);
  assert.deepEqual(
    result.map((e) => e.unitId),
    ["a", "c", "b"],
  );
  assert.deepEqual(
    result.map((e) => e.tieRolls),
    [[6], [3, 5], [3, 1]],
  );
  assert.equal(rng.used, 8);
});

test("отдельные группы расходуют RNG от старшей к младшей, вложенная ничья — первой", () => {
  const rng = rolls(6, 6, 2, 2, 4, 4, 2, 5, 6, 1);
  const result = createInitiativeOrder([unit("a"), unit("b"), unit("c"), unit("d")], rng);
  assert.deepEqual(
    result.map((e) => e.unitId),
    ["b", "a", "c", "d"],
  );
  assert.deepEqual(
    result.map((e) => e.tieRolls),
    [[4, 5], [4, 2], [6], [1]],
  );
  assert.equal(rng.used, 10);
});

test("погибшие и неразмещённые не участвуют; пустой набор не расходует RNG", () => {
  const dead = { ...unit("dead"), alive: false, position: null };
  const absent = { ...unit("absent"), position: null };
  const rng = rolls(3);
  assert.deepEqual(createInitiativeOrder([dead, absent], rng), []);
  assert.equal(rng.used, 0);
  const [entry] = createInitiativeOrder([dead, unit("living"), absent], rng);
  assert.equal(entry.unitId, "living");
  assert.equal(entry.roll, 3);
  assert.equal(rng.used, 1);
});

test("изменение ловкости не пересортировывает готовую очередь и не меняет её снимок", () => {
  const a = unit("a", 2);
  const b = unit("b", 1);
  const input = [a, b];
  const before = structuredClone(input);
  const result = createInitiativeOrder(input, rolls(3, 3));
  assert.deepEqual(input, before);
  modifyStat(b, "agility", 100);
  assert.deepEqual(
    result.map((e) => e.unitId),
    ["a", "b"],
  );
  assert.equal(result[1].agility, 1);
  assert.equal(result[1].initiative, 4);
});

test("одинаковый seed воспроизводит очередь и конечное состояние RNG", () => {
  const units = Array.from({ length: 20 }, (_, index) => unit(`unit-${index}`, index % 3));
  const first = createSeededRng(42);
  const second = createSeededRng(42);
  const a = createInitiativeOrder(units, first);
  const b = createInitiativeOrder(units, second);
  assert.deepEqual(a, b);
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.equal(new Set(a.map((e) => e.unitId)).size, units.length);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test("длинная цепочка ничьих разрешается без рекурсии и произвольного тайбрейка", () => {
  let used = 0;
  const rng = {
    d6: () => {
      used += 1;
      return used === 10002 ? 6 : 1;
    },
  };
  const result = createInitiativeOrder([unit("a"), unit("b")], rng);
  assert.deepEqual(
    result.map((e) => e.unitId),
    ["b", "a"],
  );
  assert.equal(used, 10002);
  assert.equal(result[0].tieRolls.length, 5000);
});

test("ошибки входных участников обнаруживаются до бросков", () => {
  const rng = rolls();

  for (const agility of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => createInitiativeOrder([unit("a", agility)], rng), RangeError);
  }

  assert.throws(() => createInitiativeOrder([unit("a"), unit("a")], rng), TypeError);
  assert.equal(rng.used, 0);
  assert.throws(() => createInitiativeOrder([unit("a")], rolls(7)), RangeError);
});
