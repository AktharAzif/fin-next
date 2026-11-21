// The authenticator's QR code in the built console (UR-13, [SA-45]; the Authenticator board's
// scan, qrLoading, qrFailed and keyCopied states; spec 02 §5.4): the `otpauth://` URI that
// `/two-factor/enable` answers is drawn in the browser as SVG rects that scan back to it, beside
// the key for manual entry, which is there from the first frame whatever the QR code does. The app
// runs on the harness's static host under the production page policy (the fixtures fail a test on
// any violation or off-site request); `/api/*` is the scripted stand-in.
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page, Route } from "@playwright/test";
import { readDrawnQr, scanDrawnQr } from "../../../../packages/ui/test/qr/drawn.ts";
import { ApiDouble, ok, viewer } from "../support/api-double.ts";

const ENCODER_CHUNK = /\/assets\/encode-[A-Za-z0-9_-]+\.js$/;
const LABEL = "QR code for your authenticator app";

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
    .on("POST /api/auth/two-factor/enable", ok({ totpURI: URI, backupCodes: CODES }))
    .on("POST /api/auth/two-factor/verify-totp", ok({}));
}

/** Holds the encoder chunk until `release` is called. */
async function holdEncoder(page: Page): Promise<() => void> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(ENCODER_CHUNK, async (route: Route) => {
    await held;
    await route.continue();
  });
  return release;
}

const scan = (page: Page) =>
  page.getByRole("region", { name: "1. Scan this with your authenticator app" });
const tile = (page: Page) => scan(page).locator('[data-slot="qr-code"]');

test.describe("the authenticator's QR code", () => {
  test("@journey @csp the set-up draws the QR code, which scans to the URI, with the key kept", async ({
    page,
    browserName,
  }) => {
    const chunks: string[] = [];
    page.on("request", (request) => {
      if (ENCODER_CHUNK.test(new URL(request.url()).pathname)) chunks.push(request.url());
    });
    const api = welcome();
    await api.install(page);
    await gotoReady(page, "/welcome/authenticator");

    const svg = scan(page).getByRole("img", { name: LABEL });
    await expect(svg).toBeVisible();
    await expect(tile(page)).toHaveAttribute("data-state", "ready");
    const decoded = await scanDrawnQr(svg);
    expect(decoded.text).toBe(URI);
    expect(decoded.level).toBe("M");
    expect(decoded.version).toBe(8);
    expect(chunks).toHaveLength(1);

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
  });

  test("@journey the placeholder shows while the QR code's chunk loads; the key is there at once", async ({
    page,
  }) => {
    const release = await holdEncoder(page);
    await welcome().install(page);
    await gotoReady(page, "/welcome/authenticator");
    await expect(tile(page)).toHaveAttribute("data-state", "loading");
    await expect(tile(page)).toHaveText("Loading the QR code");
    await expect(page.getByTestId("authenticator-key")).toHaveText(GROUPED);
    await expect(scan(page).getByRole("button", { name: "Copy key" })).toBeEnabled();
    release();
    const svg = scan(page).getByRole("img", { name: LABEL });
    await expect(svg).toBeVisible();
    expect((await scanDrawnQr(svg)).text).toBe(URI);
  });

  test("@journey a QR code that cannot load offers Try again; the key still sets the app up", async ({
    page,
  }) => {
    let refuse = true;
    await page.route(ENCODER_CHUNK, async (route: Route) => {
      if (refuse) await route.abort();
      else await route.continue();
    });
    const api = welcome();
    await api.install(page);
    await gotoReady(page, "/welcome/authenticator");
    await expect(tile(page)).toHaveAttribute("data-state", "failed");
    await expect(tile(page)).toContainText("Couldn’t draw the QR code. Type the key instead.");
    await expect(scan(page).getByRole("img")).toHaveCount(0);
    await expect(page.getByTestId("authenticator-key")).toHaveText(GROUPED);

    refuse = false;
    await scan(page).getByRole("button", { name: "Try again" }).click();
    const svg = scan(page).getByRole("img", { name: LABEL });
    await expect(svg).toBeVisible();
    const { size } = await readDrawnQr(svg);
    expect(size).toBe(49);
    expect((await scanDrawnQr(svg)).text).toBe(URI);
  });

  test("@journey Account security's set-up dialog draws the same QR code", async ({ page }) => {
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
      .on("GET /api/account/activity", ok({ items: [], total: 0 }))
      .on("POST /api/auth/two-factor/enable", ok({ totpURI: URI, backupCodes: CODES }));
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
  });
});
