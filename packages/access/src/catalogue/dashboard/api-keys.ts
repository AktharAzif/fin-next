// The dashboard's API keys permissions (spec 02 §8.2, [SA-11]). The API keys area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const apiKeys = {
  key: "api_keys",
  label: "API keys",
  permissions: [
    {
      key: "apiKey.read",
      label: "See keys",
      description: "Names, how each starts and when it was last used.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "keys" },
    },
    {
      key: "apiKey.sandbox",
      label: "Create, roll and revoke Sandbox keys",
      description: "Keys that start fin_test_.",
      needs: ["apiKey.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "manage Sandbox keys" },
    },
    {
      key: "apiKey.live",
      label: "Create, roll and revoke Production keys",
      description: "Keys that start fin_live_.",
      needs: ["apiKey.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "manage Production keys" },
    },
  ],
} as const satisfies GroupSpec;
