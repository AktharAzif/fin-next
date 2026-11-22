// The unit of work (ARCHITECTURE §3.5, principle 14; spec 02 §3.5).
//
// A request or duty holds one logical unit of work, and a physical client only while its transaction
// runs. The rules this enforces:
//   - one transaction per unit, bound to the async context so an adapter (Better Auth's Drizzle
//     adapter) takes the same connection through `db.current()`; nested work is a savepoint;
//   - no outbound call while the unit holds a client: `assertNotHoldingClient` refuses one, and the
//     test hook in `@fin/db/testing` makes every `fetch` inside a unit fail;
//   - no session-level SET, RESET or DISCARD on a pooled client, only SET LOCAL;
//   - a client whose transaction status is not idle when the unit ends is destroyed, not returned;
//   - a commit the audit guard refuses (FA010) writes `database.audit_guard` with the table only, and
//     throws AuditGuardError, so the caller answers 500 with the request ID alone;
//   - a unit (or savepoint) whose transaction failed is never reported as done: when a statement's
//     error was caught and `fn` still resolved, Postgres would answer COMMIT with a rollback, so the
//     unit rolls back and throws TransactionAbortedError instead of returning `fn`'s result. A
//     statement that may fail on purpose (a unique key mapped to a 409) runs in `tx.savepoint()`.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Line, UnitContext } from "./context.ts";
import {
  AuditGuardError,
  ClientHeldAcrossCallError,
  NestedUnitError,
  SessionStateError,
  TransactionAbortedError,
  UnitClosedError,
} from "./errors.ts";
import { createIdSource, type IdSource } from "./ids.ts";
import type { PgPool, PoolClient, QueryResult, QueryResultRow } from "./pg.ts";
import { commitTransaction, sqlState } from "./pg.ts";

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

const UNIT_TX: unique symbol = Symbol("fin.unitTx");

/** A transaction inside a unit of work. Only `db.unit()` makes one, so a call outside is a type error. */
export interface UnitTx extends Queryable {
  readonly [UNIT_TX]: true;
  readonly context: UnitContext;
  /** IDs from the unit's clock (DA-02). */
  readonly ids: IdSource;
  /** Runs `fn` inside a savepoint: its failure rolls back only its own statements. */
  savepoint<T>(fn: (tx: UnitTx) => Promise<T>): Promise<T>;
  /** The connection, for adapters that need a pg client. Valid only until the unit ends. */
  connection(): PoolClient;
}

export interface FinDatabase {
  /** Runs `fn` in one transaction and commits when it resolves. */
  unit<T>(context: UnitContext, fn: (tx: UnitTx) => Promise<T>): Promise<T>;
  /** Runs `fn` on one client without a transaction (reads, single statements). */
  read<T>(context: UnitContext, fn: (q: Queryable) => Promise<T>): Promise<T>;
  /** The transaction of the unit this async context runs in, if any. */
  current(): UnitTx | undefined;
  readonly pool: PgPool;
  end(): Promise<void>;
}

interface Holding {
  held: boolean;
  tx: UnitTx | undefined;
}

const holding = new AsyncLocalStorage<Holding>();

/** True while the calling async context holds a database client. */
export function isHoldingClient(): boolean {
  return holding.getStore()?.held === true;
}

/**
 * Throws when the caller holds a database client: provider calls, webhook deliveries and every other
 * outbound I/O start only outside a unit (ARCHITECTURE §3.5). packages/server's outbound fetch calls
 * this in every environment.
 */
export function assertNotHoldingClient(what: string): void {
  if (isHoldingClient()) throw new ClientHeldAcrossCallError(what);
}

// SET, RESET and DISCARD change the session for the next unit that takes this client. SET LOCAL and
// SET CONSTRAINTS last only for the transaction. set_config(..., false) is the same as SET.
const SESSION_STATE =
  /^\s*(?:(?:SET)\s+(?!LOCAL\b|CONSTRAINTS\b|TRANSACTION\b)|RESET\b|DISCARD\b)|\bset_config\s*\([^)]*,\s*false\s*\)/i;

export function refusesSessionState(text: string): boolean {
  const withoutComments = text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutComments.split(";").some((statement) => SESSION_STATE.test(statement));
}

