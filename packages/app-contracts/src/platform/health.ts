// `GET /api/health` on every app host (spec 01 §4.4): answered publicly through the tunnel by the
// API half's front door, with no database work (FW-C03 step 1).

import { defineContract, noInput } from "../contract.ts";
import { z } from "../zod.ts";

export const healthAnswer = z.object({ status: z.literal("ok") });

export const health = defineContract({
  name: "health.get",
  method: "GET",
  path: "/health",
  input: noInput,
  output: healthAnswer,
  timeoutMs: 10_000,
});
