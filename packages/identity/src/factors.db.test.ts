// The authenticator, backup codes and the factor step (spec 02 §5.4, §6.1, §6.6, §6.7;
// T-SAT-27, T-SAT-28): set-up raises the session; a code sign-in of a person with a factor is
// aal1 and reaches only the factor step; a right code raises it and writes a proof; a TOTP step is
// accepted once; 10 wrong codes lock the person out for an hour; a trusted browser gives an aal1
// working session that writes no proof; the last factor stays for a privileged developer.
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
  totpFromUri,
  warmUp,
} from "../test/harness.ts";
import { revokeTrustedBrowsers } from "./browsers.ts";
import { mixesLettersAndDigits } from "./crypto/backup-codes.ts";
import { hotp, totp, totpStep } from "./crypto/totp.ts";
import { systemClock } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";

let database: TestDatabase;
let h: Harness;

beforeAll(async () => {
  database = await createTestDatabase("factors");
  h = await createHarness(database, "developer");
});

// The realm's one-time start, so that the first test's time is its own (test/harness.ts).
beforeAll(async () => {
  await warmUp(h);
});

afterAll(async () => {
  await database.drop();
}, DROP_TIMEOUT_MS);

async function sessionRow(browser: Browser) {
  const result = await h.admin.query<{
    id: string;
    assurance: string;
    expires_at: Date;
    created_at: Date;
    trusted_browser_id: string | null;
  }>(
    "SELECT id, assurance, expires_at, created_at, trusted_browser_id FROM identity.session WHERE token = $1",
    [browser.sessionToken()],
  );
  return result.rows[0];
}

async function userId(email: string): Promise<string> {
  const result = await h.admin.query<{ id: string }>(
    'SELECT id FROM identity."user" WHERE email = $1',
    [email],
  );
  return result.rows[0]?.id as string;
}

/** Makes the person an Admin of a new organisation (L-SAT-03's tables, seeded directly). */
async function makePrivileged(id: string): Promise<void> {
  const org = newId("org", systemClock);
  await seed(
    h.admin,
    "INSERT INTO identity.organization (id, name, created_by) VALUES ($1, 'Acme', $2)",
    [org, id],
  );
  await seed(
    h.admin,
    "INSERT INTO identity.member (id, organization_id, user_id, role_key) VALUES ($1, $2, $3, 'admin')",
    [newId("mem", systemClock), org, id],
  );
}

