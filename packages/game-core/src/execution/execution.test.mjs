import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionQueue } from "@deathwarriors/game-core/execution";

const effect = (operations, ownerId = "actor", source = "ordinary") => ({
  ownerId,
  source,
  operations,
});

function fixture(overrides = {}) {
  const log = [];
  const queue = new ExecutionQueue({
    isOwnerAlive: () => true,
    canExecute: () => true,
    execute: (operation, context) => {
      log.push(operation.name);

      if (operation.effects) {
        context.emit(...operation.effects);
      }
    },
    ...overrides,
  });

  return { queue, log };
}

test("последствия ждут всех операций и опережают прежнюю очередь в порядке создания", () => {
  const { queue, log } = fixture();
  queue.enqueue(
    effect([
      { name: "A1", effects: [effect([{ name: "B" }]), effect([{ name: "C" }])] },
      { name: "A2", effects: [effect([{ name: "D" }])] },
    ]),
    effect([{ name: "old" }]),
  );
  queue.drain();
  assert.deepEqual(log, ["A1", "A2", "B", "C", "D", "old"]);
  assert.equal(queue.size, 0);
});

test("вложенные последствия исполняются перед следующими соседними ветвями", () => {
  const { queue, log } = fixture();
  queue.enqueue(
    effect([
      {
        name: "A",
        effects: [
          effect([{ name: "B", effects: [effect([{ name: "nested" }])] }]),
          effect([{ name: "C" }]),
        ],
      },
    ]),
    effect([{ name: "old" }]),
  );
  queue.drain();
  assert.deepEqual(log, ["A", "B", "nested", "C", "old"]);
});

test("невозможная операция пропускается отдельно, проверки видят изменения предыдущих", () => {
  let value = 0;
  const { queue } = fixture({
    canExecute: (operation) => value >= operation.minimum,
    execute: (operation) => {
      value += operation.delta;
    },
  });
  queue.enqueue(
    effect([
      { minimum: 0, delta: 2 },
      { minimum: 3, delta: 100 },
      { minimum: 2, delta: 5 },
    ]),
  );
  queue.drain();
  assert.equal(value, 7);
});

test("жизнь владельца проверяется один раз, нулевой HP внутри эффекта допускает лечение", () => {
  const actor = { hp: 5, alive: true };
  let checks = 0;
  let boundaries = 0;
  const { queue } = fixture({
    isOwnerAlive: () => {
      checks += 1;
      return actor.alive;
    },
    execute: (delta) => {
      actor.hp = Math.max(0, actor.hp + delta);
    },
    afterEffect: () => {
      boundaries += 1;
      actor.alive = actor.hp > 0;
    },
  });
  queue.enqueue(effect([-100, 1]));
  queue.drain();
  assert.deepEqual(actor, { hp: 1, alive: true });
  assert.equal(checks, 1);
  assert.equal(boundaries, 1);
});

test("граница смерти отключает следующий обычный эффект, сохраняя чужие и собственный DEATH", () => {
  const owners = { actor: { alive: true, hp: 5 }, other: { alive: true, hp: 5 } };
  const log = [];
  const { queue } = fixture({
    isOwnerAlive: (id) => owners[id]?.alive === true,
    execute: (operation) => {
      log.push(operation.name);

      if (operation.kill) {
        owners.actor.hp = 0;
      }
    },
    afterEffect: (context) => {
      if (owners.actor.alive && owners.actor.hp === 0) {
        owners.actor.alive = false;
        context.emit(effect([{ name: "death" }], "actor", "death"));
      }
    },
  });
  queue.enqueue(
    effect([{ name: "kill", kill: true }]),
    effect([{ name: "heal" }]),
    effect([{ name: "other" }], "other"),
  );
  queue.drain();
  assert.deepEqual(log, ["kill", "death", "other"]);
});

test("погибший или отсутствующий владелец пропускается без вызова операций и границы", () => {
  let boundaries = 0;
  const { queue, log } = fixture({
    isOwnerAlive: () => false,
    afterEffect: () => {
      boundaries += 1;
    },
  });
  queue.enqueue(effect([{ name: "ordinary" }]), effect([{ name: "death" }], "actor", "death"));
  queue.drain();
  assert.deepEqual(log, ["death"]);
  assert.equal(boundaries, 1);
});

test("последствия операций и границы используют общую последовательность создания", () => {
  const { queue, log } = fixture({
    afterEffect: (context) => {
      if (context.effect.ownerId === "root") {
        context.emit(effect([{ name: "boundary" }]));
      }
    },
  });
  queue.enqueue(
    effect([{ name: "root", effects: [effect([{ name: "operation" }])] }], "root"),
    effect([{ name: "old" }]),
  );
  queue.drain();
  assert.deepEqual(log, ["root", "operation", "boundary", "old"]);
});

test("пустой эффект проходит границу, очередь можно повторно наполнить после завершения", () => {
  let boundaries = 0;
  const { queue, log } = fixture({
    afterEffect: () => {
      boundaries += 1;
    },
  });
  queue.enqueue(effect([]));
  queue.drain();
  queue.drain();
  queue.enqueue(effect([{ name: "next" }]));
  queue.drain();
  assert.equal(boundaries, 2);
  assert.deepEqual(log, ["next"]);
});

test("внешняя замена владельца и массива операций не меняет поставленную запись", () => {
  const { queue, log } = fixture({ isOwnerAlive: (id) => id === "actor" });
  const entry = effect([{ name: "original" }]);
  queue.enqueue(entry);
  entry.ownerId = "dead";
  entry.operations.push({ name: "added" });
  queue.drain();
  assert.deepEqual(log, ["original"]);
});

test("повторный drain и прямой enqueue не переключают очередь внутри эффекта", () => {
  let queue;
  let calls = 0;
  queue = fixture({
    execute: () => {
      calls += 1;
      assert.throws(() => queue.drain(), /Повторный вход/);
      assert.throws(() => queue.enqueue(effect([])), /во время исполнения/);
    },
  }).queue;
  queue.enqueue(effect([1, 2]));
  queue.drain();
  assert.equal(calls, 2);
});

test("сохранённый контекст не принимает поздние последствия", () => {
  let saved;
  const { queue } = fixture({
    execute: (_, context) => {
      saved = context;
    },
  });
  queue.enqueue(effect([1]));
  queue.drain();
  assert.throws(() => saved.emit(effect([])), /завершившегося эффекта/);
  assert.equal(queue.size, 0);
});

test("ошибка обработчика не откатывает сделанное и запрещает продолжение частичного эффекта", () => {
  const log = [];
  const { queue } = fixture({
    execute: (operation) => {
      log.push(operation);

      if (operation === "error") {
        throw new Error("broken operation");
      }
    },
  });
  queue.enqueue(effect(["done", "error", "later"]), effect(["old"]));
  assert.throws(() => queue.drain(), /broken operation/);
  assert.deepEqual(log, ["done", "error"]);
  assert.throws(() => queue.drain(), /после ошибки/);
  assert.throws(() => queue.enqueue(effect([])), /после ошибки/);
});
