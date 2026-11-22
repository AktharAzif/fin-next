// The Playwright configuration Google's journey runs under (google/run.ts passes it): the root
// configuration's console desktop project, pointed at the journey's own static host on its own
// port, which forwards `/api/` to the journey's own API half. A journey run so never reuses a
// static host or an API half another run on the same machine has up on the shared ports.
import { join, resolve } from "node:path";
import type { PlaywrightTestConfig } from "@playwright/test";
import { finPlaywrightConfig } from "../../../../packages/testing/src/playwright/config.ts";
import { GOOGLE_JOURNEY_PORTS } from "./support.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const RENDERED = process.env.FIN_E2E_RENDERED_DIR ?? join(ROOT, "apps/console/dist/e2e-rendered");
const ORIGIN = `https://console.localhost:${GOOGLE_JOURNEY_PORTS.static}`;

const base = finPlaywrightConfig(ROOT, { ...process.env, FIN_E2E_APPS: "console" });
const desktop = base.projects?.find((project) => project.name === "console-desktop");
if (desktop === undefined) throw new Error("the root configuration has no console-desktop project");

const config: PlaywrightTestConfig = {
  ...base,
  projects: [
    {
      ...desktop,
      name: "console-google",
      // The journey; `FIN_E2E_GOOGLE_BOARDS=1` adds the boards of google.spec.ts on this host too.
      testMatch: "google/*.spec.ts",
      grep: process.env.FIN_E2E_GOOGLE_BOARDS === "1" ? /@journey/ : /@google/,
      use: { ...desktop.use, baseURL: ORIGIN },
    },
  ],
  webServer: [
    {
      command: [
        "node packages/testing/src/static-host/cli.ts --app console",
        `--port ${GOOGLE_JOURNEY_PORTS.static}`,
        `--api http://127.0.0.1:${GOOGLE_JOURNEY_PORTS.api}`,
        `--headers ${join(RENDERED, "console", "_headers")}`,
        `--env-json ${join(RENDERED, "console", "env.json")}`,
      ].join(" "),
      cwd: ROOT,
      url: `https://127.0.0.1:${GOOGLE_JOURNEY_PORTS.static}/`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 30_000,
    },
  ],
};

export default config;
