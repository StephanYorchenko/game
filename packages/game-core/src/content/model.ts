import type { EffectPhase, JsonObject } from "../effects";
import type { EngineOperation } from "../operations";
import type { TargetSelector } from "../targets";
import type { Durability, Mask5x5, UnitStats } from "../world";

export type ContentOperation =
  | Exclude<EngineOperation, { kind: "move_step" | "add_effect" | "place_entity" }>
  | { kind: "add_effect"; target: TargetSelector; effectId: string }
  | { kind: "place_entity"; target: { kind: "cell" }; definitionId: string };

export interface ContentEffect {
  definitionId: string;
  phase: EffectPhase;
  operations: ContentOperation[];
  state: JsonObject;
}

export interface ContentUnit {
  definitionId: string;
  side: "defender" | "enemy";
  stats: UnitStats;
  attackMask: Mask5x5;
  keywords: string[];
  effectIds: string[];
}

export interface ContentTrap {
  definitionId: string;
  effectIds: string[];
}

export interface ContentOpening {
  definitionId: string;
  kind: "door" | "window";
  interactionMask: Mask5x5;
  reinforcement: Durability | null;
  effectIds: string[];
}

export interface ContentPack {
  version: 1;
  id: string;
  units: ContentUnit[];
  traps: ContentTrap[];
  openings: ContentOpening[];
  effects: ContentEffect[];
}
