// The organisation area's grants (spec 02 §13.7; T-SAT-20 for this area): every forbidden statement
// fails with 42501 as the service's own login. The console never writes `live_status`, never deletes
// an organisation row and never reads the audit trail but through its two reads; `fin_readonly`
// reads no token hash; `fin_api` reads the views and nothing else of this area.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DROP_TIMEOUT_MS,
  type ServiceRole,
  type TestDatabase,
} from "../test/db.ts";
import { createHarness, type Harness, ownerWithOrganization } from "../test/harness.ts";

let database: TestDatabase;
let h: Harness;
let orgId: string;

beforeAll(async () => {
  database = await createTestDatabase("grants");
  h = await createHarness(database);
  orgId = (await ownerWithOrganization(h, "grants")).orgId;
});

afterAll(async () => {
  await database?.drop();
}, DROP_TIMEOUT_MS);

async function stateAs(role: ServiceRole, text: string, values: unknown[] = []): Promise<string> {
  const pool = database.login(role, { max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(text, values);
    await client.query("ROLLBACK");
    return "ok";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return String((error as { code?: string }).code);
  } finally {
    client.release();
  }
}

describe("the organisation grants", () => {
  it("refuse what the console may not do", async () => {
    const refused: [string, unknown[]][] = [
      ["UPDATE identity.organization SET live_status = 'approved' WHERE id = $1", [orgId]],
      ["DELETE FROM identity.organization WHERE id = $1", [orgId]],
      ["SELECT * FROM audit.event LIMIT 1", []],
      ["SELECT * FROM audit.event_context LIMIT 1", []],
      ["SELECT identity.audit_reader('ses_01jd0000000000000000000000')", []],
      ["SELECT * FROM identity.membership_view", []],
    ];
    for (const [text, values] of refused) {
      expect(await stateAs("fin_console", text, values), text).toBe("42501");
    }
    expect(await stateAs("fin_console", "SELECT id, name FROM identity.organization")).toBe("ok");
  });

  it("let fin_readonly read every column but the invitation's token hash", async () => {
    expect(await stateAs("fin_readonly", "SELECT token_hash FROM identity.invitation")).toBe(
      "42501",
    );
    expect(await stateAs("fin_readonly", "SELECT id, email, status FROM identity.invitation")).toBe(
      "ok",
    );
    expect(await stateAs("fin_readonly", "SELECT * FROM identity.member")).toBe("ok");
    expect(await stateAs("fin_readonly", "UPDATE identity.member SET role_key = 'admin'")).toBe(
      "42501",
    );
    expect(
      await stateAs(
        "fin_readonly",
        "SELECT * FROM identity.organization_audit_log('a', 'b', NULL, NULL, NULL, NULL, NULL, NULL, 1, 0)",
      ),
    ).toBe("42501");
  });

  it("let fin_api read the views and nothing else of this area", async () => {
    expect(await stateAs("fin_api", "SELECT * FROM identity.membership_view")).toBe("ok");
    expect(await stateAs("fin_api", "SELECT * FROM identity.role_permission_view")).toBe("ok");
    expect(await stateAs("fin_api", "SELECT * FROM identity.organization_view")).toBe("ok");
    expect(await stateAs("fin_api", "SELECT * FROM identity.member")).toBe("42501");
    expect(await stateAs("fin_api", "SELECT * FROM identity.invitation")).toBe("42501");
  });
});
