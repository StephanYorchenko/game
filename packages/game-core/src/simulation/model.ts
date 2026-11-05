import type { ContentPack } from "../content";
import type { JournalEntry } from "../journal";
import type { NightStatus, NightTurnContext } from "../night";
import type { InteractionOptions } from "../openings";
import type { WorldState } from "../world";

export interface OpeningBinding {
  readonly id: string;
  readonly definitionId: string;
}

/** Подготовленное состояние с текущими HP/характеристиками и связями проёмов с контентом. */
export interface SimulationScenario {
  readonly world: WorldState;
  readonly openings: readonly OpeningBinding[];
}

export interface SimulationInput {
  readonly seed: number;
  readonly content: ContentPack;
  readonly scenario: SimulationScenario;
}

export interface SimulationOptions {
  /** Доверенный модуль правил; не десериализуется из контента и не меняет симуляцию. */
  getOptions?(ownerId: string): InteractionOptions;
}

export interface SimulationSnapshot {
  readonly version: 1;
  readonly contentId: string;
  readonly seed: number;
  readonly world: WorldState;
  readonly status: NightStatus | "error";
  readonly round: number;
  readonly completedRounds: number;
  readonly turnsTaken: number;
  readonly nextUnitId: string | null;
  readonly lastTurn: NightTurnContext | null;
  readonly error: { readonly message: string } | null;
}

export interface SimulationUpdate {
  readonly snapshot: SimulationSnapshot;
  /** Новые записи полного диагностического журнала за вызов, без дублирования прошлых. */
  readonly events: readonly JournalEntry[];
}

export interface SimulationSession {
  getSnapshot(): SimulationSnapshot;
  getEvents(): readonly JournalEntry[];
  /** Один полный ход с фазами и всеми последствиями. */
  step(): SimulationUpdate;
  runToEnd(): SimulationUpdate;
  reset(): SimulationUpdate;
}
