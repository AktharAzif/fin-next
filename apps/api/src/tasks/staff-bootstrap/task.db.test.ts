// T-SAT-39 (spec 02 §10.6, §10.4): staff-bootstrap on Postgres 18, as fin_owner in one transaction,
// as `migrate --task staff-bootstrap` runs it. It makes exactly one pending Admin when there is no
// active one and refuses otherwise unless `reset` names the only active Admin; every change carries
// its events with actor `operator`, `via: operator`; the code itself never reaches the database.
import { createHash } from "node:crypto";
import { syncEventTypes } from "@fin/audit";
import { createIdSource, type Queryable, type UnitTx } from "@fin/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The staff area's test platform (packages/staff, L-SAT-04): P0-E's bootstrap and runner with the
// identity and staff migrations and grants. Read by path: apps/api does not list @fin/staff.
import {
  createStaffPlatform,
  type PlatformClient,
  type StaffPlatform,
} from "../../../../../packages/staff/test/platform.mjs";
import { EXIT_FAILED, EXIT_OK, runMigrateCli } from "../../migrate/main.ts";
import { TaskError } from "../run.ts";
import { staffBootstrap } from "./task.ts";

// The audit event types are exactly those `migrate --migrate` writes: its own registry sync (the
// compiled AUDIT_EVENTS, every area's fragment), never rows registered by hand, so an event the
// image could not record fails here as it would on staging (FA001).
const registry = (q: unknown) => syncEventTypes(q as Queryable, "test-release");

// `migrate --task staff-bootstrap` below finds the task in the real registry and runs it through the
// real runner, as the image does: a refusal is read where the operator reads it, migrate's
// `task.failed` line, never `task_unknown`, and a run that succeeds ends with `task.done`.
//
// Every wait for the cluster-wide lock is in a hook, never in a test. Logging in as fin_owner and
// running migrate's entry point both take that lock (each sets fin_owner's password), and every
// other test file's bootstrap and migrations hold it in turn, so in the full db run the wait is
// seconds to a minute on a loaded machine, while the work itself takes well under a second. The
// hooks allow 120 s for it, as the platform's own does.
//
// fin_owner's CONNECTION LIMIT is 6 for the whole cluster (AUXILIARY_BUDGET in packages/db), shared
// with every other file. This file holds at most two at once: the task tests' one session below
// (only while "staff-bootstrap" runs), or migrate's own run (its owner session and its pool's one),
// never both.
let platform: StaffPlatform;
let su: PlatformClient;
/** The task tests' fin_owner session, held from their describe's start to its end. */
let owner: PlatformClient;

