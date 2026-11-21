// T-SAT-20 for this lane's fragments (spec 02 §13.7, AC-P0-11): each role holds only its grants;
// every forbidden statement fails with SQLSTATE 42501; fin_readonly reads no secret column; the
// sweeps run only as fin_worker; email.enqueue() refuses a template outside the role's folder.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type ServiceRole, type TestDatabase } from "../test/db.ts";
import { systemClock } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";

let database: TestDatabase;
const pools = new Map<ServiceRole, Pool>();

beforeAll(async () => {
  database = await createTestDatabase("grants");
  for (const role of [
    "fin_console",
    "fin_admin",
    "fin_api",
    "fin_worker",
    "fin_readonly",
  ] as const) {
    pools.set(role, database.login(role));
  }
});

afterAll(async () => {
  await database.drop();
});

async function sqlstate(
  role: ServiceRole,
  text: string,
  values: unknown[] = [],
): Promise<string | null> {
  try {
    await (pools.get(role) as Pool).query(text, values);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
}

describe("each role holds only its own tables", () => {
  it.each([
    ["fin_console", "SELECT 1 FROM staff.member"],
    ["fin_console", "SELECT 1 FROM staff.session"],
    ["fin_admin", 'SELECT 1 FROM identity."user"'],
    ["fin_admin", "SELECT 1 FROM identity.session"],
    ["fin_api", "SELECT token FROM identity.session"],
    ["fin_api", "UPDATE ops.step_up_intent SET consumed_at = now()"],
    ["fin_worker", 'SELECT 1 FROM identity."user"'],
    ["fin_console", "SELECT identity.sweep()"],
    ["fin_console", "SELECT identity.revoke_trusted_browsers('org_x', 'production_access')"],
    ["fin_console", "UPDATE identity.privileged_permission SET permission = 'x'"],
    ["fin_console", "DELETE FROM ops.lockout"],
    ["fin_console", "SELECT 1 FROM email.outbox"],
    [
      "fin_console",
      "INSERT INTO audit.event_type (name, area, category, scope, roles) VALUES ('a.b', 'a', 'security', 'person', '{x}')",
    ],
  ] as const)("%s may not: %s", async (role, text) => {
    expect(await sqlstate(role, text)).toBe("42501");
  });

  it.each([
    ["fin_console", 'SELECT count(*) FROM identity."user"'],
    ["fin_console", "SELECT count(*) FROM ops.step_up_intent"],
    ["fin_console", "SELECT count(*) FROM ops.lockout"],
    ["fin_admin", "SELECT count(*) FROM staff.enrolment_code"],
    ["fin_api", "SELECT count(*) FROM identity.session_view"],
    ["fin_api", "SELECT count(*) FROM staff.member_view"],
    ["fin_worker", "SELECT * FROM identity.sweep()"],
    ["fin_worker", "SELECT * FROM staff.sweep()"],
    ["fin_worker", "SELECT * FROM ops.sweep_step_up()"],
  ] as const)("%s may: %s", async (role, text) => {
    expect(await sqlstate(role, text)).toBeNull();
  });
});

describe("the address lock (codes.ts) is the console's alone", () => {
  // A row lock needs UPDATE on the table: a login that could take one could stall every code
  // request, codeless request and code try for an address by holding it open.
  const others = ["fin_admin", "fin_api", "fin_worker", "fin_readonly"] as const;
  const statements = [
    "SELECT 1 FROM identity.email_code_lock WHERE slot = 1 FOR UPDATE",
    "SELECT 1 FROM identity.email_code_lock WHERE slot = 1 FOR KEY SHARE",
    "SELECT slot FROM identity.email_code_lock",
    "UPDATE identity.email_code_lock SET slot = slot WHERE slot = 1",
    "INSERT INTO identity.email_code_lock (slot) VALUES (70000)",
    "DELETE FROM identity.email_code_lock",
    "TRUNCATE identity.email_code_lock",
    // In one simple query, which runs as one implicit transaction: LOCK TABLE needs a block.
    "LOCK TABLE identity.email_code_lock IN ROW EXCLUSIVE MODE; SELECT 1",
  ];
  it.each(others.flatMap((role) => statements.map((text) => [role, text] as const)))(
    "%s may not: %s",
    async (role, text) => {
      expect(await sqlstate(role, text)).toBe("42501");
    },
  );

  it("fin_console may take it", async () => {
    expect(
      await sqlstate(
        "fin_console",
        "SELECT slot FROM identity.email_code_lock WHERE slot = 1 FOR UPDATE",
      ),
    ).toBeNull();
  });

  // The table is the fixed set of slots its migration makes: the console only locks them, and can
  // neither add a row (so it never grows with the addresses callers send) nor take one away.
  it.each([
    "INSERT INTO identity.email_code_lock (slot) VALUES (1)",
    "DELETE FROM identity.email_code_lock WHERE slot = 1",
    "TRUNCATE identity.email_code_lock",
  ])("fin_console may not: %s", async (text) => {
    expect(await sqlstate("fin_console", text)).toBe("42501");
  });
});

describe("fin_readonly reads no secret column", () => {
  it.each([
    "SELECT token FROM identity.session",
    "SELECT password FROM identity.account",
    "SELECT access_token FROM identity.account",
    "SELECT value FROM identity.verification",
    "SELECT secret FROM identity.two_factor",
    "SELECT backup_codes FROM identity.two_factor",
    "SELECT token_hash FROM identity.known_browser",
    "SELECT token_hash FROM identity.trusted_browser",
    "SELECT email_hash FROM identity.email_code_request",
    "SELECT password_hash FROM identity.sign_up_request",
    "SELECT token FROM staff.session",
    "SELECT secret FROM staff.two_factor",
    "SELECT code_hash FROM staff.enrolment_code",
  ])("refuses %s", async (text) => {
    expect(await sqlstate("fin_readonly", text)).toBe("42501");
  });

  it("reads the rest", async () => {
    expect(
      await sqlstate(
        "fin_readonly",
        "SELECT id, user_id, assurance, expires_at FROM identity.session",
      ),
    ).toBeNull();
    expect(
      await sqlstate("fin_readonly", "SELECT id, user_id, verified FROM identity.two_factor"),
    ).toBeNull();
  });
});

describe("email.enqueue()'s per-role allowlist", () => {
  const enqueue = (template: string) =>
    `SELECT email.enqueue('${JSON.stringify({
      id: newId("eml", systemClock),
      template,
      recipient_kind: "address",
      recipient: "someone@example.com",
      params: {},
    })}'::jsonb)`;

  it("lets fin_console queue identity templates only", async () => {
    expect(await sqlstate("fin_console", enqueue("identity/already-registered"))).toBeNull();
    expect(await sqlstate("fin_console", enqueue("staff/staff-new-sign-in"))).toBe("FE001");
  });

  it("lets fin_admin queue staff templates only", async () => {
    expect(await sqlstate("fin_admin", enqueue("staff/staff-new-sign-in"))).toBeNull();
    expect(await sqlstate("fin_admin", enqueue("identity/sign-in-code"))).toBe("FE001");
  });
});
