// What a failed `api()` call throws (spec 06 §2.4). Three kinds, so a screen can say the right
// thing: Fin's own problem document; no answer at all ("Couldn't reach Fin"); or an answer that is
// not Fin's JSON (a Cloudflare block, a 502, a 530 or 1033 page). The message names the contract
// and the codes only, never a value from the request or the answer.
import type { Problem } from "@fin/app-contracts";

export type ApiErrorKind = "problem" | "network" | "unexpected_response";

export interface ApiErrorInit {
  kind: ApiErrorKind;
  contract: string;
  status?: number | null;
  problem?: Problem | null;
  requestId?: string | null;
  retryAfterSeconds?: number | null;
  aborted?: boolean;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** The contract's name, never its path with IDs filled in. */
  readonly contract: string;
  readonly status: number | null;
  /** `problem.code`, such as `step_up_required`. */
  readonly code: string | null;
  /** `problem.request_id`, else the `Request-Id` header. */
  readonly requestId: string | null;
  readonly problem: Problem | null;
  /** From `Retry-After` (or the problem's `retry_after`) on a 429; null otherwise. */
  readonly retryAfterSeconds: number | null;
  /** The caller's own signal ended the request (a navigation away), not a timeout. */
  readonly aborted: boolean;

  constructor(init: ApiErrorInit) {
    const status = init.status ?? null;
    const code = init.problem?.code ?? null;
    super(
      [`${init.contract}:`, init.kind, status === null ? null : String(status), code]
        .filter((part) => part !== null)
        .join(" "),
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = "ApiError";
    this.kind = init.kind;
    this.contract = init.contract;
    this.status = status;
    this.code = code;
    this.problem = init.problem ?? null;
    this.requestId = init.problem?.request_id ?? init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.aborted = init.aborted ?? false;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** True for the failures a screen shows as "Couldn't reach Fin" with Try again. */
export function isUnreachable(error: unknown): boolean {
  return isApiError(error) && (error.kind === "network" || error.kind === "unexpected_response");
}
