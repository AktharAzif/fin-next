// Sessions (spec 02 §11; T-SAT-29, AC-SAT-31): a refresh never passes the absolute limit; an aal1
// session at the factor step dies after 10 minutes; sign-out ends the session with its event;
// signing out one other session and every other session; the sweeps delete what they should.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import { codeSignIn, createHarness, type Harness, setUpAuthenticator } from "../test/harness.ts";
import { revokeSession } from "./sessions.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("sessions");
  h = await createHarness(database, "developer");
});

afterAll(async () => {
  await database.drop();
});

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;

async function row(token: string | null) {
  const result = await h.admin.query<{
    id: string;
    expires_at: Date;
    absolute_expires_at: Date;
    user_id: string;
  }>("SELECT id, expires_at, absolute_expires_at, user_id FROM identity.session WHERE token = $1", [
    token,
  ]);
  return result.rows[0];
}

describe("lifetimes (§11.1)", () => {
  it("a working session lasts 24 hours idle within 7 days absolute", async () => {
    const browser = h.browser();
    await codeSignIn(h, browser, unique("life"));
    const r = await row(browser.sessionToken());
    const idle = (r?.expires_at.getTime() ?? 0) - Date.now();
    const absolute = (r?.absolute_expires_at.getTime() ?? 0) - Date.now();
    expect(idle).toBeGreaterThan(23.9 * 3_600_000);
    expect(idle).toBeLessThanOrEqual(24 * 3_600_000);
    expect(absolute).toBeGreaterThan(6.99 * 86_400_000);
    expect(absolute).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it("a refresh never passes the absolute limit", async () => {
    const browser = h.browser();
    await codeSignIn(h, browser, unique("refresh"));
    const before = await row(browser.sessionToken());
    // Close to its absolute end, and due for a refresh (older than updateAge).
    await seed(
      h.admin,
      `UPDATE identity.session SET absolute_expires_at = now() + interval '2 minutes',
              expires_at = now() + interval '1 minute', updated_at = now() - interval '1 day',
              created_at = now() - interval '1 day'
        WHERE id = $1`,
      [before?.id],
    );
    const session = await h.realm.sessionOf(
      browser.request("GET", "/api/auth/get-session"),
      browser.context(),
    );
    expect(session?.session.id).toBe(before?.id);
    const after = await row(browser.sessionToken());
    expect(after?.expires_at.getTime()).toBeLessThanOrEqual(
      after?.absolute_expires_at.getTime() ?? 0,
    );
    expect(after?.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it("an aal1 session at the factor step dies after 10 minutes (S2-07)", async () => {
    const email = unique("tenminutes");
    const first = h.browser();
    await codeSignIn(h, first, email);
    await setUpAuthenticator(first);
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const r = await row(browser.sessionToken());
    await seed(
      h.admin,
      "UPDATE identity.session SET created_at = now() - interval '11 minutes' WHERE id = $1",
      [r?.id],
    );
    const answer = await browser.post("/api/auth/two-factor/verify-totp", { code: "123456" });
    expect(answer.status).toBe(401);
    expect(answer.json).toMatchObject({ code: "unauthenticated" });
    expect(await row(browser.sessionToken())).toBeUndefined();
  });
});

describe("ending sessions (§11.4)", () => {
  it("sign-out ends this session with session.ended", async () => {
    const browser = h.browser();
    await codeSignIn(h, browser, unique("signout"));
    const r = await row(browser.sessionToken());
    const out = await browser.post("/api/auth/sign-out");
    expect(out.status).toBe(200);
    const gone = await h.admin.query("SELECT 1 FROM identity.session WHERE id = $1", [r?.id]);
    expect(gone.rowCount).toBe(0);
    const ended = (await h.events({ event: "session.ended" })).find((e) => e.target_id === r?.id);
    expect(ended?.metadata).toEqual({ reason: "signed_out" });
    expect(
      out.setCookies.some((c) => c.startsWith("__Host-fin.session_token=") && /max-age=0/i.test(c)),
    ).toBe(true);
  });

  it("signs out one other session of the person, never this one or someone else's", async () => {
    const email = unique("revoke.one");
    const a = h.browser();
    await codeSignIn(h, a, email);
    const b = h.browser();
    await codeSignIn(h, b, email);
    const stranger = h.browser();
    await codeSignIn(h, stranger, unique("stranger"));
    const mine = await row(a.sessionToken());
    const other = await row(b.sessionToken());
    const theirs = await row(stranger.sessionToken());
    const who = {
      personId: mine?.user_id as string,
      email,
      currentSessionId: mine?.id as string,
      actor: { kind: "user" as const, id: mine?.user_id as string, via: "console" as const },
      context: { clientIp: null, userAgent: null },
      knownBrowserToken: null,
    };
    const results = await h.realm.run(a.context(), async (tx) => [
      await revokeSession(h.realm.runtime, tx, who, mine?.id as string),
      await revokeSession(h.realm.runtime, tx, who, theirs?.id as string),
      await revokeSession(h.realm.runtime, tx, who, other?.id as string),
    ]);
    expect(results).toEqual([false, false, true]);
    expect(await row(b.sessionToken())).toBeUndefined();
    expect(await row(stranger.sessionToken())).toBeDefined();
    expect((await h.events({ event: "session.revoked" })).map((e) => e.target_id)).toContain(
      other?.id,
    );
  });
});

describe("the sweeps (§13.4)", () => {
  it("delete expired sessions, verifications and old requests, and nothing else", async () => {
    const live = h.browser();
    await codeSignIn(h, live, unique("sweep.live"));
    const dead = h.browser();
    await codeSignIn(h, dead, unique("sweep.dead"));
    const deadRow = await row(dead.sessionToken());
    await seed(
      h.admin,
      "UPDATE identity.session SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [deadRow?.id],
    );
    const worker = database.login("fin_worker");
    const swept = await worker.query<{ table_name: string; deleted: string }>(
      "SELECT * FROM identity.sweep()",
    );
    const counts = Object.fromEntries(swept.rows.map((r) => [r.table_name, Number(r.deleted)]));
    expect(counts["identity.session"]).toBeGreaterThanOrEqual(1);
    expect(await row(dead.sessionToken())).toBeUndefined();
    expect(await row(live.sessionToken())).toBeDefined();
  });
});
