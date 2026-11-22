// The chain against Postgres 18: T08-09 (the TypeScript hash equals audit.row_hash for 10,000
// generated rows, nulls, empty arrays, Unicode metadata and columns at their maximum included), T08-11's
// row checks (a changed byte, a deleted row, a broken link), and the sequencer loop on a real database.
import { randomBytes, randomInt } from "node:crypto";
import type { PgClient } from "@fin/db";
import {
  collectLines,
  createTestDatabase,
  registerEventTypes,
  type TestDatabase,
  testContext,
  testId,
} from "@fin/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHAIN_SELECT, type ChainRow, rowHash, verifyRows, ZERO_HASH } from "./chain.ts";
import { runSequencer } from "./sequencer.ts";
import { syncEventTypes } from "./sync.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDatabase;
let su: PgClient;

beforeAll(async () => {
  db = await createTestDatabase({
    prefix: "p0e",
    after: (q) => syncEventTypes(q, "test-release").then(() => {}),
  });
  su = await db.superuser();
  const owner = await db.connect("fin_owner");
  try {
    await registerEventTypes(owner, [
      { name: "test.chain_row", roles: ["fin_admin"], scope: "staff", category: "staff" },
      {
        name: "test.chain_org",
        roles: ["fin_admin"],
        scope: "organisation",
        category: "organisation",
      },
    ]);
  } finally {
    await owner.end();
  }
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

const UNICODE = ["é", "é", "李", "🙂", "שלום", "Ω≈ç√", " ", 'a"b\\c', "tab\there", "ß"];

function maybe<T>(value: T): T | null {
  return randomInt(2) === 0 ? null : value;
}

/** Up to `max` characters (code points, so an emoji is never cut in half). */
function text(max: number): string {
  const length = randomInt(1, max + 1);
  const out: string[] = [];
  while (out.length < length) out.push(...Array.from(UNICODE[randomInt(UNICODE.length)] ?? "x"));
  return out.slice(0, length).join("");
}

function id(prefix: string): string {
  return testId(prefix);
}

/** One random audit.record() input; every tenth row has every column at its maximum. */
function generated(i: number): Record<string, unknown> {
  const max = i % 10 === 0;
  const org = max || randomInt(3) === 0;
  const stepUp = max || randomInt(4) === 0;
  const metadata: Record<string, unknown> = {};
  const keys = max ? 6 : randomInt(0, 6);
  for (let k = 0; k < keys; k++) {
    const kind = randomInt(5);
    metadata[`k${k}`] =
      kind === 0
        ? text(max ? 150 : 40)
        : kind === 1
          ? randomInt(1_000_000) / (randomInt(2) === 0 ? 1 : 7)
          : kind === 2
            ? randomInt(2) === 0
            : kind === 3
              ? null
              : Array.from({ length: max ? 5 : randomInt(0, 5) }, () => text(20));
  }
  return {
    id: id("aud"),
    event: org ? "test.chain_org" : "test.chain_row",
    actor_kind: "staff",
    actor_id: max ? "s".repeat(200) : maybe(id("stf")),
    actor_via: "admin",
    actor_key_id: max ? "k".repeat(200) : maybe("KEYID12345"),
    actor_link_session_id: max ? "l".repeat(200) : maybe(id("lks")),
    ...(stepUp
      ? {
          step_up_kind: "intent",
          step_up_method: "passkey",
          step_up_ref: max ? "r".repeat(200) : id("sti"),
        }
      : {}),
    target_id: max ? "t".repeat(200) : text(30),
    ref_ids: max
      ? Array.from({ length: 32 }, (_, j) => `${j}`.padEnd(200, "x"))
      : Array.from({ length: randomInt(0, 4) }, () => id("mem")),
    ...(org ? { organization_id: max ? "o".repeat(200) : id("org") } : {}),
    subject_user_id: maybe(id("usr")),
    mode: randomInt(3) === 0 ? null : randomInt(2) === 0 ? "sandbox" : "live",
    metadata,
    request_id: maybe(id("req")),
    release: max ? "v".repeat(64) : "rel",
  };
}

async function chained(epoch: number): Promise<ChainRow[]> {
  const result = await su.query<ChainRow>(
    `SELECT ${CHAIN_SELECT} FROM audit.event e WHERE e.epoch = $1 AND e.seq IS NOT NULL ORDER BY e.seq`,
    [epoch],
  );
  return result.rows;
}

describe("T08-09: the TypeScript hash equals audit.row_hash", () => {
  it("for 10,000 generated rows, then the verifier walks them all", async () => {
    const admin = await db.connect("fin_admin_a", "fin-admin");
    try {
      for (let batch = 0; batch < 20; batch++) {
        const rows = Array.from({ length: 500 }, (_, i) => generated(batch * 500 + i));
        await admin.query(
          "SELECT count(audit.record(x)) FROM jsonb_array_elements($1::jsonb) AS t(x)",
          [JSON.stringify(rows)],
        );
      }
    } finally {
      await admin.end();
    }
    const worker = await db.connect("fin_worker_a");
    try {
      expect(
        (await worker.query<{ n: number }>("SELECT audit.sequence(50000) AS n")).rows[0]?.n,
      ).toBe(10_000);
    } finally {
      await worker.end();
    }
    const rows = await chained(1);
    expect(rows.length).toBe(10_000);
    const mismatches = rows.filter(
      (row) => !rowHash(row, row.prev_hash).equals(row.hash ?? Buffer.alloc(0)),
    );
    expect(mismatches.map((row) => row.seq)).toEqual([]);
    expect(rows.some((row) => row.ref_ids.length === 0)).toBe(true);
    expect(rows.some((row) => row.ref_ids.length === 32)).toBe(true);
    expect(rows.some((row) => row.actor_id === null)).toBe(true);
    expect(rows.some((row) => /🙂|李/u.test(row.metadata_text))).toBe(true);
    const check = verifyRows(rows, "0", ZERO_HASH);
    expect(check).toMatchObject({ ok: true, checked: 10_000, lastSeq: "10000" });
    const head = await su.query<{ hash: Buffer }>("SELECT hash FROM audit.head WHERE current");
    expect(head.rows[0]?.hash.equals(check.lastHash)).toBe(true);
  });
});

describe("the sequencer loop on a real database", () => {
  it("chains new rows while it holds the lease and writes its job.run line", async () => {
    const admin = await db.connect("fin_admin_a");
    try {
      for (let i = 0; i < 3; i++) {
        await admin.query("SELECT audit.record($1::jsonb)", [JSON.stringify(generated(1))]);
      }
    } finally {
      await admin.end();
    }
    const lines = collectLines();
    const worker = db.database("fin_worker");
    const controller = new AbortController();
    let now = Date.UTC(2026, 10, 21, 12);
    await runSequencer(
      {
        db: worker,
        clock: { now: () => now },
        log: lines,
        context: () => testContext(),
        holdsLease: () => true,
        sleep: async () => {
          now += 60_000;
          controller.abort();
        },
      },
      controller.signal,
    );
    expect(lines.lines).toEqual([]);
    const unchained = await su.query(
      "SELECT count(*)::int AS n FROM audit.event WHERE seq IS NULL",
    );
    expect(unchained.rows).toEqual([{ n: 0 }]);
    // The next pass reports the minute.
    const again = new AbortController();
    await runSequencer(
      {
        db: worker,
        clock: { now: () => now },
        log: lines,
        context: () => testContext(),
        holdsLease: () => true,
        reportEveryMs: 0,
        sleep: async () => again.abort(),
      },
      again.signal,
    );
    expect(lines.lines).toEqual([
      {
        event: "job.run",
        fields: expect.objectContaining({
          job: "audit-sequencer",
          runs: 1,
          processed: 0,
          oldestUnsequencedS: 0,
          result: "ok",
        }),
      },
    ]);
  });
});

describe("T08-11: the verifier finds a changed byte, a deleted row and a broken link", () => {
  it("reports each where it happened (the rows changed as the superuser, with triggers off)", async () => {
    const before = await chained(1);
    expect(verifyRows(before, "0", ZERO_HASH).ok).toBe(true);
    await su.query("SET session_replication_role = replica");
    try {
      await su.query(
        "UPDATE audit.event SET target_id = target_id || 'x' WHERE epoch = 1 AND seq = 500",
      );
      expect(verifyRows(await chained(1), "0", ZERO_HASH).failure).toEqual({
        reason: "hash",
        epoch: 1,
        seq: "500",
      });
      await su.query("DELETE FROM audit.event WHERE epoch = 1 AND seq = 300");
      expect(verifyRows(await chained(1), "0", ZERO_HASH).failure).toEqual({
        reason: "gap",
        epoch: 1,
        seq: "301",
      });
      await su.query("UPDATE audit.event SET prev_hash = $1 WHERE epoch = 1 AND seq = 100", [
        randomBytes(32),
      ]);
      expect(verifyRows(await chained(1), "0", ZERO_HASH).failure).toEqual({
        reason: "link",
        epoch: 1,
        seq: "100",
      });
    } finally {
      await su.query("SET session_replication_role = origin");
    }
  });
});
