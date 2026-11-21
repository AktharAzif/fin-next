// Unit tests render static markup (renderToStaticMarkup) with no DOM package (G-06). The kit and
// its Playwright spec live in kit/ and e2e/, which Vitest never collects.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    css: { include: [/\.css\?raw$/] },
  },
});
