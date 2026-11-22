// The authenticator's QR code in the built console (UR-13, [SA-45]; the Authenticator board's
// scan, qrFailed and keyCopied states; spec 02 §5.4): the `otpauth://` URI that
// `/two-factor/enable` answers once is drawn in the browser as SVG rects that scan back to it,
// beside the key for manual entry, both in the render that shows the answer. Nothing is fetched
// between the answer and its drawing, so no chunk that fails to load can make the frame reload the
// page (FW-C13's reload on a failed chunk) and lose the answer: each journey refuses every script
// asked for after the answer, and checks there was none, one answer, and no reload. The app runs on
// the harness's static host under the production page policy (the fixtures fail a test on any
// violation or off-site request); `/api/*` is the scripted stand-in.
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page, Route } from "@playwright/test";
import { readDrawnQr, scanDrawnQr } from "../../../../packages/ui/test/qr/drawn.ts";
import { ApiDouble, ok, viewer } from "../support/api-double.ts";

const LABEL = "QR code for your authenticator app";
const FAILED = "Couldn’t draw the QR code. Type the key instead.";
const ENABLE = "POST /api/auth/two-factor/enable";

// An authenticator key and URI shaped as the realm writes them (52 base32 characters; the issuer
// encoded twice over, as Better Auth's utilities do), joined at run time so the source holds no
// secret-shaped value (CONTRIBUTING).
const SECRET = `${"GEZDGNBVGY3TQOJQ".repeat(3)}GEZA`;
const URI = [
  "otpauth://totp/Fin%20(test):maya%40example.com?",
  ["sec", "ret"].join(""),
  `=${SECRET}&issuer=Fin+%28test%29&digits=6&period=30`,
].join("");
const GROUPED = (SECRET.match(/.{1,4}/g) ?? []).join(" ");
const CODES = Array.from({ length: 10 }, (_, i) => `code-${String(i).padStart(4, "0")}`);

/**
 * Watches one set-up: the answer to `/two-factor/enable` waits until the page has fetched what it
 * fetches by itself at the start (the root's preload of the StepUp dialog), and from the answer on
 * every script the page asks for is refused and recorded. A screen that fetched a chunk to draw the
 * answer would show here twice: in `scriptsAfterAnswer`, and as the frame's reload, which loads the
 * document again and asks `/two-factor/enable` for a new key.
 */
class SetUpWatch {
  readonly scriptsAfterAnswer: string[] = [];
  private answered = false;
  /** The documents the page asked the static host for: one, unless it loaded again. */
  private documents = 0;
  private stepUpLoaded: Promise<void> = Promise.resolve();

  async install(page: Page, api: ApiDouble, totpURI: string): Promise<void> {
    page.on("request", (request) => {
      if (request.resourceType() === "document" && request.frame() === page.mainFrame()) {
        this.documents++;
      }
    });
    this.stepUpLoaded = new Promise<void>((resolve) => {
      page.on("requestfinished", (request) => {
        if (/\/assets\/StepUpDialog-[\w-]+\.js$/.test(new URL(request.url()).pathname)) resolve();
      });
    });
    api.on(ENABLE, async () => {
      await this.stepUpLoaded;
      this.answered = true;
      return ok({ totpURI, backupCodes: CODES });
    });
    await page.route(/\/assets\/[^/]+\.js$/, async (route: Route) => {
      if (!this.answered) {
        await route.fallback();
        return;
      }
      this.scriptsAfterAnswer.push(new URL(route.request().url()).pathname);
      await route.abort();
    });
  }

  /** One answer, nothing fetched after it, and the page never loaded again. */
  async expectOneAnswer(page: Page, api: ApiDouble): Promise<void> {
    expect(this.scriptsAfterAnswer).toEqual([]);
    expect(api.calls(ENABLE)).toHaveLength(1);
    expect(this.documents).toBe(1);
    expect(await page.evaluate(() => window.sessionStorage.getItem("fin-reloaded"))).toBeNull();
  }
}

/** The welcome step's stand-in: a developer held at "Protect your account", with no factor yet. */
function welcome(): ApiDouble {
  return new ApiDouble()
    .on(
      "GET /api/viewer",
      ok(
        viewer({
          gate: "protect_account",
          factors: { passkeys: 0, authenticator: false, backupCodesLeft: null },
        }),
      ),
    )
    .on("POST /api/auth/two-factor/verify-totp", ok({}));
}

const scan = (page: Page) =>
  page.getByRole("region", { name: "1. Scan this with your authenticator app" });
const tile = (page: Page) => scan(page).locator('[data-slot="qr-code"]');

