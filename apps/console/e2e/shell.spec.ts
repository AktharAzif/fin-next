// The console's shell (spec 01 §4.7; spec 06 §2.2, §4.2, §5.3, §6): the page loads under the
// production page policy with no violation, the stored theme applies before the first paint, the
// edge toggle collapses and expands the sidebar, the phone sheet opens, a signed-out visit goes to
// sign-in, and /api/health answers through the stub. Against the built dist/static/.
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  bootState,
  holdEntry,
  problem,
  ready,
  serveStatic,
  watchPolicy,
} from "./support/static.ts";

const ORIGIN = "http://127.0.0.1:4401";

const MAYA = {
  gate: "ok",
  user: { id: "usr_maya", name: "Maya Rivera", email: "maya@example.com" },
  assurance: "aal2",
  factors: { passkeys: 1, authenticator: false, backupCodesLeft: null },
  canSkipProtect: false,
  canTrustBrowser: true,
  memberships: [
    {
      orgId: "org_acme",
      name: "Acme Remit",
      roleKey: "super_admin",
      roleLabel: "Super admin",
      roleKnown: true,
      liveStatus: "sandbox",
    },
    {
      orgId: "org_ito",
      name: "Studio Ito",
      roleKey: "admin",
      roleLabel: "Admin",
      roleKnown: true,
      liveStatus: "sandbox",
    },
  ],
  currentOrgId: "org_acme",
  permissions: ["auditLog.read", "member.read"],
  invitations: [],
};

let policy: string[] = [];

test.beforeEach(async ({ context }) => {
  policy = await watchPolicy(context);
});

test.afterEach(() => {
  expect(policy, "no page-policy violation").toEqual([]);
});

async function signedIn(page: Page) {
  await serveStatic(page.context(), {
    dir: "dist/static",
    profile: "app",
    origin: ORIGIN,
    api: {
      "/api/viewer": (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
          body: JSON.stringify(MAYA),
        }),
    },
  });
}

async function signedOut(page: Page) {
  await serveStatic(page.context(), {
    dir: "dist/static",
    profile: "app",
    origin: ORIGIN,
    api: { "/api/viewer": (route) => route.fulfill(problem(401, "unauthenticated")) },
  });
}

test("@csp Home loads in AppFrame under the production page policy", async ({ page }) => {
  await signedIn(page);
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
  await ready(page);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
  await expect(page).toHaveTitle("Sandbox · Home · Fin");
  await expect(page.locator("[data-strip=sandbox]")).toHaveText("Sandbox");
  await expect(page.getByRole("link", { name: "Fin home" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu, Maya Rivera" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch organisation, current: Acme Remit" }),
  ).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Environment" })).toBeVisible();
  // The boot skeleton is gone once React has rendered.
  await expect(page.locator("[data-boot-block]")).toHaveCount(0);
  // The stylesheet won: the SDK's reset did not beat Fin's utilities (FW-C06).
  const sidebar = page.locator("[data-sidebar-mode]");
  await expect(sidebar).toHaveCSS("width", "224px");
});

