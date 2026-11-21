// orgs/member-role-changed (spec 02 §17.2): to the person and every Super admin. Bypasses the digest.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { TEAM } from "../shared.ts";

export const memberRoleChanged = defineTemplate({
  name: "member-role-changed",
  area: "orgs",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "Role changes in your team",
  params: z.strictObject({
    orgId: param.orgId,
    userId: param.userId,
    audience: z.enum(["person", "admins"]),
    orgName: param.orgName,
    personName: param.personName.optional(),
    roleLabel: param.roleLabel,
    previousRoleLabel: param.roleLabel.optional(),
  }),
  sample: {
    orgId: "org_01jd0000000000000000000000",
    userId: "usr_01jd0000000000000000000000",
    audience: "person",
    orgName: "Example Payments",
    roleLabel: "Admin",
    previousRoleLabel: "Developer",
  },
  render: (p) => ({
    subject: "A role changed in your team on Fin",
    heading: "A role changed",
    preview: "Someone's role in your team on Fin changed.",
    paragraphs: [
      p.audience === "person"
        ? "Your role in a team on Fin changed. What you can see and do there has changed with it."
        : "A member's role in your team changed. You are told because you are a Super admin.",
    ],
    boxes: [
      { label: "Team", value: p.orgName },
      ...(p.personName === undefined ? [] : [{ label: "Person", value: p.personName }]),
      ...(p.previousRoleLabel === undefined
        ? []
        : [{ label: "Previous role", value: p.previousRoleLabel }]),
      { label: "New role", value: p.roleLabel },
    ],
    link: TEAM,
    footer: ["If you don't expect this change, ask your team's Super admin."],
  }),
});
