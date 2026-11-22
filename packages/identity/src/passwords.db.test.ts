// Passwords in the developer realm on Postgres 18 (spec 02 §5.7, §6.3, §16.2, §17.2; [SA-06],
// [SA-07]; T-SAT-21, T-SAT-26, T-SAT-32, T-SAT-33):
//   - a password chosen at sign-up becomes the account's only once the mailbox is proved, hashed
//     with argon2id; a password sign-in is aal1, proves no mailbox and never enrols a first factor;
//   - a person with a factor stops at the factor step, in a session the realm keeps (the library's
//     own password challenge is never set), and passes it the signed-in way;
//   - wrong passwords from browsers the account does not know pause the address (per network, in
//     15 minutes and in an hour, and across networks), alike for registered and unknown
//     addresses, past a restart, with one notice a day; a known browser is never paused; of the
//     tries sent together for an address one is checked, the others are answered 503 at once;
//   - a reset by an emailed code, only in the browser that asked, ends every session (one a
//     sign-in, a passkey or a factor step made or changed as it ran included, each with its
//     event), revokes the trusted browsers, forgets the known browsers but its own, lifts the
//     authenticator lockout and the pauses, and tells the person;
//   - a change needs a step-up intent; every action writes its event in its own transaction;
//   - the counts and pauses are found by their keys, never by a scan of their tables;
//   - under a burst (one address's sign-ins, one network's, one address's sign-ups) the requests
//     that may hash never hold the pool's last two clients: the rest are answered 503 at once.
import { hashPassword, verifyPassword } from "@fin/crypto";
import type { Pool, PoolClient, QueryConfig } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  type Answer,
  type Browser,
  codeSignIn,
  createHarness,
  type Harness,
  passkeyCeremony,
  registerPasskey,
  setUpAuthenticator,
} from "../test/harness.ts";
import { hotp, totpStep } from "./crypto/totp.ts";
import { verifyWithWaiver } from "./passwords/flows.ts";
import { CLIENTS_KEPT_FREE, createPasswordHasher } from "./passwords/hasher.ts";
import { resetCodeLink } from "./passwords/links.ts";
import { DAY, HOUR, ManualClock, MINUTE, systemClock } from "./ports/clock.ts";
import { MemoryLineSink } from "./ports/log.ts";
import { createPgDatabase } from "./ports/pg-database.ts";
import { signUp } from "./sign-up.ts";

let database: TestDatabase;
let h: Harness;

const PASSWORDS_ON = { FIN_FEATURE_PASSWORDS: "on" };
const GOOD = "harbour light forty two";
const BETTER = "a quiet lighthouse at dusk";

beforeAll(async () => {
  database = await createTestDatabase("passwords");
  h = await createHarness(database, "developer", { env: PASSWORDS_ON });
});

afterAll(async () => {
  await database.drop();
});

const unique = (label: string) => `${label}.${Math.random().toString(36).slice(2, 8)}@example.com`;

async function userId(email: string): Promise<string | null> {
  const result = await h.admin.query<{ id: string }>(
    'SELECT id FROM identity."user" WHERE email = $1',
    [email],
  );
  return result.rows[0]?.id ?? null;
}

async function passwordHash(id: string): Promise<string | null> {
  const result = await h.admin.query<{ password: string | null }>(
    "SELECT password FROM identity.account WHERE user_id = $1 AND provider_id = 'credential'",
    [id],
  );
  return result.rows[0]?.password ?? null;
}

async function eventsFor(event: string, target: string) {
  return (await h.events({ event })).filter((e) => e.target_id === target);
}

/** Signs up with a password from a new browser and confirms the address there. */
async function signUpWithPassword(email: string, password = GOOD, on: Harness = h) {
  const browser = on.browser();
  const answer = await signUp(
    on.realm,
    browser.request("POST", "/api/sign-up", { name: "Ada Lovelace", email, password }),
    browser.context(),
    { name: "Ada Lovelace", email, password },
  );
  expect(answer.status).toBe(202);
  for (const cookie of answer.setCookies)
    browser.absorb(new Response(null, { headers: { "set-cookie": cookie } }));
  const code = await on.latestCode(email);
  const confirmed = await browser.post("/api/auth/sign-in/email-otp", { email, otp: code });
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  return browser;
}

const passwordSignIn = (browser: Browser, email: string, password: string) =>
  browser.post("/api/auth/sign-in/email", { email, password });
const requestReset = (browser: Browser, email: string) =>
  browser.post("/api/auth/email-otp/request-password-reset", { email });
const reset = (browser: Browser, email: string, otp: string, password = BETTER) =>
  browser.post("/api/auth/email-otp/reset-password", { email, otp, password });
const clearSignInLimit = () =>
  h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");