describe("setting up an authenticator", () => {
  it("returns the URI and 10 backup codes, and finishing it raises the session with its events", async () => {
    const browser = h.browser();
    const email = "totp.setup@example.com";
    await codeSignIn(h, browser, email);
    const { enable, verify, backupCodes } = await setUpAuthenticator(browser);
    expect(enable.json?.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(new URL(String(enable.json?.totpURI)).searchParams.get("issuer")).toBe("Fin (test)");
    expect(backupCodes).toHaveLength(10);
    // The realm's generator: each code mixes letters and digits (crypto/backup-codes.ts), so none
    // is also a double-barrelled name's shape that an email's name field would show (T08-23).
    for (const code of backupCodes) {
      expect(code).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
      expect(mixesLettersAndDigits(code), code).toBe(true);
    }
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    expect((await sessionRow(browser))?.assurance).toBe("aal2");
    const events = (await h.events()).map((e) => e.event);
    expect(events).toContain("two_factor.setup_started");
    expect(events).toContain("two_factor.enabled");
    const notices = (await h.outbox(email)).map(
      (m) => `${m.template}:${String(m.params.kind ?? "")}`,
    );
    expect(notices).toContain("identity/sign-in-methods-changed:authenticator_on");
  });
});

/** A new person with a finished authenticator; each test gets its own, within the allowances. */
async function personWithAuthenticator(label: string) {
  const email = `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;
  const first = h.browser();
  await codeSignIn(h, first, email);
  const setup = await setUpAuthenticator(first);
  return { email, first, secret: setup.secret, backupCodes: setup.backupCodes };
}

describe("the factor step", () => {
  it("holds a code sign-in at aal1, reaching only the factor-step endpoints", async () => {
    const { email } = await personWithAuthenticator("factor.step");
    const browser = h.browser();
    const signedIn = await codeSignIn(h, browser, email);
    expect(signedIn.status).toBe(200);
    const row = await sessionRow(browser);
    expect(row?.assurance).toBe("aal1");
    // The factor step lives 10 minutes (S2-07).
    expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBeLessThanOrEqual(
      10 * 60_000 + 1000,
    );
    const refused = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "factor_step_required" });
    expect(refused.json?.methods).toEqual(["authenticator", "backup_code"]);
    expect((await h.events({ event: "sign_in.second_factor_required" })).length).toBeGreaterThan(0);
    expect(h.lines.named("auth.gate_refused").at(-1)).toMatchObject({
      realm: "developer",
      state: "factor_step",
    });
  });

  it("raises the session with a right code, writes a proof, and refuses the same step twice", async () => {
    const { email, secret } = await personWithAuthenticator("replay");
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const step = totpStep(new Date()) + 1n;
    const code = hotp(secret, step);
    const right = await browser.post("/api/auth/two-factor/verify-totp", { code });
    expect(right.status, JSON.stringify(right.json)).toBe(200);
    const row = await sessionRow(browser);
    expect(row?.assurance).toBe("aal2");
    const proofs = await h.admin.query(
      "SELECT method FROM identity.assurance WHERE session_id = $1",
      [row?.id],
    );
    expect(proofs.rows).toEqual([{ method: "totp" }]);
    expect(
      (await h.events({ event: "session.created" })).some((e) => e.metadata.method === "totp"),
    ).toBe(true);

    // The same code again, in another sign-in: the library would accept it; Fin refuses it.
    const other = h.browser();
    expect((await codeSignIn(h, other, email)).status).toBe(200);
    const replay = await other.post("/api/auth/two-factor/verify-totp", { code });
    expect(replay.status).toBe(401);
    expect(replay.json).toMatchObject({ code: "INVALID_CODE" });
    expect((await sessionRow(other))?.assurance).toBe("aal1");
  });

  it("passes with a backup code once, and records how many are left", async () => {
    const { email, backupCodes } = await personWithAuthenticator("backup");
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const code = backupCodes[0] as string;
    const used = await browser.post("/api/auth/two-factor/verify-backup-code", { code });
    expect(used.status, JSON.stringify(used.json)).toBe(200);
    expect((await sessionRow(browser))?.assurance).toBe("aal2");
    const event = (await h.events({ event: "backup_code.used" })).at(-1);
    expect(event?.metadata).toEqual({ remaining: 9 });
    const again = h.browser();
    expect((await codeSignIn(h, again, email)).status).toBe(200);
    const reused = await again.post("/api/auth/two-factor/verify-backup-code", { code });
    expect(reused.status).not.toBe(200);
  });

  it("locks the person out after 10 wrong codes, with sign_in.locked and one notice", async () => {
    const { email } = await personWithAuthenticator("locked");
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    for (let i = 0; i < 10; i += 1) {
      const wrong = await browser.post("/api/auth/two-factor/verify-totp", { code: "000000" });
      expect(wrong.status).toBe(401);
    }
    const locked = await browser.post("/api/auth/two-factor/verify-totp", { code: "000000" });
    expect(locked.status).toBe(429);
    expect(locked.json).toMatchObject({ code: "ACCOUNT_TEMPORARILY_LOCKED" });
    // A sign-in from elsewhere is locked too: the lockout is the person's, in a logged table.
    const elsewhere = h.browser();
    expect((await codeSignIn(h, elsewhere, email)).status).toBe(200);
    const stillLocked = await elsewhere.post("/api/auth/two-factor/verify-totp", {
      code: "123456",
    });
    expect(stillLocked.status).toBe(429);
    expect((await h.events({ event: "sign_in.locked" })).length).toBe(1);
    expect(
      (await h.events({ event: "sign_in.second_factor_failed" })).length,
    ).toBeGreaterThanOrEqual(10);
    const notices = (await h.outbox(email)).filter((m) => m.template === "identity/account-locked");
    expect(notices).toHaveLength(1);
  });
});

describe("trusted browsers ([SA-31], §6.6)", () => {
  it("gives a later code sign-in an aal1 working session with no proof, until the person is privileged", async () => {
    const email = "trusted.browser@example.com";
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const { secret } = await setUpAuthenticator(browser);
    // Sign in again in the same browser and ask to trust it at the factor step.
    await browser.post("/api/auth/sign-out");
    await codeSignIn(h, browser, email);
    const code = hotp(secret, totpStep(new Date()) + 1n);
    const trusted = await browser.post("/api/auth/two-factor/verify-totp", {
      code,
      trustDevice: true,
    });
    expect(trusted.status, JSON.stringify(trusted.json)).toBe(200);
    expect(trusted.setCookies.some((c) => c.startsWith("__Host-fin.trusted_browser="))).toBe(true);
    expect(trusted.setCookies.some((c) => c.startsWith("__Host-fin.trust_device="))).toBe(false);
    expect((await h.events({ event: "browser.trusted" })).length).toBe(1);

    await browser.post("/api/auth/sign-out");
    await codeSignIn(h, browser, email);
    const row = await sessionRow(browser);
    expect(row?.assurance).toBe("aal1");
    expect(row?.trusted_browser_id).not.toBeNull();
    const proofs = await h.admin.query("SELECT 1 FROM identity.assurance WHERE session_id = $1", [
      row?.id,
    ]);
    expect(proofs.rowCount).toBe(0);
    // A working session: a factor-step-only path is not refused at the gate.
    const working = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(working.json).toMatchObject({ code: "step_up_required" });

    // Privileged anywhere: the next request is at the factor step (S2-40).
    await makePrivileged(await userId(email));
    const held = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(held.status).toBe(403);
    expect(held.json).toMatchObject({ code: "factor_step_required" });
  });
});

describe("revoking trusted browsers (§6.6)", () => {
  it("revokes them on a factor change, one browser.trust_revoked each", async () => {
    const email = `revoke.trust.${Math.random().toString(36).slice(2, 8)}@example.com`;
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const { secret } = await setUpAuthenticator(browser);
    await browser.post("/api/auth/sign-out");
    await codeSignIn(h, browser, email);
    await browser.post("/api/auth/two-factor/verify-totp", {
      code: hotp(secret, totpStep(new Date()) + 1n),
    });
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    const trust = h.browser();
    await codeSignIn(h, trust, email);
    const trusted = await trust.post("/api/auth/two-factor/verify-totp", {
      code: hotp(secret, totpStep(new Date())),
      trustDevice: true,
    });
    expect(trusted.status, JSON.stringify(trusted.json)).toBe(200);
    const id = (await h.events({ event: "browser.trusted" })).at(-1)?.target_id;
    // A passkey added from the working session is a factor change.
    const add = await browser.post("/api/auth/passkey/verify-registration", {});
    const intent = String(add.json?.intent_id);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    await browser.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date())) },
      { "fin-step-up-intent": intent },
    );
    const authenticator = h.authenticator();
    const options = await browser.get("/api/auth/passkey/generate-register-options", {
      "fin-step-up-intent": intent,
    });
    const response = authenticator.register(
      options.json as { challenge: string; user: { id: string } },
    );
    const added = await browser.post(
      "/api/auth/passkey/verify-registration",
      { response },
      { "fin-step-up-intent": intent },
    );
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    const revoked = (await h.events({ event: "browser.trust_revoked" })).find(
      (e) => e.target_id === id,
    );
    expect(revoked?.metadata).toEqual({ reason: "factor_changed" });
    const row = await h.admin.query(
      "SELECT revoked_reason FROM identity.trusted_browser WHERE id = $1",
      [id],
    );
    expect(row.rows[0]?.revoked_reason).toBe("factor_changed");
  });
});

describe("the last factor (§6.7)", () => {
  it("is never removed for a privileged developer", async () => {
    const email = "last.factor@example.com";
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const { secret } = await setUpAuthenticator(browser);
    await makePrivileged(await userId(email));
    // The disable path needs an intent; prove one, then the rule refuses.
    const first = await browser.post("/api/auth/two-factor/disable", {});
    expect(first.json).toMatchObject({ code: "step_up_required" });
    const intent = String(first.json?.intent_id);
    const proof = await browser.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date()) + 1n) },
      { "fin-step-up-intent": intent },
    );
    expect(proof.status, JSON.stringify(proof.json)).toBe(200);
    const refused = await browser.post(
      "/api/auth/two-factor/disable",
      {},
      { "fin-step-up-intent": intent },
    );
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "last_factor" });
    const still = await h.admin.query(
      "SELECT verified FROM identity.two_factor WHERE user_id = $1",
      [await userId(email)],
    );
    expect(still.rows).toEqual([{ verified: true }]);
  });

  it("may be removed by a developer who is not privileged, with its events", async () => {
    const email = "remove.factor@example.com";
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const { secret } = await setUpAuthenticator(browser);
    const first = await browser.post("/api/auth/two-factor/disable", {});
    const intent = String(first.json?.intent_id);
    await browser.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date()) + 1n) },
      { "fin-step-up-intent": intent },
    );
    const removed = await browser.post(
      "/api/auth/two-factor/disable",
      {},
      { "fin-step-up-intent": intent },
    );
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    expect((await h.events({ event: "two_factor.disabled" })).length).toBeGreaterThan(0);
    const left = await h.admin.query("SELECT 1 FROM identity.two_factor WHERE user_id = $1", [
      await userId(email),
    ]);
    expect(left.rowCount).toBe(0);
  });
});

/** A person with a passkey who began an authenticator set-up with an intent and stopped. */
async function personWithUnfinishedAuthenticator(label: string) {
  const email = `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;
  const owner = h.browser();
  await codeSignIn(h, owner, email);
  const authenticator = h.authenticator();
  const { verify } = await registerPasskey(owner, authenticator);
  expect(verify.status, JSON.stringify(verify.json)).toBe(200);
  const asked = await owner.post("/api/auth/two-factor/enable", {});
  expect(asked.json).toMatchObject({ code: "step_up_required" });
  const intent = String(asked.json?.intent_id);
  const proved = await passkeyCeremony(owner, authenticator, { "fin-step-up-intent": intent });
  expect(proved.status, JSON.stringify(proved.json)).toBe(200);
  const enabled = await owner.post(
    "/api/auth/two-factor/enable",
    {},
    { "fin-step-up-intent": intent },
  );
  expect(enabled.status, JSON.stringify(enabled.json)).toBe(200);
  return {
    email,
    owner,
    secret: totpFromUri(String(enabled.json?.totpURI)).secret,
    backupCodes: (enabled.json?.backupCodes as string[] | undefined) ?? [],
  };
}

describe("an authenticator whose set-up is not finished (§5.4, §6.1)", () => {
  it("is no factor at the factor step: its code and its backup codes pass nothing", async () => {
    const { email, secret, backupCodes } = await personWithUnfinishedAuthenticator("unfinished");
    const id = await userId(email);
    // Someone holding only the mailbox signs in by code: aal1, at the factor step (a passkey).
    const other = h.browser();
    expect((await codeSignIn(h, other, email)).status).toBe(200);
    expect((await sessionRow(other))?.assurance).toBe("aal1");
    const right = await other.post("/api/auth/two-factor/verify-totp", {
      code: totp(secret, new Date()),
    });
    expect(right.status).toBe(400);
    expect(right.json).toMatchObject({ code: "TOTP_NOT_ENABLED" });
    const backup = await other.post("/api/auth/two-factor/verify-backup-code", {
      code: backupCodes[0],
    });
    expect(backup.status).toBe(400);
    expect(backup.json).toMatchObject({ code: "BACKUP_CODES_NOT_ENABLED" });
    expect((await sessionRow(other))?.assurance).toBe("aal1");
    const gated = await other.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(gated.json).toMatchObject({ code: "factor_step_required" });
    const row = await h.admin.query("SELECT verified FROM identity.two_factor WHERE user_id = $1", [
      id,
    ]);
    expect(row.rows).toEqual([{ verified: false }]);
    expect(
      (await h.events({ event: "two_factor.enabled" })).filter((e) => e.ref_ids.includes(id)),
    ).toHaveLength(0);
  });

  it("counts wrong codes while it is being finished toward the person's lockout", async () => {
    const { email, owner, secret } = await personWithUnfinishedAuthenticator("unfinished.lock");
    const id = await userId(email);
    for (let i = 0; i < 10; i += 1) {
      const wrong = await owner.post("/api/auth/two-factor/verify-totp", { code: "000000" });
      expect(wrong.status).toBe(401);
    }
    const locked = await owner.post("/api/auth/two-factor/verify-totp", {
      code: totp(secret, new Date()),
    });
    expect(locked.status).toBe(429);
    expect(locked.json).toMatchObject({ code: "ACCOUNT_TEMPORARILY_LOCKED" });
    expect((await h.events({ event: "sign_in.locked" })).some((e) => e.target_id === id)).toBe(
      true,
    );
    // Finishing a set-up is neither the factor step nor a step-up: neither failure is written.
    for (const event of ["sign_in.second_factor_failed", "step_up.failed"]) {
      const written = (await h.events({ event })).filter(
        (e) => e.target_id === id || e.ref_ids.includes(id),
      );
      expect(written, event).toHaveLength(0);
    }
  });

  it("is finished by the working session that began it", async () => {
    const { email, owner, secret } = await personWithUnfinishedAuthenticator("unfinished.own");
    const id = await userId(email);
    const finished = await owner.post("/api/auth/two-factor/verify-totp", {
      code: totp(secret, new Date()),
    });
    expect(finished.status, JSON.stringify(finished.json)).toBe(200);
    const row = await h.admin.query("SELECT verified FROM identity.two_factor WHERE user_id = $1", [
      id,
    ]);
    expect(row.rows).toEqual([{ verified: true }]);
    expect(
      (await h.events({ event: "two_factor.enabled" })).some((e) => e.ref_ids.includes(id)),
    ).toBe(true);
  });
});

describe("a TOTP step is accepted once ([SA-35])", () => {
  it("even when several sessions send the same code at the same moment", async () => {
    const { email, first, secret } = await personWithAuthenticator("concurrent");
    // Three factor-step sessions of the person, each on its own network.
    await first.post("/api/auth/sign-out");
    const sessions = [first, h.browser(), h.browser()];
    for (const browser of sessions) expect((await codeSignIn(h, browser, email)).status).toBe(200);
    // Open a connection for each first, so the three requests really run side by side.
    await Promise.all(sessions.map((browser) => browser.get("/api/auth/get-session")));
    const code = hotp(secret, totpStep(new Date()) + 1n);
    const answers = await Promise.all(
      sessions.map((browser) => browser.post("/api/auth/two-factor/verify-totp", { code })),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 401, 401]);
    const assurances = await Promise.all(
      sessions.map(async (b) => (await sessionRow(b))?.assurance),
    );
    expect(assurances.filter((a) => a === "aal2")).toHaveLength(1);
  });
});

