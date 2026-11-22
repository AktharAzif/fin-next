// identity/sign-in-methods-changed (spec 02 §17.2): one template for every change to how a person
// signs in. The kind picks one of Fin's fixed sentences; nothing typed reaches the heading.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY, boxes, NOT_YOU_DEVELOPER, timeBox } from "../shared.ts";

const WHAT = {
  passkey_added: "A passkey was added to your account.",
  passkey_removed: "A passkey was removed from your account.",
  passkey_refused: "A passkey sign-in was refused because the passkey looked copied.",
  authenticator_on: "An authenticator app was turned on for your account.",
  authenticator_off: "The authenticator app was turned off for your account.",
  backup_codes_regenerated: "New backup codes were made. The old ones no longer work.",
  browser_trusted: "A browser was trusted, so it won't ask for a second factor for a while.",
  signed_out_everywhere: "Your account was signed out everywhere except one browser.",
  password_changed: "Your password was changed.",
  password_reset: "Your password was reset, and you were signed out everywhere.",
  google_linked: "A Google account was linked for signing in.",
  google_unlinked: "The Google account was unlinked.",
} as const;

type Kind = keyof typeof WHAT;
const KINDS = Object.keys(WHAT) as [Kind, ...Kind[]];

export const signInMethodsChanged = defineTemplate({
  name: "sign-in-methods-changed",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Changes to how you sign in",
  params: z.strictObject({
    userId: param.userId,
    kind: z.enum(KINDS),
    time: param.time,
    device: param.device.optional(),
  }),
  sample: {
    userId: "usr_01jd0000000000000000000000",
    kind: "passkey_added",
    time: "2026-11-21T04:30:00.000Z",
    device: "Chrome on Windows",
  },
  render: (p) => ({
    subject: "Your Fin sign-in methods changed",
    heading: "Your sign-in methods changed",
    preview: "There was a change to how you sign in to Fin.",
    paragraphs: [WHAT[p.kind]],
    boxes: boxes(
      p.device === undefined ? undefined : { label: "Browser", value: p.device },
      timeBox("When", p.time),
    ),
    link: ACCOUNT_SECURITY,
    footer: [NOT_YOU_DEVELOPER],
  }),
});
