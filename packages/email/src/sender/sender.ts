// The one sender (ARCHITECTURE §9.4, §9.5; spec 08 §4.1 to §4.3; [EM-04], [SA-41]). Only `worker`
// runs it. One `runOnce()`:
//   1. claims due rows, codes and security notices first, with a lease; ordinary mail may use only
//      part of the batch, the rest is kept for codes and security notices;
//   2. per row: drops a code that outlived its code; counts the recipient once (security notices
//      past 5 an hour fold into a digest, never dropped; other classes have a backstop, one window
//      per code template and one per class and folder for the rest); resolves the recipient; renders
//      Fin's own template; takes a token from the shared bucket (ordinary mail leaves a reserve);
//      takes the daily budgets (ordinary mail leaves the reserved share, codes and security notices
//      each keep a part of it); sends;
//   3. a sent row is deleted, so a code-bearing row never outlives its send; a failed one waits with
//      backoff, or ends for good with `email.send_failed`, and a security row that cannot be sent
//      writes `email.security_unsent`. A send Cloudflare refused gives its budget back, and a token
//      or account refusal pauses this loop for the blocked wait.
//   A row whose template or params this release does not know was queued by another release (the
//   caller checked it at queue time): it waits for a worker that knows it, never deleted at once.
// `flushDigests()` turns each digest's folded rows into one `ops/security-digest` row through
// `email.enqueue()` in one transaction. Lines carry the template, class, code and IDs, never an
// address, a subject or a parameter value.

import { describe, findTemplate, TEMPLATES } from "../catalogue.ts";
import {
  CLASS_RULES,
  type EmailClass,
  type LinkOrigins,
  type Template,
  URGENT_PRIORITY,
} from "../classes.ts";
import { finHeaders } from "../headers.ts";
import { newId } from "../ids.ts";
import { inTransaction, type PoolLike } from "../outbox/db.ts";
import {
  claimRows,
  countRecipient,
  deleteRow,
  deleteRows,
  dueDigests,
  enqueue,
  foldRow,
  lockFolded,
  type OutboxRow,
  outboxAge,
  refundBudget,
  rescheduleRow,
  sweep,
  takeBudget,
  takeToken,
  type WindowKind,
} from "../outbox/store.ts";
import type { EmailPort, Mailbox, SendOutcome } from "../port.ts";
import type { RecipientHasher } from "../recipient-key.ts";
import { RenderError, renderTemplate } from "../render.ts";
import {
  type BudgetGroup,
  backoffMs,
  budgetRefusal,
  budgetScopes,
  checkLimits,
  DEFAULT_LIMITS,
  type SenderLimits,
} from "./limits.ts";

export type Level = "info" | "warn" | "error";

/** The line writer: `@fin/server`'s Telemetry.log has this shape (P0-D, under review). */
export interface EmailLog {
  log(event: string, fields: Readonly<Record<string, unknown>>, level?: Level): void;
}

export interface SenderClock {
  now(): number;
}

/** Resolves a recipient reference to an address; `address` rows need none. */
export type RecipientResolver = (
  kind: "customer" | "person",
  id: string,
) => Promise<string | undefined>;

export interface SentInfo {
  readonly emailId: string;
  readonly template: string;
  readonly params: unknown;
}

export interface SenderOptions {
  readonly db: PoolLike;
  readonly port: EmailPort;
  readonly clock: SenderClock;
  readonly log: EmailLog;
  /** This loop's lease holder: the replica and a per-process nonce. */
  readonly holder: string;
  readonly environment: string;
  /** `auth.<zone>` sends codes, security and ops; `notify.<zone>` invitations and customer mail. */
  readonly from: { readonly auth: Mailbox; readonly notify?: Mailbox };
  readonly links: LinkOrigins;
  readonly hashRecipient: RecipientHasher;
  readonly resolve?: RecipientResolver;
  readonly limits?: Partial<SenderLimits>;
  readonly random?: () => number;
  readonly newEntityRef?: () => string;
  /** Called after a send is recorded (the delivery check's heartbeat). Never throws into the loop. */
  readonly onSent?: (info: SentInfo) => void | Promise<void>;
}

export interface BatchResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly folded: number;
  readonly deferred: number;
  /** True when a claim came back full, so the loop should run again at once. */
  readonly full: boolean;
  /** True when Cloudflare refused the token or account and this loop is waiting before it claims. */
  readonly paused?: boolean;
}

