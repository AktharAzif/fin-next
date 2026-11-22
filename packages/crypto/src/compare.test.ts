import { describe, expect, it } from "vitest";
import { EncodingError, fromBase64NoPad, fromBase64Url, fromHex, toBase64Url } from "./bytes.ts";
import { constantTimeEqual, constantTimeEqualBytes } from "./compare.ts";

describe("constant-time comparisons", () => {
  it("compares strings and bytes of any length exactly", () => {
    expect(constantTimeEqual("123456", "123456")).toBe(true);
    expect(constantTimeEqual("123456", "123457")).toBe(false);
    expect(constantTimeEqual("123456", "1234567")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), "\u0001\u0002")).toBe(true);
  });

  it("compares equal-length bytes and refuses different lengths", () => {
    expect(constantTimeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(
      false,
    );
    expect(constantTimeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("strict decoders", () => {
  it("refuses non-canonical or foreign encodings", () => {
    expect(() => fromBase64Url("ab+c")).toThrow(EncodingError);
    expect(() => fromBase64Url("abc=")).toThrow(EncodingError);
    expect(() => fromBase64Url("a")).toThrow(EncodingError);
    expect(() => fromBase64NoPad("YQ==")).toThrow(EncodingError);
    expect(() => fromHex("ABCD")).toThrow(EncodingError);
    expect(() => fromHex("abc")).toThrow(EncodingError);
    const bytes = new Uint8Array([250, 251, 252]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});
