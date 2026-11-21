// The Playwright configuration behind the root playwright.config.ts (spec 01 §4.7; spec 06 §10.2;
// spec 07 §10.4). One project per app and browser variant, each against that app's static host,
// plus the harness's own self-test on Chromium, Firefox and WebKit.
//
// Which apps run: FIN_E2E_APPS (a comma list of console, admin, verify, docs), or else every app
// that has an e2e/ folder. Each needs its built dist/static and its rendered `_headers`, found in
// FIN_E2E_RENDERED_DIR/<role>/ (the deploy's layout; with env.json beside it when rendered), or
// else in the dist folder itself. The API halves' test servers are started by their own lanes on
// the ports in STATIC_APPS; FIN_E2E_NIGHTLY=1 adds the Firefox and WebKit journey projects, and
// FIN_CANVAS_RENDERS (the owner's machine only) adds the fidelity projects.
//
// Every app host answers over https at https://<role>.localhost:<port> with a certificate made
// when it starts, so every project sets `ignoreHTTPSErrors`; nothing else about TLS is relaxed.
// Browsers resolve names under .localhost to loopback by themselves. Node-side requests (the
// `request` fixture, `page.request`) need this machine to resolve them too: macOS and
// systemd-resolved do; a container needs them in /etc/hosts (docker's --add-host).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices, type PlaywrightTestConfig, type Project } from "@playwright/test";
import {
  appLoopbackOrigin,
  appOrigin,
  EMAIL_SINK_PORT,
  type HostRole,
  STATIC_APPS,
} from "../static-host/apps.ts";

type TestRole = "console" | "admin" | "verify" | "docs";
const TEST_ROLES: readonly TestRole[] = ["console", "admin", "verify", "docs"];

const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

interface Variant {
  readonly name: string;
  readonly grep: RegExp;
  readonly use: Project["use"];
}

function variants(env: NodeJS.ProcessEnv): Variant[] {
  const chromium = { ...devices["Desktop Chrome"], viewport: DESKTOP };
  const list: Variant[] = [
    {
      name: "desktop",
      grep: /@journey|@kit|@csp|@security|@visual/,
      use: { ...chromium, colorScheme: "light" },
    },
    {
      name: "phone",
      grep: /@kit|@visual|@phone/,
      use: { ...devices["Desktop Chrome"], viewport: PHONE, isMobile: true, hasTouch: true },
    },
    { name: "dark", grep: /@kit|@visual/, use: { ...chromium, colorScheme: "dark" } },
    { name: "reduced", grep: /@motion/, use: { ...chromium, reducedMotion: "reduce" } },
    {
      name: "firefox",
      grep: /@kit|@csp|@security/,
      use: { ...devices["Desktop Firefox"], viewport: DESKTOP },
    },
    {
      name: "webkit",
      grep: /@kit|@csp|@security/,
      use: { ...devices["Desktop Safari"], viewport: DESKTOP },
    },
  ];
  if (env.FIN_E2E_NIGHTLY === "1") {
    list.push(
      {
        name: "firefox-journeys",
        grep: /@journey/,
        use: { ...devices["Desktop Firefox"], viewport: DESKTOP },
      },
      {
        name: "webkit-journeys",
        grep: /@journey/,
        use: { ...devices["Desktop Safari"], viewport: DESKTOP },
      },
    );
  }
  return list;
}

function fidelityProjects(role: TestRole, renders: string): Project[] {
  const base = {
    testDir: join(STATIC_APPS[role].appDir, "e2e"),
    grep: /@fidelity/,
    snapshotPathTemplate: join(renders, role, "{arg}{ext}"),
    expect: { toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css" } },
  } satisfies Project;
  return [
    {
      ...base,
      name: `${role}-fidelity-desktop`,
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP,
        reducedMotion: "reduce",
        baseURL: appOrigin(role),
      },
    },
    {
      ...base,
      name: `${role}-fidelity-phone`,
      use: {
        ...devices["Desktop Chrome"],
        viewport: PHONE,
        reducedMotion: "reduce",
        baseURL: appOrigin(role),
      },
    },
  ];
}

