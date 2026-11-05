import assert from "node:assert/strict";
import test from "node:test";
import { createMoveState, executeMove, loadWorld } from "@deathwarriors/game-core";
import { createEffectStore } from "@deathwarriors/game-core/effects";
import { createOperationQueue } from "@deathwarriors/game-core/operations";
import { commitUnitDeaths, isOwnerAlive } from "@deathwarriors/game-core/death";
import { createDamageQueue, createDamageState } from "@deathwarriors/game-core/damage";
import { createSeededRng } from "@deathwarriors/game-core/random";
import { runUnitTurn } from "@deathwarriors/game-core/turn";

const mask = () => [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
function fixture(movement = 2, side = "enemy") {
  const unit = (id, unitSide, x) => ({
    id,
    kind: "unit",
    definitionId: "fighter",
    side: unitSide,
    alive: true,
    position: { x, y: 1 },
    stats: { hp: 5, maxHP: 5, strength: 1, agility: 1, damage: 1, movement, resistance: 0 },
    attackMask: mask(),
    keywords: [],
  });
  return {
    world: loadWorld({
      version: 1,
      map: {
        width: 7,
        height: 3,
        cells: Array.from({ length: 21 }, () => ({
          surface: "floor",
          area: "inside",
          structure: null,
        })),
      },
      units: [unit("actor", side, 0), unit("target", side === "enemy" ? "defender" : "enemy", 6)],
      traps: [],
    }),
    effects: createEffectStore(),
    movement: createMoveState(),
  };
}
const destination = { kind: "unit", id: "target" };
const options = () => ({ knownEnemyIds: ["target"], movement: { directions: ["east"] } });
const actor = (runtime) => runtime.world.units[0];
const cell = (runtime, x, y = 1) => runtime.world.map.cells[y * 7 + x];
const effect = (operations, id = "consequence") => ({
  ownerId: "actor",
  instanceId: id,
  definitionId: id,
  phase: "ACTION_START",
  source: "ordinary",
  state: {},
  context: { kind: "phase", ownerId: "actor" },
  operations,
});
const changeSpeed = (delta) =>
  effect([{ kind: "modify_stat", target: { kind: "owner" }, stat: "movement", delta }], "speed");
function queueFor(runtime, afterStep = () => []) {
  const order = runtime.world.units.map((unit) => unit.id);
  return createOperationQueue(runtime, {
    isOwnerAlive: (id) => isOwnerAlive(runtime.world, id),
    afterEffect: (context) => {
      context.emit(...commitUnitDeaths(runtime, order).effects);
      if (context.effect.operations[0]?.kind === "move_step") {
        context.emit(...afterStep(context.effect));
      }
    },
  });
}
function complete(iterator, queue) {
  let next = iterator.next();
  const batches = [];
  while (!next.done) {
    batches.push(next.value);
    queue.enqueue(...next.value);
    queue.drain();
    next = iterator.next();
  }
  return { result: next.value, batches };
}

test("MOVE лениво выдаёт один фиксированный эффект, очередь подтверждает число шагов", () => {
  const runtime = fixture();
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(1), options);
  const first = iterator.next();
  assert.deepEqual(actor(runtime).position, { x: 0, y: 1 });
  assert.equal(first.value.length, 1);
  assert.deepEqual(first.value[0].context.cell, { x: 1, y: 1 });
  assert.equal(runtime.movement.active[0].stepsTaken, 0);
  const queue = queueFor(runtime);
  queue.enqueue(...first.value);
  queue.drain();
  assert.equal(runtime.movement.active[0].stepsTaken, 1);
  const second = iterator.next();
  assert.deepEqual(second.value[0].context.cell, { x: 2, y: 1 });
  queue.enqueue(...second.value);
  queue.drain();
  assert.deepEqual(iterator.next().value, { stepsTaken: 2, reason: "budget_exhausted" });
  assert.deepEqual(runtime.movement.active, []);
});

test("последствия шага уменьшают либо увеличивают бюджет того же действия", () => {
  for (const [initial, delta, expected] of [
    [3, -2, 1],
    [1, 2, 3],
  ]) {
    const runtime = fixture(initial);
    const queue = queueFor(runtime, (entry) =>
      entry.operations[0].step === 1 ? [changeSpeed(delta)] : [],
    );
    const { result } = complete(
      executeMove(runtime, "actor", destination, createSeededRng(2), options),
      queue,
    );
    assert.deepEqual(result, { stepsTaken: expected, reason: "budget_exhausted" });
    assert.deepEqual(actor(runtime).position, { x: expected, y: 1 });
  }
});

