// T08-07: recordAudit throws on an email, IP, token shape, URL with a query or nine digits in any
// metadata string, and on an actor kind the event does not allow, before any SQL. And the payload it
// hands audit.record(), the journal entry, and the failure line.
import { createIdSource, type Line, PgDatabaseError, type UnitTx } from "@fin/db";
import { describe, expect, it } from "vitest";
import { AuditEventError, AuditWriteError, recordAudit, storedUserAgent } from "./record.ts";
import {
  AuditMetadataError,
  assertNoPersonalShapes,
  assertStorableText,
  personalShapeOf,
} from "./shapes.ts";

interface FakeTx {
  tx: UnitTx;
  queries: { text: string; values: readonly unknown[] | undefined }[];
  lines: Line[];
}

function fakeTx(fail?: { code: string; on: string }): FakeTx {
  const queries: FakeTx["queries"] = [];
  const lines: Line[] = [];
  const tx = {
    context: {
      clock: { now: () => Date.UTC(2026, 10, 21, 12) },
      release: "rel-1",
      requestId: "req_0000000000000000000000000a",
      log: { write: (line: Line) => lines.push(line) },
    },
    ids: createIdSource({ now: () => Date.UTC(2026, 10, 21, 12) }),
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (fail !== undefined && text.includes(fail.on)) {
        throw Object.assign(new PgDatabaseError("refused"), { code: fail.code });
      }
      return { rows: [], rowCount: 0, command: "SELECT", fields: [] };
    },
  } as unknown as UnitTx;
  return { tx, queries, lines };
}

const sweep = {
  event: "system.sweep_completed" as const,
  actor: { kind: "system" as const, id: null, via: "job" as const },
  target: "ops.rate_window",
  metadata: { deleted: 3, olderThan: "P1D" },
};

const digits = ["1234", "56789"].join("");
const jwt = ["eyJ", "hbGciOiJIUzI1NiJ9"].join("");
const urlWithQuery = ["https://", "example.com/cb", "?code=1"].join("");

describe("personal shapes (T08-07)", () => {
  it("finds an email, an IP address, a token or key shape, a URL with a query and nine digits", () => {
    expect(personalShapeOf("ada@example.com")).toBe("email");
    expect(personalShapeOf("from 192.0.2.44 today")).toBe("ipv4");
    expect(personalShapeOf("2001:db8:0:0:0:0:2:1")).toBe("ipv6");
    expect(personalShapeOf(jwt)).toBe("jwt");
    expect(personalShapeOf(["Bearer ", "abcdefghijkl"].join(""))).toBe("bearer");
    expect(personalShapeOf(urlWithQuery)).toBe("url-query");
    expect(personalShapeOf(`acct ${digits}`)).toBe("digits");
    for (const fine of [
      "org_01hzx",
      "P1D",
      "ops/reset/20261121T120000Z.json",
      "key_revoked:3",
      "2027-05-20",
      "12345678",
    ]) {
      expect(personalShapeOf(fine), fine).toBeUndefined();
    }
  });

  it("looks at every string at any depth and names the field, never the value", () => {
    try {
      assertNoPersonalShapes({ a: ["fine", { b: "ada@example.com" }] });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AuditMetadataError);
      expect((error as AuditMetadataError).field).toBe("metadata.a[1].b");
      expect(String(error)).not.toContain("ada@");
    }
  });
});

describe("recordAudit before any SQL", () => {
  it("refuses metadata holding a personal or secret shape, and writes nothing", async () => {
    for (const olderThan of ["ada@example.com", "192.0.2.1", jwt, urlWithQuery, digits]) {
      const { tx, queries } = fakeTx();
      await expect(
        recordAudit(tx, { ...sweep, metadata: { deleted: 1, olderThan } as never }),
      ).rejects.toBeInstanceOf(AuditMetadataError);
      expect(queries).toEqual([]);
    }
  });

  it("refuses a target or ref holding a personal shape", async () => {
    const { tx, queries } = fakeTx();
    await expect(recordAudit(tx, { ...sweep, target: "ada@example.com" })).rejects.toBeInstanceOf(
      AuditMetadataError,
    );
    await expect(recordAudit(tx, { ...sweep, refs: ["192.0.2.1"] })).rejects.toBeInstanceOf(
      AuditMetadataError,
    );
    expect(queries).toEqual([]);
  });

  it("refuses an actor kind the event does not allow", async () => {
    const { tx, queries } = fakeTx();
    await expect(
      recordAudit(tx, { ...sweep, actor: { kind: "staff", id: "stf_x", via: "admin" } }),
    ).rejects.toBeInstanceOf(AuditEventError);
    expect(queries).toEqual([]);
  });

  it("refuses metadata the event's strict schema does not accept", async () => {
    const { tx } = fakeTx();
    await expect(
      recordAudit(tx, { ...sweep, metadata: { deleted: 1, olderThan: "P1D", note: "x" } as never }),
    ).rejects.toBeInstanceOf(AuditMetadataError);
    await expect(
      recordAudit(tx, { ...sweep, metadata: { deleted: 0, olderThan: "P1D" } }),
    ).rejects.toBeInstanceOf(AuditMetadataError);
    await expect(
      recordAudit(tx, { ...sweep, event: "test.nothing" } as never),
    ).rejects.toBeInstanceOf(AuditEventError);
  });
});

