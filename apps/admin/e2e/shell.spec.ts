// Fin Admin's shell (spec 01 §4.7; spec 06 §2.2, §4.2, §4.3, §5.3, §6), on the root configuration's
// static host behind the Access stand-in: the page loads under the production page policy with no
// violation (the fixtures fail any), Fin Admin follows the system theme before the first paint and
// ignores a stored choice, the edge toggle sits 16px from the top and collapses and expands the
// sidebar, `/` opens Staff, a member of staff part-way through signing in goes to the factor step,
// and /api/health answers through the tunnel. The viewer and the Staff page's answers are stubbed
// with `page.route`, so each state is drawn exactly.
import { join } from "node:path";
import { expect, test, waitForReady } from "@fin/testing/playwright";
import type { Page, Route } from "@playwright/test";
import { bootState, holdEntry, printWhileLoading } from "../../console/e2e/support/static.ts";
import { inApp, ORIGIN, throughAccess } from "./support/journey.ts";

const NADIA_EMAIL = "nadia.brooks@example.com";
// The value a library prints while it loads, built at run time.
const ADDRESS = ["maya.rivera", "example.com"].join("@");
// The build the static host serves (`pnpm run build:test`).
const DIST = join(import.meta.dirname, "../dist/static");

const NADIA = {
  state: "ok",
  staff: { id: "stf_nadia", email: NADIA_EMAIL, roleKey: "admin", roleLabel: "Admin" },
  permissions: ["staff.read", "records.read"],
  environment: "staging",
};

function json(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      headers: {
        "content-type": status >= 400 ? "application/problem+json" : "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify(body),
    });
}

function problem(status: number, code: string) {
  return json(
    {
      type: `https://docs.localhost/errors/${code}`,
      title: code,
      status,
      code,
      request_id: "req_e2e",
    },
    status,
  );
}

/** Answers the viewer and the Staff page's calls in the page, before they reach the tunnel. */
async function stub(page: Page, viewer: (route: Route) => Promise<void>) {
  await page.route("**/api/viewer", viewer);
  await page.route(
    "**/api/staff?*",
    json({
      staff: [
        {
          id: "stf_nadia",
          email: NADIA_EMAIL,
          roleKey: "admin",
          roleLabel: "Admin",
          status: "active",
          lastSignedInAt: "2026-11-16T09:40:00.000Z",
          factors: ["passkey"],
        },
      ],
      total: 1,
    }),
  );
  await page.route(
    "**/api/staff-roles",
    json({
      roles: [
        { key: "viewer", label: "Viewer", summary: "Sees.", builtIn: true, permissions: [] },
        { key: "admin", label: "Admin", summary: "Everything.", builtIn: true, permissions: [] },
      ],
    }),
  );
}

test("@csp `/` opens Staff in AdminFrame under the production page policy", async ({ page }) => {
  await stub(page, json(NADIA));
  await throughAccess(page, NADIA_EMAIL, "/");
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
  const document = await page.request.get(`${ORIGIN}/staff`);
  expect(document.headers()["content-security-policy"]).toContain("script-src 'self'");
});

test("@security the console guard is in place before any library is evaluated", async ({
  page,
}) => {
  await stub(page, json(NADIA));
  const prints = await printWhileLoading(page, ADDRESS);
  await throughAccess(page, NADIA_EMAIL, "/");
  expect(await prints.asked()).toBeGreaterThan(0);
  expect(prints.lines).toContain("opening for [email]");
  expect(prints.lines).toContain("TypeError");
  expect(prints.lines.join("\n")).not.toContain(ADDRESS);
});

test("@journey the staff menu names the role and how they signed in", async ({ page }) => {
  await stub(page, json(NADIA));
  await throughAccess(page, NADIA_EMAIL, "/staff");
  await page.getByRole("button", { name: `Account menu, ${NADIA_EMAIL}` }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("Admin · Cloudflare Access")).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Your sign-in" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Log out" })).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(0);
});

test("@journey a member of staff part-way through signing in goes to the factor step", async ({
  page,
}) => {
  await stub(page, json({ state: "pending", email: NADIA_EMAIL }));
  await throughAccess(page, NADIA_EMAIL, "/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in/factor`);
  await expect(page.locator("[data-slot=auth-layout]")).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Enter your enrolment code" }),
  ).toBeVisible();
});

test("@journey a signed-out visit goes to sign-in", async ({ page }) => {
  await stub(page, problem(401, "unauthenticated"));
  await throughAccess(page, NADIA_EMAIL, "/staff");
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin Admin" })).toBeVisible();
});

test("@journey Staff that cannot load keeps its header and offers Try again", async ({ page }) => {
  await stub(page, json(NADIA));
  await page.route("**/api/staff?*", problem(500, "internal"));
  await throughAccess(page, NADIA_EMAIL, "/staff");
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  await expect(inApp(page).getByText("Couldn’t load staff")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("@journey Fin Admin follows the system theme before the first paint", async ({
  newContext,
}) => {
  const context = await newContext({ colorScheme: "dark", baseURL: ORIGIN });
  const page = await context.newPage();
  await stub(page, json(NADIA));
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("fin-theme", "light");
    } catch {
      // No storage: the system theme applies anyway.
    }
    // The theme as <body> is first parsed: nothing of the page can paint before it, so this is
    // the theme of the first paint in every engine (a frame callback can run earlier in Firefox,
    // while the render-blocking theme.js is still loading).
    const seen = window as unknown as { __firstBody?: string };
    const observer = new MutationObserver(() => {
      if (document.body === null || seen.__firstBody !== undefined) return;
      seen.__firstBody = String(document.documentElement.getAttribute("data-theme"));
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await throughAccess(page, NADIA_EMAIL, "/staff");
  const first = await page.waitForFunction(
    () => (window as unknown as { __firstBody?: string }).__firstBody,
    undefined,
    { polling: 100 },
  );
  expect(await first.jsonValue()).toBe("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-choice", "system");
});

test("@journey Fin Admin follows the system theme and the stored sidebar before the first paint", async ({
  newContext,
}) => {
  const context = await newContext({
    colorScheme: "dark",
    baseURL: ORIGIN,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await stub(page, json(NADIA));
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("fin-theme", "light");
      window.localStorage.setItem("fin-sidebar", "collapsed");
    } catch {
      // No storage: the test then fails on the sidebar below.
    }
  });
  // Access is passed once; the next load of the page is the one read.
  await throughAccess(page, NADIA_EMAIL, "/staff");
  // main.tsx is held, so what the page shows now is theme.js and the boot skeleton alone.
  const entry = await holdEntry(page, DIST);
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
  await waitForReady(page);
  await expect(page.locator("[data-boot-block]")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "64px");
});

test("@journey with storage blocked Fin Admin renders in the system theme", async ({
  newContext,
}) => {
  const context = await newContext({ colorScheme: "dark", baseURL: ORIGIN });
  const page = await context.newPage();
  await stub(page, json(NADIA));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await throughAccess(page, NADIA_EMAIL, "/staff");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "expanded");
  await expect(page.getByRole("heading", { level: 1, name: "Staff" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("@journey the edge toggle sits 16px down and collapses and expands the sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stub(page, json(NADIA));
  await throughAccess(page, NADIA_EMAIL, "/staff");
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
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "224px");
});

test("@csp /api/health answers through the tunnel, same origin", async ({ page }) => {
  await stub(page, json(NADIA));
  await throughAccess(page, NADIA_EMAIL, "/staff");
  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health");
    return { status: response.status, body: await response.json() };
  });
  expect(health).toEqual({ status: 200, body: { status: "ok" } });
});
