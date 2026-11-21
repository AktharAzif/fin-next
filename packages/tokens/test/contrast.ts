// WCAG 2.2 contrast for the token values: sRGB hex and `rgb(r g b / a)`, with translucent colours
// composited over the surface they sit on.

export type Rgba = { r: number; g: number; b: number; a: number };

export function parseColour(value: string): Rgba {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(v);
  if (hex?.[1] !== undefined) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgb !== null) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  throw new Error(`not a colour this test reads: ${value}`);
}

/**
 * The colour of a shadow token's 1px ring (`0px 0px 0px 1px <colour>`), the edge a button or a
 * card draws with its shadow; throws when the shadow has no such layer.
 */
export function ringColour(shadow: string): string {
  for (const layer of shadow.split(",")) {
    const ring = /^0(?:px)?\s+0(?:px)?\s+0(?:px)?\s+1px\s+(.+)$/.exec(layer.trim());
    if (ring?.[1] !== undefined) return ring[1].trim();
  }
  throw new Error(`no 1px ring in ${shadow}`);
}

/** `top` painted over an opaque `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  if (under.a !== 1) throw new Error("the ground must be opaque");
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The contrast ratio of two opaque colours, from 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
