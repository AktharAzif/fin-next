// The audit events the identity realms write (spec 02 §16.2 and §16.4; spec 08 §3.4's
// canonical names). The person-scope events are the `identity.ts` fragment of
// packages/audit/src/events/ (L-SAT-02); the staff-realm sign-in events are the part of the
// `staff.ts` fragment (L-SAT-04) that this lane's realm writes. Until packages/audit lands they
// live here, in defineEvents' shape (spec 08 §3.2), and move into those fragments then.
//
// Metadata is flat and strict: IDs, statuses, codes, counts and enums. Never a name, an
// address, a code, a token or typed text (spec 02 §16.1, ARCHITECTURE §8.2).
import * as z from "zod";

export type AuditScope = "organisation" | "person" | "staff";
export type AuditCategory = "sign_in" | "security" | "team" | "staff";
export type ActorKind = "user" | "staff" | "operator" | "system";
export type ActorVia = "console" | "admin" | "job" | "operator";
export type AuditRole = "fin_console" | "fin_admin" | "fin_api" | "fin_worker" | "fin_owner";

export interface EventSpec {
  readonly category: AuditCategory;
  readonly scope: AuditScope;
  readonly roles: readonly AuditRole[];
  readonly actors: readonly ActorKind[];
  /** The target ID's prefix. */
  readonly target: string;
  readonly metadata: z.ZodObject;
}

