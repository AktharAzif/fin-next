// The audit area's lines (spec 08 §3.3, §3.5 and §7.2's own lines), written wherever an action
// records its event: packages/audit's recordAudit (the api tasks, run by migrate), each area's own
// recorder (packages/<area>/src/audit/record.ts, such as identity's for the sign-in, session,
// factor and staff enrolment events), the unit of work that meets the guard's FA010, and
// packages/audit's tripSwitch, which records a kill switch's trip. The group D alerts that watch
// them are in alerts/audit.json, or owed (owed.ts); the chain, anchor, check and journal lines of
// §3.14 come with the duties that write them.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "audit.write_failed",
    kind: "failure",
    level: "error",
    writtenBy:
      "recordAudit (packages/audit) when the database refuses the event with an FA SQLSTATE, with `auditEvent` and `sqlstate` (its input refusals and other database errors write no line); each area's recorder (packages/<area>/src/audit/record.ts) when its input check refuses the event (`sqlstate` `input`) or the database refuses it with any code (the SQLSTATE as it is, `unknown` when there is none). A name passed as `event` is lost to the envelope, which keeps `event` as the line's own name: a line without `auditEvent` carries `sqlstate` only, and the alert labels its event `other`. The action rolls back and answers 500 with the request ID only",
    // Spec 08 §7.2 names the audit event's field `event`; the envelope owns `event` (the line's own
    // name, MC-03), so the writers call it `auditEvent`; a name passed as `event` is dropped by an
    // envelope-wins sink. test/audit-alerts.test.ts reads every writer's fields, and holds
    // `writtenBy`, the runbook and the alert's check text to say what a line without it becomes.
    fields: { auditEvent: "string", sqlstate: "string" },
    alerts: ["audit-not-written"],
    // One incident per service, SQLSTATE and audit event: a refusal that stands (every later try
    // fails the same way) must never hide a later, different one, such as an FA011 or an FA002 on
    // an event no fragment gives the service (MC-04). The rule holds each label to a closed set (for
    // the event, AUDIT_EVENTS and the area recorders' own events) and gives any other value, a
    // missing one included, the one label `other`: lines without `auditEvent` share it, and so share
    // one incident per service and SQLSTATE.
    seriesBy: ["service", "sqlstate", "auditEvent"],
  },
  {
    event: "database.audit_guard",
    kind: "security",
    level: "error",
    writtenBy:
      "the unit of work (packages/db, and identity's own), when a commit is refused with FA010: a write to a critical table came without its event",
    fields: { table: "string" },
    alerts: [],
    // It lands with its runbook, docs/runbooks/audit-guard.md.
    owed: ["audit-guard"],
  },
  {
    event: "switch.tripped",
    kind: "security",
    level: "warn",
    writtenBy:
      "packages/audit's tripSwitch, after ops.trip_switch() sets a kill switch on and records its audit event (spec 08 §7.2): the switch and the reason code",
    fields: { switch: "string", reasonCode: "string" },
    alerts: [],
    owed: ["money-switch-tripped"],
    noAlert: "No Phase 0 code calls tripSwitch yet",
  },
];
