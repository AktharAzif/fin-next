// The identity area's lines (spec 02 §18.1), written by packages/identity's line port
// (`lines.write`) for both realms, and by the orgs and staff packages and the console's API half
// where they run identity's gates. packages/identity/src/monitoring.ts keeps the same list beside
// the code. The staff realm's own lines are in staff.ts; request, csrf.refused and the audit lines
// are in platform.ts and audit.ts. The alerts spec 02 §18.2 names for these lines are in the
// identity area's alert fragment (alerts/identity.json); sign-in-code-contested is still owed
// (`owed`, listed in owed.ts with its lane, date and why).
import type { CatalogEntry } from "./types.ts";

export const entries: readonly CatalogEntry[] = [
  {
    event: "auth.gate_refused",
    kind: "security",
    level: "warn",
    writtenBy:
      "the realm's before-hook, requirePerson, and the orgs and staff guards, for a session the gate does not let through (spec 02 §6.2, §6.4)",
    fields: { realm: "string", state: "string" },
    alerts: [],
    noAlert:
      "An expected refusal (a session not yet at the state the route needs); spec 02 §18.3 panels it by state and §18.2 names no alert for it",
  },
  {
    event: "auth.code_contested",
    kind: "security",
    level: "warn",
    writtenBy:
      "the sign-in code requests, when a browser the address does not know is refused a new code over a live one, or uses the strangers' share (spec 02 §5.2)",
    fields: { reason: "string", userId: "string" },
    alerts: [],
    owed: ["sign-in-code-contested"],
  },
  {
    event: "auth.secret_unreadable",
    kind: "failure",
    level: "error",
    writtenBy:
      "the TOTP check and the console's viewer, when no configured secret version opens a stored secret",
    fields: { realm: "string", kind: "string" },
    alerts: ["secret-unreadable"],
  },
  {
    event: "auth.unhandled_error",
    kind: "failure",
    level: "error",
    writtenBy:
      "the realm's error handler, beside error.unexpected with the same errorId, for an error no refusal names (500)",
    fields: { realm: "string", authPath: "string", errorId: "string" },
    // Split by authPath: the factor-step and enrolment paths are second-factor-step-failing's,
    // every other value, a missing one included, sign-in-failing's.
    alerts: ["sign-in-failing", "second-factor-step-failing"],
  },
  {
    event: "auth.library_log",
    kind: "info",
    level: "warn",
    writtenBy:
      "the auth library's logger, its warnings and errors by level only (`libraryLevel`, the library's own; the line's envelope `level` is warn or error; no message is kept)",
    fields: { realm: "string", libraryLevel: "string" },
    alerts: [],
  },
  {
    event: "step_up.refused",
    kind: "security",
    level: "warn",
    writtenBy:
      "the step-up intents and ceremonies (identity, and the orgs and staff guards), for an intent or a ceremony that cannot serve (spec 02 §7.5)",
    fields: { realm: "string", action: "string", reason: "string" },
    // step-up-failing watches reason digest above its threshold (spec 02 §18.2).
    alerts: ["step-up-failing"],
  },
  {
    event: "step_up.locked",
    kind: "security",
    level: "warn",
    writtenBy: "the step-up counter, when the fifth failure ends the session (spec 02 §7.7)",
    fields: { realm: "string" },
    alerts: ["step-up-locked"],
  },
  {
    event: "limits.refused",
    kind: "info",
    level: "info",
    writtenBy: "the auth limiter, for a request over its bucket's allowance (spec 02 §5.6)",
    fields: { bucket: "string" },
    alerts: [],
  },
  {
    event: "limits.store_failed",
    kind: "failure",
    level: "error",
    writtenBy:
      "the auth limiter, when its store cannot be read or written; it fails closed, so the request is refused (503)",
    fields: { bucket: "string" },
    alerts: ["rate-limiter-failing"],
  },
];
