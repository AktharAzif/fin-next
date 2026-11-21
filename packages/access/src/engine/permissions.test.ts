// Permission checks and the needs graph: unit cases, then properties over seeded random sets in
// both catalogues.
import { describe, expect, it } from "vitest";
import { dashboardCatalogue as dash } from "../catalogue/dashboard/index.ts";
import { staffCatalogue as staff } from "../catalogue/staff/index.ts";
import { propertyRuns, propertySeeds, seeded } from "../test-support/seeded.ts";
import {
  can,
  canAll,
  canAny,
  dependentsOf,
  isPermission,
  isPrivileged,
  missingNeed,
  needsOf,
  permissionDiff,
  permissionSet,
  privilegeAdded,
  sortPermissions,
  tick,
  untick,
  withNeeds,
} from "./permissions.ts";
import type { Catalogue } from "./types.ts";

describe("isPermission and permissionSet", () => {
  it("know each catalogue's own permissions and nothing else", () => {
    expect(isPermission(dash, "customers.read")).toBe(true);
    expect(isPermission(dash, "staff.read")).toBe(false);
    expect(isPermission(staff, "staff.read")).toBe(true);
    expect(isPermission(staff, "apiKey.read")).toBe(false);
    expect(isPermission(dash, "Customers.Read")).toBe(false);
    expect(isPermission(dash, " customers.read")).toBe(false);
    expect(isPermission(dash, 42)).toBe(false);
    expect(isPermission(dash, undefined)).toBe(false);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "never takes the prototype key %s for a permission",
    (name) => {
      expect(isPermission(dash, name)).toBe(false);
      expect(isPermission(staff, name)).toBe(false);
      expect(permissionSet(dash, [name]).size).toBe(0);
    },
  );

  it("drops names it does not know, so they allow nothing", () => {
    const held = permissionSet(dash, ["customers.read", "customers.raed", "staff.read", ""]);
    expect([...held]).toEqual(["customers.read"]);
  });
});

describe("can, canAll and canAny", () => {
  const held = permissionSet(dash, ["customers.read", "money.read"]);

  it("check one permission by name", () => {
    expect(can(held, "customers.read")).toBe(true);
    expect(can(held, "customers.create")).toBe(false);
  });

  it("check every one, or any one", () => {
    expect(canAll(held, ["customers.read", "money.read"])).toBe(true);
    expect(canAll(held, ["customers.read", "money.transfer"])).toBe(false);
    // An empty list is a half-written requirement: met by nothing, even every permission.
    expect(canAll(held, [])).toBe(false);
    expect(canAll(new Set(dash.keys), [])).toBe(false);
    expect(canAny(held, ["money.transfer", "money.read"])).toBe(true);
    expect(canAny(held, ["money.transfer"])).toBe(false);
    expect(canAny(held, [])).toBe(false);
  });

  it("allow nothing to an empty set", () => {
    const none = permissionSet(dash, []);
    for (const key of dash.keys) expect(can(none, key)).toBe(false);
  });
});

describe("the needs graph", () => {
  it("gives each permission's transitive needs", () => {
    expect([...needsOf(dash, "sandbox.reset")]).toEqual(["customers.read", "simulator.use"]);
    expect([...needsOf(dash, "money.transfer")]).toEqual(["customers.read", "money.read"]);
    expect([...needsOf(dash, "customers.read")]).toEqual([]);
    expect([...needsOf(staff, "forms.manage")]).toEqual(["customers.read", "rfis.read"]);
    expect([...needsOf(staff, "accounts.recover")]).toEqual(["organisations.read"]);
  });

  it("gives each permission's transitive dependents, the editor's untick cascade", () => {
    expect([...dependentsOf(dash, "simulator.use")]).toEqual(["sandbox.reset"]);
    expect([...dependentsOf(dash, "money.read")]).toEqual([
      "money.beneficiaries",
      "money.transfer",
      "money.simulate",
    ]);
    expect([...dependentsOf(staff, "rfis.read")]).toEqual(["rfis.manage", "forms.manage"]);
    expect(dependentsOf(dash, "customers.read").has("sandbox.reset")).toBe(true);
  });

  it("answers an empty set for a name the catalogue does not know", () => {
    expect(needsOf(dash, "nope.read" as never).size).toBe(0);
    expect(dependentsOf(dash, "nope.read" as never).size).toBe(0);
  });

  it("ticks a permission with its needs and unticks it with its dependents", () => {
    expect([...tick(dash, [], "sandbox.reset")]).toEqual([
      "customers.read",
      "simulator.use",
      "sandbox.reset",
    ]);
    const all = withNeeds(dash, ["sandbox.reset", "money.transfer", "webhooks.read"]);
    expect([...untick(dash, all, "customers.read")]).toEqual(["webhooks.read"]);
    expect([...untick(dash, all, "money.transfer")]).toEqual([
      "customers.read",
      "simulator.use",
      "sandbox.reset",
      "money.read",
      "webhooks.read",
    ]);
  });

  it("names every held permission whose need is missing", () => {
    expect(missingNeed(dash, ["sandbox.reset", "member.read"])).toEqual([
      { permission: "sandbox.reset", needs: "customers.read" },
      { permission: "sandbox.reset", needs: "simulator.use" },
    ]);
    expect(missingNeed(dash, withNeeds(dash, ["sandbox.reset"]))).toEqual([]);
    expect(missingNeed(staff, ["forms.manage", "rfis.read"])).toEqual([
      { permission: "rfis.read", needs: "customers.read" },
      { permission: "forms.manage", needs: "customers.read" },
    ]);
  });

  it("sorts into catalogue order and drops unknown names", () => {
    expect(sortPermissions(dash, ["golive.edit", "customers.read", "nope.x" as never])).toEqual([
      "customers.read",
      "golive.edit",
    ]);
  });
});

describe("privilege", () => {
  it("is any privileged permission held ([SA-05])", () => {
    expect(isPrivileged(dash, ["customers.read", "webhooks.read"])).toBe(false);
    expect(isPrivileged(dash, ["customers.read", "member.invite"])).toBe(true);
    expect(isPrivileged(staff, staff.keys)).toBe(false);
  });

  it("is added when a change gains a privileged permission, not when it keeps or drops one", () => {
    expect(privilegeAdded(dash, ["member.read"], ["member.read", "member.role"])).toBe(true);
    expect(privilegeAdded(dash, ["member.read", "member.role"], ["member.read"])).toBe(false);
    expect(
      privilegeAdded(
        dash,
        ["member.role", "member.read"],
        ["member.role", "member.read", "customers.read"],
      ),
    ).toBe(false);
  });

  it("diffs what a change added and removed, in catalogue order", () => {
    expect(
      permissionDiff(dash, ["member.read", "golive.edit"], ["customers.read", "member.read"]),
    ).toEqual({ added: ["customers.read"], removed: ["golive.edit"] });
  });
});

describe.each([
  ["dashboard", dash as Catalogue],
  ["staff", staff as Catalogue],
])("properties of the %s needs graph", (_realm, cat) => {
  const runs = propertyRuns(400);
  for (const seed of propertySeeds()) {
    it(`hold for ${runs} random sets (seed ${seed})`, () => {
      const rng = seeded(seed);
      for (let run = 0; run < runs; run += 1) {
        const at = `seed ${seed}, run ${run}`;
        const picked = rng.subset(cat.keys, rng.pick([0.05, 0.2, 0.5]));
        const closed = withNeeds(cat, picked);
        // withNeeds adds only needs, misses none, and is idempotent.
        for (const key of picked) expect(closed.has(key), at).toBe(true);
        for (const key of closed) {
          const wanted = picked.includes(key) || picked.some((p) => needsOf(cat, p).has(key));
          expect(wanted, at).toBe(true);
        }
        expect(missingNeed(cat, closed), at).toEqual([]);
        expect([...withNeeds(cat, closed)], at).toEqual([...closed]);
        // missingNeed is empty exactly when the set is closed.
        expect(missingNeed(cat, picked).length === 0, at).toBe(
          closed.size === new Set(picked).size,
        );
        // Unticking keeps a set closed, and removes the key and its dependents only.
        const key = rng.pick(cat.keys);
        const after = untick(cat, closed, key);
        expect(missingNeed(cat, after), at).toEqual([]);
        expect(after.has(key), at).toBe(false);
        for (const kept of closed) {
          const gone = kept === key || dependentsOf(cat, key).has(kept);
          expect(after.has(kept), at).toBe(!gone);
        }
        // Ticking keeps a set closed and adds the key.
        const ticked = tick(cat, after, key);
        expect(ticked.has(key), at).toBe(true);
        expect(missingNeed(cat, ticked), at).toEqual([]);
        // needsOf and dependentsOf are inverse relations, and nothing needs itself.
        const other = rng.pick(cat.keys);
        expect(needsOf(cat, key).has(other), at).toBe(dependentsOf(cat, other).has(key));
        expect(needsOf(cat, key).has(key), at).toBe(false);
      }
    });
  }
});
