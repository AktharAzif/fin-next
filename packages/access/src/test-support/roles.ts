// Random roles for the property tests. Tests only.
import { withNeeds } from "../engine/permissions.ts";
import type { Catalogue, CustomRoleRecord, RoleLookup, RoleRef } from "../engine/types.ts";
import type { Seeded } from "./seeded.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A custom role ID of the realm's shape, from the generator. */
export function randomRoleId(rng: Seeded, cat: Catalogue): string {
  let body = "";
  for (let i = 0; i < 26; i += 1) body += CROCKFORD[rng.int(CROCKFORD.length)];
  return `${cat.customRolePrefix}_${body}`;
}

/**
 * A custom role's stored permissions. Most are closed under needs and free of restricted
 * permissions, as the editor saves them; some are raw subsets, as a damaged or hand-made row might
 * be, so the fail-closed reading is exercised too.
 */
export function randomStoredPermissions<P extends string>(rng: Seeded, cat: Catalogue<P>): P[] {
  const density = rng.pick([0.05, 0.2, 0.5, 0.85]);
  const picked = rng.subset(cat.keys, density);
  if (rng.chance(0.25)) return picked;
  const restricted = new Set<string>(cat.restricted);
  return [...withNeeds(cat, picked)].filter((key) => !restricted.has(key));
}

export function randomCustomRecord(rng: Seeded, cat: Catalogue): CustomRoleRecord {
  return {
    id: randomRoleId(rng, cat),
    name: `Role ${rng.int(1000)}`,
    description: "",
    permissions: randomStoredPermissions(rng, cat),
  };
}

/** A built-in role about a third of the time, otherwise a random custom role. */
export function randomRole<P extends string, R extends string>(
  rng: Seeded,
  cat: Catalogue<P, R>,
): RoleRef<R> {
  if (rng.chance(0.35)) return { kind: "built_in", key: rng.pick(cat.builtIns).key };
  return { kind: "custom", ...randomCustomRecord(rng, cat) };
}

/** A random role, or now and then a role that no longer exists or one Fin does not know. */
export function randomLookup<P extends string, R extends string>(
  rng: Seeded,
  cat: Catalogue<P, R>,
): RoleLookup<R> {
  const roll = rng.next();
  if (roll < 0.04) return "gone";
  if (roll < 0.08) return "unknown";
  return randomRole(rng, cat);
}