describe("a trusted-browser session (§6.6, S2-40)", () => {
  it("stops being a working session once its row is revoked or expires", async () => {
    const email = `trust.ends.${Math.random().toString(36).slice(2, 8)}@example.com`;
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const { secret } = await setUpAuthenticator(browser);
    const trustAgain = async () => {
      await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
      await browser.post("/api/auth/sign-out");
      await codeSignIn(h, browser, email);
      const trusted = await browser.post("/api/auth/two-factor/verify-totp", {
        code: hotp(secret, totpStep(new Date())),
        trustDevice: true,
      });
      expect(trusted.status, JSON.stringify(trusted.json)).toBe(200);
      await browser.post("/api/auth/sign-out");
      await codeSignIn(h, browser, email);
      const row = await sessionRow(browser);
      expect(row?.trusted_browser_id).not.toBeNull();
      const working = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
      expect(working.json).toMatchObject({ code: "step_up_required" });
      return row?.trusted_browser_id as string;
    };
    const id = await userId(email);

    // "Forget this browser": the session it made is at the factor step from its next request.
    await trustAgain();
    await h.realm.run(browser.context(), async (tx) => {
      for (const revoked of await revokeTrustedBrowsers(tx, id, "by_person", new Date())) {
        await h.realm.runtime.audit(tx, {
          event: "browser.trust_revoked",
          actor: { kind: "user", id, via: "console" },
          target: revoked,
          refs: [id],
          subjectUserId: id,
          metadata: { reason: "by_person" },
        });
      }
    });
    const revoked = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(revoked.status).toBe(403);
    expect(revoked.json).toMatchObject({ code: "factor_step_required" });

    // A row past its 30 days counts for nothing either, before the sweep deletes it.
    const second = await trustAgain();
    await seed(
      h.admin,
      `UPDATE identity.trusted_browser SET created_at = now() - interval '31 days',
              expires_at = now() - interval '1 day' WHERE id = $1`,
      [second],
    );
    const expired = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(expired.status).toBe(403);
    expect(expired.json).toMatchObject({ code: "factor_step_required" });
  });
});

