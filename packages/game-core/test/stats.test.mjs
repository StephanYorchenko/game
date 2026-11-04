import assert from "node:assert/strict";
import test from "node:test";
import { heal, modifyHP, modifyStat } from "@deathwarriors/game-core/stats";

function unit() {
  return {
    id: "actor",
    kind: "unit",
    definitionId: "fighter",
    side: "defender",
    alive: true,
    position: { x: 1, y: 1 },
    stats: { hp: 5, maxHP: 10, strength: 2, agility: 2, damage: 2, movement: 2, resistance: 2 },
    attackMask: Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]),
    keywords: [],
  };
}

test("повышение maxHP не лечит, понижение обрезает HP без восстановления при возврате", () => {
  const actor = unit();
  modifyStat(actor, "maxHP", 5);
  assert.deepEqual([actor.stats.hp, actor.stats.maxHP], [5, 15]);

  actor.stats.hp = 8;
  modifyStat(actor, "maxHP", -10);
  assert.deepEqual([actor.stats.hp, actor.stats.maxHP], [5, 5]);
  modifyStat(actor, "maxHP", 5);
  assert.deepEqual([actor.stats.hp, actor.stats.maxHP], [5, 10]);
});

test("каждая характеристика ограничена снизу и хранится непосредственно в stats", () => {
  const actor = unit();

  for (const stat of ["strength", "agility", "damage", "movement", "resistance", "maxHP"]) {
    assert.equal(modifyStat(actor, stat, -100), true);
    assert.equal(actor.stats[stat], stat === "maxHP" ? 1 : 0);
    modifyStat(actor, stat, 1000000);
    assert.equal(actor.stats[stat], stat === "maxHP" ? 1000001 : 1000000);
  }

  assert.equal(actor.stats.hp, 1);
});

test("прямое уменьшение HP не применяет сопротивление и не фиксирует смерть", () => {
  const actor = unit();
  actor.stats.resistance = 1000;
  assert.equal(modifyHP(actor, -100), true);
  assert.equal(actor.stats.hp, 0);
  assert.equal(actor.alive, true);
  assert.deepEqual(actor.position, { x: 1, y: 1 });
  assert.equal(heal(actor, 1), true);
  assert.equal(actor.stats.hp, 1);
});

test("лечение и положительное изменение HP ограничены maxHP", () => {
  const actor = unit();
  heal(actor, 0);
  assert.equal(actor.stats.hp, 5);
  heal(actor, 100);
  assert.equal(actor.stats.hp, 10);
  modifyHP(actor, -3);
  assert.equal(actor.stats.hp, 7);
  modifyHP(actor, 100);
  assert.equal(actor.stats.hp, 10);
});

test("зафиксированная смерть исключает лечение и изменение характеристик", () => {
  const actor = unit();
  actor.alive = false;
  actor.position = null;
  actor.stats.hp = 0;
  const before = structuredClone(actor);

  assert.equal(heal(actor, 5), false);
  assert.equal(modifyHP(actor, 5), false);
  assert.equal(modifyStat(actor, "maxHP", 5), false);
  assert.deepEqual(actor, before);
});

test("обратное изменение явно работает над текущим значением без скрытых модификаторов", () => {
  const actor = unit();
  modifyStat(actor, "strength", -10);
  assert.equal(actor.stats.strength, 0);
  modifyStat(actor, "strength", 10);
  assert.equal(actor.stats.strength, 10);

  const snapshot = JSON.parse(JSON.stringify(actor));
  assert.deepEqual(snapshot, actor);
  assert.deepEqual(Object.keys(actor.stats).sort(), [
    "agility",
    "damage",
    "hp",
    "maxHP",
    "movement",
    "resistance",
    "strength",
  ]);
});

test("ошибочные значения не портят состояние", () => {
  const actor = unit();
  const before = structuredClone(actor);

  for (const value of [NaN, Infinity, -Infinity, 0.5, "2"]) {
    assert.throws(() => modifyStat(actor, "damage", value), RangeError);
    assert.throws(() => modifyHP(actor, value), RangeError);
    assert.throws(() => heal(actor, value), RangeError);
  }

  assert.throws(() => heal(actor, -1), RangeError);
  assert.throws(() => modifyStat(actor, "hp", 1), TypeError);
  assert.throws(() => modifyStat(actor, "unknown", 1), TypeError);
  assert.deepEqual(actor, before);
});

test("переполнение характеристики не создаёт Infinity в JSON-состоянии", () => {
  const actor = unit();
  actor.stats.strength = Number.MAX_VALUE;
  const before = structuredClone(actor);
  assert.throws(() => modifyStat(actor, "strength", Number.MAX_VALUE), RangeError);
  assert.deepEqual(actor, before);
});
