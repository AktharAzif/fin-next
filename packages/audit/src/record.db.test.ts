// recordAudit and the registry against Postgres 18 (spec 08 §3.15): T08-02 (the synced table equals
// the compiled index), T08-04 (each login records exactly its events, generated per event), T08-13 (a
// declared journal entry is written in the same transaction, and a rollback leaves neither), the stamp
// test, the failure line, and the money trip.
import {
  AuditGuardError,
  type FinDatabase,
  isSwitchOn,
  type PgClient,
  type ServiceGroup,
  type UnitTx,
} from "@fin/db";
import { collectLines, createTestDatabase, type TestDatabase, testContext } from "@fin/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActorKind, ActorVia, AuditRole } from "./define.ts";
import { AUDIT_EVENT_AREAS, AUDIT_EVENTS, type AuditEventName } from "./events/_index.gen.ts";
import type { events as PLATFORM_EVENTS } from "./events/platform.ts";
import { AuditWriteError, type RecordInput, recordAudit } from "./record.ts";
import { tripSwitch } from "./switches.ts";
import { eventTypeRows, syncEventTypes } from "./sync.ts";

// The integration timeouts, which the root Vitest configuration leaves to each file: a file's
// database is made under the cluster-wide lock that other files' bootstraps may hold.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let db: TestDatabase;
let su: PgClient;
let owner: FinDatabase;
// One pool per login for the whole file: a pool per attempt would hold idle connections against the
// logins' cluster-wide CONNECTION LIMIT while the other packages' tests use the same logins.
const databases = new Map<AuditRole, FinDatabase>();

beforeAll(async () => {
  db = await createTestDatabase({
    prefix: "p0e",
    after: (q) => syncEventTypes(q, "test-release").then(() => {}),
  });
  su = await db.superuser();
  owner = await db.ownerDatabase();
  databases.set("fin_owner", owner);
  for (const group of GROUPS) databases.set(group, db.database(group));
});

afterAll(async () => {
  await su?.end();
  await db?.drop();
});

type PlatformEventName = keyof typeof PLATFORM_EVENTS;

// One valid input per platform event: the per-event tests below are generated from AUDIT_EVENTS, and a
// new platform event without a sample here fails the coverage test. The other areas' events (each
// area's package records its own, in its fragment's shape) are tried at audit.record() itself.
const SAMPLES: { [E in PlatformEventName]: Omit<RecordInput<E>, "event"> } = {
  "switch.tripped": {
    actor: { kind: "system", id: null, via: "reconciliation" },
    target: "live_money",
    metadata: { reasonCode: "orphan_payout", ref: null },
  },
  "audit.epoch_started": {
    actor: { kind: "operator", id: "run_test", via: "operator" },
    target: "epoch:2",
    metadata: {
      reason: "reset",
      previousEpoch: 1,
      previousSeq: 10,
      markerKey: "ops/reset/20261121T120000Z.json",
    },
  },
  "audit.restore_replayed": {
    actor: { kind: "operator", id: "run_test", via: "operator" },
    target: "ops/restore/20261121T120000Z.json",
    metadata: { automatic: ["key_revoked:2"], confirmed: [], skipped: ["role_lowered:1"] },
  },
  "audit.failover_recorded": {
    actor: { kind: "operator", id: "run_test", via: "operator" },
    target: "epoch:2",
    metadata: {
      lastAnchoredSeq: 100,
      newTimeline: 2,
      markerKey: "ops/failover/20261121T120000Z.json",
    },
  },
  "operator.task_completed": {
    actor: { kind: "operator", id: "run_test", via: "operator" },
    target: "audit-note",
    metadata: { task: "audit-note", rowsChanged: 1, release: "test-release" },
  },
  "operator.credential_rotated": {
    actor: { kind: "operator", id: "run_test", via: "operator" },
    target: "seal-key",
    metadata: {
      family: "seal-key",
      version: 2,
      services: ["api", "worker"],
      overlapEnds: "2026-12-01",
    },
  },
  "operator.escrow_opened": {
    actor: { kind: "operator", id: "run_test", via: "operator" },
    target: "seal-key",
    metadata: { family: "seal-key", version: 1, incidentRef: "inc-1" },
  },
  "system.sweep_completed": {
    actor: { kind: "system", id: null, via: "job" },
    target: "ops.rate_window",
    metadata: { deleted: 5, olderThan: "P1D" },
  },
};

const GROUPS: readonly ServiceGroup[] = [
  "fin_edge",
  "fin_api",
  "fin_worker",
  "fin_payments",
  "fin_console",
  "fin_admin",
];

function databaseFor(role: AuditRole): FinDatabase {
  const database = databases.get(role);
  if (database === undefined) throw new Error(`no pool for ${role}`);
  return database;
}

class Rollback extends Error {}

/** The `via` each actor kind records with, for the inputs built below. */
const VIA: Readonly<Record<ActorKind, ActorVia>> = {
  user: "console",
  api_key: "api",
  staff: "admin",
  customer_link: "hosted_pages",
  person_link: "hosted_pages",
  system: "job",
  provider: "webhook",
  operator: "operator",
};

