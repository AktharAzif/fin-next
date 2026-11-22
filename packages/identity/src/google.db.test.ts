// Google sign-in end to end on Postgres 18 (spec 02 §5.8, §4.2, §6.1, §6.3, §7.6, §13.8, §16.2,
// §17.2; stretch 5): the developer realm against the fixture OpenID provider on a real socket.
// Proves the state (bound to the browser's signed cookie, unexpired, one exchange however many
// callbacks come), PKCE (S256, the verifier at the token endpoint), the nonce (minted per sign-in,
// checked in the ID token), the exact redirect URI, the network's exchange allowance, a refused
// code read as the client's refusal, verified addresses only (and the mailbox proved only for the
// account's own address), linking only from Account security with an intent and only to the same
// address, unlinking with an intent from a session of any age, the audit events in the action's
// transaction (the guard refuses the account row without them), the security notices, and 404 for
// every Google path while Google is off.
import { createHmac, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FixtureAccount,
  OAuthFixture,
  type RunningOAuthFixture,
  startOAuthFixture,
  type Tamper,
} from "../../testing/src/oauth/fixture.ts";
import { createTestDatabase, seed, type TestDatabase } from "../test/db.ts";
import {
  type Answer,
  type Browser,
  codeSignIn,
  createHarness,
  type Harness,
  ORIGIN,
  setUpAuthenticator,
} from "../test/harness.ts";
import { hotp, totpStep } from "./crypto/totp.ts";
import { claimState, STATE_CLAIM_KEY } from "./google/state.ts";
import { ManualClock } from "./ports/clock.ts";
import type { Queryable } from "./ports/db.ts";

const CLIENT_ID = "fin-console-test.apps.example.com";
const REDIRECT_URI = `${ORIGIN.developer}/api/auth/callback/google`;

let database: TestDatabase;
let provider: RunningOAuthFixture;
let fixture: OAuthFixture;
let h: Harness;
const clientSecret = randomBytes(24).toString("base64url");

function googleEnv(): Record<string, string> {
  return {
    FIN_FEATURE_GOOGLE: "on",
    FIN_GOOGLE_CLIENT_ID: CLIENT_ID,
    FIN_GOOGLE_CLIENT_SECRET: clientSecret,
    FIN_GOOGLE_TEST_ISSUER: provider.origin,
  };
}

beforeAll(async () => {
  database = await createTestDatabase("google");
  fixture = new OAuthFixture();
  provider = await startOAuthFixture(fixture);
  fixture.registerClient({ clientId: CLIENT_ID, clientSecret, redirectUris: [REDIRECT_URI] });
  h = await createHarness(database, "developer", { env: googleEnv() });
});

afterAll(async () => {
  await provider?.close();
  await database?.drop();
});

const tag = () => randomBytes(4).toString("hex");
function account(label: string, overrides: Partial<FixtureAccount> = {}): FixtureAccount {
  const id = tag();
  return {
    sub: `1${randomBytes(9).readBigUInt64BE().toString().slice(0, 18)}${id.length}`,
    email: `${label}.${id}@example.com`,
    name: "Maya Rivera",
    ...overrides,
  };
}

interface RoundTrip {
  start: Answer;
  authorize: URL;
  /** The callback's path and query, as the provider sent the browser back. */
  callbackPath: string;
  callback: Answer;
  location: URL | null;
}

/** Starts a Google sign-in in this browser, lets the fixture answer, and follows the callback. */
async function roundTrip(
  browser: Browser,
  choice: FixtureAccount | "deny",
  options: {
    start?: "/sign-in/social" | "/link-social";
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    tamper?: Tamper;
    callbackFrom?: Browser;
  } = {},
): Promise<RoundTrip> {
  const path = options.start ?? "/sign-in/social";
  const start = await browser.post(
    `/api/auth${path}`,
    {
      provider: "google",
      callbackURL: path === "/link-social" ? "/account/security" : "/sign-in?via=google",
      disableRedirect: true,
      ...options.body,
    },
    options.headers ?? {},
  );
  if (start.status !== 200)
    throw new Error(`${path} answered ${start.status}: ${JSON.stringify(start.json)}`);
  const authorize = new URL(String(start.json?.url));
  fixture.chooseNext(choice);
  fixture.tamperNext(options.tamper ?? null);
  const fromProvider = await fetch(authorize, { redirect: "manual" });
  const back = new URL(String(fromProvider.headers.get("location")));
  const callbackPath = `${back.pathname}${back.search}`;
  const callback = await (options.callbackFrom ?? browser).get(callbackPath, {
    "sec-fetch-site": "cross-site",
  });
  const location = callback.headers.get("location");
  return {
    start,
    authorize,
    callbackPath,
    callback,
    location: location === null ? null : new URL(location),
  };
}

