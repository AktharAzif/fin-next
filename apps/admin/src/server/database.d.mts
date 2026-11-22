// Types of database.mjs (see its header for why it is JavaScript).
import type { Clock, LineSink, PgFinDatabase } from "@fin/identity";

export interface AdminDatabase {
  readonly db: PgFinDatabase;
  close(): Promise<void>;
  stats(): { poolTotal: number; poolIdle: number; poolWaiting: number };
}

export function openAdminDatabase(options: {
  env: Readonly<Record<string, string | undefined>>;
  clock: Clock;
  release: string;
  lines: LineSink;
}): AdminDatabase;
