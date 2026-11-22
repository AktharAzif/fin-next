// Fin Admin's Audit permission (spec 02 §8.3, [SA-12]). The staff audit area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const audit = {
  key: "audit",
  label: "Audit",
  permissions: [
    {
      key: "audit.read",
      label: "See the audit log",
      description: "Everything staff and the system did, newest first.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "the audit log" },
    },
  ],
} as const satisfies GroupSpec;