test("после нового препятствия MOVE строит обход по актуальной карте", () => {
  const runtime = fixture(10);
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(3));
  const queue = queueFor(runtime);
  const first = iterator.next();
  queue.enqueue(...first.value);
  queue.drain();
  cell(runtime, 2).structure = { id: "wall", kind: "wall" };
  const rest = complete(iterator, queue);
  const positions = rest.batches.map((batch) => batch[0].context.cell);
  assert(positions.some((position) => position.y !== 1));
  assert(!positions.some((position) => position.x === 2 && position.y === 1));
  assert.equal(rest.result.reason, "attack_available");
  assert.equal(actor(runtime).stats.hp, 5);
});

test("полная блокада и ограничения движения завершают оставшуюся часть MOVE", () => {
  const runtime = fixture(8);
  let allowed = ["east"];
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(4), () => ({
    movement: { directions: allowed },
  }));
  const queue = queueFor(runtime);
  queue.enqueue(...iterator.next().value);
  queue.drain();
  allowed = [];
  assert.deepEqual(iterator.next().value, { stepsTaken: 1, reason: "no_route" });
});

test("новая доступная атака останавливает MOVE без атаки внутри слота", () => {
  const runtime = fixture(10);
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(5), options);
  const queue = queueFor(runtime);
  queue.enqueue(...iterator.next().value);
  queue.drain();
  const other = structuredClone(runtime.world.units[1]);
  other.id = "other";
  other.position = { x: 2, y: 1 };
  runtime.world.units.push(other);
  assert.deepEqual(iterator.next().value, { stepsTaken: 1, reason: "attack_available" });
  assert.equal(other.stats.hp, 5);
});

test("выбранный проём завершает MOVE в зоне взаимодействия и остаётся закрытым", () => {
  const runtime = fixture(10);
  runtime.world.units.splice(1);
  cell(runtime, 4).structure = {
    id: "door",
    kind: "door",
    state: "closed",
    reinforcement: null,
    interactionMask: mask(),
  };
  const { result } = complete(
    executeMove(runtime, "actor", { kind: "opening", id: "door" }, createSeededRng(6), options),
    queueFor(runtime),
  );
  assert.deepEqual(result, { stepsTaken: 3, reason: "interaction_available" });
  assert.equal(cell(runtime, 4).structure.state, "closed");
  assert.deepEqual(actor(runtime).position, { x: 3, y: 1 });
});

test("другой доступный проём не подменяет выбранную цель MOVE", () => {
  const runtime = fixture(2);
  cell(runtime, 0, 0).structure = {
    id: "other-door",
    kind: "door",
    state: "closed",
    reinforcement: null,
    interactionMask: mask(),
  };
  const { result } = complete(
    executeMove(runtime, "actor", destination, createSeededRng(7), options),
    queueFor(runtime),
  );
  assert.equal(result.stepsTaken, 2);
});

test("скорость 0, отсутствие цели, неизвестный враг и отсутствие пути дают 0 шагов", () => {
  for (const scenario of ["zero", "targetless", "unknown", "blocked", "outside"]) {
    const runtime = fixture(scenario === "zero" ? 0 : 3, "defender");
    if (scenario === "blocked") {
      cell(runtime, 1).structure = { id: "wall", kind: "wall" };
    }
    if (scenario === "outside") {
      cell(runtime, 6).area = "outside";
    }
    const rng = {
      pick() {
        throw new Error("Здесь не должно быть RNG");
      },
    };
    const { result, batches } = complete(
      executeMove(
        runtime,
        "actor",
        scenario === "targetless" ? undefined : destination,
        rng,
        scenario === "unknown" ? () => ({}) : options,
      ),
      queueFor(runtime),
    );
    assert.equal(batches.length, 0);
    assert.equal(result.stepsTaken, 0);
    assert.equal(result.reason, scenario === "zero" ? "budget_exhausted" : "no_route");
  }
});

test("движущаяся цель и явно заменённая цель берутся из актуального состояния", () => {
  const runtime = fixture(10);
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(8), options);
  const queue = queueFor(runtime);
  queue.enqueue(...iterator.next().value);
  queue.drain();
  runtime.world.units[1].position = { x: 4, y: 1 };
  const result = complete(iterator, queue).result;
  assert.deepEqual(result, { stepsTaken: 3, reason: "attack_available" });

  const next = executeMove(runtime, "actor", destination, createSeededRng(8), options);
  runtime.world.units[1].position = { x: 6, y: 1 };
  const batch = next.next();
  queue.enqueue(...batch.value);
  queue.drain();
  runtime.movement.active[0].target = null;
  assert.equal(next.next().value.reason, "no_route");
});

