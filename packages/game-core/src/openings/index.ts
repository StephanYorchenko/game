import type { WorldState } from "../world";
import { checkOpeningInteraction } from "./eligibility";
import type { OpeningCheck, OpeningOptions } from "./eligibility";

export * from "./eligibility";
export * from "./targets";

/** Один синхронный INTERACT. Повторная проверка непосредственно перед изменением карты. */
export function openOpening(
  world: WorldState,
  actorId: string,
  openingId: string,
  options: OpeningOptions = {},
): OpeningCheck {
  const check = checkOpeningInteraction(world, actorId, openingId, options);

  if (check.allowed) {
    check.target.opening.state = "open";
  }

  return check;
}