describe("a trusted-browser session that shows its factor (§6.1, §6.6)", () => {
  it("is raised by its own step-up, so a factor change it makes leaves it signed in", async () => {
    const email = `trust.raised.${Math.random().toString(36).slice(2, 8)}@example.com`;
    const browser = h.browser();
    await codeSignIn(h, browser, email);
    const { secret } = await setUpAuthenticator(browser);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    await browser.post("/api/auth/sign-out");
    await codeSignIn(h, browser, email);
    const trusted = await browser.post("/api/auth/two-factor/verify-totp", {
      code: hotp(secret, totpStep(new Date())),
      trustDevice: true,
    });
    expect(trusted.status, JSON.stringify(trusted.json)).toBe(200);
    await browser.post("/api/auth/sign-out");
    await codeSignIn(h, browser, email);
    const before = await sessionRow(browser);
    expect(before).toMatchObject({ assurance: "aal1" });
    expect(before?.trusted_browser_id).not.toBeNull();
    // Long past the factor step's 10 minutes: a trusted-browser session is a working session.
    await seed(
      h.admin,
      "UPDATE identity.session SET created_at = now() - interval '2 hours' WHERE id = $1",
      [before?.id],
    );

    // Adding a passkey: the POST makes the intent, and the authenticator proves it.
    const asked = await browser.post("/api/auth/passkey/verify-registration", {});
    expect(asked.json).toMatchObject({ code: "step_up_required" });
    const intent = String(asked.json?.intent_id);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    const proved = await browser.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date())) },
      { "fin-step-up-intent": intent },
    );
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
    // The signed-in check raises this same session (§6.1).
    expect(await sessionRow(browser)).toMatchObject({ id: before?.id, assurance: "aal2" });
    const { verify } = await registerPasskey(browser, h.authenticator(), {
      "fin-step-up-intent": intent,
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);

    // The factor change revoked the trusted browser (§6.6), and the session still works.
    const revoked = await h.admin.query<{ revoked_reason: string | null }>(
      "SELECT revoked_reason FROM identity.trusted_browser WHERE id = $1",
      [before?.trusted_browser_id],
    );
    expect(revoked.rows[0]?.revoked_reason).toBe("factor_changed");
    const next = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(next.json).toMatchObject({ code: "step_up_required" });
    expect(await sessionRow(browser)).toMatchObject({ id: before?.id, assurance: "aal2" });
  });
});

