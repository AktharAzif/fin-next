// T-SAT-08 (AC-SAT-01): for seeded random role pairs in both catalogues, givingProblem refuses
// every role holding a permission the actor lacks, the top role from anyone else, any change to
// one's own role, and any target outside the actor's permissions; and allows everything else.
// Then a model team: random actors take random team actions under the engine's rules, and the
// invariants of [SA-32] hold after every step.
import { describe, expect, it } from "vitest";
import { dashboardCatalogue as dash } from "../catalogue/dashboard/index.ts";
import { staffCatalogue as staff } from "../catalogue/staff/index.ts";
import {
  randomLookup,
  randomRole,
  randomRoleId,
  randomStoredPermissions,
} from "../test-support/roles.ts";
import { propertyRuns, propertySeeds, type Seeded, seeded } from "../test-support/seeded.ts";
import {
  actingProblem,
  deletionProblem,
  editingProblem,
  givingProblem,
  lastTopRoleProblem,
  outranks,
} from "./giving.ts";
import { missingNeed, withNeeds } from "./permissions.ts";
import { validateRole } from "./role-editor.ts";
import { permissionsOf, resolveRole, roleKeyOf } from "./roles.ts";
import type { Catalogue, CustomRoleRecord, GivingProblem, RoleLookup } from "./types.ts";

const catalogues: [string, Catalogue][] = [
  ["dashboard", dash],
  ["staff", staff],
];

const within = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].every((k) => b.has(k));
const isTop = (cat: Catalogue, role: RoleLookup | undefined) =>
  typeof role === "object" && role.kind === "built_in" && role.key === cat.topRoleKey;
const same = (a: RoleLookup | undefined, b: RoleLookup) =>
  typeof a === "object" &&
  typeof b === "object" &&
  a.kind === b.kind &&
  (a.kind === "built_in" ? a.key : a.id) === (b.kind === "built_in" ? b.key : b.id);

describe.each(catalogues)("T-SAT-08: givingProblem over random role pairs (%s)", (_realm, cat) => {
  const runs = propertyRuns(3000);
  for (const seed of propertySeeds()) {
    it(`refuses exactly what §8.5 refuses, in its order, for ${runs} cases (seed ${seed})`, () => {
      const rng = seeded(seed);
      const seen = new Map<GivingProblem | null, number>();
      for (let run = 0; run < runs; run += 1) {
        const actorRole = randomRole(rng, cat);
        const actorPerms = permissionsOf(cat, actorRole);
        const actorRoleKey = roleKeyOf(actorRole);
        const targetIsSelf = rng.chance(0.12);
        const current: RoleLookup | undefined = targetIsSelf
          ? actorRole
          : rng.chance(0.2)
            ? undefined
            : randomLookup(rng, cat);
        const roll = rng.next();
        const newRole: RoleLookup =
          roll < 0.1 && current !== undefined
            ? current
            : roll < 0.2
              ? actorRole
              : roll < 0.3
                ? { kind: "built_in", key: cat.topRoleKey }
                : randomLookup(rng, cat);

        const result = givingProblem(cat, {
          actorRoleKey,
          actorPerms,
          targetIsSelf,
          ...(current === undefined ? {} : { targetCurrentRole: current }),
          newRole,
        });
        seen.set(result, (seen.get(result) ?? 0) + 1);

        const newPerms = permissionsOf(cat, newRole);
        const currentPerms =
          current === undefined ? new Set<string>() : permissionsOf(cat, current);
        const beyond = !within(newPerms, actorPerms);
        const topOnly = isTop(cat, newRole) && actorRoleKey !== cat.topRoleKey;
        const outranked = current !== undefined && !within(currentPerms, actorPerms);
        const order: [GivingProblem, boolean][] = [
          ["unknown_role", newRole === "unknown"],
          ["gone", newRole === "gone"],
          ["self", targetIsSelf],
          ["top_only", topOnly],
          ["beyond", beyond],
          ["outranked", outranked],
          ["unchanged", same(current, newRole)],
        ];
        const expected = order.find(([, applies]) => applies)?.[0] ?? null;
        const at = `seed ${seed}, run ${run}: ${JSON.stringify({ actorRole, current, newRole, targetIsSelf })}`;
        expect(result, at).toBe(expected);
        // The four refusals AC-SAT-01 names, stated on their own.
        if (beyond) expect(result, at).not.toBeNull();
        if (topOnly) expect(result, at).not.toBeNull();
        if (targetIsSelf) expect(result, at).not.toBeNull();
        if (outranked) expect(result, at).not.toBeNull();
        // Whatever passes gives nothing beyond the actor, to someone within the actor.
        if (result === null) {
          expect(within(newPerms, actorPerms), at).toBe(true);
          expect(within(currentPerms, actorPerms), at).toBe(true);
        }
      }
      // The generator reaches every answer, so none of the checks above is vacuous.
      for (const answer of [
        null,
        "unknown_role",
        "gone",
        "self",
        "top_only",
        "beyond",
        "outranked",
        "unchanged",
      ] as const) {
        expect(seen.get(answer) ?? 0, `${String(answer)} never came up`).toBeGreaterThan(0);
      }
    });
  }
});

