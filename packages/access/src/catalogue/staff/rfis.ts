// Fin Admin's Requests for information permissions (spec 02 §8.3, [SA-12]). The staff requests
// for information area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const rfis = {
  key: "rfis",
  label: "Requests for information",
  permissions: [
    {
      key: "rfis.read",
      label: "See requests for information",
      description: "Requests, answers and what is overdue.",
      needs: ["customers.read"],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "requests for information" },
    },
    {
      key: "rfis.manage",
      label: "Handle requests for information",
      description: "Ask, change, accept, ask again and withdraw.",
      needs: ["rfis.read"],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "handle requests for information", covers: "rfis.read" },
    },
  ],
} as const satisfies GroupSpec;
