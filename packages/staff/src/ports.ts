// The ports this package runs on: @fin/identity's unit of work (the staff realm's routes run in the
// realm's own unit, so the action, its audit event, its notices and the intent it spends share one
// transaction), its clock and its line sink.
import type { Clock, LineSink, UnitTx } from "@fin/identity";

export type { Clock, LineSink, UnitTx };

export type Row = Record<string, unknown>;

/** Anything that runs a statement: a unit of work, or a pooled client in a test. */
export interface Queryable {
  query<R extends object = Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
}

/** What a Fin Admin actor's audit row carries about the request ([BC-03]). */
export interface RequestFacts {
  requestId: string;
  clientIp: string | null;
  userAgent: string | null;
}

/** The SQLSTATE of a database error, if it carries one. */
export function sqlState(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}
