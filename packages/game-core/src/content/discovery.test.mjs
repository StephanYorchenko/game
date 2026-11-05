import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadWorld, canStep } from "@deathwarriors/game-core";
import {
  compileContentPack,
  loadContentPack,
  ContentValidationError,
} from "@deathwarriors/game-core/content";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { runUnitTurn } from "@deathwarriors/game-core/turn";

const minimal = JSON.parse(await readFile(new URL("./minimal.json", import.meta.url), "utf8"));
const discovery = JSON.parse(
  await readFile(new URL("../trap-discovery/example.json", import.meta.url), "utf8"),
);
function pack() {
  const input = structuredClone(minimal);
  input.effects.push(structuredClone(discovery));
  input.units.find((unit) => unit.definitionId === "wolf").effectIds.push(discovery.definitionId);
  return input;
}
const operationPath = "$.effects[4].operations[0]";
const mutations = [
  [
    "пустой trapId",
    (effect) => {
      effect.operations[0].trapId = "";
    },
    operationPath + ".trapId",
  ],
  [
    "нет trapId",
    (effect) => {
      delete effect.operations[0].trapId;
    },
    operationPath + ".trapId",
  ],
  [
    "вероятность ниже 0",
    (effect) => {
      effect.operations[0].probability = -0.1;
    },
    operationPath + ".probability",
  ],
  [
    "вероятность выше 1",
    (effect) => {
      effect.operations[0].probability = 1.1;
    },
    operationPath + ".probability",
  ],
  [
    "неизвестная формула",
    (effect) => {
      effect.operations[0].probability = { kind: "eval" };
    },
    operationPath + ".probability.kind",
  ],
  [
    "неверная характеристика",
    (effect) => {
      effect.operations[0].probability = { kind: "stat", target: { kind: "owner" }, stat: "luck" };
    },
    operationPath + ".probability.stat",
  ],
  [
    "другая фаза",
    (effect) => {
      effect.phase = "ACTION_START";
    },
    operationPath + ".kind",
  ],
  [
    "неизвестное поле",
    (effect) => {
      effect.operations[0].radius = 5;
    },
    operationPath + ".radius",
  ],
];
for (const [name, mutate, path] of mutations) {
  test("discover_trap отклонён с точным адресом: " + name, () => {
    const input = pack();
    mutate(input.effects[4]);
    assert.throws(
      () => loadContentPack(input),
      (error) => error instanceof ContentValidationError && error.path === path,
    );
  });
}

test("литералы 0, 1 и дробная вероятность компилируются без целочисленного ограничения", () => {
  for (const probability of [0, 0.5, 1]) {
    const input = pack();
    input.effects[4].operations[0].probability = probability;
    const result = compileContentPack(input);
    assert.equal(result.effects[4].operations[0].probability, probability);
  }
});

test("пример загружается, компилируется и исполняется без изменения явных параметров", () => {
  const input = pack();
  const compiled = compileContentPack(JSON.parse(JSON.stringify(input)));
  const wolf = compiled.entities.find((unit) => unit.definitionId === "wolf");
  const archer = compiled.entities.find((unit) => unit.definitionId === "archer");
  const unit = (template, id, x) => {
    const { effects: _effects, ...definition } = template;
    return { ...definition, id, alive: true, position: { x, y: 0 } };
  };
  const world = loadWorld({
    version: 1,
    map: {
      width: 7,
      height: 1,
      cells: Array.from({ length: 7 }, () => ({
        surface: "floor",
        area: "inside",
        structure: null,
      })),
    },
    units: [unit(wolf, "actor", 0), unit(archer, "target", 6)],
    traps: [{ id: "snare-1", kind: "trap", definitionId: "snare", position: { x: 1, y: 0 } }],
  });
  world.units[0].stats.agility = 5;
  const results = [];
  const runtime = {
    world,
    effects: createEffectStore(),
    trapDiscovery: { rng: createSeededRng(26), onOutcome: (result) => results.push(result) },
  };
  for (const effect of wolf.effects) {
    addEffect(runtime.effects, { ...effect, ownerId: "actor" });
  }
  const damage = createDamageState();
  const result = runUnitTurn(runtime, "actor", () => ["actor", "target"], {
    chooseAction: () => ({ kind: "MOVE" }),
    executeAction: function* () {},
    createQueue: (controlled) => createDamageQueue(controlled, damage, () => ["actor", "target"]),
  });
  assert.equal(result.actions.length, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].probability, 0.5);
  assert.equal(results[0].trapId, "snare-1");
  assert.equal(results[0].status, "discovered");
  assert.equal(canStep(world, world.units[0], { x: 1, y: 0 }), false);
  assert.deepEqual(input, pack());
});
