import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSimulation, SimulationValidationError } from "@deathwarriors/game-core/simulation";

const content = JSON.parse(
  await readFile(new URL("../content/minimal.json", import.meta.url), "utf8"),
);
const scenario = JSON.parse(await readFile(new URL("./example.json", import.meta.url), "utf8"));
const input = () => structuredClone({ seed: 33, content, scenario });
const guard = (snapshot) => snapshot.world.units.find((unit) => unit.id === "guard");

test("сессия начинает заданную ночь, сохраняет подготовленные характеристики и копирует вход", () => {
  const source = input();
  const before = structuredClone(source);
  const session = createSimulation(source);
  const initial = session.getSnapshot();
  assert.equal(initial.status, "running");
  assert.equal(initial.round, 1);
  assert.equal(initial.turnsTaken, 0);
  assert.equal(initial.nextUnitId, "guard");
  assert.equal(initial.lastTurn, null);
  assert.equal(initial.error, null);
  assert.equal(initial.seed, 33);
  assert.equal(initial.contentId, content.id);
  assert.equal(guard(initial).stats.strength, 10);
  assert.deepEqual(
    session.getEvents().map((entry) => entry.kind),
    ["night_start", "rng", "rng", "initiative"],
  );
  assert.deepEqual(source, before);
});

test("шаг исполняет один полный ход, возвращает актуальный мир и только новые события", () => {
  const source = input();
  source.scenario.world.traps = [];
  const session = createSimulation(source);
  const initialEvents = session.getEvents();
  const result = session.step();
  assert.equal(result.snapshot.turnsTaken, 1);
  assert.equal(result.snapshot.nextUnitId, "wolf");
  assert.deepEqual(result.snapshot.lastTurn, { ownerId: "guard", round: 1, turn: 1 });
  assert.equal(result.snapshot.world.map.cells[2].structure.state, "open");
  assert.deepEqual(guard(result.snapshot).position, { x: 1, y: 0 });
  assert(result.events.every((entry) => entry.sequence > initialEvents.length));
  assert.deepEqual(session.getEvents(), [...initialEvents, ...result.events]);
  assert.equal(initialEvents.length, 4);
});

test("пошаговый, полный и смешанный запуск дают одинаковые снимки и журнал", () => {
  const full = createSimulation(input());
  const initialEvents = full.getEvents();
  const complete = full.runToEnd();
  assert.equal(complete.snapshot.status, "completed");
  assert.equal(complete.snapshot.completedRounds, 13);

  const stepped = createSimulation(input());
  const events = [...stepped.getEvents()];
  let result;
  let steps = 0;
  while (stepped.getSnapshot().status === "running") {
    result = stepped.step();
    events.push(...result.events);
    steps += 1;
    assert(steps < 100);
  }
  assert.deepEqual(result.snapshot, complete.snapshot);
  assert.deepEqual(events, full.getEvents());
  assert.deepEqual(complete.events, full.getEvents().slice(initialEvents.length));

  const mixed = createSimulation(input());
  mixed.step();
  assert.deepEqual(mixed.runToEnd().snapshot, complete.snapshot);
  assert.deepEqual(mixed.getEvents(), full.getEvents());
});

test("чтение не расходует RNG, снимки и события не разделяют изменяемые данные с сессией", () => {
  const session = createSimulation(input());
  const expected = session.getSnapshot();
  const events = session.getEvents();
  const changed = session.getSnapshot();
  changed.world.units[0].stats.hp = 1;
  changed.world.map.cells[2].structure.interactionMask[0][0] = 1;
  changed.status = "defeat";
  events[0].data.seed = 100;
  assert.deepEqual(session.getSnapshot(), expected);
  assert.equal(session.getEvents()[0].data.seed, 33);
  const control = createSimulation(input());
  assert.deepEqual(session.step(), control.step());
});

test("reset повторяет исходный seed и сценарий, даже если исходный объект после создания изменён", () => {
  const source = input();
  const session = createSimulation(source);
  const initial = session.getSnapshot();
  const initialEvents = session.getEvents();
  const final = session.runToEnd();
  const allEvents = session.getEvents();
  source.seed = 0;
  source.scenario.world.units[0].stats.hp = 1;
  source.content.effects[0].operations[0].delta = -99;
  const reset = session.reset();
  assert.deepEqual(reset.snapshot, initial);
  assert.deepEqual(reset.events, initialEvents);
  assert.deepEqual(session.runToEnd(), final);
  assert.deepEqual(session.getEvents(), allEvents);
});

test("завершённая сессия возвращает пустую дельту без новых действий", () => {
  const session = createSimulation(input());
  const final = session.runToEnd();
  const events = session.getEvents();
  assert.deepEqual(session.step(), { snapshot: final.snapshot, events: [] });
  assert.deepEqual(session.runToEnd(), { snapshot: final.snapshot, events: [] });
  assert.deepEqual(session.getEvents(), events);
});

