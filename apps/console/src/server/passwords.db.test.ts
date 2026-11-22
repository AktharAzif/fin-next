// The console's password routes through the real front door (spec 02 §5.7, §14.2; T-SAT-31's
// public half): the methods the deployment offers, sign-up with a password and the password
// sign-in it allows, the reset link's check, and Account security's `passwordSet`; with passwords
// off, the realm's password paths answer 404 and sign-up refuses a password.
import { randomBytes } from "node:crypto";
import { bootApi } from "@fin/web-host/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../../../packages/orgs/test/index.ts";
import { type Booted, Client, latestCode, ORIGIN } from "../../test/client.ts";
import { defineConsoleService } from "./main.ts";

let database: TestDatabase;
let on: Booted;
let off: Booted;

const tag = randomBytes(3).toString("hex");
const address = (label: string) => `${label}.${tag}@example.com`;
const PASSWORD = "harbour light forty two";

function boot(passwords: boolean) {
  return bootApi(defineConsoleService({ pool: database.login("fin_console") }), {
    service: "console",
    roles: ["console"],
    env: {
      FIN_PUBLIC_ORIGIN: ORIGIN,
      FIN_CONNECTOR_SERVICES: "cloudflared-public",
      FIN_DOCS_ORIGIN: "https://developer.example.com",
      BETTER_AUTH_SECRETS: `1:${randomBytes(32).toString("base64url")}`,
      FIN_LIMIT_KEY_1: randomBytes(32).toString("hex"),
      ...(passwords ? { FIN_FEATURE_PASSWORDS: "on" } : {}),
    },
  });
}

beforeAll(async () => {
  database = await createTestDatabase("passwords_routes");
  on = await boot(true);
  off = await boot(false);
}, 60_000);

afterAll(async () => {
  await on?.stop();
  await off?.stop();
  await database?.drop();
});

/** Signs up with a password and confirms the address in the same client. */
async function signUp(api: Booted, email: string): Promise<Client> {
  const client = new Client(api);
  const answer = await client.call("POST", "/api/sign-up", {
    name: "Ada Lovelace",
    email,
    password: PASSWORD,
  });
  expect(answer.status, JSON.stringify(answer.json)).toBe(202);
  const confirmed = await client.call("POST", "/api/auth/sign-in/email-otp", {
    email,
    otp: await latestCode(database.admin, email),
  });
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  return client;
}

describe("with passwords on", () => {
  it("says so on GET /api/sign-in/methods, the same for everyone", async () => {
    const answer = await new Client(on).call("GET", "/api/sign-in/methods");
    expect(answer).toMatchObject({ status: 200, json: { password: true } });
  });

  it("signs up with a password, then signs in with it through the front door", async () => {
    const email = address("routes");
    const owner = await signUp(on, email);
    const security = await owner.call("GET", "/api/account/security");
    expect(security.json).toMatchObject({ passwordSet: true });
    const browser = new Client(on);
    const signedIn = await browser.call("POST", "/api/auth/sign-in/email", {
      email,
      password: PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.json)).toBe(200);
    const viewer = await browser.call("GET", "/api/viewer");
    expect(viewer.status, JSON.stringify(viewer.json)).toBe(200);
    expect(viewer.json).toMatchObject({ assurance: "aal1" });
  });

  it("refuses a common password at sign-up with the problem, never the value", async () => {
    const answer = await new Client(on).call("POST", "/api/sign-up", {
      name: "Ada Lovelace",
      email: address("weak"),
      password: "password1234",
    });
    expect(answer.status).toBe(400);
    expect(answer.json).toMatchObject({
      code: "invalid",
      fields: ["password"],
      problem: "password_common",
    });
    expect(JSON.stringify(answer.json)).not.toContain("password1234");
  });

  it("answers the reset link's check about this browser's own request only", async () => {
    const email = address("link");
    await signUp(on, email);
    const asker = new Client(on);
    const check = (client: Client) =>
      client.call("POST", "/api/reset-password/code-link", { email });
    expect((await check(asker)).json).toEqual({ state: "elsewhere" });
    const asked = await asker.call("POST", "/api/auth/email-otp/request-password-reset", {
      email,
    });
    expect(asked.status).toBe(200);
    expect((await check(asker)).json).toEqual({ state: "asking" });
    expect((await check(new Client(on))).json).toEqual({ state: "elsewhere" });
    const done = await asker.call("POST", "/api/auth/email-otp/reset-password", {
      email,
      otp: await latestCode(database.admin, email),
      password: "a quiet lighthouse at dusk",
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect((await check(asker)).json).toEqual({ state: "spent" });
  });
});

describe("with passwords off", () => {
  it("says so, refuses a password at sign-up and keeps every password path at 404", async () => {
    const client = new Client(off);
    expect((await client.call("GET", "/api/sign-in/methods")).json).toEqual({ password: false });
    const signUpAnswer = await client.call("POST", "/api/sign-up", {
      name: "Ada Lovelace",
      email: address("off"),
      password: PASSWORD,
    });
    expect(signUpAnswer.json).toMatchObject({
      code: "invalid",
      problem: "password_not_offered",
    });
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/email-otp/request-password-reset",
      "/api/auth/email-otp/reset-password",
      "/api/auth/change-password",
    ]) {
      const answer = await client.call("POST", path, { email: address("off") });
      expect(answer.status, path).toBe(404);
    }
    const link = await client.call("POST", "/api/reset-password/code-link", {
      email: address("off"),
    });
    expect(link.status).toBe(404);
  });
});
