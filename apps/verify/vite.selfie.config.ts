// The selfie host's client build (spec 06 §1.2, §1.3; S6-27): selfie.html and src/selfie/main.tsx
// into dist/static/selfie/, the second of verify's two static outputs, with public-selfie/ (its own
// theme.js copy and favicon) as the public directory. Environment-neutral hashed files, no data:
// URL, no nonce, no inline script; hidden source maps are moved out of dist/static/ into the
// release's map artefact (dist/source-maps/selfie/, EX-28). The built document is written as
// index.html: the selfie deployment answers `/s` with the single-page fallback, which serves
// /index.html (spec 01 §7.4), and static:check reads each output's index.html.
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { finLayerOrder } from "@fin/tokens/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const OUT_DIR = "dist/static/selfie";

/** Moves every emitted *.map out of the static output: no source map is ever served. */
function sourceMapsOutOfStatic(): Plugin {
  return {
    name: "fin:source-maps-out-of-static",
    apply: "build",
    writeBundle(options, bundle) {
      const outDir = resolve(options.dir ?? OUT_DIR);
      const mapsDir = resolve(outDir, "..", "..", "source-maps", "selfie");
      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith(".map")) continue;
        const to = join(mapsDir, fileName);
        mkdirSync(dirname(to), { recursive: true });
        renameSync(join(outDir, fileName), to);
      }
    },
  };
}

/** Writes the built selfie.html as the output's index.html. */
function selfieDocumentAsIndex(): Plugin {
  return {
    name: "fin:selfie-document-as-index",
    apply: "build",
    writeBundle(options, bundle) {
      if (!("selfie.html" in bundle)) throw new Error("the selfie build emitted no selfie.html");
      const outDir = resolve(options.dir ?? OUT_DIR);
      renameSync(join(outDir, "selfie.html"), join(outDir, "index.html"));
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // `@layer ui-sdk;` stays the emitted stylesheet's first statement (FW-C06).
    finLayerOrder(),
    sourceMapsOutOfStatic(),
    selfieDocumentAsIndex(),
  ],
  publicDir: "public-selfie",
  // No define carries an environment value; the selfie entry has no kit route.
  define: { __FIN_KIT__: JSON.stringify(mode === "test") },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: "hidden",
    modulePreload: { polyfill: false },
    target: "baseline-widely-available",
    rolldownOptions: { input: resolve(import.meta.dirname, "selfie.html") },
  },
  // `vite dev --config vite.selfie.config.ts` only (FW-C17): the API half on its local port.
  server: { proxy: { "/api": "http://localhost:8080" } },
}));
