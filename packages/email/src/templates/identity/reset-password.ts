// identity/reset-password (stretch 2; spec 02 §5.7): the code that resets a password.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { codeFragment, IGNORE_CODE, MINUTE_MS } from "../shared.ts";

export const resetPassword = defineTemplate({
  name: "reset-password",
  area: "identity",
  class: "code",
  subdomain: "auth",
  realm: "developer",
  secretBearing: true,
  bypassLimits: false,
  codeTtlMs: 15 * MINUTE_MS,
  params: z.strictObject({ code: param.code }),
  sample: { code: "24681357" },
  render: (p, ctx) => ({
    subject: "Reset your Fin password",
    heading: "Reset your password",
    preview: "Use this code to choose a new password. It works for 15 minutes.",
    paragraphs: [
      "Enter this code to choose a new password. Resetting it signs you out everywhere.",
      "The code works once, for 15 minutes.",
    ],
    code: p.code,
    link: {
      label: "Choose a new password",
      host: "console",
      path: `/reset-password/new${codeFragment(ctx.recipient, p.code)}`,
    },
    footer: [IGNORE_CODE],
  }),
});
