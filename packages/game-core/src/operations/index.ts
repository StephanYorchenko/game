import { ExecutionQueue } from "../execution";
import type { ExecutionHooks } from "../execution";
import { addEffect, modifyEffectCounter, removeEffect, snapshotPhase } from "../effects";
import type { EffectPhase, EffectStore, JsonObject, ScheduledEffect } from "../effects";
import { heal, modifyHP, modifyStat } from "../stats";
import type { Characteristic } from "../stats";
import { createPhaseContext, resolveTargets } from "../targets";
import type { PhaseContext, TargetSelector } from "../targets";
import type { Position, UnitStats, WorldState } from "../world";

export type InstanceTarget = { kind: "self" } | { kind: "instance"; id: string };
export type NumericExpression =
  | number
  | { kind: "stat"; target: TargetSelector; stat: keyof UnitStats }
  | { kind: "state"; name: string }
  | { kind: "counter"; instance: InstanceTarget; name: string }
  | {
      kind: "add" | "subtract" | "multiply" | "min" | "max";
      left: NumericExpression;
      right: NumericExpression;
    };

export type EffectTemplate = {
  definitionId: string;
  phase: EffectPhase;
  operations: EngineOperation[];
  state: JsonObject;
};

export type EngineOperation =
  | { kind: "modify_stat"; target: TargetSelector; stat: Characteristic; delta: NumericExpression }
  | { kind: "modify_hp"; target: TargetSelector; delta: NumericExpression }
  | { kind: "heal"; target: TargetSelector; value: NumericExpression }
  | { kind: "create_damage_event"; target: { kind: "cell" }; amount: NumericExpression }
  | { kind: "add_effect"; target: TargetSelector; effect: EffectTemplate }
  | { kind: "remove_effect"; instance: InstanceTarget }
  | { kind: "modify_counter"; instance: InstanceTarget; name: string; delta: NumericExpression };

export interface ExecutableEffect extends ScheduledEffect<EngineOperation> {
  readonly context: PhaseContext;
}

export interface OperationRuntime {
  readonly world: WorldState;
  readonly effects: EffectStore<EngineOperation>;
}

export interface OperationEvents {
  createDamageEvent(cell: Readonly<Position>, amount: number): void;
}

function instanceId(reference: InstanceTarget, effect: ExecutableEffect): string {
  return reference.kind === "self" ? effect.instanceId : reference.id;
}

/** undefined означает недоступные данные, а не неявное числовое значение 0. */
export function evaluateNumeric(
  runtime: OperationRuntime,
  effect: ExecutableEffect,
  expression: NumericExpression,
): number | undefined {
  if (typeof expression === "number") {
    if (!Number.isFinite(expression)) {
      throw new RangeError("Числовое выражение должно быть конечным");
    }

    return expression;
  }

  if (expression.kind === "state" || expression.kind === "counter") {
    const state =
      expression.kind === "state"
        ? effect.state
        : runtime.effects.instances.find(
            (entry) => entry.instanceId === instanceId(expression.instance, effect),
          )?.state;
    const value =
      state && Object.hasOwn(state, expression.name) ? state[expression.name] : undefined;

    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  if (expression.kind === "stat") {
    const result = resolveTargets(runtime.world, effect.context, expression.target);

    if (result.kind !== "entities" || result.entities.length !== 1) {
      return undefined;
    }

    const target = result.entities[0]!;
    const value = target.kind === "unit" ? target.stats[expression.stat] : undefined;

    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  const left = evaluateNumeric(runtime, effect, expression.left);
  const right = evaluateNumeric(runtime, effect, expression.right);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  let value: number;

  switch (expression.kind) {
    case "add":
      value = left + right;
      break;
    case "subtract":
      value = left - right;
      break;
    case "multiply":
      value = left * right;
      break;
    case "min":
      value = Math.min(left, right);
      break;
    case "max":
      value = Math.max(left, right);
      break;
    default:
      throw new TypeError("Неизвестное числовое выражение");
  }

  if (!Number.isFinite(value)) {
    throw new RangeError("Переполнение числового выражения");
  }

  return value;
}

/** Возвращает false для неосуществимой операции, не отменяя другие операции эффекта. */
export function executeOperation(
  runtime: OperationRuntime,
  effect: ExecutableEffect,
  operation: EngineOperation,
  events?: OperationEvents,
): boolean {
  if (operation.kind === "create_damage_event") {
    const target = resolveTargets(runtime.world, effect.context, operation.target);
    const amount = evaluateNumeric(runtime, effect, operation.amount);

    if (target.kind !== "cell" || amount === undefined) {
      return false;
    }

    if (!events) {
      throw new Error("Для CELL_DAMAGE нужна очередь независимых событий");
    }

    events.createDamageEvent(target.position, amount);
    return true;
  }

  if (operation.kind === "remove_effect") {
    return removeEffect(runtime.effects, instanceId(operation.instance, effect));
  }

  if (operation.kind === "modify_counter") {
    const delta = evaluateNumeric(runtime, effect, operation.delta);

    return (
      delta !== undefined &&
      modifyEffectCounter(
        runtime.effects,
        instanceId(operation.instance, effect),
        operation.name,
        delta,
      )
    );
  }

  if (
    operation.kind !== "modify_stat" &&
    operation.kind !== "modify_hp" &&
    operation.kind !== "heal" &&
    operation.kind !== "add_effect"
  ) {
    throw new TypeError("Неизвестная операция эффекта");
  }

  const targets = resolveTargets(runtime.world, effect.context, operation.target);

  if (targets.kind !== "entities") {
    return false;
  }

  let applied = false;

  for (const target of targets.entities) {
    if (operation.kind === "add_effect") {
      const allowed =
        (target.kind === "unit" && target.alive) ||
        target.kind === "trap" ||
        ((target.kind === "door" || target.kind === "window") && target.state !== "destroyed");

      if (allowed) {
        addEffect(runtime.effects, { ...operation.effect, ownerId: target.id });
        applied = true;
      }

      continue;
    }

    if (target.kind !== "unit" || !target.alive) {
      continue;
    }

    const value = evaluateNumeric(
      runtime,
      effect,
      operation.kind === "heal" ? operation.value : operation.delta,
    );

    if (value === undefined) {
      continue;
    }

    if (operation.kind === "modify_stat") {
      modifyStat(target, operation.stat, value);
    } else if (operation.kind === "modify_hp") {
      modifyHP(target, value);
    } else {
      heal(target, value);
    }

    applied = true;
  }

  return applied;
}

export function schedulePhase(
  store: EffectStore<EngineOperation>,
  ownerId: string,
  phase: EffectPhase,
  context: PhaseContext,
): ExecutableEffect[] {
  if (context.ownerId !== ownerId) {
    throw new TypeError("Владелец контекста не совпадает с владельцем фазового стека");
  }

  return snapshotPhase(store, ownerId, phase).map((effect) => ({
    ...effect,
    context: createPhaseContext(context),
  }));
}

/** Границы жизни/смерти задаёт планировщик; интерпретатор не вычисляет их по HP. */
export function createOperationQueue(
  runtime: OperationRuntime,
  boundaries: Pick<
    ExecutionHooks<EngineOperation, ExecutableEffect>,
    "isOwnerAlive" | "afterEffect"
  >,
): ExecutionQueue<EngineOperation, ExecutableEffect> {
  return new ExecutionQueue<EngineOperation, ExecutableEffect>({
    ...boundaries,
    canExecute: () => true,
    execute: (operation, context) => {
      executeOperation(runtime, context.effect, operation);
    },
  });
}
