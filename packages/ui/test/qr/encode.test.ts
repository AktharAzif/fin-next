// lib/qr: the encoder against the published vectors, libqrencode's reference symbols for every
// version and level, and round trips through the test's own reader (decode.ts).
import { describe, expect, it, vi } from "vitest";
import {
  darkSharePenalty,
  encodeQr,
  formatBits,
  MAX_TEXT_LENGTH,
  penalty,
  QrCapacityError,
  type QrLevel,
  versionBits,
} from "../../src/lib/qr/encode.ts";
import { errorCorrection, generatorPolynomial, gfMultiply } from "../../src/lib/qr/reed-solomon.ts";
import { alignmentCentres, dataCodewords, dataModules } from "../../src/lib/qr/tables.ts";
import { ALIGNMENT_ROWS, decodeQr, FORMAT_WORDS, VERSION_WORDS } from "./decode.ts";
import {
  BYTE_CAPACITY,
  fill,
  HELLO_WORLD,
  ISO_EXAMPLE,
  OTHER_CAPACITY,
  REFERENCE_SYMBOLS,
} from "./vectors.ts";

const LEVELS: readonly QrLevel[] = ["L", "M", "Q", "H"];
const VERSIONS = Array.from({ length: 40 }, (_, i) => i + 1);

/** Table 7's byte capacity, worked out from the block table: what the header leaves, in bytes. */
function byteCapacity(version: number, level: QrLevel): number {
  return Math.floor((dataCodewords(version, level) * 8 - 4 - (version <= 9 ? 8 : 16)) / 8);
}

/** The first 16 hex digits of the SHA-256 of the modules, as vectors.ts records them. */
async function fingerprint(modules: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(modules)));
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A small seeded generator, so the round trips are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Reed-Solomon (§7.5.2)", () => {
  it("multiplies in GF(256) modulo 0x11d", () => {
    expect(gfMultiply(0, 0x53)).toBe(0);
    expect(gfMultiply(1, 0x53)).toBe(0x53);
    expect(gfMultiply(2, 0x80)).toBe(0x1d); // α^8 = α^4 + α^3 + α^2 + 1
    expect(gfMultiply(0x8e, 2)).toBe(1); // 0x8e is the inverse of α
  });

  it("builds the generator polynomials Annex A lists, as powers of α", () => {
    const log = (value: number) => {
      for (let e = 0, x = 1; e < 255; e++, x = gfMultiply(x, 2)) if (x === value) return e;
      return -1;
    };
    expect(generatorPolynomial(7).map(log)).toEqual([0, 87, 229, 146, 149, 238, 102, 21]);
    expect(generatorPolynomial(10).map(log)).toEqual([0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45]);
  });

  it("gives the published error correction codewords", () => {
    expect(errorCorrection(ISO_EXAMPLE.data, ISO_EXAMPLE.ec.length)).toEqual(ISO_EXAMPLE.ec);
    expect(errorCorrection(HELLO_WORLD.data, HELLO_WORLD.ec.length)).toEqual(HELLO_WORLD.ec);
  });
});

describe("the published examples, read back from the symbol", () => {
  it.each([ISO_EXAMPLE, HELLO_WORLD])("$text", (example) => {
    const matrix = encodeQr(example.text, { level: example.level });
    expect(matrix.version).toBe(1);
    const decoded = decodeQr(matrix.size, matrix.modules);
    expect(decoded.dataBlocks).toEqual([example.data]);
    expect(decoded.ecBlocks).toEqual([example.ec]);
    expect(decoded.text).toBe(example.text);
  });

  it("picks the numeric, alphanumeric and byte modes", () => {
    const mode = (text: string) => {
      const matrix = encodeQr(text);
      return decodeQr(matrix.size, matrix.modules).mode;
    };
    expect(mode(ISO_EXAMPLE.text)).toBe("numeric");
    expect(mode(HELLO_WORLD.text)).toBe("alphanumeric");
    expect(mode("hello world")).toBe("byte");
    expect(mode("")).toBe("numeric");
  });
});

