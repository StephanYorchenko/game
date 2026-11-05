import { compileContentPack, ContentValidationError } from "../content";
import type { CompiledContentPack } from "../content";
import { copyContentJson } from "../content/validation";
import { addEffect, createEffectStore } from "../effects";
import type { EffectStore } from "../effects";
import type { EngineOperation } from "../operations";
import { loadWorld, ScenarioValidationError } from "../world";
import type { WorldState } from "../world";

export class SimulationValidationError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "SimulationValidationError";
  }
}

export interface PreparedSimulation {
  readonly seed: number;
  readonly contentId: string;
  readonly world: WorldState;
  readonly effects: EffectStore<EngineOperation>;
}

export function copyData<T>(value: T): T {
  return copyContentJson(value) as unknown as T;
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SimulationValidationError(path, "ожидается объект");
  }

  const object = value as Record<string, unknown>;

  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) {
      throw new SimulationValidationError(`${path}.${key}`, "неизвестное поле");
    }
  }

  for (const key of keys) {
    if (!Object.hasOwn(object, key)) {
      throw new SimulationValidationError(`${path}.${key}`, "отсутствует обязательное поле");
    }
  }

  return object;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SimulationValidationError(path, "ожидается непустой ID");
  }

  return value;
}

export function prepareSimulation(input: unknown): PreparedSimulation {
  let copied: unknown;

  try {
    copied = copyContentJson(input);
  } catch (error) {
    if (error instanceof ContentValidationError) {
      throw new SimulationValidationError(error.path, error.message.slice(error.path.length + 2));
    }

    throw error;
  }

  const root = record(copied, "$", ["seed", "content", "scenario"]);
  const seed = root.seed;

  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed >= 0x1_0000_0000) {
    throw new SimulationValidationError("$.seed", "ожидается seed uint32");
  }

  let content: CompiledContentPack;

  try {
    content = compileContentPack(root.content);
  } catch (error) {
    if (error instanceof ContentValidationError) {
      throw new SimulationValidationError(
        "$.content" + error.path.slice(1),
        error.message.slice(error.path.length + 2),
      );
    }

    throw error;
  }

  const scenario = record(root.scenario, "$.scenario", ["world", "openings"]);
  let world: WorldState;

  try {
    world = loadWorld(scenario.world);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw new SimulationValidationError(
        "$.scenario.world" + error.path.slice(1),
        error.message.slice(error.path.length + 2),
      );
    }

    throw error;
  }

  const effects = createEffectStore<EngineOperation>();

  for (const group of ["units", "traps"] as const) {
    for (const [index, entity] of world[group].entries()) {
      const definition = content.entities.find(
        (entry) => entry.definitionId === entity.definitionId && entry.kind === entity.kind,
      );
      const path = `$.scenario.world.${group}[${index}]`;

      if (!definition) {
        throw new SimulationValidationError(
          `${path}.definitionId`,
          "неизвестное определение сущности",
        );
      }

      if (entity.kind === "unit" && entity.alive && entity.stats.hp === 0) {
        throw new SimulationValidationError(
          `${path}.stats.hp`,
          "ночь требует зафиксированной жизни/смерти",
        );
      }

      for (const effect of definition.effects) {
        addEffect(effects, { ...effect, ownerId: entity.id });
      }
    }
  }

  if (!Array.isArray(scenario.openings)) {
    throw new SimulationValidationError("$.scenario.openings", "ожидается массив связей проёмов");
  }

  const bindings = new Map<string, string>();
  const openings = world.map.cells.flatMap((cell, index) => {
    const opening = cell.structure;
    return opening?.kind === "door" || opening?.kind === "window" ? [{ opening, index }] : [];
  });

  for (const [index, value] of scenario.openings.entries()) {
    const path = `$.scenario.openings[${index}]`;
    const binding = record(value, path, ["id", "definitionId"]);
    const id = text(binding.id, `${path}.id`);
    const definitionId = text(binding.definitionId, `${path}.definitionId`);
    const target = openings.find(({ opening }) => opening.id === id);

    if (!target || bindings.has(id)) {
      throw new SimulationValidationError(`${path}.id`, "проём отсутствует или уже связан");
    }

    if (
      !content.openings.some(
        (entry) => entry.definitionId === definitionId && entry.kind === target.opening.kind,
      )
    ) {
      throw new SimulationValidationError(
        `${path}.definitionId`,
        "неизвестное определение этого вида проёма",
      );
    }

    bindings.set(id, definitionId);
  }

  for (const { opening, index } of openings) {
    const definitionId = bindings.get(opening.id);

    if (!definitionId) {
      throw new SimulationValidationError(
        "$.scenario.openings",
        `нет определения для проёма ${opening.id}`,
      );
    }

    if (opening.state === "closed" && opening.reinforcement?.hp === 0) {
      throw new SimulationValidationError(
        `$.scenario.world.map.cells[${index}].structure.reinforcement.hp`,
        "закрытое укрепление с HP=0 требует разрешения разрушения до старта ночи",
      );
    }

    const definition = content.openings.find((entry) => entry.definitionId === definitionId)!;

    for (const effect of definition.effects) {
      addEffect(effects, { ...effect, ownerId: opening.id });
    }
  }

  return { seed, contentId: content.id, world, effects };
}
