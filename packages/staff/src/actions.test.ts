// The staff area's step-up actions (spec 02 §7.6, §15.5): the keys, the intent kind, the fields each
// binds (the custom staff role actions as the dashboard's role actions), and that nothing secret is
// ever bound.
import { describe, expect, it } from "vitest";
import { STAFF_ACTIONS } from "./actions.ts";

describe("the staff step-up actions", () => {
  it("are §7.6's staff rows, each an intent in the staff realm, keyed by its reason", () => {
    expect(
      Object.fromEntries(STAFF_ACTIONS.map((a) => [a.key, a.bind.map((b) => b.name)])),
    ).toEqual({
      "staff.add": ["email", "roleKey"],
      "staff.role": ["roleKey"],
      "staff.remove": [],
      "staff.reset_factors": [],
      "staff.enrolment_code": [],
      "staffRole.create": ["name", "description", "permissions"],
      "staffRole.update": ["name", "description", "permissions", "version"],
      "staffRole.delete": ["moveTo"],
      "switch.set": ["state", "reasonCode"],
    });
    for (const action of STAFF_ACTIONS) {
      expect(action.realm).toBe("staff");
      expect(action.kind).toBe("intent");
      // The reason key is the action's own key, in the lower case the intent table's column takes.
      expect(action.reasonKey).toBe(action.key.replace("staffRole.", "staff_role."));
      expect(action.reasonKey).toMatch(/^[a-z][a-z0-9_.]{0,63}$/);
      expect(action.key).toMatch(/^[a-z][a-zA-Z]*\.[a-z][a-z_]*$/);
    }
  });

  it("bind a custom role's permissions as a key list and its version as a value (§7.2)", () => {
    const kinds = (key: string) =>
      Object.fromEntries(
        (STAFF_ACTIONS.find((a) => a.key === key)?.bind ?? []).map((b) => [b.name, b.kind]),
      );
    expect(kinds("staffRole.create")).toEqual({
      name: "string",
      description: "string",
      permissions: "keys",
    });
    expect(kinds("staffRole.update")).toMatchObject({ permissions: "keys", version: "value" });
    expect(kinds("staffRole.delete")).toEqual({ moveTo: "string" });
  });

  it("bind an address as an address and never bind a code, a token or a secret", () => {
    const add = STAFF_ACTIONS.find((a) => a.key === "staff.add");
    expect(add?.bind.find((b) => b.name === "email")?.kind).toBe("address");
    for (const action of STAFF_ACTIONS) {
      for (const field of action.bind) {
        // `reasonCode` is a preset reason (a code of the catalogue's), never a credential.
        expect(field.name).not.toMatch(/^(code|otp|enrolmentCode)$|token|secret|password/i);
      }
    }
  });
});
