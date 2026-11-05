export type DamageModifier = { type: "relative" | "absolute"; value: number };

export interface DamageModifiers {
  readonly version: 1;
  stacks: Record<string, DamageModifier[]>;
}

export function createDamageModifiers(): DamageModifiers {
  return { version: 1, stacks: {} };
}

function validate(modifier: DamageModifier): void {
  if (
    (modifier.type !== "relative" && modifier.type !== "absolute") ||
    !Number.isInteger(modifier.value) ||
    (modifier.type === "absolute" && modifier.value < 0) ||
    Object.keys(modifier).some((key) => key !== "type" && key !== "value")
  ) {
    throw new TypeError("Модификатор урона — только relative/absolute с целым числом");
  }
}

export function registerDamageEvent(modifiers: DamageModifiers, eventId: string): void {
  if (modifiers.version !== 1 || typeof eventId !== "string" || eventId.length === 0) {
    throw new TypeError("Неверное хранилище или ID события урона");
  }

  if (!Object.hasOwn(modifiers.stacks, eventId)) {
    Object.defineProperty(modifiers.stacks, eventId, {
      value: [],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

/** Не создаёт отсутствующее событие и не возвращает разрешённое событие к жизни. */
export function addDamageModifier(
  modifiers: DamageModifiers,
  eventId: string,
  modifier: DamageModifier,
): boolean {
  validate(modifier);

  if (!Object.hasOwn(modifiers.stacks, eventId)) {
    return false;
  }

  modifiers.stacks[eventId]!.push({ type: modifier.type, value: modifier.value });
  return true;
}

/** Чистая числовая арифметика: записи снимаются pop(), затем стек удаляется. */
export function consumeDamageModifiers(
  modifiers: DamageModifiers,
  eventId: string,
  baseAmount: number,
): number {
  if (!Number.isInteger(baseAmount) || baseAmount < 0) {
    throw new RangeError("Исходный урон должен быть неотрицательным целым числом");
  }

  if (!Object.hasOwn(modifiers.stacks, eventId)) {
    return baseAmount;
  }

  const stack = modifiers.stacks[eventId]!;

  for (const modifier of stack) {
    validate(modifier);
  }

  let amount = baseAmount;

  while (stack.length > 0) {
    const modifier = stack.pop()!;
    amount = modifier.type === "absolute" ? modifier.value : Math.max(0, amount + modifier.value);

    if (!Number.isFinite(amount)) {
      throw new RangeError("Переполнение арифметики урона");
    }
  }

  delete modifiers.stacks[eventId];
  return amount;
}