async function sessionOf(browser: Browser) {
  const result = await h.admin.query<{
    id: string;
    assurance: string;
    created_via: string;
    mailbox_proved_at: Date | null;
    trusted_browser_id: string | null;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT id, assurance, created_via, mailbox_proved_at, trusted_browser_id, expires_at,
            created_at
       FROM identity.session WHERE token = $1`,
    [browser.sessionToken()],
  );
  return result.rows[0] ?? null;
}

/** The person's sessions still in the table. */
async function liveSessions(id: string): Promise<string[]> {
  const result = await h.admin.query<{ id: string }>(
    "SELECT id FROM identity.session WHERE user_id = $1 ORDER BY id",
    [id],
  );
  return result.rows.map((r) => r.id);
}

/** Polls until `check` holds or `ms` pass; says which. */
async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

/** How many of this database's connections wait on a lock now. */
async function lockWaits(): Promise<number> {
  const result = await h.admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'",
    [database.name],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Real argon2id whose hashes or checks wait while the test holds them, so that two requests can be
 * set side by side: one inside its hash or check (its unit of work open), the other sent meanwhile.
 */
function heldWork() {
  const held = { hash: false, verify: false };
  const waiters: Record<"hash" | "verify", (() => void)[]> = { hash: [], verify: [] };
  const entered = { hash: 0, verify: 0 };
  const pass = async (kind: "hash" | "verify") => {
    entered[kind] += 1;
    if (held[kind]) await new Promise<void>((resolve) => waiters[kind].push(resolve));
  };
  return {
    entered,
    hold(kind: "hash" | "verify") {
      held[kind] = true;
    },
    release(kind: "hash" | "verify") {
      held[kind] = false;
      for (const resolve of waiters[kind].splice(0)) resolve();
    },
    work: {
      hash: async (password: string) => {
        await pass("hash");
        return hashPassword(password);
      },
      verify: async (hash: string, password: string) => {
        await pass("verify");
        return verifyPassword(hash, password);
      },
    },
  };
}

/** A harness whose hasher the test can hold, with room for every request it sends at once. */
async function heldHarness() {
  const held = heldWork();
  const harness = await createHarness(database, "developer", {
    env: PASSWORDS_ON,
    deps: {
      passwords: createPasswordHasher({
        lines: new MemoryLineSink(),
        concurrency: 8,
        queueLimit: 8,
        queueWaitMs: 30_000,
        work: held.work,
      }),
    },
  });
  return { held, harness };
}

/** The answer as a stranger sees it: status, body and header names but the request's own. */
function shape(answer: Answer) {
  return {
    status: answer.status,
    json: answer.json,
    headers: [...answer.headers.keys()].filter((k) => k !== "set-cookie").sort(),
  };
}

describe("a password chosen at sign-up", () => {
  it("becomes the account's argon2id password once the mailbox is proved, under user.created", async () => {
    const email = unique("signup");
    const browser = await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const hash = await passwordHash(id);
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    // The credential row is accepted by the account table's audit guard under user.created.
    expect(await eventsFor("user.created", id)).toHaveLength(1);
    // The sign-up request never held the password, only its hash.
    const kept = await h.admin.query<{ password_hash: string }>(
      "SELECT password_hash FROM identity.sign_up_request WHERE email = $1",
      [email],
    );
    expect(kept.rows[0]?.password_hash).toBe(hash);
    expect(JSON.stringify(await h.outbox(email))).not.toContain(GOOD);
    expect((await sessionOf(browser))?.created_via).toBe("email_otp");
  });

  it("is refused before any allowance when it is too short or common", async () => {
    for (const [password, problem] of [
      ["short pass", "password_too_short"],
      ["password1234", "password_common"],
      ["qwertyuiop12", "password_common"],
      ["aaaaaaaaaaaaaaaa", "password_common"],
    ] as const) {
      const browser = h.browser();
      const email = unique("weak");
      await expect(
        signUp(h.realm, browser.request("POST", "/api/sign-up", {}), browser.context(), {
          name: "Ada Lovelace",
          email,
          password,
        }),
      ).rejects.toMatchObject({ code: "invalid", extensions: { fields: ["password"], problem } });
    }
  });

  it("answers a registered address exactly as an unknown one (T-SAT-32)", async () => {
    const registered = unique("registered");
    await signUpWithPassword(registered);
    const run = async (email: string) => {
      const b = h.browser();
      const answer = await signUp(h.realm, b.request("POST", "/api/sign-up", {}), b.context(), {
        name: "Ada Lovelace",
        email,
        password: BETTER,
      });
      return { status: answer.status, body: answer.body, cookies: answer.setCookies.length };
    };
    expect(await run(registered)).toEqual(await run(unique("fresh")));
  });
});

describe("a password sign-in", { timeout: 30_000 }, () => {
  it("makes an aal1 session that proves no mailbox, so it cannot enrol a first factor (§6.3)", async () => {
    const email = unique("plain");
    await signUpWithPassword(email);
    const browser = h.browser();
    const answer = await passwordSignIn(browser, email, GOOD);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    const session = await sessionOf(browser);
    expect(session).toMatchObject({ assurance: "aal1", created_via: "password" });
    expect(session?.mailbox_proved_at).toBeNull();
    const id = (await userId(email)) as string;
    const created = (await h.events({ event: "session.created" })).find(
      (e) => e.target_id === session?.id,
    );
    expect(created?.metadata).toEqual({
      method: "password",
      assurance: "aal1",
      trustedBrowser: false,
    });
    expect(created?.ref_ids).toContain(id);
    // A new browser: the new-sign-in notice, and a known-browser cookie.
    expect((await h.outbox(email)).map((m) => m.template)).toContain("identity/new-sign-in");
    expect(answer.setCookies.some((c) => c.startsWith("__Host-fin.known_browser="))).toBe(true);
    // The first factor needs a sign-in that proved the mailbox.
    const enrol = await browser.post("/api/auth/two-factor/enable", {});
    expect(enrol.status).toBe(403);
    expect(enrol.json).toMatchObject({ code: "fresh_session_required" });
    const passkey = await browser.get("/api/auth/passkey/generate-register-options");
    expect(passkey.json).toMatchObject({ code: "fresh_session_required" });
  });

  it("stops a person with an authenticator at the factor step, in a session the realm keeps", async () => {
    const email = unique("factor");
    const signedUp = await signUpWithPassword(email);
    const { secret } = await setUpAuthenticator(signedUp);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    const browser = h.browser();
    const answer = await passwordSignIn(browser, email, GOOD);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    // Pinned (SP-10): no library challenge; the session is Fin's factor-step session.
    expect(answer.json?.twoFactorRedirect).toBeUndefined();
    expect(answer.setCookies.some((c) => c.startsWith("__Host-fin.two_factor="))).toBe(false);
    expect(answer.setCookies.some((c) => c.startsWith("__Host-fin.session_token="))).toBe(true);
    const session = await sessionOf(browser);
    expect(session).toMatchObject({ assurance: "aal1", created_via: "password" });
    // 10 minutes at the factor step (S2-07).
    expect(
      (session?.expires_at.getTime() ?? 0) - (session?.created_at.getTime() ?? 0),
    ).toBeLessThanOrEqual(10 * MINUTE + 1000);
    const required = (await h.events({ event: "sign_in.second_factor_required" })).find(
      (e) => e.target_id === session?.id,
    );
    expect(required?.metadata).toEqual({ methods: ["authenticator", "backup_code"] });
    // Nothing else is reachable until the factor is shown.
    const blocked = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(blocked.json).toMatchObject({ code: "factor_step_required" });
    const passed = await browser.post("/api/auth/two-factor/verify-totp", {
      code: hotp(secret, totpStep(new Date())),
    });
    expect(passed.status, JSON.stringify(passed.json)).toBe(200);
    expect((await sessionOf(browser))?.assurance).toBe("aal2");
  });

  it("from a browser the person trusts, is a working aal1 session for the day, made from that row (§6.6)", async () => {
    const email = unique("trusted");
    const owner = await signUpWithPassword(email);
    const { secret } = await setUpAuthenticator(owner);
    const id = (await userId(email)) as string;
    // A password sign-in in a new browser stops at the factor step, where the person trusts it.
    const browser = h.browser();
    expect((await passwordSignIn(browser, email, GOOD)).status).toBe(200);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    const trusted = await browser.post("/api/auth/two-factor/verify-totp", {
      code: hotp(secret, totpStep(new Date())),
      trustDevice: true,
    });
    expect(trusted.status, JSON.stringify(trusted.json)).toBe(200);
    const row = (await h.events({ event: "browser.trusted" })).find((e) => e.ref_ids.includes(id));
    expect(row?.target_id).toMatch(/^tbr_/);
    expect((await browser.post("/api/auth/sign-out")).status).toBe(200);

    // The next password sign-in there skips the factor step.
    const answer = await passwordSignIn(browser, email, GOOD);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    const session = await sessionOf(browser);
    expect(session).toMatchObject({
      assurance: "aal1",
      created_via: "password",
      mailbox_proved_at: null,
      trusted_browser_id: row?.target_id,
    });
    const lifetime = (session?.expires_at.getTime() ?? 0) - (session?.created_at.getTime() ?? 0);
    expect(Math.abs(lifetime - DAY)).toBeLessThan(5_000);
    const created = (await h.events({ event: "session.created" })).find(
      (e) => e.target_id === session?.id,
    );
    expect(created?.metadata).toEqual({
      method: "password",
      assurance: "aal1",
      trustedBrowser: true,
    });
    expect(created?.ref_ids).toEqual(expect.arrayContaining([id, row?.target_id]));
    expect(
      (await h.events({ event: "sign_in.second_factor_required" })).filter(
        (e) => e.target_id === session?.id,
      ),
    ).toEqual([]);
    const used = await h.admin.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM identity.trusted_browser WHERE id = $1",
      [row?.target_id],
    );
    expect(used.rows[0]?.last_used_at).not.toBeNull();
    // A working session: a factor change asks for a step-up, not for the factor step.
    const working = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(working.json).toMatchObject({ code: "step_up_required" });
  });

  it("answers a wrong password the same for a registered and an unknown address", async () => {
    const email = unique("wrong");
    await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const registered = await passwordSignIn(h.browser(), email, BETTER);
    const unknown = await passwordSignIn(h.browser(), unique("nobody"), BETTER);
    expect(registered.status).toBe(401);
    expect(registered.json).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(shape(registered)).toEqual(shape(unknown));
    const failed = await eventsFor("sign_in.failed", id);
    expect(failed.at(-1)?.metadata).toEqual({ method: "password", reason: "wrong_password" });
  });

  it("answers a code-only account's password try as any wrong password", async () => {
    const email = unique("codeonly");
    await codeSignIn(h, h.browser(), email);
    const answer = await passwordSignIn(h.browser(), email, GOOD);
    expect(answer.status).toBe(401);
    expect(answer.json).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
  });
});

describe("the pause after wrong passwords (§5.7)", { timeout: 60_000 }, () => {
  async function wrongTries(browser: () => Browser, email: string, times: number) {
    const answers: Answer[] = [];
    for (let i = 0; i < times; i += 1) answers.push(await passwordSignIn(browser(), email, BETTER));
    return answers;
  }

  it("pauses an address from one network after 10 wrong passwords, even for the right one", async () => {
    const email = unique("paused");
    await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const ip = "198.51.100.17";
    // The pause counts per network, so the tries come from one address; the request limit of
    // password sign-ins (8 in 10 minutes per network) is cleared between them so it is not what
    // stops the run.
    for (let i = 0; i < 10; i += 1) {
      await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
      const answer = await passwordSignIn(h.browser({ ip }), email, BETTER);
      expect(answer.status, `try ${i + 1}`).toBe(401);
    }
    await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
    const paused = await passwordSignIn(h.browser({ ip }), email, GOOD);
    expect(paused.status).toBe(429);
    expect(paused.json).toMatchObject({ code: "rate_limited", reason: "password_paused" });
    expect(Number(paused.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another network is not paused by this one, and a passkey or a code still signs in.
    const elsewhere = await passwordSignIn(h.browser({ ip: "203.0.113.9" }), email, GOOD);
    expect(elsewhere.status, JSON.stringify(elsewhere.json)).toBe(200);
    const event = (await eventsFor("password.paused", id)).at(-1);
    expect(event?.metadata).toMatchObject({ scope: "network" });
    expect(event?.actor_kind).toBe("system");
    expect(
      (await h.outbox(email)).filter((m) => m.template === "identity/password-paused"),
    ).toHaveLength(1);
    expect(h.lines.named("auth.password_paused").at(-1)).toEqual({ scope: "network", userId: id });
  });

  it("pauses an unknown address the same way, so the pause names no account", async () => {
    const registered = unique("pause.registered");
    await signUpWithPassword(registered);
    const run = async (email: string, ip: string) => {
      for (let i = 0; i < 10; i += 1) {
        await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
        await passwordSignIn(h.browser({ ip }), email, BETTER);
      }
      await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
      return shape(await passwordSignIn(h.browser({ ip }), email, BETTER));
    };
    const a = await run(registered, "198.51.100.31");
    const b = await run(unique("pause.unknown"), "198.51.100.32");
    expect(a.status).toBe(429);
    expect({ ...a, json: { ...a.json, request_id: null, retry_after: null } }).toEqual({
      ...b,
      json: { ...b.json, request_id: null, retry_after: null },
    });
  });

  it("pauses an address everywhere after 40 wrong passwords across networks", async () => {
    const email = unique("spread");
    await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    let n = 0;
    const fresh = () => {
      n += 1;
      // Three tries per network: no network reaches its own 10.
      return h.browser({ ip: `2001:db8:${(Math.floor(n / 3) + 0x400).toString(16)}::7` });
    };
    const answers = await wrongTries(fresh, email, 40);
    expect(answers.every((a) => a.status === 401)).toBe(true);
    const paused = await passwordSignIn(h.browser({ ip: "2001:db8:ffff::1" }), email, GOOD);
    expect(paused.json).toMatchObject({ code: "rate_limited", reason: "password_paused" });
    expect((await eventsFor("password.paused", id)).at(-1)?.metadata).toMatchObject({
      scope: "address",
    });
  });

  it("checks one of the tries sent together for an address at a time, so none passes its count", async () => {
    const { held, harness: g } = await heldHarness();
    const email = unique("together");
    await signUpWithPassword(email, GOOD, g);
    const id = (await userId(email)) as string;
    // 39 wrong passwords, three per network: one short of the all-networks pause.
    for (let i = 0; i < 39; i += 1) {
      const ip = `2001:db8:${(Math.floor(i / 3) + 0x500).toString(16)}::7`;
      expect((await passwordSignIn(g.browser({ ip }), email, BETTER)).status, `try ${i + 1}`).toBe(
        401,
      );
    }
    // Five more at once from five new networks, the one check held until the others are answered.
    held.hold("verify");
    const checks = held.entered.verify;
    const answered: Answer[] = [];
    const together = [0, 1, 2, 3, 4].map((k) =>
      passwordSignIn(
        g.browser({ ip: `2001:db8:${(0x600 + k).toString(16)}::7` }),
        email,
        BETTER,
      ).then((answer) => {
        answered.push(answer);
        return answer;
      }),
    );
    expect(await until(() => answered.length === 4 && held.entered.verify - checks === 1)).toBe(
      true,
    );
    // The four that found a sign-in of the address under way were answered at once, unchecked.
    expect(answered.map((a) => a.status)).toEqual([503, 503, 503, 503]);
    expect(await lockWaits()).toBe(0);
    held.release("verify");
    const statuses = (await Promise.all(together)).map((a) => a.status).sort();
    // The one checked is the 40th wrong password, which pauses the address.
    expect(statuses).toEqual([401, 503, 503, 503, 503]);
    expect(await eventsFor("sign_in.failed", id)).toHaveLength(40);
    expect((await eventsFor("password.paused", id)).map((e) => e.metadata.scope)).toEqual([
      "address",
    ]);
    // The next try, from yet another network, finds the address paused.
    const next = await passwordSignIn(g.browser({ ip: "2001:db8:6ff::7" }), email, GOOD);
    expect(next.json).toMatchObject({ code: "rate_limited", reason: "password_paused" });
  });

  it("never counts or pauses a browser the account knows", async () => {
    const email = unique("known");
    const owner = await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const ip = "198.51.100.44";
    for (let i = 0; i < 10; i += 1) {
      await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
      await passwordSignIn(h.browser({ ip }), email, BETTER);
    }
    await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
    // The owner's browser (known since the sign-up) still signs in, from the paused network too.
    const knownBrowser = h.browser({ ip });
    knownBrowser.jar.set(
      "__Host-fin.known_browser",
      owner.jar.get("__Host-fin.known_browser") as string,
    );
    const answer = await passwordSignIn(knownBrowser, email, GOOD);
    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    // Its wrong passwords are not counted toward a pause either.
    const before = (await eventsFor("password.paused", id)).length;
    for (let i = 0; i < 12; i += 1) {
      await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
      const other = h.browser({ ip: "198.51.100.45" });
      other.jar.set(
        "__Host-fin.known_browser",
        knownBrowser.jar.get("__Host-fin.known_browser") as string,
      );
      await passwordSignIn(other, email, BETTER);
    }
    expect((await eventsFor("password.paused", id)).length).toBe(before);
  });

  it("keeps a paused address paused across a restart that empties the counters (T-SAT-33)", async () => {
    const email = unique("restart");
    await signUpWithPassword(email);
    const ip = "198.51.100.61";
    for (let i = 0; i < 10; i += 1) {
      await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
      await passwordSignIn(h.browser({ ip }), email, BETTER);
    }
    // A crash empties the UNLOGGED counters; a new process, with the same settings, reads the
    // logged pause.
    await h.admin.query("DELETE FROM ops.rate_window");
    const settings = h.realm.settings;
    const restarted = await createHarness(database, "developer", {
      env: {
        ...PASSWORDS_ON,
        BETTER_AUTH_SECRETS: settings.secrets.map((s) => `${s.version}:${s.value}`).join(","),
        FIN_LIMIT_KEY_1: Buffer.from(settings.limitKeys[0]?.key ?? []).toString("hex"),
      },
    });
    const again = await passwordSignIn(restarted.browser({ ip }), email, GOOD);
    expect(again.json).toMatchObject({ code: "rate_limited", reason: "password_paused" });
  });

  it("sends the paused notice at most once a day", async () => {
    const email = unique("daily");
    await signUpWithPassword(email);
    for (const ip of ["198.51.100.71", "198.51.100.72"]) {
      for (let i = 0; i < 10; i += 1) {
        await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
        await passwordSignIn(h.browser({ ip }), email, BETTER);
      }
    }
    const id = (await userId(email)) as string;
    expect(await eventsFor("password.paused", id)).toHaveLength(2);
    expect(
      (await h.outbox(email)).filter((m) => m.template === "identity/password-paused"),
    ).toHaveLength(1);
  });
});

describe("a password reset by an emailed code", { timeout: 60_000 }, () => {
  it("answers every address the same, and emails a code only to an account", async () => {
    const registered = unique("reset.registered");
    await signUpWithPassword(registered);
    const unknown = unique("reset.unknown");
    const a = await requestReset(h.browser(), registered);
    const b = await requestReset(h.browser(), unknown);
    expect(a.status).toBe(200);
    expect(shape(a)).toEqual(shape(b));
    expect(a.setCookies.map((c) => c.split("=")[0])).toEqual(
      b.setCookies.map((c) => c.split("=")[0]),
    );
    const sent = (await h.outbox(registered)).filter(
      (m) => m.template === "identity/reset-password",
    );
    expect(sent).toHaveLength(1);
    // The code goes in the email's body and link fragment only; nothing else is a parameter.
    expect(Object.keys(sent[0]?.params ?? {})).toEqual(["code"]);
    expect(await h.outbox(unknown)).toEqual([]);
    const id = (await userId(registered)) as string;
    expect(await eventsFor("password.reset_requested", id)).toHaveLength(1);
  });

  it("ends every session, revokes trusted browsers, lifts the lockouts and tells the person", async () => {
    const email = unique("reset.full");
    const first = await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const second = h.browser();
    expect((await passwordSignIn(second, email, GOOD)).status).toBe(200);
    // A trusted browser, an authenticator lockout and a pause, all to be lifted or revoked.
    await seed(
      h.admin,
      `INSERT INTO identity.trusted_browser (id, user_id, token_hash, label, created_at, expires_at)
       VALUES ('tbr_01jd0000000000000000000000', $1, decode(repeat('ab', 32), 'hex'), 'Chrome on Mac', now(), now() + interval '30 days')`,
      [id],
    );
    await h.admin.query(
      "INSERT INTO ops.lockout (key, kind, count, locked_until, updated_at) VALUES ($1, 'factor_code', 10, now() + interval '1 hour', now())",
      [`factor:developer:${id}`],
    );
    const ip = "198.51.100.81";
    for (let i = 0; i < 10; i += 1) {
      await h.admin.query("DELETE FROM ops.rate_window WHERE key LIKE 'password_sign_in:%'");
      await passwordSignIn(h.browser({ ip }), email, BETTER);
    }
    const sessionsBefore = await h.admin.query<{ id: string }>(
      "SELECT id FROM identity.session WHERE user_id = $1",
      [id],
    );
    expect(sessionsBefore.rows.length).toBe(2);

    const asker = h.browser({ ip });
    await requestReset(asker, email);
    const code = (await h.latestCode(email)) as string;
    const done = await reset(asker, email, code);
    expect(done.status, JSON.stringify(done.json)).toBe(200);

    expect(
      (await h.admin.query("SELECT 1 FROM identity.session WHERE user_id = $1", [id])).rowCount,
    ).toBe(0);
    const ended = (await h.events({ event: "session.ended" })).filter((e) =>
      sessionsBefore.rows.some((s) => s.id === e.target_id),
    );
    expect(ended.map((e) => e.metadata)).toEqual([
      { reason: "password_reset" },
      { reason: "password_reset" },
    ]);
    const event = (await eventsFor("password.reset", id)).at(-1);
    expect(event?.metadata).toEqual({ sessionsEnded: 2 });
    expect(
      (await eventsFor("browser.trust_revoked", "tbr_01jd0000000000000000000000")).at(-1)?.metadata,
    ).toEqual({ reason: "password_reset" });
    const lock = await h.admin.query<{ locked_until: Date | null }>(
      "SELECT locked_until FROM ops.lockout WHERE key = $1",
      [`factor:developer:${id}`],
    );
    expect(lock.rows[0]?.locked_until).toBeNull();
    const notices = (await h.outbox(email)).filter(
      (m) => m.template === "identity/sign-in-methods-changed",
    );
    expect(notices.at(-1)?.params).toMatchObject({ kind: "password_reset", userId: id });
    // The old password stops, the new one works, and the network's pause is lifted.
    expect((await passwordSignIn(h.browser({ ip }), email, GOOD)).status).toBe(401);
    const signedIn = await passwordSignIn(h.browser({ ip }), email, BETTER);
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    // The first browser's session is gone.
    expect((await first.get("/api/auth/get-session")).json).toBeNull();
    // The code works once.
    const again = await reset(asker, email, code, "another fine passphrase");
    expect(again.status).toBe(400);
  });

  it("sets a first password for a code-only account, as password.set", async () => {
    const email = unique("reset.first");
    await codeSignIn(h, h.browser(), email);
    const id = (await userId(email)) as string;
    const asker = h.browser();
    await requestReset(asker, email);
    const done = await reset(asker, email, (await h.latestCode(email)) as string);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect((await eventsFor("password.set", id)).at(-1)?.metadata).toEqual({ sessionsEnded: 1 });
    expect(await passwordHash(id)).toMatch(/^\$argon2id\$/);
  });

  it("works only in the browser that asked, and counts the tries", async () => {
    const email = unique("reset.elsewhere");
    await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const asker = h.browser();
    await requestReset(asker, email);
    const code = (await h.latestCode(email)) as string;
    const stranger = await reset(h.browser(), email, code);
    expect(stranger.status).toBe(400);
    expect(stranger.json).toMatchObject({ code: "INVALID_OTP" });
    expect((await eventsFor("password.reset_failed", id)).at(-1)?.metadata).toEqual({
      reason: "other_browser",
    });
    const wrong = await reset(asker, email, "00000000");
    expect(wrong.json).toMatchObject({ code: "INVALID_OTP" });
    expect((await eventsFor("password.reset_failed", id)).at(-1)?.metadata).toEqual({
      reason: "wrong_code",
    });
    // A weak password costs no try.
    const weak = await reset(asker, email, code, "password1234");
    expect(weak.status).toBe(400);
    expect(weak.json).toMatchObject({ code: "invalid", problem: "password_common" });
    const ok = await reset(asker, email, code);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it("stops after three wrong tries in the asking browser", async () => {
    const email = unique("reset.tries");
    await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const asker = h.browser();
    await requestReset(asker, email);
    const code = (await h.latestCode(email)) as string;
    for (let i = 0; i < 3; i += 1) await reset(asker, email, "00000000");
    const used = await reset(asker, email, code);
    expect(used.json).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
    expect((await eventsFor("password.reset_failed", id)).at(-1)?.metadata).toEqual({
      reason: "too_many_tries",
    });
    expect(await passwordHash(id)).not.toBeNull();
    expect((await passwordSignIn(h.browser(), email, GOOD)).status).toBe(200);
  });

  it("tells the link's page only about this browser's own request", async () => {
    const email = unique("reset.link");
    await signUpWithPassword(email);
    const asker = h.browser();
    const check = (b: Browser) =>
      h.realm.run(b.context(), (tx) =>
        resetCodeLink(tx, h.realm.runtime, email, b.jar.get("__Host-fin.code_browser") ?? null),
      );
    expect(await check(asker)).toBe("elsewhere");
    await requestReset(asker, email);
    expect(await check(asker)).toBe("asking");
    expect(await check(h.browser())).toBe("elsewhere");
    await reset(asker, email, (await h.latestCode(email)) as string);
    expect(await check(asker)).toBe("spent");
  });

  it("keeps its code apart from a sign-in code for the same address", async () => {
    const email = unique("reset.apart");
    await signUpWithPassword(email);
    const browser = h.browser();
    await browser.post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    const signInCode = (await h.latestCode(email)) as string;
    await requestReset(browser, email);
    const resetCode = (await h.latestCode(email)) as string;
    // The reset request supersedes no sign-in code, and neither code works for the other.
    expect((await reset(browser, email, signInCode)).status).toBe(400);
    const signedIn = await browser.post("/api/auth/sign-in/email-otp", { email, otp: signInCode });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    const done = await reset(browser, email, resetCode);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
  });
});

describe("a reset and what overlaps it (§5.7, §11.4)", { timeout: 60_000 }, () => {
  it("ends the session of a sign-in with the old password that was checking it as the reset came", async () => {
    const { held, harness: g } = await heldHarness();
    const email = unique("race.first");
    await signUpWithPassword(email, GOOD, g);
    const id = (await userId(email)) as string;
    const asker = g.browser();
    await requestReset(asker, email);
    const code = (await g.latestCode(email)) as string;

    // Someone who knows the old password signs in; their check is held after the library has read
    // the old password, inside the sign-in's unit of work.
    held.hold("verify");
    const checks = held.entered.verify;
    const intruder = g.browser();
    const signIn = passwordSignIn(intruder, email, GOOD);
    expect(await until(() => held.entered.verify > checks)).toBe(true);
    // The reset comes meanwhile; it waits for the sign-in rather than ending the sessions first.
    let resetDone = false;
    const resetting = reset(asker, email, code).finally(() => {
      resetDone = true;
    });
    expect(await until(async () => resetDone || (await lockWaits()) > 0)).toBe(true);
    held.release("verify");
    const [signedIn, done] = await Promise.all([signIn, resetting]);

    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    // No session outlives the reset, and the one the sign-in made ended with its event.
    expect(await liveSessions(id)).toEqual([]);
    expect((await intruder.get("/api/auth/get-session")).json).toBeNull();
    const made = (await g.events({ event: "session.created" })).find(
      (e) => e.ref_ids.includes(id) && e.metadata.method === "password",
    );
    expect(made?.target_id).toMatch(/^ses_/);
    expect(
      (await g.events({ event: "session.ended" }))
        .filter((e) => e.target_id === made?.target_id)
        .map((e) => e.metadata),
    ).toEqual([{ reason: "password_reset" }]);
    expect((await eventsFor("password.reset", id)).at(-1)?.metadata).toEqual({ sessionsEnded: 2 });
  });

  it("answers a sign-in that comes while a reset is under way 503 at once, so it never reads the old password", async () => {
    const { held, harness: g } = await heldHarness();
    const email = unique("race.second");
    const owner = await signUpWithPassword(email, GOOD, g);
    const id = (await userId(email)) as string;
    const before = await liveSessions(id);
    const asker = g.browser();
    await requestReset(asker, email);
    const code = (await g.latestCode(email)) as string;

    // The reset's new password is held in its hash: its code is tried and the address's lock held.
    held.hold("hash");
    const hashes = held.entered.hash;
    const resetting = reset(asker, email, code);
    expect(await until(() => held.entered.hash > hashes)).toBe(true);
    // A sign-in with the old password comes meanwhile: refused before any password is read.
    const checks = held.entered.verify;
    const during = await passwordSignIn(g.browser(), email, GOOD);
    expect(during.status).toBe(503);
    expect(during.json).toMatchObject({ code: "unavailable", retry_after: 2 });
    expect(held.entered.verify).toBe(checks);
    held.release("hash");
    const done = await resetting;
    expect(done.status, JSON.stringify(done.json)).toBe(200);

    // Sent again once the reset is done, the old password is wrong.
    const again = await passwordSignIn(g.browser(), email, GOOD);
    expect(again.status).toBe(401);
    expect(again.json).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(await liveSessions(id)).toEqual([]);
    expect((await owner.get("/api/auth/get-session")).json).toBeNull();
    // Each session the reset ended has its event.
    const ended = (await g.events({ event: "session.ended" })).map((e) => e.target_id);
    for (const session of before) expect(ended).toContain(session);
    expect((await passwordSignIn(g.browser(), email, BETTER)).status).toBe(200);
  });

  it("ends a session another method made during a reset with its event, and keeps one made after", async () => {
    const { held, harness: g } = await heldHarness();
    const email = unique("race.passkey");
    const owner = await signUpWithPassword(email, GOOD, g);
    const authenticator = g.authenticator();
    const { verify } = await registerPasskey(owner, authenticator);
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
    const id = (await userId(email)) as string;
    const asker = g.browser();
    await requestReset(asker, email);
    const code = (await g.latestCode(email)) as string;

    held.hold("hash");
    const hashes = held.entered.hash;
    const resetting = reset(asker, email, code);
    expect(await until(() => held.entered.hash > hashes)).toBe(true);
    // A passkey sign-in of the same person while the reset hashes: the reset holds nothing of the
    // person's, so it is made at once.
    const during = await passkeyCeremony(g.browser(), authenticator);
    expect(during.status, JSON.stringify(during.json)).toBe(200);
    held.release("hash");
    const done = await resetting;
    expect(done.status, JSON.stringify(done.json)).toBe(200);

    // It was there when the reset ended every session, so it ended with them, with its event.
    const passkeySessions = async () =>
      (await g.events({ event: "session.created" }))
        .filter((e) => e.ref_ids.includes(id) && e.metadata.method === "passkey")
        .map((e) => e.target_id);
    const [madeDuring] = await passkeySessions();
    expect(madeDuring).toMatch(/^ses_/);
    expect(
      (await g.events({ event: "session.ended" }))
        .filter((e) => e.target_id === madeDuring)
        .map((e) => e.metadata),
    ).toEqual([{ reason: "password_reset" }]);
    expect(await liveSessions(id)).toEqual([]);
    // One made after the reset stays.
    expect((await passkeyCeremony(g.browser(), authenticator)).status).toBe(200);
    const [, madeAfter] = await passkeySessions();
    expect(await liveSessions(id)).toEqual([madeAfter]);
    // Every session of the person is either still there or ended with its event.
    const made = (await g.events({ event: "session.created" }))
      .filter((e) => e.ref_ids.includes(id))
      .map((e) => e.target_id);
    const ended = (await g.events({ event: "session.ended" })).map((e) => e.target_id);
    const live = await liveSessions(id);
    for (const session of made) {
      expect(live.includes(session) || ended.includes(session), session).toBe(true);
    }
  });

  it("lets the person's own factor step in another browser finish while a reset hashes, and ends its session", async () => {
    const { held, harness: g } = await heldHarness();
    const email = unique("race.factor");
    const owner = await signUpWithPassword(email, GOOD, g);
    const { secret } = await setUpAuthenticator(owner);
    const id = (await userId(email)) as string;
    // In another browser the person signs in with the password and stops at the factor step.
    const other = g.browser();
    expect((await passwordSignIn(other, email, GOOD)).status).toBe(200);
    const asker = g.browser();
    await requestReset(asker, email);
    const code = (await g.latestCode(email)) as string;
    await g.admin.query("UPDATE identity.totp_step SET last_step = 0");

    // The reset holds its new password's hash: its code is tried, nothing is ended yet.
    held.hold("hash");
    const hashes = held.entered.hash;
    const resetting = reset(asker, email, code);
    expect(await until(() => held.entered.hash > hashes)).toBe(true);
    // The factor step, meanwhile, in the other browser: it raises its session and moves its expiry.
    let stepDone = false;
    const step = other
      .post("/api/auth/two-factor/verify-totp", { code: hotp(secret, totpStep(new Date())) })
      .finally(() => {
        stepDone = true;
      });
    expect(await until(async () => stepDone || (await lockWaits()) > 0)).toBe(true);
    held.release("hash");
    const [done, stepped] = await Promise.all([resetting, step]);

    // Neither waits on the other in a circle: both are answered, and nothing failed.
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(stepped.status, JSON.stringify(stepped.json)).toBe(200);
    expect(g.lines.named("auth.unhandled_error")).toEqual([]);
    // The session the factor step raised is one the reset ended, with its event.
    const raised = (await g.events({ event: "session.created" })).find(
      (e) => e.ref_ids.includes(id) && e.metadata.method === "totp",
    )?.target_id;
    expect(raised).toMatch(/^ses_/);
    expect(await liveSessions(id)).toEqual([]);
    const ended = (await g.events({ event: "session.ended" })).filter((e) =>
      e.ref_ids.includes(id),
    );
    expect(ended.filter((e) => e.target_id === raised).map((e) => e.metadata)).toEqual([
      { reason: "password_reset" },
    ]);
    expect((await eventsFor("password.reset", id)).at(-1)?.metadata).toEqual({
      sessionsEnded: ended.length,
    });
  });

  it("forgets the known browsers but its own, so one that signed in with the old password is paused", async () => {
    const email = unique("reset.known");
    const owner = await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    // Someone signs in once with the password and keeps the known-browser cookie it gave them.
    const intruder = h.browser({ ip: "198.51.100.91" });
    expect((await passwordSignIn(intruder, email, GOOD)).status).toBe(200);
    const intruderCookie = intruder.jar.get("__Host-fin.known_browser") as string;
    expect(intruderCookie).toMatch(/./);
    const knownBefore = await h.admin.query(
      "SELECT 1 FROM identity.known_browser WHERE user_id = $1",
      [id],
    );
    expect(knownBefore.rowCount).toBe(2);

    // The owner resets from their own browser, which the account knows.
    await requestReset(owner, email);
    expect((await reset(owner, email, (await h.latestCode(email)) as string)).status).toBe(200);
    const knownAfter = await h.admin.query<{ id: string }>(
      "SELECT id FROM identity.known_browser WHERE user_id = $1",
      [id],
    );
    expect(knownAfter.rowCount).toBe(1);

    // The intruder's cookie no longer exempts their guesses: ten from one network pause it there,
    // so even the right new password is refused from it.
    const ip = "198.51.100.92";
    const asIntruder = () => {
      const browser = h.browser({ ip });
      browser.jar.set("__Host-fin.known_browser", intruderCookie);
      return browser;
    };
    for (let i = 0; i < 10; i += 1) {
      await clearSignInLimit();
      expect((await passwordSignIn(asIntruder(), email, GOOD)).status, `try ${i + 1}`).toBe(401);
    }
    await clearSignInLimit();
    const paused = await passwordSignIn(asIntruder(), email, BETTER);
    expect(paused.json).toMatchObject({ code: "rate_limited", reason: "password_paused" });
    // The browser that reset is still known: it signs in from that network all the same.
    const ownerThere = h.browser({ ip });
    ownerThere.jar.set(
      "__Host-fin.known_browser",
      owner.jar.get("__Host-fin.known_browser") as string,
    );
    await clearSignInLimit();
    const signedIn = await passwordSignIn(ownerThere, email, BETTER);
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  });
});

describe("changing a password", { timeout: 30_000 }, () => {
  it("needs a step-up intent and writes password.changed with it", async () => {
    const email = unique("change");
    const browser = await signUpWithPassword(email);
    const { secret } = await setUpAuthenticator(browser);
    const id = (await userId(email)) as string;
    const body = { currentPassword: GOOD, newPassword: BETTER };
    const asked = await browser.post("/api/auth/change-password", body);
    expect(asked.status).toBe(403);
    expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: "change_password" });
    const intent = String(asked.json?.intent_id);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    const proved = await browser.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date())) },
      { "fin-step-up-intent": intent },
    );
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
    const weak = await browser.post(
      "/api/auth/change-password",
      { currentPassword: GOOD, newPassword: "iloveyou1234" },
      { "fin-step-up-intent": intent },
    );
    expect(weak.json).toMatchObject({ code: "invalid", problem: "password_common" });
    const changed = await browser.post(
      "/api/auth/change-password",
      { ...body, revokeOtherSessions: true },
      {
        "fin-step-up-intent": intent,
      },
    );
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    const event = (await eventsFor("password.changed", id)).at(-1);
    expect(event?.step_up_ref).toBe(intent);
    expect(event?.ref_ids).toContain(intent);
    expect(
      (await h.outbox(email))
        .filter((m) => m.template === "identity/sign-in-methods-changed")
        .at(-1)?.params,
    ).toMatchObject({ kind: "password_changed" });
    // revokeOtherSessions was dropped: this session stays.
    expect((await sessionOf(browser))?.assurance).toBe("aal2");
    expect((await passwordSignIn(h.browser(), email, BETTER)).status).toBe(200);
    // The intent is used up.
    const replay = await browser.post("/api/auth/change-password", body, {
      "fin-step-up-intent": intent,
    });
    expect(replay.status).toBe(403);
  });
});

describe("factor changes for a person with a password", { timeout: 30_000 }, () => {
  it("take Fin's step-up, never the password: a password the client sends is dropped", async () => {
    const email = unique("recheck");
    const browser = await signUpWithPassword(email);
    // The first factor in the fresh session (the library would otherwise ask for the password).
    const { secret } = await setUpAuthenticator(browser);
    // Turning it off needs an intent; a password in the body neither helps nor is checked.
    const asked = await browser.post("/api/auth/two-factor/disable", { password: GOOD });
    expect(asked.json).toMatchObject({ code: "step_up_required" });
    const intent = String(asked.json?.intent_id);
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    await browser.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date())) },
      { "fin-step-up-intent": intent },
    );
    const off = await browser.post(
      "/api/auth/two-factor/disable",
      { password: "not the password at all" },
      { "fin-step-up-intent": intent },
    );
    expect(off.status, JSON.stringify(off.json)).toBe(200);
  });

  it("accepts the stand-in once, on its own path only", async () => {
    const browser = h.browser();
    const results = await h.realm.run(browser.context(), async (_tx, state) => {
      const hash = await h.realm.runtime.passwords.hash(GOOD);
      state.rule = h.realm.policy.match("/two-factor/disable", "POST");
      state.passwordWaiver = { path: "/two-factor/disable", nonce: "n".repeat(43) };
      const right = await verifyWithWaiver(h.realm.runtime, { hash, password: "n".repeat(43) });
      // Used up: the next check is a real one.
      const again = await verifyWithWaiver(h.realm.runtime, { hash, password: "n".repeat(43) });
      const real = await verifyWithWaiver(h.realm.runtime, { hash, password: GOOD });
      // On another path the stand-in is refused, and used up all the same.
      state.rule = h.realm.policy.match("/sign-in/email", "POST");
      state.passwordWaiver = { path: "/two-factor/disable", nonce: "m".repeat(43) };
      const elsewhere = await verifyWithWaiver(h.realm.runtime, { hash, password: "m".repeat(43) });
      return { right, again, real, elsewhere, left: state.passwordWaiver };
    });
    expect(results).toEqual({
      right: true,
      again: false,
      real: true,
      elsewhere: false,
      left: null,
    });
  });
});

describe("the audit guard on passwords (T-SAT-26)", () => {
  it("refuses a password written as the console's login without its event", async () => {
    const email = unique("guard");
    await signUpWithPassword(email);
    const id = (await userId(email)) as string;
    const client = await h.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE identity.account SET password = 'x' WHERE user_id = $1 AND provider_id = 'credential'",
        [id],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "FA010" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});

describe("hashing under load (ARCHITECTURE §3.5)", { timeout: 60_000 }, () => {
  it("answers 503 with Retry-After past the queue, at a library path", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lines = new MemoryLineSink();
    const busy = await createHarness(database, "developer", {
      env: PASSWORDS_ON,
      deps: {
        passwords: createPasswordHasher({
          lines,
          concurrency: 1,
          queueLimit: 0,
          work: {
            hash: async () => {
              await blocked;
              return "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            },
            verify: async () => {
              await blocked;
              return false;
            },
          },
        }),
      },
    });
    const first = passwordSignIn(busy.browser(), unique("load.a"), BETTER);
    // Let the first request reach the hasher before the second asks for a slot.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await passwordSignIn(busy.browser(), unique("load.b"), BETTER);
    release();
    await first;
    expect(second.status).toBe(503);
    expect(second.json).toMatchObject({ code: "unavailable", retry_after: 2 });
    expect(second.headers.get("retry-after")).toBe("2");
    expect(lines.named("auth.password_hash_busy")).toEqual([{ reason: "queue_full" }]);
  });

  /**
   * A realm the size of the console's (a pool of 10, UV_THREADPOOL_SIZE=8: six hashes at once and
   * two waiting), whose hashes and checks the test holds.
   */
  async function consoleSized() {
    const held = heldWork();
    const pool = database.login("fin_console", { max: 10 });
    const db = createPgDatabase({
      pool,
      clock: systemClock,
      release: "test",
      lines: new MemoryLineSink(),
    });
    const lines = new MemoryLineSink();
    const passwords = createPasswordHasher({
      lines,
      limits: { threadPoolSize: 8, databasePoolSize: db.poolSize },
      queueWaitMs: 30_000,
      work: held.work,
    });
    const harness = await createHarness(database, "developer", {
      env: PASSWORDS_ON,
      deps: { db, passwords },
    });
    /** The pool's clients no request holds (idle, or not yet made). */
    const freeClients = () => 10 - (pool.totalCount - pool.idleCount);
    return { held, harness, passwords, lines, freeClients };
  }

  /** The value, or "timeout" when it takes longer than `ms`. */
  async function within<T>(ms: number, promise: Promise<T>): Promise<T | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Starts every request at once, noting each answer (or refusal) as it comes. */
  function burst<T>(requests: (() => Promise<T>)[]) {
    const settled: { value: T | null; error: unknown }[] = [];
    const all = requests.map((send) =>
      send().then(
        (value) => {
          settled.push({ value, error: null });
        },
        (error: unknown) => {
          settled.push({ value: null, error });
        },
      ),
    );
    return { settled, done: () => Promise.all(all) };
  }

  it("checks one sign-in of an address at a time and answers the rest 503 at once, keeping clients free, with or without a known browser", async () => {
    const { held, harness: g, passwords, lines, freeClients } = await consoleSized();
    const email = unique("burst.address");
    const owner = await signUpWithPassword(email, GOOD, g);
    const knownCookie = owner.jar.get("__Host-fin.known_browser") as string;
    for (const known of [false, true]) {
      held.hold("verify");
      const checks = held.entered.verify;
      // Ten sign-ins of one address, each from its own /48, so no network's limit stops them.
      const sent = burst(
        Array.from({ length: 10 }, () => () => {
          const browser = g.browser();
          if (known) browser.jar.set("__Host-fin.known_browser", knownCookie);
          return passwordSignIn(browser, email, BETTER);
        }),
      );
      expect(
        await until(() => sent.settled.length === 9 && held.entered.verify - checks === 1),
        `known browser: ${known}`,
      ).toBe(true);
      // One is checking its password; the others wait for nothing and hold no client.
      for (const { value } of sent.settled) {
        expect(value?.status).toBe(503);
        expect(value?.json).toMatchObject({ code: "unavailable", retry_after: 2 });
        expect(value?.headers.get("retry-after")).toBe("2");
      }
      expect(passwords.load().running).toBe(1);
      expect(freeClients()).toBeGreaterThanOrEqual(CLIENTS_KEPT_FREE);
      // Another request is answered at once, while the check still holds its client.
      const bystander = await within(3_000, g.browser().get("/api/auth/get-session"));
      expect(bystander === "timeout" ? "timeout" : bystander.status).toBe(200);
      held.release("verify");
      await sent.done();
      expect(sent.settled.map((s) => s.value?.status).sort()).toEqual([401, ...Array(9).fill(503)]);
    }
    expect(lines.named("auth.password_hash_busy").length).toBeGreaterThanOrEqual(18);
  });

  it("admits no more sign-ins than the clients hashing may hold: one network's burst waits on its own limit within them", async () => {
    const { held, harness: g, lines, freeClients } = await consoleSized();
    held.hold("hash");
    const hashes = held.entered.hash;
    // Ten sign-ins from one network, to ten addresses no account has (the library hashes the
    // password all the same). They take turns on the network's counters, held across each hash.
    const ip = "198.51.100.121";
    const sent = burst(
      Array.from(
        { length: 10 },
        (_, k) => () => passwordSignIn(g.browser({ ip }), unique(`burst.net${k}`), BETTER),
      ),
    );
    expect(await until(() => sent.settled.length === 2 && held.entered.hash - hashes === 1)).toBe(
      true,
    );
    // Six slots and two waiting: eight admitted, the other two answered 503 before taking a client.
    expect(sent.settled.map((s) => s.value?.status)).toEqual([503, 503]);
    expect(lines.named("auth.password_hash_busy")).toEqual([
      { reason: "queue_full" },
      { reason: "queue_full" },
    ]);
    expect(freeClients()).toBeGreaterThanOrEqual(CLIENTS_KEPT_FREE);
    const bystander = await within(3_000, g.browser().get("/api/auth/get-session"));
    expect(bystander === "timeout" ? "timeout" : bystander.status).toBe(200);
    held.release("hash");
    await sent.done();
    expect(sent.settled.map((s) => s.value?.status).sort()).toEqual([
      ...Array(8).fill(401),
      503,
      503,
    ]);
  });

  it("admits a sign-up with a password the same way: one address's burst waits on its own limit within them", async () => {
    const { held, harness: g, freeClients } = await consoleSized();
    const email = unique("burst.signup");
    held.hold("hash");
    const hashes = held.entered.hash;
    const sent = burst(
      Array.from({ length: 10 }, () => () => {
        const browser = g.browser();
        return signUp(g.realm, browser.request("POST", "/api/sign-up", {}), browser.context(), {
          name: "Ada Lovelace",
          email,
          password: GOOD,
        });
      }),
    );
    expect(await until(() => sent.settled.length === 2 && held.entered.hash - hashes === 1)).toBe(
      true,
    );
    for (const { error } of sent.settled) {
      expect(error).toMatchObject({ code: "unavailable", extensions: { retry_after: 2 } });
    }
    expect(freeClients()).toBeGreaterThanOrEqual(CLIENTS_KEPT_FREE);
    const bystander = await within(3_000, g.browser().get("/api/auth/get-session"));
    expect(bystander === "timeout" ? "timeout" : bystander.status).toBe(200);
    held.release("hash");
    await sent.done();
    // Past the two refused at once, the address's own allowance (3 a day) decides.
    const outcomes = sent.settled.map((s) =>
      s.value !== null ? s.value.status : (s.error as { code?: string }).code,
    );
    expect(outcomes.filter((o) => o === "unavailable")).toHaveLength(2);
    expect(outcomes.filter((o) => o === 202)).toHaveLength(3);
    expect(outcomes.filter((o) => o === "rate_limited")).toHaveLength(5);
  });
});

describe("the windows of the pause", { timeout: 60_000 }, () => {
  it("pauses a network at its 15th wrong password in an hour, across 15-minute windows, until the hour ends", async () => {
    // A clock the test moves, one minute into an hour, so the hour holds two 15-minute windows.
    const start = new Date(Math.floor(Date.now() / HOUR) * HOUR + MINUTE);
    const hourEnds = new Date(start.getTime() - MINUTE + HOUR);
    const clock = new ManualClock(start);
    const m = await createHarness(database, "developer", { env: PASSWORDS_ON, clock });
    const email = unique("hour");
    await signUpWithPassword(email, GOOD, m);
    const id = (await userId(email)) as string;
    const ip = "198.51.100.101";
    const tryFrom = async (from: string, password: string) => {
      await clearSignInLimit();
      return passwordSignIn(m.browser({ ip: from }), email, password);
    };

    // Nine in the hour's first 15 minutes: one short of that window's 10.
    for (let i = 0; i < 9; i += 1) expect((await tryFrom(ip, BETTER)).status).toBe(401);
    // Six in the next 15 minutes: that window holds 6, the hour 15. The first five pause nothing.
    clock.set(new Date(start.getTime() + 15 * MINUTE));
    for (let i = 0; i < 5; i += 1) {
      expect((await tryFrom(ip, BETTER)).status, `try ${10 + i}`).toBe(401);
    }
    expect(await eventsFor("password.paused", id)).toEqual([]);
    // The 15th is checked and answered as any wrong password, and pauses this network for the
    // rest of the hour.
    expect((await tryFrom(ip, BETTER)).status).toBe(401);
    expect((await eventsFor("password.paused", id)).map((e) => e.metadata)).toEqual([
      { scope: "network", until: hourEnds.toISOString() },
    ]);
    const paused = await tryFrom(ip, GOOD);
    expect(paused.json).toMatchObject({ code: "rate_limited", reason: "password_paused" });
    expect(Number(paused.headers.get("retry-after"))).toBe(
      (hourEnds.getTime() - clock.now().getTime()) / 1000,
    );
    // Another network is not paused by it.
    expect((await tryFrom("198.51.100.102", GOOD)).status).toBe(200);
    // Just before the hour ends the network is still paused; when it ends, it is not.
    clock.set(new Date(hourEnds.getTime() - 1000));
    expect((await tryFrom(ip, GOOD)).json).toMatchObject({ reason: "password_paused" });
    clock.set(hourEnds);
    expect((await tryFrom(ip, GOOD)).status).toBe(200);
  });
});

describe("the counts and pauses behind the pause (§5.6)", { timeout: 60_000 }, () => {
  /** Records each statement the pool's clients run. */
  function recording(pool: Pool, seen: { text: string; values: readonly unknown[] }[]): Pool {
    const connect = pool.connect.bind(pool);
    const wrapped = new WeakSet<PoolClient>();
    (pool as { connect: () => Promise<PoolClient> }).connect = async () => {
      const client = await connect();
      if (!wrapped.has(client)) {
        wrapped.add(client);
        const query = client.query.bind(client);
        client.query = ((config: string | QueryConfig, values?: readonly unknown[]) => {
          const text = typeof config === "string" ? config : config.text;
          seen.push({ text, values: values ?? [] });
          return query(config, values);
        }) as PoolClient["query"];
      }
      return client;
    };
    return pool;
  }

  /** The tables a plan reads with a sequential scan, with sequential scans off. */
  async function seqScans(text: string, values: readonly unknown[]): Promise<string[]> {
    const client = await h.admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON) ${text}`,
        values,
      );
      const found: string[] = [];
      const walk = (node: unknown): void => {
        if (typeof node !== "object" || node === null) return;
        const record = node as Record<string, unknown>;
        if (record["Node Type"] === "Seq Scan") found.push(String(record["Relation Name"]));
        for (const value of Object.values(record)) walk(value);
      };
      walk(plan.rows[0]?.["QUERY PLAN"]);
      return found;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }

  it("are counted, read and lifted by their own keys, never by a scan of their tables", async () => {
    const seen: { text: string; values: readonly unknown[] }[] = [];
    const pool = recording(database.login("fin_console"), seen);
    const db = createPgDatabase({
      pool,
      clock: systemClock,
      release: "test",
      lines: new MemoryLineSink(),
    });
    const r = await createHarness(database, "developer", { env: PASSWORDS_ON, deps: { db } });
    const email = unique("keys");
    const owner = await signUpWithPassword(email, GOOD, r);
    // Wrong passwords to a pause, a paused try, a reset that lifts it, and a sign-in after it.
    const ip = "198.51.100.111";
    for (let i = 0; i < 10; i += 1) {
      await clearSignInLimit();
      await passwordSignIn(r.browser({ ip }), email, BETTER);
    }
    await clearSignInLimit();
    expect((await passwordSignIn(r.browser({ ip }), email, GOOD)).status).toBe(429);
    await requestReset(owner, email);
    expect((await reset(owner, email, (await r.latestCode(email)) as string)).status).toBe(200);
    await clearSignInLimit();
    expect((await passwordSignIn(r.browser({ ip }), email, BETTER)).status).toBe(200);

    const statements = new Map<string, readonly unknown[]>();
    for (const { text, values } of seen) {
      if (/\bops\.(rate_window|lockout)\b/.test(text)) statements.set(text, values);
    }
    expect(statements.size).toBeGreaterThan(3);
    for (const [text, values] of statements) {
      expect(await seqScans(text, values), text).toEqual([]);
    }
  });
});
