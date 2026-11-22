// Google sign-in for the staff realm on Postgres 18 (spec 02 §5.8, §6.4, §10.5, §13.8, §16.4;
// [SA-15]): the staff realm against the fixture OpenID provider on a real socket, its own switch
// on with the Workspace domain. Proves that Google is at most a first factor (the session is the
// emailed code's `aal1`: the factor step for a member with a factor, enrolment for a pending one,
// still needing the enrolment code), that the session is bound to the request's Access identity
// and checked against it again on the next request, that only a listed member whose verified
// address is the Access identity's and whose token carries the Workspace's `hd` gets one (an
// unknown, removed, mismatched or outside address is refused, with its line and, for a member,
// `staff.sign_in_failed`), that no member and no sign-in method row is ever made, that the state
// is consumed once, and the library's own refusals (a cancelled sign-in, an unverified address).
// As in the developer realm, whatever a client causes by changing its own authorization request is
// a refusal of the round trip, never a failure of Fin or the provider, and a token that is not the
// provider's stays a failure however long it is.
import { createHash, randomBytes } from "node:crypto";
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
  createHarness,
  type Harness,
  ORIGIN,
  passkeyCeremony,
  registerPasskey,
} from "../test/harness.ts";
import { systemClock } from "./ports/clock.ts";
import { newId } from "./ports/ids.ts";
import { issueEnrolmentCode, redeemEnrolmentCode } from "./staff/enrolment.ts";

const ADMIN = ORIGIN.staff;
const CLIENT_ID = "fin-admin-test.apps.example.com";
const REDIRECT_URI = `${ADMIN}/api/auth/callback/google`;
/** The company Workspace's domain in these tests (example.com, as every fixture address). */
const WORKSPACE = "example.com";

let database: TestDatabase;
let provider: RunningOAuthFixture;
let fixture: OAuthFixture;
let h: Harness;
const clientSecret = randomBytes(24).toString("base64url");

beforeAll(async () => {
  database = await createTestDatabase("staff_google");
  fixture = new OAuthFixture();
  provider = await startOAuthFixture(fixture);
  fixture.registerClient({ clientId: CLIENT_ID, clientSecret, redirectUris: [REDIRECT_URI] });
  h = await createHarness(database, "staff", {
    env: {
      FIN_FEATURE_STAFF_GOOGLE: "on",
      FIN_GOOGLE_CLIENT_ID: CLIENT_ID,
      FIN_GOOGLE_CLIENT_SECRET: clientSecret,
      FIN_GOOGLE_HOSTED_DOMAIN: WORKSPACE,
      FIN_GOOGLE_TEST_ISSUER: provider.origin,
    },
  });
  // Cloning the template waits on the server, which the other files keep busy.
}, 60_000);

afterAll(async () => {
  await provider?.close();
  await database?.drop();
});

const unique = (label: string) => `${label}.${randomBytes(4).toString("hex")}@${WORKSPACE}`;
const crossSite = { "sec-fetch-site": "cross-site" };

async function addMember(
  email: string,
  status: "pending" | "active" | "removed",
  roleKey = "operator",
): Promise<string> {
  const id = newId("stf", systemClock);
  await seed(
    h.admin,
    `INSERT INTO staff.member (id, email, role_key, status, added_by, factor_enrolled_at, removed_at)
     VALUES ($1, $2, $3, $4, 'operator',
             CASE WHEN $4 = 'active' THEN now() END, CASE WHEN $4 = 'removed' THEN now() END)`,
    [id, email, roleKey, status],
  );
  return id;
}

function accessFor(email: string) {
  return { email, sub: `sub-${email}` };
}

function staffBrowser(email: string | null): Browser {
  return h.browser({ access: email === null ? null : accessFor(email) });
}

function googleAccount(email: string, overrides: Partial<FixtureAccount> = {}): FixtureAccount {
  return {
    sub: `1${randomBytes(8).readBigUInt64BE().toString().slice(0, 18)}`,
    email,
    name: "Nadia Haddad",
    hd: WORKSPACE,
    ...overrides,
  };
}

interface RoundTrip {
  start: Answer;
  authorize: URL;
  callbackPath: string;
  callback: Answer;
  location: URL;
}