type RowResult = "sent" | "failed" | "folded" | "deferred" | "lost";

/** The budget a send was counted against, so a refused send can give it back. */
interface BudgetHeld {
  readonly day: string;
  readonly scopes: readonly string[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The longest life of any code this release knows: a code row nobody can render is stale after it. */
const LONGEST_CODE_MS = Math.max(...TEMPLATES.map((t) => t.codeTtlMs ?? 0));

function budgetGroup(cls: EmailClass): BudgetGroup {
  if (cls === "code") return "code";
  return cls === "security" || cls === "ops" ? "security" : "ordinary";
}

function windowKind(template: Template): WindowKind {
  if (template.class === "security" || template.class === "ops") return "security";
  if (template.class === "code") return `code:${template.area}/${template.name}`;
  return `${template.class}:${template.area}`;
}

function hourKey(ms: number): string {
  const d = new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function organisationOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const id = (params as Record<string, unknown>).orgId;
  return typeof id === "string" && /^org_[0-9a-hjkmnp-tv-z]{26}$/u.test(id) ? id : undefined;
}

export class Sender {
  private readonly o: SenderOptions;
  private readonly limits: SenderLimits;
  private readonly random: () => number;
  private readonly entityRef: () => string;
  /**
   * Until when this loop claims nothing after Cloudflare refused the token, the entitlement or the
   * account (they page): every waiting row would otherwise call and fail in turn. It is load shedding
   * for this replica only; nothing about a person is decided from it.
   */
  private pausedUntil = Number.NEGATIVE_INFINITY;

  constructor(options: SenderOptions) {
    this.o = options;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.random = options.random ?? Math.random;
    this.entityRef = options.newEntityRef ?? (() => crypto.randomUUID());
    checkLimits(this.limits);
  }

  /** One pass: claim, process each row, report. */
  async runOnce(): Promise<BatchResult> {
    const { db, holder } = this.o;
    const now = this.o.clock.now();
    if (now < this.pausedUntil) {
      return { claimed: 0, sent: 0, failed: 0, folded: 0, deferred: 0, full: false, paused: true };
    }
    const { concurrency, reservedUrgent, leaseMs } = this.limits;
    const urgent = await claimRows(db, {
      now,
      holder,
      leaseMs,
      limit: concurrency,
      minPriority: 0,
      maxPriority: URGENT_PRIORITY,
    });
    const room = Math.min(concurrency - urgent.length, concurrency - reservedUrgent);
    const ordinary = await claimRows(db, {
      now,
      holder,
      leaseMs,
      limit: room,
      minPriority: URGENT_PRIORITY + 1,
      maxPriority: 32767,
    });
    const rows = [...urgent, ...ordinary];
    const results = await Promise.all(rows.map((row) => this.processSafely(row)));
    const count = (r: RowResult): number => results.filter((x) => x === r).length;
    return {
      claimed: rows.length,
      sent: count("sent"),
      failed: count("failed"),
      folded: count("folded"),
      deferred: count("deferred"),
      full: urgent.length === concurrency || (room > 0 && ordinary.length === room),
      paused: false,
    };
  }

  /** How long rows have waited, for the loop's `job.run`. */
  async age(): Promise<{ urgentS: number; otherS: number; waiting: number }> {
    return outboxAge(this.o.db, this.o.clock.now());
  }

  /** Housekeeping of the count tables. */
  async sweep(): Promise<void> {
    await sweep(this.o.db, this.o.clock.now());
  }

  private async processSafely(row: OutboxRow): Promise<RowResult> {
    try {
      return await this.process(row);
    } catch {
      // A database error mid-row: the lease expires and the row is claimed again. The loop's
      // `job.run` carries the failure; nothing about the row or its recipient is logged.
      this.o.log.log(
        "email.send_failed",
        {
          template: row.template,
          class: row.category,
          code: "sender_error",
          reason: "unknown",
          emailId: row.id,
          attempt: row.attempts,
          final: false,
        },
        "error",
      );
      return "failed";
    }
  }

  private async process(row: OutboxRow): Promise<RowResult> {
    const now = this.o.clock.now();
    const template = findTemplate(row.template);
    // Granted and queued, so another release knows it: wait for a worker that does (spec 01 §6.9
    // rolls services after `migrate` and rolls back without it, so old and new run side by side).
    if (template === undefined) {
      return this.retry(row, undefined, "unknown_template", "release", undefined);
    }

    if (template.codeTtlMs !== undefined && now >= row.createdAt + template.codeTtlMs) {
      return this.end(row, template, "expired", "permanent");
    }

    // Count the recipient once per row, at claim time (spec 08 §4.3, [DA-16]). Security notices share
    // one allowance. Every other class has backstop windows of its own, so no other class, service or
    // template can use up the one a person's codes depend on: one per code template, one per class
    // and template folder for notices and customer mail.
    if (row.category !== "ops" && !row.counted) {
      const key = this.o.hashRecipient(row.recipientKind, row.recipient);
      const kind = windowKind(template);
      const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS;
      const count = await countRecipient(this.o.db, row.id, this.o.holder, key, kind, windowStart);
      if (count === undefined) return "lost";
      if (
        kind === "security" &&
        count > this.limits.securityPerHour &&
        !template.bypasses(row.params)
      ) {
        const digestKey = `dig_${key}_${hourKey(now)}`;
        if (!(await foldRow(this.o.db, row.id, this.o.holder, digestKey, now))) return "lost";
        this.o.log.log("email.folded", {
          template: row.template,
          class: row.category,
          emailId: row.id,
          digestKey,
        });
        return "folded";
      }
      if (kind !== "security" && count > this.limits.otherPerHour) {
        return this.end(row, template, "recipient_limit", "permanent");
      }
    }

    let address: string | undefined;
    if (row.recipientKind === "address") address = row.recipient;
    else
      address =
        this.o.resolve === undefined
          ? undefined
          : await this.o.resolve(row.recipientKind, row.recipient);
    if (address === undefined) return this.end(row, template, "unresolvable", "permanent");

    const subdomain = CLASS_RULES[template.class].subdomain;
    const from = subdomain === "auth" ? this.o.from.auth : this.o.from.notify;
    if (from === undefined) return this.retry(row, template, "no_sender", "blocked", undefined);

    let rendered: ReturnType<typeof renderTemplate>;
    try {
      rendered = renderTemplate(
        template,
        row.params,
        { recipient: address, environment: this.o.environment, describe },
        this.o.links,
      );
    } catch (error) {
      if (error instanceof RenderError && error.code === "link_origin_missing") {
        return this.retry(row, template, error.code, "blocked", undefined);
      }
      // The caller checked the params against its release's template at queue time, so a refusal
      // here means another release queued it (a new or changed param): wait for a worker that knows.
      if (error instanceof RenderError && error.code === "invalid_params") {
        return this.retry(row, template, error.code, "release", undefined);
      }
      return this.end(
        row,
        template,
        error instanceof RenderError ? error.code : "render_failed",
        "permanent",
      );
    }

    const reservedShare = CLASS_RULES[template.class].reservedShare;
    const token = await takeToken(
      this.o.db,
      this.limits.bucket,
      reservedShare ? 0 : this.limits.bucketReserve,
      now,
    );
    if (!token.taken) {
      await rescheduleRow(this.o.db, row.id, this.o.holder, {
        dueAt: now + token.waitMs,
        errorCode: null,
        refundAttempt: true,
      });
      return "deferred";
    }

    const budget = await this.takeBudgets(row, template, now);
    if (typeof budget === "string") return budget;

    const outcome = await this.o.port.send({
      from,
      to: address,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: finHeaders(template.class, this.entityRef()),
      template: template.id,
      category: template.class,
      emailId: row.id,
    });
    return this.record(row, template, outcome, budget);
  }

  private async takeBudgets(
    row: OutboxRow,
    template: Template,
    now: number,
  ): Promise<BudgetHeld | RowResult> {
    const reservedShare = CLASS_RULES[template.class].reservedShare;
    const group = budgetGroup(template.class);
    const ordinaryLimit = this.limits.dailyBudget - this.limits.dailySecurityReserve;
    // An organisation's counter: ordinary mail ([SA-40]) and security notices each have their own.
    const named = organisationOf(row.params);
    const orgId =
      group === "ordinary" || (group === "security" && template.class === "security")
        ? named
        : undefined;
    const day = utcDay(now);
    const scopes = budgetScopes(group, orgId);
    const taken = await takeBudget(this.o.db, day, scopes, (counts) =>
      budgetRefusal(group, counts, this.limits),
    );
    const base = { template: row.template, class: row.category, emailId: row.id };
    if (taken.refusedBy === undefined) {
      if (reservedShare && (taken.counts.environment ?? 0) === ordinaryLimit + 1) {
        // The first send into the reserved share today: ordinary mail has used its part. This is the
        // early warning, well before the total (at 75% with the defaults).
        this.o.log.log(
          "email.budget_reached",
          { ...base, scope: "environment", share: "security" },
          "warn",
        );
      }
      return { day, scopes: scopes.raise };
    }
    const scope = taken.refusedBy === "environment" ? "environment" : "organisation";
    const spentAll = (taken.counts.environment ?? 0) >= this.limits.dailyBudget;
    const share = !reservedShare
      ? "ordinary"
      : scope === "organisation" || spentAll
        ? "all"
        : group === "code"
          ? "security_only"
          : "code_only";
    this.o.log.log(
      "email.budget_reached",
      { ...base, scope, share, ...(orgId === undefined ? {} : { orgId }) },
      "warn",
    );
    if (template.class === "code") return this.end(row, template, "budget", "permanent");
    // Security and ops rows past their share, or a security notice past its organisation's ceiling.
    if (reservedShare) {
      // Security and ops rows are never dropped for the budget: they wait and try again.
      return this.retry(row, template, "budget", "budget", this.limits.budgetWaitMs);
    }
    const tomorrow =
      Math.floor(now / DAY_MS) * DAY_MS + DAY_MS + Math.round(this.random() * 15 * 60_000);
    await rescheduleRow(this.o.db, row.id, this.o.holder, {
      dueAt: tomorrow,
      errorCode: "budget",
      refundAttempt: true,
    });
    return "deferred";
  }

  private async record(
    row: OutboxRow,
    template: Template,
    outcome: SendOutcome,
    budget: BudgetHeld,
  ): Promise<RowResult> {
    if (!outcome.ok) {
      // Cloudflare sent nothing: a refused token or account, a throttle, or a refusal before or at
      // the HTTP layer. Give the day's budget back, so refusals never spend it. An `unknown` outcome
      // may have gone and a 2xx bounce was processed: those keep their count.
      const sentNothing =
        outcome.kind === "blocked" ||
        outcome.kind === "throttled" ||
        (outcome.kind === "permanent" &&
          (outcome.httpStatus === undefined || outcome.httpStatus >= 400));
      if (sentNothing) await refundBudget(this.o.db, budget.day, budget.scopes);
      if (outcome.kind === "blocked") {
        this.pausedUntil = Math.max(
          this.pausedUntil,
          this.o.clock.now() + this.limits.blockedWaitMs,
        );
      }
    }
    if (outcome.ok) {
      // Deleted on send: a code-bearing row never outlives its message (ARCHITECTURE §9.4).
      const deleted = await deleteRow(this.o.db, row.id, this.o.holder);
      const folded =
        template.id === "ops/security-digest" &&
        typeof row.params === "object" &&
        row.params !== null
          ? (row.params as Record<string, unknown>).total
          : undefined;
      this.o.log.log("email.sent", {
        template: template.id,
        class: template.class,
        emailId: row.id,
        attempt: row.attempts,
        tries: outcome.tries,
        status: outcome.status,
        durationMs: outcome.durationMs,
        ...(typeof folded === "number" ? { folded } : {}),
        ...(deleted ? {} : { leaseLost: true }),
      });
      if (this.o.onSent !== undefined) {
        try {
          await this.o.onSent({ emailId: row.id, template: template.id, params: row.params });
        } catch {
          // The heartbeat's own failure is reported by its caller; the send stands.
        }
      }
      return "sent";
    }
    const extra = {
      tries: outcome.tries,
      durationMs: outcome.durationMs,
      severity: outcome.severity,
      ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }),
    };
    if (outcome.kind === "permanent")
      return this.end(row, template, outcome.code, "permanent", extra);
    return this.retry(row, template, outcome.code, outcome.kind, outcome.retryAfterMs, extra);
  }

