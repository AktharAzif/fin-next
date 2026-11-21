import type { FinDatabase, Line, Queryable, UnitTx } from "@fin/db";
import { describe, expect, it } from "vitest";
import { runSequencer } from "./sequencer.ts";

function fakeDb(chained: number[], failOn = new Set<number>()) {
  let pass = 0;
  const q: Queryable = {
    async query(text: string) {
      if (text.includes("audit.sequence")) {
        pass += 1;
        if (failOn.has(pass)) throw new Error("db down");
        return {
          rows: [{ n: chained[pass - 1] ?? 0 }],
          rowCount: 1,
          command: "SELECT",
          fields: [],
        } as never;
      }
      return { rows: [{ s: 3 }], rowCount: 1, command: "SELECT", fields: [] } as never;
    },
  };
  const db = {
    unit: async <T>(_ctx: unknown, fn: (tx: UnitTx) => Promise<T>) => fn(q as UnitTx),
    read: async <T>(_ctx: unknown, fn: (q: Queryable) => Promise<T>) => fn(q),
  } as unknown as FinDatabase;
  return db;
}

describe("runSequencer", () => {
  it("passes every interval while it holds the lease, and writes one job.run line a minute", async () => {
    let now = 0;
    const lines: Line[] = [];
    const controller = new AbortController();
    let ticks = 0;
    await runSequencer(
      {
        db: fakeDb([2, 0, 5, 1]),
        clock: { now: () => new Date(now) },
        log: { write: (line) => lines.push(line) },
        context: () => ({
          clock: { now: () => new Date(now) },
          release: "r",
          log: { write: () => {} },
        }),
        holdsLease: () => true,
        sleep: async () => {
          now += 20_000;
          ticks += 1;
          if (ticks === 4) controller.abort();
        },
      },
      controller.signal,
    );
    expect(lines).toEqual([
      {
        event: "job.run",
        level: "info",
        fields: {
          job: "audit-sequencer",
          trigger: "schedule",
          processed: 8,
          runs: 4,
          failed: 0,
          oldestUnsequencedS: 3,
          result: "ok",
        },
      },
    ]);
  });

  it("does not pass without the lease, and reports the skip; counts a failed pass", async () => {
    let now = 0;
    const lines: Line[] = [];
    const controller = new AbortController();
    let holds = false;
    let ticks = 0;
    await runSequencer(
      {
        db: fakeDb([1, 1], new Set([1])),
        clock: { now: () => new Date(now) },
        log: { write: (line) => lines.push(line) },
        context: () => ({
          clock: { now: () => new Date(now) },
          release: "r",
          log: { write: () => {} },
        }),
        holdsLease: () => holds,
        sleep: async () => {
          now += 60_000;
          ticks += 1;
          holds = ticks >= 2;
          if (ticks === 4) controller.abort();
        },
      },
      controller.signal,
    );
    expect(lines.map((l) => l.fields)).toEqual([
      expect.objectContaining({ runs: 0, result: "skipped", skipReason: "leased" }),
      expect.objectContaining({ runs: 0, failed: 1, result: "failed" }),
      expect.objectContaining({ runs: 1, processed: 1, result: "ok" }),
    ]);
  });
});
