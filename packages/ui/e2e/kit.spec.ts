// The kit spec (spec 06 §10.3; AC-P0-16): every wave 0 and wave 1 component of @fin/ui, live, under
// the production page policy, with zero securitypolicyviolation events, on Chromium, Firefox and
// WebKit. Tags: @csp for the policy cases, @kit for the component cases, @motion for reduced motion.
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openKit, type PageRecord, violations } from "./serve.ts";

// The kit's sample signing secret, joined at run time as the kit joins it.
const SIGNING_SECRET = ["whsec", "kit", "sample", "only"].join("_");

let record: PageRecord;

test.beforeEach(async ({ page }) => {
  record = await openKit(page);
});

test.afterEach(async ({ page }) => {
  expect(await violations(page, record)).toEqual([]);
  expect(record.offsite).toEqual([]);
  expect(record.consoleErrors).toEqual([]);
});

const section = (page: Page, name: string) => page.locator(`section[data-kit="${name}"]`);

/** The one toast region (its text is also spoken through the SDK's live region). */
const toasts = (page: Page) => page.getByRole("region", { name: "Notifications" });

/**
 * Focus as the keyboard gives it: tooltips and focus rings answer keyboard focus, not a click.
 * A key press first sets the keyboard modality; then focus moves (Tab does not reach buttons in
 * every WebKit build, so the spec moves it directly).
 */
async function keyboardFocus(page: Page, target: ReturnType<Page["locator"]>) {
  await page.keyboard.press("Shift");
  await target.focus();
  await expect(target).toBeFocused();
}

/**
 * Moves focus onto `target` with the Tab key from the element before it. Some WebKit builds leave
 * buttons out of the Tab order unless Option is held, so WebKit tries Alt+Tab when Tab misses.
 */
