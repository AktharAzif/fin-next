// orgs/member-removed (spec 02 §9.4, §17.2): to the person removed, and to the remaining Super admins
// and Admins with what was rolled at once and what keeps working for the hour. Bypasses the digest.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { TEAM } from "../shared.ts";

export const memberRemoved = defineTemplate({
  name: "member-removed",
  area: "orgs",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "People removed from your team",
  params: z.strictObject({
    orgId: param.orgId,
    userId: param.userId,
    audience: z.enum(["person", "admins"]),
    orgName: param.orgName,
    personName: param.personName.optional(),
    rolledNow: param.count.optional(),
    rollingWithinHour: param.count.optional(),
  }),
  sample: {
    orgId: "org_01jd0000000000000000000000",
    userId: "usr_01jd0000000000000000000000",
    audience: "admins",
    orgName: "Example Payments",
    personName: "Grace Hopper",
    rolledNow: 2,
    rollingWithinHour: 1,
  },
  render: (p) =>
    p.audience === "person"
      ? {
          subject: "You were removed from a team on Fin",
          heading: "You were removed from a team",
          preview: "You no longer have access to a team on Fin.",
          paragraphs: ["You were removed from a team on Fin and no longer have access to it."],
          boxes: [{ label: "Team", value: p.orgName }],
          footer: ["If you think this is a mistake, ask the team's Super admin."],
        }
      : {
          subject: "Someone was removed from your team on Fin",
          heading: "Someone was removed from your team",
          preview: "A member was removed from your team, and their credentials were rolled.",
          paragraphs: [
            "A member was removed from your team. Credentials they could use were rolled; some keep working for up to an hour so your integrations can switch over.",
          ],
          boxes: [
            { label: "Team", value: p.orgName },
            ...(p.personName === undefined ? [] : [{ label: "Person", value: p.personName }]),
            { label: "Rolled at once", value: String(p.rolledNow ?? 0) },
            { label: "Working for up to an hour", value: String(p.rollingWithinHour ?? 0) },
          ],
          link: TEAM,
          footer: ["If you don't expect this, check your team's activity in the audit log."],
        },
});
