// Staff Google sign-in through Fin Admin's whole API half (spec 02 §2.2, §2.3, §5.8, §6.4, §10.5;
// [SA-15]): the connector's address and ingress proof, the Access check of step 4 on every request
// (the test Access stand-in's token behind the real verifier), the origin gate, the staff realm with
// its own Google switch on, Postgres 18 as the admin login, and the fixture OpenID provider on
// loopback. The viewer tells the sign-in page whether to offer Google; the round trip starts with a
// gated POST and comes back on the one ungated GET; the session it leaves is at the factor step and
// reaches nothing until the passkey; the callback without an Access token never reaches the realm
// (no code is exchanged); an address the staff table does not list, or one that is not the Access
// identity, is refused; and with the switch off every Google path answers the endpoint policy's
// empty 404, before the library.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_ORIGIN,
  createStaffHarness,
  type StaffHarness,
} from "../../../../packages/staff/test/index.ts";
import {
  type FixtureAccount,
  OAuthFixture,
  type RunningOAuthFixture,
  startOAuthFixture,
} from "../../../../packages/testing/src/oauth/fixture.ts";
import {
  type AdminClient,
  type AdminHost,
  createAdminHost,
  enrolThroughHost,
  type Reply,
} from "../../test/host.ts";

const CLIENT_ID = "fin-admin-test.apps.example.com";
const REDIRECT_URI = `${ADMIN_ORIGIN}/api/auth/callback/google`;
/** The company Workspace's domain in these tests (example.com, as every fixture address). */
const WORKSPACE = "example.com";
const clientSecret = randomBytes(24).toString("base64url");

let provider: RunningOAuthFixture;
let fixture: OAuthFixture;
let on: StaffHarness;
let off: StaffHarness;
let host: AdminHost;
let offHost: AdminHost;

beforeAll(async () => {
  fixture = new OAuthFixture();
  provider = await startOAuthFixture(fixture);
  fixture.registerClient({ clientId: CLIENT_ID, clientSecret, redirectUris: [REDIRECT_URI] });
  on = await createStaffHarness("admgoogleon", {
    env: {
      FIN_FEATURE_STAFF_GOOGLE: "on",
      FIN_GOOGLE_CLIENT_ID: CLIENT_ID,
      FIN_GOOGLE_CLIENT_SECRET: clientSecret,
      FIN_GOOGLE_HOSTED_DOMAIN: WORKSPACE,
      FIN_GOOGLE_TEST_ISSUER: provider.origin,
    },
  });
  off = await createStaffHarness("admgoogleoff");
  host = await createAdminHost(on);
  offHost = await createAdminHost(off);
}, 120_000);

afterAll(async () => {
  await on?.close();
  await off?.close();
  await provider?.close();
});

const unique = (label: string) => `${label}.${randomBytes(4).toString("hex")}@${WORKSPACE}`;
/** The provider's top-level redirect back: cross-site, no Origin, no X-Fin-App. */
const fromGoogle = { origin: "", "x-fin-app": "", "sec-fetch-site": "cross-site" };

function account(email: string): FixtureAccount {
  return { sub: `7${Date.now()}${randomBytes(2).readUInt16BE()}`, email, hd: WORKSPACE };
}

/** Starts Google in this browser and has the provider answer; returns the callback's path. */
async function toProvider(client: AdminClient, choice: FixtureAccount): Promise<string> {
  const start = await client.post("/api/auth/sign-in/social", {
    provider: "google",
    callbackURL: "/sign-in",
    errorCallbackURL: "/sign-in",
    disableRedirect: true,
  });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  fixture.chooseNext(choice);
  const fromProvider = await fetch(String(start.json?.url), { redirect: "manual" });
  const back = new URL(String(fromProvider.headers.get("location")));
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
  return `${back.pathname}${back.search}`;
}

function locationOf(reply: Reply): URL {
  const location = reply.headers.get("location");
  if (location === null) throw new Error(`no redirect: ${reply.status}`);
  return new URL(location);
}

describe("the sign-in page's viewer", () => {
  it("offers Google only while the staff switch is on", async () => {
    const email = unique("viewer");
    expect((await host.client(email).get("/api/viewer")).json).toEqual({
      state: "signed_out",
      accessEmail: email,
      google: true,
    });
    expect((await offHost.client(email).get("/api/viewer")).json).toEqual({
      state: "signed_out",
      accessEmail: email,
    });
  });
});

