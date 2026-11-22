// orgs/role-permissions-changed (spec 02 §17.2): a custom role's permissions changed; to its holders.
// Bypasses the digest.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";

export const rolePermissionsChanged = defineTemplate({
  name: "role-permissions-changed",
  area: "orgs",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "Changes to your role's permissions",
  params: z.strictObject({
    orgId: param.orgId,
    roleId: param.roleId,
    orgName: param.orgName,
    roleLabel: param.roleLabel,
    personName: param.personName.optional(),
  }),
  sample: {
    orgId: "org_01jd0000000000000000000000",
    roleId: "rol_01jd0000000000000000000000",
    orgName: "Example Payments",
    roleLabel: "Support",
    personName: "Grace Hopper",
  },
  render: (p) => ({
    subject: "Your role's permissions changed on Fin",
    heading: "Your role's permissions changed",
    preview: "What your role can do in a team on Fin changed.",
    paragraphs: [
      "The permissions of a role you hold changed. What you can see and do in the team changed with it.",
    ],
    boxes: [
      { label: "Team", value: p.orgName },
      { label: "Role", value: p.roleLabel },
      ...(p.personName === undefined ? [] : [{ label: "Changed by", value: p.personName }]),
    ],
    link: { label: "Open roles", host: "console", path: "/settings/roles" },
    footer: ["If you don't expect this change, ask your team's Super admin."],
  }),
});
