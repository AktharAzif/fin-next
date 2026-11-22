// T-SAT-02, SP-10's pins (spec 02 §3.6): the library behaviours Fin's design depends on, proved
// on the installed version (better-auth 1.7.25). A changed pin fails CI, and the identity lane
// re-reads the installed source before a bump merges ([SA-35], [SA-02]).
import { getSchema } from "better-auth/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DROP_TIMEOUT_MS,
  seed,
  type TestDatabase,
  testRole,
} from "../test/db.ts";
import { codeSignIn, createHarness, type Harness, setUpAuthenticator } from "../test/harness.ts";
import { hotp, totpStep } from "./crypto/totp.ts";
import { OutsideUnitError } from "./ports/pg-database.ts";
import { developerSchema, staffSchema } from "./schema/tables.ts";

let database: TestDatabase;
let h: Harness;
let staff: Harness;

beforeAll(async () => {
  database = await createTestDatabase("pins");
  h = await createHarness(database, "developer");
  staff = await createHarness(database, "staff");
});

afterAll(async () => {
  await database.drop();
}, DROP_TIMEOUT_MS);

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;

interface InternalAdapter {
  createSession(userId: string): Promise<unknown>;
  createUser(user: Record<string, unknown>): Promise<unknown>;
  findUserByEmail(email: string): Promise<unknown>;
}

async function internalAdapter(harness: Harness): Promise<InternalAdapter> {
  const ctx = (await harness.realm.auth.$context) as unknown as {
    internalAdapter: InternalAdapter;
  };
  return ctx.internalAdapter;
}

