// The icon set (AC-UI-04): every glyph the motion layer and the shells name exists in bold and fill;
// createIcon's markup; the duo glyph; the cues' per-instance ids; the brand marks.
import motionCss from "@fin/motion/fin-motion.css?raw";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { flagArt, networkArt, tokenArt } from "../src/cues.ts";
import * as named from "../src/icons.ts";
import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  createIcon,
  FinLockup,
  FinMark,
  FlagArt,
  flagCodes,
  GlobeArt,
  GoogleMark,
  glyphNames,
  glyphs,
  HouseIcon,
  Icon,
  NetworkArt,
  networkCodes,
  TokenArt,
  tokenCodes,
} from "../src/index.ts";
import type { SvgNode } from "../src/svg-node.ts";

/** The glyphs spec 06 §4.2 and §4.3 give the sidebars, the header menus and the edge toggle. */
const SHELL_GLYPHS = [
  "House",
  "Users",
  "Bank",
  "ArrowsLeftRight",
  "Key",
  "WebhooksLogo",
  "ListBullets",
  "Flask",
  "ClockCounterClockwise",
  "GearSix",
  "BookOpen",
  "ArrowUpRight",
  "Rocket",
  "ListChecks",
  "Buildings",
  "ChatCircleText",
  "FileText",
  "UsersThree",
  "Power",
  "CaretUpDown",
  "Plus",
  "ShieldCheck",
  "Sun",
  "Moon",
  "Desktop",
  "SignOut",
  "UserCircle",
  "LockSimple",
  "CaretLeft",
  "CaretRight",
  "CaretDown",
  "List",
  "X",
];

/** The glyphs the header names as never moving: they have no selector of their own. */
const STILL = ["BookOpen", "Copy", "Pause", "GoogleLogo", "QrCode", "Power"];

/** Every glyph fin-motion.css styles, and the still ones its header lists. */
function motionGlyphs(): string[] {
  const names = new Set<string>(STILL);
  for (const m of motionCss.matchAll(/\.fin-ico--([A-Z][A-Za-z]*)/g)) if (m[1]) names.add(m[1]);
  return [...names].sort();
}

it("reads the still glyphs from the motion layer's header", () => {
  const header = /\/\*([\s\S]*?)\*\//.exec(motionCss)?.[1] ?? "";
  const still = header.slice(header.indexOf(" still "), header.indexOf("The edge toggle"));
  for (const name of STILL) expect(still).toContain(name);
});

