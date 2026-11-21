// Reed-Solomon error correction over GF(256) as the QR standard defines it (ISO/IEC 18004:2015
// §7.5.2): the field's reducing polynomial is x^8 + x^4 + x^3 + x^2 + 1 (0x11d), its generator α
// is 2, and the code's generator polynomial of degree n is (x - α^0)(x - α^1)…(x - α^(n-1)).

// α^i for i in 0..254, and its inverse, the logarithm of each non-zero element.
const EXP = new Uint8Array(255);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}

/** The product of two field elements. */
export function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[((LOG[a] ?? 0) + (LOG[b] ?? 0)) % 255] ?? 0;
}

/** The generator polynomial's coefficients, highest power first; the leading 1 is included. */
export function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    // poly · (x + α^i): the shift by x, plus each coefficient times α^i one place lower.
    const next = [...poly, 0];
    for (let j = 0; j < poly.length; j++) {
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(poly[j] ?? 0, EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/** The `degree` error correction codewords of a block: the remainder of data·x^degree by g(x). */
export function errorCorrection(data: readonly number[], degree: number): number[] {
  const generator = generatorPolynomial(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const codeword of data) {
    const factor = codeword ^ (remainder.shift() ?? 0);
    remainder.push(0);
    for (let i = 0; i < degree; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMultiply(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}
