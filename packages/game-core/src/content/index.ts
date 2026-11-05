import { EFFECT_PHASES } from "../effects";
import type { EffectTemplate } from "../operations";
import type { EntityTemplate } from "../summoning";
import type { ContentOperation, ContentPack, ContentOpening } from "./model";
import {
  ContentValidationError,
  STATS,
  array,
  choice,
  copyContentJson,
  durability,
  instance,
  integer,
  mask,
  numeric,
  object,
  selector,
  text,
} from "./validation";

export * from "./model";
export { ContentValidationError } from "./validation";

interface Reference {
  readonly id: string;
  readonly path: string;
  readonly kind: "effect" | "entity";
}

function amount(value: unknown, path: string, minimum = -Infinity): void {
  numeric(value, path);

  if (typeof value === "number") {
    integer(value, path, minimum);
  }
}

function operation(value: unknown, path: string): Reference[] {
  const op = object(value, path);
  const kind = choice(op.kind, `${path}.kind`, [
    "move_unit",
    "modify_stat",
    "modify_hp",
    "heal",
    "create_damage_event",
    "place_entity",
    "trigger_reaction",
    "add_damage_modifier",
    "add_effect",
    "remove_effect",
    "modify_counter",
    "interrupt_action",
    "interrupt_turn",
  ]);

  switch (kind) {
    case "modify_stat":
      object(value, path, ["kind", "target", "stat", "delta"]);
      selector(op.target, `${path}.target`);
      choice(
        op.stat,
        `${path}.stat`,
        STATS.filter((stat) => stat !== "hp"),
      );
      amount(op.delta, `${path}.delta`);
      break;
    case "modify_hp":
    case "heal": {
      const field = kind === "heal" ? "value" : "delta";
      object(value, path, ["kind", "target", field]);
      selector(op.target, `${path}.target`);
      amount(op[field], `${path}.${field}`, kind === "heal" ? 0 : -Infinity);
      break;
    }
    case "create_damage_event":
      object(value, path, ["kind", "target", "amount"]);
      selector(op.target, `${path}.target`, true);
      amount(op.amount, `${path}.amount`, 0);
      break;
    case "move_unit":
    case "interrupt_action":
    case "interrupt_turn":
      object(value, path, ["kind", "target"]);
      selector(op.target, `${path}.target`);
      break;
    case "trigger_reaction":
      object(value, path, ["kind", "target", "phase"]);
      selector(op.target, `${path}.target`);
      choice(op.phase, `${path}.phase`, [
        "ATTACK_SUCCESS",
        "ATTACK_FAILURE",
        "DEFENSE_SUCCESS",
        "DEFENSE_FAILURE",
      ]);
      break;
    case "add_effect":
    case "place_entity": {
      const field = kind === "add_effect" ? "effectId" : "definitionId";
      object(value, path, ["kind", "target", field]);
      selector(op.target, `${path}.target`, kind === "place_entity");
      return [
        {
          id: text(op[field], `${path}.${field}`),
          path: `${path}.${field}`,
          kind: kind === "add_effect" ? "effect" : "entity",
        },
      ];
    }
    case "remove_effect":
      object(value, path, ["kind", "instance"]);
      instance(op.instance, `${path}.instance`);
      break;
    case "modify_counter":
      object(value, path, ["kind", "instance", "name", "delta"]);
      instance(op.instance, `${path}.instance`);
      text(op.name, `${path}.name`);
      amount(op.delta, `${path}.delta`);
      break;
    case "add_damage_modifier": {
      object(value, path, ["kind", "event", "modifier"]);
      const event = object(op.event, `${path}.event`);
      const eventKind = choice(event.kind, `${path}.event.kind`, ["context_damage", "event"]);
      object(op.event, `${path}.event`, eventKind === "event" ? ["kind", "id"] : ["kind"]);

      if (eventKind === "event") {
        text(event.id, `${path}.event.id`);
      }

      const modifier = object(op.modifier, `${path}.modifier`, ["type", "value"]);
      choice(modifier.type, `${path}.modifier.type`, ["relative", "absolute"]);
      amount(modifier.value, `${path}.modifier.value`);
      break;
    }
  }

  return [];
}

