// The package's unit tests (`pnpm --filter @fin/identity test`). Integration tests
// (`*.db.test.ts`) run only through vitest.db.config.ts, against FIN_TEST_DATABASE_URL.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.db.test.ts"],
    pool: "threads",
  },
});
