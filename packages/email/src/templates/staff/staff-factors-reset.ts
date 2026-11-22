// staff/staff-factors-reset (spec 02 §17.3): an Admin reset a member's second factors; to the person
// and every Admin. Bypasses the digest.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { NOT_YOU_STAFF, STAFF } from "../shared.ts";

export const staffFactorsReset = defineTemplate({
  name: "staff-factors-reset",
  area: "staff",
  class: "security",
  subdomain: "auth",
  realm: "staff",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "Staff sign-in factors reset",
  params: z.strictObject({
    staffId: param.staffId,
    audience: z.enum(["person", "admins"]),
    personName: param.personName.optional(),
    changedBy: param.personName.optional(),
  }),
  sample: {
    staffId: "stf_01jd0000000000000000000000",
    audience: "person",
    changedBy: "Dorothy Vaughan",
  },
  render: (p) => ({
    subject: "Staff sign-in factors were reset in Fin Admin",
    heading: "Sign-in factors were reset",
    preview: "A staff member's sign-in factors were reset.",
    paragraphs: [
      p.audience === "person"
        ? "Your Fin Admin passkeys and authenticator were removed. You need a new enrolment code from an Admin to sign in again."
        : "A staff member's passkeys and authenticator were removed. They need a new enrolment code to sign in again.",
    ],
    boxes: [
      ...(p.personName === undefined ? [] : [{ label: "Staff member", value: p.personName }]),
      ...(p.changedBy === undefined ? [] : [{ label: "Reset by", value: p.changedBy }]),
    ],
    ...(p.audience === "admins" ? { link: STAFF } : {}),
    footer: [NOT_YOU_STAFF],
  }),
});
