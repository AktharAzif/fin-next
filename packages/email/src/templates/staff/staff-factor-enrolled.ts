// staff/staff-factor-enrolled (spec 02 §17.3): a pending member enrolled a first factor; to every Admin.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { NOT_YOU_STAFF, STAFF, timeBox } from "../shared.ts";

export const staffFactorEnrolled = defineTemplate({
  name: "staff-factor-enrolled",
  area: "staff",
  class: "security",
  subdomain: "auth",
  realm: "staff",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Staff who finished enrolling",
  params: z.strictObject({
    staffId: param.staffId,
    personName: param.personName.optional(),
    factor: z.enum(["passkey", "authenticator"]),
    time: param.time,
  }),
  sample: {
    staffId: "stf_01jd0000000000000000000000",
    personName: "Katherine Johnson",
    factor: "passkey",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "A staff member finished enrolling in Fin Admin",
    heading: "A staff member finished enrolling",
    preview: "A pending staff member set up their first sign-in factor.",
    paragraphs: [
      p.factor === "passkey"
        ? "A pending staff member set up a passkey and can now use Fin Admin."
        : "A pending staff member set up an authenticator app and can now use Fin Admin.",
    ],
    boxes: [
      ...(p.personName === undefined ? [] : [{ label: "Staff member", value: p.personName }]),
      timeBox("When", p.time),
    ],
    link: STAFF,
    footer: [`If you don't expect this, remove them from Staff. ${NOT_YOU_STAFF}`],
  }),
});