/** The apps this run serves and tests. */
export function selectedRoles(root: string, env: NodeJS.ProcessEnv = process.env): TestRole[] {
  const listed = env.FIN_E2E_APPS;
  if (listed !== undefined && listed.trim() !== "") {
    const names = listed.split(",").map((name) => name.trim());
    for (const name of names) {
      if (!TEST_ROLES.includes(name as TestRole))
        throw new Error(`FIN_E2E_APPS names an unknown app: ${name}`);
    }
    return names as TestRole[];
  }
  return TEST_ROLES.filter((role) => existsSync(join(root, STATIC_APPS[role].appDir, "e2e")));
}

function staticHostServer(root: string, role: HostRole, env: NodeJS.ProcessEnv, ci: boolean) {
  const rendered = env.FIN_E2E_RENDERED_DIR;
  const args = ["node", "packages/testing/src/static-host/cli.ts", "--app", role];
  if (rendered !== undefined && rendered !== "") {
    args.push("--headers", join(rendered, role, "_headers"));
    const envJson = join(rendered, role, "env.json");
    if (existsSync(envJson)) args.push("--env-json", envJson);
  }
  return {
    command: args.join(" "),
    cwd: root,
    // By the bound address, so the readiness check does not depend on Node resolving the name.
    url: `${appLoopbackOrigin(role)}/`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: !ci,
    stdout: "ignore" as const,
    stderr: "pipe" as const,
    timeout: 30_000,
  };
}

/** Builds the whole configuration for a repository root. */
export function finPlaywrightConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightTestConfig {
  const ci = env.CI !== undefined && env.CI !== "";
  const roles = selectedRoles(root, env);
  const projects: Project[] = [];
  for (const role of roles) {
    for (const variant of variants(env)) {
      projects.push({
        name: `${role}-${variant.name}`,
        testDir: join(root, STATIC_APPS[role].appDir, "e2e"),
        testMatch: "**/*.spec.ts",
        grep: variant.grep,
        use: { ...variant.use, baseURL: appOrigin(role) },
      });
    }
    const renders = env.FIN_CANVAS_RENDERS;
    if (renders !== undefined && renders !== "") projects.push(...fidelityProjects(role, renders));
  }
  for (const [name, device] of [
    ["chromium", devices["Desktop Chrome"]],
    ["firefox", devices["Desktop Firefox"]],
    ["webkit", devices["Desktop Safari"]],
  ] as const) {
    projects.push({
      name: `harness-${name}`,
      testDir: join(root, "packages/testing/e2e"),
      testMatch: "**/*.spec.ts",
      use: { ...device, viewport: DESKTOP },
    });
  }

  const hosts: HostRole[] = roles.flatMap((role) =>
    role === "verify" ? ["verify", "selfie"] : [role],
  );
  const webServer = hosts.map((role) => staticHostServer(root, role, env, ci));
  if (roles.some((role) => STATIC_APPS[role].apiPort !== undefined)) {
    webServer.push({
      command: "node packages/testing/src/email/cli.ts",
      cwd: root,
      // Plain http: only Node reads and writes the sink, never a browser.
      url: `http://127.0.0.1:${EMAIL_SINK_PORT}/messages`,
      ignoreHTTPSErrors: false,
      reuseExistingServer: !ci,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 30_000,
    });
  }

  const renders = env.FIN_CANVAS_RENDERS;
  return defineConfig({
    fullyParallel: true,
    forbidOnly: ci,
    retries: ci ? 1 : 0,
    ...(ci ? { workers: 1, globalTimeout: 25 * 60 * 1000 } : {}),
    reporter: ci ? [["blob"]] : [["list"]],
    timeout: 30 * 1000,
    outputDir: join(root, "test-results"),
    use: { trace: "retain-on-failure", bypassCSP: false, ignoreHTTPSErrors: true },
    ...(renders !== undefined && renders !== "" ? { updateSnapshots: "none" as const } : {}),
    projects,
    ...(webServer.length > 0 ? { webServer } : {}),
  });
}
