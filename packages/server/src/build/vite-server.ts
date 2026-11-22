// The server bundle (spec 01 §4.4, S0-13): Vite's SSR build, everything bundled into one
// `dist/server/main.js` with its map beside it (unserved; Node runs with --enable-source-maps),
// `pg-native` ignored. FIN_BUILD_TARGET picks `release` (the default) or `test` and is compiled in,
// so a release bundle refuses every seam variable (config/seams.ts).
import type { UserConfig } from "vite";

export interface ServerBundleOptions {
  /** The app's root directory (where its vite.server.config.ts lives). */
  root: string;
  /** The entry, relative to the root: the app's server.node.ts. */
  entry: string;
}

export function serverBundleTarget(
  env: Readonly<Record<string, string | undefined>>,
): "release" | "test" {
  const value = env.FIN_BUILD_TARGET;
  if (value === undefined || value === "" || value === "release") return "release";
  if (value === "test") return "test";
  throw new Error("FIN_BUILD_TARGET must be release or test");
}

export function serverBundleConfig(options: ServerBundleOptions): UserConfig {
  const target = serverBundleTarget(process.env);
  return {
    root: options.root,
    publicDir: false,
    logLevel: "warn",
    clearScreen: false,
    define: { __FIN_BUILD_TARGET__: JSON.stringify(target) },
    ssr: { target: "node", noExternal: true, external: ["pg-native"] },
    build: {
      ssr: options.entry,
      outDir: "dist/server",
      emptyOutDir: true,
      target: "es2024",
      sourcemap: true,
      minify: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      rolldownOptions: {
        output: { entryFileNames: "main.js", format: "es", codeSplitting: false },
      },
    },
  };
}
