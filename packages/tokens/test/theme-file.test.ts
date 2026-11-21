// theme.css is generated from tokens.css by scripts/theme.ts (UI-12: built, not ported). It fails
// when the committed file is not what the script builds from the committed tokens, so a token or a
// script change lands with its theme: run `pnpm --filter @fin/tokens theme`.
//
// The comparison is of the whole file, byte for byte: `?raw` hands over the file's text exactly as
// it is on disk (a byte-order mark, a carriage return and trailing white space are all kept), and
// `toBe` compares that whole string with the whole of the script's output, so no line of the
// pinned file can differ from what the script writes.
import { describe, expect, it } from "vitest";
import { buildTheme } from "../scripts/theme.ts";
import themeCss from "../theme.css?raw";
import tokensCss from "../tokens.css?raw";
import { findRule, readRules, readUtilities } from "./css.ts";

/** scripts/theme.ts's mapping rule, as its header's table states it: token name to theme name. */
const MAPPING: [RegExp, string][] = [
  [/^--fin-color-(.+)$/, "--color-$1"],
  [/^--fin-font-(.+)$/, "--font-$1"],
  [/^--fin-text-(.+)-size$/, "--text-$1"],
  [/^--fin-text-(.+)-line-height$/, "--text-$1--line-height"],
  [/^--fin-text-(.+)-tracking$/, "--text-$1--letter-spacing"],
  [/^--fin-text-(.+)-weight$/, "--text-$1--font-weight"],
  [/^--fin-radius-(.+)$/, "--radius-$1"],
  [/^--fin-shadow-(.+)$/, "--shadow-$1"],
  [/^--fin-layout-(.+)$/, "--spacing-$1"],
  [/^--fin-density-(.+)$/, "--spacing-$1"],
  [/^--fin-space-unit$/, "--spacing"],
];

describe("theme.css", () => {
  it("is, as a whole and byte for byte, what scripts/theme.ts builds from tokens.css", () => {
    expect(themeCss, "theme.css is stale: run `pnpm --filter @fin/tokens theme`").toBe(
      buildTheme(tokensCss),
    );
  });

  it("maps each token family as scripts/theme.ts's header table says, every value a token", () => {
    const rules = readRules(tokensCss);
    const names = [
      ...findRule(rules, ':root, [data-theme="light"]').declarations.keys(),
      ...findRule(rules, ":root").declarations.keys(),
    ];
    const theme = findRule(readRules(themeCss), "@theme inline").declarations;
    const expected = new Map<string, string>();
    for (const name of names) {
      const rule = MAPPING.find(([pattern]) => pattern.test(name));
      if (rule === undefined) continue;
      const mapped = name.replace(rule[0], rule[1]);
      // A shadow may read its stand-in instead; test/theme.test.ts holds where it must.
      const standIn = `var(--themed-${mapped.slice(2)})`;
      const shadow = mapped.startsWith("--shadow-") && theme.get(mapped) === standIn;
      expected.set(mapped, shadow ? standIn : `var(${name})`);
    }
    expect(expected.size).toBeGreaterThan(100);
    const mapped = [...theme].filter(([name]) => expected.has(name));
    expect(new Map(mapped)).toEqual(expected);
    // What the theme holds besides the families: the reset, the breakpoints and four defaults.
    expect([...theme].filter(([name]) => !expected.has(name))).toEqual([
      ["--*", "initial"],
      ["--breakpoint-sm", "40rem"],
      ["--breakpoint-md", "48rem"],
      ["--breakpoint-lg", "64rem"],
      ["--breakpoint-xl", "80rem"],
      ["--default-font-family", "var(--fin-font-sans)"],
      ["--default-mono-font-family", "var(--fin-font-mono)"],
      ["--default-transition-duration", "var(--fin-duration-fast)"],
      ["--default-transition-timing-function", "var(--fin-ease-out)"],
    ]);
    // The z layers and durations, which Tailwind has no namespace for, as utilities.
    const utilities = readUtilities(themeCss);
    for (const name of names) {
      const layer = /^--fin-z-(.+)$/.exec(name)?.[1];
      if (layer !== undefined) {
        expect(utilities.get(`z-${layer}`)?.declarations.get("z-index"), name).toBe(`var(${name})`);
      }
      const duration = /^--fin-duration-(.+)$/.exec(name)?.[1];
      if (duration !== undefined) {
        const utility = utilities.get(`duration-${duration}`)?.declarations;
        expect(utility?.get("transition-duration"), name).toBe(`var(${name})`);
      }
    }
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

  it("refuses to build when a token the theme's defaults read is missing", () => {
    // --fin-font-sans: only `--default-font-family` reads it once the family itself is gone.
    expect(() => buildTheme(tokensCss.replace(/--fin-font-sans:[^;]*;/, ""))).toThrow(
      /--fin-font-sans/,
    );
  });
});
