// Fin's error answer: an RFC 9457 problem document with Fin's `code` and `request_id` (spec 02
// §14.1, spec 01 §4.4). Unknown extensions are kept, so a newer server never breaks an older
// client. The per-area code lists are fragments owned by their lanes (`src/errors/<area>.ts`);
// this file holds only the shape every app reads and the extensions `api()` acts on.
import { z } from "./zod.ts";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export const problemSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: z.string().min(1),
  request_id: z.string().optional(),
  detail: z.string().optional(),
});
export type Problem = z.output<typeof problemSchema>;

export const STEP_UP_METHODS = ["passkey", "authenticator", "backup_code"] as const;
export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

/** `403 step_up_required` (spec 02 §7.5): the intent to prove, or a window to open. */
export const stepUpRequiredSchema = z.looseObject({
  code: z.literal("step_up_required"),
  step_up_kind: z.enum(["intent", "window"]),
  intent_id: z.string().min(1).optional(),
  methods: z.array(z.enum(STEP_UP_METHODS)),
  reason_key: z.string().min(1),
  expires_at: z.string().optional(),
});
export type StepUpRequired = z.output<typeof stepUpRequiredSchema>;

/** `403 second_factor_required`; `hold: true` means the account is held until a factor is added. */
export const secondFactorRequiredSchema = z.looseObject({
  code: z.literal("second_factor_required"),
  hold: z.boolean().optional(),
});

/** `429 rate_limited`; the `Retry-After` header carries the same number of seconds. */
export const rateLimitedSchema = z.looseObject({
  code: z.literal("rate_limited"),
  retry_after: z.number().int().nonnegative().optional(),
});