describe("the unit of work holds every library write (S2-04)", () => {
  it("refuses a library query outside a unit of work", async () => {
    const adapter = await internalAdapter(h);
    const error = await adapter.findUserByEmail("nobody@example.com").then(
      () => null,
      (e: unknown) => e as { cause?: unknown },
    );
    // Drizzle wraps the driver's error; the cause is the binding's refusal.
    expect(error?.cause).toBeInstanceOf(OutsideUnitError);
  });

  it("rolls the library's own writes back with the unit when a notice cannot be queued", async () => {
    const email = unique("rollback");
    await h.admin.query(
      `REVOKE EXECUTE ON FUNCTION email.enqueue(jsonb) FROM "${testRole("fin_console")}"`,
    );
    try {
      const answer = await h
        .browser()
        .post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
      expect(answer.status).toBe(500);
      expect(answer.json).toMatchObject({ code: "internal" });
    } finally {
      await h.admin.query(
        `GRANT EXECUTE ON FUNCTION email.enqueue(jsonb) TO "${testRole("fin_console")}"`,
      );
    }
    const verification = await h.admin.query(
      "SELECT 1 FROM identity.verification WHERE identifier = $1",
      [`sign-in-otp-${email}`],
    );
    expect(verification.rowCount).toBe(0);
    const requests = await h.admin.query(
      "SELECT count(*)::int AS n FROM identity.email_code_request",
    );
    const before = requests.rows[0]?.n;
    expect(typeof before).toBe("number");
    expect(h.lines.named("email.security_unsent").at(-1)).toMatchObject({
      template: "identity/sign-in-code",
    });
  });

  it("runs hooks.after before the handler returns: the events are there when it answers", async () => {
    const browser = h.browser();
    const email = unique("after");
    const answer = await codeSignIn(h, browser, email);
    expect(answer.status).toBe(200);
    const events = await h.events({ event: "user.created" });
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("the paths that create a session, and what the hooks see", () => {
  it("refuses a session or an account made from any other path", async () => {
    const adapter = await internalAdapter(h);
    const userId = await (async () => {
      const browser = h.browser();
      await codeSignIn(h, browser, unique("paths"));
      const r = await h.admin.query<{ user_id: string }>(
        "SELECT user_id FROM identity.session WHERE token = $1",
        [browser.sessionToken()],
      );
      return r.rows[0]?.user_id as string;
    })();
    const context = h.browser().context();
    await expect(h.realm.run(context, () => adapter.createSession(userId))).rejects.toThrow(
      /may not be created from a server call/,
    );
    await expect(
      h.realm.run(context, () =>
        adapter.createUser({ email: unique("server"), name: "", emailVerified: true }),
      ),
    ).rejects.toThrow(/may not create an account/);
    await expect(
      staff.realm.run(context, async () =>
        (
          (await staff.realm.auth.$context) as unknown as { internalAdapter: InternalAdapter }
        ).internalAdapter.createUser({
          email: unique("staff"),
          name: "",
          emailVerified: true,
        }),
      ),
    ).rejects.toThrow(/may not create an account/);
  });

  it("does not let the two-factor plugin challenge a code sign-in: it gives a session, not a redirect", async () => {
    const email = unique("nochallenge");
    const first = h.browser();
    await codeSignIn(h, first, email);
    await setUpAuthenticator(first);
    const browser = h.browser();
    const answer = await codeSignIn(h, browser, email);
    expect(answer.status).toBe(200);
    expect(answer.json?.twoFactorRedirect).toBeUndefined();
    expect(browser.sessionToken()).not.toBeNull();
  });
});

describe("/two-factor/verify-totp with a signed-in session", () => {
  it("returns the same session, and the library accepts a step twice (so Fin keeps the last step)", async () => {
    const email = unique("sameSession");
    const first = h.browser();
    await codeSignIn(h, first, email);
    const { secret } = await setUpAuthenticator(first);
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const before = browser.sessionToken();
    const code = hotp(secret, totpStep(new Date()) + 1n);
    const passed = await browser.post("/api/auth/two-factor/verify-totp", { code });
    expect(passed.status).toBe(200);
    expect(browser.sessionToken()).toBe(before);
    // With Fin's record of the last step forgotten, the library takes the same code again.
    await seed(h.admin, "UPDATE identity.totp_step SET last_step = 0");
    const again = await browser.post("/api/auth/two-factor/verify-totp", { code });
    expect(again.status).toBe(200);
  });

  it("does not apply the library's lockout in that branch (Fin's applies instead)", async () => {
    const email = unique("nolockout");
    const first = h.browser();
    await codeSignIn(h, first, email);
    await setUpAuthenticator(first);
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    for (let i = 0; i < 3; i += 1)
      await browser.post("/api/auth/two-factor/verify-totp", { code: "000000" });
    const row = await h.admin.query<{ failed_verification_count: number }>(
      `SELECT t.failed_verification_count FROM identity.two_factor t JOIN identity."user" u ON u.id = t.user_id
        WHERE u.email = $1`,
      [email],
    );
    expect(row.rows[0]?.failed_verification_count).toBe(0);
    const fin = await h.admin.query<{ count: number }>(
      "SELECT count FROM ops.lockout WHERE kind = 'factor_code'",
    );
    expect(fin.rows.some((r) => r.count >= 3)).toBe(true);
  });
});

describe("the library's schema", () => {
  it.each([
    ["developer", () => h, developerSchema],
    ["staff", () => staff, staffSchema],
  ] as const)(
    "matches the %s tables Fin declares and creates",
    async (_realm, harness, declared) => {
      const realm = harness().realm;
      const schema = getSchema(realm.auth.options) as Record<
        string,
        { fields: Record<string, unknown> }
      >;
      const tables = declared as unknown as Record<string, Record<string, unknown>>;
      for (const [model, { fields }] of Object.entries(schema)) {
        if (model === "rateLimit") continue;
        const table = tables[model];
        expect(table, model).toBeDefined();
        for (const field of Object.keys(fields))
          expect(table?.[field], `${model}.${field}`).toBeDefined();
      }
    },
  );
});

describe("one line per auth request (§18.1)", () => {
  it("writes exactly one request line, with the auth fields and IDs only", async () => {
    const before = h.lines.named("request").length;
    const browser = h.browser();
    const email = unique("line");
    await codeSignIn(h, browser, email);
    const lines = h.lines.named("request").slice(before);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      realm: "developer",
      authPath: "/email-otp/send-verification-otp",
      assurance: "none",
      status: 200,
    });
    expect(lines[0]?.gate).toBeUndefined();
    expect(lines[1]).toMatchObject({
      realm: "developer",
      authPath: "/sign-in/email-otp",
      assurance: "aal1",
      gate: "ok",
      outcome: "ok",
      status: 200,
    });
    expect(String(lines[1]?.userId)).toMatch(/^usr_/);
    expect(JSON.stringify(h.lines.lines)).not.toContain(email);
  });

  it("hands its fields to the front door's request line when it gives one", async () => {
    const browser = h.browser();
    const annotated: Record<string, unknown>[] = [];
    const before = h.lines.named("request").length;
    const response = await h.realm.handler(browser.request("POST", "/api/auth/sign-out"), {
      ...browser.context(),
      annotate: (fields) => annotated.push({ ...fields }),
    });
    expect(response.status).toBe(200);
    expect(annotated).toHaveLength(1);
    expect(annotated[0]).toMatchObject({
      realm: "developer",
      authPath: "/sign-out",
      outcome: "ok",
    });
    expect(h.lines.named("request").length).toBe(before);
  });
});

describe("emailOTP with sign-up on (developer realm)", () => {
  it("creates an account only through /sign-in/email-otp", async () => {
    const email = unique("only");
    const browser = h.browser();
    await browser.post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    const code = (await h.latestCode(email)) as string;
    expect(
      await h.admin.query('SELECT 1 FROM identity."user" WHERE email = $1', [email]),
    ).toMatchObject({ rowCount: 0 });
    const blocked = await browser.post("/api/auth/email-otp/verify-email", { email, otp: code });
    expect(blocked.status).toBe(404);
    const signedIn = await browser.post("/api/auth/sign-in/email-otp", { email, otp: code });
    expect(signedIn.status).toBe(200);
  });
});
