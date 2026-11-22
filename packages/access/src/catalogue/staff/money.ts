// Fin Admin's Money permissions (spec 02 §8.3, [SA-12], [MO-13]). The staff money area's fragment.
// Operating money never sends a payout.
import type { GroupSpec } from "../../engine/types.ts";

export const money = {
  key: "money",
  label: "Money",
  permissions: [
    {
      key: "money.read",
      label: "See money",
      description: "Provider status, transfers and reconciliation breaks.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "money" },
    },
    {
      key: "money.operate",
      label: "Operate money",
      description: "Retry, close and resolve breaks. Never send a payout.",
      needs: ["money.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "operate money" },
    },
  ],
} as const satisfies GroupSpec;
