import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import {
  appHostName,
  appLoopbackOrigin,
  appOrigin,
  STATIC_APPS,
  testAccessAudience,
  testIngressProof,
} from "../static-host/apps.ts";
import { accessLoginUrl } from "./access.ts";
import { rpIdFor } from "./authenticator.ts";
import { finPlaywrightConfig, selectedRoles } from "./config.ts";
import { CSP_INIT_SCRIPT, isPolicyConsoleMessage } from "./csp.ts";
import { refuseBypassCsp } from "./fixtures.ts";
import { isOffsite, watchOffsite } from "./offsite.ts";

type Listener = (value: never) => void;

/** Just enough of a browser context and its pages to drive the recorder's listeners. */
function fakeContext() {
  const listeners = new Map<string, Listener[]>();
  const on = (map: Map<string, Listener[]>) => (event: string, listener: Listener) => {
    map.set(event, [...(map.get(event) ?? []), listener]);
  };
  const emit = (map: Map<string, Listener[]>, event: string, value: unknown) => {
    for (const listener of map.get(event) ?? []) listener(value as never);
  };
  const context = { on: on(listeners), pages: () => [] };
  const page = (url: string) => {
    const own = new Map<string, Listener[]>();
    return {
      value: { on: on(own), url: () => url },
      websocket: (socket: string) => emit(own, "websocket", { url: () => socket }),
    };
  };
  const request = (
    url: string,
    { type = "fetch", navigation = false, topLevel = true } = {},
  ): unknown => ({
    url: () => url,
    resourceType: () => type,
    isNavigationRequest: () => navigation,
    frame: () => ({
      url: () => "https://console.localhost:4101/",
      parentFrame: () => (topLevel ? null : {}),
    }),
  });
  return {
    context: context as unknown as BrowserContext,
    request: (url: string, options?: Parameters<typeof request>[1]) =>
      emit(listeners, "request", request(url, options)),
    openPage(url: string) {
      const made = page(url);
      emit(listeners, "page", made.value);
      return made;
    },
  };
}

describe("watchOffsite", () => {
  const APP = "https://console.localhost:4101";
  const STAND_IN = "http://127.0.0.1:4110";

  it("records exactly the requests that leave the allowed origins", () => {
    const fake = fakeContext();
    const offsite = watchOffsite(fake.context, [APP]);
    fake.request(`${APP}/assets/app.js`, { type: "script" });
    fake.request("https://fonts.example.com/a.woff2", { type: "font" });
    expect(offsite.requests).toEqual([
      {
        url: "https://fonts.example.com/a.woff2",
        resourceType: "font",
        pageUrl: "https://console.localhost:4101/",
      },
    ]);
    expect(() => offsite.assertNone()).toThrow("another origin 1 time(s)");
    offsite.clear();
    expect(() => offsite.assertNone()).not.toThrow();
  });

  it("lets a top-level navigation reach a navigation origin, and nothing else load from it", () => {
    const fake = fakeContext();
    const offsite = watchOffsite(fake.context, [APP], { navigationOrigins: [STAND_IN] });
    fake.request(`${STAND_IN}/cdn-cgi/access/login?app=x`, { type: "document", navigation: true });
    expect(offsite.requests).toEqual([]);
    fake.request(`${STAND_IN}/cdn-cgi/access/certs`, { type: "fetch" });
    fake.request(`${STAND_IN}/framed`, { type: "document", navigation: true, topLevel: false });
    expect(offsite.requests.map((r) => r.url)).toEqual([
      `${STAND_IN}/cdn-cgi/access/certs`,
      `${STAND_IN}/framed`,
    ]);
  });

  it("records a page's WebSocket to another origin, which Playwright never reports as a request", () => {
    const fake = fakeContext();
    const offsite = watchOffsite(fake.context, [APP]);
    const page = fake.openPage(`${APP}/`);
    page.websocket("wss://console.localhost:4101/live");
    page.websocket("wss://socket.example.com/live");
    expect(offsite.requests).toEqual([
      { url: "wss://socket.example.com/live", resourceType: "websocket", pageUrl: `${APP}/` },
    ]);
  });
});

