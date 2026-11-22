// Serves the built kit to a page from its own origin with the production page policy, through
// Playwright's routing (no server process and no node:* module in a client package). It records
// every policy violation and policy console message from an init script, and every request to
// another origin, so each test can assert there were none (AC-P0-16, AC-UI-30).
import type { ConsoleMessage, Page } from "@playwright/test";

export const ORIGIN = "http://kit.fin.test";

/** The policy every console, Fin Admin and verify document gets (spec 06 §6.1). */
export const PAGE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  json: "application/json",
};

const DIST = decodeURIComponent(new URL("../dist/kit/", import.meta.url).pathname);

export type PageRecord = { violations: string[]; consoleErrors: string[]; offsite: string[] };

declare global {
  interface Window {
    __violations?: string[];
  }
}

/** Opens the kit under the policy and returns what the page did that it must not. */
export async function openKit(page: Page, query = ""): Promise<PageRecord> {
  const record: PageRecord = { violations: [], consoleErrors: [], offsite: [] };
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__violations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on("console", (message: ConsoleMessage) => {
    const text = message.text();
    if (/content security policy|content-security-policy|refused to/i.test(text)) {
      record.violations.push(`console: ${text}`);
    } else if (message.type() === "error") {
      record.consoleErrors.push(text);
    }
  });
  page.on("pageerror", (error) => record.consoleErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      record.offsite.push(url.origin);
      await route.abort();
      return;
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (path.includes("..")) {
      await route.fulfill({ status: 400 });
      return;
    }
    const ext = path.split(".").pop() ?? "";
    const headers: Record<string, string> = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    };
    if (ext === "html") headers["content-security-policy"] = PAGE_POLICY;
    try {
      await route.fulfill({ path: DIST + path, headers });
    } catch {
      await route.fulfill({
        status: 404,
        headers: { "content-type": "text/plain" },
        body: "not found",
      });
    }
  });
  await page.goto(`/${query}`);
  await page.locator("body[data-ready]").waitFor();
  return record;
}

/** The violations the page itself saw, plus the console's. */
export async function violations(page: Page, record: PageRecord): Promise<string[]> {
  const seen = await page.evaluate(() => window.__violations ?? []);
  return [...seen, ...record.violations];
}
