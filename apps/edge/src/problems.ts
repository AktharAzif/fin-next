// The public API's problem documents (RFC 9457; spec 05 §3.3, [AP-03]): `type` is
// `<docs origin>/errors/<code>`, `title` one per code (British English, sentence case, no full stop),
// `status` the HTTP status, `detail` Fin's own words that never echo input, `code`, `next_actor` and
// `request_id` as the Request-Id header. The codes here are the platform codes the edge raises
// (spec 05 §3.3.4); L-SUN-01's `packages/contract/src/errors/platform.ts` takes the catalogue over,
// with the rest of §3.3, when it lands.
import type { FinContext } from "@fin/server/http";

export type NextActor = "developer" | "customer" | "fin";

interface Entry {
  status: number;
  title: string;
  nextActor: NextActor;
}

export const EDGE_PROBLEMS = {
  invalid_request: { status: 400, title: "The request is not valid", nextActor: "developer" },
  api_version_unknown: {
    status: 400,
    title: "Fin doesn't know this API version",
    nextActor: "developer",
  },
  unauthenticated: { status: 401, title: "Send a valid API key", nextActor: "developer" },
  forbidden: { status: 403, title: "This key can't do that", nextActor: "developer" },
  https_required: { status: 403, title: "Call the API over https", nextActor: "developer" },
  sandbox_key_required: { status: 403, title: "Use a Sandbox key here", nextActor: "developer" },
  live_not_enabled: { status: 403, title: "Production isn't enabled yet", nextActor: "developer" },
  live_paused: { status: 403, title: "Production access is paused", nextActor: "developer" },
  sandbox_only: { status: 403, title: "This works in the Sandbox only", nextActor: "developer" },
  not_found: { status: 404, title: "Not found", nextActor: "developer" },
  body_too_large: { status: 413, title: "The request body is too large", nextActor: "developer" },
  rate_limited: { status: 429, title: "Too many requests", nextActor: "developer" },
  internal: { status: 500, title: "Something went wrong on Fin's side", nextActor: "fin" },
  temporarily_unavailable: {
    status: 503,
    title: "This is unavailable for a moment",
    nextActor: "fin",
  },
} as const satisfies Readonly<Record<string, Entry>>;

export type EdgeProblemCode = keyof typeof EDGE_PROBLEMS;

/** The one sentence every 401 carries, whatever the reason (spec 05 §3.3.4, T05-08). */
export const UNAUTHENTICATED_DETAIL =
  "Send a valid API key as `Authorization: Bearer fin_test_...` or `fin_live_...`. A key with an address allowlist works only from those addresses.";
/** What a 401 from the docs origin adds. */
export const FROM_DOCS_DETAIL = " Try it calls from your browser's address.";

/** The extensions a public problem may carry (spec 05 §3.3.1); anything else is dropped. */
const EXTENSIONS = new Set([
  "missing",
  "field",
  "current_status",
  "item",
  "reason",
  "customer_id",
  "violated_policies",
]);

export interface EdgeProblem {
  code: EdgeProblemCode;
  detail?: string;
  extensions?: Readonly<Record<string, unknown>>;
  headers?: Readonly<Record<string, string>>;
}

export function problemBody(docsOrigin: string, requestId: string, problem: EdgeProblem): string {
  const entry = EDGE_PROBLEMS[problem.code];
  const doc: Record<string, unknown> = {
    type: `${docsOrigin}/errors/${problem.code}`,
    title: entry.title,
    status: entry.status,
  };
  if (problem.detail !== undefined) doc.detail = problem.detail;
  doc.code = problem.code;
  doc.next_actor = entry.nextActor;
  doc.request_id = requestId;
  for (const [key, value] of Object.entries(problem.extensions ?? {})) {
    if (EXTENSIONS.has(key) && value !== undefined) doc[key] = value;
  }
  return JSON.stringify(doc);
}

/** Answers a problem for this request, with `Retry-After` on every 429 and 503. */
export function problemAnswer(c: FinContext, docsOrigin: string, problem: EdgeProblem): Response {
  const entry = EDGE_PROBLEMS[problem.code];
  const headers = new Headers({ "content-type": "application/problem+json", ...problem.headers });
  if ((entry.status === 429 || entry.status === 503) && !headers.has("retry-after")) {
    headers.set("retry-after", entry.status === 429 ? "1" : "5");
  }
  if (entry.status === 401) headers.set("www-authenticate", "Bearer");
  return new Response(problemBody(docsOrigin, c.get("requestId") ?? "req_unknown", problem), {
    status: entry.status,
    headers,
  });
}
