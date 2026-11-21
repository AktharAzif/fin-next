// The frame in a browser (spec 06 §2.4, §2.5, §5.1, §9): what static markup cannot show. The harness
// boots through startApp with the console's root and AppFrame, under the production page policy.
import { expect, type Page, test } from "@playwright/test";
import {
  type Answer,
  held,
  openHarness,
  type PageRecord,
  problem,
  VIEWER,
  violations,
} from "./serve.ts";

// The value the break page throws with, built as the page builds it.
const ADDRESS = ["maya.rivera", "example.com"].join("@");

let record: PageRecord;

test.afterEach(async ({ page }) => {
  expect(await violations(page, record)).toEqual([]);
  expect(record.offsite).toEqual([]);
  // Nothing the page printed holds the address, whatever failed.
  expect(record.console.join("\n")).not.toContain(ADDRESS);
});

const signedIn = (): Record<string, () => Answer> => ({
  "/viewer": () => ({ status: 200, body: VIEWER }),
});

const mounts = (page: Page) => page.evaluate(() => window.__harness?.mounts ?? []);
const politeRegion = (page: Page) => page.locator('[data-ui-sdk-announcer=""][aria-live="polite"]');

test.describe("the page's entrance (spec 06 §5.1)", () => {
  test("a slow navigation leaves the page on screen as it is; the new page gets its own entrance", async ({
    page,
  }) => {
    record = await openHarness(page, "/a", signedIn());
    await page.getByTestId("note").fill("kept");
    await page.evaluate(() =>
      document.querySelector(".fin-enter")?.setAttribute("data-marked", ""),
    );

    await page.getByRole("link", { name: "Go to the slow page" }).click();
    await expect(page).toHaveURL(/\/slow$/);
    // The slow page's loader is held: the location names it, the page drawn is still A.
    await page.waitForTimeout(300);
    await expect(page.getByRole("heading", { level: 1, name: "Page A" })).toBeVisible();
    await expect(page.getByTestId("note")).toHaveValue("kept");
    await expect(page.locator(".fin-enter[data-marked]")).toHaveCount(1);
    expect(await mounts(page)).toEqual(["mount A"]);

    await page.evaluate(() => window.__harness?.releaseSlow());
    await expect(page.getByRole("heading", { level: 1, name: "Slow page" })).toBeVisible();
    // A new wrapper: the entrance belongs to the new page.
    await expect(page.locator(".fin-enter")).toHaveCount(1);
    await expect(page.locator(".fin-enter[data-marked]")).toHaveCount(0);
    expect(await mounts(page)).toEqual(["mount A", "unmount A", "mount Slow"]);
  });

  test("a change of search parameters keeps the page, its entrance and focus where they are", async ({
    page,
  }) => {
    record = await openHarness(page, "/a", signedIn());
    await page.getByTestId("note").fill("kept");
    await page.evaluate(() =>
      document.querySelector(".fin-enter")?.setAttribute("data-marked", ""),
    );
    await page.getByRole("link", { name: "Details tab" }).click();
    await expect(page).toHaveURL(/\/a\?tab=details$/);
    await page.waitForTimeout(200);
    await expect(page.locator(".fin-enter[data-marked]")).toHaveCount(1);
    await expect(page.getByTestId("note")).toHaveValue("kept");
    await expect(page.getByRole("heading", { level: 1, name: "Page A" })).not.toBeFocused();
    expect(await mounts(page)).toEqual(["mount A"]);
  });

  test("a path below a page is the not-found page: its own entrance, title and focus", async ({
    page,
  }) => {
    record = await openHarness(page, "/a", signedIn());
    await page.evaluate(() =>
      document.querySelector(".fin-enter")?.setAttribute("data-marked", ""),
    );
    await page.getByRole("link", { name: "A page below this one" }).click();
    await expect(page).toHaveURL(/\/a\/missing$/);
    const heading = page.getByRole("heading", { level: 1, name: "Page not found" });
    await expect(heading).toBeVisible();
    // A new wrapper: the not-found page is another page than A, with its own entrance.
    await expect(page.locator(".fin-enter")).toHaveCount(1);
    await expect(page.locator(".fin-enter[data-marked]")).toHaveCount(0);
    await expect(page).toHaveTitle("Sandbox · Page not found · Fin");
    await expect(heading).toBeFocused();
    expect(await mounts(page)).toEqual(["mount A", "unmount A"]);
  });
});