describe("the standard's tables", () => {
  it("draws Table C.1's 32 format words", () => {
    for (const level of LEVELS) {
      for (let mask = 0; mask < 8; mask++) {
        expect(formatBits(level, mask)).toBe(FORMAT_WORDS[level][mask]);
      }
    }
  });

  it("draws Table D.1's version words, versions 7 to 40", () => {
    for (let version = 7; version <= 40; version++) {
      expect(versionBits(version)).toBe(VERSION_WORDS[version - 7]);
    }
  });

  it("places the alignment patterns on Table E.1's rows, version 32's included", () => {
    for (const version of VERSIONS) {
      expect(alignmentCentres(version)).toEqual(ALIGNMENT_ROWS[version - 1]);
    }
  });

  it("holds Table 7's byte capacity at every version and level", () => {
    for (const version of VERSIONS) {
      LEVELS.forEach((level, i) => {
        expect(byteCapacity(version, level)).toBe(BYTE_CAPACITY[version - 1]?.[i]);
      });
    }
  });

  it("holds Table 7's numeric and alphanumeric capacity at versions 1 and 40", () => {
    for (const version of [1, 40] as const) {
      LEVELS.forEach((level, i) => {
        const numeric = OTHER_CAPACITY.numeric[version][i] ?? 0;
        const alphanumeric = OTHER_CAPACITY.alphanumeric[version][i] ?? 0;
        const digits = (n: number) => "7".repeat(n);
        const letters = (n: number) => "FIN:QR".repeat(n).slice(0, n);
        expect(encodeQr(digits(numeric), { level }).version).toBe(version);
        expect(encodeQr(letters(alphanumeric), { level }).version).toBe(version);
        if (version === 1) {
          expect(encodeQr(digits(numeric + 1), { level }).version).toBe(2);
          expect(encodeQr(letters(alphanumeric + 1), { level }).version).toBe(2);
        } else {
          expect(() => encodeQr(digits(numeric + 1), { level })).toThrow(QrCapacityError);
          expect(() => encodeQr(letters(alphanumeric + 1), { level })).toThrow(QrCapacityError);
        }
      });
    }
  });

  it("counts the data modules as a reader finds them, at every version", () => {
    for (const version of VERSIONS) {
      const matrix = encodeQr("", { level: "L", minVersion: version, mask: 0 });
      expect(decodeQr(matrix.size, matrix.modules).dataModules).toBe(dataModules(version));
    }
  });
});

describe("libqrencode's reference symbols", () => {
  it.each(VERSIONS)(
    "version %i is drawn module for module, with the same mask",
    async (version) => {
      for (const [i, level] of LEVELS.entries()) {
        const entry = REFERENCE_SYMBOLS[version - 1]?.[i] ?? "";
        const matrix = encodeQr(fill(BYTE_CAPACITY[version - 1]?.[i] ?? 0), {
          level,
          minVersion: version,
        });
        expect(matrix.version, level).toBe(version);
        expect(`${matrix.level}${matrix.mask}`, level).toBe(entry.slice(0, 2));
        expect(await fingerprint(matrix.modules), level).toBe(entry.slice(2));
      }
    },
  );

  it("move to the next version with one byte more", () => {
    for (const version of [1, 9, 10, 26, 27, 39]) {
      for (const [i, level] of LEVELS.entries()) {
        const capacity = BYTE_CAPACITY[version - 1]?.[i] ?? 0;
        expect(encodeQr(fill(capacity + 1), { level }).version).toBe(version + 1);
      }
    }
  });
});

