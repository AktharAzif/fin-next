// Passkeys (spec 02 §5.3, §6.1, §6.3, §6.7, §7.4, §11.3; AC-SAT-06): the first one under the
// first-factor rule raises the session; a passkey sign-in is aal2 at once; a passkey step-up
// replaces the session without lengthening it and moves its proofs; another person's passkey is
// refused; a challenge works once; a counter that goes backwards is refused and the person told; a
// sign-in in flight while its passkey is removed finds it gone, and neither waits on the other; an
// assertion holds its person's row only once its network's allowance is counted and its browser
// holds a challenge, and never in a way that keeps the person's own sign-in waiting.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  type Browser,
  codeSignIn,
  createHarness,
  type Harness,
  passkeyCeremony,
  registerPasskey,
} from "../test/harness.ts";
import { systemClock } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("passkeys");
  h = await createHarness(database, "developer");
});

afterAll(async () => {
  await database.drop();
});

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;

async function session(browser: Browser) {
  const result = await h.admin.query<{
    id: string;
    assurance: string;
    absolute_expires_at: Date;
    created_via: string;
  }>(
    "SELECT id, assurance, absolute_expires_at, created_via FROM identity.session WHERE token = $1",
    [browser.sessionToken()],
  );
  return result.rows[0];
}

async function personWithPasskey(label: string) {
  const email = unique(label);
  const browser = h.browser();
  await codeSignIn(h, browser, email);
  const authenticator = h.authenticator();
  const { verify } = await registerPasskey(browser, authenticator);
  return { email, browser, authenticator, verify };
}

