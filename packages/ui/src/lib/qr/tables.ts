// The QR standard's tables that cannot be derived (ISO/IEC 18004:2015), for versions 1 to 40, and
// the ones that can, derived from the symbol's structure. Written from the published standard.

export type QrLevel = "L" | "M" | "Q" | "H";

/** The two bits each level puts in the format information (Table 12): L 01, M 00, Q 11, H 10. */
export const LEVEL_BITS: Readonly<Record<QrLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };

// Table 9: error correction codewords in each block, then the number of blocks, by version.
const EC_PER_BLOCK: Readonly<Record<QrLevel, readonly number[]>> = {
  L: [
    7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30,
    26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  Q: [
    13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30,
    30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  H: [
    17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
};

const BLOCKS: Readonly<Record<QrLevel, readonly number[]>> = {
  L: [
    1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15,
    16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
    26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34,
    35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37,
    40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
};

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Modules on a side: 21 for version 1, four more for each version after it. */
export function sizeOf(version: number): number {
  return 4 * version + 17;
}

export function ecPerBlock(version: number, level: QrLevel): number {
  return EC_PER_BLOCK[level][version - 1] ?? 0;
}

export function blockCount(version: number, level: QrLevel): number {
  return BLOCKS[level][version - 1] ?? 0;
}

/**
 * The rows and columns of the alignment patterns' centres (Annex E, Table E.1): none in version 1;
 * else `version / 7 + 2` of them, the first at 6, the last 7 from the far edge, the rest evenly
 * spaced by the smallest even step that reaches, except version 32, whose table row steps by 26.
 */
export function alignmentCentres(version: number): number[] {
  if (version < 2) return [];
  const count = Math.floor(version / 7) + 2;
  const last = sizeOf(version) - 7;
  const step = version === 32 ? 26 : Math.ceil((last - 6) / (count - 1) / 2) * 2;
  const centres = [6];
  for (let i = count - 2; i >= 0; i--) centres.push(last - i * step);
  return centres;
}

/**
 * The modules left for data and error correction once the function patterns are drawn: the
 * symbol, less the three finders with their separators (64 each), the timing patterns, the format
 * information and the dark module (31), the alignment patterns (25 each, less the 5 each shares
 * with a timing pattern) and, from version 7, the two version blocks (36).
 */
export function dataModules(version: number): number {
  const size = sizeOf(version);
  let modules = size * size - 3 * 64 - 2 * (size - 16) - 31;
  const k = alignmentCentres(version).length;
  if (k > 0) modules -= 25 * (k * k - 3) - 5 * 2 * (k - 2);
  if (version >= 7) modules -= 36;
  return modules;
}

/** The data codewords a symbol of this version and level holds (Table 7's capacity, in bytes). */
export function dataCodewords(version: number, level: QrLevel): number {
  return (
    Math.floor(dataModules(version) / 8) - ecPerBlock(version, level) * blockCount(version, level)
  );
}
