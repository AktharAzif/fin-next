// The staff area's events (spec 08 §3.4's `staff.ts`, L-SAT-04; spec 02 §16.4), in two halves: the
// staff realm's sign-in, factor, step-up and enrolment-code events @fin/identity writes (its
// STAFF_REALM_EVENTS), and the management events @fin/staff writes (its STAFF_EVENTS): adding,
// changing, removing and resetting staff, the operator's bootstrap of the first Admin and the kill
// switches. Each package records its half itself, in this shape; this fragment is what the registry
// sync writes to audit.event_type, so `migrate --migrate` registers them and `migrate --task
// staff-bootstrap` can record its events. The packages' fragment tests hold each half equal to it.
import { z } from "zod";
import { type AuditCategory, defineEvents, type EventSpec } from "../define.ts";

const signInMethod = z.enum(["email_otp", "passkey", "totp", "backup_code", "password", "google"]);
const proofMethod = z.enum(["passkey", "totp", "backup_code"]);
const factor = z.object({ method: z.enum(["passkey", "totp"]) }).strict();
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`));
const empty = z.object({}).strict();
const roleKey = z.string().regex(/^(viewer|compliance|operator|admin|srl_[0-9a-hjkmnp-tv-z]{26})$/);
const reasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const counts = z.object({ sessionsEnded: z.int().min(0), factorsRemoved: z.int().min(0) }).strict();

/** The staff realm's own events, recorded by `fin_admin` (identity's half). */
const realm = (category: AuditCategory, target: string, metadata: z.ZodObject): EventSpec => ({
  category,
  scope: "staff",
  roles: ["fin_admin"],
  actors: ["staff", "system"],
  target,
  metadata,
});

export const events = defineEvents("staff", {
  "staff.signed_in": realm("sign_in", "sts", z.object({ method: signInMethod }).strict()),
  "staff.second_factor_required": realm("sign_in", "sts", empty),
  "staff.signed_out": realm("sign_in", "sts", empty),
  "staff.session_revoked": realm("sign_in", "sts", empty),
  "staff.signed_out_everywhere": realm(
    "sign_in",
    "stf",
    z.object({ count: z.int().min(0) }).strict(),
  ),
  "staff.sign_in_failed": realm(
    "sign_in",
    "stf",
    z
      .object({
        method: signInMethod,
        reason: z.enum([
          "wrong_code",
          "expired",
          "passkey_failed",
          "access_mismatch",
          "removed",
          "too_many_tries",
        ]),
      })
      .strict(),
  ),
  "staff.step_up_passed": realm(
    "security",
    "sts",
    z
      .object({
        method: proofMethod,
        kind: z.enum(["window", "intent"]),
        action: z
          .string()
          .regex(/^[a-z][a-zA-Z_]*\.[a-z][a-z_]*$/)
          .nullable(),
        intentId: id("sti").nullable(),
        replacedSessionId: id("sts").nullable(),
      })
      .strict(),
  ),
  "staff.step_up_failed": realm(
    "security",
    "sts",
    z
      .object({
        method: proofMethod,
        reason: z.enum(["wrong_code", "other_person", "passkey_failed"]),
      })
      .strict(),
  ),
  "staff.step_up_locked": realm("security", "sts", empty),
  "staff.factor_setup_started": realm("security", "stf", factor),
  // The target is the factor's own ID, a `pky_` or a `tfa_`: a label, so no one prefix is enforced.
  "staff.factor_added": realm("security", "factor", factor),
  "staff.factor_removed": realm("security", "factor", factor),
  "staff.factor_enrolled": realm("security", "stf", factor),
  "staff.enrolment_code_issued": {
    ...realm(
      "staff",
      "enc",
      z.object({ reason: z.enum(["added", "reset", "reissued", "bootstrap"]) }).strict(),
    ),
    // The first Admin's code is issued by the operator's bootstrap task (§10.6).
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator", "system"],
  },
  "staff.enrolment_code_redeemed": realm("staff", "enc", empty),

  // The management events (@fin/staff's half). fin_owner records the operator's tasks' events:
  // `migrate --task staff-bootstrap` (§10.6) and `pnpm fin switch` (spec 08 §3.4).
  "staff.member_added": {
    category: "staff",
    scope: "staff",
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "stf",
    metadata: z.object({ roleKey, reactivated: z.boolean() }).strict(),
  },
  "staff.role_changed": {
    category: "staff",
    scope: "staff",
    roles: ["fin_admin"],
    actors: ["staff"],
    target: "stf",
    metadata: z
      .object({
        fromRole: roleKey,
        toRole: roleKey,
        reason: z.enum(["changed", "role_deleted"]),
        lowered: z.boolean(),
      })
      .strict(),
    journal: { kind: "staff_role_lowered", when: (m) => m.lowered === true },
  },
  "staff.member_removed": {
    category: "staff",
    scope: "staff",
    roles: ["fin_admin"],
    actors: ["staff"],
    target: "stf",
    metadata: counts,
    journal: { kind: "staff_removed" },
  },
  "staff.factors_reset": {
    category: "staff",
    scope: "staff",
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "stf",
    metadata: counts,
    journal: { kind: "staff_factors_reset" },
  },
  "staff.bootstrapped": {
    category: "staff",
    scope: "staff",
    roles: ["fin_owner"],
    actors: ["operator"],
    target: "stf",
    metadata: z.object({ reset: z.boolean(), reasonCode }).strict(),
  },
  "switch.set": {
    category: "operations",
    scope: "staff",
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "switch",
    metadata: z.object({ reasonCode }).strict(),
    journal: { kind: "switch_set" },
  },
  "switch.cleared": {
    category: "operations",
    scope: "staff",
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator"],
    target: "switch",
    metadata: z.object({ reasonCode }).strict(),
    journal: { kind: "switch_cleared" },
  },
});
