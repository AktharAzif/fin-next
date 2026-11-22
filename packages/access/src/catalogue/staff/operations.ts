// Fin Admin's Operations permission: the kill switches (spec 02 §8.3, [SA-12]). The staff
// operations area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const operations = {
  key: "operations",
  label: "Operations",
  permissions: [
    {
      key: "switches.manage",
      label: "Use the kill switches",
      description: "Stop or restart one kind of work at once.",
      needs: [],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "use the kill switches" },
    },
  ],
} as const satisfies GroupSpec;
