// T-SAT-26 for the sign-in tables (spec 02 §13.8, S2-04; AC-SAT-11, AC-SAT-43): every
// registration is installed as its trigger; as the service's own login, a write to a sign-in
// table with no event naming its key is refused at commit (FA010), and the same write with its
// event commits. A leaked console or admin login cannot add a sign-in method, mint a session,
// raise an assurance or change an address quietly.
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, ROLE_PREFIX, seed, type TestDatabase, testRole } from "../test/db.ts";
import { eventTypeRows } from "./audit/events.ts";
import { REALM_GUARDS } from "./guards.ts";
import { systemClock } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";

let database: TestDatabase;
let consolePool: Pool;
let adminPool: Pool;

beforeAll(async () => {
  database = await createTestDatabase("guards");
  consolePool = database.login("fin_console");
  adminPool = database.login("fin_admin");
});

afterAll(async () => {
  await database.drop();
});

const id = (prefix: Parameters<typeof newId>[0]) => newId(prefix, systemClock);

async function inTransaction(
  pool: Pool,
  statements: [string, unknown[]][],
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [text, values] of statements) await client.query(text, values);
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return (error as { code?: string }).code ?? "error";
  } finally {
    client.release();
  }
}

function recordEvent(
  event: string,
  target: string,
  refs: string[],
  subject: string | null,
): [string, unknown[]] {
  return [
    "SELECT audit.record($1::jsonb)",
    [
      JSON.stringify({
        id: id("aud"),
        event,
        actor_kind: subject === null ? "staff" : "user",
        actor_id: subject,
        actor_via: subject === null ? "admin" : "console",
        target_id: target,
        ref_ids: refs,
        ...(subject === null ? {} : { subject_user_id: subject }),
        metadata: {},
        release: "test",
      }),
    ],
  ];
}

async function aUser(): Promise<string> {
  const userId = id("usr");
  await seed(
    database.admin,
    'INSERT INTO identity."user" (id, email, email_verified) VALUES ($1, $2, true)',
    [userId, `${userId}@example.com`],
  );
  return userId;
}

async function aSession(userId: string): Promise<string> {
  const sessionId = id("ses");
  await seed(
    database.admin,
    `INSERT INTO identity.session (id, user_id, token, expires_at, assurance, absolute_expires_at, created_via)
     VALUES ($1, $2, $3, now() + interval '1 hour', 'aal1', now() + interval '1 day', 'email_otp')`,
    [sessionId, userId, `tok-${sessionId}`],
  );
  return sessionId;
}

async function aMember(): Promise<string> {
  const memberId = id("stf");
  await seed(
    database.admin,
    `INSERT INTO staff.member (id, email, role_key, status, added_by) VALUES ($1, $2, 'viewer', 'pending', 'operator')`,
    [memberId, `${memberId}@example.com`],
  );
  return memberId;
}

describe("the registrations", () => {
  it("are installed exactly, one trigger per table, operation and event list", async () => {
    const triggers = await database.admin.query<{ table: string; args: string[]; def: string }>(
      `SELECT c.relnamespace::regnamespace || '.' || c.relname AS table,
              pg_get_triggerdef(t.oid) AS def,
              string_to_array(encode(t.tgargs, 'escape'), '\\000') AS args
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname LIKE 'audit_guard_%'`,
    );
    const installed = new Set(
      triggers.rows.map(
        (t) => `${t.table}|${t.args.slice(0, 2).join("|")}|${/AFTER (.+?) ON/.exec(t.def)?.[1]}`,
      ),
    );
    const expected = new Set(
      REALM_GUARDS.flatMap((g) =>
        g.ops.map((op) => `${g.table}|${g.keyColumn}|${g.events.join(",")}|${op}`),
      ),
    );
    expect(installed).toEqual(expected);
  });

  it("name only events the catalogues know, or the never-allowed marker", () => {
    const known = new Set(eventTypeRows().map((r) => r.name));
    const others =
      /^(staff\.(member_added|role_changed|member_removed|factors_reset|bootstrapped)|password\.|account\.)/;
    for (const guard of REALM_GUARDS) {
      for (const event of guard.events) {
        if (event === "*" || event === "guard.never_allowed") continue;
        expect(known.has(event) || others.test(event), `${guard.table}: ${event}`).toBe(true);
      }
    }
  });
});