describe.each(catalogues)(
  "actingProblem and the last top role over random pairs (%s)",
  (_realm, cat) => {
    const runs = propertyRuns(2000);
    for (const seed of propertySeeds()) {
      it(`refuses self and outranked targets and the last top holder (seed ${seed})`, () => {
        const rng = seeded(seed);
        for (let run = 0; run < runs; run += 1) {
          const actorRole = randomRole(rng, cat);
          const actorPerms = permissionsOf(cat, actorRole);
          const targetIsSelf = rng.chance(0.15);
          const targetRole = targetIsSelf ? actorRole : randomLookup(rng, cat);
          const at = `seed ${seed}, run ${run}`;
          const targetPerms = permissionsOf(cat, targetRole);
          const expected = targetIsSelf
            ? "self"
            : within(targetPerms, actorPerms)
              ? null
              : "outranked";
          expect(actingProblem(cat, { actorPerms, targetIsSelf, targetRole }), at).toBe(expected);
          expect(outranks(cat, targetPerms, actorPerms), at).toBe(!within(targetPerms, actorPerms));

          // Now and then a count that is not a whole number, as a slip reading it might give.
          const otherTopHolders = rng.chance(0.1)
            ? rng.pick([Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY])
            : rng.int(4);
          const change = rng.pick([
            "remove",
            "reset",
            { newRole: randomLookup(rng, cat) },
          ] as const);
          const leavesTop = typeof change === "string" || !isTop(cat, change.newRole);
          const someoneElse = Number.isInteger(otherTopHolders) && otherTopHolders >= 1;
          const last = isTop(cat, targetRole) && leavesTop && !someoneElse;
          expect(lastTopRoleProblem(cat, { targetRole, change, otherTopHolders }), at).toBe(
            last ? "last_top_role" : null,
          );
        }
      });
    }
  },
);

// The model team. Each member holds one role key; custom roles live in a table the model edits.
interface Member {
  readonly id: number;
  roleKey: string;
  /** Staff only: false when just added or reset (pending, holding nothing), until they enrol. */
  active: boolean;
}

interface World {
  readonly cat: Catalogue;
  readonly roles: Map<string, CustomRoleRecord>;
  members: Member[];
  nextId: number;
}

const realmRules = {
  dashboard: {
    change: "member.role",
    remove: "member.invite",
    add: "member.invite",
    reset: undefined,
    manageRoles: "role.manage",
  },
  staff: {
    change: "staff.role",
    remove: "staff.remove",
    add: "staff.add",
    reset: "staff.reset_factors",
    manageRoles: "staffRoles.manage",
  },
} as const;

function lookup(world: World, roleKey: string): RoleLookup {
  return resolveRole(world.cat, roleKey, (id) => world.roles.get(id));
}

function permsOf(world: World, member: Member): ReadonlySet<string> {
  return member.active ? permissionsOf(world.cat, lookup(world, member.roleKey)) : new Set();
}

/** The members counted as holding the top role: every Super admin, or every active staff Admin. */
function topHolders(world: World): Member[] {
  return world.members.filter((m) => m.active && m.roleKey === world.cat.topRoleKey);
}

/** What the caller counts for lastTopRoleProblem: the counted holders other than the target. */
function otherTopHolders(world: World, target: Member): number {
  return topHolders(world).filter((m) => m.id !== target.id).length;
}

function newWorld(rng: Seeded, cat: Catalogue): World {
  const world: World = { cat, roles: new Map(), members: [], nextId: 0 };
  for (let i = 0; i < 4; i += 1) {
    const id = randomRoleId(rng, cat);
    world.roles.set(id, {
      id,
      name: `Role ${i}`,
      description: "",
      permissions: randomStoredPermissions(rng, cat),
    });
  }
  world.members.push({ id: world.nextId++, roleKey: cat.topRoleKey, active: true });
  const keys = [...cat.builtIns.map((r) => r.key), ...world.roles.keys()];
  for (let i = 0; i < 5; i += 1) {
    // Now and then a "No access" member, whose role key Fin does not know.
    const roleKey = rng.chance(0.1) ? "owner" : rng.pick(keys);
    world.members.push({ id: world.nextId++, roleKey, active: true });
  }
  return world;
}

