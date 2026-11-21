// The database port: the process pool's unit of work (packages/db, P0-E). Until P0-E's
// `packages/db` lands, this package codes against this narrow interface; `pg-database.ts` is
// the implementation over node-postgres that the tests and, until then, the API halves use.
//
// One request holds one unit of work (ARCHITECTURE §1 principle 14). Every write of an auth
// request, the library's included, happens inside it, so a row and its audit event commit or roll
// back together (spec 02 §3.5, S2-04).
import type { Clock } from "./clock.ts";

export type Row = Record<string, unknown>;

export interface QueryResultLike<R> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R extends object = Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<R>>;
}

/** A unit of work: one transaction, bound to the request that opened it. */
export interface UnitTx extends Queryable {
  readonly unitId: string;
  readonly clock: Clock;
  readonly requestId: string | null;
  readonly release: string;
  /**
   * Marks the unit as failed, so it rolls back even when a caller (the library) swallowed the
   * error that caused it. A poisoned unit never commits.
   */
  poison(reason: string): void;
  readonly poisonedBy: string | null;
}

export interface UnitOptions {
  requestId?: string | null;
}

export interface FinDatabase {
  /**
   * Runs `fn` in a unit of work. If the calling async context already holds one, `fn` joins it
   * (no nested transaction); otherwise a new one is opened, bound, committed after `fn` returns
   * and rolled back if `fn` throws or the unit was poisoned.
   */
  unit<T>(fn: (tx: UnitTx) => Promise<T>, options?: UnitOptions): Promise<T>;
  /** The unit bound to the calling async context, if any. */
  current(): UnitTx | null;
}

/** The commit was refused by an audit guard (SQLSTATE FA010, spec 08 §3.5). */
export class AuditGuardError extends Error {
  readonly table: string;
  constructor(table: string) {
    super(`audit guard refused the commit on ${table}`);
    this.name = "AuditGuardError";
    this.table = table;
  }
}

/** The unit was poisoned (or a statement failed inside it), so it rolled back. */
export class UnitRolledBackError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`unit of work rolled back: ${reason}`, options);
    this.name = "UnitRolledBackError";
    this.reason = reason;
  }
}

/** The SQLSTATE of a database error, if it carries one. */
export function sqlState(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
