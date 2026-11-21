// The audit area's lines (spec 08 §3.3, §3.5 and §7.2's own lines), written wherever an action
// records its event: packages/audit's recordAudit (the api tasks, run by migrate), identity's
// recorder for the sign-in, organisation and staff events, and the unit of work that meets the
// guard's FA010, and packages/audit's tripSwitch, which records a kill switch's trip. The group D
// alerts that watch them are in alerts/audit.json, or owed (owed.ts); the chain, anchor, check and
// journal lines of §3.14 come with the duties that write them.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "audit.write_failed",
    kind: "failure",
    level: "error",
    writtenBy:
      "recordAudit (packages/audit, and identity's recorder), when the database refuses the event (an FA SQLSTATE) or the input check refuses it; the action rolls back and answers 500 with the request ID only",
    // Spec 08 §7.2 names the audit event's field `event`; the envelope owns `event` (the line's own
    // name, MC-03), so the writer calls it `auditEvent`.
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
