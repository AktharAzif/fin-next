// Fin Admin's Developer accounts permission (spec 02 §8.3, [SA-12], [SA-30]). The staff developer
// accounts area's fragment. Admin-only.
import type { GroupSpec } from "../../engine/types.ts";

export const accounts = {
  key: "accounts",
  label: "Developer accounts",
  permissions: [
    {
      key: "accounts.recover",
      label: "Recover developer accounts",
      description: "Reset a developer's second factors after an identity check.",
      needs: ["organisations.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: true,
      summary: { does: "recover developer accounts" },
    },
  ],
} as const satisfies GroupSpec;
