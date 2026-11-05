import assert from "node:assert/strict";
import test from "node:test";
import { canStep, loadWorld } from "@deathwarriors/game-core";
import { addEffect, createEffectStore } from "@deathwarriors/game-core/effects";
import {
  createCellDamage,
  createDamageQueue,
  createDamageState,
} from "@deathwarriors/game-core/damage";
import { runUnitTurn } from "@deathwarriors/game-core/turn";
import {
  canAttackOpening,
  checkOpeningInteraction,
  findOpening,
  openOpening,
} from "@deathwarriors/game-core/openings";

const fullMask = () => Array.from({ length: 5 }, () => [1, 1, 1, 1, 1]);
const defenderPolicy = { defenderCanOpen: () => true };

function fixture(kind = "door", side = "enemy") {
  const world = loadWorld({
    version: 1,
    map: {
      width: 4,
      height: 3,
      cells: Array.from({ length: 12 }, (_, index) => ({
        surface: "floor",
        area: "inside",
        structure:
          index === 6
            ? {
                id: "opening",
                kind,
                state: "closed",
                reinforcement: null,
                interactionMask: fullMask(),
              }
            : null,
      })),
    },
    units: [
      {
        id: "actor",
        kind: "unit",
        definitionId: "fighter",
        side,
        alive: true,
        position: { x: 1, y: 1 },
        stats: { hp: 5, maxHP: 5, strength: 1, agility: 1, damage: 1, movement: 1, resistance: 0 },
        attackMask: fullMask(),
        keywords: [],
      },
    ],
    traps: [],
  });
  return { world, effects: createEffectStore() };
}

test("дверь и окно открываются врагом без защитника за ними; проход обновляется сразу", () => {
  for (const kind of ["door", "window"]) {
    const { world } = fixture(kind);
    const unit = world.units[0];
    const target = findOpening(world, "opening");
    assert.deepEqual(target.position, { x: 2, y: 1 });
    assert.equal(canStep(world, unit, target.position), false);
    assert.equal(checkOpeningInteraction(world, unit.id, "opening").allowed, true);
    assert.equal(target.opening.state, "closed");
    assert.equal(openOpening(world, unit.id, "opening").allowed, true);
    assert.equal(canStep(world, unit, target.position), true);
    assert.equal(world.map.cells[6].structure, target.opening);
    assert.deepEqual(openOpening(world, unit.id, "opening"), {
      allowed: false,
      reason: "not_closed",
    });
    assert.equal(target.opening.state, "open");
  }
});

test("защитник открывает только дверь после проверки AI; окно не разрешается политикой", () => {
  const { world } = fixture("door", "defender");
  assert.equal(openOpening(world, "actor", "opening").reason, "defender_policy");
  assert.equal(
    openOpening(world, "actor", "opening", {
      defenderCanOpen: () => false,
    }).reason,
    "defender_policy",
  );
  assert.equal(
    openOpening(world, "actor", "opening", {
      defenderCanOpen: (currentWorld, actor, target) => {
        assert.equal(currentWorld, world);
        assert.equal(actor, world.units[0]);
        assert.equal(target.opening.id, "opening");
        return true;
      },
    }).allowed,
    true,
  );
  const window = fixture("window", "defender");
  assert.equal(
    openOpening(window.world, "actor", "opening", defenderPolicy).reason,
    "defender_window",
  );
});

test("доступность использует матрицу объекта и актуальную supercover-линию", () => {
  const { world } = fixture();
  world.units[0].position = { x: 0, y: 1 };
  const opening = findOpening(world, "opening").opening;
  opening.interactionMask[2][0] = 0;
  assert.equal(openOpening(world, "actor", "opening").reason, "unreachable");
  opening.interactionMask[2][0] = 1;
  world.map.cells[5].structure = { id: "wall", kind: "wall" };
  assert.equal(openOpening(world, "actor", "opening").reason, "unreachable");
  world.map.cells[5].structure = null;
  world.units.push({ ...world.units[0], id: "blocker", position: { x: 1, y: 1 } });
  assert.equal(openOpening(world, "actor", "opening").reason, "unreachable");
  world.units.pop();
  assert.equal(openOpening(world, "actor", "opening").allowed, true);
});

