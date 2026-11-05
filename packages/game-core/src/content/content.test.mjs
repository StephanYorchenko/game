import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadWorld, createMoveState, executeMove } from "@deathwarriors/game-core";
import {
  compileContentPack,
  loadContentPack,
  ContentValidationError,
} from "@deathwarriors/game-core/content";
import { createEffectStore, addEffect } from "@deathwarriors/game-core/effects";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { createSummoningState, placeEntity } from "@deathwarriors/game-core/summoning";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { runUnitTurn } from "@deathwarriors/game-core/turn";

const minimal = JSON.parse(await readFile(new URL("./minimal.json", import.meta.url), "utf8"));
const input = () => structuredClone(minimal);

test("минимальный каталог загружается, ссылки разворачиваются в независимые runtime-шаблоны", () => {
  const source = input();
  const loaded = loadContentPack(source);
  const compiled = compileContentPack(loaded);
  assert.equal(compiled.entities.length, 4);
  assert.equal(compiled.openings.length, 3);
  assert.equal(compiled.effects.length, 4);
  const snare = compiled.entities.find((entry) => entry.definitionId === "snare");
  assert.equal(snare.effects[0].operations[1].effect.definitionId, "bleeding");
  snare.effects[0].operations[1].effect.operations[0].delta = -4;
  compiled.entities[0].stats.hp = 1;
  assert.deepEqual(source, minimal);
  assert.deepEqual(loaded, minimal);
  assert.equal(
    compiled.effects.find((entry) => entry.definitionId === "bleeding").operations[0].delta,
    -1,
  );
  assert.deepEqual(
    compileContentPack(JSON.parse(JSON.stringify(loaded))),
    compileContentPack(source),
  );
});

const invalid = [
  [
    "зарезервированный ID",
    (pack) => {
      pack.effects[0].definitionId = "engine:move_step";
    },
    "$.effects[0].definitionId",
  ],
  [
    "версия",
    (pack) => {
      pack.version = 2;
    },
    "$.version",
  ],
  [
    "лишнее поле",
    (pack) => {
      pack.ui = true;
    },
    "$.ui",
  ],
  [
    "ID экземпляра в определении",
    (pack) => {
      pack.units[0].id = "instance";
    },
    "$.units[0].id",
  ],
  [
    "повтор определения",
    (pack) => {
      pack.units[1].definitionId = "warrior";
    },
    "$.units[1].definitionId",
  ],
  [
    "пустой ID",
    (pack) => {
      pack.id = " ";
    },
    "$.id",
  ],
  [
    "отрицательная скорость",
    (pack) => {
      pack.units[0].stats.movement = -1;
    },
    "$.units[0].stats.movement",
  ],
  [
    "дробная характеристика",
    (pack) => {
      pack.units[0].stats.strength = 0.5;
    },
    "$.units[0].stats.strength",
  ],
  [
    "HP выше maxHP",
    (pack) => {
      pack.units[0].stats.hp = 11;
    },
    "$.units[0].stats.hp",
  ],
  [
    "NaN",
    (pack) => {
      pack.units[0].stats.damage = NaN;
    },
    "$.units[0].stats.damage",
  ],
  [
    "Infinity в формуле",
    (pack) => {
      pack.effects[0].operations[0].delta = Infinity;
    },
    "$.effects[0].operations[0].delta",
  ],
  [
    "размер маски",
    (pack) => {
      pack.units[0].attackMask.pop();
    },
    "$.units[0].attackMask",
  ],
  [
    "небинарная маска",
    (pack) => {
      pack.openings[0].interactionMask[0][0] = 2;
    },
    "$.openings[0].interactionMask[0][0]",
  ],
  [
    "неизвестная способность",
    (pack) => {
      pack.traps[0].effectIds = ["missing"];
    },
    "$.traps[0].effectIds[0]",
  ],
  [
    "ссылка другого типа",
    (pack) => {
      pack.traps[0].effectIds = ["wolf"];
    },
    "$.traps[0].effectIds[0]",
  ],
  [
    "неизвестная фаза",
    (pack) => {
      pack.effects[0].phase = "on_damaged";
    },
    "$.effects[0].phase",
  ],
  [
    "неизвестная операция",
    (pack) => {
      pack.effects[0].operations[0].kind = "eval";
    },
    "$.effects[0].operations[0].kind",
  ],
  [
    "внутренний шаг не контент",
    (pack) => {
      pack.effects[0].operations[0] = {
        kind: "move_step",
        moveId: "move:1",
        step: 1,
      };
    },
    "$.effects[0].operations[0].kind",
  ],
  [
    "неизвестный селектор",
    (pack) => {
      pack.effects[0].operations[0].target.kind = "nearest";
    },
    "$.effects[0].operations[0].target.kind",
  ],
  [
    "неизвестная характеристика",
    (pack) => {
      pack.effects[2].operations[0].stat = "speed";
    },
    "$.effects[2].operations[0].stat",
  ],
  [
    "недопустимый HP как modify_stat",
    (pack) => {
      pack.effects[2].operations[0].stat = "hp";
    },
    "$.effects[2].operations[0].stat",
  ],
  [
    "битая ссылка add_effect",
    (pack) => {
      pack.effects[2].operations[1].effectId = "missing";
    },
    "$.effects[2].operations[1].effectId",
  ],
  [
    "отрицательный урон",
    (pack) => {
      pack.effects[1].operations[0].amount = -1;
    },
    "$.effects[1].operations[0].amount",
  ],
  [
    "разреженный массив",
    (pack) => {
      delete pack.units[0];
    },
    "$.units[0]",
  ],
  [
    "функция",
    (pack) => {
      pack.effects[0].state.run = () => 1;
    },
    "$.effects[0].state.run",
  ],
  [
    "undefined",
    (pack) => {
      pack.effects[0].state.value = undefined;
    },
    "$.effects[0].state.value",
  ],
  [
    "пропущено поле",
    (pack) => {
      delete pack.effects[0].state;
    },
    "$.effects[0].state",
  ],
];
for (const [name, mutate, path] of invalid) {
  test("контент отклонён с адресом ошибки: " + name, () => {
    const pack = input();
    mutate(pack);
    assert.throws(
      () => loadContentPack(pack),
      (error) => error instanceof ContentValidationError && error.path === path,
    );
  });
}

