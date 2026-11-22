// T-SAT-09: both catalogues exactly as spec 02 §8.2 and §8.3 list them. The tables below are
// copied from the spec, not from the fragments, so a fragment that drifts from the spec fails here.
import { describe, expect, it } from "vitest";
import type { Catalogue, StepUpKind } from "../engine/types.ts";
import { dashboardCatalogue } from "./dashboard/index.ts";
import { staffCatalogue } from "./staff/index.ts";

type Row = readonly [
  group: string,
  key: string,
  label: string,
  description: string,
  needs: readonly string[],
  stepUp: StepUpKind,
  privileged: boolean,
  sandboxOnly: boolean,
  restricted: boolean,
];

// spec 02 §8.2: Group | Key | Label | Description | Needs | Step-up | P | Sandbox | Restricted.
// biome-ignore format: the spec's table, one row per line
const DASHBOARD: readonly Row[] = [
  ["Customers", "customers.read", "See customers", "Their details, documents and history.", [], "window", false, false, false],
  ["Customers", "customers.create", "Add customers and send their links", "Create a customer and send them a link to verify.", ["customers.read"], "window", false, false, false],
  ["Customers", "customers.restart", "Start a customer again", "Clear what they sent and ask for it again.", ["customers.read"], "intent", false, false, false],
  ["Customers", "customers.delete", "Delete customers", "Remove a customer and what they sent, for good.", ["customers.read"], "intent", false, false, false],
  ["Simulator", "simulator.use", "Use the simulator", "Approve, reject or ask for information on Sandbox customers.", ["customers.read"], "window", false, true, false],
  ["Simulator", "sandbox.reset", "Reset the Sandbox", "Delete every Sandbox customer and start clean.", ["simulator.use"], "intent", false, true, false],
  ["Money movement", "money.read", "See money movement", "Virtual accounts, beneficiaries and transfers.", ["customers.read"], "window", false, false, false],
  ["Money movement", "money.beneficiaries", "Add and remove beneficiaries", "The bank accounts a customer can send money to.", ["money.read"], "intent", true, false, false],
  ["Money movement", "money.transfer", "Send money", "Move a customer's USD to a beneficiary, and open virtual accounts.", ["money.read"], "intent", true, false, false],
  ["Money movement", "money.simulate", "Simulate deposits", "Add USD to a customer's balance in the Sandbox.", ["money.read"], "none", false, true, false],
  ["Webhooks", "webhooks.read", "See endpoints and events", "Endpoints, deliveries and the events Fin sent.", [], "none", false, false, false],
  ["Webhooks", "webhooks.manage", "Add, change and pause endpoints", "Where Fin sends events, and which ones.", ["webhooks.read"], "intent", true, false, false],
  ["Webhooks", "webhooks.roll_secret", "Roll signing secrets", "Make a new secret. Fin signs with the old one too for a day.", ["webhooks.read"], "intent", true, false, false],
  ["Webhooks", "webhooks.redeliver", "Redeliver events", "Send an event to an endpoint again.", ["webhooks.read"], "window", false, false, false],
  ["API keys", "apiKey.read", "See keys", "Names, how each starts and when it was last used.", [], "none", false, false, false],
  ["API keys", "apiKey.sandbox", "Create, roll and revoke Sandbox keys", "Keys that start fin_test_.", ["apiKey.read"], "intent", false, false, false],
  ["API keys", "apiKey.live", "Create, roll and revoke Production keys", "Keys that start fin_live_.", ["apiKey.read"], "intent", true, false, false],
  ["Team", "member.read", "See the team", "Who is here, their roles and invitations.", [], "none", false, false, false],
  ["Team", "member.invite", "Invite and remove people", "Send invitations and take people off the team.", ["member.read"], "intent", true, false, false],
  ["Team", "member.role", "Change people's roles", "Give someone another role, never one that can do more than you.", ["member.read"], "intent", true, false, false],
  ["Team", "role.manage", "Create and change roles", "Roles like this one, and what each allows.", ["member.read"], "intent", true, false, false],
  ["Audit log", "auditLog.read", "See the audit log", "Who did what in this organisation, and when.", [], "none", false, false, false],
  ["Organisation settings", "organization.update", "Rename the organisation", "The name people see in invitations and emails.", [], "intent", true, false, false],
  ["Organisation settings", "organization.delete", "Delete the organisation", "Close it and delete its data.", [], "intent", true, false, true],
  ["Go to Production", "golive.edit", "Fill in your Production request", "Answers and documents, saved as you go.", [], "none", false, false, false],
  ["Go to Production", "golive.submit", "Send it to Fin", "Send your finished Production request for Fin to review.", ["golive.edit"], "intent", true, false, true],
];