/**
 * Starts a staff Google sign-in in this browser, lets the fixture answer, follows the callback.
 * `edit` changes the authorization request on its way through the browser, as a client may;
 * `tamper` plants a fault in the provider's token answer; `addToCallback` is appended to the
 * callback's query, as a client may.
 */
async function roundTrip(
  browser: Browser,
  choice: FixtureAccount | "deny",
  options: {
    edit?: (params: URLSearchParams) => void;
    tamper?: Tamper;
    addToCallback?: string;
    callbackFrom?: Browser;
  } = {},
): Promise<RoundTrip> {
  const start = await browser.post("/api/auth/sign-in/social", {
    provider: "google",
    callbackURL: "/sign-in",
    errorCallbackURL: "/sign-in",
    disableRedirect: true,
  });
  if (start.status !== 200) {
    throw new Error(`/sign-in/social answered ${start.status}: ${JSON.stringify(start.json)}`);
  }
  const authorize = new URL(String(start.json?.url));
  fixture.chooseNext(choice);
  fixture.tamperNext(options.tamper ?? null);
  const sent = new URL(authorize);
  options.edit?.(sent.searchParams);
  const fromProvider = await fetch(sent, { redirect: "manual" });
  const back = new URL(String(fromProvider.headers.get("location")));
  const callbackPath = `${back.pathname}${back.search}${options.addToCallback ?? ""}`;
  const callback = await (options.callbackFrom ?? browser).get(callbackPath, crossSite);
  const location = callback.headers.get("location");
  if (location === null) {
    throw new Error(`the callback answered ${callback.status}: ${JSON.stringify(callback.json)}`);
  }
  return { start, authorize, callbackPath, callback, location: new URL(location) };
}

async function sessionOf(browser: Browser) {
  const result = await h.admin.query<{
    id: string;
    user_id: string;
    assurance: string;
    created_via: string;
    access_sub: string;
    enrolment_open_until: Date | null;
    expires_at: Date;
    absolute_expires_at: Date;
    created_at: Date;
  }>(
    `SELECT id, user_id, assurance, created_via, access_sub, enrolment_open_until, expires_at,
            absolute_expires_at, created_at
       FROM staff.session WHERE token = $1`,
    [browser.sessionToken()],
  );
  return result.rows[0] ?? null;
}

async function sessionsOf(memberId: string): Promise<number> {
  const result = await h.admin.query<{ n: number }>(
    "SELECT count(*)::integer AS n FROM staff.session WHERE user_id = $1",
    [memberId],
  );
  return result.rows[0]?.n ?? 0;
}

async function stateRows(state: string): Promise<number> {
  const result = await h.admin.query<{ n: number }>(
    "SELECT count(*)::integer AS n FROM staff.verification WHERE identifier = $1",
    [`auth-state:${state}`],
  );
  return result.rows[0]?.n ?? 0;
}

async function failures(memberId: string) {
  return (await h.events({ event: "staff.sign_in_failed" })).filter(
    (e) => e.target_id === memberId,
  );
}

/** A pending member signed in by an emailed code, who redeems an enrolment code and adds a passkey. */
async function enrolledMember(label: string) {
  const email = unique(label);
  const memberId = await addMember(email, "pending");
  const browser = staffBrowser(email);
  await browser.post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
  const code = await h.latestCode(email);
  const signedIn = await browser.post("/api/auth/sign-in/email-otp", { email, otp: code });
  expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
  const context = { requestId: newId("req", systemClock), clientIp: null, userAgent: null };
  const issued = await h.realm.run(context, (tx) =>
    issueEnrolmentCode(tx, h.realm.runtime, {
      memberId,
      reason: "added",
      issuedBy: "operator",
      actor: { kind: "operator", id: null },
    }),
  );
  const session = await sessionOf(browser);
  await h.realm.run(browser.context(), (tx) =>
    redeemEnrolmentCode(tx, h.realm.runtime, {
      memberId,
      sessionId: session?.id as string,
      code: issued.code,
    }),
  );
  const authenticator = h.authenticator();
  const { verify } = await registerPasskey(browser, authenticator);
  expect(verify.status, JSON.stringify(verify.json)).toBe(200);
  return { email, memberId, authenticator };
}