describe("the first passkey", () => {
  it("registers under the first-factor rule, named by the device, and raises the session", async () => {
    const { browser, verify, email } = await personWithPasskey("first");
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect(verify.json?.name).toBe("Chrome on Mac");
    expect((await session(browser))?.assurance).toBe("aal2");
    expect((await h.events({ event: "passkey.added" })).length).toBeGreaterThan(0);
    const notices = (await h.outbox(email)).map(
      (m) => `${m.template}:${String(m.params.kind ?? "")}`,
    );
    expect(notices).toContain("identity/sign-in-methods-changed:passkey_added");
  });

  it("is refused once the mailbox proof is older than 15 minutes (§6.3)", async () => {
    const browser = h.browser();
    await codeSignIn(h, browser, unique("stale"));
    // The guard refuses this change from every login (§13.8), so the fixture writes it with
    // triggers off.
    await seed(
      h.admin,
      "UPDATE identity.session SET mailbox_proved_at = now() - interval '16 minutes' WHERE token = $1",
      [browser.sessionToken()],
    );
    const options = await browser.get("/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(403);
    expect(options.json).toMatchObject({ code: "fresh_session_required" });
  });

  it("needs an intent for a second passkey", async () => {
    const { browser } = await personWithPasskey("second");
    const options = await browser.get("/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(403);
    expect(options.json).toMatchObject({
      code: "step_up_required",
      step_up_kind: "intent",
      reason_key: "add_passkey",
    });
    expect(options.json?.methods).toEqual(["passkey"]);
  });
});

describe("a passkey sign-in", () => {
  it("is aal2 at once, with a proof and session.created", async () => {
    const { authenticator } = await personWithPasskey("signin");
    const browser = h.browser();
    const signedIn = await passkeyCeremony(browser, authenticator);
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    const row = await session(browser);
    expect(row).toMatchObject({ assurance: "aal2", created_via: "passkey" });
    const proofs = await h.admin.query(
      "SELECT method FROM identity.assurance WHERE session_id = $1",
      [row?.id],
    );
    expect(proofs.rows).toEqual([{ method: "passkey" }]);
    const created = (await h.events({ event: "session.created" })).filter(
      (e) => e.target_id === row?.id,
    );
    expect(created[0]?.metadata).toMatchObject({ method: "passkey", assurance: "aal2" });
  });

  it("refuses a challenge used twice", async () => {
    const { authenticator } = await personWithPasskey("challenge");
    const browser = h.browser();
    const challenge = await browser.get("/api/auth/passkey/generate-authenticate-options");
    const response = authenticator.authenticate(String(challenge.json?.challenge));
    const first = await browser.post("/api/auth/passkey/verify-authentication", { response });
    expect(first.status).toBe(200);
    // The same assertion again is refused (its counter did not move).
    const replayed = await browser.post("/api/auth/passkey/verify-authentication", { response });
    expect(replayed.status).not.toBe(200);
    // A fresh assertion over the spent challenge is refused by the library (SP-10's pin).
    const fresh = authenticator.authenticate(String(challenge.json?.challenge));
    const again = await browser.post("/api/auth/passkey/verify-authentication", {
      response: fresh,
    });
    expect(again.status).toBe(400);
    expect(again.json).toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
  });

  it("refuses a signature counter that goes backwards, and tells the person", async () => {
    const { authenticator, email } = await personWithPasskey("counter");
    expect((await passkeyCeremony(h.browser(), authenticator, {}, { counter: 5 })).status).toBe(
      200,
    );
    const refused = await passkeyCeremony(h.browser(), authenticator, {}, { counter: 3 });
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "forbidden", reason: "passkey_refused" });
    const notices = (await h.outbox(email)).map(
      (m) => `${m.template}:${String(m.params.kind ?? "")}`,
    );
    expect(notices).toContain("identity/sign-in-methods-changed:passkey_refused");
  });

  it("answers an assertion it cannot verify as any failed ceremony, and tells nobody", async () => {
    const { authenticator, email } = await personWithPasskey("forged");
    expect((await passkeyCeremony(h.browser(), authenticator, {}, { counter: 5 })).status).toBe(
      200,
    );
    const before = (await h.outbox(email)).length;
    const credential = authenticator.credentials[0];
    if (credential === undefined) throw new Error("no credential was registered");
    const credentialId = credential.id.toString("base64url");
    // Anyone may know a credential ID; an unsigned assertion naming it with a low counter...
    const browser = h.browser();
    const challenge = await browser.get("/api/auth/passkey/generate-authenticate-options");
    const forged = forgedAssertion(credentialId, String(challenge.json?.challenge), 0);
    const refused = await browser.post("/api/auth/passkey/verify-authentication", {
      response: forged,
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    // ...or one sent with no challenge at all.
    const cold = await h
      .browser()
      .post("/api/auth/passkey/verify-authentication", { response: forged });
    expect(cold.status).toBe(400);
    expect(cold.json).toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
    expect((await h.outbox(email)).length).toBe(before);
  });
});

/** An assertion that names a real credential but is signed by nobody (signature `AA`). */
function forgedAssertion(credentialId: string, challenge: string, counter: number) {
  const counterBytes = Buffer.alloc(4);
  counterBytes.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(h.realm.settings.rpId).digest(),
    Buffer.from([0x05]),
    counterBytes,
  ]);
  const clientData = JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: h.realm.settings.publicOrigin,
    crossOrigin: false,
  });
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: Buffer.from(clientData).toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: "AA",
    },
    clientExtensionResults: {},
  };
}

describe("removing a passkey (§7.6 account.passkey_remove)", () => {
  it("takes an intent bound to that passkey, and writes passkey.removed with its notice", async () => {
    const { browser, authenticator, email } = await personWithPasskey("remove");
    const second = h.authenticator();
    const add = await browser.post("/api/auth/passkey/verify-registration", {});
    const addIntent = String(add.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": addIntent })).status,
    ).toBe(200);
    const { verify } = await registerPasskey(browser, second, { "fin-step-up-intent": addIntent });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    const id = String(verify.json?.id);
    const asked = await browser.post("/api/auth/passkey/delete-passkey", { id });
    expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: "remove_passkey" });
    const intent = String(asked.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": intent })).status,
    ).toBe(200);
    const removed = await browser.post(
      "/api/auth/passkey/delete-passkey",
      { id },
      { "fin-step-up-intent": intent },
    );
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    const event = (await h.events({ event: "passkey.removed" })).find((e) => e.target_id === id);
    expect(event?.step_up_ref).toBe(intent);
    const notices = (await h.outbox(email)).map((m) => String(m.params.kind ?? ""));
    expect(notices).toContain("passkey_removed");
  });
});

