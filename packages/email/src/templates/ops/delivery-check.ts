// ops/delivery-check (spec 01 §8.5, S0-09): the worker's daily and per-release proof that the outbox,
// the sender and Cloudflare Email Sending deliver to the seed inbox. No code, no personal data.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { finId, param } from "../../params.ts";
import { timeBox } from "../shared.ts";

export const deliveryCheck = defineTemplate({
  name: "delivery-check",
  area: "ops",
  class: "ops",
  subdomain: "auth",
  realm: "ops",
  secretBearing: false,
  bypassLimits: false,
  params: z.strictObject({
    checkId: finId("job"),
    release: param.release,
    trigger: z.enum(["release", "daily"]),
    time: param.time,
  }),
  sample: {
    checkId: "job_01jd0000000000000000000000",
    release: "0123456789abcdef0123456789abcdef01234567",
    trigger: "daily",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p, ctx) => ({
    subject: "Fin delivery check",
    heading: "Fin delivery check",
    preview: "Fin's email is reaching this inbox. No action is needed.",
    paragraphs: [
      "This message proves that Fin's outbox, its sender and Cloudflare Email Sending are working.",
      "No action is needed. If these messages stop arriving, the email-not-sent alert should already have fired.",
    ],
    boxes: [
      { label: "Environment", value: ctx.environment },
      { label: "Release", value: p.release.slice(0, 12) },
      {
        label: "Sent because of",
        value: p.trigger === "release" ? "a new release" : "the daily check",
      },
      { label: "Check", value: p.checkId },
      timeBox("Queued at", p.time),
    ],
  }),
});