describe("a member with a factor (§6.4)", () => {
  it("gets an aal1 session at the factor step, bound to Access, and the factor still decides", async () => {
    const { email, memberId, authenticator } = await enrolledMember("google.active");
    const browser = staffBrowser(email);
    const trip = await roundTrip(browser, googleAccount(email));

    // The authorization request names the Workspace, with PKCE, a nonce and the chooser.
    expect(trip.authorize.searchParams.get("hd")).toBe(WORKSPACE);
    expect(trip.authorize.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(trip.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(trip.authorize.searchParams.get("prompt")).toBe("select_account");

    // Back to the sign-in page, which sends a session at the factor step on to the factor page.
    expect(trip.callback.status).toBe(302);
    expect(trip.location.href).toBe(`${ADMIN}/sign-in`);
    expect(
      trip.callback.setCookies.some((c) =>
        /^__Host-fin-admin\.session_token=.*SameSite=Strict/i.test(c),
      ),
    ).toBe(true);
    expect(trip.callback.setCookies.some((c) => /^__Host-fin-admin\.state=;/i.test(c))).toBe(true);
    const session = await sessionOf(browser);
    expect(session).toMatchObject({
      user_id: memberId,
      assurance: "aal1",
      created_via: "google",
      access_sub: `sub-${email}`,
      enrolment_open_until: null,
    });
    const lifetime = (session?.expires_at.getTime() ?? 0) - (session?.created_at.getTime() ?? 0);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    const required = (await h.events({ event: "staff.second_factor_required" })).find(
      (e) => e.target_id === session?.id,
    );
    expect(required?.ref_ids).toContain(memberId);
    expect(h.lines.named("request").at(-1)).toMatchObject({
      authPath: "/callback/:id",
      staffId: memberId,
      assurance: "aal1",
      gate: "factor_step",
    });
    // No sign-in method row: staff keep no Google account (§13.8), and the state is spent.
    const accounts = await h.admin.query("SELECT 1 FROM staff.account");
    expect(accounts.rowCount).toBe(0);
    expect(await stateRows(String(trip.authorize.searchParams.get("state")))).toBe(0);

    // At the factor step nothing else is reachable: removing a factor, for one.
    const held = await browser.post("/api/auth/two-factor/disable", {});
    expect(held.status).toBe(403);
    expect(held.json).toMatchObject({ code: "factor_step_required", methods: ["passkey"] });

    // The passkey finishes the factor step: a new aal2 session replaces nothing of Google's.
    const factor = await passkeyCeremony(browser, authenticator);
    expect(factor.status, JSON.stringify(factor.json)).toBe(200);
    expect(await sessionOf(browser)).toMatchObject({ assurance: "aal2", user_id: memberId });
  });

  it("is checked against Access on the next request: another Access identity ends the session", async () => {
    const { email, memberId } = await enrolledMember("google.access");
    const browser = staffBrowser(email);
    await roundTrip(browser, googleAccount(email));
    const before = await sessionsOf(memberId);
    expect((await sessionOf(browser))?.assurance).toBe("aal1");
    browser.options.access = accessFor(unique("someone.else"));
    const after = await browser.get("/api/auth/get-session");
    expect(after.status).toBe(403);
    expect(after.json).toMatchObject({ code: "access_mismatch" });
    expect(await sessionsOf(memberId)).toBe(before - 1);
    expect(h.lines.named("staff.access_mismatch").at(-1)).toEqual({ staffId: memberId });
  });
});

describe("a pending member (§6.5)", () => {
  it("gets an aal1 session at enrolment, which still needs the enrolment code", async () => {
    const email = unique("google.pending");
    const memberId = await addMember(email, "pending");
    const browser = staffBrowser(email);
    const trip = await roundTrip(browser, googleAccount(email));
    expect(trip.location.href).toBe(`${ADMIN}/sign-in`);
    expect(await sessionOf(browser)).toMatchObject({ user_id: memberId, assurance: "aal1" });
    expect(h.lines.named("request").at(-1)).toMatchObject({ gate: "pending" });
    // Google opens no enrolment window: registering a factor needs the enrolment code first.
    const noWindow = await browser.get("/api/auth/passkey/generate-register-options");
    expect(noWindow.status).toBe(403);
    expect(noWindow.json).toMatchObject({ code: "forbidden", reason: "enrolment_code_required" });
    const member = await h.admin.query<{ status: string }>(
      "SELECT status FROM staff.member WHERE id = $1",
      [memberId],
    );
    expect(member.rows[0]?.status).toBe("pending");
  });
});

describe("addresses that may not sign in", () => {
  it("refuses an address the staff table does not list, and makes no member", async () => {
    const email = unique("google.outsider");
    const browser = staffBrowser(email);
    const trip = await roundTrip(browser, googleAccount(email));
    expect(trip.callback.status).toBe(302);
    expect(trip.location.href).toBe(`${ADMIN}/sign-in?error=account_refused`);
    expect(browser.sessionToken()).toBeNull();
    const made = await h.admin.query("SELECT 1 FROM staff.member WHERE email = $1", [email]);
    expect(made.rowCount).toBe(0);
    expect(h.lines.named("staff.not_listed").at(-1)).toEqual({ reason: "google" });
    expect(h.lines.named("auth.google_refused").at(-1)).toEqual({
      realm: "staff",
      reason: "not_listed",
    });
    expect(h.lines.named("request").at(-1)).toMatchObject({
      outcome: "refused",
      reason: "google.not_listed",
    });
    expect(await stateRows(String(trip.authorize.searchParams.get("state")))).toBe(0);
  });

  it("refuses a removed member, with staff.sign_in_failed", async () => {
    const email = unique("google.removed");
    const memberId = await addMember(email, "removed");
    const browser = staffBrowser(email);
    const trip = await roundTrip(browser, googleAccount(email));
    expect(trip.location.searchParams.get("error")).toBe("account_refused");
    expect(await sessionsOf(memberId)).toBe(0);
    expect((await failures(memberId)).map((e) => e.metadata)).toEqual([
      { method: "google", reason: "removed" },
    ]);
  });

  it("refuses a Google account that is not the Access identity, even another member's", async () => {
    const signedInAs = unique("google.access.one");
    await addMember(signedInAs, "active");
    const otherEmail = unique("google.access.two");
    const other = await addMember(otherEmail, "active");
    const browser = staffBrowser(signedInAs);
    const trip = await roundTrip(browser, googleAccount(otherEmail));
    expect(trip.location.searchParams.get("error")).toBe("account_refused");
    expect(browser.sessionToken()).toBeNull();
    expect(await sessionsOf(other)).toBe(0);
    expect((await failures(other)).map((e) => e.metadata)).toEqual([
      { method: "google", reason: "access_mismatch" },
    ]);
    expect(h.lines.named("staff.access_mismatch").at(-1)).toEqual({ staffId: other });
  });

  it.each([
    ["no Workspace at all (a consumer account)", { hd: undefined }],
    ["another Workspace", { hd: "example.org" }],
  ])("refuses a token from %s, even for a member's address", async (_label, overrides) => {
    const email = unique("google.domain");
    const memberId = await addMember(email, "active");
    const browser = staffBrowser(email);
    const account = googleAccount(email);
    const { hd: _hd, ...withoutHd } = account;
    const trip = await roundTrip(
      browser,
      overrides.hd === undefined ? withoutHd : { ...account, hd: overrides.hd },
    );
    expect(trip.location.searchParams.get("error")).toBe("account_refused");
    expect(await sessionsOf(memberId)).toBe(0);
    expect((await failures(memberId)).map((e) => e.metadata)).toEqual([
      { method: "google", reason: "hosted_domain" },
    ]);
    expect(h.lines.named("auth.google_refused").at(-1)).toEqual({
      realm: "staff",
      reason: "hosted_domain",
    });
  });

  it("refuses an address Google has not verified, as the library's refusal", async () => {
    const email = unique("google.unverified");
    const memberId = await addMember(email, "active");
    const trip = await roundTrip(
      staffBrowser(email),
      googleAccount(email, { emailVerified: false }),
    );
    expect(trip.location.searchParams.get("error")).toBe("email_unverified");
    expect(await sessionsOf(memberId)).toBe(0);
    expect(h.lines.named("auth.google_refused").at(-1)).toEqual({
      realm: "staff",
      reason: "email_unverified",
    });
  });
});

describe("the round trip itself", () => {
  it("lines a cancelled sign-in and sends it back to the sign-in page", async () => {
    const email = unique("google.cancel");
    await addMember(email, "active");
    const trip = await roundTrip(staffBrowser(email), "deny");
    expect(trip.location.origin + trip.location.pathname).toBe(`${ADMIN}/sign-in`);
    expect(trip.location.searchParams.get("error")).toBe("access_denied");
    expect(trip.location.searchParams.has("error_description")).toBe(false);
    expect(h.lines.named("auth.google_refused").at(-1)).toEqual({
      realm: "staff",
      reason: "access_denied",
    });
  });

  it("spends a state once: the same callback again makes no second session", async () => {
    const email = unique("google.replay");
    const memberId = await addMember(email, "active");
    const browser = staffBrowser(email);
    const trip = await roundTrip(browser, googleAccount(email));
    expect(await sessionsOf(memberId)).toBe(1);
    const exchanges = fixture.exchanges.length;
    const again = await browser.get(trip.callbackPath, crossSite);
    expect(again.status).toBe(302);
    expect(new URL(String(again.headers.get("location"))).searchParams.get("error")).toBe(
      "state_mismatch",
    );
    expect(fixture.exchanges.length).toBe(exchanges);
    expect(await sessionsOf(memberId)).toBe(1);
  });

  it("decides a callback whose error is empty by the staff checks, never the library's own path", async () => {
    // The library refuses a callback for its `error` only when that is not empty; with an empty
    // one it goes on to the code, so the staff realm's checks must still decide it.
    const outsider = unique("google.emptyerror.outsider");
    const outsiderBrowser = staffBrowser(outsider);
    const notListed = h.lines.named("staff.not_listed").length;
    const refused = await roundTrip(outsiderBrowser, googleAccount(outsider), {
      addToCallback: "&error=",
    });
    expect(refused.location.href).toBe(`${ADMIN}/sign-in?error=account_refused`);
    expect(outsiderBrowser.sessionToken()).toBeNull();
    expect(h.lines.named("staff.not_listed").length).toBe(notListed + 1);
    expect(h.lines.named("auth.google_refused").at(-1)).toEqual({
      realm: "staff",
      reason: "not_listed",
    });

    // A member whose address is the Access identity gets Fin's own staff session, at the factor
    // step, as on any callback; the library never answers with its account path.
    const { email, memberId } = await enrolledMember("google.emptyerror.member");
    const browser = staffBrowser(email);
    const trip = await roundTrip(browser, googleAccount(email), { addToCallback: "&error=" });
    expect(trip.location.href).toBe(`${ADMIN}/sign-in`);
    expect(await sessionOf(browser)).toMatchObject({
      user_id: memberId,
      assurance: "aal1",
      created_via: "google",
      access_sub: `sub-${email}`,
    });
    expect(h.lines.named("request").at(-1)).toMatchObject({ gate: "factor_step" });
    const accounts = await h.admin.query("SELECT 1 FROM staff.account");
    expect(accounts.rowCount).toBe(0);
  });

  it("needs the Access identity at the start and at the callback", async () => {
    const email = unique("google.noaccess");
    const memberId = await addMember(email, "active");
    const start = await staffBrowser(null).post("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/sign-in",
      disableRedirect: true,
    });
    expect(start.status).toBe(401);
    expect(start.json).toMatchObject({ code: "access_required" });

    // Started with Access, finished without it (the API half never lets this through: its front
    // door checks the Access token on every request before the realm runs).
    const browser = staffBrowser(email);
    const begun = await browser.post("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/sign-in",
      disableRedirect: true,
    });
    fixture.chooseNext(googleAccount(email));
    const fromProvider = await fetch(String(begun.json?.url), { redirect: "manual" });
    const back = new URL(String(fromProvider.headers.get("location")));
    browser.options.access = null;
    const callback = await browser.get(`${back.pathname}${back.search}`, crossSite);
    expect(callback.status).toBe(401);
    expect(callback.json).toMatchObject({ code: "access_required" });
    expect(await sessionsOf(memberId)).toBe(0);
  });
});

