// A minimal stand-in for the static host, for the shell specs of the three web apps until
// @fin/testing's static host (L-SAT-08) is on main: every request of the browser context is answered
// from the app's built dist/static/ with the production page policy of its `_headers` profile
// (spec 01 §7.4), the single-page fallback, a rendered /env.json, and an /api/ stub that answers
// /api/health as the API half does. No socket is opened: Playwright's routing serves the files, so
// the documents load under exactly these headers (no test sets bypassCSP).
//
// When the harness lands, the specs move to its fixtures and its host, and this file goes.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { BrowserContext, Page, Route } from "@playwright/test";

/** The page policy every console, Fin Admin and verify document gets (spec 06 §6.1). */
export const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; report-to csp";

/** Verify's `hosted` profile adds `blob:` to img-src for the photo preview (SD3-04). */
const HOSTED_POLICY = PAGE_POLICY.replace("img-src 'self'", "img-src 'self' blob:");

const APP_PERMISSIONS =
  "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)";
const HOSTED_PERMISSIONS =
  "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), publickey-credentials-get=(), publickey-credentials-create=()";

/** `selfie` is `hosted` until SP-11 lists Sumsub's hosts (spec 01 §7.4). */
export type Profile = "app" | "hosted" | "selfie";

/** The headers of spec 01 §7.4's profile for every path (`/*`). */
export function profileHeaders(profile: Profile): Record<string, string> {
  return {
    "cache-control": "no-cache",
    "content-security-policy": profile === "app" ? PAGE_POLICY : HOSTED_POLICY,
    "reporting-endpoints": 'csp="/api/monitoring/csp"',
    "x-content-type-options": "nosniff",
    "referrer-policy": profile === "app" ? "same-origin" : "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": profile === "app" ? APP_PERMISSIONS : HOSTED_PERMISSIONS,
    "x-robots-tag": "noindex, nofollow",
  };
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export const RELEASE = "e2e-release";

export interface StaticOptions {
  /** The app's static output: apps/<app>/dist/static (verify: dist/static/{verify,selfie}). */
  dir: string;
  profile: Profile;
  origin: string;
  /** Extra API answers by path, before the defaults (`/api/health`, everything else 404). */
  api?: Record<string, (route: Route) => Promise<void>>;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return {
    status,
    headers: {
      "content-type": status >= 400 ? "application/problem+json" : "application/json",
      "cache-control": "no-store",
      "fin-release": RELEASE,
      ...extra,
    },
    body: JSON.stringify(body),
  };
}

export function problem(status: number, code: string) {
  return json(status, {
    type: `https://docs.example.com/errors/${code}`,
    title: code,
    status,
    code,
    request_id: "req_e2e",
  });
}

/** Answers every request of the context as the static deployment and its tunnel would. */
export async function serveStatic(context: BrowserContext, options: StaticOptions): Promise<void> {
  const root = resolve(options.dir);
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(`no build at ${options.dir}: run the app's build first`);
  }
  const headers = profileHeaders(options.profile);
  const env = {
    environment: "ci",
    release: RELEASE,
    docsOrigin: "https://docs.example.com",
    consoleOrigin: options.origin,
  };

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== options.origin) {
      await route.abort("blockedbyclient");
      return;
    }
    const path = decodeURIComponent(url.pathname);
    if (path === "/api" || path.startsWith("/api/")) {
      const handler = options.api?.[path];
      if (handler !== undefined) return handler(route);
      if (path === "/api/health") return route.fulfill(json(200, { status: "ok" }));
      if (path === "/api/monitoring/csp")
        return route.fulfill({ status: 204, headers: { "cache-control": "no-store" } });
      return route.fulfill(problem(404, "not_found"));
    }
    if (path === "/env.json") {
      return route.fulfill({
        status: 200,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(env),
      });
    }
    const file = normalize(join(root, path));
    const inside = file === root || file.startsWith(`${root}${sep}`);
    const found = inside && existsSync(file) && statSync(file).isFile();
    const served = found ? file : join(root, "index.html");
    const cache =
      path.startsWith("/assets/") && found ? "public, max-age=31536000, immutable" : "no-cache";
    return route.fulfill({
      status: 200,
      headers: {
        ...headers,
        "cache-control": cache,
        "content-type": TYPES[extname(served)] ?? "application/octet-stream",
      },
      body: readFileSync(served),
    });
  });
}

/** Records every `securitypolicyviolation` in every frame, and the engines' console warnings. */
export async function watchPolicy(context: BrowserContext): Promise<string[]> {
  const seen: string[] = [];
  await context.exposeBinding("__finPolicy", (_source, text: string) => {
    seen.push(text);
  });
  await context.addInitScript({
    content: `document.addEventListener("securitypolicyviolation", (e) => {
      globalThis.__finPolicy(String(e.effectiveDirective || e.violatedDirective) + " " + String(e.blockedURI));
    }, true);`,
  });
  context.on("console", (message) => {
    const text = message.text();
    if (/content[- ]security[- ]policy|Refused to (load|execute|apply|connect)/i.test(text))
      seen.push(text);
  });
  return seen;
}

export interface HeldEntry {
  /** Resolves once the browser has asked for the entry module. */
  requested: Promise<void>;
  /** Lets the entry module load. */
  release(): void;
}

/**
 * Holds the build's entry module (the one `<script type="module">` in index.html) until released,
 * so a test can read the page as the boot skeleton draws it, before main.tsx runs (AC-UI-08).
 */
export async function holdEntry(page: Page, dir: string): Promise<HeldEntry> {
  const html = readFileSync(join(resolve(dir), "index.html"), "utf8");
  const src = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
  if (src === undefined) throw new Error(`no module script in ${dir}/index.html`);
  let requested!: () => void;
  let release!: () => void;
  const asked = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === src,
    async (route) => {
      requested();
      await released;
      await route.fallback();
    },
  );
  return { requested: asked, release };
}

/**
 * The page as the boot skeleton draws it: waits for the stylesheet, then reads the attributes
 * theme.js set, the body's background and the boot sidebar's width, and whether the entry has run.
 */
export async function bootState(page: Page) {
  await page.locator("[data-boot-block]").first().waitFor({ state: "attached" });
  await page.waitForFunction(() =>
    [...document.styleSheets].some((sheet) => sheet.href?.includes("/assets/") === true),
  );
  return page.evaluate(() => {
    const root = document.documentElement;
    const sidebar = document.querySelector("[data-boot-sidebar]");
    return {
      theme: root.getAttribute("data-theme"),
      choice: root.getAttribute("data-theme-choice"),
      boot: root.getAttribute("data-boot"),
      sidebar: root.getAttribute("data-sidebar"),
      background: getComputedStyle(document.body).backgroundColor,
      bootSidebarWidth: sidebar === null ? null : getComputedStyle(sidebar).width,
      ready: document.body.hasAttribute("data-ready"),
    };
  });
}

/** Waits for the root to mark the first route resolved (FW-C16). */
export async function ready(page: Page): Promise<void> {
  await page.locator("body[data-ready]").waitFor({ state: "attached" });
}
