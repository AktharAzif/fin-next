// The staff area's lines (spec 02 §18.1): Fin Admin's people, written by identity's staff realm
// (sign-in, enrolment) and by packages/staff (the guard, the member changes, the Access drift
// duty), through the same line port. access.keys_unavailable and access.jwt_refused, the API
// half's front door, are in web-host.ts. The alerts spec 02 §18.2 names for these lines come with
// the staff area's alert fragment (alerts/staff.json), which has not landed; until then each entry
// names the alerts it is owed (`owed`, listed in owed.ts with their lane and date), or why none.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "staff.not_listed",
    kind: "security",
    level: "warn",
    writtenBy:
      "identity's staff realm (a code request) and the staff guard (a request), for an Access identity that is no active or pending member",
    fields: { reason: "string" },
    alerts: [],
    owed: ["admin-staff-refused"],
  },
  {
    event: "staff.access_mismatch",
    kind: "security",
    level: "warn",
    writtenBy:
      "identity's staff realm and the staff guard and viewer, when the session's member is not the verified Access identity; the session ends (spec 02 §10.5)",
    fields: { staffId: "string" },
    alerts: [],
    owed: ["admin-access-mismatch"],
  },
  {
    event: "staff.enrolment_refused",
    kind: "security",
    level: "warn",
    writtenBy:
      "identity's staff enrolment, for a wrong, expired, used or void code, or a factor added outside the enrolment window (spec 02 §6.5)",
    fields: { staffId: "string", reason: "string" },
    alerts: [],
    owed: ["staff-enrolment-refused"],
  },
  {
    event: "staff.enrolled",
    kind: "security",
    level: "warn",
    writtenBy: "identity's staff realm, when a member enrols their first factor (spec 02 §6.5)",
    fields: { staffId: "string", method: "string" },
    alerts: [],
    owed: ["staff-enrolled"],
  },
  {
    event: "staff.changed",
    kind: "security",
    level: "warn",
    writtenBy:
      "packages/staff's member changes: a member added, their role changed, removed, or their factors reset (spec 02 §10.2)",
    fields: { kind: "string", staffId: "string", actorId: "string" },
    alerts: [],
    owed: ["staff-changed"],
  },
  {
    event: "staff.permission_refused",
    kind: "security",
    level: "warn",
    writtenBy:
      "the staff guard, for a request whose member's role lacks the route's permission (403, reason staff.permission)",
    fields: { staffId: "string", permission: "string" },
    alerts: [],
    noAlert:
      "spec 02 §18.2 names no alert for it: the server refuses the request before its handler, Fin Admin's pages only mirror the check, and the line counts the refusals by permission for the area's panels",
  },
  {
    event: "access.drift",
    kind: "security",
    level: "error",
    writtenBy:
      "the Access drift duty (packages/staff), when Fin Admin's Access allow list and the staff table differ; counts only (spec 02 §10.9)",
    fields: {
      accessCount: "number",
      staffCount: "number",
      missing: "number",
      extra: "number",
      domains: "number",
      other: "number",
    },
    alerts: [],
    owed: ["admin-access-drift"],
  },
];
