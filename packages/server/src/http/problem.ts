// RFC 9457 problem documents (ARCHITECTURE §13.2; spec 05 §3.3; spec 02 §14.1): `type` is
// `<docs origin>/errors/<code>`, `title` is per code, `status` equals the HTTP status, `code` is
// stable, `request_id` matches the Request-Id header, and only allowlisted extensions pass.
import { isBoundedCode } from "@fin/core";

export const PROBLEM_TITLES: Readonly<Record<string, string>> = Object.freeze({
  access_required: "Sign in through Access first",
  access_unavailable: "Access cannot be checked right now",
  forbidden: "This request is not allowed",
  https_required: "Use https",
  internal: "Something went wrong on our side",
  invalid: "The request is not valid",
  invalid_origin: "This request did not come from the app",
  misdirected: "This host is not served here",
  not_found: "Not found",
  payload_too_large: "The request body is too large",
  unauthenticated: "Authentication is required",
  unavailable: "The service is unavailable",
});

/** The extensions a problem may carry (ARCHITECTURE §13.2, spec 02 §14.1); anything else drops. */
export const PROBLEM_EXTENSIONS: ReadonlySet<string> = new Set([
  "missing",
  "field",
  "current_status",
  "item",
  "reason",
  "customer_id",
  "violated_policies",
  "retry_after",
  "methods",
  "hold",
  "permission",
  "intent_id",
  "step_up_kind",
  "reason_key",
  "expires_at",
  "problem",
  "limit",
  "target_id",
  "fields",
]);

export interface ProblemInput {
  status: number;
  code: string;
  detail?: string;
  extensions?: Readonly<Record<string, unknown>>;
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: string;
  request_id: string;
  detail?: string;
  [extension: string]: unknown;
}

/** Builds the document; an unknown code is an internal error, never echoed. */
export function problemDocument(
  docsOrigin: string,
  requestId: string,
  input: ProblemInput,
): ProblemDocument {
  const code = isBoundedCode(input.code) && !input.code.includes(".") ? input.code : "internal";
  const doc: ProblemDocument = {
    type: `${docsOrigin}/errors/${code}`,
    title: PROBLEM_TITLES[code] ?? "The request was refused",
    status: input.status,
    code,
    request_id: requestId,
  };
  if (input.detail !== undefined) doc.detail = input.detail;
  for (const [key, value] of Object.entries(input.extensions ?? {})) {
    if (PROBLEM_EXTENSIONS.has(key) && value !== undefined) doc[key] = value;
  }
  return doc;
}

export function problemResponse(
  docsOrigin: string,
  requestId: string,
  input: ProblemInput,
  headers?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(problemDocument(docsOrigin, requestId, input)), {
    status: input.status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}