/** Waits until `n` backends of this test's database wait for a lock another transaction holds. */
async function lockWaiters(n: number): Promise<void> {
  for (let tries = 0; tries < 1000; tries += 1) {
    const waiting = await h.admin.query<{ n: number }>(
      `SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(waiting.rows[0]?.n ?? 0) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${n} backends never waited for a lock`);
}

describe("a passkey sign-in while that passkey is removed (§5.3, §6.7)", () => {
  it("finds the passkey gone and makes no session, and the removal goes through", async () => {
    const { browser, authenticator } = await personWithPasskey("removed.inflight");
    const owned = await h.admin.query<{ id: string }>(
      "SELECT p.id FROM identity.passkey p JOIN identity.session s ON s.user_id = p.user_id WHERE s.token = $1",
      [browser.sessionToken()],
    );
    const id = String(owned.rows[0]?.id);
    const asked = await browser.post("/api/auth/passkey/delete-passkey", { id });
    const intent = String(asked.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": intent })).status,
    ).toBe(200);
    // Whoever holds the lost device makes an assertion with the passkey in another browser.
    const device = h.browser();
    const challenge = await device.get("/api/auth/passkey/generate-authenticate-options");
    const response = authenticator.authenticate(String(challenge.json?.challenge));
    // The removal is held after it has deleted the passkey, before it commits: another transaction
    // holds the row of the intent it spends last.
    const holder = await h.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM ops.step_up_intent WHERE id = $1 FOR UPDATE", [intent]);
      const removing = browser.post(
        "/api/auth/passkey/delete-passkey",
        { id },
        { "fin-step-up-intent": intent },
      );
      removing.catch(() => undefined);
      await lockWaiters(1);
      const signingIn = device.post("/api/auth/passkey/verify-authentication", { response });
      signingIn.catch(() => undefined);
      await lockWaiters(2);
      await holder.query("ROLLBACK");
      const [removed, signedIn] = await Promise.all([removing, signingIn]);

      expect(removed.status, JSON.stringify(removed.json)).toBe(200);
      expect(signedIn.status).toBe(401);
      expect(device.sessionToken()).toBeNull();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    expect(
      (await h.admin.query("SELECT 1 FROM identity.passkey WHERE id = $1", [id])).rowCount,
    ).toBe(0);
  });
});

/** The answer, or a failure once it has waited two seconds (on a row another transaction holds). */
function promptly<T>(answer: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the answer waited on a held row")), 2000);
  });
  return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}

