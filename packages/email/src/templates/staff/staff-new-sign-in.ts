// staff/staff-new-sign-in (spec 02 §17.3): every staff sign-in that reaches `aal2`.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { boxes, NOT_YOU_STAFF, timeBox } from "../shared.ts";

export const staffNewSignIn = defineTemplate({
  name: "staff-new-sign-in",
  area: "staff",
  class: "security",
  subdomain: "auth",
  realm: "staff",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Fin Admin sign-ins",
  params: z.strictObject({
    staffId: param.staffId,
    device: param.device.optional(),
    time: param.time,
  }),
  sample: {
    staffId: "stf_01jd0000000000000000000000",
    device: "Safari on macOS",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "New sign-in to Fin Admin",
    heading: "New sign-in to Fin Admin",
    preview: "Your Fin Admin account was signed in to.",
    paragraphs: ["Your Fin Admin account was signed in to with a second factor."],
    boxes: boxes(
      p.device === undefined ? undefined : { label: "Browser", value: p.device },
      timeBox("When", p.time),
    ),
    footer: [NOT_YOU_STAFF],
  }),
});
