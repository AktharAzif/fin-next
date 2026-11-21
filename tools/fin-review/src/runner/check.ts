// The checks after every session (spec 07 §4.5) and the retries (§4.6), shared by every runner.
//
// After each attempt, in order: the model check first, because a session served by another model
// is never accepted and never retried whatever else went wrong; then the process exited 0 and
// printed Claude Code's JSON result, which is not an error; then structured_output is present and
// matches the session's schema and the caller's own checks. Throttling (HTTP 429 or 529) is retried
// up to four attempts with waits of 15, 60 and 180 seconds; any other failure but a budget stop is
// retried once; never another model, never a lower effort, never --fallback-model.

import type { Clock } from "../clock.ts";
import type { RunOutcome } from "../exec.ts";
import { isJsonObject, parseJsonBytes } from "../json.ts";
import { compileSchema, describeErrors } from "../review/schema.ts";
import type { OutputCheck, SessionFailure, SessionResult, SessionSpec } from "./types.ts";

export const THROTTLE_WAITS_MS: readonly number[] = [15_000, 60_000, 180_000];
const THROTTLE_STATUSES: ReadonlySet<number> = new Set([429, 529]);
const DETAIL_MAX = 160;

export interface AttemptCheck {
  readonly ok: boolean;
  readonly failure?: SessionFailure;
  /** True when the attempt was cancelled rather than failed. */
  readonly cancelled: boolean;
  readonly detail: string;
  readonly output?: unknown;
  readonly modelObserved: readonly string[];
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheReadTokens: number;
  /** The top-level field names of the JSON result (the doctor records them, D5). */
  readonly resultFields: readonly string[];
}