describe("a passkey assertion before the library checks it (§5.3, §5.6)", () => {
  it("holds no row with no challenge, or past its network's allowance, and answers at once while a change holds the person's row", async () => {
    const { authenticator, email } = await personWithPasskey("unproven");
    const owner = await h.admin.query<{ id: string }>(
      'SELECT id FROM identity."user" WHERE email = $1',
      [email],
    );
    // A change to the person's factors holds their row, as a removal does.
    const holder = await h.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query('SELECT 1 FROM identity."user" WHERE id = $1 FOR UPDATE', [
        owner.rows[0]?.id,
      ]);
      // The credential's own signature, from a browser that holds no challenge.
      const cold = await promptly(
        h.browser().post("/api/auth/passkey/verify-authentication", {
          response: authenticator.authenticate("Y2hhbGxlbmdl"),
        }),
      );
      expect(cold.status).toBe(400);
      expect(cold.json).toMatchObject({ code: "CHALLENGE_NOT_FOUND" });
      // The credential's own signature over a live challenge, from a network that has used up its
      // allowance.
      const device = h.browser();
      let tries = 0;
      for (; tries < 40; tries += 1) {
        const tried = await device.post("/api/auth/passkey/verify-authentication", {
          response: { id: "x" },
        });
        if (tried.status === 429) break;
      }
      expect(tries).toBeLessThan(40);
      const options = await device.get("/api/auth/passkey/generate-authenticate-options");
      const limited = await promptly(
        device.post("/api/auth/passkey/verify-authentication", {
          response: authenticator.authenticate(String(options.json?.challenge)),
        }),
      );
      expect(limited.status).toBe(429);
      expect(limited.json).toMatchObject({ code: "rate_limited" });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    // The credential still signs in once nothing holds its owner's row.
    expect((await passkeyCeremony(h.browser(), authenticator)).status).toBe(200);
  });

  it("never holds up the person's own sign-in while another assertion naming them is in flight", async () => {
    const { authenticator } = await personWithPasskey("unqueued");
    // Another browser's assertion naming the credential, held up inside the library (another
    // transaction holds its challenge), so it holds the person's row meanwhile.
    const other = h.browser();
    const challenge = await other.get("/api/auth/passkey/generate-authenticate-options");
    const asserted = authenticator.authenticate(String(challenge.json?.challenge));
    const row = await h.admin.query<{ id: string }>(
      "SELECT id FROM identity.verification ORDER BY id DESC LIMIT 1",
    );
    const blocker = await h.admin.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM identity.verification WHERE id = $1 FOR UPDATE", [
        row.rows[0]?.id,
      ]);
      const inFlight = other.post("/api/auth/passkey/verify-authentication", {
        response: asserted,
      });
      inFlight.catch(() => undefined);
      await lockWaiters(1);
      // The person signs in from their own browser meanwhile, and is not kept waiting.
      const own = await promptly(passkeyCeremony(h.browser(), authenticator));
      expect(own.status, JSON.stringify(own.json)).toBe(200);
      await blocker.query("ROLLBACK");
      // The held assertion's counter is behind the one just used, so it is refused.
      expect((await inFlight).status).not.toBe(200);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });
});

describe("a passkey step-up (§11.3)", () => {
  it("replaces the session, keeps its absolute limit and moves its proofs", async () => {
    const { browser, authenticator } = await personWithPasskey("stepup");
    const before = await session(browser);
    const stepped = await passkeyCeremony(browser, authenticator);
    expect(stepped.status, JSON.stringify(stepped.json)).toBe(200);
    const after = await session(browser);
    expect(after?.id).not.toBe(before?.id);
    expect(after?.created_via).toBe("replacement");
    expect(after?.absolute_expires_at.getTime()).toBe(before?.absolute_expires_at.getTime());
    const old = await h.admin.query("SELECT 1 FROM identity.session WHERE id = $1", [before?.id]);
    expect(old.rowCount).toBe(0);
    const proofs = await h.admin.query(
      "SELECT count(*)::int AS n FROM identity.assurance WHERE session_id = $1",
      [after?.id],
    );
    expect(proofs.rows[0]?.n).toBeGreaterThanOrEqual(2);
    const passed = (await h.events({ event: "step_up.passed" })).find(
      (e) => e.target_id === after?.id,
    );
    expect(passed?.metadata).toMatchObject({
      method: "passkey",
      kind: "window",
      replacedSessionId: before?.id,
    });
  });

  it("keeps the organisation the session was in", async () => {
    const { browser, authenticator, email } = await personWithPasskey("org.keep");
    const owner = await h.admin.query<{ id: string }>(
      'SELECT id FROM identity."user" WHERE email = $1',
      [email],
    );
    const org = newId("org", systemClock);
    await seed(
      h.admin,
      "INSERT INTO identity.organization (id, name, created_by) VALUES ($1, 'Acme', $2)",
      [org, owner.rows[0]?.id],
    );
    await seed(
      h.admin,
      "UPDATE identity.session SET current_organization_id = $2 WHERE token = $1",
      [browser.sessionToken(), org],
    );
    expect((await passkeyCeremony(browser, authenticator)).status).toBe(200);
    const after = await h.admin.query(
      "SELECT created_via, current_organization_id FROM identity.session WHERE token = $1",
      [browser.sessionToken()],
    );
    expect(after.rows).toEqual([{ created_via: "replacement", current_organization_id: org }]);
  });

  it("refuses another person's passkey, keeps the old session and deletes the new one (AC-SAT-06)", async () => {
    const victim = await personWithPasskey("victim");
    const intruder = await personWithPasskey("intruder");
    const before = await session(victim.browser);
    const refused = await passkeyCeremony(victim.browser, intruder.authenticator);
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "step_up_invalid", reason: "other_person" });
    expect((await session(victim.browser))?.id).toBe(before?.id);
    const failed = (await h.events({ event: "step_up.failed" })).find(
      (e) => e.target_id === before?.id,
    );
    expect(failed?.metadata).toMatchObject({ method: "passkey", reason: "other_person" });
    const orphan = await h.admin.query(
      'SELECT count(*)::int AS n FROM identity.session s JOIN identity."user" u ON u.id = s.user_id WHERE u.email = $1',
      [intruder.email],
    );
    // The intruder's own session stays; the one the ceremony made in the victim's browser is gone.
    expect(orphan.rows[0]?.n).toBe(1);
  });
});

