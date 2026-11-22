// identity/new-sign-in (spec 02 §17.2): a working session from a browser the account does not know.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY, NOT_YOU_DEVELOPER, timeBox } from "../shared.ts";

export const newSignIn = defineTemplate({
  name: "new-sign-in",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Sign-ins from new browsers",
  params: z.strictObject({ userId: param.userId, device: param.device, time: param.time }),
  sample: {
    userId: "usr_01jd0000000000000000000000",
    device: "Safari on macOS",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "New sign-in to your Fin account",
    heading: "New sign-in to your account",
    preview: "Your Fin account was signed in to from a browser it hasn't seen before.",
    paragraphs: ["Your Fin account was signed in to from a browser it hasn't seen before."],
    boxes: [{ label: "Browser", value: p.device }, timeBox("When", p.time)],
    link: ACCOUNT_SECURITY,
    footer: [NOT_YOU_DEVELOPER],
  }),
});
