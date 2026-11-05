import type { JsonValue } from "../effects";

export class ContentValidationError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ContentValidationError";
  }
}

/** До разбора схемы отсекаем не-JSON, сохраняя точный адрес ошибки. */
export function copyContentJson(input: unknown, path = "$", active = new Set<object>()): JsonValue {
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
    throw new ContentValidationError(path, "ожидаются конечные JSON-данные без циклов");
  }

  active.add(input);

  try {
    if (Array.isArray(input)) {
      return Array.from({ length: input.length }, (_, index) => {
        if (!Object.hasOwn(input, index)) {
          throw new ContentValidationError(`${path}[${index}]`, "отсутствует элемент");
        }

        const descriptor = Object.getOwnPropertyDescriptor(input, index)!;

        if (descriptor.get || descriptor.set) {
          throw new ContentValidationError(`${path}[${index}]`, "ожидается обычный JSON-элемент");
        }

        return copyContentJson(input[index], `${path}[${index}]`, active);
      });
    }

    return Object.fromEntries(
      Object.entries(Object.getOwnPropertyDescriptors(input)).map(([key, descriptor]) => {
        if (descriptor.get || descriptor.set || !descriptor.enumerable) {
          throw new ContentValidationError(`${path}.${key}`, "ожидается обычное JSON-поле");
        }

        return [key, copyContentJson(descriptor.value, `${path}.${key}`, active)];
      }),
    );
  } finally {
    active.delete(input);
  }
}

export function object(
  value: unknown,
  path: string,
  keys?: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContentValidationError(path, "ожидается объект");
  }

  const result = value as Record<string, unknown>;

  if (keys) {
    for (const key of Object.keys(result)) {
      if (!keys.includes(key)) {
        throw new ContentValidationError(`${path}.${key}`, "неизвестное поле");
      }
    }

    for (const key of keys) {
      if (!Object.hasOwn(result, key)) {
        throw new ContentValidationError(`${path}.${key}`, "отсутствует обязательное поле");
      }
    }
  }

  return result;
}

export function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ContentValidationError(path, "ожидается массив");
  }

  return value;
}

export function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContentValidationError(path, "ожидается непустая строка");
  }

  return value;
}

export function choice<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new ContentValidationError(path, `ожидается одно из: ${choices.join(", ")}`);
  }

  return value as T;
}

export function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new ContentValidationError(path, `ожидается целое число не меньше ${minimum}`);
  }

  return value;
}

export function mask(value: unknown, path: string): void {
  const rows = array(value, path);

  if (rows.length !== 5) {
    throw new ContentValidationError(path, "ожидается матрица 5×5");
  }

  for (const [y, value] of rows.entries()) {
    const row = array(value, `${path}[${y}]`);

    if (row.length !== 5) {
      throw new ContentValidationError(`${path}[${y}]`, "ожидается строка из 5 клеток");
    }

    for (const [x, bit] of row.entries()) {
      if (bit !== 0 && bit !== 1) {
        throw new ContentValidationError(`${path}[${y}][${x}]`, "ожидается 0 или 1");
      }
    }
  }
}

export const STATS = [
  "hp",
  "maxHP",
  "resistance",
  "strength",
  "agility",
  "damage",
  "movement",
] as const;

export function durability(value: unknown, path: string, unit: boolean): void {
  const keys = unit ? STATS : ["hp", "maxHP", "resistance"];
  const stats = object(value, path, keys);

  for (const key of keys) {
    integer(stats[key], `${path}.${key}`, key === "maxHP" ? 1 : 0);
  }

  if ((stats.hp as number) > (stats.maxHP as number)) {
    throw new ContentValidationError(`${path}.hp`, "HP превышает maxHP");
  }
}

export function selector(value: unknown, path: string, cellOnly = false): void {
  const target = object(value, path);
  const kind = choice(
    target.kind,
    `${path}.kind`,
    cellOnly
      ? ["cell"]
      : ["owner", "attacker", "defender", "cell", "occupant", "allies", "enemies", "unit"],
  );
  object(value, path, kind === "unit" ? ["kind", "id"] : ["kind"]);

  if (kind === "unit") {
    text(target.id, `${path}.id`);
  }
}

export function instance(value: unknown, path: string): void {
  const target = object(value, path);
  const kind = choice(target.kind, `${path}.kind`, ["self", "instance"]);
  object(value, path, kind === "instance" ? ["kind", "id"] : ["kind"]);

  if (kind === "instance") {
    text(target.id, `${path}.id`);
  }
}

export function numeric(value: unknown, path: string): void {
  if (typeof value === "number") {
    return;
  }

  const expr = object(value, path);
  const kind = choice(expr.kind, `${path}.kind`, [
    "stat",
    "state",
    "counter",
    "add",
    "subtract",
    "multiply",
    "min",
    "max",
  ]);

  if (kind === "stat") {
    object(value, path, ["kind", "target", "stat"]);
    selector(expr.target, `${path}.target`);
    choice(expr.stat, `${path}.stat`, STATS);
  } else if (kind === "state" || kind === "counter") {
    object(value, path, kind === "state" ? ["kind", "name"] : ["kind", "name", "instance"]);
    text(expr.name, `${path}.name`);

    if (kind === "counter") {
      instance(expr.instance, `${path}.instance`);
    }
  } else {
    object(value, path, ["kind", "left", "right"]);
    numeric(expr.left, `${path}.left`);
    numeric(expr.right, `${path}.right`);
  }
}
