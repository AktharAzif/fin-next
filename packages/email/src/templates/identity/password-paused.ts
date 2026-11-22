// identity/password-paused (stretch 2; spec 02 §5.7): password sign-in for an address is paused after
// repeated wrong passwords from browsers the account does not know (at most once a day).
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY, timeBox } from "../shared.ts";

export const passwordPaused = defineTemplate({
  name: "password-paused",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Password sign-in pauses",
  params: z.strictObject({ userId: param.userId, time: param.time }),
  sample: { userId: "usr_01jd0000000000000000000000", time: "2026-11-21T04:30:00.000Z" },
  render: (p) => ({
    subject: "Password sign-in is paused on your Fin account",
    heading: "Password sign-in is paused",
    preview: "Too many wrong passwords were tried, so password sign-in is paused for a while.",
    paragraphs: [
      "Too many wrong passwords were tried for your account from browsers it doesn't know, so password sign-in is paused for a while.",
      "You can still sign in with a passkey or an emailed code.",
    ],
    boxes: [timeBox("When", p.time)],
    link: ACCOUNT_SECURITY,
    footer: ["If this wasn't you, consider changing your password once you are signed in."],
  }),
});
