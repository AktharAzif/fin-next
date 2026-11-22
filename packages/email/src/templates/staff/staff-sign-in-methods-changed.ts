// staff/staff-sign-in-methods-changed (spec 02 §17.3).
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { NOT_YOU_STAFF, timeBox } from "../shared.ts";

const WHAT = {
  passkey_added: "A passkey was added to your Fin Admin account.",
  passkey_removed: "A passkey was removed from your Fin Admin account.",
  authenticator_on: "An authenticator app was turned on for your Fin Admin account.",
  authenticator_off: "The authenticator app was turned off for your Fin Admin account.",
  signed_out_everywhere: "Your Fin Admin account was signed out everywhere except one browser.",
} as const;

type Kind = keyof typeof WHAT;
const KINDS = Object.keys(WHAT) as [Kind, ...Kind[]];

export const staffSignInMethodsChanged = defineTemplate({
  name: "staff-sign-in-methods-changed",
  area: "staff",
  class: "security",
  subdomain: "auth",
  realm: "staff",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Changes to how you sign in to Fin Admin",
  params: z.strictObject({ staffId: param.staffId, kind: z.enum(KINDS), time: param.time }),
  sample: {
    staffId: "stf_01jd0000000000000000000000",
    kind: "authenticator_on",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "Your Fin Admin sign-in methods changed",
    heading: "Your sign-in methods changed",
    preview: "There was a change to how you sign in to Fin Admin.",
    paragraphs: [WHAT[p.kind]],
    boxes: [timeBox("When", p.time)],
    footer: [NOT_YOU_STAFF],
  }),
});