describe("a replaced session keeps the organisation it was in (§11.3)", () => {
  it("when finishing an authenticator replaces it", async () => {
    const browser = h.browser();
    const email = `org.totp.${Math.random().toString(36).slice(2, 8)}@example.com`;
    await codeSignIn(h, browser, email);
    const org = newId("org", systemClock);
    await seed(
      h.admin,
      "INSERT INTO identity.organization (id, name, created_by) VALUES ($1, 'Acme', $2)",
      [org, await userId(email)],
    );
    await seed(
      h.admin,
      "UPDATE identity.session SET current_organization_id = $2 WHERE token = $1",
      [browser.sessionToken(), org],
    );
    const { verify } = await setUpAuthenticator(browser);
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    const after = await h.admin.query(
      "SELECT created_via, current_organization_id FROM identity.session WHERE token = $1",
      [browser.sessionToken()],
    );
    expect(after.rows).toEqual([{ created_via: "replacement", current_organization_id: org }]);
  });
});

describe("TOTP secrets", () => {
  it("match the library's otpauth URI", () => {
    const uri =
      "otpauth://totp/Fin:a%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Fin";
    const { secret, code } = totpFromUri(uri, new Date(59_000));
    expect(new TextDecoder().decode(secret)).toBe("12345678901234567890");
    expect(code).toBe("287082");
  });
});
