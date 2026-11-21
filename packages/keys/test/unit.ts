// A unit of work over one connection, for the lifecycle's integration tests: BEGIN, the work, then
// COMMIT, or ROLLBACK when the work threw or poisoned the unit, as the console's unit of work does.
// Commit-time refusals (the audit guard's FA010) surface as the commit's error.
import type { KeysTx } from "../src/tx.ts";
import type { PlatformClient } from "./platform.mjs";

export async function inUnit<T>(
  client: PlatformClient,
  fn: (tx: KeysTx) => Promise<T>,
  requestId = "req_01jd0000000000000000000000",
): Promise<T> {
  let poisoned: string | null = null;
  const tx: KeysTx = {
    query: (text, values) => client.query(text, values),
    requestId,
    release: "test-release",
    poison: (reason) => {
      poisoned ??= reason;
    },
  };
  await client.query("BEGIN");
  let result: T;
  try {
    result = await fn(tx);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  if (poisoned !== null) {
    await client.query("ROLLBACK");
    throw new Error(`the unit was poisoned: ${poisoned}`);
  }
  await client.query("COMMIT");
  return result;
}

/** A Fin ID with a fixed body, for fixtures. */
export function fixtureId(prefix: string, n: number): string {
  return `${prefix}_01jd${String(n).padStart(22, "0")}`;
}
