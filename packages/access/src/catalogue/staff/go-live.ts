// Fin Admin's Production access requests permissions (spec 02 §8.3, [SA-12]). The staff go-live
// area's fragment. Deciding asks for a second approver once a second staff member exists ([SA-39]);
// the route decides that, not the editor.
import type { GroupSpec } from "../../engine/types.ts";

export const goLive = {
  key: "golive",
  label: "Production access requests",
  permissions: [
    {
      key: "golive.read",
      label: "See Production access requests",
      description: "Requests, their answers and documents, and who acts next.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "Production access requests" },
    },
    {
      key: "golive.decide",
      label: "Decide Production access requests",
      description: "Approve, ask for changes or decline.",
      needs: ["golive.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "decide Production access requests", covers: "golive.read" },
    },
  ],
} as const satisfies GroupSpec;
