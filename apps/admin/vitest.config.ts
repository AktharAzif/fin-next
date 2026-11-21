// Unit tests only (spec 06 §10.1); the Playwright journeys in e2e/ never run under Vitest.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
