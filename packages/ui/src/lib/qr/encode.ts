// The QR encoder (spec 06 §3.3's `qr`; UR-13, [SA-45]): text in, a matrix of modules out, written
// fresh from ISO/IEC 18004:2015. One segment in the most compact mode that holds the whole text
// (numeric, alphanumeric, or bytes of UTF-8), the smallest version that fits it at the asked level,
// Reed-Solomon blocks interleaved, the function patterns, the codewords placed in the standard's
// zigzag, and the mask with the lowest penalty. QrCode (qr-code.tsx) imports it with itself; what
// it returns is drawn as SVG elements, never as an image. A text no symbol can hold is refused from
// its length before any work, and a text that is not well-formed Unicode is refused rather than
// drawn as another text. An error never carries the text, which may hold a secret.
import { errorCorrection } from "./reed-solomon.ts";
import {
  alignmentCentres,
  blockCount,
  dataCodewords,
  dataModules,
  ecPerBlock,
  LEVEL_BITS,
  MAX_VERSION,
  MIN_VERSION,
  type QrLevel,
  sizeOf,
} from "./tables.ts";

export type { QrLevel } from "./tables.ts";

export interface QrMatrix {
  readonly version: number;
  readonly level: QrLevel;
  /** The mask pattern applied, 0 to 7 (§7.8.2). */
  readonly mask: number;
  /** Modules on a side. */
  readonly size: number;
  /** Row by row, `size * size` of them: 1 for a dark module, 0 for a light one. */
  readonly modules: Uint8Array;
}

export interface QrOptions {
  /** The error correction level; M by default, which survives about 15% of the symbol damaged. */
  level?: QrLevel;
  /** The smallest version to use. */
  minVersion?: number;
  /** A fixed mask pattern instead of the one with the lowest penalty (for tests). */
  mask?: number;
}

/** Thrown when the text does not fit in a version 40 symbol at the asked level. */
export class QrCapacityError extends RangeError {
  override name = "QrCapacityError";
}

/**
 * The most characters any symbol holds: version 40-L in numeric mode (Table 7). A longer text is
 * refused from its length alone, before it is read.
 */
export const MAX_TEXT_LENGTH = 7089;

interface Mode {
  readonly indicator: number;
  /** The character count indicator's length for versions 1-9, 10-26 and 27-40 (Table 3). */
  readonly countBits: readonly [number, number, number];
}

const NUMERIC: Mode = { indicator: 0b0001, countBits: [10, 12, 14] };
const ALPHANUMERIC: Mode = { indicator: 0b0010, countBits: [9, 11, 13] };
const BYTE: Mode = { indicator: 0b0100, countBits: [8, 16, 16] };
const ALPHANUMERIC_SET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const NUMERIC_TEXT = /^[0-9]*$/;
const ALPHANUMERIC_TEXT = /^[0-9A-Z $%*+\-./:]*$/;
/** A surrogate that is not half of a pair: in a `u` pattern a pair reads as one code point. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function push(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function countBits(mode: Mode, version: number): number {
  return mode.countBits[version <= 9 ? 0 : version <= 26 ? 1 : 2];
}

/** The bytes of UTF-8 a well-formed text takes, counted without encoding it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4; // a pair: one code point past U+FFFF
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The most compact mode that holds the whole text, and its count: characters, or bytes (§7.4). */
function modeOf(text: string): { mode: Mode; count: number } {
  if (NUMERIC_TEXT.test(text)) return { mode: NUMERIC, count: text.length };
  if (ALPHANUMERIC_TEXT.test(text)) return { mode: ALPHANUMERIC, count: text.length };
  return { mode: BYTE, count: utf8Length(text) };
}

/** The data bits a segment of `count` takes in `mode`, worked out from the count (§7.4.3 to §7.4.5). */
function dataBitLength(mode: Mode, count: number): number {
  if (mode === NUMERIC) return 10 * Math.floor(count / 3) + ([0, 4, 7][count % 3] ?? 0);
  if (mode === ALPHANUMERIC) return 11 * Math.floor(count / 2) + 6 * (count % 2);
  return 8 * count;
}

