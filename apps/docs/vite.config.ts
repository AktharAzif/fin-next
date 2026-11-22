// The docs placeholder's build (spec 01 §4.5): one static page with hashed CSS and fonts in
// dist/static/, no script of its own besides /theme.js, no data: URL, no source map left behind.
// Its `_headers` come from the `docs` profile at deploy; the build writes none.
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { finLayerOrder } from "@fin/tokens/vite";
import tailwindcss from "@tailwindcss/vite";
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

export default defineConfig({
  plugins: [tailwindcss(), finLayerOrder(), sourceMapsOutOfStatic()],
  build: {
    outDir: "dist/static",
    emptyOutDir: true,
    assetsDir: "assets",
    assetsInlineLimit: 0,
    sourcemap: "hidden",
    target: "baseline-widely-available",
  },
});
