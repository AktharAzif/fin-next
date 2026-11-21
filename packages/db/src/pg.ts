/// <reference path="./types/pg.d.ts" />
// The one place Fin imports `pg`. Everything else imports from here, so the narrow declarations in
// types/pg.d.ts are always in the compilation.
import pg, { type Client as ClientInstance } from "pg";
import { TransactionAbortedError } from "./errors.ts";

export type {
  Client as PgClient,
  ClientConfig,
  DatabaseError,
  Notification,
  Pool as PgPool,
  PoolClient,
  PoolConfig,
  QueryResult,
  QueryResultRow,
} from "pg";

export const { Client, Pool, escapeIdentifier, escapeLiteral } = pg;
export const PgDatabaseError = pg.DatabaseError;

/** The SQLSTATE of a database error, or undefined for anything else. */
export function sqlState(error: unknown): string | undefined {
  if (error instanceof pg.DatabaseError && typeof error.code === "string") return error.code;
  return undefined;
}

/**
 * Commits the client's open transaction, or throws TransactionAbortedError when there is nothing to
 * commit. Postgres answers COMMIT on a failed transaction with ROLLBACK and no error, so a caller that
 * caught a statement's error and went on would otherwise report work as written that was rolled back.
 */
export async function commitTransaction(client: ClientInstance): Promise<void> {
  if (client.getTransactionStatus() === "E") {
    await client.query("ROLLBACK").catch(() => {});
    throw new TransactionAbortedError();
  }
  const result = await client.query("COMMIT");
  if (result.command !== "COMMIT") throw new TransactionAbortedError();
}
