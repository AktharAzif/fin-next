// The edge's server bundle (spec 01 §4.4, §4.9; S0-13): one dist/server/main.js with its map.
import { serverBundleConfig } from "@fin/server/vite";
import { defineConfig } from "vite";

export default defineConfig(
  serverBundleConfig({ root: import.meta.dirname, entry: "src/server.node.ts" }),
);
