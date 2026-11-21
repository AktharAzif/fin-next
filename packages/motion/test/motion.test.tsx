// The motion pin and the motion layer's rules (AC-UI-02, AC-UI-03, AC-UI-13's static half).
import tokensCss from "@fin/tokens/tokens.css?raw";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import motionCss from "../fin-motion.css?raw";
import pin from "../PIN.json" with { type: "json" };
import { Enter, NavigationBar, Swap, usePrefersReducedMotion } from "../src/index.tsx";
import {
  initialNavigationRun,
  type NavigationRun,
  navigationDraw,
  nextNavigationRun,
} from "../src/navigation-run.ts";
import { glyphsOf, readRules } from "./rules.ts";

const TRANSFORMS = new Set(["translate", "rotate", "scale", "transform"]);
const CARET_OPEN = ':is([aria-expanded="true"], [data-open]) .fin-ico--CaretDown';
const NO_PREFERENCE = "@media (prefers-reduced-motion: no-preference)";

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const NO_COMMENTS = motionCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** The stylesheet with the no-preference block cut out: what runs under reduced motion too. */
function everySetting(css: string): string {
  const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  if (start === -1) throw new Error("no no-preference block");
  let depth = 0;
  let i = css.indexOf("{", start);
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) break;
  }
  return css.slice(0, start) + css.slice(i + 1);
}

