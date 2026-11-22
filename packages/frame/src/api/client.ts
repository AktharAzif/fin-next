// `api()`: the one client every screen uses for its app's own JSON routes (FW-C08, spec 06 §2.4).
// Every call is relative and same-origin (`/api/...`), so there is no CORS and no preflight, and
// the session cookie travels by default. Every unsafe method carries `X-Fin-App: <app>`, the third
// check of the origin gate (FW-C09); a body is always JSON. The answer is parsed with the
// contract's output schema, and Fin's problem documents are mapped to the frame's reactions:
// step-up (re-sent once after the proof), the factor and session gates, rate limits and the
// release toast. There is no query library and no retry loop.
import {
  type AppContract,
  type AppName,
  type ContractInput,
  type ContractOutput,
  isUnsafeMethod,
  PROBLEM_CONTENT_TYPE,
  type Problem,
  problemSchema,
  rateLimitedSchema,
  type StepUpRequired,
  secondFactorRequiredSchema,
  stepUpRequiredSchema,
} from "@fin/app-contracts";
import { ApiError } from "./errors.ts";
import { buildRequest, parseRetryAfter } from "./request.ts";

export const DEFAULT_TIMEOUT_MS = 30_000;

/** The proof the root StepUp modal hands back (spec 02 §7.1, §7.5). */
export interface StepUpProof {
  /** The intent the person proved, re-sent as `Fin-Step-Up-Intent`; null for a window. */
  readonly intentId: string | null;
  /**
   * Called once with the re-sent request's outcome, so the modal can close, or show "That didn't
   * work. Try again." on `step_up_invalid` (it never loops).
   */
  settle(outcome: "done" | "invalid" | "failed"): void;
}

/** What the frame does when an answer needs more than the calling screen (spec 06 §2.4's table). */
export interface ApiHooks {
  /** Opens the root StepUp modal; resolves with the proof, or null if the person closed it. */
  stepUp?: (required: StepUpRequired) => Promise<StepUpProof | null>;
  /** A 401: on an `app`-frame route the session has gone; on an `auth` route it is the answer. */
  unauthenticated?: (problem: Problem) => void;
  /**
   * `second_factor_required`: the root dialog's "Add a second factor first"; with `hold`, the
   * console sends the person to `/welcome/secure` instead.
   */
  secondFactorRequired?: (hold: boolean) => void;
  /** `factor_step_required`: back to the sign-in's factor step. */
  factorStepRequired?: () => void;
  /** `fresh_session_required`: the root dialog's "Sign in by email to add a second factor". */
  freshSessionRequired?: () => void;
  /** Every answer's `Fin-Release`; the frame compares it with env.json's release (FW-C13). */
  release?: (release: string) => void;
  /** Fin Admin: an opaque redirect means Access ended the session; the frame reloads. */
  opaqueRedirect?: () => void;
  /** An answer that failed its contract's schema, reported with IDs only (spec 06 §2.6). */
  report?: (error: unknown, ids: Record<string, string>) => void;
}

export interface ApiConfig {
  app: AppName;
  /** `/api` (same origin). Under the fallback shape, env.json's API origin plus `/api`. */
  base?: string;
  /** `same-origin`; `include` only under the fallback shape (ARCHITECTURE §5.17). */
  credentials?: RequestCredentials;
  /** Fin Admin sets this: `redirect: "manual"`, so an Access redirect is seen, not followed. */
  manualRedirect?: boolean;
  /** The console's current organisation, for contracts that read `Fin-Organization`. */
  organization?: () => string | null;
  fetch?: typeof fetch;
  randomUUID?: () => string;
  now?: () => number;
}

export interface ApiOptions {
  /** Kept across one user action's retries; a fresh one is made when absent on a create. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Overrides the current organisation for this call (null sends none). */
  organization?: string | null;
}

export type Api = <C extends AppContract>(
  contract: C,
  input: ContractInput<C>,
  options?: ApiOptions,
) => Promise<ContractOutput<C>>;

export interface ApiClient {
  api: Api;
  /**
   * Adds or replaces the hooks it names; every hook it does not name stays as it was. The frame
   * installs its own at boot (startApp), so a later call from an app can never switch off the
   * step-up re-send, the sign-in redirect or the release toast by leaving them out.
   */
  configure(hooks: ApiHooks): void;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1 && signals[0] !== undefined) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("The request timed out", "TimeoutError")), ms);
  return controller.signal;
}

function isJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type === PROBLEM_CONTENT_TYPE || type.endsWith("+json");
}

async function readJson(response: Response): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

/**
 * A base without its trailing slashes. One backward pass over the slashes it drops, never a
 * pattern: an unanchored `/\/+$/` retries at every slash of an inner run, quadratic in its length.
 */
function withoutTrailingSlashes(base: string): string {
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end -= 1;
  return base.slice(0, end);
}

