// A QR reader for the tests (and the console's journey), written separately from the encoder so a
// round trip proves something: it takes a matrix of modules, checks the function patterns, reads
// the format and version information against the standard's published tables (ISO/IEC 18004:2015
// Annex C, Table C.1 and Annex D, Table D.1), finds the data modules from Table E.1's alignment
// rows, removes the mask, reads the codewords in the standard's order, de-interleaves the blocks,
// checks every block's Reed-Solomon syndromes are zero (its own field arithmetic), and parses the
// segments and the padding. It corrects nothing: a symbol it reads is exactly as the standard
// describes it. Only the block table (Table 9) is shared with the encoder; the published capacity
// values and the reference symbols in vectors.ts check that table.
import { blockCount, ecPerBlock, type QrLevel } from "../../src/lib/qr/tables.ts";

export interface Decoded {
  version: number;
  level: QrLevel;
  mask: number;
  mode: "numeric" | "alphanumeric" | "byte";
  text: string;
  /** The data codewords, block by block, de-interleaved. */
  dataBlocks: number[][];
  /** The error correction codewords, block by block. */
  ecBlocks: number[][];
  /** How many modules the function patterns and the format and version areas leave for data. */
  dataModules: number;
}

/** Table C.1: the 32 format information words after masking, by level and then mask 0 to 7. */
export const FORMAT_WORDS: Readonly<Record<QrLevel, readonly number[]>> = {
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
  Q: [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed],
  H: [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b],
};

/** Table D.1: the 18-bit version information words for versions 7 to 40. */
export const VERSION_WORDS: readonly number[] = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d, 0x0f928, 0x10b78, 0x1145d,
  0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9, 0x177ec, 0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a,
  0x1d33f, 0x1ed75, 0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64, 0x27541,
  0x28c69,
];

/** Table E.1: the alignment pattern centres' rows and columns for versions 1 to 40. */
export const ALIGNMENT_ROWS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

// Table 10, as conditions on row i and column j that invert a module.
const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/** Thrown when the matrix is not a symbol the standard allows. */
export class UnreadableSymbol extends Error {
  override name = "UnreadableSymbol";
}

function fail(why: string): never {
  throw new UnreadableSymbol(why);
}

/** Multiplication in GF(256) modulo 0x11d, by shifts (the encoder uses tables). */
function times(a: number, b: number): number {
  let result = 0;
  for (let x = a, y = b; y !== 0; y >>= 1) {
    if (y & 1) result ^= x;
    x = x & 0x80 ? ((x << 1) ^ 0x11d) & 0xff : x << 1;
  }
  return result;
}

/** Whether the block's codeword polynomial is zero at α^0 … α^(ec-1). */
function syndromesZero(block: readonly number[], ec: number): boolean {
  for (let i = 0, alpha = 1; i < ec; i++, alpha = times(alpha, 2)) {
    let value = 0;
    for (const codeword of block) value = times(value, alpha) ^ codeword;
    if (value !== 0) return false;
  }
  return true;
}

