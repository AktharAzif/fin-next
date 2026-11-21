// orgs/member-joined (spec 02 §17.2): to the inviter and every Super admin. Bypasses the digest.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { TEAM } from "../shared.ts";

export const memberJoined = defineTemplate({
  name: "member-joined",
  area: "orgs",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "People who joined your team",
  params: z.strictObject({
    orgId: param.orgId,
    userId: param.userId,
    orgName: param.orgName,
    personName: param.personName.optional(),
    roleLabel: param.roleLabel,
  }),
  sample: {
    orgId: "org_01jd0000000000000000000000",
    userId: "usr_01jd0000000000000000000000",
    orgName: "Example Payments",
    personName: "Grace Hopper",
    roleLabel: "Developer",
  },
  render: (p) => ({
    subject: "Someone joined your team on Fin",
    heading: "Someone joined your team",
    preview: "An invitation to your team was accepted.",
    paragraphs: ["An invitation to your team was accepted. They now have the role shown here."],
    boxes: [
      { label: "Team", value: p.orgName },
      ...(p.personName === undefined ? [] : [{ label: "Person", value: p.personName }]),
      { label: "Role", value: p.roleLabel },
    ],
    link: TEAM,
    footer: ["If you don't expect this, remove them from the team and check who can invite."],
  }),
});
