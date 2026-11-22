// The sender's numbers (ARCHITECTURE §9.4, §9.5; spec 08 §4.3). Every limit that must agree across
// replicas or survive a restart is counted in Postgres; these are only the thresholds.
import type { BucketSettings } from "../outbox/store.ts";

export interface SenderLimits {
  /** Messages in flight at once in one loop run. */
  readonly concurrency: number;
  /** Of `concurrency`, the share ordinary mail may never use: kept for codes and security notices. */
  readonly reservedUrgent: number;
  readonly leaseMs: number;
  /** Security notices to one recipient per hour before they fold into a digest ([SA-41]). */
  readonly securityPerHour: number;
  /**
   * The backstop for every other class, per recipient per hour (the asking endpoints limit first).
   * Each code template has a window of its own (`code:identity/sign-in-code`), and notices and
   * customer mail one per class and template folder (`notice:orgs`), so invitations, customer mail or
   * other codes never use up the window a person's sign-in codes depend on.
   */
  readonly otherPerHour: number;
  /** A digest goes at the end of the hour, or this long after its first fold, whichever is sooner. */
  readonly digestDelayMs: number;
  /**
   * Cloudflare blocks a token for 5 minutes after 1,200 calls in 5 minutes. capacity + 300 × rate
   * must stay below 1,200: 150 + 300 × 3 = 1,050.
   */
  readonly bucket: BucketSettings;
  /** Tokens ordinary mail must leave in the bucket for codes and security notices. */
  readonly bucketReserve: number;
  /** The environment's daily send budget, and the share only codes, security and ops may use. */
  readonly dailyBudget: number;
  readonly dailySecurityReserve: number;
  /**
   * Of that share, the part only codes may use (a flood of security notices cannot take it) and the
   * part only security and ops may use (a flood of codes cannot take it). Their sum is at most
   * `dailySecurityReserve`; the rest of the share is for either.
   */
  readonly dailyCodeOnlyReserve: number;
  readonly dailySecurityOnlyReserve: number;
  /**
   * Of the security-only part, the part only security and ops mail that names no organisation may
   * use (a person's own sign-ins and locks, staff notices, the digest and the delivery check):
   * neither organisations' notices nor codes can take it, however many organisations there are.
   */
  readonly dailyAccountSecurityReserve: number;
  /** Per organisation per day, for ordinary rows whose params name an organisation ([SA-40]). */
  readonly dailyPerOrganisation: number;
  /**
   * Per organisation per day for security notices, bypass templates included, so one team cannot
   * spend what every organisation's notices may use. It is below that share at its smallest
   * (`dailySecurityOnlyReserve − dailyAccountSecurityReserve`, once ordinary mail and codes have
   * used all they may). Past it they wait until the next UTC day, never dropped, and
   * `email.security_unsent` (reason `budget`) pages.
   */
  readonly dailySecurityPerOrganisation: number;
  /** Retry backoff: base × 2^(attempt-1), capped; half of it fixed and half jittered. */
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  /** Wait after a token, entitlement or account refusal (they page; the row keeps waiting). */
  readonly blockedWaitMs: number;
  /** Ordinary rows end after this many attempts; security rows never end on a retryable failure. */
  readonly maxAttempts: number;
  /** After this many failed attempts a security row writes `email.security_unsent` (once). */
  readonly securityUnsentAfter: number;
  /**
   * How long a row this release cannot render (its template, or its params, belong to another
   * release: a rolling deploy or a rollback) waits for a worker that can, from when it was queued.
   * It is tried every `blockedWaitMs`; a security row says so with `email.security_unsent` after
   * `securityUnsentAfter` tries and waits the longer bound.
   */
  readonly releaseWaitMaxMs: number;
  readonly securityReleaseWaitMaxMs: number;
}

export const DEFAULT_LIMITS: SenderLimits = Object.freeze({
  concurrency: 4,
  reservedUrgent: 1,
  leaseMs: 60_000,
  securityPerHour: 5,
  otherPerHour: 20,
  digestDelayMs: 10 * 60_000,
  bucket: Object.freeze({ name: "cloudflare", capacity: 150, ratePerSecond: 3 }),
  bucketReserve: 50,
  dailyBudget: 2_000,
  dailySecurityReserve: 500,
  dailyCodeOnlyReserve: 200,
  dailySecurityOnlyReserve: 200,
  dailyAccountSecurityReserve: 50,
  dailyPerOrganisation: 300,
  dailySecurityPerOrganisation: 100,
  retryBaseMs: 30_000,
  retryCapMs: 30 * 60_000,
  blockedWaitMs: 5 * 60_000,
  maxAttempts: 10,
  securityUnsentAfter: 5,
  releaseWaitMaxMs: 24 * 3_600_000,
  securityReleaseWaitMaxMs: 7 * 24 * 3_600_000,
});

