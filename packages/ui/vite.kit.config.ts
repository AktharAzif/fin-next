// The kit's build (spec 06 §10.3): a test-only page that renders every @fin/ui component of waves 0
// and 1, built like an app (assets as files, never data: URLs; no nonce; no inline script) so the
// Playwright spec can open it under the production page policy on three engines (AC-P0-16).
// It is never deployed; apps mount @fin/frame's kit route instead, once that lane lands.
import { finLayerOrder } from "@fin/tokens/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  root: "kit",
  base: "/",
  plugins: [react(), tailwindcss(), finLayerOrder()],
  define: { __FIN_KIT__: JSON.stringify(mode === "test") },
  build: {
    outDir: "../dist/kit",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
    target: "baseline-widely-available",
  },
}));
