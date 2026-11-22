import { describe, expect, it } from "vitest";
import { ping, withoutTrailingSlashes } from "../src/ship.ts";

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

describe("the heartbeat's failure URL", () => {
  it("drops the trailing slashes only", () => {
    expect(withoutTrailingSlashes("https://heartbeat.example.com/beat/abc///")).toBe(
      "https://heartbeat.example.com/beat/abc",
    );
    expect(withoutTrailingSlashes("https://heartbeat.example.com/beat/abc")).toBe(
      "https://heartbeat.example.com/beat/abc",
    );
    expect(withoutTrailingSlashes("///")).toBe("");
  });

  it("reads one character per trailing slash and one more, however many slashes come before", () => {
    // The shape a backtracking /\/+$/ is quadratic on: a long run of slashes, then one more character.
    const inner = `https://heartbeat.example.com/${"/".repeat(100_000)}x`;
    expect(countWork(() => withoutTrailingSlashes(inner))).toEqual({ result: inner, reads: 1 });
    const trailing = `https://heartbeat.example.com/x${"/".repeat(100_000)}`;
    expect(countWork(() => withoutTrailingSlashes(trailing))).toEqual({
      result: "https://heartbeat.example.com/x",
      reads: 100_001,
    });
  });

  it("pings the failure URL once under a heartbeat URL that ends in slashes", async () => {
    const pinged: string[] = [];
    const accepted = await ping("https://heartbeat.example.com/beat/abc//", true, async (input) => {
      pinged.push(String(input));
      return new Response("ok");
    });
    expect(accepted).toBe(true);
    expect(pinged).toEqual(["https://heartbeat.example.com/beat/abc/fail"]);
  });
});
