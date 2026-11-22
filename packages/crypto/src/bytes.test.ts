import { describe, expect, it } from "vitest";
import { EncodingError, fromBase64NoPad, toBase64NoPad } from "./bytes.ts";

/**
 * The work `run` does, counted without a clock: each character it reads with charCodeAt, and each
 * regular expression it runs. No pattern may run at all here, so a pattern that could backtrack
 * polynomially fails the test at once instead of hanging it.
 */
function countWork<T>(run: () => T): { result: T; reads: number } {
  const { charCodeAt } = String.prototype;
  const { exec } = RegExp.prototype;
  let reads = 0;
  String.prototype.charCodeAt = function (this: string, index: number): number {
    reads += 1;
    return charCodeAt.call(this, index);
  };
  RegExp.prototype.exec = (input: string): RegExpExecArray | null => {
    throw new Error(`a regular expression ran on ${String(input).length} characters`);
  };
  try {
    const result = run();
    return { result, reads };
  } finally {
    String.prototype.charCodeAt = charCodeAt;
    RegExp.prototype.exec = exec;
  }
}

describe("unpadded base64", () => {
  it("drops exactly the padding base64 writes", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(toBase64NoPad(bytes())).toBe("");
    expect(toBase64NoPad(bytes(0xfb))).toBe("+w");
    expect(toBase64NoPad(bytes(0xfb, 0xff))).toBe("+/8");
    expect(toBase64NoPad(bytes(0xfb, 0xff, 0xbf))).toBe("+/+/");
    for (const value of ["", "+w", "+/8", "+/+/", "AAAA", "AA"]) {
      expect(toBase64NoPad(fromBase64NoPad(value))).toBe(value);
    }
    expect(() => fromBase64NoPad("+w==")).toThrow(EncodingError);
    expect(() => fromBase64NoPad("+x")).toThrow(EncodingError);
  });

  it("reads at most the last three characters of what it encodes, and runs no pattern", () => {
    // Base64 pads only its last quantum, with at most two "=": the backward pass stops after them.
    for (const length of [30_000, 30_001, 30_002]) {
      const { result, reads } = countWork(() => toBase64NoPad(new Uint8Array(length).fill(0xfb)));
      expect(result.length).toBe(Math.ceil((length * 4) / 3));
      expect(result.endsWith("=")).toBe(false);
      expect(reads).toBeLessThanOrEqual(3);
    }
  });
});
