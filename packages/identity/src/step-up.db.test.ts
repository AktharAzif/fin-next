// Step-up intents and windows (spec 02 §7; T-SAT-30 for this lane's actions; AC-SAT-06,
// AC-SAT-32): refused with no intent, with an intent for another action, for other parameters,
// used, expired or of another session; passes once with a fresh one; a window passes within 5
// minutes of a proof and not after; two concurrent re-sends make exactly one action; five wrong
// codes end the session.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, DROP_TIMEOUT_MS, seed, type TestDatabase } from "../test/db.ts";
import {
  type Browser,
  codeSignIn,
  createHarness,
  type Harness,
  passkeyCeremony,
  registerPasskey,
  setUpAuthenticator,
  warmUp,
} from "../test/harness.ts";
import { hotp, totpStep } from "./crypto/totp.ts";
import { requirePerson } from "./require-person.ts";
import { revokeOtherSessions } from "./sessions.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("step_up");
  h = await createHarness(database, "developer");
});

// The realm's one-time start, so that the first test's time is its own (test/harness.ts).
beforeAll(async () => {
  await warmUp(h);
});

afterAll(async () => {
  await database.drop();
}, DROP_TIMEOUT_MS);

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;
async function personWithAuthenticator(label: string) {
  const email = unique(label);
  const browser = h.browser();
  await codeSignIn(h, browser, email);
  const { secret } = await setUpAuthenticator(browser);
  return { email, browser, secret };
}

/**
 * Proves an intent with a right TOTP code. Each step is accepted once ([SA-35]); these tests are
 * not about replay, so the person's last accepted step is forgotten first.
 */
async function prove(browser: Browser, secret: Uint8Array, intentId: string | null) {
  await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
  return browser.post(
    "/api/auth/two-factor/verify-totp",
    { code: hotp(secret, totpStep(new Date())) },
    intentId === null ? {} : { "fin-step-up-intent": intentId },
  );
}