describe("refuseBypassCsp", () => {
  it("refuses bypassCSP from any route, naming it, and lets everything else through", () => {
    expect(() => refuseBypassCsp("newContext()", { bypassCSP: true })).toThrow(
      "newContext() turns it on",
    );
    expect(() => refuseBypassCsp("contextOptions", { bypassCSP: true })).toThrow("spec 06 §6.4");
    for (const options of [undefined, {}, { bypassCSP: false }, { bypassCSP: undefined }]) {
      expect(() => refuseBypassCsp("x", options)).not.toThrow();
    }
  });
});

describe("isOffsite", () => {
  const allowed = new Set(["http://127.0.0.1:4101"]);

  it("allows the app's own origin and schemes that never leave the page", () => {
    expect(isOffsite("http://127.0.0.1:4101/assets/app.js", allowed)).toBe(false);
    expect(isOffsite("ws://127.0.0.1:4101/socket", allowed)).toBe(false);
    expect(isOffsite("data:image/png;base64,AAAA", allowed)).toBe(false);
    expect(isOffsite("blob:http://127.0.0.1:4101/uuid", allowed)).toBe(false);
    expect(isOffsite("about:blank", allowed)).toBe(false);
  });

  it("catches another origin, another port and another scheme", () => {
    expect(isOffsite("https://fonts.example.com/a.woff2", allowed)).toBe(true);
    expect(isOffsite("http://127.0.0.1:4102/", allowed)).toBe(true);
    expect(isOffsite("https://127.0.0.1:4101/", allowed)).toBe(true);
    expect(isOffsite("wss://127.0.0.1:4101/", allowed)).toBe(true);
  });
});

describe("the policy console messages of the three engines", () => {
  it.each([
    "Refused to apply inline style because it violates the following Content Security Policy directive: \"style-src 'self'\".",
    "Refused to load the script 'https://script.example.invalid/x.js' because it violates the following Content Security Policy directive",
    "Content-Security-Policy: The page’s settings blocked an inline style (style-src-attr) from being applied",
    "Refused to execute a script because its hash, its nonce, or 'unsafe-inline' does not appear in the script-src directive of the Content Security Policy.",
  ])("recognises %s", (text) => {
    expect(isPolicyConsoleMessage(text)).toBe(true);
  });

  it("ignores ordinary logs", () => {
    expect(isPolicyConsoleMessage("Download the React DevTools")).toBe(false);
    expect(isPolicyConsoleMessage("Failed to load resource: 404")).toBe(false);
  });

  it("listens in the capture phase and reports through the binding", () => {
    expect(CSP_INIT_SCRIPT).toContain('addEventListener("securitypolicyviolation"');
    expect(CSP_INIT_SCRIPT).toContain("__finCspViolation");
  });
});

