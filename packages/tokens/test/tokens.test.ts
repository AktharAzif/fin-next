// The token drift test (AC-UI-02): every --fin-* name and value in tokens.css equals the export's
// pin, in each theme, density and motion setting; every text pair passes 4.5:1 and every non-text
// pair 3:1 in both themes.
import { describe, expect, it } from "vitest";
import pin from "../export-pin/tokens.json" with { type: "json" };
import tokensCss from "../tokens.css?raw";
import { contrast, over, parseColour, type Rgba } from "./contrast.ts";
import { findRule, normalise, readRules } from "./css.ts";

const rules = readRules(tokensCss);
const LIGHT = ':root, [data-theme="light"]';
const DARK = '[data-theme="dark"]';
const SYSTEM_DARK = ':root:not([data-theme="light"])';
const PREFERS_DARK = "@media (prefers-color-scheme: dark)";
const PREFERS_REDUCED = "@media (prefers-reduced-motion: reduce)";

function asRecord(map: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...map].map(([k, v]) => [k, normalise(v)]));
}
function pinned(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, normalise(v)]));
}

describe("tokens.css against the export pin", () => {
  it("declares the light values on :root and [data-theme=light]", () => {
    expect(asRecord(findRule(rules, LIGHT).declarations)).toEqual(pinned(pin.themed.light));
  });

  it("declares the dark values on [data-theme=dark]", () => {
    expect(asRecord(findRule(rules, DARK).declarations)).toEqual(pinned(pin.themed.dark));
  });

  it("falls back to the dark values under the system's dark preference", () => {
    const rule = findRule(rules, SYSTEM_DARK, PREFERS_DARK);
    expect(asRecord(rule.declarations)).toEqual(pinned(pin.themed.dark));
  });

  it("declares every theme-independent value on :root", () => {
    expect(asRecord(findRule(rules, ":root").declarations)).toEqual(pinned(pin.root));
  });

  it("declares both densities", () => {
    const def = findRule(rules, '[data-density="default"]');
    const compact = findRule(rules, '[data-density="compact"]');
    expect(asRecord(def.declarations)).toEqual(pinned(pin.density.default));
    expect(asRecord(compact.declarations)).toEqual(pinned(pin.density.compact));
  });

  it("shortens motion under reduced motion", () => {
    const rule = findRule(rules, ":root", PREFERS_REDUCED);
    expect(asRecord(rule.declarations)).toEqual(pinned(pin.reducedMotion));
  });

  it("holds the export's 203 distinct --fin-* names and nothing else", () => {
    const names = new Set<string>();
    for (const rule of rules) for (const name of rule.declarations.keys()) names.add(name);
    expect([...names].every((n) => n.startsWith("--fin-"))).toBe(true);
    expect(names.size).toBe(203);
    const expected = new Set([...Object.keys(pin.themed.light), ...Object.keys(pin.root)]);
    expect([...names].sort()).toEqual([...expected].sort());
  });

  it("names the same colours in both themes", () => {
    expect(Object.keys(pin.themed.dark).sort()).toEqual(Object.keys(pin.themed.light).sort());
  });

  it("keeps the shell's sizes as the spec names them (spec 06 §3.2)", () => {
    const root = pin.root as Record<string, string>;
    const expected: Record<string, string> = {
      "--fin-layout-sidebar": "224px",
      "--fin-layout-sidebar-collapsed": "64px",
      "--fin-layout-header": "56px",
      "--fin-layout-drawer-s": "480px",
      "--fin-layout-drawer-m": "720px",
      "--fin-layout-drawer-l": "960px",
      "--fin-layout-modal": "480px",
      "--fin-layout-modal-padding": "24px",
      "--fin-layout-toast": "480px",
      "--fin-layout-toast-offset": "24px",
      "--fin-layout-target-min": "24px",
      "--fin-z-header": "20",
      "--fin-z-tooltip": "90",
      "--fin-focus-width": "2px",
      "--fin-focus-offset": "2px",
      "--fin-duration-fast": "140ms",
      "--fin-duration-base": "200ms",
      "--fin-duration-slow": "240ms",
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(normalise(root[name] ?? "missing"), name).toBe(value);
    }
  });
});

