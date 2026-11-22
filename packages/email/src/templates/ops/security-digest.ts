// ops/security-digest (spec 08 §4.3): one message that stands for the security notices folded past
// a recipient's hourly allowance, so no notice is ever dropped ([SA-41]). One fixed line per
// template kind with its count, in Fin's words only, and one link to the right activity page. A
// digest is never folded itself.
import { z } from "zod";
import { type Box, defineTemplate, type Link } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY } from "../shared.ts";

const TEMPLATE_ID = /^[a-z][a-z-]{1,30}\/[a-z][a-z0-9-]{1,62}$/u;

export const securityDigest = defineTemplate({
  name: "security-digest",
  area: "ops",
  class: "security",
  subdomain: "auth",
  realm: "ops",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "Summaries of changes",
  params: z.strictObject({
    digestKey: z.string().regex(/^dig_[0-9a-f]{32}_[0-9]{10}$/u),
    realm: z.enum(["developer", "staff", "mixed"]),
    total: param.count.min(1),
    lines: z
      .array(z.strictObject({ template: z.string().regex(TEMPLATE_ID), count: param.count.min(1) }))
      .min(1)
      .max(60),
  }),
  sample: {
    // A keyed hash of 32 hex characters, written as a repeat so no ID-shaped literal is committed.
    digestKey: `dig_${"0f".repeat(16)}_2026112104`,
    realm: "developer",
    total: 3,
    lines: [
      { template: "identity/sign-in-methods-changed", count: 2 },
      { template: "identity/new-sign-in", count: 1 },
    ],
  },
  render: (p, ctx) => {
    const lines: Box[] = p.lines.map((line) => ({
      label: ctx.describe(line.template) ?? "Other changes",
      value: String(line.count),
    }));
    // One link, to the realm's own page; a mixed digest names none rather than two.
    const link: Link | undefined =
      p.realm === "developer"
        ? ACCOUNT_SECURITY
        : p.realm === "staff"
          ? { label: "Open Fin Admin", host: "admin", path: "/" }
          : undefined;
    return {
      subject: "Recent changes to your Fin account",
      heading: "Changes in the last hour",
      preview: "A summary of recent changes to your Fin account or team.",
      paragraphs: [
        `There were ${p.total} changes to your Fin account or team in the last hour.`,
        "We sent the first few on their own and gathered the rest here, so you still hear about every one.",
      ],
      boxes: lines,
      ...(link === undefined ? {} : { link }),
      footer: ["If you don't recognise any of these changes, review your account security now."],
    };
  },
});
