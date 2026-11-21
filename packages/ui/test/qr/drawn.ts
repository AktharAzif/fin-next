// Reads a QR code drawn on a page back into modules, for the Playwright specs (the kit's and the
// console's): the SVG's viewBox gives the size, each rect a run of dark modules. It refuses a
// drawing that holds anything but rects of one module's height, so a spec that reads it also
// proves the code is plain SVG elements.
import type { Locator } from "@playwright/test";
import { type Decoded, decodeQr } from "./decode.ts";

export interface Drawn {
  size: number;
  modules: Uint8Array;
}

export async function readDrawnQr(svg: Locator): Promise<Drawn> {
  const drawn = await svg.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    viewBox: element.getAttribute("viewBox") ?? "",
    children: [...element.querySelectorAll("*")].map((child) => ({
      tag: child.tagName.toLowerCase(),
      x: child.getAttribute("x"),
      y: child.getAttribute("y"),
      width: child.getAttribute("width"),
      height: child.getAttribute("height"),
    })),
  }));
  if (drawn.tag !== "svg") throw new Error(`the QR code is a <${drawn.tag}>, not an <svg>`);
  const [x0, y0, width, height] = drawn.viewBox.split(" ").map(Number);
  if (x0 !== 0 || y0 !== 0 || width !== height || width === undefined) {
    throw new Error(`unexpected viewBox ${drawn.viewBox}`);
  }
  const size = width;
  const modules = new Uint8Array(size * size);
  for (const child of drawn.children) {
    if (child.tag !== "rect" || child.height !== "1") {
      throw new Error(`the QR code holds a <${child.tag}> that is not a one-module rect`);
    }
    const x = Number(child.x);
    const y = Number(child.y);
    for (let k = 0; k < Number(child.width); k++) modules[y * size + x + k] = 1;
  }
  return { size, modules };
}

/** Reads and decodes a drawn QR code. */
export async function scanDrawnQr(svg: Locator): Promise<Decoded> {
  const { size, modules } = await readDrawnQr(svg);
  return decodeQr(size, modules);
}
