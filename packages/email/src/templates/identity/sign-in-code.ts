// identity/sign-in-code (spec 02 §5.2, §17.2): an 8-digit code asked on sign-in, alive 15 minutes.
// The link carries the address and the code in the fragment; the page never submits by itself.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { codeFragment, IGNORE_CODE, MINUTE_MS } from "../shared.ts";

export const signInCode = defineTemplate({
  name: "sign-in-code",
  area: "identity",
  class: "code",
  subdomain: "auth",
  realm: "developer",
  secretBearing: true,
  bypassLimits: false,
  codeTtlMs: 15 * MINUTE_MS,
  params: z.strictObject({ code: param.code }),
  sample: { code: "12345678" },
  render: (p, ctx) => ({
    subject: "Your Fin sign-in code",
    heading: "Sign in to Fin",
    preview: "Use this code to sign in. It works for 15 minutes.",
    paragraphs: [
      "Enter this code on the sign-in page, or press the button in the browser where you asked for it.",
      "The code works once, for 15 minutes.",
    ],
    code: p.code,
    link: {
      label: "Sign in",
      host: "console",
      path: `/sign-in/code${codeFragment(ctx.recipient, p.code)}`,
    },
    footer: [IGNORE_CODE],
  }),
});