describe("the GETs of a passkey ceremony ([SA-44], §2.3)", () => {
  it("never make an intent or spend a budget; the gated POST makes the intent", async () => {
    const { browser, authenticator } = await personWithPasskey("get.intent");
    const sessionId = (await session(browser))?.id;
    // More GETs than a session may make intents in ten minutes: none makes one.
    for (let i = 0; i < 31; i += 1) {
      const asked = await browser.get("/api/auth/passkey/generate-register-options");
      expect(asked.status).toBe(403);
      expect(asked.json).toMatchObject({
        code: "step_up_required",
        step_up_kind: "intent",
        reason_key: "add_passkey",
      });
      expect(asked.json?.intent_id).toBeUndefined();
    }
    const made = await h.admin.query(
      "SELECT count(*)::int AS n FROM ops.step_up_intent WHERE session_id = $1",
      [sessionId],
    );
    expect(made.rows[0]?.n).toBe(0);
    // The POST that adds the passkey makes the intent; the GET checks it; the POST consumes it.
    const minted = await browser.post("/api/auth/passkey/verify-registration", {});
    expect(minted.status).toBe(403);
    expect(minted.json).toMatchObject({ code: "step_up_required", reason_key: "add_passkey" });
    const intent = String(minted.json?.intent_id);
    expect(
      (await passkeyCeremony(browser, authenticator, { "fin-step-up-intent": intent })).status,
    ).toBe(200);
    const { verify } = await registerPasskey(browser, h.authenticator(), {
      "fin-step-up-intent": intent,
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect(
      (await h.events({ event: "passkey.added" })).some((e) => e.target_id === verify.json?.id),
    ).toBe(true);
  });

  it("never spend the person's method_add allowance", async () => {
    const browser = h.browser();
    await codeSignIn(h, browser, unique("get.method_add"));
    for (let i = 0; i < 21; i += 1) {
      expect((await browser.get("/api/auth/passkey/generate-register-options")).status).toBe(200);
    }
    const enable = await browser.post("/api/auth/two-factor/enable", {});
    expect(enable.status, JSON.stringify(enable.json)).toBe(200);
  });

  it("never spend the network's passkey sign-in allowance", async () => {
    const browser = h.browser();
    for (let i = 0; i < 31; i += 1) {
      const options = await browser.get("/api/auth/passkey/generate-authenticate-options");
      expect(options.status).toBe(200);
    }
    const verify = await browser.post("/api/auth/passkey/verify-authentication", {
      response: { id: "x" },
    });
    expect(verify.status).not.toBe(429);
  });
});
