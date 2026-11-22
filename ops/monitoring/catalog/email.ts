// The email area's events (spec 08 §4.1 to §4.3 and §7.2), written by packages/email's sender.
// email.sent and email.send_failed are in platform.ts, beside Phase 0's email-not-sent alert. The
// group G alerts these lines feed (spec 08 §7.8) are in the email area's alert fragment
// (alerts/email.json), with email-delivery-stalled, which no text of the plan names: the name is
// proposed by the lane that added the line, for the steward to confirm or change.
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
    alerts: ["email-budget-reached"],
  },
  {
    event: "email.security_unsent",
    kind: "failure",
    level: "error",
    writtenBy:
      "worker's sender, for a security row that could not be sent (suppressed, failed, budget, invalid recipient), once while it waits and once if it ends; identity's email.enqueue() on console and admin, for a notice that could not be queued (not_allowed, enqueue_failed)",
    fields: {
      template: "string",
      class: "string",
      emailId: "string",
      code: "string",
      reason: "string",
      final: "boolean",
    },
    alerts: ["security-email-unsent"],
  },
  {
    event: "email.delivery_stalled",
    kind: "failure",
    level: "error",
    writtenBy:
      "worker's sender, when a database step of the delivery path (step: claim, row, digest, age or sweep) stalls: a lock wait that ran out (code pg_55P03, SQLSTATE 55P03 after the login's lock timeout) or a connection the pool could not open or hand out in time (code connect_timeout); with the row's emailId for a row. Never the error's words. The error then goes on as before, to the loop's failed job.run or the row's email.send_failed",
    fields: { step: "string", code: "string", emailId: "string" },
    alerts: ["email-delivery-stalled"],
  },
];
