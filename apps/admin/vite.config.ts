// Fin Admin's client build (spec 06 §1.3): environment-neutral hashed files in dist/static/,
// no data: URL, no nonce, no inline script, hidden source maps moved out of dist/static/ into the
// release's map artefact (dist/source-maps/, which the sourcemaps-staging job uploads, EX-28).
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { finLayerOrder } from "@fin/tokens/vite";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Moves every emitted *.map out of the static output: no source map is ever served. */
function sourceMapsOutOfStatic(): Plugin {
  return {
    name: "fin:source-maps-out-of-static",
    apply: "build",
    writeBundle(options, bundle) {
      const outDir = resolve(options.dir ?? "dist/static");
      const mapsDir = resolve(outDir, "..", "source-maps");
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith(".map")) continue;
        const to = join(mapsDir, fileName);
        mkdirSync(dirname(to), { recursive: true });
        renameSync(join(outDir, fileName), to);
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    // Before react(); its settings are tsr.config.json's (file routes, "-" files are not routes).
    tanstackRouter(),
    react(),
    tailwindcss(),
    // `@layer ui-sdk;` stays the emitted stylesheet's first statement (FW-C06).
    finLayerOrder(),
    sourceMapsOutOfStatic(),
  ],
  // The kit route exists only in `--mode test` (S6-16). No define carries an environment value.
  define: { __FIN_KIT__: JSON.stringify(mode === "test") },
  build: {
    outDir: "dist/static",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: "hidden",
    modulePreload: { polyfill: false },
    target: "baseline-widely-available",
    // The scrubbing console guard (@fin/frame/report) gets a chunk of its own, which the entry
    // imports first, so it is in place before any library chunk is evaluated (spec 06 §2.3 step
    // 1). Left in the entry chunk, it would run after every shared chunk the entry imports, React
    // DOM's included. The @security journey in e2e/shell.spec.ts holds the order.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "console-guard",
              test: /[\\/]packages[\\/]frame[\\/]src[\\/](?:report[\\/][^\\/]+|api[\\/]errors)\.ts$/,
              priority: 100,
            },
          ],
        },
      },
    },
  },
  // `vite dev` only (FW-C17): the API half on its local port.
  server: { proxy: { "/api": "http://localhost:8080" } },
}));