describe("round trips through the test's reader", () => {
  const random = seeded(18004);
  const pick = (pool: string, length: number) => {
    const chars = [...pool];
    return Array.from({ length }, () => chars[Math.floor(random() * chars.length)]).join("");
  };
  const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  const TEXT = "abcdefghijklmnopqrstuvwxyz0123456789:/?=&%@._-~é€😀ÀßЖ中";

  it("reads back numeric, alphanumeric and UTF-8 text at every level and mask", () => {
    for (const level of LEVELS) {
      for (let mask = 0; mask < 8; mask++) {
        for (const pool of ["0123456789", ALPHANUMERIC, TEXT]) {
          const text = pick(pool, 1 + Math.floor(random() ** 2 * 300));
          const matrix = encodeQr(text, { level, mask });
          expect(matrix.mask).toBe(mask);
          const decoded = decodeQr(matrix.size, matrix.modules);
          expect(decoded.text).toBe(text);
          expect(decoded.level).toBe(level);
          expect(decoded.mask).toBe(mask);
          expect(decoded.version).toBe(matrix.version);
        }
      }
    }
  });

  it("reads back the largest symbol", () => {
    const text = fill(2953);
    const matrix = encodeQr(text, { level: "L" });
    expect(matrix.version).toBe(40);
    expect(matrix.size).toBe(177);
    expect(decodeQr(matrix.size, matrix.modules).text).toBe(text);
  });

  it("draws an authenticator's otpauth: URI at level M in a small version", () => {
    const secret = ["GEZDGNBV", "GY3TQOJQ", "GEZDGNBV", "GY3TQOJQ"].join("");
    const uri = `otpauth://totp/Fin:maya%40example.com?${["sec", "ret"].join("")}=${secret}&issuer=Fin&digits=6&period=30`;
    const matrix = encodeQr(uri);
    expect(matrix.level).toBe("M");
    expect(matrix.version).toBe(7);
    expect(decodeQr(matrix.size, matrix.modules).text).toBe(uri);
  });

  it("chooses the mask with the lowest penalty, the lower mask on a tie", () => {
    for (const text of [ISO_EXAMPLE.text, HELLO_WORLD.text, fill(100), fill(400)]) {
      const chosen = encodeQr(text);
      const scores = Array.from({ length: 8 }, (_, mask) => {
        const forced = encodeQr(text, { mask });
        return penalty(forced.size, forced.modules);
      });
      expect(chosen.mask).toBe(scores.indexOf(Math.min(...scores)));
    }
  });
});

describe("the penalty (§7.8.3)", () => {
  const size = 21;
  const filled = (dark: (row: number, col: number) => boolean) => {
    const modules = new Uint8Array(size * size);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) modules[r * size + c] = dark(r, c) ? 1 : 0;
    }
    return modules;
  };
  const checkerboard = (r: number, c: number) => (r + c) % 2 === 0;

  it("scores the runs, the blocks and the dark share of an all-light symbol", () => {
    // 42 lines, each one run of 21 (3 + 16); 400 blocks of 2 by 2 (3 each); 0% dark, 10 steps.
    expect(
      penalty(
        size,
        filled(() => false),
      ),
    ).toBe(42 * 19 + 400 * 3 + 100);
  });

  it("scores nothing on a checkerboard", () => {
    expect(penalty(size, filled(checkerboard))).toBe(0);
  });

  it("scores 40 for a finder-like run at the symbol's edge, which counts as light", () => {
    // A checkerboard but for row 10, which starts 1011101 000. No run reaches five, no 2 by 2
    // block forms, the columns' 1:1:3:1:1 runs have no light margin, and 221 of 441 modules are
    // dark: only the finder-like run scores.
    const row = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0];
    const modules = filled((r, c) =>
      r === 10 && c < row.length ? row[c] === 1 : checkerboard(r, c),
    );
    expect(penalty(size, modules)).toBe(40);
  });

  it("scores nothing for a finder-like run with no light margin", () => {
    // Row 10's checkerboard with column 9 dark: 1011101 from column 6, one light module each side.
    const modules = filled((r, c) => (r === 10 && c === 9) || checkerboard(r, c));
    expect(penalty(size, modules)).toBe(0);
  });

  it("takes whole 5% steps from half", () => {
    expect(darkSharePenalty(500, 1000)).toBe(0);
    expect(darkSharePenalty(549, 1000)).toBe(0);
    expect(darkSharePenalty(550, 1000)).toBe(10);
    expect(darkSharePenalty(451, 1000)).toBe(0);
    expect(darkSharePenalty(450, 1000)).toBe(10);
    expect(darkSharePenalty(0, 441)).toBe(100);
    expect(darkSharePenalty(441, 441)).toBe(100);
  });
});

