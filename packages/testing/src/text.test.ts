import { describe, expect, it } from "vitest";
import { createAddressBook } from "./canon/addresses.ts";
import { EmailSinkReader } from "./email/reader.ts";
import { trimEnd } from "./text.ts";
import { base32Decode } from "./totp.ts";

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

describe("trimEnd", () => {
  it("drops the given characters at the end only", () => {
    expect(trimEnd("https://x.example.com/a).", ").,")).toBe("https://x.example.com/a");
    expect(trimEnd("a/b//", "/")).toBe("a/b");
    expect(trimEnd("///", "/")).toBe("");
    expect(trimEnd("", "/")).toBe("");
    expect(trimEnd("abc", "")).toBe("abc");
  });

  it("reads one character per character it drops, and one more", () => {
    // The shape an unanchored /\/+$/ is quadratic on: a long run, then one more character.
    const inner = `${"/".repeat(100_000)}x`;
    expect(countWork(() => trimEnd(inner, "/"))).toEqual({ result: inner, reads: 1 });
    const trailing = `x${"!".repeat(100_000)}`;
    expect(countWork(() => trimEnd(trailing, ").,;:!?'\""))).toEqual({
      result: "x",
      reads: 100_001,
    });
  });
});

describe("the test helpers' trims, on the shapes CodeQL named", () => {
  it("reads an email sink origin's slashes once (many repetitions of '/')", () => {
    const origin = `http://sink.example.com${"/".repeat(100_000)}x`;
    expect(countWork(() => new EmailSinkReader(origin).origin)).toEqual({
      result: origin,
      reads: 1,
    });
    expect(new EmailSinkReader("http://sink.example.com///").origin).toBe(
      "http://sink.example.com",
    );
  });

  it("reads base32 padding once (many repetitions of '=')", () => {
    const { result, reads } = countWork(() => base32Decode(`MZXW6YTBOI${"=".repeat(100_000)}`));
    expect(new TextDecoder().decode(result)).toBe("foobar");
    expect(reads).toBe(100_001);
    expect(() => countWork(() => base32Decode(`MZ${"=".repeat(100_000)}X`))).toThrow("not base32");
  });

  it("cleans a scope of many hyphens in one pass (many repetitions of '-')", () => {
    const { result } = countWork(() => createAddressBook(`${"-".repeat(100_000)}run-7-`).scope);
    expect(result).toBe("run-7");
  });
});
