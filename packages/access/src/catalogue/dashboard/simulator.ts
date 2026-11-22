// The dashboard's Simulator permissions, Sandbox only (spec 02 §8.2, [SA-11]). The simulator
// area's fragment.
import type { GroupSpec } from "../../engine/types.ts";

export const simulator = {
  key: "simulator",
  label: "Simulator",
  permissions: [
    {
      key: "simulator.use",
      label: "Use the simulator",
      description: "Approve, reject or ask for information on Sandbox customers.",
      needs: ["customers.read"],
      stepUp: "window",
      privileged: false,
      sandboxOnly: true,
      restricted: false,
      summary: { does: "use the simulator" },
    },
    {
      key: "sandbox.reset",
      label: "Reset the Sandbox",
      description: "Delete every Sandbox customer and start clean.",
      needs: ["simulator.use"],
      stepUp: "intent",
      privileged: false,
      sandboxOnly: true,
      restricted: false,
      summary: { does: "reset the Sandbox" },
    },
  ],
} as const satisfies GroupSpec;