test.describe("focus on navigation (S6-17, AC-UI-27)", () => {
  test("a new path focuses the page's h1 and announces its title once", async ({ page }) => {
    record = await openHarness(page, "/a", signedIn());
    await page.getByRole("link", { name: "Go to the slow page" }).click();
    await page.evaluate(() => window.__harness?.releaseSlow());
    const heading = page.getByRole("heading", { level: 1, name: "Slow page" });
    await expect(heading).toBeFocused();
    await expect(page).toHaveTitle("Sandbox · Slow page · Fin");
    await expect(politeRegion(page)).toHaveText("Sandbox · Slow page · Fin");
  });
});

test.describe("the report seam (spec 06 §2.6, AC-UI-29)", () => {
  test("a throwing button is reported and says so, and the console never prints the error whole", async ({
    page,
  }) => {
    record = await openHarness(page, "/break", signedIn());
    const before = await page.evaluate(() => window.__harness?.pendingReports() ?? 0);
    await page.getByRole("button", { name: "Break it" }).click();
    await expect
      .poll(() => page.evaluate(() => window.__harness?.pendingReports() ?? 0))
      .toBeGreaterThan(before);
    await expect(page.getByText("That didn’t work. Try again.")).toBeVisible();
  });
});

test.describe("a 401 (spec 06 §2.4)", () => {
  test("on an auth page's cold load is that page's own answer", async ({ page }) => {
    record = await openHarness(page, "/invite", {
      "/viewer": () => problem(401, "unauthenticated"),
      "/invitation": () => problem(401, "unauthenticated"),
    });
    await expect(page).toHaveURL(/\/invite$/);
    await expect(page.getByRole("heading", { level: 1, name: "Invitation" })).toBeVisible();
  });

  test("on an app route reached from an auth page goes to sign-in, keeping the path", async ({
    page,
  }) => {
    record = await openHarness(page, "/invite", {
      ...signedIn(),
      "/invitation": () => problem(401, "unauthenticated"),
      "/team/members": () => problem(401, "unauthenticated"),
    });
    await page.getByRole("link", { name: "Open Team" }).click();
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%2Fteam&error=signed_out$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin" })).toBeVisible();
  });
});

test.describe("the back-forward cache (FW-C14, FW-S4)", () => {
  const restore = (page: Page) =>
    page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );

  test("a restored page stays hidden until the session has been checked again", async ({
    page,
  }) => {
    const api = signedIn();
    record = await openHarness(page, "/a", api);
    const check = held(200, VIEWER);
    api["/viewer"] = check.answer;
    await restore(page);
    await expect(page.locator("#root")).toBeHidden();
    await page.waitForTimeout(200);
    await expect(page.locator("#root")).toBeHidden();
    check.release();
    await expect(page.locator("#root")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Page A" })).toBeVisible();
  });

  test("a restored page whose session has ended shows only the sign-in page", async ({ page }) => {
    const api = signedIn();
    record = await openHarness(page, "/a", api);
    const check = held(401, problem(401, "unauthenticated").body);
    api["/viewer"] = check.answer;
    await restore(page);
    await expect(page.locator("#root")).toBeHidden();
    check.release();
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fa&error=signed_out$/);
    await expect(page.locator("#root")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Fin" })).toBeVisible();
    await expect(page.getByText("Page A")).toHaveCount(0);
  });
});
