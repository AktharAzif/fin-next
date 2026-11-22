// A database port that refuses every use, for unit tests that must prove a request never
// reached the database (the allowlist answers before any unit of work or limit).
import type { Pool, QueryConfig, QueryResult } from "pg";
import { systemClock } from "../src/ports/clock.ts";
import { MemoryLineSink } from "../src/ports/log.ts";
import { createPgDatabase, type PgFinDatabase } from "../src/ports/pg-database.ts";

export class UntouchablePool {
  connects = 0;
  async connect(): Promise<never> {
    this.connects += 1;
    throw new Error("the database was used");
  }
  async query(_text: string | QueryConfig): Promise<QueryResult> {
    throw new Error("the database was used");
  }
  async end(): Promise<void> {}
  on(): this {
    return this;
  }
}

export function untouchableDatabase(): {
  db: PgFinDatabase;
  pool: UntouchablePool;
  lines: MemoryLineSink;
} {
  const pool = new UntouchablePool();
  const lines = new MemoryLineSink();
  const db = createPgDatabase({
    pool: pool as unknown as Pool,
    clock: systemClock,
    release: "test",
    lines,
  });
  return { db, pool, lines };
}
