import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appOrigin,
  STATIC_APPS,
  testAccessAudience,
  testIngressProof,
} from "../static-host/apps.ts";
import { accessLoginUrl } from "./access.ts";
import { rpIdFor } from "./authenticator.ts";
import { finPlaywrightConfig, selectedRoles } from "./config.ts";
import { CSP_INIT_SCRIPT, isPolicyConsoleMessage } from "./csp.ts";
import { isOffsite } from "./offsite.ts";

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
    expect(rpIdFor("http://127.0.0.1:4101")).toBe("127.0.0.1");
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
    expect(appOrigin("admin")).toBe(`http://127.0.0.1:${STATIC_APPS.admin.port}`);
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
      `${appOrigin("console")}/`,
      `${appOrigin("verify")}/`,
      `${appOrigin("selfie")}/`,
      "http://127.0.0.1:4111/messages",
    ]);
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
