// T-SAT-39 (spec 02 §10.6, §10.4): staff-bootstrap on Postgres 18, as fin_owner in one transaction,
// as `migrate --task staff-bootstrap` runs it. It makes exactly one pending Admin when there is no
// active one and refuses otherwise unless `reset` names the only active Admin; every change carries
// its events with actor `operator`, `via: operator`; the code itself never reaches the database.
import { createHash } from "node:crypto";
import { createIdSource, type UnitTx } from "@fin/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The staff area's test platform (packages/staff, L-SAT-04): P0-E's bootstrap and runner with the
// identity and staff migrations and grants. Read by path: apps/api does not list @fin/staff.
import {
  createStaffPlatform,
  type PlatformClient,
  type StaffPlatform,
} from "../../../../../packages/staff/test/platform.mjs";
import { StaffBootstrapRefused, staffBootstrap } from "./task.ts";

let platform: StaffPlatform;
let su: PlatformClient;

beforeAll(async () => {
  platform = await createStaffPlatform("sat04task");
  su = await platform.superuser();
}, 120_000);

afterAll(async () => {
  await su?.end();
  await platform?.drop();
});

const codeHash = (code: string) =>
  createHash("sha256").update(code.replace(/-/g, "").toUpperCase(), "utf8").digest("hex");

