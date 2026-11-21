// The console's problem answers (spec 02 §14.1, spec 01 §4.4): `application/problem+json` with
// `type <docs origin>/errors/<code>`, `title`, `status`, `code`, `request_id` and only the allowlisted
// extensions. A refusal from the identity realm (AuthRefusal: the gate, step-up, limits) or from this
// area (OrgRefusal: scope, giving, outrank, last holder) answers its own code and marks the request
// line `refused` with its bounded reason; a store failure answers 503; anything else is the host's
// reported 500.
import { AuthRefusal, AuditGuardError, UnitRolledBackError } from "@fin/identity";
import { isOrgRefusal, ORG_PROBLEM_TITLE, type OrgProblemCode } from "@fin/orgs";
import { type FinContext, markOutcome, PROBLEM_EXTENSIONS } from "@fin/server/http";

const AUTH_TITLES: Readonly<Record<string, string>> = {
  unauthenticated: "Sign in to continue.",
  factor_step_required: "Use your second factor to continue.",
  second_factor_required: "Add a second factor first.",
  fresh_session_required: "Sign in by email to add a second factor.",
  step_up_required: "Use your second factor to continue.",
  step_up_invalid: "That didn't work. Try again.",
  rate_limited: "Too many tries. Wait a moment.",
  paused: "This is paused for now.",
  unavailable: "Try again in a moment.",
  internal: "Something went wrong.",
};

function titleOf(code: string): string {
  return (
    AUTH_TITLES[code] ??
    (ORG_PROBLEM_TITLE as Readonly<Record<string, string>>)[code as OrgProblemCode] ??
    "The request was refused."
  );
}

export function problem(
  c: FinContext,
  docsOrigin: string,
  status: number,
  code: string,
  extensions: Readonly<Record<string, unknown>> = {},
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body: Record<string, unknown> = {
    type: `${docsOrigin}/errors/${code}`,
    title: titleOf(code),
    status,
    code,
    request_id: c.get("requestId") ?? "req_unknown",
  };
  for (const [key, value] of Object.entries(extensions)) {
    if (PROBLEM_EXTENSIONS.has(key) && value !== undefined) body[key] = value;
  }
  const answer = new Headers({
    "content-type": "application/problem+json",
    "cache-control": "no-store",
    ...headers,
  });
  if (code === "rate_limited" && typeof extensions.retry_after === "number") {
    answer.set("retry-after", String(extensions.retry_after));
  }
  return new Response(JSON.stringify(body), { status, headers: answer });
}

/** The answer for an error a route's work threw, or null for one the host's handler reports. */
export function refusalAnswer(c: FinContext, docsOrigin: string, error: unknown): Response | null {
  if (error instanceof AuthRefusal) {
    markOutcome(c, "refused", error.lineReason);
    return problem(c, docsOrigin, error.status, error.code, error.extensions);
  }
  if (isOrgRefusal(error)) {
    markOutcome(c, "refused", error.lineReason);
    return problem(c, docsOrigin, error.status, error.code, error.extensions);
  }
  const cause = error instanceof UnitRolledBackError ? error.cause : error;
  if (cause instanceof Error && cause.name === "LimitStoreError") {
    // The limiter fails closed (spec 02 §5.6); its own line is `limits.store_failed`.
    markOutcome(c, "error", "limits.store_failed");
    return problem(c, docsOrigin, 503, "unavailable", { retry_after: 5 }, { "retry-after": "5" });
  }
  if (error instanceof AuditGuardError) {
    // The unit wrote `database.audit_guard`; the answer says nothing more (spec 08 §3.5).
    markOutcome(c, "error", "database.audit_guard");
    return problem(c, docsOrigin, 500, "internal");
  }
  return null;
}