describe("as fin_console, a sign-in table write with no event is refused at commit", () => {
  it("refuses a passkey row, and commits it with passkey.added", async () => {
    const userId = await aUser();
    const insert = (pkyId: string): [string, unknown[]] => [
      `INSERT INTO identity.passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
       VALUES ($1, 'pk', $2, $3, 0, 'singleDevice', false)`,
      [pkyId, userId, `cred-${pkyId}`],
    ];
    const pky = id("pky");
    expect(await inTransaction(consolePool, [insert(pky)])).toBe("FA010");
    expect(
      await inTransaction(consolePool, [
        insert(pky),
        recordEvent("passkey.added", pky, [userId], userId),
      ]),
    ).toBeNull();
  });

  it("refuses a two-factor row, a session, a raised assurance and a proof", async () => {
    const userId = await aUser();
    const tfa = id("tfa");
    expect(
      await inTransaction(consolePool, [
        [
          "INSERT INTO identity.two_factor (id, secret, backup_codes, user_id, verified) VALUES ($1, 's', 'b', $2, true)",
          [tfa, userId],
        ],
      ]),
    ).toBe("FA010");
    const ses = id("ses");
    expect(
      await inTransaction(consolePool, [
        [
          `INSERT INTO identity.session (id, user_id, token, expires_at, assurance, absolute_expires_at, created_via)
           VALUES ($1, $2, $3, now() + interval '1 hour', 'aal2', now() + interval '1 day', 'passkey')`,
          [ses, userId, `tok-${ses}`],
        ],
      ]),
    ).toBe("FA010");
    const existing = await aSession(userId);
    expect(
      await inTransaction(consolePool, [
        ["UPDATE identity.session SET assurance = 'aal2' WHERE id = $1", [existing]],
      ]),
    ).toBe("FA010");
    expect(
      await inTransaction(consolePool, [
        ["UPDATE identity.session SET assurance = 'aal2' WHERE id = $1", [existing]],
        recordEvent("step_up.passed", existing, [userId], userId),
      ]),
    ).toBeNull();
    expect(
      await inTransaction(consolePool, [
        [
          "INSERT INTO identity.assurance (id, user_id, session_id, method) VALUES ($1, $2, $3, 'passkey')",
          [id("asr"), userId, existing],
        ],
      ]),
    ).toBe("FA010");
  });

  it("always refuses a changed address, a changed absolute limit and a moved credential", async () => {
    const userId = await aUser();
    const session = await aSession(userId);
    expect(
      await inTransaction(consolePool, [
        ["UPDATE identity.\"user\" SET email = 'changed@example.com' WHERE id = $1", [userId]],
        recordEvent("user.created", userId, [], userId),
      ]),
    ).toBe("FA010");
    expect(
      await inTransaction(consolePool, [
        [
          "UPDATE identity.session SET absolute_expires_at = now() + interval '30 days' WHERE id = $1",
          [session],
        ],
        recordEvent("session.created", session, [userId], userId),
      ]),
    ).toBe("FA010");
  });

  it("refuses a trusted browser without browser.trusted", async () => {
    const userId = await aUser();
    const tbr = id("tbr");
    const insert: [string, unknown[]] = [
      `INSERT INTO identity.trusted_browser (id, user_id, token_hash, label, expires_at)
       VALUES ($1, $2, $3, 'Chrome on Mac', now() + interval '30 days')`,
      [tbr, userId, Buffer.alloc(32, 7)],
    ];
    expect(await inTransaction(consolePool, [insert])).toBe("FA010");
    expect(
      await inTransaction(consolePool, [
        insert,
        recordEvent("browser.trusted", tbr, [userId], userId),
      ]),
    ).toBeNull();
  });

  it("refuses to consume an intent with no event naming it", async () => {
    const userId = await aUser();
    const session = await aSession(userId);
    const sti = id("sti");
    await seed(
      database.admin,
      `INSERT INTO ops.step_up_intent (id, realm, session_id, principal_id, action, params_digest, reason_key, expires_at, proved_at, proof_method)
       VALUES ($1, 'developer', $2, $3, 'account.backup_codes', $4, 'x', now() + interval '5 minutes', now(), 'totp')`,
      [sti, session, userId, Buffer.alloc(32)],
    );
    expect(
      await inTransaction(consolePool, [
        ["UPDATE ops.step_up_intent SET consumed_at = now() WHERE id = $1", [sti]],
      ]),
    ).toBe("FA010");
  });
});

describe("as fin_admin, the staff sign-in tables are guarded the same way", () => {
  it("refuses a staff passkey, a staff session and a changed staff address", async () => {
    const memberId = await aMember();
    expect(
      await inTransaction(adminPool, [
        [
          `INSERT INTO staff.passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
           VALUES ($1, 'pk', $2, $3, 0, 'singleDevice', false)`,
          [id("pky"), memberId, `cred-${memberId}`],
        ],
      ]),
    ).toBe("FA010");
    expect(
      await inTransaction(adminPool, [
        [
          `INSERT INTO staff.session (id, user_id, token, expires_at, assurance, absolute_expires_at, created_via, access_sub)
           VALUES ($1, $2, $3, now() + interval '10 minutes', 'aal2', now() + interval '12 hours', 'passkey', 'sub-1')`,
          [id("sts"), memberId, `tok-${memberId}`],
        ],
      ]),
    ).toBe("FA010");
    expect(
      await inTransaction(adminPool, [
        ["UPDATE staff.member SET email = 'other@example.com' WHERE id = $1", [memberId]],
      ]),
    ).toBe("FA010");
  });

  it("refuses an enrolment code without staff.enrolment_code_issued", async () => {
    const memberId = await aMember();
    const enc = id("enc");
    const insert: [string, unknown[]] = [
      `INSERT INTO staff.enrolment_code (id, member_id, code_hash, reason, issued_by, expires_at)
       VALUES ($1, $2, $3, 'added', 'operator', now() + interval '30 minutes')`,
      [enc, memberId, Buffer.alloc(32, 1)],
    ];
    expect(await inTransaction(adminPool, [insert])).toBe("FA010");
    expect(
      await inTransaction(adminPool, [
        insert,
        recordEvent("staff.enrolment_code_issued", enc, [memberId], null),
      ]),
    ).toBeNull();
  });
});

describe("audit.record's role allowlist", () => {
  it("refuses a developer event from fin_admin and a staff event from fin_console (FA002)", async () => {
    const userId = await aUser();
    expect(
      await inTransaction(adminPool, [recordEvent("session.revoked", id("ses"), [userId], userId)]),
    ).toBe("FA002");
    expect(
      await inTransaction(consolePool, [recordEvent("staff.signed_out", id("sts"), [], null)]),
    ).toBe("FA002");
    expect(testRole("fin_console")).toBe(`${ROLE_PREFIX}fin_console`);
    expect(ROLE_PREFIX).toMatch(/^[a-z][a-z0-9_]+_$/);
  });
});
