// The assembled step-up action catalogue (IF-03). Listing an action twice throws when the
// catalogue is built, so two areas cannot claim one key.
import type { StepUpAction } from "../types.ts";
import { IDENTITY_ACTIONS } from "./identity.ts";

export function buildCatalogue(
  fragments: readonly (readonly StepUpAction[])[],
): ReadonlyMap<string, StepUpAction> {
  const map = new Map<string, StepUpAction>();
  for (const fragment of fragments) {
    for (const action of fragment) {
      if (map.has(action.key)) throw new Error(`step-up action ${action.key} is listed twice`);
      if (!/^[a-z][a-zA-Z]*\.[a-z][a-z_]*$/.test(action.key)) {
        throw new Error(`step-up action ${action.key} has a bad key`);
      }
      map.set(action.key, action);
    }
  }
  return map;
}

export function stepUpCatalogue(
  extra: readonly (readonly StepUpAction[])[] = [],
): ReadonlyMap<string, StepUpAction> {
  return buildCatalogue([IDENTITY_ACTIONS, ...extra]);
}