describe("helpers", () => {
  it("uses the host name as the passkey relying party", () => {
    expect(rpIdFor(appOrigin("console"))).toBe("console.localhost");
    expect(rpIdFor("https://console.example.com")).toBe("console.example.com");
  });

  it("builds the Access login URL", () => {
    const url = new URL(
      accessLoginUrl({
        standInOrigin: "http://127.0.0.1:4110",
        appOrigin: "http://127.0.0.1:4102",
        email: "grace.hall@example.com",
        path: "/staff",
      }),
    );
    expect(url.pathname).toBe("/cdn-cgi/access/login");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app: "http://127.0.0.1:4102",
      redirect_url: "/staff",
      email: "grace.hall@example.com",
    });
  });

  it("derives stable test values, distinct per host, overridable for the proof", () => {
    expect(testIngressProof("console", {})).toBe(testIngressProof("console", {}));
    expect(testIngressProof("console", {})).not.toBe(testIngressProof("admin", {}));
    expect(testIngressProof("console", { FIN_E2E_INGRESS_PROOF: "given" })).toBe("given");
    expect(testAccessAudience()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("serves every host over https under its own name, so each keeps its own cookie jar", () => {
    expect(appOrigin("admin")).toBe(`https://admin.localhost:${STATIC_APPS.admin.port}`);
    expect(appLoopbackOrigin("admin")).toBe(`https://127.0.0.1:${STATIC_APPS.admin.port}`);
    const roles = Object.keys(STATIC_APPS) as (keyof typeof STATIC_APPS)[];
    const names = roles.map((role) => appHostName(role));
    expect(new Set(names).size).toBe(roles.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+\.localhost$/);
  });

  it("gives every host its own port", () => {
    const ports = Object.values(STATIC_APPS).map((app) => app.port);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe("the Playwright configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "fin-testing-config-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("runs only the harness's own projects while no app has journeys", () => {
    const config = finPlaywrightConfig(root, {});
    expect(config.projects?.map((p) => p.name)).toEqual([
      "harness-chromium",
      "harness-firefox",
      "harness-webkit",
    ]);
    expect(config.webServer).toBeUndefined();
    expect(config.use?.bypassCSP).toBe(false);
    expect(config.use?.ignoreHTTPSErrors).toBe(true);
    expect(config.fullyParallel).toBe(true);
    expect(config.timeout).toBe(30_000);
  });

  it("adds one project per app and browser variant once an app has an e2e folder", () => {
    mkdirSync(join(root, "apps/console/e2e"), { recursive: true });
    mkdirSync(join(root, "apps/verify/e2e"), { recursive: true });
    expect(selectedRoles(root, {})).toEqual(["console", "verify"]);
    const config = finPlaywrightConfig(root, {});
    const names = config.projects?.map((p) => p.name) ?? [];
    for (const variant of ["desktop", "phone", "dark", "reduced", "firefox", "webkit"]) {
      expect(names).toContain(`console-${variant}`);
      expect(names).toContain(`verify-${variant}`);
    }
    expect(names).not.toContain("console-firefox-journeys");
    const desktop = config.projects?.find((p) => p.name === "console-desktop");
    expect(desktop?.use?.baseURL).toBe(appOrigin("console"));
    expect(desktop?.use?.viewport).toEqual({ width: 1440, height: 900 });
    expect(String(desktop?.grep)).toContain("@journey");
    const servers = Array.isArray(config.webServer) ? config.webServer : [];
    expect(servers.map((s) => s.url)).toEqual([
      `${appLoopbackOrigin("console")}/`,
      `${appLoopbackOrigin("verify")}/`,
      `${appLoopbackOrigin("selfie")}/`,
      "http://127.0.0.1:4111/messages",
    ]);
    expect(servers.slice(0, 3).every((s) => s.ignoreHTTPSErrors === true)).toBe(true);
  });

  it("follows FIN_E2E_APPS, the nightly flag, CI and the rendered folder", () => {
    const config = finPlaywrightConfig(root, {
      FIN_E2E_APPS: "admin",
      FIN_E2E_NIGHTLY: "1",
      CI: "true",
      FIN_E2E_RENDERED_DIR: "/rendered",
    });
    const names = config.projects?.map((p) => p.name) ?? [];
    expect(names).toContain("admin-firefox-journeys");
    expect(names).toContain("admin-webkit-journeys");
    expect(names).not.toContain("console-desktop");
    expect(config.workers).toBe(1);
    expect(config.retries).toBe(1);
    expect(config.reporter).toEqual([["blob"]]);
    expect(config.globalTimeout).toBe(25 * 60 * 1000);
    const servers = Array.isArray(config.webServer) ? config.webServer : [];
    expect(servers[0]?.command).toContain("--headers /rendered/admin/_headers");
    expect(servers[0]?.reuseExistingServer).toBe(false);
    expect(() => finPlaywrightConfig(root, { FIN_E2E_APPS: "nope" })).toThrow("unknown app");
  });

  it("adds the fidelity projects only with FIN_CANVAS_RENDERS", () => {
    const config = finPlaywrightConfig(root, {
      FIN_E2E_APPS: "console",
      FIN_CANVAS_RENDERS: "/renders",
    });
    const fidelity = config.projects?.filter((p) => p.name?.includes("fidelity")) ?? [];
    expect(fidelity.map((p) => p.name)).toEqual([
      "console-fidelity-desktop",
      "console-fidelity-phone",
    ]);
    expect(fidelity[0]?.snapshotPathTemplate).toBe("/renders/console/{arg}{ext}");
    expect(config.updateSnapshots).toBe("none");
  });
});
