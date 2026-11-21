// Roles: resolving a stored role key, what a role allows, its label and its summary (spec 02 §8.1
// to §8.3). A role Fin does not know, or one that no longer exists, allows nothing.
import { isPermission, sortPermissions } from "./permissions.ts";
import type {
  BuiltInRole,
  Catalogue,
  CustomRoleRecord,
  PermissionDef,
  RoleLookup,
  RoleRef,
} from "./types.ts";

/** What a membership whose role Fin does not know shows as (spec 02 §9.2's "No access" rows). */
export const NO_ACCESS_LABEL = "No access";

/** The summary sentence of a role that allows nothing. */
export const NOTHING_YET = "Can't do anything yet.";

// IDs are `<prefix>_<26 Crockford base32 characters>` (DECISIONS DA-02).
const CROCKFORD_26 = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** The built-in role with this key, if there is one. */
export function builtInRole<P extends string, R extends string>(
  cat: Catalogue<P, R>,
  key: string,
): BuiltInRole<P, R> | undefined {
  return cat.builtIns.find((role) => role.key === key);
}

/** Whether `key` is one of the catalogue's built-in role keys. */
export function isBuiltInKey<P extends string, R extends string>(
  cat: Catalogue<P, R>,
  key: string,
): key is R {
  return builtInRole(cat, key) !== undefined;
}

/** Whether `key` has the shape of one of the realm's custom role IDs (`rol_...` or `srl_...`). */
export function isCustomRoleId(cat: Catalogue, key: string): boolean {
  const prefix = `${cat.customRolePrefix}_`;
  return key.startsWith(prefix) && CROCKFORD_26.test(key.slice(prefix.length));
}

/**
 * Resolves a stored role key (a member's or an invitation's): a built-in key, or a custom role ID
 * looked up with `findCustom`. A custom ID with no row is `gone`; anything else is `unknown`.
 */
export function resolveRole<P extends string, R extends string>(
  cat: Catalogue<P, R>,
  roleKey: string,
  findCustom: (id: string) => CustomRoleRecord | undefined,
): RoleLookup<R> {
  if (isBuiltInKey(cat, roleKey)) return { kind: "built_in", key: roleKey };
  if (!isCustomRoleId(cat, roleKey)) return "unknown";
  const record = findCustom(roleKey);
  if (record === undefined || record.id !== roleKey) return "gone";
  return {
    kind: "custom",
    id: record.id,
    name: record.name,
    description: record.description,
    permissions: [...record.permissions],
  };
}

/** The key a role is stored under: a built-in's key or a custom role's ID. */
export function roleKeyOf(role: RoleRef): string {
  return role.kind === "built_in" ? role.key : role.id;
}

/** Whether two lookups name the same role. `gone` and `unknown` name no role, so never match. */
export function sameRole(a: RoleLookup, b: RoleLookup): boolean {
  if (typeof a === "string" || typeof b === "string") return false;
  return a.kind === b.kind && roleKeyOf(a) === roleKeyOf(b);
}

/** Whether the lookup is the realm's top role (`super_admin`, or staff `admin`). */
export function isTopRole(cat: Catalogue, role: RoleLookup): boolean {
  return typeof role !== "string" && role.kind === "built_in" && role.key === cat.topRoleKey;
}

/**
 * What a role allows. A built-in role holds its row's set. A custom role holds the stored names
 * the catalogue knows, minus the restricted ones, minus any whose needs it does not also hold
 * (after the others are removed), so a stored row that breaks a rule allows less, never more.
 * `gone` and `unknown` allow nothing.
 */
export function permissionsOf<P extends string>(
  cat: Catalogue<P>,
  role: RoleLookup,
): ReadonlySet<P> {
  if (typeof role === "string") return new Set();
  if (role.kind === "built_in") {
    const row = builtInRole(cat, role.key);
    if (row === undefined) return new Set();
    return new Set(row.holds === "all" ? cat.keys : row.holds);
  }
  const held = new Set<P>();
  for (const name of role.permissions) {
    if (isPermission(cat, name) && !cat.permissions[name].restricted) held.add(name);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of held) {
      if (cat.closure[key].some((need) => !held.has(need))) {
        held.delete(key);
        changed = true;
      }
    }
  }
  return new Set(sortPermissions(cat, held));
}

/** The role's label: a built-in's label or a custom role's name; "No access" for no role. */
export function roleLabel(cat: Catalogue, role: RoleLookup): string {
  if (typeof role === "string") return NO_ACCESS_LABEL;
  if (role.kind === "custom") return role.name;
  return builtInRole(cat, role.key)?.label ?? NO_ACCESS_LABEL;
}

/** A permission's label, for audit sentences and the role editor. */
export function permissionLabel<P extends string>(cat: Catalogue<P>, key: NoInfer<P>): string {
  return isPermission(cat, key) ? cat.permissions[key].label : "";
}

/** "a", "a and b", "a, b and c". */
export function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/**
 * The generated summary sentence for a set of permissions (spec 02 §8.2): first what the role can
 * see, then what else it can do, in catalogue order; then what it cannot change, for each group
 * with a "can't" phrase whose other permissions it holds none of. "Can't do anything yet." for none.
 */
export function describePermissions<P extends string>(
  cat: Catalogue<P>,
  perms: Iterable<NoInfer<P>>,
): string {
  const held = sortPermissions(cat, perms);
  if (held.length === 0) return NOTHING_YET;
  const defs: PermissionDef<P>[] = held.map((key) => cat.permissions[key]);
  const covered = new Set<string>();
  for (const def of defs) {
    if ("does" in def.summary && def.summary.covers !== undefined) covered.add(def.summary.covers);
  }
  const seen: string[] = [];
  const does: string[] = [];
  for (const def of defs) {
    if ("see" in def.summary) {
      if (!covered.has(def.key)) seen.push(def.summary.see);
    } else {
      does.push(def.summary.does);
    }
  }
  const clauses = [...(seen.length > 0 ? [`see ${listInWords(seen)}`] : []), ...does];
  const heldSet = new Set<string>(held);
  const cant: string[] = [];
  for (const group of cat.groups) {
    if (group.cant === undefined) continue;
    const changes = group.permissions.filter((key) => !("see" in cat.permissions[key].summary));
    if (!changes.some((key) => heldSet.has(key))) cant.push(group.cant);
  }
  const sentences = [
    ...(clauses.length > 0 ? [`Can ${listInWords(clauses)}.`] : []),
    ...(cant.length > 0 ? [`Can't ${listInWords(cant)}.`] : []),
  ];
  return sentences.join(" ");
}

/** A role's summary: a built-in's own; a custom role's description, or the generated sentence. */
export function summary<P extends string>(cat: Catalogue<P>, role: RoleLookup): string {
  if (typeof role === "string") return NOTHING_YET;
  if (role.kind === "built_in") return builtInRole(cat, role.key)?.summary ?? NOTHING_YET;
  if (role.description.trim() !== "") return role.description;
  return describePermissions(cat, permissionsOf(cat, role));
}
