// orgs/invitation (spec 02 §9.3, §17.2): sent from notify.<zone>. The link carries the invitation's
// token in the fragment (`/invite#t=<token>`), the one link token a developer template may carry.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";

export const invitation = defineTemplate({
  name: "invitation",
  area: "orgs",
  class: "notice",
  subdomain: "notify",
  realm: "developer",
  secretBearing: true,
  bypassLimits: false,
  params: z.strictObject({
    invitationId: param.invitationId,
    orgId: param.orgId,
    token: param.invitationToken,
    orgName: param.orgName,
    roleLabel: param.roleLabel,
    personName: param.personName.optional(),
  }),
  sample: {
    invitationId: "inv_01jd0000000000000000000000",
    orgId: "org_01jd0000000000000000000000",
    token: "Abcdefghijklmnopqrstuvwxyz012345",
    orgName: "Example Payments",
    roleLabel: "Developer",
    personName: "Grace Hopper",
  },
  render: (p) => ({
    subject: "You're invited to a team on Fin",
    heading: "You're invited to a team on Fin",
    preview: "Open the invitation to see the team and join it.",
    paragraphs: [
      "You've been invited to join a team on Fin. Open the invitation to see it and to join.",
    ],
    boxes: [
      { label: "Team", value: p.orgName },
      { label: "Role", value: p.roleLabel },
      ...(p.personName === undefined ? [] : [{ label: "Invited by", value: p.personName }]),
    ],
    link: { label: "Open the invitation", host: "console", path: `/invite#t=${p.token}` },
    footer: [
      "If you don't expect this invitation, you can ignore it. Nothing happens unless you accept.",
    ],
  }),
});
