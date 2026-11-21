// Sessions (spec 02 §11; T-SAT-29, AC-SAT-31): a refresh never passes the absolute limit; an aal1
// session at the factor step dies after 10 minutes; sign-out ends the session with its event;
// signing out one other session and every other session; the sweeps delete what they should.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  type Browser,
  codeSignIn,
  createHarness,
  type Harness,
  setUpAuthenticator,
} from "../test/harness.ts";
import { hotp, totpStep } from "./crypto/totp.ts";
import { requirePerson } from "./require-person.ts";
import { revokeOtherSessions, revokeSession } from "./sessions.ts";

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
    assurance: string;
    trusted_browser_id: string | null;
  }>(
    `SELECT id, expires_at, absolute_expires_at, user_id, assurance, trusted_browser_id
       FROM identity.session WHERE token = $1`,
    [token],
  );
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
      trustedBrowserToken: null,
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

describe("signing out everywhere else from a trusted browser (§11.4, §6.1, §6.6)", () => {
  /** Trusts browser `b` at the factor step, which leaves it signed in; returns the trusted row. */
  async function trust(b: Browser, email: string, secret: Uint8Array): Promise<string> {
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    expect((await codeSignIn(h, b, email)).status).toBe(200);
    const trusted = await b.post("/api/auth/two-factor/verify-totp", {
      code: hotp(secret, totpStep(new Date())),
      trustDevice: true,
    });
    expect(trusted.status, JSON.stringify(trusted.json)).toBe(200);
    return (await h.events({ event: "browser.trusted" })).at(-1)?.target_id as string;
  }

  /**
   * A person with an authenticator whose browsers `here` and `there` are trusted: `here` signed in
   * again by code (an aal1 trusted-browser session), `there` still in the session that trusted it.
   * Four code emails, so the address's fifth in the hour is still allowed (§5.6).
   */
  async function trustedTwice(label: string) {
    const email = unique(label);
    const here = h.browser();
    await codeSignIn(h, here, email);
    const { secret, backupCodes } = await setUpAuthenticator(here);
    await here.post("/api/auth/sign-out");
    const hereTrust = await trust(here, email, secret);
    await here.post("/api/auth/sign-out");
    const there = h.browser();
    const thereTrust = await trust(there, email, secret);
    expect((await codeSignIn(h, here, email)).status).toBe(200);
    const mine = await row(here.sessionToken());
    expect(mine).toMatchObject({ assurance: "aal1", trusted_browser_id: hereTrust });
    return { email, here, there, secret, backupCodes, hereTrust, thereTrust, mine };
  }

  async function revokedReason(id: string): Promise<string | null> {
    const result = await h.admin.query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM identity.trusted_browser WHERE id = $1",
      [id],
    );
    return result.rows[0]?.revoked_reason ?? null;
  }

  /** "Sign out everywhere else" as its route runs it, from `b`, with an optional intent. */
  const signOutElsewhere = (
    b: Browser,
    headers: Record<string, string> = {},
    tokens: { known?: boolean; trusted?: boolean } = {},
  ) =>
    h.realm.run(b.context(), async (tx) => {
      const who = await requirePerson(
        h.realm,
        b.request("POST", "/api/account/sessions/revoke-others", {}, headers),
        b.context(),
        { stepUp: { kind: "intent", action: "account.sessions_revoke_others", body: {} } },
      );
      await who.consume();
      return revokeOtherSessions(h.realm.runtime, tx, {
        personId: who.personId,
        email: who.email,
        currentSessionId: who.sessionId,
        actor: who.actor,
        context: { clientIp: null, userAgent: null },
        knownBrowserToken:
          tokens.known === false ? null : (b.jar.get("__Host-fin.known_browser") ?? null),
        trustedBrowserToken:
          tokens.trusted === false ? null : (b.jar.get("__Host-fin.trusted_browser") ?? null),
      });
    });

  async function intentFor(b: Browser): Promise<string> {
    const asked = await signOutElsewhere(b).catch((e: unknown) => e);
    return (asked as { extensions: { intent_id: string } }).extensions.intent_id;
  }

  it("keeps this session and this browser's trust after a backup-code step-up past 10 minutes", async () => {
    const { email, here, there, backupCodes, hereTrust, thereTrust, mine } =
      await trustedTwice("everywhere");
    await seed(
      h.admin,
      "UPDATE identity.session SET created_at = now() - interval '2 hours' WHERE id = $1",
      [mine?.id],
    );
    const intentId = await intentFor(here);
    const proved = await here.post(
      "/api/auth/two-factor/verify-backup-code",
      { code: backupCodes[0] },
      { "fin-step-up-intent": intentId },
    );
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
    // The signed-in backup-code check raises this same session (§6.1).
    expect(await row(here.sessionToken())).toMatchObject({ id: mine?.id, assurance: "aal2" });

    expect(await signOutElsewhere(here, { "fin-step-up-intent": intentId })).toBe(1);
    // Every other session ends; this one goes on working (§11.4).
    expect(await row(there.sessionToken())).toBeUndefined();
    expect(await row(here.sessionToken())).toMatchObject({ id: mine?.id });
    const working = await here.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(working.json).toMatchObject({ code: "step_up_required" });
    // Every trusted browser but this one is revoked, one event each.
    expect(await revokedReason(hereTrust)).toBeNull();
    expect(await revokedReason(thereTrust)).toBe("signed_out_everywhere");
    const revoked = (await h.events({ event: "browser.trust_revoked" })).map((e) => e.target_id);
    expect(revoked).toContain(thereTrust);
    expect(revoked).not.toContain(hereTrust);
    // This browser is still trusted: its next code sign-in is a working session again.
    await here.post("/api/auth/sign-out");
    expect((await codeSignIn(h, here, email)).status).toBe(200);
    expect(await row(here.sessionToken())).toMatchObject({
      assurance: "aal1",
      trusted_browser_id: hereTrust,
    });
  });

  /** Asks for the intent, proves it with the authenticator, and signs out everywhere else. */
  async function stepUpAndSignOutElsewhere(
    b: Browser,
    secret: Uint8Array,
    tokens: { trusted?: boolean } = {},
  ): Promise<number> {
    const intentId = await intentFor(b);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    const proved = await b.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date())) },
      { "fin-step-up-intent": intentId },
    );
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
    return signOutElsewhere(b, { "fin-step-up-intent": intentId }, tokens);
  }

  it("keeps the trusted browser the session came from, with no cookie given", async () => {
    const { here, secret, hereTrust, thereTrust } = await trustedTwice("keep.session");
    expect(await stepUpAndSignOutElsewhere(here, secret, { trusted: false })).toBe(1);
    expect(await revokedReason(hereTrust)).toBeNull();
    expect(await revokedReason(thereTrust)).toBe("signed_out_everywhere");
  });

  it("keeps the trusted browser this browser's cookie names, from a session not made by it", async () => {
    const { here, secret, hereTrust, thereTrust, mine } = await trustedTwice("keep.cookie");
    // As a passkey sign-in in the trusted browser would be: aal2, and no trusted browser of its own.
    await seed(
      h.admin,
      "UPDATE identity.session SET trusted_browser_id = NULL, assurance = 'aal2' WHERE id = $1",
      [mine?.id],
    );
    expect(await stepUpAndSignOutElsewhere(here, secret)).toBe(1);
    expect(await revokedReason(hereTrust)).toBeNull();
    expect(await revokedReason(thereTrust)).toBe("signed_out_everywhere");
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
