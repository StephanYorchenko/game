import { runAutomaticTurn } from "../actions";
import type { AutomaticTurnOptions } from "../actions";
import type { DamageState } from "../damage";
import { createInitiativeOrder } from "../initiative";
import type { InitiativeEntry } from "../initiative";
import type { MoveState } from "../movement";
import type { InteractionOptions } from "../openings";
import type { OperationRuntime } from "../operations";
import type { SeededRng } from "../random";
import type { SummoningState } from "../summoning";
import { clearTrapKnowledge } from "../trap-discovery";
import type { TurnResult } from "../turn";
import { getCell } from "../world";

export const NIGHT_ROUNDS = 13;
export type NightStatus = "running" | "completed" | "defeat";
export type NightRng = Pick<SeededRng, "d6" | "pick" | "nextFloat">;

export interface NightRuntime extends OperationRuntime {
  readonly movement: MoveState;
  readonly summoning: SummoningState;
}

/** Сохраняемые данные между полностью разрешёнными ходами, без объектов очередей. */
export interface NightState {
  readonly version: 1;
  status: NightStatus;
  round: number;
  completedRounds: number;
  turnsTaken: number;
  order: string[];
  acted: string[];
  readonly initiative: readonly InitiativeEntry[];
  departedEnemyIds: string[];
  failed: boolean;
}

export interface NightTurnContext {
  readonly ownerId: string;
  readonly round: number;
  readonly turn: number;
}

export interface NightTurn extends NightTurnContext {
  readonly result: TurnResult;
}

export type NightStep =
  | { readonly kind: "turn"; readonly turn: NightTurn; readonly status: NightStatus }
  | { readonly kind: "finished"; readonly round: number; readonly status: "completed" | "defeat" };

export interface NightOptions {
  getOptions?(ownerId: string): InteractionOptions;
  createTurnOptions?(context: NightTurnContext): Omit<AutomaticTurnOptions, "getOptions">;
  onRoundStart?(round: number): void;
  onTurn?(turn: NightTurn): void;
  onRoundEnd?(round: number): void;
  onFinish?(status: "completed" | "defeat"): void;
}

function assertIdle(runtime: NightRuntime): void {
  if (!runtime.movement || !runtime.summoning) {
    throw new Error("Для ночи нужны сохраняемые movement и summoning в runtime");
  }

  if (runtime.movement.active.length > 0 || runtime.turnControl?.active) {
    throw new Error("Ночь ожидает полностью разрешённую границу хода");
  }

  if (runtime.world.units.some((unit) => unit.alive && unit.stats.hp === 0)) {
    throw new Error("Перед следующим ходом нужно зафиксировать все смерти");
  }
}

/** Инициатива разыгрывается один раз; HP, характеристики и постоянные эффекты не сбрасываются. */
export function createNight(runtime: NightRuntime, rng: Pick<SeededRng, "d6">): NightState {
  assertIdle(runtime);
  const initiative = createInitiativeOrder(runtime.world.units, rng);
  clearTrapKnowledge(runtime.world);
  return {
    version: 1,
    status: "running",
    round: 1,
    completedRounds: 0,
    turnsTaken: 0,
    order: initiative.map((entry) => entry.unitId),
    acted: [],
    initiative,
    departedEnemyIds: [],
    failed: false,
  };
}

/** Читается заново: смерти удаляют ID, призыв добавляет новые ID в конец того же раунда. */
export function getNextNightUnit(runtime: NightRuntime, state: NightState): string | undefined {
  if (state.status !== "running" || state.failed) {
    return undefined;
  }

  const acted = new Set(state.acted);
  const alive = new Set(
    runtime.world.units.filter((unit) => unit.alive && unit.position).map((unit) => unit.id),
  );
  return state.order.find((id) => !acted.has(id) && alive.has(id));
}

