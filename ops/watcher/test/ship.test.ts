import { describe, expect, it } from "vitest";
import type { Fetch } from "../src/cloudflare.ts";
import { ping, withoutTrailingSlashes } from "../src/ship.ts";

/**
 * The work `run` does, counted without a clock: each character it reads with charCodeAt, and the
 * input length of each regular expression it runs. No pattern may run at all here: one that runs
 * is recorded and refused at once, so a pattern that could backtrack polynomially fails the test
 * instead of hanging it, even inside code that catches the refusal (as `ping` does).
 */
function countWork<T>(run: () => T): { result: T; reads: number; patterns: number[] } {
  const { charCodeAt } = String.prototype;
  const { exec } = RegExp.prototype;
  let reads = 0;
  const patterns: number[] = [];
  String.prototype.charCodeAt = function (this: string, index: number): number {
    reads += 1;
    return charCodeAt.call(this, index);
  };
  RegExp.prototype.exec = (input: string): RegExpExecArray | null => {
    patterns.push(String(input).length);
    throw new Error(`a regular expression ran on ${String(input).length} characters`);
  };
  try {
    const result = run();
    return { result, reads, patterns };
  } finally {
    String.prototype.charCodeAt = charCodeAt;
    RegExp.prototype.exec = exec;
  }
}

/** A heartbeat that records each URL it is pinged at; its answer is made before any count starts. */
function heartbeat(): { fetch: Fetch; pinged: string[] } {
  const pinged: string[] = [];
  const ok = new Response("ok");
  return {
    pinged,
    fetch: async (input) => {
      pinged.push(input);
      return ok;
    },
  };
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
    expect(countWork(() => withoutTrailingSlashes(inner))).toEqual({
      result: inner,
      reads: 1,
      patterns: [],
    });
    const trailing = `https://heartbeat.example.com/x${"/".repeat(100_000)}`;
    expect(countWork(() => withoutTrailingSlashes(trailing))).toEqual({
      result: "https://heartbeat.example.com/x",
      reads: 100_001,
      patterns: [],
    });
  });

  it("does the same work through ping(), at the site that builds the failure URL", async () => {
    // ping() builds the failure URL before its first await, so the count sees all of that work.
    const inner = `https://heartbeat.example.com/${"/".repeat(100_000)}x`;
    const first = heartbeat();
    const innerRun = countWork(() => ping(inner, true, first.fetch));
    expect(innerRun.patterns).toEqual([]);
    expect(innerRun.reads).toBe(1);
    expect(await innerRun.result).toBe(true);
    expect(first.pinged).toEqual([`${inner}/fail`]);

    const trailing = `https://heartbeat.example.com/x${"/".repeat(100_000)}`;
    const second = heartbeat();
    const trailingRun = countWork(() => ping(trailing, true, second.fetch));
    expect(trailingRun.patterns).toEqual([]);
    expect(trailingRun.reads).toBe(100_001);
    expect(await trailingRun.result).toBe(true);
    expect(second.pinged).toEqual(["https://heartbeat.example.com/x/fail"]);

    // The heartbeat itself (not failed) is pinged as given, with nothing read.
    const third = heartbeat();
    const okRun = countWork(() => ping(trailing, false, third.fetch));
    expect(okRun.patterns).toEqual([]);
    expect(okRun.reads).toBe(0);
    expect(await okRun.result).toBe(true);
    expect(third.pinged).toEqual([trailing]);
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
