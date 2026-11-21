// The harness's own journey test, on Chromium, Firefox and WebKit (projects harness-*): the static
// host serves the fixture app under the `app` profile's policy, and the shared fixtures do their
// jobs in a real browser: no violation on a clean page, every violation caught on a broken one,
// the page's JSON POST through /api/ with no preflight, the frozen clock, the virtual
// authenticator, and Access in front of a host.
import { join } from "node:path";
import {
  AccessStandIn,
  type RunningAccessStandIn,
  startAccessStandIn,
} from "../src/access/stand-in.ts";
import { CANON_TIME } from "../src/clock.ts";
import { signInThroughAccess } from "../src/playwright/access.ts";
import { expect, test as fin } from "../src/playwright/fixtures.ts";
import { gotoReady } from "../src/playwright/ready.ts";
import { type RunningStaticHost, startStaticHost } from "../src/static-host/server.ts";
import { type FakeApi, startFakeApi } from "../test/fake-api.ts";

const ROOT = join(import.meta.dirname, "../test/fixtures/app");

interface Servers {
  readonly api: FakeApi;
  readonly host: RunningStaticHost;
  readonly access: RunningAccessStandIn;
  readonly gated: RunningStaticHost;
}

const test = fin.extend<object, { servers: Servers }>({
  servers: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture signature
    async ({}, use) => {
      const api = await startFakeApi();
      const proof = ["harness", "proof"].join("-");
      const host = await startStaticHost({
        app: "console",
        root: ROOT,
        hostname: "localhost",
        api: { origin: api.origin, ingressProof: proof },
      });
      const access = await startAccessStandIn(new AccessStandIn({ audience: "harness-aud" }));
      const gated = await startStaticHost({
        app: "admin",
        root: ROOT,
        api: { origin: api.origin, ingressProof: proof },
        access: access.standIn.gate(),
      });
      await use({ api, host, access, gated });
      await Promise.all([host.close(), gated.close(), access.close(), api.close()]);
    },
    { scope: "worker" },
  ],
  allowedOrigins: async ({ servers }, use) => {
    await use([servers.host.origin, servers.gated.origin, servers.access.origin]);
  },
});

test("a clean page loads under the production policy with no violation @csp", async ({
  page,
  servers,
}) => {
  const response = await gotoReady(page, `${servers.host.origin}/`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  await expect(page.locator("main")).toHaveText("STATIC-OK");
});

test("a deep link answers the app with 200", async ({ page, servers }) => {
  const response = await gotoReady(page, `${servers.host.origin}/settings/team`);
  expect(response?.status()).toBe(200);
  await expect(page.locator("main")).toHaveText("STATIC-OK");
});

test("the page's JSON POST reaches the API half with no preflight", async ({ page, servers }) => {
  const methods: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/")) methods.push(request.method());
  });
  await gotoReady(page, `${servers.host.origin}/#ping`);
  await expect(page.locator("main")).toHaveText(`API 200 ${servers.host.authority}`);
  expect(methods).toEqual(["POST"]);
  const forwarded = servers.api.received.at(-1);
  expect(forwarded?.headers).toContainEqual(["Fin-Ingress-Proof", "harness-proof"]);
});

test("the recorder catches an inline style the policy refuses @csp", async ({
  page,
  servers,
  csp,
}) => {
  await gotoReady(page, `${servers.host.origin}/#violate-style`);
  await expect.poll(() => csp.violations.length).toBeGreaterThan(0);
  expect(
    csp.violations.some((v) => v.directive.startsWith("style-src") || v.source === "console"),
  ).toBe(true);
  csp.clear();
});

test("the recorder catches a script from another origin @csp", async ({
  page,
  servers,
  csp,
  offsite,
}) => {
  await gotoReady(page, `${servers.host.origin}/#violate-script`);
  await expect.poll(() => csp.violations.length).toBeGreaterThan(0);
  expect(
    csp.violations.some((v) => v.directive.startsWith("script-src") || v.source === "console"),
  ).toBe(true);
  csp.clear();
  offsite.clear();
});

test("the browser clock is frozen at the canon's time", async ({ page, servers, clock }) => {
  await gotoReady(page, `${servers.host.origin}/`);
  const now = await page.evaluate(() => Date.now());
  expect(now).toBe(Date.parse(CANON_TIME));
  expect(clock.epochMs()).toBe(now);
});

test("a second context gets its own recorders and the project's options", async ({
  newContext,
  servers,
}) => {
  const other = await newContext();
  const page = await other.newPage();
  await gotoReady(page, `${servers.host.origin}/`);
  expect(await page.evaluate(() => Date.now())).toBe(Date.parse(CANON_TIME));
});

test("the virtual authenticator answers a passkey ceremony", async ({
  page,
  servers,
  authenticator,
}) => {
  await gotoReady(page, `${servers.host.origin}/`);
  const rpId = authenticator.rpIdFor(servers.host.origin);
  const created = await page.evaluate(async (id) => {
    const credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id, name: "Fixture" },
        user: {
          id: new Uint8Array([1, 2, 3, 4]),
          name: "asha.rao@example.com",
          displayName: "Asha Rao",
        },
        challenge: new Uint8Array(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      },
    })) as PublicKeyCredential | null;
    return credential?.id ?? null;
  }, rpId);
  expect(created).not.toBeNull();
  const held = await authenticator.only(rpId);
  expect(held.id).toBe(created);
  const asserted = await page.evaluate(async (id) => {
    const credential = (await navigator.credentials.get({
      publicKey: { rpId: id, challenge: new Uint8Array(32), userVerification: "required" },
    })) as PublicKeyCredential | null;
    return credential?.id ?? null;
  }, rpId);
  expect(asserted).toBe(created);
  await authenticator.remove(held.id);
  expect(await authenticator.list(rpId)).toEqual([]);
});

test("Access stands in front of every path until a fixture identity signs in", async ({
  page,
  servers,
}) => {
  await page.goto(`${servers.gated.origin}/staff`);
  expect(new URL(page.url()).origin).toBe(servers.access.origin);
  await signInThroughAccess(page, {
    standInOrigin: servers.access.origin,
    appOrigin: servers.gated.origin,
    email: "grace.hall@example.com",
    path: "/staff",
  });
  await expect(page.locator("main")).toHaveText("STATIC-OK");
  expect(new URL(page.url()).pathname).toBe("/staff");
  const response = await page.request.post(`${servers.gated.origin}/api/staff`, { data: {} });
  const echo = (await response.json()) as { headers: [string, string][] };
  expect(echo.headers.find(([name]) => name === "Cf-Access-Authenticated-User-Email")?.[1]).toBe(
    "grace.hall@example.com",
  );
});

test.describe("the recorders fail the test that meets one", () => {
  test("a violation left uncleared fails the test @csp", async ({ page, servers, csp }) => {
    test.fail(true, "the csp fixture must fail a test that saw a violation");
    await gotoReady(page, `${servers.host.origin}/#violate-style`);
    await expect.poll(() => csp.violations.length).toBeGreaterThan(0);
  });

  test("a request to another origin fails the test", async ({ page, servers, offsite }) => {
    test.fail(true, "the offsite fixture must fail a test that left the allowed origins");
    await page.goto(`${servers.api.origin}/elsewhere`);
    expect(offsite.requests.length).toBeGreaterThan(0);
  });
});
