// staff/staff-access-changed (spec 02 §10, §17.3): added, role changed or removed; to the person and
// every Admin. Never carries the enrolment code (spec 02 §6.5). Bypasses the digest.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { NOT_YOU_STAFF, STAFF } from "../shared.ts";

const WHAT = {
  added: {
    person:
      "You were added to Fin Admin. An Admin will give you an enrolment code by another route.",
    admins: "Someone was added to Fin Admin.",
  },
  role_changed: {
    person: "Your role in Fin Admin changed. What you can see and do there changed with it.",
    admins: "A staff member's role in Fin Admin changed.",
  },
  removed: {
    person: "You were removed from Fin Admin and can no longer sign in to it.",
    admins: "A staff member was removed from Fin Admin.",
  },
} as const;

export const staffAccessChanged = defineTemplate({
  name: "staff-access-changed",
  area: "staff",
  class: "security",
  subdomain: "auth",
  realm: "staff",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "Changes to staff access",
  params: z.strictObject({
    staffId: param.staffId,
    kind: z.enum(["added", "role_changed", "removed"]),
    audience: z.enum(["person", "admins"]),
    personName: param.personName.optional(),
    roleLabel: param.roleLabel.optional(),
    changedBy: param.personName.optional(),
  }),
  sample: {
    staffId: "stf_01jd0000000000000000000000",
    kind: "role_changed",
    audience: "admins",
    personName: "Katherine Johnson",
    roleLabel: "Compliance",
    changedBy: "Dorothy Vaughan",
  },
  render: (p) => ({
    subject: "Staff access changed in Fin Admin",
    heading: "Staff access changed",
    preview: "There was a change to who can use Fin Admin.",
    paragraphs: [WHAT[p.kind][p.audience]],
    boxes: [
      ...(p.personName === undefined ? [] : [{ label: "Staff member", value: p.personName }]),
      ...(p.roleLabel === undefined ? [] : [{ label: "Role", value: p.roleLabel }]),
      ...(p.changedBy === undefined ? [] : [{ label: "Changed by", value: p.changedBy }]),
    ],
    ...(p.audience === "admins" ? { link: STAFF } : {}),
    footer: [NOT_YOU_STAFF],
  }),
});
