// Unit tests of apps/api's data side (migrate, tasks, the probe); integration tests run with
// vitest.db.config.ts. P0-D's apps/api/vitest.config.ts, when it lands, takes these over.
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const root = join(import.meta.dirname, "..", "..");

export default defineConfig({
  test: {
    root,
    include: [
      "src/migrate/**/*.test.ts",
      "src/tasks/**/*.test.ts",
      "src/worker/probe/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/*.db.test.ts"],
  },
});
