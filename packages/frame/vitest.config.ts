// @fin/frame's tests: unit tests in node with static markup (spec 06 §10.1). boot.css is read as it
// ships (`?raw`), which Vitest leaves empty unless the file goes through Vite's CSS pipeline.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    css: { include: [/boot\.css/] },
  },
});