async function sessionOf(token: string | null) {
  const result = await h.admin.query<{
    id: string;
    user_id: string;
    assurance: string;
    created_via: string;
    mailbox_proved_at: Date | null;
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT id, user_id, assurance, created_via, mailbox_proved_at, expires_at, created_at
       FROM identity.session WHERE token = $1`,
    [token],
  );
  return result.rows[0] ?? null;
}

async function linesOf(event: string): Promise<Record<string, unknown>[]> {
  return h.lines.named(event).map((fields) => ({ ...fields }));
}

const crossSite = { "sec-fetch-site": "cross-site" };

/** Starts a Google sign-in in this browser: the provider's address, and the state it carries. */
async function startGoogle(
  browser: Browser,
): Promise<{ authorize: string; state: string; callbackOf(code: string): string }> {
  const start = await browser.post("/api/auth/sign-in/social", {
    provider: "google",
    callbackURL: "/sign-in?via=google",
    disableRedirect: true,
  });
  if (start.status !== 200) throw new Error(`/sign-in/social answered ${start.status}`);
  const authorize = String(start.json?.url);
  const state = String(new URL(authorize).searchParams.get("state"));
  return {
    authorize,
    state,
    callbackOf: (code) =>
      `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${state}`,
  };
}

/** The callback (path and query) the provider sends the browser back to, for this choice. */
async function providerBack(authorize: string, choice: FixtureAccount | "deny"): Promise<string> {
  fixture.chooseNext(choice);
  const answer = await fetch(authorize, { redirect: "manual" });
  const back = new URL(String(answer.headers.get("location")));
  return `${back.pathname}${back.search}`;
}

/** The `error` a callback's redirect carries back to the page (null when it succeeded). */
function errorOf(answer: Answer): string | null {
  const location = answer.headers.get("location");
  if (location === null) throw new Error(`no redirect: ${answer.status}`);
  return new URL(location).searchParams.get("error");
}

describe("Google off (the default)", () => {
  it("answers 404 with an empty body on every Google path, before the router", async () => {
    const off = await createHarness(database, "developer");
    expect(off.realm.settings.google).toBeNull();
    const browser = off.browser();
    for (const [method, path] of [
      ["POST", "/api/auth/sign-in/social"],
      ["GET", "/api/auth/callback/google"],
      ["GET", "/api/auth/callback/:id"],
      ["POST", "/api/auth/link-social"],
      ["POST", "/api/auth/unlink-account"],
    ] as const) {
      const answer = await browser.call(
        method,
        path,
        method === "POST" ? { provider: "google" } : undefined,
      );
      expect(answer.status, `${method} ${path}`).toBe(404);
      expect(answer.json).toBeNull();
    }
    expect(off.lines.lines.filter((l) => l.event === "auth.endpoint_blocked")).toHaveLength(5);
  });
});

describe("a Google sign-up", () => {
  it("sends state, PKCE, a nonce and the exact redirect URI, and makes an aal1 account with its events", async () => {
    const browser = h.browser();
    const maya = account("maya");
    const trip = await roundTrip(browser, maya);

    // The authorization request (§5.8).
    const p = trip.authorize.searchParams;
    expect(trip.authorize.origin).toBe(provider.origin);
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("openid email profile");
    expect(p.get("prompt")).toBe("select_account");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("nonce")?.length).toBeGreaterThanOrEqual(32);
    expect(p.get("state")?.length).toBeGreaterThanOrEqual(32);
    // The state cookie is the library's, host-only and Lax, so it comes back on the provider's
    // top-level redirect.
    const stateCookie = trip.start.setCookies.find((c) => c.startsWith("__Host-fin.state="));
    expect(stateCookie).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax/i);
    expect(stateCookie).not.toMatch(/domain=/i);

    // The token request carried the verifier and the same redirect URI.
    expect(fixture.exchanges.at(-1)).toMatchObject({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      pkce: true,
      outcome: "issued",
    });

    // Back on the console's own page, signed in with a Strict session.
    expect(trip.callback.status).toBe(302);
    expect(trip.location?.href).toBe(`${ORIGIN.developer}/sign-in?via=google`);
    expect(trip.callback.setCookies.find((c) => c.startsWith("__Host-fin.session_token="))).toMatch(
      /SameSite=Strict/i,
    );
    const session = await sessionOf(browser.sessionToken());
    expect(session).toMatchObject({ assurance: "aal1", created_via: "google" });
    expect(session?.mailbox_proved_at).not.toBeNull();

    const user = await h.admin.query<{
      id: string;
      email: string;
      name: string;
      email_verified: boolean;
    }>(`SELECT id, email, name, email_verified FROM identity."user" WHERE email = $1`, [
      maya.email,
    ]);
    expect(user.rows[0]).toMatchObject({
      email: maya.email,
      name: "Maya Rivera",
      email_verified: true,
    });
    const userId = String(user.rows[0]?.id);
    const accountRow = await h.admin.query(
      `SELECT id, account_id, provider_id, access_token, refresh_token, id_token, scope,
              access_token_expires_at, refresh_token_expires_at
         FROM identity.account WHERE user_id = $1`,
      [userId],
    );
    expect(accountRow.rows).toHaveLength(1);
    // No provider token is kept (§4.2).
    expect(accountRow.rows[0]).toMatchObject({
      account_id: maya.sub,
      provider_id: "google",
      access_token: null,
      refresh_token: null,
      id_token: null,
      scope: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
    });

    // The events, in the sign-up's transaction.
    const created = (await h.events({ event: "user.created" })).filter(
      (e) => e.target_id === userId,
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata).toEqual({ method: "google", viaInvitation: false });
    const linked = (await h.events({ event: "account.linked" })).filter((e) =>
      e.ref_ids.includes(userId),
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]?.target_id).toBe(String(accountRow.rows[0]?.id));
    expect(linked[0]?.metadata).toEqual({ provider: "google" });
    const sessions = (await h.events({ event: "session.created" })).filter(
      (e) => e.target_id === session?.id,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.metadata).toEqual({
      method: "google",
      assurance: "aal1",
      trustedBrowser: false,
    });

    // The first sign-in sends no new-sign-in notice.
    expect((await h.outbox(maya.email)).map((m) => m.template)).toEqual([]);
    // The request line names the realm, the path and the outcome, and no address.
    const request = (await linesOf("request")).at(-1);
    expect(request).toMatchObject({ realm: "developer", authPath: "/callback/:id", status: 302 });
    expect(JSON.stringify(h.lines.lines)).not.toContain(maya.email);
  });

  it("signs the same Google account in again, and tells the person about a new browser", async () => {
    const maya = account("again");
    await roundTrip(h.browser(), maya);
    const other = h.browser();
    const trip = await roundTrip(other, maya);
    expect(trip.location?.pathname).toBe("/sign-in");
    const users = await h.admin.query(`SELECT id FROM identity."user" WHERE email = $1`, [
      maya.email,
    ]);
    expect(users.rows).toHaveLength(1);
    const accounts = await h.admin.query(`SELECT id FROM identity.account WHERE user_id = $1`, [
      users.rows[0]?.id,
    ]);
    expect(accounts.rows).toHaveLength(1);
    expect((await h.outbox(maya.email)).map((m) => m.template)).toEqual(["identity/new-sign-in"]);
  });

  it("keeps a profile name only when it passes the name rule", async () => {
    const odd = account("odd", { name: "Visit www.example.com now" });
    await roundTrip(h.browser(), odd);
    const user = await h.admin.query<{ name: string }>(
      `SELECT name FROM identity."user" WHERE email = $1`,
      [odd.email],
    );
    expect(user.rows[0]?.name).toBe("");
  });

  it("is refused while sign-ups are paused, and counts toward the sign-up limits", async () => {
    await seed(h.admin, "UPDATE ops.kill_switch SET state = 'on' WHERE name = 'signups'");
    try {
      const paused = account("paused");
      const trip = await roundTrip(h.browser(), paused);
      expect(trip.location?.pathname).toBe("/sign-in");
      expect(trip.location?.searchParams.get("error")).toBe("unable_to_create_user");
      const users = await h.admin.query(`SELECT 1 FROM identity."user" WHERE email = $1`, [
        paused.email,
      ]);
      expect(users.rowCount).toBe(0);
      expect((await linesOf("auth.google_refused")).at(-1)).toEqual({
        realm: "developer",
        reason: "signups_paused",
      });
    } finally {
      await seed(h.admin, "UPDATE ops.kill_switch SET state = 'off' WHERE name = 'signups'");
    }
    // Five new accounts from one network in an hour; the sixth is refused ([SA-40]).
    const network = `2001:db8:${tag().slice(0, 4)}::9`;
    for (let i = 0; i < 5; i += 1) {
      const ok = await roundTrip(h.browser({ ip: network }), account(`net${i}`));
      expect(ok.location?.searchParams.get("error"), `account ${i}`).toBeNull();
    }
    const sixth = await roundTrip(h.browser({ ip: network }), account("net6"));
    expect(sixth.location?.searchParams.get("error")).toBe("unable_to_create_user");
    expect((await linesOf("auth.google_refused")).at(-1)?.reason).toBe("sign_up_limited");
  });
});

describe("the mailbox proof of a Google session (§5.8, §6.3)", () => {
  it("is given only when Google verified the account's own address this time", async () => {
    const maya = account("moved");
    const first = h.browser();
    await roundTrip(first, maya);
    expect((await sessionOf(first.sessionToken()))?.mailbox_proved_at).not.toBeNull();

    // The same Google account (its subject) comes back with another verified address.
    const browser = h.browser();
    const trip = await roundTrip(browser, {
      ...maya,
      email: `moved.elsewhere.${tag()}@example.com`,
    });
    expect(trip.location?.searchParams.get("error")).toBeNull();
    const session = await sessionOf(browser.sessionToken());
    expect(session).toMatchObject({ created_via: "google", assurance: "aal1" });
    expect(session?.mailbox_proved_at).toBeNull();
    const person = await h.admin.query<{ email: string }>(
      `SELECT email FROM identity."user" WHERE id = $1`,
      [session?.user_id],
    );
    expect(person.rows[0]?.email).toBe(maya.email);

    // So that session cannot add a first factor under the first-factor rule (§6.3).
    const enable = await browser.post("/api/auth/two-factor/enable", {});
    expect(enable.status).toBe(403);
    expect(enable.json).toMatchObject({ code: "fresh_session_required" });
    const options = await browser.get("/api/auth/passkey/generate-register-options");
    expect(options.status).toBe(403);
    expect(options.json).toMatchObject({ code: "fresh_session_required" });
  });
});

describe("what a Google sign-in refuses", () => {
  it("an address that has a Fin account Google is not linked to (no implicit linking)", async () => {
    const email = `coded.${tag()}@example.com`;
    await codeSignIn(h, h.browser(), email);
    const browser = h.browser();
    const trip = await roundTrip(browser, account("coded", { email }));
    expect(trip.location?.href).toBe(`${ORIGIN.developer}/sign-in?error=account_not_linked`);
    expect(browser.sessionToken()).toBeNull();
    const accounts = await h.admin.query(
      `SELECT a.id FROM identity.account a JOIN identity."user" u ON u.id = a.user_id WHERE u.email = $1`,
      [email],
    );
    expect(accounts.rowCount).toBe(0);
    expect((await linesOf("auth.google_refused")).at(-1)).toEqual({
      realm: "developer",
      reason: "account_not_linked",
    });
  });

  it("an address Google has not verified", async () => {
    const unverified = account("unverified", { emailVerified: false });
    const browser = h.browser();
    const trip = await roundTrip(browser, unverified);
    expect(trip.location?.searchParams.get("error")).toBe("email_unverified");
    expect(browser.sessionToken()).toBeNull();
    expect((await linesOf("auth.google_refused")).at(-1)?.reason).toBe("email_unverified");
    const users = await h.admin.query(`SELECT 1 FROM identity."user" WHERE email = $1`, [
      unverified.email,
    ]);
    expect(users.rowCount).toBe(0);
  });

  it("never carries the provider's own error text back to the page", async () => {
    const trip = await roundTrip(h.browser(), "deny");
    expect(trip.location?.searchParams.get("error")).toBe("access_denied");
    expect(trip.location?.searchParams.has("error_description")).toBe(false);
  });

  it("the person cancelling at Google", async () => {
    const browser = h.browser();
    const trip = await roundTrip(browser, "deny");
    expect(trip.location?.searchParams.get("error")).toBe("access_denied");
    expect(browser.sessionToken()).toBeNull();
  });

  it.each([
    ["nonce", "nonce"],
    ["audience", "audience"],
    ["issuer", "issuer"],
    ["expired", "expired"],
    ["issued_long_ago", "issued_at"],
    ["signature", "signature"],
    ["alg_none", "algorithm"],
    ["unknown_kid", "unknown_key"],
    ["token_error", "token_exchange"],
  ] as const)("an ID token with a planted fault: %s", async (tamper, reason) => {
    const person = account(`t${tamper.replaceAll("_", "")}`);
    const browser = h.browser();
    const refusals = h.lines.named("auth.google_refused").length;
    const trip = await roundTrip(browser, person, { tamper });
    expect(trip.location?.pathname).toBe("/sign-in");
    expect(trip.location?.searchParams.get("error")).toBe("google_failed");
    expect(browser.sessionToken()).toBeNull();
    expect((await linesOf("auth.google_failed")).at(-1)).toEqual({ realm: "developer", reason });
    // A failure, not a refusal of the person: the request line says so, no refusal line.
    expect(h.lines.named("auth.google_refused").length).toBe(refusals);
    expect((await linesOf("request")).at(-1)).toMatchObject({
      outcome: "error",
      reason: "google.failed",
    });
    const users = await h.admin.query(`SELECT 1 FROM identity."user" WHERE email = $1`, [
      person.email,
    ]);
    expect(users.rowCount).toBe(0);
  });

  it("a callback in a browser that did not start it (the state is bound to its cookie)", async () => {
    const victim = h.browser();
    const exchanges = fixture.exchanges.length;
    const trip = await roundTrip(h.browser(), account("csrf"), { callbackFrom: victim });
    expect(trip.location?.searchParams.get("error")).toBe("state_mismatch");
    expect(victim.sessionToken()).toBeNull();
    // Nothing was exchanged for a browser without the state's cookie.
    expect(fixture.exchanges.length).toBe(exchanges);
  });

  it("a state cookie the realm did not sign: no exchange, and the browser that started it still finishes", async () => {
    const starter = h.browser();
    const { authorize, state } = await startGoogle(starter);
    const callbackPath = await providerBack(authorize, account("forged"));
    const exchanges = fixture.exchanges.length;
    const otherSecret = randomBytes(32).toString("base64url");
    for (const forged of [
      `${state}.forged-signature`,
      `${state}.${createHmac("sha256", otherSecret).update(state).digest("base64")}`,
      state,
    ]) {
      const stranger = h.browser();
      stranger.jar.set("__Host-fin.state", encodeURIComponent(forged));
      const answer = await stranger.get(callbackPath, crossSite);
      expect(errorOf(answer)).toBe("state_mismatch");
      expect(stranger.sessionToken()).toBeNull();
    }
    expect(fixture.exchanges.length).toBe(exchanges);
    // The state is still the starter's, and its code unspent: its own callback signs in.
    const own = await starter.get(callbackPath, crossSite);
    expect(errorOf(own)).toBeNull();
    expect(starter.sessionToken()).not.toBeNull();
    expect(fixture.exchanges.length).toBe(exchanges + 1);
  });

  it.each([
    [
      "its row",
      "UPDATE identity.verification SET expires_at = now() - interval '1 second' WHERE identifier = $1",
    ],
    [
      "its stored expiry",
      `UPDATE identity.verification
          SET value = jsonb_set(value::jsonb, '{expiresAt}',
                to_jsonb((extract(epoch FROM now()) * 1000)::bigint - 1000))::text
        WHERE identifier = $1`,
    ],
  ])("an expired state (%s): no exchange, no session", async (_label, expire) => {
    const browser = h.browser();
    const { authorize, state } = await startGoogle(browser);
    const callbackPath = await providerBack(authorize, account("late"));
    await h.admin.query(expire, [`auth-state:${state}`]);
    const exchanges = fixture.exchanges.length;
    const answer = await browser.get(callbackPath, crossSite);
    expect(answer.status).toBe(302);
    expect(errorOf(answer)).not.toBeNull();
    expect(fixture.exchanges.length).toBe(exchanges);
    expect(browser.sessionToken()).toBeNull();
  });

  it("one state buys one exchange, even for two callbacks at once", async () => {
    const starter = h.browser();
    const { authorize } = await startGoogle(starter);
    // Two codes for the one state (two accounts at the provider), in two jars holding its cookie.
    const people = [account("twin"), account("twin")];
    const paths = [
      await providerBack(authorize, people[0] as FixtureAccount),
      await providerBack(authorize, people[1] as FixtureAccount),
    ];
    const jars = [h.browser(), h.browser()];
    for (const jar of jars) for (const [name, value] of starter.jar) jar.jar.set(name, value);
    const exchanges = fixture.exchanges.length;
    const answers = await Promise.all(jars.map((jar, i) => jar.get(String(paths[i]), crossSite)));
    expect(fixture.exchanges.length).toBe(exchanges + 1);
    expect(answers.map(errorOf).sort()).toEqual([null, "state_mismatch"].sort());
    expect(jars.filter((jar) => jar.sessionToken() !== null)).toHaveLength(1);
    const made = await h.admin.query(`SELECT 1 FROM identity."user" WHERE email = ANY($1)`, [
      people.map((p) => p.email),
    ]);
    expect(made.rowCount).toBe(1);
  });

  it("claims a state under its row's lock: a second claim waits for the first, then finds it spent", async () => {
    const { state } = await startGoogle(h.browser());
    const pool = database.login("fin_console", { max: 2 });
    const first = await pool.connect();
    const second = await pool.connect();
    const asUnit = (client: PoolClient): Queryable => ({
      async query<R extends object>(text: string, values?: readonly unknown[]) {
        const result = await client.query(text, values === undefined ? [] : [...values]);
        return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
      },
    });
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      expect((await claimState(asUnit(first), state, new Date(), "req_first")).kind).toBe(
        "claimed",
      );
      const pid = (await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      const waiting = claimState(asUnit(second), state, new Date(), "req_second");
      // The second claim blocks on the row the first one holds, until the first commits.
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i += 1) {
        const activity = await h.admin.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        blocked = activity.rows[0]?.wait_event_type === "Lock";
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await first.query("COMMIT");
      expect((await waiting).kind).toBe("spent");
      await second.query("COMMIT");
    } finally {
      first.release();
      second.release();
      await pool.end();
    }
    const row = await h.admin.query<{ value: string }>(
      "SELECT value FROM identity.verification WHERE identifier = $1",
      [`auth-state:${state}`],
    );
    expect(JSON.parse(String(row.rows[0]?.value))[STATE_CLAIM_KEY]).toBe("req_first");
  });

  it("refuses a callback whose state another callback has claimed, before the library consumes it", async () => {
    const browser = h.browser();
    const { authorize, state } = await startGoogle(browser);
    const callbackPath = await providerBack(authorize, account("claimed"));
    // Another callback of this state holds its one exchange.
    await h.admin.query(
      `UPDATE identity.verification
          SET value = jsonb_set(value::jsonb, ARRAY[$2], to_jsonb('req_other'::text))::text
        WHERE identifier = $1`,
      [`auth-state:${state}`, STATE_CLAIM_KEY],
    );
    const exchanges = fixture.exchanges.length;
    const answer = await browser.get(callbackPath, crossSite);
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toBe(`${ORIGIN.developer}/sign-in?error=state_mismatch`);
    expect(fixture.exchanges.length).toBe(exchanges);
    expect(browser.sessionToken()).toBeNull();
    expect((await linesOf("auth.google_refused")).at(-1)).toEqual({
      realm: "developer",
      reason: "state_used",
    });
    expect((await linesOf("request")).at(-1)).toMatchObject({
      outcome: "refused",
      reason: "google.state_used",
      status: 302,
    });
    // The state is left to the callback that claimed it.
    const row = await h.admin.query("SELECT 1 FROM identity.verification WHERE identifier = $1", [
      `auth-state:${state}`,
    ]);
    expect(row.rowCount).toBe(1);
  });

  it("a code the provider refuses: a refusal of the client, not a failure of Fin or Google", async () => {
    const browser = h.browser();
    const { callbackOf } = await startGoogle(browser);
    const failures = h.lines.named("auth.google_failed").length;
    const exchanges = fixture.exchanges.length;
    const answer = await browser.get(callbackOf("not-a-code"), crossSite);
    expect(fixture.exchanges.slice(exchanges)).toEqual([
      expect.objectContaining({ outcome: "refused", error: "invalid_grant" }),
    ]);
    expect(errorOf(answer)).toBe("invalid_code");
    expect(browser.sessionToken()).toBeNull();
    expect(h.lines.named("auth.google_failed").length).toBe(failures);
    expect((await linesOf("auth.google_refused")).at(-1)).toEqual({
      realm: "developer",
      reason: "invalid_code",
    });
    expect((await linesOf("request")).at(-1)).toMatchObject({
      outcome: "refused",
      reason: "google.invalid_code",
      status: 302,
    });
  });

  it("answers the callback route's pattern 404, even with a live state, its cookie and a code", async () => {
    const browser = h.browser();
    const { authorize } = await startGoogle(browser);
    const callbackPath = await providerBack(authorize, account("pattern"));
    const exchanges = fixture.exchanges.length;
    const literal = await browser.get(
      callbackPath.replace("/callback/google", "/callback/:id"),
      crossSite,
    );
    expect(literal.status).toBe(404);
    expect(literal.json).toBeNull();
    expect(fixture.exchanges.length).toBe(exchanges);
    // The state is untouched: the real callback still finishes.
    const real = await browser.get(callbackPath, crossSite);
    expect(errorOf(real)).toBeNull();
    expect(browser.sessionToken()).not.toBeNull();
  });

  it("a callback replayed after it was used (the state works once)", async () => {
    const browser = h.browser();
    const person = account("replay");
    const trip = await roundTrip(browser, person);
    expect(trip.location?.pathname).toBe("/sign-in");
    const exchanges = fixture.exchanges.length;
    const again = await browser.get(trip.callbackPath, { "sec-fetch-site": "cross-site" });
    expect(again.status).toBe(302);
    // The state cookie went with the first use, so nothing is exchanged again.
    expect(fixture.exchanges.length).toBe(exchanges);
    expect(new URL(String(again.headers.get("location"))).searchParams.get("error")).toMatch(
      /^state_(mismatch|not_found)$/,
    );
  });

  it.each([
    ["another site", { callbackURL: "https://evil.example.org/sign-in" }],
    ["a protocol-relative path", { callbackURL: "//evil.example.org/sign-in" }],
    ["a backslashed path", { callbackURL: "/\\evil.example.org" }],
    ["an API path", { callbackURL: "/api/viewer" }],
    ["a page outside the flow", { callbackURL: "/settings/team" }],
    ["an unsafe next", { callbackURL: "/sign-in?next=//evil.example.org" }],
    ["an extra query field", { callbackURL: "/sign-in?redirect=/x" }],
    ["an error page elsewhere", { errorCallbackURL: "https://evil.example.org/" }],
    ["another provider", { provider: "github" }],
  ])("refuses %s as a redirect target or provider (400 invalid)", async (_label, body) => {
    const answer = await h.browser().post("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/sign-in",
      disableRedirect: true,
      ...body,
    });
    expect(answer.status).toBe(400);
    expect(answer.json).toMatchObject({ code: "invalid" });
  });

  it("ignores an ID token, scopes and extra parameters the client sends (redirect only)", async () => {
    const answer = await h.browser().post("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: `${ORIGIN.developer}/sign-up`,
      disableRedirect: true,
      idToken: { token: "x.y.z" },
      scopes: ["https://www.googleapis.com/auth/drive"],
      loginHint: "someone@example.com",
      additionalParams: { access_type: "offline" },
    });
    expect(answer.status).toBe(200);
    const url = new URL(String(answer.json?.url));
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("login_hint")).toBeNull();
    expect(url.searchParams.get("access_type")).toBeNull();
  });
});

describe("the network's code exchange allowance (§5.6)", () => {
  it("counts each exchange a network causes, and past 30 a minute refuses before any exchange", async () => {
    // A clock that stands still keeps every request in one window of the allowance.
    const limited = await createHarness(database, "developer", {
      env: googleEnv(),
      clock: new ManualClock(new Date()),
    });
    const ip = `2001:db8:${tag().slice(0, 4)}::5`;
    const junkCallback = async (from: string) => {
      const browser = limited.browser({ ip: from });
      const start = await browser.post("/api/auth/sign-in/social", {
        provider: "google",
        callbackURL: "/sign-in",
        disableRedirect: true,
      });
      const state = new URL(String(start.json?.url)).searchParams.get("state");
      return browser.get(`/api/auth/callback/google?code=junk-${tag()}&state=${state}`, crossSite);
    };
    const exchanges = fixture.exchanges.length;
    for (let i = 0; i < 30; i += 1) {
      expect((await junkCallback(ip)).status, `callback ${i + 1}`).toBe(302);
    }
    expect(fixture.exchanges.length).toBe(exchanges + 30);

    const refused = await junkCallback(ip);
    expect(refused.status).toBe(429);
    expect(refused.json).toMatchObject({ code: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(fixture.exchanges.length).toBe(exchanges + 30);
    expect(limited.lines.named("limits.refused").at(-1)).toEqual({ bucket: "google_exchange" });
    expect(limited.lines.named("request").at(-1)).toMatchObject({
      outcome: "refused",
      reason: "limits.google_exchange",
      status: 429,
    });

    // Another network keeps its own allowance.
    expect((await junkCallback(`2001:db8:${tag().slice(0, 4)}::6`)).status).toBe(302);
    expect(fixture.exchanges.length).toBe(exchanges + 31);
  });
});

describe("the factor step after Google", () => {
  it("holds a person with a factor at the factor step, with a 10-minute session", async () => {
    const maya = account("factor");
    const first = h.browser();
    await roundTrip(first, maya);
    await setUpAuthenticator(first);
    const browser = h.browser();
    const trip = await roundTrip(browser, maya);
    expect(trip.location?.pathname).toBe("/sign-in");
    const session = await sessionOf(browser.sessionToken());
    expect(session?.assurance).toBe("aal1");
    const life = (session?.expires_at.getTime() ?? 0) - (session?.created_at.getTime() ?? 0);
    expect(life).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
    const required = (await h.events({ event: "sign_in.second_factor_required" })).find(
      (e) => e.target_id === session?.id,
    );
    expect(required?.metadata).toEqual({ methods: ["authenticator", "backup_code"] });
    // At the factor step, only the factor endpoints answer.
    const refused = await browser.post("/api/auth/two-factor/generate-backup-codes", {});
    expect(refused.json).toMatchObject({ code: "factor_step_required" });
  });
});

/** A person signed in by code with an authenticator, and a way to prove intents. */
async function personWithFactor(label: string) {
  const email = `${label}.${tag()}@example.com`;
  const browser = h.browser();
  await codeSignIn(h, browser, email);
  const { secret } = await setUpAuthenticator(browser);
  const prove = async (intentId: string) => {
    await h.admin.query("UPDATE identity.totp_step SET last_step = 0");
    const proved = await browser.post(
      "/api/auth/two-factor/verify-totp",
      { code: hotp(secret, totpStep(new Date())) },
      { "fin-step-up-intent": intentId },
    );
    expect(proved.status, JSON.stringify(proved.json)).toBe(200);
  };
  const user = await h.admin.query<{ id: string }>(
    `SELECT id FROM identity."user" WHERE email = $1`,
    [email],
  );
  return { email, browser, prove, userId: String(user.rows[0]?.id) };
}

/** `/link-social` through its step-up: asked, proved, re-sent with the intent. */
async function linkIntent(person: Awaited<ReturnType<typeof personWithFactor>>): Promise<string> {
  const asked = await person.browser.post("/api/auth/link-social", {
    provider: "google",
    callbackURL: "/account/security",
    disableRedirect: true,
  });
  expect(asked.status).toBe(403);
  expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: "link_google" });
  const intentId = String(asked.json?.intent_id);
  await person.prove(intentId);
  return intentId;
}

describe("linking Google from Account security", () => {
  it("links the same address with an intent, in one transaction with its event and notice", async () => {
    const person = await personWithFactor("link");
    const intentId = await linkIntent(person);
    const google = account("link", { email: person.email });
    const trip = await roundTrip(person.browser, google, {
      start: "/link-social",
      headers: { "fin-step-up-intent": intentId },
    });
    expect(trip.location?.href).toBe(`${ORIGIN.developer}/account/security`);
    const row = await h.admin.query<{ id: string }>(
      `SELECT id FROM identity.account WHERE user_id = $1 AND provider_id = 'google'`,
      [person.userId],
    );
    expect(row.rows).toHaveLength(1);
    const event = (await h.events({ event: "account.linked" })).find(
      (e) => e.target_id === row.rows[0]?.id,
    );
    expect(event).toMatchObject({
      actor_kind: "user",
      actor_id: person.userId,
      step_up_ref: intentId,
    });
    expect(event?.ref_ids).toEqual(expect.arrayContaining([person.userId, intentId]));
    const intent = await h.admin.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM ops.step_up_intent WHERE id = $1",
      [intentId],
    );
    expect(intent.rows[0]?.consumed_at).not.toBeNull();
    const notices = await h.outbox(person.email);
    expect(notices.at(-1)).toMatchObject({
      template: "identity/sign-in-methods-changed",
      params: { kind: "google_linked" },
    });

    // Google now signs the person in.
    const later = h.browser();
    const signIn = await roundTrip(later, google);
    expect(signIn.location?.searchParams.get("error")).toBeNull();
    expect((await sessionOf(later.sessionToken()))?.user_id).toBe(person.userId);
  });

  it("refuses a Google account with another address, and leaves the intent unused", async () => {
    const person = await personWithFactor("mismatch");
    const intentId = await linkIntent(person);
    const trip = await roundTrip(person.browser, account("someone-else"), {
      start: "/link-social",
      headers: { "fin-step-up-intent": intentId },
    });
    expect(trip.location?.searchParams.get("error")).toBe("email_does_not_match");
    const rows = await h.admin.query(`SELECT 1 FROM identity.account WHERE user_id = $1`, [
      person.userId,
    ]);
    expect(rows.rowCount).toBe(0);
    const intent = await h.admin.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM ops.step_up_intent WHERE id = $1",
      [intentId],
    );
    expect(intent.rows[0]?.consumed_at).toBeNull();
  });

  it("refuses a link whose intent was used meanwhile, before anything is linked", async () => {
    const person = await personWithFactor("used");
    const intentId = await linkIntent(person);
    const started = await person.browser.post(
      "/api/auth/link-social",
      { provider: "google", callbackURL: "/account/security", disableRedirect: true },
      { "fin-step-up-intent": intentId },
    );
    expect(started.status).toBe(200);
    await seed(h.admin, "UPDATE ops.step_up_intent SET consumed_at = now() WHERE id = $1", [
      intentId,
    ]);
    fixture.chooseNext(account("used", { email: person.email }));
    const back = await fetch(String(started.json?.url), { redirect: "manual" });
    const location = new URL(String(back.headers.get("location")));
    const callback = await person.browser.get(`${location.pathname}${location.search}`);
    expect(new URL(String(callback.headers.get("location"))).href).toBe(
      `${ORIGIN.developer}/account/security?error=step_up_invalid`,
    );
    const rows = await h.admin.query(`SELECT 1 FROM identity.account WHERE user_id = $1`, [
      person.userId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("asks a person with no factor to add one first", async () => {
    const browser = h.browser();
    await codeSignIn(h, browser, `nofactor.${tag()}@example.com`);
    const asked = await browser.post("/api/auth/link-social", {
      provider: "google",
      callbackURL: "/account/security",
    });
    expect(asked.status).toBe(403);
    expect(asked.json).toMatchObject({ code: "second_factor_required" });
  });
});

describe("unlinking Google", () => {
  it("removes only the person's own Google account, with an intent, its event and notice", async () => {
    const person = await personWithFactor("unlink");
    const intentId = await linkIntent(person);
    await roundTrip(person.browser, account("unlink", { email: person.email }), {
      start: "/link-social",
      headers: { "fin-step-up-intent": intentId },
    });
    const row = await h.admin.query<{ id: string }>(
      `SELECT id FROM identity.account WHERE user_id = $1 AND provider_id = 'google'`,
      [person.userId],
    );
    const accountId = String(row.rows[0]?.id);

    // Someone else's account is not found, whatever the intent.
    const stranger = await personWithFactor("stranger");
    const theirs = await stranger.browser.post("/api/auth/unlink-account", { accountId }, {});
    expect(theirs.status).toBe(403);
    const theirIntent = String(theirs.json?.intent_id);
    await stranger.prove(theirIntent);
    const refused = await stranger.browser.post(
      "/api/auth/unlink-account",
      { accountId },
      { "fin-step-up-intent": theirIntent },
    );
    expect(refused.status).toBe(404);

    const asked = await person.browser.post("/api/auth/unlink-account", { accountId });
    expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: "unlink_google" });
    const unlinkIntent = String(asked.json?.intent_id);
    await person.prove(unlinkIntent);
    const done = await person.browser.post(
      "/api/auth/unlink-account",
      { accountId },
      { "fin-step-up-intent": unlinkIntent },
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const left = await h.admin.query(`SELECT 1 FROM identity.account WHERE id = $1`, [accountId]);
    expect(left.rowCount).toBe(0);
    const event = (await h.events({ event: "account.unlinked" })).find(
      (e) => e.target_id === accountId,
    );
    expect(event).toMatchObject({ step_up_ref: unlinkIntent, metadata: { provider: "google" } });
    expect((await h.outbox(person.email)).at(-1)).toMatchObject({
      template: "identity/sign-in-methods-changed",
      params: { kind: "google_unlinked" },
    });
  });

  it("unlinks from a session older than a day once the step-up passes (the intent is the proof)", async () => {
    const person = await personWithFactor("aged");
    const linkId = await linkIntent(person);
    await roundTrip(person.browser, account("aged", { email: person.email }), {
      start: "/link-social",
      headers: { "fin-step-up-intent": linkId },
    });
    const row = await h.admin.query<{ id: string }>(
      `SELECT id FROM identity.account WHERE user_id = $1 AND provider_id = 'google'`,
      [person.userId],
    );
    const accountId = String(row.rows[0]?.id);
    // Two days old, and still live: 24 hours idle and 7 days at most (§11.1).
    await h.admin.query(
      "UPDATE identity.session SET created_at = now() - interval '2 days' WHERE token = $1",
      [person.browser.sessionToken()],
    );
    expect((await person.browser.get("/api/auth/get-session")).json).not.toBeNull();

    const asked = await person.browser.post("/api/auth/unlink-account", { accountId });
    expect(asked.json).toMatchObject({ code: "step_up_required", reason_key: "unlink_google" });
    const unlinkIntent = String(asked.json?.intent_id);
    await person.prove(unlinkIntent);
    const done = await person.browser.post(
      "/api/auth/unlink-account",
      { accountId },
      { "fin-step-up-intent": unlinkIntent },
    );
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const left = await h.admin.query(`SELECT 1 FROM identity.account WHERE id = $1`, [accountId]);
    expect(left.rowCount).toBe(0);
    const intent = await h.admin.query<{ consumed_at: Date | null }>(
      "SELECT consumed_at FROM ops.step_up_intent WHERE id = $1",
      [unlinkIntent],
    );
    expect(intent.rows[0]?.consumed_at).not.toBeNull();
    expect(
      (await h.events({ event: "account.unlinked" })).find((e) => e.target_id === accountId),
    ).toMatchObject({ step_up_ref: unlinkIntent });
  });
});

describe("the audit guard on the account row (§13.8)", () => {
  it("refuses a Google sign-up whose events are not written, and keeps nothing", async () => {
    const silent = await createHarness(database, "developer", {
      env: googleEnv(),
      deps: { audit: async () => "evt_silenced" },
    });
    const person = account("silent");
    const browser = silent.browser();
    const start = await browser.post("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/sign-in",
      disableRedirect: true,
    });
    fixture.chooseNext(person);
    const back = new URL(
      String(
        (await fetch(String(start.json?.url), { redirect: "manual" })).headers.get("location"),
      ),
    );
    const callback = await browser.get(`${back.pathname}${back.search}`);
    expect(callback.status).toBe(500);
    expect(callback.setCookies.some((c) => c.startsWith("__Host-fin.session_token="))).toBe(false);
    const users = await h.admin.query(`SELECT 1 FROM identity."user" WHERE email = $1`, [
      person.email,
    ]);
    expect(users.rowCount).toBe(0);
  });
});