  /**
   * Waits and tries again, or ends the row when its class allows no more tries. `release` is a row
   * this release cannot render (its template is unknown here, so `template` may be undefined): it
   * waits the blocked wait each time, bounded by its age rather than its attempts.
   */
  private async retry(
    row: OutboxRow,
    template: Template | undefined,
    code: string,
    reason: string,
    waitHintMs: number | undefined,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<RowResult> {
    const now = this.o.clock.now();
    const backoff = backoffMs(this.limits, row.attempts, this.random);
    const wait =
      reason === "blocked" || reason === "release"
        ? Math.max(this.limits.blockedWaitMs, waitHintMs ?? 0)
        : Math.max(waitHintMs ?? 0, reason === "budget" ? 0 : backoff);
    const cls: EmailClass = template?.class ?? row.category;
    const codeTtlMs = template?.codeTtlMs ?? (cls === "code" ? LONGEST_CODE_MS : undefined);
    const codeExpired = codeTtlMs !== undefined && now + wait >= row.createdAt + codeTtlMs;
    const triesUsed =
      reason === "release"
        ? now >=
          row.createdAt +
            (cls === "security"
              ? this.limits.securityReleaseWaitMaxMs
              : this.limits.releaseWaitMaxMs)
        : cls !== "security" && row.attempts >= this.limits.maxAttempts;
    if (codeExpired || triesUsed) {
      return this.end(row, template, code, codeExpired ? "expired" : reason, extra);
    }
    let markUnsent: number | undefined;
    if (
      cls === "security" &&
      row.securityUnsentAt === null &&
      (reason === "budget" || row.attempts >= this.limits.securityUnsentAfter)
    ) {
      markUnsent = now;
      this.o.log.log(
        "email.security_unsent",
        {
          template: row.template,
          class: cls,
          emailId: row.id,
          code,
          reason: reason === "budget" ? "budget" : "failed",
          final: false,
        },
        "error",
      );
    }
    const updated = await rescheduleRow(this.o.db, row.id, this.o.holder, {
      dueAt: now + wait,
      errorCode: code,
      refundAttempt: false,
      ...(markUnsent === undefined ? {} : { markSecurityUnsent: markUnsent }),
    });
    this.o.log.log(
      "email.send_failed",
      {
        template: row.template,
        class: cls,
        code,
        reason,
        emailId: row.id,
        attempt: row.attempts,
        final: false,
        retryInS: Math.round(wait / 1000),
        ...extra,
        ...(updated ? {} : { leaseLost: true }),
      },
      "error",
    );
    return updated ? "failed" : "lost";
  }

  /** Ends a row for good: deleted, with `email.send_failed` and, for a security row, `email.security_unsent`. */
  private async end(
    row: OutboxRow,
    template: Template | undefined,
    code: string,
    reason: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<RowResult> {
    const deleted = await deleteRow(this.o.db, row.id, this.o.holder);
    const cls = template?.class ?? row.category;
    this.o.log.log(
      "email.send_failed",
      {
        template: row.template,
        class: cls,
        code,
        reason,
        emailId: row.id,
        attempt: row.attempts,
        final: true,
        ...extra,
        ...(deleted ? {} : { leaseLost: true }),
      },
      "error",
    );
    if (cls === "security" && deleted) {
      const unsent =
        code === "suppressed"
          ? "suppressed"
          : code === "bounced" || code === "unresolvable"
            ? "invalid_recipient"
            : code === "budget"
              ? "budget"
              : "failed";
      this.o.log.log(
        "email.security_unsent",
        { template: row.template, class: cls, emailId: row.id, code, reason: unsent, final: true },
        "error",
      );
    }
    return deleted ? "failed" : "lost";
  }

  /**
   * Sends each due digest: its folded rows become one `ops/security-digest` row, queued through
   * `email.enqueue()` and deleted in the same transaction, so a restart neither loses nor repeats it.
   */
  async flushDigests(): Promise<number> {
    const now = this.o.clock.now();
    const due = await dueDigests(this.o.db, now, this.limits.digestDelayMs);
    let queued = 0;
    for (const digest of due) {
      const made = await inTransaction(this.o.db, async (tx) => {
        const rows = await lockFolded(tx, digest.key);
        const first = rows[0];
        if (first === undefined) return false;
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.template, (counts.get(r.template) ?? 0) + 1);
        const staff = rows.filter((r) => r.template.startsWith("staff/")).length;
        const realm = staff === 0 ? "developer" : staff === rows.length ? "staff" : "mixed";
        await enqueue(tx, {
          id: newId("eml", this.o.clock),
          template: "ops/security-digest",
          recipientKind: first.recipientKind,
          recipient: first.recipient,
          params: {
            digestKey: digest.key,
            realm,
            total: rows.length,
            lines: [...counts.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .slice(0, 60)
              .map(([template, count]) => ({ template, count })),
          },
        });
        await deleteRows(
          tx,
          rows.map((r) => r.id),
        );
        return true;
      });
      if (made) queued += 1;
    }
    return queued;
  }
}
