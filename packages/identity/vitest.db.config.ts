// Integration tests on real Postgres 18 (never PGlite, CI-12). FIN_TEST_DATABASE_URL names a
// database on a server where the connecting role may create databases and roles; the global
// setup builds one template database from the fixtures, this package's migrations and its grant
// fragments, and each test file clones it (test/db.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.db.test.ts", "test/**/*.db.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./test/global-setup.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
