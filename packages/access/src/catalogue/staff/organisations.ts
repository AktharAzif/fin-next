// Fin Admin's Organisations permissions (spec 02 §8.3, [SA-12]). The staff organisations area's
// fragment. Restoring Production access asks for a second approver once a second staff member
// exists; the route decides that, not the editor.
import type { GroupSpec } from "../../engine/types.ts";

export const organisations = {
  key: "organisations",
  label: "Organisations",
  permissions: [
    {
      key: "organisations.read",
      label: "See organisations",
      description: "Organisations, their members and their Production status.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "organisations" },
    },
    {
      key: "organisations.pause",
      label: "Pause and restore Production access",
      description: "Stop an organisation's Production keys, and turn them back on.",
      needs: ["organisations.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "pause and restore Production access" },
    },
    {
      key: "organisations.approvals",
      label: "Change customer approvals",
      description: 'Turn "Fin approves each customer" on or off.',
      needs: ["organisations.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "change customer approvals" },
    },
  ],
} as const satisfies GroupSpec;
