// Permission checks and the needs graph (spec 02 §8.1). Every check is by permission name, and
// anything unknown fails closed: a name the catalogue does not define is never held.
import type { Catalogue } from "./types.ts";

/** Whether `value` names one of the catalogue's permissions (never a prototype key). */
export function isPermission<P extends string>(cat: Catalogue<P>, value: unknown): value is P {
  return typeof value === "string" && Object.hasOwn(cat.permissions, value);
}

/**
 * The permissions among `values` the catalogue knows, for names read from a session, a viewer
 * answer or a table. Unknown names are dropped: they allow nothing.
 */
export function permissionSet<P extends string>(
  cat: Catalogue<P>,
  values: Iterable<string>,
): ReadonlySet<P> {
  const out = new Set<P>();
  for (const value of values) if (isPermission(cat, value)) out.add(value);
  return out;
}

/** Whether the held set allows `key`. The key must be one of the catalogue's permissions. */
export function can<P extends string>(held: ReadonlySet<P>, key: NoInfer<P>): boolean {
  return held.has(key);
}

/** Whether the held set allows every one of `keys` (a route's or a page's "and"). */
export function canAll<P extends string>(
  held: ReadonlySet<P>,
  keys: readonly NoInfer<P>[],
): boolean {
  return keys.every((key) => held.has(key));
}

/** Whether the held set allows at least one of `keys` (a route policy's `anyOf`). Empty: no. */
export function canAny<P extends string>(
  held: ReadonlySet<P>,
  keys: readonly NoInfer<P>[],
): boolean {
  return keys.some((key) => held.has(key));
}

/** The permissions `key` needs, transitively, in catalogue order. */
export function needsOf<P extends string>(cat: Catalogue<P>, key: NoInfer<P>): ReadonlySet<P> {
  return new Set(isPermission(cat, key) ? cat.closure[key] : []);
}

/** The permissions that need `key`, transitively, in catalogue order: the editor's untick cascade. */
export function dependentsOf<P extends string>(cat: Catalogue<P>, key: NoInfer<P>): ReadonlySet<P> {
  return new Set(isPermission(cat, key) ? cat.dependents[key] : []);
}

/** The given permissions in catalogue order, each once; unknown names are dropped. */
export function sortPermissions<P extends string>(
  cat: Catalogue<P>,
  perms: Iterable<NoInfer<P>>,
): P[] {
  const given = new Set<string>(perms);
  return cat.keys.filter((key) => given.has(key));
}

/** The given permissions with everything they need: the editor's auto-tick. */
export function withNeeds<P extends string>(
  cat: Catalogue<P>,
  perms: Iterable<NoInfer<P>>,
): Set<P> {
  const out = new Set<P>();
  for (const key of perms) {
    if (!isPermission(cat, key)) continue;
    out.add(key);
    for (const need of cat.closure[key]) out.add(need);
  }
  return new Set(sortPermissions(cat, out));
}

/** Every held permission whose need is not held, in catalogue order. */
export function missingNeed<P extends string>(
  cat: Catalogue<P>,
  perms: Iterable<NoInfer<P>>,
): { permission: P; needs: P }[] {
  const held = new Set<string>(perms);
  const out: { permission: P; needs: P }[] = [];
  for (const permission of cat.keys) {
    if (!held.has(permission)) continue;
    for (const needs of cat.closure[permission]) {
      if (!held.has(needs)) out.push({ permission, needs });
    }
  }
  return out;
}

/** The editor ticks `key`: it and everything it needs are added. */
export function tick<P extends string>(
  cat: Catalogue<P>,
  perms: Iterable<NoInfer<P>>,
  key: NoInfer<P>,
): Set<P> {
  return withNeeds(cat, [...perms, key]);
}

/** The editor unticks `key`: it and everything that needs it are removed. */
export function untick<P extends string>(
  cat: Catalogue<P>,
  perms: Iterable<NoInfer<P>>,
  key: NoInfer<P>,
): Set<P> {
  const removed = new Set<P>([key, ...dependentsOf(cat, key)]);
  return new Set(sortPermissions(cat, perms).filter((p) => !removed.has(p)));
}

/** Whether any of the permissions is privileged ([SA-05]; only the dashboard marks any). */
export function isPrivileged<P extends string>(
  cat: Catalogue<P>,
  perms: Iterable<NoInfer<P>>,
): boolean {
  for (const key of perms)
    if (isPermission(cat, key) && cat.permissions[key].privileged) return true;
  return false;
}

/** What a change of a role's permissions added and removed, in catalogue order (for its audit). */
export function permissionDiff<P extends string>(
  cat: Catalogue<P>,
  before: Iterable<NoInfer<P>>,
  after: Iterable<NoInfer<P>>,
): { added: P[]; removed: P[] } {
  const was = new Set(sortPermissions(cat, before));
  const now = new Set(sortPermissions(cat, after));
  return {
    added: [...now].filter((key) => !was.has(key)),
    removed: [...was].filter((key) => !now.has(key)),
  };
}

/** Whether a change adds a privileged permission, which puts holders without a factor on hold. */
export function privilegeAdded<P extends string>(
  cat: Catalogue<P>,
  before: Iterable<NoInfer<P>>,
  after: Iterable<NoInfer<P>>,
): boolean {
  return isPrivileged(cat, permissionDiff(cat, before, after).added);
}