const signInMethod = z.enum(["email_otp", "passkey", "totp", "backup_code", "password", "google"]);
const proofMethod = z.enum(["passkey", "totp", "backup_code"]);
const factorMethod = z.enum(["passkey", "authenticator", "backup_code"]);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`));
const isoTime = z.iso.datetime();
const empty = z.strictObject({});

const person = (category: AuditCategory, target: string, metadata: z.ZodObject): EventSpec => ({
  category,
  scope: "person",
  roles: ["fin_console"],
  actors: ["user", "system"],
  target,
  metadata,
});

const staff = (category: AuditCategory, target: string, metadata: z.ZodObject): EventSpec => ({
  category,
  scope: "staff",
  roles: ["fin_admin"],
  actors: ["staff", "system"],
  target,
  metadata,
});

/** Person scope, recorded by `fin_console` (spec 02 §16.2). */
export const IDENTITY_EVENTS = {
  "user.created": person(
    "security",
    "usr",
    z.strictObject({ method: z.enum(["email_otp", "google"]), viaInvitation: z.boolean() }),
  ),
  "user.name_changed": person("security", "usr", empty),
  "session.created": person(
    "sign_in",
    "ses",
    z.strictObject({
      method: signInMethod,
      assurance: z.enum(["aal1", "aal2"]),
      trustedBrowser: z.boolean(),
    }),
  ),
  "session.ended": person(
    "sign_in",
    "ses",
    z.strictObject({ reason: z.enum(["signed_out", "step_up_locked", "password_reset"]) }),
  ),
  "session.revoked": person("sign_in", "ses", empty),
  "session.revoked_others": person("sign_in", "usr", z.strictObject({ count: z.int().min(0) })),
  "sign_in.second_factor_required": person(
    "sign_in",
    "ses",
    z.strictObject({ methods: z.array(factorMethod).max(3) }),
  ),
  "sign_in.failed": person(
    "sign_in",
    "usr",
    z.strictObject({
      method: signInMethod,
      reason: z.enum([
        "wrong_code",
        "expired",
        "other_browser",
        "passkey_failed",
        "too_many_tries",
      ]),
    }),
  ),
  "sign_in.second_factor_failed": person("sign_in", "usr", z.strictObject({ method: proofMethod })),
  "sign_in.locked": person("sign_in", "usr", z.strictObject({ until: isoTime })),
  "two_factor.setup_started": person("security", "usr", empty),
  "two_factor.enabled": person("security", "tfa", empty),
  "two_factor.disabled": person("security", "tfa", empty),
  "backup_codes.regenerated": person("security", "usr", empty),
  "backup_code.used": person("security", "usr", z.strictObject({ remaining: z.int().min(0) })),
  "passkey.added": person("security", "pky", empty),
  "passkey.removed": person("security", "pky", empty),
  "step_up.passed": person(
    "security",
    "ses",
    z.strictObject({
      method: proofMethod,
      kind: z.enum(["window", "intent"]),
      action: z
        .string()
        .regex(/^[a-z][a-zA-Z_]*\.[a-z][a-z_]*$/)
        .nullable(),
      intentId: id("sti").nullable(),
      replacedSessionId: id("ses").nullable(),
    }),
  ),
  "step_up.failed": person(
    "security",
    "ses",
    z.strictObject({
      method: proofMethod,
      reason: z.enum(["wrong_code", "other_person", "passkey_failed"]),
    }),
  ),
  "step_up.locked": person("security", "ses", empty),
  "browser.trusted": person("security", "tbr", empty),
  "browser.trust_revoked": {
    ...person(
      "security",
      "tbr",
      z.strictObject({
        reason: z.enum([
          "factor_changed",
          "password_reset",
          "signed_out_everywhere",
          "role_elevated",
          "production_access",
          "by_person",
          "removed",
        ]),
      }),
    ),
    // Also `fin_api`, for the revocations of a go-live approval (§6.6, spec 08 §3.4).
    roles: ["fin_console", "fin_api"],
    actors: ["user", "staff", "system"],
  },
} as const satisfies Record<string, EventSpec>;

/** Staff scope, recorded by `fin_admin`: the events the staff realm's sign-in writes (§16.4). */
export const STAFF_REALM_EVENTS = {
  "staff.signed_in": staff("sign_in", "sts", z.strictObject({ method: signInMethod })),
  "staff.second_factor_required": staff("sign_in", "sts", empty),
  "staff.signed_out": staff("sign_in", "sts", empty),
  "staff.session_revoked": staff("sign_in", "sts", empty),
  "staff.signed_out_everywhere": staff("sign_in", "stf", z.strictObject({ count: z.int().min(0) })),
  "staff.sign_in_failed": staff(
    "sign_in",
    "stf",
    z.strictObject({
      method: signInMethod,
      reason: z.enum([
        "wrong_code",
        "expired",
        "passkey_failed",
        "access_mismatch",
        "removed",
        "too_many_tries",
      ]),
    }),
  ),
  "staff.step_up_passed": staff(
    "security",
    "sts",
    z.strictObject({
      method: proofMethod,
      kind: z.enum(["window", "intent"]),
      action: z
        .string()
        .regex(/^[a-z][a-zA-Z_]*\.[a-z][a-z_]*$/)
        .nullable(),
      intentId: id("sti").nullable(),
      replacedSessionId: id("sts").nullable(),
    }),
  ),
  "staff.step_up_failed": staff(
    "security",
    "sts",
    z.strictObject({
      method: proofMethod,
      reason: z.enum(["wrong_code", "other_person", "passkey_failed"]),
    }),
  ),
  "staff.step_up_locked": staff("security", "sts", empty),
  "staff.factor_setup_started": staff(
    "security",
    "stf",
    z.strictObject({ method: z.enum(["passkey", "totp"]) }),
  ),
  "staff.factor_added": staff(
    "security",
    "",
    z.strictObject({ method: z.enum(["passkey", "totp"]) }),
  ),
  "staff.factor_removed": staff(
    "security",
    "",
    z.strictObject({ method: z.enum(["passkey", "totp"]) }),
  ),
  "staff.factor_enrolled": staff(
    "security",
    "stf",
    z.strictObject({ method: z.enum(["passkey", "totp"]) }),
  ),
  "staff.enrolment_code_issued": {
    ...staff(
      "staff",
      "enc",
      z.strictObject({ reason: z.enum(["added", "reset", "reissued", "bootstrap"]) }),
    ),
    // The first Admin's code is issued by the operator's bootstrap task (§10.6).
    roles: ["fin_admin", "fin_owner"],
    actors: ["staff", "operator", "system"],
  },
  "staff.enrolment_code_redeemed": staff("staff", "enc", empty),
} as const satisfies Record<string, EventSpec>;

export const REALM_EVENTS = { ...IDENTITY_EVENTS, ...STAFF_REALM_EVENTS } as const;
export type RealmEventName = keyof typeof REALM_EVENTS;

/** The registry rows `audit.event_type` needs for these events (spec 08 §3.2's audit-sync). */
export function eventTypeRows(): {
  name: string;
  area: string;
  category: AuditCategory;
  scope: AuditScope;
  roles: readonly AuditRole[];
}[] {
  return Object.entries(REALM_EVENTS).map(([name, spec]) => ({
    name,
    area: name.startsWith("staff.") ? "staff" : "identity",
    category: spec.category,
    scope: spec.scope,
    roles: spec.roles,
  }));
}
