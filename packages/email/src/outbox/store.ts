// Every statement the sender runs on the outbox and its tables (spec 01 §6.10 plus
// `migrations/20261121194000_email_sender.sql`). They are all in `email_private`, which only the
// worker and email.enqueue()'s owner may use, so no other login can name, and so lock, any of them;
// other services reach the outbox only through `email.enqueue()`. Times are passed in from the
// injected clock, never read from the database's own clock, so the tests control time; every write
// after a claim is fenced on `leased_by`, so a replica whose lease was taken over changes nothing.
import { findTemplate } from "../catalogue.ts";
import type { EmailClass } from "../classes.ts";
import { inTransaction, type PoolLike, type Queryable } from "./db.ts";

export type RecipientKind = "address" | "customer" | "person";

export interface OutboxRow {
  readonly id: string;
  readonly template: string;
  readonly category: EmailClass;
  readonly priority: number;
  readonly recipientKind: RecipientKind;
  readonly recipient: string;
  readonly params: unknown;
  readonly carriesCode: boolean;
  readonly dueAt: number;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: number;
  readonly counted: boolean;
  readonly securityUnsentAt: number | null;
}

interface RawRow {
  id: string;
  template: string;
  category: EmailClass;
  priority: number;
  recipient_kind: RecipientKind;
  recipient: string;
  params: unknown;
  carries_code: boolean;
  due_at: Date;
  attempts: number;
  last_error_code: string | null;
  created_at: Date;
  counted: boolean;
  security_unsent_at: Date | null;
}

const COLUMNS =
  "id, template, category, priority, recipient_kind, recipient, params, carries_code, due_at, attempts, last_error_code, created_at, counted, security_unsent_at";

