// Serves the built harness (dist/harness) to a page from its own origin with the production page
// policy, and answers /env.json and /api/* from the test, through Playwright's routing: no server
// process and no node:* module. It records policy violations, console lines, page errors and every
// request to another origin, so each test can assert what the page did.
import type { ConsoleMessage, Page, Route } from "@playwright/test";

export const ORIGIN = "http://frame.fin.test";

/** The policy every console, Fin Admin and verify document gets (spec 06 §6.1). */
const PAGE_POLICY = [
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
};

const DIST = decodeURIComponent(new URL("../dist/harness/", import.meta.url).pathname);

/** One API answer: status and JSON body, or a held answer the test releases. */
export type Answer =
  | { status: number; body: unknown }
  | { hold: Promise<{ status: number; body: unknown }> };

export type PageRecord = {
  violations: string[];
  console: string[];
  pageErrors: string[];
  offsite: string[];
};

declare global {
  interface Window {
    __violations?: string[];
  }
}

const json = (status: number, body: unknown) => ({
  status,
  headers: {
    "content-type": status >= 400 ? "application/problem+json" : "application/json",
    "cache-control": "no-store",
  },
  body: JSON.stringify(body),
});

export function problem(status: number, code: string) {
  return { status, body: { type: "about:blank", title: code, status, code } };
}

export const ENV = {
  environment: "ci",
  release: "harness",
  docsOrigin: "https://docs.example.com",
  consoleOrigin: "https://console.example.com",
};

/** A signed-in console viewer with one organisation in Sandbox. */
export const VIEWER = {
  gate: "ok",
  user: { id: "usr_1", name: "Maya Rivera", email: "maya@example.com" },
  assurance: "aal2",
  factors: { passkeys: 1, authenticator: false, backupCodesLeft: null },
  canSkipProtect: false,
  canTrustBrowser: true,
  memberships: [
    {
      orgId: "org_1",
      name: "Acme Remit",
      roleKey: "super_admin",
      roleLabel: "Super admin",
      roleKnown: true,
      liveStatus: "sandbox",
    },
  ],
  currentOrgId: "org_1",
  permissions: [],
  invitations: [],
};

/**
 * Opens the harness at `path`. `api` answers each /api path (without the /api prefix); a path it
 * does not name answers 404.
 */
export async function openHarness(
  page: Page,
  path: string,
  api: Record<string, () => Answer>,
): Promise<PageRecord> {
  const record: PageRecord = { violations: [], console: [], pageErrors: [], offsite: [] };
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
    }
    record.console.push(`${message.type()}: ${text}`);
  });
  page.on("pageerror", (error) => record.pageErrors.push(error.message));
  await page.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      record.offsite.push(url.origin);
      await route.abort();
      return;
    }
    if (url.pathname === "/env.json") {
      await route.fulfill(json(200, ENV));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const answer = api[url.pathname.slice(4)]?.() ?? problem(404, "not_found");
      const settled = "hold" in answer ? await answer.hold : answer;
      await route.fulfill(json(settled.status, settled.body));
      return;
    }
    // A path with no file extension is the single-page app's document.
    const last = url.pathname.split("/").pop() ?? "";
    const file = last.includes(".") ? url.pathname.slice(1) : "index.html";
    if (file.includes("..")) {
      await route.fulfill({ status: 400 });
      return;
    }
    const ext = file.split(".").pop() ?? "";
    const headers: Record<string, string> = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    };
    if (ext === "html") headers["content-security-policy"] = PAGE_POLICY;
    try {
      await route.fulfill({ path: DIST + file, headers });
    } catch {
      await route.fulfill({ status: 404, headers: { "content-type": "text/plain" }, body: "" });
    }
  });
  await page.goto(path);
  await page.locator("body[data-ready]").waitFor();
  return record;
}

/** The violations the page itself saw, plus the console's. */
export async function violations(page: Page, record: PageRecord): Promise<string[]> {
  const seen = await page.evaluate(() => window.__violations ?? []);
  return [...seen, ...record.violations];
}

/** An answer the test holds until it calls `release`. */
export function held(status: number, body: unknown) {
  let release: () => void = () => {};
  const hold = new Promise<{ status: number; body: unknown }>((resolve) => {
    release = () => resolve({ status, body });
  });
  return { answer: () => ({ hold }), release: () => release() };
}
