// fonts.css is generated from the font files by scripts/fonts.ts (fin-font-metrics; UI-12: built,
// not ported). It fails when the committed file is not what the tool builds from the committed
// fonts, and checks the tool against what each file and Arial are known to hold.
//
// The comparison is of the whole file, byte for byte: `?raw` hands over the file's text exactly as
// it is on disk (a byte-order mark, a carriage return and trailing white space are all kept), and
// `toBe` compares that whole string with the whole of the tool's output, so no line of the pinned
// file can differ from what the tool writes. `?inline` hands over each font file's exact bytes.
import { describe, expect, it } from "vitest";
import fira400 from "../fonts/fira-mono-latin-400-normal.woff2?inline";
import fira500 from "../fonts/fira-mono-latin-500-normal.woff2?inline";
import inter from "../fonts/inter-latin-wght-normal.woff2?inline";
import fontsCss from "../fonts.css?raw";
import {
  ARIAL,
  averageAdvance,
  buildFonts,
  faceFamily,
  fallbackOverrides,
  readFont,
} from "../scripts/fonts.ts";
import tokensCss from "../tokens.css?raw";

/** The bytes of a base64 data URL. */
function bytes(url: string): Uint8Array {
  const binary = atob(url.slice(url.indexOf(",") + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const FILES = [
  { name: "inter-latin-wght-normal.woff2", bytes: bytes(inter) },
  { name: "fira-mono-latin-400-normal.woff2", bytes: bytes(fira400) },
  { name: "fira-mono-latin-500-normal.woff2", bytes: bytes(fira500) },
];

describe("fonts.css", () => {
  it("is, as a whole and byte for byte, what fin-font-metrics builds from the files in fonts/", async () => {
    expect(fontsCss, "fonts.css is stale: run `pnpm --filter @fin/tokens fonts`").toBe(
      await buildFonts(FILES),
    );
  });

  it("declares each face under a family the tokens' stacks name, the fallback included", () => {
    const stacks = [...tokensCss.matchAll(/--fin-font-(?:sans|display|mono):([^;]*);/g)]
      .map((m) => m[1] ?? "")
      .join(",");
    const declared = [...fontsCss.matchAll(/font-family: "([^"]+)"/g)].map((m) => m[1]);
    expect(declared).toEqual(["Fira Mono", "Fira Mono", "Inter Variable", "Inter Fallback"]);
    for (const family of declared) expect(stacks).toContain(`"${family}"`);
  });

  it("uses relative URLs to the files, never a data: URL", () => {
    const urls = [...fontsCss.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls).toEqual(FILES.map((f) => `"./fonts/${f.name}"`).sort());
  });
});

describe("fin-font-metrics", () => {
  it("reads each file's family, weight and vertical metrics from its own tables", async () => {
    const variable = await readFont(FILES[0]?.bytes ?? new Uint8Array());
    expect(variable).toMatchObject({
      family: "Inter",
      unitsPerEm: 2048,
      weightRange: [100, 900],
      italic: false,
    });
    expect(faceFamily(variable)).toBe("Inter Variable");
    const medium = await readFont(FILES[2]?.bytes ?? new Uint8Array());
    expect(medium).toMatchObject({ unitsPerEm: 1000, weight: 500, weightRange: null });
    expect(faceFamily(medium)).toBe("Fira Mono");
    // A monospace font: every letter has the same advance.
    expect(new Set(Object.values(medium.widths)).size).toBe(1);
  });

  it("matches a fallback on the weighted average advance, and keeps the font's vertical room", async () => {
    // Arial's own average, on its published widths: 0.477em.
    expect(averageAdvance(ARIAL)).toBeCloseTo(0.4775, 4);
    const font = await readFont(FILES[0]?.bytes ?? new Uint8Array());
    const overrides = fallbackOverrides(font, ARIAL);
    const adjust = Number.parseFloat(overrides["size-adjust"]) / 100;
    expect(adjust).toBeCloseTo(averageAdvance(font) / averageAdvance(ARIAL), 4);
    // The adjusted ascent and descent add back up to the font's own, in ems.
    const ascent = (Number.parseFloat(overrides["ascent-override"]) / 100) * adjust;
    const descent = (Number.parseFloat(overrides["descent-override"]) / 100) * adjust;
    expect(ascent).toBeCloseTo(font.ascent / font.unitsPerEm, 3);
    expect(descent).toBeCloseTo(Math.abs(font.descent) / font.unitsPerEm, 3);
  });

  it("refuses a file that is no font", async () => {
    await expect(readFont(new Uint8Array(64))).rejects.toThrow();
  });
});