/** A staff round trip whose authorization request the client changed (or whose token says so). */
interface Edited {
  readonly label: string;
  readonly edit?: (params: URLSearchParams) => void;
  readonly tamper?: Tamper;
  /** The `auth.google_refused` line's reason. */
  readonly reason: string;
  /** The `?error=` the sign-in page comes back with. */
  readonly page: string;
  /** What the provider's token endpoint did with the code. */
  readonly exchange: "issued" | "refused";
}

const EDITED: readonly Edited[] = [
  {
    label: "another nonce",
    edit: (p) => p.set("nonce", randomBytes(24).toString("base64url")),
    reason: "nonce",
    page: "invalid_code",
    exchange: "issued",
  },
  {
    label: "a nonce long enough to push the ID token past Fin's bound",
    edit: (p) => p.set("nonce", "n".repeat(6000)),
    reason: "too_long",
    page: "invalid_code",
    exchange: "issued",
  },
  {
    label: "a scope without email",
    edit: (p) => p.set("scope", "openid profile"),
    reason: "email",
    page: "email_not_found",
    exchange: "issued",
  },
  {
    label: "a scope with no identity in it (no ID token comes back)",
    edit: (p) => p.set("scope", "https://www.googleapis.com/auth/drive.file"),
    reason: "scope",
    page: "invalid_code",
    exchange: "issued",
  },
  {
    label: "another PKCE challenge",
    edit: (p) =>
      p.set("code_challenge", createHash("sha256").update(randomBytes(32)).digest("base64url")),
    reason: "invalid_code",
    page: "invalid_code",
    exchange: "refused",
  },
  {
    label: "a token whose nonce is not this sign-in's, however it came (planted)",
    tamper: "nonce",
    reason: "nonce",
    page: "invalid_code",
    exchange: "issued",
  },
];

