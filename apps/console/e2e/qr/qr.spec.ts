// The authenticator's QR code in the built console (UR-13, [SA-45]; the Authenticator board's
// scan, qrFailed and keyCopied states; spec 02 §5.4): the `otpauth://` URI that
// `/two-factor/enable` answers once is drawn in the browser as SVG rects that scan back to it,
// beside the key for manual entry, both in the render that shows the answer. Nothing is fetched
// between the answer and its drawing, so no chunk that fails to load can make the frame reload the
// page (FW-C13's reload on a failed chunk) and lose the answer: each journey refuses every script
// asked for after the answer, and checks there was none, one answer, and no reload. Nothing the
// page sends to `/api/*` carries the key or the URI, however spelt (escaped, form-encoded, in
// groups of four, in any case: a test checks the check). (The frame keeps a failure report in
// memory until the monitoring lane's relay is installed, so a journey cannot read the report a
// refusal makes; the kit spec and the unit tests read it. The relay's envelopes go to `/api/*`, and this
// check will cover them.) The app runs on the harness's static host under the production page
// policy (the fixtures fail a test on any violation or off-site request); `/api/*` is the scripted
// stand-in.
import { expect, gotoReady, test } from "@fin/testing/playwright";
import type { Page, Route } from "@playwright/test";
import { readDrawnQr, scanDrawnQr } from "../../../../packages/ui/test/qr/drawn.ts";
import { ApiDouble, ok, type Recorded, viewer } from "../support/api-double.ts";

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

/**
 * Text as the check reads it, however a request spelt it: every `%XX` escape undone (again while
 * one is left, so a value escaped twice reads too; a byte past ASCII as a space), then upper case
 * with everything but letters and digits gone. The key reads the same in groups of four, in a
 * path, a query string or a form body (space as `%20` or `+`), and in any case.
 */
function readable(text: string): string {
  let current = text;
  let previous: string;
  do {
    previous = current;
    current = previous.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code < 0x80 ? String.fromCharCode(code) : " ";
    });
  } while (current !== previous);
  return current.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Each part of one recorded request as text: its method, path, query, headers and body. */
function partsOf(request: Recorded): (readonly [string, string])[] {
  const body =
    typeof request.body === "string" ? request.body : (JSON.stringify(request.body) ?? "");
  return [
    ["method", request.method],
    ["path", request.path],
    ...[...request.search].flatMap(([name, value]) => [
      ["query", name] as const,
      ["query", value] as const,
    ]),
    ...Object.entries(request.headers).flatMap(([name, value]) => [
      ["header", name] as const,
      ["header", value] as const,
    ]),
    ["body", body],
  ];
}

/** Which parts of the requests carry the key or the URI, each read as `readable` reads it. */
function keyCarriers(requests: readonly Recorded[]): string[] {
  const pieces = [readable(SECRET), readable("otpauth")];
  return requests.flatMap((request, index) =>
    partsOf(request)
      .filter(([, text]) => pieces.some((piece) => readable(text).includes(piece)))
      .map(([part]) => `request ${index} (${request.method}): its ${part}`),
  );
}

/**
 * Nothing the page sent to `/api/*` (its method, path, query, headers or body) carries the key or
 * the URI, however it is spelt: only the code from the app goes back.
 */
function expectKeyNeverSent(api: ApiDouble): void {
  expect(api.requests.length).toBeGreaterThan(0);
  expect(keyCarriers(api.requests), "the key or the URI in a request").toEqual([]);
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
  test("@journey the check on what the page sends finds the key and the URI however a request spells them", () => {
    const sent = (part: Partial<Recorded>): Recorded => ({
      method: "GET",
      path: "/api/viewer",
      search: new URLSearchParams(),
      headers: {},
      body: undefined,
      ...part,
    });
    const spellings: readonly Recorded[] = [
      // The key as the screen shows it, in groups of four: in a query string (as a URL's
      // searchParams reads `%20`, and as a form encodes it, with `+`), a path and a form body.
      sent({ search: new URLSearchParams(`k=${encodeURIComponent(GROUPED)}`) }),
      sent({ search: new URLSearchParams(`k=${GROUPED.replaceAll(" ", "+")}`) }),
      sent({ path: `/api/keys/${encodeURIComponent(GROUPED)}` }),
      sent({ method: "POST", body: new URLSearchParams({ key: GROUPED }).toString() }),
      // In lower case with other separators in a JSON body, and escaped twice in a header.
      sent({ method: "POST", body: { key: GROUPED.toLowerCase().replaceAll(" ", "-") } }),
      sent({ headers: { "x-key": encodeURIComponent(encodeURIComponent(GROUPED)) } }),
      // The URI, escaped, in a form body.
      sent({ method: "POST", body: `u=${encodeURIComponent(URI)}` }),
    ];
    for (const [index, request] of spellings.entries()) {
      expect(keyCarriers([request]), `spelling ${index}`).toHaveLength(1);
    }
    // What a set-up sends back, the code from the app, carries neither.
    const code = sent({
      method: "POST",
      path: "/api/auth/two-factor/verify-totp",
      headers: { "x-fin-app": "console", "content-type": "application/json" },
      body: { code: "123456" },
    });
    expect(keyCarriers([code])).toEqual([]);
  });

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

    // Drawn in place: no image, no image URL, and the secret nowhere but the key, however spelt
    // (the key shows in groups of four, so a raw search alone would miss a grouped copy).
    const markup = await scan(page).evaluate((element) => element.outerHTML);
    expect(markup).not.toContain(["da", "ta:"].join(""));
    expect(markup).not.toMatch(/<img|<image|<object|<embed|<iframe|href=|style=/i);
    expect(markup).not.toContain("otpauth");
    expect(markup.split(SECRET)).toHaveLength(1);
    expect(readable(markup).split(readable(SECRET))).toHaveLength(2);
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
    expectKeyNeverSent(api);
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
    expectKeyNeverSent(api);
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
    expectKeyNeverSent(api);
  });
});
