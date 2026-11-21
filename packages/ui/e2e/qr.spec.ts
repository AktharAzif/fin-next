// The kit's QR code (UR-13, [SA-45]) under the production page policy on Chromium, Firefox and
// WebKit, and dark and phone on Chromium: the code is SVG rects that scan back to the value, on a
// tile that stays light in the dark theme; the encoder chunk is fetched only when a code is drawn;
// the placeholder shows while it loads; a chunk that cannot load shows "Try again", is reported,
// and the next try draws the code. No policy violation, no request to another origin.
import { expect, type Page, test } from "@playwright/test";
import { KIT_QR_LABEL, KIT_QR_SECRET, KIT_QR_VALUE } from "../kit/qr-sample.ts";
import { scanDrawnQr } from "../test/qr/drawn.ts";
import { openKit, type PageRecord, violations } from "./serve.ts";

const ENCODER_CHUNK = /\/assets\/encode-[A-Za-z0-9_-]+\.js$/;

let record: PageRecord;
/** Console errors a test expects (a chunk it refused on purpose), left out of the afterEach. */
let expectedErrors: RegExp | null = null;

test.beforeEach(async ({ page }) => {
  expectedErrors = null;
  record = await openKit(page);
});

test.afterEach(async ({ page }) => {
  expect(await violations(page, record)).toEqual([]);
  expect(record.offsite).toEqual([]);
  const errors = record.consoleErrors.filter((text) => !expectedErrors?.test(text));
  expect(errors).toEqual([]);
});

const live = (page: Page) => page.locator('[data-kit="qr-live"]');
const tile = (page: Page) => live(page).locator('[data-slot="qr-code"]');
const encoderServed = () => record.served.some((path) => ENCODER_CHUNK.test(`/${path}`));

test.describe("QrCode @kit", () => {
  test("@csp draws SVG rects that scan back to the value, fetching the encoder only then", async ({
    page,
  }) => {
    expect(encoderServed()).toBe(false);
    await live(page).getByRole("button", { name: "Draw the QR code" }).click();
    const svg = live(page).getByRole("img", { name: KIT_QR_LABEL });
    await expect(svg).toBeVisible();
    expect(encoderServed()).toBe(true);
    await expect(tile(page)).toHaveAttribute("data-state", "ready");

    const decoded = await scanDrawnQr(svg);
    expect(decoded.text).toBe(KIT_QR_VALUE);
    expect(decoded.level).toBe("M");

    // The board's tile: 148px, the symbol 136px inside it, light whatever the theme.
    const geometry = await tile(page).evaluate((element) => {
      const drawing = element.querySelector("svg") as SVGSVGElement;
      const style = getComputedStyle(element);
      return {
        tile: (element as HTMLElement).offsetWidth,
        // Measured against the tile's own box, so an entrance's scale does not count.
        symbol:
          (drawing.getBoundingClientRect().width / element.getBoundingClientRect().width) *
          (element as HTMLElement).offsetWidth,
        background: style.backgroundColor,
        ink: getComputedStyle(drawing).color,
      };
    });
    expect(geometry.tile).toBe(148);
    expect(Math.round(geometry.symbol)).toBe(136);
    expect(geometry.background).toBe("rgb(255, 255, 255)");
    expect(geometry.ink).toBe("rgb(10, 10, 10)");

    // Nothing but the drawing holds the value, and no image or image URL is anywhere.
    const html = await page.content();
    expect(html).not.toContain(KIT_QR_SECRET);
    expect(html).not.toContain(["da", "ta:"].join(""));
    expect(await page.locator("img, image, object, embed, iframe").count()).toBe(0);
  });

  test("shows the placeholder while the encoder loads, then the code", async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(ENCODER_CHUNK, async (route) => {
      await held;
      await route.fallback();
    });
    await live(page).getByRole("button", { name: "Draw the QR code" }).click();
    await expect(tile(page)).toHaveAttribute("data-state", "loading");
    await expect(tile(page)).toHaveAttribute("aria-busy", "true");
    await expect(tile(page)).toHaveText("Loading the QR code");
    await expect(page.locator('[data-ui-sdk-announcer=""]')).toHaveText("Loading the QR code");
    release();
    const svg = live(page).getByRole("img", { name: KIT_QR_LABEL });
    await expect(svg).toBeVisible();
    expect((await scanDrawnQr(svg)).text).toBe(KIT_QR_VALUE);
  });

  test("a chunk that cannot load: Try again, reported, and the next try draws", async ({
    page,
  }) => {
    expectedErrors = /Failed to load resource|encode-|dynamically imported module|ERR_FAILED/i;
    let refuse = true;
    await page.route(ENCODER_CHUNK, async (route) => {
      if (refuse) await route.abort();
      else await route.fallback();
    });
    await live(page).getByRole("button", { name: "Draw the QR code" }).click();
    await expect(tile(page)).toHaveAttribute("data-state", "failed");
    await expect(tile(page)).toContainText("Couldn’t draw the QR code. Type the key instead.");
    await expect(page.locator("body")).toHaveAttribute("data-reported", "");
    await expect(live(page).getByRole("img")).toHaveCount(0);

    refuse = false;
    await live(page).getByRole("button", { name: "Try again" }).click();
    const svg = live(page).getByRole("img", { name: KIT_QR_LABEL });
    await expect(svg).toBeVisible();
    expect((await scanDrawnQr(svg)).text).toBe(KIT_QR_VALUE);
  });

  test("the placeholder and failed tiles, drawn still", async ({ page }) => {
    const still = page.locator('[data-kit="qr-still"]');
    await still.getByRole("button", { name: "Show the other states" }).click();
    const tiles = still.locator('[data-slot="qr-code"]');
    await expect(tiles).toHaveCount(2);
    await expect(tiles.nth(0)).toHaveAttribute("data-state", "loading");
    await expect(tiles.nth(0).locator("[data-skeleton]")).toHaveCount(1);
    await expect(tiles.nth(1)).toHaveAttribute("data-state", "failed");
    await expect(tiles.nth(1).getByRole("button", { name: "Try again" })).toBeVisible();
    for (const index of [0, 1]) {
      expect(await tiles.nth(index).evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(148);
    }
  });
});
