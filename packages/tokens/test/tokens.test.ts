// The token drift test (AC-UI-02): every --fin-* name and value in tokens.css equals the export's
// pin, in each theme, density and motion setting. The contrast test measures every text pair
// against 4.5:1 and every non-text pair against 3:1 in both themes (spec 06 §9); the export's
// pairs below their ratio are listed, word for word, in below-ratio.ts (UR-21).
import { describe, expect, it } from "vitest";
import pin from "../export-pin/tokens.json" with { type: "json" };
import tokensCss from "../tokens.css?raw";
import { BELOW_RATIO } from "./below-ratio.ts";
import { contrast, over, parseColour, type Rgba, ringColour } from "./contrast.ts";
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
const themes: ["light" | "dark", Theme][] = [
  ["light", pin.themed.light],
  ["dark", pin.themed.dark],
];
const GROUNDS = ["bg", "surface", "surface-raised", "surface-subtle"];
const FILLS = ["fill-hover", "fill-selected"];
const TONES = ["success", "warning", "danger", "info", "neutral"];
const HUES = Object.keys(pin.themed.light)
  .map((k) => /^--fin-color-badge-([a-z]+)-fg$/.exec(k)?.[1])
  .filter((h): h is string => h !== undefined);

/** A colour drawn over backgrounds listed from the top one down to an opaque ground. */
type Pair = { front: string; under: string[]; needs: 4.5 | 3 };

/** Every pair spec 06 §9 holds to a ratio, in the export's names. */
function pairs(): Pair[] {
  const list: Pair[] = [];
  const text = (front: string, ...under: string[]) => list.push({ front, under, needs: 4.5 });
  const edge = (front: string, ...under: string[]) => list.push({ front, under, needs: 3 });
  const statusText = TONES.map((tone) => `status-${tone}-fg`);
  const badges = [
    ...TONES.map((tone) => [`status-${tone}-fg`, `status-${tone}-bg`] as const),
    ...HUES.map((hue) => [`badge-${hue}-fg`, `badge-${hue}-bg`] as const),
  ];
  for (const ground of GROUNDS) {
    // Text, and status text (errors, destructive items), on each ground and on the hover and
    // selected fills over it (rows, menu items, list items).
    for (const fg of ["text-primary", "text-secondary", "text-tertiary", ...statusText]) {
      text(fg, ground);
      for (const fill of FILLS) text(fg, fill, ground);
    }
    // Badges, on each ground and in a hovered or selected row over it.
    for (const [fg, bg] of badges) {
      text(fg, bg, ground);
      for (const fill of FILLS) text(fg, bg, fill, ground);
    }
    // Non-text: the focus ring; the borders of controls (fields and checkboxes at rest and
    // hovered, a switch's track, an invalid field, the 1px ring that edges a button and a
    // switch's thumb); the solid fills that mark a control or its state (a primary or danger
    // button, a checked box). Icons that carry meaning take the text and status colours, held to
    // 4.5:1 above. Left out on purpose: text-disabled and disabled borders (WCAG 2.2 exempts
    // inactive controls), and the edges of surfaces and dividers (border, shadow-ring, the
    // popover and overlay rings), which are not controls.
    for (const fg of [
      "focus-ring",
      "border-input",
      "border-input-hover",
      "border-strong",
      "border-danger",
      "shadow-button ring",
      "shadow-button-hover ring",
      "action-primary",
      "danger-solid",
    ]) {
      edge(fg, ground);
    }
  }
  // Text on the inverse and solid colours, and selected text.
  text("text-inverse", "surface-inverse");
  for (const bg of ["action-primary", "action-primary-hover"]) text("on-action-primary", bg);
  for (const bg of ["danger-solid", "danger-solid-hover"]) text("on-danger-solid", bg);
  text("text-primary", "selection");
  return list;
}

/** A colour by its export name (`<name>` for --fin-color-<name>, `<shadow> ring` for a ring). */
function colourOf(theme: Theme, name: string): { value: string; rgba: Rgba } {
  const ring = /^(shadow-[a-z-]+) ring$/.exec(name);
  const token = ring?.[1] !== undefined ? `--fin-${ring[1]}` : `--fin-color-${name}`;
  const declared = theme[token];
  if (declared === undefined) throw new Error(`no ${token}`);
  const value = ring === null ? declared : ringColour(declared);
  return { value, rgba: parseColour(value) };
}