function short(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX)}...` : flat;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function failed(failure: SessionFailure, detail: string, rest: Partial<AttemptCheck> = {}): AttemptCheck {
  return {
    ok: false,
    failure,
    cancelled: false,
    detail,
    modelObserved: [],
    costMicroUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    resultFields: [],
    ...rest,
  };
}

const POLICY_RE = /\bpolic(?:y|ies)\b|\brefus/i;
const THROTTLE_TEXT_RE = /^API Error: (?:429|529)\b|rate_limit_error|overloaded_error/;

/** Checks one attempt's outcome against `spec` (spec 07 §4.5). Pure. */
export function checkAttempt(spec: SessionSpec, outcome: RunOutcome, accept?: OutputCheck): AttemptCheck {
  switch (outcome.kind) {
    case "aborted":
      return { ...failed("exit", "cancelled"), cancelled: true };
    case "timeout":
      return failed("timeout", `no result within ${spec.timeoutMs} ms`);
    case "start":
      return failed("exit", `could not start: ${short(outcome.message)}`);
    case "output":
      return failed("exit", `wrote too much to ${outcome.stream}`);
    case "exited":
      break;
    default: {
      const unreachable: never = outcome;
      throw new TypeError(`unknown outcome ${JSON.stringify(unreachable)}`);
    }
  }
  const exitText = outcome.code === null ? `signal ${outcome.signal ?? "?"}` : `exit ${outcome.code}`;
  const parsed = parseJsonBytes(outcome.stdout);
  if (!parsed.ok || !isJsonObject(parsed.value) || parsed.value["type"] !== "result") {
    const stderr = short(outcome.stderr.toString("utf8"));
    return failed("exit", `${exitText}: no JSON result${parsed.ok ? "" : ` (${parsed.error})`}${stderr === "" ? "" : `; stderr: ${stderr}`}`);
  }
  const result = parsed.value;
  const resultFields = Object.keys(result).sort();
  const usage = isJsonObject(result["usage"]) ? result["usage"] : {};
  const modelUsage = result["modelUsage"];
  const modelObserved = isJsonObject(modelUsage) ? Object.keys(modelUsage).sort() : [];
  const cost = result["total_cost_usd"];
  const base = {
    modelObserved,
    costMicroUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1_000_000) : 0,
    tokensIn: count(usage["input_tokens"]) + count(usage["cache_creation_input_tokens"]),
    tokensOut: count(usage["output_tokens"]),
    cacheReadTokens: count(usage["cache_read_input_tokens"]),
    resultFields,
  };

  // §4.5 rule 3 first: any model but the requested one is a mismatch, whatever else happened.
  const foreign = modelObserved.filter((id) => id !== spec.modelId);
  if (foreign.length > 0) {
    return failed("model_mismatch", `modelUsage names ${foreign.map((id) => short(id)).join(", ")}, not only ${spec.modelId}`, base);
  }
  const isError = result["is_error"] === true;
  const subtype = typeof result["subtype"] === "string" ? result["subtype"] : "";
  const resultText = typeof result["result"] === "string" ? result["result"] : "";
  const apiStatus = result["api_error_status"];
  if ((typeof apiStatus === "number" && THROTTLE_STATUSES.has(apiStatus)) || (isError && THROTTLE_TEXT_RE.test(resultText))) {
    return failed("throttled", `throttled (${typeof apiStatus === "number" ? apiStatus : "API error"})`, base);
  }
  if (subtype === "error_max_budget_usd") return failed("budget", `stopped at its budget of ${spec.maxBudgetUsd} USD`, base);
  if (outcome.code !== 0 || isError) {
    const why = `${exitText}${subtype === "" ? "" : `, ${short(subtype)}`}${isError ? `: ${short(resultText)}` : ""}`;
    return failed(isError && POLICY_RE.test(resultText) ? "refusal" : "exit", why, base);
  }
  if (result["stop_reason"] === "refusal") return failed("refusal", "the model refused (stop_reason refusal)", base);
  if (subtype === "error_max_structured_output_retries") return failed("schema", "no output matched the schema", base);
  if (subtype !== "success") return failed("exit", `result subtype ${short(subtype)}`, base);
  if (!Object.hasOwn(result, "structured_output") || result["structured_output"] === null) {
    return failed("refusal", "no structured_output (the request was declined)", base);
  }
  if (modelObserved.length === 0) return failed("model_mismatch", "modelUsage names no model", base);
  const output = result["structured_output"];
  const schemaErrors = compileSchema(spec.schema)(output);
  if (schemaErrors.length > 0) return failed("schema", `output does not match its schema: ${describeErrors(schemaErrors)}`, { ...base, output });
  const rejected = accept === undefined ? null : accept(output);
  if (rejected !== null) return failed("schema", short(rejected), { ...base, output });
  return { ok: true, cancelled: false, detail: "", output, ...base };
}

export interface RetryDeps {
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly clientVersion: string;
  readonly apiHost: string;
}

/** One attempt: starts the session afresh (a new scratch home) and reports how it ended. */
export type Attempt = (attempt: number) => Promise<RunOutcome>;

/**
 * Runs `attempt` until it passes the checks or the retries of spec 07 §4.6 are spent, and returns
 * the session's result. Cost, tokens and duration add up over every attempt; modelObserved is
 * every model any attempt reported.
 */
export async function runWithRetries(spec: SessionSpec, attempt: Attempt, deps: RetryDeps, accept?: OutputCheck): Promise<SessionResult> {
  const models = new Set<string>();
  let costMicroUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheReadTokens = 0;
  let durationMs = 0;
  let attempts = 0;
  let throttleWaits = 0;
  let retried = false;
  const result = (check: AttemptCheck | null, extra: { failure?: SessionFailure; detail?: string } = {}): SessionResult => {
    const failure = extra.failure ?? check?.failure;
    const detail = extra.detail ?? check?.detail ?? "";
    const keepOutput = check !== null && check.output !== undefined && failure !== "model_mismatch";
    return {
      id: spec.id,
      state: check?.ok === true && failure === undefined ? "ok" : "failed",
      ...(failure === undefined ? {} : { failure, failureDetail: detail }),
      ...(keepOutput ? { output: check.output } : {}),
      modelObserved: [...models].sort(),
      effortObserved: null,
      costMicroUsd,
      tokensIn,
      tokensOut,
      cacheReadTokens,
      durationMs,
      attempts,
      clientVersion: deps.clientVersion,
      apiHost: deps.apiHost,
    };
  };
  for (;;) {
    if (deps.signal.aborted) return result(null, { failure: "exit", detail: "cancelled" });
    attempts++;
    const started = deps.clock.now();
    const outcome = await attempt(attempts);
    durationMs += Math.max(0, deps.clock.now() - started);
    const check = checkAttempt(spec, outcome, accept);
    for (const id of check.modelObserved) models.add(id);
    costMicroUsd += check.costMicroUsd;
    tokensIn += check.tokensIn;
    tokensOut += check.tokensOut;
    cacheReadTokens += check.cacheReadTokens;
    if (check.ok) return result(check);
    if (check.cancelled || deps.signal.aborted) return result(check, { failure: "exit", detail: "cancelled" });
    switch (check.failure) {
      case "model_mismatch":
      case "budget":
        return result(check);
      case "throttled": {
        const wait = THROTTLE_WAITS_MS[throttleWaits];
        if (wait === undefined) return result(check);
        throttleWaits++;
        try {
          await deps.clock.sleep(wait, deps.signal);
        } catch {
          return result(check, { failure: "exit", detail: "cancelled" });
        }
        continue;
      }
      default:
        if (retried) return result(check);
        retried = true;
        continue;
    }
  }
}
