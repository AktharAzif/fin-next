// theme.css and base.css, as far as unit tests can hold them: under reduced motion no utility
// transitions a transform or a size (spec 06 §5.1, AC-UI-13's static half); no theme shadow can put
// `none` inside the list Tailwind composes; every --fin-* variable they read is a token.
import { describe, expect, it } from "vitest";
import baseCss from "../base.css?raw";
import pin from "../export-pin/tokens.json" with { type: "json" };
import themeCss from "../theme.css?raw";
import tokensCss from "../tokens.css?raw";
import { findRule, readRules, readUtilities, stripComments } from "./css.ts";

const REDUCE = "@media (prefers-reduced-motion: reduce)";
/** The properties whose transitions move, turn, scale or resize something. */
const MOVING = new Set(["translate", "rotate", "scale", "transform", "height", "width"]);
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

describe("theme.css under reduced motion", () => {
  const utilities = [...readUtilities(themeCss).values()];
  const moving = utilities.filter((u) =>
    list(u.declarations.get("transition-property")).some((p) => MOVING.has(p)),
  );

  it("reads the utilities that transition a transform or a size", () => {
    expect(utilities.length).toBeGreaterThan(30);
    expect(moving.map((u) => u.name).sort()).toEqual([
      "animate-copied",
      "fin-toast",
      "transition-dialog",
      "transition-popup",
      "transition-press",
      "transition-tooltip",
    ]);
  });

  it("keeps only their colour and opacity transitions (a toast's stack, a switch's thumb)", () => {
    for (const utility of moving) {
      const reduced = utility.nested.filter((block) => block.prelude === REDUCE);
      expect(reduced.length, utility.name).toBe(1);
      const kept = list(reduced[0]?.declarations.get("transition-property"));
      const all = list(utility.declarations.get("transition-property"));
      expect(kept, utility.name).toEqual(all.filter((p) => !MOVING.has(p)));
      expect(kept, utility.name).toContain("opacity");
    }
  });

  it("lets a dialog still leave the top layer after its fade", () => {
    const dialog = utilities.find((u) => u.name === "transition-dialog");
    const reduced = dialog?.nested.find((block) => block.prelude === REDUCE);
    expect(list(reduced?.declarations.get("transition-property"))).toEqual([
      "opacity",
      "display",
      "overlay",
    ]);
    expect(dialog?.declarations.get("transition-behavior")).toBe("allow-discrete");
  });

  it("never transitions every property, so nothing moves that a utility did not name", () => {
    for (const utility of utilities) {
      for (const block of [utility.declarations, ...utility.nested.map((n) => n.declarations)]) {
        expect(block.get("transition-property"), utility.name).not.toBe("all");
        expect(block.has("transition"), utility.name).toBe(false);
      }
    }
  });
});

describe("theme.css's shadows", () => {
  const rules = readRules(themeCss);
  const theme = findRule(rules, "@theme inline").declarations;
  const shadows = [...theme].filter(([name]) => name.startsWith("--shadow-"));
  const themed = { light: pin.themed.light, dark: pin.themed.dark } as Record<
    "light" | "dark",
    Record<string, string>
  >;
  const LIGHT = ':root, [data-theme="light"]';
  const DARK = '[data-theme="dark"]';
  const SYSTEM_DARK = ':root:not([data-theme="light"])';
  const PREFERS_DARK = "@media (prefers-color-scheme: dark)";

  it("maps each shadow to its token, or to a stand-in where the export says none", () => {
    expect(shadows.length).toBe(10);
    for (const [name, value] of shadows) {
      const token = `--fin-${name.slice(2)}`;
      const none = Object.values(themed).some((values) => values[token] === "none");
      expect(value, name).toBe(none ? `var(--themed-${name.slice(2)})` : `var(${token})`);
    }
    expect(
      shadows.filter(([, value]) => value.startsWith("var(--themed-")).map(([n]) => n),
    ).toEqual(["--shadow-input"]);
  });

  it("gives a stand-in the export's shadow in each theme, and an empty shadow for none", () => {
    for (const [name, value] of shadows) {
      if (!value.startsWith("var(--themed-")) continue;
      const standIn = `--themed-${name.slice(2)}`;
      const token = `--fin-${name.slice(2)}`;
      const expected = (t: "light" | "dark") =>
        themed[t][token] === "none" ? "0 0 #0000" : `var(${token})`;
      // The same theme selectors as tokens.css, so a themed subtree gets its own value.
      expect(findRule(rules, LIGHT).declarations.get(standIn)).toBe(expected("light"));
      expect(findRule(rules, DARK).declarations.get(standIn)).toBe(expected("dark"));
      expect(findRule(rules, SYSTEM_DARK, PREFERS_DARK).declarations.get(standIn)).toBe(
        expected("dark"),
      );
    }
  });
});

describe("the stylesheets' variables", () => {
  it("read only --fin-* tokens that tokens.css declares", () => {
    const declared = new Set([...tokensCss.matchAll(/(--fin-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    for (const [file, css] of [
      ["theme.css", themeCss],
      ["base.css", baseCss],
    ] as const) {
      const used = [...stripComments(css).matchAll(/var\((--fin-[a-z0-9-]+)/g)].map((m) => m[1]);
      expect(used.length, file).toBeGreaterThan(5);
      expect(
        used.filter((name) => !declared.has(name)),
        file,
      ).toEqual([]);
    }
  });
});
