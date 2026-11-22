// identity/session-ended (spec 02 §17.2): five wrong tries at a step-up ended the session.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY, boxes, NOT_YOU_DEVELOPER, timeBox } from "../shared.ts";

export const sessionEnded = defineTemplate({
  name: "session-ended",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Sessions ended after failed checks",
  params: z.strictObject({
    userId: param.userId,
    time: param.time,
    device: param.device.optional(),
  }),
  sample: {
    userId: "usr_01jd0000000000000000000000",
    time: "2026-11-21T04:30:00.000Z",
    device: "Firefox on Linux",
  },
  render: (p) => ({
    subject: "A Fin session was signed out",
    heading: "A session was signed out",
    preview: "A session was signed out after too many failed checks.",
    paragraphs: [
      "One of your sessions was signed out after five failed attempts to confirm it was you.",
    ],
    boxes: boxes(
      p.device === undefined ? undefined : { label: "Browser", value: p.device },
      timeBox("When", p.time),
    ),
    link: ACCOUNT_SECURITY,
    footer: [NOT_YOU_DEVELOPER],
  }),
});
