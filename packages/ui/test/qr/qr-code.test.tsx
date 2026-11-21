// lib/qr: QrCode and QrCodeView as static markup. The drawing is SVG <rect> elements and nothing
// else (no image, no image URL, no style attribute, no markup from a string), it scans back to the
// value, and the value appears nowhere but in the drawing.
import { describe, expect, it } from "vitest";
import { encodeQr, type QrMatrix } from "../../src/lib/qr/encode.ts";
import { darkRuns, QrCode, QrCodeView } from "../../src/lib/qr/qr-code.tsx";
import { attr, render, tagsWith, text } from "../html.ts";
import { decodeQr } from "./decode.ts";

// Joined at run time: the source holds no secret-shaped value (CONTRIBUTING).
const SECRET = ["KRUGS4ZA", "NFXGO3LT", "MFWXA3DF"].join("");
const URI = `otpauth://totp/Fin:maya%40example.com?${["sec", "ret"].join("")}=${SECRET}&issuer=Fin`;
const LABEL = "QR code for your authenticator app";

/** The modules the markup's rects draw, rebuilt from their attributes. */
function modulesOf(html: string): { size: number; modules: Uint8Array } {
  const svg = tagsWith(html, "viewBox")[0];
  const size = Number((attr(svg, "viewBox") ?? "").split(" ")[2]);
  const modules = new Uint8Array(size * size);
  for (const rect of html.match(/<rect\b[^>]*>/g) ?? []) {
    const x = Number(attr(rect, "x"));
    const y = Number(attr(rect, "y"));
    const width = Number(attr(rect, "width"));
    expect(attr(rect, "height")).toBe("1");
    for (let k = 0; k < width; k++) modules[y * size + x + k] = 1;
  }
  return { size, modules };
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

describe("QrCodeView", () => {
  const ready = render(
    <QrCodeView state={{ kind: "ready", matrix: encodeQr(URI) }} label={LABEL} />,
  );

  it("draws the code as SVG rects on a light tile, named for screen readers", () => {
    const [svg] = tagsWith(ready, "role", "img");
    expect(svg?.startsWith("<svg")).toBe(true);
    expect(attr(svg, "aria-label")).toBe(LABEL);
    expect(attr(svg, "viewBox")).toBe("0 0 37 37");
    expect(attr(svg, "shape-rendering")).toBe("crispEdges");
    expect(attr(svg, "fill")).toBe("currentColor");
    const [tile] = tagsWith(ready, "data-slot", "qr-code");
    expect(attr(tile, "data-state")).toBe("ready");
    expect(attr(tile, "data-theme")).toBe("light");
    expect(attr(tile, "class")).toContain("size-37");
    expect(attr(tile, "class")).toContain("bg-surface-raised");
  });

  it("scans back to the value", () => {
    const { size, modules } = modulesOf(ready);
    expect(decodeQr(size, modules).text).toBe(URI);
  });

  it("holds no image, image URL, style attribute or foreign element, and never the value", () => {
    expect(ready).not.toMatch(/<img|<image|<foreignObject|<use|href=|style=/i);
    expect(ready).not.toContain(["da", "ta:"].join(""));
    expect(ready).not.toContain(SECRET);
    expect(ready).not.toContain("otpauth");
    const elements = new Set([...ready.matchAll(/<([a-z]+)\b/g)].map((m) => m[1]));
    expect(elements).toEqual(new Set(["div", "svg", "rect"]));
  });

  it("shows a placeholder while the encoder loads, and says so", () => {
    const html = render(<QrCodeView state={{ kind: "loading" }} label={LABEL} />);
    const [tile] = tagsWith(html, "data-slot", "qr-code");
    expect(attr(tile, "data-state")).toBe("loading");
    expect(attr(tile, "aria-busy")).toBe("true");
    expect(text(html)).toBe("Loading the QR code");
    expect(tagsWith(html, "data-skeleton")).toHaveLength(1);
    expect(html).not.toContain("<svg");
  });

  it("offers Try again when it could not draw, and keeps the reason for screen readers", () => {
    const html = render(<QrCodeView state={{ kind: "failed" }} label={LABEL} onRetry={() => {}} />);
    const [tile] = tagsWith(html, "data-slot", "qr-code");
    expect(attr(tile, "data-state")).toBe("failed");
    expect(attr(tile, "class")).toContain("bg-fill-selected");
    expect(text(html)).toContain("Couldn’t draw the QR code. Type the key instead.");
    expect(html).toMatch(/<button\b[^>]*>[\s\S]*Try again[\s\S]*<\/button>/);
  });
});

describe("QrCode", () => {
  it("starts on the placeholder until its encoder chunk has loaded", () => {
    const html = render(<QrCode value={URI} label={LABEL} />);
    expect(attr(tagsWith(html, "data-slot", "qr-code")[0], "data-state")).toBe("loading");
    expect(html).not.toContain(SECRET);
  });

  it("takes a caller's class on the tile", () => {
    const html = render(<QrCode value={URI} label={LABEL} className="self-start" />);
    expect(attr(tagsWith(html, "data-slot", "qr-code")[0], "class")).toContain("self-start");
  });
});