function toRow(raw: RawRow): OutboxRow {
  return {
    id: raw.id,
    template: raw.template,
    category: raw.category,
    priority: Number(raw.priority),
    recipientKind: raw.recipient_kind,
    recipient: raw.recipient,
    params: raw.params,
    carriesCode: raw.carries_code,
    dueAt: new Date(raw.due_at).getTime(),
    attempts: Number(raw.attempts),
    lastErrorCode: raw.last_error_code,
    createdAt: new Date(raw.created_at).getTime(),
    counted: raw.counted,
    securityUnsentAt:
      raw.security_unsent_at === null ? null : new Date(raw.security_unsent_at).getTime(),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export interface ClaimOptions {
  readonly now: number;
  readonly holder: string;
  readonly leaseMs: number;
  readonly limit: number;
  /** Claim only rows with priority in [minPriority, maxPriority]. */
  readonly minPriority: number;
  readonly maxPriority: number;
}

/**
 * Claims due rows, most urgent first, with a lease (ARCHITECTURE §4.6's claim): `FOR UPDATE SKIP
 * LOCKED`, so two replicas never claim one row; an expired lease is claimable again.
 */
export async function claimRows(db: Queryable, o: ClaimOptions): Promise<OutboxRow[]> {
  if (o.limit <= 0) return [];
  const result = await db.query<RawRow>(
    `UPDATE email_private.outbox o
        SET lease_until = $1::timestamptz + make_interval(secs => $2::double precision / 1000),
            leased_by = $3, attempts = o.attempts + 1
      WHERE o.id IN (
        SELECT id FROM email_private.outbox
         WHERE folded_into IS NULL AND due_at <= $1::timestamptz
           AND (lease_until IS NULL OR lease_until < $1::timestamptz)
           AND priority BETWEEN $4 AND $5
         ORDER BY priority, due_at, id
         LIMIT $6
         FOR UPDATE SKIP LOCKED)
      RETURNING ${COLUMNS.split(", ")
        .map((c) => `o.${c}`)
        .join(", ")}`,
    [iso(o.now), o.leaseMs, o.holder, o.minPriority, o.maxPriority, o.limit],
  );
  return result.rows.map(toRow).sort((a, b) => a.priority - b.priority || a.dueAt - b.dueAt);
}

/** Deletes a row the sender is done with (sent, or ended for good). */
export async function deleteRow(db: Queryable, id: string, holder: string): Promise<boolean> {
  const result = await db.query(
    "DELETE FROM email_private.outbox WHERE id = $1 AND leased_by = $2",
    [id, holder],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface Reschedule {
  readonly dueAt: number;
  readonly errorCode: string | null;
  /** Gives the claim's attempt back (a local deferral, not a try at sending). */
  readonly refundAttempt: boolean;
  readonly markSecurityUnsent?: number;
}

/** Puts a claimed row back to wait until `dueAt`. */
export async function rescheduleRow(
  db: Queryable,
  id: string,
  holder: string,
  r: Reschedule,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE email_private.outbox
        SET due_at = $3::timestamptz, lease_until = NULL, leased_by = NULL,
            last_error_code = coalesce($4, last_error_code),
            attempts = CASE WHEN $5 THEN greatest(attempts - 1, 0) ELSE attempts END,
            security_unsent_at = coalesce(security_unsent_at, $6::timestamptz)
      WHERE id = $1 AND leased_by = $2`,
    [
      id,
      holder,
      iso(r.dueAt),
      r.errorCode,
      r.refundAttempt,
      r.markSecurityUnsent === undefined ? null : iso(r.markSecurityUnsent),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * A recipient window's kind: `security` (the digest's allowance); a code template
 * (`code:identity/sign-in-code`), so no other template can use up the backstop a code depends on; or
 * a class and a template folder (`notice:orgs`, `customer:kyc`).
 */
export type WindowKind =
  | "security"
  | `code:${string}/${string}`
  | `${"notice" | "customer"}:${string}`;

/**
 * Counts a row against its recipient's window once (the `counted` flag makes a retried row count
 * only the first time) and returns the window's count, or undefined when it was already counted.
 */
export async function countRecipient(
  db: Queryable,
  id: string,
  holder: string,
  key: string,
  kind: WindowKind,
  windowStart: number,
): Promise<number | undefined> {
  const result = await db.query<{ count: number }>(
    `WITH c AS (
       UPDATE email_private.outbox SET counted = true
        WHERE id = $1 AND leased_by = $2 AND NOT counted
        RETURNING id)
     INSERT INTO email_private.recipient_window (key, kind, window_start, count)
     SELECT $3, $4, $5::timestamptz, 1 FROM c
     ON CONFLICT (key, kind, window_start) DO UPDATE SET count = email_private.recipient_window.count + 1
     RETURNING count`,
    [id, holder, key, kind, iso(windowStart)],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : Number(row.count);
}

/** Folds a security row into its digest: it is no longer claimed on its own. */
export async function foldRow(
  db: Queryable,
  id: string,
  holder: string,
  digestKey: string,
  now: number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE email_private.outbox
        SET folded_into = $3, folded_at = $4::timestamptz, lease_until = NULL, leased_by = NULL
      WHERE id = $1 AND leased_by = $2`,
    [id, holder, digestKey, iso(now)],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface BucketSettings {
  readonly name: string;
  readonly capacity: number;
  readonly ratePerSecond: number;
}

/** The bucket's row is gone and could not be put back: every send would wait, so it is an error. */
export class BucketMissing extends Error {
  readonly code = "bucket_missing";
  constructor() {
    super("email_private.send_bucket has no row for the bucket");
    this.name = "BucketMissing";
  }
}

/**
 * Takes one token from the shared bucket, leaving at least `reserve` tokens (ordinary mail may not
 * dip into the share kept for codes and security notices). Returns how many seconds to wait when
 * refused. A missing row (a restore leaves the table empty, [DA-15]) is put back full, as the
 * migration seeds it; if it cannot be, `BucketMissing` is thrown rather than holding mail quietly.
 */
export async function takeToken(
  db: Queryable,
  bucket: BucketSettings,
  reserve: number,
  now: number,
): Promise<{ readonly taken: boolean; readonly waitMs: number }> {
  const take = () =>
    db.query<{ avail: number; taken: string | number }>(
      `WITH cur AS (
         SELECT name,
                least($2::float8, tokens + greatest(0, extract(epoch FROM ($4::timestamptz - refilled_at))) * $3::float8) AS avail
           FROM email_private.send_bucket WHERE name = $1 FOR UPDATE),
       upd AS (
         UPDATE email_private.send_bucket b
            SET tokens = cur.avail - 1, refilled_at = greatest(b.refilled_at, $4::timestamptz)
           FROM cur
          WHERE b.name = cur.name AND cur.avail >= 1 + $5::float8
          RETURNING b.name)
       SELECT cur.avail, (SELECT count(*) FROM upd) AS taken FROM cur`,
      [bucket.name, bucket.capacity, bucket.ratePerSecond, iso(now), reserve],
    );
  let row = (await take()).rows[0];
  if (row === undefined) {
    await db.query(
      `INSERT INTO email_private.send_bucket (name, tokens, refilled_at) VALUES ($1, 0, '-infinity')
       ON CONFLICT (name) DO NOTHING`,
      [bucket.name],
    );
    row = (await take()).rows[0];
    if (row === undefined) throw new BucketMissing();
  }
  if (Number(row.taken) > 0) return { taken: true, waitMs: 0 };
  const missing = 1 + reserve - Number(row.avail);
  return {
    taken: false,
    waitMs: Math.max(250, Math.ceil((missing / bucket.ratePerSecond) * 1000)),
  };
}

/**
 * Gives back a token taken for a send that was then held back before Cloudflare was called (the
 * daily budget refused it), so a row that waits on a budget never spends the bucket.
 */
export async function refundToken(db: Queryable, bucket: BucketSettings): Promise<void> {
  await db.query(
    "UPDATE email_private.send_bucket SET tokens = least($2::float8, tokens + 1) WHERE name = $1",
    [bucket.name, bucket.capacity],
  );
}

export interface BudgetTake<R> {
  /** Why the send was refused, or undefined when it was counted. */
  readonly refusedBy: R | undefined;
  /** Each scope's count: before the take when refused, after it when counted. */
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * Counts one send against the `raise` scopes, all or none, in one transaction: the `read` scopes'
 * rows (a superset) are locked in one order, so two replicas never deadlock, `refuse` decides from
 * all of their counts together (a share kept for one class depends on what the others have used),
 * and only then are the `raise` counts raised. Agreement across replicas is Postgres's, never
 * process memory's.
 */
export async function takeBudget<R>(
  pool: PoolLike,
  day: string,
  scopes: { readonly read: readonly string[]; readonly raise: readonly string[] },
  refuse: (counts: Readonly<Record<string, number>>) => R | undefined,
): Promise<BudgetTake<R>> {
  const read = [...new Set([...scopes.read, ...scopes.raise])].sort();
  const raise = [...new Set(scopes.raise)];
  return inTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO email_private.daily_budget (day, scope, count)
       SELECT $1::date, s, 0 FROM unnest($2::text[]) AS s ORDER BY s
       ON CONFLICT (day, scope) DO NOTHING`,
      [day, read],
    );
    const locked = await tx.query<{ scope: string; count: number }>(
      `SELECT scope, count FROM email_private.daily_budget
        WHERE day = $1::date AND scope = ANY($2::text[]) ORDER BY scope FOR UPDATE`,
      [day, read],
    );
    const counts: Record<string, number> = {};
    for (const r of locked.rows) counts[r.scope] = Number(r.count);
    const refusedBy = refuse(counts);
    if (refusedBy !== undefined) return { refusedBy, counts };
    const raised = await tx.query<{ scope: string; count: number }>(
      `UPDATE email_private.daily_budget SET count = count + 1
        WHERE day = $1::date AND scope = ANY($2::text[]) RETURNING scope, count`,
      [day, raise],
    );
    for (const r of raised.rows) counts[r.scope] = Number(r.count);
    return { refusedBy: undefined, counts };
  });
}

/** Gives one send back to each scope it was counted against (Cloudflare sent nothing). */
export async function refundBudget(
  db: Queryable,
  day: string,
  scopes: readonly string[],
): Promise<void> {
  await db.query(
    `UPDATE email_private.daily_budget SET count = greatest(count - 1, 0)
      WHERE day = $1::date AND scope = ANY($2::text[])`,
    [day, [...new Set(scopes)]],
  );
}

export interface DueDigest {
  readonly key: string;
  readonly firstFoldedAt: number;
  readonly rows: number;
}

/** Digests whose rows have waited long enough: the end of the hour, or 10 minutes after the first fold. */
export async function dueDigests(
  db: Queryable,
  now: number,
  delayMs: number,
): Promise<DueDigest[]> {
  const result = await db.query<{ key: string; first: Date; rows: string | number }>(
    `SELECT folded_into AS key, min(folded_at) AS first, count(*) AS rows
       FROM email_private.outbox WHERE folded_into IS NOT NULL
      GROUP BY folded_into
     HAVING min(folded_at) <= $1::timestamptz - make_interval(secs => $2::double precision / 1000)
         OR (to_timestamp(right(folded_into, 10), 'YYYYMMDDHH24')::timestamp AT TIME ZONE 'UTC') + interval '1 hour' <= $1::timestamptz`,
    [iso(now), delayMs],
  );
  return result.rows.map((r) => ({
    key: r.key,
    firstFoldedAt: new Date(r.first).getTime(),
    rows: Number(r.rows),
  }));
}

export interface FoldedRow {
  readonly id: string;
  readonly template: string;
  readonly recipientKind: RecipientKind;
  readonly recipient: string;
}

/** Locks a digest's folded rows (inside the caller's transaction). */
export async function lockFolded(db: Queryable, key: string): Promise<FoldedRow[]> {
  const result = await db.query<{
    id: string;
    template: string;
    recipient_kind: RecipientKind;
    recipient: string;
  }>(
    `SELECT id, template, recipient_kind, recipient FROM email_private.outbox
      WHERE folded_into = $1 ORDER BY id FOR UPDATE SKIP LOCKED`,
    [key],
  );
  return result.rows.map((r) => ({
    id: r.id,
    template: r.template,
    recipientKind: r.recipient_kind,
    recipient: r.recipient,
  }));
}

export interface EnqueueInput {
  readonly id: string;
  readonly template: string;
  readonly recipientKind: RecipientKind;
  readonly recipient: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly dueAt?: number;
}

/**
 * `enqueue()` refused the input before it reached the database. `code` is `email.enqueue()`'s own
 * SQLSTATE for bad input, so callers handle both alike; the message names fields, never values.
 */
export class EnqueueRefused extends Error {
  readonly code = "FE002";
  readonly reason: "unknown_template" | "invalid_params" | "bad_input";
  constructor(reason: EnqueueRefused["reason"], message: string) {
    super(message);
    this.name = "EnqueueRefused";
    this.reason = reason;
  }
}

/**
 * Whether a string Postgres's jsonb would refuse: U+0000, or a lone surrogate (JSON.stringify writes
 * it as a `\udXXX` escape). Either error's CONTEXT quotes the JSON text up to that point, which holds
 * the address and any code, so such input never reaches the cast.
 */
function refusedByJsonb(text: string): boolean {
  return text.includes("\u0000") || !text.isWellFormed();
}

/** Whether any string inside, key or value, is one Postgres's jsonb would refuse. */
function holdsRefused(value: unknown): boolean {
  if (typeof value === "string") return refusedByJsonb(value);
  if (Array.isArray(value)) return value.some(holdsRefused);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(([k, v]) => refusedByJsonb(k) || holdsRefused(v));
  }
  return false;
}

/**
 * Calls `email.enqueue()`: the only way any service, the worker included, adds a row. The params are
 * checked against the template first, so a notice that could never be rendered fails here, in the
 * caller's transaction, and the action rolls back with it (spec 08 §4.1, [SA-41], T08-24), rather
 * than being dropped by the worker after the action has committed. The row holds the params as the
 * template parsed them, so a name or device label the template hides is never written.
 */
export async function enqueue(db: Queryable, input: EnqueueInput): Promise<string> {
  const template = findTemplate(input.template);
  if (template === undefined) {
    throw new EnqueueRefused(
      "unknown_template",
      "email.enqueue: no such template in the catalogue",
    );
  }
  const parsed = template.params.safeParse(input.params);
  if (!parsed.success) {
    // The issue paths name fields only, never their values.
    const fields = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(",");
    throw new EnqueueRefused(
      "invalid_params",
      `email.enqueue: params refused for ${template.id}: ${fields}`,
    );
  }
  const p: Record<string, unknown> = {
    id: input.id,
    template: input.template,
    recipient_kind: input.recipientKind,
    recipient: input.recipient,
    params: parsed.data,
  };
  if (input.dueAt !== undefined) p.due_at = iso(input.dueAt);
  if (holdsRefused(p)) {
    throw new EnqueueRefused("bad_input", "email.enqueue: a NUL or a lone surrogate is refused");
  }
  const result = await db.query<{ id: string }>("SELECT email.enqueue($1::jsonb) AS id", [
    JSON.stringify(p),
  ]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("email.enqueue returned no id");
  return id;
}

export async function deleteRows(db: Queryable, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db.query("DELETE FROM email_private.outbox WHERE id = ANY($1::text[])", [
    ids,
  ]);
  return result.rowCount ?? 0;
}

export interface OutboxAge {
  /** Seconds the oldest waiting code or security row has waited (the `email-outbox-age` reading). */
  readonly urgentS: number;
  readonly otherS: number;
  readonly waiting: number;
}

/**
 * How long rows have waited, from when they first became due (`first_due_at`, set once at enqueue),
 * for `job.run`'s `oldestDueS`. A deferral by the token bucket or a budget moves `due_at` but never
 * `first_due_at`, so a row held back again and again keeps ageing and `email-outbox-age` sees it.
 * Folded rows are left out: they wait for their digest by design.
 */
export async function outboxAge(db: Queryable, now: number): Promise<OutboxAge> {
  const result = await db.query<{
    urgent: number | null;
    other: number | null;
    waiting: string | number;
  }>(
    `SELECT extract(epoch FROM ($1::timestamptz - min(first_due_at) FILTER (WHERE priority <= 2)))::float8 AS urgent,
            extract(epoch FROM ($1::timestamptz - min(first_due_at) FILTER (WHERE priority > 2)))::float8 AS other,
            count(*) AS waiting
       FROM email_private.outbox
      WHERE folded_into IS NULL AND first_due_at <= $1::timestamptz`,
    [iso(now)],
  );
  const row = result.rows[0];
  const clamp = (v: number | null | undefined): number =>
    v === null || v === undefined ? 0 : Math.max(0, Math.round(Number(v)));
  return {
    urgentS: clamp(row?.urgent),
    otherS: clamp(row?.other),
    waiting: Number(row?.waiting ?? 0),
  };
}

/** Removes windows and budgets nobody reads any more. */
export async function sweep(db: Queryable, now: number): Promise<void> {
  await db.query(
    "DELETE FROM email_private.recipient_window WHERE window_start < $1::timestamptz - interval '2 days'",
    [iso(now)],
  );
  await db.query(
    "DELETE FROM email_private.daily_budget WHERE day < ($1::timestamptz AT TIME ZONE 'UTC')::date - 7",
    [iso(now)],
  );
}