/** One task run: fin_owner, one transaction, committed only when the task returns. */
async function run(params: Record<string, unknown>, runId = `run_${Date.now()}`) {
  const owner = await platform.owner();
  try {
    await owner.query("BEGIN");
    const tx = {
      ids: createIdSource({ now: () => Date.now() }),
      query: (text: string, values?: readonly unknown[]) => owner.query(text, values),
    } as unknown as UnitTx;
    try {
      const result = await staffBootstrap.run(tx, staffBootstrap.params.parse(params), {
        runId,
        release: "test-release",
        environment: "ci",
      });
      await owner.query("COMMIT");
      return result;
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  } finally {
    await owner.end();
  }
}

async function seedActive(email: string, roleKey: string): Promise<string> {
  const id = createIdSource({ now: () => Date.now() }).newId("stf");
  await su.query("BEGIN");
  await su.query("SET LOCAL session_replication_role = replica");
  await su.query(
    `INSERT INTO staff.member (id, email, role_key, status, added_by, factor_enrolled_at)
     VALUES ($1, $2, $3, 'active', 'operator', now())`,
    [id, email, roleKey],
  );
  await su.query("COMMIT");
  return id;
}

async function eventsFor(target: string) {
  const result = await su.query<{
    event: string;
    actor_kind: string;
    actor_id: string;
    actor_via: string;
    metadata: Record<string, unknown>;
    db_login: string;
  }>(
    `SELECT event, actor_kind, actor_id, actor_via, metadata, db_login FROM audit.event
      WHERE target_id = $1 OR $1 = ANY (ref_ids) ORDER BY recorded_at, id`,
    [target],
  );
  return result.rows;
}

describe("staff-bootstrap", () => {
  it("makes the first Admin pending, with one live code, and records it as the operator", async () => {
    const result = await run(
      {
        address: "First.Admin@Example.com",
        codeHash: codeHash("ABCD-EFGH-JKMN-PQRS"),
        reasonCode: "first_admin",
      },
      "run_first",
    );
    const staffId = String(result.ids?.staffId);
    const member = await su.query<{
      email: string;
      role_key: string;
      status: string;
      added_by: string;
    }>("SELECT email, role_key, status, added_by FROM staff.member WHERE id = $1", [staffId]);
    expect(member.rows[0]).toEqual({
      email: "first.admin@example.com",
      role_key: "admin",
      status: "pending",
      added_by: "operator",
    });
    const codes = await su.query<{ code_hash: Buffer; reason: string; issued_by: string }>(
      "SELECT code_hash, reason, issued_by FROM staff.enrolment_code WHERE member_id = $1 AND voided_at IS NULL",
      [staffId],
    );
    expect(codes.rows).toHaveLength(1);
    expect(codes.rows[0]?.code_hash.toString("hex")).toBe(codeHash("ABCD-EFGH-JKMN-PQRS"));
    expect(codes.rows[0]).toMatchObject({ reason: "bootstrap", issued_by: "operator" });
    // One statement records all three, so they share its time: compared as a set.
    const events = await eventsFor(staffId);
    expect(events.map((e) => e.event).sort()).toEqual([
      "staff.bootstrapped",
      "staff.enrolment_code_issued",
      "staff.member_added",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_kind: "operator",
        actor_id: "run_first",
        actor_via: "operator",
        db_login: "fin_owner",
      });
    }
    const metadata = (name: string) => events.find((e) => e.event === name)?.metadata;
    expect(metadata("staff.member_added")).toEqual({ roleKey: "admin", reactivated: false });
    expect(metadata("staff.bootstrapped")).toEqual({ reset: false, reasonCode: "first_admin" });
    expect(metadata("staff.enrolment_code_issued")).toEqual({ reason: "bootstrap" });
    // Running it again for the same address while they are pending issues a new code, once.
    const again = await run({
      address: "first.admin@example.com",
      codeHash: codeHash("BCDE-FGHJ-KMNP-QRST"),
      reasonCode: "first_admin",
    });
    expect(again.ids?.staffId).toBe(staffId);
    const live = await su.query(
      "SELECT 1 FROM staff.enrolment_code WHERE member_id = $1 AND voided_at IS NULL AND redeemed_at IS NULL",
      [staffId],
    );
    expect(live.rowCount).toBe(1);
    // Another address while that Admin is pending: refused, nothing written.
    await expect(
      run({
        address: "second.admin@example.com",
        codeHash: codeHash("CDEF-GHJK-MNPQ-RSTV"),
        reasonCode: "first_admin",
      }),
    ).rejects.toMatchObject({ code: "pending_admin_exists" });
    const second = await su.query(
      "SELECT 1 FROM staff.member WHERE email = 'second.admin@example.com'",
    );
    expect(second.rowCount).toBe(0);
  });

  it("refuses while an active Admin exists, and refuses a reset of anyone but the only one", async () => {
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query(
      "UPDATE staff.member SET status = 'active', factor_enrolled_at = now() WHERE email = 'first.admin@example.com'",
    );
    await su.query("COMMIT");
    const before = await su.query("SELECT count(*)::integer AS n FROM audit.event");
    await expect(
      run({
        address: "other@example.com",
        codeHash: codeHash("DEFG-HJKM-NPQR-STVW"),
        reasonCode: "first_admin",
      }),
    ).rejects.toBeInstanceOf(StaffBootstrapRefused);
    await expect(
      run({
        address: "nobody@example.com",
        codeHash: codeHash("DEFG-HJKM-NPQR-STVW"),
        reset: true,
        reasonCode: "lost_factors",
      }),
    ).rejects.toMatchObject({ code: "reset_needs_active_admin" });
    const viewer = await seedActive("a.viewer@example.com", "viewer");
    await expect(
      run({
        address: "a.viewer@example.com",
        codeHash: codeHash("DEFG-HJKM-NPQR-STVW"),
        reset: true,
        reasonCode: "lost_factors",
      }),
    ).rejects.toMatchObject({ code: "reset_needs_active_admin" });
    await seedActive("second.active@example.com", "admin");
    await expect(
      run({
        address: "first.admin@example.com",
        codeHash: codeHash("DEFG-HJKM-NPQR-STVW"),
        reset: true,
        reasonCode: "lost_factors",
      }),
    ).rejects.toMatchObject({ code: "another_admin_can_reset" });
    const after = await su.query("SELECT count(*)::integer AS n FROM audit.event");
    expect(after.rows).toEqual(before.rows);
    expect(viewer).toMatch(/^stf_/);
  });

  it("resets the last Admin who lost every factor, with the reset's events and journal entry", async () => {
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query(
      "UPDATE staff.member SET status = 'removed', removed_at = now() WHERE email = 'second.active@example.com'",
    );
    await su.query("COMMIT");
    const result = await run(
      {
        address: "first.admin@example.com",
        codeHash: codeHash("EFGH-JKMN-PQRS-TVWX"),
        reset: true,
        reasonCode: "lost_factors",
      },
      "run_reset",
    );
    const staffId = String(result.ids?.staffId);
    const member = await su.query<{ status: string; factor_enrolled_at: Date | null }>(
      "SELECT status, factor_enrolled_at FROM staff.member WHERE id = $1",
      [staffId],
    );
    expect(member.rows[0]).toEqual({ status: "pending", factor_enrolled_at: null });
    const events = (await eventsFor(staffId)).filter((e) => e.actor_id === "run_reset");
    expect(events.map((e) => e.event).sort()).toEqual([
      "staff.bootstrapped",
      "staff.enrolment_code_issued",
      "staff.factors_reset",
    ]);
    expect(events.find((e) => e.event === "staff.bootstrapped")?.metadata).toEqual({
      reset: true,
      reasonCode: "lost_factors",
    });
    const journal = await su.query<{ kind: string }>(
      "SELECT j.kind FROM audit.journal_entry j JOIN audit.event e ON e.id = j.audit_event_id WHERE e.target_id = $1",
      [staffId],
    );
    expect(journal.rows.map((r) => r.kind)).toEqual(["staff_factors_reset"]);
  });

  it("is fin_owner's alone: no service login may run it", async () => {
    const result = await su.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.routine_privileges
        WHERE routine_schema = 'staff' AND routine_name = 'bootstrap_admin' AND privilege_type = 'EXECUTE'`,
    );
    expect(result.rows.map((r) => r.grantee)).toEqual(["fin_owner"]);
  });
});