function finishNight(
  runtime: NightRuntime,
  state: NightState,
  status: "completed" | "defeat",
): void {
  clearTrapKnowledge(runtime.world);

  if (state.completedRounds === NIGHT_ROUNDS) {
    const enemies = runtime.world.units.filter((unit) => unit.side === "enemy" && unit.alive);
    const ids = new Set(enemies.map((unit) => unit.id));
    state.departedEnemyIds = state.order.filter((id) => ids.has(id));

    for (const enemy of enemies) {
      if (!state.departedEnemyIds.includes(enemy.id)) {
        state.departedEnemyIds.push(enemy.id);
      }
    }

    for (let index = runtime.world.units.length - 1; index >= 0; index -= 1) {
      if (ids.has(runtime.world.units[index]!.id)) {
        runtime.world.units.splice(index, 1);
      }
    }

    for (let index = state.order.length - 1; index >= 0; index -= 1) {
      if (ids.has(state.order[index]!)) {
        state.order.splice(index, 1);
      }
    }
  }

  state.status = status;
}

function endRound(runtime: NightRuntime, state: NightState, options: NightOptions): void {
  state.completedRounds += 1;
  options.onRoundEnd?.(state.round);
  const defendersRemain = runtime.world.units.some(
    (unit) => unit.side === "defender" && unit.alive,
  );

  if (!defendersRemain || state.round === NIGHT_ROUNDS) {
    const status = defendersRemain ? "completed" : "defeat";
    finishNight(runtime, state, status);
    options.onFinish?.(status);
    return;
  }

  state.round += 1;
  state.acted = [];
}

/** Один шаг — полный ход юнита с последствиями; проверка поражения только в конце раунда. */
export function stepNight(
  runtime: NightRuntime,
  state: NightState,
  damage: DamageState,
  rng: NightRng,
  options: NightOptions = {},
): NightStep {
  if (
    state.version !== 1 ||
    !Number.isInteger(state.round) ||
    state.round < 1 ||
    state.round > NIGHT_ROUNDS ||
    !["running", "completed", "defeat"].includes(state.status)
  ) {
    throw new TypeError("Некорректное состояние ночи");
  }

  if (state.failed) {
    throw new Error("Нельзя продолжать ночь после ошибки исполнения");
  }

  if (state.status !== "running") {
    return { kind: "finished", round: state.round, status: state.status };
  }

  assertIdle(runtime);

  try {
    if (state.acted.length === 0) {
      options.onRoundStart?.(state.round);
    }

    let ownerId = getNextNightUnit(runtime, state);

    while (!ownerId && state.status === "running") {
      endRound(runtime, state, options);
      ownerId = getNextNightUnit(runtime, state);
    }

    if (state.status !== "running") {
      return { kind: "finished", round: state.round, status: state.status };
    }

    if (!ownerId) {
      throw new Error("В текущем раунде отсутствует следующий участник");
    }

    const context: NightTurnContext = { ownerId, round: state.round, turn: state.turnsTaken + 1 };
    const getOptions = (id: string): InteractionOptions => ({
      knownEnemyIds: runtime.world.units
        .filter(
          (unit) =>
            unit.alive &&
            unit.side === "enemy" &&
            unit.position &&
            getCell(runtime.world.map, unit.position)?.area === "inside",
        )
        .map((unit) => unit.id),
      ...(options.getOptions?.(id) ?? runtime.trapDiscovery?.getOptions?.(id) ?? {}),
    });
    const controlled: NightRuntime = {
      ...runtime,
      trapDiscovery: {
        rng,
        getOptions,
        onOutcome: (outcome) => runtime.trapDiscovery?.onOutcome?.(outcome),
      },
    };
    state.acted.push(ownerId);
    const result = runAutomaticTurn(controlled, ownerId, () => state.order, damage, rng, {
      ...options.createTurnOptions?.(context),
      getOptions: () => getOptions(ownerId),
    });
    state.turnsTaken += 1;
    const turn: NightTurn = { ...context, result };
    options.onTurn?.(turn);

    if (!getNextNightUnit(runtime, state)) {
      endRound(runtime, state, options);
    }

    return { kind: "turn", turn, status: state.status };
  } catch (error) {
    state.failed = true;
    throw error;
  }
}

export function runNight(
  runtime: NightRuntime,
  state: NightState,
  damage: DamageState,
  rng: NightRng,
  options: NightOptions = {},
): NightState {
  if (state.failed) {
    throw new Error("Нельзя продолжать ночь после ошибки исполнения");
  }

  while (state.status === "running") {
    stepNight(runtime, state, damage, rng, options);
  }

  return state;
}
