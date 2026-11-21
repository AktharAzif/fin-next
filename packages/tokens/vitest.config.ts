// Vitest blanks every CSS import unless told to process it; the tests read Fin's own stylesheets
// as text through `?raw`, so those requests pass through untouched.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    css: { include: [/\.css\?raw$/] },
  },
});