describe("recordAudit's write", () => {
  it("hands audit.record() the event with the unit's ID, release and request ID", async () => {
    const { tx, queries } = fakeTx();
    const id = await recordAudit(tx, { ...sweep, refs: ["job_x"] });
    expect(id).toMatch(/^aud_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toBe("SELECT audit.record($1::jsonb)");
    expect(JSON.parse(String(queries[0]?.values?.[0]))).toEqual({
      id,
      event: "system.sweep_completed",
      actor_kind: "system",
      actor_id: null,
      actor_via: "job",
      target_id: "ops.rate_window",
      ref_ids: ["job_x"],
      metadata: { deleted: 3, olderThan: "P1D" },
      release: "rel-1",
      request_id: "req_0000000000000000000000000a",
    });
  });

  it("writes the journal entry the event declares, naming only the entry and the event", async () => {
    const { tx, queries } = fakeTx();
    const id = await recordAudit(tx, {
      event: "switch.tripped",
      actor: { kind: "system", id: null, via: "reconciliation" },
      target: "live_money",
      metadata: { reasonCode: "orphan_payout", ref: null },
    });
    expect(queries.map((q) => q.text)).toEqual([
      "SELECT audit.record($1::jsonb)",
      "SELECT audit.record_journal($1::jsonb)",
    ]);
    // The kind, organisation and subjects are the database's to take from the event (§3.10).
    const journal = JSON.parse(String(queries[1]?.values?.[0]));
    expect(Object.keys(journal).sort()).toEqual(["audit_event_id", "id"]);
    expect(journal.audit_event_id).toBe(id);
    expect(journal.id).toMatch(/^jrn_/);
  });

  it("turns an FA refusal into audit.write_failed and AuditWriteError, and passes other errors through", async () => {
    const failing = fakeTx({ code: "FA002", on: "audit.record(" });
    await expect(recordAudit(failing.tx, sweep)).rejects.toBeInstanceOf(AuditWriteError);
    // The audit event is `auditEvent`: a field named `event` would collide with the line's own.
    expect(failing.lines).toEqual([
      {
        event: "audit.write_failed",
        level: "error",
        fields: { auditEvent: "system.sweep_completed", sqlstate: "FA002" },
      },
    ]);
    const other = fakeTx({ code: "57014", on: "audit.record(" });
    await expect(recordAudit(other.tx, sweep)).rejects.not.toBeInstanceOf(AuditWriteError);
    expect(other.lines).toEqual([]);
  });

  it("keeps at most 400 characters of a user agent", async () => {
    const { tx, queries } = fakeTx();
    await expect(
      recordAudit(tx, { ...sweep, context: { clientIp: "192.0.2.1", userAgent: "u".repeat(500) } }),
    ).resolves.toBeDefined();
    const payload = JSON.parse(String(queries[0]?.values?.[0]));
    expect(payload.context.user_agent).toHaveLength(400);
    expect(payload.context.client_ip).toBe("192.0.2.1");
  });

  it("cuts a user agent between characters, never inside one, so the JSON stays storable", async () => {
    // 399 ASCII characters and an emoji is 400 characters but 401 UTF-16 units: a cut at 400 units
    // would leave half the emoji, which Postgres's jsonb refuses.
    const emoji = "\u{1F600}";
    for (const [userAgent, kept] of [
      [`${"a".repeat(399)}${emoji}`, `${"a".repeat(399)}${emoji}`],
      [`${"a".repeat(400)}${emoji}`, "a".repeat(400)],
      [`${"a".repeat(399)}${emoji}${emoji}`, `${"a".repeat(399)}${emoji}`],
      ["broken \ud83d agent", "broken � agent"],
    ] as const) {
      expect(storedUserAgent(userAgent)).toBe(kept);
      const { tx, queries } = fakeTx();
      await recordAudit(tx, { ...sweep, context: { clientIp: null, userAgent } });
      // JSON.stringify writes a whole character as itself and half of one as a `\uXXXX` escape.
      const text = String(queries[0]?.values?.[0]);
      expect(text).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
      expect(JSON.parse(text).context.user_agent).toBe(kept);
    }
  });

  it("refuses, before any SQL, a string Postgres could not store: a lone surrogate in any field", async () => {
    expect(() => assertStorableText({ a: ["fine", "\udc00"] }, "event")).toThrow(
      AuditMetadataError,
    );
    for (const input of [
      { ...sweep, target: "ops.rate_window\ud800" },
      { ...sweep, refs: ["job_\udbff"] },
      { ...sweep, actor: { kind: "system" as const, id: "sys\ud83d", via: "job" as const } },
      { ...sweep, context: { clientIp: "192.0.2.1\ud800", userAgent: null } },
    ]) {
      const { tx, queries } = fakeTx();
      await expect(recordAudit(tx, input)).rejects.toBeInstanceOf(AuditMetadataError);
      expect(queries).toEqual([]);
    }
  });
});
