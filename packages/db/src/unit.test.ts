import { describe, expect, it } from "vitest";
import { discardLines } from "./context.ts";
import { TransactionAbortedError } from "./errors.ts";
import { defineGuards } from "./guards/types.ts";
import { createIdSource, idPattern, isId } from "./ids.ts";
import { PgDatabaseError, type PgPool } from "./pg.ts";
import { createDatabase, refusesSessionState } from "./unit.ts";

describe("a savepoint whose statement failed with its error caught", () => {
  it("throws TransactionAbortedError even before the client's status has caught up with the failure", async () => {
    const sent: string[] = [];
    let failed = false;
    const refusal = (message: string, code: string) =>
      Object.assign(new PgDatabaseError(message), { code });
    const client = {
      async query(text: string) {
        sent.push(text);
        if (text === "SELECT 1/0") {
          failed = true;
          throw refusal("division by zero", "22012");
        }
        if (failed && text.startsWith("RELEASE SAVEPOINT")) {
          throw refusal("current transaction is aborted", "25P02");
        }
        if (text.startsWith("ROLLBACK TO SAVEPOINT")) failed = false;
        return { rows: [], rowCount: 0, command: text.split(" ")[0], fields: [] };
      },
      // The status the last ReadyForQuery gave: Postgres flushes an error before it, so a caller can
      // catch a failure while the status still says the transaction is fine.
      getTransactionStatus: () => "T",
      release() {},
    };
    const db = createDatabase({ pool: { connect: async () => client } as unknown as PgPool });
    const context = { clock: { now: () => 0 }, release: "r", log: discardLines };
    await db.unit(context, async (tx) => {
      await expect(
        tx.savepoint(async (inner) => {
          await inner.query("SELECT 1/0").catch(() => {});
          return "done";
        }),
      ).rejects.toBeInstanceOf(TransactionAbortedError);
    });
    expect(sent).toEqual([
      "BEGIN",
      "SAVEPOINT fin_sp_1",
      "SELECT 1/0",
      "RELEASE SAVEPOINT fin_sp_1",
      "ROLLBACK TO SAVEPOINT fin_sp_1",
      "COMMIT",
    ]);
  });
});

describe("refusesSessionState (no session-level SET on a pooled client)", () => {
  it("refuses SET, SET SESSION, RESET, DISCARD and set_config(..., false)", () => {
    for (const sql of [
      "SET search_path = ops",
      "  set statement_timeout = 0",
      "SET SESSION AUTHORIZATION fin_owner",
      "SET ROLE fin_api",
      "RESET ALL",
      "DISCARD ALL",
      "SELECT set_config('search_path', 'ops', false)",
      "SELECT 1; SET work_mem = '1GB'",
      "-- a comment\nSET timezone = 'UTC'",
    ]) {
      expect(refusesSessionState(sql), sql).toBe(true);
    }
  });

  it("allows SET LOCAL, SET CONSTRAINTS, SET TRANSACTION and ordinary statements", () => {
    for (const sql of [
      "SET LOCAL statement_timeout = '5s'",
      "SET CONSTRAINTS ALL IMMEDIATE",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      "UPDATE ops.job SET state = 'done' WHERE id = $1",
      "SELECT set_config('fin.x', 'y', true)",
      "INSERT INTO t (settings) VALUES ('SET x')",
    ]) {
      expect(refusesSessionState(sql), sql).toBe(false);
    }
  });
});

describe("IDs (DA-02)", () => {
  it("are <prefix>_<26 Crockford characters>, time-ordered by the unit's clock", () => {
    let now = Date.UTC(2026, 10, 21, 10, 0, 0);
    const ids = createIdSource({ now: () => now });
    const first = ids.newId("aud");
    now += 1;
    const second = ids.newId("aud");
    expect(first).toMatch(/^aud_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(isId("aud", first)).toBe(true);
    expect(first < second).toBe(true);
    expect(first.slice(4, 14)).not.toBe(second.slice(4, 14));
  });

  it("puts 80 random bits after the time, from the injected source", () => {
    const fixed = createIdSource({ now: () => 0 }, (size) => new Uint8Array(size).fill(0xff));
    expect(fixed.newId("job")).toBe(`job_${"0".repeat(10)}${"z".repeat(16)}`);
    const zero = createIdSource({ now: () => 0 }, (size) => new Uint8Array(size));
    expect(zero.newId("eml")).toBe(`eml_${"0".repeat(26)}`);
  });

  it("refuses a bad prefix and a time outside 48 bits", () => {
    expect(() => idPattern("AUD")).toThrow(TypeError);
    expect(() => createIdSource({ now: () => -1 }).newId("aud")).toThrow(RangeError);
  });
});

describe("defineGuards", () => {
  it("refuses a registration the installer would refuse", () => {
    const ok = {
      table: "ops.kill_switch",
      ops: ["INSERT"],
      keyColumn: "name",
      events: ["switch.set"],
    } as const;
    expect(defineGuards([ok])).toEqual([ok]);
    expect(() => defineGuards([{ ...ok, table: "kill_switch" }])).toThrow(TypeError);
    expect(() => defineGuards([{ ...ok, ops: ["UPDATE OF state; DROP"] as never }])).toThrow(
      TypeError,
    );
    expect(() => defineGuards([{ ...ok, events: ["Switch.Set"] }])).toThrow(TypeError);
    expect(() => defineGuards([{ ...ok, events: [] }])).toThrow(TypeError);
  });
});
