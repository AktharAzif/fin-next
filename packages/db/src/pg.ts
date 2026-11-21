/// <reference path="./types/pg.d.ts" />
// The one place Fin imports `pg`. Everything else imports from here, so the narrow declarations in
// types/pg.d.ts are always in the compilation.
import pg from "pg";

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
