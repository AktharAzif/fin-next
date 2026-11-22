// identity/account-recovery-started (Sunday spill; spec 02 §6.8): recovery of a person's account
// began. Sent to the person and to the Super admins named in spec 08 §4.4.
import { z } from "zod";
import { defineTemplate } from "../../classes.ts";
import { param } from "../../params.ts";
import { ACCOUNT_SECURITY, timeBox } from "../shared.ts";

export const accountRecoveryStarted = defineTemplate({
  name: "account-recovery-started",
  area: "identity",
  class: "security",
  subdomain: "auth",
  realm: "developer",
  secretBearing: false,
  bypassLimits: false,
  digestLine: "Account recoveries started",
  params: z.strictObject({
    userId: param.userId,
    audience: z.enum(["person", "admins"]),
    personName: param.personName.optional(),
    time: param.time,
  }),
  sample: {
    userId: "usr_01jd0000000000000000000000",
    audience: "admins",
    personName: "Ada Lovelace",
    time: "2026-11-21T04:30:00.000Z",
  },
  render: (p) => ({
    subject: "Account recovery started on Fin",
    heading: "Account recovery started",
    preview: "Recovery of a Fin account has started.",
    paragraphs: [
      p.audience === "person"
        ? "Recovery of your Fin account has started. Until it finishes, your sign-in methods may change."
        : "Recovery of a team member's Fin account has started. You are told because you are a Super admin.",
    ],
    boxes: [
      ...(p.personName === undefined ? [] : [{ label: "Account", value: p.personName }]),
      timeBox("When", p.time),
    ],
    link: ACCOUNT_SECURITY,
    footer: ["If you don't expect this recovery, contact Fin support straight away."],
  }),
});
