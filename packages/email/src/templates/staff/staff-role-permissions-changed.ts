// staff/staff-role-permissions-changed (stretch 3; spec 02 §17.3): a custom staff role changed; to its
// holders and every Admin.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { NOT_YOU_STAFF, STAFF } from "../shared.ts";

export const staffRolePermissionsChanged = defineTemplate({
  name: "staff-role-permissions-changed",
  area: "staff",
  class: "security",
  subdomain: "auth",
  realm: "staff",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Changes to staff role permissions",
  params: z.strictObject({ roleLabel: param.roleLabel, changedBy: param.personName.optional() }),
  sample: { roleLabel: "Compliance", changedBy: "Dorothy Vaughan" },
  render: (p) => ({
    subject: "A staff role's permissions changed in Fin Admin",
    heading: "A staff role's permissions changed",
    preview: "What a staff role can do in Fin Admin changed.",
    paragraphs: [
      "The permissions of a staff role changed. What its holders can see and do changed with it.",
    ],
    boxes: [
      { label: "Role", value: p.roleLabel },
      ...(p.changedBy === undefined ? [] : [{ label: "Changed by", value: p.changedBy }]),
    ],
    link: STAFF,
    footer: [NOT_YOU_STAFF],
  }),
});
