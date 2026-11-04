const UINT32_RANGE = 0x1_0000_0000;
const MASK64 = (1n << 64n) - 1n;
const MULTIPLIER = 6364136223846793005n;
/** Фиксированный PCG stream 54: increment = 2 * stream + 1. */
const INCREMENT = 109n;
export const RNG_ALGORITHM = "pcg32-v1" as const;

export interface RngSnapshot {
  readonly algorithm: typeof RNG_ALGORITHM;
  /** 64-битное состояние как 16 строчных шестнадцатеричных цифр. */
  readonly state: string;
}

export interface SeededRng {
  nextUint32(): number;
  nextFloat(): number;
  /** Равномерное целое в [0, maxExclusive), где 1 <= maxExclusive <= 2^32. */
  nextInt(maxExclusive: number): number;
  d6(): number;
  /** Порядок кандидатов — часть входного состояния; массив не сортируется и не меняется. */
  pick<T>(candidates: readonly T[]): T | undefined;
  snapshot(): RngSnapshot;
}

function generator(initialState: bigint): SeededRng {
  let state = initialState;
  const nextUint32 = (): number => {
    const previous = state;
    state = (previous * MULTIPLIER + INCREMENT) & MASK64;
    const mixed = Number((((previous >> 18n) ^ previous) >> 27n) & 0xffff_ffffn);
    const rotation = Number(previous >> 59n);

    return ((mixed >>> rotation) | (mixed << ((32 - rotation) & 31))) >>> 0;
  };
  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
      throw new RangeError("maxExclusive должен быть целым числом от 1 до 2^32");
    }

    if (maxExclusive === 1) {
      return 0;
    }

    // Оставляем кратное размеру диапазона количество возможных 32-битных результатов.
    const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
    let value: number;

    do {
      value = nextUint32();
    } while (value >= limit);

    return value % maxExclusive;
  };

  return {
    nextUint32,
    nextFloat: () => nextUint32() / UINT32_RANGE,
    nextInt,
    d6: () => nextInt(6) + 1,
    pick: <T>(candidates: readonly T[]): T | undefined => {
      if (candidates.length === 0) {
        return undefined;
      }

      return candidates[nextInt(candidates.length)];
    },
    snapshot: () => ({ algorithm: RNG_ALGORITHM, state: state.toString(16).padStart(16, "0") }),
  };
}

/** Числовой seed — uint32, включая 0. Не читает время, Math.random или глобальное состояние. */
export function createSeededRng(seed: number): SeededRng {
  if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_RANGE) {
    throw new RangeError("seed должен быть целым числом от 0 до 2^32 - 1");
  }

  // PCG seeding: нулевая инициализация, шаг, добавление seed, ещё один шаг.
  const seeded = ((INCREMENT + BigInt(seed)) * MULTIPLIER + INCREMENT) & MASK64;

  return generator(seeded);
}

/** Восстановление продолжает поток, не выполняя повторную инициализацию seed. */
export function restoreSeededRng(input: unknown): SeededRng {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Ожидается JSON-снимок RNG");
  }

  const snapshot = input as Record<string, unknown>;

  if (
    Object.keys(snapshot).length !== 2 ||
    !Object.hasOwn(snapshot, "algorithm") ||
    !Object.hasOwn(snapshot, "state") ||
    snapshot.algorithm !== RNG_ALGORITHM ||
    typeof snapshot.state !== "string" ||
    !/^[0-9a-f]{16}$/.test(snapshot.state)
  ) {
    throw new TypeError("Некорректный или неподдерживаемый снимок RNG");
  }

  return generator(BigInt(`0x${snapshot.state}`));
}