/** The text's data bits in its mode, once it is known to fit (§7.4.3 to §7.4.5). */
function segmentBits(text: string, mode: Mode): number[] {
  const bits: number[] = [];
  if (mode === NUMERIC) {
    for (let i = 0; i < text.length; i += 3) {
      const group = text.slice(i, i + 3);
      push(bits, Number(group), group.length * 3 + 1);
    }
  } else if (mode === ALPHANUMERIC) {
    for (let i = 0; i < text.length; i += 2) {
      const first = ALPHANUMERIC_SET.indexOf(text.charAt(i));
      if (i + 1 < text.length)
        push(bits, first * 45 + ALPHANUMERIC_SET.indexOf(text.charAt(i + 1)), 11);
      else push(bits, first, 6);
    }
  } else {
    for (const byte of new TextEncoder().encode(text)) push(bits, byte, 8);
  }
  return bits;
}

interface Segment {
  readonly mode: Mode;
  readonly count: number;
  readonly bits: readonly number[];
}

/** The data codewords: header, data, terminator, zero bits to a byte, then 0xEC and 0x11 (§7.4.10). */
function dataCodewordsFor(seg: Segment, version: number, capacity: number): number[] {
  const bits: number[] = [];
  push(bits, seg.mode.indicator, 4);
  push(bits, seg.count, countBits(seg.mode, version));
  for (const bit of seg.bits) bits.push(bit);
  push(bits, 0, Math.min(4, capacity * 8 - bits.length));
  push(bits, 0, (8 - (bits.length % 8)) % 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** Splits the data into blocks, adds each block's error correction and interleaves (§7.6). */
function interleave(data: readonly number[], version: number, level: QrLevel): number[] {
  const blocks = blockCount(version, level);
  const ec = ecPerBlock(version, level);
  const total = Math.floor(dataModules(version) / 8);
  const shortBlocks = blocks - (total % blocks);
  const shortData = Math.floor(total / blocks) - ec;
  const dataBlocks: number[][] = [];
  for (let b = 0, at = 0; b < blocks; b++) {
    const length = shortData + (b < shortBlocks ? 0 : 1);
    dataBlocks.push(data.slice(at, at + length));
    at += length;
  }
  const ecBlocks = dataBlocks.map((block) => errorCorrection(block, ec));
  const out: number[] = [];
  for (let i = 0; i <= shortData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i] ?? 0);
  }
  for (let i = 0; i < ec; i++) for (const block of ecBlocks) out.push(block[i] ?? 0);
  return out;
}

interface Grid {
  readonly size: number;
  readonly dark: Uint8Array;
  /** 1 where a function pattern or the format or version information sits. */
  readonly fixed: Uint8Array;
}

function fix(grid: Grid, row: number, col: number, dark: boolean): void {
  grid.dark[row * grid.size + col] = dark ? 1 : 0;
  grid.fixed[row * grid.size + col] = 1;
}

