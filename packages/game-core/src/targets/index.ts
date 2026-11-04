import { getCell } from "../world/index.js";
import type { Position, Structure, TrapState, UnitState, WorldState } from "../world/index.js";

export type PhaseContext =
  | { readonly kind: "phase"; readonly ownerId: string }
  | {
      readonly kind: "attack";
      readonly ownerId: string;
      readonly attackerId: string;
      readonly defenderId: string;
      readonly cell: Readonly<Position>;
    }
  | {
      readonly kind: "death" | "move_end";
      readonly ownerId: string;
      readonly cell: Readonly<Position>;
    };

export type TargetSelector =
  | { readonly kind: "owner" | "attacker" | "defender" | "cell" | "allies" | "enemies" }
  | { readonly kind: "unit"; readonly id: string };

export type EffectEntity = UnitState | TrapState | Structure;
export type TargetResolution =
  | { readonly kind: "entities"; readonly entities: readonly EffectEntity[] }
  | { readonly kind: "cell"; readonly position: Readonly<Position> }
  | {
      readonly kind: "unavailable";
      readonly reason: "missing_context" | "missing_entity" | "owner_has_no_side" | "invalid_cell";
    };

/** Вызывать в момент возникновения события/начала MOVE, а не при отложенном резолве. */
export function createPhaseContext(input: PhaseContext): PhaseContext {
  if (typeof input.ownerId !== "string" || input.ownerId.length === 0) {
    throw new TypeError("В контексте эффекта нужен ID владельца");
  }

  if (input.kind === "phase") {
    return Object.freeze({ ...input });
  }

  if (!Number.isInteger(input.cell.x) || !Number.isInteger(input.cell.y)) {
    throw new TypeError("Контекстная клетка должна иметь целые координаты");
  }

  return Object.freeze({ ...input, cell: Object.freeze({ ...input.cell }) });
}

function findEntity(world: WorldState, id: string): EffectEntity | undefined {
  const entity =
    world.units.find((unit) => unit.id === id) ?? world.traps.find((trap) => trap.id === id);

  if (entity) {
    return entity;
  }

  return world.map.cells.find((cell) => cell.structure?.id === id)?.structure ?? undefined;
}

/** Набор сущностей разрешается заново; семантическая клетка уже зафиксирована в контексте. */
export function resolveTargets(
  world: WorldState,
  context: PhaseContext,
  selector: TargetSelector,
  options: { readonly livingUnitsOnly?: boolean } = {},
): TargetResolution {
  if (selector.kind === "cell") {
    if (context.kind === "phase") {
      return { kind: "unavailable", reason: "missing_context" };
    }

    if (!getCell(world.map, context.cell)) {
      return { kind: "unavailable", reason: "invalid_cell" };
    }

    return { kind: "cell", position: { ...context.cell } };
  }

  let entities: EffectEntity[];

  if (selector.kind === "allies" || selector.kind === "enemies") {
    const owner = findEntity(world, context.ownerId);

    if (!owner) {
      return { kind: "unavailable", reason: "missing_entity" };
    }

    if (owner.kind !== "unit") {
      return { kind: "unavailable", reason: "owner_has_no_side" };
    }

    entities = world.units.filter(
      (unit) =>
        unit.position !== null &&
        (selector.kind === "allies" ? unit.side === owner.side : unit.side !== owner.side),
    );
  } else {
    let entity: EffectEntity | undefined;

    if (selector.kind === "unit") {
      entity = world.units.find((unit) => unit.id === selector.id);
    } else if (selector.kind === "owner") {
      entity = findEntity(world, context.ownerId);
    } else if (selector.kind === "attacker" || selector.kind === "defender") {
      if (context.kind !== "attack") {
        return { kind: "unavailable", reason: "missing_context" };
      }

      entity = findEntity(
        world,
        selector.kind === "attacker" ? context.attackerId : context.defenderId,
      );
    } else {
      throw new TypeError("Неизвестный селектор цели эффекта");
    }

    if (!entity) {
      return { kind: "unavailable", reason: "missing_entity" };
    }

    entities = [entity];
  }

  if (options.livingUnitsOnly) {
    entities = entities.filter((entity) => entity.kind === "unit" && entity.alive);
  }

  return { kind: "entities", entities };
}