async function tabTo(page: Page, target: Locator) {
  for (const [back, forward] of [
    ["Shift+Tab", "Tab"],
    ["Alt+Shift+Tab", "Alt+Tab"],
  ] as const) {
    await target.focus();
    await page.keyboard.press(back);
    await page.keyboard.press(forward);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

/** The kit's page-level tabs (the section also holds a drawer's tabs). */
const customerTabs = (page: Page) =>
  section(page, "tabs")
    .locator('[data-slot="tabs"]')
    .filter({
      has: page.getByRole("tablist", { name: "Customer", exact: true }),
    });

/** The text colour tokens as computed colours, for the theme the page shows. */
async function textTokens(page: Page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const rgb = (name: string) => {
      const hex = root.getPropertyValue(name).trim().replace(/^#/, "");
      const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
      return `rgb(${r}, ${g}, ${b})`;
    };
    return {
      primary: rgb("--fin-color-text-primary"),
      secondary: rgb("--fin-color-text-secondary"),
      tertiary: rgb("--fin-color-text-tertiary"),
      disabled: rgb("--fin-color-text-disabled"),
    };
  });
}

/** Layout width, unaffected by an entry transition's scale. */
const layoutWidth = (target: ReturnType<Page["locator"]>) =>
  target.evaluate((el) => (el as HTMLElement).offsetWidth);

/**
 * Puts the page on Playwright's clock (spec 06 §10.2: countdowns and busy windows use it). The
 * clock goes in before the page loads, so no timer the page started is a real one; the load's own
 * timers run, then time stands still until the test moves it with runFor.
 */
async function onTestClock(page: Page) {
  await page.clock.install();
  await page.reload();
  await page.locator("body[data-ready]").waitFor();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
}

test.describe("the page policy @csp", () => {
  test("the policy is enforced: a style attribute set from script is refused and reported", async ({
    page,
  }) => {
    const refused = await page.evaluate(() => {
      const probe = document.createElement("div");
      document.body.append(probe);
      probe.setAttribute("style", "color: rgb(1, 2, 3)");
      const applied = getComputedStyle(probe).color === "rgb(1, 2, 3)";
      probe.remove();
      return !applied;
    });
    expect(refused).toBe(true);
    await expect
      .poll(async () => (await page.evaluate(() => window.__violations ?? [])).length)
      .toBeGreaterThan(0);
    // This test made the violation on purpose: clear it so the shared check holds for the rest.
    await page.evaluate(() => {
      window.__violations = [];
    });
    record.violations = [];
  });

  test("the csp-nonce meta carries no nonce, and nothing inline is in the document", async ({
    page,
  }) => {
    const meta = page.locator('meta[property="csp-nonce"]');
    await expect(meta).toHaveCount(1);
    expect(await meta.getAttribute("nonce")).toBeNull();
    expect(await page.locator("script:not([src])").count()).toBe(0);
    expect(await page.locator("[nonce]").count()).toBe(0);
  });

  test("the SDK's styles are adopted sheets, never <style> elements", async ({ page }) => {
    await section(page, "menu").locator('[data-kit="menu-trigger"]').click();
    await expect(page.getByRole("menu")).toBeVisible();
    const sheets = await page.evaluate(() => document.adoptedStyleSheets.length);
    expect(sheets).toBeGreaterThan(0);
    expect(await page.locator('style[id^="ui-sdk-"]').count()).toBe(0);
    expect(await page.locator("style").count()).toBe(0);
    await page.keyboard.press("Escape");
  });

  test("a plain popover has no border, padding or fill; a utility beats the SDK's reset", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Plain popover" }).click();
    const plain = page.locator('[data-kit="plain-popover"]');
    await expect(plain).toBeVisible();
    const box = await plain.evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, padding: s.paddingTop, fill: s.backgroundColor };
    });
    expect(box.border).toBe("0px");
    expect(box.padding).toBe("0px");
    expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(box.fill);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Styled popover" }).click();
    const styled = await page.locator('[data-kit="styled-popover"]').evaluate((el) => {
      const s = getComputedStyle(el);
      return { border: s.borderTopWidth, padding: s.paddingTop };
    });
    expect(styled).toEqual({ border: "1px", padding: "16px" });
  });

  test("[data-slot][hidden] stays hidden under a display class", async ({ page }) => {
    const display = await page
      .locator('[data-kit="hidden-slot"]')
      .evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe("none");
  });

  test("the built assets carry no data: URL, no agent bridge and no development marker", async ({
    page,
  }) => {
    // Every file the build emitted, from its manifest (entries, the chunks the SDK imports lazily,
    // stylesheets and fonts), with the page itself and what it names: not only what index.html
    // loads, since a lazily loaded chunk is never named there.
    const files = await page.evaluate(async () => {
      type Chunk = { file: string; css?: string[]; assets?: string[] };
      const manifest = (await (await fetch("/.vite/manifest.json")).json()) as Record<
        string,
        Chunk
      >;
      const paths = new Set<string>(["index.html"]);
      for (const chunk of Object.values(manifest)) {
        for (const path of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
          paths.add(path);
        }
      }
      for (const el of document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
        'script[src], link[rel="stylesheet"]',
      )) {
        paths.add(new URL(el instanceof HTMLScriptElement ? el.src : el.href).pathname.slice(1));
      }
      return Promise.all(
        [...paths].sort().map(async (path) => {
          const response = await fetch(`/${path}`);
          const text = /\.(?:js|css|html)$/.test(path) ? await response.text() : "";
          return { path, status: response.status, text };
        }),
      );
    });
    const listed = files.map((file) => file.path);
    expect(listed.filter((path) => path.endsWith(".js")).length).toBeGreaterThanOrEqual(2);
    expect(listed.filter((path) => path.endsWith(".css")).length).toBeGreaterThanOrEqual(1);
    // Whatever the page loaded from the build is in that list, so the list is the whole build.
    const loaded = record.served.filter((path) => /\.(?:js|css|woff2)$/.test(path));
    expect(loaded.filter((path) => !listed.includes(path))).toEqual([]);
    for (const file of files) {
      expect(file.status, file.path).toBe(200);
      // A data: URL in a stylesheet or in a script's strings (a typed one, or url(data:…)); the
      // message names the file and the match, not the whole file.
      for (const pattern of [/url\(\s*["']?data:[^)]{0,40}/i, /\bdata:[a-z]+\/[a-z0-9.+-]+/i]) {
        expect(file.text.match(pattern)?.[0] ?? null, `data: URL in ${file.path}`).toBeNull();
      }
      for (const marker of ["modelContext", "registerTools", "ui-sdk.devtools", "__UI_SDK__"]) {
        expect(file.text.includes(marker), `${marker} in ${file.path}`).toBe(false);
      }
      if (file.path.endsWith(".css")) {
        expect(file.text.replace(/^(?:\s|\/\*[\s\S]*?\*\/)*/, "")).toMatch(/^@layer\s+ui-sdk\b/);
      }
    }
  });

  test("the fonts load from the page's own origin", async ({ page }) => {
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.evaluate(() =>
      [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family.replace(/"/g, "")),
    );
    expect(loaded).toContain("Inter Variable");
    const family = await page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain("Inter Variable");
  });
});

/** Every live region in the document, by its politeness (spec 06 §9: one polite, one assertive). */
const liveRegions = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[aria-live]:not([aria-live="off"]), [role="alert"], [role="status"], [role="log"], [role="marquee"], [role="timer"], output',
      ),
    ]
      .map((el) => {
        const live = el.getAttribute("aria-live");
        if (live !== null) return live;
        return el.getAttribute("role") === "alert" ? "assertive" : "polite";
      })
      .sort(),
  );

