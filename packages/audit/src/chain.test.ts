import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ChainRow, rowHash, verifyRows, ZERO_HASH } from "./chain.ts";

function row(seq: number, overrides: Partial<ChainRow> = {}): ChainRow {
  return {
    epoch: 1,
    seq: String(seq),
    id: `aud_${String(seq).padStart(26, "0")}`,
    event: "system.sweep_completed",
    category: "system",
    scope: "staff",
    organization_id: null,
    subject_user_id: null,
    mode: null,
    actor_kind: "system",
    actor_id: null,
    actor_via: "job",
    actor_key_id: null,
    actor_link_session_id: null,
    step_up_kind: null,
    step_up_method: null,
    step_up_ref: null,
    target_id: "ops.rate_window",
    ref_ids: [],
    metadata_text: '{"deleted": 1, "olderThan": "P1D"}',
    request_id: null,
    release: "rel",
    db_login: "fin_worker_a",
    app_name: "fin-worker",
    backend_pid: 42,
    xid: "1000",
    recorded_at_text: "2026-11-21T10:00:00.000000Z",
    prev_hash: null,
    hash: null,
    ...overrides,
  };
}

function chain(count: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: Buffer = ZERO_HASH;
  for (let i = 1; i <= count; i++) {
    const r = row(i, { prev_hash: prev });
    r.hash = rowHash(r, prev);
    prev = r.hash;
    rows.push(r);
  }
  return rows;
}

describe("rowHash, version 1", () => {
  it("is SHA-256 over length-prefixed UTF-8 fields, nulls as FF FF FF FF, in spec 08 §3.6's order", () => {
    const r = row(7, { ref_ids: ["mem_a", "ü"], organization_id: "org_x" });
    const enc = (value: string | null) => {
      if (value === null) return Buffer.from([0xff, 0xff, 0xff, 0xff]);
      const bytes = Buffer.from(value, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(bytes.length);
      return Buffer.concat([len, bytes]);
    };
    const prev = Buffer.alloc(32, 9);
    const prevField = Buffer.concat([Buffer.from([0, 0, 0, 32]), prev]);
    const expected = createHash("sha256")
      .update(
        Buffer.concat([
          enc("fin-audit-v1"),
          enc("1"),
          enc("7"),
          prevField,
          enc(r.id),
          enc(r.event),
          enc(r.category),
          enc(r.scope),
          enc("org_x"),
          enc(null),
          enc(null),
          enc("system"),
          enc(null),
          enc("job"),
          enc(null),
          enc(null),
          enc(null),
          enc(null),
          enc(null),
          enc("ops.rate_window"),
          enc("2"),
          enc("mem_a"),
          enc("ü"),
          enc(r.metadata_text),
          enc(null),
          enc("rel"),
          enc("fin_worker_a"),
          enc("fin-worker"),
          enc("42"),
          enc("1000"),
          enc("2026-11-21T10:00:00.000000Z"),
        ]),
      )
      .digest();
    expect(rowHash(r, prev).equals(expected)).toBe(true);
  });

  it("changes when any field changes, including a null becoming an empty string", () => {
    const base = rowHash(row(1), ZERO_HASH);
    expect(rowHash(row(1, { actor_id: "" }), ZERO_HASH).equals(base)).toBe(false);
    expect(rowHash(row(1, { ref_ids: [""] }), ZERO_HASH).equals(base)).toBe(false);
    expect(rowHash(row(1), Buffer.alloc(32, 1)).equals(base)).toBe(false);
    expect(
      rowHash(row(1, { metadata_text: '{"deleted": 2, "olderThan": "P1D"}' }), ZERO_HASH).equals(
        base,
      ),
    ).toBe(false);
  });
});

describe("verifyRows (the verifier's walk, §3.8 step 2)", () => {
  it("accepts an intact chain and says where the next check starts", () => {
    const rows = chain(5);
    const check = verifyRows(rows, "0", ZERO_HASH);
    expect(check).toMatchObject({ ok: true, lastSeq: "5", checked: 5 });
    expect(check.lastHash.equals(rows[4]?.hash ?? Buffer.alloc(0))).toBe(true);
  });

  it("reports a changed row (hash), a broken link (link) and a missing row (gap)", () => {
    const changed = chain(5);
    const third = changed[2];
    if (third) third.target_id = "tampered";
    expect(verifyRows(changed, "0", ZERO_HASH).failure).toEqual({
      reason: "hash",
      epoch: 1,
      seq: "3",
    });

    const relinked = chain(5);
    const fourth = relinked[3];
    if (fourth) fourth.prev_hash = Buffer.alloc(32, 7);
    expect(verifyRows(relinked, "0", ZERO_HASH).failure).toEqual({
      reason: "link",
      epoch: 1,
      seq: "4",
    });

    const gapped = chain(5);
    gapped.splice(1, 1);
    expect(verifyRows(gapped, "0", ZERO_HASH).failure).toEqual({
      reason: "gap",
      epoch: 1,
      seq: "3",
    });
  });
});
