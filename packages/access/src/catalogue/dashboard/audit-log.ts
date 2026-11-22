// The dashboard's Audit log permission (spec 02 §8.2, [SA-11]). The audit log area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const auditLog = {
  key: "audit_log",
  label: "Audit log",
  permissions: [
    {
      key: "auditLog.read",
      label: "See the audit log",
      description: "Who did what in this organisation, and when.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "the audit log" },
    },
  ],
} as const satisfies GroupSpec;
