// The reset's security notice as the admin API stand-in puts it in the email sink (test target only):
// rendered by @fin/email's own `staff/staff-factors-reset` template and layout, so a journey reads
// the words the worker would send (spec 02 §17.3), never a copy of them. Its parameters are what
// @fin/staff's resetStaffFactors queues: the member's ID and the audience, nothing typed, no code.
// @fin/email is not one of Fin Admin's dependencies, so its two files are imported by path.
import { renderTemplate } from "../../../../packages/email/src/render.ts";
import { staffFactorsReset } from "../../../../packages/email/src/templates/staff/staff-factors-reset.ts";

export const RESET_TEMPLATE = "staff/staff-factors-reset";

/**
 * Fin's ID shape for one of the stand-in's (`stf_` and 20 hex digits, all Crockford base32): padded
 * to 26 characters. The template checks the shape and never shows the ID.
 */
export function finShapedId(standInId: string): string {
  const [prefix = "", body = ""] = standInId.split("_");
  return `${prefix}_${body.toLowerCase().padEnd(26, "0").slice(0, 26)}`;
}

/** The sink's message body for one recipient of the reset notice. */
export function factorsResetNotice(input: {
  to: string;
  audience: "person" | "admins";
  staffId: string;
  /** The admin host's origin, the one link the Admins' copy carries. */
  admin: string;
}) {
  const rendered = renderTemplate(
    staffFactorsReset,
    { staffId: finShapedId(input.staffId), audience: input.audience },
    { recipient: input.to, environment: "ci", describe: () => undefined },
    { admin: input.admin },
  );
  return {
    from: "Fin <account-security@example.net>",
    to: [input.to],
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    template: RESET_TEMPLATE,
    category: "security",
  };
}
