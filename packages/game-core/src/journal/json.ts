import type { JsonValue } from "../effects";

/** Строгая копия: не теряет undefined, функции, NaN или циклы молча. */
export function copyJson(input: unknown, active = new Set<object>()): JsonValue {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return input;
  }

  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }

  if (
    typeof input !== "object" ||
    input === null ||
    (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype) ||
    active.has(input) ||
    Object.getOwnPropertySymbols(input).length > 0
  ) {
    throw new TypeError("Журнал принимает только конечные JSON-данные без циклов");
  }

  active.add(input);

  try {
    if (Array.isArray(input)) {
      const values: JsonValue[] = [];

      for (let index = 0; index < input.length; index += 1) {
        values.push(copyJson(input[index], active));
      }

      return values;
    }

    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, copyJson(Reflect.get(input, key), active)]),
    );
  } finally {
    active.delete(input);
  }
}

export const canonicalJson = (input: unknown): string => JSON.stringify(copyJson(input));