test("@csp a signed-out visit goes to sign-in, keeping a safe next", async ({ page }) => {
  await signedOut(page);
  await page.goto("/settings/team");
  await ready(page);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in?next=%2Fsettings%2Fteam`);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin" })).toBeVisible();
  await expect(page.locator("[data-slot=auth-layout]")).toBeVisible();
});

test("@journey the stored theme and sidebar apply before the first paint", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  // main.tsx is held, so what the page shows now is theme.js and the boot skeleton alone.
  const entry = await holdEntry(page, "dist/static");
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("fin-theme", "dark");
      window.localStorage.setItem("fin-sidebar", "collapsed");
    } catch {
      // A browser without storage: the test then fails on the theme below.
    }
  });
  await page.goto("/", { waitUntil: "commit" });
  await entry.requested;
  expect(await bootState(page)).toEqual({
    theme: "dark",
    choice: "dark",
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
});

test("@journey the boot skeleton draws the full sidebar when nothing is stored", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  const entry = await holdEntry(page, "dist/static");
  await page.goto("/", { waitUntil: "commit" });
  await entry.requested;
  expect(await bootState(page)).toMatchObject({
    sidebar: "expanded",
    bootSidebarWidth: "224px",
    ready: false,
  });
  entry.release();
  await ready(page);
  await expect(page.locator("[data-boot-block]")).toHaveCount(0);
});

test("@journey with storage blocked the page follows the system theme", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark", baseURL: ORIGIN });
  const page = await context.newPage();
  policy = await watchPolicy(context);
  await signedIn(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-choice", "system");
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "expanded");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Maya" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("@journey the edge toggle collapses and expands the sidebar, and remembers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await page.goto("/");
  await ready(page);
  const collapse = page.getByRole("button", { name: "Collapse sidebar" });
  await expect(collapse).toBeVisible();
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  const box = await collapse.boundingBox();
  // Centred on the 224px sidebar's right border, 40px down (under the Sandbox strip's row).
  expect(box).toMatchObject({ x: 212, y: 40, width: 24, height: 24 });

  // A press from the keyboard: the focus stays on the toggle, which does not move. (A click does
  // the same, but WebKit, like Safari, never focuses a button on click.)
  await collapse.focus();
  await page.keyboard.press("Enter");
  const expand = page.getByRole("button", { name: "Expand sidebar" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(expand).toBeFocused();
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "64px");
  expect(await expand.boundingBox()).toMatchObject({ x: 52, y: 40, width: 24, height: 24 });
  expect(await page.evaluate(() => localStorage.getItem("fin-sidebar"))).toBe("collapsed");

  // The rail's items are named by their tooltips; the current one is still marked.
  await expect(page.getByRole("link", { name: "Home", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // A reload keeps the rail (the first-paint test checks the boot skeleton draws it too).
  await page.reload();
  await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

  // A click expands it again.
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "224px");
  expect(await page.evaluate(() => localStorage.getItem("fin-sidebar"))).toBe("expanded");
});

test("@journey the tab order is the skip link, the logo, the toggle, then Home", async ({
  page,
  browserName,
}) => {
  // WebKit, like Safari, moves to links with Option+Tab only.
  const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
  await page.setViewportSize({ width: 1440, height: 900 });
  await signedIn(page);
  await page.goto("/");
  await ready(page);
  await page.locator("body").focus();
  await page.keyboard.press(tab);
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press(tab);
  await expect(page.getByRole("link", { name: "Fin home" })).toBeFocused();
  await page.keyboard.press(tab);
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeFocused();
  await page.keyboard.press(tab);
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeFocused();
});

test("@journey from 1024 to 1279px the width forces the rail and hides the toggle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await signedIn(page);
  await page.goto("/");
  await ready(page);
  await expect(page.locator("[data-sidebar-mode]")).toHaveCSS("width", "64px");
  await expect(page.getByRole("button", { name: /sidebar$/ })).toHaveCount(0);
});

test("@phone the phone shell opens the navigation as a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signedIn(page);
  await page.goto("/");
  await ready(page);
  await expect(page.getByRole("button", { name: /sidebar$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sheet = page.getByRole("dialog", { name: "Navigation" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Home", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await sheet.getByRole("button", { name: "Close navigation" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
});

test("@journey the account menu changes the theme at once", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "Account menu, Maya Rivera" }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("maya@example.com · Super admin")).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => localStorage.getItem("fin-theme"))).toBe("dark");
});

test("@journey the organisation switcher lists each organisation with the role", async ({
  page,
}) => {
  await signedIn(page);
  await page.goto("/");
  await ready(page);
  const trigger = page.getByRole("button", { name: "Switch organisation, current: Acme Remit" });
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio", { name: /Acme Remit/ })).toBeChecked();
  await expect(menu.getByRole("menuitemradio", { name: /Studio Ito/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Create organisation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

// The back-forward cache (FW-C14, FW-S4). A real restore cannot be triggered under automation, so
// the page receives the same pagehide and pageshow events a restore fires, in the same order.
async function leaveAndRestore(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
}

async function serveViewerOnDemand(page: Page) {
  const answers: Array<(route: Route) => Promise<void>> = [];
  const held: Array<() => void> = [];
  await serveStatic(page.context(), {
    dir: "dist/static",
    profile: "app",
    origin: ORIGIN,
    api: {
      "/api/viewer": async (route) => {
        // Each request waits for the test to release it, then takes the next queued answer.
        await new Promise<void>((release) => held.push(release));
        const answer = answers.shift() ?? ((r: Route) => r.fulfill(viewerAnswer(MAYA)));
        await answer(route);
      },
    },
  });
  return {
    /** Queues the next answer of /api/viewer. */
    next(answer: (route: Route) => Promise<void>) {
      answers.push(answer);
    },
    /** Lets the oldest held /api/viewer request answer. */
    release() {
      held.shift()?.();
    },
    held: () => held.length,
  };
}

function viewerAnswer(body: unknown) {
  return {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

test("@security a page restored from the back-forward cache shows nothing until the session is checked", async ({
  page,
}) => {
  const viewer = await serveViewerOnDemand(page);
  const loading = page.goto("/");
  await expect.poll(viewer.held).toBe(1);
  viewer.release();
  await loading;
  await ready(page);
  const heading = page.getByRole("heading", { level: 1, name: "Welcome, Maya" });
  await expect(heading).toBeVisible();

  // The session has ended elsewhere; the check is still on its way.
  viewer.next((route) => route.fulfill(problem(401, "unauthenticated")));
  await leaveAndRestore(page);
  await expect.poll(viewer.held).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("data-locked", "");
  await expect(heading).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Switch organisation, current: Acme Remit" }),
  ).toBeHidden();
  await expect(page.getByRole("button", { name: "Account menu, Maya Rivera" })).toBeHidden();
  await expect(page.locator("[data-strip=sandbox]")).toBeHidden();

  // The answer says signed out: the document loads again and goes to sign-in.
  viewer.next((route) => route.fulfill(problem(401, "unauthenticated")));
  viewer.release();
  await expect.poll(viewer.held).toBe(1);
  viewer.release();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin" })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-locked", /.*/);
  await expect(page.getByText("Maya")).toHaveCount(0);
});

test("@journey a restored page with the same session shows again", async ({ page }) => {
  const viewer = await serveViewerOnDemand(page);
  const loading = page.goto("/");
  await expect.poll(viewer.held).toBe(1);
  viewer.release();
  await loading;
  await ready(page);
  const heading = page.getByRole("heading", { level: 1, name: "Welcome, Maya" });
  await leaveAndRestore(page);
  await expect.poll(viewer.held).toBe(1);
  await expect(heading).toBeHidden();
  viewer.release();
  await expect(heading).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-locked", /.*/);
  await expect(page).toHaveURL(`${ORIGIN}/`);
});

test("@csp /api/health answers through the stub, same origin", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await ready(page);
  const health = await page.evaluate(async () => {
    const response = await fetch("/api/health");
    return {
      status: response.status,
      body: await response.json(),
      release: response.headers.get("fin-release"),
    };
  });
  expect(health).toEqual({ status: 200, body: { status: "ok" }, release: "e2e-release" });
});
