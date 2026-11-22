import { describe, expect, it } from "vitest";
import { adminNav } from "../src/nav/admin/index.ts";
import { consoleNav } from "../src/nav/console/index.ts";
import { allNavItems, filterNav } from "../src/nav/filter.ts";
import type { NavContext, NavTree } from "../src/nav/types.ts";

const everyRoute = () => true;
const ids = (tree: NavTree) => ({
  groups: tree.groups.map((group) => [group.label ?? null, group.items.map((item) => item.id)]),
  footer: tree.footer.map((item) => item.id),
});

// The roles of the canvases' cast (shell-v2 §2.2), by the permissions the sidebar reads.
const SUPER_ADMIN = null;
const COMPLIANCE = [
  "customers.read",
  "customers.restart",
  "money.read",
  "member.read",
  "auditLog.read",
  "golive.edit",
];
const BILLING = ["member.read", "auditLog.read"];

function context(permissions: string[] | null, overrides: Partial<NavContext> = {}): NavContext {
  return {
    can: (permission) => permissions === null || permissions.includes(permission),
    hasRoute: everyRoute,
    environment: "sandbox",
    docsOrigin: "https://docs.example.com",
    ...overrides,
  };
}

describe("the console's sidebar", () => {
  it("draws the full tree for a Super admin, in the canvas order", () => {
    expect(ids(filterNav(consoleNav, context(SUPER_ADMIN)))).toEqual({
      groups: [
        [null, ["home"]],
        ["Money movement", ["customers", "virtual-accounts", "transfers"]],
        ["Developers", ["api-keys", "webhooks", "events", "simulator"]],
      ],
      footer: ["audit-log", "settings", "api-docs"],
    });
  });

  it("leaves out what a role cannot open, and empty groups with it", () => {
    expect(ids(filterNav(consoleNav, context(COMPLIANCE)))).toEqual({
      groups: [
        [null, ["home"]],
        ["Money movement", ["customers", "virtual-accounts", "transfers"]],
      ],
      footer: ["audit-log", "settings", "api-docs"],
    });
    expect(ids(filterNav(consoleNav, context(BILLING)))).toEqual({
      groups: [[null, ["home"]]],
      footer: ["audit-log", "settings", "api-docs"],
    });
    expect(ids(filterNav(consoleNav, context([]))).footer).toEqual(["settings", "api-docs"]);
  });

  it("drops the Simulator in Production", () => {
    const tree = filterNav(consoleNav, context(SUPER_ADMIN, { environment: "production" }));
    expect(tree.groups.flatMap((group) => group.items.map((item) => item.id))).not.toContain(
      "simulator",
    );
  });

  it("shows an item only once its route exists (Saturday: Home, Audit log, Settings)", () => {
    const routes = new Set(["/", "/audit-log", "/settings/organisation"]);
    expect(
      ids(filterNav(consoleNav, context(SUPER_ADMIN, { hasRoute: (path) => routes.has(path) }))),
    ).toEqual({
      groups: [[null, ["home"]]],
      footer: ["audit-log", "settings", "api-docs"],
    });
  });

  it("points API docs at the docs origin, in a new tab", () => {
    const docs = filterNav(consoleNav, context(SUPER_ADMIN)).footer.find(
      (item) => item.id === "api-docs",
    );
    expect(docs).toEqual({
      id: "api-docs",
      label: "API docs",
      href: "https://docs.example.com/",
      glyph: "BookOpen",
      external: true,
    });
    const { docsOrigin: _docs, ...withoutDocs } = context(SUPER_ADMIN);
    const none = filterNav(consoleNav, withoutDocs);
    expect(none.footer.map((item) => item.id)).not.toContain("api-docs");
  });

  it("labels every item with its page title and gives every item a unique id", () => {
    const items = allNavItems(consoleNav);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items)
      expect(item.label).toMatch(/^[A-Z][a-z]*( [a-z]+)*$|^API (keys|docs)$/);
  });
});

describe("Fin Admin's sidebar", () => {
  it("draws the review lists and the Settings group for an Admin", () => {
    expect(ids(filterNav(adminNav, context(SUPER_ADMIN, { environment: "production" })))).toEqual({
      groups: [
        [null, ["golive", "approvals", "organisations", "customers", "rfis", "money", "audit"]],
        ["Settings", ["forms", "reasons", "staff", "switches"]],
      ],
      footer: [],
    });
  });

  it("shows Staff alone on Saturday (spec 02 §15.3)", () => {
    const tree = filterNav(
      adminNav,
      context(SUPER_ADMIN, { hasRoute: (path) => path === "/staff" }),
    );
    expect(ids(tree)).toEqual({ groups: [["Settings", ["staff"]]], footer: [] });
  });

  it("keeps Reasons for every member of staff and hides Staff without staff.read", () => {
    const viewer = filterNav(adminNav, context(["records.read"]));
    expect(ids(viewer)).toEqual({ groups: [["Settings", ["reasons"]]], footer: [] });
  });

  it("never routes under /api", () => {
    for (const item of [...allNavItems(consoleNav), ...allNavItems(adminNav)]) {
      expect(item.path.startsWith("/api")).toBe(false);
    }
  });
});
