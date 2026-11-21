// Which attack profiles a change maps to (spec 07 §2.7): every profile whose globs match one of its
// tier S paths; a tier S path that no other profile maps gets `generic`.

import { matchesAny } from "../plan/glob.ts";
import { GENERIC_PROFILE } from "./procedure.ts";
import type { AttackProfile } from "./procedure.ts";

/** Profile ID to the tier S paths it maps, in the procedure's profile order. */
export function profilesFor(profiles: readonly AttackProfile[], sPaths: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, path: string): void => {
    const list = out.get(id);
    if (list === undefined) out.set(id, [path]);
    else if (!list.includes(path)) list.push(path);
  };
  for (const path of sPaths) {
    let mapped = false;
    for (const profile of profiles) {
      if (profile.id === GENERIC_PROFILE) continue;
      if (matchesAny(profile.globs, path)) {
        add(profile.id, path);
        mapped = true;
      }
    }
    if (!mapped) add(GENERIC_PROFILE, path);
  }
  const ordered = new Map<string, string[]>();
  for (const profile of profiles) {
    const paths = out.get(profile.id);
    if (paths !== undefined) ordered.set(profile.id, paths.sort());
  }
  return ordered;
}
