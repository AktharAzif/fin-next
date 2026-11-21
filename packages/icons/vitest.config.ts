// Vitest blanks every CSS import unless told to process it; the glyph test reads the motion layer
// as text through `?raw`, so that request passes through untouched.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    css: { include: [/\.css\?raw$/] },
  },
});