/**
 * audit.record()'s input for another area's event, as that area's package sends it: the event's
 * first actor kind, a target of its prefix, its scope's fields and empty metadata (the database
 * checks the metadata's shape; the area's own recorder checks its schema before it calls).
 */
function areaInput(tx: UnitTx, event: AuditEventName): Record<string, unknown> {
  const spec = AUDIT_EVENTS[event];
  const kind: ActorKind = spec.actors[0] ?? "system";
  const someId = (prefix: string) => `${prefix}_01jd0000000000000000000000`;
  return {
    id: tx.ids.newId("aud"),
    event,
    actor_kind: kind,
    actor_id: kind === "system" ? null : "act_test",
    actor_via: VIA[kind],
    target_id: /^[a-z]{3}$/.test(spec.target) ? someId(spec.target) : spec.target,
    metadata: {},
    release: tx.context.release,
    ...(spec.scope === "organisation" ? { organization_id: someId("org") } : {}),
    ...(spec.scope === "person" ? { subject_user_id: someId("usr") } : {}),
  };
}

/** Records the event in a unit that is then rolled back; resolves "ok" or the refusal's code. */
async function attempt(role: AuditRole, event: AuditEventName): Promise<string> {
  const database = databaseFor(role);
  try {
    await database.unit(testContext(), async (tx) => {
      if (Object.hasOwn(SAMPLES, event)) {
        const platform = event as PlatformEventName;
        await recordAudit(tx, { event: platform, ...SAMPLES[platform] } as RecordInput<
          typeof platform
        >);
      } else {
        await tx.query("SELECT audit.record($1::jsonb)", [JSON.stringify(areaInput(tx, event))]);
      }
      throw new Rollback();
    });
    return "committed";
  } catch (error) {
    if (error instanceof Rollback) return "ok";
    if (error instanceof AuditWriteError) return error.sqlstate;
    return (error as { code?: string }).code ?? String(error);
  }
}

