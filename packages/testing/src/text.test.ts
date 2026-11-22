import { describe, expect, it } from "vitest";
import { createAddressBook } from "./canon/addresses.ts";
import { EmailSinkReader, linksFrom } from "./email/reader.ts";
import { trimEnd } from "./text.ts";
import { base32Decode } from "./totp.ts";

/** A regular expression a counted run was allowed to run, and the length of its input. */
interface PatternRun {
  source: string;
  length: number;
}

/**
 * The work `run` does, counted without a clock: each character it reads with charCodeAt, and each
 * regular expression it runs. Only the patterns whose sources `allowed` lists may run (they are
 * recorded with the length of their input); any other is refused at once, so a pattern that could
 * backtrack polynomially fails the test instead of hanging it.
 */
function countWork<T>(
  run: () => T,
  allowed: readonly string[] = [],
): { result: T; reads: number; patterns: PatternRun[] } {
  const { charCodeAt } = String.prototype;
  const { exec } = RegExp.prototype;
  let reads = 0;
  const patterns: PatternRun[] = [];
  String.prototype.charCodeAt = function (this: string, index: number): number {
    reads += 1;
    return charCodeAt.call(this, index);
  };
  RegExp.prototype.exec = function (this: RegExp, input: string): RegExpExecArray | null {
    const length = String(input).length;
    if (!allowed.includes(this.source)) {
      throw new Error(`a regular expression ran on ${length} characters`);
    }
    patterns.push({ source: this.source, length });
    return exec.call(this, input);
  };
  try {
    const result = run();
    return { result, reads, patterns };
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
    expect(countWork(() => trimEnd(inner, "/"))).toEqual({
      result: inner,
      reads: 1,
      patterns: [],
    });
    const trailing = `x${"!".repeat(100_000)}`;
    expect(countWork(() => trimEnd(trailing, ").,;:!?'\""))).toEqual({
      result: "x",
      reads: 100_001,
      patterns: [],
    });
  });
});

describe("the test helpers' trims, on the shapes CodeQL named", () => {
  it("reads an email sink origin's slashes once (many repetitions of '/')", () => {
    const origin = `http://sink.example.com${"/".repeat(100_000)}x`;
    expect(countWork(() => new EmailSinkReader(origin).origin)).toEqual({
      result: origin,
      reads: 1,
      patterns: [],
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

  it("cleans a scope of many hyphens in one pass, one read per unit (many repetitions of '-')", () => {
    const scope = `${"-".repeat(100_000)}run-7-`;
    expect(countWork(() => createAddressBook(scope).scope)).toEqual({
      result: "run-7",
      reads: scope.length,
      patterns: [],
    });
    // A run of hyphens between letters, in a scope long enough to be shortened: one read per unit
    // of the scope, then the shortened start's trailing hyphen and the letter before it.
    const long = `${"a".repeat(14)}${"-".repeat(100_000)}${"b".repeat(30)}`;
    const shortened = countWork(() => createAddressBook(long).scope);
    expect(shortened.result).toMatch(/^a{14}-[0-9a-f]{16}$/);
    expect(shortened.reads).toBe(long.length + 2);
    expect(shortened.patterns).toEqual([]);
  });

  it("trims a link's trailing punctuation once, through linksFrom (many repetitions of '!')", () => {
    // Only linksFrom's two link finders may run; the trim runs no pattern.
    const finders = [String.raw`https?:\/\/[^\s<>"]+`, String.raw`href\s*=\s*"(https?:\/\/[^"]+)"`];
    const inner = `https://docs.example.com/a${"!".repeat(100_000)}x`;
    const innerRun = countWork(() => linksFrom({ text: `See ${inner} now` }), finders);
    expect(innerRun.result).toEqual([inner]);
    expect(innerRun.reads).toBe(1);
    const trailing = `See https://docs.example.com/a${"!".repeat(100_000)} now`;
    const trailingRun = countWork(() => linksFrom({ text: trailing }), finders);
    expect(trailingRun.result).toEqual(["https://docs.example.com/a"]);
    expect(trailingRun.reads).toBe(100_001);
    for (const { patterns, text } of [
      { patterns: innerRun.patterns, text: `See ${inner} now` },
      { patterns: trailingRun.patterns, text: trailing },
    ]) {
      expect(new Set(patterns.map((p) => p.source))).toEqual(new Set(finders));
      for (const p of patterns) expect([text.length, 0]).toContain(p.length);
    }
  });
});
