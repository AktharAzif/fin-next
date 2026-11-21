// The harness's own journey test, on Chromium, Firefox and WebKit (projects harness-*): the static
// host serves the fixture app under the `app` profile's policy, over https under each host's own
// name, and the shared fixtures do their jobs in a real browser: no violation on a clean page,
// every violation caught on a broken one, the page's JSON POST through /api/ with no preflight,
// `__Host-` cookies kept per host, the frozen clock, the virtual authenticator, Access in front of
// a host, the off-origin recorder, and the bypassCSP refusals.
import { join } from "node:path";
import {
  AccessStandIn,
  type RunningAccessStandIn,
  startAccessStandIn,
} from "../src/access/stand-in.ts";
import { CANON_TIME } from "../src/clock.ts";
import { selfSignedIdentity } from "../src/http/certificate.ts";
import { type Listening, listen } from "../src/http/node.ts";
import { signInThroughAccess } from "../src/playwright/access.ts";
import { expect, test as fin } from "../src/playwright/fixtures.ts";
import { gotoReady } from "../src/playwright/ready.ts";
import { type RunningStaticHost, startStaticHost } from "../src/static-host/server.ts";
import { type FakeApi, startFakeApi } from "../test/fake-api.ts";

const ROOT = join(import.meta.dirname, "../test/fixtures/app");

/** A header's values as the API half received them, by case-insensitive name. */
function received(headers: readonly (readonly [string, string])[] | undefined, name: string) {
  return (headers ?? []).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
}

interface Servers {
  readonly api: FakeApi;
  /** The console under the `app` profile. */
  readonly host: RunningStaticHost;
  readonly access: RunningAccessStandIn;
  /** Fin Admin, with Access in front. */
  readonly gated: RunningStaticHost;
  /** A host served with no policy, so a page can reach another origin at all. */
  readonly plain: RunningStaticHost;
  /** Another origin, outside every allowed list. */
  readonly elsewhere: Listening;
  readonly elsewhereHits: string[];
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
        name: "console.localhost",
        api: { origin: api.origin, ingressProof: proof },
      });
      const access = await startAccessStandIn(new AccessStandIn({ audience: "harness-aud" }));
      const gated = await startStaticHost({
        app: "admin",
        root: ROOT,
        name: "admin.localhost",
        api: { origin: api.origin, ingressProof: proof },
        access: access.standIn.gate(),
      });
      const plain = await startStaticHost({
        app: "docs",
        root: ROOT,
        name: "docs.localhost",
        headers: null,
        api: { origin: api.origin, ingressProof: proof },
      });
      const elsewhereHits: string[] = [];
      const elsewhere = await listen(
        async (request) => {
          elsewhereHits.push(request.target);
          return new Response("ELSEWHERE", { headers: { "content-type": "text/plain" } });
        },
        { name: "elsewhere.localhost", tls: selfSignedIdentity(["elsewhere.localhost"]) },
      );
      await use({ api, host, access, gated, plain, elsewhere, elsewhereHits });
      await Promise.all([
        host.close(),
        gated.close(),
        plain.close(),
        elsewhere.close(),
        access.close(),
        api.close(),
      ]);
    },
    { scope: "worker" },
  ],
  // The app hosts only: the stand-in is the fixtures' navigation origin, never an allowed one.
  allowedOrigins: async ({ servers }, use) => {
    await use([servers.host.origin, servers.gated.origin, servers.plain.origin]);
  },
  accessStandInOrigin: async ({ servers }, use) => {
    await use(servers.access.origin);
  },
});

