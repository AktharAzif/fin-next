// §8.7: what a role cannot open is hidden; what it cannot do is disabled with the reason.
import { describe, expect, it } from "vitest";
import {
  type DashboardPermission,
  dashboardCatalogue as dash,
} from "../catalogue/dashboard/index.ts";
import { type StaffPermission, staffCatalogue as staff } from "../catalogue/staff/index.ts";
import { permissionSet } from "./permissions.ts";
import { permissionsOf } from "./roles.ts";
import {
  allows,
  disabledReason,
  type Guarded,
  NOT_ALLOWED_REASON,
  visibleGroups,
  visibleItems,
} from "./visibility.ts";

// spec 06 §4.2's console tree, as packages/frame will write it.
interface Item extends Guarded<DashboardPermission> {
  readonly label: string;
}
const consoleTree: { label: string; items: Item[] }[] = [
  { label: "(top)", items: [{ label: "Home" }] },
  {
    label: "Money movement",
    items: [
      { label: "Customers", requires: { allOf: ["customers.read"] } },
      { label: "Virtual accounts", requires: { allOf: ["customers.read", "money.read"] } },
      { label: "Transfers", requires: { allOf: ["customers.read", "money.read"] } },
    ],
  },
  {
    label: "Developers",
    items: [
      { label: "API keys", requires: { allOf: ["apiKey.read"] } },
      { label: "Webhooks", requires: { allOf: ["webhooks.read"] } },
      { label: "Events", requires: { allOf: ["webhooks.read"] } },
      { label: "Simulator", requires: { allOf: ["simulator.use", "customers.read"] } },
    ],
  },
  {
    label: "footer",
    items: [{ label: "Audit log", requires: { allOf: ["auditLog.read"] } }, { label: "Settings" }],
  },
];

const labels = (groups: { label: string; items: { label: string }[] }[]) =>
  groups.map((g) => [g.label, g.items.map((i) => i.label)]);

describe("navigation hides what a role cannot open", () => {
  it("shows a Super admin everything", () => {
    const held = permissionsOf(dash, { kind: "built_in", key: "super_admin" });
    expect(visibleGroups(held, consoleTree).flatMap((g) => g.items)).toHaveLength(10);
  });

  it("drops the items, and then the groups, a read-only role cannot open", () => {
    const held = permissionSet(dash, ["customers.read", "member.read"]);
    expect(labels(visibleGroups(held, consoleTree))).toEqual([
      ["(top)", ["Home"]],
      ["Money movement", ["Customers"]],
      ["footer", ["Settings"]],
    ]);
  });

  it("needs every one of allOf", () => {
    const held = permissionSet(dash, ["simulator.use"]);
    expect(visibleItems(held, consoleTree[2]?.items ?? []).map((i) => i.label)).toEqual([]);
  });

  it("shows nothing guarded to a role Fin does not know", () => {
    const held = permissionsOf(dash, "unknown");
    expect(labels(visibleGroups(held, consoleTree))).toEqual([
      ["(top)", ["Home"]],
      ["footer", ["Settings"]],
    ]);
  });
});

describe("allows", () => {
  const held = permissionSet(staff, ["customers.read", "rfis.read"]);

  it("is always met without a requirement", () => {
    expect(allows<StaffPermission>(held, undefined)).toBe(true);
    expect(allows<StaffPermission>(held, {})).toBe(true);
  });

  it("needs all of allOf and one of anyOf", () => {
    expect(allows(held, { allOf: ["customers.read", "rfis.read"] })).toBe(true);
    expect(allows(held, { allOf: ["customers.read", "rfis.manage"] })).toBe(false);
    expect(allows(held, { anyOf: ["rfis.manage", "rfis.read"] })).toBe(true);
    expect(allows(held, { anyOf: ["rfis.manage"] })).toBe(false);
    expect(allows(held, { allOf: ["customers.read"], anyOf: ["forms.manage"] })).toBe(false);
  });

  it("fails closed on an empty anyOf", () => {
    expect(allows(held, { anyOf: [] })).toBe(false);
  });
});

describe("actions a role cannot take are disabled with the reason", () => {
  it("gives the spec's reason, or null", () => {
    expect(NOT_ALLOWED_REASON).toBe(
      "Your role doesn't allow this. Ask someone who can change roles.",
    );
    const viewer = permissionsOf(staff, { kind: "built_in", key: "viewer" });
    expect(disabledReason(viewer, { allOf: ["customers.decide"] })).toBe(NOT_ALLOWED_REASON);
    expect(disabledReason(viewer, { allOf: ["customers.read"] })).toBeNull();
    const compliance = permissionsOf(staff, { kind: "built_in", key: "compliance" });
    expect(disabledReason(compliance, { allOf: ["customers.decide"] })).toBeNull();
  });
});