// spec 02 §8.3: Group | Key | Label | Description | Needs | Step-up | Admin-only. Fin Admin marks
// no permission privileged and none Sandbox-only.
// biome-ignore format: the spec's table, one row per line
const STAFF: readonly Row[] = [
  ["Production access requests", "golive.read", "See Production access requests", "Requests, their answers and documents, and who acts next.", [], "none", false, false, false],
  ["Production access requests", "golive.decide", "Decide Production access requests", "Approve, ask for changes or decline.", ["golive.read"], "intent", false, false, false],
  ["Customers", "customers.read", "See customers", "Customers and their people, with personal details masked.", [], "none", false, false, false],
  ["Customers", "customers.reveal", "Show personal details", "Unmask a customer's or person's details, within a budget.", ["customers.read"], "window", false, false, false],
  ["Customers", "documents.view", "View identity documents", "Open identity documents from Sumsub, within a budget.", ["customers.read"], "window", false, false, false],
  ["Customers", "customers.decide", "Decide customers", "Approve, unapprove and reject customers and people.", ["customers.read"], "intent", false, false, false],
  ["Requests for information", "rfis.read", "See requests for information", "Requests, answers and what is overdue.", ["customers.read"], "none", false, false, false],
  ["Requests for information", "rfis.manage", "Handle requests for information", "Ask, change, accept, ask again and withdraw.", ["rfis.read"], "none", false, false, false],
  ["Organisations", "organisations.read", "See organisations", "Organisations, their members and their Production status.", [], "none", false, false, false],
  ["Organisations", "organisations.pause", "Pause and restore Production access", "Stop an organisation's Production keys, and turn them back on.", ["organisations.read"], "intent", false, false, false],
  ["Organisations", "organisations.approvals", "Change customer approvals", 'Turn "Fin approves each customer" on or off.', ["organisations.read"], "intent", false, false, false],
  ["Developer accounts", "accounts.recover", "Recover developer accounts", "Reset a developer's second factors after an identity check.", ["organisations.read"], "intent", false, false, true],
  ["Money", "money.read", "See money", "Provider status, transfers and reconciliation breaks.", [], "none", false, false, false],
  ["Money", "money.operate", "Operate money", "Retry, close and resolve breaks. Never send a payout.", ["money.read"], "intent", false, false, false],
  ["Operations", "switches.manage", "Use the kill switches", "Stop or restart one kind of work at once.", [], "intent", false, false, false],
  ["Audit", "audit.read", "See the audit log", "Everything staff and the system did, newest first.", [], "none", false, false, false],
  ["Settings", "forms.manage", "Manage forms", "Edit, publish and archive request forms.", ["rfis.read"], "none", false, false, false],
  ["Settings", "reasons.manage", "Manage reasons", "The preset reasons staff give.", [], "none", false, false, false],
  ["Settings", "templates.manage", "Manage message templates", "What staff send to developers and customers.", [], "none", false, false, false],
  ["Settings", "views.manage", "Manage shared views", "Save and delete views every member of staff sees.", [], "none", false, false, false],
  ["Staff", "staff.read", "See staff", "Who can use Fin Admin, their roles and when they last signed in.", [], "none", false, false, false],
  ["Staff", "staff.add", "Add staff", "Add someone and give them an enrolment code.", ["staff.read"], "intent", false, false, false],
  ["Staff", "staff.remove", "Remove staff", "Take someone out of Fin Admin at once.", ["staff.read"], "intent", false, false, false],
  ["Staff", "staff.role", "Change staff roles", "Give someone another role.", ["staff.read"], "intent", false, false, true],
  ["Staff", "staff.reset_factors", "Reset second factors", "Remove someone's passkeys and authenticator so they enrol again.", ["staff.read"], "intent", false, false, true],
  ["Staff", "staffRoles.manage", "Create and change staff roles", "Roles like this one, and what each allows.", ["staff.read"], "intent", false, false, true],
];