describe("the glyph set", () => {
  it("has every glyph the motion layer names, in bold and fill", () => {
    const named = motionGlyphs();
    expect(named.length).toBeGreaterThan(50);
    const missing = named.filter((n) => !(n in glyphs));
    expect(missing).toEqual([]);
    for (const name of named) {
      const g = glyphs[name as keyof typeof glyphs];
      expect(g.bold.length, `${name} bold`).toBeGreaterThan(0);
      expect(g.fill.length, `${name} fill`).toBeGreaterThan(0);
    }
  });

  it("has every glyph the shells' icon tables use, in bold and fill", () => {
    for (const name of SHELL_GLYPHS) {
      const g = glyphs[name as keyof typeof glyphs];
      expect(g, name).toBeDefined();
      expect(g.bold.length * g.fill.length, name).toBeGreaterThan(0);
    }
  });

  it("holds well-formed path data in a 256 box", () => {
    for (const name of glyphNames) {
      for (const d of [...glyphs[name].bold, ...glyphs[name].fill]) {
        expect(d, name).toMatch(/^[Mm][-0-9.,\sA-Za-z]+$/);
        expect(d, name).not.toMatch(/[<>"']/);
      }
    }
  });

  it("gives every glyph a named component", () => {
    for (const name of glyphNames) {
      const component = (named as Record<string, { glyph?: string }>)[`${name}Icon`];
      expect(component?.glyph, name).toBe(name);
    }
    expect(Object.keys(named).length).toBe(glyphNames.length);
  });
});

describe("createIcon", () => {
  it("writes the motion classes, data-icon and aria-hidden", () => {
    const html = renderToStaticMarkup(<HouseIcon />);
    expect(html).toMatch(/^<svg [^>]*class="fin-ico fin-ico--House"/);
    expect(html).toContain('data-icon="House"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="16" height="16" viewBox="0 0 256 256" fill="currentColor"');
    expect(html).toContain('focusable="false"');
    expect(html).not.toContain("style=");
    expect(html).toContain(`<path d="${glyphs.House.bold[0]}"></path>`);
  });

  it("names a titled icon as an image instead of hiding it", () => {
    const html = renderToStaticMarkup(<HouseIcon title="Home" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Home"');
    expect(html).not.toContain("aria-hidden");
  });

  it("draws the fill weight on request, and adds classes after its own", () => {
    const html = renderToStaticMarkup(
      <HouseIcon weight="fill" size={12} className="text-text-tertiary" />,
    );
    expect(html).toContain(`d="${glyphs.House.fill[0]}"`);
    expect(html).toContain('width="12"');
    expect(html).toContain('class="fin-ico fin-ico--House text-text-tertiary"');
  });

  it("draws both weights for the duo glyph and cross-fades by opacity", () => {
    const rest = renderToStaticMarkup(<HouseIcon duo />);
    expect(rest).toContain('class="fin-ico fin-ico--House fin-ico--duo"');
    expect(rest).toContain('data-weight="bold"');
    expect(rest).toContain(`<path d="${glyphs.House.bold[0]}" opacity="1"></path>`);
    expect(rest).toContain(`<path d="${glyphs.House.fill[0]}" opacity="0"></path>`);
    const current = renderToStaticMarkup(<HouseIcon duo current />);
    expect(current).toContain('data-weight="fill"');
    expect(current).toContain(`<path d="${glyphs.House.bold[0]}" opacity="0"></path>`);
    expect(current).toContain(`<path d="${glyphs.House.fill[0]}" opacity="1"></path>`);
  });

  it("spins only a busy ArrowClockwise", () => {
    expect(renderToStaticMarkup(<ArrowClockwiseIcon busy />)).toContain(
      'class="fin-ico fin-ico--ArrowClockwise fin-ico-spin"',
    );
    expect(renderToStaticMarkup(<CaretDownIcon busy />)).not.toContain("fin-ico-spin");
  });

  it("draws by name with Icon, the same as the named component", () => {
    expect(renderToStaticMarkup(<Icon name="Key" />)).toBe(
      renderToStaticMarkup(createIcon("Key")({})),
    );
  });
});

function walk(nodes: readonly SvgNode[], visit: (n: SvgNode) => void) {
  for (const n of nodes) {
    visit(n);
    walk(n.c, visit);
  }
}

describe("the cues", () => {
  const all = [...Object.values(flagArt), ...Object.values(tokenArt), ...Object.values(networkArt)];

  it("carry no script, handler, style or outside reference", () => {
    for (const art of all) {
      walk(art.children, (n) => {
        expect(["script", "foreignObject", "image", "use", "a"]).not.toContain(n.t);
        for (const [k, v] of Object.entries(n.a)) {
          expect(k).not.toMatch(/^on|^style$|href/i);
          expect(v).not.toMatch(/javascript:|https?:|data:/);
        }
      });
    }
  });

  it("give every instance its own ids, and point every reference at one of them", () => {
    const html = renderToStaticMarkup(
      <>
        <FlagArt code="US" />
        <FlagArt code="US" />
      </>,
    );
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    for (const m of html.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1]);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
  });

  it("render every flag, token and network, hidden from assistive technology", () => {
    for (const code of flagCodes) {
      expect(renderToStaticMarkup(<FlagArt code={code} size={20} />)).toMatch(
        /^<svg [^>]*width="20" height="20"[^>]*aria-hidden="true"/,
      );
    }
    for (const code of tokenCodes) {
      expect(renderToStaticMarkup(<TokenArt code={code} />)).toContain('aria-hidden="true"');
    }
    for (const code of networkCodes) {
      expect(renderToStaticMarkup(<NetworkArt code={code} />)).toContain('data-cue="network-');
    }
    expect(renderToStaticMarkup(<GlobeArt />)).toContain('data-cue="globe"');
  });
});

describe("the brand marks", () => {
  it("draw the lockup at 18px by default, keeping its proportions", () => {
    const html = renderToStaticMarkup(<FinLockup />);
    expect(html).toContain('height="18"');
    expect(html).toContain('width="105.92"');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("draw the F mark at 24px, as an image when labelled", () => {
    const html = renderToStaticMarkup(<FinMark label="Fin home" />);
    expect(html).toContain('height="24" viewBox="0 0 168 200"');
    expect(html).toContain('width="20.16"');
    expect(html).toContain('role="img" aria-label="Fin home"');
  });

  it("draw the Google mark from its glyph", () => {
    expect(renderToStaticMarkup(<GoogleMark />)).toContain(glyphs.GoogleLogo.bold[0]);
  });
});