beforeAll(async () => {
  platform = await createStaffPlatform("sat04task", { registry });
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
}

/** What one run of migrate's entry point returned and wrote. */
interface CliRun {
  code: number;
  lines: Record<string, unknown>[];
  raw: string;
}

/**
 * The same runs through `migrate`'s own entry point, as the operator's `pnpm fin task` starts it,
 * one after another under one hold of the cluster-wide lock, in their order. Called only from
 * hooks (above).
 */
async function cli<const T extends readonly Record<string, unknown>[]>(
  on: StaffPlatform,
  ...runs: T
): Promise<{ [K in keyof T]: CliRun }> {
  return on.withLock(async () => {
    const done: CliRun[] = [];
    for (const params of runs) {
      let raw = "";
      const code = await runMigrateCli(
        ["--task", "staff-bootstrap"],
        {
          FIN_ENVIRONMENT: "ci",
          FIN_RELEASE: "test-release",
          FIN_RUN_ID: "run_cli",
          FIN_BOOTSTRAP_DATABASE_URL: on.superuserUrl(),
          FIN_TASK_PARAMS: JSON.stringify(params),
        },
        {
          stdout: (text) => {
            raw += text;
          },
          clock: { now: () => Date.now() },
        },
      );
      const lines = raw
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      done.push({ code, lines, raw });
    }
    return done as { [K in keyof T]: CliRun };
  });
}

async function seedMember(email: string, roleKey: string, status: "active" | "pending") {
  const id = createIdSource({ now: () => Date.now() }).newId("stf");
  await su.query("BEGIN");
  await su.query("SET LOCAL session_replication_role = replica");
  await su.query(
    `INSERT INTO staff.member (id, email, role_key, status, added_by, factor_enrolled_at)
     VALUES ($1, $2, $3, $4, 'operator', CASE WHEN $4 = 'active' THEN now() END)`,
    [id, email, roleKey, status],
  );
  await su.query("COMMIT");
  return id;
}

async function liveCodes(staffId: string) {
  const result = await su.query<{ code_hash: Buffer }>(
    "SELECT code_hash FROM staff.enrolment_code WHERE member_id = $1 AND voided_at IS NULL AND redeemed_at IS NULL",
    [staffId],
  );
  return result.rows.map((r) => r.code_hash.toString("hex"));
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
  beforeAll(async () => {
    owner = await platform.owner();
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
  });

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
    ).rejects.toBeInstanceOf(TaskError);
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

  it("reissues a pending Admin's code while a second Admin is pending too, and adds no Admin", async () => {
    // §10.4's recovery: the only active Admin added another Admin, who has not enrolled yet, then
    // lost every factor. The reset leaves two pending Admins and no active one, and its code is
    // lost or runs out: the run must still reissue a code to either of them.
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query(
      "UPDATE staff.member SET status = 'active', factor_enrolled_at = now() WHERE email = 'first.admin@example.com'",
    );
    await su.query("COMMIT");
    const added = await seedMember("added.admin@example.com", "admin", "pending");
    const reset = await run({
      address: "first.admin@example.com",
      codeHash: codeHash("FGHJ-KMNP-QRST-VWXY"),
      reset: true,
      reasonCode: "lost_factors",
    });
    const first = String(reset.ids?.staffId);
    await su.query("BEGIN");
    await su.query("SET LOCAL session_replication_role = replica");
    await su.query(
      `UPDATE staff.enrolment_code SET issued_at = now() - interval '40 minutes',
              expires_at = now() - interval '10 minutes'
        WHERE member_id = $1 AND voided_at IS NULL AND redeemed_at IS NULL`,
      [first],
    );
    await su.query("COMMIT");
    const again = await run({
      address: "first.admin@example.com",
      codeHash: codeHash("GHJK-MNPQ-RSTV-WXYZ"),
      reasonCode: "lost_factors",
    });
    expect(again.ids?.staffId).toBe(first);
    expect(await liveCodes(first)).toEqual([codeHash("GHJK-MNPQ-RSTV-WXYZ")]);
    const other = await run({
      address: "added.admin@example.com",
      codeHash: codeHash("HJKM-NPQR-STVW-XYZ0"),
      reasonCode: "first_admin",
    });
    expect(other.ids?.staffId).toBe(added);
    expect(await liveCodes(added)).toEqual([codeHash("HJKM-NPQR-STVW-XYZ0")]);
    // Still never a third Admin while one is pending.
    await expect(
      run({
        address: "third.admin@example.com",
        codeHash: codeHash("JKMN-PQRS-TVWX-YZ01"),
        reasonCode: "first_admin",
      }),
    ).rejects.toMatchObject({ code: "pending_admin_exists" });
    const admins = await su.query<{ email: string; status: string }>(
      "SELECT email, status FROM staff.member WHERE role_key = 'admin' AND status <> 'removed' ORDER BY email",
    );
    expect(admins.rows).toEqual([
      { email: "added.admin@example.com", status: "pending" },
      { email: "first.admin@example.com", status: "pending" },
    ]);
  });

  it("is fin_owner's alone: no service login may run it", async () => {
    const result = await su.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.routine_privileges
        WHERE routine_schema = 'staff' AND routine_name = 'bootstrap_admin' AND privilege_type = 'EXECUTE'`,
    );
    expect(result.rows.map((r) => r.grantee)).toEqual(["fin_owner"]);
  });
});

describe("migrate --task staff-bootstrap while Admins are active", () => {
  // Two active Admins, seeded here (the task tests above have closed their fin_owner session): a
  // run is refused while an Admin is active, and a reset of one while another can reset them.
  let refused: CliRun;
  let reset: CliRun;

  beforeAll(async () => {
    await seedActive("refusal.first@example.com", "admin");
    await seedActive("refusal.second@example.com", "admin");
    [refused, reset] = await cli(
      platform,
      {
        address: "other@example.com",
        codeHash: codeHash("DEFG-HJKM-NPQR-STVW"),
        reasonCode: "first_admin",
      },
      {
        address: "refusal.first@example.com",
        codeHash: codeHash("DEFG-HJKM-NPQR-STVW"),
        reset: true,
        reasonCode: "lost_factors",
      },
    );
  }, 120_000);

  it("names the refusal in migrate's task.failed line, where the operator reads it", () => {
    const { code, lines, raw } = refused;
    expect(code).toBe(EXIT_FAILED);
    expect(lines.at(-1)).toMatchObject({
      event: "task.failed",
      task: "staff-bootstrap",
      code: "active_admin_exists",
    });
    expect(raw).not.toContain("other@example.com");
    expect(reset.lines.at(-1)).toMatchObject({
      event: "task.failed",
      code: "another_admin_can_reset",
    });
  });
});

describe("migrate --task staff-bootstrap on a new environment", () => {
  // Its own database with no Admin yet, so the run must succeed end to end: the registry, the
  // runner, the task, the runner's own `operator.task_completed`, and the commit.
  const hash = codeHash("KMNP-QRST-VWXY-Z012");
  let fresh: StaffPlatform;
  let freshSu: PlatformClient;
  let made: CliRun;

  beforeAll(async () => {
    fresh = await createStaffPlatform("sat04cli", { registry });
    freshSu = await fresh.superuser();
  }, 120_000);

  // A hook of its own, so the run's wait for the lock has the whole allowance.
  beforeAll(async () => {
    [made] = await cli(fresh, {
      address: "Cli.Admin@Example.com",
      codeHash: hash,
      reasonCode: "first_admin",
    });
  }, 120_000);

  afterAll(async () => {
    await freshSu?.end();
    await fresh?.drop();
  });

  it("makes the first Admin, records it as the operator and says so with IDs only", async () => {
    const { code, lines, raw } = made;
    expect(lines.filter((l) => l.event === "audit.write_failed")).toEqual([]);
    expect(code).toBe(EXIT_OK);
    const done = lines.at(-1);
    expect(done).toMatchObject({
      event: "task.done",
      task: "staff-bootstrap",
      rowsChanged: 2,
      reset: 0,
      reactivated: 0,
    });
    const staffId = String(done?.staffId);
    const codeId = String(done?.enrolmentCodeId);
    expect(staffId).toMatch(/^stf_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(codeId).toMatch(/^enc_[0-9a-hjkmnp-tv-z]{26}$/);
    // Neither the address nor the code's hash reaches the output, in any case.
    expect(raw.toLowerCase()).not.toContain("cli.admin@example.com");
    expect(raw.toLowerCase()).not.toContain(hash);

    const member = await freshSu.query<{ id: string; email: string; status: string }>(
      "SELECT id, email, status FROM staff.member WHERE role_key = 'admin'",
    );
    expect(member.rows).toEqual([
      { id: staffId, email: "cli.admin@example.com", status: "pending" },
    ]);
    const events = await freshSu.query<{
      event: string;
      target_id: string;
      actor_kind: string;
      actor_id: string;
      actor_via: string;
      db_login: string;
    }>(
      "SELECT event, target_id, actor_kind, actor_id, actor_via, db_login FROM audit.event ORDER BY event",
    );
    expect(events.rows.map((e) => [e.event, e.target_id])).toEqual([
      ["operator.task_completed", "staff-bootstrap"],
      ["staff.bootstrapped", staffId],
      ["staff.enrolment_code_issued", codeId],
      ["staff.member_added", staffId],
    ]);
    for (const event of events.rows) {
      expect(event).toMatchObject({
        actor_kind: "operator",
        actor_id: "run_cli",
        actor_via: "operator",
        db_login: "fin_owner",
      });
    }
  });
});