/** The function patterns (§6.3), with the format and version areas reserved. */
function functionPatterns(version: number): Grid {
  const size = sizeOf(version);
  const grid: Grid = {
    size,
    dark: new Uint8Array(size * size),
    fixed: new Uint8Array(size * size),
  };
  for (let i = 0; i < size; i++) {
    fix(grid, 6, i, i % 2 === 0);
    fix(grid, i, 6, i % 2 === 0);
  }
  // Each finder: rings at Chebyshev distance 0 to 3 from its centre, dark but the second; then
  // the light separator at distance 4, wherever it falls inside the symbol.
  for (const [r0, c0] of [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ] as const) {
    for (let dr = -4; dr <= 4; dr++) {
      for (let dc = -4; dc <= 4; dc++) {
        const row = r0 + dr;
        const col = c0 + dc;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const ring = Math.max(Math.abs(dr), Math.abs(dc));
        fix(grid, row, col, ring !== 2 && ring !== 4);
      }
    }
  }
  const centres = alignmentCentres(version);
  const last = centres[centres.length - 1];
  for (const r0 of centres) {
    for (const c0 of centres) {
      // Not over the three finders.
      if ((r0 === 6 && (c0 === 6 || c0 === last)) || (r0 === last && c0 === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          fix(grid, r0 + dr, c0 + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  drawFormat(grid, 0); // reserves the areas; the real bits are drawn once the mask is chosen
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      fix(grid, a, b, on);
      fix(grid, b, a, on);
    }
  }
  return grid;
}

/** `value` followed by its BCH remainder by `generator` (Annex C and D). */
function bch(value: number, generator: number, degree: number): number {
  let remainder = value << degree;
  for (let bit = 31 - Math.clz32(generator); 31 - Math.clz32(remainder) >= bit; ) {
    remainder ^= generator << (31 - Math.clz32(remainder) - bit);
  }
  return (value << degree) | remainder;
}

/** The 18-bit version information (§7.10), from version 7: the version, then its BCH bits. */
export function versionBits(version: number): number {
  return bch(version, 0x1f25, 12);
}

/** The 15-bit format information (§7.9): level and mask, its BCH bits, masked by 0x5412. */
export function formatBits(level: QrLevel, mask: number): number {
  return bch((LEVEL_BITS[level] << 3) | mask, 0x537, 10) ^ 0x5412;
}

/** Draws both copies of the format information (Figure 25) and the dark module. */
function drawFormat(grid: Grid, bits: number): void {
  const { size } = grid;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i < 15; i++) {
    // Beside the top-left finder: up column 8 then left along row 8, skipping the timing pattern.
    if (i < 6) fix(grid, i, 8, bit(i));
    else if (i < 8) fix(grid, i + 1, 8, bit(i));
    else if (i === 8) fix(grid, 8, 7, bit(i));
    else fix(grid, 8, 14 - i, bit(i));
    // Split between the other two finders.
    if (i < 8) fix(grid, 8, size - 1 - i, bit(i));
    else fix(grid, size - 15 + i, 8, bit(i));
  }
  fix(grid, size - 8, 8, true);
}

/** Places the codewords' bits two columns at a time, up then down, right to left (§7.7.3). */
function placeCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size, dark, fixed } = grid;
  let index = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (fixed[row * size + col]) continue;
        const byte = codewords[index >>> 3] ?? 0; // the remainder bits past the end are 0
        dark[row * size + col] = (byte >>> (7 - (index & 7))) & 1;
        index++;
      }
    }
    upward = !upward;
  }
}

/** Whether mask pattern `mask` inverts the module at (`row`, `col`) (Table 10). */
function maskInverts(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(grid: Grid, mask: number): void {
  const { size, dark, fixed } = grid;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const index = row * size + col;
      if (!fixed[index] && maskInverts(mask, row, col)) dark[index] = (dark[index] ?? 0) ^ 1;
    }
  }
}

/**
 * The runs along one row or column, as lengths that alternate light, dark, light, … and start and
 * end with a light run (of length 0 where the line starts or ends dark).
 */
function runsOf(size: number, module: (b: number) => number): number[] {
  const runs: number[] = [];
  let colour = 0;
  let length = 0;
  for (let b = 0; b < size; b++) {
    if (module(b) === colour) length++;
    else {
      runs.push(length);
      colour ^= 1;
      length = 1;
    }
  }
  runs.push(length);
  if (colour === 1) runs.push(0);
  return runs;
}

/**
 * The penalty of a masked symbol (§7.8.3, Table 11): runs of five or more of one colour in a row
 * or column (3, plus 1 for each module past five); each 2 by 2 block of one colour (3); each
 * dark:light:dark:light:dark run of ratio 1:1:3:1:1 with a light run four times its unit on either
 * side, the area outside the symbol counting as light (40); and 10 for each whole 5% the dark share
 * lies away from half.
 */
