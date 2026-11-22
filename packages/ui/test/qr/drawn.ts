// Reads a QR code drawn as SVG back into modules, for the unit tests and the Playwright specs (the
// kit's and the console's): the viewBox gives the tile, each rect a run of dark modules in whole
// CSS pixels. It refuses a drawing that holds anything but rects of one module's height on the
// module grid, so a test that reads it also proves the code is plain SVG elements on whole pixels.
import type { Locator } from "@playwright/test";
import { type Decoded, decodeQr } from "./decode.ts";

/** A child element of the drawing, as its attributes read. */
export interface DrawnElement {
  readonly tag: string;
  readonly x: string | null;
  readonly y: string | null;
  readonly width: string | null;
  readonly height: string | null;
}

export interface Drawn {
  /** Modules on a side. */
  readonly size: number;
  /** The tile's side, in CSS pixels (the viewBox's, and the drawing's width and height). */
  readonly tile: number;
  /** A module's side, in CSS pixels. */
  readonly module: number;
  /** From the tile's edge to the symbol's, in CSS pixels. */
  readonly offset: number;
  /** Row by row, 1 for a dark module. */
  readonly modules: Uint8Array;
}

function whole(value: string | null, what: string): number {
  const n = Number(value);
  if (value === null || !Number.isInteger(n) || n < 0) {
    throw new Error(`the QR code's ${what} is ${value ?? "missing"}, not a whole pixel`);
  }
  return n;
}

/** Rebuilds the modules from a drawing's viewBox, size and children. */
export function modulesFromDrawing(
  viewBox: string,
  width: string | null,
  height: string | null,
  children: readonly DrawnElement[],
): Drawn {
  const [x0, y0, w, h] = viewBox.split(" ").map(Number);
  if (x0 !== 0 || y0 !== 0 || w !== h || w === undefined || !Number.isInteger(w)) {
    throw new Error(`unexpected viewBox ${viewBox}`);
  }
  if (width !== String(w) || height !== String(w)) {
    throw new Error(`the drawing is ${width} by ${height}, not its viewBox's ${w}px`);
  }
  const rects = children.map((child) => {
    if (child.tag !== "rect") throw new Error(`the QR code holds a <${child.tag}>, not a rect`);
    return {
      x: whole(child.x, "x"),
      y: whole(child.y, "y"),
      width: whole(child.width, "width"),
      height: whole(child.height, "height"),
    };
  });
  const first = rects[0];
  if (first === undefined) throw new Error("the QR code draws no module");
  const module = first.height;
  const offset = Math.min(...rects.map((rect) => rect.x));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const size = (right - offset) / module;
  if (module < 1 || !Number.isInteger(size) || Math.min(...rects.map((r) => r.y)) !== offset) {
    throw new Error("the QR code's rects are not on one module grid");
  }
  const modules = new Uint8Array(size * size);
  for (const rect of rects) {
    const column = (rect.x - offset) / module;
    const row = (rect.y - offset) / module;
    const span = rect.width / module;
    if (
      rect.height !== module ||
      ![column, row, span].every(Number.isInteger) ||
      row >= size ||
      column + span > size
    ) {
      throw new Error("the QR code holds a rect off its module grid");
    }
    for (let k = 0; k < span; k++) modules[row * size + column + k] = 1;
  }
  return { size, tile: w, module, offset, modules };
}

export async function readDrawnQr(svg: Locator): Promise<Drawn> {
  const drawn = await svg.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    viewBox: element.getAttribute("viewBox") ?? "",
    width: element.getAttribute("width"),
    height: element.getAttribute("height"),
    children: [...element.querySelectorAll("*")].map((child) => ({
      tag: child.tagName.toLowerCase(),
      x: child.getAttribute("x"),
      y: child.getAttribute("y"),
      width: child.getAttribute("width"),
      height: child.getAttribute("height"),
    })),
  }));
  if (drawn.tag !== "svg") throw new Error(`the QR code is a <${drawn.tag}>, not an <svg>`);
  return modulesFromDrawing(drawn.viewBox, drawn.width, drawn.height, drawn.children);
}

/** Reads and decodes a drawn QR code. */
export async function scanDrawnQr(svg: Locator): Promise<Decoded> {
  const { size, modules } = await readDrawnQr(svg);
  return decodeQr(size, modules);
}
