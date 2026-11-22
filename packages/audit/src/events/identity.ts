// The identity area's events (spec 08 §3.4's `identity.ts`, L-SAT-02; spec 02 §16.2): the person-scope
// sign-in and security events the console's realm writes, recorded by `fin_console`. @fin/identity
// records them itself (its IDENTITY_EVENTS, in this shape); this fragment is what the registry sync
// writes to audit.event_type, so `migrate --migrate` registers them. Identity's fragment test holds
// the two equal, field by field.
import { z } from "zod";
import { type AuditCategory, defineEvents, type EventSpec } from "../define.ts";

const signInMethod = z.enum(["email_otp", "passkey", "totp", "backup_code", "password", "google"]);
const proofMethod = z.enum(["passkey", "totp", "backup_code"]);
const factorMethod = z.enum(["passkey", "authenticator", "backup_code"]);
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`));
const empty = z.object({}).strict();

const person = (category: AuditCategory, target: string, metadata: z.ZodObject): EventSpec => ({
  category,
  scope: "person",
  roles: ["fin_console"],
  actors: ["user", "system"],
  target,
  metadata,
});

export const events = defineEvents("identity", {
  "user.created": person(
    "security",
    "usr",
    z.object({ method: z.enum(["email_otp", "google"]), viaInvitation: z.boolean() }).strict(),
  ),
  "user.name_changed": person("security", "usr", empty),
  "session.created": person(
    "sign_in",
    "ses",
    z
      .object({
        method: signInMethod,
        assurance: z.enum(["aal1", "aal2"]),
        trustedBrowser: z.boolean(),
      })
      .strict(),
  ),
  "session.ended": person(
    "sign_in",
    "ses",
    z.object({ reason: z.enum(["signed_out", "step_up_locked", "password_reset"]) }).strict(),
  ),
  "session.revoked": person("sign_in", "ses", empty),
  "session.revoked_others": person("sign_in", "usr", z.object({ count: z.int().min(0) }).strict()),
  "sign_in.second_factor_required": person(
    "sign_in",
    "ses",
    z.object({ methods: z.array(factorMethod).max(3) }).strict(),
  ),
  "sign_in.failed": person(
    "sign_in",
    "usr",
    z
      .object({
        method: signInMethod,
        reason: z.enum([
          "wrong_code",
          "expired",
          "other_browser",
          "passkey_failed",
          "too_many_tries",
        ]),
      })
      .strict(),
  ),
  "sign_in.second_factor_failed": person(
    "sign_in",
    "usr",
    z.object({ method: proofMethod }).strict(),
  ),
  "sign_in.locked": person("sign_in", "usr", z.object({ until: z.iso.datetime() }).strict()),
  "two_factor.setup_started": person("security", "usr", empty),
  "two_factor.enabled": person("security", "tfa", empty),
  "two_factor.disabled": person("security", "tfa", empty),
  "backup_codes.regenerated": person("security", "usr", empty),
  "backup_code.used": person("security", "usr", z.object({ remaining: z.int().min(0) }).strict()),
  "passkey.added": person("security", "pky", empty),
  "passkey.removed": person("security", "pky", empty),
  "step_up.passed": person(
    "security",
    "ses",
    z
      .object({
        method: proofMethod,
        kind: z.enum(["window", "intent"]),
        action: z
          .string()
          .regex(/^[a-z][a-zA-Z_]*\.[a-z][a-z_]*$/)
          .nullable(),
        intentId: id("sti").nullable(),
        replacedSessionId: id("ses").nullable(),
      })
      .strict(),
  ),
  "step_up.failed": person(
    "security",
    "ses",
    z
      .object({
        method: proofMethod,
        reason: z.enum(["wrong_code", "other_person", "passkey_failed"]),
      })
      .strict(),
  ),
  "step_up.locked": person("security", "ses", empty),
  // Google sign-in (stretch 5, §5.8): a Google account linked to, or unlinked from, a person.
  "account.linked": person("security", "acc", z.object({ provider: z.enum(["google"]) }).strict()),
  "account.unlinked": person(
    "security",
    "acc",
    z.object({ provider: z.enum(["google"]) }).strict(),
  ),
  "browser.trusted": person("security", "tbr", empty),
  "browser.trust_revoked": {
    ...person(
      "security",
      "tbr",
      z
        .object({
          reason: z.enum([
            "factor_changed",
            "password_reset",
            "signed_out_everywhere",
            "role_elevated",
            "production_access",
            "by_person",
            "removed",
          ]),
        })
        .strict(),
    ),
    // Also `fin_api`, for the revocations of a go-live approval (§6.6, spec 08 §3.4).
    roles: ["fin_console", "fin_api"],
    actors: ["user", "staff", "system"],
  },
});
