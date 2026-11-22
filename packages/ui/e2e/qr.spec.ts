// The kit's QR code (UR-13, [SA-45]) under the production page policy on Chromium, Firefox and
// WebKit, and dark and phone on Chromium: the code is SVG rects that scan back to the value, drawn
// in the same render with nothing fetched, on a tile that stays light in the dark theme and under
// forced colours. What each engine paints is read from a screenshot, pixel by pixel, at 1x and 2x:
// every module whole pixels of one shade, the dark share exactly the symbol's, and the pixels scan
// back to the value; at 1.25x, module edges grey but the mean darkness the symbol's, and the module
// centres scan. A value no code holds shows the failed tile, with no "Try again", reported
// once. No policy violation of the page's own, no request to another origin, no console error.
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  KIT_QR_LABEL,
  KIT_QR_SECRET,
  KIT_QR_SIZES,
  KIT_QR_TOO_LONG,
  KIT_QR_VALUE,
} from "../kit/qr-sample.ts";
import { decodeQr } from "../test/qr/decode.ts";
import { readDrawnQr, scanDrawnQr } from "../test/qr/drawn.ts";
import { locateSymbol, readPng, readScreenQr, readZoomedQr } from "../test/qr/pixels.ts";
import { openKit, type PageRecord, violations } from "./serve.ts";

const FAILED = "Couldn’t draw the QR code. Type the key instead.";

/**
 * What one of Playwright's own screenshots adds in WebKit: to sync animations it appends a
 * `<style>body {}</style>` to the page, which the policy refuses, as it should. The pixel tests
 * check the page had no violation before their first screenshot, and then expect exactly these,
 * one pair a screenshot, and nothing else.
 */
const WEBKIT_SCREENSHOT_STYLE = [
  "style-src-elem inline",
  "console: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
];

let record: PageRecord;
let screenshots = 0;

test.beforeEach(async ({ page }) => {
  screenshots = 0;
  record = await openKit(page);
});

test.afterEach(async ({ page, browserName }) => {
  const fromScreenshots =
    browserName === "webkit"
      ? Array.from({ length: screenshots }, () => WEBKIT_SCREENSHOT_STYLE).flat()
      : [];
  expect((await violations(page, record)).sort()).toEqual(fromScreenshots.sort());
  expect(record.offsite).toEqual([]);
  expect(record.consoleErrors).toEqual([]);
});

const part = (page: Page, name: string) => page.locator(`[data-kit="${name}"]`);
const tiles = (scope: Locator) => scope.locator('[data-slot="qr-code"]');
const scripts = () => record.served.filter((path) => path.endsWith(".js"));

/**
 * Screenshots a ready tile and reads it back pixel by pixel: every pixel of every module is the
 * module's shade, the margin round the symbol is light, the dark share is exactly the symbol's,
 * and the modules read from the pixels scan back to `value`. The layout may put the tile between
 * two pixels (WebKit's text metrics do in the kit); where the engine then paints it is found from
 * the pixels, within two of where the layout says. The screenshot asks Playwright for no
 * stylesheet to stop animations or hide the caret (the page policy refuses one); it waits for the
 * page's entrances to end instead. WebKit's one sync stylesheet is counted in `screenshots`.
 */
async function expectPaintedExactly(page: Page, tile: Locator, value: string): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    const ending = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined));
    await Promise.all(ending);
  });
  const box = await tile.boundingBox();
  if (box === null) throw new Error("the tile is not drawn");
  const drawn = await readDrawnQr(tile.getByRole("img"));
  const clip = {
    x: Math.floor(box.x) - 4,
    y: Math.floor(box.y) - 4,
    width: Math.ceil(box.width) + 8,
    height: Math.ceil(box.height) + 8,
  };
  if (screenshots === 0) {
    expect(await violations(page, record), "the page's own, before any screenshot").toEqual([]);
  }
  screenshots++;
  const png = await readPng(await page.screenshot({ clip, caret: "initial" }));
  const scale = png.width / clip.width;
  expect(Number.isInteger(scale), `${png.width}px across ${clip.width} CSS pixels`).toBe(true);
  const at = locateSymbol(png, drawn, scale, {
    x: (box.x - clip.x + drawn.offset) * scale,
    y: (box.y - clip.y + drawn.offset) * scale,
  });
  const read = readScreenQr(png, drawn, scale, at);
  expect(read.strayPixels, "pixels painted the other shade from their module").toBe(0);
  expect(read.darkMargin, "dark pixels in the light margin").toBe(0);
  expect(read.paintedDark).toBe(read.modulesDark);
  expect(decodeQr(drawn.size, read.modules).text).toBe(value);
}

