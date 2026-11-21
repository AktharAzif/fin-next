// The audit area's lines (spec 08 §3.3, §3.5 and §7.2's own lines), written wherever an action
// records its event: packages/audit's recordAudit (the api tasks, run by migrate), identity's
// recorder for the sign-in, organisation and staff events, and the unit of work that meets the
// guard's FA010. The group D alerts that watch them are in alerts/audit.json; the chain, anchor,
// check and journal lines of §3.14 come with the duties that write them.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "audit.write_failed",
    kind: "failure",
    level: "error",
    writtenBy:
      "recordAudit (packages/audit) when the database refuses the event with an FA SQLSTATE, with `auditEvent` and `sqlstate` (its input refusals and other database errors write no line); identity's recorder when its input check refuses the event (`sqlstate` `input`) or the database refuses it with any code (the SQLSTATE as it is, `unknown` when there is none), but it passes the event's name as `event`, which the envelope keeps as the line's own name, so its lines carry `sqlstate` only until identity renames the field. The action rolls back and answers 500 with the request ID only",
    // Spec 08 §7.2 names the audit event's field `event`; the envelope owns `event` (the line's own
    // name, MC-03), so packages/audit calls it `auditEvent`. Identity's recorder still passes
    // `event`, which an envelope-wins sink drops; test/audit-alerts.test.ts holds `writtenBy` and
    // the runbook to the fields each writer passes.
    fields: { auditEvent: "string", sqlstate: "string" },
    alerts: ["audit-not-written"],
  },
  {
    event: "database.audit_guard",
    kind: "security",
    level: "error",
    writtenBy:
      "the unit of work (packages/db, and identity's own), when a commit is refused with FA010: a write to a critical table came without its event",
    fields: { table: "string" },
    alerts: [],
    noAlert:
      "audit-guard (P, spec 08 §3.14 group D) is owed by this area's alert fragment, with its runbook audit-guard.md, which have not landed",
  },
];
