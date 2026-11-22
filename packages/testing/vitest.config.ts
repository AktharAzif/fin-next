// The package's own Vitest run (`pnpm --filter @fin/testing test`). Unit tests only: the
// Playwright self-test under e2e/ runs through playwright.config.ts, never here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "**/*.db.test.ts"],
    pool: "threads",
  },
});