/** Reads a symbol given as `size` rows of `size` modules (1 dark, 0 light). */
export function decodeQr(size: number, modules: ArrayLike<number>): Decoded {
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 40) fail("size");
  if (modules.length !== size * size) fail("module count");
  const at = (r: number, c: number) => (modules[r * size + c] === 1 ? 1 : 0);

  // Function patterns, and the map of modules that carry no data.
  const reserved = new Uint8Array(size * size);
  const expect = (r: number, c: number, dark: 0 | 1, what: string) => {
    if (at(r, c) !== dark) fail(`${what} at ${r},${c}`);
    reserved[r * size + c] = 1;
  };
  const reserve = (r: number, c: number) => {
    reserved[r * size + c] = 1;
  };
  const finders: readonly (readonly [number, number])[] = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
  for (const [top, left] of finders) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const col = left + c;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const border = inside && (r === 0 || r === 6 || c === 0 || c === 6);
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        expect(row, col, border || core ? 1 : 0, "finder");
      }
    }
  }
  for (let k = 8; k < size - 8; k++) {
    expect(6, k, k % 2 === 0 ? 1 : 0, "timing");
    expect(k, 6, k % 2 === 0 ? 1 : 0, "timing");
  }
  const centres = ALIGNMENT_ROWS[version - 1] ?? [];
  for (const r of centres) {
    for (const c of centres) {
      const onFinder = (r < 9 && c < 9) || (r < 9 && c > size - 10) || (r > size - 10 && c < 9);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          expect(r + dr, c + dc, ring === 1 ? 0 : 1, "alignment");
        }
      }
    }
  }
  expect(size - 8, 8, 1, "dark module");

  // Format information: both copies, each read most significant bit first, must name one word.
  const copyA: [number, number][] = [];
  for (let c = 0; c <= 8; c++) if (c !== 6) copyA.push([8, c]);
  for (let r = 7; r >= 0; r--) if (r !== 6) copyA.push([r, 8]);
  const copyB: [number, number][] = [];
  for (let r = size - 1; r >= size - 7; r--) copyB.push([r, 8]);
  for (let c = size - 8; c < size; c++) copyB.push([8, c]);
  const word = (cells: [number, number][]) =>
    cells.reduce((value, [r, c]) => {
      reserve(r, c);
      return (value << 1) | at(r, c);
    }, 0);
  const formatA = word(copyA);
  const formatB = word(copyB);
  if (formatA !== formatB) fail("format copies differ");
  let level: QrLevel | null = null;
  let mask = -1;
  for (const [name, words] of Object.entries(FORMAT_WORDS) as [QrLevel, readonly number[]][]) {
    const index = words.indexOf(formatA);
    if (index >= 0) {
      level = name;
      mask = index;
    }
  }
  if (level === null) fail("format word");

  // Version information, from version 7: both 6 by 3 blocks, most significant bit first.
  if (version >= 7) {
    let bottomLeft = 0;
    let topRight = 0;
    for (let i = 17; i >= 0; i--) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      bottomLeft = (bottomLeft << 1) | at(a, b);
      topRight = (topRight << 1) | at(b, a);
      reserve(a, b);
      reserve(b, a);
    }
    if (bottomLeft !== topRight) fail("version copies differ");
    if (bottomLeft !== VERSION_WORDS[version - 7]) fail("version word");
  }

  // The data region's modules in placement order: column pairs from the right, up then down.
  const order: [number, number][] = [];
  let column = size - 1;
  let up = true;
  while (column > 0) {
    if (column === 6) column--;
    const rows = Array.from({ length: size }, (_, k) => (up ? size - 1 - k : k));
    for (const r of rows) {
      for (const c of [column, column - 1]) if (!reserved[r * size + c]) order.push([r, c]);
    }
    up = !up;
    column -= 2;
  }
  const invert = MASKS[mask] ?? fail("mask");
  const bits = order.map(([r, c]) => at(r, c) ^ (invert(r, c) ? 1 : 0));
  const codewords: number[] = [];
  for (let k = 0; k + 8 <= bits.length; k += 8) {
    codewords.push(bits.slice(k, k + 8).reduce((v, bit) => (v << 1) | bit, 0));
  }
  for (const bit of bits.slice(codewords.length * 8)) if (bit !== 0) fail("remainder bits");

  // De-interleave (§7.6): shorter blocks first, each later block one data codeword longer.
  const blocks = blockCount(version, level);
  const ec = ecPerBlock(version, level);
  const longBlocks = codewords.length % blocks;
  const shortLength = Math.floor(codewords.length / blocks) - ec;
  const dataBlocks = Array.from({ length: blocks }, () => [] as number[]);
  const ecBlocks = Array.from({ length: blocks }, () => [] as number[]);
  let next = 0;
  for (let k = 0; k <= shortLength; k++) {
    for (let b = 0; b < blocks; b++) {
      const length = shortLength + (b >= blocks - longBlocks ? 1 : 0);
      if (k < length) dataBlocks[b]?.push(codewords[next++] ?? fail("short"));
    }
  }
  for (let k = 0; k < ec; k++) {
    for (let b = 0; b < blocks; b++) ecBlocks[b]?.push(codewords[next++] ?? fail("short"));
  }
  for (let b = 0; b < blocks; b++) {
    if (!syndromesZero([...(dataBlocks[b] ?? []), ...(ecBlocks[b] ?? [])], ec)) fail("syndromes");
  }

  // One segment, then the terminator and the padding.
  const data = dataBlocks.flat();
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((k) => (byte >> k) & 1));
  let cursor = 0;
  const read = (length: number) => {
    if (cursor + length > stream.length) fail("data runs out");
    let value = 0;
    for (let k = 0; k < length; k++) value = (value << 1) | (stream[cursor++] ?? 0);
    return value;
  };
  const range = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const indicator = read(4);
  let mode: Decoded["mode"];
  let text = "";
  if (indicator === 0b0001) {
    mode = "numeric";
    let count = read([10, 12, 14][range] ?? 0);
    for (; count >= 3; count -= 3) text += String(read(10)).padStart(3, "0");
    if (count === 2) text += String(read(7)).padStart(2, "0");
    if (count === 1) text += String(read(4));
  } else if (indicator === 0b0010) {
    mode = "alphanumeric";
    let count = read([9, 11, 13][range] ?? 0);
    for (; count >= 2; count -= 2) {
      const pair = read(11);
      text += ALPHANUMERIC.charAt(Math.floor(pair / 45)) + ALPHANUMERIC.charAt(pair % 45);
    }
    if (count === 1) text += ALPHANUMERIC.charAt(read(6));
  } else if (indicator === 0b0100) {
    mode = "byte";
    const count = read([8, 16, 16][range] ?? 0);
    const bytes = Uint8Array.from({ length: count }, () => read(8));
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else {
    fail("mode");
  }
  const rest = stream.length - cursor;
  if (read(Math.min(4, rest)) !== 0) fail("terminator");
  while (cursor % 8 !== 0) if (read(1) !== 0) fail("bit padding");
  for (let pad = 0xec; cursor < stream.length; pad ^= 0xec ^ 0x11) {
    if (read(8) !== pad) fail("pad codewords");
  }
  return { version, level, mask, mode, text, dataBlocks, ecBlocks, dataModules: order.length };
}
