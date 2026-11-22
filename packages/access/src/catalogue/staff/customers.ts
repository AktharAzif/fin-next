// Fin Admin's Customers permissions (spec 02 §8.3, [SA-12]). The staff customers area's fragment.
// Fin Admin copy may name Sumsub.
import type { GroupSpec } from "../../engine/types.ts";

export const customers = {
  key: "customers",
  label: "Customers",
  permissions: [
    {
      key: "customers.read",
      label: "See customers",
      description: "Customers and their people, with personal details masked.",
      needs: [],
      stepUp: "none",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "customers" },
    },
    {
      key: "customers.reveal",
      label: "Show personal details",
      description: "Unmask a customer's or person's details, within a budget.",
      needs: ["customers.read"],
      stepUp: "window",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "show personal details" },
    },
    {
      key: "documents.view",
      label: "View identity documents",
      description: "Open identity documents from Sumsub, within a budget.",
      needs: ["customers.read"],
      stepUp: "window",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "view identity documents" },
    },
    {
      key: "customers.decide",
      label: "Decide customers",
      description: "Approve, unapprove and reject customers and people.",
      needs: ["customers.read"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "decide customers" },
    },
  ],
} as const satisfies GroupSpec;
