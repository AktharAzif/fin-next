// The unit of work over node-postgres, bound to the request with AsyncLocalStorage (spec 02
// §3.5, S2-04). It also gives the library's Drizzle adapter a client that never opens a
// connection of its own: every adapter query runs on the bound unit's connection, and the
// library's own `transaction: true` calls become savepoints inside the unit. A library query
// outside a unit of work is refused, so no write can escape the request's transaction.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg";
import type { Clock } from "./clock.ts";
import {
  AuditGuardError,
  type FinDatabase,
  type QueryResultLike,
  type Row,
  sqlState,
  type UnitOptions,
  UnitRolledBackError,
  type UnitTx,
} from "./db.ts";
import { newId } from "./ids.ts";
import type { LineSink } from "./log.ts";

/** A connection-like object the Drizzle node-postgres driver accepts as its client. */
export interface LibraryClient {
  query(config: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult>;
}

export interface PgFinDatabase extends FinDatabase {
  /** The client to give `drizzle()`: it runs every query on the bound unit. */
  readonly libraryClient: LibraryClient;
}

export interface PgDatabaseOptions {
  pool: Pool;
  clock: Clock;
  release: string;
  lines: LineSink;
}

/** Raised when the library queries the database outside a unit of work. */
export class OutsideUnitError extends Error {
  constructor() {
    super("identity: a library query ran outside a unit of work");
    this.name = "OutsideUnitError";
  }
}

const AUDIT_GUARD = /audit guard: ([a-z_]+\.[a-z_]+)/;

class PgUnit implements UnitTx {
  readonly unitId: string;
  readonly clock: Clock;
  readonly requestId: string | null;
  readonly release: string;
  readonly client: PoolClient;
  /** The library's open savepoints, innermost last, with whether a statement failed inside. */
  readonly savepoints: { name: string; failed: boolean }[] = [];
  #savepointSeq = 0;
  #poisonedBy: string | null = null;
  #failedStatement: string | null = null;

  constructor(client: PoolClient, clock: Clock, release: string, requestId: string | null) {
    this.client = client;
    this.clock = clock;
    this.release = release;
    this.requestId = requestId;
    this.unitId = newId("req", clock);
  }

  get poisonedBy(): string | null {
    return this.#poisonedBy ?? this.#failedStatement;
  }

  poison(reason: string): void {
    this.#poisonedBy ??= reason;
  }

  nextSavepoint(): string {
    this.#savepointSeq += 1;
    return `fin_lib_${this.#savepointSeq}`;
  }

  noteFailure(error: unknown): void {
    const innermost = this.savepoints.at(-1);
    if (innermost !== undefined) innermost.failed = true;
    else this.#failedStatement ??= `statement_failed:${sqlState(error) ?? "unknown"}`;
  }

  async query<R extends object = Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResultLike<R>> {
    const result = await this.run<R>(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async run<R = Row>(
    config: string | QueryConfig,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    try {
      return await this.client.query<R>(config, values);
    } catch (error) {
      this.noteFailure(error);
      throw error;
    }
  }
}

const TRANSACTION_CONTROL = /^\s*(begin|start\s+transaction|commit|end|rollback)\b/i;

export function createPgDatabase(options: PgDatabaseOptions): PgFinDatabase {
  const storage = new AsyncLocalStorage<PgUnit>();

  async function unit<T>(fn: (tx: UnitTx) => Promise<T>, unitOptions?: UnitOptions): Promise<T> {
    const bound = storage.getStore();
    if (bound !== undefined) return fn(bound);
    const client = await options.pool.connect();
    const tx = new PgUnit(client, options.clock, options.release, unitOptions?.requestId ?? null);
    let broken = false;
    try {
      await client.query("BEGIN");
      let result: T;
      try {
        result = await storage.run(tx, () => fn(tx));
      } catch (error) {
        await rollback(client).catch(() => {
          broken = true;
        });
        throw error;
      }
      if (tx.poisonedBy !== null) {
        await rollback(client).catch(() => {
          broken = true;
        });
        throw new UnitRolledBackError(tx.poisonedBy);
      }
      try {
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client).catch(() => {
          broken = true;
        });
        const guard = sqlState(error) === "FA010" ? auditGuardTable(error) : null;
        if (guard !== null) {
          options.lines.write("database.audit_guard", "error", { table: guard });
          throw new AuditGuardError(guard);
        }
        throw error;
      }
      return result;
    } finally {
      client.release(broken);
    }
  }

  const libraryClient: LibraryClient = {
    async query(config: string | QueryConfig, values?: readonly unknown[]): Promise<QueryResult> {
      const tx = storage.getStore();
      if (tx === undefined) throw new OutsideUnitError();
      const text = typeof config === "string" ? config : config.text;
      const control = TRANSACTION_CONTROL.exec(text)?.[1]?.toLowerCase();
      if (control === undefined) return tx.run(config, values);
      // The library's own transactions become savepoints inside the unit (S2-04).
      if (control === "begin" || control.startsWith("start")) {
        const name = tx.nextSavepoint();
        await tx.run(`SAVEPOINT ${name}`);
        tx.savepoints.push({ name, failed: false });
        return emptyResult("SAVEPOINT");
      }
      const savepoint = tx.savepoints.pop();
      if (savepoint === undefined) {
        tx.poison("library_transaction_control");
        throw new Error("identity: the library ended a transaction it did not begin");
      }
      if (control === "rollback" || savepoint.failed) {
        await tx.run(`ROLLBACK TO SAVEPOINT ${savepoint.name}`);
        await tx.run(`RELEASE SAVEPOINT ${savepoint.name}`);
        if (control !== "rollback") {
          // A COMMIT of a savepoint whose statements failed: Postgres would roll it back, so
          // the library's write did not happen; the unit must not pretend it did.
          tx.poison("library_commit_after_failure");
        }
        return emptyResult("ROLLBACK");
      }
      await tx.run(`RELEASE SAVEPOINT ${savepoint.name}`);
      return emptyResult("COMMIT");
    },
  };

  return {
    unit,
    current: () => storage.getStore() ?? null,
    libraryClient,
  };
}

function auditGuardTable(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return AUDIT_GUARD.exec(message)?.[1] ?? "unknown";
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK");
}

function emptyResult(command: string): QueryResult {
  return { rows: [], rowCount: 0, command, fields: [] };
}