export function penalty(size: number, dark: Uint8Array): number {
  const at = (row: number, col: number) => dark[row * size + col] ?? 0;
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      const runs = runsOf(size, (b) => (pass === 0 ? at(a, b) : at(b, a)));
      for (const run of runs) if (run >= 5) score += run - 2;
      const last = runs.length - 1;
      for (let i = 1; i + 4 < last; i += 2) {
        const n = runs[i] ?? 0;
        const ratio =
          n > 0 &&
          runs[i + 1] === n &&
          runs[i + 2] === 3 * n &&
          runs[i + 3] === n &&
          runs[i + 4] === n;
        if (!ratio) continue;
        const before = i - 1 === 0 || (runs[i - 1] ?? 0) >= 4 * n;
        const after = i + 5 === last || (runs[i + 5] ?? 0) >= 4 * n;
        if (before || after) score += 40;
      }
    }
  }
  let darkCount = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      darkCount += at(row, col);
      if (row + 1 < size && col + 1 < size) {
        const v = at(row, col);
        if (v === at(row, col + 1) && v === at(row + 1, col) && v === at(row + 1, col + 1))
          score += 3;
      }
    }
  }
  return score + darkSharePenalty(darkCount, size * size);
}

/**
 * N4: 10 for each whole 5% step the dark share lies away from 50%, read exactly (54.9% is still
 * within the first step; libqrencode rounds to a whole percent first, and differs there).
 */
export function darkSharePenalty(dark: number, total: number): number {
  return 10 * Math.floor(Math.abs(dark * 20 - total * 10) / total);
}

/** Encodes `text` as a QR symbol. */
export function encodeQr(text: string, options: QrOptions = {}): QrMatrix {
  const level = options.level ?? "M";
  if (!Object.hasOwn(LEVEL_BITS, level)) throw new RangeError("The level is L, M, Q or H.");
  const fixedMask = options.mask;
  if (fixedMask !== undefined && !(Number.isInteger(fixedMask) && fixedMask >= 0 && fixedMask <= 7))
    throw new RangeError("The mask pattern is 0 to 7.");
  let version = options.minVersion ?? MIN_VERSION;
  if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION)
    throw new RangeError("The version is 1 to 40.");
  // Refused before the text is read past its length: no symbol holds more characters than this.
  if (text.length > MAX_TEXT_LENGTH)
    throw new QrCapacityError("The text is too long for a QR code.");
  // A lone surrogate would be encoded as U+FFFD, a code of another text: refused instead.
  if (LONE_SURROGATE.test(text)) throw new RangeError("The text is not well-formed Unicode.");
  const { mode, count } = modeOf(text);
  const length = dataBitLength(mode, count);
  while (4 + countBits(mode, version) + length > dataCodewords(version, level) * 8) {
    version++;
    if (version > MAX_VERSION) throw new QrCapacityError("The text is too long for a QR code.");
  }
  const seg: Segment = { mode, count, bits: segmentBits(text, mode) };
  const data = dataCodewordsFor(seg, version, dataCodewords(version, level));
  const grid = functionPatterns(version);
  placeCodewords(grid, interleave(data, version, level));

  const masks = fixedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [fixedMask];
  let best: { mask: number; dark: Uint8Array; score: number } | null = null;
  for (const mask of masks) {
    const candidate: Grid = { size: grid.size, dark: grid.dark.slice(), fixed: grid.fixed };
    applyMask(candidate, mask);
    drawFormat(candidate, formatBits(level, mask));
    const score = masks.length === 1 ? 0 : penalty(candidate.size, candidate.dark);
    if (best === null || score < best.score) best = { mask, dark: candidate.dark, score };
  }
  if (best === null) throw new RangeError("No mask pattern was tried.");
  return { version, level, mask: best.mask, size: grid.size, modules: best.dark };
}
