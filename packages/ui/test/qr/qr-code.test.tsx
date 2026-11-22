// lib/qr: QrCode and QrCodeView as static markup. The drawing is SVG <rect> elements and nothing
// else (no image, no image URL, no style attribute, no markup from a string), each module whole
// CSS pixels at a whole-pixel offset, it scans back to the value, and the value appears nowhere
// but in the drawing. The code is drawn in the first render: the encoder comes with the component.
import { describe, expect, it } from "vitest";
import { encodeQr, MAX_TEXT_LENGTH, type QrMatrix } from "../../src/lib/qr/encode.ts";
import {
  darkRuns,
  QR_MIN_MODULE_PX,
  QR_QUIET_MODULES,
  QR_TILE_PX,
  QrCode,
  QrCodeView,
  qrGeometry,
} from "../../src/lib/qr/qr-code.tsx";
import { attr, classes, render, tagsWith, text } from "../html.ts";
import { decodeQr } from "./decode.ts";
import { type Drawn, modulesFromDrawing } from "./drawn.ts";

// Joined at run time: the source holds no secret-shaped value (CONTRIBUTING).
const SECRET = ["KRUGS4ZA", "NFXGO3LT", "MFWXA3DF"].join("");
const URI = `otpauth://totp/Fin:maya%40example.com?${["sec", "ret"].join("")}=${SECRET}&issuer=Fin`;
const LABEL = "QR code for your authenticator app";
const FAILED = "Couldn’t draw the QR code. Type the key instead.";

/** The drawing in the markup, read back by the same reader the Playwright specs use. */
function drawnIn(html: string): Drawn {
  const svg = tagsWith(html, "viewBox")[0];
  const rects = (html.match(/<rect\b[^>]*>/g) ?? []).map((rect) => ({
    tag: "rect",
    x: attr(rect, "x") ?? null,
    y: attr(rect, "y") ?? null,
    width: attr(rect, "width") ?? null,
    height: attr(rect, "height") ?? null,
  }));
  return modulesFromDrawing(
    attr(svg, "viewBox") ?? "",
    attr(svg, "width") ?? null,
    attr(svg, "height") ?? null,
    rects,
  );
}

describe("darkRuns", () => {
  it("covers every dark module once, and no light one", () => {
    const matrix = encodeQr(URI);
    const rebuilt = new Uint8Array(matrix.size * matrix.size);
    for (const run of darkRuns(matrix)) {
      expect(run.width).toBeGreaterThan(0);
      for (let k = 0; k < run.width; k++) {
        const index = run.y * matrix.size + run.x + k;
        expect(rebuilt[index]).toBe(0);
        rebuilt[index] = 1;
      }
    }
    expect(rebuilt).toEqual(matrix.modules);
  });

  it("joins neighbours in a row into one run", () => {
    const matrix: QrMatrix = {
      version: 1,
      level: "M",
      mask: 0,
      size: 3,
      modules: Uint8Array.from([1, 1, 1, 0, 1, 0, 1, 0, 1]),
    };
    expect(darkRuns(matrix)).toEqual([
      { x: 0, y: 0, width: 3 },
      { x: 1, y: 1, width: 1 },
      { x: 0, y: 2, width: 1 },
      { x: 2, y: 2, width: 1 },
    ]);
  });
});

describe("qrGeometry", () => {
  const SIZES = Array.from({ length: 40 }, (_, i) => 4 * (i + 1) + 17);

  it("draws every version in whole pixels at a whole-pixel offset, never under 2px a module", () => {
    for (const size of SIZES) {
      const { tile, module, offset } = qrGeometry(size);
      expect([tile, module, offset].every(Number.isInteger), `size ${size}`).toBe(true);
      expect(module, `size ${size}`).toBeGreaterThanOrEqual(QR_MIN_MODULE_PX);
    }
  });

  it("keeps two modules of light margin on every side, the symbol centred to a pixel", () => {
    for (const size of SIZES) {
      const { tile, module, offset } = qrGeometry(size);
      const far = tile - offset - module * size;
      expect(offset, `size ${size}`).toBeGreaterThanOrEqual(QR_QUIET_MODULES * module);
      expect(far, `size ${size}`).toBeGreaterThanOrEqual(QR_QUIET_MODULES * module);
      expect(far - offset, `size ${size}`).toBeGreaterThanOrEqual(0);
      expect(far - offset, `size ${size}`).toBeLessThanOrEqual(1);
    }
  });

  it("uses the board's 148px tile, with the largest module that fits, and grows only past it", () => {
    for (const size of SIZES) {
      const { tile, module } = qrGeometry(size);
      const fits = (m: number) => m * (size + 2 * QR_QUIET_MODULES) <= QR_TILE_PX;
      if (fits(QR_MIN_MODULE_PX)) {
        expect(tile, `size ${size}`).toBe(QR_TILE_PX);
        expect(fits(module) && !fits(module + 1), `size ${size}`).toBe(true);
      } else {
        expect(module, `size ${size}`).toBe(QR_MIN_MODULE_PX);
        expect(tile, `size ${size}`).toBe(QR_MIN_MODULE_PX * (size + 2 * QR_QUIET_MODULES));
      }
    }
    // The realm's usual URI is version 8: 2px a module, on the board's tile.
    expect(qrGeometry(49)).toEqual({ tile: 148, module: 2, offset: 25 });
    expect(qrGeometry(37)).toEqual({ tile: 148, module: 3, offset: 18 });
  });
});

