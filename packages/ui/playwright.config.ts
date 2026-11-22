// The kit spec's Playwright projects (spec 06 §10.2, §10.3): the built kit under the production
// page policy on Chromium, Firefox and WebKit, plus dark, phone and reduced-motion runs on Chromium.
// No web server: e2e/serve.ts answers every request from dist/kit with the policy's headers
// (`vite preview` is never used for tests, FW-C17). No test sets bypassCSP.
import { defineConfig, devices } from "@playwright/test";

const desktop = { viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 4,
  reporter: [["list"]],
  use: { baseURL: "http://kit.fin.test", trace: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...desktop } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], ...desktop } },
    { name: "webkit", use: { ...devices["Desktop Safari"], ...desktop } },
    {
      name: "dark",
      grep: /@kit/,
      use: { ...devices["Desktop Chrome"], ...desktop, colorScheme: "dark" },
    },
    {
      // Spec 06 §10.2: the @kit cases run on a phone too (their geometry is viewport-aware), plus
      // anything tagged @phone.
      name: "phone",
      grep: /@kit|@phone/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "reduced",
      grep: /@motion/,
      use: { ...devices["Desktop Chrome"], ...desktop, reducedMotion: "reduce" },
    },
  ],
});