test("a clean page loads under the production policy with no violation @csp", async ({
  page,
  servers,
}) => {
  const response = await gotoReady(page, `${servers.host.origin}/`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(new URL(page.url()).protocol).toBe("https:");
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
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
  expect(received(forwarded?.headers, "fin-ingress-proof")).toEqual(["harness-proof"]);
  expect(received(forwarded?.headers, "origin")).toEqual([servers.host.origin]);
});

test("every engine keeps the API's __Host- cookies, and each host keeps its own @security", async ({
  page,
  context,
  servers,
}) => {
  await gotoReady(page, `${servers.host.origin}/#ping`);
  await expect(page.locator("main")).toHaveText(`API 200 ${servers.host.authority}`);
  const kept = await context.cookies(servers.host.origin);
  expect(kept.map((cookie) => [cookie.name, cookie.secure, cookie.httpOnly]).sort()).toEqual([
    ["__Host-a", true, true],
    ["__Host-b", true, true],
  ]);
  // Sent back to the host that set them...
  await page.evaluate(async () => {
    await fetch("/api/again", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fin-app": "fixture" },
      body: "{}",
    });
  });
  const back = servers.api.received.at(-1);
  expect(back?.target).toBe("/api/again");
  expect(received(back?.headers, "cookie")).toEqual(["__Host-a=1; __Host-b=2"]);
  // ...and never to another app host on the same loopback address.
  expect(await context.cookies(servers.plain.origin)).toEqual([]);
  await gotoReady(page, `${servers.plain.origin}/#ping`);
  await expect(page.locator("main")).toHaveText(`API 200 ${servers.plain.authority}`);
  const other = servers.api.received.at(-1);
  expect(other?.host).toBe(servers.plain.authority);
  expect(received(other?.headers, "cookie")).toEqual([]);
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

test("the off-origin recorder records exactly what left the allowed origins", async ({
  page,
  servers,
  offsite,
}) => {
  await gotoReady(page, `${servers.plain.origin}/`);
  expect(offsite.requests).toEqual([]);
  const target = `${servers.elsewhere.origin}/fetched`;
  await page.evaluate(async (url) => {
    await fetch(url).catch(() => undefined);
  }, target);
  await expect.poll(() => offsite.requests.map((r) => r.url)).toEqual([target]);
  expect(offsite.requests[0]).toMatchObject({ resourceType: "fetch" });
  expect(offsite.requests[0]?.pageUrl).toContain(servers.plain.origin);
  offsite.clear();
  const landed = `${servers.elsewhere.origin}/landed`;
  await page.goto(landed);
  expect(offsite.requests).toEqual([
    expect.objectContaining({ url: landed, resourceType: "document" }),
  ]);
  offsite.clear();
});

test("the off-origin recorder records a WebSocket to another origin", async ({
  page,
  servers,
  offsite,
}) => {
  await gotoReady(page, `${servers.plain.origin}/`);
  const socket = `wss://${servers.elsewhere.authority}/socket`;
  const before = servers.elsewhereHits.length;
  const outcome = await page.evaluate(
    (url) =>
      new Promise<string>((done) => {
        const ws = new WebSocket(url);
        ws.onerror = () => done("error");
        ws.onclose = () => done("closed");
        setTimeout(() => done("timeout"), 5000);
      }),
    socket,
  );
  expect(["error", "closed"]).toContain(outcome);
  await expect.poll(() => servers.elsewhereHits.length).toBeGreaterThan(before);
  await expect
    .poll(() => offsite.requests.map((r) => [r.resourceType, r.url]))
    .toEqual([["websocket", socket]]);
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

test("a second context with bypassCSP is refused", async ({ newContext }) => {
  await expect(newContext({ bypassCSP: true })).rejects.toThrow("newContext() turns it on");
});

test("the virtual authenticator answers a passkey ceremony", async ({
  page,
  servers,
  authenticator,
}) => {
  await gotoReady(page, `${servers.host.origin}/`);
  const rpId = authenticator.rpIdFor(servers.host.origin);
  expect(rpId).toBe("console.localhost");
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
  context,
  servers,
  offsite,
  allowedOrigins,
}) => {
  // The stand-in is not an allowed origin: only the fixtures' navigation rule lets the page there.
  expect(allowedOrigins).not.toContain(servers.access.origin);
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
  expect(offsite.requests).toEqual([]);
  const [cookie] = await context.cookies(servers.gated.origin);
  expect(cookie).toMatchObject({ name: "CF_Authorization", secure: true, httpOnly: true });
  expect(await context.cookies(servers.host.origin)).toEqual([]);
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
    await page.goto(`${servers.elsewhere.origin}/elsewhere`);
    expect(offsite.requests.length).toBeGreaterThan(0);
  });
});

test.describe("bypassCSP from a test.use is refused", () => {
  test.use({ bypassCSP: true });
  test.fail("the context fixture refuses it before the test runs", async ({ page }) => {
    await page.goto("about:blank");
  });
});

test.describe("bypassCSP through contextOptions is refused", () => {
  test.use({ contextOptions: { bypassCSP: true } });
  test.fail("the context fixture refuses it before the test runs", async ({ page }) => {
    await page.goto("about:blank");
  });
});
