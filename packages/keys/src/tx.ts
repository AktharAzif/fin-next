// The unit of work the key lifecycle runs in: one transaction, bound to the request (ARCHITECTURE §1
// principle 14), so a key change, its audit event and its notices commit or roll back together. The
// console's unit (packages/identity's UnitTx) satisfies this shape; this package depends on neither
// packages/identity nor packages/db, whose `pg` declarations cannot share one program.

export interface KeysTx {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
  readonly requestId: string | null;
  readonly release: string;
  /** Marks the unit failed, so it rolls back even when a caller swallowed the error. */
  poison(reason: string): void;
}

/** The structured lines this area writes (the console's line sink). */
export interface KeysLines {
  write(event: string, level: "info" | "warn" | "error", fields: Record<string, unknown>): void;
}

/** The clock the console's realm runs on (its `now()` answers a Date). */
export interface DateClock {
  now(): Date;
}

/** The SQLSTATE of a database error, if it carries one. */
export function sqlStateOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
