// EmailPort (ARCHITECTURE §9.3): the one interface every email adapter implements. The release image
// has only the Cloudflare adapter; the development sink lives in the `test` image target.
import type { EmailClass } from "./classes.ts";

export interface Mailbox {
  readonly address: string;
  readonly name?: string;
}

/** One message to one recipient (ARCHITECTURE §9.3: one recipient per message). */
export interface OutgoingEmail {
  readonly from: Mailbox;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, string>>;
  /** For the adapter's own observation; never sent as a header beyond X-Fin-Category. */
  readonly template: string;
  readonly category: EmailClass;
}

/**
 * Why a send did not go, and what the outbox does next:
 *   - `permanent`: never retried; the row ends (a security row writes `email.security_unsent`).
 *   - `throttled`: Cloudflare asked us to wait; the row waits `retryAfterMs` or its backoff.
 *   - `blocked`: the token, the entitlement or the account; pages; the row waits and retries.
 *   - `unknown`: a timeout, a network error or a 5xx; the message may already have gone (there is
 *     no idempotency key), so the adapter never retries it in line; the outbox decides.
 */
export type FailureKind = "permanent" | "throttled" | "blocked" | "unknown";

export type SendOutcome =
  | {
      readonly ok: true;
      /** `delivered` or `queued` (queued counts as sent, ARCHITECTURE §9.3). */
      readonly status: "delivered" | "queued";
      readonly tries: number;
      readonly durationMs: number;
      readonly httpStatus: number;
    }
  | {
      readonly ok: false;
      readonly kind: FailureKind;
      /** A bounded code: `cf_<n>` for Cloudflare's numeric codes, `http_<n>`, `timeout`, ... */
      readonly code: string;
      readonly tries: number;
      readonly durationMs: number;
      readonly httpStatus?: number;
      readonly retryAfterMs?: number;
      /** `page` for the token, entitlement and account codes; `alert` for the never-retried ones. */
      readonly severity: "page" | "alert" | "none";
    };

export interface EmailPort {
  send(message: OutgoingEmail): Promise<SendOutcome>;
}
