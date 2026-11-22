// The dashboard's Organisation settings permissions (spec 02 §8.2, [SA-11]). The organisation
// area's fragment. Deleting the organisation is Super admin only.
import type { GroupSpec } from "../../engine/types.ts";

export const organisation = {
  key: "organisation",
  label: "Organisation settings",
  permissions: [
    {
      key: "organization.update",
      label: "Rename the organisation",
      description: "The name people see in invitations and emails.",
      needs: [],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "rename the organisation" },
    },
    {
      key: "organization.delete",
      label: "Delete the organisation",
      description: "Close it and delete its data.",
      needs: [],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: true,
      summary: { does: "delete the organisation" },
    },
  ],
} as const satisfies GroupSpec;
