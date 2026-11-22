// identity/account-recovery-finished (Sunday spill; spec 02 §6.8): recovery finished or was cancelled.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY, timeBox } from "../shared.ts";

export const accountRecoveryFinished = defineTemplate({
  name: "account-recovery-finished",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Account recoveries finished or cancelled",
  params: z.strictObject({
    userId: param.userId,
    audience: z.enum(["person", "admins"]),
    outcome: z.enum(["finished", "cancelled"]),
    personName: param.personName.optional(),
    time: param.time,
  }),
  sample: {
    userId: "usr_01jd0000000000000000000000",
    audience: "person",
    outcome: "finished",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "Account recovery ended on Fin",
    heading: p.outcome === "finished" ? "Account recovery finished" : "Account recovery cancelled",
    preview: "An account recovery on Fin has ended.",
    paragraphs: [
      p.outcome === "finished"
        ? "The account recovery finished. The account's old sign-in methods no longer work."
        : "The account recovery was cancelled. Nothing about the account was changed.",
    ],
    boxes: [
      ...(p.personName === undefined ? [] : [{ label: "Account", value: p.personName }]),
      timeBox("When", p.time),
    ],
    link: ACCOUNT_SECURITY,
    footer: ["If you don't expect this, contact Fin support straight away."],
  }),
});
