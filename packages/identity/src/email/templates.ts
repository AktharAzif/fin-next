// The security emails the identity realms queue (spec 02 §17.2 and §17.3; spec 08 §4.4's
// canonical names and classes). Their rendering lives in packages/email (L-SAT-05 owns the
// sender and the `defineTemplate` harness; the `identity/` and `staff/` folders hold the copy).
// What this package owns is the contract: the name, the class, and the strict parameter schema,
// which never admits a secret: no enrolment code, key secret, backup code or link token
// (spec 02 §17.1, T-SAT-41). A one-time sign-in code is the one secret a `code` template carries.
import * as z from "zod";

export type TemplateClass = "code" | "security";

export interface TemplateSpec {
  readonly class: TemplateClass;
  readonly role: "fin_console" | "fin_admin";
  readonly params: z.ZodObject;
}

const device = z.string().min(1).max(60);
const time = z.iso.datetime();
const signInCode = z.string().regex(/^\d{8}$/);

export const IDENTITY_TEMPLATES = {
  "identity/sign-in-code": {
    class: "code",
    role: "fin_console",
    params: z.strictObject({ code: signInCode }),
  },
  "identity/confirm-email": {
    class: "code",
    role: "fin_console",
    params: z.strictObject({ code: signInCode }),
  },
  "identity/already-registered": {
    class: "security",
    role: "fin_console",
    params: z.strictObject({}),
  },
  "identity/new-sign-in": {
    class: "security",
    role: "fin_console",
    params: z.strictObject({ userId: z.string(), device, time }),
  },
  "identity/sign-in-methods-changed": {
    class: "security",
    role: "fin_console",
    params: z.strictObject({
      userId: z.string(),
      kind: z.enum([
        "passkey_added",
        "passkey_removed",
        "passkey_refused",
        "authenticator_on",
        "authenticator_off",
        "backup_codes_regenerated",
        "browser_trusted",
        "signed_out_everywhere",
        "password_changed",
        "password_reset",
      ]),
      device: device.optional(),
      time,
    }),
  },
  // Passwords (stretch 2, §5.7): the reset code, and the once-a-day notice of a pause.
  "identity/reset-password": {
    class: "code",
    role: "fin_console",
    params: z.strictObject({ code: signInCode }),
  },
  "identity/password-paused": {
    class: "security",
    role: "fin_console",
    params: z.strictObject({ userId: z.string(), time }),
  },
  "identity/account-locked": {
    class: "security",
    role: "fin_console",
    params: z.strictObject({ userId: z.string(), until: time }),
  },
  "identity/session-ended": {
    class: "security",
    role: "fin_console",
    params: z.strictObject({ userId: z.string(), reason: z.enum(["too_many_tries"]), time }),
  },
} as const satisfies Record<string, TemplateSpec>;

/** The staff realm's templates this lane's realm queues (folder `staff/`, L-SAT-04's copy). */
export const STAFF_REALM_TEMPLATES = {
  "staff/staff-sign-in-code": {
    class: "code",
    role: "fin_admin",
    params: z.strictObject({ code: signInCode }),
  },
  "staff/staff-new-sign-in": {
    class: "security",
    role: "fin_admin",
    params: z.strictObject({ staffId: z.string(), device, time }),
  },
  "staff/staff-sign-in-methods-changed": {
    class: "security",
    role: "fin_admin",
    params: z.strictObject({
      staffId: z.string(),
      kind: z.enum([
        "passkey_added",
        "passkey_removed",
        "authenticator_on",
        "authenticator_off",
        "signed_out_everywhere",
      ]),
      time,
    }),
  },
  "staff/staff-factor-enrolled": {
    class: "security",
    role: "fin_admin",
    params: z.strictObject({ staffId: z.string(), method: z.enum(["passkey", "totp"]), time }),
  },
} as const satisfies Record<string, TemplateSpec>;

export const REALM_TEMPLATES = { ...IDENTITY_TEMPLATES, ...STAFF_REALM_TEMPLATES } as const;
export type RealmTemplateName = keyof typeof REALM_TEMPLATES;
