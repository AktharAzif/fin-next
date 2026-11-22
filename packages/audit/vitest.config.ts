// Unit tests only; the integration tests (`*.db.test.ts`) run with vitest.db.config.ts (`pnpm test:db`).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.db.test.ts"],
  },
});
