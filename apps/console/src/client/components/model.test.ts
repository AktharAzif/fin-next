import { ApiError } from "@fin/frame";
import { describe, expect, it } from "vitest";
import type { RoleRow } from "../api/contracts/roles.ts";
import { formatDay, formatFull, formatShort } from "../format/dates.ts";
import { holdersText, permissionsText, roleHref, withArticle } from "../format/text.ts";
import { reasonLine, withReasonValues } from "../step-up/reasons.ts";
import { backupCodesText, groupKey, secretOf } from "./authenticator.tsx";
import {
  CATALOGUE,
  countLine,
  draftProblems,
  givableCopy,
  groupShort,
  groupState,
  lockReason,
  toggle,
  toPermissions,
  whySaveIsOff,
} from "./role-editor.ts";
import {
  canGiveAny,
  offered,
  pickedRole,
  roleChoices,
  roleGone,
  roleRefusal,
  whyNoRole,
} from "./roles.tsx";

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
    const empty = draftProblems(
      { name: "", description: "", permissions: toPermissions([]) },
      actor,
    );
    expect(whySaveIsOff(empty, "")).toBe("Name the role and tick at least one permission.");
    const named = draftProblems(
      { name: "Support", description: "", permissions: toPermissions([]) },
      actor,
    );
    expect(whySaveIsOff(named, "Support")).toBe("Tick at least one permission.");
    const ready = draftProblems(
      { name: "Support", description: "", permissions: toPermissions(["customers.read"]) },
      actor,
    );
    expect(ready).toEqual([]);
    expect(whySaveIsOff(ready, "Support")).toBeNull();
    expect(
      draftProblems(
        { name: "Super Admin", description: "", permissions: toPermissions(["customers.read"]) },
        actor,
      ),
    ).toContain("reads_as_built_in");
  });

  it("never leaves Save pressable when saving would do nothing", () => {
    const all = toPermissions(CATALOGUE.keys);
    // Every permission, the restricted ones included: what a copy of Super admin held.
    const restricted = draftProblems(
      { name: "Super admin copy", description: "", permissions: all },
      all,
    );
    expect(restricted).toContain("restricted");
    expect(whySaveIsOff(restricted, "Super admin copy")).toBe(
      "Untick the permissions you can’t give first.",
    );
    const actor = toPermissions(["customers.read", "member.read"]);
    const beyond = draftProblems(
      { name: "Support", description: "", permissions: toPermissions(["money.read"]) },
      actor,
    );
    expect(beyond).toContain("beyond");
    expect(whySaveIsOff(beyond, "Support")).toBe("Untick the permissions you can’t give first.");
    const missing = draftProblems(
      { name: "Support", description: "", permissions: toPermissions(["money.transfer"]) },
      all,
    );
    expect(missing).toEqual(["missing_need"]);
    expect(whySaveIsOff(missing, "Support")).toBe("Tick what each permission needs first.");
  });

  it("duplicates only what the editor may give, so the copy can be saved", () => {
    const all = toPermissions(CATALOGUE.keys);
    // A Super admin duplicating Super admin: the restricted permissions stay behind.
    const copy = givableCopy(CATALOGUE.keys, all);
    expect(copy.has("organization.delete")).toBe(false);
    expect(
      draftProblems({ name: "Super admin copy", description: "", permissions: copy }, all),
    ).toEqual([]);
    // An Admin duplicating a role above theirs: what they lack stays behind, and so does what
    // needs it; what is kept brings everything it needs.
    const admin = toPermissions(["customers.read", "member.read"]);
    const kept = givableCopy(
      ["customers.read", "money.read", "money.transfer", "member.read"],
      admin,
    );
    expect([...kept].sort()).toEqual(["customers.read", "member.read"]);
    expect(draftProblems({ name: "Support", description: "", permissions: kept }, admin)).toEqual(
      [],
    );
    // Nothing the source lacked is added, and unknown names are dropped.
    expect([...givableCopy(["customers.read", "no.such"], admin)]).toEqual(["customers.read"]);
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
    {
      roleKey: "super_admin",
      roleId: null,
      label: "Super admin",
      builtIn: true,
      permissionCount: 26,
      holders: 1,
    },
    {
      roleKey: "admin",
      roleId: null,
      label: "Admin",
      builtIn: true,
      permissionCount: 24,
      holders: 1,
    },
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
    const choices = roleChoices(roles, {
      roleKey: "admin",
      permissions: ["member.read", "apiKey.read"],
    });
    expect(choices.map((c) => [c.roleKey, c.reason])).toEqual([
      ["super_admin", "Only a Super admin can do this."],
      ["admin", "You don’t have this yourself."],
      ["rol_dev", "You don’t have this yourself."],
    ]);
    expect(canGiveAny(choices)).toBe(false);
    expect(whyNoRole(choices, null)).toBe("There is no role you can give.");
    // A refused role can never be the one sent, even if it was picked somehow.
    expect(pickedRole(choices, "super_admin")).toBeNull();
  });

  it("offers what the actor may give, marks the current role, and describes each", () => {
    const all = ["webhooks.read", "apiKey.read", "member.read"];
    const choices = roleChoices(roles.slice(2), { roleKey: "admin", permissions: all }, "rol_dev");
    expect(choices[0]).toMatchObject({
      reason: "Current",
      description: "Builds and tests the integration in Sandbox.",
    });
    const fresh = roleChoices(roles.slice(2), { roleKey: "admin", permissions: all });
    expect(canGiveAny(fresh)).toBe(true);
    expect(pickedRole(fresh, "rol_dev")).toBe("rol_dev");
  });

  it("never starts with a role chosen, least of all the most privileged (least privilege)", () => {
    // A Super admin may give every role, the top one first in the list.
    const top = roleChoices(roles, { roleKey: "super_admin", permissions: CATALOGUE.keys });
    expect(top.filter((c) => c.reason === null).map((c) => c.roleKey)).toContain("super_admin");
    expect(pickedRole(top, null)).toBeNull();
    expect(whyNoRole(top, null)).toBe("Choose a role first.");
    // The person's own pick is what is sent.
    expect(pickedRole(top, "rol_dev")).toBe("rol_dev");
    expect(whyNoRole(top, "rol_dev")).toBeNull();
    // A pick that is no longer offered (the list changed) is no pick.
    expect(pickedRole(top, "rol_gone")).toBeNull();
    expect(whyNoRole(top, "rol_gone")).toBe("Choose a role first.");
    expect(offered(top, "rol_dev")).toBe(true);
    expect(offered(top, "rol_gone")).toBe(false);
    expect(offered(top, null)).toBe(false);
  });

  it("says a role deleted meanwhile no longer exists, so the page reads the roles again", () => {
    const refused = (status: number, code: string, extra: Record<string, unknown> = {}) =>
      new ApiError({
        kind: "problem",
        contract: "team.invite",
        status,
        problem: { type: "x", title: "x", status, code, request_id: "req_1", ...extra },
      });
    for (const problem of ["gone", "unknown_role"]) {
      const error = refused(403, "giving_refused", { problem });
      expect(roleGone(error), problem).toBe(true);
      expect(roleRefusal(error), problem).toBe("That role no longer exists. Pick another.");
    }
    const beyond = refused(403, "giving_refused", { problem: "beyond" });
    expect(roleGone(beyond)).toBe(false);
    expect(roleRefusal(beyond)).toBe("That role can do more than yours, so you can’t give it.");
    expect(roleRefusal(refused(403, "giving_refused", { problem: "top_only" }))).toBe(
      "Only a Super admin can make someone a Super admin.",
    );
    expect(roleRefusal(refused(409, "last_top_role"))).toBe(
      "Every organisation needs a Super admin. Make someone else one first.",
    );
    expect(roleGone(refused(404, "not_found"))).toBe(false);
  });
});

describe("the StepUp dialog's line (spec 02 §15.5)", () => {
  it("fills the reason from the page's own values", async () => {
    expect(reasonLine("account.passkey_add")).toBe("Use your second factor to add a passkey.");
    const line = await withReasonValues(
      "member.role",
      { name: "Priya Shah", role: "Compliance" },
      async () => reasonLine("member.role"),
    );
    expect(line).toBe("Use your second factor to change Priya Shah’s role to Compliance.");
  });

  it("falls back when a value or the key is missing, and forgets the values after", async () => {
    expect(reasonLine("member.remove")).toBe("Use your second factor to continue.");
    expect(reasonLine("no.such.key")).toBe("Use your second factor to continue.");
    expect(reasonLine("constructor")).toBe("Use your second factor to continue.");
    await withReasonValues("member.remove", { name: "Priya Shah" }, async () => undefined);
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
