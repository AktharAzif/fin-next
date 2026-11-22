// The frame's browser spec (spec 06 §10.1's journeys layer, for what static markup cannot show):
// the built harness under the production page policy on Chromium, Firefox and WebKit. No web
// server: e2e/serve.ts answers every request through Playwright's routing.
import { defineConfig, devices } from "@playwright/test";

const desktop = { viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 4,
  reporter: [["list"]],
  use: { baseURL: "http://frame.fin.test", trace: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...desktop } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], ...desktop } },
    { name: "webkit", use: { ...devices["Desktop Safari"], ...desktop } },
  ],
});