/** Refuses limits whose shares do not fit inside the budget. */
export function checkLimits(limits: SenderLimits): void {
  if (limits.reservedUrgent >= limits.concurrency) {
    throw new Error("reservedUrgent must leave ordinary mail at least one slot");
  }
  if (limits.dailySecurityReserve > limits.dailyBudget) {
    throw new Error("dailySecurityReserve must fit inside dailyBudget");
  }
  if (limits.dailyCodeOnlyReserve + limits.dailySecurityOnlyReserve > limits.dailySecurityReserve) {
    throw new Error("the code-only and security-only shares must fit inside dailySecurityReserve");
  }
  if (limits.dailyAccountSecurityReserve > limits.dailySecurityOnlyReserve) {
    throw new Error("dailyAccountSecurityReserve must fit inside dailySecurityOnlyReserve");
  }
  if (limits.dailyPerOrganisation >= limits.dailyBudget - limits.dailySecurityReserve) {
    throw new Error(
      "dailyPerOrganisation must stay below ordinary mail's part, so one organisation cannot spend it all",
    );
  }
  // What organisations' notices may use at the least: ordinary mail and codes have used all they may.
  const organisations = limits.dailySecurityOnlyReserve - limits.dailyAccountSecurityReserve;
  if (limits.dailySecurityPerOrganisation >= organisations) {
    throw new Error(
      "dailySecurityPerOrganisation must stay below what organisations' notices may use, so one cannot spend it all",
    );
  }
}

/** Which daily counters a send uses: ordinary mail, codes, or security and ops. */
export type BudgetGroup = "ordinary" | "code" | "security";

/**
 * The budget scopes of a send. `raise`: what it is counted against (the environment, its group's
 * counter for codes or for security and ops, `class:org-security` too for a security notice that
 * names an organisation, and that organisation's counter). `read`: what the decision needs, which is
 * `raise` plus every class counter, because the share one group keeps depends on what the others
 * have used.
 */
export function budgetScopes(
  group: BudgetGroup,
  orgId: string | undefined,
): { readonly read: string[]; readonly raise: string[] } {
  const raise = ["environment"];
  if (group === "code") raise.push("class:code");
  if (group === "security") raise.push("class:security");
  if (orgId !== undefined) {
    if (group === "ordinary") raise.push(`org:${orgId}`);
    else raise.push("class:org-security", `org-security:${orgId}`);
  }
  const read = [...new Set([...raise, "class:code", "class:security", "class:org-security"])];
  return { read, raise };
}

/** Which share a refused send ran into, for `email.budget_reached`. */
export type BudgetShare = "ordinary" | "all" | "code_only" | "security_only" | "account_only";

export interface BudgetRefusal {
  /** `environment`, or the organisation's counter that refused (`org:...`, `org-security:...`). */
  readonly scope: string;
  readonly share: BudgetShare;
}

/**
 * Whether one more send fits, from the counts of its scopes before the send (ARCHITECTURE §9.5;
 * [SA-40]). Each kept part holds because everyone else's use stays below the budget less that part:
 * - ordinary mail stops at the budget less the reserved share;
 * - security and ops may not take the part kept only for codes (`env − code < budget − codeOnly`);
 * - codes may not take the part kept only for security and ops (`env − security < budget −
 *   securityOnly`);
 * - neither codes nor organisations' security notices may take the part kept for security and ops
 *   that names no organisation (`env − account < budget − account share`, where `account` is
 *   `security − org-security`), and organisations' notices may not take it out of what codes leave
 *   either (`env − code − account < budget − codeOnly − account share`);
 * - each organisation has its own ceilings, for ordinary mail and for security notices.
 * `orgId` is the organisation a send names (counted only for ordinary mail and security notices).
 * Returns the refusal, or undefined when the send fits.
 */
export function budgetRefusal(
  group: BudgetGroup,
  counts: Readonly<Record<string, number>>,
  limits: SenderLimits,
  orgId?: string,
): BudgetRefusal | undefined {
  const env = counts.environment ?? 0;
  const codes = counts["class:code"] ?? 0;
  const security = counts["class:security"] ?? 0;
  const account = security - (counts["class:org-security"] ?? 0);
  const total = limits.dailyBudget;
  const accountShare = limits.dailyAccountSecurityReserve;
  const environment = (share: BudgetShare): BudgetRefusal => ({ scope: "environment", share });
  if (group === "ordinary") {
    if (env >= total - limits.dailySecurityReserve) return environment("ordinary");
  } else {
    if (env >= total) return environment("all");
    if (group === "code") {
      if (env - security >= total - limits.dailySecurityOnlyReserve) {
        return environment("security_only");
      }
      if (env - account >= total - accountShare) return environment("account_only");
    } else {
      if (env - codes >= total - limits.dailyCodeOnlyReserve) return environment("code_only");
      if (orgId !== undefined) {
        if (env - account >= total - accountShare) return environment("account_only");
        if (env - codes - account >= total - limits.dailyCodeOnlyReserve - accountShare) {
          return environment("account_only");
        }
      }
    }
  }
  for (const [scope, count] of Object.entries(counts)) {
    if (scope.startsWith("org:") && count >= limits.dailyPerOrganisation) {
      return { scope, share: "all" };
    }
    if (scope.startsWith("org-security:") && count >= limits.dailySecurityPerOrganisation) {
      return { scope, share: "all" };
    }
  }
  return undefined;
}

/** Exponential backoff with jitter for a row's `attempt`th failure. */
export function backoffMs(limits: SenderLimits, attempt: number, random: () => number): number {
  const ceiling = Math.min(limits.retryCapMs, limits.retryBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1_000, Math.round(ceiling / 2 + (random() * ceiling) / 2));
}
