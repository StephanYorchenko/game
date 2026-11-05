import { snapshotPhase } from "../effects";
import type { ExecutableEffect, OperationRuntime } from "../operations";
import { createPhaseContext } from "../targets";
import type { PhaseContext } from "../targets";

export interface ReactionCause {
  readonly definitionIds: readonly string[];
}

export type ReactionPhase =
  | "ATTACK_SUCCESS"
  | "ATTACK_FAILURE"
  | "DEFENSE_SUCCESS"
  | "DEFENSE_FAILURE";

export function copyReactionCause(cause: ReactionCause): ReactionCause {
  if (
    !cause ||
    !Array.isArray(cause.definitionIds) ||
    Array.from(cause.definitionIds).some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new TypeError("Причинная цепочка требует массива непустых definitionId");
  }

  return { definitionIds: [...cause.definitionIds] };
}

export function enterReaction(
  cause: ReactionCause | undefined,
  definitionId: string,
): ReactionCause | undefined {
  if (typeof definitionId !== "string" || definitionId.length === 0) {
    throw new TypeError("Для реакции нужен definitionId");
  }

  const ancestors = cause ? copyReactionCause(cause).definitionIds : [];
  return ancestors.includes(definitionId)
    ? undefined
    : { definitionIds: [...ancestors, definitionId] };
}

export function canEnterReaction(
  effect: Pick<ExecutableEffect, "definitionId" | "cause">,
): boolean {
  return enterReaction(effect.cause, effect.definitionId) !== undefined;
}

/** Новая копия для каждого потомка: соседние ветви цепочки не меняют друг друга. */
export function inheritReactionCause<T extends object>(
  entry: T,
  cause: ReactionCause | undefined,
): T & { readonly cause?: ReactionCause } {
  return cause ? { ...entry, cause: copyReactionCause(cause) } : { ...entry };
}

/** Копирует только боевую фазу реакции; DEATH назначает граница смерти, не конфиг операции. */
export function createReactionHandler(
  runtime: OperationRuntime,
  emit: (...effects: readonly ExecutableEffect[]) => void,
): (ownerId: string, phase: ReactionPhase, context: PhaseContext) => boolean {
  return (ownerId, phase, context) => {
    if (
      !["ATTACK_SUCCESS", "ATTACK_FAILURE", "DEFENSE_SUCCESS", "DEFENSE_FAILURE"].includes(phase)
    ) {
      throw new TypeError("Нельзя вызвать эту фазу как боевую реакцию");
    }

    const effects = snapshotPhase(runtime.effects, ownerId, phase).map((effect) => ({
      ...effect,
      context: createPhaseContext({ ...context, ownerId }),
    }));
    emit(...effects);
    return effects.length > 0;
  };
}
