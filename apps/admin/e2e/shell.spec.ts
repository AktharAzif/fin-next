// Fin Admin's shell (spec 01 §4.7; spec 06 §2.2, §4.2, §4.3, §5.3, §6): the page loads under the
// production page policy with no violation, Fin Admin follows the system theme before the first
// paint and ignores a stored choice, the edge toggle sits 16px from the top and collapses and
// expands the sidebar, `/` opens Staff (Saturday's only list), a member of staff part-way through
// signing in goes to the factor step, and /api/health answers through the stub.
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  bootState,
  holdEntry,
  problem,
  ready,
  serveStatic,
  watchPolicy,
} from "../../console/e2e/support/static.ts";

const ORIGIN = "http://127.0.0.1:4402";

const NADIA = {
  state: "ok",
  staff: {
    id: "stf_nadia",
    email: "nadia.brooks@example.org",
    roleKey: "admin",
    roleLabel: "Admin",
  },
  permissions: ["staff.read", "records.read"],
  environment: "staging",
};

let policy: string[] = [];

test.beforeEach(async ({ context }) => {
  policy = await watchPolicy(context);
});

test.afterEach(() => {
  expect(policy, "no page-policy violation").toEqual([]);
});

function viewer(body: unknown) {
  return (route: Route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(body),
    });
}

async function serve(page: Page, answer: (route: Route) => Promise<void>) {
  await serveStatic(page.context(), {
    dir: "dist/static",
    profile: "app",
    origin: ORIGIN,
    api: { "/api/viewer": answer },
  });
}

test("@csp `/` opens Staff in AdminFrame under the production page policy", async ({ page }) => {
  await serve(page, viewer(NADIA));
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("style-src 'self'");
  await ready(page);
  await expect(page).toHaveURL(`${ORIGIN}/staff`);
  await expect(page).toHaveTitle("Staff · Fin Admin");
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  await expect(page.locator("[data-app-shell=admin]")).toBeVisible();
  await expect(page.locator("[data-strip]")).toHaveCount(0);
  await expect(page.locator("[data-deployment=staging]")).toHaveText("Staging");
  await expect(page.getByRole("link", { name: "Fin Admin" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Staff", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("radiogroup", { name: "Environment" })).toHaveCount(0);
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "224px");
});

test("@journey the staff menu names the role and how they signed in", async ({ page }) => {
  await serve(page, viewer(NADIA));
  await page.goto("/staff");
  await ready(page);
  await page.getByRole("button", { name: "Account menu, nadia.brooks@example.org" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("Admin · Cloudflare Access")).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Your sign-in" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
});

test("@journey a member of staff part-way through signing in goes to the factor step", async ({
  page,
}) => {
  await serve(page, viewer({ state: "pending", email: "nadia.brooks@example.org" }));
  await page.goto("/staff");
  await ready(page);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
  await expect(page.locator("[data-slot=auth-layout]")).toBeVisible();
});

test("@journey a signed-out visit goes to sign-in", async ({ page }) => {
  await serve(page, (route) => route.fulfill(problem(401, "unauthenticated")));
  await page.goto("/staff");
  await ready(page);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin Admin" })).toBeVisible();
});

test("@journey Fin Admin follows the system theme and the stored sidebar before the first paint", async ({
  browser,
}) => {
  const context = await browser.newContext({
    colorScheme: "dark",
    baseURL: ORIGIN,
    viewport: { width: 1440, height: 900 },
  });
  policy = await watchPolicy(context);
  const page = await context.newPage();
  await serve(page, viewer(NADIA));
  // main.tsx is held, so what the page shows now is theme.js and the boot skeleton alone.
  const entry = await holdEntry(page, "dist/static");
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("fin-theme", "light");
      window.localStorage.setItem("fin-sidebar", "collapsed");
    } catch {
      // No storage: the test then fails on the sidebar below.
    }
  });
  await page.goto("/staff", { waitUntil: "commit" });
  await entry.requested;
  expect(await bootState(page)).toEqual({
    theme: "dark",
    choice: "system",
    boot: "app",
    sidebar: "collapsed",
    background: "rgb(10, 10, 10)",
    bootSidebarWidth: "64px",
    ready: false,
  });
  entry.release();
  await ready(page);
  await expect(page.locator("[data-boot-block]")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "64px");
  await context.close();
});

test("@journey with storage blocked Fin Admin renders in the system theme", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark", baseURL: ORIGIN });
  policy = await watchPolicy(context);
  const page = await context.newPage();
  await serve(page, viewer(NADIA));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await page.goto("/staff");
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "expanded");
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("@journey the edge toggle sits 16px down and collapses and expands the sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await serve(page, viewer(NADIA));
  await page.goto("/staff");
  await ready(page);
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  expect(await collapse.boundingBox()).toMatchObject({ x: 212, y: 16, width: 24, height: 24 });
  await collapse.focus();
  await page.keyboard.press("Enter");
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expand).toBeFocused();
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "64px");
  expect(await expand.boundingBox()).toMatchObject({ x: 52, y: 16, width: 24, height: 24 });
  expect(await page.evaluate(() => localStorage.getItem("fin-sidebar"))).toBe("collapsed");
  await page.reload();
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "224px");
});

test("@csp /api/health answers through the stub, same origin", async ({ page }) => {
  await serve(page, viewer(NADIA));
  await page.goto("/staff");
  await ready(page);
  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health");
    return { status: response.status, body: await response.json() };
  });
  expect(health).toEqual({ status: 200, body: { status: "ok" } });
});
