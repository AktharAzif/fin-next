// The small database seam the outbox code runs on. `pg`'s Pool and PoolClient satisfy it as they
// are; `@fin/db` (P0-E, under review) will hand the worker its pool, and nothing here changes.
// A pooled client is held only for a short transaction with no outbound I/O inside it (ARCHITECTURE
// principle 14): every send happens between two pool-level statements.

export interface QueryResultLike<R> {
  readonly rows: R[];
  readonly rowCount: number | null;
}

export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResultLike<R>>;
}

export interface ClientLike extends Queryable {
  release(error?: Error | boolean): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<ClientLike>;
}

/** Runs `work` in one transaction on one pooled client, released on every path. */
export async function inTransaction<T>(
  pool: PoolLike,
  work: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    throw error;
  } finally {
    client.release(broken ?? false);
  }
}