test("подтверждённый шаг считается даже если последствия вернули юнита назад", () => {
  const runtime = fixture(1);
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(9), options);
  const queue = queueFor(runtime);
  queue.enqueue(...iterator.next().value);
  queue.drain();
  actor(runtime).position = { x: 0, y: 1 };
  assert.deepEqual(iterator.next().value, { stepsTaken: 1, reason: "budget_exhausted" });
});

test("шаг повторно проверяется в очереди, дубли и устаревшие эффекты не добавляют шаги", () => {
  const runtime = fixture(3);
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(10), options);
  const first = iterator.next().value;
  const queue = queueFor(runtime);
  queue.enqueue(...first, ...first);
  queue.drain();
  assert.equal(runtime.movement.active[0].stepsTaken, 1);
  const second = iterator.next().value;
  cell(runtime, 2).structure = { id: "wall", kind: "wall" };
  queue.enqueue(...second);
  queue.drain();
  assert.deepEqual(iterator.next().value, { stepsTaken: 1, reason: "no_route" });
  queue.enqueue(...first);
  queue.drain();
  assert.deepEqual(actor(runtime).position, { x: 1, y: 1 });
});

test("смерть в последствиях шага не создаёт дальнейшие шаги", () => {
  const runtime = fixture(5);
  const queue = queueFor(runtime, () => [
    effect([{ kind: "modify_hp", target: { kind: "owner" }, delta: -5 }], "kill"),
  ]);
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(11), options);
  const { result, batches } = complete(iterator, queue);
  assert.deepEqual(result, { stepsTaken: 1, reason: "dead" });
  assert.equal(batches.length, 1);
  assert.equal(actor(runtime).alive, false);
});

test("очередь независимого урона исполняет шаги; две последовательные MOVE тратят два слота", () => {
  const runtime = fixture(1);
  const order = ["actor", "target"];
  const queue = createDamageQueue(runtime, createDamageState(), () => order);
  const result = runUnitTurn(runtime, "actor", () => order, {
    chooseAction: () => ({ kind: "MOVE" }),
    createQueue: () => queue,
    executeAction: () => executeMove(runtime, "actor", destination, createSeededRng(12), options),
  });
  assert.deepEqual(result.actions, [
    { slot: 1, kind: "MOVE" },
    { slot: 2, kind: "MOVE" },
  ]);
  assert.deepEqual(actor(runtime).position, { x: 2, y: 1 });
  assert.equal(runtime.movement.nextMoveId, 3);
});

test("итератор запрещает next до очереди и параллельный MOVE; return очищает состояние", () => {
  const runtime = fixture();
  const first = executeMove(runtime, "actor", destination, createSeededRng(13), options);
  first.next();
  const second = executeMove(runtime, "actor", destination, createSeededRng(13), options);
  assert.throws(() => second.next(), /уже исполняется/);
  assert.throws(() => first.next(), /ещё не разрешён/);
  assert.deepEqual(runtime.movement.active, []);
  const third = executeMove(runtime, "actor", destination, createSeededRng(13), options);
  third.next();
  third.return();
  assert.deepEqual(runtime.movement.active, []);
  const missing = { ...runtime, movement: undefined };
  assert.throws(
    () => executeMove(missing, "actor", destination, createSeededRng(13)).next(),
    /createMoveState/,
  );
});

test("JSON-копия состояния не связана с оригиналом, одинаковый seed повторяет обход", () => {
  const initial = fixture(10);
  cell(initial, 2).structure = { id: "wall", kind: "wall" };
  const simulate = () => {
    const runtime = JSON.parse(JSON.stringify(initial));
    const { result, batches } = complete(
      executeMove(runtime, "actor", destination, createSeededRng(14)),
      queueFor(runtime),
    );
    return { runtime, result, batches };
  };
  assert.deepEqual(simulate(), simulate());
  assert.deepEqual(actor(initial).position, { x: 0, y: 1 });
  assert.equal(initial.movement.nextMoveId, 1);
});

