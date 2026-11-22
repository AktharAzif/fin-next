// The supervisor bundle: one dist/server/main.js (spec 01 §4.4, §4.9; S0-13), copied into the
// connector image as /app/dist/main.js.
import { serverBundleConfig } from "@fin/server/vite";
import { defineConfig } from "vite";

export default defineConfig(
  serverBundleConfig({ root: import.meta.dirname, entry: "src/server.node.ts" }),
);
