// theme.css is generated from tokens.css by scripts/theme.ts (UI-12: built, not ported). It fails
// when the committed file is not what the script builds from the committed tokens, so a token or a
// script change lands with its theme: run `pnpm --filter @fin/tokens theme`.
import { describe, expect, it } from "vitest";
import { buildTheme } from "../scripts/theme.ts";
import themeCss from "../theme.css?raw";
import tokensCss from "../tokens.css?raw";

describe("theme.css", () => {
  it("is what scripts/theme.ts builds from tokens.css", () => {
    expect(themeCss, "theme.css is stale: run `pnpm --filter @fin/tokens theme`").toBe(
      buildTheme(tokensCss),
    );
  });

  it("is rebuilt when a token family changes", () => {
    const extra = tokensCss.replace(
      "--fin-radius-full: 9999px;",
      "--fin-radius-full: 9999px;\n  --fin-radius-pill: 999px;",
    );
    expect(extra).not.toBe(tokensCss);
    expect(buildTheme(extra)).toContain("--radius-pill: var(--fin-radius-pill);");
    expect(buildTheme(extra)).not.toBe(themeCss);
  });

  it("refuses to build when a token a utility reads is missing", () => {
    expect(() => buildTheme(tokensCss.replace(/--fin-focus-width:[^;]*;/, ""))).toThrow(
      /--fin-focus-width/,
    );
  });
});
