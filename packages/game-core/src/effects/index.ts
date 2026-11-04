import type { QueuedEffect } from "../execution/index.js";

export const EFFECT_PHASES = [
  "TURN_START",
  "TURN_END",
  "ACTION_START",
  "ACTION_END",
  "ATTACK_SUCCESS",
  "ATTACK_FAILURE",
  "DEFENSE_SUCCESS",
  "DEFENSE_FAILURE",
  "SUMMON",
  "DEATH",
] as const;

export type EffectPhase = (typeof EFFECT_PHASES)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface EffectDefinition<Operation extends JsonValue> {
  readonly definitionId: string;
  readonly ownerId: string;
  readonly phase: EffectPhase;
  readonly operations: readonly Operation[];
  readonly state: JsonObject;
}

export interface EffectInstance<Operation extends JsonValue> extends EffectDefinition<Operation> {
  readonly instanceId: string;
}

/** Хранить между фазами, ночами и кампаниями; порядок instances — от старых к новым. */
export interface EffectStore<Operation extends JsonValue> {
  nextInstanceId: number;
  instances: EffectInstance<Operation>[];
}

export interface ScheduledEffect<Operation extends JsonValue> extends QueuedEffect<Operation> {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly phase: EffectPhase;
  readonly state: JsonObject;
}

function cloneJson(value: JsonValue, active = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) ||
    active.has(value)
  ) {
    throw new TypeError("Эффект должен содержать только конечные JSON-данные без циклов");
  }

  active.add(value);

  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];

      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("В массиве эффекта не допускаются пропуски");
        }

        result.push(cloneJson(value[index]!, active));
      }

      return result;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item, active)]),
    );
  } finally {
    active.delete(value);
  }
}

function copyDefinition<Operation extends JsonValue>(
  definition: EffectDefinition<Operation>,
): EffectDefinition<Operation> {
  if (
    typeof definition.definitionId !== "string" ||
    definition.definitionId.length === 0 ||
    typeof definition.ownerId !== "string" ||
    definition.ownerId.length === 0 ||
    !EFFECT_PHASES.includes(definition.phase)
  ) {
    throw new TypeError("Нужны ID определения, ID владельца и одна известная фаза эффекта");
  }

  if (
    !Array.isArray(definition.operations) ||
    typeof definition.state !== "object" ||
    definition.state === null ||
    Array.isArray(definition.state)
  ) {
    throw new TypeError("Нужны массив операций и JSON-объект состояния эффекта");
  }

  return {
    definitionId: definition.definitionId,
    ownerId: definition.ownerId,
    phase: definition.phase,
    operations: cloneJson([...definition.operations]) as Operation[],
    state: cloneJson(definition.state) as JsonObject,
  };
}

export function createEffectStore<Operation extends JsonValue>(): EffectStore<Operation> {
  return { nextInstanceId: 1, instances: [] };
}

export function addEffect<Operation extends JsonValue>(
  store: EffectStore<Operation>,
  definition: EffectDefinition<Operation>,
): string {
  const copy = copyDefinition(definition);

  if (!Number.isSafeInteger(store.nextInstanceId) || store.nextInstanceId < 1) {
    throw new RangeError("Исчерпан или повреждён счётчик instanceId");
  }

  const instanceId = `effect:${store.nextInstanceId}`;

  if (store.instances.some((instance) => instance.instanceId === instanceId)) {
    throw new Error("Повторный instanceId в хранилище эффектов");
  }

  store.instances.push({ ...copy, instanceId });
  store.nextInstanceId += 1;
  return instanceId;
}

export function removeEffect<Operation extends JsonValue>(
  store: EffectStore<Operation>,
  instanceId: string,
): boolean {
  const index = store.instances.findIndex((instance) => instance.instanceId === instanceId);

  if (index < 0) {
    return false;
  }

  store.instances.splice(index, 1);
  return true;
}

/** Меняет только постоянный экземпляр. Отсутствующий оригинал/счётчик пропускается. */
export function modifyEffectCounter<Operation extends JsonValue>(
  store: EffectStore<Operation>,
  instanceId: string,
  name: string,
  delta: number,
): boolean {
  if (!Number.isInteger(delta)) {
    throw new RangeError("Изменение счётчика должно быть конечным целым числом");
  }

  const instance = store.instances.find((candidate) => candidate.instanceId === instanceId);
  const current = instance?.state[name];

  if (!instance || !Object.hasOwn(instance.state, name) || !Number.isInteger(current)) {
    return false;
  }

  const next = (current as number) + delta;

  if (!Number.isFinite(next)) {
    throw new RangeError("Переполнение счётчика эффекта");
  }

  instance.state[name] = next;
  return true;
}

export function snapshotPhase<Operation extends JsonValue>(
  store: EffectStore<Operation>,
  ownerId: string,
  phase: EffectPhase,
): ScheduledEffect<Operation>[] {
  return store.instances
    .filter((instance) => instance.ownerId === ownerId && instance.phase === phase)
    .reverse()
    .map((instance) => ({
      ...copyDefinition(instance),
      instanceId: instance.instanceId,
      source: phase === "DEATH" ? "death" : "ordinary",
    }));
}
