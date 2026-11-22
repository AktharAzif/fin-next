// Fin Admin's viewer (spec 02 §14.4). `GET /api/viewer` answers in any staff state, so the entry
// module can send a signed-out or pending member of staff to the right sign-in step (spec 06 §2.3).
//
// P0-G's stub of the contract: spec 02's staff lane owns this file once it merges (spec 06 §11.3)
// and adds the contract test against the route.

import { defineContract, noInput } from "../contract.ts";
import { STEP_UP_METHODS } from "../problem.ts";
import { z } from "../zod.ts";

/** The deployment Fin Admin runs in, shown as the header's Badge (the AdminFrame states). */
export const STAFF_ENVIRONMENTS = ["production", "staging", "development"] as const;

export const staffViewerAnswer = z.union([
  z.object({
    state: z.literal("signed_out"),
    accessEmail: z.string().nullable(),
    /** Present while staff Google sign-in is on (spec 02 §5.8): the page offers the button. */
    google: z.literal(true).optional(),
  }),
  z.object({ state: z.literal("pending"), email: z.string() }),
  z.object({
    state: z.literal("factor_step"),
    email: z.string(),
    methods: z.array(z.enum(STEP_UP_METHODS)),
  }),
  z.object({
    state: z.literal("ok"),
    staff: z.object({
      id: z.string().min(1),
      email: z.string(),
      roleKey: z.string().min(1),
      roleLabel: z.string(),
    }),
    permissions: z.array(z.string()),
    /** Any other value draws the `unknownDeployment` state rather than failing the frame. */
    environment: z.string(),
  }),
]);
export type StaffViewer = z.output<typeof staffViewerAnswer>;
export type StaffViewerSignedIn = Extract<StaffViewer, { state: "ok" }>;

export const staffViewer = defineContract({
  name: "staffViewer.get",
  method: "GET",
  path: "/viewer",
  input: noInput,
  output: staffViewerAnswer,
});
