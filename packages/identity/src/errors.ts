// The auth problem codes (spec 02 §14.1, S2-26), answered as problem documents
// (`application/problem+json`, spec 01 §4.4) wherever Fin refuses before or around the library.
// The canonical list lives in packages/app-contracts/src/errors/auth.ts (L-SAT-02's fragment,
// outside this lane's paths this run); it moves there when that package exists.

export type AuthProblemCode =
  | "unauthenticated"
  | "factor_step_required"
  | "second_factor_required"
  | "fresh_session_required"
  | "step_up_required"
  | "step_up_invalid"
  | "forbidden"
  | "invalid"
  | "not_found"
  | "conflict"
  | "last_factor"
  | "rate_limited"
  | "paused"
  | "unavailable"
  | "access_required"
  | "access_mismatch"
  | "invalid_origin"
  | "internal";

const STATUS: Readonly<Record<AuthProblemCode, number>> = {
  unauthenticated: 401,
  factor_step_required: 403,
  second_factor_required: 403,
  fresh_session_required: 403,
  step_up_required: 403,
  step_up_invalid: 403,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  conflict: 409,
  last_factor: 409,
  rate_limited: 429,
  paused: 503,
  unavailable: 503,
  access_required: 401,
  access_mismatch: 403,
  invalid_origin: 403,
  internal: 500,
};

const TITLE: Readonly<Record<AuthProblemCode, string>> = {
  unauthenticated: "Sign in to continue.",
  factor_step_required: "Use your second factor to continue.",
  second_factor_required: "Add a second factor first.",
  fresh_session_required: "Sign in by email to add a second factor.",
  step_up_required: "Use your second factor to continue.",
  step_up_invalid: "That didn't work. Try again.",
  forbidden: "You can't do that.",
  invalid: "Check what you entered.",
  not_found: "Not found.",
  conflict: "Something changed. Try again.",
  last_factor: "Keep another way to sign in first.",
  rate_limited: "Too many tries. Wait a moment.",
  paused: "This is paused for now.",
  unavailable: "Try again in a moment.",
  access_required: "Sign in through Access.",
  access_mismatch: "You're signed in as someone else.",
  invalid_origin: "This request came from another site.",
  internal: "Something went wrong.",
};

export type ProblemExtensions = Readonly<
  Record<string, string | number | boolean | null | readonly string[]>
>;

/** A refusal Fin decides before (or instead of) the library; the realm turns it into a problem. */
export class AuthRefusal extends Error {
  readonly code: AuthProblemCode;
  readonly status: number;
  readonly extensions: ProblemExtensions;
  /** A bounded reason for the request line, e.g. `gate.factor_step`. */
  readonly lineReason: string;
  /**
   * Whether the request's writes must roll back. Most refusals commit (a counted try, a created
   * intent, a failure event); a refusal found after the action ran (a lost intent race) does not.
   */
  readonly rollback: boolean;
  constructor(
    code: AuthProblemCode,
    lineReason: string,
    extensions: ProblemExtensions = {},
    options: { rollback?: boolean } = {},
  ) {
    super(code);
    this.name = "AuthRefusal";
    this.code = code;
    this.status = STATUS[code];
    this.extensions = extensions;
    this.lineReason = lineReason;
    this.rollback = options.rollback === true;
  }
}

export function problemResponse(
  docsOrigin: string,
  code: AuthProblemCode,
  requestId: string,
  extensions: ProblemExtensions = {},
  extraHeaders: Readonly<Record<string, string>> = {},
): Response {
  const status = STATUS[code];
  const body = {
    type: `${docsOrigin}/errors/${code}`,
    title: TITLE[code],
    status,
    code,
    request_id: requestId,
    ...extensions,
  };
  const headers = new Headers({
    "content-type": "application/problem+json",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  if (
    (code === "rate_limited" || code === "unavailable") &&
    typeof extensions.retry_after === "number"
  ) {
    headers.set("retry-after", String(extensions.retry_after));
  }
  return new Response(JSON.stringify(body), { status, headers });
}
