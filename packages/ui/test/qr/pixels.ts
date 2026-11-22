// Reads a QR code from a screenshot of its tile, for the kit's spec: what the engine painted, pixel
// by pixel, rather than what the markup says. A PNG reader on Web APIs only (DecompressionStream
// reads the zlib stream; no node:* module in a client package, FW-C12), for what every engine's
// screenshot is: 8 bits a channel, grey or RGB with or without alpha, not interlaced.
import type { Drawn } from "./drawn.ts";

export interface Png {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly pixels: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export async function readPng(bytes: Uint8Array): Promise<Png> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (SIGNATURE.some((byte, i) => bytes[i] !== byte)) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.slice(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      channels = CHANNELS[body[9] ?? -1] ?? 0;
      if (body[8] !== 8 || body[12] !== 0 || channels === 0) {
        throw new Error("a PNG this reader does not read: 8 bits a channel, not interlaced");
      }
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const stream = new Blob(data).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const corner = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        predicted = a <= b && a <= c ? left : b <= c ? up : corner;
      } else if (filter !== 0) throw new Error(`a PNG row with filter ${filter}`);
      pixels[y * stride + x] = ((raw[line + x] ?? 0) + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/** A pixel's lightness, 0 (black) to 255 (white), by the Rec. 709 weights. */
export function lightness(png: Png, x: number, y: number): number {
  const at = (y * png.width + x) * png.channels;
  const [r, g, b] =
    png.channels < 3
      ? [png.pixels[at] ?? 0, png.pixels[at] ?? 0, png.pixels[at] ?? 0]
      : [png.pixels[at] ?? 0, png.pixels[at + 1] ?? 0, png.pixels[at + 2] ?? 0];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface ScreenReading {
  /** The modules as painted, each read from the pixel at its centre. */
  readonly modules: Uint8Array;
  /** Pixels of the symbol painted the other shade from their module's. */
  readonly strayPixels: number;
  /** Pixels of the light margin (one module round the symbol) that are not light. */
  readonly darkMargin: number;
  /** The share of the symbol's pixels painted dark, and the share of its modules that are. */
  readonly paintedDark: number;
  readonly modulesDark: number;
}

/** A pixel of an image, from its top left. */
export interface PixelAt {
  readonly x: number;
  readonly y: number;
}

/**
 * Reads the symbol `drawn` describes from a screenshot taken at `scale` device pixels a CSS pixel,
 * its top-left module's top-left pixel at `at`: each module's square of pixels, which should be all
 * dark or all light, and the margin of one module round it, which should be light.
 */
export function readScreenQr(png: Png, drawn: Drawn, scale: number, at: PixelAt): ScreenReading {
  const { size, module } = drawn;
  const side = module * scale;
  const dark = (x: number, y: number) => lightness(png, x, y) < 128;
  const modules = new Uint8Array(size * size);
  let strayPixels = 0;
  let painted = 0;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const want = drawn.modules[row * size + column] === 1;
      const left = at.x + column * side;
      const top = at.y + row * side;
      for (let y = top; y < top + side; y++) {
        for (let x = left; x < left + side; x++) {
          if (dark(x, y)) painted++;
          if (dark(x, y) !== want) strayPixels++;
        }
      }
      const half = Math.floor(side / 2);
      modules[row * size + column] = dark(left + half, top + half) ? 1 : 0;
    }
  }
  let darkMargin = 0;
  const span = size * side;
  for (let y = at.y - side; y < at.y + span + side; y++) {
    for (let x = at.x - side; x < at.x + span + side; x++) {
      const inside = x >= at.x && x < at.x + span && y >= at.y && y < at.y + span;
      if (!inside && dark(x, y)) darkMargin++;
    }
  }
  const all = size * size;
  return {
    modules,
    strayPixels,
    darkMargin,
    paintedDark: painted / (all * side * side),
    modulesDark: drawn.modules.reduce((sum, m) => sum + m, 0) / all,
  };
}

export interface ZoomedReading {
  /** The modules as painted, each read from the pixel at its centre. */
  readonly modules: Uint8Array;
  /** Modules whose centre pixel is the other shade. */
  readonly mismatches: number;
  /** The symbol's mean darkness, 0 (all paper) to 1 (all ink), edges' grey included. */
  readonly meanDark: number;
  /** The share of its modules that are dark. */
  readonly modulesDark: number;
}

/** The paper and the ink the tile draws with (rgb(255, 255, 255) and rgb(10, 10, 10)). */
const PAPER = 255;
const INK = 10;

/**
 * Reads the symbol from a screenshot taken where a CSS pixel is a fraction of device pixels (a
 * zoomed page, a 125% screen), so a module's edges fall between pixels and are painted grey. Where
 * it sits is searched in quarter pixels within 1.5 of `near`: the place whose module centres match
 * the most modules. Each centre pixel lies wholly inside its module, so it is one shade; the mean
 * darkness of every pixel shows whether the engine rounds dark modules outwards.
 */
export function readZoomedQr(png: Png, drawn: Drawn, scale: number, near: PixelAt): ZoomedReading {
  const { size } = drawn;
  const side = drawn.module * scale;
  const sample = (at: PixelAt): Uint8Array => {
    const modules = new Uint8Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const x = Math.floor(at.x + (column + 0.5) * side);
        const y = Math.floor(at.y + (row + 0.5) * side);
        modules[row * size + column] = lightness(png, x, y) < 128 ? 1 : 0;
      }
    }
    return modules;
  };
  let best: { at: PixelAt; modules: Uint8Array; mismatches: number } | null = null;
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const at = { x: near.x + dx / 4, y: near.y + dy / 4 };
      const modules = sample(at);
      const mismatches = modules.reduce((n, m, i) => n + (m === drawn.modules[i] ? 0 : 1), 0);
      if (best === null || mismatches < best.mismatches) best = { at, modules, mismatches };
    }
  }
  if (best === null) throw new Error("nowhere to look");
  let dark = 0;
  let pixels = 0;
  const [left, top] = [Math.ceil(best.at.x), Math.ceil(best.at.y)];
  const [right, bottom] = [
    Math.floor(best.at.x + size * side),
    Math.floor(best.at.y + size * side),
  ];
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      dark += Math.min(1, Math.max(0, (PAPER - lightness(png, x, y)) / (PAPER - INK)));
      pixels++;
    }
  }
  return {
    modules: best.modules,
    mismatches: best.mismatches,
    meanDark: dark / pixels,
    modulesDark: drawn.modules.reduce((sum, m) => sum + m, 0) / (size * size),
  };
}

/**
 * Where the engine painted the symbol: of the pixels within `reach` of `near` (where the layout
 * puts it, which may fall between two pixels for the engine to snap), the one whose module grid
 * matches the most pixels.
 */
export function locateSymbol(
  png: Png,
  drawn: Drawn,
  scale: number,
  near: PixelAt,
  reach = 2,
): PixelAt {
  let best: { at: PixelAt; stray: number } | null = null;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const at = { x: Math.round(near.x) + dx, y: Math.round(near.y) + dy };
      const stray = readScreenQr(png, drawn, scale, at).strayPixels;
      if (best === null || stray < best.stray) best = { at, stray };
    }
  }
  return best?.at ?? { x: Math.round(near.x), y: Math.round(near.y) };
}
