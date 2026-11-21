// Verify's shell (spec 01 §4.7; spec 06 §2.2, §5.3, §6, §7.3; FW-C21): the hosted page loads under
// the `hosted` profile's page policy with no violation, in AuthFrame, following the system theme
// before the first paint; the link token in the fragment leaves the address bar and the history
// before anything else runs; and /api/health answers through the stub.
import { expect, test } from "@playwright/test";
import {
  bootState,
  holdEntry,
  ready,
  serveStatic,
  watchPolicy,
} from "../../console/e2e/support/static.ts";

const ORIGIN = "http://127.0.0.1:4403";
// A token-shaped value, built at run time (the public-safety scan never sees a literal one).
const TOKEN = ["0123456789ABCDEF", "GHJKMNPQRSTVWXYZ"].join("");

let policy: string[] = [];

test.beforeEach(async ({ context, page }) => {
  policy = await watchPolicy(context);
  await serveStatic(page.context(), {
    dir: "dist/static/verify",
    profile: "hosted",
    origin: ORIGIN,
  });
});

test.afterEach(() => {
  expect(policy, "no page-policy violation").toEqual([]);
});

test("@csp a link page loads in AuthFrame under the hosted page policy", async ({ page }) => {
  const response = await page.goto("/c");
  expect(response?.headers()["content-security-policy"]).toContain("img-src 'self' blob:");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await ready(page);
  await expect(page.locator("[data-slot=auth-layout]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Verify" })).toBeVisible();
  await expect(page).toHaveTitle("Verify · Fin");
  await expect(page.locator("[data-app-shell]")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-sidebar", /.*/);
});

test("@security the link token leaves the address bar and the history at once", async ({
  page,
}) => {
  await page.goto(`/c#${TOKEN}`);
  await ready(page);
  expect(page.url()).toBe(`${ORIGIN}/c`);
  expect(await page.evaluate(() => location.hash)).toBe("");
  // The entry was replaced, not pushed: going back never reaches a URL that holds the token.
  await page.goBack().catch(() => null);
  expect(page.url()).not.toContain(TOKEN);
});

test("@journey verify follows the system theme before the first paint", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark", baseURL: ORIGIN });
  policy = await watchPolicy(context);
  const page = await context.newPage();
  await serveStatic(context, { dir: "dist/static/verify", profile: "hosted", origin: ORIGIN });
  // main.tsx is held, so what the page shows now is theme.js and the boot skeleton alone.
  const entry = await holdEntry(page, "dist/static/verify");
  await page.goto("/p", { waitUntil: "commit" });
  await entry.requested;
  expect(await bootState(page)).toEqual({
    theme: "dark",
    choice: "system",
    boot: "auth",
    sidebar: null,
    background: "rgb(10, 10, 10)",
    bootSidebarWidth: null,
    ready: false,
  });
  entry.release();
  await ready(page);
  await expect(page.locator("[data-boot-block]")).toHaveCount(0);
  await context.close();
});

test("@journey with storage blocked verify renders in the system theme", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark", baseURL: ORIGIN });
  policy = await watchPolicy(context);
  const page = await context.newPage();
  await serveStatic(context, { dir: "dist/static/verify", profile: "hosted", origin: ORIGIN });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await page.goto("/c");
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { level: 1, name: "Verify" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("@csp a path no route matches is not found, in AuthFrame", async ({ page }) => {
  await page.goto("/nowhere");
  await ready(page);
  await expect(page.locator("[data-slot=auth-layout]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
});

test("@csp /api/health answers through the stub, same origin", async ({ page }) => {
  await page.goto("/c");
  await ready(page);
  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health");
    return { status: response.status, body: await response.json() };
  });
  expect(health).toEqual({ status: 200, body: { status: "ok" } });
});
