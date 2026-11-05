import { readFile } from "node:fs/promises";

const minimal = JSON.parse(
  await readFile(new URL("../content/minimal.json", import.meta.url), "utf8"),
);

export const adjacent = [
  [0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 1, 0, 1, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 0, 0],
];
export const owner = { kind: "owner" };
export const byId = (id) => ({ kind: "unit", id });
export const hp = (target, delta) => ({ kind: "modify_hp", target, delta });
export const speed = (target, delta) => ({ kind: "modify_stat", target, stat: "movement", delta });

export function fixture(width, height = 1, seed = 34) {
  return {
    seed,
    content: structuredClone(minimal),
    scenario: {
      world: {
        version: 1,
        map: {
          width,
          height,
          cells: Array.from({ length: width * height }, () => ({
            surface: "floor",
            area: "inside",
            structure: null,
          })),
        },
        units: [],
        traps: [],
      },
      openings: [],
    },
  };
}

export function addUnit(input, { id, side = "defender", x, y = 0, stats = {} }) {
  const definition = {
    definitionId: "unit:" + id,
    side,
    stats: {
      hp: 20,
      maxHP: 20,
      strength: 1,
      agility: side === "defender" ? 100 : 0,
      damage: 0,
      movement: 0,
      resistance: 0,
      ...stats,
    },
    attackMask: structuredClone(adjacent),
    keywords: [],
    effectIds: [],
  };
  input.content.units.push(definition);
  const { effectIds, ...fields } = structuredClone(definition);
  const unit = { id, kind: "unit", alive: true, position: { x, y }, ...fields };
  input.scenario.world.units.push(unit);
  return unit;
}

export function addOpening(
  input,
  { id, x, y = 0, kind = "door", reinforcement = null, mask = adjacent },
) {
  const definition = {
    definitionId: "opening:" + id,
    kind,
    interactionMask: structuredClone(mask),
    reinforcement,
    effectIds: [],
  };
  input.content.openings.push(structuredClone(definition));
  input.scenario.openings.push({ id, definitionId: definition.definitionId });
  const { definitionId, effectIds, ...fields } = structuredClone(definition);
  const structure = { id, state: "closed", ...fields };
  cell(input, x, y).structure = structure;
  return structure;
}

export function addTrap(input, id, x, y = 0) {
  const definitionId = "trap:" + id;
  input.content.traps.push({ definitionId, effectIds: [] });
  input.scenario.world.traps.push({ id, kind: "trap", definitionId, position: { x, y } });
}

export function ability(input, id, definitionId, phase, operations, state = {}) {
  const entity =
    input.scenario.world.units.find((unit) => unit.id === id) ??
    input.scenario.world.traps.find((trap) => trap.id === id) ??
    input.scenario.openings.find((opening) => opening.id === id);
  const definition = [
    ...input.content.units,
    ...input.content.traps,
    ...input.content.openings,
  ].find((entry) => entry.definitionId === entity.definitionId);
  input.content.effects.push({ definitionId, phase, operations, state });
  definition.effectIds.push(definitionId);
}

export function cell(input, x, y = 0) {
  return input.scenario.world.map.cells[y * input.scenario.world.map.width + x];
}
export function unit(snapshot, id) {
  return snapshot.world.units.find((entry) => entry.id === id);
}
export function actions(events, ownerId) {
  return events
    .filter((entry) => entry.kind === "action" && entry.scope.ownerId === ownerId)
    .map((entry) => entry.data);
}
export function operations(events, definitionId) {
  return events
    .filter((entry) => entry.kind === "operation" && entry.data.definitionId === definitionId)
    .map((entry) => entry.data);
}
export function moves(events, ownerId) {
  return events
    .filter(
      (entry) =>
        entry.kind === "operation" &&
        entry.data.ownerId === ownerId &&
        entry.data.operation.kind === "move_step" &&
        entry.data.applied,
    )
    .map((entry) => entry.data.context.cell);
}