const DASHBOARD_GROUPS = [
  "Customers",
  "Simulator",
  "Money movement",
  "Webhooks",
  "API keys",
  "Team",
  "Audit log",
  "Organisation settings",
  "Go to Production",
];

const STAFF_GROUPS = [
  "Production access requests",
  "Customers",
  "Requests for information",
  "Organisations",
  "Developer accounts",
  "Money",
  "Operations",
  "Audit",
  "Settings",
  "Staff",
];

const keysOf = (rows: readonly Row[]) => rows.map((row) => row[1]);
const holdsOf = (cat: Catalogue, roleKey: string): string[] => {
  const role = cat.builtIns.find((r) => r.key === roleKey);
  if (role === undefined) throw new Error(`no built-in role ${roleKey}`);
  return role.holds === "all" ? [...cat.keys] : [...role.holds];
};
const sortedCopy = (items: Iterable<string>) => [...items].sort();

function catalogueMatchesSpec(cat: Catalogue, rows: readonly Row[], groups: readonly string[]) {
  it("has 26 permissions, in the spec's order", () => {
    expect(rows).toHaveLength(26);
    expect(cat.keys).toEqual(keysOf(rows));
    expect(Object.keys(cat.permissions)).toHaveLength(26);
  });

  it("has the spec's groups, in order, each holding its rows", () => {
    expect(cat.groups.map((g) => g.label)).toEqual(groups);
    for (const group of cat.groups) {
      const expected = rows.filter((row) => row[0] === group.label).map((row) => row[1]);
      expect(group.permissions, group.label).toEqual(expected);
    }
  });

  it.each(rows)("%s: %s is as the spec lists it", (...row) => {
    const [group, key, label, description, needs, stepUp, privileged, sandboxOnly, restricted] =
      row;
    const def = cat.permissions[key];
    if (def === undefined) throw new Error(`${key} is missing`);
    expect(cat.groups.find((g) => g.key === def.group)?.label).toBe(group);
    expect(def.key).toBe(key);
    expect(def.label).toBe(label);
    expect(def.description).toBe(description);
    expect([...def.needs]).toEqual([...needs]);
    expect(def.stepUp).toBe(stepUp);
    expect(def.privileged).toBe(privileged);
    expect(def.sandboxOnly).toBe(sandboxOnly);
    expect(def.restricted).toBe(restricted);
  });

  it("names only permissions it defines as needs, and its needs form no cycle", () => {
    const known = new Set(cat.keys);
    const state = new Map<string, "open" | "done">();
    const visit = (key: string): void => {
      expect(state.get(key), `cycle through ${key}`).not.toBe("open");
      if (state.get(key) === "done") return;
      state.set(key, "open");
      for (const need of cat.permissions[key]?.needs ?? []) {
        expect(known.has(need), `${key} needs ${need}`).toBe(true);
        visit(need);
      }
      state.set(key, "done");
    };
    for (const key of cat.keys) visit(key);
  });

  it("has every label and description, each description a sentence", () => {
    for (const key of cat.keys) {
      const def = cat.permissions[key];
      expect(def?.label.trim(), key).not.toBe("");
      expect(def?.description.trim(), key).not.toBe("");
      expect(def?.description.endsWith("."), key).toBe(true);
      expect(def?.label.endsWith("."), key).toBe(false);
    }
    for (const group of cat.groups) expect(group.label.trim()).not.toBe("");
    for (const role of cat.builtIns) {
      expect(role.label.trim()).not.toBe("");
      expect(role.summary.endsWith(".")).toBe(true);
    }
  });

  it("lists exactly the restricted rows as restricted", () => {
    expect(cat.restricted).toEqual(rows.filter((row) => row[8]).map((row) => row[1]));
  });

  it("is frozen, so no screen or service can change it at run time", () => {
    expect(Object.isFrozen(cat)).toBe(true);
    expect(Object.isFrozen(cat.permissions)).toBe(true);
    expect(Object.isFrozen(cat.keys)).toBe(true);
    expect(Object.isFrozen(cat.builtIns)).toBe(true);
    for (const role of cat.builtIns) expect(Object.isFrozen(role)).toBe(true);
    for (const key of cat.keys) {
      expect(Object.isFrozen(cat.permissions[key])).toBe(true);
      expect(Object.isFrozen(cat.permissions[key]?.needs)).toBe(true);
    }
    expect(() => {
      (cat.keys as string[]).push("x.y");
    }).toThrow(TypeError);
  });
}