export function createApiClient(config: ApiConfig): ApiClient {
  let hooks: ApiHooks = {};
  const base = withoutTrailingSlashes(config.base ?? "/api");
  const fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  const uuid = config.randomUUID ?? (() => crypto.randomUUID());
  const now = config.now ?? (() => Date.now());

  const api: Api = async (contract, input, options = {}) => {
    const { path, body } = buildRequest(contract, input);
    const unsafe = isUnsafeMethod(contract.method);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (unsafe) headers["X-Fin-App"] = config.app;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (contract.organization === true) {
      const organization =
        options.organization === undefined
          ? (config.organization?.() ?? null)
          : options.organization;
      if (organization !== null) headers["Fin-Organization"] = organization;
    }
    const idempotencyKey =
      options.idempotencyKey ?? (unsafe && contract.creates === true ? uuid() : undefined);
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;

    const send = async (extraHeaders: Record<string, string>): Promise<Response> => {
      const signals = [timeoutSignal(contract.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
      if (options.signal !== undefined) signals.push(options.signal);
      const init: RequestInit = {
        method: contract.method,
        headers: { ...headers, ...extraHeaders },
        credentials: config.credentials ?? "same-origin",
        cache: "no-store",
        redirect: config.manualRedirect === true ? "manual" : "follow",
        signal: combineSignals(signals),
      };
      if (body !== undefined) init.body = body;
      try {
        return await fetchImpl(`${base}${path}`, init);
      } catch (cause) {
        throw new ApiError({
          kind: "network",
          contract: contract.name,
          aborted: options.signal?.aborted === true,
          cause,
        });
      }
    };

    /** Reads one answer: the parsed output, or the ApiError to throw. */
    const read = async (
      response: Response,
    ): Promise<{ ok: true; value: unknown } | { ok: false; error: ApiError }> => {
      if (response.type === "opaqueredirect") {
        hooks.opaqueRedirect?.();
        return {
          ok: false,
          error: new ApiError({ kind: "unexpected_response", contract: contract.name }),
        };
      }
      const release = response.headers.get("Fin-Release");
      if (release !== null && release !== "") hooks.release?.(release);
      const requestId = response.headers.get("Request-Id");
      const fail = (init: Omit<ConstructorParameters<typeof ApiError>[0], "contract">) => ({
        ok: false as const,
        error: new ApiError({
          contract: contract.name,
          status: response.status,
          requestId,
          ...init,
        }),
      });

      if (response.ok) {
        let value: unknown = null;
        if (response.status !== 204 && response.status !== 205) {
          const text = await response.text().catch(() => null);
          if (text === null) return fail({ kind: "unexpected_response" });
          if (text !== "") {
            if (!isJson(response.headers.get("Content-Type")))
              return fail({ kind: "unexpected_response" });
            try {
              value = JSON.parse(text);
            } catch {
              return fail({ kind: "unexpected_response" });
            }
          }
        }
        const output = contract.output.safeParse(value);
        if (!output.success) {
          hooks.report?.(new Error(`${contract.name}: the answer does not match the contract`), {
            contract: contract.name,
            ...(requestId === null ? {} : { requestId }),
          });
          return fail({ kind: "unexpected_response" });
        }
        return { ok: true, value: output.data };
      }

      const json = isJson(response.headers.get("Content-Type"))
        ? await readJson(response)
        : { ok: false as const };
      const problem = json.ok ? problemSchema.safeParse(json.value) : null;
      if (problem === null || !problem.success || problem.data.status !== response.status) {
        return fail({ kind: "unexpected_response" });
      }
      const retryAfterSeconds =
        response.status === 429
          ? (parseRetryAfter(response.headers.get("Retry-After"), now()) ??
            rateLimitedSchema.safeParse(problem.data).data?.retry_after ??
            null)
          : null;
      return fail({ kind: "problem", problem: problem.data, retryAfterSeconds });
    };

    const react = (error: ApiError): void => {
      const problem = error.problem;
      if (problem === null) return;
      if (error.status === 401) hooks.unauthenticated?.(problem);
      else if (problem.code === "second_factor_required") {
        hooks.secondFactorRequired?.(
          secondFactorRequiredSchema.safeParse(problem).data?.hold === true,
        );
      } else if (problem.code === "factor_step_required") hooks.factorStepRequired?.();
      else if (problem.code === "fresh_session_required") hooks.freshSessionRequired?.();
    };

    const first = await read(await send({}));
    if (first.ok) return first.value as ContractOutput<typeof contract>;
    const stepUp =
      first.error.code === "step_up_required"
        ? stepUpRequiredSchema.safeParse(first.error.problem)
        : null;
    if (stepUp === null || !stepUp.success || hooks.stepUp === undefined) {
      react(first.error);
      throw first.error;
    }
    if (stepUp.data.step_up_kind === "intent" && stepUp.data.intent_id === undefined)
      throw first.error;

    const proof = await hooks.stepUp(stepUp.data);
    if (proof === null) throw first.error;
    // Re-send once: the same body, the same Idempotency-Key, plus the proved intent.
    let second: Awaited<ReturnType<typeof read>>;
    try {
      second = await read(
        await send(proof.intentId === null ? {} : { "Fin-Step-Up-Intent": proof.intentId }),
      );
    } catch (error) {
      proof.settle("failed");
      throw error;
    }
    if (second.ok) {
      proof.settle("done");
      return second.value as ContractOutput<typeof contract>;
    }
    proof.settle(second.error.code === "step_up_invalid" ? "invalid" : "failed");
    react(second.error);
    throw second.error;
  };

  return {
    api,
    configure(next) {
      hooks = { ...hooks, ...next };
    },
  };
}
