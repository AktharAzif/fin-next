// T-SAT-20 and T-SAT-26's staff halves (spec 02 §13.7, §13.8): what each service's own login may do
// on the staff objects (anything else fails with 42501), and the guards on staff roles refuse a
// commit without its event.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaffHarness, DROP_TIMEOUT_MS, type StaffHarness, unique } from "../test/harness.ts";

let h: StaffHarness;
let admin: Pool;
let worker: Pool;
let api: Pool;

beforeAll(async () => {
  h = await createStaffHarness("sat04grants");
  admin = h.login("fin_admin_a", 2);
  worker = h.login("fin_worker_a", 2);
  api = h.login("fin_api_a", 2);
  await h.seedMember(unique("listed"), "viewer", "pending");
  await h.seedMember(unique("gone"), "viewer", "removed");
}, 120_000);

afterAll(async () => {
  await h?.close();
}, DROP_TIMEOUT_MS);

const refused = (run: Promise<unknown>) => expect(run).rejects.toMatchObject({ code: "42501" });

describe("the staff grants", () => {
  it("never let a service run the bootstrap", async () => {
    for (const pool of [admin, worker, api]) {
      await refused(
        pool.query(
          "SELECT staff.bootstrap_admin('a@example.com', '\\x00'::bytea, false, 'x', 'r', 'r', '{}'::jsonb)",
        ),
      );
    }
  });

  it("give the worker the drift check's view and nothing else of staff", async () => {
    const view = await worker.query<{ email: string }>("SELECT email FROM staff.access_list_view");
    expect(view.rows.every((r) => !r.email.startsWith("gone."))).toBe(true);
    expect(view.rows.some((r) => r.email.startsWith("listed."))).toBe(true);
    await refused(worker.query("SELECT 1 FROM staff.member"));
    await refused(worker.query("SELECT 1 FROM staff.role"));
    await refused(worker.query("SELECT 1 FROM staff.change_lock"));
  });

  it("give api the views of §13.6 and no table", async () => {
    await api.query("SELECT role_id, permission FROM staff.role_permission_view");
    await api.query("SELECT id, email, role_key, status FROM staff.member_view");
    await refused(api.query("SELECT 1 FROM staff.member"));
    await refused(api.query("SELECT 1 FROM staff.access_list_view"));
    await refused(api.query("SELECT 1 FROM staff.change_lock"));
  });

  it("let Fin Admin take the change lock but never remove or add its row", async () => {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT 1 FROM staff.change_lock WHERE id = 1 FOR UPDATE");
      expect(locked.rowCount).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await refused(admin.query("DELETE FROM staff.change_lock"));
    await refused(admin.query("INSERT INTO staff.change_lock (id) VALUES (1)"));
    await refused(admin.query("SELECT 1 FROM audit.event"));
  });

  it("show the operator's read-only login no code hash", async () => {
    const readonly = await h.admin.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.column_privileges
        WHERE grantee = 'fin_readonly' AND table_schema = 'staff' AND table_name = 'enrolment_code'
          AND column_name = 'code_hash'`,
    );
    expect(readonly.rows).toEqual([]);
  });
});

describe("the guards on staff roles (§13.8)", () => {
  it("refuse a role or a role permission written without its event", async () => {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO staff.role (id, name, created_by) VALUES ('srl_01jd0000000000000000000000', 'Readers', 'stf_01jd0000000000000000000000')",
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "FA010" });
      await client.query("BEGIN");
      const id = await h.seedCustomRole("Seeded", ["staff.read"]);
      await client.query("DELETE FROM staff.role_permission WHERE role_id = $1", [id]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "FA010" });
    } finally {
      client.release();
    }
    const kept = await h.admin.query("SELECT 1 FROM staff.role_permission");
    expect(kept.rowCount).toBe(1);
  });
});