test("циклы объектов и разворачиваемых шаблонов дают явный адрес", () => {
  const cyclic = input();
  cyclic.effects[0].state.loop = cyclic;
  assert.throws(
    () => loadContentPack(cyclic),
    (error) => error instanceof ContentValidationError && error.path === "$.effects[0].state.loop",
  );
  const templates = input();
  templates.effects[3].operations.push({
    kind: "add_effect",
    target: { kind: "owner" },
    effectId: "haste",
  });
  assert.throws(() => compileContentPack(templates), /цикл вложенных шаблонов/);
});

test("все публичные операции и ограниченные формулы проверяются и компилируются", () => {
  const pack = input();
  pack.effects.push({
    definitionId: "operation-examples",
    phase: "TURN_START",
    state: { delta: 1, count: 0 },
    operations: [
      { kind: "place_entity", target: { kind: "cell" }, definitionId: "wolf" },
      { kind: "heal", target: { kind: "owner" }, value: 1 },
      { kind: "move_unit", target: { kind: "unit", id: "actor" } },
      { kind: "interrupt_action", target: { kind: "owner" } },
      { kind: "interrupt_turn", target: { kind: "owner" } },
      { kind: "trigger_reaction", target: { kind: "owner" }, phase: "DEFENSE_SUCCESS" },
      { kind: "modify_counter", instance: { kind: "self" }, name: "count", delta: 1 },
      {
        kind: "add_damage_modifier",
        event: { kind: "context_damage" },
        modifier: {
          type: "relative",
          value: {
            kind: "add",
            left: { kind: "stat", target: { kind: "owner" }, stat: "strength" },
            right: {
              kind: "max",
              left: { kind: "state", name: "delta" },
              right: {
                kind: "counter",
                instance: { kind: "instance", id: "effect:1" },
                name: "count",
              },
            },
          },
        },
      },
    ],
  });
  const compiled = compileContentPack(pack);
  const operations = compiled.effects.at(-1).operations;
  assert.equal(operations.length, 8);
  assert.equal(operations[0].template.definitionId, "wolf");
  assert.equal(operations[7].modifier.value.kind, "add");
  pack.effects.at(-1).operations[0].definitionId = "door";
  assert.throws(() => loadContentPack(pack), /неизвестное определение entity: door/);
});

function runtimeFrom(compiled) {
  const unit = (definitionId, id, x) => {
    const {
      kind,
      effects: _effects,
      ...definition
    } = compiled.entities.find((entry) => entry.definitionId === definitionId);
    return { ...definition, id, kind, alive: true, position: { x, y: 0 } };
  };
  return {
    world: loadWorld({
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
      units: [unit("wolf", "actor", 0), unit("archer", "target", 6)],
      traps: [],
    }),
    effects: createEffectStore(),
    movement: createMoveState(),
    summoning: createSummoningState(),
  };
}

test("пример исполняется без браузера: размещение ловушки, урон и кровотечение следующего хода", () => {
  const compiled = compileContentPack(minimal);
  const runtime = runtimeFrom(compiled);
  const order = ["actor", "target"];
  const snare = compiled.entities.find((entry) => entry.definitionId === "snare");
  assert.equal(placeEntity(runtime, runtime.summoning, order, { x: 1, y: 0 }, snare).placed, true);
  const queue = createDamageQueue(runtime, createDamageState(), () => order);
  const handlers = {
    chooseAction: () => ({ kind: "MOVE" }),
    createQueue: () => queue,
    executeAction: (_, context) =>
      executeMove(context.runtime, "actor", { kind: "unit", id: "target" }, createSeededRng(31)),
  };
  runUnitTurn(runtime, "actor", () => order, handlers);
  assert.equal(runtime.world.units[0].stats.hp, 8);
  assert.equal(runtime.world.traps.length, 0);
  runUnitTurn(runtime, "actor", () => order, handlers);
  assert.equal(runtime.world.units[0].stats.hp, 7);
  assert(runtime.effects.instances.some((entry) => entry.definitionId === "bleeding"));
});

test("временная скорость примера откатывается явным ACTION_END, эффект удаляет только себя", () => {
  const compiled = compileContentPack(minimal);
  const runtime = runtimeFrom(compiled);
  const archer = compiled.entities.find((entry) => entry.definitionId === "archer");
  for (const template of archer.effects) {
    addEffect(runtime.effects, { ...template, ownerId: "target" });
  }
  const speeds = [];
  const baseline = runtime.world.units[1].stats.movement;
  runUnitTurn(runtime, "target", () => ["actor", "target"], {
    chooseAction: ({ unit }) => {
      speeds.push(unit.stats.movement);
      return { kind: "MOVE" };
    },
    executeAction: function* () {},
  });
  assert.deepEqual(speeds, [baseline + 1, baseline + 1]);
  assert.equal(runtime.world.units[1].stats.movement, baseline);
  assert.deepEqual(
    runtime.effects.instances.map((entry) => entry.definitionId),
    ["haste"],
  );
});
