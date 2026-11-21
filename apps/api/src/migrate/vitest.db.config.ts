// Integration tests of apps/api's data side against FIN_TEST_DATABASE_URL, one file at a time (the roles
// they bootstrap are cluster-wide).
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const root = join(import.meta.dirname, "..", "..");

export default defineConfig({
  test: {
    root,
    include: [
      "src/migrate/**/*.db.test.ts",
      "src/tasks/**/*.db.test.ts",
      "src/worker/probe/**/*.db.test.ts",
    ],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