test("защитник идёт только к TRUE-двери без открытого пути к известному врагу", () => {
  const runtime = fixture(8, "defender");
  for (let y = 0; y < 3; y += 1) {
    cell(runtime, 3, y).structure = { id: `wall-${y}`, kind: "wall" };
  }
  cell(runtime, 3).structure = {
    id: "door",
    kind: "door",
    state: "closed",
    reinforcement: null,
    interactionMask: mask(),
  };
  const target = { kind: "opening", id: "door" };
  const result = complete(
    executeMove(runtime, "actor", target, createSeededRng(15), options),
    queueFor(runtime),
  ).result;
  assert.deepEqual(result, { stepsTaken: 2, reason: "interaction_available" });
  assert.equal(cell(runtime, 3).structure.state, "closed");

  actor(runtime).position = { x: 0, y: 1 };
  cell(runtime, 3).structure = null;
  const open = complete(
    executeMove(runtime, "actor", target, createSeededRng(15), options),
    queueFor(runtime),
  ).result;
  assert.deepEqual(open, { stepsTaken: 0, reason: "no_route" });
});

test("неукреплённый чужой проём не останавливает MOVE, укреплённый даёт доступную атаку", () => {
  const runtime = fixture(8);
  cell(runtime, 0, 0).structure = {
    id: "fort",
    kind: "door",
    state: "closed",
    reinforcement: { hp: 5, maxHP: 5, resistance: 0 },
    interactionMask: mask(),
  };
  const result = complete(
    executeMove(runtime, "actor", destination, createSeededRng(16), options),
    queueFor(runtime),
  ).result;
  assert.deepEqual(result, { stepsTaken: 0, reason: "attack_available" });
  assert.equal(cell(runtime, 0, 0).structure.reinforcement.hp, 5);
});

test("шаг удаляет ловушку до переноса и продолжает MOVE", () => {
  const runtime = fixture();
  runtime.world.traps.push({
    id: "trap",
    kind: "trap",
    definitionId: "trap",
    position: { x: 1, y: 1 },
  });
  const result = complete(
    executeMove(runtime, "actor", destination, createSeededRng(17), options),
    queueFor(runtime),
  ).result;
  assert.deepEqual(result, { stepsTaken: 2, reason: "budget_exhausted" });
  assert.deepEqual(actor(runtime).position, { x: 2, y: 1 });
  assert.equal(runtime.world.traps.length, 0);
});

test("реальный MOVE с нулём шагов сохраняет ACTION_END и два слота", () => {
  const runtime = fixture(0);
  const phases = [];
  const result = runUnitTurn(runtime, "actor", () => ["actor", "target"], {
    chooseAction: () => ({ kind: "MOVE" }),
    executeAction: () => executeMove(runtime, "actor", destination, createSeededRng(18), options),
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(result.actions.length, 2);
  assert.deepEqual(phases, [
    "TURN_START",
    "ACTION_START",
    "ACTION_END",
    "ACTION_START",
    "ACTION_END",
    "TURN_END",
  ]);
  assert.deepEqual(actor(runtime).position, { x: 0, y: 1 });
});

test("изменение клетки уже выданного шага перепланирует маршрут в том же MOVE", () => {
  const runtime = fixture(10);
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(19));
  const first = iterator.next().value;
  const fixed = first[0].context.cell;
  cell(runtime, fixed.x, fixed.y).structure = { id: "new-wall", kind: "wall" };
  const queue = queueFor(runtime);
  queue.enqueue(...first);
  queue.drain();
  assert.equal(runtime.movement.active[0].stepsTaken, 0);
  const retry = iterator.next().value;
  assert.notEqual(retry[0].instanceId, first[0].instanceId);
  queue.enqueue(...first, ...retry);
  queue.drain();
  assert.equal(runtime.movement.active[0].stepsTaken, 1);
  const { result } = complete(iterator, queue);
  assert.equal(result.reason, "attack_available");
  assert(result.stepsTaken > 0);
});

test("смерть перед выданным шагом позволяет очереди пропустить его без ошибки итератора", () => {
  const runtime = fixture();
  const iterator = executeMove(runtime, "actor", destination, createSeededRng(20), options);
  const first = iterator.next().value;
  const queue = queueFor(runtime);
  queue.enqueue(
    effect([{ kind: "modify_hp", target: { kind: "owner" }, delta: -5 }], "earlier-death"),
    ...first,
  );
  queue.drain();
  assert.deepEqual(iterator.next().value, { stepsTaken: 0, reason: "dead" });
  assert.deepEqual(runtime.movement.active, []);
});