describe("the dashboard catalogue (spec 02 §8.2, [SA-11])", () => {
  const cat: Catalogue = dashboardCatalogue;
  catalogueMatchesSpec(cat, DASHBOARD, DASHBOARD_GROUPS);

  it("is the dashboard realm, with rol_ custom roles and member.role to move people", () => {
    expect(cat.realm).toBe("dashboard");
    expect(cat.customRolePrefix).toBe("rol");
    expect(cat.movePermission).toBe("member.role");
  });

  it("has exactly the built-in Super admin and Admin roles, and Super admin on top", () => {
    expect(cat.builtIns.map((r) => [r.key, r.label])).toEqual([
      ["super_admin", "Super admin"],
      ["admin", "Admin"],
    ]);
    expect(cat.topRoleKey).toBe("super_admin");
  });

  it("gives Super admin all 26 and Admin all but deleting the organisation and sending the request", () => {
    expect(sortedCopy(holdsOf(cat, "super_admin"))).toEqual(sortedCopy(keysOf(DASHBOARD)));
    expect(sortedCopy(holdsOf(cat, "admin"))).toEqual(
      sortedCopy(
        keysOf(DASHBOARD).filter((k) => k !== "organization.delete" && k !== "golive.submit"),
      ),
    );
  });

  it("carries the spec's built-in summaries", () => {
    expect(cat.builtIns.map((r) => r.summary)).toEqual([
      "Everything, including deleting the organisation, sending the Production request and making Super admins.",
      "Everything except deleting the organisation, sending the Production request and making Super admins.",
    ]);
  });

  it("marks exactly the spec's privileged and Sandbox-only permissions", () => {
    expect(cat.keys.filter((k) => cat.permissions[k]?.privileged)).toEqual([
      "money.beneficiaries",
      "money.transfer",
      "webhooks.manage",
      "webhooks.roll_secret",
      "apiKey.live",
      "member.invite",
      "member.role",
      "role.manage",
      "organization.update",
      "organization.delete",
      "golive.submit",
    ]);
    expect(cat.keys.filter((k) => cat.permissions[k]?.sandboxOnly)).toEqual([
      "simulator.use",
      "sandbox.reset",
      "money.simulate",
    ]);
  });

  it("restricts exactly deleting the organisation and sending the Production request", () => {
    expect(cat.restricted).toEqual(["organization.delete", "golive.submit"]);
  });
});

