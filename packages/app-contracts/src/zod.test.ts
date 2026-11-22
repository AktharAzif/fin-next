import { describe, expect, it } from "vitest";
import { consoleViewer, z } from "./index.ts";

describe("Zod under the page policy", () => {
  it("is jitless, so no schema ever probes for `new Function` (script-src 'self')", () => {
    expect(z.config().jitless).toBe(true);
  });

  it("still parses and refuses as before", () => {
    expect(
      consoleViewer.output.safeParse({ gate: "factor_step", email: "a@example.com", methods: [] })
        .success,
    ).toBe(true);
    expect(consoleViewer.output.safeParse({ gate: "elsewhere" }).success).toBe(false);
  });
});