type Theme = Record<string, string>;
const themes: [string, Theme][] = [
  ["light", pin.themed.light],
  ["dark", pin.themed.dark],
];
const colour = (theme: Theme, name: string): Rgba => {
  const value = theme[`--fin-color-${name}`];
  if (value === undefined) throw new Error(`no --fin-color-${name}`);
  return parseColour(value);
};
const GROUNDS = ["bg", "surface", "surface-raised", "surface-subtle"];
const TONES = ["success", "warning", "danger", "info", "neutral"];
const HUES = Object.keys(pin.themed.light)
  .map((k) => /^--fin-color-badge-([a-z]+)-fg$/.exec(k)?.[1])
  .filter((h): h is string => h !== undefined);

/** [foreground, background, ground under a translucent background] */
function textPairs(): [string, string, string?][] {
  const pairs: [string, string, string?][] = [];
  for (const fg of ["text-primary", "text-secondary", "text-tertiary"]) {
    for (const bg of GROUNDS) pairs.push([fg, bg]);
  }
  pairs.push(["text-inverse", "surface-inverse"]);
  pairs.push(
    ["on-action-primary", "action-primary"],
    ["on-action-primary", "action-primary-hover"],
  );
  pairs.push(["on-danger-solid", "danger-solid"], ["on-danger-solid", "danger-solid-hover"]);
  for (const ground of ["bg", "surface", "surface-raised"]) {
    for (const fg of ["text-primary", "text-secondary"]) {
      pairs.push([fg, "fill-hover", ground], [fg, "fill-selected", ground]);
    }
    for (const tone of TONES) pairs.push([`status-${tone}-fg`, `status-${tone}-bg`, ground]);
    for (const hue of HUES) pairs.push([`badge-${hue}-fg`, `badge-${hue}-bg`, ground]);
    pairs.push(["status-danger-fg", ground]);
  }
  return pairs;
}

describe("the readers this test relies on", () => {
  it("spells equal values one way", () => {
    expect(normalise(".14s")).toBe("140ms");
    expect(normalise("cubic-bezier(.23, 1, .32,1)")).toBe("cubic-bezier(0.23, 1, 0.32, 1)");
    expect(normalise("-.02em")).toBe("-0.02em");
    expect(normalise("#FFFFFF")).not.toBe(normalise("#fafafa"));
  });

  it("measures contrast as WCAG does", () => {
    expect(contrast(parseColour("#000000"), parseColour("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrast(parseColour("#767676"), parseColour("#ffffff"))).toBeCloseTo(4.54, 2);
    const half = over(parseColour("rgb(0 0 0 / 0.5)"), parseColour("#ffffff"));
    expect(Math.round(half.r)).toBe(128);
  });
});

describe("contrast in both themes", () => {
  for (const [name, theme] of themes) {
    it(`passes 4.5:1 for every text pair in ${name}`, () => {
      const failures: string[] = [];
      for (const [fg, bg, ground] of textPairs()) {
        const back =
          ground === undefined ? colour(theme, bg) : over(colour(theme, bg), colour(theme, ground));
        const front = over(colour(theme, fg), back);
        const ratio = contrast(front, back);
        if (ratio < 4.5)
          failures.push(`${fg} on ${bg}${ground ? ` over ${ground}` : ""}: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });

    it(`passes 3:1 for every edge that carries meaning in ${name}`, () => {
      const failures: string[] = [];
      const pairs: [string, string][] = [];
      for (const ground of ["bg", "surface", "surface-raised"]) {
        pairs.push(["focus-ring", ground], ["border-danger", ground], ["danger-solid", ground]);
        pairs.push(["action-primary", ground], ["text-tertiary", ground]);
      }
      for (const [fg, bg] of pairs) {
        const back = colour(theme, bg);
        const ratio = contrast(over(colour(theme, fg), back), back);
        if (ratio < 3) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });
  }
});
