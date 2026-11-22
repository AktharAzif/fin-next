// The dashboard's Money movement permissions (spec 02 §8.2, [SA-11]; added on 20 Nov). The money
// area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const money = {
  key: "money",
  label: "Money movement",
  permissions: [
    {
      key: "money.read",
      label: "See money movement",
      description: "Virtual accounts, beneficiaries and transfers.",
      needs: ["customers.read"],
      stepUp: "window",
      privileged: false,
      sandboxOnly: false,
      restricted: false,
      summary: { see: "money movement" },
    },
    {
      key: "money.beneficiaries",
      label: "Add and remove beneficiaries",
      description: "The bank accounts a customer can send money to.",
      needs: ["money.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "add and remove beneficiaries" },
    },
    {
      key: "money.transfer",
      label: "Send money",
      description: "Move a customer's USD to a beneficiary, and open virtual accounts.",
      needs: ["money.read"],
      stepUp: "intent",
      privileged: true,
      sandboxOnly: false,
      restricted: false,
      summary: { does: "send money" },
    },
    {
      key: "money.simulate",
      label: "Simulate deposits",
      description: "Add USD to a customer's balance in the Sandbox.",
      needs: ["money.read"],
      stepUp: "none",
      privileged: false,
      sandboxOnly: true,
      restricted: false,
      summary: { does: "simulate deposits" },
    },
  ],
} as const satisfies GroupSpec;
