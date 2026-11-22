// The console's shell spec on three engines, against its own build (`pnpm --filter @fin/console
// e2e` builds first). A stand-in until the root configuration of @fin/testing (L-SAT-08) is on main;
// then the spec runs under it and this file goes.
import { defineConfig, devices } from "@playwright/test";

const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { baseURL: "http://127.0.0.1:4401", bypassCSP: false, trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport } },
  ],
});
