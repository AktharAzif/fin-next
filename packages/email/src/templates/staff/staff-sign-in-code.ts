// staff/staff-sign-in-code (spec 02 §10.5, §17.3): a staff code, alive 10 minutes. No link: staff type
// the code on Fin Admin's sign-in page, behind Access, so a mail scanner has nothing to open.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { MINUTE_MS, NOT_YOU_STAFF } from "../shared.ts";

export const staffSignInCode = defineTemplate({
  name: "staff-sign-in-code",
  area: "staff",
  class: "code",
  subdomain: "auth",
  realm: "staff",
  secretBearing: true,
  bypassLimits: false,
  codeTtlMs: 10 * MINUTE_MS,
  params: z.strictObject({ code: param.code }),
  sample: { code: "13572468" },
  render: (p) => ({
    subject: "Your Fin Admin sign-in code",
    heading: "Sign in to Fin Admin",
    preview: "Use this code to sign in to Fin Admin. It works for 10 minutes.",
    paragraphs: ["Enter this code on Fin Admin's sign-in page. It works once, for 10 minutes."],
    code: p.code,
    footer: [`If you didn't ask for this code, don't use it. ${NOT_YOU_STAFF}`],
  }),
});
