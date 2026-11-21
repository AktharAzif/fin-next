// identity/confirm-email (spec 02 §5.1, §17.2): the code that proves the mailbox at sign-up.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { codeFragment, MINUTE_MS } from "../shared.ts";

export const confirmEmail = defineTemplate({
  name: "confirm-email",
  area: "identity",
  class: "code",
  subdomain: "auth",
  realm: "developer",
  secretBearing: true,
  bypassLimits: false,
  codeTtlMs: 15 * MINUTE_MS,
  params: z.strictObject({ code: param.code }),
  sample: { code: "87654321" },
  render: (p, ctx) => ({
    subject: "Confirm your email for Fin",
    heading: "Confirm your email",
    preview: "Use this code to finish creating your Fin account.",
    paragraphs: [
      "Enter this code to finish creating your Fin account, or press the button in the browser where you signed up.",
      "The code works once, for 15 minutes.",
    ],
    code: p.code,
    link: {
      label: "Confirm your email",
      host: "console",
      path: `/verify-email${codeFragment(ctx.recipient, p.code)}`,
    },
    footer: [
      "If you didn't sign up for Fin, you can ignore this email. No account is made without the code.",
    ],
  }),
});