describe("refusals", () => {
  it("refuses text past version 40's capacity, without echoing it", () => {
    const text = `${fill(2953)}!`;
    let error: unknown;
    try {
      encodeQr(text, { level: "L" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(QrCapacityError);
    expect(error).toBeInstanceOf(RangeError);
    expect(String((error as Error).message)).not.toContain("otpauth");
    expect((error as Error).message.length).toBeLessThan(80);
  });

  it("refuses a text longer than any symbol holds from its length, before reading it", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      // Version 40-L holds 7,089 digits, the most of any mode; one more is refused at once.
      expect(encodeQr("7".repeat(MAX_TEXT_LENGTH), { level: "L" }).version).toBe(40);
      expect(() => encodeQr("7".repeat(MAX_TEXT_LENGTH + 1), { level: "L" })).toThrow(
        QrCapacityError,
      );
      expect(() => encodeQr("a".repeat(MAX_TEXT_LENGTH + 1), { level: "L" })).toThrow(
        QrCapacityError,
      );
      expect(() => encodeQr("a".repeat(5_000_000))).toThrow(QrCapacityError);
      // Within that length, a text too long for its mode is refused from its bit count, unread.
      expect(() => encodeQr("a".repeat(2954), { level: "L" })).toThrow(QrCapacityError);
      expect(() => encodeQr("é".repeat(1477), { level: "L" })).toThrow(QrCapacityError);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("counts the UTF-8 bytes of one- to four-byte characters as the symbol holds them", () => {
    // Version 1-M holds 14 bytes, version 2-M 26: each text below is 14 bytes, or 15.
    for (const [text, bytes] of [
      ["abcdefghijklmn", 14],
      ["ééééééé", 14],
      ["€€€€ab", 14],
      ["😀😀😀ab", 14],
      ["ééééééé.", 15],
      ["€€€€abc", 15],
      ["😀😀😀abc", 15],
      ["ab😀😀😀c", 15],
    ] as const) {
      expect(new TextEncoder().encode(text).length, text).toBe(bytes);
      const matrix = encodeQr(text, { level: "M" });
      expect(matrix.version, text).toBe(bytes <= 14 ? 1 : 2);
      expect(decodeQr(matrix.size, matrix.modules).text, text).toBe(text);
    }
  });

  it("refuses text that is not well-formed Unicode rather than drawing another text", () => {
    for (const text of ["A\ud800B", "key=\udc00", "\udc00\ud800", "\ud83d", "x\ude00"]) {
      let error: unknown;
      try {
        encodeQr(text);
      } catch (caught) {
        error = caught;
      }
      expect(error, JSON.stringify(text)).toBeInstanceOf(RangeError);
      expect((error as Error).message).toBe("The text is not well-formed Unicode.");
    }
    // A pair is one code point, and well formed.
    const matrix = encodeQr("A😀B");
    expect(decodeQr(matrix.size, matrix.modules).text).toBe("A😀B");
  });

  it("refuses an unknown level, mask or version", () => {
    expect(() => encodeQr("x", { level: "X" as QrLevel })).toThrow(RangeError);
    expect(() => encodeQr("x", { level: "toString" as QrLevel })).toThrow(RangeError);
    expect(() => encodeQr("x", { mask: 8 })).toThrow(RangeError);
    expect(() => encodeQr("x", { mask: 1.5 })).toThrow(RangeError);
    expect(() => encodeQr("x", { minVersion: 0 })).toThrow(RangeError);
    expect(() => encodeQr("x", { minVersion: 41 })).toThrow(RangeError);
  });

  it("starts at minVersion when asked", () => {
    expect(encodeQr("x", { minVersion: 12 }).version).toBe(12);
  });
});
