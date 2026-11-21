// Integration tests (`*.db.test.ts`) against FIN_TEST_DATABASE_URL (spec 01 §4.7), one file at a time:
// each makes its own database, but the roles they bootstrap are cluster-wide.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
