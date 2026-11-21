// The staff factor reset's security notice (spec 02 §17.1, §17.3, §6.5, [SA-14], [SA-41]; T-SAT-15 and
// T-SAT-41 for this template): `staff/staff-factors-reset`, queued by @fin/staff's resetStaffFactors
// in the reset's own transaction to the member (`person`) and every active Admin (`admins`).
//   - Fixed words in the subject, heading and preview; the member's copy says what went and how they
//     get back in, and carries no link at all (nothing in it to click, so it cannot be dressed up as
//     a way back in); the Admins' copy links only to Staff on the admin host.
//   - Never an enrolment code: a `code` parameter is refused, and one planted in a typed value is
//     hidden, in both parts.
//   - A security notice only Fin Admin may queue, which bypasses the per-kind limits.
import { describe, expect, it } from "vitest";
import { describe as digestLine, findTemplate, rolesFor } from "../../catalogue.ts";
import { HIDDEN_VALUE } from "../../params.ts";
import { RenderError, renderTemplate } from "../../render.ts";
import { staffFactorsReset } from "../staff/staff-factors-reset.ts";

const STAFF_ID = "stf_01jd0000000000000000000000";
const LINKS = { console: "https://console.example.com", admin: "https://staff.example.com" };
const CONTEXT = { recipient: "mei@example.com", environment: "staging", describe: digestLine };

/** An enrolment code as an Admin is shown it, built at run time. */
function plantedCode(): string {
  return ["7K3M", "Q9TR", "W2XA", "H8ZD"].join("-");
}

function render(params: Record<string, unknown>) {
  return renderTemplate(staffFactorsReset, params, CONTEXT, LINKS);
}

describe("staff/staff-factors-reset", () => {
  it("is the reset's security notice, queued only by Fin Admin, past every per-kind limit", () => {
    expect(findTemplate("staff/staff-factors-reset")).toBe(staffFactorsReset);
    expect(staffFactorsReset).toMatchObject({
      class: "security",
      subdomain: "auth",
      secretBearing: false,
    });
    expect(staffFactorsReset.bypasses({ staffId: STAFF_ID, audience: "person" })).toBe(true);
    expect(rolesFor(staffFactorsReset)).toEqual(["fin_admin"]);
    expect(digestLine("staff/staff-factors-reset")).toBe("Staff sign-in factors reset");
  });

  it("tells the member what went and how they get back in, with no link", () => {
    const r = render({ staffId: STAFF_ID, audience: "person" });
    expect(r.subject).toBe("Staff sign-in factors were reset in Fin Admin");
    expect(r.heading).toBe("Sign-in factors were reset");
    expect(r.preview).toBe("A staff member's sign-in factors were reset.");
    expect(r.text).toContain(
      "Your Fin Admin passkeys and authenticator were removed. You need a new enrolment code from an Admin to sign in again.",
    );
    expect(r.text).toContain("If this wasn't you, tell another Fin Admin straight away.");
    expect(r.html).not.toContain("<a ");
    expect(r.text).not.toContain("https://");
  });

  it("tells every Admin, with one link, to Staff on the admin host", () => {
    const r = render({ staffId: STAFF_ID, audience: "admins" });
    expect(r.text).toContain(
      "A staff member's passkeys and authenticator were removed. They need a new enrolment code to sign in again.",
    );
    expect(r.text).toContain("Open Staff in Fin Admin: https://staff.example.com/staff");
    expect(r.html.match(/<a /g)).toHaveLength(1);
    expect(r.html).toContain('href="https://staff.example.com/staff"');
    expect(() =>
      renderTemplate(staffFactorsReset, { staffId: STAFF_ID, audience: "admins" }, CONTEXT, {}),
    ).toThrow(RenderError);
  });

  it("never carries the enrolment code: refused as a parameter, hidden in a typed value", () => {
    const code = plantedCode();
    expect(() => render({ staffId: STAFF_ID, audience: "person", code })).toThrow(RenderError);
    for (const audience of ["person", "admins"] as const) {
      const r = render({ staffId: STAFF_ID, audience, personName: code, changedBy: code });
      for (const part of [r.subject, r.preview, r.heading, r.text, r.html]) {
        expect(part).not.toContain(code);
        expect(part).not.toContain(code.replace(/-/g, ""));
      }
      expect(r.text).toContain(HIDDEN_VALUE);
    }
  });

  it("keeps a typed name out of the subject, heading and preview, in a labelled box only", () => {
    const r = render({
      staffId: STAFF_ID,
      audience: "admins",
      personName: "Mei Tanaka",
      changedBy: "Nadia Brooks",
    });
    for (const part of [r.subject, r.heading, r.preview]) {
      expect(part).not.toContain("Mei");
      expect(part).not.toContain("Nadia");
    }
    expect(r.text).toContain("Staff member: Mei Tanaka");
    expect(r.text).toContain("Reset by: Nadia Brooks");
  });

  it("refuses an audience it does not know and an ID that is not a staff member's", () => {
    expect(() => render({ staffId: STAFF_ID, audience: "everyone" })).toThrow(RenderError);
    expect(() => render({ staffId: "usr_01jd0000000000000000000000", audience: "person" })).toThrow(
      RenderError,
    );
  });
});