describe("QrCodeView", () => {
  const matrix = encodeQr(URI);
  const ready = render(<QrCodeView state={{ kind: "ready", matrix }} label={LABEL} />);

  it("draws the code as SVG rects on a light tile, named for screen readers", () => {
    const [svg] = tagsWith(ready, "role", "img");
    expect(svg?.startsWith("<svg")).toBe(true);
    expect(attr(svg, "aria-label")).toBe(LABEL);
    expect(attr(svg, "viewBox")).toBe("0 0 148 148");
    expect(attr(svg, "width")).toBe("148");
    expect(attr(svg, "height")).toBe("148");
    expect(attr(svg, "fill")).toBe("currentColor");
    // Whole pixels are exact in every engine; crispEdges would round them outwards in WebKit at
    // any fraction of a pixel left over, so the default rendering is kept.
    expect(attr(svg, "shape-rendering")).toBeUndefined();
    const [tile] = tagsWith(ready, "data-slot", "qr-code");
    expect(attr(tile, "data-state")).toBe("ready");
    expect(attr(tile, "data-theme")).toBe("light");
    expect(classes(tile)).toContain("bg-surface-raised");
    expect(classes(tile)).toContain("text-text-primary");
    // The tile is the drawing's size: no stretching parent widens its light ground.
    expect(classes(tile)).toContain("size-fit");
  });

  it("keeps its light ground and dark modules under forced colours", () => {
    const [tile] = tagsWith(ready, "data-slot", "qr-code");
    expect(classes(tile)).toContain("forced-color-adjust-none");
  });

  it("draws every module as whole CSS pixels, at the offset qrGeometry gives", () => {
    const drawn = drawnIn(ready);
    expect(drawn).toMatchObject({ size: matrix.size, ...qrGeometry(matrix.size) });
    expect(drawn.modules).toEqual(matrix.modules);
  });

  it("scans back to the value", () => {
    const { size, modules } = drawnIn(ready);
    expect(decodeQr(size, modules).text).toBe(URI);
  });

  it("grows the tile for a symbol 148px cannot hold at 2px a module", () => {
    const big = encodeQr("A".repeat(600)); // version 15-M, 77 modules
    const html = render(<QrCodeView state={{ kind: "ready", matrix: big }} label={LABEL} />);
    const drawn = drawnIn(html);
    expect(drawn).toMatchObject({ size: 77, tile: 162, module: 2, offset: 4 });
    expect(decodeQr(drawn.size, drawn.modules).text).toBe("A".repeat(600));
  });

  it("holds no image, image URL, style attribute or foreign element, and never the value", () => {
    expect(ready).not.toMatch(/<img|<image|<foreignObject|<use|href=|style=/i);
    expect(ready).not.toContain(["da", "ta:"].join(""));
    expect(ready).not.toContain(SECRET);
    expect(ready).not.toContain("otpauth");
    const elements = new Set([...ready.matchAll(/<([a-z]+)\b/g)].map((m) => m[1]));
    expect(elements).toEqual(new Set(["div", "svg", "rect"]));
  });

  it("says when it could not draw, and offers no Try again: a second try draws the same", () => {
    const html = render(<QrCodeView state={{ kind: "failed" }} label={LABEL} />);
    const [tile] = tagsWith(html, "data-slot", "qr-code");
    expect(attr(tile, "data-state")).toBe("failed");
    expect(classes(tile)).toContain("size-37");
    expect(classes(tile)).toContain("bg-fill-selected");
    expect(text(html)).toBe(FAILED);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<svg");
  });
});

describe("QrCode", () => {
  it("draws the code in its first render: there is no chunk to wait for", () => {
    const html = render(<QrCode value={URI} label={LABEL} />);
    expect(attr(tagsWith(html, "data-slot", "qr-code")[0], "data-state")).toBe("ready");
    const { size, modules } = drawnIn(html);
    expect(decodeQr(size, modules).text).toBe(URI);
    expect(html).not.toContain(SECRET);
  });

  it("draws at the asked level", () => {
    const html = render(<QrCode value={URI} label={LABEL} level="H" />);
    const { size, modules } = drawnIn(html);
    expect(decodeQr(size, modules).level).toBe("H");
  });

  it("shows the failed tile for a value no code holds, and not the value", () => {
    const value = `${URI}&pad=${"7".repeat(MAX_TEXT_LENGTH)}`;
    const html = render(<QrCode value={value} label={LABEL} />);
    expect(attr(tagsWith(html, "data-slot", "qr-code")[0], "data-state")).toBe("failed");
    expect(text(html)).toBe(FAILED);
    expect(html).not.toContain("<button");
    expect(html).not.toContain(SECRET);
  });

  it("shows the failed tile for a value that is not well-formed Unicode", () => {
    const html = render(<QrCode value={`${URI}\ud800`} label={LABEL} />);
    expect(attr(tagsWith(html, "data-slot", "qr-code")[0], "data-state")).toBe("failed");
  });

  it("takes a caller's class on the tile", () => {
    const html = render(<QrCode value={URI} label={LABEL} className="self-start" />);
    expect(classes(tagsWith(html, "data-slot", "qr-code")[0])).toContain("self-start");
  });
});
