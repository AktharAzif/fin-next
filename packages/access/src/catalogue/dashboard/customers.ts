// The dashboard's Customers permissions (spec 02 §8.2, [SA-11]). The customers area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const customers = {
  key: "customers",
  label: "Customers",
  permissions: [
    {
      key: "customers.read",
      label: "See customers",
      description: "Their details, documents and history.",
      needs: [],
      stepUp: "window",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "customers" },
    },
    {
      key: "customers.create",
      label: "Add customers and send their links",
      description: "Create a customer and send them a link to verify.",
      needs: ["customers.read"],
      stepUp: "window",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "add customers" },
    },
    {
      key: "customers.restart",
      label: "Start a customer again",
      description: "Clear what they sent and ask for it again.",
      needs: ["customers.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "start customers again" },
    },
    {
      key: "customers.delete",
      label: "Delete customers",
      description: "Remove a customer and what they sent, for good.",
      needs: ["customers.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "delete customers" },
    },
  ],
} as const satisfies GroupSpec;
