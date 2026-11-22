// Unit tests for the limiter's failures (spec 02 §5.6, §18.2): a store that fails is refused
// closed with `limits.store_failed`, which pages; two units in each other's way are not a store
// that failed, so a deadlock or a serialization failure is thrown as it came.
import { describe, expect, it } from "vitest";
import { createLimitStore, isConflict, type LimitStore, LimitStoreError } from "./limits.ts";
import { systemClock } from "./ports/clock.ts";
import type { Queryable } from "./ports/db.ts";
import { MemoryLineSink } from "./ports/log.ts";

/** A database whose every statement fails with this SQLSTATE. */
function failing(code: string): { error: Error; db: Queryable } {
  const error = Object.assign(new Error(`refused with ${code}`), { code });
  return {
    error,
    db: {
      query: async () => {
        throw error;
      },
    },
  };
}

/** Every call of the limiter that runs a statement. */
function calls(limits: LimitStore, db: Queryable): (() => Promise<unknown>)[] {
  return [
    () => limits.consume(db, "code_send", "subject"),
    () => limits.consumeWindows(db, "default", [{ ms: 10_000, max: 100 }], "subject"),
    () => limits.remaining(db, "code_send", "subject"),
    () => limits.lock(db, "key", "code_email", new Date()),
    () => limits.lockedUntil(db, "key"),
    () => limits.holdLockout(db, "key", "factor_code"),
    () => limits.recordFailure(db, "key", "factor_code", 10, 60_000),
    () => limits.clearFailures(db, "key"),
  ];
}

describe("the limiter's failures", () => {
  it("throws a deadlock or a serialization failure as it came, never as a store failure", async () => {
    for (const code of ["40P01", "40001"]) {
      const lines = new MemoryLineSink();
      const limits = createLimitStore({ clock: systemClock, lines });
      const { error, db } = failing(code);
      expect(isConflict(error)).toBe(true);
      for (const call of calls(limits, db)) await expect(call()).rejects.toBe(error);
      expect(lines.named("limits.store_failed")).toEqual([]);
    }
  });

  it("refuses any other failure closed as a store failure, with its line", async () => {
    for (const code of ["42501", "57014", "08006"]) {
      const lines = new MemoryLineSink();
      const limits = createLimitStore({ clock: systemClock, lines });
      const { error, db } = failing(code);
      expect(isConflict(error)).toBe(false);
      const all = calls(limits, db);
      for (const call of all) await expect(call()).rejects.toBeInstanceOf(LimitStoreError);
      expect(lines.named("limits.store_failed")).toHaveLength(all.length);
    }
    expect(isConflict(new Error("no SQLSTATE"))).toBe(false);
  });
});