describe("T08-02: the registry in the database", () => {
  it("equals the compiled AUDIT_EVENTS after migrating a fresh database", async () => {
    // Byte order on both sides (eventTypeRows sorts by code unit): the cluster's default collation
    // depends on the host, and CI's image (en_US.utf8) would order some names the other way round.
    const rows = await su.query(
      'SELECT name, area, category, scope, roles, journal_kind, retired FROM audit.event_type ORDER BY name COLLATE "C"',
    );
    expect(rows.rows).toEqual(eventTypeRows());
    // The journal kind an event declares is the registry's, synced with it (§3.10).
    expect(
      (await su.query("SELECT journal_kind FROM audit.event_type WHERE name = 'switch.tripped'"))
        .rows,
    ).toEqual([{ journal_kind: "switch_set" }]);
  });

  it("changes nothing on a second sync, and never deletes a row it does not know", async () => {
    await su.query(
      "INSERT INTO audit.event_type (name, area, category, scope, roles, synced_release) VALUES ('legacy.thing', 'old', 'system', 'staff', '{fin_owner}', 'old')",
    );
    const result = await owner.unit(testContext(), (tx) => syncEventTypes(tx, "another-release"));
    expect(result).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: Object.keys(AUDIT_EVENTS).length,
    });
    const releases = await su.query(
      "SELECT DISTINCT synced_release FROM audit.event_type WHERE area = 'platform'",
    );
    expect(releases.rows).toEqual([{ synced_release: "test-release" }]);
    expect(
      (
        await su.query(
          "SELECT count(*)::int AS n FROM audit.event_type WHERE name = 'legacy.thing'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
});

describe("T08-04: each login records exactly the events whose roles name its group", () => {
  it("has a sample for every platform event", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      Object.keys(AUDIT_EVENTS)
        .filter((name) => AUDIT_EVENT_AREAS[name as AuditEventName] === "platform")
        .sort(),
    );
  });

  for (const event of Object.keys(AUDIT_EVENTS) as AuditEventName[]) {
    const allowed: readonly string[] = AUDIT_EVENTS[event].roles;
    it(`${event} is recorded by ${allowed.join(", ")} and refused to every other role`, async () => {
      const outcomes: Record<string, string> = {};
      for (const role of [...GROUPS, "fin_owner"] as AuditRole[])
        outcomes[role] = await attempt(role, event);
      for (const [role, outcome] of Object.entries(outcomes)) {
        if (allowed.includes(role)) expect(outcome, role).toBe("ok");
        // Roles without EXECUTE on audit.record() are refused by the grant (42501), the rest by the
        // per-role registry (FA002).
        else expect(["FA002", "42501"], `${role}: ${outcome}`).toContain(outcome);
      }
    });
  }
});

describe("what recordAudit writes", () => {
  it("names the login that wrote the row, and the unit's release and request ID", async () => {
    const worker = db.database("fin_worker");
    const id = await worker.unit(testContext({ requestId: "req_test", release: "rel-xyz" }), (tx) =>
      recordAudit(tx, { event: "system.sweep_completed", ...SAMPLES["system.sweep_completed"] }),
    );
    const row = await su.query(
      "SELECT db_login, release, request_id, actor_kind, target_id FROM audit.event WHERE id = $1",
      [id],
    );
    expect(row.rows).toEqual([
      {
        db_login: "fin_worker_a",
        release: "rel-xyz",
        request_id: "req_test",
        actor_kind: "system",
        target_id: "ops.rate_window",
      },
    ]);
  });

  it("stores whatever user agent a client sends: one cut inside a character, or holding a U+0000, is not refused by Postgres", async () => {
    const worker = db.database("fin_worker");
    for (const userAgent of [`${"a".repeat(399)}\u{1F600}\u{1F600}`, "agent\u0000/1.0"]) {
      const id = await worker.unit(testContext(), (tx) =>
        recordAudit(tx, {
          event: "system.sweep_completed",
          ...SAMPLES["system.sweep_completed"],
          context: { clientIp: null, userAgent },
        }),
      );
      expect(
        (await su.query("SELECT count(*)::int AS n FROM audit.event WHERE id = $1", [id])).rows,
      ).toEqual([{ n: 1 }]);
    }
  });

  it("writes audit.write_failed and rolls the action back when the database refuses the event", async () => {
    await su.query(
      "UPDATE audit.event_type SET retired = true WHERE name = 'system.sweep_completed'",
    );
    const lines = collectLines();
    const worker = db.database("fin_worker");
    try {
      await expect(
        worker.unit(testContext({ log: lines }), async (tx) => {
          await tx.query(
            "INSERT INTO ops.duty_state (scheduler, duty) VALUES ('worker', 'sweep-probe')",
          );
          await recordAudit(tx, {
            event: "system.sweep_completed",
            ...SAMPLES["system.sweep_completed"],
          });
        }),
      ).rejects.toBeInstanceOf(AuditWriteError);
      expect(lines.lines).toEqual([
        {
          event: "audit.write_failed",
          fields: { auditEvent: "system.sweep_completed", sqlstate: "FA001" },
        },
      ]);
      expect(
        (await su.query("SELECT count(*)::int AS n FROM ops.duty_state WHERE duty = 'sweep-probe'"))
          .rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await owner.unit(testContext(), (tx) => syncEventTypes(tx, "test-release"));
    }
  });
});

describe("T08-13: the revocation journal", () => {
  it("writes switch.tripped's journal entry in the same transaction", async () => {
    const payments = db.database("fin_payments");
    const id = await payments.unit(testContext(), (tx) =>
      recordAudit(tx, { event: "switch.tripped", ...SAMPLES["switch.tripped"] }),
    );
    const journal = await su.query(
      "SELECT kind, subject_ids FROM audit.journal_entry WHERE audit_event_id = $1",
      [id],
    );
    expect(journal.rows).toEqual([{ kind: "switch_set", subject_ids: ["live_money"] }]);
  });

  it("leaves neither the event nor its journal entry when the action rolls back", async () => {
    const payments = db.database("fin_payments");
    let id = "";
    await expect(
      payments.unit(testContext(), async (tx) => {
        id = await recordAudit(tx, { event: "switch.tripped", ...SAMPLES["switch.tripped"] });
        throw new Error("the action failed");
      }),
    ).rejects.toThrow("the action failed");
    expect(
      (await su.query("SELECT count(*)::int AS n FROM audit.event WHERE id = $1", [id])).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await su.query(
          "SELECT count(*)::int AS n FROM audit.journal_entry WHERE audit_event_id = $1",
          [id],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });
});

describe("tripSwitch (the automatic money trip)", () => {
  it("records switch.tripped as the database wrote it, journals it and writes its line", async () => {
    const lines = collectLines();
    const worker = db.database("fin_worker");
    const id = await worker.unit(testContext({ log: lines }), (tx) =>
      tripSwitch(tx, {
        name: "live_money",
        reasonCode: "reconciliation_break",
        ref: null,
        via: "job",
      }),
    );
    const row = await su.query(
      "SELECT event, db_login, actor_via, metadata FROM audit.event WHERE id = $1",
      [id],
    );
    expect(row.rows).toEqual([
      {
        event: "switch.tripped",
        db_login: "fin_worker_a",
        actor_via: "job",
        metadata: { reasonCode: "reconciliation_break", ref: null },
      },
    ]);
    expect(
      (await su.query("SELECT kind FROM audit.journal_entry WHERE audit_event_id = $1", [id])).rows,
    ).toEqual([{ kind: "switch_set" }]);
    expect(lines.lines).toEqual([
      {
        event: "switch.tripped",
        fields: { switch: "live_money", reasonCode: "reconciliation_break" },
      },
    ]);
    expect(await owner.read(testContext(), (q) => isSwitchOn(q, "live_money"))).toBe(true);
  });

  it("is refused by the guard when the switch changes without an event: a direct UPDATE by the owner", async () => {
    await expect(
      owner.unit(testContext(), (tx) =>
        tx.query("UPDATE ops.kill_switch SET state = 'off' WHERE name = 'live_money'"),
      ),
    ).rejects.toBeInstanceOf(AuditGuardError);
  });
});