test("касание угла не обходит препятствие; проверка при исполнении видит изменения", () => {
  const { world } = fixture();
  world.units[0].position = { x: 1, y: 0 };
  assert.equal(checkOpeningInteraction(world, "actor", "opening").allowed, true);
  world.map.cells[2].structure = { id: "corner", kind: "wall" };
  assert.equal(openOpening(world, "actor", "opening").reason, "unreachable");
  assert.equal(findOpening(world, "opening").opening.state, "closed");
});

test("отсутствующий/погибший актор и отсутствующий/разрушенный проём не открываются", () => {
  const { world } = fixture();
  assert.equal(openOpening(world, "missing", "opening").reason, "actor_unavailable");
  world.units[0].alive = false;
  assert.equal(openOpening(world, "actor", "opening").reason, "actor_unavailable");
  world.units[0].alive = true;
  world.units[0].position = null;
  assert.equal(openOpening(world, "actor", "opening").reason, "actor_unavailable");
  world.units[0].position = { x: 1, y: 1 };
  assert.equal(openOpening(world, "actor", "missing").reason, "opening_missing");
  findOpening(world, "opening").opening.state = "destroyed";
  assert.equal(openOpening(world, "actor", "opening").reason, "not_closed");
});

test("обычный проём не атакуется; укреплённый атакуется только врагом по геометрии", () => {
  const { world } = fixture();
  const opening = findOpening(world, "opening").opening;
  assert.equal(canAttackOpening(world, "actor", "opening"), false);
  opening.reinforcement = { hp: 4, maxHP: 4, resistance: 1 };
  assert.equal(openOpening(world, "actor", "opening").reason, "reinforced");
  assert.equal(canAttackOpening(world, "actor", "opening"), true);
  world.units[0].side = "defender";
  assert.equal(canAttackOpening(world, "actor", "opening"), false);
  world.units[0].side = "enemy";
  world.units[0].attackMask[2][3] = 0;
  assert.equal(canAttackOpening(world, "actor", "opening"), false);
  world.units[0].attackMask = fullMask();
  opening.state = "open";
  assert.equal(canAttackOpening(world, "actor", "opening"), false);
});

test("разрушение обоих видов проёмов сохраняет укрепление и прикреплённые эффекты", () => {
  for (const kind of ["door", "window"]) {
    const runtime = fixture(kind);
    const { world, effects } = runtime;
    const opening = findOpening(world, "opening").opening;
    const reinforcement = { hp: 3, maxHP: 6, resistance: 1 };
    opening.reinforcement = reinforcement;
    addEffect(effects, {
      definitionId: "rune",
      ownerId: "opening",
      phase: "TURN_START",
      operations: [],
      state: { rune: 7 },
    });
    const savedEffects = JSON.stringify(effects);
    const state = createDamageState();
    const queue = createDamageQueue(runtime, state, () => ["actor"]);
    queue.enqueue(createCellDamage(state, { x: 2, y: 1 }, 4));
    queue.drain();
    assert.equal(opening.state, "destroyed");
    assert.equal(opening.reinforcement, reinforcement);
    assert.equal(reinforcement.hp, 0);
    assert.equal(JSON.stringify(effects), savedEffects);
    assert.equal(canStep(world, world.units[0], { x: 2, y: 1 }), true);
    assert.equal(canAttackOpening(world, "actor", "opening"), false);
    assert.equal(openOpening(world, "actor", "opening").reason, "not_closed");
  }
});

test("первый INTERACT расходует один слот, второй MOVE сразу проходит через дверь", () => {
  const runtime = fixture();
  const result = runUnitTurn(runtime, "actor", () => ["actor"], {
    chooseAction: ({ slot }) => ({ kind: slot === 1 ? "INTERACT" : "MOVE" }),
    executeAction: function* (action, { unit }) {
      if (action.kind === "INTERACT") {
        assert.equal(openOpening(runtime.world, unit.id, "opening").allowed, true);
      } else {
        assert.equal(canStep(runtime.world, unit, { x: 2, y: 1 }), true);
        unit.position = { x: 2, y: 1 };
      }
    },
  });
  assert.deepEqual(result.actions, [
    { slot: 1, kind: "INTERACT" },
    { slot: 2, kind: "MOVE" },
  ]);
  assert.equal(result.status, "completed");
  assert.deepEqual(runtime.world.units[0].position, { x: 2, y: 1 });
});