describe("what a client changes in its own authorization request (it passes through the browser)", () => {
  it.each(EDITED)("$label: a refusal of the round trip, never a failure", async (c) => {
    // A listed member signed in to Access as this address: only the round trip itself is wrong.
    const email = unique("google.edited");
    const memberId = await addMember(email, "active");
    const browser = staffBrowser(email);
    const failed = h.lines.named("auth.google_failed").length;
    const unhandled = h.lines.named("auth.unhandled_error").length;
    const exchanges = fixture.exchanges.length;
    const trip = await roundTrip(browser, googleAccount(email), {
      ...(c.edit === undefined ? {} : { edit: c.edit }),
      ...(c.tamper === undefined ? {} : { tamper: c.tamper }),
    });
    // The provider answered the request it was sent; nothing failed on its side or Fin's.
    expect(fixture.exchanges.slice(exchanges)).toEqual([
      expect.objectContaining({ outcome: c.exchange }),
    ]);
    expect(trip.callback.status).toBe(302);
    expect(trip.location.href).toBe(`${ADMIN}/sign-in?error=${c.page}`);
    expect(browser.sessionToken()).toBeNull();
    expect(await sessionsOf(memberId)).toBe(0);
    // No line google-sign-in-failing watches, and no unhandled error.
    expect(h.lines.named("auth.google_failed").length).toBe(failed);
    expect(h.lines.named("auth.unhandled_error").length).toBe(unhandled);
    expect(h.lines.named("auth.google_refused").at(-1)).toEqual({
      realm: "staff",
      reason: c.reason,
    });
    expect(h.lines.named("request").at(-1)).toMatchObject({
      authPath: "/callback/:id",
      outcome: "refused",
      reason: `google.${c.reason}`,
      status: 302,
    });
  });
});

