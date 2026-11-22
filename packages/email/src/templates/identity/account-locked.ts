// identity/account-locked (spec 02 §17.2): the authenticator lockout started (at most once a day).
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY, NOT_YOU_DEVELOPER, timeBox } from "../shared.ts";

export const accountLocked = defineTemplate({
  name: "account-locked",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Authenticator lockouts",
  params: z.strictObject({ userId: param.userId, time: param.time }),
  sample: { userId: "usr_01jd0000000000000000000000", time: "2026-11-21T04:30:00.000Z" },
  render: (p) => ({
    subject: "Authenticator codes are paused on your Fin account",
    heading: "Authenticator codes are paused",
    preview: "Too many wrong authenticator codes were entered, so they are paused for an hour.",
    paragraphs: [
      "Too many wrong authenticator codes were entered for your account, so authenticator codes are paused for an hour.",
      "You can still sign in with a passkey.",
    ],
    boxes: [timeBox("When", p.time)],
    link: ACCOUNT_SECURITY,
    footer: [NOT_YOU_DEVELOPER],
  }),
});