describe("the Fin Admin catalogue (spec 02 §8.3, [SA-12])", () => {
  const cat: Catalogue = staffCatalogue;
  catalogueMatchesSpec(cat, STAFF, STAFF_GROUPS);

  it("is the staff realm, with srl_ custom roles and staff.role to move people", () => {
    expect(cat.realm).toBe("staff");
    expect(cat.customRolePrefix).toBe("srl");
    expect(cat.movePermission).toBe("staff.role");
  });

  it("has exactly the prebuilt Viewer, Compliance, Operator and Admin roles, and Admin on top", () => {
    expect(cat.builtIns.map((r) => [r.key, r.label])).toEqual([
      ["viewer", "Viewer"],
      ["compliance", "Compliance"],
      ["operator", "Operator"],
      ["admin", "Admin"],
    ]);
    expect(cat.topRoleKey).toBe("admin");
  });

  it("gives Viewer every *.read and nothing else", () => {
    const reads = keysOf(STAFF).filter((k) => k.endsWith(".read"));
    expect(reads).toEqual([
      "golive.read",
      "customers.read",
      "rfis.read",
      "organisations.read",
      "money.read",
      "audit.read",
      "staff.read",
    ]);
    expect(sortedCopy(holdsOf(cat, "viewer"))).toEqual(sortedCopy(reads));
    expect(holdsOf(cat, "viewer")).not.toContain("customers.reveal");
    expect(holdsOf(cat, "viewer")).not.toContain("documents.view");
  });

  it("builds Compliance on Viewer, Operator on Compliance, and gives Admin all 26", () => {
    const compliance = [
      ...holdsOf(cat, "viewer"),
      "customers.reveal",
      "documents.view",
      "customers.decide",
      "rfis.manage",
      "forms.manage",
      "golive.decide",
      "views.manage",
    ];
    expect(sortedCopy(holdsOf(cat, "compliance"))).toEqual(sortedCopy(compliance));
    expect(sortedCopy(holdsOf(cat, "operator"))).toEqual(
      sortedCopy([
        ...compliance,
        "organisations.pause",
        "organisations.approvals",
        "switches.manage",
      ]),
    );
    expect(sortedCopy(holdsOf(cat, "admin"))).toEqual(sortedCopy(keysOf(STAFF)));
  });

  it("carries the spec's prebuilt summaries", () => {
    expect(cat.builtIns.map((r) => r.summary)).toEqual([
      "Sees everything in Fin Admin except personal details and documents, and changes nothing.",
      "Reviews and decides customers and Production access requests, handles requests for information and forms, and sees personal details and documents.",
      "Does everything Compliance does, pauses and restores Production access, changes customer approvals and uses the kill switches.",
      "Does everything, including staff, staff roles, reasons and message templates.",
    ]);
  });

  it("makes exactly the four Admin-only permissions restricted ([SA-12])", () => {
    expect(sortedCopy(cat.restricted)).toEqual(
      sortedCopy(["staff.role", "staffRoles.manage", "staff.reset_factors", "accounts.recover"]),
    );
    for (const role of ["viewer", "compliance", "operator"]) {
      for (const key of cat.restricted) expect(holdsOf(cat, role)).not.toContain(key);
    }
  });

  it("marks nothing privileged or Sandbox-only", () => {
    expect(cat.keys.filter((k) => cat.permissions[k]?.privileged)).toEqual([]);
    expect(cat.keys.filter((k) => cat.permissions[k]?.sandboxOnly)).toEqual([]);
  });
});

describe("both catalogues", () => {
  it("close every built-in role under its needs", () => {
    for (const cat of [dashboardCatalogue, staffCatalogue] as Catalogue[]) {
      for (const role of cat.builtIns) {
        const held = new Set(holdsOf(cat, role.key));
        for (const key of held) {
          for (const need of cat.permissions[key]?.needs ?? []) {
            expect(held.has(need), `${cat.realm} ${role.key}: ${key} needs ${need}`).toBe(true);
          }
        }
      }
    }
  });

  it("let only the top role hold a restricted permission", () => {
    for (const cat of [dashboardCatalogue, staffCatalogue] as Catalogue[]) {
      for (const role of cat.builtIns.filter((r) => r.key !== cat.topRoleKey)) {
        for (const key of cat.restricted) expect(holdsOf(cat, role.key)).not.toContain(key);
      }
    }
  });
});