describe("what Fin or the provider did wrong (google-sign-in-failing watches it)", () => {
  const longNonce = (p: URLSearchParams) => p.set("nonce", "n".repeat(6000));
  it.each([
    ["a bad signature", "signature", undefined, "signature"],
    ["a bad signature on a token a long nonce made too long", "signature", longNonce, "signature"],
    ["another audience", "audience", undefined, "audience"],
    ["the token endpoint failing", "token_error", undefined, "token_exchange"],
  ] as const)("%s: a failure, not a refusal", async (_label, tamper, edit, reason) => {
    const email = unique("google.failing");
    const memberId = await addMember(email, "active");
    const browser = staffBrowser(email);
    const refusals = h.lines.named("auth.google_refused").length;
    const trip = await roundTrip(browser, googleAccount(email), {
      tamper,
      ...(edit === undefined ? {} : { edit }),
    });
    expect(trip.location.href).toBe(`${ADMIN}/sign-in?error=google_failed`);
    expect(browser.sessionToken()).toBeNull();
    expect(await sessionsOf(memberId)).toBe(0);
    expect(h.lines.named("auth.google_failed").at(-1)).toEqual({ realm: "staff", reason });
    expect(h.lines.named("auth.google_refused").length).toBe(refusals);
    expect(h.lines.named("request").at(-1)).toMatchObject({
      outcome: "error",
      reason: "google.failed",
    });
  });
});