function guardedTable(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const match = /^audit guard: ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)$/.exec(message);
  return match?.[1] ?? "unknown";
}

function releaseClient(client: PoolClient): void {
  // A client still in (or failed inside) a transaction must not reach the next unit.
  const status = client.getTransactionStatus();
  client.release(status === "I" ? undefined : true);
}

export interface DatabaseOptions {
  pool: PgPool;
}

export function createDatabase(options: DatabaseOptions): FinDatabase {
  const { pool } = options;

  function makeTx(
    client: PoolClient,
    context: UnitContext,
    ids: IdSource,
    state: { open: boolean; savepoints: number },
  ): UnitTx {
    const tx: UnitTx = {
      [UNIT_TX]: true,
      context,
      ids,
      async query<R extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<QueryResult<R>> {
        if (!state.open) throw new UnitClosedError();
        if (refusesSessionState(text)) throw new SessionStateError();
        return values === undefined ? client.query<R>(text) : client.query<R>(text, values);
      },
      async savepoint<T>(fn: (inner: UnitTx) => Promise<T>): Promise<T> {
        if (!state.open) throw new UnitClosedError();
        state.savepoints += 1;
        const name = `fin_sp_${state.savepoints}`;
        await client.query(`SAVEPOINT ${name}`);
        try {
          const result = await fn(tx);
          // A statement inside failed and its error was caught: the savepoint's work is lost.
          if (client.getTransactionStatus() === "E") throw new TransactionAbortedError();
          try {
            await client.query(`RELEASE SAVEPOINT ${name}`);
          } catch (error) {
            // The status can still read "in a transaction" when the failure was caught: Postgres
            // flushes the error before it says the transaction failed. RELEASE in a failed
            // transaction is refused with 25P02, which is the same news.
            if (sqlState(error) === "25P02") throw new TransactionAbortedError();
            throw error;
          }
          return result;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          throw error;
        }
      },
      connection() {
        if (!state.open) throw new UnitClosedError();
        return client;
      },
    };
    return tx;
  }

  function writeGuardLine(context: UnitContext, table: string): void {
    const line: Line = { event: "database.audit_guard", level: "error", fields: { table } };
    context.log.write(line);
  }

  return {
    pool,

    async unit<T>(context: UnitContext, fn: (tx: UnitTx) => Promise<T>): Promise<T> {
      if (isHoldingClient()) throw new NestedUnitError();
      const client = await pool.connect();
      const store: Holding = { held: true, tx: undefined };
      const state = { open: true, savepoints: 0 };
      const tx = makeTx(client, context, createIdSource(context.clock), state);
      store.tx = tx;
      try {
        return await holding.run(store, async () => {
          await client.query("BEGIN");
          let result: T;
          try {
            result = await fn(tx);
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
          }
          try {
            await commitTransaction(client);
          } catch (error) {
            if (client.getTransactionStatus() !== "I")
              await client.query("ROLLBACK").catch(() => {});
            if (sqlState(error) === "FA010") {
              const table = guardedTable(error);
              writeGuardLine(context, table);
              throw new AuditGuardError(table);
            }
            throw error;
          }
          return result;
        });
      } finally {
        state.open = false;
        store.held = false;
        store.tx = undefined;
        releaseClient(client);
      }
    },

    async read<T>(_context: UnitContext, fn: (q: Queryable) => Promise<T>): Promise<T> {
      if (isHoldingClient()) throw new NestedUnitError();
      const client = await pool.connect();
      const store: Holding = { held: true, tx: undefined };
      let open = true;
      const q: Queryable = {
        async query<R extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<QueryResult<R>> {
          if (!open) throw new UnitClosedError();
          if (refusesSessionState(text)) throw new SessionStateError();
          return values === undefined ? client.query<R>(text) : client.query<R>(text, values);
        },
      };
      try {
        return await holding.run(store, () => fn(q));
      } finally {
        open = false;
        store.held = false;
        releaseClient(client);
      }
    },

    current() {
      const store = holding.getStore();
      return store?.held === true ? store.tx : undefined;
    },

    end: () => pool.end(),
  };
}