describe("fin-motion.css", () => {
  it("hashes to PIN.json's SHA-256 (AC-UI-03)", async () => {
    expect(new TextEncoder().encode(motionCss).byteLength).toBe(pin.bytes);
    expect(await sha256(motionCss)).toBe(pin.sha256);
  });

  it("has no brand swap: the rail's mark is only a link (AC-UI-03)", () => {
    expect(motionCss).not.toContain("fin-brand-swap");
  });

  it("reads only --fin-* variables that tokens.css declares (AC-UI-02)", () => {
    const declared = new Set([...tokensCss.matchAll(/(--fin-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...NO_COMMENTS.matchAll(/var\((--fin-[a-z0-9-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  it("declares no --fin-* variable of its own, and no colour value", () => {
    expect(NO_COMMENTS).not.toMatch(/--fin-[a-z0-9-]+\s*:/);
    expect(NO_COMMENTS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(NO_COMMENTS).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/);
  });

  it("moves, turns, scales and shimmers only when no reduced motion is asked for", () => {
    const always = everySetting(NO_COMMENTS);
    const animations = [...always.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(new Set(animations)).toEqual(new Set(["fin-fade-in", "fin-fade-out", "fin-turn"]));
    const rules = readRules(always);
    expect(rules.some((r) => r.selector.includes(".fin-enter"))).toBe(true);
    // In every setting, the one transform is CaretDown's open state, which is drawn, not animated.
    const transforms = rules.flatMap((r) =>
      [...r.declarations]
        .filter(([name]) => TRANSFORMS.has(name))
        .map(([name, value]) => `${r.selector} { ${name}: ${value} }`),
    );
    expect(transforms).toEqual([`${CARET_OPEN} { rotate: 180deg }`]);
    const transitions = rules.flatMap((r) =>
      [...r.declarations]
        .filter(([name]) => name.startsWith("transition"))
        .map(([name, value]) => `${r.selector} { ${name}: ${value} }`),
    );
    expect(transitions).toEqual([
      ".fin-ico--duo > path { transition: opacity var(--fin-duration-fast) var(--fin-ease-out) }",
    ]);
    // The shimmer's keyframes are defined for every setting; only no-preference runs them.
    for (const rule of rules) {
      expect(rule.selector).not.toContain("[data-skeleton]");
      expect([...rule.declarations.values()].join(";")).not.toContain("fin-sweep");
    }
  });

  it("caps the fades of every setting at the fast duration", () => {
    const always = everySetting(NO_COMMENTS);
    for (const m of always.matchAll(/animation:\s*fin-fade-(?:in|out)\s+(\S+)/g)) {
      expect(m[1]).toBe("var(--fin-duration-fast)");
    }
  });

  it("keeps spinners turning in every setting", () => {
    expect(everySetting(NO_COMMENTS)).toMatch(
      /\.fin-ico--ArrowClockwise\.fin-ico-spin,\s*\[aria-busy="true"\] \.fin-ico--ArrowClockwise \{\s*animation: fin-turn var\(--fin-motion-spin\) linear infinite;/,
    );
  });

  it("shimmers every skeleton shape under fin-shimmer", () => {
    expect(NO_COMMENTS).toMatch(
      /\.fin-shimmer \[data-skeleton\] \{[^}]*fin-sweep 1\.6s linear infinite/,
    );
  });

  it("names every class of spec 06 §5.1", () => {
    for (const name of [
      "fin-enter",
      "fin-swap",
      "fin-swap-out",
      "fin-progress",
      "fin-shimmer",
      "fin-ico-spin",
    ]) {
      expect(NO_COMMENTS).toContain(`.${name}`);
    }
  });
});

describe("the glyphs' motion", () => {
  const rules = readRules(motionCss);
  /** The rules that set a transform or a transition (the stylesheet is unlayered: they win). */
  const moving = rules.filter((r) =>
    [...r.declarations.keys()].some(
      (name) => TRANSFORMS.has(name) || name.startsWith("transition"),
    ),
  );
  /** The glyphs whose rules set `property` (a custom property or a declaration) in `context`. */
  const setting = (property: string, context = NO_PREFERENCE) =>
    new Set(
      rules
        .filter((r) => r.context === context && r.declarations.has(property))
        .flatMap((r) => glyphsOf(r.selector)),
    );
  const hovered = (r: { selector: string }) => r.selector.includes(":hover");
  const sorted = (names: Iterable<string>) => [...names].sort();

  it("never styles every icon: only named glyphs get a transform or a transition", () => {
    for (const rule of moving) {
      expect(rule.selector, rule.selector).not.toMatch(/\.fin-ico(?![\w-])/);
      // The duo glyph's paths cross-fade by opacity; every other rule names its glyphs.
      if (!rule.selector.endsWith("> path")) {
        expect(glyphsOf(rule.selector).length, rule.selector).toBeGreaterThan(0);
      }
    }
  });

  it("moves each glyph only in the property that moves it, on hover and on the way back", () => {
    const move = setting("--ico-move");
    const turn = setting("--ico-turn");
    const grow = setting("--ico-grow");
    expect(move.size).toBe(33);
    expect(turn.size).toBe(17);
    expect(sorted(grow)).toEqual(["CaretUpDown"]);
    for (const glyph of move) expect(turn.has(glyph) || grow.has(glyph), glyph).toBe(false);
    for (const glyph of turn) expect(grow.has(glyph), glyph).toBe(false);

    const onHover = (property: string) =>
      new Set(
        moving
          .filter((r) => r.context === NO_PREFERENCE && hovered(r) && r.declarations.has(property))
          .flatMap((r) => glyphsOf(r.selector)),
      );
    expect(sorted(onHover("translate"))).toEqual(sorted(move));
    expect(sorted(onHover("rotate"))).toEqual(sorted(turn));
    expect(sorted(onHover("scale"))).toEqual(sorted(grow));
    for (const rule of moving.filter(hovered)) {
      const set = [...rule.declarations.keys()].filter((name) => TRANSFORMS.has(name));
      expect(set.length, rule.selector).toBeLessThanOrEqual(1);
    }

    const transitioned = (property: string) =>
      new Set(
        moving
          .filter(
            (r) =>
              r.context === NO_PREFERENCE &&
              (r.declarations.get("transition") ?? "").startsWith(`${property} `),
          )
          .flatMap((r) => glyphsOf(r.selector)),
      );
    expect(sorted(transitioned("translate"))).toEqual(sorted(move));
    expect(sorted(transitioned("rotate"))).toEqual(sorted([...turn, "CaretDown"]));
    expect(sorted(transitioned("scale"))).toEqual(sorted(grow));
  });

  it("leaves Copy, Check and the still glyphs to their own utilities (CopyField's cross-fade)", () => {
    const touched = new Set(moving.flatMap((r) => glyphsOf(r.selector)));
    for (const glyph of ["Copy", "Check", "BookOpen", "Pause", "GoogleLogo", "QrCode", "Power"]) {
      expect(touched.has(glyph), glyph).toBe(false);
    }
    for (const still of ["Copy", "BookOpen", "Pause", "GoogleLogo", "QrCode", "Power"]) {
      expect(NO_COMMENTS, still).not.toContain(`.fin-ico--${still}`);
    }
  });

  it("turns CaretDown while its control is open, in every setting, animated only under no-preference", () => {
    const open = rules.filter((r) => r.selector === CARET_OPEN);
    expect(open.map((r) => [r.context, Object.fromEntries(r.declarations)])).toEqual([
      ["", { rotate: "180deg" }],
      [NO_PREFERENCE, { "transition-duration": "var(--fin-duration-base)" }],
    ]);
    expect(setting("--ico-turn").has("CaretDown")).toBe(false);
  });
});

describe("the React helpers", () => {
  it("Enter wraps its content in fin-enter", () => {
    const html = renderToStaticMarkup(
      <Enter keyBy="/customers" className="grid">
        <p>Customers</p>
      </Enter>,
    );
    expect(html).toBe('<div class="fin-enter grid"><p>Customers</p></div>');
  });

  it("Swap shows the fallback until ready, then fades the content in", () => {
    const fallback = <span data-skeleton="">…</span>;
    expect(
      renderToStaticMarkup(
        <Swap ready={false} fallback={fallback}>
          Done
        </Swap>,
      ),
    ).toBe('<span data-skeleton="">…</span>');
    expect(
      renderToStaticMarkup(
        <Swap ready fallback={fallback}>
          Done
        </Swap>,
      ),
    ).toBe('<div class="fin-swap">Done</div>');
  });

  it("NavigationBar is a named progress bar while pending, and nothing before the first navigation", () => {
    expect(renderToStaticMarkup(<NavigationBar pending={false} />)).toBe("");
    expect(renderToStaticMarkup(<NavigationBar pending className="h-0.5" />)).toBe(
      '<div role="progressbar" aria-label="Loading" class="fin-progress h-0.5"></div>',
    );
  });

  it("NavigationBar fades out after every navigation, the first load's included", () => {
    /** What the bar draws through a life of `pending` values: its kind and React key each time. */
    const life = (first: boolean, ...then: boolean[]) => {
      let state = initialNavigationRun(first);
      const seen = [state];
      for (const pending of then) {
        state = nextNavigationRun(state, pending);
        seen.push(state);
      }
      return seen.map((s: NavigationRun) => {
        const draw = navigationDraw(s);
        return draw.kind === "nothing" ? "nothing" : `${draw.kind} ${draw.key}`;
      });
    };
    // Mounted during the cold load: that load ends in the fade-out, and the next one is a new run
    // with a new key, so its bar mounts afresh and grows again.
    expect(life(true, false, true, false)).toEqual([
      "bar 1",
      "fade-out 1-out",
      "bar 2",
      "fade-out 2-out",
    ]);
    // Mounted idle: nothing until the first navigation; a pending spell keeps one bar.
    expect(life(false, false, true, true, false)).toEqual([
      "nothing",
      "nothing",
      "bar 1",
      "bar 1",
      "fade-out 1-out",
    ]);
    const idle = initialNavigationRun(false);
    expect(nextNavigationRun(idle, false)).toBe(idle);
  });

  it("usePrefersReducedMotion is false on the server", () => {
    function Probe() {
      return <i>{String(usePrefersReducedMotion())}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
  });
});
