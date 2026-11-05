import { resolveOpeningAttack, resolveUnitAttack, selectImmediateAttackTarget } from "../combat";
import type { AttackQueue } from "../combat";
import { createDamageQueue } from "../damage";
import type { DamageState } from "../damage";
import { assessDefenderTargets, isDefenderDoorEligible } from "../defender-targeting";
import { getEnemyRouteTargets } from "../enemy-targeting";
import { executeMove } from "../movement";
import type { MoveTarget } from "../movement";
import { openOpening, selectImmediateInteraction } from "../openings";
import type { InteractionOptions } from "../openings";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import type { SeededRng } from "../random";
import { runUnitTurn } from "../turn";
import type { ActionContext, TurnHandlers, TurnResult } from "../turn";
import type { WorldState } from "../world";

export type AutomaticAction =
  | { readonly kind: "ATTACK"; readonly targetKind: "unit" | "opening"; readonly targetId: string }
  | { readonly kind: "INTERACT"; readonly openingId: string }
  | { readonly kind: "MOVE"; readonly target: MoveTarget | null };

interface RouteCandidate {
  readonly target: MoveTarget;
  readonly distance: number;
}

/** Выбор цели маршрута не строит и не разыгрывает ещё не запрошенные шаги. */
function selectRouteTarget(
  world: WorldState,
  actorId: string,
  rng: Pick<SeededRng, "pick">,
  options: InteractionOptions,
): MoveTarget | null {
  const actor = world.units.find((unit) => unit.id === actorId);
  let candidates: RouteCandidate[];

  if (actor?.side === "defender") {
    const assessment = assessDefenderTargets(world, actorId, options.knownEnemyIds ?? [], options);
    candidates =
      assessment.openEnemies.length > 0
        ? assessment.openEnemies.map((enemy) => ({
            target: { kind: "unit", id: enemy.targetId },
            distance: enemy.distance,
          }))
        : assessment.doors.flatMap((door) =>
            door.leadsToEnemy && door.distance !== null
              ? [{ target: { kind: "opening", id: door.doorId }, distance: door.distance }]
              : [],
          );
  } else {
    candidates = getEnemyRouteTargets(world, actorId, options).map((goal) => ({
      target: { kind: goal.kind, id: goal.id },
      distance: goal.distance,
    }));
  }

  if (candidates.length === 0) {
    return null;
  }

  const distance = Math.min(...candidates.map((candidate) => candidate.distance));
  const tied = candidates.filter((candidate) => candidate.distance === distance);
  const selected = tied.length === 1 ? tied[0]! : rng.pick(tied)!;
  return { ...selected.target };
}

/** Вызывать после ACTION_START: выбор меняет только RNG, но не мир. WAIT не существует. */
export function chooseAutomaticAction(
  world: WorldState,
  actorId: string,
  rng: Pick<SeededRng, "pick">,
  options: InteractionOptions = {},
): AutomaticAction {
  const attack = selectImmediateAttackTarget(world, actorId, rng, options);

  if (attack) {
    return { kind: "ATTACK", targetKind: attack.kind, targetId: attack.id };
  }

  const interaction = selectImmediateInteraction(world, actorId, rng, options);

  if (interaction) {
    return { kind: "INTERACT", openingId: interaction.id };
  }

  const actor = world.units.find((unit) => unit.id === actorId);
  const target =
    actor?.alive && actor.position && actor.stats.movement > 0
      ? selectRouteTarget(world, actorId, rng, options)
      : null;
  return { kind: "MOVE", target };
}

/** ATTACK разрешает свои независимые последствия, INTERACT открывает один проём, MOVE ленив. */
export function* executeAutomaticAction(
  runtime: OperationRuntime,
  actorId: string,
  action: AutomaticAction,
  queue: AttackQueue,
  rng: Pick<SeededRng, "pick" | "d6">,
  getOptions: () => InteractionOptions = () => ({}),
): Generator<readonly ExecutableEffect[]> {
  if (queue.size !== 0) {
    throw new Error("Перед действием нужно разрешить предыдущий пакет очереди");
  }

  if (action.kind === "MOVE") {
    yield* executeMove(runtime, actorId, action.target ?? undefined, rng, getOptions);
    return;
  }

  const options = getOptions();

  if (action.kind === "ATTACK") {
    if (action.targetKind === "unit") {
      if (
        runtime.world.units.find((unit) => unit.id === actorId)?.side === "defender" &&
        !options.knownEnemyIds?.includes(action.targetId)
      ) {
        return;
      }

      resolveUnitAttack(runtime, queue, actorId, action.targetId, rng, options);
    } else {
      resolveOpeningAttack(runtime, queue, actorId, action.targetId, options);
    }

    return;
  }

  openOpening(runtime.world, actorId, action.openingId, {
    ...options,
    defenderCanOpen: (world, unit, target) =>
      isDefenderDoorEligible(
        world,
        unit.id,
        target.opening.id,
        options.knownEnemyIds ?? [],
        options,
      ),
  });
}

export interface AutomaticTurnOptions {
  getOptions?(): InteractionOptions;
  /** Наблюдатели читают состояние и не меняют симуляцию. */
  onAction?(action: AutomaticAction, context: ActionContext): void;
  onPhase?: TurnHandlers<AutomaticAction>["onPhase"];
  createQueue?(runtime: OperationRuntime): AttackQueue;
}

/** Два слота с полной переоценкой после каждой ACTION_START и предыдущих последствий. */
export function runAutomaticTurn(
  runtime: OperationRuntime,
  actorId: string,
  getTurnOrder: () => string[],
  damage: DamageState,
  rng: Pick<SeededRng, "pick" | "d6">,
  options: AutomaticTurnOptions = {},
): TurnResult {
  const getOptions = options.getOptions ?? (() => ({}));
  let queue: AttackQueue;

  return runUnitTurn<AutomaticAction>(runtime, actorId, getTurnOrder, {
    ...(options.onPhase ? { onPhase: options.onPhase } : {}),
    createQueue: (controlled) => {
      queue =
        options.createQueue?.(controlled) ?? createDamageQueue(controlled, damage, getTurnOrder);
      return queue;
    },
    chooseAction: (context) => {
      const action = chooseAutomaticAction(context.runtime.world, actorId, rng, getOptions());
      options.onAction?.(action, context);
      return action;
    },
    executeAction: (action, context) =>
      executeAutomaticAction(context.runtime, actorId, action, queue, rng, getOptions),
  });
}
