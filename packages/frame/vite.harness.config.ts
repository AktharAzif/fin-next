// The frame's browser harness (harness/), built like an app (assets as files, no source maps, no
// inline script, no nonce) so its Playwright spec can open it under the production page policy.
// A test build only: it is never deployed, and no app imports it.
import { defineConfig } from "vite";

export default defineConfig({
  root: "harness",
  base: "/",
  build: {
    outDir: "../dist/harness",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
    target: "baseline-widely-available",
  },
});
