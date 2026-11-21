// The motion pin and the motion layer's rules (AC-UI-02, AC-UI-03, AC-UI-13's static half).
import tokensCss from "@fin/tokens/tokens.css?raw";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import motionCss from "../fin-motion.css?raw";
import pin from "../PIN.json" with { type: "json" };
import { Enter, NavigationBar, Swap, usePrefersReducedMotion } from "../src/index.tsx";

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
    const rules = always.replace(/@keyframes [a-z-]+ \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(rules).toContain(".fin-enter");
    expect(rules).not.toMatch(/\b(?:translate|rotate|scale):/);
    expect(rules).not.toContain("fin-sweep");
    expect(rules).not.toContain("[data-skeleton]");
    expect(always).toMatch(/transition:\s*opacity/);
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

  it("usePrefersReducedMotion is false on the server", () => {
    function Probe() {
      return <i>{String(usePrefersReducedMotion())}</i>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<i>false</i>");
  });
});