test.describe("QrCode @kit", () => {
  test("@csp draws SVG rects that scan back to the value in the same render, fetching nothing", async ({
    page,
  }) => {
    const before = scripts();
    await part(page, "qr-live").getByRole("button", { name: "Draw the QR code" }).click();
    const tile = tiles(part(page, "qr-live"));
    await expect(tile).toHaveAttribute("data-state", "ready");
    const svg = tile.getByRole("img", { name: KIT_QR_LABEL });
    await expect(svg).toBeVisible();
    // The encoder comes with the component: the draw fetches no chunk of its own.
    expect(scripts()).toEqual(before);
    expect(record.served.filter((path) => /encode/.test(path))).toEqual([]);

    const decoded = await scanDrawnQr(svg);
    expect(decoded.text).toBe(KIT_QR_VALUE);
    expect(decoded.level).toBe("M");
    expect(decoded.version).toBe(5);

    // The board's 148px tile, 3px a module for this version, light whatever the theme.
    const drawn = await readDrawnQr(svg);
    expect(drawn).toMatchObject({ size: 37, tile: 148, module: 3, offset: 18 });
    const look = await tile.evaluate((element) => {
      const drawing = element.querySelector("svg") as SVGSVGElement;
      return {
        width: (element as HTMLElement).offsetWidth,
        height: (element as HTMLElement).offsetHeight,
        background: getComputedStyle(element).backgroundColor,
        ink: getComputedStyle(drawing).color,
      };
    });
    expect(look).toEqual({
      width: 148,
      height: 148,
      background: "rgb(255, 255, 255)",
      ink: "rgb(10, 10, 10)",
    });

    // Nothing but the drawing holds the value, and no image or image URL is anywhere.
    const html = await page.content();
    expect(html).not.toContain(KIT_QR_SECRET);
    expect(html).not.toContain(["da", "ta:"].join(""));
    expect(await page.locator("img, image, object, embed, iframe").count()).toBe(0);
  });

  test("paints every module on whole pixels, the dark share exact, and the pixels scan", async ({
    page,
  }) => {
    await part(page, "qr-live").getByRole("button", { name: "Draw the QR code" }).click();
    await part(page, "qr-sizes").getByRole("button", { name: "Draw codes of other sizes" }).click();
    await expectPaintedExactly(page, tiles(part(page, "qr-live")), KIT_QR_VALUE);
    const sized = tiles(part(page, "qr-sizes"));
    await expect(sized).toHaveCount(KIT_QR_SIZES.length);
    const versions: number[] = [];
    for (const [i, value] of KIT_QR_SIZES.entries()) {
      await expectPaintedExactly(page, sized.nth(i), value);
      versions.push((await scanDrawnQr(sized.nth(i).getByRole("img"))).version);
    }
    // 2px a module for versions 8 and 11 on the board's tile; version 15's tile grows to 162px.
    expect(versions).toEqual([8, 11, 15]);
    expect(await sized.nth(2).evaluate((element) => (element as HTMLElement).offsetWidth)).toBe(
      162,
    );
  });

  test.describe("at twice the pixel ratio", () => {
    test.use({ deviceScaleFactor: 2 });

    test("paints every module on whole device pixels", async ({ page }) => {
      await part(page, "qr-live").getByRole("button", { name: "Draw the QR code" }).click();
      await part(page, "qr-sizes")
        .getByRole("button", { name: "Draw codes of other sizes" })
        .click();
      await expectPaintedExactly(page, tiles(part(page, "qr-live")), KIT_QR_VALUE);
      for (const [i, value] of KIT_QR_SIZES.entries()) {
        await expectPaintedExactly(page, tiles(part(page, "qr-sizes")).nth(i), value);
      }
    });
  });

  test.describe("at 1.25 device pixels a CSS pixel (a 125% screen, a zoomed page)", () => {
    const SCALE = 1.25;
    test.use({ deviceScaleFactor: SCALE });

    test("paints module edges grey but no darker than they are, and the code scans", async ({
      page,
    }) => {
      await part(page, "qr-live").getByRole("button", { name: "Draw the QR code" }).click();
      await part(page, "qr-sizes")
        .getByRole("button", { name: "Draw codes of other sizes" })
        .click();
      const cases: [Locator, string][] = [
        [tiles(part(page, "qr-live")), KIT_QR_VALUE],
        ...KIT_QR_SIZES.map((value, i): [Locator, string] => [
          tiles(part(page, "qr-sizes")).nth(i),
          value,
        ]),
      ];
      for (const [tile, value] of cases) {
        await tile.scrollIntoViewIfNeeded();
        const svg = tile.getByRole("img");
        const box = await svg.boundingBox();
        if (box === null) throw new Error("the drawing is not drawn");
        const drawn = await readDrawnQr(svg);
        if (screenshots === 0) {
          expect(await violations(page, record), "the page's own, before any screenshot").toEqual(
            [],
          );
        }
        screenshots++;
        const png = await readPng(await page.screenshot({ caret: "initial" }));
        const read = readZoomedQr(png, drawn, SCALE, {
          x: (box.x + drawn.offset) * SCALE,
          y: (box.y + drawn.offset) * SCALE,
        });
        expect(read.mismatches, `module centres the other shade (version of ${value.length})`).toBe(
          0,
        );
        expect(decodeQr(drawn.size, read.modules).text).toBe(value);
        // Rounding dark edges outwards (crispEdges in WebKit) makes it 55% to 73% dark here.
        expect(Math.abs(read.meanDark - read.modulesDark)).toBeLessThan(0.04);
      }
    });
  });

  test("under forced colours in a dark scheme the tile stays light and its modules dark", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Playwright emulates forced colours in Chromium only");
    await page.emulateMedia({ forcedColors: "active", colorScheme: "dark" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    await part(page, "qr-live").getByRole("button", { name: "Draw the QR code" }).click();
    const tile = tiles(part(page, "qr-live"));
    const look = await tile.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      fill: getComputedStyle(element.querySelector("rect") as SVGRectElement).fill,
    }));
    expect(look).toEqual({ background: "rgb(255, 255, 255)", fill: "rgb(10, 10, 10)" });
    await expectPaintedExactly(page, tile, KIT_QR_VALUE);
  });

  test("a value no code holds: the failed tile says so, with no Try again, reported once", async ({
    page,
  }) => {
    const reports = part(page, "qr-reports");
    await expect(reports).toHaveAttribute("data-reports", "0");
    await part(page, "qr-too-long").getByRole("button", { name: "Draw a value too long" }).click();
    const tile = tiles(part(page, "qr-too-long"));
    await expect(tile).toHaveAttribute("data-state", "failed");
    await expect(tile).toHaveText(FAILED);
    await expect(tile.getByRole("button")).toHaveCount(0);
    await expect(reports).toHaveAttribute("data-reports", "1");
    // The page around it draws again; the refusal is not reported again.
    const again = part(page, "qr-too-long").getByRole("button", { name: /Draw the page again/ });
    await again.click();
    await again.click();
    await expect(again).toHaveText("Draw the page again (2)");
    await expect(reports).toHaveAttribute("data-reports", "1");
    expect(await page.content()).not.toContain(KIT_QR_TOO_LONG);
  });

  test("the failed tile, drawn still", async ({ page }) => {
    const still = part(page, "qr-still");
    await still.getByRole("button", { name: "Show the failed state" }).click();
    const tile = tiles(still);
    await expect(tile).toHaveAttribute("data-state", "failed");
    await expect(tile).toHaveText(FAILED);
    await expect(tile.getByRole("button")).toHaveCount(0);
    expect(
      await tile.evaluate((el) => [
        (el as HTMLElement).offsetWidth,
        (el as HTMLElement).offsetHeight,
      ]),
    ).toEqual([148, 148]);
  });
});
