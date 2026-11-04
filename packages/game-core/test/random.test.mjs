import assert from "node:assert/strict";
import test from "node:test";
import { createSeededRng, restoreSeededRng, RNG_ALGORITHM } from "@deathwarriors/game-core/random";

const reference = [0xa15c02b7, 0x7b47f409, 0xba1d3330, 0x83d2f293, 0xbfa4784b, 0xcbed606e];

test("seed 42 и stream 54 совпадают с опубликованным контрольным вектором PCG32", () => {
  const rng = createSeededRng(42);
  assert.deepEqual(
    reference.map(() => rng.nextUint32()),
    reference,
  );
});

test("одинаковые seed и последовательность операций воспроизводятся", () => {
  const run = (seed) => {
    const rng = createSeededRng(seed);

    return Array.from({ length: 100 }, () => [
      rng.nextUint32(),
      rng.nextFloat(),
      rng.d6(),
      rng.pick(["door", "window", "enemy"]),
    ]);
  };
  assert.deepEqual(run(123), run(123));
  assert.notDeepEqual(run(123), run(124));
});

test("границы seed включают 0 и 2^32 - 1", () => {
  for (const seed of [0, 0xffff_ffff]) {
    const rng = createSeededRng(seed);
    const values = Array.from({ length: 20 }, () => rng.nextUint32());
    assert(values.every((v) => Number.isInteger(v) && v >= 0 && v < 2 ** 32));
    assert(new Set(values).size > 1);
  }

  for (const seed of [-1, 2 ** 32, 1.5, NaN, Infinity, "42", undefined]) {
    assert.throws(() => createSeededRng(seed), RangeError);
  }
});

test("ограниченный выбор отбрасывает неполный хвост диапазона без модульного смещения", () => {
  const rng = createSeededRng(42);
  assert.equal(rng.nextInt(2 ** 31 + 1), reference[1]); // Первый результат выше порога и отброшен.
  assert.equal(rng.nextUint32(), reference[2]);
});

test("полный 32-битный диапазон сохраняет исходный результат", () => {
  assert.equal(createSeededRng(42).nextInt(2 ** 32), reference[0]);
});

test("d6 и nextFloat соблюдают включённые и исключённые границы", () => {
  const rng = createSeededRng(999);

  for (let i = 0; i < 2000; i++) {
    const die = rng.d6();
    const fraction = rng.nextFloat();
    assert(Number.isInteger(die) && die >= 1 && die <= 6);
    assert(fraction >= 0 && fraction < 1);
  }
});

test("ошибочные границы не расходуют RNG", () => {
  const rng = createSeededRng(42);
  const before = rng.snapshot();

  for (const bound of [0, -1, 1.5, NaN, Infinity, 2 ** 32 + 1]) {
    assert.throws(() => rng.nextInt(bound), RangeError);
  }

  assert.deepEqual(rng.snapshot(), before);
});

test("пустой и единственный кандидат не расходуют RNG", () => {
  const rng = createSeededRng(42);
  const before = rng.snapshot();
  assert.equal(rng.pick([]), undefined);
  assert.equal(rng.pick(["door"]), "door");
  assert.equal(rng.nextInt(1), 0);
  assert.deepEqual(rng.snapshot(), before);
});

test("выбор сохраняет исходный порядок кандидатов и возвращает тот же объект", () => {
  const candidates = Object.freeze([{ id: "z" }, { id: "a" }, { id: "m" }]);
  const expectedIndex = createSeededRng(42).nextInt(candidates.length);
  assert.equal(createSeededRng(42).pick(candidates), candidates[expectedIndex]);
  assert.deepEqual(
    candidates.map((c) => c.id),
    ["z", "a", "m"],
  );
});

test("снимок проходит через JSON и продолжает поток после смешанных операций", () => {
  const original = createSeededRng(42);
  original.d6();
  original.nextInt(2 ** 31 + 1);
  original.pick(["a", "b"]);
  const snapshot = original.snapshot();
  const restored = restoreSeededRng(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(snapshot.algorithm, RNG_ALGORITHM);

  for (let i = 0; i < 50; i++) {
    assert.equal(restored.nextUint32(), original.nextUint32());
  }

  assert.deepEqual(restored.snapshot(), original.snapshot());
  assert.notDeepEqual(original.snapshot(), snapshot);
});

test("снимок не разделяет изменяемое состояние с генератором", () => {
  const rng = createSeededRng(42);
  const snapshot = rng.snapshot();
  snapshot.state = "0000000000000000";
  assert.equal(rng.nextUint32(), reference[0]);
  assert.equal(
    restoreSeededRng({ algorithm: RNG_ALGORITHM, state: "0000000000000000" }).nextUint32(),
    0,
  );
});

test("повреждённые снимки и неизвестная версия отклоняются", () => {
  for (const snapshot of [
    null,
    [],
    {},
    { algorithm: "other", state: "0000000000000000" },
    { algorithm: RNG_ALGORITHM, state: "0" },
    { algorithm: RNG_ALGORITHM, state: "GGGGGGGGGGGGGGGG" },
    { algorithm: RNG_ALGORITHM, state: "0000000000000000", extra: true },
  ]) {
    assert.throws(() => restoreSeededRng(snapshot), TypeError);
  }
});

test("генератор не зависит от Math.random", () => {
  const saved = Math.random;

  try {
    Math.random = () => {
      throw new Error("случайность вне RNG");
    };
    const rng = createSeededRng(42);
    rng.nextUint32();
    rng.nextFloat();
    rng.nextInt(17);
    rng.d6();
    rng.pick(["a", "b"]);
    restoreSeededRng(rng.snapshot()).d6();
  } finally {
    Math.random = saved;
  }
});