test.describe("the components @kit", () => {
  test("one polite and one assertive live region, however many error states and toasts show", async ({
    page,
  }) => {
    // The kit renders two ErrorStates, skeleton regions and an OTP input in an error status.
    await expect.poll(() => liveRegions(page)).toEqual(["assertive", "polite"]);
    const table = section(page, "table");
    await table.getByRole("button", { name: "Show error" }).click();
    await expect(table.getByText("Couldn’t load members")).toBeVisible();
    // The error state is spoken once, at once, through the SDK's assertive region.
    await expect(page.locator('[data-ui-sdk-announcer="assertive"]')).toHaveText(
      "Couldn’t load members. Check your connection and try again.",
    );
    await page.locator('[data-kit="toast-error"]').click();
    await page.locator('[data-kit="toast-success"]').click();
    await expect(
      page.getByRole("region", { name: "Notifications" }).getByText("Webhook created"),
    ).toBeVisible();
    expect(await liveRegions(page)).toEqual(["assertive", "polite"]);
  });

  test("tokens reach the page: the system's theme by default, an explicit theme over it", async ({
    page,
  }) => {
    const systemDark = await page.evaluate(
      () => matchMedia("(prefers-color-scheme: dark)").matches,
    );
    const initial = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(initial).toBe(systemDark ? "rgb(10, 10, 10)" : "rgb(255, 255, 255)");
    expect(await openKitColour(page, "?theme=dark")).toBe("rgb(10, 10, 10)");
    expect(await openKitColour(page, "?theme=light")).toBe("rgb(255, 255, 255)");
    const primary = await page
      .getByRole("button", { name: "New transfer" })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(primary).toBe("rgb(23, 23, 23)");
  });

  test("on a phone, nothing scrolls sideways and a modal keeps 16px from each edge @phone", async ({
    page,
  }) => {
    // AC-UI-28: no horizontal scroll at 320 and 390 CSS pixels wide.
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(() => {
        const edge = document.documentElement.clientWidth;
        // For the failure message: what reaches past the edge (a table's own scroller may).
        const wide = [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > edge)
          .map((el) => el.getAttribute("data-slot") ?? el.tagName.toLowerCase());
        return {
          scroll: document.documentElement.scrollWidth - edge,
          wide: [...new Set(wide)].slice(0, 8).join(", "),
        };
      });
      expect(overflow.scroll, `at ${width}px: ${overflow.wide}`).toBe(0);
      // The 8-box code input fits its column, its boxes shrunk alike and still 24px targets.
      const emailed = section(page, "otp").locator('[data-slot="fin-otp"]').nth(1);
      const fit = await emailed.evaluate((el) => {
        const group = el.querySelector('[data-slot="otp-input-group"]')?.getBoundingClientRect();
        const widths = [...el.querySelectorAll('[data-slot="otp-input-slot"]')].map((slot) =>
          Math.round(slot.getBoundingClientRect().width * 4),
        );
        return {
          inside: (group?.right ?? Number.POSITIVE_INFINITY) <= el.getBoundingClientRect().right,
          alike: new Set(widths).size === 1,
          target: Math.min(...widths) / 4 >= 24,
        };
      });
      expect(fit, `at ${width}px`).toEqual({ inside: true, alike: true, target: true });
      await page.getByRole("button", { name: "Create API key" }).click();
      const dialog = page.getByRole("dialog", { name: "Create API key" });
      await expect(dialog).toBeVisible();
      expect(await layoutWidth(dialog)).toBe(Math.min(480, width - 32));
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });

  test("buttons: pending keeps focus and announces busy; a throw is reported", async ({ page }) => {
    const pending = page.locator('[data-kit="pending-button"]');
    await pending.focus();
    await page.keyboard.press("Enter");
    await expect(pending).toHaveAttribute("aria-busy", "true");
    await expect(pending).toHaveAttribute("data-pending", "");
    await expect(pending).toBeFocused();
    await expect(pending).not.toHaveAttribute("data-pending", "", { timeout: 3000 });
    await page.locator('[data-kit="throwing-button"]').click();
    await expect(page.locator("body")).toHaveAttribute("data-reported", "");
    await expect(toasts(page).getByText("That didn’t work. Try again.")).toBeVisible();
  });

  test("a text button's failure is reported and said, as a button's is", async ({ page }) => {
    await page.locator('[data-kit="throwing-text-button"]').click();
    await expect(page.locator("body")).toHaveAttribute("data-reported", "");
    await expect(toasts(page).getByText("That didn’t work. Try again.")).toBeVisible();
  });

  test("a toast action's failure is reported and said", async ({ page }) => {
    await page.locator('[data-kit="toast-undo"]').click();
    const region = page.getByRole("region", { name: "Notifications" });
    await region.getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-reported", "");
    await expect(region.getByText("That didn’t work. Try again.")).toBeVisible();
  });

  test("disabled with a reason: focusable, described, with the reason as its tooltip", async ({
    page,
  }) => {
    const button = page.locator('[data-kit="reason-button"]');
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await tabTo(page, button);
    await expect(button).toHaveAccessibleDescription(
      "Production isn’t enabled for your account yet.",
    );
    await expect(
      page.getByRole("tooltip", { name: "Production isn’t enabled for your account yet." }),
    ).toBeVisible();
  });

  test("the 24px edge toggle: 24 by 24, named, its tooltip its name", async ({ page }) => {
    const toggle = page.locator('[data-kit="edge-toggle"]');
    const box = await toggle.boundingBox();
    expect(box?.width).toBe(24);
    expect(box?.height).toBe(24);
    await expect(toggle).toHaveAccessibleName("Collapse sidebar");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await tabTo(page, toggle);
    await expect(page.getByRole("tooltip", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("focus shows the one 2px ring, 2px outside", async ({ page }) => {
    const button = section(page, "buttons").getByRole("button", { name: "Continue" }).first();
    await keyboardFocus(page, button);
    const ring = await button.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.outlineWidth, offset: s.outlineOffset, style: s.outlineStyle };
    });
    expect(ring).toEqual({ width: "2px", offset: "2px", style: "solid" });
  });

  test("fields: the label names the control; the error is described before the helper", async ({
    page,
  }) => {
    const input = page.getByRole("textbox", { name: "Endpoint URL" });
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAccessibleDescription(
      "Enter an https:// URL. Fin posts events here.",
    );
    const height = (await page.getByRole("textbox", { name: "Work email" }).first().boundingBox())
      ?.height;
    expect(height).toBe(40);
  });

  test("dropdown menu: keyboard, its own chrome, radio rows, focus given back", async ({
    page,
  }) => {
    const trigger = page.locator('[data-kit="menu-trigger"]');
    await keyboardFocus(page, trigger);
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const chrome = await menu.evaluate((el) => {
      const s = getComputedStyle(el);
      return { padding: s.paddingTop, radius: s.borderTopLeftRadius, fill: s.backgroundColor };
    });
    expect(chrome.padding).toBe("4px");
    expect(chrome.radius).toBe("8px");
    expect(chrome.fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(await menu.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
    expect(await layoutWidth(menu)).toBe(288);
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator('[data-kit="theme-choice"]')).toHaveText("dark");
    await keyboardFocus(page, trigger);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("tabs: arrows move and select; TabLinks mark the current page", async ({ page }) => {
    const customer = customerTabs(page);
    const overview = customer.getByRole("tab", { name: "Overview" });
    const details = customer.getByRole("tab", { name: "Details" });
    const documents = customer.getByRole("tab", { name: "Documents" });
    await overview.click();
    await page.keyboard.press("ArrowRight");
    await expect(details).toHaveAttribute("aria-selected", "true");
    await expect(customer.getByRole("tabpanel")).toHaveText("The details.");
    // A disabled tab: the arrows reach it, but it is never chosen, by the keys or by a click.
    await page.keyboard.press("ArrowRight");
    await expect(documents).toBeFocused();
    await expect(documents).toHaveAttribute("aria-disabled", "true");
    await expect(documents).toHaveAttribute("aria-selected", "false");
    await expect(details).toHaveAttribute("aria-selected", "true");
    await expect(customer.getByRole("tabpanel")).toHaveText("The details.");
    await page.keyboard.press("End");
    await expect(customer.getByRole("tab", { name: /Money/ })).toBeFocused();
    await details.click();
    await documents.click({ force: true });
    await expect(details).toHaveAttribute("aria-selected", "true");
    await expect(customer.getByRole("tabpanel")).toHaveText("The details.");
    await expect(
      page
        .getByRole("navigation", { name: "Settings" })
        .getByRole("link", { name: "Organisation" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("tabs: the board's gaps, the chosen tab and the current link (AC-UI-07)", async ({
    page,
  }) => {
    const customer = customerTabs(page);
    const look = await customer.evaluate((root) => {
      const px = (n: number) => Math.round(n) + 0;
      const row = root.querySelector('[data-slot="tabs-row"]') as HTMLElement;
      const tabs = [...root.querySelectorAll('[role="tab"]')] as HTMLElement[];
      const panel = root.querySelector('[role="tabpanel"]') as HTMLElement;
      const label = (tab: HTMLElement) => {
        const range = document.createRange();
        range.selectNodeContents(tab.firstChild as Node);
        return range.getBoundingClientRect();
      };
      const [overview, details, documents] = tabs.map(label);
      const rowBox = row.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      return {
        // The first label on the content edge; labels 28px apart; the panel's first line 24px
        // under the 1px rule.
        edge: px((overview?.left ?? 0) - rowBox.left),
        apart: [
          px((details?.left ?? 0) - (overview?.right ?? 0)),
          px((documents?.left ?? 0) - (details?.right ?? 0)),
        ],
        under: px(
          panelBox.top + Number.parseFloat(getComputedStyle(panel).paddingTop) - rowBox.bottom,
        ),
        rule: getComputedStyle(row).borderBottomWidth,
        height: px(tabs[0]?.getBoundingClientRect().height ?? 0),
      };
    });
    expect(look).toEqual({ edge: 0, apart: [28, 28], under: 24, rule: "1px", height: 40 });

    // Read at rest, before any click (a tab's colour fades between states): Overview is chosen.
    const token = await textTokens(page);
    const details = customer.getByRole("tab", { name: "Details" });
    const states = await customer.evaluate((root) => {
      const paint = (el: Element | null) => {
        if (el === null) return null;
        const mark = getComputedStyle(el, "::after");
        return {
          colour: getComputedStyle(el).color,
          weight: getComputedStyle(el).fontWeight,
          mark: mark.backgroundColor,
          markBox: [mark.height, mark.left, mark.right, mark.bottom].join(" "),
        };
      };
      const count = root.querySelector('[data-slot="tab-count"]');
      return {
        chosen: paint(root.querySelector('[role="tab"][aria-selected="true"]')),
        other: paint(
          root.querySelector('[role="tab"][aria-selected="false"]:not([aria-disabled])'),
        ),
        disabled: paint(root.querySelector('[role="tab"][aria-disabled="true"]')),
        count:
          count === null
            ? null
            : { colour: getComputedStyle(count).color, weight: getComputedStyle(count).fontWeight },
      };
    });
    const none = "rgba(0, 0, 0, 0)";
    expect(states.chosen).toEqual({
      colour: token.primary,
      weight: "500",
      mark: token.primary,
      markBox: "2px 8px 8px 0px",
    });
    expect(states.other).toMatchObject({ colour: token.secondary, weight: "500", mark: none });
    expect(states.disabled).toMatchObject({ colour: token.disabled, mark: none });
    expect(states.count).toEqual({ colour: token.tertiary, weight: "400" });

    // Focus draws the one ring inside the tab, so the row's edge never clips it.
    await keyboardFocus(page, details);
    const ring = await details.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.outlineWidth, offset: s.outlineOffset, style: s.outlineStyle };
    });
    expect(ring).toEqual({ width: "2px", offset: "-2px", style: "solid" });

    const settings = page.getByRole("navigation", { name: "Settings" });
    const linkPaint = (name: string) =>
      settings.getByRole("link", { name }).evaluate((el) => ({
        colour: getComputedStyle(el).color,
        mark: getComputedStyle(el, "::after").backgroundColor,
      }));
    expect(await linkPaint("Organisation")).toEqual({ colour: token.primary, mark: token.primary });
    expect(await linkPaint("Team")).toEqual({ colour: token.secondary, mark: none });
  });

  test("tabs in a drawer: labels 24px in; a row too wide scrolls in itself, not the page", async ({
    page,
  }) => {
    const drawer = page.locator('[data-kit="tabs-drawer"]');
    const fit = await drawer.evaluate((box) => {
      const row = box.querySelector('[data-slot="tabs-row"]') as HTMLElement;
      const list = box.querySelector('[role="tablist"]') as HTMLElement;
      const panel = box.querySelector('[role="tabpanel"]') as HTMLElement;
      const px = (n: number) => Math.round(n) + 0;
      const range = document.createRange();
      range.selectNodeContents(list.querySelector('[role="tab"]')?.firstChild as Node);
      const rowBox = row.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const ps = getComputedStyle(panel);
      return {
        inset: px(range.getBoundingClientRect().left - rowBox.left),
        panel: [
          px(panelBox.left + Number.parseFloat(ps.paddingLeft) - rowBox.left),
          px(panelBox.top + Number.parseFloat(ps.paddingTop) - rowBox.bottom),
        ],
        scrolls: getComputedStyle(list).overflowX === "auto" && list.scrollWidth > list.clientWidth,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(fit).toEqual({ inset: 24, panel: [24, 20], scrolls: true, page: 0 });
  });

  test("tabs in a drawer: the panel's focus ring is drawn inside, so the drawer never cuts it", async ({
    page,
  }) => {
    const drawer = page.locator('[data-kit="tabs-drawer"]');
    const panel = drawer.getByRole("tabpanel");
    // The panel holds nothing focusable, so Tab from the chosen tab lands on the panel itself.
    await keyboardFocus(page, drawer.getByRole("tab", { name: "Overview and tasks" }));
    await page.keyboard.press("Tab");
    await expect(panel).toBeFocused();
    const ring = await panel.evaluate((el) => {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const clip = (el.closest('[data-kit="tabs-drawer"]') as HTMLElement).getBoundingClientRect();
      return {
        visible: el.matches(":focus-visible"),
        width: s.outlineWidth,
        offset: s.outlineOffset,
        style: s.outlineStyle,
        // The panel reaches the drawer's edges: an outside ring would fall in the clipped area.
        edges: [box.left - clip.left, clip.right - box.right].map((n) => Math.round(n) + 0),
      };
    });
    expect(ring).toEqual({
      visible: true,
      width: "2px",
      offset: "-2px",
      style: "solid",
      edges: [0, 0],
    });
  });

  test("tabs: a choice the page holds moves the selection from outside the tabs", async ({
    page,
  }) => {
    const customer = customerTabs(page);
    const money = customer.getByRole("tab", { name: /Money/ });
    await expect(customer.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await section(page, "tabs").getByRole("button", { name: "Open the Money tab" }).click();
    await expect(money).toHaveAttribute("aria-selected", "true");
    await expect(customer.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(customer.getByRole("tabpanel")).toHaveText("The money.");
    // A change from outside does not pull focus into the tabs (AC-UI-27: a tab change never moves it).
    await expect(money).not.toBeFocused();
  });

  test("toasts: three at most, the oldest non-error evicted, errors stay; F8 reaches them", async ({
    page,
  }) => {
    const region = page.getByRole("region", { name: "Notifications" });
    await page.locator('[data-kit="toast-error"]').click();
    await page.locator('[data-kit="toast-success"]').click();
    await page.locator('[data-kit="toast-info"]').click();
    await expect(region.locator('[data-slot="toast"]')).toHaveCount(3);
    await page.locator('[data-kit="toast-success"]').click();
    await expect(region.locator('[data-slot="toast"]:not([data-ending-style])')).toHaveCount(3);
    await expect(region.getByText("Couldn’t create webhook")).toBeVisible();
    await expect(region.getByText("Fin was updated")).toBeVisible();
    const width = (await region.locator('[data-slot="toast"]').first().boundingBox())?.width ?? 0;
    expect(width).toBeLessThanOrEqual(480);
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const box = (await region.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(viewport.height - (box.y + box.height) - 24)).toBeLessThanOrEqual(1);
    await page.keyboard.press("F8");
    await expect(region.locator('[data-slot="toast"]').first()).toBeFocused();
  });

  test("modal: 480 wide with 24 padding, focus on the title, Escape closes, focus returns", async ({
    page,
  }) => {
    const opener = page.getByRole("button", { name: "Create API key" });
    await keyboardFocus(page, opener);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await expect(dialog).toBeVisible();
    // 480 wide, and 16px from each edge on a phone.
    const viewport = page.viewportSize()?.width ?? 0;
    expect(await layoutWidth(dialog)).toBe(Math.min(480, viewport - 32));
    expect(await dialog.evaluate((el) => getComputedStyle(el).paddingTop)).toBe("24px");
    expect(await dialog.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
    await expect(page.getByRole("heading", { name: "Create API key" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("modal: the page behind does not scroll, by wheel or by keys, until it closes", async ({
    page,
  }) => {
    const opener = page.getByRole("button", { name: "Create API key" });
    await opener.scrollIntoViewIfNeeded();
    const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await expect(dialog).toBeVisible();
    const before = await scrollY();
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    await page.mouse.move(viewport.width / 2, viewport.height - 8);
    await page.mouse.wheel(0, 600);
    await page.mouse.wheel(0, -300);
    for (const key of ["PageDown", "End", "ArrowDown", "Space"]) await page.keyboard.press(key);
    // Give a scroll that was not stopped the time to happen.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(await scrollY()).toBe(before);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.mouse.wheel(0, 600);
    await expect.poll(scrollY).toBeGreaterThan(before);
  });

  test("sizes: avatars, their flag and a growing textarea compute their sizes under the policy", async ({
    page,
  }) => {
    const avatars = section(page, "brand").locator('[data-slot="avatar"]');
    const sizes = await avatars.evaluateAll((els) =>
      els.map((el) => {
        const face = el.firstElementChild as HTMLElement;
        return [face.offsetWidth, face.offsetHeight];
      }),
    );
    expect(sizes).toEqual([
      [40, 40],
      [32, 32],
      [24, 24],
      [20, 20],
    ]);
    const flag = await avatars
      .first()
      .locator("svg")
      .evaluate((el) => {
        const box = el.getBoundingClientRect();
        return [box.width, box.height];
      });
    expect(flag).toEqual([16, 16]);
    // A remark grows from 3 rows (80px) to 10 (220px), then scrolls inside itself.
    const remark = page.getByRole("textbox", { name: /^Description/ });
    const height = () => remark.evaluate((el) => (el as HTMLElement).offsetHeight);
    expect(await height()).toBe(80);
    await remark.fill(["one", "two", "three", "four", "five", "six"].join("\n"));
    await expect.poll(height).toBeGreaterThan(80);
    expect(await height()).toBeLessThan(220);
    await remark.fill(Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n"));
    await expect.poll(height).toBe(220);
    expect(await remark.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });

  test("confirm dialog: no X; while busy it says so and nothing dismisses it; then it closes", async ({
    page,
  }) => {
    await onTestClock(page);
    await page.getByRole("button", { name: "Delete webhook" }).first().click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this webhook?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    await expect(cancel).toBeFocused();
    const confirm = dialog.getByRole("button", { name: "Delete webhook" });
    await confirm.click();
    // Busy: the dialog and its confirm say so, Cancel is unavailable, and Escape does nothing.
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(confirm).toHaveAttribute("aria-busy", "true");
    await expect(confirm.locator('[data-slot="spinner"]')).toHaveCount(1);
    await expect(cancel).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(page.locator('[data-kit="deleted"]')).toHaveText("Deleted 0");
    await page.clock.runFor(300);
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-kit="deleted"]')).toHaveText("Deleted 1");
  });

  test("secret reveal: a new secret needs its own “I’ve saved it” before Done", async ({
    page,
  }) => {
    const copy = section(page, "copy");
    const saved = copy.getByRole("checkbox", { name: "I’ve saved the secret somewhere safe" });
    const done = copy.getByRole("button", { name: "Done" }).first();
    await expect(done).toHaveAttribute("aria-disabled", "true");
    await copy.getByText("I’ve saved the secret somewhere safe").click();
    await expect(saved).toHaveAttribute("aria-checked", "true");
    await expect(done).not.toHaveAttribute("aria-disabled", "true");
    await copy.locator('[data-kit="another-key"]').click();
    await expect(saved).toHaveAttribute("aria-checked", "false");
    await expect(done).toHaveAttribute("aria-disabled", "true");
  });

  test("confirm dialog: a typed confirmation starts empty each time it opens", async ({ page }) => {
    const opener = page.getByRole("button", { name: "Delete Production webhook" });
    const dialog = page.getByRole("alertdialog", { name: "Delete this Production webhook?" });
    const field = dialog.getByRole("textbox", { name: "Type acme-hooks to confirm" });
    const confirm = dialog.getByRole("button", { name: "Delete webhook" });
    await opener.click();
    await expect(dialog).toBeVisible();
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await field.fill("acme-hooks");
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    await confirm.click();
    // The page closes the dialog after its request, not the dialog's own Cancel or Escape.
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-kit="deleted-typed"]')).toHaveText("acme-hooks");
    await opener.click();
    await expect(dialog).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    // And after Escape, too.
    await field.fill("acme-hooks");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await opener.click();
    await expect(field).toHaveValue("");
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
  });

  test("OTP input: a pasted code fills every box and is handed on once", async ({ page }) => {
    const input = page.getByRole("textbox", { name: "Verification code" });
    await expect(input).toHaveAttribute("autocomplete", "one-time-code");
    await input.focus();
    // A paste event carrying the code as a clipboard delivers it, spaces and all, so the SDK's
    // paste path (which strips separators) is what fills the boxes: a script's paste inserts
    // nothing by itself. Firefox builds the event's clipboardData from its own dataType and data
    // fields and ignores a DataTransfer passed in, so the event carries both.
    const handled = await input.evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "654 321");
      const init = {
        clipboardData: data,
        dataType: "text/plain",
        data: "654 321",
        bubbles: true,
        cancelable: true,
      };
      const event = new ClipboardEvent("paste", init);
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(handled).toBe(true);
    await expect(
      section(page, "otp")
        .locator('[data-slot="fin-otp"]')
        .first()
        .locator('[data-slot="otp-input-slot"]'),
    ).toHaveText(["6", "5", "4", "3", "2", "1"]);
    await expect(page.locator('[data-kit="otp-handed"]')).toHaveText("654321");
    await expect(section(page, "otp").getByText(/That code isn’t right/)).toBeVisible();
    const selected = await input.evaluate((el) => {
      const i = el as HTMLInputElement;
      return [i.selectionStart, i.selectionEnd];
    });
    expect(selected).toEqual([0, 6]);
    await page.keyboard.type("123456");
    await expect(page.locator('[data-kit="otp-handed"]')).toHaveText("654321,123456");
    await expect(section(page, "otp").getByText("Code accepted.")).toBeVisible();
  });

  test("OTP input: 44px boxes from 640px wide, 36px below", async ({ page }) => {
    const width = page.viewportSize()?.width ?? 0;
    const boxes = section(page, "otp")
      .locator('[data-slot="fin-otp"]')
      .first()
      .locator('[data-slot="otp-input-slot"]');
    await expect(boxes).toHaveCount(6);
    for (const box of await boxes.all()) {
      expect(await layoutWidth(box)).toBe(width >= 640 ? 44 : 36);
      expect(await box.evaluate((el) => (el as HTMLElement).offsetHeight)).toBe(44);
    }
  });

  test("OTP input: one that mounts expired takes no focus and scrolls nothing", async ({
    page,
  }) => {
    await expect(page.getByRole("textbox", { name: "Emailed code" })).toHaveCount(1);
    const state = await page.evaluate(() => ({
      active: document.activeElement?.tagName,
      scrollY: Math.round(window.scrollY),
    }));
    expect(state).toEqual({ active: "BODY", scrollY: 0 });
  });

  test("OTP input: a code that expires while the person is elsewhere leaves focus there", async ({
    page,
  }) => {
    const expire = page.locator('[data-kit="otp-expire"]');
    await keyboardFocus(page, expire);
    await page.keyboard.press("Enter");
    await expect(section(page, "otp").getByText("This code expired. Send a new code.")).toHaveCount(
      2,
    );
    await expect(expire).toBeFocused();
  });

  test("OTP resend: focus stays on it while it sends and counts down; start and end are said", async ({
    page,
  }) => {
    await onTestClock(page);
    const otp = section(page, "otp").locator('[data-slot="fin-otp"]').first();
    const line = otp.locator('[data-slot="fin-otp-resend"]');
    const resend = otp.getByRole("button", { name: "Send a new code" });
    await keyboardFocus(page, resend);
    await page.keyboard.press("Enter");
    // What assistive technology is given for the focused element: its role, name and state.
    const focused = async () => ({
      tag: await page.evaluate(() => document.activeElement?.tagName),
      aria: await page.locator(":focus").ariaSnapshot(),
    });
    const waitingName = { tag: "BUTTON", aria: '- button "Send a new code" [disabled]' };
    await expect.poll(focused).toEqual({ tag: "BUTTON", aria: '- button "Sending" [disabled]' });
    await page.clock.runFor(400);
    await expect.poll(focused).toEqual(waitingName);
    await expect(line).toHaveText("Send a new code in 0:30");
    await page.clock.runFor(200);
    await expect(page.locator('[data-ui-sdk-announcer=""]')).toHaveText(
      "Code sent. You can send a new code in 30 seconds.",
    );
    // Each tick moves the clock the eye sees and never the focused control's name, so the
    // countdown is said at its start and its end only (spec 06 §9), not every second.
    for (let second = 29; second > 0; second -= 1) {
      await page.clock.runFor(1000);
      await expect(line).toHaveText(`Send a new code in 0:${String(second).padStart(2, "0")}`);
      expect(await focused()).toEqual(waitingName);
    }
    await page.clock.runFor(1000);
    await expect.poll(focused).toEqual({ tag: "BUTTON", aria: '- button "Send a new code"' });
    await expect(line).toHaveText("Didn’t get it? Send a new code");
    await page.clock.runFor(200);
    await expect(page.locator('[data-ui-sdk-announcer=""]')).toHaveText(
      "You can send a new code now.",
    );
  });

  test("OTP resend: one that mounts mid-cooldown says the wait, and its time can be read", async ({
    page,
  }) => {
    await onTestClock(page);
    await page.locator('[data-kit="otp-mount"]').click();
    const sent = section(page, "otp").locator('[data-slot="fin-otp"]').nth(2);
    await expect(sent.getByRole("textbox", { name: "Sign-in code" })).toHaveCount(1);
    const line = sent.locator('[data-slot="fin-otp-resend"]');
    const resend = sent.getByRole("button", { name: "Send a new code" });
    await expect(line).toHaveText("Send a new code in 0:45");
    // The start is said as it mounts (spec 06 §9), with no resend first.
    await page.clock.runFor(200);
    await expect(page.locator('[data-ui-sdk-announcer=""]')).toHaveText(
      "You can send a new code in 45 seconds.",
    );
    // The time is in the accessibility tree beside the control, never in its name, so it can be
    // read but is not spoken each second.
    await keyboardFocus(page, resend);
    const waitingName = '- button "Send a new code" [disabled]';
    for (let second = 44; second > 40; second -= 1) {
      await page.clock.runFor(1000);
      const time = `0:${String(second).padStart(2, "0")}`;
      await expect(line).toHaveText(`Send a new code in ${time}`);
      expect(await line.ariaSnapshot()).toContain(`in ${time}`);
      expect(await page.locator(":focus").ariaSnapshot()).toBe(waitingName);
    }
  });

  test("OTP resend: a refused resend is reported and said, and focus stays", async ({ page }) => {
    const otp = section(page, "otp").locator('[data-slot="fin-otp"]').nth(1);
    const resend = otp.getByRole("button", { name: "Send a new code" });
    await keyboardFocus(page, resend);
    await page.keyboard.press("Enter");
    await expect(toasts(page).getByText("That didn’t work. Try again.")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-reported", "");
    await expect(resend).toBeFocused();
    await expect(resend).not.toHaveAttribute("aria-disabled", "true");
  });

  test("checkbox and switch: native labels, indeterminate, keyboard", async ({ page }) => {
    const all = page.getByRole("checkbox", { name: "Select all" });
    await expect(all).toHaveAttribute("aria-checked", "mixed");
    await page.getByText("Select all").click();
    await expect(all).toHaveAttribute("aria-checked", "true");
    const toggle = page.getByRole("switch", { name: "Email me when a payout fails" });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("copy field: the copy button names its value; the secret is masked until shown", async ({
    page,
  }) => {
    await expect(
      section(page, "copy").getByRole("button", { name: "Copy transaction ID" }),
    ).toBeVisible();
    const show = page.getByRole("button", { name: "Show signing secret" });
    await expect(section(page, "copy").getByText(SIGNING_SECRET)).toHaveCount(0);
    await show.click();
    await expect(section(page, "copy").getByText(SIGNING_SECRET)).toBeVisible();
  });

  test("table: one row in the Tab order, arrows, Home, End, Enter; aria-sort", async ({
    page,
    browserName,
  }) => {
    const table = section(page, "table").getByRole("table", { name: "Team members" });
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(4);
    // Every Tab stop in the body: the one row in the Tab order, and only that row's own controls.
    const stops = () =>
      table.locator("tbody").evaluate((body) => {
        const all = [...body.querySelectorAll<HTMLElement>("*")].filter(
          (el) =>
            el.tabIndex >= 0 &&
            !el.matches(":disabled") &&
            el.checkVisibility({ visibilityProperty: true }),
        );
        const rowsOf = new Set(all.map((el) => el.closest("tr")?.getAttribute("data-row-id")));
        const rowStops = all.filter((el) => el.matches("tr"));
        return {
          rows: [...rowsOf],
          rowStops: rowStops.map((el) => el.getAttribute("data-row-id")),
          controls: all.length - rowStops.length,
        };
      });
    const idColumn = (page.viewportSize()?.width ?? 0) >= 1280;
    // The ID cell holds the full ID's trigger and its copy button; below 1280px it is hidden.
    const ownControls = idColumn ? 2 : 0;
    expect(await stops()).toEqual({
      rows: ["mem_02"],
      rowStops: ["mem_02"],
      controls: ownControls,
    });
    await rows.first().focus();
    // Tab from the current row reaches its own controls, then leaves the table.
    if (idColumn && browserName !== "webkit") {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() =>
          document.activeElement?.closest("tr")?.getAttribute("data-row-id"),
        ),
      ).toBe("mem_02");
      await rows.first().focus();
    }
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    expect(await stops()).toEqual({
      rows: ["mem_04"],
      rowStops: ["mem_04"],
      controls: ownControls,
    });
    // A control another row mounts later, without the table drawing again (a cell's own state),
    // and a tabindex put back on a control taken out: both leave the Tab order at once. The probe
    // stands in for them from outside React, then goes.
    const outOfOrder = await table.locator("tbody").evaluate(async (body) => {
      const other = body.querySelector<HTMLElement>('tr[data-row-id="mem_01"]');
      const cell = other?.querySelector("td");
      if (other === null || cell === null || cell === undefined) return "no row";
      const probe = document.createElement("button");
      probe.type = "button";
      probe.textContent = "probe";
      cell.append(probe);
      const before = other.querySelector<HTMLElement>("[data-row-tabindex]");
      before?.setAttribute("tabindex", "0");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const result = [probe.tabIndex, before === null ? -1 : before.tabIndex];
      probe.remove();
      return result;
    });
    expect(outOfOrder).toEqual([-1, -1]);
    await page.keyboard.press("End");
    await expect(rows.nth(3)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-kit="table-opened"]')).toHaveText("Opened mem_02");
    await expect(table.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await table.getByRole("button", { name: "Name" }).click();
    await expect(table.getByRole("columnheader", { name: "Name" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    const height = (await rows.first().boundingBox())?.height ?? 0;
    expect(Math.abs(height - 44)).toBeLessThanOrEqual(1);
  });

  test("table states: skeleton rows while loading, the error with its request ID, the zero state", async ({
    page,
  }) => {
    const table = section(page, "table");
    await table.getByRole("button", { name: "Show loading" }).click();
    await expect(table.locator("[data-skeleton]").first()).toBeVisible();
    await expect(table.getByRole("table")).toHaveAttribute("aria-busy", "true");
    await table.getByRole("button", { name: "Show error" }).click();
    await expect(table.getByText("Couldn’t load members")).toBeVisible();
    await expect(table.getByText("req_7d1c9a")).toBeVisible();
    await table.getByRole("button", { name: "Show empty" }).click();
    await expect(table.getByText("You’re the only member")).toBeVisible();
  });
});

test.describe("motion @motion", () => {
  test("skeletons shimmer unless reduced motion is asked for; spinners always turn", async ({
    page,
  }) => {
    const reduced = await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    const shape = page.locator("[data-skeleton]").first();
    const shimmer = await shape.evaluate((el) => getComputedStyle(el).animationName);
    expect(shimmer).toBe(reduced ? "none" : "fin-sweep");
    const spinner = await page
      .locator('section[data-kit="buttons"] [data-slot="spinner"]')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(spinner).toBe("fin-spinner-turn");
    const enter = await page.locator('[data-slot="auth-card"]').evaluate((el) => {
      const s = getComputedStyle(el);
      return { name: s.animationName, duration: s.animationDuration };
    });
    expect(enter.name).toBe(reduced ? "fin-fade-in" : "fin-rise-in");
    expect(enter.duration).toBe(reduced ? "0.14s" : "0.2s");
  });
});

async function openKitColour(page: Page, query: string): Promise<string> {
  await page.goto(`/${query}`);
  await page.locator("body[data-ready]").waitFor();
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}