/** Строгая загрузка каталога определений; не создаёт ID экземпляров и не меняет мир. */
export function loadContentPack(input: unknown): ContentPack {
  const copy = copyContentJson(input);
  const root = object(copy, "$", ["version", "id", "units", "traps", "openings", "effects"]);

  if (root.version !== 1) {
    throw new ContentValidationError("$.version", "поддерживается версия 1");
  }

  text(root.id, "$.id");
  const definitions = new Map<string, { kind: string; references: Reference[] }>();
  const effectRefs = (value: unknown, path: string): Reference[] =>
    array(value, path).map((id, index) => ({
      id: text(id, `${path}[${index}]`),
      path: `${path}[${index}]`,
      kind: "effect",
    }));

  for (const group of ["units", "traps", "openings", "effects"] as const) {
    for (const [index, value] of array(root[group], `$.${group}`).entries()) {
      const path = `$.${group}[${index}]`;
      const keys =
        group === "units"
          ? ["definitionId", "side", "stats", "attackMask", "keywords", "effectIds"]
          : group === "openings"
            ? ["definitionId", "kind", "interactionMask", "reinforcement", "effectIds"]
            : group === "effects"
              ? ["definitionId", "phase", "operations", "state"]
              : ["definitionId", "effectIds"];
      const definition = object(value, path, keys);
      const id = text(definition.definitionId, `${path}.definitionId`);

      if (id.startsWith("engine:")) {
        throw new ContentValidationError(`${path}.definitionId`, "engine: зарезервирован движком");
      }

      if (definitions.has(id)) {
        throw new ContentValidationError(`${path}.definitionId`, `повторный definitionId: ${id}`);
      }

      let references: Reference[];

      if (group === "effects") {
        choice(definition.phase, `${path}.phase`, EFFECT_PHASES);
        object(definition.state, `${path}.state`);
        references = array(definition.operations, `${path}.operations`).flatMap((op, i) =>
          operation(op, `${path}.operations[${i}]`),
        );
      } else {
        references = effectRefs(definition.effectIds, `${path}.effectIds`);

        if (group === "units") {
          choice(definition.side, `${path}.side`, ["defender", "enemy"]);
          durability(definition.stats, `${path}.stats`, true);
          mask(definition.attackMask, `${path}.attackMask`);
          array(definition.keywords, `${path}.keywords`).forEach((keyword, i) =>
            text(keyword, `${path}.keywords[${i}]`),
          );
        } else if (group === "openings") {
          choice(definition.kind, `${path}.kind`, ["door", "window"]);
          mask(definition.interactionMask, `${path}.interactionMask`);

          if (definition.reinforcement !== null) {
            durability(definition.reinforcement, `${path}.reinforcement`, false);
          }
        }
      }

      definitions.set(id, { kind: group, references });
    }
  }

  for (const definition of definitions.values()) {
    for (const ref of definition.references) {
      const target = definitions.get(ref.id);

      if (
        !target ||
        (ref.kind === "effect"
          ? target.kind !== "effects"
          : target.kind !== "units" && target.kind !== "traps")
      ) {
        throw new ContentValidationError(
          ref.path,
          `неизвестное определение ${ref.kind}: ${ref.id}`,
        );
      }
    }
  }

  // Текущий runtime хранит вложенные шаблоны inline: циклическое разворачивание невозможно.
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }

    active.add(id);

    for (const ref of definitions.get(id)!.references) {
      if (active.has(ref.id)) {
        throw new ContentValidationError(ref.path, "цикл вложенных шаблонов контента");
      }

      visit(ref.id);
    }

    active.delete(id);
    visited.add(id);
  };

  for (const id of definitions.keys()) {
    visit(id);
  }

  return copy as unknown as ContentPack;
}

export interface CompiledContentPack {
  readonly id: string;
  readonly entities: readonly EntityTemplate[];
  readonly effects: readonly EffectTemplate[];
  readonly openings: readonly (Omit<ContentOpening, "effectIds"> & {
    readonly effects: readonly EffectTemplate[];
  })[];
}

/** Ссылки превращаются в собственные inline-шаблоны существующего runtime. */
export function compileContentPack(input: unknown): CompiledContentPack {
  const pack = loadContentPack(input);
  const effect = (id: string): EffectTemplate => {
    const definition = pack.effects.find((entry) => entry.definitionId === id)!;
    return {
      definitionId: id,
      phase: definition.phase,
      state: copyContentJson(definition.state) as EffectTemplate["state"],
      operations: definition.operations.map(compileOperation),
    };
  };
  const entity = (id: string): EntityTemplate => {
    const unit = pack.units.find((entry) => entry.definitionId === id);
    const trap = pack.traps.find((entry) => entry.definitionId === id);

    return unit
      ? {
          definitionId: id,
          kind: "unit",
          side: unit.side,
          stats: { ...unit.stats },
          attackMask: copyContentJson(unit.attackMask) as unknown as typeof unit.attackMask,
          keywords: [...unit.keywords],
          effects: unit.effectIds.map(effect),
        }
      : { definitionId: id, kind: "trap", effects: trap!.effectIds.map(effect) };
  };
  const compileOperation = (op: ContentOperation): EffectTemplate["operations"][number] => {
    if (op.kind === "add_effect") {
      return { kind: "add_effect", target: { ...op.target }, effect: effect(op.effectId) };
    }

    if (op.kind === "place_entity") {
      return { kind: "place_entity", target: { ...op.target }, template: entity(op.definitionId) };
    }

    return copyContentJson(op) as unknown as typeof op;
  };

  return {
    id: pack.id,
    entities: [...pack.units, ...pack.traps].map((entry) => entity(entry.definitionId)),
    effects: pack.effects.map((entry) => effect(entry.definitionId)),
    openings: pack.openings.map(({ effectIds, ...opening }) => ({
      ...opening,
      effects: effectIds.map(effect),
    })),
  };
}
