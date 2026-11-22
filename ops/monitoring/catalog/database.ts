// The database area's security events that Phase 0's alerts/database.json watches (spec 08 §7.2's
// own lines). The audit lines, the guard's database.audit_guard included, are in audit.ts beside
// alerts/audit.json; the probe's readings are fields of job.run (platform.ts). This file holds only
// what the Phase 0 database alerts name.
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "database.privileged_login",
    kind: "security",
    level: "warn",
    writtenBy: "worker's matcher of ops.privileged_login against the registered runs",
    fields: { role: "string", registered: "boolean" },
    alerts: ["privileged-login"],
  },
  {
    event: "database.grants_drift",
    kind: "security",
    level: "error",
    writtenBy: "the hourly grants drift check",
    fields: { role: "string", missing: "number", extra: "number" },
    alerts: ["grants-drift"],
  },
];