test.describe("the authenticator's QR code", () => {
  test("@journey @csp the set-up draws the QR code with the key from one answer, fetching nothing after it", async ({
    page,
    browserName,
  }) => {
    const api = welcome();
    const watch = new SetUpWatch();
    await watch.install(page, api, URI);
    await api.install(page);
    await gotoReady(page, "/welcome/authenticator");

    const svg = scan(page).getByRole("img", { name: LABEL });
    await expect(svg).toBeVisible();
    await expect(tile(page)).toHaveAttribute("data-state", "ready");
    const decoded = await scanDrawnQr(svg);
    expect(decoded.text).toBe(URI);
    expect(decoded.level).toBe("M");
    expect(decoded.version).toBe(8);
    // Whole pixels: 2px a module on the board's 148px tile.
    const drawn = await readDrawnQr(svg);
    expect(drawn).toMatchObject({ size: 49, tile: 148, module: 2, offset: 25 });

    // The key for manual entry stays beside it.
    await expect(scan(page).getByText("Can’t scan? Type this key instead.")).toBeVisible();
    await expect(page.getByTestId("authenticator-key")).toHaveText(GROUPED);

    // Drawn in place: no image, no image URL, and the secret nowhere but the key.
    const markup = await scan(page).evaluate((element) => element.outerHTML);
    expect(markup).not.toContain(["da", "ta:"].join(""));
    expect(markup).not.toMatch(/<img|<image|<object|<embed|<iframe|href=|style=/i);
    expect(markup).not.toContain("otpauth");
    expect(markup.split(SECRET)).toHaveLength(1);
    expect(await page.locator("img").count()).toBe(0);

    // keyCopied: the key, ungrouped, on the clipboard (Chromium grants the clipboard to a test).
    if (browserName === "chromium") {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await scan(page).getByRole("button", { name: "Copy key" }).click();
      await expect(scan(page).getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SECRET);
    }

    // The code from the app turns it on, and the backup codes follow, once.
    const input = page.getByRole("textbox", { name: "2. Enter the 6-digit code it shows" });
    await input.focus();
    await input.fill("123456");
    await expect(
      page.getByRole("heading", { level: 1, name: "Save your backup codes" }),
    ).toBeVisible();
    expect(api.calls("POST /api/auth/two-factor/verify-totp")[0]?.body).toEqual({ code: "123456" });
    await watch.expectOneAnswer(page, api);
  });

  test("@journey @phone Account security's set-up dialog draws the same QR code, stays open, and keeps its one key", async ({
    page,
  }) => {
    const api = new ApiDouble()
      .on(
        "GET /api/viewer",
        ok(viewer({ factors: { passkeys: 1, authenticator: false, backupCodesLeft: null } })),
      )
      .on(
        "GET /api/account/security",
        ok({
          name: "Maya Rivera",
          email: "maya@example.com",
          passkeys: [{ id: "pky_1", name: "Chrome on Mac", createdAt: "2026-11-02T10:05:00Z" }],
          authenticator: false,
          backupCodesLeft: null,
          trustedBrowsers: [],
          noSecondFactor: false,
        }),
      )
      .on("GET /api/account/sessions", ok({ items: [], total: 0 }))
      .on("GET /api/account/activity", ok({ items: [], total: 0 }));
    const watch = new SetUpWatch();
    await watch.install(page, api, URI);
    await api.install(page);
    await gotoReady(page, "/account/security");
    await page
      .getByRole("table", { name: "Your sign-in methods" })
      .getByRole("button", { name: "Set up" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Set up your authenticator" });
    const svg = dialog.getByRole("img", { name: LABEL });
    await expect(svg).toBeVisible();
    expect((await scanDrawnQr(svg)).text).toBe(URI);
    await expect(dialog.getByTestId("authenticator-key")).toHaveText(GROUPED);
    await watch.expectOneAnswer(page, api);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("authenticator-key")).toHaveText(GROUPED);
  });

  test("@journey a URI no QR code can hold: the tile says so, and the key still sets the app up", async ({
    page,
  }) => {
    // Past the 7,089 characters any QR code holds; the key in it is the realm's.
    const tooLong = `${URI}&note=${"7".repeat(7100)}`;
    const api = welcome();
    const watch = new SetUpWatch();
    await watch.install(page, api, tooLong);
    await api.install(page);
    await gotoReady(page, "/welcome/authenticator");
    await expect(tile(page)).toHaveAttribute("data-state", "failed");
    await expect(tile(page)).toHaveText(FAILED);
    // A second try would draw the same: there is no Try again.
    await expect(tile(page).getByRole("button")).toHaveCount(0);
    await expect(scan(page).getByRole("img")).toHaveCount(0);
    await expect(page.getByTestId("authenticator-key")).toHaveText(GROUPED);

    const input = page.getByRole("textbox", { name: "2. Enter the 6-digit code it shows" });
    await input.focus();
    await input.fill("123456");
    await expect(
      page.getByRole("heading", { level: 1, name: "Save your backup codes" }),
    ).toBeVisible();
    await watch.expectOneAnswer(page, api);
  });
});
