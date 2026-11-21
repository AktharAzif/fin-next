// The lines this package writes (spec 02 §18.1, spec 08 §7.2) with their kind and the alerts that
// watch them (§18.2). `monitoring:check` reads the area catalogues in ops/monitoring/catalog/
// (ARCHITECTURE §10.11); this is the identity area's list for that catalogue fragment, kept beside
// the code that writes the lines, and monitoring.test.ts fails when the code writes a line this
// list does not name.

export type LineKind = "unit" | "security" | "failure" | "info";

export interface LineSpec {
  readonly kind: LineKind;
  /** The alerts that watch the line, or the reason none does. */
  readonly alerts: readonly string[] | { readonly none: string };
}

export const IDENTITY_LINES = {
  request: {
    kind: "unit",
    alerts: [
      "sign-in-failing",
      "second-factor-step-failing",
      "step-up-failing",
      "admin-without-second-factor",
    ],
  },
  "auth.endpoint_blocked": { kind: "security", alerts: ["auth-endpoint-unlisted"] },
  // Spec 01 §8.9's line (the origin gate's), written here for a library GET another site sent.
  "csrf.refused": { kind: "security", alerts: ["csrf-refused-jump"] },
  "auth.gate_refused": {
    kind: "security",
    alerts: { none: "an expected refusal; panelled by state (§18.3), not alerted" },
  },
  "auth.code_contested": { kind: "security", alerts: ["sign-in-code-contested"] },
  "auth.secret_unreadable": { kind: "failure", alerts: ["secret-unreadable"] },
  "auth.unhandled_error": { kind: "failure", alerts: ["sign-in-failing"] },
  "auth.library_log": {
    kind: "info",
    alerts: {
      none: "the library's own warnings, libraryLevel only; errors surface as auth.unhandled_error",
    },
  },
  // Google sign-in (stretch 5, §5.8, §18.2's stretch alert). A failure on Fin's side or the
  // provider's: the code exchange, the provider's keys, or an ID token that does not verify.
  "auth.google_failed": { kind: "failure", alerts: ["google-sign-in-failing"] },
  // A round trip that came back refused: the person cancelled, the address has an account not
  // linked to Google, sign-ups are paused, or a link did not match the account.
  "auth.google_refused": {
    kind: "security",
    alerts: {
      none: "expected refusals, each answered on the page; panelled by reason (§18.3), and google-sign-in-failing watches the failures",
    },
  },
  "step_up.refused": { kind: "security", alerts: ["step-up-failing"] },
  "step_up.locked": { kind: "security", alerts: ["step-up-locked"] },
  "limits.refused": {
    kind: "info",
    alerts: { none: "a working limit; panelled by bucket (§18.3)" },
  },
  "limits.store_failed": { kind: "failure", alerts: ["rate-limiter-failing"] },
  "staff.not_listed": { kind: "security", alerts: ["admin-staff-refused"] },
  "staff.access_mismatch": { kind: "security", alerts: ["admin-access-mismatch"] },
  "staff.enrolment_refused": { kind: "security", alerts: ["staff-enrolment-refused"] },
  "staff.enrolled": { kind: "security", alerts: ["staff-enrolled"] },
  "email.security_unsent": { kind: "failure", alerts: ["security-email-unsent"] },
  "audit.write_failed": { kind: "failure", alerts: ["audit-not-written"] },
  "database.audit_guard": { kind: "failure", alerts: ["audit-guard"] },
} as const satisfies Record<string, LineSpec>;

export type IdentityLine = keyof typeof IDENTITY_LINES;