describe("an intent on a library path (account.backup_codes)", () => {
  it("is asked for, proved by a ceremony, and consumed once by the action", async () => {
    const { browser, secret, email } = await personWithAuthenticator("intent");
    const asked = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(asked.status).toBe(403);
    expect(asked.json).toMatchObject({
      code: "step_up_required",
      step_up_kind: "intent",
      reason_key: "new_backup_codes",
      methods: ["authenticator", "backup_code"],
    });
    const intentId = String(asked.json?.intent_id);
    expect(intentId).toMatch(/^sti_/);

    // Unproved: refused.
    const early = await browser.post(
      "/api/auth/two-factor/generate-backup-codes",
      {},
      { "fin-step-up-intent": intentId },
    );
    expect(early.json).toMatchObject({ code: "step_up_invalid", reason: "unproved" });

    const proved = await prove(browser, secret, intentId);
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
    const passed = (await h.events({ event: "step_up.passed" })).at(-1);
    expect(passed?.metadata).toMatchObject({
      kind: "intent",
      action: "account.backup_codes",
      intentId,
    });

    const done = await browser.post(
      "/api/auth/two-factor/generate-backup-codes",
      {},
      { "fin-step-up-intent": intentId },
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json?.backupCodes).toHaveLength(10);
    const regenerated = (await h.events({ event: "backup_codes.regenerated" })).at(-1);
    expect(regenerated?.ref_ids).toContain(intentId);
    expect((await h.outbox(email)).some((m) => m.params.kind === "backup_codes_regenerated")).toBe(
      true,
    );

    // Used: refused, and nothing happens.
    const again = await browser.post(
      "/api/auth/two-factor/generate-backup-codes",
      {},
      { "fin-step-up-intent": intentId },
    );
    expect(again.json).toMatchObject({ code: "step_up_invalid", reason: "used" });
    expect(h.lines.named("step_up.refused").at(-1)).toMatchObject({
      reason: "used",
      action: "account.backup_codes",
    });
  });

  it("is refused for another action, other parameters, another session and after it expires", async () => {
    const { browser, secret } = await personWithAuthenticator("refusals");
    const authenticator = h.authenticator();

    // Another action: an intent made for the backup codes cannot remove a passkey.
    const backup = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    const backupIntent = String(backup.json?.intent_id);
    await prove(browser, secret, backupIntent);
    const otherAction = await browser.post(
      "/api/auth/passkey/delete-passkey",
      { id: "pky_00000000000000000000000000" },
      { "fin-step-up-intent": backupIntent },
    );
    expect(otherAction.json).toMatchObject({ code: "step_up_invalid", reason: "other_action" });

    // Other parameters: an intent to remove one passkey cannot remove another.
    const add = await browser.post("/api/auth/passkey/verify-registration", {});
    const addIntent = String(add.json?.intent_id);
    await prove(browser, secret, addIntent);
    const { verify } = await registerPasskey(browser, authenticator, {
      "fin-step-up-intent": addIntent,
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    const passkeyId = String(verify.json?.id);
    const removeA = await browser.post("/api/auth/passkey/delete-passkey", { id: passkeyId });
    const removeIntent = String(removeA.json?.intent_id);
    await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": removeIntent });
    const digest = await browser.post(
      "/api/auth/passkey/delete-passkey",
      { id: "pky_00000000000000000000000001" },
      { "fin-step-up-intent": removeIntent },
    );
    expect(digest.json).toMatchObject({ code: "step_up_invalid", reason: "digest" });

    // Another session of the same person cannot use it.
    const other = h.browser();
    await passkeyCeremony(other, authenticator);
    const otherSession = await other.post(
      "/api/auth/passkey/delete-passkey",
      { id: passkeyId },
      { "fin-step-up-intent": removeIntent },
    );
    expect(otherSession.json).toMatchObject({ code: "step_up_invalid", reason: "other_session" });

    // Expired: past its 5 minutes by the database clock.
    await database.admin.query(
      "UPDATE ops.step_up_intent SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second' WHERE id = $1",
      [removeIntent],
    );
    const expired = await browser.post(
      "/api/auth/passkey/delete-passkey",
      { id: passkeyId },
      { "fin-step-up-intent": removeIntent },
    );
    expect(expired.json).toMatchObject({ code: "step_up_invalid", reason: "expired" });
    const still = await h.admin.query("SELECT 1 FROM identity.passkey WHERE id = $1", [passkeyId]);
    expect(still.rowCount).toBe(1);
  });

  it("lets two concurrent re-sends with one intent make exactly one action (AC-SAT-32)", async () => {
    const { browser, secret } = await personWithAuthenticator("race");
    const asked = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    const intentId = String(asked.json?.intent_id);
    await prove(browser, secret, intentId);
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        browser.post(
          "/api/auth/two-factor/generate-backup-codes",
          {},
          { "fin-step-up-intent": intentId },
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.json?.code === "step_up_invalid")).toHaveLength(2);
    const regenerated = (await h.events({ event: "backup_codes.regenerated" })).filter((e) =>
      e.ref_ids.includes(intentId),
    );
    expect(regenerated).toHaveLength(1);
  });
});

describe("a window (§7.3) through requirePerson", () => {
  it("passes within 5 minutes of a proof and not after", async () => {
    const { browser, secret } = await personWithAuthenticator("window");
    const guard = () =>
      requirePerson(
        h.realm,
        browser.request("PATCH", "/api/account/name", { name: "Ada" }),
        browser.context(),
        {
          stepUp: { kind: "window", action: "account.name" },
        },
      );
    // The set-up's own proof opened a window.
    await expect(guard()).resolves.toMatchObject({ gate: "ok" });
    await seed(h.admin, "UPDATE identity.assurance SET created_at = now() - interval '6 minutes'");
    await expect(guard()).rejects.toMatchObject({
      code: "step_up_required",
      extensions: { step_up_kind: "window" },
    });
    const proof = await prove(browser, secret, null);
    expect(proof.status).toBe(200);
    await expect(guard()).resolves.toMatchObject({ gate: "ok" });
  });

  it("never makes an intent for a GET (§2.3)", async () => {
    const { browser } = await personWithAuthenticator("get.route");
    const before = await h.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ops.step_up_intent",
    );
    await expect(
      requirePerson(h.realm, browser.request("GET", "/api/account/sessions"), browser.context(), {
        stepUp: { kind: "intent", action: "account.sessions_revoke_others", body: {} },
      }),
    ).rejects.toThrow(/a GET never may/);
    const after = await h.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ops.step_up_intent",
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("answers second_factor_required for a person with no factor", async () => {
    const browser = h.browser();
    await codeSignIn(h, browser, unique("nofactor"));
    await expect(
      requirePerson(
        h.realm,
        browser.request("POST", "/api/account/sessions/revoke-others", {}),
        browser.context(),
        {
          stepUp: { kind: "intent", action: "account.sessions_revoke_others", body: {} },
        },
      ),
    ).rejects.toMatchObject({ code: "second_factor_required" });
  });

  it("makes, checks and consumes an intent for a Fin route, whose event names it", async () => {
    const { browser, secret, email } = await personWithAuthenticator("route");
    const elsewhere = h.browser();
    await codeSignIn(h, elsewhere, email);
    const call = (headers: Record<string, string> = {}, options: { skipEvent?: boolean } = {}) =>
      h.realm.run(browser.context(), async (tx) => {
        const who = await requirePerson(
          h.realm,
          browser.request("POST", "/api/account/sessions/revoke-others", {}, headers),
          browser.context(),
          { stepUp: { kind: "intent", action: "account.sessions_revoke_others", body: {} } },
        );
        await who.consume();
        if (options.skipEvent !== true) {
          await revokeOtherSessions(h.realm.runtime, tx, {
            personId: who.personId,
            email: who.email,
            currentSessionId: who.sessionId,
            actor: who.actor,
            context: { clientIp: null, userAgent: null },
            knownBrowserToken: null,
            trustedBrowserToken: null,
          });
        }
        return who;
      });
    const asked = await call().catch((e: unknown) => e as { extensions: { intent_id: string } });
    const intentId = (asked as { extensions: { intent_id: string } }).extensions.intent_id;
    await prove(browser, secret, intentId);
    // Consuming an intent with no event naming it is refused at commit by the guard (§13.8).
    await expect(call({ "fin-step-up-intent": intentId }, { skipEvent: true })).rejects.toThrow(
      /audit guard/,
    );
    const who = await call({ "fin-step-up-intent": intentId });
    expect(who.actor.stepUp).toEqual({ kind: "intent", method: "totp", ref: intentId });
    const event = (await h.events({ event: "session.revoked_others" })).at(-1);
    expect(event).toMatchObject({ step_up_ref: intentId, metadata: { count: 1 } });
    expect(elsewhere.sessionToken()).not.toBeNull();
    const gone = await h.admin.query("SELECT 1 FROM identity.session WHERE token = $1", [
      elsewhere.sessionToken(),
    ]);
    expect(gone.rowCount).toBe(0);
    await expect(call({ "fin-step-up-intent": intentId })).rejects.toMatchObject({
      code: "step_up_invalid",
    });
  });
});

describe("wrong codes at a step-up (§7.7)", () => {
  it("end the session at the fifth, with step_up.locked and the session-ended notice", async () => {
    const { browser, email } = await personWithAuthenticator("fivewrong");
    const asked = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    const intentId = String(asked.json?.intent_id);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await browser.post(
        "/api/auth/two-factor/verify-totp",
        { code: "000000" },
        { "fin-step-up-intent": intentId },
      );
      expect(wrong.status).toBe(401);
    }
    const after = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(after.status).toBe(401);
    expect(after.json).toMatchObject({ code: "unauthenticated", reason: "too_many_tries" });
    expect((await h.events({ event: "step_up.locked" })).length).toBe(1);
    expect((await h.events({ event: "step_up.failed" })).length).toBeGreaterThanOrEqual(5);
    expect((await h.outbox(email)).some((m) => m.template === "identity/session-ended")).toBe(true);
    expect(h.lines.named("step_up.locked").at(-1)).toEqual({ realm: "developer" });
  });
});
