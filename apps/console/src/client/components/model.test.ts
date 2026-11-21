import { describe, expect, it } from "vitest";
import type { RoleRow } from "../api/contracts/roles.ts";
import { formatDay, formatFull, formatShort } from "../format/dates.ts";
import { holdersText, permissionsText, roleHref, withArticle } from "../format/text.ts";
import { reasonLine, withReasonValues } from "../step-up/reasons.ts";
import { backupCodesText, groupKey, secretOf } from "./authenticator.tsx";
import {
  countLine,
  draftProblems,
  groupShort,
  groupState,
  lockReason,
  toggle,
  toPermissions,
  whySaveIsOff,
} from "./role-editor.ts";
import { firstGivable, roleChoices } from "./roles.tsx";

describe("the role editor's model (spec 02 §8.1, §8.4)", () => {
  it("ticks what a permission needs, and unticks what depends on it", () => {
    const ticked = toggle(toPermissions([]), "money.transfer", true);
    expect([...ticked].sort()).toEqual(["customers.read", "money.read", "money.transfer"]);
    const unticked = toggle(ticked, "customers.read", false);
    expect([...unticked]).toEqual([]);
  });

  it("locks what the editor lacks, and what only a Super admin holds", () => {
    const admin = toPermissions(["member.read", "customers.read"]);
    expect(lockReason("customers.read", admin)).toBeNull();
    expect(lockReason("money.read", admin)).toBe("You don’t have this yourself.");
    expect(lockReason("organization.delete", toPermissions(["organization.delete"]))).toBe(
      "Only a Super admin can do this.",
    );
  });

  it("says why Save is off", () => {
    const actor = toPermissions(["customers.read", "member.read"]);
    const empty = draftProblems({ name: "", description: "", permissions: toPermissions([]) }, actor);
    expect(whySaveIsOff(empty, "")).toBe("Name the role and tick at least one permission.");
    const named = draftProblems({ name: "Support", description: "", permissions: toPermissions([]) }, actor);
    expect(whySaveIsOff(named, "Support")).toBe("Tick at least one permission.");
    const ready = draftProblems(
      { name: "Support", description: "", permissions: toPermissions(["customers.read"]) },
      actor,
    );
    expect(ready).toEqual([]);
    expect(whySaveIsOff(ready, "Support")).toBeNull();
    expect(
      draftProblems({ name: "Super Admin", description: "", permissions: toPermissions(["customers.read"]) }, actor),
    ).toContain("reads_as_built_in");
  });

  it("draws the summary's lines", () => {
    expect(countLine("Developer", 15)).toBe("Developer can do 15 things.");
    expect(countLine("", 1)).toBe("This role can do 1 thing.");
    expect(countLine("Support", 0)).toBe("This role can’t do anything yet.");
    const keys = ["customers.read", "customers.create"] as const;
    expect(groupState(toPermissions(["customers.read"]), keys)).toBe("some");
    expect(groupShort("some", 1, 2)).toBe("1 of 2");
    expect(groupShort("all", 2, 2)).toBe("All");
    expect(groupShort("none", 0, 2)).toBe("None");
  });
});

describe("choosing a role ([SA-32])", () => {
  const roles: RoleRow[] = [
    { roleKey: "super_admin", roleId: null, label: "Super admin", builtIn: true, permissionCount: 26, holders: 1 },
    { roleKey: "admin", roleId: null, label: "Admin", builtIn: true, permissionCount: 24, holders: 1 },
    {
      roleKey: "rol_dev",
      roleId: "rol_dev",
      label: "Developer",
      description: "Builds and tests the integration in Sandbox.",
      builtIn: false,
      permissionCount: 2,
      holders: 2,
      permissions: ["webhooks.read", "apiKey.read"],
    },
  ];

  it("disables the top role for anyone but its holders, and a role beyond the actor", () => {
    const choices = roleChoices(roles, { roleKey: "admin", permissions: ["member.read", "apiKey.read"] });
    expect(choices.map((c) => [c.roleKey, c.reason])).toEqual([
      ["super_admin", "Only a Super admin can do this."],
      ["admin", "You don’t have this yourself."],
      ["rol_dev", "You don’t have this yourself."],
    ]);
    expect(firstGivable(choices)).toBeNull();
  });

  it("offers what the actor may give, marks the current role, and describes each", () => {
    const all = ["webhooks.read", "apiKey.read", "member.read"];
    const choices = roleChoices(roles.slice(2), { roleKey: "admin", permissions: all }, "rol_dev");
    expect(choices[0]).toMatchObject({ reason: "Current", description: "Builds and tests the integration in Sandbox." });
    expect(firstGivable(roleChoices(roles.slice(2), { roleKey: "admin", permissions: all }))).toBe("rol_dev");
  });
});

describe("the StepUp dialog's line (spec 02 §15.5)", () => {
  it("fills the reason from the page's own values", async () => {
    expect(reasonLine("account.passkey_add")).toBe("Use your second factor to add a passkey.");
    const line = await withReasonValues({ name: "Priya Shah", role: "Compliance" }, async () =>
      reasonLine("member.role"),
    );
    expect(line).toBe("Use your second factor to change Priya Shah’s role to Compliance.");
  });

  it("falls back when a value or the key is missing, and forgets the values after", async () => {
    expect(reasonLine("member.remove")).toBe("Use your second factor to continue.");
    expect(reasonLine("no.such.key")).toBe("Use your second factor to continue.");
    await withReasonValues({ name: "Priya Shah" }, async () => undefined);
    expect(reasonLine("member.remove")).toBe("Use your second factor to continue.");
  });
});

describe("the authenticator's key and the backup codes", () => {
  it("shows the key in groups of four", () => {
    const uri = "otpauth://totp/Fin:maya%40example.com?secret=JBSWY3DPEHPK3PXP7QKD&issuer=Fin";
    expect(secretOf(uri)).toBe("JBSWY3DPEHPK3PXP7QKD");
    expect(groupKey("JBSWY3DPEHPK3PXP7QKD")).toBe("JBSW Y3DP EHPK 3PXP 7QKD");
    expect(secretOf("https://example.com/?secret=ABC")).toBeNull();
    expect(secretOf("otpauth://totp/x?secret=not-base32!")).toBeNull();
  });

  it("writes the codes' text file", () => {
    expect(backupCodesText(["aaaa-1111", "bbbb-2222"])).toBe(
      "Fin backup codes\nEach code signs you in once if you lose your authenticator app.\n\naaaa-1111\nbbbb-2222\n",
    );
  });
});

describe("dates and counts as the boards write them", () => {
  it("formats in UTC", () => {
    expect(formatDay("2026-11-02T10:05:00Z")).toBe("2 Nov 2026");
    expect(formatShort("2026-11-20T14:05:00Z")).toBe("20 Nov, 14:05");
    expect(formatFull("2026-11-20T14:05:00Z")).toBe("20 Nov 2026, 14:05 UTC");
    expect(formatDay("not a date")).toBe("—");
    expect(formatDay(null)).toBe("—");
  });

  it("counts people and permissions, and names a role with its article", () => {
    expect(holdersText(0)).toBe("No one yet");
    expect(holdersText(1)).toBe("1 person");
    expect(holdersText(3)).toBe("3 people");
    expect(permissionsText(26)).toBe("All 26 permissions");
    expect(permissionsText(15)).toBe("15 of 26 permissions");
    expect(withArticle("Admin")).toBe("an Admin");
    expect(withArticle("Developer")).toBe("a Developer");
    expect(roleHref("rol_1/x")).toBe("/settings/roles/rol_1%2Fx");
  });
});
