// The unit of work on a real pool (ARCHITECTURE §3.5): one transaction, no client held across an
// outbound call, no session-level SET, non-idle clients destroyed, and the async-context binding.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ClientHeldAcrossCallError,
  NestedUnitError,
  SessionStateError,
  TransactionAbortedError,
  UnitClosedError,
} from "./errors.ts";
import {
  createTestDatabase,
  installFetchGuard,
  type TestDatabase,
  testContext,
} from "./testing/index.ts";
import { assertNotHoldingClient, type FinDatabase, isHoldingClient, type UnitTx } from "./unit.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDatabase;
let edge: FinDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ prefix: "p0e" });
  edge = db.database("fin_edge");
});

afterAll(async () => {
  await db?.drop();
});

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

const ctx = testContext();

describe("one transaction per unit", () => {
  it("commits when the function resolves and rolls back when it throws", async () => {
    await edge.unit(ctx, (tx) =>
      tx.query(
        "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('unit-commit', now(), 1)",
      ),
    );
    await expect(
      edge.unit(ctx, async (tx) => {
        await tx.query(
          "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('unit-rollback', now(), 1)",
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await edge.read(ctx, (q) =>
      q.query<{ key: string }>(
        "SELECT key FROM ops.rate_window WHERE key LIKE 'unit-%' ORDER BY key",
      ),
    );
    expect(rows.rows).toEqual([{ key: "unit-commit" }]);
  });

  it("runs a savepoint whose failure rolls back only its own statements", async () => {
    await edge.unit(ctx, async (tx) => {
      await tx.query(
        "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('sp-outer', now(), 1)",
      );
      await expect(
        tx.savepoint(async (inner) => {
          await inner.query(
            "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('sp-inner', now(), 1)",
          );
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
    });
    const rows = await edge.read(ctx, (q) =>
      q.query<{ key: string }>("SELECT key FROM ops.rate_window WHERE key LIKE 'sp-%'"),
    );
    expect(rows.rows).toEqual([{ key: "sp-outer" }]);
  });

  it("never reports a unit as done when a statement failed and its error was caught", async () => {
    const lines: string[] = [];
    await expect(
      edge.unit(ctx, async (tx) => {
        await tx.query(
          "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('aborted-unit', now(), 1)",
        );
        try {
          await tx.query("SELECT 1/0");
        } catch {
          lines.push("caught");
        }
        return "done";
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
    expect(lines).toEqual(["caught"]);
    const rows = await edge.read(ctx, (q) =>
      q.query("SELECT key FROM ops.rate_window WHERE key = 'aborted-unit'"),
    );
    expect(rows.rows).toEqual([]);
    // The pool's client is usable by the next unit.
    await expect(edge.unit(ctx, (tx) => tx.query("SELECT 1"))).resolves.toBeDefined();
  });

  it("fails a savepoint whose statement failed with its error caught, and keeps the rest of the unit", async () => {
    await edge.unit(ctx, async (tx) => {
      await tx.query(
        "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('aborted-sp-kept', now(), 1)",
      );
      await expect(
        tx.savepoint(async (inner) => {
          await inner.query(
            "INSERT INTO ops.rate_window (key, window_start, count) VALUES ('aborted-sp-lost', now(), 1)",
          );
          await inner.query("SELECT 1/0").catch(() => {});
          return "done";
        }),
      ).rejects.toBeInstanceOf(TransactionAbortedError);
    });
    const rows = await edge.read(ctx, (q) =>
      q.query<{ key: string }>(
        "SELECT key FROM ops.rate_window WHERE key IN ('aborted-sp-kept', 'aborted-sp-lost') ORDER BY key",
      ),
    );
    expect(rows.rows).toEqual([{ key: "aborted-sp-kept" }]);
  });

  it("binds the transaction to the async context for adapters, and only while the unit runs", async () => {
    expect(edge.current()).toBeUndefined();
    let seen: UnitTx | undefined;
    let leaked: UnitTx | undefined;
    await edge.unit(ctx, async (tx) => {
      await Promise.resolve();
      seen = edge.current();
      expect(seen).toBe(tx);
      expect(tx.connection()).toBeDefined();
      leaked = tx;
    });
    expect(edge.current()).toBeUndefined();
    await expect(leaked?.query("SELECT 1")).rejects.toBeInstanceOf(UnitClosedError);
    expect(() => leaked?.connection()).toThrow(UnitClosedError);
  });

  it("refuses a unit inside a unit (nested work is a savepoint)", async () => {
    await expect(edge.unit(ctx, () => edge.unit(ctx, async () => {}))).rejects.toBeInstanceOf(
      NestedUnitError,
    );
  });

  it("makes IDs from the unit's clock", async () => {
    const fixed = testContext({ clock: { now: () => Date.UTC(2026, 10, 21) } });
    const id = await edge.unit(fixed, async (tx) => tx.ids.newId("req"));
    expect(id.slice(4, 14)).toBe(
      await edge.unit(fixed, async (tx) => tx.ids.newId("req").slice(4, 14)),
    );
  });
});

describe("no session-level state on a pooled client", () => {
  it("refuses SET, RESET and DISCARD, and allows SET LOCAL", async () => {
    await expect(
      edge.unit(ctx, (tx) => tx.query("SET statement_timeout = 0")),
    ).rejects.toBeInstanceOf(SessionStateError);
    await expect(edge.read(ctx, (q) => q.query("RESET ALL"))).rejects.toBeInstanceOf(
      SessionStateError,
    );
    await expect(edge.read(ctx, (q) => q.query("DISCARD ALL"))).rejects.toBeInstanceOf(
      SessionStateError,
    );
    const timeout = await edge.unit(ctx, async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '1234ms'");
      return (await tx.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t"))
        .rows[0]?.t;
    });
    expect(timeout).toBe("1234ms");
    const after = await edge.read(ctx, (q) =>
      q.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t"),
    );
    expect(after.rows[0]?.t).toBe("15s");
  });

  it("destroys a client left inside a transaction instead of returning it to the pool", async () => {
    const pool = edge.pool;
    await edge.read(ctx, async (q) => {
      await q.query("SELECT 1");
    });
    const before = pool.totalCount;
    await edge.read(ctx, async (q) => {
      await q.query("BEGIN");
    });
    expect(pool.totalCount).toBe(before - 1);
    const status = await edge.read(ctx, async (q) =>
      q.query<{ in_tx: boolean }>("SELECT now() = statement_timestamp() AS in_tx"),
    );
    expect(status.rows[0]?.in_tx).toBe(true);
  });
});

describe("no client held across an outbound call (the test hook)", () => {
  it("fails any fetch that starts inside a unit, and lets one outside through", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("ok");
    }) as typeof fetch;
    try {
      uninstall = installFetchGuard();
      await expect(
        edge.unit(ctx, async () => {
          await fetch("https://provider.example.com/a");
        }),
      ).rejects.toBeInstanceOf(ClientHeldAcrossCallError);
      await expect(
        edge.read(ctx, async () => {
          await fetch("https://provider.example.com/b");
        }),
      ).rejects.toBeInstanceOf(ClientHeldAcrossCallError);
      await edge.unit(ctx, async (tx) => tx.query("SELECT 1"));
      const response = await fetch("https://provider.example.com/c");
      expect(await response.text()).toBe("ok");
      expect(calls).toEqual(["https://provider.example.com/c"]);
    } finally {
      uninstall?.();
      uninstall = undefined;
      globalThis.fetch = original;
    }
  });

  it("answers isHoldingClient and assertNotHoldingClient by the async context, and false once the unit ends", async () => {
    expect(isHoldingClient()).toBe(false);
    let later: Promise<boolean> | undefined;
    await edge.unit(ctx, async () => {
      expect(isHoldingClient()).toBe(true);
      expect(() => assertNotHoldingClient("provider call")).toThrow(ClientHeldAcrossCallError);
      later = new Promise((resolve) => setTimeout(() => resolve(isHoldingClient()), 20));
    });
    expect(await later).toBe(false);
    expect(() => assertNotHoldingClient("provider call")).not.toThrow();
  });
});
