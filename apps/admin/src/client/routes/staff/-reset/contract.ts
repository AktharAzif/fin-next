// `POST /api/staff/:staffId/reset-factors` (spec 02 §10.2, §14.3, [SA-14]): an Admin removes a member's
// passkeys and authenticator, ends every session of theirs, and gets a new enrolment code, once.
// `staff.reset_factors` (Admin-only) and an intent (`staff.reset_factors`, bound to the member): api()
// asks the root "Confirm it's you" for it and sends the request again once. The answer is the API
// half's own (apps/admin/src/server/routes/handlers.ts): the member's ID, `pending`, and the code with
// its expiry. The code is shown once and never kept after the dialog closes.
//
// It lives with the reset's screen until the staff contracts move to packages/app-contracts/src/staff/
// (spec 06 §11.3), beside the others in ../../../api/contracts.ts.
import { defineContract, z } from "@fin/app-contracts";

export const resetFactorsAnswer = z.object({
  staffId: z.string().min(1).max(64),
  /** A reset member enrols again: `pending` until their new first factor (spec 02 §6.5). */
  status: z.literal("pending"),
  /** Shown once (spec 02 §6.5): never stored, logged or emailed. */
  enrolmentCode: z.string().min(16).max(32),
  /** ISO 8601: 30 minutes after the reset. */
  expiresAt: z.string(),
});
export type ResetFactorsAnswer = z.output<typeof resetFactorsAnswer>;

export const resetStaffFactors = defineContract({
  name: "staff.resetFactors",
  method: "POST",
  path: "/staff/:staffId/reset-factors",
  input: z.object({ staffId: z.string().min(1).max(64) }),
  output: resetFactorsAnswer,
});
