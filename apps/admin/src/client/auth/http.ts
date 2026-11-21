// The staff realm's library endpoints under `/api/auth/*` (spec 02 §4.3), called with the same rules
// as @fin/frame's api(): relative and same-origin, `X-Fin-App: admin` on every unsafe call, JSON
// bodies only (a body-less POST carries no content type), no cache, a 30-second limit, and
// `redirect: "manual"`, because an opaque redirect means Cloudflare Access ended the session and
// the page must load again (FW-C08). The library answers its own `{ code, message }` bodies (such as
// `INVALID_OTP`), and Fin's before-hook answers problem documents; both are returned as data, so a
// screen can tell a wrong code from an expired one. Nothing here logs a value from the request or
// the answer.
import { PROBLEM_CONTENT_TYPE, type Problem, problemSchema } from "@fin/app-contracts";
import { parseRetryAfter } from "@fin/frame";

export const AUTH_TIMEOUT_MS = 30_000;

export type AuthAnswer =
  | { readonly ok: true; readonly status: number; readonly data: unknown }
  /** No answer at all: offline, refused, or the 30 seconds ran out. */
  | { readonly ok: false; readonly kind: "network" }
  /** Access sent the request to its login: the page reloads (handled by the caller's hook). */
  | { readonly ok: false; readonly kind: "access" }
  /** An answer that is neither the library's nor Fin's (a Cloudflare page, a 502). */
  | { readonly ok: false; readonly kind: "unexpected"; readonly status: number }
  /** The library's own refusal: `{ code, message }`, upper-case codes. */
  | { readonly ok: false; readonly kind: "library"; readonly status: number; readonly code: string }
  /** Fin's problem document, from the before-hook or the gate. */
  | {
      readonly ok: false;
      readonly kind: "problem";
      readonly status: number;
      readonly problem: Problem;
      readonly retryAfterSeconds: number | null;
    };

export type AuthFailure = Exclude<AuthAnswer, { ok: true }>;

export interface AuthRequest {
  readonly method: "GET" | "POST";
  /** The path under `/api/auth`, such as `/sign-in/email-otp`. */
  readonly path: `/${string}`;
  /** A JSON body; absent for a GET and for a body-less POST. */
  readonly body?: Readonly<Record<string, unknown>>;
  /** The intent a step-up proves (`Fin-Step-Up-Intent`, spec 02 §7.4). */
  readonly intentId?: string | null;
  readonly signal?: AbortSignal;
}

export interface AuthTransport {
  fetch?: typeof fetch;
  now?: () => number;
  /** Access ended the session: by default the page loads again and Access signs the person in. */
  onAccessRedirect?: () => void;
}

function isJson(contentType: string | null): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type === PROBLEM_CONTENT_TYPE || type.endsWith("+json");
}

function libraryCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : null;
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** Sends one request to the staff realm and reads its answer; never throws. */
export async function authRequest(
  request: AuthRequest,
  transport: AuthTransport = {},
): Promise<AuthAnswer> {
  const fetchImpl = transport.fetch ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (request.method !== "GET") headers["X-Fin-App"] = "admin";
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  if (request.intentId !== undefined && request.intentId !== null) {
    headers["Fin-Step-Up-Intent"] = request.intentId;
  }
  const signals = [timeout(AUTH_TIMEOUT_MS)];
  if (request.signal !== undefined) signals.push(request.signal);
  const init: RequestInit = {
    method: request.method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.any(signals),
  };
  if (request.body !== undefined) init.body = JSON.stringify(request.body);

  let response: Response;
  try {
    response = await fetchImpl(`/api/auth${request.path}`, init);
  } catch {
    return { ok: false, kind: "network" };
  }
  if (response.type === "opaqueredirect") {
    (transport.onAccessRedirect ?? (() => window.location.reload()))();
    return { ok: false, kind: "access" };
  }

  const json = isJson(response.headers.get("Content-Type"));
  let value: unknown = null;
  if (response.status !== 204) {
    const text = await response.text().catch(() => null);
    if (text === null) return { ok: false, kind: "unexpected", status: response.status };
    if (text !== "") {
      if (!json) return { ok: false, kind: "unexpected", status: response.status };
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, kind: "unexpected", status: response.status };
      }
    }
  }
  if (response.ok) return { ok: true, status: response.status, data: value };

  const problem = problemSchema.safeParse(value);
  if (problem.success && problem.data.status === response.status) {
    return {
      ok: false,
      kind: "problem",
      status: response.status,
      problem: problem.data,
      retryAfterSeconds:
        response.status === 429
          ? parseRetryAfter(response.headers.get("Retry-After"), (transport.now ?? Date.now)())
          : null,
    };
  }
  const code = libraryCode(value);
  if (code !== null) return { ok: false, kind: "library", status: response.status, code };
  return { ok: false, kind: "unexpected", status: response.status };
}

/** The problem's code, the library's code, or null. */
export function failureCode(failure: AuthFailure): string | null {
  if (failure.kind === "problem") return failure.problem.code;
  if (failure.kind === "library") return failure.code;
  return null;
}

/** A string extension of the problem (`reason`, `problem`), or null. */
export function problemField(failure: AuthFailure, field: string): string | null {
  if (failure.kind !== "problem") return null;
  const value = (failure.problem as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}
