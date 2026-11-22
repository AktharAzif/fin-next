// Types of database.mjs (see its header for why it is JavaScript).
import type { Clock as ProcessClock } from "@fin/core";
import type { Clock, LineSink, PgFinDatabase } from "@fin/identity";
import type { DatabaseClock } from "@fin/server/process-health";

export interface AdminDatabase {
  readonly db: PgFinDatabase;
  close(): Promise<void>;
  stats(): { poolTotal: number; poolIdle: number; poolWaiting: number };
  /** `dbOk` and `clockSkewMs` for `process.health`, against the process's injected clock. */
  sampleClock(clock: ProcessClock): Promise<DatabaseClock>;
}

export function openAdminDatabase(options: {
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
  release: string;
  lines: LineSink;
}): AdminDatabase;
