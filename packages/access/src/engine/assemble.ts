// Assembles a catalogue from its areas' fragments and checks it (spec 02 §8.1: "the assembled
// catalogue is built and checked, never edited by hand"). A catalogue that breaks a rule is refused
// when its module loads, so a bad fragment fails every test and every build that imports it.
import { hasInvisible, hasVisibleText } from "./text.ts";
import type {
  BuiltInRole,
  Catalogue,
  GroupSpec,
  PermissionDef,
  PermissionGroup,
  PermissionSpec,
  Realm,
  StepUpKind,
  SummaryPhrase,
} from "./types.ts";

type PermissionsIn<G extends readonly GroupSpec[]> = G[number]["permissions"][number];

/** The permission keys a list of fragments defines. */
export type KeysOf<G extends readonly GroupSpec[]> = PermissionsIn<G>["key"];

type NeedsIn<G extends readonly GroupSpec[]> = PermissionsIn<G>["needs"][number];
type CoversIn<G extends readonly GroupSpec[]> = Extract<
  PermissionsIn<G>["summary"],
  { readonly covers: string }
>["covers"];

/**
 * Refuses, at compile time, a fragment whose needs (or summary cover) name a permission no fragment
 * defines, so a typo in a need is a type error before it is a test failure.
 */
type KnownNames<G extends readonly GroupSpec[]> = [NeedsIn<G> | CoversIn<G>] extends [KeysOf<G>]
  ? unknown
  : {
      readonly "names a permission no fragment defines": Exclude<
        NeedsIn<G> | CoversIn<G>,
        KeysOf<G>
      >;
    };

export interface CatalogueInput<G extends readonly GroupSpec[], R extends string> {
  readonly realm: Realm;
  /** The areas' fragments, in the role editor's order. */
  readonly groups: G;
  readonly builtIns: readonly BuiltInRole<KeysOf<G>, R>[];
  readonly topRoleKey: NoInfer<R>;
  readonly customRolePrefix: string;
  readonly movePermission: NoInfer<KeysOf<G>>;
}

/** A catalogue that breaks one of the engine's rules. */
export class CatalogueError extends Error {
  override readonly name = "CatalogueError";
}

const STEP_UP_KINDS: ReadonlySet<StepUpKind> = new Set(["none", "window", "intent"]);
// `<area>.<action>`: a camel-case area and a lower-case action whose words one underscore joins.
const PERMISSION_KEY = /^[a-z][A-Za-z]*\.[a-z]+(?:_[a-z]+)*$/;
const GROUP_OR_ROLE_KEY = /^[a-z][a-z_]*$/;
const ROLE_PREFIX = /^[a-z]{3}$/;

/** Catalogue text that shows something: no space round it and no character that draws as nothing. */
const filled = (value: unknown): value is string =>
  typeof value === "string" &&
  hasVisibleText(value) &&
  !hasInvisible(value) &&
  value === value.trim();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * Builds a catalogue from its fragments and checks every structural rule: keys and labels present
 * and unique (permission keys also ignoring case; group, permission and built-in role labels
 * ignoring case, each among their own kind), needs known and acyclic, built-in roles closed under
 * needs, only the top role holding restricted permissions, and the top role holding everything.
 * Throws `CatalogueError` otherwise.
 */
export function assembleCatalogue<const G extends readonly GroupSpec[], const R extends string>(
  input: CatalogueInput<G, R> & { readonly groups: KnownNames<G> },
): Catalogue<KeysOf<G>, R> {
  return assemble(input as unknown as CatalogueInput<readonly GroupSpec[], string>) as Catalogue<
    KeysOf<G>,
    R
  >;
}