describe("a staff Google round trip through the API half", () => {
  it("stops at the factor step, reaches nothing, and the passkey finishes it", async () => {
    const member = await enrolThroughHost(on, host, unique("google.member"), "operator");
    const browser = host.client(member.email);
    // Without X-Fin-App the origin gate refuses the start, as every unsafe request.
    const ungated = await browser.post(
      "/api/auth/sign-in/social",
      { provider: "google", callbackURL: "/sign-in" },
      { "x-fin-app": "" },
    );
    expect(ungated.status).toBe(403);
    expect(ungated.json).toMatchObject({ code: "invalid_origin" });

    const callbackPath = await toProvider(browser, account(member.email));
    // A POST to the callback is refused by the gate (§2.3): only the GET is exempt.
    const posted = await browser.send("POST", callbackPath, undefined, {
      ...fromGoogle,
      origin: "https://accounts.google.com",
    });
    expect(posted.status).toBe(403);

    const callback = await browser.send("GET", callbackPath, undefined, fromGoogle);
    expect(callback.status).toBe(302);
    expect(locationOf(callback).href).toBe(`${ADMIN_ORIGIN}/sign-in`);
    expect(browser.jar.has("__Host-fin-admin.session_token")).toBe(true);

    // Google is a first factor only: the factor step, and nothing a permission guards.
    expect((await browser.get("/api/viewer")).json).toEqual({
      state: "factor_step",
      email: member.email,
      methods: ["passkey"],
    });
    const held = await browser.get("/api/staff");
    expect(held.status).toBe(403);
    expect(held.json).toMatchObject({ code: "factor_step_required" });

    const factor = await browser.passkey(member.authenticator);
    expect(factor.status, JSON.stringify(factor.json)).toBe(200);
    const viewer = await browser.get("/api/viewer");
    expect(viewer.json).toMatchObject({ state: "ok", staff: { email: member.email } });
    expect((await browser.get("/api/staff")).status).toBe(200);
  });

  it("never lets a callback without an Access token reach the realm: no code is exchanged", async () => {
    const member = await enrolThroughHost(on, host, unique("google.noaccess"), "viewer");
    const browser = host.client(member.email);
    const callbackPath = await toProvider(browser, account(member.email));
    const exchanges = fixture.exchanges.length;
    browser.email = null;
    const callback = await browser.send("GET", callbackPath, undefined, fromGoogle);
    expect(callback.status).toBe(401);
    expect(callback.json).toMatchObject({ code: "access_required" });
    expect(fixture.exchanges.length).toBe(exchanges);
    expect(browser.jar.has("__Host-fin-admin.session_token")).toBe(false);
  });

  it("refuses a Google account that is not the Access identity", async () => {
    const member = await enrolThroughHost(on, host, unique("google.mismatch"), "viewer");
    const browser = host.client(unique("google.someone"));
    const callbackPath = await toProvider(browser, account(member.email));
    const callback = await browser.send("GET", callbackPath, undefined, fromGoogle);
    expect(locationOf(callback).href).toBe(`${ADMIN_ORIGIN}/sign-in?error=account_refused`);
    expect(browser.jar.has("__Host-fin-admin.session_token")).toBe(false);
    const failed = (await on.events("staff.sign_in_failed")).filter(
      (e) => e.target_id === member.staffId,
    );
    expect(failed.map((e) => e.metadata)).toEqual([
      { method: "google", reason: "access_mismatch" },
    ]);
  });

  it("refuses an address the staff table does not list, though Access let it in", async () => {
    const outsider = unique("google.outsider");
    const browser = host.client(outsider);
    const callbackPath = await toProvider(browser, account(outsider));
    const callback = await browser.send("GET", callbackPath, undefined, fromGoogle);
    expect(locationOf(callback).href).toBe(`${ADMIN_ORIGIN}/sign-in?error=account_refused`);
    expect(browser.jar.has("__Host-fin-admin.session_token")).toBe(false);
    expect((await browser.get("/api/viewer")).json).toMatchObject({ state: "signed_out" });
    const made = await on.admin.query("SELECT 1 FROM staff.member WHERE email = $1", [outsider]);
    expect(made.rowCount).toBe(0);
  });
});

describe("staff Google switched off", () => {
  it("answers the endpoint policy's empty 404 on every Google path, before the library", async () => {
    const browser = offHost.client(unique("google.off"));
    const blocked = offHost.captured.events("auth.endpoint_blocked").length;
    const start = await browser.post("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/sign-in",
    });
    expect(start.status).toBe(404);
    const callback = await browser.send(
      "GET",
      "/api/auth/callback/google?code=x&state=y",
      undefined,
      fromGoogle,
    );
    expect(callback.status).toBe(404);
    // The staff realm's endpoint policy answered both, not the library (whose own 404 for a
    // provider it does not have carries a body): an empty answer, and each path lined as blocked.
    expect(start.json).toBeNull();
    expect(callback.json).toBeNull();
    expect(offHost.captured.events("auth.endpoint_blocked").slice(blocked)).toEqual([
      expect.objectContaining({ realm: "staff", class: "blocked" }),
      expect.objectContaining({ realm: "staff", class: "blocked" }),
    ]);
  });
});
