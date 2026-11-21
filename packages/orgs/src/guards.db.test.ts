// The organisation tables' audit guards (spec 02 §13.8; T-SAT-26 for this area, AC-SAT-11): the
// installed triggers are exactly the registrations, and each guarded change without its event is
// refused at commit (FA010), as the console's own login and as the table's owner; with its event,
// it commits; an organisation's deletion commits by its bulk path.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import { createHarness, type Harness, ownerWithOrganization, person } from "../test/harness.ts";
import { ORGS_GUARDS } from "./guards.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("guards");
  h = await createHarness(database);
});

afterAll(async () => {
  await database?.drop();
});

/** The trigger name audit.install_guard gives a registration's operation. */
function triggerName(op: string, keyColumn: string, events: readonly string[]): string {
  const hash = createHash("md5")
    .update(`${op}|${keyColumn}|${events.join(",")}`)
    .digest("hex");
  return `audit_guard_${op.split(" ")[0]?.toLowerCase()}_${keyColumn.slice(0, 30)}_${hash.slice(0, 8)}`;
}

async function sqlstateOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return String((error as { code?: string }).code);
  }
}

/** Runs statements in one transaction on a client; the commit is where a guard refuses. */
async function inTransaction(client: PoolClient, statements: readonly [string, unknown[]][]) {
  try {
    await client.query("BEGIN");
    for (const [text, values] of statements) await client.query(text, values);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("the organisation guards", () => {
  it("are installed exactly as registered", async () => {
    const tables = [...new Set(ORGS_GUARDS.map((g) => g.table))];
    const installed = await database.admin.query<{ table_name: string; tgname: string }>(
      `SELECT c.relnamespace::regnamespace::text || '.' || c.relname AS table_name, t.tgname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname LIKE 'audit_guard_%'
          AND c.relnamespace::regnamespace::text || '.' || c.relname = ANY($1::text[])`,
      [tables],
    );
    const expected = ORGS_GUARDS.flatMap((g) =>
      g.ops.map((op) => `${g.table} ${triggerName(op, g.keyColumn, g.events)}`),
    ).sort();
    expect(installed.rows.map((r) => `${r.table_name} ${r.tgname}`).sort()).toEqual(expected);
  });

  it("refuse each guarded change without its event at commit, as the console's login", async () => {
    const { who, orgId, memberId } = await ownerWithOrganization(h, "guarded");
    const spare = await person(h, "spare", { factor: false });
    const roleId = "rol_01jd00000000000000000000g1";
    await seed(
      h.admin,
      "INSERT INTO identity.role (id, organization_id, name, created_by) VALUES ($1, $2, 'Guarded', $3)",
      [roleId, orgId, who.userId],
    );
    await seed(
      h.admin,
      "INSERT INTO identity.role_permission (role_id, permission) VALUES ($1, 'member.read')",
      [roleId],
    );
    const invitationId = "inv_01jd00000000000000000000g1";
    await seed(
      h.admin,
      `INSERT INTO identity.invitation (id, organization_id, email, role_key, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'guard.invitee@example.com', 'admin', decode(repeat('ef', 32), 'hex'), $3, now() + interval '7 days')`,
      [invitationId, orgId, who.userId],
    );
    const cases: [string, [string, unknown[]][]][] = [
      [
        "organization insert",
        [
          [
            "INSERT INTO identity.organization (id, name, created_by) VALUES ('org_01jd00000000000000000000g2', 'Quiet', $1)",
            [who.userId],
          ],
        ],
      ],
      [
        "organization rename",
        [["UPDATE identity.organization SET name = 'Quietly' WHERE id = $1", [orgId]]],
      ],
      [
        "organization delete mark",
        [["UPDATE identity.organization SET deleted_at = now() WHERE id = $1", [orgId]]],
      ],
      [
        "member insert",
        [
          [
            "INSERT INTO identity.member (id, organization_id, user_id, role_key) VALUES ('mem_01jd00000000000000000000g2', $1, $2, 'admin')",
            [orgId, spare.userId],
          ],
        ],
      ],
      [
        "member role",
        [["UPDATE identity.member SET role_key = 'admin' WHERE id = $1", [memberId]]],
      ],
      ["member delete", [["DELETE FROM identity.member WHERE id = $1", [memberId]]]],
      [
        "invitation insert",
        [
          [
            "INSERT INTO identity.invitation (id, organization_id, email, role_key, token_hash, invited_by, expires_at) VALUES ('inv_01jd00000000000000000000g2', $1, 'quiet@example.com', 'admin', decode(repeat('aa', 32), 'hex'), $2, now() + interval '1 day')",
            [orgId, who.userId],
          ],
        ],
      ],
      [
        "invitation status",
        [
          [
            "UPDATE identity.invitation SET status = 'cancelled', cancel_reason = 'cancelled' WHERE id = $1",
            [invitationId],
          ],
        ],
      ],
      [
        "invitation token",
        [
          [
            "UPDATE identity.invitation SET token_hash = decode(repeat('bb', 32), 'hex') WHERE id = $1",
            [invitationId],
          ],
        ],
      ],
      [
        "invitation role",
        [["UPDATE identity.invitation SET role_key = 'super_admin' WHERE id = $1", [invitationId]]],
      ],
      [
        "role insert",
        [
          [
            "INSERT INTO identity.role (id, organization_id, name, created_by) VALUES ('rol_01jd00000000000000000000g2', $1, 'Quiet role', $2)",
            [orgId, who.userId],
          ],
        ],
      ],
      [
        "role update",
        [["UPDATE identity.role SET name = 'Renamed quietly' WHERE id = $1", [roleId]]],
      ],
      ["role delete", [["DELETE FROM identity.role WHERE id = $1", [roleId]]]],
      [
        "role permission insert",
        [
          [
            "INSERT INTO identity.role_permission (role_id, permission) VALUES ($1, 'auditLog.read')",
            [roleId],
          ],
        ],
      ],
      [
        "role permission delete",
        [["DELETE FROM identity.role_permission WHERE role_id = $1", [roleId]]],
      ],
    ];
    for (const [label, statements] of cases) {
      const state = await sqlstateOf(async () => inTransaction(await h.pool.connect(), statements));
      expect(state, label).toBe("FA010");
    }
  });

  it("refuse, as the owner too, the changes no event may make", async () => {
    const { orgId, memberId, who } = await ownerWithOrganization(h, "never");
    const other = await ownerWithOrganization(h, "never_other");
    const cases: [string, [string, unknown[]][]][] = [
      [
        "organization creator",
        [
          [
            "UPDATE identity.organization SET created_by = $2 WHERE id = $1",
            [orgId, other.who.userId],
          ],
        ],
      ],
      [
        "member moved",
        [
          [
            "UPDATE identity.member SET organization_id = $2 WHERE id = $1",
            [memberId, other.orgId],
          ],
        ],
      ],
      [
        "member reassigned",
        [["UPDATE identity.member SET user_id = $2 WHERE id = $1", [memberId, other.who.userId]]],
      ],
    ];
    for (const [label, statements] of cases) {
      const state = await sqlstateOf(async () =>
        inTransaction(await database.admin.connect(), statements),
      );
      expect(state, label).toBe("FA010");
    }
    void who;
  });

  it("let a change commit with its event in the same transaction", async () => {
    const { who, orgId } = await ownerWithOrganization(h, "allowed");
    const state = await sqlstateOf(async () =>
      inTransaction(await h.pool.connect(), [
        ["UPDATE identity.organization SET name = 'With event' WHERE id = $1", [orgId]],
        [
          "SELECT audit.record($1::jsonb)",
          [
            JSON.stringify({
              id: "aud_01jd00000000000000000000g1",
              event: "organization.updated",
              actor_kind: "user",
              actor_id: who.userId,
              actor_via: "console",
              target_id: orgId,
              ref_ids: [],
              organization_id: orgId,
              metadata: { fields: ["name"] },
              release: "test",
            }),
          ],
        ],
      ]),
    );
    expect(state).toBe("ok");
  });
});
