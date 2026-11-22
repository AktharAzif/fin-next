// staff/staff-switch-changed (spec 02 §17.3): a kill switch was set or cleared; to every Admin.
// Bypasses the digest.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { NOT_YOU_STAFF } from "../shared.ts";

export const staffSwitchChanged = defineTemplate({
  name: "staff-switch-changed",
  area: "staff",
  class: "security",
  subdomain: "auth",
  realm: "staff",
  secretBearing: false,
  bypassLimits: true,
  digestLine: "Kill switches set or cleared",
  params: z.strictObject({
    // The switch's name as ops.kill_switch checks it (spec 01 §6.10): a code, never typed text.
    switch: z
      .string()
      .regex(/^[a-z][a-z_]*(:[a-z0-9][a-z0-9_-]{0,62})?$/u)
      .max(96),
    state: z.enum(["on", "off"]),
    changedBy: param.personName.optional(),
    time: param.time,
  }),
  sample: {
    switch: "live_money",
    state: "on",
    changedBy: "Dorothy Vaughan",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "A kill switch changed in Fin Admin",
    heading: "A kill switch changed",
    preview: "A kill switch was set or cleared in Fin Admin.",
    paragraphs: [
      p.state === "on"
        ? "A kill switch was set. The work it guards is stopped until it is cleared."
        : "A kill switch was cleared. The work it guards has started again.",
    ],
    boxes: [
      { label: "Switch", value: p.switch },
      { label: "State", value: p.state === "on" ? "On (stopped)" : "Off (running)" },
      ...(p.changedBy === undefined ? [] : [{ label: "Changed by", value: p.changedBy }]),
    ],
    link: { label: "Open switches", host: "admin", path: "/switches" },
    footer: [NOT_YOU_STAFF],
  }),
});