function assemble(input: CatalogueInput<readonly GroupSpec[], string>): Catalogue {
  const { realm } = input;
  const fail = (message: string): never => {
    throw new CatalogueError(`${String(realm)} catalogue: ${message}`);
  };
  if (realm !== "dashboard" && realm !== "staff") fail("the realm must be dashboard or staff");
  if (!ROLE_PREFIX.test(input.customRolePrefix)) {
    fail("the custom role prefix must be three lower-case letters");
  }
  if (input.groups.length === 0) fail("there are no groups");

  // Groups and permissions, in the editor's order. A label or key seen before is kept lower-cased
  // with what first had it, so a repeat in another case is refused too.
  const specs = new Map<string, PermissionSpec>();
  const groupOf = new Map<string, string>();
  const groupKeys = new Set<string>();
  const groupLabels = new Map<string, string>();
  const foldedKeys = new Map<string, string>();
  const groups: PermissionGroup[] = [];
  for (const group of input.groups) {
    if (!GROUP_OR_ROLE_KEY.test(group.key)) fail(`the group key "${group.key}" is malformed`);
    if (groupKeys.has(group.key)) fail(`the group "${group.key}" appears twice`);
    groupKeys.add(group.key);
    if (!filled(group.label)) fail(`the group "${group.key}" has no label`);
    const labelTwin = groupLabels.get(group.label.toLowerCase());
    if (labelTwin !== undefined)
      fail(`the group "${group.key}" repeats the label of "${labelTwin}"`);
    groupLabels.set(group.label.toLowerCase(), group.key);
    if (group.cant !== undefined && !filled(group.cant)) {
      fail(`the group "${group.key}" has an empty "can't" phrase`);
    }
    if (group.permissions.length === 0) fail(`the group "${group.key}" has no permissions`);
    for (const spec of group.permissions) {
      if (!PERMISSION_KEY.test(spec.key)) fail(`the permission key "${spec.key}" is malformed`);
      if (specs.has(spec.key)) fail(`the permission "${spec.key}" appears twice`);
      const caseTwin = foldedKeys.get(spec.key.toLowerCase());
      if (caseTwin !== undefined) {
        fail(`the permission "${spec.key}" differs from "${caseTwin}" only in case`);
      }
      foldedKeys.set(spec.key.toLowerCase(), spec.key);
      specs.set(spec.key, spec);
      groupOf.set(spec.key, group.key);
    }
    groups.push({
      key: group.key,
      label: group.label,
      ...(group.cant === undefined ? {} : { cant: group.cant }),
      permissions: group.permissions.map((p) => p.key),
    });
  }
  const keys = [...specs.keys()];
  const order = new Map(keys.map((key, index) => [key, index]));
  const sorted = (set: Iterable<string>) =>
    [...set].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  // Each permission's own fields.
  const permissionLabels = new Map<string, string>();
  for (const spec of specs.values()) {
    const at = `the permission "${spec.key}"`;
    if (!filled(spec.label)) fail(`${at} has no label`);
    const labelTwin = permissionLabels.get(spec.label.toLowerCase());
    if (labelTwin !== undefined) fail(`${at} repeats the label of "${labelTwin}"`);
    permissionLabels.set(spec.label.toLowerCase(), spec.key);
    if (!filled(spec.description)) fail(`${at} has no description`);
    if (!STEP_UP_KINDS.has(spec.stepUp)) fail(`${at} has an unknown step-up kind`);
    for (const flag of ["privileged", "sandboxOnly", "restricted"] as const) {
      if (typeof spec[flag] !== "boolean") fail(`${at}: "${flag}" must be true or false`);
    }
    if (realm === "staff" && spec.privileged) {
      fail(`${at} is marked privileged, which only the dashboard catalogue uses ([SA-05])`);
    }
    const needs = new Set<string>();
    for (const need of spec.needs) {
      if (need === spec.key) fail(`${at} needs itself`);
      if (!specs.has(need)) fail(`${at} needs "${need}", which no fragment defines`);
      if (needs.has(need)) fail(`${at} names the need "${need}" twice`);
      needs.add(need);
    }
    const phrase = spec.summary as SummaryPhrase;
    if ("see" in phrase) {
      if (!filled(phrase.see)) fail(`${at} has an empty summary phrase`);
    } else if (!filled(phrase.does)) {
      fail(`${at} has an empty summary phrase`);
    }
  }

  // Needs form no cycle.
  const state = new Map<string, "open" | "done">();
  const visit = (key: string, path: readonly string[]): void => {
    const seen = state.get(key);
    if (seen === "done") return;
    if (seen === "open") fail(`the needs form a cycle: ${[...path, key].join(" → ")}`);
    state.set(key, "open");
    for (const need of specs.get(key)?.needs ?? []) visit(need, [...path, key]);
    state.set(key, "done");
  };
  for (const key of keys) visit(key, []);

  // The transitive closure and its inverse.
  const closure = Object.create(null) as Record<string, readonly string[]>;
  const closureOf = (key: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...(specs.get(key)?.needs ?? [])];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (out.has(next)) continue;
      out.add(next);
      stack.push(...(specs.get(next)?.needs ?? []));
    }
    return out;
  };
  for (const key of keys) closure[key] = sorted(closureOf(key));
  const dependents = Object.create(null) as Record<string, readonly string[]>;
  for (const key of keys) {
    dependents[key] = keys.filter((other) => closure[other]?.includes(key) === true);
  }

  // A summary cover names a `see` permission the permission needs.
  for (const spec of specs.values()) {
    const phrase = spec.summary as SummaryPhrase;
    if (!("does" in phrase) || phrase.covers === undefined) continue;
    const covered = specs.get(phrase.covers);
    if (covered === undefined) fail(`"${spec.key}" covers "${phrase.covers}", which is unknown`);
    if (closure[spec.key]?.includes(phrase.covers) !== true) {
      fail(`"${spec.key}" covers "${phrase.covers}", which it does not need`);
    }
    if (covered !== undefined && !("see" in covered.summary)) {
      fail(`"${spec.key}" covers "${phrase.covers}", which is not a "see" permission`);
    }
  }

  const permissions = Object.create(null) as Record<string, PermissionDef>;
  for (const spec of specs.values()) {
    permissions[spec.key] = {
      key: spec.key,
      group: groupOf.get(spec.key) ?? "",
      label: spec.label,
      description: spec.description,
      needs: [...spec.needs],
      stepUp: spec.stepUp,
      privileged: spec.privileged,
      sandboxOnly: spec.sandboxOnly,
      restricted: spec.restricted,
      summary: { ...spec.summary },
    };
  }
  const restricted = keys.filter((key) => specs.get(key)?.restricted === true);

  // Built-in roles.
  if (input.builtIns.length === 0) fail("there are no built-in roles");
  if (!input.builtIns.some((role) => role.key === input.topRoleKey)) {
    fail(`the top role "${input.topRoleKey}" is not a built-in role`);
  }
  const roleKeys = new Set<string>();
  const roleLabels = new Set<string>();
  const builtIns: BuiltInRole[] = [];
  for (const role of input.builtIns) {
    const at = `the built-in role "${role.key}"`;
    if (!GROUP_OR_ROLE_KEY.test(role.key)) fail(`${at} has a malformed key`);
    if (role.key.startsWith(`${input.customRolePrefix}_`)) {
      fail(`${at} has a key that reads as a custom role's ID`);
    }
    if (roleKeys.has(role.key)) fail(`${at} appears twice`);
    roleKeys.add(role.key);
    if (!filled(role.label)) fail(`${at} has no label`);
    if (roleLabels.has(role.label.toLowerCase())) fail(`${at} repeats another role's label`);
    roleLabels.add(role.label.toLowerCase());
    if (!filled(role.summary)) fail(`${at} has no summary`);
    const holds = role.holds === "all" ? keys : role.holds;
    if (holds.length === 0) fail(`${at} holds nothing`);
    const held = new Set<string>();
    for (const key of holds) {
      if (!specs.has(key)) fail(`${at} holds "${key}", which no fragment defines`);
      if (held.has(key)) fail(`${at} holds "${key}" twice`);
      held.add(key);
    }
    for (const key of held) {
      for (const need of closure[key] ?? []) {
        if (!held.has(need)) fail(`${at} holds "${key}" but not its need "${need}"`);
      }
      if (role.key !== input.topRoleKey && specs.get(key)?.restricted === true) {
        fail(`${at} holds "${key}", which only the top role may hold`);
      }
    }
    builtIns.push({
      key: role.key,
      label: role.label,
      summary: role.summary,
      holds: role.holds === "all" ? "all" : sorted(held),
    });
  }
  const top = builtIns.find((role) => role.key === input.topRoleKey);
  if (top !== undefined && top.holds !== "all" && top.holds.length !== keys.length) {
    fail(`the top role "${input.topRoleKey}" must hold every permission`);
  }
  if (!specs.has(input.movePermission)) {
    fail(`the move permission "${input.movePermission}" is not in the catalogue`);
  }

  return deepFreeze({
    realm,
    groups,
    permissions,
    keys,
    closure,
    dependents,
    builtIns,
    topRoleKey: input.topRoleKey,
    restricted,
    customRolePrefix: input.customRolePrefix,
    movePermission: input.movePermission,
  });
}
