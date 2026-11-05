import type { JsonValue } from "../effects";
import { createSeededRng } from "../random";
import type { RngSnapshot, SeededRng } from "../random";
import { canonicalJson, copyJson } from "./json";

export { createJournalRuntime, createJournalDamageQueue, runJournaledTurn } from "./engine";

export interface JournalScope {
  readonly round: number | null;
  readonly turn: number | null;
  readonly ownerId: string | null;
  readonly slot: 1 | 2 | null;
  readonly phase: string | null;
}

export interface JournalEntry {
  readonly sequence: number;
  readonly scope: JournalScope;
  readonly kind: string;
  readonly visibility: "internal" | "public";
  readonly data: JsonValue;
}

/** Полный диагностический журнал; публичная проекция разрешает только явные public-записи. */
export class EventJournal {
  private entries: JournalEntry[] = [];
  private scope: JournalScope = {
    round: null,
    turn: null,
    ownerId: null,
    slot: null,
    phase: null,
  };

  setScope(scope: JournalScope): void {
    for (const value of [scope.round, scope.turn]) {
      if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
        throw new RangeError("Номер раунда/хода должен быть положительным целым или null");
      }
    }

    if (scope.slot !== null && scope.slot !== 1 && scope.slot !== 2) {
      throw new RangeError("Слот должен быть 1, 2 или null");
    }

    this.scope = copyJson(scope) as unknown as JournalScope;
  }

  append(kind: string, data: unknown, visibility: "internal" | "public" = "internal"): void {
    this.entries.push({
      sequence: this.entries.length + 1,
      scope: { ...this.scope },
      kind,
      visibility,
      data: copyJson(data),
    });
  }

  get size(): number {
    return this.entries.length;
  }

  snapshot(afterSequence = 0): readonly JournalEntry[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > this.size) {
      throw new RangeError("Курсор журнала должен указывать на существующую границу записей");
    }

    return copyJson(this.entries.slice(afterSequence)) as unknown as JournalEntry[];
  }

  publicSnapshot(): readonly JournalEntry[] {
    return this.snapshot()
      .filter((entry) => entry.visibility === "public")
      .map((entry, index) => ({ ...entry, sequence: index + 1 }));
  }
}

/** Одна запись на вызов API; обёртка не делает дополнительных случайных выборов. */
export function journalRng(journal: EventJournal, rng: SeededRng): SeededRng {
  const invoke = (method: string, args: JsonValue, call: () => number): number => {
    const before = rng.snapshot();
    const result = call();
    journal.append("rng", { method, args, result, before, after: rng.snapshot() });
    return result;
  };

  return {
    nextUint32: () => invoke("nextUint32", [], () => rng.nextUint32()),
    nextFloat: () => invoke("nextFloat", [], () => rng.nextFloat()),
    nextInt: (maxExclusive) => invoke("nextInt", [maxExclusive], () => rng.nextInt(maxExclusive)),
    d6: () => invoke("d6", [], () => rng.d6()),
    pick: <T>(candidates: readonly T[]): T | undefined => {
      const ordered = copyJson(candidates);
      const before = rng.snapshot();
      const index = candidates.length === 0 ? null : rng.nextInt(candidates.length);
      journal.append("rng", {
        method: "pick",
        candidates: ordered,
        index,
        before,
        after: rng.snapshot(),
      });
      return index === null ? undefined : candidates[index];
    },
    snapshot: () => rng.snapshot(),
  };
}

export interface SimulationRecording<Initial, Final> {
  readonly version: 1;
  readonly seed: number;
  readonly initial: Initial;
  readonly entries: readonly JournalEntry[];
  readonly final: Final;
  readonly rng: RngSnapshot;
}

export type SimulationRunner<Initial, Final> = (
  initial: Initial,
  journal: EventJournal,
  rng: SeededRng,
) => Final;

/** Runner задаёт версию симуляции/контента; все его входы должны быть в initial. */
export function recordSimulation<Initial, Final>(
  initial: Initial,
  seed: number,
  runner: SimulationRunner<Initial, Final>,
): SimulationRecording<Initial, Final> {
  const saved = copyJson(initial) as Initial;
  const journal = new EventJournal();
  const rng = journalRng(journal, createSeededRng(seed));
  const final = runner(copyJson(saved) as Initial, journal, rng);

  return {
    version: 1,
    seed,
    initial: saved,
    entries: journal.snapshot(),
    final: copyJson(final) as Final,
    rng: rng.snapshot(),
  };
}

/** Повтор выполняет тот же runner, сравнивая журнал, итог и состояние RNG. */
export function replaySimulation<Initial, Final>(
  recording: SimulationRecording<Initial, Final>,
  runner: SimulationRunner<Initial, Final>,
): {
  readonly matches: boolean;
  readonly firstMismatch: string | null;
  readonly actual: SimulationRecording<Initial, Final>;
} {
  if (recording.version !== 1) {
    throw new TypeError("Неизвестная версия записи симуляции");
  }

  const actual = recordSimulation(recording.initial, recording.seed, runner);
  const length = Math.max(recording.entries.length, actual.entries.length);
  let firstMismatch: string | null = null;

  for (let index = 0; index < length; index += 1) {
    if (
      canonicalJson(recording.entries[index] ?? null) !==
      canonicalJson(actual.entries[index] ?? null)
    ) {
      firstMismatch = `entries[${index}]`;
      break;
    }
  }

  if (firstMismatch === null && canonicalJson(recording.final) !== canonicalJson(actual.final)) {
    firstMismatch = "final";
  }

  if (firstMismatch === null && canonicalJson(recording.rng) !== canonicalJson(actual.rng)) {
    firstMismatch = "rng";
  }

  return { matches: firstMismatch === null, firstMismatch, actual };
}