function randomRoleKey(rng: Seeded, world: World): string {
  const keys = [...world.cat.builtIns.map((r) => r.key), ...world.roles.keys()];
  if (rng.chance(0.03)) return randomRoleId(rng, world.cat);
  if (rng.chance(0.02)) return "owner";
  return rng.pick(keys);
}

function step(rng: Seeded, world: World, applied: Map<string, number>, at: string): void {
  const { cat } = world;
  const rules = realmRules[cat.realm];
  const actor = rng.pick(world.members);
  const actorPerms = permsOf(world, actor);
  const actorWasTop = actor.active && actor.roleKey === cat.topRoleKey;
  const topBefore = new Set(topHolders(world).map((m) => m.id));
  const done = (kind: string) => applied.set(kind, (applied.get(kind) ?? 0) + 1);
  const action = rng.pick([
    "change",
    "change",
    "remove",
    "add",
    "reset",
    "enrol",
    "edit",
    "create",
    "delete",
  ]);

  if (action === "change" || action === "remove" || action === "reset") {
    const target = rng.pick(world.members);
    // The engine is called as its documentation says: the target's role as stored, pending or
    // not, and the counted holders other than the target.
    const targetRole = lookup(world, target.roleKey);
    const targetPerms = permsOf(world, target);
    const targetIsSelf = target.id === actor.id;
    const others = otherTopHolders(world, target);
    const pendingTop = !target.active && target.roleKey === cat.topRoleKey;
    if (action === "change") {
      if (!actorPerms.has(rules.change)) return;
      const newKey = randomRoleKey(rng, world);
      const newRole = lookup(world, newKey);
      const giving = givingProblem(cat, {
        actorRoleKey: actor.roleKey,
        actorPerms,
        targetIsSelf,
        targetCurrentRole: targetRole,
        newRole,
      });
      const last = lastTopRoleProblem(cat, {
        targetRole,
        change: { newRole },
        otherTopHolders: others,
      });
      if (giving !== null || last !== null) return;
      expect(targetIsSelf, at).toBe(false);
      expect(within(permissionsOf(cat, newRole), actorPerms), at).toBe(true);
      expect(within(permissionsOf(cat, targetRole), actorPerms), at).toBe(true);
      expect(within(targetPerms, actorPerms), at).toBe(true);
      target.roleKey = newKey;
      done("change");
      if (pendingTop) done("act on a pending top holder");
    } else {
      const permission = action === "remove" ? rules.remove : rules.reset;
      if (permission === undefined || !actorPerms.has(permission)) return;
      const acting = actingProblem(cat, { actorPerms, targetIsSelf, targetRole });
      const last = lastTopRoleProblem(cat, {
        targetRole,
        change: action,
        otherTopHolders: others,
      });
      if (acting !== null || last !== null) return;
      expect(targetIsSelf, at).toBe(false);
      expect(within(permissionsOf(cat, targetRole), actorPerms), at).toBe(true);
      expect(within(targetPerms, actorPerms), at).toBe(true);
      if (action === "remove") world.members = world.members.filter((m) => m.id !== target.id);
      else target.active = false;
      done(action);
      if (pendingTop) done("act on a pending top holder");
    }
  } else if (action === "add") {
    if (!actorPerms.has(rules.add)) return;
    const newKey = randomRoleKey(rng, world);
    const newRole = lookup(world, newKey);
    const giving = givingProblem(cat, {
      actorRoleKey: actor.roleKey,
      actorPerms,
      targetIsSelf: false,
      newRole,
    });
    if (giving !== null) return;
    expect(within(permissionsOf(cat, newRole), actorPerms), at).toBe(true);
    // A new staff member is pending until they enrol (spec 02 §10.2); an invitation accepted
    // makes an active member.
    world.members.push({ id: world.nextId++, roleKey: newKey, active: cat.realm !== "staff" });
    done("add");
  } else if (action === "enrol") {
    const pending = world.members.filter((m) => !m.active);
    if (pending.length === 0) return;
    rng.pick(pending).active = true;
    done("enrol");
  } else {
    if (!actorPerms.has(rules.manageRoles)) return;
    const draftPerms = [...withNeeds(cat, rng.subset([...actorPerms], 0.3))].filter(
      (key) => !cat.permissions[key]?.restricted,
    );
    if (action === "create") {
      if (world.roles.size >= 30) return;
      const name = `Made ${world.nextId++}`;
      const problems = validateRole(
        cat,
        { name, description: "", permissions: draftPerms },
        actorPerms,
        { takenNames: [...world.roles.values()].map((r) => r.name) },
      );
      if (problems.length > 0) return;
      const id = randomRoleId(rng, cat);
      world.roles.set(id, { id, name, description: "", permissions: draftPerms });
      done("create");
      return;
    }
    const ids = [...world.roles.keys()];
    if (ids.length === 0) return;
    const id = rng.pick(ids);
    const role = lookup(world, id);
    const before = permissionsOf(cat, role);
    if (action === "edit") {
      const record = world.roles.get(id) as CustomRoleRecord;
      const editing = editingProblem(cat, { actorRoleKey: actor.roleKey, actorPerms, role });
      const problems = validateRole(
        cat,
        { name: record.name, description: "", permissions: draftPerms },
        actorPerms,
      );
      if (editing !== null || problems.length > 0) return;
      expect(actor.roleKey === id, at).toBe(false);
      expect(within(before, actorPerms), at).toBe(true);
      world.roles.set(id, { ...record, permissions: draftPerms });
      done("edit");
    } else {
      const holders = world.members.filter((m) => m.roleKey === id);
      const moveKey = randomRoleKey(rng, world);
      const problem = deletionProblem(cat, {
        actorRoleKey: actor.roleKey,
        actorPerms,
        role,
        holders: holders.length,
        invitations: 0,
        moveTo: lookup(world, moveKey),
      });
      if (problem !== null) return;
      expect(within(before, actorPerms), at).toBe(true);
      if (holders.length > 0) {
        expect(actorPerms.has(cat.movePermission), at).toBe(true);
        expect(within(permissionsOf(cat, lookup(world, moveKey)), actorPerms), at).toBe(true);
      }
      for (const holder of holders) holder.roleKey = moveKey;
      world.roles.delete(id);
      done("delete");
    }
  }

  // The invariants, after every step that changed something. Each is checked in plain code and
  // the step asserts once that none is broken: an expect for every member, restricted key and
  // role permission came to about 90,000 of them for each seed and catalogue.
  const broken: string[] = [];
  const topAfter = new Set(topHolders(world).map((m) => m.id));
  if (topAfter.size < 1) broken.push("the last top holder was lost");
  const lostTop = [...topBefore].some((id) => !topAfter.has(id));
  if (lostTop && !actorWasTop) broken.push("a non-top actor removed a top holder");
  for (const member of world.members) {
    if (lookup(world, member.roleKey) === "gone") {
      broken.push(`member ${member.id}'s role vanished`);
    }
    const perms = permsOf(world, member);
    const missing = missingNeed(cat, perms);
    if (missing.length > 0)
      broken.push(`member ${member.id} lacks needs: ${JSON.stringify(missing)}`);
    if (member.roleKey !== cat.topRoleKey) {
      for (const key of cat.restricted) {
        if (perms.has(key)) broken.push(`${key} below the top (member ${member.id})`);
      }
    }
  }
  for (const record of world.roles.values()) {
    for (const key of permissionsOf(cat, lookup(world, record.id))) {
      if (cat.permissions[key]?.restricted !== false) {
        broken.push(`role ${record.id} holds ${key}, which is restricted or unknown`);
      }
    }
  }
  expect(broken, at).toEqual([]);
}

describe.each(catalogues)("a model team under the rules of [SA-32] (%s)", (_realm, cat) => {
  const worlds = propertyRuns(40);
  for (const seed of propertySeeds()) {
    it(`keeps a top holder, and nobody acts on or gives beyond themselves (seed ${seed})`, () => {
      const rng = seeded(seed);
      const applied = new Map<string, number>();
      for (let w = 0; w < worlds; w += 1) {
        const world = newWorld(rng, cat);
        for (let s = 0; s < 150; s += 1)
          step(rng, world, applied, `seed ${seed}, world ${w}, step ${s}`);
      }
      const kinds = ["change", "remove", "add", "edit", "create", "delete"];
      if (cat.realm === "staff") kinds.push("reset", "enrol", "act on a pending top holder");
      for (const kind of kinds) {
        expect(applied.get(kind) ?? 0, `no ${kind} was ever applied`).toBeGreaterThan(0);
      }
    });
  }
});