const invalid = [
  [
    "seed вне uint32",
    (data) => {
      data.seed = 2 ** 32;
    },
    "$.seed",
  ],
  [
    "дробный seed",
    (data) => {
      data.seed = 0.5;
    },
    "$.seed",
  ],
  [
    "NaN",
    (data) => {
      data.seed = NaN;
    },
    "$.seed",
  ],
  [
    "неизвестное поле",
    (data) => {
      data.queue = [];
    },
    "$.queue",
  ],
  [
    "невалидный контент",
    (data) => {
      data.content.effects[0].phase = "on_damaged";
    },
    "$.content.effects[0].phase",
  ],
  [
    "невалидный мир",
    (data) => {
      data.scenario.world.units[0].stats.hp = -1;
    },
    "$.scenario.world.units[0].stats.hp",
  ],
  [
    "пустой definitionId",
    (data) => {
      data.scenario.world.units[0].definitionId = "";
    },
    "$.scenario.world.units[0].definitionId",
  ],
  [
    "неизвестный юнит",
    (data) => {
      data.scenario.world.units[0].definitionId = "missing";
    },
    "$.scenario.world.units[0].definitionId",
  ],
  [
    "ловушка вместо определения юнита",
    (data) => {
      data.scenario.world.units[0].definitionId = "snare";
    },
    "$.scenario.world.units[0].definitionId",
  ],
  [
    "юнит вместо определения ловушки",
    (data) => {
      data.scenario.world.traps[0].definitionId = "wolf";
    },
    "$.scenario.world.traps[0].definitionId",
  ],
  [
    "повтор ID",
    (data) => {
      data.scenario.world.units[1].id = "guard";
    },
    "$.scenario.world.units[1].id",
  ],
  [
    "нет связи проёма",
    (data) => {
      data.scenario.openings = [];
    },
    "$.scenario.openings",
  ],
  [
    "лишняя связь",
    (data) => {
      data.scenario.openings[0].id = "missing";
    },
    "$.scenario.openings[0].id",
  ],
  [
    "повтор связи",
    (data) => {
      data.scenario.openings.push(data.scenario.openings[0]);
    },
    "$.scenario.openings[1].id",
  ],
  [
    "другой вид проёма",
    (data) => {
      data.scenario.openings[0].definitionId = "window";
    },
    "$.scenario.openings[0].definitionId",
  ],
  [
    "нет массива связей",
    (data) => {
      delete data.scenario.openings;
    },
    "$.scenario.openings",
  ],
  [
    "жизнь с HP=0",
    (data) => {
      data.scenario.world.units[0].stats.hp = 0;
    },
    "$.scenario.world.units[0].stats.hp",
  ],
  [
    "неразрешённое разрушение",
    (data) => {
      data.scenario.world.map.cells[2].structure.reinforcement = { hp: 0, maxHP: 5, resistance: 0 };
    },
    "$.scenario.world.map.cells[2].structure.reinforcement.hp",
  ],
  [
    "не-JSON данные",
    (data) => {
      data.scenario.world.units[0].stats.hp = () => 5;
    },
    "$.scenario.world.units[0].stats.hp",
  ],
];
for (const [name, mutate, path] of invalid) {
  test("сценарий отклонён с адресом: " + name, () => {
    const data = input();
    mutate(data);
    assert.throws(
      () => createSimulation(data),
      (error) => error instanceof SimulationValidationError && error.path === path,
    );
  });
}

test("seed 0 и максимальный uint32 допускаются", () => {
  for (const seed of [0, 2 ** 32 - 1]) {
    assert.equal(createSimulation({ ...input(), seed }).getSnapshot().seed, seed);
  }
});

test("ошибка динамической формулы возвращает error, журнал и запрещает продолжение до reset", () => {
  const data = input();
  data.content.effects.push({
    definitionId: "bad-probability",
    phase: "TURN_START",
    state: {},
    operations: [
      {
        kind: "discover_trap",
        trapId: "snare",
        probability: { kind: "add", left: 1, right: 1 },
      },
    ],
  });
  data.content.units.find((unit) => unit.definitionId === "wolf").effectIds.push("bad-probability");
  const session = createSimulation(data);
  const failed = session.runToEnd();
  assert.equal(failed.snapshot.status, "error");
  assert.equal(failed.snapshot.nextUnitId, null);
  assert.match(failed.snapshot.error.message, /Вероятность/);
  assert.equal(failed.events.filter((entry) => entry.kind === "simulation_error").length, 1);
  assert.equal(
    failed.events.find((entry) => entry.kind === "simulation_error").scope.ownerId,
    "wolf",
  );
  assert.deepEqual(session.step(), { snapshot: failed.snapshot, events: [] });
  assert.deepEqual(session.runToEnd(), { snapshot: failed.snapshot, events: [] });
  assert.equal(session.reset().snapshot.status, "running");
  assert.deepEqual(session.runToEnd(), failed);
});

test("повторный вход и reset во время исполнения не меняют активную сессию", () => {
  let session;
  let checked = false;
  session = createSimulation(input(), {
    getOptions: () => {
      if (!checked) {
        checked = true;
        assert.throws(() => session.step(), /Повторный вход/);
        assert.throws(() => session.reset(), /сбрасывать/);
        const snapshot = session.getSnapshot();
        snapshot.world.units[0].stats.hp = 0;
      }
      return {};
    },
  });
  assert.equal(session.step().snapshot.status, "running");
  assert.equal(guard(session.getSnapshot()).stats.hp, 10);
  assert.equal(checked, true);
});

