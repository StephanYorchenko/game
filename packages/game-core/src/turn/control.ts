export type TurnStage = "TURN_START" | "ACTION_START" | "action" | "ACTION_END" | "TURN_END";

export interface ActiveTurnControl {
  readonly ownerId: string;
  stage: TurnStage;
  slot: 1 | 2 | null;
  actionInterrupted: boolean;
  turnInterrupted: boolean;
}

export interface TurnControlState {
  readonly version: 1;
  active: ActiveTurnControl | null;
}

export function createTurnControl(): TurnControlState {
  return { version: 1, active: null };
}

/** Прерывается только уже исполняемый ход/слот; будущему владельцу флаг не сохраняется. */
export function interruptTurnExecution(
  state: TurnControlState | undefined,
  unitId: string,
  scope: "action" | "turn",
): boolean {
  const active = state?.active;

  if (!active || active.ownerId !== unitId || active.stage === "TURN_END") {
    return false;
  }

  if (scope === "turn") {
    active.turnInterrupted = true;
    return true;
  }

  if (active.stage !== "ACTION_START" && active.stage !== "action") {
    return false;
  }

  active.actionInterrupted = true;
  return true;
}

export function isActionInterrupted(state: TurnControlState | undefined, unitId: string): boolean {
  const active = state?.active;

  return active?.ownerId === unitId && (active.actionInterrupted || active.turnInterrupted);
}
