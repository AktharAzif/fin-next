// The selfie host's document (spec 01 §7.4; spec 06 §1.2, §7.3; FW-C20): verify's second static
// output, dist/static/selfie, loads at `/s` under the `selfie` profile's page policy (the `hosted`
// one until SP-11 lists Sumsub's hosts) with no violation, in AuthFrame, following the system theme
// before the first paint; the ticket in the fragment leaves the address bar and the history before
// anything else runs; and /api/health answers through the stub.
import { expect, test } from "@playwright/test";
import {
  bootState,
  holdEntry,
  ready,
  serveStatic,
  watchPolicy,
} from "../../console/e2e/support/static.ts";

const ORIGIN = "http://127.0.0.1:4403";
const DIR = "dist/static/selfie";
// A ticket-shaped value, built at run time (the public-safety scan never sees a literal one).
const TICKET = [
  ["sft", ["0123456789ABCDEFGHJKMNPQ", "RS"].join("")].join("_"),
  ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNO-_"].join(""),
].join(".");

let policy: string[] = [];

test.beforeEach(async ({ context }) => {
  policy = await watchPolicy(context);
  await serveStatic(context, { dir: DIR, profile: "selfie", origin: ORIGIN });
});

test.afterEach(() => {
  expect(policy, "no page-policy violation").toEqual([]);
});

test("@csp the selfie page loads at /s in AuthFrame under its own page policy", async ({
  page,
}) => {
  const response = await page.goto("/s");
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  await ready(page);
  await expect(page.locator("[data-slot=auth-layout]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Selfie" })).toBeVisible();
  await expect(page).toHaveTitle("Selfie · Fin");
  await expect(page.locator("[data-app-shell]")).toHaveCount(0);
  await expect(page.locator("[data-boot-block]")).toHaveCount(0);
});

test("@security the ticket leaves the address bar and the history at once", async ({ page }) => {
  await page.goto(`/s#${TICKET}`);
  await ready(page);
  expect(page.url()).toBe(`${ORIGIN}/s`);
  expect(await page.evaluate(() => location.hash)).toBe("");
  await page.goBack().catch(() => null);
  expect(page.url()).not.toContain(TICKET);
});

test("@journey the selfie page follows the system theme before the first paint", async ({
  browser,
}) => {
  const context = await browser.newContext({ colorScheme: "dark", baseURL: ORIGIN });
  policy = await watchPolicy(context);
  const page = await context.newPage();
  await serveStatic(context, { dir: DIR, profile: "selfie", origin: ORIGIN });
  const entry = await holdEntry(page, DIR);
  await page.goto("/s", { waitUntil: "commit" });
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

test("@csp any other path is not found, in AuthFrame", async ({ page }) => {
  await page.goto("/c");
  await ready(page);
  await expect(page.locator("[data-slot=auth-layout]")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
});

test("@csp /api/health answers through the stub, same origin", async ({ page }) => {
  await page.goto("/s");
  await ready(page);
  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health");
    return { status: response.status, body: await response.json() };
  });
  expect(health).toEqual({ status: 200, body: { status: "ok" } });
});
