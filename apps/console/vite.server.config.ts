// The console's server bundle (spec 01 §4.4, S0-13): Vite's SSR build of src/server/server.node.ts
// to one dist/server/main.js with its map beside it. The client build is vite.config.ts (P0-G).
import { serverBundleConfig } from "@fin/server/vite";
import { defineConfig } from "vite";

export default defineConfig(
  serverBundleConfig({ root: import.meta.dirname, entry: "src/server/server.node.ts" }),
);
