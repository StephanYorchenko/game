import { createDamageState } from "../damage";
import type { DamageState } from "../damage";
import { EventJournal, createJournalDamageQueue, journalRng } from "../journal";
import type { JournalEntry, JournalScope } from "../journal";
import { createMoveState } from "../movement";
import { createNight, getNextNightUnit, runNight, stepNight } from "../night";
import type { NightOptions, NightRuntime, NightState, NightTurnContext } from "../night";
import { createSeededRng } from "../random";
import type { SeededRng } from "../random";
import { createSummoningState } from "../summoning";
import type {
  SimulationOptions,
  SimulationSession,
  SimulationSnapshot,
  SimulationUpdate,
} from "./model";
import { copyData, prepareSimulation } from "./scenario";
import type { PreparedSimulation } from "./scenario";

export * from "./model";
export { SimulationValidationError } from "./scenario";

class Session implements SimulationSession {
  readonly #prepared: PreparedSimulation;
  readonly #options: SimulationOptions;
  #runtime!: NightRuntime;
  #night!: NightState;
  #damage!: DamageState;
  #rng!: SeededRng;
  #journal!: EventJournal;
  #error: { message: string } | null = null;
  #lastTurn: NightTurnContext | null = null;
  #currentTurn: NightTurnContext | null = null;
  #busy = false;

  constructor(prepared: PreparedSimulation, options: SimulationOptions) {
    if (options.getOptions !== undefined && typeof options.getOptions !== "function") {
      throw new TypeError("getOptions должен быть доверенным обработчиком правил");
    }

    this.#prepared = prepared;
    this.#options = { ...options };
    this.#initialize();
  }

  #initialize(): void {
    this.#journal = new EventJournal();
    this.#error = null;
    this.#lastTurn = null;
    this.#currentTurn = null;
    this.#rng = journalRng(this.#journal, createSeededRng(this.#prepared.seed));
    this.#runtime = {
      world: copyData(this.#prepared.world),
      effects: copyData(this.#prepared.effects),
      movement: createMoveState(),
      summoning: createSummoningState(),
      trapDiscovery: {
        rng: this.#rng,
        onOutcome: (outcome) => this.#journal.append("trap_discovery", outcome),
      },
    };
    this.#damage = createDamageState();
    this.#scope("night_start");
    this.#journal.append("night_start", {
      seed: this.#prepared.seed,
      contentId: this.#prepared.contentId,
    });
    this.#night = createNight(this.#runtime, this.#rng);
    this.#journal.append("initiative", this.#night.initiative);
  }

  #scope(phase: string, location?: Partial<Omit<JournalScope, "phase">>): void {
    this.#journal.setScope({
      round: null,
      turn: null,
      ownerId: null,
      slot: null,
      ...location,
      phase,
    });
  }

  #nightOptions(): NightOptions {
    return {
      ...(this.#options.getOptions ? { getOptions: this.#options.getOptions } : {}),
      onRoundStart: (round) => {
        this.#scope("round_start", { round });
        this.#journal.append("round_start", { round });
      },
      onRoundEnd: (round) => {
        this.#scope("round_end", { round });
        this.#journal.append("round_end", { round });
      },
      onFinish: (status) => {
        this.#scope("night_end", { round: this.#night.round });
        this.#journal.append("night_end", {
          status,
          completedRounds: this.#night.completedRounds,
          departedEnemyIds: this.#night.departedEnemyIds,
        });
      },
      onTurn: (turn) => {
        const { ownerId, round, turn: number } = turn;
        this.#lastTurn = { ownerId, round, turn: number };
        this.#scope("turn_result", this.#lastTurn);
        this.#journal.append("turn_result", turn);
      },
      createTurnOptions: (location) => {
        this.#currentTurn = { ...location };
        this.#scope("turn_start", location);
        this.#journal.append("turn_start", location);
        return {
          createQueue: (runtime) =>
            createJournalDamageQueue(this.#journal, runtime, this.#damage, () => this.#night.order),
          onPhase: (phase, slot) => {
            this.#scope(phase, { ...location, slot });
            this.#journal.append("phase", { phase });
          },
          onAction: (action, context) => {
            this.#scope("action", { ...location, slot: context.slot });
            this.#journal.append("action", action);
          },
        };
      },
    };
  }

  getSnapshot(): SimulationSnapshot {
    return {
      version: 1,
      contentId: this.#prepared.contentId,
      seed: this.#prepared.seed,
      world: copyData(this.#runtime.world),
      status: this.#error ? "error" : this.#night.status,
      round: this.#night.round,
      completedRounds: this.#night.completedRounds,
      turnsTaken: this.#night.turnsTaken,
      nextUnitId: this.#error ? null : (getNextNightUnit(this.#runtime, this.#night) ?? null),
      lastTurn: this.#lastTurn ? { ...this.#lastTurn } : null,
      error: this.#error ? { ...this.#error } : null,
    };
  }

  getEvents(): readonly JournalEntry[] {
    return this.#journal.snapshot();
  }

  #execute(complete: boolean): SimulationUpdate {
    if (this.#busy) {
      throw new Error("Повторный вход в симуляцию запрещён");
    }

    const before = this.#journal.size;
    this.#busy = true;

    try {
      if (!this.#error && this.#night.status === "running") {
        const execute = complete ? runNight : stepNight;
        execute(this.#runtime, this.#night, this.#damage, this.#rng, this.#nightOptions());
      }
    } catch (error) {
      this.#error = {
        message: error instanceof Error ? error.message : "Ошибка исполнения симуляции",
      };
      this.#scope("error", this.#currentTurn ?? { round: this.#night.round });
      this.#journal.append("simulation_error", this.#error);
    } finally {
      this.#busy = false;
      this.#currentTurn = null;
    }

    return { snapshot: this.getSnapshot(), events: this.#journal.snapshot(before) };
  }

  step(): SimulationUpdate {
    return this.#execute(false);
  }

  runToEnd(): SimulationUpdate {
    return this.#execute(true);
  }

  reset(): SimulationUpdate {
    if (this.#busy) {
      throw new Error("Нельзя сбрасывать исполняемую симуляцию");
    }

    this.#busy = true;

    try {
      this.#initialize();
    } finally {
      this.#busy = false;
    }

    return { snapshot: this.getSnapshot(), events: this.getEvents() };
  }
}

/** Новый изолированный запуск одной ночи. Вход и все выдаваемые данные копируются. */
export function createSimulation(
  input: unknown,
  options: SimulationOptions = {},
): SimulationSession {
  return new Session(prepareSimulation(input), options);
}
