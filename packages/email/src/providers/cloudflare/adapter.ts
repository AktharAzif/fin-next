// The Cloudflare Email Sending adapter behind EmailPort (ARCHITECTURE §9.2, §9.3; [EM-01]).
//
// One `fetch` to `POST /client/v4/accounts/{account_id}/email/sending/send` with a bearer token; no
// SDK, no Worker. Its rules:
//   - 5 s per try and 7 s per send in all; the answer body is read up to 16 KB;
//   - only 429 with code 10004 is retried in line, up to 3 tries with jittered backoff, inside the
//     budget; never a timeout or a 5xx (there is no idempotency key, so the message may have gone);
//   - a 429 that is not 10004, or a `retry-after` beyond the budget, is handed back as `throttled`
//     so the outbox row waits;
//   - only `success`, the numeric error codes and the LENGTHS of the result arrays are read (the
//     arrays hold addresses; `message_id` is not read either). `queued` counts as sent; a 200 with a
//     non-empty `permanent_bounces` or `suppressed_recipients` is a failure;
//   - 10001, 10200, 10201 and 10202 are never retried and alert; 10105, 10203, 10207, 401 and 403
//     page;
//   - every header is checked against Cloudflare's allowlist before the call (one bad header fails
//     the whole send); `from` is `{ address, name }`; one recipient per message.
// Each try writes one `provider.call` line (ARCHITECTURE §10.2; spec 08 §7.2), so in-line retries,
// throttles and timeouts reach the provider metrics: the outcome, a bounded failure and code, the
// try's index and duration, and Fin's IDs, never an address. The sender writes `email.sent` /
// `email.send_failed` from the outcome, once per row.
import { checkHeaders, HeaderRefused } from "../../headers.ts";
import type {
  EmailPort,
  FailureKind,
  OutgoingEmail,
  ProviderLog,
  SendOutcome,
} from "../../port.ts";
import { API_ORIGIN } from "./hosts.ts";

export const PROVIDER = "cloudflare-email";

export interface AdapterClock {
  now(): number;
}

export interface CloudflareAdapterOptions {
  readonly accountId: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly clock?: AdapterClock;
  readonly sleep?: (ms: number) => Promise<void>;
  /** A uniform value in [0, 1), for the backoff's jitter. */
  readonly random?: () => number;
  /** Makes the per-try abort signal; tests shorten it. */
  readonly timeoutSignal?: (ms: number) => AbortSignal;
  readonly tryTimeoutMs?: number;
  readonly budgetMs?: number;
  readonly maxTries?: number;
  readonly maxBodyBytes?: number;
  /** Where each try's `provider.call` line goes; the worker passes its telemetry. */
  readonly log?: ProviderLog;
}

export const TRY_TIMEOUT_MS = 5000;
export const SEND_BUDGET_MS = 7000;
export const MAX_TRIES = 3;
export const MAX_BODY_BYTES = 16 * 1024;
const BACKOFF_BASE_MS = 400;
/** A retry is not started unless this much budget is left for the try itself. */
const MIN_TRY_MS = 1000;

const NEVER_RETRIED = new Set([10001, 10200, 10201, 10202]);
const PAGING = new Set([10101, 10102, 10103, 10105, 10203, 10207]);
const THROTTLED = 10004;

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;

export class AdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConfigError";
  }
}

interface Answer {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly success: boolean | undefined;
  readonly codes: readonly number[];
  readonly counts: {
    readonly delivered: number;
    readonly queued: number;
    readonly bounced: number;
    readonly suppressed: number;
  };
}