/** The pair, its colours and its ratio when it is below what it needs, else undefined. */
function belowRatio(theme: Theme, pair: Pair): string | undefined {
  const layers = pair.under.map((name) => colourOf(theme, name));
  let back: Rgba | undefined;
  for (const layer of [...layers].reverse()) {
    back = back === undefined ? layer.rgba : over(layer.rgba, back);
  }
  if (back === undefined) throw new Error("a pair needs a ground");
  const front = colourOf(theme, pair.front);
  const ratio = contrast(over(front.rgba, back), back);
  if (ratio >= pair.needs) return undefined;
  const on = pair.under.map((name, i) => `${name} ${layers[i]?.value}`).join(" over ");
  // Rounded down, so a ratio just below the bar never reads as the bar itself.
  const shown = (Math.floor(ratio * 100) / 100).toFixed(2);
  return `${pair.front} ${front.value} on ${on}: ${shown} < ${pair.needs}`;
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

  it("reads the 1px ring of a shadow token", () => {
    expect(ringColour("0px 0px 0px 1px rgb(0 0 0 / 0.1), 0px 1px 2px 0px rgb(0 0 0 / 0.05)")).toBe(
      "rgb(0 0 0 / 0.1)",
    );
    expect(() => ringColour("0px 1px 2px 0px rgb(0 0 0 / 0.05)")).toThrow();
    expect(() => ringColour("none")).toThrow();
  });

  it("composites the layers under a colour from the ground up and reports a pair below its bar", () => {
    const dark = pin.themed.dark as Theme;
    // #7c86ff over (indigo at 30% over white at 9% over #171717): 4.29, rounded down.
    expect(
      belowRatio(dark, {
        front: "badge-indigo-fg",
        under: ["badge-indigo-bg", "fill-selected", "surface"],
        needs: 4.5,
      }),
    ).toBe(
      "badge-indigo-fg #7c86ff on badge-indigo-bg rgb(49 44 133 / 0.3) over fill-selected rgb(255 255 255 / 0.09) over surface #171717: 4.29 < 4.5",
    );
    expect(
      belowRatio(dark, {
        front: "badge-indigo-fg",
        under: ["badge-indigo-bg", "surface"],
        needs: 4.5,
      }),
    ).toBeUndefined();
    expect(belowRatio(pin.themed.light, { front: "border-input", under: ["bg"], needs: 3 })).toBe(
      "border-input #e5e5e5 on bg #ffffff: 1.25 < 3",
    );
  });
});

describe("contrast in both themes (AC-UI-02, spec 06 §9)", () => {
  it("measures the pairs spec 06 §9 names: text, the focus ring and the borders of controls", () => {
    const named = new Set(pairs().map((p) => `${p.front} on ${p.under.join(" over ")}`));
    for (const ground of GROUNDS) {
      for (const front of ["focus-ring", "border-input", "border-input-hover", "border-strong"]) {
        expect(named.has(`${front} on ${ground}`), `${front} on ${ground}`).toBe(true);
      }
      for (const fill of FILLS) {
        for (const front of ["text-tertiary", ...TONES.map((tone) => `status-${tone}-fg`)]) {
          expect(named.has(`${front} on ${fill} over ${ground}`)).toBe(true);
        }
      }
    }
  });

  for (const [name, theme] of themes) {
    it(`holds every pair to its ratio in ${name}, except the export's pairs listed for UR-21`, () => {
      const below = pairs()
        .map((pair) => belowRatio(theme, pair))
        .filter((found): found is string => found !== undefined);
      // A pair missing from the list, a listed pair that passes, or a changed colour or ratio
      // fails here: each is a decision for the design system and the owner, not for this file.
      expect([...below].sort()).toEqual([...BELOW_RATIO[name]].sort());
      expect(new Set(BELOW_RATIO[name]).size).toBe(BELOW_RATIO[name].length);
    });
  }
});
