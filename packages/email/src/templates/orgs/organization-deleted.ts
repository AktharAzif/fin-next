// orgs/organization-deleted (spec 02 §17.2): to every member.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { timeBox } from "../shared.ts";

export const organizationDeleted = defineTemplate({
  name: "organization-deleted",
  area: "orgs",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Teams deleted",
  params: z.strictObject({
    orgId: param.orgId,
    orgName: param.orgName,
    personName: param.personName.optional(),
    time: param.time,
  }),
  sample: {
    orgId: "org_01jd0000000000000000000000",
    orgName: "Example Payments",
    personName: "Grace Hopper",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "A team you belong to was deleted on Fin",
    heading: "A team was deleted",
    preview: "A team you were a member of on Fin was deleted.",
    paragraphs: [
      "A team you were a member of was deleted. Its API keys and webhooks no longer work.",
    ],
    boxes: [
      { label: "Team", value: p.orgName },
      ...(p.personName === undefined ? [] : [{ label: "Deleted by", value: p.personName }]),
      timeBox("When", p.time),
    ],
    footer: ["If you don't expect this, contact Fin support straight away."],
  }),
});