test("доверенный модуль ограничений подключается через общий контракт", () => {
  const source = input();
  source.scenario.world.traps = [];
  const session = createSimulation(source, {
    getOptions: () => ({ movement: { directions: [] } }),
  });
  const result = session.step();
  assert.deepEqual(guard(result.snapshot).position, { x: 0, y: 0 });
  assert.equal(result.snapshot.world.map.cells[2].structure.state, "closed");
  assert.equal(result.snapshot.status, "running");
});

test("отсутствие защитников на старте приводит к поражению на границе раунда", () => {
  const data = input();
  data.scenario.world.units = data.scenario.world.units.filter((unit) => unit.side === "enemy");
  const session = createSimulation(data);
  assert.equal(session.getSnapshot().status, "running");
  const result = session.runToEnd();
  assert.equal(result.snapshot.status, "defeat");
  assert.equal(result.snapshot.completedRounds, 1);
  assert.equal(result.snapshot.turnsTaken, 1);
  assert.equal(result.snapshot.error, null);
});

test("кровотечение сохраняет все 13 раундов и может вызвать поражение в последнем", () => {
  const data = input();
  data.scenario.world.units = data.scenario.world.units.filter((unit) => unit.side === "defender");
  data.scenario.world.units[0].stats.hp = 13;
  data.scenario.world.units[0].stats.maxHP = 13;
  data.content.units.find((unit) => unit.definitionId === "archer").effectIds = ["bleeding"];
  const result = createSimulation(data).runToEnd();
  assert.equal(result.snapshot.status, "defeat");
  assert.equal(result.snapshot.completedRounds, 13);
  assert.equal(guard(result.snapshot).alive, false);
});

test("DEATH-призыв через контент создаёт нового защитника с новым ID и спасает раунд", () => {
  const data = input();
  data.scenario.world.units = data.scenario.world.units.filter((unit) => unit.side === "defender");
  data.scenario.world.units[0].id = "entity:1";
  data.content.effects.push(
    {
      definitionId: "mortal",
      phase: "TURN_START",
      state: {},
      operations: [{ kind: "modify_hp", target: { kind: "owner" }, delta: -100 }],
    },
    {
      definitionId: "replacement",
      phase: "DEATH",
      state: {},
      operations: [{ kind: "place_entity", target: { kind: "cell" }, definitionId: "warrior" }],
    },
  );
  data.content.units.find((unit) => unit.definitionId === "archer").effectIds = [
    "mortal",
    "replacement",
  ];
  const session = createSimulation(data);
  const result = session.runToEnd();
  assert.equal(result.snapshot.status, "completed");
  assert.equal(result.snapshot.world.units.find((unit) => unit.id === "entity:1").alive, false);
  assert.equal(result.snapshot.world.units.find((unit) => unit.id === "entity:2").alive, true);
  const round1 = session
    .getEvents()
    .filter((entry) => entry.kind === "turn_start" && entry.scope.round === 1);
  assert.deepEqual(
    round1.map((entry) => entry.scope.ownerId),
    ["entity:1", "entity:2"],
  );
});

test("способности проёма привязываются по его определению и проходят обычные боевые фазы", () => {
  const data = input();
  data.scenario.world.traps = [];
  data.scenario.world.units[1].position.x = 3;
  data.scenario.world.units[1].stats.damage = 2;
  data.scenario.world.map.cells[2].structure.reinforcement = { hp: 2, maxHP: 2, resistance: 0 };
  data.scenario.openings[0].definitionId = "fortified-door";
  data.content.openings.find((opening) => opening.definitionId === "fortified-door").effectIds = [
    "rune",
  ];
  data.content.effects.push({
    definitionId: "rune",
    phase: "DEFENSE_FAILURE",
    state: {},
    operations: [{ kind: "modify_hp", target: { kind: "unit", id: "wolf" }, delta: -1 }],
  });
  const session = createSimulation(data);
  session.step();
  const result = session.step();
  assert.equal(result.snapshot.world.map.cells[2].structure.state, "destroyed");
  assert.equal(result.snapshot.world.units.find((unit) => unit.id === "wolf").stats.hp, 9);
  assert(
    result.events.some((entry) => entry.kind === "operation" && entry.data.definitionId === "rune"),
  );
});

test("DTO содержит JSON, методы и внутренние очереди сессии не раскрываются", () => {
  const session = createSimulation(input());
  const result = session.runToEnd();
  assert.deepEqual(Object.keys(session), []);
  for (const name of ["queue", "order", "acted", "effects", "movement", "summoning"]) {
    assert.equal(Object.hasOwn(result.snapshot, name), false);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("пример запуска исполняется отдельным Node-процессом без браузера", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./example.mjs", import.meta.url))],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "completed");
  assert.equal(output.completedRounds, 13);
  assert.deepEqual(output.defenders, [{ id: "guard", hp: 10 }]);
  assert(output.events > 0);
});
