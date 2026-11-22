// The dashboard's Go to Production permissions (spec 02 §8.2, [SA-11], round-2 wording). The
// go-live area's fragment. Sending the request is Super admin only.
import type { GroupSpec } from "../../engine/types.ts";

export const goLive = {
  key: "golive",
  label: "Go to Production",
  permissions: [
    {
      key: "golive.edit",
      label: "Fill in your Production request",
      description: "Answers and documents, saved as you go.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "fill in the Production request" },
    },
    {
      key: "golive.submit",
      label: "Send it to Fin",
      description: "Send your finished Production request for Fin to review.",
      needs: ["golive.edit"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: true,
      summary: { does: "send the Production request" },
    },
  ],
} as const satisfies GroupSpec;
