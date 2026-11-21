// The email area's events (spec 08 §4.1 to §4.3 and §7.2), written by packages/email's sender.
// email.sent and email.send_failed are in platform.ts, beside Phase 0's email-not-sent alert. The
// group G alerts these lines feed (spec 08 §7.8) come with the email area's alert fragment
// (L-SAT-05); until then each entry names the alerts it is owed (`owed`, listed in owed.ts with
// their lane and date).
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "email.folded",
    kind: "unit",
    level: "info",
    writtenBy: "worker's sender, for a security row past its recipient's hourly allowance",
    fields: { template: "string", class: "string", emailId: "string", digestKey: "string" },
    alerts: [],
  },
  {
    event: "email.budget_reached",
    kind: "failure",
    level: "warn",
    writtenBy:
      "worker's sender, when ordinary mail first reaches the security share, or a budget refuses a send",
    fields: {
      template: "string",
      class: "string",
      emailId: "string",
      scope: "string",
      share: "string",
      orgId: "string",
    },
    alerts: [],
    owed: ["email-budget-reached"],
  },
  {
    event: "email.security_unsent",
    kind: "failure",
    level: "error",
    writtenBy:
      "worker's sender, once for a security row that could not be sent (suppressed, failed, budget, invalid recipient)",
    fields: {
      template: "string",
      class: "string",
      emailId: "string",
      code: "string",
      reason: "string",
      final: "boolean",
    },
    alerts: [],
    owed: ["security-email-unsent"],
  },
];