/** Reads at most `limit` bytes of a body and cancels the rest. */
export async function readCapped(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = limit - size;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** Picks out only what the adapter may read: success, numeric codes and array lengths. */
export function parseAnswer(
  status: number,
  body: string,
  retryAfterMs: number | undefined,
): Answer {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const codes = errors
    .map((e) =>
      typeof e === "object" && e !== null ? (e as Record<string, unknown>).code : undefined,
    )
    // Cloudflare's codes are small positive integers; anything else is left out, so a code we write
    // (`cf_<n>`, which becomes the outbox row's `last_error_code`) always has the shape its CHECK allows.
    .filter(
      (c): c is number =>
        typeof c === "number" && Number.isSafeInteger(c) && c >= 0 && c <= 9_999_999,
    );
  const result =
    typeof record.result === "object" && record.result !== null
      ? (record.result as Record<string, unknown>)
      : {};
  return {
    status,
    retryAfterMs,
    success: typeof record.success === "boolean" ? record.success : undefined,
    codes,
    counts: {
      delivered: arrayLength(result.delivered),
      queued: arrayLength(result.queued),
      bounced: arrayLength(result.permanent_bounces),
      suppressed: arrayLength(result.suppressed_recipients),
    },
  };
}

/** `retry-after` as seconds or an HTTP date, in milliseconds from now. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d{1,7}$/u.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

type Verdict =
  | { readonly ok: true; readonly status: "delivered" | "queued" }
  | {
      readonly ok: false;
      readonly kind: FailureKind;
      readonly code: string;
      readonly severity: "page" | "alert" | "none";
      readonly retryInLine: boolean;
    };

function codeOf(answer: Answer): string {
  const first = answer.codes[0];
  return first === undefined ? `http_${answer.status}` : `cf_${first}`;
}

/** Turns one answer into a verdict (ARCHITECTURE §9.3's table). */
export function classify(answer: Answer): Verdict {
  const { status, codes, counts } = answer;
  if (status >= 200 && status < 300 && answer.success === true) {
    if (counts.bounced > 0)
      return {
        ok: false,
        kind: "permanent",
        code: "bounced",
        severity: "none",
        retryInLine: false,
      };
    if (counts.suppressed > 0) {
      return {
        ok: false,
        kind: "permanent",
        code: "suppressed",
        severity: "none",
        retryInLine: false,
      };
    }
    if (counts.delivered > 0) return { ok: true, status: "delivered" };
    if (counts.queued > 0) return { ok: true, status: "queued" };
    // Accepted, yet no recipient is accounted for: it may have gone, so it is never resent in line.
    return {
      ok: false,
      kind: "unknown",
      code: "empty_result",
      severity: "alert",
      retryInLine: false,
    };
  }
  if (codes.some((c) => PAGING.has(c)) || status === 401 || status === 403) {
    return {
      ok: false,
      kind: "blocked",
      code: codeOf(answer),
      severity: "page",
      retryInLine: false,
    };
  }
  if (codes.some((c) => NEVER_RETRIED.has(c))) {
    return {
      ok: false,
      kind: "permanent",
      code: codeOf(answer),
      severity: "alert",
      retryInLine: false,
    };
  }
  if (status === 429) {
    const isThrottle = codes.includes(THROTTLED);
    return {
      ok: false,
      kind: "throttled",
      code: isThrottle ? `cf_${THROTTLED}` : codeOf(answer),
      severity: "none",
      retryInLine: isThrottle,
    };
  }
  if (status >= 500)
    return {
      ok: false,
      kind: "unknown",
      code: codeOf(answer),
      severity: "none",
      retryInLine: false,
    };
  if (status >= 200 && status < 300) {
    // A 2xx that is not `success: true`: an answer we cannot trust either way.
    return {
      ok: false,
      kind: "unknown",
      code: "invalid_response",
      severity: "alert",
      retryInLine: false,
    };
  }
  return {
    ok: false,
    kind: "permanent",
    code: codeOf(answer),
    severity: "alert",
    retryInLine: false,
  };
}

type CallOutcome = "ok" | "refused" | "retry" | "unknown";
type CallFailure =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "unavailable"
  | "timeout"
  | "network"
  | "invalid_response";

/** A failed try's `provider.call` outcome and failure (ARCHITECTURE §10.2's vocabulary). */
export function callFailure(
  kind: FailureKind,
  code: string,
  status: number | undefined,
): { readonly outcome: CallOutcome; readonly failure?: CallFailure } {
  switch (kind) {
    case "throttled":
      return { outcome: "retry", failure: "rate_limited" };
    case "blocked":
      return { outcome: "refused", failure: status === 401 ? "unauthorized" : "forbidden" };
    case "permanent":
      return { outcome: "refused" };
    case "unknown":
      if (code === "timeout") return { outcome: "unknown", failure: "timeout" };
      if (code === "network") return { outcome: "unknown", failure: "network" };
      if (status !== undefined && status >= 500) {
        return { outcome: "unknown", failure: status === 503 ? "unavailable" : "server_error" };
      }
      return { outcome: "unknown", failure: "invalid_response" };
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class CloudflareEmailAdapter implements EmailPort {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: AdapterClock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutSignal: (ms: number) => AbortSignal;
  private readonly tryTimeoutMs: number;
  private readonly budgetMs: number;
  private readonly maxTries: number;
  private readonly maxBodyBytes: number;
  private readonly log: ProviderLog | undefined;

  constructor(options: CloudflareAdapterOptions) {
    if (!ACCOUNT_ID.test(options.accountId)) {
      throw new AdapterConfigError("FIN_EMAIL_ACCOUNT_ID is not a Cloudflare account ID");
    }
    if (options.token.length < 20 || /\s/u.test(options.token)) {
      throw new AdapterConfigError("FIN_EMAIL_TOKEN is not a token");
    }
    this.url = `${API_ORIGIN}/client/v4/accounts/${options.accountId}/email/sending/send`;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? Math.random;
    this.timeoutSignal = options.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
    this.tryTimeoutMs = options.tryTimeoutMs ?? TRY_TIMEOUT_MS;
    this.budgetMs = options.budgetMs ?? SEND_BUDGET_MS;
    this.maxTries = options.maxTries ?? MAX_TRIES;
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    this.log = options.log;
  }

  /** One `provider.call` line for one try. Fields are bounded codes and Fin's IDs only. */
  private logCall(
    message: OutgoingEmail,
    retry: number,
    durationMs: number,
    status: number | undefined,
    outcome: CallOutcome,
    failure: CallFailure | undefined,
    code: string | undefined,
  ): void {
    this.log?.log(
      "provider.call",
      {
        provider: PROVIDER,
        operation: "send",
        ...(status === undefined ? {} : { status }),
        durationMs,
        outcome,
        ...(failure === undefined ? {} : { failure }),
        ...(code === undefined ? {} : { code }),
        retry,
        template: message.template,
        class: message.category,
        ...(message.emailId === undefined ? {} : { emailId: message.emailId }),
      },
      outcome === "ok" ? "info" : "warn",
    );
  }

  async send(message: OutgoingEmail): Promise<SendOutcome> {
    const started = this.clock.now();
    const elapsed = (): number => this.clock.now() - started;
    try {
      checkHeaders(message.headers);
    } catch (error) {
      if (error instanceof HeaderRefused) {
        return {
          ok: false,
          kind: "permanent",
          code: error.code,
          tries: 0,
          durationMs: 0,
          severity: "alert",
        };
      }
      throw error;
    }
    const body = JSON.stringify({
      from: message.from.name === undefined ? { address: message.from.address } : message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
    });

    let tries = 0;
    for (;;) {
      tries += 1;
      const left = this.budgetMs - elapsed();
      const tryStarted = this.clock.now();
      const tryMs = (): number => this.clock.now() - tryStarted;
      let answer: Answer;
      try {
        const response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body,
          redirect: "error",
          signal: this.timeoutSignal(Math.max(1, Math.min(this.tryTimeoutMs, left))),
        });
        const text = await readCapped(response, this.maxBodyBytes);
        answer = parseAnswer(
          response.status,
          text,
          parseRetryAfter(response.headers.get("retry-after"), this.clock.now()),
        );
      } catch (error) {
        const timedOut =
          error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        const code = timedOut ? "timeout" : "network";
        const call = callFailure("unknown", code, undefined);
        this.logCall(message, tries - 1, tryMs(), undefined, call.outcome, call.failure, undefined);
        return {
          ok: false,
          kind: "unknown",
          code,
          tries,
          durationMs: elapsed(),
          severity: "none",
        };
      }

      const verdict = classify(answer);
      if (verdict.ok) {
        this.logCall(message, tries - 1, tryMs(), answer.status, "ok", undefined, undefined);
        return {
          ok: true,
          status: verdict.status,
          tries,
          durationMs: elapsed(),
          httpStatus: answer.status,
        };
      }
      const call = callFailure(verdict.kind, verdict.code, answer.status);
      this.logCall(
        message,
        tries - 1,
        tryMs(),
        answer.status,
        call.outcome,
        call.failure,
        verdict.code,
      );
      if (verdict.retryInLine && tries < this.maxTries) {
        const backoff = this.random() * BACKOFF_BASE_MS * 2 ** (tries - 1);
        const wait = Math.max(answer.retryAfterMs ?? 0, backoff);
        if (elapsed() + wait + MIN_TRY_MS <= this.budgetMs) {
          await this.sleep(wait);
          continue;
        }
      }
      return {
        ok: false,
        kind: verdict.kind,
        code: verdict.code,
        tries,
        durationMs: elapsed(),
        httpStatus: answer.status,
        ...(answer.retryAfterMs === undefined ? {} : { retryAfterMs: answer.retryAfterMs }),
        severity: verdict.severity,
      };
    }
  }
}
