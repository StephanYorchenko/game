import { getImmediateAttackTargets } from "../combat";
import { assessDefenderTargets } from "../defender-targeting";
import { findOpening, getAvailableInteractions } from "../openings";
import type { InteractionOptions } from "../openings";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import { findActionPath } from "../pathfinding";
import type { ActionTarget } from "../pathfinding";
import type { SeededRng } from "../random";
import { createPhaseContext } from "../targets";
import { getCell } from "../world";
import type { UnitState, WorldState } from "../world";
import type { MoveProgress, MoveTarget, PendingMoveStep } from "./state";

export interface MoveResult {
  readonly stepsTaken: number;
  readonly reason:
    | "dead"
    | "attack_available"
    | "interaction_available"
    | "budget_exhausted"
    | "no_route";
}

function resolveDestination(
  world: WorldState,
  actor: UnitState,
  target: MoveTarget | null,
  options: InteractionOptions,
): ActionTarget | undefined {
  if (!target) {
    return undefined;
  }

  if (target.kind === "unit") {
    const unit = world.units.find((candidate) => candidate.id === target.id);

    if (
      !unit?.alive ||
      !unit.position ||
      unit.side === actor.side ||
      getCell(world.map, unit.position)?.area !== "inside" ||
      (actor.side === "defender" && !options.knownEnemyIds?.includes(unit.id))
    ) {
      return undefined;
    }

    return { kind: "attack", position: { ...unit.position }, actorArea: "inside" };
  }

  const opening = findOpening(world, target.id);

  if (!opening || opening.opening.state !== "closed") {
    return undefined;
  }

  if (actor.side === "defender") {
    const assessment = assessDefenderTargets(world, actor.id, options.knownEnemyIds ?? [], options);

    if (
      assessment.openEnemies.length > 0 ||
      !assessment.doors.some((door) => door.doorId === target.id && door.leadsToEnemy)
    ) {
      return undefined;
    }
  }

  return opening.opening.reinforcement
    ? { kind: "attack", position: { ...opening.position } }
    : {
        kind: "interact",
        position: { ...opening.position },
        interactionMask: opening.opening.interactionMask,
      };
}

/** Один yield — один фиксированный шаг; потребитель полностью разрешает очередь между next. */
export function* executeMove(
  runtime: OperationRuntime,
  actorId: string,
  target: MoveTarget | undefined,
  rng: Pick<SeededRng, "pick">,
  getOptions: () => InteractionOptions = () => ({}),
): Generator<readonly ExecutableEffect[], MoveResult> {
  const state = runtime.movement;

  if (!state) {
    throw new Error("Для MOVE нужно состояние createMoveState()");
  }

  if (state.active.some((move) => move.actorId === actorId)) {
    throw new Error("У юнита уже исполняется MOVE");
  }

  if (!Number.isSafeInteger(state.nextMoveId) || state.nextMoveId < 1) {
    throw new RangeError("Исчерпан или повреждён счётчик MOVE");
  }

  const move: MoveProgress = {
    id: `move:${state.nextMoveId++}`,
    actorId,
    target: target ? { ...target } : null,
    stepsTaken: 0,
    stepsIssued: 0,
    pending: null,
  };
  state.active.push(move);
  const finish = (reason: MoveResult["reason"]): MoveResult => ({
    stepsTaken: move.stepsTaken,
    reason,
  });

  try {
    while (true) {
      const actor = runtime.world.units.find((unit) => unit.id === actorId);

      if (!actor?.alive || !actor.position) {
        return finish("dead");
      }

      const options = getOptions();

      if (getImmediateAttackTargets(runtime.world, actorId, options).length > 0) {
        return finish("attack_available");
      }

      if (
        move.target?.kind === "opening" &&
        getAvailableInteractions(runtime.world, actorId, options).some(
          (opening) => opening.id === move.target?.id,
        )
      ) {
        return finish("interaction_available");
      }

      if (move.stepsTaken >= actor.stats.movement) {
        return finish("budget_exhausted");
      }

      const destination = resolveDestination(runtime.world, actor, move.target, options);
      const path = destination
        ? findActionPath(runtime.world, actor, destination, rng, options)
        : undefined;
      const cell = path?.steps[0];

      if (!cell) {
        return finish("no_route");
      }

      const rules = options.movement;
      const step: PendingMoveStep = {
        number: ++move.stepsIssued,
        from: { ...actor.position },
        cell: { ...cell },
        rules: {
          ...(rules?.knownTrapIds ? { knownTrapIds: [...rules.knownTrapIds] } : {}),
          ...(rules?.directions ? { directions: [...rules.directions] } : {}),
          ...(rules?.allowWindows !== undefined ? { allowWindows: rules.allowWindows } : {}),
        },
        status: "pending",
      };
      move.pending = step;

      yield [
        {
          ownerId: actorId,
          instanceId: `${move.id}:step:${step.number}`,
          definitionId: "engine:move_step",
          source: "ordinary",
          phase: "ACTION_START",
          state: {},
          context: createPhaseContext({ kind: "move_step", ownerId: actorId, cell: step.cell }),
          operations: [{ kind: "move_step", moveId: move.id, step: step.number }],
        },
      ];

      if (!actor.alive || !actor.position) {
        return finish("dead");
      }

      if (step.status === "pending") {
        throw new Error("Предыдущий шаг MOVE ещё не разрешён очередью");
      }

      move.pending = null;
    }
  } finally {
    const index = state.active.indexOf(move);

    if (index !== -1) {
      state.active.splice(index, 1);
    }
  }
}
